// Feature: admin-reseller-portal, Property 20: Checksum validation
//
// For any submitted checksum, the value is accepted only if it is a
// 64-character hexadecimal string; otherwise it is rejected.
//
// Validates: Requirements 8.4

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { validateChecksum } from "../lib/validation.ts";

const NUM_RUNS = 100;

const HEX_DIGITS = "0123456789abcdefABCDEF";
// A representative set of characters that are NOT hexadecimal digits.
const NON_HEX_CHARS = "ghijklmnopqrstuvwxyzGHIJKLMNOPQRSTUVWXYZ!@#$%^&*()_+-=[]{};:'\",.<>/?\\|`~ é😀".split("");
const NON_HEX_CHAR = fc
  .constantFrom(...NON_HEX_CHARS)
  .filter((c) => !/[0-9a-fA-F]/.test(c));

/** A well-formed 64-character hexadecimal string (mixed case). */
const validChecksum = fc
  .array(fc.constantFrom(...HEX_DIGITS.split("")), {
    minLength: 64,
    maxLength: 64,
  })
  .map((chars) => chars.join(""));

describe("Property 20: Checksum validation", () => {
  it("accepts any 64-character hex string and normalizes to lowercase", () => {
    fc.assert(
      fc.property(validChecksum, (hex) => {
        const result = validateChecksum(hex);
        assert.strictEqual(result.ok, true);
        if (result.ok) {
          assert.strictEqual(result.value, hex.toLowerCase());
          // Value remains a 64-char hex string
          assert.match(result.value, /^[0-9a-f]{64}$/);
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("accepts 64-hex strings surrounded by whitespace (trimmed)", () => {
    fc.assert(
      fc.property(
        validChecksum,
        fc.stringMatching(/^[ \t\n\r]*$/),
        fc.stringMatching(/^[ \t\n\r]*$/),
        (hex, lead, trail) => {
          const result = validateChecksum(lead + hex + trail);
          assert.strictEqual(result.ok, true);
          if (result.ok) {
            assert.strictEqual(result.value, hex.toLowerCase());
          }
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it("rejects hex strings whose (trimmed) length is not exactly 64", () => {
    fc.assert(
      fc.property(
        fc
          .array(fc.constantFrom(...HEX_DIGITS.split("")), {
            minLength: 0,
            maxLength: 200,
          })
          .map((chars) => chars.join(""))
          .filter((s) => s.trim().length !== 64),
        (hexWrongLen) => {
          const result = validateChecksum(hexWrongLen);
          assert.strictEqual(result.ok, false);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it("rejects 64-length strings that contain at least one non-hex character", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...HEX_DIGITS.split("")), {
          minLength: 63,
          maxLength: 63,
        }),
        NON_HEX_CHAR,
        fc.nat({ max: 63 }),
        (hexChars, badChar, pos) => {
          const chars = hexChars.slice();
          chars.splice(pos, 0, badChar); // now length 64 with one bad char
          const candidate = chars.join("");
          // Guard: ensure the string is genuinely not a valid trimmed 64-hex
          fc.pre(!/^[0-9a-fA-F]{64}$/.test(candidate.trim()));
          const result = validateChecksum(candidate);
          assert.strictEqual(result.ok, false);
        }
      ),
      { numRuns: NUM_RUNS }
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
        (nonString) => {
          const result = validateChecksum(nonString as unknown);
          assert.strictEqual(result.ok, false);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });
});
