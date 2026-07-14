import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  enforceRateLimit,
  monthKeyUtc,
  nextMonthEpochSeconds,
  InMemoryCounterStore,
  type UsagePlan,
} from "../lib/ratelimit.ts";

/**
 * Testing Strategy property (portal-owned monthly quota logic), task 5.3.
 *
 * For any monthly Quota and any number of requests within a UTC calendar month:
 *  - at most `monthlyQuota` requests are allowed in that month,
 *  - every request beyond the quota (once the rate window can never trip) is
 *    rejected with `{ allowed: false, reason: "quota" }`, and
 *  - advancing the clock to the next calendar month resets the quota counter,
 *    so requests pass again.
 *
 * The rate window is given a huge rate/burst allowance so it never trips,
 * isolating the monthly-quota behaviour under test.
 *
 * Validates: Requirements 12.6
 */

/** A plan whose rate window is effectively unbounded, isolating the quota. */
function planWithQuota(monthlyQuota: number): UsagePlan {
  return {
    rateLimitPerSec: 1_000_000,
    burst: 1_000_000,
    monthlyQuota,
  };
}

/** Fire `count` sequential requests at a fixed instant and collect decisions. */
async function fireRequests(
  store: InMemoryCounterStore,
  apiKeyId: string,
  plan: UsagePlan,
  now: Date,
  count: number
) {
  const decisions = [];
  for (let i = 0; i < count; i++) {
    decisions.push(await enforceRateLimit(store, apiKeyId, plan, { now }));
  }
  return decisions;
}

describe("ratelimit monthly quota (property)", () => {
  // Feature: admin-reseller-portal, Property (Testing Strategy): monthly quota
  // caps allowed requests per calendar month and resets at the next month.
  it("throttles once the monthly quota is reached and resets next calendar month", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 50 }), // monthlyQuota
        fc.integer({ min: 0, max: 120 }), // requests attempted in month 1
        fc.integer({ min: 0, max: 120 }), // requests attempted in next month
        fc.integer({ min: 2000, max: 2100 }), // UTC year
        fc.integer({ min: 0, max: 11 }), // UTC month index
        async (monthlyQuota, month1Count, month2Count, year, monthIndex) => {
          const store = new InMemoryCounterStore();
          const plan = planWithQuota(monthlyQuota);
          const apiKeyId = "ak-test";

          // A fixed instant safely inside the chosen calendar month.
          const now = new Date(Date.UTC(year, monthIndex, 15, 12, 0, 0));

          // --- Month 1 ---
          const first = await fireRequests(store, apiKeyId, plan, now, month1Count);

          const allowedInMonth1 = first.filter((d) => d.allowed).length;
          const expectedAllowed1 = Math.min(month1Count, monthlyQuota);

          // At most `monthlyQuota` requests are allowed.
          assert.strictEqual(
            allowedInMonth1,
            expectedAllowed1,
            "allowed count in month 1 must equal min(attempts, quota)"
          );

          // The first `expectedAllowed1` pass; every request after that is
          // rejected specifically for the quota (never the rate window).
          first.forEach((decision, index) => {
            if (index < expectedAllowed1) {
              assert.deepStrictEqual(decision, { allowed: true, reason: null });
            } else {
              assert.deepStrictEqual(decision, { allowed: false, reason: "quota" });
            }
          });

          // --- Advance to the next calendar month (quota should reset) ---
          const nextNow = new Date(nextMonthEpochSeconds(now) * 1000);
          assert.notStrictEqual(
            monthKeyUtc(nextNow),
            monthKeyUtc(now),
            "next month key must differ from the current month key"
          );

          const second = await fireRequests(
            store,
            apiKeyId,
            plan,
            nextNow,
            month2Count
          );

          const allowedInMonth2 = second.filter((d) => d.allowed).length;
          const expectedAllowed2 = Math.min(month2Count, monthlyQuota);

          // The counter reset: the fresh month allows up to the full quota again.
          assert.strictEqual(
            allowedInMonth2,
            expectedAllowed2,
            "quota must reset at the next calendar month"
          );

          second.forEach((decision, index) => {
            if (index < expectedAllowed2) {
              assert.deepStrictEqual(decision, { allowed: true, reason: null });
            } else {
              assert.deepStrictEqual(decision, { allowed: false, reason: "quota" });
            }
          });
        }
      ),
      { numRuns: 200 }
    );
  });
});

describe("ratelimit monthly quota (unit)", () => {
  it("allows exactly monthlyQuota requests then returns quota reason", async () => {
    const store = new InMemoryCounterStore();
    const plan = planWithQuota(3);
    const now = new Date(Date.UTC(2025, 5, 10, 0, 0, 0));

    const d1 = await enforceRateLimit(store, "k", plan, { now });
    const d2 = await enforceRateLimit(store, "k", plan, { now });
    const d3 = await enforceRateLimit(store, "k", plan, { now });
    const d4 = await enforceRateLimit(store, "k", plan, { now });

    assert.deepStrictEqual(d1, { allowed: true, reason: null });
    assert.deepStrictEqual(d2, { allowed: true, reason: null });
    assert.deepStrictEqual(d3, { allowed: true, reason: null });
    assert.deepStrictEqual(d4, { allowed: false, reason: "quota" });
  });

  it("resets the quota at the start of the next calendar month", async () => {
    const store = new InMemoryCounterStore();
    const plan = planWithQuota(1);
    const dec = new Date(Date.UTC(2025, 11, 20, 0, 0, 0)); // December -> January rollover

    const first = await enforceRateLimit(store, "k", plan, { now: dec });
    const blocked = await enforceRateLimit(store, "k", plan, { now: dec });
    assert.deepStrictEqual(first, { allowed: true, reason: null });
    assert.deepStrictEqual(blocked, { allowed: false, reason: "quota" });

    const jan = new Date(nextMonthEpochSeconds(dec) * 1000);
    assert.strictEqual(monthKeyUtc(jan), "2026-01");
    const afterReset = await enforceRateLimit(store, "k", plan, { now: jan });
    assert.deepStrictEqual(afterReset, { allowed: true, reason: null });
  });

  it("isolates quota per api key", async () => {
    const store = new InMemoryCounterStore();
    const plan = planWithQuota(1);
    const now = new Date(Date.UTC(2025, 0, 1, 0, 0, 0));

    const a = await enforceRateLimit(store, "key-a", plan, { now });
    const b = await enforceRateLimit(store, "key-b", plan, { now });
    assert.deepStrictEqual(a, { allowed: true, reason: null });
    assert.deepStrictEqual(b, { allowed: true, reason: null });
  });
});
