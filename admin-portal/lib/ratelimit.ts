/**
 * Reseller_API rate limiting and monthly quota enforcement.
 *
 * The portal enforces two independent limits per Api_Key using DynamoDB atomic
 * counters (mirrored by an in-memory fake for tests):
 *
 *  1. A per-key request-window counter (sustained Rate_Limit + burst allowance),
 *     keyed by `{apiKeyId}#rate#{windowStart}`. The window key rotates every
 *     `windowSeconds`, so the counter naturally resets each window; a DynamoDB
 *     TTL cleans up stale window items.
 *  2. A per-key per-calendar-month Quota counter, keyed by
 *     `{apiKeyId}#quota#{YYYY-MM}` (UTC). The month key rotates at the calendar
 *     boundary, so the quota resets at the start of each month; a DynamoDB TTL
 *     set to the next-month epoch cleans up the previous month's item.
 *
 * Enforcement uses `UpdateItem ADD` + a conditional expression so the counter
 * can never exceed the limit under concurrency: the increment is applied only
 * when the resulting value would stay within the allowance, otherwise the write
 * is rejected and the request is throttled with HTTP 429 (Req 12.5, 12.6).
 *
 * The pure window/quota decision logic is separated from AWS access behind the
 * {@link CounterStore} interface, so it is unit- and property-testable via the
 * {@link InMemoryCounterStore} fake without any live AWS dependency.
 *
 * @module lib/ratelimit
 * Requirements: 12.5, 12.6
 */

import type { DynamoClient } from "./dynamo.ts";
import { ConditionalCheckFailedError } from "./dynamo.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The reason a request was throttled, or `null` when it was allowed. */
export type RateLimitReason = "rate" | "quota";

/**
 * The outcome of a rate-limit/quota check. `allowed` is false with a non-null
 * `reason` when the request must be rejected with HTTP 429.
 */
export interface RateLimitDecision {
  allowed: boolean;
  reason: RateLimitReason | null;
}

/**
 * The rate/quota configuration bound to an Api_Key (its Usage_Plan), or the
 * portal defaults when no explicit plan is assigned.
 */
export interface UsagePlan {
  /** Sustained request rate (requests per second). */
  rateLimitPerSec: number;
  /** Burst allowance added on top of the sustained rate within a window. */
  burst: number;
  /** Maximum number of requests permitted within one calendar month. */
  monthlyQuota: number;
}

/**
 * Abstraction over the counter data store. Both the DynamoDB-backed store and
 * the in-memory fake implement this, so the enforcement logic is exercised
 * identically in production and tests.
 */
export interface CounterStore {
  /**
   * Atomically add `incrementBy` to the counter at `key`, but only when the
   * resulting value would not exceed `limit`.
   *
   * - When the (missing counters count as 0) pre-increment value plus
   *   `incrementBy` is within `limit`, the counter is incremented and
   *   `{ allowed: true, count }` (the new value) is returned.
   * - Otherwise the counter is left unchanged and `{ allowed: false, count }`
   *   (the current value) is returned.
   *
   * @param key            Counter partition key.
   * @param incrementBy    Amount to add (typically 1 per request).
   * @param limit          Maximum permitted counter value.
   * @param ttlEpochSeconds DynamoDB TTL (epoch seconds) bounding the counter's lifetime.
   */
  incrementIfWithin(
    key: string,
    incrementBy: number,
    limit: number,
    ttlEpochSeconds: number
  ): Promise<{ allowed: boolean; count: number }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Counter table name (per design data model). */
export const COUNTER_TABLE = "pdm-portal-counters";

/** Partition-key attribute name of the counter table. */
export const COUNTER_KEY_ATTR = "counterKey";

/** Counter value attribute name. */
export const COUNTER_VALUE_ATTR = "count";

/** TTL attribute name on counter items. */
export const COUNTER_TTL_ATTR = "expiresAt";

/** Default rate-limit window length, in seconds. */
export const DEFAULT_WINDOW_SECONDS = 1;

/**
 * Portal default Usage_Plan applied to Api_Keys that have no explicit plan
 * assigned (Req 11.5). Enforcement callers pass the resolved plan; this is the
 * fallback the resolver uses when a field is missing.
 */
export const DEFAULT_USAGE_PLAN: Readonly<UsagePlan> = Object.freeze({
  rateLimitPerSec: 5,
  burst: 10,
  monthlyQuota: 10_000,
});

// ---------------------------------------------------------------------------
// Pure helpers (no I/O — directly unit/property-testable)
// ---------------------------------------------------------------------------

/**
 * Resolve an Api_Key's effective Usage_Plan, substituting the portal defaults
 * for any absent or non-finite field (Req 11.5).
 */
export function resolveUsagePlan(plan?: Partial<UsagePlan> | null): UsagePlan {
  const pick = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return {
    rateLimitPerSec: pick(plan?.rateLimitPerSec, DEFAULT_USAGE_PLAN.rateLimitPerSec),
    burst: pick(plan?.burst, DEFAULT_USAGE_PLAN.burst),
    monthlyQuota: pick(plan?.monthlyQuota, DEFAULT_USAGE_PLAN.monthlyQuota),
  };
}

/**
 * The maximum number of requests permitted within a single rate window:
 * sustained rate applied over the window length, plus the burst allowance.
 */
export function computeWindowAllowance(
  plan: Pick<UsagePlan, "rateLimitPerSec" | "burst">,
  windowSeconds: number = DEFAULT_WINDOW_SECONDS
): number {
  return plan.rateLimitPerSec * windowSeconds + plan.burst;
}

/**
 * The epoch-second start of the fixed window containing `now`.
 * Windows are aligned to multiples of `windowSeconds` from the epoch.
 */
export function windowStartEpoch(
  now: Date,
  windowSeconds: number = DEFAULT_WINDOW_SECONDS
): number {
  const epochSec = Math.floor(now.getTime() / 1000);
  return Math.floor(epochSec / windowSeconds) * windowSeconds;
}

/** The UTC calendar-month key for `now`, formatted `YYYY-MM`. */
export function monthKeyUtc(now: Date): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/**
 * Epoch seconds at the start (00:00:00 UTC) of the calendar month *after* the
 * one containing `now`. Used as the quota counter's TTL so it resets at the
 * month boundary.
 */
export function nextMonthEpochSeconds(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0);
  return Math.floor(next / 1000);
}

/** Build the rate-window counter partition key for an Api_Key. */
export function rateCounterKey(apiKeyId: string, windowStart: number): string {
  return `${apiKeyId}#rate#${windowStart}`;
}

/** Build the monthly-quota counter partition key for an Api_Key. */
export function quotaCounterKey(apiKeyId: string, month: string): string {
  return `${apiKeyId}#quota#${month}`;
}

/**
 * Pure predicate: would adding `incrementBy` to `currentCount` exceed `limit`?
 * Missing counters are treated as 0 by the caller. This is the core decision
 * that both the DynamoDB conditional expression and the fake store enforce.
 */
export function wouldExceed(
  currentCount: number,
  incrementBy: number,
  limit: number
): boolean {
  return currentCount + incrementBy > limit;
}

// ---------------------------------------------------------------------------
// Enforcement (near-pure — drives a CounterStore, with an injectable clock)
// ---------------------------------------------------------------------------

/** Options for {@link enforceRateLimit}. */
export interface EnforceOptions {
  /** Current time; defaults to `new Date()`. Injectable for deterministic tests. */
  now?: Date;
  /** Rate-window length in seconds; defaults to {@link DEFAULT_WINDOW_SECONDS}. */
  windowSeconds?: number;
  /** Requests consumed by this call; defaults to 1. */
  cost?: number;
}

/**
 * Enforce both the per-window Rate_Limit and the per-calendar-month Quota for a
 * single Reseller_API request against the given counter store.
 *
 * The rate window is checked first so that a request rejected for exceeding the
 * rate limit does not consume the caller's monthly quota. When the rate check
 * passes, the quota counter is incremented and checked. The returned decision
 * maps directly to the HTTP response: `allowed: false` with a `reason` becomes a
 * 429 (`rate_limit_exceeded` / `quota_exceeded`), otherwise the request proceeds.
 *
 * @returns `{ allowed: true, reason: null }` when the request is within both
 *          limits; otherwise `{ allowed: false, reason }`.
 */
export async function enforceRateLimit(
  store: CounterStore,
  apiKeyId: string,
  plan: UsagePlan,
  options: EnforceOptions = {}
): Promise<RateLimitDecision> {
  const now = options.now ?? new Date();
  const windowSeconds = options.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
  const cost = options.cost ?? 1;

  // 1. Rate window.
  const windowStart = windowStartEpoch(now, windowSeconds);
  const rateAllowance = computeWindowAllowance(plan, windowSeconds);
  const rateKey = rateCounterKey(apiKeyId, windowStart);
  const rateTtl = windowStart + windowSeconds;

  const rate = await store.incrementIfWithin(rateKey, cost, rateAllowance, rateTtl);
  if (!rate.allowed) {
    return { allowed: false, reason: "rate" };
  }

  // 2. Monthly quota (only consumed once the rate check passes).
  const quotaKey = quotaCounterKey(apiKeyId, monthKeyUtc(now));
  const quotaTtl = nextMonthEpochSeconds(now);

  const quota = await store.incrementIfWithin(
    quotaKey,
    cost,
    plan.monthlyQuota,
    quotaTtl
  );
  if (!quota.allowed) {
    return { allowed: false, reason: "quota" };
  }

  return { allowed: true, reason: null };
}

// ---------------------------------------------------------------------------
// DynamoDB-backed counter store
// ---------------------------------------------------------------------------

/**
 * A {@link CounterStore} backed by DynamoDB atomic counters via the shared
 * `dynamo` document-client wrappers.
 *
 * `incrementIfWithin` issues a single `UpdateItem ADD` guarded by a conditional
 * expression `if_not_exists(count, 0) <= (limit - incrementBy)`, so the counter
 * is bumped only when the new value stays within the allowance. A failed
 * condition (the limit would be exceeded) surfaces as a
 * {@link ConditionalCheckFailedError} and is reported as `allowed: false`
 * without mutating the counter. The item TTL is (re)set on every increment.
 */
export class DynamoCounterStore implements CounterStore {
  private readonly client: DynamoClient;
  private readonly tableName: string;

  constructor(client: DynamoClient, tableName: string = COUNTER_TABLE) {
    this.client = client;
    this.tableName = tableName;
  }

  async incrementIfWithin(
    key: string,
    incrementBy: number,
    limit: number,
    ttlEpochSeconds: number
  ): Promise<{ allowed: boolean; count: number }> {
    const maxBefore = limit - incrementBy;
    try {
      const newCount = await this.client.atomicIncrement(
        this.tableName,
        { [COUNTER_KEY_ATTR]: key },
        COUNTER_VALUE_ATTR,
        incrementBy,
        {
          conditionExpression: `if_not_exists(#counter, :zero) <= :maxBefore`,
          expressionAttributeNames: { "#ttl": COUNTER_TTL_ATTR },
          expressionAttributeValues: {
            ":zero": 0,
            ":maxBefore": maxBefore,
            ":ttl": ttlEpochSeconds,
          },
          additionalSetExpressions: `#ttl = :ttl`,
        }
      );
      return { allowed: true, count: newCount };
    } catch (err: unknown) {
      if (err instanceof ConditionalCheckFailedError) {
        return { allowed: false, count: limit };
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// In-memory fake counter store (for unit and property tests)
// ---------------------------------------------------------------------------

/**
 * In-memory {@link CounterStore} for tests. Mirrors the DynamoDB store's
 * conditional-increment semantics exactly — missing counters are treated as 0
 * and an increment is applied only when it stays within the limit — but keeps
 * all state in a plain map, so the window/quota decision logic can be exercised
 * deterministically without any AWS dependency.
 *
 * Window and month resets happen automatically because the counter key embeds
 * the window start / calendar month, so a new time bucket uses a fresh key. The
 * TTL argument is retained only for inspection.
 */
export class InMemoryCounterStore implements CounterStore {
  /** Current counter values keyed by counter key. */
  private readonly counts = new Map<string, number>();
  /** Most recent TTL seen per counter key (for test inspection). */
  private readonly ttls = new Map<string, number>();

  async incrementIfWithin(
    key: string,
    incrementBy: number,
    limit: number,
    ttlEpochSeconds: number
  ): Promise<{ allowed: boolean; count: number }> {
    const current = this.counts.get(key) ?? 0;
    if (wouldExceed(current, incrementBy, limit)) {
      return { allowed: false, count: current };
    }
    const next = current + incrementBy;
    this.counts.set(key, next);
    this.ttls.set(key, ttlEpochSeconds);
    return { allowed: true, count: next };
  }

  /** Read the current value of a counter (0 when absent). */
  peek(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  /** Read the most recently stored TTL for a counter, or undefined. */
  ttlOf(key: string): number | undefined {
    return this.ttls.get(key);
  }

  /** Remove all counters (convenience for test teardown). */
  clear(): void {
    this.counts.clear();
    this.ttls.clear();
  }
}
