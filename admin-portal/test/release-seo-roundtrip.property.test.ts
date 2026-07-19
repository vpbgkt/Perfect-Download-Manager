// Feature: admin-reseller-portal, Property 21: Metadata persistence round-trip (release and SEO)
//
// For any valid submission, persisting Release_Metadata (or a page's
// Seo_Settings) and then reading it back yields the same values that were
// written.
//
// Validates: Requirements 8.2, 9.2

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { FakeDynamoClient } from "../lib/dev/in-memory-dynamo.ts";
import { createAuditLog } from "../lib/audit.ts";
import {
  createReleaseStore,
  RELEASE_TABLE_NAME,
  RELEASE_PARTITION_KEY,
} from "../lib/release.ts";
import { createSeoModule, SEO_TABLE_NAME, SEO_PARTITION_KEY } from "../lib/seo.ts";
import type { ManifestSigner } from "../lib/signing.ts";

const RUNS = 100;
const BUCKET = "pdm-updates-452359090613-aps1";

/** A fake signer that never touches SSM and returns a deterministic signature. */
const fakeSigner: ManifestSigner = {
  async signManifest(input) {
    return {
      Version: input.version,
      Channel: input.channel,
      PackageUrl: input.packageUrl,
      PackageSizeBytes: input.packageSizeBytes,
      PackageSha256: input.packageSha256,
      ReleasedUtc: input.releasedUtc,
      ...(input.releaseNotes ? { ReleaseNotes: input.releaseNotes } : {}),
      Signature: "ZmFrZS1zaWduYXR1cmU=",
    };
  },
};

function releaseHarness() {
  const dynamo = new FakeDynamoClient();
  dynamo.registerKeySchema(RELEASE_TABLE_NAME, RELEASE_PARTITION_KEY);
  let idN = 0;
  const audit = createAuditLog(dynamo, {
    tableName: "pdm-portal-audit",
    now: () => "2025-01-01T00:00:00.000Z",
    generateId: () => `audit-${idN++}`,
  });
  const objects: { key: string; body: string }[] = [];
  const store = createReleaseStore({
    dynamo,
    signer: fakeSigner,
    objectStore: { async putObject(p) { objects.push({ key: p.key, body: p.body }); } },
    audit,
    now: () => "2025-06-15T12:00:00.000Z",
  });
  return { store, objects };
}

const hex64 = fc
  .array(fc.constantFrom(..."0123456789abcdef"), { minLength: 64, maxLength: 64 })
  .map((c) => c.join(""));

const validReleaseSubmission = fc.record({
  version: fc.string({ minLength: 1, maxLength: 12 }).map((s) => (s.trim() || "1.0.0")),
  msiUrl: fc.nat({ max: 9999 }).map((n) => `https://${BUCKET}.s3.ap-south-1.amazonaws.com/msi/${n}.msi`),
  portableZipUrl: fc.nat({ max: 9999 }).map((n) => `https://${BUCKET}.s3.amazonaws.com/zip/${n}.zip`),
  msiSha256: hex64,
  portableSha256: hex64,
  releaseNotes: fc.string({ maxLength: 40 }),
  portableSizeBytes: fc.integer({ min: 0, max: 10_000_000 }),
});

describe("Property 21: Metadata persistence round-trip — release", () => {
  it("publishes valid Release_Metadata and reads back identical values", async () => {
    await fc.assert(
      fc.asyncProperty(validReleaseSubmission, async (sub) => {
        const { store } = releaseHarness();
        const res = await store.publish(sub, { actor: "admin-1", actorRole: "admin", sourceIp: "1.2.3.4" });
        assert.strictEqual(res.ok, true, res.ok ? "" : JSON.stringify(res.error));
        if (!res.ok) return;

        const current = await store.getCurrent();
        assert.ok(current);
        if (!current) return;
        assert.strictEqual(current.version, sub.version.trim());
        assert.strictEqual(current.msiUrl, sub.msiUrl);
        assert.strictEqual(current.portableZipUrl, sub.portableZipUrl);
        assert.strictEqual(current.msiSha256, sub.msiSha256);
        assert.strictEqual(current.portableSha256, sub.portableSha256);
        assert.strictEqual(current.releaseNotes, sub.releaseNotes);
        assert.strictEqual(current.portableSizeBytes, sub.portableSizeBytes);
      }),
      { numRuns: RUNS }
    );
  });
});

function seoHarness() {
  const dynamo = new FakeDynamoClient();
  dynamo.registerKeySchema(SEO_TABLE_NAME, SEO_PARTITION_KEY);
  let idN = 0;
  const audit = createAuditLog(dynamo, {
    tableName: "pdm-portal-audit",
    now: () => "2025-01-01T00:00:00.000Z",
    generateId: () => `audit-${idN++}`,
  });
  const seo = createSeoModule({ dynamo, audit, now: () => "2025-06-15T12:00:00.000Z" });
  return { seo };
}

const validSeo = fc.record({
  pageId: fc.string({ minLength: 1, maxLength: 20 }).map((s) => (s.trim() || "home")),
  title: fc
    .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz "), { minLength: 1, maxLength: 70 })
    .map((c) => c.join("").trim() || "T"),
  metaDescription: fc
    .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz "), { minLength: 60, maxLength: 150 })
    .map((c) => {
      let s = c.join("");
      // guarantee trimmed length in [50,160]
      while (s.trim().length < 50) s += "x";
      return s.slice(0, 160);
    }),
  ogTitle: fc.string({ maxLength: 30 }),
});

describe("Property 21: Metadata persistence round-trip — SEO", () => {
  it("persists valid Seo_Settings and reads back identical values", async () => {
    await fc.assert(
      fc.asyncProperty(validSeo, async (page) => {
        fc.pre(page.title.trim().length >= 1 && page.title.trim().length <= 70);
        fc.pre(page.metaDescription.trim().length >= 50 && page.metaDescription.trim().length <= 160);
        const { seo } = seoHarness();
        const res = await seo.updateSeoSettings(
          page.pageId,
          {
            title: page.title,
            metaDescription: page.metaDescription,
            ogTitle: page.ogTitle,
          },
          { actor: "admin-1", actorRole: "admin", sourceIp: "1.2.3.4" }
        );
        assert.strictEqual(res.ok, true, res.ok ? "" : JSON.stringify(res.error));

        const read = await seo.getSeoSettings(page.pageId);
        assert.ok(read);
        if (!read) return;
        assert.strictEqual(read.title, page.title.trim());
        assert.strictEqual(read.metaDescription, page.metaDescription.trim());
        assert.strictEqual(read.ogTitle, page.ogTitle.trim());
      }),
      { numRuns: RUNS }
    );
  });
});
