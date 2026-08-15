// Per-source-IP attempt limiting for the activation and validation endpoints (Requirement 8).
//
// A fixed-window counter modelled on the existing /trial limiter (`rateLimit.mjs`): one item per
// (bucket, IP) keyed `RL#<bucket>#<ip>`, carrying `reqCount`, `windowStart`, and a numeric
// epoch-second `ttl` so DynamoDB TTL purges expired counters without touching License_Records or
// `TRIAL#` anchors. Every collaborator (docClient, tableName, limits, now) is injected so the
// module is unit- and property-testable without AWS.
//
// The counter is best-effort abuse friction. Call sites are expected to treat any read/write
// failure as "not limited" and log it without key material (Requirement 8.7); this module only
// performs the counting and reports the outcome.

import { UpdateCommand, GetCommand } from "@aws-sdk/lib-dynamodb";

// Logical counter buckets. The total-request and unknown-key counters, and the two endpoints,
// live in distinct items because the bucket is part of the item key (Req 8.2, 8.6).
export const BUCKET_ACTIVATE_TOTAL = "ACT";
export const BUCKET_ACTIVATE_UNKNOWN = "ACTUNKNOWN";
export const BUCKET_VALIDATE_TOTAL = "VAL";
export const BUCKET_TRIAL = "TRIAL"; // existing /trial bucket

// Built-in defaults (Req 8.3, 8.4).
export const DEFAULT_TOTAL_LIMIT = 60;
export const DEFAULT_WINDOW_SEC = 3600;
export const DEFAULT_UNKNOWN_KEY_LIMIT = 10;

// Bounds an environment-supplied value must fall within to be honoured (Req 8.9).
export const LIMIT_BOUNDS = { min: 1, max: 10000 };
export const WINDOW_BOUNDS = { min: 60, max: 86400 };

/**
 * Pure: resolve one env-supplied setting. Returns the supplied numeric value when it is a finite
 * number within `bounds`, otherwise the built-in `fallback` (Req 8.9). Non-numeric input (empty
 * string, whitespace, null, undefined, NaN) and out-of-range values fall back, so a bad parameter
 * can never disable limiting.
 */
export function resolveSetting(raw, fallback, bounds) {
  if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
    return fallback;
  }
  const value = Number(raw);
  if (Number.isFinite(value) && value >= bounds.min && value <= bounds.max) {
    return value;
  }
  return fallback;
}

/**
 * Pure: read every limit/window for all buckets from an env-like object, clamping each to its
 * default when absent or out of bounds (Req 8.9). The unknown-key counter shares the activation
 * window. Returns a map keyed by bucket: `{ limit, windowSec }`.
 */
export function resolveLimits(env = {}) {
  const activateWindow = resolveSetting(env.ACTIVATE_RATE_WINDOW_SEC, DEFAULT_WINDOW_SEC, WINDOW_BOUNDS);
  const validateWindow = resolveSetting(env.VALIDATE_RATE_WINDOW_SEC, DEFAULT_WINDOW_SEC, WINDOW_BOUNDS);
  const trialWindow = resolveSetting(env.TRIAL_RATE_WINDOW_SEC, DEFAULT_WINDOW_SEC, WINDOW_BOUNDS);

  return {
    [BUCKET_ACTIVATE_TOTAL]: {
      limit: resolveSetting(env.ACTIVATE_RATE_LIMIT, DEFAULT_TOTAL_LIMIT, LIMIT_BOUNDS),
      windowSec: activateWindow
    },
    [BUCKET_ACTIVATE_UNKNOWN]: {
      limit: resolveSetting(env.ACTIVATE_UNKNOWN_KEY_LIMIT, DEFAULT_UNKNOWN_KEY_LIMIT, LIMIT_BOUNDS),
      windowSec: activateWindow
    },
    [BUCKET_VALIDATE_TOTAL]: {
      limit: resolveSetting(env.VALIDATE_RATE_LIMIT, DEFAULT_TOTAL_LIMIT, LIMIT_BOUNDS),
      windowSec: validateWindow
    },
    [BUCKET_TRIAL]: {
      limit: resolveSetting(env.TRIAL_RATE_LIMIT, DEFAULT_TOTAL_LIMIT, LIMIT_BOUNDS),
      windowSec: trialWindow
    }
  };
}

/**
 * Determine the source IP from the HTTP API (v2) request context only, never from a request body
 * value or a client-supplied header. A request whose source IP is absent is attributed to one
 * shared `"unknown"` counter per bucket (Req 8.10).
 */
export function clientIp(event) {
  return event?.requestContext?.http?.sourceIp || "unknown";
}

/**
 * Build an attempt limiter over injected collaborators.
 *
 * @param {object}   deps
 * @param {object}   deps.docClient  DynamoDB DocumentClient (needs `.send`).
 * @param {string}   deps.tableName  Licenses_Table name.
 * @param {object}   deps.limits     Map of bucket -> { limit, windowSec } (see `resolveLimits`).
 * @param {function} [deps.now]      Clock returning epoch milliseconds; defaults to `Date.now`.
 *
 * Returns `{ increment, peek }`:
 *  - `increment(bucket, ip)` -> `{ allowed, count, limit, windowStart }`
 *  - `peek(bucket, ip)`      -> `{ allowed, count }` (never writes)
 */
export function createAttemptLimiter({ docClient, tableName, limits, now = () => Date.now() }) {
  const nowSec = () => Math.floor(now() / 1000);
  const keyFor = (bucket, ip) => `RL#${bucket}#${ip}`;

  const settingsFor = (bucket) =>
    (limits && limits[bucket]) || { limit: DEFAULT_TOTAL_LIMIT, windowSec: DEFAULT_WINDOW_SEC };

  /**
   * Count this request against `bucket`/`ip` as one atomic UpdateItem. When the stored window has
   * elapsed but TTL has not yet purged the row, the window is reset in place to a count of 1
   * (Req 8.11). `allowed` is `count <= limit`, so the limit-th request in a window still passes
   * and the (limit + 1)-th is rejected (Req 8.3, 8.4).
   */
  async function increment(bucket, ip) {
    const { limit, windowSec } = settingsFor(bucket);
    const sec = nowSec();
    const key = keyFor(bucket, ip);

    const res = await docClient.send(new UpdateCommand({
      TableName: tableName,
      Key: { licenseKey: key },
      UpdateExpression:
        "ADD reqCount :one SET #ttl = if_not_exists(#ttl, :exp), windowStart = if_not_exists(windowStart, :now)",
      ExpressionAttributeNames: { "#ttl": "ttl" },
      ExpressionAttributeValues: { ":one": 1, ":exp": sec + windowSec, ":now": sec },
      ReturnValues: "ALL_NEW"
    }));

    let count = Number(res.Attributes?.reqCount ?? 1);
    let windowStart = Number(res.Attributes?.windowStart ?? sec);

    if (sec - windowStart >= windowSec) {
      // Window elapsed (TTL purge lags); open a new window in place and process this request.
      await docClient.send(new UpdateCommand({
        TableName: tableName,
        Key: { licenseKey: key },
        UpdateExpression: "SET reqCount = :one, windowStart = :now, #ttl = :exp",
        ExpressionAttributeNames: { "#ttl": "ttl" },
        ExpressionAttributeValues: { ":one": 1, ":now": sec, ":exp": sec + windowSec }
      }));
      count = 1;
      windowStart = sec;
    }

    return { allowed: count <= limit, count, limit, windowStart };
  }

  /**
   * Read the counter for `bucket`/`ip` without writing (Req 8.5). A missing item, or one whose
   * window has elapsed, reads as an empty, allowed counter.
   */
  async function peek(bucket, ip) {
    const { limit, windowSec } = settingsFor(bucket);
    const sec = nowSec();
    const key = keyFor(bucket, ip);

    const res = await docClient.send(new GetCommand({
      TableName: tableName,
      Key: { licenseKey: key }
    }));

    const item = res.Item;
    if (!item) {
      return { allowed: true, count: 0 };
    }

    const windowStart = Number(item.windowStart ?? sec);
    if (sec - windowStart >= windowSec) {
      return { allowed: true, count: 0 };
    }

    const count = Number(item.reqCount ?? 0);
    return { allowed: count <= limit, count };
  }

  return { increment, peek };
}
