// Feature: license-key-management-enhancements
// Property 16: Existing records, requests, responses, and outcomes keep their behavior
//
// Validates: Requirements 10.1, 10.2, 10.5, 10.6, 10.8, 10.9, 10.12, 10.13
//
// This property verifies backward compatibility across the feature enhancement:
//
// - Legacy_License_Keys (PDM-XXXX-XXXX-XXXX-XXXX hex format) are accepted
//   everywhere the Portal_Backend accepts a License_Key (Req 10.2).
// - Pre-feature request shapes (no keyPrefix, no Customer_Fields) produce the
//   same persisted attributes (other than new key format) as before (Req 10.5).
// - Responses on both credential paths include every field that existed before
//   this feature under the same name and meaning, with new fields added
//   alongside (Req 10.6, 10.12).
// - Adding Customer_Fields to a pre-feature record does not change its
//   `licenseKey` (Req 10.13).
// - The Licensing_Backend reads existing attributes (`status`, `plan`, `owner`,
//   `features`, `maxActivations`, `expiresAt`, `activations`) with unchanged
//   meanings (Req 10.9).
// - A Legacy_License_Key activates through the system unchanged (Req 10.1, 10.8).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { FakeDynamoClient } from "../lib/dev/in-memory-dynamo.ts";
import { createAuditLog } from "../lib/audit.ts";
import {
  createLicenseCreator,
  LICENSES_TABLE_NAME,
  LICENSE_PARTITION_KEY,
} from "../lib/licenses/create.ts";
import { createAttributeUpdater } from "../lib/licenses/attributes.ts";
import { createLicenseQuery } from "../lib/licenses/query.ts";
import {
  CUSTOMER_FIELDS,
  evaluateCustomerProfile,
  type CustomerField,
  type CustomerProfile,
} from "../lib/licenses/customer.ts";
import type { DynamoItem } from "../lib/dynamo.ts";

const RUNS = 100;

// ─── Constants ───────────────────────────────────────────────────────────────

/** The pre-feature License_Record schema attributes (Req 10.9). */
const PRE_FEATURE_ATTRS = [
  "licenseKey",
  "status",
  "plan",
  "owner",
  "features",
  "maxActivations",
  "expiresAt",
  "activations",
  "createdAt",
  "resellerAccountId",
] as const;

/** Response fields that must be present on every license view/summary. */
const REQUIRED_RESPONSE_FIELDS = [
  "licenseKey",
  "status",
  "features",
  "activationCount",
] as const;

const actor = { actor: "admin-user", actorRole: "admin", sourceIp: "198.51.100.1" };
const adminScope = { role: "admin" as const, resellerAccountId: null };
const resellerScope = { role: "reseller" as const, resellerAccountId: "res-alpha" };
const principal = { identity: "admin-user", role: "admin" as const, resellerAccountId: null };

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/**
 * Legacy License_Key format: PDM-XXXX-XXXX-XXXX-XXXX where X is uppercase hex.
 * Uses fc.constantFrom to pick from realistic hex groups.
 */
const HEX_GROUPS = [
  "0000", "1111", "2222", "3333", "4444", "5555", "6666", "7777",
  "8888", "9999", "AAAA", "BBBB", "CCCC", "DDDD", "EEEE", "FFFF",
  "A1B2", "C3D4", "E5F6", "1A2B", "3C4D", "5E6F", "7890", "ABCD",
  "1234", "5678", "9ABC", "DEF0", "FACE", "BEAD", "CAFE", "DEAD",
] as const;

const legacyKeyArb = fc
  .tuple(
    fc.constantFrom(...HEX_GROUPS),
    fc.constantFrom(...HEX_GROUPS),
    fc.constantFrom(...HEX_GROUPS),
    fc.constantFrom(...HEX_GROUPS)
  )
  .map(([a, b, c, d]) => `PDM-${a}-${b}-${c}-${d}`);

/**
 * Pre-feature create request shape: no keyPrefix, no Customer_Fields,
 * just the existing fields.
 */
const preFeatureCreateArb = fc.record({
  plan: fc.option(fc.constantFrom("standard", "pro", "enterprise"), { nil: undefined }),
  maxActivations: fc.integer({ min: 1, max: 1000 }),
  owner: fc.option(fc.string({ minLength: 1, maxLength: 30 }), { nil: undefined }),
  features: fc.option(fc.array(fc.constantFrom("feature-a", "feature-b", "feature-c"), { maxLength: 3 }), { nil: undefined }),
  expiresAt: fc.option(
    fc.constantFrom("2025-12-31T23:59:59.000Z", "2026-06-15T00:00:00.000Z"),
    { nil: undefined }
  ),
  resellerAccountId: fc.option(fc.constantFrom("res-alpha", "res-beta"), { nil: null }),
});

/**
 * Valid customer data to add to a pre-feature record (Req 10.13).
 */
const customerFieldsToAddArb = fc.record({
  customerEmail: fc.option(fc.constant("alice@example.com"), { nil: undefined }),
  customerName: fc.option(fc.constant("Alice Johnson"), { nil: undefined }),
  customerPhone: fc.option(fc.constant("+1 555 1234567"), { nil: undefined }),
  customerCountry: fc.option(fc.constant("US"), { nil: undefined }),
  customerCompany: fc.option(fc.constant("Acme Corp"), { nil: undefined }),
  customerNotes: fc.option(fc.constant("VIP customer"), { nil: undefined }),
}).filter((profile) => {
  // Ensure at least one field is present
  return Object.values(profile).some((v) => v !== undefined);
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildDeps() {
  const dynamo = new FakeDynamoClient();
  const audit = createAuditLog(dynamo);
  const creator = createLicenseCreator({ dynamo, audit });
  const updater = createAttributeUpdater({ dynamo, audit });
  const query = createLicenseQuery({ dynamo });
  return { dynamo, creator, updater, query };
}

/**
 * Seed a pre-feature Legacy_License_Key record directly into DynamoDB, as it
 * would appear from the previous version of the system (no Customer_Fields,
 * no keyPrefix, legacy key format).
 */
function seedLegacyRecord(
  dynamo: FakeDynamoClient,
  overrides: Partial<DynamoItem> & { licenseKey: string }
): DynamoItem {
  const record: DynamoItem = {
    licenseKey: overrides.licenseKey,
    status: overrides.status ?? "active",
    plan: overrides.plan ?? "standard",
    owner: overrides.owner ?? "test-owner",
    features: overrides.features ?? [],
    maxActivations: overrides.maxActivations ?? 5,
    activations: overrides.activations ?? {},
    createdAt: overrides.createdAt ?? "2024-01-15T10:00:00.000Z",
  };
  if (overrides.expiresAt) record.expiresAt = overrides.expiresAt;
  if (overrides.resellerAccountId) record.resellerAccountId = overrides.resellerAccountId;
  dynamo.registerKeySchema(LICENSES_TABLE_NAME, LICENSE_PARTITION_KEY);
  void dynamo.put({ TableName: LICENSES_TABLE_NAME, Item: { ...record } });
  return record;
}

// ─── Property 16 ─────────────────────────────────────────────────────────────

describe("Property 16: Existing records, requests, responses, and outcomes keep their behavior", () => {
  it("Legacy_License_Keys are accepted by the query view path (Req 10.1, 10.2)", async () => {
    await fc.assert(
      fc.asyncProperty(legacyKeyArb, async (legacyKey) => {
        const { dynamo, query } = buildDeps();

        // Seed a legacy record directly (as it would exist from before the feature).
        seedLegacyRecord(dynamo, { licenseKey: legacyKey });

        // View by the legacy key must succeed — the system accepts it.
        const viewed = await query.view(adminScope, legacyKey);
        assert.ok(viewed, "Legacy_License_Key must be viewable (Req 10.2)");
        assert.strictEqual(viewed.licenseKey, legacyKey, "viewed key must equal the legacy key");
      }),
      { numRuns: RUNS }
    );
  });

  it("Legacy_License_Keys appear in list/search results (Req 10.2)", async () => {
    await fc.assert(
      fc.asyncProperty(legacyKeyArb, async (legacyKey) => {
        const { dynamo, query } = buildDeps();

        seedLegacyRecord(dynamo, { licenseKey: legacyKey });

        // List should include the legacy record.
        const result = await query.list(adminScope, { pageSize: 50 });
        const keys = result.items.map((i) => i.licenseKey);
        assert.ok(
          keys.includes(legacyKey),
          "Legacy_License_Key must appear in list results (Req 10.2)"
        );
      }),
      { numRuns: RUNS }
    );
  });

  it("pre-feature request shapes produce the same persisted attributes aside from key format (Req 10.5)", async () => {
    await fc.assert(
      fc.asyncProperty(preFeatureCreateArb, async (input) => {
        const { dynamo, creator } = buildDeps();

        // A create with no keyPrefix and no Customer_Fields.
        const result = await creator.create(
          {
            plan: input.plan,
            maxActivations: input.maxActivations,
            owner: input.owner,
            features: input.features,
            expiresAt: input.expiresAt,
            resellerAccountId: input.resellerAccountId,
            // No keyPrefix, no customer — pre-feature shape.
          },
          actor
        );

        assert.strictEqual(result.ok, true, "pre-feature-shaped create must succeed");
        if (!result.ok) return;

        // The persisted item must have all pre-feature attributes and no new ones
        // except the ones that are naturally absent (undefined values are not stored).
        const stored = dynamo.dump(LICENSES_TABLE_NAME);
        assert.strictEqual(stored.length, 1);
        const item = stored[0];

        // Must carry the core pre-feature attributes with correct types.
        assert.strictEqual(typeof item.licenseKey, "string");
        assert.strictEqual(item.status, "active");
        assert.ok(Array.isArray(item.features));
        assert.strictEqual(typeof item.maxActivations, "number");
        assert.deepStrictEqual(item.activations, {});
        assert.strictEqual(typeof item.createdAt, "string");

        // No Customer_Field attributes should be present (Req 10.5).
        for (const field of CUSTOMER_FIELDS) {
          assert.strictEqual(
            Object.prototype.hasOwnProperty.call(item, field),
            false,
            `Customer_Field '${field}' must not appear on a pre-feature request result`
          );
        }

        // No keyPrefix attribute should be present (Req 10.5).
        assert.strictEqual(
          Object.prototype.hasOwnProperty.call(item, "keyPrefix"),
          false,
          "keyPrefix must not appear on a pre-feature request result"
        );
      }),
      { numRuns: RUNS }
    );
  });

  it("responses include every pre-feature field under the same name (Req 10.6, 10.9)", async () => {
    await fc.assert(
      fc.asyncProperty(
        legacyKeyArb,
        fc.constantFrom("standard", "pro", "enterprise"),
        fc.integer({ min: 1, max: 100 }),
        fc.option(fc.constantFrom("2025-12-31T23:59:59.000Z"), { nil: undefined }),
        async (legacyKey, plan, maxActivations, expiresAt) => {
          const { dynamo, query } = buildDeps();

          const record: DynamoItem = {
            licenseKey: legacyKey,
            status: "active",
            plan,
            owner: "pre-feature-owner",
            features: ["feature-a"],
            maxActivations,
            activations: {},
            createdAt: "2024-01-01T00:00:00.000Z",
          };
          if (expiresAt) record.expiresAt = expiresAt;

          dynamo.registerKeySchema(LICENSES_TABLE_NAME, LICENSE_PARTITION_KEY);
          void dynamo.put({ TableName: LICENSES_TABLE_NAME, Item: { ...record } });

          // View the record.
          const viewed = await query.view(adminScope, legacyKey);
          assert.ok(viewed, "legacy record must be viewable");

          // All pre-feature response fields must be present and correct.
          assert.strictEqual(viewed.licenseKey, legacyKey, "licenseKey (Req 10.9)");
          assert.strictEqual(viewed.status, "active", "status (Req 10.9)");
          assert.strictEqual(viewed.plan, plan, "plan (Req 10.9)");
          assert.strictEqual(viewed.owner, "pre-feature-owner", "owner (Req 10.9)");
          assert.deepStrictEqual(viewed.features, ["feature-a"], "features (Req 10.9)");
          assert.strictEqual(viewed.maxActivations, maxActivations, "maxActivations (Req 10.9)");
          assert.strictEqual(viewed.activationCount, 0, "activationCount");
          assert.deepStrictEqual(viewed.activations, [], "activations");
          assert.strictEqual(viewed.createdAt, "2024-01-01T00:00:00.000Z", "createdAt");
          if (expiresAt) {
            assert.strictEqual(viewed.expiresAt, expiresAt, "expiresAt (Req 10.9)");
          }

          // New attributes absent from a pre-feature record must not appear in response
          // as null — they must simply be absent (Req 10.3/10.6).
          for (const field of CUSTOMER_FIELDS) {
            assert.strictEqual(
              viewed[field],
              undefined,
              `Customer_Field '${field}' must be absent (not null) on pre-feature record response`
            );
          }
          assert.strictEqual(
            viewed.keyPrefix,
            undefined,
            "keyPrefix must be absent on pre-feature record response"
          );
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("additive responses: both admin and reseller credential paths return same pre-feature fields (Req 10.6, 10.12)", async () => {
    await fc.assert(
      fc.asyncProperty(legacyKeyArb, async (legacyKey) => {
        const { dynamo, query } = buildDeps();

        // Seed a reseller-owned legacy record.
        seedLegacyRecord(dynamo, {
          licenseKey: legacyKey,
          resellerAccountId: "res-alpha",
        });

        // Admin view.
        const adminView = await query.view(adminScope, legacyKey);
        assert.ok(adminView, "admin must see the record");

        // Reseller view.
        const resellerView = await query.view(resellerScope, legacyKey);
        assert.ok(resellerView, "reseller must see their own record");

        // Both credential paths must return the same pre-feature fields.
        for (const field of REQUIRED_RESPONSE_FIELDS) {
          assert.deepStrictEqual(
            adminView[field],
            resellerView[field],
            `field '${field}' must be identical across both credential paths (Req 10.6, 10.12)`
          );
        }

        // Both must include licenseKey, status, activationCount, features.
        assert.strictEqual(adminView.licenseKey, legacyKey);
        assert.strictEqual(resellerView.licenseKey, legacyKey);
        assert.strictEqual(adminView.resellerAccountId, "res-alpha");
        assert.strictEqual(resellerView.resellerAccountId, "res-alpha");
      }),
      { numRuns: RUNS }
    );
  });

  it("adding Customer_Fields to a pre-feature record does not change its licenseKey (Req 10.13)", async () => {
    await fc.assert(
      fc.asyncProperty(
        legacyKeyArb,
        customerFieldsToAddArb,
        async (legacyKey, fieldsToAdd) => {
          const { dynamo, updater, query } = buildDeps();

          // Seed a pre-feature record (no Customer_Fields).
          seedLegacyRecord(dynamo, { licenseKey: legacyKey });

          // Save the licenseKey before the update.
          const beforeView = await query.view(adminScope, legacyKey);
          assert.ok(beforeView);
          const keyBefore = beforeView.licenseKey;

          // Add Customer_Fields via an update.
          const attributes: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(fieldsToAdd)) {
            if (value !== undefined) {
              attributes[key] = value;
            }
          }

          const result = await updater.update({
            licenseKey: legacyKey,
            attributes,
            principal,
            sourceIp: actor.sourceIp,
          });
          assert.strictEqual(result.ok, true, "update must succeed");
          if (!result.ok) return;

          // The licenseKey must be unchanged (Req 10.13).
          const afterView = await query.view(adminScope, legacyKey);
          assert.ok(afterView, "record must still be viewable after adding customer fields");
          assert.strictEqual(
            afterView.licenseKey,
            keyBefore,
            "licenseKey must not change when Customer_Fields are added (Req 10.13)"
          );

          // The added Customer_Fields must appear on the record.
          for (const [key, value] of Object.entries(fieldsToAdd)) {
            if (value !== undefined) {
              assert.ok(
                afterView[key as keyof typeof afterView] !== undefined,
                `added Customer_Field '${key}' must be present on the record after update`
              );
            }
          }

          // Pre-feature attributes must still be intact (Req 10.9).
          assert.strictEqual(afterView.status, "active", "status preserved (Req 10.9)");
          assert.strictEqual(afterView.plan, "standard", "plan preserved (Req 10.9)");
          assert.strictEqual(afterView.owner, "test-owner", "owner preserved (Req 10.9)");
          assert.deepStrictEqual(afterView.features, [], "features preserved (Req 10.9)");
          assert.strictEqual(afterView.maxActivations, 5, "maxActivations preserved (Req 10.9)");
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("a pre-feature request shape through the Reseller_API path produces correct response (Req 10.12)", async () => {
    await fc.assert(
      fc.asyncProperty(
        legacyKeyArb,
        fc.constantFrom("res-alpha", "res-beta"),
        async (legacyKey, resellerId) => {
          const { dynamo, query } = buildDeps();

          // Seed a reseller-owned legacy record.
          seedLegacyRecord(dynamo, {
            licenseKey: legacyKey,
            resellerAccountId: resellerId,
          });

          const scope = { role: "reseller" as const, resellerAccountId: resellerId };

          // View must succeed and carry pre-feature fields.
          const viewed = await query.view(scope, legacyKey);
          assert.ok(viewed, "reseller must see their own legacy record");
          assert.strictEqual(viewed.licenseKey, legacyKey);
          assert.strictEqual(viewed.status, "active");
          assert.strictEqual(viewed.resellerAccountId, resellerId);

          // New fields must be absent (not null) on a pre-feature record.
          for (const field of CUSTOMER_FIELDS) {
            assert.strictEqual(
              viewed[field],
              undefined,
              `${field} must be absent on pre-feature reseller record (Req 10.12)`
            );
          }
          assert.strictEqual(viewed.keyPrefix, undefined);

          // List through reseller scope must also include it.
          const listResult = await query.list(scope, { pageSize: 50 });
          const keys = listResult.items.map((i) => i.licenseKey);
          assert.ok(
            keys.includes(legacyKey),
            "reseller's legacy record must appear in list (Req 10.12)"
          );
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("new key format (PDM-<secret>) is accepted alongside legacy keys (Req 10.2, 10.8)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 100 }),
        async (maxActivations) => {
          const { dynamo, creator, query } = buildDeps();

          // Create a license with no prefix — produces the new format.
          const result = await creator.create({ maxActivations }, actor);
          assert.strictEqual(result.ok, true);
          if (!result.ok) return;

          const newKey = result.value.licenseKey;

          // The new key format must be accepted by the view path (Req 10.2).
          const viewed = await query.view(adminScope, newKey);
          assert.ok(viewed, "new format key must be viewable");
          assert.strictEqual(viewed.licenseKey, newKey);

          // Now seed a legacy key and verify both coexist in the same table.
          const legacyKey = "PDM-AAAA-BBBB-CCCC-DDDD";
          seedLegacyRecord(dynamo, { licenseKey: legacyKey });

          const legacyViewed = await query.view(adminScope, legacyKey);
          assert.ok(legacyViewed, "legacy key must still be viewable alongside new key");

          const newViewed = await query.view(adminScope, newKey);
          assert.ok(newViewed, "new key must still be viewable alongside legacy key");
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("existing attributes are read with unchanged meanings after Customer_Fields are added (Req 10.9)", async () => {
    await fc.assert(
      fc.asyncProperty(
        legacyKeyArb,
        fc.constantFrom("standard", "pro"),
        fc.integer({ min: 1, max: 1000 }),
        fc.option(fc.constantFrom("2025-12-31T23:59:59.000Z"), { nil: undefined }),
        async (legacyKey, plan, maxActivations, expiresAt) => {
          const { dynamo, updater, query } = buildDeps();

          // Seed a pre-feature record with specific attribute values.
          const record: DynamoItem = {
            licenseKey: legacyKey,
            status: "active",
            plan,
            owner: "original-owner",
            features: ["feat-x", "feat-y"],
            maxActivations,
            activations: { "aabb": { activatedAt: "2024-03-01T00:00:00.000Z" } },
            createdAt: "2024-01-15T10:00:00.000Z",
          };
          if (expiresAt) record.expiresAt = expiresAt;

          dynamo.registerKeySchema(LICENSES_TABLE_NAME, LICENSE_PARTITION_KEY);
          void dynamo.put({ TableName: LICENSES_TABLE_NAME, Item: { ...record } });

          // Add a Customer_Field.
          const result = await updater.update({
            licenseKey: legacyKey,
            attributes: { customerEmail: "test@example.com" },
            principal,
            sourceIp: actor.sourceIp,
          });
          assert.strictEqual(result.ok, true);

          // Verify all pre-feature attributes retain their meaning.
          const afterView = await query.view(adminScope, legacyKey);
          assert.ok(afterView);
          assert.strictEqual(afterView.licenseKey, legacyKey, "licenseKey unchanged");
          assert.strictEqual(afterView.status, "active", "status unchanged (Req 10.9)");
          assert.strictEqual(afterView.plan, plan, "plan unchanged (Req 10.9)");
          assert.strictEqual(afterView.owner, "original-owner", "owner unchanged (Req 10.9)");
          assert.deepStrictEqual(afterView.features, ["feat-x", "feat-y"], "features unchanged (Req 10.9)");
          assert.strictEqual(afterView.maxActivations, maxActivations, "maxActivations unchanged (Req 10.9)");
          if (expiresAt) {
            assert.strictEqual(afterView.expiresAt, expiresAt, "expiresAt unchanged (Req 10.9)");
          }
          assert.strictEqual(afterView.activationCount, 1, "activationCount from activations map");

          // The new Customer_Field must coexist with the existing attributes.
          assert.strictEqual(afterView.customerEmail, "test@example.com");
        }
      ),
      { numRuns: RUNS }
    );
  });
});
