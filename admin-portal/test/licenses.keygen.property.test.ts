// Feature: license-key-management-enhancements, Property 1: Generated keys always match the key grammar and length bounds
// Validates: Requirements 5.1, 5.2, 5.6, 6.2, 6.6, 6.7, 11.4
//
// For any Custom_Key_Prefix accepted by prefix validation, and for any
// generation with no prefix, the generated License_Key consists of the literal
// `PDM`, the normalized prefix exactly once when one was supplied, and a
// Key_Secret_Component of exactly 7 hyphen-separated groups of exactly 4
// Key_Alphabet symbols (28 symbols, 34 characters, no leading or trailing
// hyphen), so the whole key is 8–128 characters, contains only `A`–`Z`,
// `0`–`9`, and hyphen, never contains `I`, `L`, `O`, or `U` in its secret
// component, and matches the Licensing_Backend validator `^[A-Za-z0-9\-]{8,128}$`.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  generateLicenseKey,
  generateSecretComponent,
  validateKeyPrefix,
  KEY_ALPHABET,
  LICENSE_KEY_PREFIX,
  SECRET_GROUPS,
  SECRET_GROUP_SIZE,
  MIN_CUSTOM_PREFIX_LENGTH,
  MAX_CUSTOM_PREFIX_LENGTH,
} from "../lib/licenses/keygen.ts";

const RUNS = 100;

// ---------------------------------------------------------------------------
// Grammar constants derived from the module's own exports.
// ---------------------------------------------------------------------------

/** Number of characters in a Key_Secret_Component: 7 groups × 4 symbols + 6 hyphens = 34. */
const SECRET_LENGTH = SECRET_GROUPS * SECRET_GROUP_SIZE + (SECRET_GROUPS - 1);

/** One Key_Alphabet symbol (digits and A–Z excluding I, L, O, U). */
const SYMBOL = `[${KEY_ALPHABET}]`;
/** One group of exactly SECRET_GROUP_SIZE symbols. */
const GROUP = `${SYMBOL}{${SECRET_GROUP_SIZE}}`;
/** Exactly SECRET_GROUPS groups joined by single hyphens, no leading/trailing hyphen. */
const SECRET_PATTERN = `${GROUP}(?:-${GROUP}){${SECRET_GROUPS - 1}}`;

/** A well-formed Key_Secret_Component in isolation. */
const SECRET_RE = new RegExp(`^${SECRET_PATTERN}$`);
/** A well-formed License_Key with no Custom_Key_Prefix: `PDM-<secret>`. */
const KEY_NO_PREFIX_RE = new RegExp(`^${LICENSE_KEY_PREFIX}-${SECRET_PATTERN}$`);
/** The Licensing_Backend input validator that every key must satisfy (Req 5.6). */
const BACKEND_VALIDATOR_RE = /^[A-Za-z0-9\-]{8,128}$/;
/** Whole-key charset: only A–Z, 0–9, and hyphen (Req 5.6). */
const KEY_CHARSET_RE = /^[A-Z0-9-]+$/;
/** Symbols forbidden in a Key_Secret_Component (Req 6.6). */
const FORBIDDEN_SECRET_CHARS = /[ILOU]/;

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Characters legal in a normalized Custom_Key_Prefix (A–Z and 0–9). */
const PREFIX_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("");
const prefixCharArb = fc.constantFrom(...PREFIX_CHARS);

/** A non-empty run of legal prefix characters (a single hyphen-free segment). */
const segmentArb = fc
  .array(prefixCharArb, { minLength: 1, maxLength: 5 })
  .map((chars) => chars.join(""));

/**
 * An already-normalized, valid Custom_Key_Prefix: one or more segments joined by
 * single hyphens, no leading/trailing hyphen, no double hyphen, length within
 * the accepted 1–32 window. Every value is a fixed point of normalization and is
 * therefore accepted by validateKeyPrefix unchanged.
 */
const validPrefixArb: fc.Arbitrary<string> = fc
  .array(segmentArb, { minLength: 1, maxLength: 8 })
  .map((segments) => segments.join("-"))
  .filter(
    (prefix) =>
      prefix.length >= MIN_CUSTOM_PREFIX_LENGTH &&
      prefix.length <= MAX_CUSTOM_PREFIX_LENGTH
  );

/**
 * A raw prefix submission mixing legal characters with whitespace and
 * underscores, exercising the "for any prefix accepted by prefix validation"
 * clause through validateKeyPrefix's normalization rather than a pre-normalized
 * value.
 */
const rawPrefixArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-".split("")), {
    minLength: 0,
    maxLength: 40,
  })
  .map((chars) => chars.join(""));

// ---------------------------------------------------------------------------
// Shared assertions
// ---------------------------------------------------------------------------

/** The number of (possibly overlapping) occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    count += 1;
    from = at + 1;
  }
  return count;
}

/**
 * Assert the universal grammar/length/charset guarantees that every generated
 * License_Key must satisfy, then return the Key_Secret_Component (the final
 * SECRET_LENGTH characters) for prefix-specific checks.
 */
function assertKeyEnvelope(key: string): string {
  // Length window (Req 5.6): 8 ≤ len ≤ 128.
  assert.ok(
    key.length >= 8 && key.length <= 128,
    `key length ${key.length} out of the 8–128 window: ${key}`
  );
  // Whole-key charset (Req 5.6): only A–Z, 0–9, hyphen.
  assert.match(key, KEY_CHARSET_RE);
  // The exact validator the Licensing_Backend applies (Req 5.6).
  assert.match(key, BACKEND_VALIDATOR_RE);
  // Literal `PDM` segment leads every key (Req 5.1, 5.2).
  assert.ok(
    key.startsWith(`${LICENSE_KEY_PREFIX}-`),
    `key must start with '${LICENSE_KEY_PREFIX}-': ${key}`
  );

  // The Key_Secret_Component is the trailing SECRET_LENGTH characters.
  const secret = key.slice(key.length - SECRET_LENGTH);
  // 7 groups of 4 Key_Alphabet symbols, no leading/trailing hyphen (Req 6.2, 6.7).
  assert.match(secret, SECRET_RE);
  // Never contains I, L, O, or U in the secret component (Req 6.6).
  assert.doesNotMatch(secret, FORBIDDEN_SECRET_CHARS);

  return secret;
}

// ---------------------------------------------------------------------------
// Property 1
// ---------------------------------------------------------------------------

describe("Property 1: Generated keys always match the key grammar and length bounds", () => {
  it("generateSecretComponent() is always 7 groups of 4 Key_Alphabet symbols", () => {
    fc.assert(
      // The fc.integer seed just drives repeated independent draws.
      fc.property(fc.integer(), () => {
        const secret = generateSecretComponent();
        assert.strictEqual(secret.length, SECRET_LENGTH);
        assert.match(secret, SECRET_RE);
        assert.doesNotMatch(secret, FORBIDDEN_SECRET_CHARS);
      }),
      { numRuns: RUNS }
    );
  });

  it("generateLicenseKey() with no prefix is `PDM-<secret>` within all bounds (Req 5.2, 5.6, 6.6, 6.7)", () => {
    fc.assert(
      fc.property(fc.integer(), () => {
        const key = generateLicenseKey();
        const secret = assertKeyEnvelope(key);
        // Exact unprefixed shape.
        assert.match(key, KEY_NO_PREFIX_RE);
        assert.strictEqual(key, `${LICENSE_KEY_PREFIX}-${secret}`);
      }),
      { numRuns: RUNS }
    );
  });

  it("generateLicenseKey(prefix) is `PDM-<PREFIX>-<secret>` containing the prefix exactly once (Req 5.1, 5.6)", () => {
    fc.assert(
      fc.property(validPrefixArb, (prefix) => {
        // The prefix is a fixed point of validation (already normalized).
        const validated = validateKeyPrefix(prefix);
        assert.strictEqual(validated.ok, true);
        if (validated.ok) assert.strictEqual(validated.value, prefix);

        const key = generateLicenseKey(prefix);
        const secret = assertKeyEnvelope(key);

        // Exact prefixed shape: literal, prefix once, secret.
        assert.strictEqual(key, `${LICENSE_KEY_PREFIX}-${prefix}-${secret}`);
        // The `PDM-<prefix>-` head plus a secret; the normalized prefix appears
        // exactly once as the segment between the two structural hyphens.
        assert.strictEqual(
          countOccurrences(key, `-${prefix}-`),
          1,
          `normalized prefix must appear exactly once: ${key}`
        );
      }),
      { numRuns: RUNS }
    );
  });

  it("any prefix accepted by validateKeyPrefix yields a well-formed key (Req 5.1, 5.2, 5.6)", () => {
    fc.assert(
      fc.property(rawPrefixArb, (raw) => {
        const validated = validateKeyPrefix(raw);
        // Only exercise submissions the validator accepts (Property 1's domain).
        fc.pre(validated.ok);
        if (!validated.ok) return;

        const normalized = validated.value; // undefined for absent prefixes
        const key = generateLicenseKey(normalized);
        const secret = assertKeyEnvelope(key);

        if (normalized === undefined) {
          // Absent prefix (whitespace-only): unprefixed key (Req 5.2).
          assert.strictEqual(key, `${LICENSE_KEY_PREFIX}-${secret}`);
        } else {
          // Present prefix: `PDM-<PREFIX>-<secret>` (Req 5.1).
          assert.strictEqual(key, `${LICENSE_KEY_PREFIX}-${normalized}-${secret}`);
          assert.match(normalized, /^[A-Z0-9-]+$/);
        }
      }),
      { numRuns: RUNS }
    );
  });
});
