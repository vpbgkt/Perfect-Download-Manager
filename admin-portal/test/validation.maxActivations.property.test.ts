// Feature: admin-reseller-portal, Property 9: maxActivations validation
//
// Validates: Requirements 3.4, 6.2
//
// maxActivations must be an integer >= 1. The validator returns
// { ok: true, value } for accepted inputs and { ok: false, error } otherwise.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { validateMaxActivations } from "../lib/validation.ts";

describe("Property 9: maxActivations validation", () => {
  // Any integer >= 1 is accepted and echoed back unchanged.
  it("accepts every integer >= 1 and returns it unchanged", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), (n) => {
        const result = validateMaxActivations(n);
        assert.deepStrictEqual(result, { ok: true, value: n });
      }),
      { numRuns: 100 }
    );
  });

  // Any integer <= 0 is rejected (below the minimum of 1).
  it("rejects every integer <= 0", () => {
    fc.assert(
      fc.property(fc.integer({ min: Number.MIN_SAFE_INTEGER, max: 0 }), (n) => {
        const result = validateMaxActivations(n);
        assert.strictEqual(result.ok, false);
      }),
      { numRuns: 100 }
    );
  });

  // Any finite non-integer number is rejected.
  it("rejects finite non-integer numbers", () => {
    fc.assert(
      fc.property(
        fc.double({ noNaN: true, noDefaultInfinity: true }).filter((x) => !Number.isInteger(x)),
        (x) => {
          const result = validateMaxActivations(x);
          assert.strictEqual(result.ok, false);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Non-finite numbers (NaN, +/-Infinity) are rejected.
  it("rejects non-finite numbers", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(NaN, Infinity, -Infinity),
        (x) => {
          const result = validateMaxActivations(x);
          assert.strictEqual(result.ok, false);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Any non-number input is rejected regardless of shape.
  it("rejects non-number inputs", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.boolean(),
          fc.constant(null),
          fc.constant(undefined),
          fc.array(fc.integer()),
          fc.object(),
          // numeric strings must also be rejected (validator accepts numbers only)
          fc.integer({ min: 1 }).map((n) => String(n))
        ),
        (value) => {
          const result = validateMaxActivations(value);
          assert.strictEqual(result.ok, false);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Result shape invariant: every result is a well-formed discriminated union.
  it("always returns a well-formed { ok, value|error } result", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        const result = validateMaxActivations(value);
        if (result.ok) {
          assert.strictEqual(typeof result.value, "number");
          assert.ok(Number.isInteger(result.value) && result.value >= 1);
        } else {
          assert.strictEqual(typeof result.error, "string");
        }
      }),
      { numRuns: 100 }
    );
  });
});
