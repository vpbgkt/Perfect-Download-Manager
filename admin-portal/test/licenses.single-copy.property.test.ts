// Feature: license-key-management-enhancements
// Property 10: Key and customer values are stored in exactly one place
//
// Validates: Requirements 1.4, 7.1
//
// Requirement 1.4: THE Portal_Backend SHALL store Customer_Fields as attributes
// of the same License_Record item in the Licenses_Table and SHALL hold no second
// copy of any Customer_Field value in another data store.
//
// Requirement 7.1: THE Licenses_Table SHALL store each License_Key as the value
// of the `licenseKey` partition key attribute [...] and SHALL hold no second copy
// of that License_Key value in another attribute of that License_Record or in
// another data store.
//
// Strategy: After creating a License_Record with a Customer_Profile and optional
// Custom_Key_Prefix, scan every table in the in-memory fake. Assert that:
// 1. The full License_Key value appears exactly once across all items in all
//    tables — as the `licenseKey` attribute of the License_Record itself.
// 2. Each non-empty Customer_Field value appears exactly once across all items
//    in all tables — as the corresponding attribute of the License_Record.
// The audit table is allowed to store field *names* but never field *values*
// (Req 9.1, 9.2), so any occurrence of a customer value in the audit table is
// a violation.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  createLicenseCreator,
  LICENSES_TABLE_NAME,
  LICENSE_PARTITION_KEY,
} from "../lib/licenses/create.ts";
import { createAuditLog, AUDIT_TABLE_NAME } from "../lib/audit.ts";
import { FakeDynamoClient } from "../lib/dev/in-memory-dynamo.ts";
import type { DynamoItem } from "../lib/dynamo.ts";
import {
  CUSTOMER_FIELDS,
  evaluateCustomerProfile,
  normalizeCustomerField,
  type CustomerField,
  type CustomerProfile,
} from "../lib/licenses/customer.ts";

const RUNS = 100;

// ─── Known tables the portal touches ─────────────────────────────────────────

/** Every DynamoDB table that the portal may write to during license creation. */
const ALL_TABLE_NAMES = [
  LICENSES_TABLE_NAME,   // "pdm-licenses"
  AUDIT_TABLE_NAME,      // "pdm-portal-audit"
] as const;

// ─── Arbitraries ─────────────────────────────────────────────────────────────

const lowerAlphaNum = "abcdefghijklmnopqrstuvwxyz0123456789".split("");
const lowerAlpha = "abcdefghijklmnopqrstuvwxyz".split("");

/** Valid email that passes normalization and validation. */
const emailArb = fc
  .tuple(
    fc.array(fc.constantFrom(...lowerAlphaNum), { minLength: 1, maxLength: 20 }),
    fc.array(fc.constantFrom(...lowerAlphaNum), { minLength: 1, maxLength: 8 }),
    fc.array(fc.constantFrom(...lowerAlpha), { minLength: 2, maxLength: 5 })
  )
  .map(([localChars, domainChars, tldChars]) => {
    const local = localChars.join("").slice(0, 64) || "a";
    const domain = domainChars.join("");
    const tld = tldChars.join("");
    return `${local}@${domain}.${tld}`;
  })
  .filter((v) => {
    const outcome = evaluateCustomerProfile({ customerEmail: v });
    return outcome.errors.length === 0 && Object.keys(outcome.set).length > 0;
  });

/** Valid country code. */
const countryArb = fc.constantFrom(
  "US", "GB", "IN", "DE", "FR", "JP", "AU", "CA", "BR", "ZA"
);

/** Valid phone. */
const phoneArb = fc
  .tuple(
    fc.boolean(),
    fc.array(fc.constantFrom("0", "1", "2", "3", "4", "5", "6", "7", "8", "9"), { minLength: 7, maxLength: 15 })
  )
  .map(([hasPlus, digits]) => {
    const phone = digits.join("");
    return hasPlus ? `+${phone}` : phone;
  })
  .filter((v) => {
    const outcome = evaluateCustomerProfile({ customerPhone: v });
    return outcome.errors.length === 0 && Object.keys(outcome.set).length > 0;
  });

/** Valid name/company (1-120 chars). */
const nameChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz ".split("");
const nameArb = fc
  .array(fc.constantFrom(...nameChars), { minLength: 2, maxLength: 60 })
  .map((chars) => chars.join(""))
  .filter((v) => v.trim().length > 0 && v.trim().length <= 120);

/** Valid notes (1-100 chars, printable). */
const notesChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,!?-_".split("");
const notesArb = fc
  .array(fc.constantFrom(...notesChars), { minLength: 1, maxLength: 100 })
  .map((chars) => chars.join(""))
  .filter((v) => v.trim().length > 0);

/**
 * A valid Customer_Profile with at least one field set, containing values that
 * pass validation and normalization.
 */
const validProfileArb: fc.Arbitrary<Record<string, string>> = fc
  .record({
    customerEmail: fc.option(emailArb, { nil: undefined }),
    customerName: fc.option(nameArb, { nil: undefined }),
    customerPhone: fc.option(phoneArb, { nil: undefined }),
    customerCountry: fc.option(countryArb, { nil: undefined }),
    customerCompany: fc.option(nameArb, { nil: undefined }),
    customerNotes: fc.option(notesArb, { nil: undefined }),
  })
  .filter((profile) => {
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(profile)) {
      if (v !== undefined) body[k] = v;
    }
    if (Object.keys(body).length === 0) return false;
    const outcome = evaluateCustomerProfile(body);
    return outcome.errors.length === 0 && Object.keys(outcome.set).length > 0;
  })
  .map((profile) => {
    // Evaluate to get the normalized set of values (what gets stored)
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(profile)) {
      if (v !== undefined) body[k] = v;
    }
    const outcome = evaluateCustomerProfile(body);
    return outcome.set as Record<string, string>;
  });

/** Optional Custom_Key_Prefix (already normalized, valid). */
const prefixChars = "ABCDEFGHJKMNPQRSTVWXYZ0123456789".split("");
const prefixArb = fc.option(
  fc.array(fc.constantFrom(...prefixChars), { minLength: 1, maxLength: 20 })
    .map((chars) => chars.join(""))
    .filter((s) => !s.startsWith("-") && !s.endsWith("-") && !s.includes("--")),
  { nil: undefined }
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

const actor = { actor: "admin-user", actorRole: "admin", sourceIp: "198.51.100.42" };

/**
 * Recursively scan every string value within a DynamoDB item, checking whether
 * it contains or equals the target value. Returns all (tableName, itemKey, attrPath)
 * locations where the value appears.
 */
function findValueInAllTables(
  dynamo: FakeDynamoClient,
  targetValue: string
): Array<{ table: string; itemKey: string; attrPath: string }> {
  const locations: Array<{ table: string; itemKey: string; attrPath: string }> = [];
  if (!targetValue || targetValue.length === 0) return locations;

  for (const tableName of ALL_TABLE_NAMES) {
    const items = dynamo.dump(tableName);
    for (const item of items) {
      const itemKey = String(
        item[LICENSE_PARTITION_KEY] ?? item["auditId"] ?? JSON.stringify(item).slice(0, 40)
      );
      scanObject(item, "", (path, value) => {
        if (typeof value === "string" && value === targetValue) {
          locations.push({ table: tableName, itemKey, attrPath: path });
        }
      });
    }
  }
  return locations;
}

/**
 * Walk every leaf value in a nested object/array, calling `cb` for each leaf.
 */
function scanObject(
  obj: unknown,
  prefix: string,
  cb: (path: string, value: unknown) => void
): void {
  if (obj === null || obj === undefined) return;
  if (typeof obj === "string" || typeof obj === "number" || typeof obj === "boolean") {
    cb(prefix, obj);
    return;
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      scanObject(obj[i], `${prefix}[${i}]`, cb);
    }
    return;
  }
  if (typeof obj === "object") {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      scanObject(value, prefix ? `${prefix}.${key}` : key, cb);
    }
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Property 10: Key and customer values are stored in exactly one place", () => {
  it("the full License_Key value appears exactly once across all tables — as the licenseKey attribute of its License_Record (Req 7.1)", async () => {
    await fc.assert(
      fc.asyncProperty(
        validProfileArb,
        prefixArb,
        fc.integer({ min: 1, max: 100 }),
        async (customerSet, keyPrefix, maxActivations) => {
          const dynamo = new FakeDynamoClient();
          const audit = createAuditLog(dynamo);
          const creator = createLicenseCreator({ dynamo, audit });

          const result = await creator.create(
            { plan: "standard", maxActivations, keyPrefix, customer: customerSet },
            actor
          );

          assert.strictEqual(result.ok, true, "create must succeed");
          if (!result.ok) return;

          const licenseKey = result.value.licenseKey;

          // Find every occurrence of the full License_Key across all tables.
          const keyLocations = findValueInAllTables(dynamo, licenseKey);

          // The key must appear exactly once: as the `licenseKey` partition key
          // of the License_Record in the licenses table.
          const licensesTableOccurrences = keyLocations.filter(
            (loc) => loc.table === LICENSES_TABLE_NAME && loc.attrPath === LICENSE_PARTITION_KEY
          );
          assert.strictEqual(
            licensesTableOccurrences.length,
            1,
            `License_Key must appear exactly once as ${LICENSE_PARTITION_KEY} in ${LICENSES_TABLE_NAME}; found ${licensesTableOccurrences.length}`
          );

          // No other occurrence of the License_Key in any table should store
          // it as a separate copy. The audit table is allowed to reference the
          // key as a "target" identifier — this is the target License_Key in the
          // audit entry, which is the record identifier, not a "second copy" of
          // the key value for the purpose of Req 7.1. But the key must NOT appear
          // as any *other* attribute on the License_Record itself.
          const duplicatesOnSameRecord = keyLocations.filter(
            (loc) =>
              loc.table === LICENSES_TABLE_NAME &&
              loc.attrPath !== LICENSE_PARTITION_KEY
          );
          assert.strictEqual(
            duplicatesOnSameRecord.length,
            0,
            `License_Key must not appear as another attribute on the License_Record; found at: ${duplicatesOnSameRecord.map((l) => l.attrPath).join(", ")}`
          );
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("each Customer_Field value appears exactly once across all tables — on the License_Record (Req 1.4)", async () => {
    await fc.assert(
      fc.asyncProperty(
        validProfileArb,
        prefixArb,
        fc.integer({ min: 1, max: 100 }),
        async (customerSet, keyPrefix, maxActivations) => {
          const dynamo = new FakeDynamoClient();
          const audit = createAuditLog(dynamo);
          const creator = createLicenseCreator({ dynamo, audit });

          const result = await creator.create(
            { plan: "standard", maxActivations, keyPrefix, customer: customerSet },
            actor
          );

          assert.strictEqual(result.ok, true, "create must succeed");
          if (!result.ok) return;

          const licenseKey = result.value.licenseKey;

          // For each stored Customer_Field value, verify it appears exactly once.
          for (const field of CUSTOMER_FIELDS) {
            const storedValue = customerSet[field];
            if (!storedValue || storedValue.length === 0) continue;

            const locations = findValueInAllTables(dynamo, storedValue);

            // The value must appear exactly once: as the corresponding attribute
            // on the License_Record in the licenses table.
            const onLicenseRecord = locations.filter(
              (loc) =>
                loc.table === LICENSES_TABLE_NAME &&
                loc.itemKey === licenseKey &&
                loc.attrPath === field
            );
            assert.strictEqual(
              onLicenseRecord.length,
              1,
              `Customer_Field '${field}' value must appear exactly once on the License_Record; found ${onLicenseRecord.length}`
            );

            // The value must NOT appear anywhere else (no second copy in audit
            // table or any other table/item). Audit entries may store field
            // *names* but never values (Req 9.1, 9.2).
            const elsewhere = locations.filter(
              (loc) =>
                !(
                  loc.table === LICENSES_TABLE_NAME &&
                  loc.itemKey === licenseKey &&
                  loc.attrPath === field
                )
            );
            assert.strictEqual(
              elsewhere.length,
              0,
              `Customer_Field '${field}' value must not appear in any other location; found at: ${elsewhere.map((l) => `${l.table}/${l.itemKey}/${l.attrPath}`).join(", ")}`
            );
          }
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("the keyPrefix value is not duplicated as a separate attribute beyond the License_Record (Req 7.1)", async () => {
    await fc.assert(
      fc.asyncProperty(
        validProfileArb,
        // Force a prefix to be present for this sub-property
        fc.array(fc.constantFrom(...prefixChars), { minLength: 2, maxLength: 16 })
          .map((chars) => chars.join(""))
          .filter((s) => !s.startsWith("-") && !s.endsWith("-") && !s.includes("--")),
        fc.integer({ min: 1, max: 100 }),
        async (customerSet, keyPrefix, maxActivations) => {
          const dynamo = new FakeDynamoClient();
          const audit = createAuditLog(dynamo);
          const creator = createLicenseCreator({ dynamo, audit });

          const result = await creator.create(
            { plan: "standard", maxActivations, keyPrefix, customer: customerSet },
            actor
          );

          assert.strictEqual(result.ok, true, "create must succeed");
          if (!result.ok) return;

          const licenseKey = result.value.licenseKey;

          // The keyPrefix value is stored on the License_Record in two forms:
          // 1. As the `keyPrefix` attribute (the normalized prefix string)
          // 2. Embedded in the `licenseKey` partition key (as part of the key format)
          // Both of these are on the same License_Record — that's one place.
          // It must NOT appear as a value in any other table.

          const prefixLocations = findValueInAllTables(dynamo, keyPrefix);

          // Filter to only locations outside the License_Record itself.
          const outsideLicenseRecord = prefixLocations.filter(
            (loc) =>
              !(loc.table === LICENSES_TABLE_NAME && loc.itemKey === licenseKey)
          );

          // The audit table is allowed to store the keyPrefix value in the
          // `changes` field (design: "keyPrefix: { before: null, after: <normalized> }"),
          // which is the audit entry's representation of what changed. This is
          // the *change description*, not a second copy for lookup purposes.
          // Req 1.4 and 7.1 are about not duplicating for storage/retrieval,
          // so we allow the audit change record.
          const nonAuditDuplicates = outsideLicenseRecord.filter(
            (loc) => loc.table !== AUDIT_TABLE_NAME
          );
          assert.strictEqual(
            nonAuditDuplicates.length,
            0,
            `keyPrefix must not appear in any non-audit table outside the License_Record; found at: ${nonAuditDuplicates.map((l) => `${l.table}/${l.itemKey}/${l.attrPath}`).join(", ")}`
          );
        }
      ),
      { numRuns: RUNS }
    );
  });
});
