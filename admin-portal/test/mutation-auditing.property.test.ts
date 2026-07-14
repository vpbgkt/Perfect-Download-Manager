// Feature: admin-reseller-portal, Property 27: Every successful mutation is fully audited
//
// For any successful mutating Portal_Backend operation, exactly one append-only
// Audit_Entry is written, carrying the actor identity, actor role, action,
// target identifier, source IP, and an ISO 8601 UTC timestamp — and never any
// secret value.
//
// Validates: Requirements 3.7, 5.3, 6.6, 7.5, 8.6, 9.6, 10.5, 11.6, 13.1, 13.2

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { FakeDynamoClient } from "../lib/dev/in-memory-dynamo.ts";
import { createAuditLog, AUDIT_TABLE_NAME, isSecretKey } from "../lib/audit.ts";
import {
  createLicenseCreator,
  LICENSES_TABLE_NAME,
  LICENSE_PARTITION_KEY,
} from "../lib/licenses/create.ts";
import { createStatusUpdater } from "../lib/licenses/status.ts";
import { createAttributeUpdater } from "../lib/licenses/attributes.ts";
import { createActivationManager } from "../lib/licenses/activations.ts";
import { createAccountManager, RESELLERS_TABLE_NAME, RESELLER_PARTITION_KEY } from "../lib/accounts.ts";
import { createApiKeyManager, APIKEYS_TABLE_NAME, APIKEY_PARTITION_KEY } from "../lib/apikeys.ts";
import { createSeoModule, SEO_TABLE_NAME, SEO_PARTITION_KEY } from "../lib/seo.ts";
import { createReleaseStore, RELEASE_TABLE_NAME, RELEASE_PARTITION_KEY } from "../lib/release.ts";
import type { ManifestSigner } from "../lib/signing.ts";
import type { Principal } from "../lib/auth.ts";

const RUNS = 100;
const BUCKET = "pdm-updates-452359090613-aps1";

const admin: Principal = {
  identity: "admin-1",
  role: "admin",
  resellerAccountId: null,
  mfaEnrolled: true,
  authMethod: "firebase",
};
const superActor = { actor: "super-1", actorRole: "super_admin", sourceIp: "1.2.3.4" };
const adminActor = { actor: "admin-1", actorRole: "admin", sourceIp: "1.2.3.4" };

const fakeSigner: ManifestSigner = {
  async signManifest(input) {
    return {
      Version: input.version,
      Channel: input.channel,
      PackageUrl: input.packageUrl,
      PackageSizeBytes: input.packageSizeBytes,
      PackageSha256: input.packageSha256,
      ReleasedUtc: input.releasedUtc,
      Signature: "c2ln",
    };
  },
};

function harness() {
  const dynamo = new FakeDynamoClient();
  dynamo.registerKeySchema(LICENSES_TABLE_NAME, LICENSE_PARTITION_KEY);
  dynamo.registerKeySchema(RESELLERS_TABLE_NAME, RESELLER_PARTITION_KEY);
  dynamo.registerKeySchema(APIKEYS_TABLE_NAME, APIKEY_PARTITION_KEY);
  dynamo.registerKeySchema(SEO_TABLE_NAME, SEO_PARTITION_KEY);
  dynamo.registerKeySchema(RELEASE_TABLE_NAME, RELEASE_PARTITION_KEY);

  let auditN = 0;
  const audit = createAuditLog(dynamo, {
    now: () => "2025-06-15T12:00:00.000Z",
    generateId: () => `audit-${auditN++}`,
  });
  const now = () => new Date("2025-06-15T12:00:00.000Z");
  let idN = 0;
  return {
    dynamo,
    audit,
    creator: createLicenseCreator({ dynamo, audit, now }),
    status: createStatusUpdater({ dynamo, audit, now }),
    attrs: createAttributeUpdater({ dynamo, audit, now }),
    activations: createActivationManager({
      dynamo,
      audit,
      authorizer: { assertOwnership: () => ({ ok: true, value: undefined }) },
      now: () => "2025-06-15T12:00:00.000Z",
    }),
    accounts: createAccountManager({ dynamo, audit, now, generateId: () => `res-${idN++}` }),
    apikeys: createApiKeyManager({ dynamo, audit, now, generateApiKeyId: () => `key-${idN++}` }),
    seo: createSeoModule({ dynamo, audit, now: () => "2025-06-15T12:00:00.000Z" }),
    release: createReleaseStore({
      dynamo,
      signer: fakeSigner,
      objectStore: { async putObject() {} },
      audit,
      now: () => "2025-06-15T12:00:00.000Z",
    }),
  };
}

function seedLicense(dynamo: FakeDynamoClient, key: string) {
  void dynamo.put({
    TableName: LICENSES_TABLE_NAME,
    Item: {
      [LICENSE_PARTITION_KEY]: key,
      status: "active",
      plan: "standard",
      owner: "acme",
      features: ["f1"],
      maxActivations: 5,
      activations: { ["a".repeat(64)]: { activatedAt: "2025-01-01T00:00:00.000Z" } },
      createdAt: "2025-01-01T00:00:00.000Z",
    },
  });
}

const KEY = "PDM-AAAA-BBBB-CCCC-DDDD";

const REQUIRED_AUDIT_FIELDS = ["actor", "actorRole", "action", "target", "sourceIp", "timestamp"] as const;

/** Assert a single audit entry was appended and is well-formed with no secrets. */
function assertOneWellFormedEntry(dynamo: FakeDynamoClient, before: number): void {
  const entries = dynamo.dump(AUDIT_TABLE_NAME);
  assert.strictEqual(entries.length, before + 1, "exactly one audit entry should be appended");
  const entry = entries[entries.length - 1];
  for (const f of REQUIRED_AUDIT_FIELDS) {
    assert.ok(entry[f] !== undefined && entry[f] !== null && entry[f] !== "", `audit entry missing ${f}`);
  }
  // ISO 8601 UTC timestamp.
  assert.match(String(entry.timestamp), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  // No secret-bearing keys anywhere in the persisted entry.
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return void v.forEach(walk);
    if (v && typeof v === "object") {
      for (const [k, val] of Object.entries(v)) {
        assert.ok(!isSecretKey(k), `secret-bearing key "${k}" leaked into an audit entry`);
        walk(val);
      }
    }
  };
  walk(entry);
}

describe("Property 27: Every successful mutation is fully audited", () => {
  it("each successful mutation appends exactly one well-formed, secret-free audit entry", async () => {
    const mutation = fc.constantFrom(
      "create",
      "status",
      "attributes",
      "activation",
      "reseller-create",
      "reseller-suspend",
      "apikey-issue",
      "apikey-revoke",
      "seo",
      "release"
    );

    await fc.assert(
      fc.asyncProperty(mutation, async (kind) => {
        const h = harness();

        // Perform exactly one successful mutation of the chosen kind, seeding
        // any prerequisite state WITHOUT going through an audited path.
        const before = h.dynamo.itemCount(AUDIT_TABLE_NAME);

        switch (kind) {
          case "create": {
            const r = await h.creator.create({ maxActivations: 3, resellerAccountId: null }, adminActor);
            assert.strictEqual(r.ok, true);
            break;
          }
          case "status": {
            seedLicense(h.dynamo, KEY);
            const r = await h.status.update({ licenseKey: KEY, status: "revoked", principal: admin, sourceIp: "1.2.3.4" });
            assert.strictEqual(r.ok, true);
            break;
          }
          case "attributes": {
            seedLicense(h.dynamo, KEY);
            const r = await h.attrs.update({ licenseKey: KEY, attributes: { plan: "pro" }, principal: admin, sourceIp: "1.2.3.4" });
            assert.strictEqual(r.ok, true);
            break;
          }
          case "activation": {
            seedLicense(h.dynamo, KEY);
            const r = await h.activations.removeActivation({ principal: admin, licenseKey: KEY, fingerprint: "a".repeat(64), sourceIp: "1.2.3.4" });
            assert.strictEqual(r.ok, true);
            break;
          }
          case "reseller-create": {
            const r = await h.accounts.createReseller({ orgName: "Org", contactEmail: "o@e.com" }, superActor);
            assert.strictEqual(r.ok, true);
            break;
          }
          case "reseller-suspend": {
            const created = await h.accounts.createReseller({ orgName: "Org", contactEmail: "o@e.com" }, superActor);
            assert.strictEqual(created.ok, true);
            if (!created.ok) return;
            const beforeSuspend = h.dynamo.itemCount(AUDIT_TABLE_NAME);
            const r = await h.accounts.suspend({ resellerAccountId: created.value.resellerAccountId }, superActor);
            assert.strictEqual(r.ok, true);
            assertOneWellFormedEntry(h.dynamo, beforeSuspend);
            return;
          }
          case "apikey-issue": {
            const r = await h.apikeys.issueApiKey({ resellerAccountId: "r1" }, superActor);
            assert.strictEqual(r.ok, true);
            break;
          }
          case "apikey-revoke": {
            const issued = await h.apikeys.issueApiKey({ resellerAccountId: "r1" }, superActor);
            assert.strictEqual(issued.ok, true);
            if (!issued.ok) return;
            const beforeRevoke = h.dynamo.itemCount(AUDIT_TABLE_NAME);
            const r = await h.apikeys.revokeApiKey({ apiKeyId: issued.value.record.apiKeyId }, superActor);
            assert.strictEqual(r.ok, true);
            assertOneWellFormedEntry(h.dynamo, beforeRevoke);
            return;
          }
          case "seo": {
            const r = await h.seo.updateSeoSettings(
              "home",
              { title: "Title", metaDescription: "x".repeat(60) },
              adminActor
            );
            assert.strictEqual(r.ok, true);
            break;
          }
          case "release": {
            const r = await h.release.publish(
              {
                version: "1.0.0",
                msiUrl: `https://${BUCKET}.s3.amazonaws.com/msi/1.msi`,
                portableZipUrl: `https://${BUCKET}.s3.amazonaws.com/zip/1.zip`,
                msiSha256: "a".repeat(64),
                portableSha256: "b".repeat(64),
              },
              adminActor
            );
            assert.strictEqual(r.ok, true);
            break;
          }
        }

        assertOneWellFormedEntry(h.dynamo, before);
      }),
      { numRuns: RUNS }
    );
  });
});
