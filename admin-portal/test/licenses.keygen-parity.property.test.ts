// Feature: license-key-management-enhancements
// Property 5: The two Key_Generator implementations agree
//
// Validates: Requirements 6.9, 5.11
//
// The portal Key_Generator (admin-portal/lib/licenses/keygen.ts) and the CLI
// mirror (backend/licensing/admin/lib/keygen.mjs) produce identical results for
// every input: the same alphabet, the same constants, the same normalization
// output for any prefix string, the same validation outcome (ok/fail + value),
// and the same key structure when given identical byte sequences through their
// injectable random-byte source.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

// Portal implementation (TypeScript)
import {
  KEY_ALPHABET as PORTAL_KEY_ALPHABET,
  LICENSE_KEY_PREFIX as PORTAL_LICENSE_KEY_PREFIX,
  SECRET_GROUPS as PORTAL_SECRET_GROUPS,
  SECRET_GROUP_SIZE as PORTAL_SECRET_GROUP_SIZE,
  MIN_CUSTOM_PREFIX_LENGTH as PORTAL_MIN_PREFIX,
  MAX_CUSTOM_PREFIX_LENGTH as PORTAL_MAX_PREFIX,
  LICENSE_KEY_GROUPS as PORTAL_LICENSE_KEY_GROUPS,
  normalizeKeyPrefix as portalNormalize,
  validateKeyPrefix as portalValidate,
  generateSecretComponent as portalGenerateSecret,
  generateLicenseKey as portalGenerateKey,
} from "../lib/licenses/keygen.ts";

// Backend mirror implementation (ES module)
import {
  KEY_ALPHABET as BACKEND_KEY_ALPHABET,
  LICENSE_KEY_PREFIX as BACKEND_LICENSE_KEY_PREFIX,
  SECRET_GROUPS as BACKEND_SECRET_GROUPS,
  SECRET_GROUP_SIZE as BACKEND_SECRET_GROUP_SIZE,
  MIN_CUSTOM_PREFIX_LENGTH as BACKEND_MIN_PREFIX,
  MAX_CUSTOM_PREFIX_LENGTH as BACKEND_MAX_PREFIX,
  LICENSE_KEY_GROUPS as BACKEND_LICENSE_KEY_GROUPS,
  normalizeKeyPrefix as backendNormalize,
  validateKeyPrefix as backendValidate,
  generateSecretComponent as backendGenerateSecret,
  generateLicenseKey as backendGenerateKey,
// @ts-ignore — .mjs module has no TypeScript declarations
} from "../../backend/licensing/admin/lib/keygen.mjs";

const RUNS = 100;

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Mixed prefix input exercising all normalization paths. */
const mixedPrefixArb: fc.Arbitrary<string> = fc
  .array(
    fc.oneof(
      { weight: 5, arbitrary: fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("")) },
      { weight: 2, arbitrary: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")) },
      { weight: 2, arbitrary: fc.constantFrom("-", "_", " ", "\t", "\n") },
      { weight: 1, arbitrary: fc.constantFrom(..."!@#$%^&*()+=".split("")) }
    ),
    { minLength: 0, maxLength: 40 }
  )
  .map((chars) => chars.join(""));

/** Non-string, non-null inputs for the type-rejection path. */
const nonStringNonNullArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.integer(),
  fc.double(),
  fc.boolean(),
  fc.object(),
  fc.array(fc.integer())
);

/**
 * A deterministic byte source factory: given an array of bytes, returns a
 * RandomBytes function that yields those bytes in order, cycling if needed.
 * Both implementations receive the exact same byte sequence so their output
 * must be identical.
 */
function makeDeterministicSource(bytes: number[]): (n: number) => Uint8Array {
  let offset = 0;
  return (n: number): Uint8Array => {
    const result = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      result[i] = bytes[offset % bytes.length];
      offset++;
    }
    return result;
  };
}

/** Arbitrary producing 28–56 byte values in 0..255 for the secret component. */
const byteArrayArb: fc.Arbitrary<number[]> = fc.array(
  fc.integer({ min: 0, max: 255 }),
  { minLength: 28, maxLength: 56 }
);

// ---------------------------------------------------------------------------
// Property 5
// ---------------------------------------------------------------------------

describe("Property 5: The two Key_Generator implementations agree", () => {
  // --- Clause 1: Exported constants are identical (Req 6.9) ---
  it("exported constants are identical between portal and backend", () => {
    assert.strictEqual(PORTAL_KEY_ALPHABET, BACKEND_KEY_ALPHABET);
    assert.strictEqual(PORTAL_LICENSE_KEY_PREFIX, BACKEND_LICENSE_KEY_PREFIX);
    assert.strictEqual(PORTAL_SECRET_GROUPS, BACKEND_SECRET_GROUPS);
    assert.strictEqual(PORTAL_SECRET_GROUP_SIZE, BACKEND_SECRET_GROUP_SIZE);
    assert.strictEqual(PORTAL_MIN_PREFIX, BACKEND_MIN_PREFIX);
    assert.strictEqual(PORTAL_MAX_PREFIX, BACKEND_MAX_PREFIX);
    assert.strictEqual(PORTAL_LICENSE_KEY_GROUPS, BACKEND_LICENSE_KEY_GROUPS);
  });

  // --- Clause 2: normalizeKeyPrefix produces the same output for any input (Req 6.9, 5.11) ---
  it("normalizeKeyPrefix produces identical output for any string input", () => {
    fc.assert(
      fc.property(mixedPrefixArb, (input) => {
        const portalResult = portalNormalize(input);
        const backendResult = backendNormalize(input);
        assert.strictEqual(
          portalResult,
          backendResult,
          `normalization diverges for input "${input}": portal="${portalResult}" backend="${backendResult}"`
        );
      }),
      { numRuns: RUNS }
    );
  });

  // --- Clause 3: validateKeyPrefix produces the same outcome for any string input (Req 6.9, 5.11) ---
  it("validateKeyPrefix produces identical ok/fail results for any string input", () => {
    fc.assert(
      fc.property(mixedPrefixArb, (input) => {
        const portalResult = portalValidate(input);
        const backendResult = backendValidate(input);
        assert.strictEqual(
          portalResult.ok,
          backendResult.ok,
          `validation ok diverges for input "${input}"`
        );
        if (portalResult.ok && backendResult.ok) {
          assert.strictEqual(portalResult.value, backendResult.value);
        }
        if (!portalResult.ok && !backendResult.ok) {
          assert.strictEqual(portalResult.error, backendResult.error);
        }
      }),
      { numRuns: RUNS }
    );
  });

  // --- Clause 4: validateKeyPrefix agrees on absent inputs (Req 6.9, 5.11) ---
  it("validateKeyPrefix agrees on absent inputs: undefined, null, whitespace-only", () => {
    for (const absent of [undefined, null]) {
      const portalResult = portalValidate(absent);
      const backendResult = backendValidate(absent);
      assert.strictEqual(portalResult.ok, true);
      assert.strictEqual(backendResult.ok, true);
      if (portalResult.ok && backendResult.ok) {
        assert.strictEqual(portalResult.value, backendResult.value);
      }
    }

    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(" ", "\t", "\n", "\r"), { minLength: 1, maxLength: 10 }).map((c) => c.join("")),
        (blank) => {
          const portalResult = portalValidate(blank);
          const backendResult = backendValidate(blank);
          assert.strictEqual(portalResult.ok, true);
          assert.strictEqual(backendResult.ok, true);
          if (portalResult.ok && backendResult.ok) {
            assert.strictEqual(portalResult.value, backendResult.value);
          }
        }
      ),
      { numRuns: RUNS }
    );
  });

  // --- Clause 5: validateKeyPrefix agrees on non-string non-null inputs (Req 6.9) ---
  it("validateKeyPrefix agrees on non-string non-null inputs", () => {
    fc.assert(
      fc.property(nonStringNonNullArb, (value) => {
        const portalResult = portalValidate(value);
        const backendResult = backendValidate(value);
        assert.strictEqual(portalResult.ok, false);
        assert.strictEqual(backendResult.ok, false);
        assert.strictEqual(portalResult.ok, backendResult.ok);
        if (!portalResult.ok && !backendResult.ok) {
          assert.strictEqual(portalResult.error, backendResult.error);
        }
      }),
      { numRuns: RUNS }
    );
  });

  // --- Clause 6: generateSecretComponent produces the same key for the same bytes (Req 6.9) ---
  it("generateSecretComponent produces identical output given the same byte sequence", () => {
    fc.assert(
      fc.property(byteArrayArb, (bytes) => {
        // Create two independent sources from the same byte array so both
        // implementations see the exact same sequence.
        const portalSource = makeDeterministicSource([...bytes]);
        const backendSource = makeDeterministicSource([...bytes]);

        const portalSecret = portalGenerateSecret(portalSource);
        const backendSecret = backendGenerateSecret(backendSource);

        assert.strictEqual(
          portalSecret,
          backendSecret,
          `secret component diverges for bytes [${bytes.slice(0, 6).join(",")}...]: portal="${portalSecret}" backend="${backendSecret}"`
        );
      }),
      { numRuns: RUNS }
    );
  });

  // --- Clause 7: generateLicenseKey produces the same key for the same prefix and bytes (Req 6.9, 5.11) ---
  it("generateLicenseKey produces identical output given the same prefix and byte sequence", () => {
    fc.assert(
      fc.property(
        fc.option(mixedPrefixArb, { nil: undefined }),
        byteArrayArb,
        (rawPrefix, bytes) => {
          // Only test prefixes that both implementations would accept.
          const portalValidation = portalValidate(rawPrefix);
          fc.pre(portalValidation.ok);
          if (!portalValidation.ok) return;

          const prefix = portalValidation.value; // string | undefined

          const portalSource = makeDeterministicSource([...bytes]);
          const backendSource = makeDeterministicSource([...bytes]);

          const portalKey = portalGenerateKey(prefix, portalSource);
          const backendKey = backendGenerateKey(prefix, backendSource);

          assert.strictEqual(
            portalKey,
            backendKey,
            `key diverges for prefix="${prefix}": portal="${portalKey}" backend="${backendKey}"`
          );
        }
      ),
      { numRuns: RUNS }
    );
  });
});
