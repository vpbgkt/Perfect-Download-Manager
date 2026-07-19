// Feature: admin-reseller-portal, task 14.3 external-boundary integration tests
//
// - Firebase ID-token verification accepts genuine / rejects forged tokens and
//   resolves the expected role (via the injected verifier boundary).
// - A portal status change is read back through the same `pdm-licenses` item.
// - The SSM signing round-trip does not persist/return the key, and the produced
//   signature verifies against the corresponding public key.
// - The signed `manifest.json` is published to the (fake) S3 release bucket.
// - Portal operational data is read back from its own DynamoDB tables.
//
// Requirements: 1.2, 2.1, 5.4, 8.2, 8.5, 14.1, 14.5, 15.1, 15.2

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import { FakeDynamoClient } from "../lib/dev/in-memory-dynamo.ts";
import { createAuditLog } from "../lib/audit.ts";
import {
  createAuthenticator,
  FakeTokenVerifier,
  type AdminRecord,
} from "../lib/auth.ts";
import { FakeEmailSender } from "../lib/email.ts";
import { createLicenseCreator, LICENSES_TABLE_NAME, LICENSE_PARTITION_KEY } from "../lib/licenses/create.ts";
import { createStatusUpdater } from "../lib/licenses/status.ts";
import {
  createManifestSigner,
  buildManifest,
  manifestSigningPayload,
  type SsmParameterStore,
} from "../lib/signing.ts";
import {
  createReleaseStore,
  manifestObjectKey,
  RELEASE_TABLE_NAME,
  RELEASE_PARTITION_KEY,
} from "../lib/release.ts";
import { createAccountManager, RESELLERS_TABLE_NAME, RESELLER_PARTITION_KEY } from "../lib/accounts.ts";

const ADMINS_TABLE = "pdm-portal-admins";
const BUCKET = "pdm-updates-452359090613-aps1";

function auditFor(dynamo: FakeDynamoClient) {
  let n = 0;
  return createAuditLog(dynamo, { now: () => "2025-06-15T12:00:00.000Z", generateId: () => `audit-${n++}` });
}

describe("Firebase ID-token verification boundary (Req 1.2, 2.1)", () => {
  it("accepts a genuine token, resolves the role, and rejects a forged one", async () => {
    const dynamo = new FakeDynamoClient();
    dynamo.registerKeySchema(ADMINS_TABLE, "firebaseUid");
    const verifier = new FakeTokenVerifier();
    verifier.setToken("genuine", { uid: "uid-super" });

    const now = "2025-06-15T12:00:00.000Z";
    const admin: AdminRecord = {
      firebaseUid: "uid-super",
      email: "s@e.com",
      role: "super_admin",
      mfaEnrolled: true,
      lastSeenAt: now,
    };
    void dynamo.put({ TableName: ADMINS_TABLE, Item: admin as unknown as Record<string, unknown> });

    const auth = createAuthenticator({
      dynamo,
      tokenVerifier: verifier,
      emailSender: new FakeEmailSender(),
      now: () => new Date(now),
    });

    const genuine = await auth.authenticate({ idToken: "genuine" });
    assert.strictEqual(genuine.ok, true);
    if (genuine.ok) assert.strictEqual(genuine.value.role, "super_admin");

    const forged = await auth.authenticate({ idToken: "forged" });
    assert.strictEqual(forged.ok, false);
  });
});

describe("Status change read-back through the same pdm-licenses item (Req 5.4, 14.1)", () => {
  it("persists the new status on the item the licensing backend reads", async () => {
    const dynamo = new FakeDynamoClient();
    dynamo.registerKeySchema(LICENSES_TABLE_NAME, LICENSE_PARTITION_KEY);
    const audit = auditFor(dynamo);
    const now = () => new Date("2025-06-15T12:00:00.000Z");

    const creator = createLicenseCreator({ dynamo, audit, now });
    const created = await creator.create(
      { maxActivations: 3 },
      { actor: "admin-1", actorRole: "admin", sourceIp: "1.2.3.4" }
    );
    assert.strictEqual(created.ok, true);
    if (!created.ok) return;
    const key = created.value.licenseKey;

    const status = createStatusUpdater({ dynamo, audit, now });
    const changed = await status.update({
      licenseKey: key,
      status: "revoked",
      principal: { identity: "admin-1", role: "admin", resellerAccountId: null, mfaEnrolled: true, authMethod: "firebase" },
      sourceIp: "1.2.3.4",
    });
    assert.strictEqual(changed.ok, true);

    // Read back through the raw item (what activate/validate Lambdas read).
    const raw = await dynamo.get({ TableName: LICENSES_TABLE_NAME, Key: { [LICENSE_PARTITION_KEY]: key } });
    assert.strictEqual(raw?.status, "revoked");
  });
});

describe("SSM signing round-trip (Req 8.5, 15.1, 15.2)", () => {
  it("signs with the SSM key, never returns it, and the signature verifies", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

    let reads = 0;
    const ssm: SsmParameterStore = {
      async getSecureParameter() {
        reads++;
        return pem;
      },
    };
    const signer = createManifestSigner({ ssm });

    const input = {
      version: "1.2.3",
      channel: "Stable",
      packageUrl: `https://${BUCKET}.s3.amazonaws.com/zip/1.2.3.zip`,
      packageSizeBytes: 1024,
      packageSha256: "e".repeat(64),
      releasedUtc: "2025-06-15T12:00:00.000Z",
      releaseNotes: "notes",
    };
    const manifest = await signer.signManifest(input);

    // The key was fetched at use-time and never appears in the output.
    assert.strictEqual(reads, 1);
    assert.ok(!JSON.stringify(manifest).includes(pem));
    assert.ok(!/PRIVATE KEY/i.test(JSON.stringify(manifest)));

    // The signature verifies over the canonical unsigned-manifest payload.
    const { Signature, ...unsigned } = manifest;
    const payload = manifestSigningPayload(buildManifest(input));
    assert.strictEqual(JSON.stringify(unsigned), payload);
    const verified = cryptoVerify(
      "sha256",
      Buffer.from(payload, "utf8"),
      { key: publicKey, dsaEncoding: "der" },
      Buffer.from(Signature, "base64")
    );
    assert.strictEqual(verified, true);
  });
});

describe("Signed manifest published to the S3 release bucket (Req 8.2)", () => {
  it("writes manifest.json (with a Signature, no key material) to the object store", async () => {
    const dynamo = new FakeDynamoClient();
    dynamo.registerKeySchema(RELEASE_TABLE_NAME, RELEASE_PARTITION_KEY);
    const published: { key: string; body: string; contentType: string }[] = [];

    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const signer = createManifestSigner({ ssm: { async getSecureParameter() { return pem; } } });

    const store = createReleaseStore({
      dynamo,
      signer,
      objectStore: { async putObject(p) { published.push(p); } },
      audit: auditFor(dynamo),
      now: () => "2025-06-15T12:00:00.000Z",
    });

    const res = await store.publish(
      {
        version: "3.0.0",
        msiUrl: `https://${BUCKET}.s3.amazonaws.com/msi/3.msi`,
        portableZipUrl: `https://${BUCKET}.s3.amazonaws.com/zip/3.zip`,
        msiSha256: "1".repeat(64),
        portableSha256: "2".repeat(64),
        channel: "Stable",
        portableSizeBytes: 2048,
      },
      { actor: "admin-1", actorRole: "admin", sourceIp: "1.2.3.4" }
    );
    assert.strictEqual(res.ok, true);

    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0].key, manifestObjectKey("Stable"));
    assert.strictEqual(published[0].contentType, "application/json");
    const parsed = JSON.parse(published[0].body);
    assert.strictEqual(typeof parsed.Signature, "string");
    assert.strictEqual(parsed.Version, "3.0.0");
    assert.ok(!JSON.stringify(parsed).includes(pem));
    assert.ok(!/PRIVATE KEY/i.test(published[0].body));
  });
});

describe("Portal operational data read back from its own tables (Req 14.5)", () => {
  it("writes a Reseller_Account to pdm-portal-resellers and reads it back", async () => {
    const dynamo = new FakeDynamoClient();
    dynamo.registerKeySchema(RESELLERS_TABLE_NAME, RESELLER_PARTITION_KEY);
    let idN = 0;
    const accounts = createAccountManager({
      dynamo,
      audit: auditFor(dynamo),
      now: () => new Date("2025-06-15T12:00:00.000Z"),
      generateId: () => `res-${idN++}`,
    });

    const created = await accounts.createReseller(
      { orgName: "Distributor", contactEmail: "ops@dist.com" },
      { actor: "super-1", actorRole: "super_admin", sourceIp: "1.2.3.4" }
    );
    assert.strictEqual(created.ok, true);
    if (!created.ok) return;

    // The operational data lives in the portal's own table, separate from pdm-licenses.
    const raw = await dynamo.get({
      TableName: RESELLERS_TABLE_NAME,
      Key: { [RESELLER_PARTITION_KEY]: created.value.resellerAccountId },
    });
    assert.ok(raw);
    assert.strictEqual(raw?.orgName, "Distributor");
    assert.strictEqual(raw?.state, "active");
    assert.notStrictEqual(RESELLERS_TABLE_NAME, LICENSES_TABLE_NAME);
  });
});
