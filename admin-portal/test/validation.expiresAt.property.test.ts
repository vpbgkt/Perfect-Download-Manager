// Feature: admin-reseller-portal, Property 10: expiresAt validation and clearing
//
// Validates: Requirements 3.5, 6.4, 6.5
//
// expiresAt must be a valid ISO 8601 UTC date-time when present; an empty
// submission clears the value so the License_Record becomes perpetual.
//
// The pure validator `validateIso8601Utc` in lib/validation.ts owns the
// "valid when present" half (Req 3.5, 6.4). The "empty clears the value"
// half (Req 6.5) is a submission-resolution decision layered on top of that
// validator: an empty / whitespace-only submission is a *clear* signal, a
// valid timestamp is a *set*, and anything else is *rejected* leaving the
// record unchanged. `resolveExpiresAtSubmission` below composes the real
// validator to express that decision so both clauses of Property 10 are
// exercised against production validation logic.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { validateIso8601Utc } from "../lib/validation.ts";

const RUNS = 100;

// ---------------------------------------------------------------------------
// expiresAt submission resolution (Req 6.5 clearing composed over Req 3.5/6.4)
// ---------------------------------------------------------------------------

type ExpiresAtResolution =
  | { action: "clear" }
  | { action: "set"; value: string }
  | { action: "reject"; error: string };

/**
 * Resolves how an `expiresAt` submission on an update should be applied,
 * built purely on the real `validateIso8601Utc` validator:
 *  - empty / whitespace-only  -> clear the attribute (perpetual, Req 6.5)
 *  - valid ISO 8601 UTC        -> set the trimmed value (Req 6.4)
 *  - anything else             -> reject, leaving the record unchanged (Req 3.5, 6.4)
 */
function resolveExpiresAtSubmission(input: string): ExpiresAtResolution {
  if (input.trim() === "") {
    return { action: "clear" };
  }
  const result = validateIso8601Utc(input);
  return result.ok
    ? { action: "set", value: result.value }
    : { action: "reject", error: result.error };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Real, in-range calendar instants. */
const baseDateArb = fc.date({
  min: new Date("1970-01-01T00:00:00.000Z"),
  max: new Date("2999-12-31T23:59:59.000Z"),
  noInvalidDate: true,
});

/** Valid ISO 8601 UTC date-times in every UTC form the validator accepts. */
const validExpiresAtArb = baseDateArb.chain((d) => {
  const iso = d.toISOString(); // e.g. 2024-06-15T10:30:00.123Z (fractional + Z)
  const noMillis = iso.replace(/\.\d+Z$/, "Z"); // 2024-06-15T10:30:00Z
  const body = noMillis.slice(0, -1); // 2024-06-15T10:30:00
  return fc.constantFrom(
    iso,
    noMillis,
    `${body}+00:00`,
    `${body}-00:00`,
    `${body}+0000`,
    `${body}-0000`
  );
});

/** Empty / whitespace-only submissions: the "clear to perpetual" signal. */
const clearExpiresAtArb = fc.string({
  unit: fc.constantFrom(" ", "\t", "\n", "\r"),
  minLength: 0,
  maxLength: 10,
});

/** Non-empty strings that are NOT valid ISO 8601 UTC date-times. */
const invalidExpiresAtArb = fc
  .oneof(
    // Date-only (no time component).
    fc.constantFrom("2024-01-01", "1999-12-31", "2024-06-15"),
    // Structurally fine but non-UTC offsets.
    fc.constantFrom(
      "2024-03-20T15:45:30+05:30",
      "2024-03-20T15:45:30-08:00",
      "2024-01-01T00:00:00+01:00"
    ),
    // Impossible calendar dates (regex passes, Date.parse rejects).
    fc.constantFrom(
      "2024-13-01T00:00:00Z",
      "2024-00-10T00:00:00Z",
      "2024-02-30T00:00:00Z",
      "2024-01-32T00:00:00Z"
    ),
    // Malformed / wrong separators / missing parts.
    fc.constantFrom(
      "not-a-date",
      "2024/06/15T10:30:00Z",
      "15-06-2024T10:30:00Z",
      "T10:30:00Z"
    ),
    // Arbitrary junk that always ends in a non-offset, non-Z character.
    fc.string({ minLength: 0, maxLength: 40 }).map((s) => `${s}x`)
  )
  // Keep only genuinely non-empty inputs (the empty case is a separate clause).
  .filter((s) => s.trim() !== "");

// ---------------------------------------------------------------------------
// Property 10
// ---------------------------------------------------------------------------

describe("Property 10: expiresAt validation and clearing", () => {
  // --- Clause 1: valid ISO 8601 UTC timestamps are accepted (Req 3.5, 6.4) ---
  it("accepts any valid ISO 8601 UTC date-time, echoing the trimmed value", () => {
    fc.assert(
      fc.property(validExpiresAtArb, (ts) => {
        const result = validateIso8601Utc(ts);
        assert.deepStrictEqual(result, { ok: true, value: ts });
      }),
      { numRuns: RUNS }
    );
  });

  it("accepts valid timestamps regardless of surrounding whitespace", () => {
    fc.assert(
      fc.property(validExpiresAtArb, (ts) => {
        const result = validateIso8601Utc(`  ${ts}  `);
        assert.deepStrictEqual(result, { ok: true, value: ts });
      }),
      { numRuns: RUNS }
    );
  });

  // --- Clause 2: non-empty invalid timestamps are rejected (Req 3.5, 6.4) ---
  it("rejects any non-empty value that is not a valid ISO 8601 UTC date-time", () => {
    fc.assert(
      fc.property(invalidExpiresAtArb, (bad) => {
        const result = validateIso8601Utc(bad);
        assert.strictEqual(result.ok, false, `expected reject for ${JSON.stringify(bad)}`);
      }),
      { numRuns: RUNS }
    );
  });

  // --- Submission resolution: reject leaves the record unchanged (Req 3.5, 6.4) ---
  it("resolves non-empty invalid submissions as a reject (record unchanged)", () => {
    fc.assert(
      fc.property(invalidExpiresAtArb, (bad) => {
        const resolution = resolveExpiresAtSubmission(bad);
        assert.strictEqual(resolution.action, "reject");
      }),
      { numRuns: RUNS }
    );
  });

  it("resolves valid submissions as a set carrying the trimmed timestamp", () => {
    fc.assert(
      fc.property(validExpiresAtArb, (ts) => {
        assert.deepStrictEqual(resolveExpiresAtSubmission(`  ${ts}  `), {
          action: "set",
          value: ts,
        });
      }),
      { numRuns: RUNS }
    );
  });

  // --- Clause 3: empty submissions clear the value to perpetual (Req 6.5) ---
  it("resolves any empty / whitespace-only submission as a clear to perpetual", () => {
    fc.assert(
      fc.property(clearExpiresAtArb, (blank) => {
        assert.deepStrictEqual(resolveExpiresAtSubmission(blank), { action: "clear" });
      }),
      { numRuns: RUNS }
    );
  });

  it("does not treat an empty / whitespace-only value as a valid timestamp", () => {
    fc.assert(
      fc.property(clearExpiresAtArb, (blank) => {
        assert.strictEqual(validateIso8601Utc(blank).ok, false);
      }),
      { numRuns: RUNS }
    );
  });

  // --- Totality: every string submission resolves to exactly one action ---
  it("resolves every string submission to exactly one of clear/set/reject", () => {
    fc.assert(
      fc.property(
        fc.oneof(clearExpiresAtArb, validExpiresAtArb, invalidExpiresAtArb, fc.string()),
        (input) => {
          const resolution = resolveExpiresAtSubmission(input);
          if (input.trim() === "") {
            assert.strictEqual(resolution.action, "clear");
          } else if (validateIso8601Utc(input).ok) {
            assert.strictEqual(resolution.action, "set");
            assert.strictEqual((resolution as { value: string }).value, input.trim());
          } else {
            assert.strictEqual(resolution.action, "reject");
          }
        }
      ),
      { numRuns: RUNS }
    );
  });

  // --- Result-shape invariant over arbitrary input (Req 3.5, 6.4) ---
  it("validateIso8601Utc always returns a well-formed result", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        const result = validateIso8601Utc(value);
        if (result.ok) {
          assert.strictEqual(typeof result.value, "string");
        } else {
          assert.strictEqual(typeof result.error, "string");
        }
      }),
      { numRuns: RUNS }
    );
  });
});
