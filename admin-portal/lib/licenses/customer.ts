/**
 * Customer_Profile normalization and validation for the Admin & Reseller Portal.
 *
 * A License_Record may carry six optional, additive Customer_Fields —
 * `customerEmail`, `customerName`, `customerPhone`, `customerCountry`,
 * `customerCompany`, and `customerNotes` — stored as attributes of the *same*
 * `pdm-licenses` item. This module is the single, pure place that decides, for
 * a submitted request body, which Customer_Fields to write (in normalized
 * form), which to clear, and which are invalid.
 *
 * The contract is deliberately total and side-effect free (Req 4.9, 4.10):
 *
 *  - **Normalize first, then validate** every *submitted* Customer_Field, in
 *    the order Requirement 4.9 demands, before any attribute is written by a
 *    caller (Req 4.2, 4.4, 4.11, 4.12).
 *  - **All-or-nothing at the call site.** {@link evaluateCustomerProfile} never
 *    throws and never partially applies; it *reports* every offending field so
 *    the caller can reject a request naming all of them and write nothing
 *    (Req 4.9). Callers MUST treat a non-empty `errors` as a rejection.
 *  - A submitted value that is **present but neither a string nor `null`**
 *    yields an error and **no** normalized form (Req 4.7).
 *  - A submitted value whose normalized form is the **empty string** (including
 *    `null`, `""`, or a whitespace-only string) is neither an error nor a
 *    stored attribute: it lands in `clear`, meaning "absent on create, REMOVE
 *    on update" (Req 1.3, 2.2, 4.13).
 *
 * The `isEmailFormat` / `isCountryCode` / `isPhoneFormat` predicates implement
 * the glossary rules directly rather than through permissive regexes, so the
 * stored form and the search form agree (Req 4.1, 4.3, 4.5).
 *
 * No I/O, no external dependencies — every collaborator that would perform a
 * side effect lives in the storage layer (`create.ts`, `attributes.ts`).
 *
 * @module lib/licenses/customer
 * Requirements: 1.2, 1.3, 1.4, 2.1, 2.2, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7,
 * 4.9, 4.10, 4.11, 4.12, 4.13
 */

// ─── Field catalogue ─────────────────────────────────────────────────────────

/** The six additive Customer_Field attribute names, in a stable order. */
export const CUSTOMER_FIELDS = [
  "customerEmail",
  "customerName",
  "customerPhone",
  "customerCountry",
  "customerCompany",
  "customerNotes",
] as const;

/** One of the six Customer_Field attribute names. */
export type CustomerField = (typeof CUSTOMER_FIELDS)[number];

/**
 * The subset of Customer_Fields a license search compares a term against
 * (Req 3.2). Exported here so the search path and this module share one source
 * of truth.
 */
export const SEARCHABLE_CUSTOMER_FIELDS = [
  "customerEmail",
  "customerName",
  "customerCompany",
  "customerPhone",
] as const;

/** Maximum normalized length of `customerName` / `customerCompany` (Req 4.6). */
export const MAX_NAME_LENGTH = 120;

/** Maximum normalized length of `customerNotes` (Req 4.6). */
export const MAX_NOTES_LENGTH = 1000;

/**
 * A stored Customer_Profile: each present Customer_Field holds its normalized,
 * non-empty string value. Absent fields are simply missing keys — never `null`,
 * never `""` (Req 4.13, 10.3).
 */
export type CustomerProfile = Partial<Record<CustomerField, string>>;

// ─── Format predicates (glossary rules, implemented directly) ─────────────────

/**
 * Email_Format: 1–254 characters, exactly one `@`, a local part of 1–64
 * characters, a domain of at least 3 characters containing at least one `.` and
 * neither beginning nor ending with `.`, and no whitespace anywhere (Req 4.1).
 */
export function isEmailFormat(value: string): boolean {
  if (value.length < 1 || value.length > 254) {
    return false;
  }
  // No whitespace character anywhere.
  if (/\s/.test(value)) {
    return false;
  }
  const at = value.indexOf("@");
  // Exactly one "@": a first "@" must exist and there must be no second.
  if (at === -1 || value.indexOf("@", at + 1) !== -1) {
    return false;
  }
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length < 1 || local.length > 64) {
    return false;
  }
  if (domain.length < 3) {
    return false;
  }
  if (!domain.includes(".")) {
    return false;
  }
  if (domain.startsWith(".") || domain.endsWith(".")) {
    return false;
  }
  return true;
}

/**
 * Country_Code: a two-character ISO 3166-1 alpha-2 code composed of uppercase
 * letters `A`–`Z` (Req 4.3). Callers normalize (trim + uppercase) first.
 */
export function isCountryCode(value: string): boolean {
  return /^[A-Z]{2}$/.test(value);
}

/**
 * Phone_Format: 7–20 characters composed of digits, spaces, hyphens,
 * parentheses, and at most one `+` that appears only as the first character,
 * containing at least 7 digits (Req 4.5).
 */
export function isPhoneFormat(value: string): boolean {
  if (value.length < 7 || value.length > 20) {
    return false;
  }
  // Only digits, space, hyphen, parentheses, and "+" are permitted.
  if (!/^[0-9 ()\-+]+$/.test(value)) {
    return false;
  }
  // At most one "+", and only as the first character.
  const firstPlus = value.indexOf("+");
  if (firstPlus !== -1) {
    if (firstPlus !== 0 || value.indexOf("+", 1) !== -1) {
      return false;
    }
  }
  // At least 7 digits.
  const digitCount = (value.match(/[0-9]/g) ?? []).length;
  return digitCount >= 7;
}

// ─── Per-field normalization (Req 4.2 / 4.4 / 4.11 / 4.12) ────────────────────

/**
 * Normalize one submitted Customer_Field value according to its field:
 *
 *  - `customerEmail`: trim, then lowercase (Req 4.2);
 *  - `customerCountry`: trim, then uppercase (Req 4.4);
 *  - `customerName` / `customerCompany` / `customerPhone`: trim, then collapse
 *    each run of whitespace to a single space (Req 4.11);
 *  - `customerNotes`: trim only, leaving every other character unchanged
 *    (Req 4.12).
 *
 * The result is a fixed point: applying this function to its own output returns
 * that output unchanged (Req 4.8).
 */
export function normalizeCustomerField(field: CustomerField, value: string): string {
  switch (field) {
    case "customerEmail":
      return value.trim().toLowerCase();
    case "customerCountry":
      return value.trim().toUpperCase();
    case "customerName":
    case "customerCompany":
    case "customerPhone":
      return value.trim().replace(/\s+/g, " ");
    case "customerNotes":
      return value.trim();
  }
}

// ─── Evaluation outcome ────────────────────────────────────────────────────────

/** One offending Customer_Field, with a human-readable reason (Req 4.9). */
export interface CustomerFieldError {
  field: CustomerField;
  reason: string;
}

/** The result of evaluating the Customer_Fields of one request body. */
export interface CustomerProfileOutcome {
  /** Fields whose normalized value is non-empty and valid → write these. */
  set: CustomerProfile;
  /**
   * Fields submitted but normalized to empty (`null`, `""`, or whitespace-only)
   * → absent on create, `REMOVE` on update (Req 1.3, 2.2, 4.13).
   */
  clear: CustomerField[];
  /** Every offending Customer_Field; Req 4.9 requires naming all of them. */
  errors: CustomerFieldError[];
}

// ─── Per-field validation of an already-normalized value ──────────────────────

/**
 * Validate an already-normalized, non-empty Customer_Field value against its
 * field rule, returning a reason string when it fails or `null` when it passes
 * (Req 4.1, 4.3, 4.5, 4.6).
 */
function validateNormalized(field: CustomerField, normalized: string): string | null {
  switch (field) {
    case "customerEmail":
      return isEmailFormat(normalized)
        ? null
        : "customerEmail must be a valid email address";
    case "customerCountry":
      return isCountryCode(normalized)
        ? null
        : "customerCountry must be a two-letter ISO 3166-1 alpha-2 country code";
    case "customerPhone":
      return isPhoneFormat(normalized)
        ? null
        : "customerPhone must be 7 to 20 characters of digits, spaces, hyphens, parentheses, and an optional leading +, with at least 7 digits";
    case "customerName":
      return normalized.length <= MAX_NAME_LENGTH
        ? null
        : `customerName must be at most ${MAX_NAME_LENGTH} characters`;
    case "customerCompany":
      return normalized.length <= MAX_NAME_LENGTH
        ? null
        : `customerCompany must be at most ${MAX_NAME_LENGTH} characters`;
    case "customerNotes":
      return normalized.length <= MAX_NOTES_LENGTH
        ? null
        : `customerNotes must be at most ${MAX_NOTES_LENGTH} characters`;
  }
}

/** True when `key` was submitted (present with a value other than `undefined`). */
function isSubmitted(body: Record<string, unknown>, key: CustomerField): boolean {
  return (
    Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined
  );
}

// ─── Evaluation entry point ────────────────────────────────────────────────────

/**
 * Normalize then validate every *submitted* Customer_Field of a request body,
 * returning the fields to `set` (normalized, non-empty, valid), the fields to
 * `clear` (submitted but empty after normalization), and every offending field
 * in `errors`.
 *
 * This function never throws and never partially applies: the caller MUST
 * reject the request when `errors` is non-empty and write nothing (Req 4.9,
 * 4.10, 1.10, 2.9). A field that is omitted (or explicitly `undefined`) is
 * absent and appears in none of the three collections.
 */
export function evaluateCustomerProfile(
  body: Record<string, unknown>
): CustomerProfileOutcome {
  const set: CustomerProfile = {};
  const clear: CustomerField[] = [];
  const errors: CustomerFieldError[] = [];

  for (const field of CUSTOMER_FIELDS) {
    // Omitted (or explicitly undefined) → absent; nothing to do.
    if (!isSubmitted(body, field)) {
      continue;
    }

    const value = body[field];

    // Explicit null is a request to clear the attribute (Req 2.2, 4.13).
    if (value === null) {
      clear.push(field);
      continue;
    }

    // Present but neither a string nor null → error, no normalized form (Req 4.7).
    if (typeof value !== "string") {
      errors.push({ field, reason: `${field} must be a string` });
      continue;
    }

    // Normalize before evaluating anything (Req 4.9).
    const normalized = normalizeCustomerField(field, value);

    // Normalizes to empty → treated as absent, never an error (Req 4.13).
    if (normalized.length === 0) {
      clear.push(field);
      continue;
    }

    const reason = validateNormalized(field, normalized);
    if (reason !== null) {
      errors.push({ field, reason });
      continue;
    }

    set[field] = normalized;
  }

  return { set, clear, errors };
}
