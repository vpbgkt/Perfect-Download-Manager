import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAuthenticator } from "../lib/auth.ts";
import { FakeDynamoClient } from "../lib/dev/in-memory-dynamo.ts";

const RESELLERS_TABLE = "pdm-portal-resellers";

async function setup(state: "active" | "suspended" = "active") {
  const dynamo = new FakeDynamoClient();
  dynamo.registerKeySchema(RESELLERS_TABLE, "resellerAccountId");
  await dynamo.put({
    TableName: RESELLERS_TABLE,
    Item: {
      resellerAccountId: "acc_test",
      accountType: "reseller",
      contactEmail: "reseller@example.invalid",
      orgName: "Test account",
      passwordHash: "unused",
      state,
      sessionVersion: 0,
      balance: 0,
      discountPercent: 0,
    },
  });
  return createAuthenticator({ dynamo });
}

const session = {
  accountId: "acc_test",
  email: "reseller@example.invalid",
  role: "reseller" as const,
  resellerAccountId: "acc_test",
  sessionVersion: 0,
};

describe("password JWT session validation", () => {
  it("rejects a session after logout advances its version", async () => {
    const auth = await setup();
    assert.strictEqual((await auth.authenticateJwtSession(session)).ok, true);
    assert.strictEqual((await auth.logoutPasswordSession(session)).ok, true);

    assert.strictEqual((await auth.authenticateJwtSession(session)).ok, false);
    assert.strictEqual(
      (
        await auth.authenticateJwtSession({
          ...session,
          sessionVersion: 1,
        })
      ).ok,
      true
    );
  });

  it("rejects sessions for suspended accounts", async () => {
    const auth = await setup("suspended");
    assert.strictEqual((await auth.authenticateJwtSession(session)).ok, false);
  });
});
