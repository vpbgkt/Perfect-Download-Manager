// Feature: admin-reseller-portal, task 11.6 unit test
//
// Api_Keys issued without an explicit Usage_Plan fall back to the portal default
// rate/burst/quota; a partial plan fills only its missing fields from the default.
//
// Requirements: 11.5

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeDynamoClient } from "../lib/dev/in-memory-dynamo.ts";
import { createAuditLog } from "../lib/audit.ts";
import {
  createApiKeyManager,
  APIKEYS_TABLE_NAME,
  APIKEY_PARTITION_KEY,
} from "../lib/apikeys.ts";
import { DEFAULT_USAGE_PLAN } from "../lib/ratelimit.ts";

function makeManager() {
  const dynamo = new FakeDynamoClient();
  dynamo.registerKeySchema(APIKEYS_TABLE_NAME, APIKEY_PARTITION_KEY);
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
  return { manager };
}

const actor = { actor: "super-1", actorRole: "super_admin", sourceIp: "1.2.3.4" };

describe("Default Usage_Plan fallback (Req 11.5)", () => {
  it("applies the portal default plan when none is supplied", async () => {
    const { manager } = makeManager();
    const res = await manager.issueApiKey({ resellerAccountId: "r1" }, actor);
    assert.strictEqual(res.ok, true);
    if (!res.ok) return;
    assert.strictEqual(res.value.record.rateLimitPerSec, DEFAULT_USAGE_PLAN.rateLimitPerSec);
    assert.strictEqual(res.value.record.burst, DEFAULT_USAGE_PLAN.burst);
    assert.strictEqual(res.value.record.monthlyQuota, DEFAULT_USAGE_PLAN.monthlyQuota);
  });

  it("applies the default plan when an explicit null plan is supplied", async () => {
    const { manager } = makeManager();
    const res = await manager.issueApiKey({ resellerAccountId: "r1", plan: null }, actor);
    assert.strictEqual(res.ok, true);
    if (!res.ok) return;
    assert.strictEqual(res.value.record.rateLimitPerSec, DEFAULT_USAGE_PLAN.rateLimitPerSec);
    assert.strictEqual(res.value.record.burst, DEFAULT_USAGE_PLAN.burst);
    assert.strictEqual(res.value.record.monthlyQuota, DEFAULT_USAGE_PLAN.monthlyQuota);
  });

  it("fills only missing fields of a partial plan from the default", async () => {
    const { manager } = makeManager();
    const res = await manager.issueApiKey(
      { resellerAccountId: "r1", plan: { rateLimitPerSec: 42 } },
      actor
    );
    assert.strictEqual(res.ok, true);
    if (!res.ok) return;
    assert.strictEqual(res.value.record.rateLimitPerSec, 42);
    assert.strictEqual(res.value.record.burst, DEFAULT_USAGE_PLAN.burst);
    assert.strictEqual(res.value.record.monthlyQuota, DEFAULT_USAGE_PLAN.monthlyQuota);
  });
});
