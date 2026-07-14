// Feature: admin-reseller-portal, Property 8: New license records have correct defaults
//
// Property 8: New license records have correct defaults
// Validates: Requirements 3.2, 3.6
//
// For any authorized create-license request, the persisted License_Record has
//   - status === "active",
//   - activations === {} (an empty map),
//   - createdAt equal to the injected creation time rendered as a valid ISO 8601
//     UTC timestamp (Req 3.2), and
//   - resellerAccountId equal to the creating Reseller_Account for a
//     reseller-created record, while an admin-created record attaches no reseller
//     association (Req 3.6).
//
// The record is inspected on the in-memory DynamoDB fake (dump/allItems) — the
// authoritative persisted state — rather than only the returned value.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { createLicenseCreator, LICENSES_TABLE_NAME, LICENSE_PARTITION_KEY } from "../lib/licenses/create.ts";
import { createAuditLog } from "../lib/audit.ts";
import { validateIso8601Utc } from "../lib/validation.ts";
import { FakeDynamoClient } from "../lib/dev/in-memory-dynamo.ts";

const RUNS = 100;

/** Generate one canonical `XXXX` uppercase-hex License_Key group. */
const groupArb = fc
  .integer({ min: 0, max: 0xffff })
  .map((n) => n.toString(16).toUpperCase().padStart(4, "0"));

/** Generate a well-formed `PDM-XXXX-XXXX-XXXX-XXXX` License_Key. */
const licenseKeyArb = fc
  .tuple(groupArb, groupArb, groupArb, groupArb)
  .map((groups) => `PDM-${groups.join("-")}`);

/** A valid creation clock instant (used for the injected `now` and createdAt). */
const nowArb = fc.date({
  min: new Date("2000-01-01T00:00:00.000Z"),
  max: new Date("2100-01-01T00:00:00.000Z"),
  noInvalidDate: true,
});

/** Common, already-authorized create attributes (excluding reseller ownership). */
const baseInputArb = fc.record({
  plan: fc.option(fc.string(), { nil: undefined }),
  maxActivations: fc.integer({ min: 1, max: 100_000 }),
  owner: fc.option(fc.string(), { nil: undefined }),
  features: fc.option(fc.array(fc.string(), { maxLength: 8 }), { nil: undefined }),
  expiresAt: fc.option(
    nowArb.map((d) => d.toISOString()),
    { nil: undefined }
  ),
});

/** Build a fresh creator wired to an in-memory fake, returning both. */
function makeCreator(now: Date, licenseKey: string) {
  const dynamo = new FakeDynamoClient();
  const audit = createAuditLog(dynamo);
  const creator = createLicenseCreator({
    dynamo,
    audit,
    now: () => now,
    generateKey: () => licenseKey,
  });
  return { dynamo, creator };
}

/** Read the single persisted License_Record straight off the fake. */
function persistedRecord(dynamo: FakeDynamoClient, licenseKey: string) {
  const items = dynamo.dump(LICENSES_TABLE_NAME);
  const record = items.find((item) => item[LICENSE_PARTITION_KEY] === licenseKey);
  assert.ok(record, "expected the created License_Record to be persisted in pdm-licenses");
  return record as Record<string, unknown>;
}

describe("Property 8: New license records have correct defaults", () => {
  it("reseller-created records get active status, empty activations, ISO 8601 UTC createdAt, and the reseller association (Req 3.2, 3.6)", async () => {
    await fc.assert(
      fc.asyncProperty(
        baseInputArb,
        licenseKeyArb,
        nowArb,
        fc.string({ minLength: 1, maxLength: 40 }),
        async (base, licenseKey, now, resellerAccountId) => {
          const { dynamo, creator } = makeCreator(now, licenseKey);

          const result = await creator.create({ ...base, resellerAccountId }, {
            actor: "reseller-user",
            actorRole: "reseller",
            sourceIp: "203.0.113.7",
          });

          assert.strictEqual(result.ok, true, "reseller create should succeed for valid input");

          const record = persistedRecord(dynamo, licenseKey);

          // Req 3.2 — deterministic defaults.
          assert.strictEqual(record.status, "active");
          assert.deepStrictEqual(record.activations, {});
          assert.strictEqual(record.createdAt, now.toISOString());
          assert.strictEqual(validateIso8601Utc(record.createdAt as string).ok, true);
          assert.strictEqual(
            new Date(record.createdAt as string).getTime(),
            now.getTime(),
            "createdAt must round-trip to the injected creation instant"
          );

          // Req 3.6 — the creating reseller is recorded as the owner association.
          assert.strictEqual(record.resellerAccountId, resellerAccountId);
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("admin-created records get the same defaults but attach no reseller association (Req 3.2, 3.6)", async () => {
    await fc.assert(
      fc.asyncProperty(
        baseInputArb,
        licenseKeyArb,
        nowArb,
        // Admin-created: resellerAccountId is omitted, null, or undefined.
        fc.constantFrom<null | undefined>(null, undefined),
        async (base, licenseKey, now, resellerAccountId) => {
          const { dynamo, creator } = makeCreator(now, licenseKey);

          const result = await creator.create({ ...base, resellerAccountId }, {
            actor: "admin-user",
            actorRole: "admin",
            sourceIp: "198.51.100.42",
          });

          assert.strictEqual(result.ok, true, "admin create should succeed for valid input");

          const record = persistedRecord(dynamo, licenseKey);

          // Req 3.2 — deterministic defaults.
          assert.strictEqual(record.status, "active");
          assert.deepStrictEqual(record.activations, {});
          assert.strictEqual(record.createdAt, now.toISOString());
          assert.strictEqual(validateIso8601Utc(record.createdAt as string).ok, true);
          assert.strictEqual(
            new Date(record.createdAt as string).getTime(),
            now.getTime(),
            "createdAt must round-trip to the injected creation instant"
          );

          // Req 3.6 — no reseller association is attached for admin-created records.
          assert.strictEqual(
            record.resellerAccountId,
            undefined,
            "admin-created records must not carry a resellerAccountId"
          );
        }
      ),
      { numRuns: RUNS }
    );
  });
});
