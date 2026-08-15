// Feature: license-key-management-enhancements
// Property 2: Key_Secret_Components are independent of every request input and
//             mutually distinct.
//
// Validates: Requirements 6.1, 6.4, 6.5, 11.5
//
// For any fixed combination of Custom_Key_Prefix, Customer_Profile, actor
// identity, creation timestamp, and sequence position, repeated key generation
// yields a different Key_Secret_Component on every repetition (6.4); every
// secret is a pure function of the bytes drawn from the injected `node:crypto`
// byte source alone and of no request input (6.1); and no batch of
// consecutively generated keys for one identical prefix contains two equal
// secret components (6.5, 11.5). The batch clause draws >= 1000 keys per
// iteration as required for Req 6.5.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  generateLicenseKey,
  generateSecretComponent,
  SECRET_GROUPS,
  SECRET_GROUP_SIZE,
  type RandomBytes,
} from "../lib/licenses/keygen.ts";

const RUNS = 100;

/** Number of Key_Alphabet symbols in one Key_Secret_Component (28). */
const SECRET_SYMBOLS = SECRET_GROUPS * SECRET_GROUP_SIZE;

/**
 * Character length of a rendered Key_Secret_Component: the symbols plus the
 * hyphens between the groups (e.g. 28 symbols + 6 hyphens = 34).
 */
const SECRET_TEXT_LENGTH = SECRET_SYMBOLS + (SECRET_GROUPS - 1);

/** Canonical Key_Secret_Component shape: 7 hyphen-separated groups of 4. */
const SECRET_RE = new RegExp(
  `^([0-9A-HJKMNP-TV-Z]{${SECRET_GROUP_SIZE}}-){${SECRET_GROUPS - 1}}[0-9A-HJKMNP-TV-Z]{${SECRET_GROUP_SIZE}}$`
);

/**
 * Extract the trailing Key_Secret_Component from a License_Key. The secret is
 * always the final {@link SECRET_TEXT_LENGTH} characters of the key, regardless
 * of whether a Custom_Key_Prefix is present.
 */
function secretOf(key: string): string {
  const secret = key.slice(-SECRET_TEXT_LENGTH);
  assert.match(secret, SECRET_RE, `extracted secret must be well-formed: ${secret}`);
  return secret;
}

/**
 * A deterministic byte source that always returns the same fixed bytes. Because
 * the accepted range spans the whole byte space (ACCEPT_LIMIT === 256), the
 * generator consumes exactly one draw of {@link SECRET_SYMBOLS} bytes, so a
 * source returning those bytes fully determines the secret.
 */
function fixedSource(bytes: Uint8Array): RandomBytes {
  return (n: number) => bytes.slice(0, n);
}

/** Arbitrary block of bytes large enough to satisfy one secret generation. */
const bytesArb: fc.Arbitrary<Uint8Array> = fc
  .array(fc.integer({ min: 0, max: 255 }), {
    minLength: SECRET_SYMBOLS,
    maxLength: SECRET_SYMBOLS,
  })
  .map((xs) => Uint8Array.from(xs));

/** Arbitrary Custom_Key_Prefix already in normalized (accepted) form. */
const prefixArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(..."ABCDEFGHJKMNPQRSTVWXYZ0123456789".split("")), {
    minLength: 1,
    maxLength: 12,
  })
  .map((cs) => cs.join(""));

describe("Property 2: secret independence and uniqueness", () => {
  // --- Clause 1 (Req 6.1): the secret is a pure function of the drawn bytes,
  //     independent of the Custom_Key_Prefix and every other request input. ---
  it("secret depends only on the drawn bytes, never on the prefix", () => {
    fc.assert(
      fc.property(bytesArb, prefixArb, prefixArb, (bytes, prefixA, prefixB) => {
        const source = fixedSource(bytes);

        // The bare secret generator, and the assembled key with two different
        // prefixes and with no prefix, all fed the SAME bytes.
        const bare = generateSecretComponent(source);
        const withA = secretOf(generateLicenseKey(prefixA, source));
        const withB = secretOf(generateLicenseKey(prefixB, source));
        const withNone = secretOf(generateLicenseKey(undefined, source));

        // Identical bytes => identical secret, whatever the surrounding input.
        assert.strictEqual(withA, bare);
        assert.strictEqual(withB, bare);
        assert.strictEqual(withNone, bare);
      }),
      { numRuns: RUNS }
    );
  });

  // --- Clause 2 (Req 6.1): the mapping is deterministic in its byte source —
  //     equal bytes always yield the equal secret across independent calls. ---
  it("equal byte draws yield equal secrets across independent calls", () => {
    fc.assert(
      fc.property(bytesArb, (bytes) => {
        const first = generateSecretComponent(fixedSource(bytes));
        const second = generateSecretComponent(fixedSource(bytes));
        assert.strictEqual(first, second);
      }),
      { numRuns: RUNS }
    );
  });

  // --- Clause 3 (Req 6.4): repeating a request with every input held identical
  //     yields a different secret on each repetition when the real
  //     cryptographic source is used. ---
  it("repeated generation with identical inputs yields different secrets", () => {
    fc.assert(
      fc.property(prefixArb, (prefix) => {
        // Same prefix (and, implicitly, same actor/timestamp/sequence) twice.
        const first = secretOf(generateLicenseKey(prefix));
        const second = secretOf(generateLicenseKey(prefix));
        assert.notStrictEqual(
          first,
          second,
          "two secrets for identical inputs must differ"
        );
      }),
      { numRuns: RUNS }
    );
  });

  // --- Clause 4 (Req 6.5, 11.5): a batch of >= 1000 consecutively generated
  //     keys for one identical prefix contains no two equal secrets. ---
  it("a batch of >= 1000 keys for one prefix has all-distinct secrets", () => {
    const BATCH = 1000;
    fc.assert(
      fc.property(prefixArb, (prefix) => {
        const secrets = new Set<string>();
        for (let i = 0; i < BATCH; i++) {
          secrets.add(secretOf(generateLicenseKey(prefix)));
        }
        assert.strictEqual(
          secrets.size,
          BATCH,
          "every secret in the batch must be distinct"
        );
      }),
      { numRuns: RUNS }
    );
  });
});
