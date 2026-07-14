/**
 * Pure validators/sanitizers for the Admin & Reseller Portal.
 *
 * Every validator returns a typed Result:
 *   - { ok: true, value: T } on success (value is the sanitized/normalized output)
 *   - { ok: false, error: string } on failure (error is a human-readable reason)
 *
 * No side effects, no external dependencies.
 *
 * @module validation
 */

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** Discriminated-union result type used by all validators. */
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function fail<T = never>(error: string): Result<T> {
  return { ok: false, error };
}

// ---------------------------------------------------------------------------
// License Key: PDM-XXXX-XXXX-XXXX-XXXX (X = uppercase hex)
// ---------------------------------------------------------------------------

const LICENSE_KEY_REGEX = /^PDM-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/;

/**
 * Validates that a value matches the License_Key format `PDM-XXXX-XXXX-XXXX-XXXX`
 * where each X is an uppercase hexadecimal character (0-9, A-F).
 */
export function validateLicenseKey(input: unknown): Result<string> {
  if (typeof input !== "string") {
    return fail("License key must be a string");
  }
  const trimmed = input.trim();
  if (!LICENSE_KEY_REGEX.test(trimmed)) {
    return fail(
      "License key must match format PDM-XXXX-XXXX-XXXX-XXXX where X is uppercase hex"
    );
  }
  return ok(trimmed);
}

// ---------------------------------------------------------------------------
// maxActivations: integer >= 1
// ---------------------------------------------------------------------------

/**
 * Validates that `maxActivations` is an integer greater than or equal to 1.
 * Accepts number inputs only (not string representations).
 */
export function validateMaxActivations(input: unknown): Result<number> {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return fail("maxActivations must be a finite number");
  }
  if (!Number.isInteger(input)) {
    return fail("maxActivations must be an integer");
  }
  if (input < 1) {
    return fail("maxActivations must be at least 1");
  }
  return ok(input);
}

// ---------------------------------------------------------------------------
// ISO 8601 UTC timestamp (expiresAt)
// ---------------------------------------------------------------------------

/**
 * ISO 8601 date-time pattern accepting:
 * - Full date-time with T separator and Z or +00:00/-00:00 UTC offset
 * - Supports optional fractional seconds
 */
const ISO_8601_UTC_REGEX =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]00:?00)$/;

/**
 * Validates that a value is a valid ISO 8601 UTC date-time string.
 *
 * The value must both match the accepted UTC syntax and denote a real calendar
 * instant. `Date.parse` alone is insufficient because it silently normalizes
 * day/time overflows (e.g. `2024-02-30T00:00:00Z` becomes March 1), which would
 * let impossible dates slip through. To guard against that we round-trip the
 * parsed instant back through its UTC calendar fields and require them to match
 * the year-month-day-hour-minute-second written in the input; any normalization
 * shows up as a mismatch and is rejected.
 */
export function validateIso8601Utc(input: unknown): Result<string> {
  if (typeof input !== "string") {
    return fail("Timestamp must be a string");
  }
  const trimmed = input.trim();
  const match = ISO_8601_UTC_REGEX.exec(trimmed);
  if (!match) {
    return fail("Timestamp must be a valid ISO 8601 UTC date-time (e.g. 2024-01-15T10:30:00Z)");
  }

  // Verify it parses to a real date.
  const parsedMs = Date.parse(trimmed);
  if (Number.isNaN(parsedMs)) {
    return fail("Timestamp is not a valid date");
  }

  // Round-trip guard: the parsed instant must re-serialize to the same calendar
  // fields as the input. If Date normalized an overflow (Feb 30 -> Mar 1, day 32,
  // etc.), the UTC fields will differ and we reject.
  const [, year, month, day, hour, minute, second] = match;
  const parsedDate = new Date(parsedMs);
  const sameCalendar =
    parsedDate.getUTCFullYear() === Number(year) &&
    parsedDate.getUTCMonth() + 1 === Number(month) &&
    parsedDate.getUTCDate() === Number(day) &&
    parsedDate.getUTCHours() === Number(hour) &&
    parsedDate.getUTCMinutes() === Number(minute) &&
    parsedDate.getUTCSeconds() === Number(second);

  if (!sameCalendar) {
    return fail("Timestamp is not a valid calendar date-time");
  }

  return ok(trimmed);
}

// ---------------------------------------------------------------------------
// Status enum: "active" | "revoked" | "suspended"
// ---------------------------------------------------------------------------

const VALID_STATUSES = ["active", "revoked", "suspended"] as const;
export type LicenseStatus = (typeof VALID_STATUSES)[number];

/**
 * Validates that a value is one of the allowed License_Status values.
 */
export function validateStatus(input: unknown): Result<LicenseStatus> {
  if (typeof input !== "string") {
    return fail("Status must be a string");
  }
  const trimmed = input.trim() as LicenseStatus;
  if (!VALID_STATUSES.includes(trimmed)) {
    return fail(`Status must be one of: ${VALID_STATUSES.join(", ")}`);
  }
  return ok(trimmed);
}

// ---------------------------------------------------------------------------
// S3 release URL: https under bucket pdm-updates-452359090613-aps1
// ---------------------------------------------------------------------------

const S3_BUCKET = "pdm-updates-452359090613-aps1";

/**
 * Accepted URL patterns for the release bucket:
 * - Virtual-hosted style: https://pdm-updates-452359090613-aps1.s3.amazonaws.com/...
 * - Virtual-hosted with region: https://pdm-updates-452359090613-aps1.s3.ap-south-1.amazonaws.com/...
 * - Path style: https://s3.amazonaws.com/pdm-updates-452359090613-aps1/...
 * - Path style with region: https://s3.ap-south-1.amazonaws.com/pdm-updates-452359090613-aps1/...
 */
export function validateReleaseUrl(input: unknown): Result<string> {
  if (typeof input !== "string") {
    return fail("Release URL must be a string");
  }
  const trimmed = input.trim();

  // Must be https
  if (!trimmed.startsWith("https://")) {
    return fail("Release URL must use HTTPS protocol");
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return fail("Release URL is not a valid URL");
  }

  if (url.protocol !== "https:") {
    return fail("Release URL must use HTTPS protocol");
  }

  const host = url.hostname.toLowerCase();

  // Virtual-hosted style: bucket.s3[.region].amazonaws.com
  const virtualHosted =
    host === `${S3_BUCKET}.s3.amazonaws.com` ||
    host.startsWith(`${S3_BUCKET}.s3.`) && host.endsWith(".amazonaws.com");

  // Path style: s3[.region].amazonaws.com/bucket/...
  const pathStyle =
    (host === "s3.amazonaws.com" || (host.startsWith("s3.") && host.endsWith(".amazonaws.com"))) &&
    url.pathname.startsWith(`/${S3_BUCKET}/`);

  if (!virtualHosted && !pathStyle) {
    return fail(
      `Release URL must be an HTTPS URL under S3 bucket ${S3_BUCKET}`
    );
  }

  return ok(trimmed);
}

// ---------------------------------------------------------------------------
// SHA-256 checksum: 64-character hexadecimal string
// ---------------------------------------------------------------------------

const CHECKSUM_REGEX = /^[0-9a-fA-F]{64}$/;

/**
 * Validates that a value is a 64-character hexadecimal string (SHA-256 checksum).
 * The value is normalized to lowercase.
 */
export function validateChecksum(input: unknown): Result<string> {
  if (typeof input !== "string") {
    return fail("Checksum must be a string");
  }
  const trimmed = input.trim();
  if (!CHECKSUM_REGEX.test(trimmed)) {
    return fail("Checksum must be a 64-character hexadecimal string");
  }
  return ok(trimmed.toLowerCase());
}

// ---------------------------------------------------------------------------
// SEO title: 1–70 characters
// ---------------------------------------------------------------------------

/**
 * Validates that a page title is between 1 and 70 characters inclusive.
 */
export function validateSeoTitle(input: unknown): Result<string> {
  if (typeof input !== "string") {
    return fail("SEO title must be a string");
  }
  const trimmed = input.trim();
  if (trimmed.length < 1) {
    return fail("SEO title must be at least 1 character");
  }
  if (trimmed.length > 70) {
    return fail("SEO title must be at most 70 characters");
  }
  return ok(trimmed);
}

// ---------------------------------------------------------------------------
// SEO meta description: 50–160 characters
// ---------------------------------------------------------------------------

/**
 * Validates that a meta description is between 50 and 160 characters inclusive.
 */
export function validateSeoDescription(input: unknown): Result<string> {
  if (typeof input !== "string") {
    return fail("SEO meta description must be a string");
  }
  const trimmed = input.trim();
  if (trimmed.length < 50) {
    return fail("SEO meta description must be at least 50 characters");
  }
  if (trimmed.length > 160) {
    return fail("SEO meta description must be at most 160 characters");
  }
  return ok(trimmed);
}

// ---------------------------------------------------------------------------
// Api_Key format: pdm_ak_ prefix + 48 hex characters (total 55 chars)
// ---------------------------------------------------------------------------

/**
 * Api_Key format: `pdm_ak_` prefix followed by 48 lowercase hexadecimal characters.
 * This gives a 192-bit secret space, which is more than sufficient.
 */
const API_KEY_REGEX = /^pdm_ak_[0-9a-f]{48}$/;

/**
 * Validates that a value matches the expected Api_Key format.
 */
export function validateApiKey(input: unknown): Result<string> {
  if (typeof input !== "string") {
    return fail("API key must be a string");
  }
  const trimmed = input.trim();
  if (!API_KEY_REGEX.test(trimmed)) {
    return fail("API key must match format pdm_ak_ followed by 48 hex characters");
  }
  return ok(trimmed);
}

// ---------------------------------------------------------------------------
// 6-digit email OTP
// ---------------------------------------------------------------------------

const OTP_REGEX = /^\d{6}$/;

/**
 * Validates that a value is a 6-digit numeric OTP code.
 */
export function validateEmailOtp(input: unknown): Result<string> {
  if (typeof input !== "string") {
    return fail("OTP must be a string");
  }
  const trimmed = input.trim();
  if (!OTP_REGEX.test(trimmed)) {
    return fail("OTP must be exactly 6 digits");
  }
  return ok(trimmed);
}
