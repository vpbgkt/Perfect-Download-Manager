// Feature: admin-reseller-portal, reseller account management properties
//
// Property 24: Reseller account creation validation and defaults (Req 10.1, 10.4)
// Property 25: Reseller suspend/reactivate round-trip           (Req 10.2, 10.3)

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { FakeDynamoClient } from "../lib/dev/in-memory-dynamo.ts";
import { createAuditLog } from "../lib/audit.ts";
import {
  createAccountManager,
  RESELLERS_TABLE_NAME,
  RESELLER_PARTITION_KEY,
  RESELLER_ACTIVE,
  RESELLER_SUSPENDED,
} from "../lib/accounts.ts";

const RUNS = 100;

function harness() {
  const dynamo = new FakeDynamoClient();
  dynamo.registerKeySchema(RESELLERS_TABLE_NAME, RESELLER_PARTITION_KEY);
  let auditN = 0;
  const audit = createAuditLog(dynamo, {
    tableName: "pdm-portal-audit",
    now: () => "2025-01-01T00:00:00.000Z",
    generateId: () => `audit-${auditN++}`,
  });
  let idN = 0;
  const accounts = createAccountManager({
    dynamo,
    audit,
    now: () => new Date("2025-06-15T12:00:00.000Z"),
    generateId: () => `res-${idN++}`,
  });
  return { dynamo, accounts };
}

const actor = { actor: "super-1", actorRole: "super_admin", sourceIp: "1.2.3.4" };

describe("Property 24: Reseller account creation validation and defaults", () => {
  it("creates an active account with unique id when org name + email are present", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim().length > 0),
        fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim().length > 0),
        async (orgName, contactEmail) => {
          const { dynamo, accounts } = harness();
          const res = await accounts.createReseller({ orgName, contactEmail }, actor);
          assert.strictEqual(res.ok, true);
          if (!res.ok) return;
          assert.strictEqual(res.value.state, RESELLER_ACTIVE);
          assert.strictEqual(res.value.orgName, orgName.trim());
          assert.strictEqual(res.value.contactEmail, contactEmail.trim());
          assert.ok(res.value.resellerAccountId.length > 0);

          const stored = await dynamo.get({
            TableName: RESELLERS_TABLE_NAME,
            Key: { [RESELLER_PARTITION_KEY]: res.value.resellerAccountId },
          });
          assert.strictEqual(stored?.state, RESELLER_ACTIVE);
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("rejects and writes nothing when org name or contact email is missing/blank", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(fc.constant(""), fc.constant("   "), fc.constant(undefined), fc.constant(null)),
        fc.oneof(fc.constant(""), fc.constant("   "), fc.constant(undefined), fc.constant(null), fc.string({ minLength: 1, maxLength: 10 })),
        async (orgName, contactEmail) => {
          // Ensure at least one field is genuinely missing/blank.
          const orgBad = typeof orgName !== "string" || orgName.trim() === "";
          fc.pre(orgBad || typeof contactEmail !== "string" || contactEmail.trim() === "");
          const { dynamo, accounts } = harness();
          const res = await accounts.createReseller(
            { orgName: orgName as unknown, contactEmail: contactEmail as unknown },
            actor
          );
          assert.strictEqual(res.ok, false);
          if (!res.ok) assert.strictEqual(res.error.code, "validation_error");
          assert.strictEqual(dynamo.itemCount(RESELLERS_TABLE_NAME), 0);
        }
      ),
      { numRuns: RUNS }
    );
  });
});

describe("Property 25: Reseller suspend/reactivate round-trip", () => {
  it("suspend then reactivate returns the account to active, and each transition persists", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
        async (org) => {
          const { dynamo, accounts } = harness();
          const created = await accounts.createReseller(
            { orgName: org, contactEmail: "ops@example.com" },
            actor
          );
          assert.strictEqual(created.ok, true);
          if (!created.ok) return;
          const id = created.value.resellerAccountId;

          const suspended = await accounts.suspend({ resellerAccountId: id }, actor);
          assert.strictEqual(suspended.ok, true);
          if (suspended.ok) assert.strictEqual(suspended.value.state, RESELLER_SUSPENDED);
          let stored = await dynamo.get({ TableName: RESELLERS_TABLE_NAME, Key: { [RESELLER_PARTITION_KEY]: id } });
          assert.strictEqual(stored?.state, RESELLER_SUSPENDED);

          const reactivated = await accounts.reactivate({ resellerAccountId: id }, actor);
          assert.strictEqual(reactivated.ok, true);
          if (reactivated.ok) assert.strictEqual(reactivated.value.state, RESELLER_ACTIVE);
          stored = await dynamo.get({ TableName: RESELLERS_TABLE_NAME, Key: { [RESELLER_PARTITION_KEY]: id } });
          assert.strictEqual(stored?.state, RESELLER_ACTIVE);
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("suspend/reactivate of an unknown account is reported as not-found", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 20 }), async (id) => {
        const { accounts } = harness();
        const s = await accounts.suspend({ resellerAccountId: id }, actor);
        assert.strictEqual(s.ok, false);
        if (!s.ok) assert.strictEqual(s.error.code, "not_found");
        const r = await accounts.reactivate({ resellerAccountId: id }, actor);
        assert.strictEqual(r.ok, false);
        if (!r.ok) assert.strictEqual(r.error.code, "not_found");
      }),
      { numRuns: RUNS }
    );
  });
});
