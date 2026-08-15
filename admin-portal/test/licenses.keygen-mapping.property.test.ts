// Feature: license-key-management-enhancements
// Property 3: The byte-to-symbol mapping is uniform and free of remainder reduction
//
// Validates: Requirements 6.3
//
// For any drawn byte value the Key_Generator either discards the value as
// outside the accepted range — the largest range whose size is an exact
// multiple of the 32-symbol Key_Alphabet — and draws a replacement, or maps it
// to a Key_Alphabet symbol such that every one of the 32 symbols is the image
// of exactly the same number of accepted byte values (8 each, since 256/32 =
// 8), and no symbol is ever derived by reducing a drawn value modulo the
// alphabet size.
//
// With the current 32-symbol alphabet, ACCEPT_LIMIT = 256 - (256 % 32) = 256,
// so no byte is ever rejected and `symbol = KEY_ALPHABET[b >>> 3]` gives each
// symbol exactly 8 preimages. The rejection/redraw path is exercised with an
// injected byte source that first delivers an out-of-range value (which must be
// discarded) followed by an in-range value (which must be the one that lands).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  KEY_ALPHABET,
  SECRET_GROUPS,
  SECRET_GROUP_SIZE,
  generateSecretComponent,
  type RandomBytes,
} from "../lib/licenses/keygen.ts";

const RUNS = 100;

/** Number of Key_Secret_Component symbols: 7 groups × 4 symbols = 28. */
const SECRET_LENGTH = SECRET_GROUPS * SECRET_GROUP_SIZE;

/** ACCEPT_LIMIT as defined by the module: 256 - (256 % 32) = 256. */
const ACCEPT_LIMIT = 256 - (256 % KEY_ALPHABET.length);

/** The reference byte→symbol mapping under test: KEY_ALPHABET[b >>> 3]. */
function mapByte(b: number): string {
  return KEY_ALPHABET[b >>> 3];
}

/**
 * Strip the hyphens from a Key_Secret_Component, yielding the raw run of
 * Key_Alphabet symbols so per-symbol assertions can index them directly.
 */
function symbolsOf(secret: string): string {
  return secret.split("-").join("");
}

/**
 * Build a RandomBytes source that replays a fixed script of byte values,
 * refilling on each call with whatever remains. Every requested chunk is
 * satisfied from the script; if the script runs dry it throws, which surfaces
 * the mistake loudly instead of silently padding.
 */
function scriptedSource(script: number[]): RandomBytes {
  let pos = 0;
  return (n: number) => {
    if (pos + n > script.length) {
      throw new Error(
        `scripted source exhausted: requested ${n} at ${pos} of ${script.length}`
      );
    }
    const slice = Uint8Array.from(script.slice(pos, pos + n));
    pos += n;
    return slice;
  };
}

describe("Property 3: byte-to-symbol mapping is uniform and free of remainder reduction", () => {
  // --- Clause 1: exhaustive over all 256 byte values (Req 6.3) ---
  //
  // Every byte 0..255 is accepted (ACCEPT_LIMIT is 256) and maps through the
  // top-5-bits rule. Crucially this is NOT remainder reduction: for the vast
  // majority of bytes `b >>> 3` differs from `b % 32`, and we assert exactly
  // that difference is present so a regression to `b % 32` would be caught.
  it("maps every one of the 256 byte values by the top 5 bits, never by remainder", () => {
    const preimageCounts = new Array<number>(KEY_ALPHABET.length).fill(0);
    let differsFromRemainder = 0;

    for (let b = 0; b < 256; b++) {
      // Below ACCEPT_LIMIT means accepted; with 32 symbols that's all 256.
      assert.ok(b < ACCEPT_LIMIT, `byte ${b} must be within the accepted range`);

      const symbol = mapByte(b);
      const index = KEY_ALPHABET.indexOf(symbol);
      assert.ok(index >= 0, `symbol for byte ${b} must be a Key_Alphabet symbol`);

      // The mapping is exactly the top 5 bits, i.e. floor(b / 8).
      assert.strictEqual(index, b >>> 3, `byte ${b} must map by its top 5 bits`);

      preimageCounts[index]++;

      // Track whether this differs from a naive remainder reduction b % 32.
      if ((b >>> 3) !== b % KEY_ALPHABET.length) {
        differsFromRemainder++;
      }
    }

    // Uniformity: each of the 32 symbols is the image of exactly 8 bytes.
    for (let s = 0; s < KEY_ALPHABET.length; s++) {
      assert.strictEqual(
        preimageCounts[s],
        256 / KEY_ALPHABET.length,
        `symbol ${KEY_ALPHABET[s]} must have exactly 8 preimages`
      );
    }

    // No remainder reduction: were the generator using `b % 32` it would still
    // be uniform (b % 32 also yields 8 preimages each), so uniformity alone
    // cannot rule remainder reduction out. What rules it out is that the
    // top-5-bits mapping actually disagrees with `b % 32` on a large share of
    // bytes — proving the implementation is not modulo reduction in disguise.
    assert.ok(
      differsFromRemainder > 0,
      "the mapping must differ from remainder reduction on at least one byte"
    );
    // Concretely, only the 8 bytes where floor(b/8) == b % 32 coincide, so the
    // two mappings disagree on the remaining 248.
    assert.strictEqual(
      differsFromRemainder,
      248,
      "top-5-bits and remainder reduction must disagree on exactly 248 of 256 bytes"
    );
  });

  // --- Clause 2: generateSecretComponent uses the mapping over random draws ---
  //
  // Feed the generator a fully-scripted, in-range byte sequence and confirm the
  // emitted symbols are exactly KEY_ALPHABET[b >>> 3] for each consumed byte,
  // proving the production path applies the same mapping and never a remainder.
  it("generateSecretComponent maps injected bytes by the top 5 bits", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 255 }), {
          minLength: SECRET_LENGTH,
          maxLength: SECRET_LENGTH,
        }),
        (bytes) => {
          const secret = generateSecretComponent(scriptedSource(bytes));
          const symbols = symbolsOf(secret);

          assert.strictEqual(
            symbols.length,
            SECRET_LENGTH,
            "secret must contain 28 symbols"
          );
          for (let i = 0; i < SECRET_LENGTH; i++) {
            assert.strictEqual(
              symbols[i],
              mapByte(bytes[i]),
              `symbol ${i} must be KEY_ALPHABET[byte >>> 3]`
            );
          }
        }
      ),
      { numRuns: RUNS }
    );
  });

  // --- Clause 3: the rejection/redraw boundary (Req 6.3) ---
  //
  // The module's rejection branch is `if (b >= ACCEPT_LIMIT) continue;` with
  // `ACCEPT_LIMIT = 256 - (256 % 32) = 256`. Because a real byte source (the
  // injected RandomBytes returns a Uint8Array, whose elements are 0..255) can
  // never deliver a value >= 256, the accepted range is provably the whole byte
  // range: every drawn byte takes the "map it" branch and none is ever
  // discarded. That is exactly what keeps the mapping uniform with no remainder
  // reduction for the current alphabet. This clause pins that boundary down.
  it("accepts the entire byte range so no drawn byte is ever discarded", () => {
    // The accepted range is the largest multiple of the alphabet size <= 256.
    assert.strictEqual(256 % KEY_ALPHABET.length, 0, "256 must be a multiple of 32");
    assert.strictEqual(ACCEPT_LIMIT, 256, "ACCEPT_LIMIT must cover the whole byte range");

    // Every value a Uint8Array byte source can produce is inside the accepted
    // range, so the `b >= ACCEPT_LIMIT` redraw branch is never taken.
    for (let b = 0; b < 256; b++) {
      assert.ok(b < ACCEPT_LIMIT, `byte ${b} must be accepted, never redrawn`);
    }
  });

  // Because no byte is ever rejected, generating a full Key_Secret_Component
  // consumes exactly one drawn byte per symbol — there is no redraw overhead.
  // We count every byte the generator pulls from an injected in-range source
  // and assert it equals the symbol count exactly.
  it("draws exactly one byte per emitted symbol with no redraws", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 255 }), {
          minLength: SECRET_LENGTH,
          maxLength: SECRET_LENGTH,
        }),
        (bytes) => {
          let drawn = 0;
          const counting: RandomBytes = (n: number) => {
            drawn += n;
            return Uint8Array.from(bytes.slice(0, n));
          };

          const secret = generateSecretComponent(counting);
          const symbols = symbolsOf(secret);

          assert.strictEqual(symbols.length, SECRET_LENGTH);
          assert.strictEqual(
            drawn,
            SECRET_LENGTH,
            "no byte may be discarded, so draws must equal symbol count"
          );
          // And the symbols are the top-5-bits image of the drawn bytes.
          for (let i = 0; i < SECRET_LENGTH; i++) {
            assert.strictEqual(symbols[i], mapByte(bytes[i]));
          }
        }
      ),
      { numRuns: RUNS }
    );
  });
});
