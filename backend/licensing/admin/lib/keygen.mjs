/**
 * License_Key generation for the licensing admin CLI (ES module mirror).
 *
 * This module mirrors `admin-portal/lib/licenses/keygen.ts` byte-for-byte in
 * observable behavior, against the same written specification. A parity
 * property test imports both implementations and asserts identical grammar and
 * identical normalization results, so the semantics of {@link normalizeKeyPrefix}
 * and {@link generateLicenseKey} must stay exactly aligned with the portal
 * module.
 *
 * A License_Key is composed, in order, of the literal segment `PDM`, an
 * optional normalized Custom_Key_Prefix, and a freshly generated
 * Key_Secret_Component:
 *
 *   - without a prefix: `PDM-<secret>`
 *   - with a prefix:    `PDM-<PREFIX>-<secret>`
 *
 * The Key_Secret_Component is 7 hyphen-separated groups of 4 Key_Alphabet
 * symbols (28 symbols × log2(32) = 140 bits of randomness, above the 128-bit
 * floor). Every byte is drawn from the cryptographically secure source in
 * `node:crypto` through an injectable random-byte source; no other source is
 * ever consulted, and a source failure or short read surfaces as a
 * {@link KeyGenerationError} rather than a weaker fallback.
 *
 * Since the backend has no shared Result type, {@link validateKeyPrefix}
 * returns a plain object mirroring the portal's `Result` shape:
 *   - success: `{ ok: true, value }`
 *   - failure: `{ ok: false, error }`
 *
 * @module admin/lib/keygen
 * Requirements: 6.9, 5.11, 6.1, 6.2, 6.3, 6.6, 6.7
 */

import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Result helpers (mirror the portal's module-private ok/fail)
// ---------------------------------------------------------------------------

function ok(value) {
  return { ok: true, value };
}

function fail(error) {
  return { ok: false, error };
}

// ---------------------------------------------------------------------------
// Alphabet and structural constants
// ---------------------------------------------------------------------------

/**
 * The 32-symbol Key_Alphabet: digits `0`–`9` and uppercase letters `A`–`Z`
 * excluding the ambiguous `I`, `L`, `O`, and `U`. Exactly 32 symbols, so each
 * symbol carries 5 bits.
 */
export const KEY_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Human-readable literal segment shared by every License_Key. */
export const LICENSE_KEY_PREFIX = "PDM";

/** Number of Key_Secret_Component groups (7 × 4 × 5 bits = 140 bits). */
export const SECRET_GROUPS = 7;

/** Number of Key_Alphabet symbols per Key_Secret_Component group. */
export const SECRET_GROUP_SIZE = 4;

/** Minimum length of a normalized Custom_Key_Prefix (Req 5.5). */
export const MIN_CUSTOM_PREFIX_LENGTH = 1;

/** Maximum length of a normalized Custom_Key_Prefix (Req 5.5). */
export const MAX_CUSTOM_PREFIX_LENGTH = 32;

/**
 * @deprecated Retained only so existing importers keep resolving. Aliases
 * {@link SECRET_GROUPS}; use that constant in new code.
 */
export const LICENSE_KEY_GROUPS = SECRET_GROUPS;

/** Total number of Key_Alphabet symbols in one Key_Secret_Component. */
const SECRET_LENGTH = SECRET_GROUPS * SECRET_GROUP_SIZE; // 28

/**
 * Largest drawn-value range whose size is an exact multiple of the alphabet
 * size, i.e. `256 - (256 % 32) = 256`. A byte at or above this limit is
 * rejected and redrawn so the byte→symbol mapping stays uniform even if the
 * alphabet size is ever changed to a non-divisor of 256 (Req 6.3). With the
 * current 32-symbol alphabet the limit is the whole byte range, so no byte is
 * ever rejected, and `symbol = KEY_ALPHABET[b >>> 3]` gives each symbol exactly
 * 8 preimages with no remainder reduction.
 */
const ACCEPT_LIMIT = 256 - (256 % KEY_ALPHABET.length); // 256

// ---------------------------------------------------------------------------
// Errors and injection points
// ---------------------------------------------------------------------------

/**
 * Thrown when the `node:crypto` byte source throws or under-delivers (Req 6.8).
 * No fallback source is consulted; the caller must abort without a write.
 */
export class KeyGenerationError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "KeyGenerationError";
  }
}

/** Default byte source: cryptographically secure bytes from `node:crypto`. */
const defaultRandomBytes = (n) => randomBytes(n);

// ---------------------------------------------------------------------------
// Custom_Key_Prefix normalization and validation
// ---------------------------------------------------------------------------

/**
 * Normalize a submitted Custom_Key_Prefix by applying the ordered steps of
 * Requirement 5.3:
 *   1. remove leading and trailing whitespace,
 *   2. convert letters to uppercase,
 *   3. replace each run of whitespace or underscore characters with a single hyphen,
 *   4. replace each run of consecutive hyphens with a single hyphen,
 *   5. remove leading and trailing hyphens.
 *
 * Total and idempotent: `normalizeKeyPrefix(normalizeKeyPrefix(x))` equals
 * `normalizeKeyPrefix(x)` for every input.
 *
 * @param {string} input
 * @returns {string}
 */
export function normalizeKeyPrefix(input) {
  let value = input.trim();
  value = value.toUpperCase();
  value = value.replace(/[\s_]+/g, "-");
  value = value.replace(/-+/g, "-");
  value = value.replace(/^-+|-+$/g, "");
  return value;
}

/**
 * Structural check of a submitted Custom_Key_Prefix.
 *
 * Returns:
 *   - `ok(undefined)` when the prefix is absent — omitted, `null`, or a string
 *     containing only whitespace — so the caller mints an unprefixed key with
 *     no validation error (Req 5.2);
 *   - an error for a value that is present but neither a string nor `null`
 *     (Req 5.12);
 *   - an error when the normalized value contains a character other than
 *     `A`–`Z`, `0`–`9`, or a hyphen (Req 5.4);
 *   - an error when the normalized value is shorter than
 *     {@link MIN_CUSTOM_PREFIX_LENGTH} or longer than
 *     {@link MAX_CUSTOM_PREFIX_LENGTH} (Req 5.5);
 *   - `ok(<normalized>)` otherwise.
 *
 * @param {unknown} input
 * @returns {{ ok: true, value: (string|undefined) } | { ok: false, error: string }}
 */
export function validateKeyPrefix(input) {
  // Absent: omitted or explicitly null (Req 5.2).
  if (input === undefined || input === null) {
    return ok(undefined);
  }
  // Present but not a string (Req 5.12).
  if (typeof input !== "string") {
    return fail("Custom key prefix must be a string");
  }
  // Absent: whitespace-only string (Req 5.2). Checked before normalization so a
  // non-whitespace value that normalizes to empty (e.g. "___") is still treated
  // as a present prefix and rejected on length below.
  if (input.trim() === "") {
    return ok(undefined);
  }

  const normalized = normalizeKeyPrefix(input);

  // Charset violation (Req 5.4).
  if (/[^A-Z0-9-]/.test(normalized)) {
    return fail(
      "Custom key prefix must contain only letters A-Z, digits 0-9, and hyphens"
    );
  }
  // Length violation, including a value that normalized away to empty (Req 5.5).
  if (
    normalized.length < MIN_CUSTOM_PREFIX_LENGTH ||
    normalized.length > MAX_CUSTOM_PREFIX_LENGTH
  ) {
    return fail(
      `Custom key prefix must be between ${MIN_CUSTOM_PREFIX_LENGTH} and ${MAX_CUSTOM_PREFIX_LENGTH} characters after normalization`
    );
  }

  return ok(normalized);
}

// ---------------------------------------------------------------------------
// Key_Secret_Component generation
// ---------------------------------------------------------------------------

/**
 * Draw `n` bytes from the injected source, treating any throw or short read as
 * a {@link KeyGenerationError}. No fallback source is ever consulted (Req 6.1,
 * 6.8).
 *
 * @param {(n: number) => Uint8Array} random
 * @param {number} n
 * @returns {Uint8Array}
 */
function drawBytes(random, n) {
  let bytes;
  try {
    bytes = random(n);
  } catch (cause) {
    throw new KeyGenerationError("Random byte source failed", { cause });
  }
  if (!(bytes instanceof Uint8Array)) {
    throw new KeyGenerationError("Random byte source did not return bytes");
  }
  if (bytes.length < n) {
    throw new KeyGenerationError(
      `Random byte source returned a short read (${bytes.length} of ${n} bytes)`
    );
  }
  return bytes;
}

/**
 * Generate a Key_Secret_Component: 7 hyphen-separated groups of 4 Key_Alphabet
 * symbols (34 characters). Each symbol is chosen by drawing one byte and
 * mapping it through `KEY_ALPHABET[b >>> 3]`, discarding and redrawing any byte
 * at or above {@link ACCEPT_LIMIT} so the mapping is uniform with no remainder
 * reduction (Req 6.2, 6.3). A single `randomBytes(28)` call suffices in the
 * common case; the loop refills only if the rejection branch consumes values.
 *
 * @param {(n: number) => Uint8Array} [random]
 * @returns {string}
 */
export function generateSecretComponent(random = defaultRandomBytes) {
  const symbols = [];

  while (symbols.length < SECRET_LENGTH) {
    const bytes = drawBytes(random, SECRET_LENGTH - symbols.length);
    for (let i = 0; i < bytes.length && symbols.length < SECRET_LENGTH; i++) {
      const b = bytes[i];
      // Rejection/redraw branch: keeps the mapping unbiased for any alphabet
      // size. With 32 symbols ACCEPT_LIMIT is 256, so this never triggers.
      if (b >= ACCEPT_LIMIT) {
        continue;
      }
      symbols.push(KEY_ALPHABET[b >>> 3]);
    }
  }

  const groups = [];
  for (let g = 0; g < SECRET_GROUPS; g++) {
    const start = g * SECRET_GROUP_SIZE;
    groups.push(symbols.slice(start, start + SECRET_GROUP_SIZE).join(""));
  }
  return groups.join("-");
}

// ---------------------------------------------------------------------------
// License_Key assembly
// ---------------------------------------------------------------------------

/**
 * Generate a License_Key.
 *
 * When `prefix` is a non-empty string (it must already be normalized and
 * validated by {@link validateKeyPrefix}) the result is
 * `PDM-<PREFIX>-<secret>` (Req 5.1); otherwise it is `PDM-<secret>` (Req 5.2).
 * The Key_Secret_Component is drawn from `random`, defaulting to `node:crypto`.
 * A source failure propagates as a {@link KeyGenerationError} and no key is
 * returned (Req 6.8).
 *
 * @param {string} [prefix]
 * @param {(n: number) => Uint8Array} [random]
 * @returns {string}
 */
export function generateLicenseKey(prefix, random) {
  const secret = generateSecretComponent(random);
  if (prefix !== undefined && prefix !== "") {
    return `${LICENSE_KEY_PREFIX}-${prefix}-${secret}`;
  }
  return `${LICENSE_KEY_PREFIX}-${secret}`;
}
