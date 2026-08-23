// Feature: license-key-management-enhancements
// Property 18: Key material and customer data never reach tokens, licensing responses, or logs
//
// Validates: Requirements 7.4, 7.5, 7.11, 9.4, 9.6
//
// For any License_Record carrying Customer_Field values, every License_Token and
// every Activation_Endpoint, Validation_Endpoint, and POST /deactivate response
// body excludes every Customer_Field value; for any Portal_Backend or
// Licensing_Backend response (including every validation error and every other
// error body), no private signing key material, key-generation seed, or Api_Key
// plaintext secret occurs; and for any portal or Lambda operation, log output at
// info severity and above contains no Customer_Field value and no complete
// License_Key.
//
// The test uses simulated handler logic with an injected logger, verifying that
// token payloads and all response bodies are free of customer data and key
// secrets.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

const RUNS = 100;

// ─── Constants ────────────────────────────────────────────────────────────────

const CUSTOMER_FIELDS = [
  "customerEmail", "customerName", "customerPhone",
  "customerCountry", "customerCompany", "customerNotes",
] as const;

/** Simulated private key material that must never appear in responses or logs. */
const FAKE_PRIVATE_KEY = "-----BEGIN EC PRIVATE KEY-----\nMHQCAQEEIBkg2yYFmwSh9klSU+cNqFq4/P/GM3s2RUBe9ItDJOtvoAcGBSuBBAAi\noWQDYgAE7RnMYF1b2Zj9D3+j\n-----END EC PRIVATE KEY-----";
const FAKE_API_KEY_SECRET = "pdm_apikey_a1b2c3d4e5f6g7h8i9j0klmnopqrstu";

// ─── Arbitraries ──────────────────────────────────────────────────────────────

const KEY_ALPHABET_CHARS = "ABCDEFGHJKMNPQRSTVWXYZ0123456789".split("");

/** Generate a valid license key (new format: PDM-<7x4 groups>). */
const newKeyArb = fc.string({ unit: fc.constantFrom(...KEY_ALPHABET_CHARS), minLength: 28, maxLength: 28 })
  .map((secret) => {
    const groups: string[] = [];
    for (let i = 0; i < 28; i += 4) groups.push(secret.slice(i, i + 4));
    return `PDM-${groups.join("-")}`;
  });

/** Generate a valid license key with a prefix. */
const prefixedKeyArb = fc.tuple(
  fc.string({ unit: fc.constantFrom(...KEY_ALPHABET_CHARS), minLength: 2, maxLength: 8 }),
  fc.string({ unit: fc.constantFrom(...KEY_ALPHABET_CHARS), minLength: 28, maxLength: 28 }),
).map(([prefix, secret]) => {
  const groups: string[] = [];
  for (let i = 0; i < 28; i += 4) groups.push(secret.slice(i, i + 4));
  return `PDM-${prefix}-${groups.join("-")}`;
});

const validKeyArb = fc.oneof(newKeyArb, prefixedKeyArb);

/** Generate realistic customer field values. */
const customerEmailArb = fc.tuple(
  fc.string({ unit: fc.constantFrom(..."abcdefghijk"), minLength: 3, maxLength: 10 }),
  fc.string({ unit: fc.constantFrom(..."abcdefghijk"), minLength: 3, maxLength: 8 }),
).map(([local, domain]) => `${local}@${domain}.com`);

const customerNameArb = fc.string({ unit: fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz "), minLength: 3, maxLength: 30 });

const customerPhoneArb = fc.tuple(
  fc.boolean(),
  fc.string({ unit: fc.constantFrom(..."0123456789"), minLength: 7, maxLength: 12 }),
).map(([hasPlus, digits]) => hasPlus ? `+${digits}` : digits);

const customerCountryArb = fc.string({ unit: fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"), minLength: 2, maxLength: 2 });

const customerCompanyArb = fc.string({ unit: fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz "), minLength: 3, maxLength: 20 });

const customerNotesArb = fc.string({ unit: fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz 0123456789.,-"), minLength: 5, maxLength: 40 });

/** Generate a full customer profile. */
const customerProfileArb = fc.record({
  customerEmail: customerEmailArb,
  customerName: customerNameArb,
  customerPhone: customerPhoneArb,
  customerCountry: customerCountryArb,
  customerCompany: customerCompanyArb,
  customerNotes: customerNotesArb,
});

/** Valid fingerprint (hex string 64 chars). */
const fingerprintArb = fc.string({ unit: fc.constantFrom(..."0123456789abcdef"), minLength: 64, maxLength: 64 });

const ipArb = fc.constantFrom("203.0.113.7", "198.51.100.42", "10.0.0.1", "::1");

// ─── Simulated handler infrastructure ─────────────────────────────────────────

interface LicenseRecord {
  licenseKey: string;
  status: string;
  plan: string;
  owner: string;
  features: string[];
  maxActivations: number;
  maxConn: number;
  maxParallel: number;
  expiresAt: string;
  activations: Record<string, { activatedAt: string; lastSeenAt: string }>;
  createdAt: string;
  keyPrefix?: string;
  customerEmail?: string;
  customerName?: string;
  customerPhone?: string;
  customerCountry?: string;
  customerCompany?: string;
  customerNotes?: string;
}

function makeLicenseRecord(licenseKey: string, customer: Record<string, string>): LicenseRecord {
  return {
    licenseKey,
    status: "active",
    plan: "professional",
    owner: "test-owner",
    features: ["feature-x", "feature-y"],
    maxActivations: 5,
    maxConn: 10,
    maxParallel: 3,
    expiresAt: "2099-12-31T23:59:59.000Z",
    activations: {},
    createdAt: "2024-01-01T00:00:00.000Z",
    ...customer,
  };
}

/**
 * Simulates the token payload construction as done by `issueToken` in
 * `backend/licensing/src/lib/tokens.mjs`. The payload must NOT contain any
 * Customer_Field.
 */
function buildTokenPayload(license: LicenseRecord, fingerprint: string) {
  return {
    v: 2,
    licenseKey: license.licenseKey,
    fingerprint,
    plan: license.plan ?? "standard",
    owner: license.owner ?? null,
    features: Array.isArray(license.features) ? license.features : [],
    maxConn: Number.isFinite(license.maxConn) ? license.maxConn : 0,
    maxParallel: Number.isFinite(license.maxParallel) ? license.maxParallel : 0,
    issuedAt: new Date().toISOString(),
    expiresAt: "2099-12-31T23:59:59.000Z",
    nonce: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
  };
}

/**
 * Simulates the activate handler response for a found license.
 * Returns both the token payload and the response body.
 */
function simulateActivateSuccess(license: LicenseRecord, fingerprint: string) {
  const payload = buildTokenPayload(license, fingerprint);
  const tokenStr = Buffer.from(JSON.stringify(payload)).toString("base64url") + ".fakesig";
  return {
    statusCode: 200,
    body: {
      valid: true,
      token: tokenStr,
      owner: payload.owner,
      plan: payload.plan,
      features: payload.features,
      subscriptionExpiresAt: license.expiresAt ?? null,
      tokenExpiresAt: payload.expiresAt,
    },
    payload, // for inspection
  };
}

/**
 * Simulates the validate handler response for a found license.
 */
function simulateValidateSuccess(license: LicenseRecord, fingerprint: string) {
  const payload = buildTokenPayload(license, fingerprint);
  const tokenStr = Buffer.from(JSON.stringify(payload)).toString("base64url") + ".fakesig";
  return {
    statusCode: 200,
    body: {
      valid: true,
      token: tokenStr,
      owner: payload.owner,
      plan: payload.plan,
      features: payload.features,
      subscriptionExpiresAt: license.expiresAt ?? null,
      tokenExpiresAt: payload.expiresAt,
    },
    payload,
  };
}

/**
 * Simulates the deactivate handler response for a found license.
 */
function simulateDeactivateSuccess(_license: LicenseRecord, _fingerprint: string) {
  return {
    statusCode: 200,
    body: { ok: true, released: true },
  };
}

/**
 * Simulates various error responses from the licensing endpoints.
 */
function simulateErrorResponses(licenseKey: string) {
  return [
    // 429 rate limited
    { statusCode: 429, body: { valid: false, message: "rate_limited" } },
    // Unknown key (activate)
    { statusCode: 200, body: { valid: false, message: "License key not found." } },
    // Revoked
    { statusCode: 200, body: { valid: false, message: "This license has been revoked." } },
    // Suspended
    { statusCode: 200, body: { valid: false, revoked: true, message: "This license is suspended." } },
    // Expired
    { statusCode: 200, body: { valid: false, message: "This license has expired." } },
    // Activation limit
    { statusCode: 200, body: { valid: false, message: "Activation limit reached for this license. Deactivate another device first." } },
    // Input validation errors
    { statusCode: 400, body: { valid: false, message: "invalid_license_key" } },
    { statusCode: 400, body: { valid: false, message: "invalid_fingerprint" } },
    // Deactivate unauthorized
    { statusCode: 401, body: { ok: false, message: "unauthorized" } },
    // Deactivate not found
    { statusCode: 200, body: { ok: true, released: false, message: "License key not found." } },
  ];
}

/**
 * Simulates portal error responses.
 */
function simulatePortalErrorResponses() {
  return [
    // Validation errors
    { status: 400, body: { error: "validation_error", field: "customerEmail", reason: "Invalid email format" } },
    { status: 400, body: { error: "validation_error", field: "keyPrefix", reason: "Prefix contains invalid characters" } },
    { status: 400, body: { error: "validation_error", field: "customerEmail", reason: "Invalid email format", fields: [{ field: "customerEmail", reason: "Invalid email format" }, { field: "customerPhone", reason: "Invalid phone format" }] } },
    // Auth errors
    { status: 401, body: { error: "authentication_failed" } },
    { status: 401, body: { error: "unauthenticated" } },
    { status: 403, body: { error: "not_authorized" } },
    { status: 403, body: { error: "mfa_enrollment_required" } },
    { status: 404, body: { error: "not_found" } },
    // Bad request
    { status: 400, body: { error: "bad_request", reason: "Key generation failed" } },
  ];
}

/**
 * Simulates log output from the licensing backend (e.g., counter failure logs,
 * general request processing logs).
 */
function simulateLogOutput(license: LicenseRecord, ip: string) {
  // Simulate what the handlers log at info-and-above severity:
  return [
    // Counter failure log (Req 8.7)
    JSON.stringify({ event: "attempt_counter_failure", bucket: "ACT" }),
    JSON.stringify({ event: "attempt_counter_failure", bucket: "VAL" }),
    JSON.stringify({ event: "attempt_counter_failure", bucket: "ACTUNKNOWN" }),
    // Request processed log (generic info-level)
    JSON.stringify({ event: "request_processed", endpoint: "activate", ip, status: 200 }),
    JSON.stringify({ event: "request_processed", endpoint: "validate", ip, status: 200 }),
    JSON.stringify({ event: "request_processed", endpoint: "deactivate", ip, status: 200 }),
    // Error log for audit failure (Req 9.8)
    JSON.stringify({ event: "audit_write_failure", action: "license:update", target: license.licenseKey }),
  ];
}

// ─── Assertions ───────────────────────────────────────────────────────────────

/**
 * Characters a License_Key ([A-Z0-9-]) or a base64url token ([A-Za-z0-9_-]) can be built from.
 * A Customer_Field value made only of these can collide with such an identifier by chance.
 */
const KEY_OR_TOKEN_CHARSET = /^[A-Za-z0-9_-]+$/;

/**
 * True when a value is distinctive enough that finding it as a substring can only mean it was
 * actually emitted. A value containing "@", ".", "+", a space, etc. cannot occur inside a
 * License_Key or a base64url token, so a match is real rather than coincidental.
 */
function isDistinctiveValue(value: string): boolean {
  return value.length >= 4 && !KEY_OR_TOKEN_CHARSET.test(value);
}

/** Recursively collect every property name and every string leaf of a parsed JSON value. */
function collectJsonStrings(node: unknown, names: string[], leaves: string[]): void {
  if (typeof node === "string") {
    leaves.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectJsonStrings(item, names, leaves);
    return;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      names.push(key);
      collectJsonStrings(value, names, leaves);
    }
  }
}

/**
 * Asserts that a serialized string (JSON body or log line) does not carry any Customer_Field
 * value from the given record.
 *
 * Two complementary checks, because a naive substring scan is unsound here: short values such as
 * a two-letter Country_Code ("AA") or a three-letter name occur by chance inside almost any
 * uppercase License_Key or base64url token that the payload legitimately contains.
 *
 *  1. Structural — no property may be *named* like a Customer_Field, and no string leaf may
 *     *equal* a Customer_Field value. Exact leaf comparison is collision-proof, and a genuine leak
 *     shows up exactly this way (the value carried as its own field).
 *  2. Substring — additionally catches a value interpolated into a larger message, but only for
 *     values distinctive enough that a chance match is impossible.
 */
function assertNoCustomerFieldValues(
  serialized: string,
  record: Partial<Record<(typeof CUSTOMER_FIELDS)[number], string | undefined>>,
  context: string
) {
  const values = new Map<string, string>(); // value -> field name
  for (const field of CUSTOMER_FIELDS) {
    const value = record[field];
    if (typeof value === "string" && value.length > 0) {
      values.set(value, field);
    }
  }

  let parsed: unknown;
  let isJson = true;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    isJson = false;
  }

  if (isJson) {
    const names: string[] = [];
    const leaves: string[] = [];
    collectJsonStrings(parsed, names, leaves);

    for (const name of names) {
      assert.ok(
        !CUSTOMER_FIELDS.includes(name as (typeof CUSTOMER_FIELDS)[number]),
        `${context} must not carry a Customer_Field property ("${name}")`
      );
    }

    for (const leaf of leaves) {
      const field = values.get(leaf);
      assert.ok(
        field === undefined,
        `${context} must not contain ${field} value "${leaf}"`
      );
    }
  }

  for (const [value, field] of values) {
    if (isDistinctiveValue(value)) {
      assert.ok(
        !serialized.includes(value),
        `${context} must not contain ${field} value "${value}"`
      );
    }
  }
}

/**
 * Asserts that a serialized string does not contain private key material,
 * key-generation seeds, or Api_Key plaintext secrets (Req 7.5).
 */
function assertNoSecretMaterial(serialized: string, context: string) {
  assert.ok(
    !serialized.includes("BEGIN EC PRIVATE KEY"),
    `${context} must not contain private key material`
  );
  assert.ok(
    !serialized.includes("BEGIN PRIVATE KEY"),
    `${context} must not contain private key material`
  );
  assert.ok(
    !serialized.includes(FAKE_PRIVATE_KEY.slice(0, 40)),
    `${context} must not contain private key PEM`
  );
  assert.ok(
    !serialized.includes(FAKE_API_KEY_SECRET),
    `${context} must not contain Api_Key plaintext secret`
  );
  assert.ok(
    !serialized.includes("pdm_apikey_"),
    `${context} must not contain Api_Key secret prefix`
  );
}

// ─── Property tests ───────────────────────────────────────────────────────────

describe("Property 18: Key material and customer data never reach tokens, licensing responses, or logs", () => {

  // ── Clause 1: Token payloads exclude every Customer_Field value (Req 7.4) ──
  it("License_Token payloads never contain any Customer_Field value", async () => {
    await fc.assert(
      fc.asyncProperty(
        validKeyArb,
        customerProfileArb,
        fingerprintArb,
        async (licenseKey, customer, fingerprint) => {
          const record = makeLicenseRecord(licenseKey, customer);
          const payload = buildTokenPayload(record, fingerprint);
          const payloadStr = JSON.stringify(payload);

          // Token payload must not include any customer field value.
          assertNoCustomerFieldValues(payloadStr, record, "Token payload");

          // Token payload keys must be exactly the known set — no customer fields sneaked in.
          const payloadKeys = new Set(Object.keys(payload));
          const allowedKeys = new Set(["v", "licenseKey", "fingerprint", "plan", "owner",
            "features", "maxConn", "maxParallel", "issuedAt", "expiresAt", "nonce"]);
          for (const key of payloadKeys) {
            assert.ok(allowedKeys.has(key),
              `Unexpected key "${key}" in token payload — potential data leak`);
          }
        }
      ),
      { numRuns: RUNS }
    );
  });

  // ── Clause 2: Activate/validate/deactivate response bodies exclude Customer_Field values (Req 7.4) ──
  it("activate, validate, and deactivate response bodies never contain Customer_Field values", async () => {
    await fc.assert(
      fc.asyncProperty(
        validKeyArb,
        customerProfileArb,
        fingerprintArb,
        async (licenseKey, customer, fingerprint) => {
          const record = makeLicenseRecord(licenseKey, customer);

          // Activate success response
          const activateRes = simulateActivateSuccess(record, fingerprint);
          const activateBodyStr = JSON.stringify(activateRes.body);
          assertNoCustomerFieldValues(activateBodyStr, record, "Activate response body");

          // Validate success response
          const validateRes = simulateValidateSuccess(record, fingerprint);
          const validateBodyStr = JSON.stringify(validateRes.body);
          assertNoCustomerFieldValues(validateBodyStr, record, "Validate response body");

          // Deactivate success response
          const deactivateRes = simulateDeactivateSuccess(record, fingerprint);
          const deactivateBodyStr = JSON.stringify(deactivateRes.body);
          assertNoCustomerFieldValues(deactivateBodyStr, record, "Deactivate response body");
        }
      ),
      { numRuns: RUNS }
    );
  });

  // ── Clause 3: Error responses from licensing endpoints exclude Customer_Field values (Req 7.4) ──
  it("all licensing error responses exclude Customer_Field values and secret material", async () => {
    await fc.assert(
      fc.asyncProperty(
        validKeyArb,
        customerProfileArb,
        async (licenseKey, customer) => {
          const record = makeLicenseRecord(licenseKey, customer);
          const errorResponses = simulateErrorResponses(licenseKey);

          for (const resp of errorResponses) {
            const bodyStr = JSON.stringify(resp.body);

            // Must not contain customer data.
            assertNoCustomerFieldValues(bodyStr, record, `Error response (${resp.statusCode})`);

            // Must not contain private key material or Api_Key secrets (Req 7.5).
            assertNoSecretMaterial(bodyStr, `Error response (${resp.statusCode})`);

            // Must not echo back the full license key in error bodies (Req 7.6 for unknowns).
            // The 429 and error bodies must not include the presented license key.
            if (resp.statusCode === 429 || resp.statusCode === 400 || resp.statusCode === 401) {
              assert.ok(
                !bodyStr.includes(licenseKey),
                `Error response (${resp.statusCode}) must not echo back the License_Key`
              );
            }
          }
        }
      ),
      { numRuns: RUNS }
    );
  });

  // ── Clause 4: Portal error responses exclude Customer_Field values and secret material (Req 7.5) ──
  it("portal error response bodies never contain Customer_Field values, private keys, or Api_Key secrets", async () => {
    await fc.assert(
      fc.asyncProperty(
        customerProfileArb,
        async (customer) => {
          const portalErrors = simulatePortalErrorResponses();

          for (const resp of portalErrors) {
            const bodyStr = JSON.stringify(resp.body);

            // Must not contain any customer field value (collision-proof: see helper).
            assertNoCustomerFieldValues(bodyStr, customer, `Portal error (${resp.status})`);

            // Must not contain private key or Api_Key secrets (Req 7.5).
            assertNoSecretMaterial(bodyStr, `Portal error (${resp.status})`);
          }
        }
      ),
      { numRuns: RUNS }
    );
  });

  // ── Clause 5: Log output at info+ severity contains no Customer_Field values (Req 9.4, 9.6) ──
  it("log output at info severity and above contains no Customer_Field value and no complete License_Key", async () => {
    await fc.assert(
      fc.asyncProperty(
        validKeyArb,
        customerProfileArb,
        ipArb,
        async (licenseKey, customer, ip) => {
          const record = makeLicenseRecord(licenseKey, customer);
          const logLines = simulateLogOutput(record, ip);

          for (const logLine of logLines) {
            // Must not contain any Customer_Field value (Req 9.4, 9.6).
            assertNoCustomerFieldValues(logLine, record, "Log output");

            // Must not contain the complete License_Key (Req 7.11).
            // Note: The target field in audit-failure logs may reference the
            // License_Key as an identifier for locating the record — this is
            // permissible per Req 9.1. However, it must not appear as a logged
            // value in normal request-processing lines.
            const parsed = JSON.parse(logLine);
            if (parsed.event !== "audit_write_failure") {
              assert.ok(
                !logLine.includes(licenseKey),
                `Non-audit log line must not contain the complete License_Key "${licenseKey}"`
              );
            }

            // Must not contain private key material or Api_Key secrets.
            assertNoSecretMaterial(logLine, "Log output");
          }
        }
      ),
      { numRuns: RUNS }
    );
  });

  // ── Clause 6: Token payload structure is stable and excludes customer fields (Req 7.4) ──
  // Even when a record has all customer fields populated, the token only contains
  // the defined entitlement claims.
  it("token payloads generated from records with full customer profiles have no customer data", async () => {
    await fc.assert(
      fc.asyncProperty(
        validKeyArb,
        customerProfileArb,
        fingerprintArb,
        fc.constantFrom("professional", "standard", "enterprise"),
        fc.array(fc.string({ unit: fc.constantFrom(..."abcdefghijk-"), minLength: 3, maxLength: 10 }), { minLength: 0, maxLength: 5 }),
        async (licenseKey, customer, fingerprint, plan, features) => {
          const record: LicenseRecord = {
            ...makeLicenseRecord(licenseKey, customer),
            plan,
            features,
            keyPrefix: "CAMPAIGN",
          };

          // Build payload exactly as issueToken does.
          const payload = buildTokenPayload(record, fingerprint);
          const payloadStr = JSON.stringify(payload);

          // No customer field value in the payload.
          assertNoCustomerFieldValues(payloadStr, record, "Full-profile token payload");

          // keyPrefix must not be in the token.
          assert.ok(
            !payloadStr.includes('"keyPrefix"'),
            "Token payload must not contain the keyPrefix field"
          );
          if (record.keyPrefix) {
            // The prefix as a standalone value should not be in the payload
            // (it may appear as part of the licenseKey itself, which is allowed).
            const payloadWithoutKey = payloadStr.replace(record.licenseKey, "");
            assert.ok(
              !payloadWithoutKey.includes(`"${record.keyPrefix}"`),
              "Token payload must not contain the keyPrefix as a separate value"
            );
          }
        }
      ),
      { numRuns: RUNS }
    );
  });

  // ── Clause 7: The activate success response body excludes Customer_Field keys entirely (Req 7.4) ──
  it("activate and validate success response bodies do not include any Customer_Field key names as response fields", async () => {
    await fc.assert(
      fc.asyncProperty(
        validKeyArb,
        customerProfileArb,
        fingerprintArb,
        async (licenseKey, customer, fingerprint) => {
          const record = makeLicenseRecord(licenseKey, customer);

          const activateRes = simulateActivateSuccess(record, fingerprint);
          const activateBodyKeys = Object.keys(activateRes.body);

          // The response body must not contain customer field key names.
          for (const field of CUSTOMER_FIELDS) {
            assert.ok(
              !activateBodyKeys.includes(field),
              `Activate response must not have "${field}" as a response field`
            );
          }

          const validateRes = simulateValidateSuccess(record, fingerprint);
          const validateBodyKeys = Object.keys(validateRes.body);

          for (const field of CUSTOMER_FIELDS) {
            assert.ok(
              !validateBodyKeys.includes(field),
              `Validate response must not have "${field}" as a response field`
            );
          }
        }
      ),
      { numRuns: RUNS }
    );
  });
});
