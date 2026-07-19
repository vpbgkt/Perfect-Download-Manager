import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  enforceRateLimit,
  computeWindowAllowance,
  windowStartEpoch,
  InMemoryCounterStore,
  type UsagePlan,
} from "../lib/ratelimit.ts";

/**
 * Rate-limit window property tests (portal-owned window logic).
 *
 * These exercise the pure window decision path of `enforceRateLimit` against
 * the in-memory fake counter store. The monthly quota is set far above any
 * generated request volume so the *only* reason a request can be rejected here
 * is the per-window Rate_Limit/burst allowance — isolating the window logic
 * under test (Req 12.5).
 */

// A quota large enough that it can never trip within these tests, so every
// rejection is attributable to the rate window (reason "rate").
const UNREACHABLE_QUOTA = 1_000_000;

function makePlan(rateLimitPerSec: number, burst: number): UsagePlan {
  return { rateLimitPerSec, burst, monthlyQuota: UNREACHABLE_QUOTA };
}

describe("lib/ratelimit — rate-limit window logic (Req 12.5)", () => {
  // Feature: admin-reseller-portal, Property (Testing Strategy): rate-limit window logic —
  // within a single window at most computeWindowAllowance(plan) requests are allowed and
  // every request beyond the allowance is rejected with { allowed: false, reason: "rate" }.
  it("within a single window, exactly the allowance passes and the rest are throttled with reason 'rate'", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 10 }), // rateLimitPerSec
        fc.integer({ min: 0, max: 10 }), // burst
        fc.integer({ min: 1, max: 3 }), // windowSeconds
        fc.integer({ min: 0, max: 60 }), // number of requests in the window
        fc.integer({ min: 0, max: 2_000_000_000 }), // base epoch second
        async (rate, burst, windowSeconds, requestCount, baseEpochSec) => {
          const plan = makePlan(rate, burst);
          const store = new InMemoryCounterStore();
          const allowance = computeWindowAllowance(plan, windowSeconds);

          // Anchor every request at the start of one window so they all fall in
          // the same fixed window regardless of intra-window jitter.
          const windowStart = windowStartEpoch(
            new Date(baseEpochSec * 1000),
            windowSeconds
          );
          const now = new Date(windowStart * 1000);

          let allowed = 0;
          for (let i = 0; i < requestCount; i++) {
            const decision = await enforceRateLimit(store, "key-a", plan, {
              now,
              windowSeconds,
            });
            if (decision.allowed) {
              allowed++;
              assert.strictEqual(decision.reason, null);
            } else {
              // Quota is unreachable, so the only rejection reason is the rate window.
              assert.strictEqual(decision.reason, "rate");
            }
          }

          // At most `allowance` requests pass within the window; the remainder
          // (if any) are rejected.
          assert.strictEqual(allowed, Math.min(requestCount, allowance));
        }
      ),
      { numRuns: 200 }
    );
  });

  // Feature: admin-reseller-portal, Property (Testing Strategy): rate-limit window reset —
  // when the clock advances to a new window the per-window counter resets, so each
  // fresh window again admits exactly computeWindowAllowance(plan) requests.
  it("advancing the clock into a new window resets the counter and admits the full allowance again", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 10 }), // rateLimitPerSec
        fc.integer({ min: 0, max: 10 }), // burst
        fc.integer({ min: 1, max: 3 }), // windowSeconds
        fc.integer({ min: 1, max: 4 }), // number of consecutive windows
        fc.integer({ min: 0, max: 2_000_000_000 }), // base epoch second
        async (rate, burst, windowSeconds, numWindows, baseEpochSec) => {
          const plan = makePlan(rate, burst);
          const store = new InMemoryCounterStore();
          const allowance = computeWindowAllowance(plan, windowSeconds);

          const windowStart = windowStartEpoch(
            new Date(baseEpochSec * 1000),
            windowSeconds
          );

          for (let w = 0; w < numWindows; w++) {
            // Each iteration steps into the next fixed window.
            const now = new Date((windowStart + w * windowSeconds) * 1000);

            let allowed = 0;
            // Send more than the allowance so we always saturate the window.
            for (let i = 0; i < allowance + 3; i++) {
              const decision = await enforceRateLimit(store, "key-b", plan, {
                now,
                windowSeconds,
              });
              if (decision.allowed) {
                allowed++;
                assert.strictEqual(decision.reason, null);
              } else {
                assert.strictEqual(decision.reason, "rate");
              }
            }

            // Despite the previous window(s) being saturated, this fresh window
            // admits exactly the full allowance again.
            assert.strictEqual(allowed, allowance);
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});
