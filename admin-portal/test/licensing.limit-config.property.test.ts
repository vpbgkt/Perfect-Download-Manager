// Feature: license-key-management-enhancements, Property 17:
// Environment-supplied limits are clamped or replaced by defaults.
//
// For any environment-supplied request limit and Attempt_Window value, the supplied value is
// applied when it is a number inside its bounds (1..10000 requests, 60..86400 seconds) and the
// built-in default is applied whenever the value is not a number or falls outside those bounds.
//
// This test imports the backend limiter module directly to exercise the pure `resolveSetting`
// and `resolveLimits` env readers.
//
// Validates: Requirements 8.9

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  resolveSetting,
  resolveLimits,
  DEFAULT_TOTAL_LIMIT,
  DEFAULT_WINDOW_SEC,
  DEFAULT_UNKNOWN_KEY_LIMIT,
  LIMIT_BOUNDS,
  WINDOW_BOUNDS,
  BUCKET_ACTIVATE_TOTAL,
  BUCKET_ACTIVATE_UNKNOWN,
  BUCKET_VALIDATE_TOTAL,
  BUCKET_TRIAL,
} from "../../backend/licensing/src/lib/attemptLimit.mjs";

const RUNS = 100;

type Bounds = { min: number; max: number };

/** A raw env value that is a finite number strictly inside `bounds` (integer, honoured). */
function inRange(bounds: Bounds): fc.Arbitrary<number> {
  return fc.integer({ min: bounds.min, max: bounds.max });
}

/** A raw env value below the lower bound (out of range, must fall back). */
function belowMin(bounds: Bounds): fc.Arbitrary<number> {
  return fc.integer({ min: bounds.min - 100000, max: bounds.min - 1 });
}

/** A raw env value above the upper bound (out of range, must fall back). */
function aboveMax(bounds: Bounds): fc.Arbitrary<number> {
  return fc.integer({ min: bounds.max + 1, max: bounds.max + 100000 });
}

/** Junk values that are non-numeric or non-finite (must fall back). */
const junk: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(""),
  fc.constantFrom("   ", "\t", "\n", " \t\n "),
  fc.constant(null),
  fc.constant(undefined),
  fc.constant(Number.NaN),
  fc.constant("abc"),
  fc.constant("12px"),
  fc.constant("1,000"),
  // Arbitrary strings that never parse to a finite number.
  fc.string().filter((s) => !Number.isFinite(Number(s)) || s.trim() === ""),
);

/** A number-as-string in range, which `Number(raw)` accepts (honoured). */
function inRangeString(bounds: Bounds): fc.Arbitrary<string> {
  return inRange(bounds).map((n) => String(n));
}

describe("Property 17: Environment-supplied limits are clamped or replaced by defaults", () => {
  it("honours a finite numeric value inside its bounds (as number)", () => {
    // Pair each bounds object with an in-range value drawn from that same bounds.
    const boundedValue: fc.Arbitrary<{ bounds: Bounds; value: number }> = fc
      .constantFrom(LIMIT_BOUNDS, WINDOW_BOUNDS)
      .chain((bounds) => inRange(bounds).map((value) => ({ bounds, value })));

    fc.assert(
      fc.property(boundedValue, fc.integer(), ({ bounds, value }, fallback) => {
        assert.strictEqual(resolveSetting(value, fallback, bounds), value);
      }),
      { numRuns: RUNS },
    );
  });

  it("honours an in-range numeric value supplied as a string", () => {
    fc.assert(
      fc.property(
        inRangeString(LIMIT_BOUNDS),
        fc.integer(),
        (raw, fallback) => {
          assert.strictEqual(resolveSetting(raw, fallback, LIMIT_BOUNDS), Number(raw));
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("also honours the boundary values (min and max)", () => {
    for (const bounds of [LIMIT_BOUNDS, WINDOW_BOUNDS]) {
      assert.strictEqual(resolveSetting(bounds.min, 999, bounds), bounds.min);
      assert.strictEqual(resolveSetting(bounds.max, 999, bounds), bounds.max);
    }
  });

  it("falls back to the default for values below the minimum", () => {
    fc.assert(
      fc.property(
        belowMin(LIMIT_BOUNDS),
        fc.integer(),
        (value, fallback) => {
          assert.strictEqual(resolveSetting(value, fallback, LIMIT_BOUNDS), fallback);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("falls back to the default for values above the maximum", () => {
    fc.assert(
      fc.property(
        aboveMax(WINDOW_BOUNDS),
        fc.integer(),
        (value, fallback) => {
          assert.strictEqual(resolveSetting(value, fallback, WINDOW_BOUNDS), fallback);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("falls back to the default for non-numeric / non-finite input", () => {
    fc.assert(
      fc.property(junk, fc.integer(), (raw, fallback) => {
        assert.strictEqual(resolveSetting(raw, fallback, LIMIT_BOUNDS), fallback);
        assert.strictEqual(resolveSetting(raw, fallback, WINDOW_BOUNDS), fallback);
      }),
      { numRuns: RUNS },
    );
  });

  it("resolveLimits honours in-range env values across every bucket", () => {
    fc.assert(
      fc.property(
        inRange(LIMIT_BOUNDS), // ACTIVATE_RATE_LIMIT
        inRange(LIMIT_BOUNDS), // ACTIVATE_UNKNOWN_KEY_LIMIT
        inRange(LIMIT_BOUNDS), // VALIDATE_RATE_LIMIT
        inRange(LIMIT_BOUNDS), // TRIAL_RATE_LIMIT
        inRange(WINDOW_BOUNDS), // ACTIVATE_RATE_WINDOW_SEC
        inRange(WINDOW_BOUNDS), // VALIDATE_RATE_WINDOW_SEC
        inRange(WINDOW_BOUNDS), // TRIAL_RATE_WINDOW_SEC
        (actLimit, unkLimit, valLimit, trialLimit, actWin, valWin, trialWin) => {
          const limits = resolveLimits({
            ACTIVATE_RATE_LIMIT: actLimit,
            ACTIVATE_UNKNOWN_KEY_LIMIT: unkLimit,
            VALIDATE_RATE_LIMIT: valLimit,
            TRIAL_RATE_LIMIT: trialLimit,
            ACTIVATE_RATE_WINDOW_SEC: actWin,
            VALIDATE_RATE_WINDOW_SEC: valWin,
            TRIAL_RATE_WINDOW_SEC: trialWin,
          });

          assert.deepStrictEqual(limits[BUCKET_ACTIVATE_TOTAL], {
            limit: actLimit,
            windowSec: actWin,
          });
          // The unknown-key counter shares the activation window.
          assert.deepStrictEqual(limits[BUCKET_ACTIVATE_UNKNOWN], {
            limit: unkLimit,
            windowSec: actWin,
          });
          assert.deepStrictEqual(limits[BUCKET_VALIDATE_TOTAL], {
            limit: valLimit,
            windowSec: valWin,
          });
          assert.deepStrictEqual(limits[BUCKET_TRIAL], {
            limit: trialLimit,
            windowSec: trialWin,
          });
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("resolveLimits clamps out-of-range / junk env values to the defaults per bucket", () => {
    const badLimit = fc.oneof(belowMin(LIMIT_BOUNDS), aboveMax(LIMIT_BOUNDS), junk);
    const badWindow = fc.oneof(belowMin(WINDOW_BOUNDS), aboveMax(WINDOW_BOUNDS), junk);

    fc.assert(
      fc.property(
        badLimit,
        badLimit,
        badLimit,
        badLimit,
        badWindow,
        badWindow,
        badWindow,
        (actLimit, unkLimit, valLimit, trialLimit, actWin, valWin, trialWin) => {
          const limits = resolveLimits({
            ACTIVATE_RATE_LIMIT: actLimit,
            ACTIVATE_UNKNOWN_KEY_LIMIT: unkLimit,
            VALIDATE_RATE_LIMIT: valLimit,
            TRIAL_RATE_LIMIT: trialLimit,
            ACTIVATE_RATE_WINDOW_SEC: actWin,
            VALIDATE_RATE_WINDOW_SEC: valWin,
            TRIAL_RATE_WINDOW_SEC: trialWin,
          });

          assert.deepStrictEqual(limits[BUCKET_ACTIVATE_TOTAL], {
            limit: DEFAULT_TOTAL_LIMIT,
            windowSec: DEFAULT_WINDOW_SEC,
          });
          assert.deepStrictEqual(limits[BUCKET_ACTIVATE_UNKNOWN], {
            limit: DEFAULT_UNKNOWN_KEY_LIMIT,
            windowSec: DEFAULT_WINDOW_SEC,
          });
          assert.deepStrictEqual(limits[BUCKET_VALIDATE_TOTAL], {
            limit: DEFAULT_TOTAL_LIMIT,
            windowSec: DEFAULT_WINDOW_SEC,
          });
          assert.deepStrictEqual(limits[BUCKET_TRIAL], {
            limit: DEFAULT_TOTAL_LIMIT,
            windowSec: DEFAULT_WINDOW_SEC,
          });
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("resolveLimits with an empty env yields every built-in default", () => {
    const limits = resolveLimits({});
    assert.deepStrictEqual(limits[BUCKET_ACTIVATE_TOTAL], {
      limit: DEFAULT_TOTAL_LIMIT,
      windowSec: DEFAULT_WINDOW_SEC,
    });
    assert.deepStrictEqual(limits[BUCKET_ACTIVATE_UNKNOWN], {
      limit: DEFAULT_UNKNOWN_KEY_LIMIT,
      windowSec: DEFAULT_WINDOW_SEC,
    });
    assert.deepStrictEqual(limits[BUCKET_VALIDATE_TOTAL], {
      limit: DEFAULT_TOTAL_LIMIT,
      windowSec: DEFAULT_WINDOW_SEC,
    });
    assert.deepStrictEqual(limits[BUCKET_TRIAL], {
      limit: DEFAULT_TOTAL_LIMIT,
      windowSec: DEFAULT_WINDOW_SEC,
    });
  });
});
