// Feature: admin-reseller-portal, task 13.2 Reseller_API throttling & isolation
//
// Exceeding the rate limit returns a 'rate' decision (HTTP 429
// rate_limit_exceeded); exceeding the monthly quota returns a 'quota' decision
// (HTTP 429 quota_exceeded); suspended-account and revoked-key requests are
// rejected; a non-owned key is reported as not-found.
//
// Requirements: 12.2, 12.4, 12.5, 12.6

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeDynamoClient } from "../lib/dev/in-memory-dynamo.ts";
import {
  enforceRateLimit,
  InMemoryCounterStore,
  type UsagePlan,
} from "../lib/ratelimit.ts";
import {
  createAuthenticator,
  sha256Hasher,
  FakeTokenVerifier,
  type ApiKeyRecord,
  type ResellerAccountRecord,
  type Principal,
} from "../lib/auth.ts";
import { FakeEmailSender } from "../lib/email.ts";
import { createLicenseQuery } from "../lib/licenses/query.ts";
import { LICENSES_TABLE_NAME, LICENSE_PARTITION_KEY } from "../lib/licenses/create.ts";

const APIKEYS_TABLE = "pdm-portal-apikeys";
const RESELLERS_TABLE = "pdm-portal-resellers";
const SECRET_HASH_INDEX = "secretHash-index";

const plan: UsagePlan = { rateLimitPerSec: 2, burst: 1, monthlyQuota: 5 };

describe("Reseller_API rate limiting (Req 12.5)", () => {
  it("throttles with reason 'rate' once the window allowance is exceeded", async () => {
    const store = new InMemoryCounterStore();
    const now = new Date("2025-06-15T12:00:00.000Z");
    const allowance = plan.rateLimitPerSec * 1 + plan.burst; // = 3
    for (let i = 0; i < allowance; i++) {
      const d = await enforceRateLimit(store, "key-1", plan, { now });
      assert.deepStrictEqual(d, { allowed: true, reason: null });
    }
    const over = await enforceRateLimit(store, "key-1", plan, { now });
    assert.deepStrictEqual(over, { allowed: false, reason: "rate" });
  });
});

describe("Reseller_API monthly quota (Req 12.6)", () => {
  it("throttles with reason 'quota' once the monthly quota is exhausted", async () => {
    // Give a generous rate window so only the quota can bite; advance time each
    // call so the per-second window never limits us.
    const store = new InMemoryCounterStore();
    const big: UsagePlan = { rateLimitPerSec: 1000, burst: 1000, monthlyQuota: 5 };
    for (let i = 0; i < big.monthlyQuota; i++) {
      const now = new Date(Date.parse("2025-06-15T12:00:00.000Z") + i * 1000);
      const d = await enforceRateLimit(store, "key-q", big, { now });
      assert.deepStrictEqual(d, { allowed: true, reason: null });
    }
    const over = await enforceRateLimit(store, "key-q", big, {
      now: new Date("2025-06-15T12:10:00.000Z"),
    });
    assert.deepStrictEqual(over, { allowed: false, reason: "quota" });
  });

  it("resets the quota at the next calendar month", async () => {
    const store = new InMemoryCounterStore();
    const big: UsagePlan = { rateLimitPerSec: 1000, burst: 1000, monthlyQuota: 1 };
    const june = new Date("2025-06-30T23:59:59.000Z");
    assert.strictEqual((await enforceRateLimit(store, "k", big, { now: june })).allowed, true);
    assert.strictEqual((await enforceRateLimit(store, "k", big, { now: june })).allowed, false);
    // New calendar month -> fresh quota.
    const july = new Date("2025-07-01T00:00:00.000Z");
    assert.strictEqual((await enforceRateLimit(store, "k", big, { now: july })).allowed, true);
  });
});

function authHarness() {
  const dynamo = new FakeDynamoClient();
  dynamo.registerKeySchema(APIKEYS_TABLE, "apiKeyId");
  dynamo.registerKeySchema(RESELLERS_TABLE, "resellerAccountId");
  const auth = createAuthenticator({
    dynamo,
    tokenVerifier: new FakeTokenVerifier(),
    emailSender: new FakeEmailSender(),
    tables: { apiKeys: APIKEYS_TABLE, resellers: RESELLERS_TABLE, apiKeySecretHashIndex: SECRET_HASH_INDEX },
  });
  return { dynamo, auth };
}

function seedKey(dynamo: FakeDynamoClient, secret: string, opts: { reseller: string; state: "active" | "revoked" }) {
  const rec: ApiKeyRecord = {
    apiKeyId: `id-${opts.reseller}`,
    resellerAccountId: opts.reseller,
    secretHash: sha256Hasher.hash(secret),
    state: opts.state,
  };
  void dynamo.put({ TableName: APIKEYS_TABLE, Item: rec as unknown as Record<string, unknown> });
}

function seedReseller(dynamo: FakeDynamoClient, id: string, state: "active" | "suspended") {
  const rec: ResellerAccountRecord = {
    resellerAccountId: id,
    orgName: "Org",
    contactEmail: "o@e.com",
    state,
  };
  void dynamo.put({ TableName: RESELLERS_TABLE, Item: rec as unknown as Record<string, unknown> });
}

const VALID_SECRET = "pdm_ak_" + "a".repeat(48);

describe("Reseller_API authentication rejects revoked keys and suspended accounts (Req 12.2)", () => {
  it("rejects a revoked Api_Key", async () => {
    const { dynamo, auth } = authHarness();
    seedReseller(dynamo, "r1", "active");
    seedKey(dynamo, VALID_SECRET, { reseller: "r1", state: "revoked" });
    const res = await auth.authenticateApiKey({ apiKey: VALID_SECRET });
    assert.strictEqual(res.ok, false);
    if (!res.ok) assert.strictEqual(res.error.code, "authentication_failed");
  });

  it("rejects a request for a suspended Reseller_Account", async () => {
    const { dynamo, auth } = authHarness();
    seedReseller(dynamo, "r1", "suspended");
    seedKey(dynamo, VALID_SECRET, { reseller: "r1", state: "active" });
    const res = await auth.authenticateApiKey({ apiKey: VALID_SECRET });
    assert.strictEqual(res.ok, false);
    if (!res.ok) assert.strictEqual(res.error.code, "authentication_failed");
  });

  it("authenticates an active key for an active account", async () => {
    const { dynamo, auth } = authHarness();
    seedReseller(dynamo, "r1", "active");
    seedKey(dynamo, VALID_SECRET, { reseller: "r1", state: "active" });
    const res = await auth.authenticateApiKey({ apiKey: VALID_SECRET });
    assert.strictEqual(res.ok, true);
    if (res.ok) assert.strictEqual(res.value.resellerAccountId, "r1");
  });
});

describe("Reseller_API isolation: a non-owned key is not-found (Req 12.4)", () => {
  it("a reseller cannot view another account's license", async () => {
    const dynamo = new FakeDynamoClient();
    dynamo.registerKeySchema(LICENSES_TABLE_NAME, LICENSE_PARTITION_KEY);
    const key = "PDM-1111-2222-3333-4444";
    void dynamo.put({
      TableName: LICENSES_TABLE_NAME,
      Item: {
        [LICENSE_PARTITION_KEY]: key,
        status: "active",
        plan: "standard",
        features: [],
        maxActivations: 5,
        activations: {},
        createdAt: "2025-01-01T00:00:00.000Z",
        resellerAccountId: "owner-reseller",
      },
    });
    const query = createLicenseQuery({ dynamo });

    const intruder: Principal = {
      identity: "id-other",
      role: "reseller",
      resellerAccountId: "other-reseller",
      mfaEnrolled: true,
      authMethod: "apikey",
    };
    const owner: Principal = { ...intruder, identity: "id-owner", resellerAccountId: "owner-reseller" };

    assert.strictEqual(await query.view(intruder, key), null);
    const seen = await query.view(owner, key);
    assert.ok(seen && seen.licenseKey === key);
  });
});
