// Feature: admin-reseller-portal, task 10.4 unit tests
//
// - GET /release returns the seeded Release_Metadata fields
// - GET /seo returns seeded pages; GET /seo/public serializes valid JSON
// - the signed manifest projection contains NO key material
//
// Requirements: 8.1, 8.5, 9.1, 9.5

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { FakeDynamoClient } from "../lib/dev/in-memory-dynamo.ts";
import { createAuditLog } from "../lib/audit.ts";
import {
  createReleaseStore,
  projectManifestInput,
  RELEASE_TABLE_NAME,
  RELEASE_PARTITION_KEY,
  type ReleaseMetadata,
} from "../lib/release.ts";
import { createSeoModule, SEO_TABLE_NAME, SEO_PARTITION_KEY } from "../lib/seo.ts";
import { createManifestSigner, type SsmParameterStore } from "../lib/signing.ts";

const BUCKET = "pdm-updates-452359090613-aps1";

function auditFor(dynamo: FakeDynamoClient) {
  let n = 0;
  return createAuditLog(dynamo, {
    tableName: "pdm-portal-audit",
    now: () => "2025-01-01T00:00:00.000Z",
    generateId: () => `audit-${n++}`,
  });
}

describe("GET /release returns current Release_Metadata (Req 8.1)", () => {
  it("reads back the seeded fields", async () => {
    const dynamo = new FakeDynamoClient();
    dynamo.registerKeySchema(RELEASE_TABLE_NAME, RELEASE_PARTITION_KEY);
    const seeded: ReleaseMetadata = {
      releaseId: "current",
      version: "2.3.4",
      msiUrl: `https://${BUCKET}.s3.amazonaws.com/msi/2.3.4.msi`,
      portableZipUrl: `https://${BUCKET}.s3.amazonaws.com/zip/2.3.4.zip`,
      msiSha256: "a".repeat(64),
      portableSha256: "b".repeat(64),
      releaseNotes: "notes",
      portableSizeBytes: 12345,
      channel: "Stable",
      updatedAt: "2025-06-15T12:00:00.000Z",
    };
    await dynamo.put({ TableName: RELEASE_TABLE_NAME, Item: { ...seeded } });

    const store = createReleaseStore({
      dynamo,
      signer: { async signManifest() { throw new Error("not used"); } },
      objectStore: { async putObject() {} },
      audit: auditFor(dynamo),
    });

    const current = await store.getCurrent();
    assert.deepStrictEqual(current, seeded);
  });

  it("returns null when nothing has been published", async () => {
    const dynamo = new FakeDynamoClient();
    dynamo.registerKeySchema(RELEASE_TABLE_NAME, RELEASE_PARTITION_KEY);
    const store = createReleaseStore({
      dynamo,
      signer: { async signManifest() { throw new Error("not used"); } },
      objectStore: { async putObject() {} },
      audit: auditFor(dynamo),
    });
    assert.strictEqual(await store.getCurrent(), null);
  });
});

describe("GET /seo and GET /seo/public (Req 9.1, 9.5)", () => {
  it("lists seeded pages and serializes to valid JSON with expected keys", async () => {
    const dynamo = new FakeDynamoClient();
    dynamo.registerKeySchema(SEO_TABLE_NAME, SEO_PARTITION_KEY);
    const seo = createSeoModule({ dynamo, audit: auditFor(dynamo), now: () => "2025-06-15T12:00:00.000Z" });

    await seo.updateSeoSettings(
      "home",
      { title: "Home Title", metaDescription: "x".repeat(60), ogTitle: "OG Home" },
      { actor: "a", actorRole: "admin", sourceIp: "1.2.3.4" }
    );
    await seo.updateSeoSettings(
      "pricing",
      { title: "Pricing", metaDescription: "y".repeat(80) },
      { actor: "a", actorRole: "admin", sourceIp: "1.2.3.4" }
    );

    const all = await seo.listSeoSettings();
    assert.strictEqual(all.length, 2);
    const byId = Object.fromEntries(all.map((p) => [p.pageId, p]));
    assert.strictEqual(byId.home.title, "Home Title");
    assert.strictEqual(byId.home.ogTitle, "OG Home");
    assert.strictEqual(byId.pricing.metaDescription, "y".repeat(80));

    // Public endpoint serialization: round-trips through JSON with expected keys.
    const json = JSON.stringify(all);
    const parsed = JSON.parse(json) as Array<Record<string, unknown>>;
    assert.strictEqual(parsed.length, 2);
    for (const page of parsed) {
      assert.ok("pageId" in page);
      assert.ok("title" in page);
      assert.ok("metaDescription" in page);
    }
  });
});

describe("Signed manifest projection contains no key material (Req 8.5)", () => {
  it("projects portable-zip fields and the signed manifest omits any private key", async () => {
    // Generate a throwaway EC P-256 key and expose it through a fake SSM.
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const fakeSsm: SsmParameterStore = {
      async getSecureParameter() {
        return pem;
      },
    };
    const signer = createManifestSigner({ ssm: fakeSsm });

    const metadata: ReleaseMetadata = {
      releaseId: "current",
      version: "9.9.9",
      msiUrl: `https://${BUCKET}.s3.amazonaws.com/msi/9.9.9.msi`,
      portableZipUrl: `https://${BUCKET}.s3.amazonaws.com/zip/9.9.9.zip`,
      msiSha256: "c".repeat(64),
      portableSha256: "d".repeat(64),
      releaseNotes: "release notes",
      portableSizeBytes: 555,
      channel: "Stable",
      updatedAt: "2025-06-15T12:00:00.000Z",
    };

    const input = projectManifestInput(metadata, metadata.updatedAt);
    // PackageUrl/PackageSha256/PackageSizeBytes map from the portable-zip fields.
    assert.strictEqual(input.packageUrl, metadata.portableZipUrl);
    assert.strictEqual(input.packageSha256, metadata.portableSha256);
    assert.strictEqual(input.packageSizeBytes, metadata.portableSizeBytes);

    const manifest = await signer.signManifest(input);

    // The signed manifest has exactly the expected client-facing fields.
    assert.deepStrictEqual(
      Object.keys(manifest).sort(),
      ["Channel", "PackageSha256", "PackageSizeBytes", "PackageUrl", "ReleaseNotes", "ReleasedUtc", "Signature", "Version"].sort()
    );
    // No key material anywhere in the serialized manifest.
    const serialized = JSON.stringify(manifest);
    assert.ok(!/PRIVATE KEY/i.test(serialized));
    assert.ok(!serialized.includes(pem));
    assert.ok(!/BEGIN EC/i.test(serialized));
    assert.strictEqual(typeof manifest.Signature, "string");
    assert.ok(manifest.Signature.length > 0);
  });
});
