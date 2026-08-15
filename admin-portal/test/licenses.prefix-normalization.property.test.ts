// Feature: license-key-management-enhancements
// Property 4: Prefix normalization is idempotent and acceptance is exactly the
//             legal charset and length.
//
// Validates: Requirements 5.3, 5.4, 5.5, 5.12, 11.8
//
// normalizeKeyPrefix applies the ordered steps of Req 5.3 and is idempotent:
// normalizing an already-normalized value returns that same value, and the
// normalized result never contains whitespace, an underscore, a lowercase
// letter, a pair of consecutive hyphens, or a leading/trailing hyphen (11.8).
// validateKeyPrefix accepts a present prefix exactly when its normalized form
// is 1–32 characters drawn only from A-Z, 0-9, and hyphen (5.4, 5.5, 11.8),
// treats an absent prefix — omitted, null, or whitespace-only — as ok(undefined)
// (5.2), and rejects a present value that is neither a string nor null (5.12).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  normalizeKeyPrefix,
  validateKeyPrefix,
  MIN_CUSTOM_PREFIX_LENGTH,
  MAX_CUSTOM_PREFIX_LENGTH,
} from "../lib/licenses/keygen.ts";

const RUNS = 100;

/** The legal normalized charset: uppercase letters, digits, and hyphen (Req 5.4). */
const LEGAL_CHARSET_RE = /^[A-Z0-9-]+$/;

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Single symbols drawn from every category a submitted prefix can mix. */
const mixedChar: fc.Arbitrary<string> = fc.oneof(
  // Legal uppercase letters and digits (weighted high so valid runs appear).
  { weight: 6, arbitrary: fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("")) },
  // Hyphens — arrays of these naturally form hyphen runs (Req 5.3 step 4).
  { weight: 3, arbitrary: fc.constant("-") },
  // Underscores — collapse to a single hyphen (Req 5.3 step 3).
  { weight: 2, arbitrary: fc.constant("_") },
  // Whitespace forms — trimmed at the edges, collapsed to hyphen inside.
  { weight: 2, arbitrary: fc.constantFrom(" ", "\t", "\n", "\r", "\f") },
  // Lowercase letters — uppercased by normalization (Req 5.3 step 2).
  { weight: 2, arbitrary: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")) },
  // Illegal characters that survive normalization and must be rejected (Req 5.4).
  { weight: 1, arbitrary: fc.constantFrom(..."!@#$%^&*()+=.,/:;".split("")) }
);

/** Free-form prefixes of length 0–40 mixing every character category. */
const mixedPrefixArb: fc.Arbitrary<string> = fc
  .array(mixedChar, { minLength: 0, maxLength: 40 })
  .map((chars) => chars.join(""));

/** Already-legal prefixes (1–32 uppercase/digit symbols) to drive the accept path. */
const legalPrefixArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("")), {
    minLength: 1,
    maxLength: 32,
  })
  .map((chars) => chars.join(""));

/** The full prefix input space: mostly mixed forms, salted with clean legal ones. */
const prefixArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 4, arbitrary: mixedPrefixArb },
  { weight: 1, arbitrary: legalPrefixArb }
);

/** Whitespace-only strings — an absent prefix per Req 5.2. */
const whitespaceOnlyArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(" ", "\t", "\n", "\r", "\f", "\v"), { minLength: 1, maxLength: 12 })
  .map((chars) => chars.join(""));

/** Present values that are neither a string nor null (Req 5.12). */
const nonStringNonNullArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.integer(),
  fc.double(),
  fc.boolean(),
  fc.object(),
  fc.array(fc.integer())
);

// ---------------------------------------------------------------------------
// Property 4
// ---------------------------------------------------------------------------

describe("Property 4: Prefix normalization is idempotent; acceptance is exactly the legal charset and length", () => {
  // --- Clause 1: normalization is idempotent (Req 5.3, 11.8) ---
  it("normalizeKeyPrefix is idempotent: normalize(normalize(x)) === normalize(x)", () => {
    fc.assert(
      fc.property(prefixArb, (input) => {
        const once = normalizeKeyPrefix(input);
        const twice = normalizeKeyPrefix(once);
        assert.strictEqual(twice, once, "second normalization must be a fixed point");
      }),
      { numRuns: RUNS }
    );
  });

  // --- Clause 2: the normalized form obeys the structural invariants (Req 5.3, 11.8) ---
  it("normalized form has no whitespace, underscore, lowercase, consecutive or edge hyphens", () => {
    fc.assert(
      fc.property(prefixArb, (input) => {
        const n = normalizeKeyPrefix(input);
        assert.ok(!/\s/.test(n), "no whitespace");
        assert.ok(!/_/.test(n), "no underscore");
        assert.ok(!/[a-z]/.test(n), "no lowercase letter");
        assert.ok(!/--/.test(n), "no pair of consecutive hyphens");
        assert.ok(!/^-/.test(n), "no leading hyphen");
        assert.ok(!/-$/.test(n), "no trailing hyphen");
      }),
      { numRuns: RUNS }
    );
  });

  // --- Clause 3: acceptance is EXACTLY legal charset + length 1..32 (Req 5.4, 5.5, 11.8) ---
  it("validateKeyPrefix accepts a present prefix iff its normalized form is 1-32 legal characters", () => {
    fc.assert(
      fc.property(prefixArb, (input) => {
        const result = validateKeyPrefix(input);
        const normalized = normalizeKeyPrefix(input);

        // A non-whitespace input is a *present* prefix; a whitespace-only (or
        // empty) input is absent and handled by the dedicated clause below.
        fc.pre(input.trim() !== "");

        const expectedAccepted =
          normalized.length >= MIN_CUSTOM_PREFIX_LENGTH &&
          normalized.length <= MAX_CUSTOM_PREFIX_LENGTH &&
          LEGAL_CHARSET_RE.test(normalized);

        const actuallyAccepted = result.ok && result.value !== undefined;
        assert.strictEqual(
          actuallyAccepted,
          expectedAccepted,
          `acceptance must match legal charset+length for normalized="${normalized}"`
        );

        if (result.ok && result.value !== undefined) {
          // An accepted prefix is returned as its normalized form...
          assert.strictEqual(result.value, normalized);
          // ...which is guaranteed legal and length-bounded.
          assert.match(result.value, LEGAL_CHARSET_RE);
          assert.ok(result.value.length >= MIN_CUSTOM_PREFIX_LENGTH);
          assert.ok(result.value.length <= MAX_CUSTOM_PREFIX_LENGTH);
        }
      }),
      { numRuns: RUNS }
    );
  });

  // --- Clause 4: absent prefixes yield ok(undefined) (Req 5.2) ---
  it("treats omitted, null, and whitespace-only prefixes as ok(undefined)", () => {
    // Omitted and null are fixed cases.
    for (const absent of [undefined, null]) {
      const result = validateKeyPrefix(absent);
      assert.strictEqual(result.ok, true);
      if (result.ok) assert.strictEqual(result.value, undefined);
    }

    // Whitespace-only strings are absent across the whole space.
    fc.assert(
      fc.property(whitespaceOnlyArb, (blank) => {
        const result = validateKeyPrefix(blank);
        assert.strictEqual(result.ok, true, "whitespace-only prefix is absent, not an error");
        if (result.ok) assert.strictEqual(result.value, undefined);
      }),
      { numRuns: RUNS }
    );
  });

  // --- Clause 5: present non-string, non-null values are rejected (Req 5.12) ---
  it("rejects a present value that is neither a string nor null", () => {
    fc.assert(
      fc.property(nonStringNonNullArb, (value) => {
        const result = validateKeyPrefix(value);
        assert.strictEqual(result.ok, false, "non-string, non-null prefix must be rejected");
      }),
      { numRuns: RUNS }
    );
  });
});
