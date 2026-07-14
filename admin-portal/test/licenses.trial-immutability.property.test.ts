// Feature: admin-reseller-portal, Property 32: Trial anchors are never modified
//
// The portal never writes, overwrites, or mutates trial-anchor items whose
// `licenseKey` begins with `TRIAL#`:
//  - create only ever writes `PDM-…` keys (never a TRIAL# item);
//  - status change, attribute update, and activation removal all report a
//    TRIAL# target as not-found and leave the item untouched.
//
// Validates: Requirements 14.4

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { FakeDynamoClient } from "../lib/dev/in-memory-dynamo.ts";
import { createAuditLog } from "../lib/audit.ts";
import {
  createLicenseCreator,
  LICENSES_TABLE_NAME,
  LICENSE_PARTITION_KEY,
  TRIAL_ANCHOR_PREFIX,
} from "../lib/licenses/create.ts";
import { createStatusUpdater } from "../lib/licenses/status.ts";
import { createAttributeUpdater } from "../lib/licenses/attributes.ts";
import { createActivationManager } from "../lib/licenses/activations.ts";
import type { Principal } from "../lib/auth.ts";

const RUNS = 100;

const adminPrincipal: Principal = {
  identity: "admin-1",
  role: "admin",
  resellerAccountId: null,
  mfaEnrolled: true,
  authMethod: "firebase",
};

function harness() {
  const dynamo = new FakeDynamoClient();
  dynamo.registerKeySchema(LICENSES_TABLE_NAME, LICENSE_PARTITION_KEY);
  let idN = 0;
  const audit = createAuditLog(dynamo, {
    tableName: "pdm-portal-audit",
    now: () => "2025-01-01T00:00:00.000Z",
    generateId: () => `audit-${idN++}`,
  });
  const now = () => new Date("2025-06-15T12:00:00.000Z");
  return {
    dynamo,
    audit,
    creator: createLicenseCreator({ dynamo, audit, now }),
    status: createStatusUpdater({ dynamo, audit, now }),
    attrs: createAttributeUpdater({ dynamo, audit, now }),
    activations: createActivationManager({
      dynamo,
      audit,
      authorizer: {
        assertOwnership: () => ({ ok: true, value: undefined }),
      },
      now: () => "2025-06-15T12:00:00.000Z",
    }),
  };
}

/** Seed a raw TRIAL# anchor item as the licensing backend would store it. */
function seedTrialAnchor(dynamo: FakeDynamoClient, key: string) {
  const anchor = {
    [LICENSE_PARTITION_KEY]: key,
    trialStartedAt: "2024-01-01T00:00:00.000Z",
    fingerprint: "abc123",
  };
  void dynamo.put({ TableName: LICENSES_TABLE_NAME, Item: { ...anchor } });
  return anchor;
}

const trialKeyArb = fc
  .string({ minLength: 1, maxLength: 16, unit: fc.constantFrom(..."0123456789abcdef") })
  .map((s) => `${TRIAL_ANCHOR_PREFIX}${s}`);

describe("Property 32: Trial anchors are never modified", () => {
  it("create never emits a TRIAL# key across many mints", async () => {
    const { dynamo, creator } = harness();
    for (let i = 0; i < RUNS; i++) {
      const res = await creator.create(
        { maxActivations: 2, resellerAccountId: null },
        { actor: "admin-1", actorRole: "admin", sourceIp: "10.0.0.1" }
      );
      assert.strictEqual(res.ok, true);
      if (res.ok) {
        assert.ok(!res.value.licenseKey.startsWith(TRIAL_ANCHOR_PREFIX));
      }
    }
    for (const item of dynamo.dump(LICENSES_TABLE_NAME)) {
      assert.ok(!String(item[LICENSE_PARTITION_KEY]).startsWith(TRIAL_ANCHOR_PREFIX));
    }
  });

  it("status/attribute/activation operations leave a seeded TRIAL# anchor untouched", async () => {
    await fc.assert(
      fc.asyncProperty(trialKeyArb, async (trialKey) => {
        const h = harness();
        const anchor = seedTrialAnchor(h.dynamo, trialKey);
        const before = h.dynamo.dump(LICENSES_TABLE_NAME);

        const s = await h.status.update({
          licenseKey: trialKey,
          status: "revoked",
          principal: adminPrincipal,
          sourceIp: "10.0.0.1",
        });
        assert.strictEqual(s.ok, false);
        if (!s.ok) assert.strictEqual(s.error.code, "not_found");

        const a = await h.attrs.update({
          licenseKey: trialKey,
          attributes: { plan: "premium" },
          principal: adminPrincipal,
          sourceIp: "10.0.0.1",
        });
        assert.strictEqual(a.ok, false);
        if (!a.ok) assert.strictEqual(a.error.code, "not_found");

        const r = await h.activations.removeActivation({
          principal: adminPrincipal,
          licenseKey: trialKey,
          fingerprint: "abc123",
          sourceIp: "10.0.0.1",
        });
        assert.strictEqual(r.ok, false);
        if (!r.ok) assert.strictEqual(r.error.code, "not_found");

        // The anchor is byte-for-byte unchanged and remains the only item.
        const after = h.dynamo.dump(LICENSES_TABLE_NAME);
        assert.deepStrictEqual(after, before);
        assert.deepStrictEqual(
          after.find((i) => i[LICENSE_PARTITION_KEY] === trialKey),
          anchor
        );
      }),
      { numRuns: RUNS }
    );
  });
});
