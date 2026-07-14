// Feature: admin-reseller-portal, license mutation properties
//
// Property 11: License status validation and persistence   (Req 5.1, 5.2, 5.5)
// Property 12: Partial attribute update preserves untouched  (Req 6.1)
// Property 13: Activation cap cannot drop below activations   (Req 6.3)
// Property 14: Activation removal is precise                   (Req 7.3, 7.4)

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { FakeDynamoClient } from "../lib/dev/in-memory-dynamo.ts";
import { createAuditLog } from "../lib/audit.ts";
import {
  LICENSES_TABLE_NAME,
  LICENSE_PARTITION_KEY,
} from "../lib/licenses/create.ts";
import { createStatusUpdater } from "../lib/licenses/status.ts";
import { createAttributeUpdater } from "../lib/licenses/attributes.ts";
import { createActivationManager } from "../lib/licenses/activations.ts";
import type { Principal } from "../lib/auth.ts";

const RUNS = 100;

const admin: Principal = {
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
    status: createStatusUpdater({ dynamo, audit, now }),
    attrs: createAttributeUpdater({ dynamo, audit, now }),
    activations: createActivationManager({
      dynamo,
      audit,
      authorizer: { assertOwnership: () => ({ ok: true, value: undefined }) },
      now: () => "2025-06-15T12:00:00.000Z",
    }),
  };
}

interface SeedOpts {
  status?: string;
  plan?: string;
  owner?: string;
  features?: string[];
  maxActivations?: number;
  expiresAt?: string;
  activations?: Record<string, { activatedAt?: string; lastSeenAt?: string }>;
}

function seedLicense(dynamo: FakeDynamoClient, key: string, opts: SeedOpts = {}) {
  const item = {
    [LICENSE_PARTITION_KEY]: key,
    status: opts.status ?? "active",
    plan: opts.plan ?? "standard",
    owner: opts.owner ?? "acme",
    features: opts.features ?? ["f1"],
    maxActivations: opts.maxActivations ?? 5,
    ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}),
    activations: opts.activations ?? {},
    createdAt: "2025-01-01T00:00:00.000Z",
  };
  void dynamo.put({ TableName: LICENSES_TABLE_NAME, Item: { ...item } });
  return item;
}

const KEY = "PDM-AAAA-BBBB-CCCC-DDDD";

describe("Property 11: License status validation and persistence", () => {
  it("persists exactly the requested valid status", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom("active", "revoked", "suspended"), async (status) => {
        const h = harness();
        seedLicense(h.dynamo, KEY, { status: "active" });
        const res = await h.status.update({ licenseKey: KEY, status, principal: admin, sourceIp: "1.2.3.4" });
        assert.strictEqual(res.ok, true);
        if (res.ok) assert.strictEqual(res.value.status, status);
        const stored = await h.dynamo.get({ TableName: LICENSES_TABLE_NAME, Key: { [LICENSE_PARTITION_KEY]: KEY } });
        assert.strictEqual(stored?.status, status);
      }),
      { numRuns: RUNS }
    );
  });

  it("rejects any non-enum status and leaves status unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string().filter((s) => !["active", "revoked", "suspended"].includes(s.trim())),
        async (badStatus) => {
          const h = harness();
          seedLicense(h.dynamo, KEY, { status: "active" });
          const res = await h.status.update({ licenseKey: KEY, status: badStatus, principal: admin, sourceIp: "1.2.3.4" });
          assert.strictEqual(res.ok, false);
          if (!res.ok) assert.strictEqual(res.error.code, "validation_error");
          const stored = await h.dynamo.get({ TableName: LICENSES_TABLE_NAME, Key: { [LICENSE_PARTITION_KEY]: KEY } });
          assert.strictEqual(stored?.status, "active");
        }
      ),
      { numRuns: RUNS }
    );
  });
});

describe("Property 12: Partial attribute update preserves untouched attributes", () => {
  it("updates only submitted attributes; every other attribute is unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          plan: fc.option(fc.constantFrom("pro", "enterprise"), { nil: undefined }),
          owner: fc.option(fc.string({ maxLength: 12 }), { nil: undefined }),
          features: fc.option(fc.array(fc.string({ maxLength: 6 }), { maxLength: 4 }), { nil: undefined }),
        }),
        async (submitted) => {
          const h = harness();
          const original = seedLicense(h.dynamo, KEY, {
            plan: "standard",
            owner: "acme",
            features: ["f1", "f2"],
            maxActivations: 5,
            expiresAt: "2030-01-01T00:00:00.000Z",
          });

          // Build the exact submitted set (only defined keys).
          const attributes: Record<string, unknown> = {};
          if (submitted.plan !== undefined) attributes.plan = submitted.plan;
          if (submitted.owner !== undefined) attributes.owner = submitted.owner;
          if (submitted.features !== undefined) attributes.features = submitted.features;

          const res = await h.attrs.update({ licenseKey: KEY, attributes, principal: admin, sourceIp: "1.2.3.4" });
          assert.strictEqual(res.ok, true);

          const stored = await h.dynamo.get({ TableName: LICENSES_TABLE_NAME, Key: { [LICENSE_PARTITION_KEY]: KEY } });
          assert.ok(stored);
          if (!stored) return;

          // Submitted attributes reflect the new values; untouched attributes equal the original.
          assert.strictEqual(stored.plan, submitted.plan !== undefined ? submitted.plan : original.plan);
          assert.strictEqual(stored.owner, submitted.owner !== undefined ? submitted.owner : original.owner);
          assert.deepStrictEqual(stored.features, submitted.features !== undefined ? submitted.features : original.features);

          // Always-untouched attributes never change.
          assert.strictEqual(stored.maxActivations, original.maxActivations);
          assert.strictEqual(stored.expiresAt, original.expiresAt);
          assert.strictEqual(stored.status, original.status);
          assert.strictEqual(stored.createdAt, original.createdAt);
        }
      ),
      { numRuns: RUNS }
    );
  });
});

describe("Property 13: Activation cap cannot drop below current activations", () => {
  it("rejects maxActivations below the current activation count, leaving the record unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 8 }), // number of current activations
        fc.integer({ min: 0, max: 12 }), // requested new cap
        async (count, requested) => {
          const h = harness();
          const activations: Record<string, { activatedAt: string }> = {};
          for (let i = 0; i < count; i++) {
            activations[`fp${i.toString().padStart(4, "0")}${"0".repeat(56)}`.slice(0, 64)] = {
              activatedAt: "2025-01-02T00:00:00.000Z",
            };
          }
          const original = seedLicense(h.dynamo, KEY, { maxActivations: 10, activations });

          const res = await h.attrs.update({
            licenseKey: KEY,
            attributes: { maxActivations: requested },
            principal: admin,
            sourceIp: "1.2.3.4",
          });

          const stored = await h.dynamo.get({ TableName: LICENSES_TABLE_NAME, Key: { [LICENSE_PARTITION_KEY]: KEY } });
          const currentCount = Object.keys(activations).length;

          if (requested < 1) {
            // Below the absolute floor (Req 6.2).
            assert.strictEqual(res.ok, false);
            assert.strictEqual(stored?.maxActivations, original.maxActivations);
          } else if (requested < currentCount) {
            // Below the current activation count (Req 6.3): rejected, unchanged.
            assert.strictEqual(res.ok, false);
            if (!res.ok) {
              assert.strictEqual(res.error.code, "validation_error");
              assert.match(res.error.message, new RegExp(String(currentCount)));
            }
            assert.strictEqual(stored?.maxActivations, original.maxActivations);
          } else {
            // At or above the count: accepted and persisted.
            assert.strictEqual(res.ok, true);
            assert.strictEqual(stored?.maxActivations, requested);
          }
        }
      ),
      { numRuns: RUNS }
    );
  });
});

describe("Property 14: Activation removal is precise", () => {
  it("removes exactly the targeted fingerprint and leaves all others intact", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .uniqueArray(
            fc.string({ minLength: 8, maxLength: 12, unit: fc.constantFrom(..."0123456789abcdef") }),
            { minLength: 1, maxLength: 8 }
          ),
        fc.nat(),
        async (fps, pick) => {
          const h = harness();
          const activations: Record<string, { activatedAt: string; lastSeenAt: string }> = {};
          for (const fp of fps) {
            activations[fp] = { activatedAt: "2025-01-02T00:00:00.000Z", lastSeenAt: "2025-02-02T00:00:00.000Z" };
          }
          seedLicense(h.dynamo, KEY, { maxActivations: 100, activations });
          const target = fps[pick % fps.length];

          const res = await h.activations.removeActivation({
            principal: admin,
            licenseKey: KEY,
            fingerprint: target,
            sourceIp: "1.2.3.4",
          });
          assert.strictEqual(res.ok, true);

          const stored = await h.dynamo.get({ TableName: LICENSES_TABLE_NAME, Key: { [LICENSE_PARTITION_KEY]: KEY } });
          const remaining = stored?.activations as Record<string, unknown>;
          assert.ok(!(target in remaining), "target fingerprint should be gone");
          for (const fp of fps) {
            if (fp === target) continue;
            assert.ok(fp in remaining, `untargeted fingerprint ${fp} should remain`);
          }
          assert.strictEqual(Object.keys(remaining).length, fps.length - 1);
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("returns not-found for an absent fingerprint and leaves the map unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(
          fc.string({ minLength: 8, maxLength: 12, unit: fc.constantFrom(..."0123456789abcdef") }),
          { minLength: 0, maxLength: 6 }
        ),
        fc.string({ minLength: 1, maxLength: 12 }),
        async (fps, absent) => {
          fc.pre(!fps.includes(absent));
          const h = harness();
          const activations: Record<string, { activatedAt: string }> = {};
          for (const fp of fps) activations[fp] = { activatedAt: "2025-01-02T00:00:00.000Z" };
          seedLicense(h.dynamo, KEY, { maxActivations: 100, activations });

          const res = await h.activations.removeActivation({
            principal: admin,
            licenseKey: KEY,
            fingerprint: absent,
            sourceIp: "1.2.3.4",
          });
          assert.strictEqual(res.ok, false);
          if (!res.ok) assert.strictEqual(res.error.code, "not_found");

          const stored = await h.dynamo.get({ TableName: LICENSES_TABLE_NAME, Key: { [LICENSE_PARTITION_KEY]: KEY } });
          assert.deepStrictEqual(Object.keys(stored?.activations as object).sort(), [...fps].sort());
        }
      ),
      { numRuns: RUNS }
    );
  });
});
