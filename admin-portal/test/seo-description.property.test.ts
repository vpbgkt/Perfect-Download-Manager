// Feature: admin-reseller-portal, Property 23: SEO meta-description validation
//
// For any submitted meta description, the value is accepted only if it is
// between 50 and 160 characters inclusive; a value shorter than 50 or longer
// than 160 characters is rejected.
//
// Validates: Requirements 9.4

import { describe, it } from "node:test";
import fc from "fast-check";
import { validateSeoDescription } from "../lib/validation.ts";

const RUNS = 100;

// Non-whitespace characters so that trimming never changes the length; this
// lets length-constrained generators exercise exact boundary lengths.
const NON_WS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

describe("Property 23: SEO meta-description validation", () => {
  // The validator trims input before measuring length, so the acceptance
  // decision is based on the trimmed length. The oracle mirrors that rule.
  it("accepts a description iff its trimmed length is between 50 and 160 inclusive", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const trimmedLength = raw.trim().length;
        const expectedOk = trimmedLength >= 50 && trimmedLength <= 160;

        const result = validateSeoDescription(raw);

        if (expectedOk) {
          // Accepted: ok flag set and the sanitized value is the trimmed input.
          return result.ok === true && result.value === raw.trim();
        }
        // Rejected: ok flag false with a human-readable error string.
        return result.ok === false && typeof result.error === "string";
      }),
      { numRuns: RUNS }
    );
  });

  // Explicitly exercise the accepted range including the 50 and 160 boundaries
  // using generators constrained to those exact trimmed lengths.
  it("accepts trimmed lengths across the 50..160 range including boundaries", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 50, max: 160 }).chain((len) =>
          fc.string({
            unit: fc.constantFrom(...NON_WS),
            minLength: len,
            maxLength: len,
          })
        ),
        (desc) => {
          const result = validateSeoDescription(desc);
          return result.ok === true && result.value === desc;
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("rejects descriptions shorter than 50 characters", () => {
    fc.assert(
      fc.property(
        fc.string({
          unit: fc.constantFrom(...NON_WS),
          minLength: 0,
          maxLength: 49,
        }),
        (desc) => {
          const result = validateSeoDescription(desc);
          return result.ok === false;
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("rejects descriptions longer than 160 characters", () => {
    fc.assert(
      fc.property(
        fc.string({
          unit: fc.constantFrom(...NON_WS),
          minLength: 161,
          maxLength: 500,
        }),
        (desc) => {
          const result = validateSeoDescription(desc);
          return result.ok === false;
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("rejects any non-string input", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer(),
          fc.double(),
          fc.boolean(),
          fc.constant(null),
          fc.constant(undefined),
          fc.array(fc.anything()),
          fc.object()
        ),
        (input) => {
          const result = validateSeoDescription(input);
          return result.ok === false;
        }
      ),
      { numRuns: RUNS }
    );
  });
});
