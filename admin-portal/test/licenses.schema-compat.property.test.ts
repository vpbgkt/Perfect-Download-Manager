// Feature: admin-reseller-portal, Property 31: License schema compatibility is preserved
//
// A newly created License_Record persisted to `pdm-licenses` carries exactly the
// existing schema attributes the activate/validate/trial Lambdas read
// (licenseKey, status, plan, owner, features, maxActivations, expiresAt,
// activations, createdAt) plus at most the single additive `resellerAccountId`
// attribute — and nothing else that could collide with the existing schema.
//
// Validates: Requirements 14.2, 14.3

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

const RUNS = 100;

/** The existing License_Record schema attributes (Req 14.2). */
const EXISTING_SCHEMA_ATTRS = [
  "licenseKey",
  "status",
  "plan",
  "owner",
  "features",
  "maxActivations",
  "expiresAt",
  "activations",
  "createdAt",
] as const;

/** Only additive attribute the portal may add (Req 14.3). */
const ADDITIVE_ATTRS = ["resellerAccountId"] as const;

const ALLOWED_ATTRS = new Set<string>([...EXISTING_SCHEMA_ATTRS, ...ADDITIVE_ATTRS]);

function makeCreator() {
  const dynamo = new FakeDynamoClient();
  dynamo.registerKeySchema(LICENSES_TABLE_NAME, LICENSE_PARTITION_KEY);
  const audit = createAuditLog(dynamo, {
    tableName: "pdm-portal-audit",
    now: () => "2025-01-01T00:00:00.000Z",
    generateId: (() => {
      let n = 0;
      return () => `audit-${n++}`;
    })(),
  });
  const creator = createLicenseCreator({
    dynamo,
    audit,
    now: () => new Date("2025-06-15T12:00:00.000Z"),
  });
  return { dynamo, creator };
}

const actor = { actor: "admin-1", actorRole: "admin", sourceIp: "10.0.0.1" };

describe("Property 31: License schema compatibility is preserved", () => {
  it("persists only allowed schema attributes for admin- and reseller-created records", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          plan: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
          maxActivations: fc.integer({ min: 1, max: 1000 }),
          owner: fc.option(fc.string({ maxLength: 30 }), { nil: undefined }),
          features: fc.option(fc.array(fc.string({ maxLength: 10 }), { maxLength: 5 }), {
            nil: undefined,
          }),
          reseller: fc.option(fc.string({ minLength: 1, maxLength: 12 }), { nil: null }),
        }),
        async (input) => {
          const { dynamo, creator } = makeCreator();
          const result = await creator.create(
            {
              plan: input.plan,
              maxActivations: input.maxActivations,
              owner: input.owner,
              features: input.features,
              resellerAccountId: input.reseller,
            },
            actor
          );
          assert.strictEqual(result.ok, true);
          if (!result.ok) return;

          const stored = dynamo.dump(LICENSES_TABLE_NAME);
          assert.strictEqual(stored.length, 1);
          const item = stored[0];

          // Every persisted attribute must be an allowed schema/additive attr.
          for (const key of Object.keys(item)) {
            assert.ok(
              ALLOWED_ATTRS.has(key),
              `unexpected attribute "${key}" would collide with the existing schema`
            );
          }

          // Required existing-schema fields are present and correctly typed.
          assert.strictEqual(item.status, "active");
          assert.deepStrictEqual(item.activations, {});
          assert.strictEqual(typeof item.createdAt, "string");
          assert.strictEqual(typeof item.licenseKey, "string");
          assert.ok(Array.isArray(item.features));
          assert.strictEqual(typeof item.maxActivations, "number");
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("adds resellerAccountId only for reseller-created records", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.option(fc.string({ minLength: 1, maxLength: 12 }), { nil: null }),
        async (reseller) => {
          const { dynamo, creator } = makeCreator();
          const result = await creator.create(
            { maxActivations: 3, resellerAccountId: reseller },
            actor
          );
          assert.strictEqual(result.ok, true);
          const item = dynamo.dump(LICENSES_TABLE_NAME)[0];
          if (reseller == null) {
            assert.ok(!("resellerAccountId" in item) || item.resellerAccountId === undefined);
          } else {
            assert.strictEqual(item.resellerAccountId, reseller);
          }
        }
      ),
      { numRuns: RUNS }
    );
  });
});
