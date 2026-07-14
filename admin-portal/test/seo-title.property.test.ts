// Feature: admin-reseller-portal, Property 22: SEO title validation
//
// For any submitted page title, the value is accepted only if it is between
// 1 and 70 characters inclusive; otherwise the request is rejected.
//
// Validates: Requirements 9.3

import { describe, it } from "node:test";
import fc from "fast-check";
import { validateSeoTitle } from "../lib/validation.ts";

const RUNS = 100;

describe("Property 22: SEO title validation", () => {
  // The validator trims input before measuring length, so the acceptance
  // decision is based on the trimmed length. The oracle mirrors that rule.
  it("accepts a title iff its trimmed length is between 1 and 70 inclusive", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const trimmedLength = raw.trim().length;
        const expectedOk = trimmedLength >= 1 && trimmedLength <= 70;

        const result = validateSeoTitle(raw);

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

  // Explicitly exercise the boundaries (1 and 70 accepted; 0 and 71 rejected)
  // using generators constrained to those exact trimmed lengths.
  it("accepts trimmed lengths at the 1 and 70 boundaries", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 70 }).chain((len) =>
          // Use non-whitespace characters so trimming does not change length.
          fc.string({
            unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789"),
            minLength: len,
            maxLength: len,
          })
        ),
        (title) => {
          const result = validateSeoTitle(title);
          return result.ok === true && result.value === title;
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("rejects titles longer than 70 characters", () => {
    fc.assert(
      fc.property(
        fc.string({
          unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789"),
          minLength: 71,
          maxLength: 300,
        }),
        (title) => {
          const result = validateSeoTitle(title);
          return result.ok === false;
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("rejects empty or whitespace-only titles", () => {
    fc.assert(
      fc.property(
        fc.string({
          unit: fc.constantFrom(" ", "\t", "\n", "\r"),
          minLength: 0,
          maxLength: 20,
        }),
        (title) => {
          const result = validateSeoTitle(title);
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
          const result = validateSeoTitle(input);
          return result.ok === false;
        }
      ),
      { numRuns: RUNS }
    );
  });
});
