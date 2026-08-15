// Feature: license-key-management-enhancements
// Property 13: Audit entries name changed Customer_Fields and never carry their values
//
// Validates: Requirements 1.8, 2.7, 5.10, 9.1, 9.2, 9.3, 9.7
//
// For any Mutation that changes at least one Customer_Field, exactly one
// Audit_Entry is appended recording the actor identity, the actor role, the
// action, the License_Key, the source IP, an ISO 8601 UTC timestamp, the names
// of the changed Customer_Fields, and the normalized Custom_Key_Prefix when one
// was applied, while no Customer_Field value occurs anywhere in that entry.
//
// For any Mutation that changes no Customer_Field, no appended entry names a
// Customer_Field and the entry is otherwise identical to the entry the same
// Mutation produced before this feature.
//
// No operation updates or removes an already-appended Audit_Entry.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  createLicenseCreator,
  LICENSES_TABLE_NAME,
  LICENSE_PARTITION_KEY,
  LICENSE_CREATE_ACTION,
} from "../lib/licenses/create.ts";
import {
  createAttributeUpdater,
  LICENSE_ATTRIBUTES_ACTION,
} from "../lib/licenses/attributes.ts";
import { createAuditLog, AUDIT_TABLE_NAME } from "../lib/audit.ts";
import { FakeDynamoClient } from "../lib/dev/in-memory-dynamo.ts";
import type { DynamoItem } from "../lib/dynamo.ts";
import {
  CUSTOMER_FIELDS,
  type CustomerField,
  type CustomerProfile,
} from "../lib/licenses/customer.ts";
import type { Principal } from "../lib/auth.ts";

const RUNS = 100;

// ─── Helpers ─────────────────────────────────────────────────────────────────

const admin: Principal = {
  identity: "admin-1",
  role: "admin",
  resellerAccountId: null,
  mfaEnrolled: true,
  authMethod: "firebase",
};

const actor = { actor: "admin-1", actorRole: "admin", sourceIp: "198.51.100.42" };

/** All valid customer values for seeding and assertions. */
const VALID_CUSTOMER_VALUES: Record<CustomerField, string> = {
  customerEmail: "alice@example.com",
  customerName: "Alice Smith",
  customerPhone: "+1 555 1234567",
  customerCountry: "US",
  customerCompany: "Acme Corp",
  customerNotes: "Important customer",
};

/**
 * Recursively check that no Customer_Field VALUE appears anywhere in an object.
 * We compare against the set of actual values that were submitted/stored.
 */
function assertNoCustomerValues(
  obj: unknown,
  customerValues: string[],
  path = ""
): void {
  if (obj === null || obj === undefined) return;
  if (typeof obj === "string") {
    for (const val of customerValues) {
      if (val.length > 0 && obj.includes(val)) {
        assert.fail(
          `Customer_Field value "${val}" leaked into audit entry at path "${path}"`
        );
      }
    }
    return;
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      assertNoCustomerValues(obj[i], customerValues, `${path}[${i}]`);
    }
    return;
  }
  if (typeof obj === "object") {
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      assertNoCustomerValues(val, customerValues, `${path}.${key}`);
    }
  }
}

/** Get all audit entries from the fake DynamoDB. */
function getAuditEntries(dynamo: FakeDynamoClient): DynamoItem[] {
  return dynamo.dump(AUDIT_TABLE_NAME);
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Pick a non-empty subset of Customer_Fields. */
const customerFieldSubsetArb: fc.Arbitrary<CustomerField[]> = fc
  .subarray([...CUSTOMER_FIELDS], { minLength: 1 })
  .map((arr) => [...arr].sort());

/** Generate a valid CustomerProfile with only the chosen subset of fields. */
function validProfileForFields(
  fields: CustomerField[]
): fc.Arbitrary<CustomerProfile> {
  return fc.constant(
    Object.fromEntries(
      fields.map((f) => [f, VALID_CUSTOMER_VALUES[f]])
    ) as CustomerProfile
  );
}

/** A valid normalized prefix (1-20 uppercase alphanumeric chars, no hyphens for simplicity). */
const validPrefixArb: fc.Arbitrary<string> = fc
  .array(
    fc.constantFrom(..."ABCDEFGHJKMNPQRSTVWXYZ0123456789".split("")),
    { minLength: 1, maxLength: 20 }
  )
  .map((chars) => chars.join(""));

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Property 13: Audit entries name changed Customer_Fields and never carry their values", () => {
  it("create with Customer_Fields: audit entry names the fields, never carries values, and includes keyPrefix when supplied (Req 1.8, 5.10, 9.1, 9.2)", async () => {
    await fc.assert(
      fc.asyncProperty(
        customerFieldSubsetArb,
        fc.boolean(), // whether to include a prefix
        validPrefixArb,
        async (fields, usePrefix, prefix) => {
          const dynamo = new FakeDynamoClient();
          const audit = createAuditLog(dynamo, {
            now: () => "2025-06-15T12:00:00.000Z",
            generateId: () => `audit-${Date.now()}-${Math.random()}`,
          });
          const creator = createLicenseCreator({
            dynamo,
            audit,
            now: () => new Date("2025-06-15T12:00:00.000Z"),
          });

          const customer: CustomerProfile = {};
          const customerValues: string[] = [];
          for (const f of fields) {
            customer[f] = VALID_CUSTOMER_VALUES[f];
            customerValues.push(VALID_CUSTOMER_VALUES[f]);
          }

          const result = await creator.create(
            {
              maxActivations: 5,
              customer,
              keyPrefix: usePrefix ? prefix : undefined,
            },
            actor
          );

          assert.strictEqual(result.ok, true, "create must succeed");
          if (!result.ok) return;

          // Exactly one audit entry must have been appended.
          const entries = getAuditEntries(dynamo);
          const createEntries = entries.filter(
            (e) => e.action === LICENSE_CREATE_ACTION
          );
          assert.strictEqual(
            createEntries.length,
            1,
            "exactly one create audit entry must be appended"
          );

          const entry = createEntries[0];

          // Required fields on the audit entry (Req 9.1).
          assert.strictEqual(entry.actor, actor.actor);
          assert.strictEqual(entry.actorRole, actor.actorRole);
          assert.strictEqual(entry.action, LICENSE_CREATE_ACTION);
          assert.strictEqual(entry.target, result.value.licenseKey);
          assert.strictEqual(entry.sourceIp, actor.sourceIp);
          assert.match(
            String(entry.timestamp),
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
            "timestamp must be ISO 8601 UTC"
          );

          // The changes must include customerFieldsSet with the sorted field
          // names and no values (Req 1.8, 9.1, 9.2).
          const changes = entry.changes as Record<string, unknown>;
          assert.ok(changes, "audit entry must have changes");

          const cfs = changes.customerFieldsSet as { before: unknown; after: unknown };
          assert.ok(cfs, "changes must include customerFieldsSet");
          assert.strictEqual(cfs.before, null);
          assert.deepStrictEqual(
            cfs.after,
            [...fields].sort(),
            "customerFieldsSet.after must be sorted Customer_Field names"
          );

          // When a prefix was applied, it must appear in the audit (Req 5.10).
          if (usePrefix) {
            const kp = changes.keyPrefix as { before: unknown; after: unknown };
            assert.ok(kp, "changes must include keyPrefix when one was supplied");
            assert.strictEqual(kp.before, null);
            assert.strictEqual(kp.after, prefix);
          }

          // No Customer_Field value anywhere in the entry (Req 9.2).
          assertNoCustomerValues(entry, customerValues);
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("update with Customer_Fields: audit entry names only the changed fields and never carries values (Req 2.7, 9.1, 9.2)", async () => {
    await fc.assert(
      fc.asyncProperty(
        customerFieldSubsetArb,
        async (fieldsToUpdate) => {
          const dynamo = new FakeDynamoClient();
          const audit = createAuditLog(dynamo, {
            now: () => "2025-06-15T12:00:00.000Z",
            generateId: () => `audit-${Date.now()}-${Math.random()}`,
          });

          // Seed a license with no customer fields initially.
          const licenseKey = "PDM-TEST-ABCD-EFGH-JKMN-PQRS-TVWX-0123-4567";
          const seedRecord: DynamoItem = {
            licenseKey,
            status: "active",
            plan: "standard",
            features: [],
            maxActivations: 5,
            activations: {},
            createdAt: "2024-01-01T00:00:00.000Z",
          };
          await dynamo.conditionalPut(
            LICENSES_TABLE_NAME,
            seedRecord,
            LICENSE_PARTITION_KEY
          );

          const updater = createAttributeUpdater({
            dynamo,
            audit,
            now: () => new Date("2025-06-15T12:00:00.000Z"),
          });

          // Build the update with valid customer field values.
          const attributes: Record<string, unknown> = {};
          const customerValues: string[] = [];
          for (const f of fieldsToUpdate) {
            attributes[f] = VALID_CUSTOMER_VALUES[f];
            customerValues.push(VALID_CUSTOMER_VALUES[f]);
          }

          const auditCountBefore = dynamo.itemCount(AUDIT_TABLE_NAME);

          const result = await updater.update({
            licenseKey,
            attributes,
            principal: admin,
            sourceIp: "198.51.100.42",
          });

          assert.strictEqual(result.ok, true, "update must succeed");
          if (!result.ok) return;

          // Exactly one audit entry was appended for this operation.
          const auditCountAfter = dynamo.itemCount(AUDIT_TABLE_NAME);
          assert.strictEqual(
            auditCountAfter,
            auditCountBefore + 1,
            "exactly one audit entry must be appended"
          );

          const entries = getAuditEntries(dynamo);
          const entry = entries[entries.length - 1];

          // Required audit fields (Req 9.1).
          assert.strictEqual(entry.actor, admin.identity);
          assert.strictEqual(entry.actorRole, admin.role);
          assert.strictEqual(entry.action, LICENSE_ATTRIBUTES_ACTION);
          assert.strictEqual(entry.target, licenseKey);
          assert.strictEqual(entry.sourceIp, "198.51.100.42");
          assert.match(
            String(entry.timestamp),
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
          );

          // The changes must include customerFieldsSet with sorted field names
          // only (Req 2.7, 9.1, 9.2).
          const changes = entry.changes as Record<string, unknown>;
          assert.ok(changes, "audit entry must have changes");

          const cfs = changes.customerFieldsSet as { before: unknown; after: unknown };
          assert.ok(cfs, "changes must include customerFieldsSet");
          assert.strictEqual(cfs.before, null);
          assert.deepStrictEqual(
            cfs.after,
            [...fieldsToUpdate].sort(),
            "customerFieldsSet.after must be exactly the sorted changed field names"
          );

          // No Customer_Field value anywhere in the entry (Req 9.2).
          assertNoCustomerValues(entry, customerValues);
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("update with no Customer_Field changes: no customerFieldsSet/Cleared key appears (Req 9.7)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("pro", "enterprise", "standard"),
        async (newPlan) => {
          const dynamo = new FakeDynamoClient();
          const audit = createAuditLog(dynamo, {
            now: () => "2025-06-15T12:00:00.000Z",
            generateId: () => `audit-${Date.now()}-${Math.random()}`,
          });

          // Seed a license with some customer fields already set.
          const licenseKey = "PDM-NOCHG-ABCD-EFGH-JKMN-PQRS-TVWX-0123-4567";
          const seedRecord: DynamoItem = {
            licenseKey,
            status: "active",
            plan: "standard",
            features: [],
            maxActivations: 5,
            activations: {},
            createdAt: "2024-01-01T00:00:00.000Z",
            customerEmail: "alice@example.com",
            customerName: "Alice Smith",
          };
          await dynamo.conditionalPut(
            LICENSES_TABLE_NAME,
            seedRecord,
            LICENSE_PARTITION_KEY
          );

          const updater = createAttributeUpdater({
            dynamo,
            audit,
            now: () => new Date("2025-06-15T12:00:00.000Z"),
          });

          // Update only a non-Customer_Field attribute.
          const result = await updater.update({
            licenseKey,
            attributes: { plan: newPlan },
            principal: admin,
            sourceIp: "198.51.100.42",
          });

          assert.strictEqual(result.ok, true, "update must succeed");
          if (!result.ok) return;

          // The appended audit entry must NOT contain customerFieldsSet or
          // customerFieldsCleared (Req 9.7).
          const entries = getAuditEntries(dynamo);
          const entry = entries[entries.length - 1];
          const changes = entry.changes as Record<string, unknown>;

          assert.strictEqual(
            Object.prototype.hasOwnProperty.call(changes, "customerFieldsSet"),
            false,
            "customerFieldsSet must not appear when no Customer_Field changed"
          );
          assert.strictEqual(
            Object.prototype.hasOwnProperty.call(changes, "customerFieldsCleared"),
            false,
            "customerFieldsCleared must not appear when no Customer_Field changed"
          );
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("clearing Customer_Fields: audit records customerFieldsCleared with names only (Req 2.7, 9.1, 9.2)", async () => {
    await fc.assert(
      fc.asyncProperty(
        customerFieldSubsetArb,
        async (fieldsToClear) => {
          const dynamo = new FakeDynamoClient();
          const audit = createAuditLog(dynamo, {
            now: () => "2025-06-15T12:00:00.000Z",
            generateId: () => `audit-${Date.now()}-${Math.random()}`,
          });

          // Seed a license with all customer fields populated.
          const licenseKey = "PDM-CLR-ABCD-EFGH-JKMN-PQRS-TVWX-0123-4567";
          const seedRecord: DynamoItem = {
            licenseKey,
            status: "active",
            plan: "standard",
            features: [],
            maxActivations: 5,
            activations: {},
            createdAt: "2024-01-01T00:00:00.000Z",
            ...VALID_CUSTOMER_VALUES,
          };
          await dynamo.conditionalPut(
            LICENSES_TABLE_NAME,
            seedRecord,
            LICENSE_PARTITION_KEY
          );

          const updater = createAttributeUpdater({
            dynamo,
            audit,
            now: () => new Date("2025-06-15T12:00:00.000Z"),
          });

          // Clear the selected customer fields by submitting null.
          const attributes: Record<string, unknown> = {};
          const existingValues: string[] = [];
          for (const f of fieldsToClear) {
            attributes[f] = null;
            existingValues.push(VALID_CUSTOMER_VALUES[f]);
          }

          const auditCountBefore = dynamo.itemCount(AUDIT_TABLE_NAME);

          const result = await updater.update({
            licenseKey,
            attributes,
            principal: admin,
            sourceIp: "198.51.100.42",
          });

          assert.strictEqual(result.ok, true, "update must succeed");
          if (!result.ok) return;

          // Exactly one audit entry appended.
          const auditCountAfter = dynamo.itemCount(AUDIT_TABLE_NAME);
          assert.strictEqual(
            auditCountAfter,
            auditCountBefore + 1,
            "exactly one audit entry must be appended"
          );

          const entries = getAuditEntries(dynamo);
          const entry = entries[entries.length - 1];
          const changes = entry.changes as Record<string, unknown>;

          // customerFieldsCleared must hold sorted field names (Req 9.1, 9.2).
          const cfc = changes.customerFieldsCleared as {
            before: unknown;
            after: unknown;
          };
          assert.ok(cfc, "changes must include customerFieldsCleared");
          assert.deepStrictEqual(
            cfc.before,
            [...fieldsToClear].sort(),
            "customerFieldsCleared.before must be sorted cleared field names"
          );
          assert.strictEqual(cfc.after, null);

          // No Customer_Field value anywhere in the entry (Req 9.2).
          assertNoCustomerValues(entry, existingValues);
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("audit entries are append-only: no existing entry is updated or removed (Req 9.3)", async () => {
    await fc.assert(
      fc.asyncProperty(
        customerFieldSubsetArb,
        fc.integer({ min: 2, max: 5 }),
        async (fields, mutationCount) => {
          const dynamo = new FakeDynamoClient();
          let auditN = 0;
          const audit = createAuditLog(dynamo, {
            now: () => "2025-06-15T12:00:00.000Z",
            generateId: () => `audit-${auditN++}`,
          });

          // Seed a license.
          const licenseKey = "PDM-APPONLY-ABCD-EFGH-JKMN-PQRS-TVWX-0123-4567";
          const seedRecord: DynamoItem = {
            licenseKey,
            status: "active",
            plan: "standard",
            features: [],
            maxActivations: 5,
            activations: {},
            createdAt: "2024-01-01T00:00:00.000Z",
          };
          await dynamo.conditionalPut(
            LICENSES_TABLE_NAME,
            seedRecord,
            LICENSE_PARTITION_KEY
          );

          const updater = createAttributeUpdater({
            dynamo,
            audit,
            now: () => new Date("2025-06-15T12:00:00.000Z"),
          });

          // Perform multiple mutations and snapshot audit entries after each.
          const snapshots: DynamoItem[][] = [];

          for (let i = 0; i < mutationCount; i++) {
            const attributes: Record<string, unknown> = {};
            for (const f of fields) {
              // Alternate between setting and clearing to generate variety.
              attributes[f] =
                i % 2 === 0 ? VALID_CUSTOMER_VALUES[f] : null;
            }

            await updater.update({
              licenseKey,
              attributes,
              principal: admin,
              sourceIp: "198.51.100.42",
            });

            // Snapshot all audit entries after this mutation.
            snapshots.push(getAuditEntries(dynamo));
          }

          // Verify append-only: each snapshot is a prefix of the next and no
          // entry from a previous snapshot changes.
          for (let i = 1; i < snapshots.length; i++) {
            const prev = snapshots[i - 1];
            const curr = snapshots[i];

            // Current must have at least as many entries as previous.
            assert.ok(
              curr.length >= prev.length,
              "audit log must only grow (append-only)"
            );

            // Every entry in the previous snapshot must be unchanged in the
            // current snapshot.
            for (let j = 0; j < prev.length; j++) {
              assert.deepStrictEqual(
                curr[j],
                prev[j],
                `audit entry ${j} must not be modified or removed after being appended`
              );
            }
          }
        }
      ),
      { numRuns: RUNS }
    );
  });
});
