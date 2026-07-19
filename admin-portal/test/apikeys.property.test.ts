// Feature: admin-reseller-portal, Property 26: API key secret is one-time and non-reversible
//
// An issued Api_Key returns its plaintext secret exactly once at creation; only
// a non-reversible SHA-256 hash is persisted (the plaintext is never stored),
// and a revoked key is rejected by the auth path.
//
// Validates: Requirements 11.1, 11.2, 11.3

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { createHash } from "node:crypto";
import { FakeDynamoClient } from "../lib/dev/in-memory-dynamo.ts";
import { createAuditLog } from "../lib/audit.ts";
import {
  createApiKeyManager,
  APIKEYS_TABLE_NAME,
  APIKEY_PARTITION_KEY,
  API_KEY_PREFIX,
} from "../lib/apikeys.ts";
import {
  createAuthenticator,
  sha256Hasher,
  FakeTokenVerifier,
} from "../lib/auth.ts";
import { FakeEmailSender } from "../lib/email.ts";

const RUNS = 100;
const RESELLERS_TABLE = "pdm-portal-resellers";

function harness() {
  const dynamo = new FakeDynamoClient();
  dynamo.registerKeySchema(APIKEYS_TABLE_NAME, APIKEY_PARTITION_KEY);
  dynamo.registerKeySchema(RESELLERS_TABLE, "resellerAccountId");
  let auditN = 0;
  const audit = createAuditLog(dynamo, {
    tableName: "pdm-portal-audit",
    now: () => "2025-01-01T00:00:00.000Z",
    generateId: () => `audit-${auditN++}`,
  });
  let idN = 0;
  const manager = createApiKeyManager({
    dynamo,
    audit,
    now: () => new Date("2025-06-15T12:00:00.000Z"),
    generateApiKeyId: () => `key-${idN++}`,
  });
  const auth = createAuthenticator({
    dynamo,
    tokenVerifier: new FakeTokenVerifier(),
    emailSender: new FakeEmailSender(),
    tables: { apiKeySecretHashIndex: "secretHash-index" },
  });
  return { dynamo, manager, auth };
}

const actor = { actor: "super-1", actorRole: "super_admin", sourceIp: "1.2.3.4" };

describe("Property 26: API key secret is one-time and non-reversible", () => {
  it("returns plaintext once, stores only its SHA-256 hash, never the plaintext", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 16 }).filter((s) => s.trim().length > 0), async (rid) => {
        const { dynamo, manager } = harness();
        // Seed the owning reseller as active.
        await dynamo.put({
          TableName: RESELLERS_TABLE,
          Item: { resellerAccountId: rid.trim(), orgName: "Org", contactEmail: "o@e.com", state: "active" },
        });

        const res = await manager.issueApiKey({ resellerAccountId: rid }, actor);
        assert.strictEqual(res.ok, true);
        if (!res.ok) return;

        const { record, secret } = res.value;
        // Plaintext is well-formed and prefixed.
        assert.ok(secret.startsWith(API_KEY_PREFIX));
        // Persisted record stores only the hash, and it equals SHA-256(secret).
        assert.strictEqual(record.secretHash, createHash("sha256").update(secret, "utf8").digest("hex"));
        // The plaintext must never appear in the persisted item.
        const stored = await dynamo.get({
          TableName: APIKEYS_TABLE_NAME,
          Key: { [APIKEY_PARTITION_KEY]: record.apiKeyId },
        });
        assert.ok(stored);
        assert.strictEqual((stored as { secretHash?: string }).secretHash, record.secretHash);
        assert.ok(!JSON.stringify(stored).includes(secret), "plaintext secret must not be persisted");
        // The stored hash is not the plaintext (non-reversible representation).
        assert.notStrictEqual(record.secretHash, secret);
      }),
      { numRuns: RUNS }
    );
  });

  it("authenticates with the plaintext once, then rejects after revocation", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 16 }).filter((s) => s.trim().length > 0), async (rid) => {
        const { dynamo, manager, auth } = harness();
        await dynamo.put({
          TableName: RESELLERS_TABLE,
          Item: { resellerAccountId: rid.trim(), orgName: "Org", contactEmail: "o@e.com", state: "active" },
        });

        const issued = await manager.issueApiKey({ resellerAccountId: rid }, actor);
        assert.strictEqual(issued.ok, true);
        if (!issued.ok) return;
        const { record, secret } = issued.value;

        // Sanity: the persisted hash matches the default hasher over the secret.
        assert.strictEqual(record.secretHash, sha256Hasher.hash(secret));

        // Before revocation the key authenticates.
        const before = await auth.authenticateApiKey({ apiKey: secret });
        assert.strictEqual(before.ok, true);
        if (before.ok) assert.strictEqual(before.value.resellerAccountId, rid.trim());

        // After revocation the same key is rejected (Req 11.3).
        const revoked = await manager.revokeApiKey({ apiKeyId: record.apiKeyId }, actor);
        assert.strictEqual(revoked.ok, true);
        const after = await auth.authenticateApiKey({ apiKey: secret });
        assert.strictEqual(after.ok, false);
        if (!after.ok) assert.strictEqual(after.error.code, "authentication_failed");
      }),
      { numRuns: RUNS }
    );
  });
});
