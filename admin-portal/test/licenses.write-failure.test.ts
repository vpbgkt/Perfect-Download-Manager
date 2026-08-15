// Feature: license-key-management-enhancements — create write-failure path (unit)
//
// Validates: Requirements 1.10, 11.1
//
// Req 1.10: IF the Licenses_Table write of a create-license request fails, THEN
// THE Portal_Backend SHALL return an error response indicating that the
// License_Record was not created and SHALL leave every item in the
// Licenses_Table unchanged.
//
// These are example/unit tests (node:test). They inject a `conditionalPut`
// rejection that is NOT a ConditionalCheckFailedError (a generic write failure,
// e.g. a throttling / service error) and assert the create surfaces the failure
// as "not created" while leaving the Licenses_Table byte-for-byte unchanged.
//
// Note on the implemented behavior (task 5.1): `createLicenseCreator` catches
// only `ConditionalCheckFailedError` (a key collision → retry). A non-collision
// rejection is re-thrown from `create()` — it never reaches the audit write and
// never performs a partial write. The tests below therefore assert BOTH the
// propagated failure AND a deep-equal table snapshot before/after.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createLicenseCreator,
  LICENSES_TABLE_NAME,
  LICENSE_PARTITION_KEY,
  type CreateActor,
  type CreateLicenseInput,
} from "../lib/licenses/create.ts";
import { createAuditLog, AUDIT_TABLE_NAME } from "../lib/audit.ts";
import { ConditionalCheckFailedError, type DynamoItem } from "../lib/dynamo.ts";
import { FakeDynamoClient } from "../lib/dev/in-memory-dynamo.ts";

/**
 * In-memory DynamoDB fake whose `conditionalPut` rejects for one target table
 * with a caller-supplied error, while every other operation (and every other
 * table) behaves exactly as the real fake. Used to simulate a Licenses_Table
 * write failure that is not a key collision.
 */
class WriteFailingDynamo extends FakeDynamoClient {
  private readonly failTable: string;
  private readonly error: Error;

  constructor(failTable: string, error: Error) {
    super();
    this.failTable = failTable;
    this.error = error;
  }

  override async conditionalPut(
    tableName: string,
    item: DynamoItem,
    partitionKeyName: string
  ): Promise<void> {
    if (tableName === this.failTable) {
      throw this.error;
    }
    return super.conditionalPut(tableName, item, partitionKeyName);
  }
}

const ACTOR: CreateActor = {
  actor: "admin-user",
  actorRole: "admin",
  sourceIp: "198.51.100.42",
};

const INPUT: CreateLicenseInput = {
  plan: "standard",
  maxActivations: 5,
  owner: "Acme Corp",
  features: ["a", "b"],
};

/** A pre-existing License_Record used to prove the table is left untouched. */
function seedRecord(licenseKey: string): DynamoItem {
  return {
    licenseKey,
    status: "active",
    plan: "standard",
    owner: "existing-owner",
    features: [],
    maxActivations: 3,
    activations: {},
    createdAt: "2024-01-01T00:00:00.000Z",
  };
}

/** Build a creator wired to a Licenses_Table write that always rejects. */
function makeFailingCreator(error: Error) {
  const dynamo = new WriteFailingDynamo(LICENSES_TABLE_NAME, error);
  // Deterministic key so the failure is a genuine write failure, not a collision.
  const creator = createLicenseCreator({
    dynamo,
    audit: createAuditLog(dynamo),
    now: () => new Date("2025-06-01T12:00:00.000Z"),
    generateKey: () => "PDM-ABCD-EFGH-JKMN-PQRS-TVWX-YZ23-4567",
  });
  return { dynamo, creator };
}

describe("create write-failure path (Req 1.10, 11.1)", () => {
  it("propagates a non-collision put rejection and writes no License_Record", async () => {
    const writeError = new Error("ProvisionedThroughputExceededException");
    const { dynamo, creator } = makeFailingCreator(writeError);

    const before = dynamo.dump(LICENSES_TABLE_NAME);

    await assert.rejects(
      () => creator.create(INPUT, ACTOR),
      (err: unknown) => {
        // The exact injected write failure surfaces to the caller — the record
        // was not created.
        assert.strictEqual(err, writeError);
        // It must NOT be masqueraded as a collision.
        assert.ok(!(err instanceof ConditionalCheckFailedError));
        return true;
      },
      "a non-collision Licenses_Table write failure must propagate as an error"
    );

    // Req 1.10 — the Licenses_Table is left unchanged (still empty here).
    const after = dynamo.dump(LICENSES_TABLE_NAME);
    assert.deepStrictEqual(after, before);
    assert.strictEqual(dynamo.itemCount(LICENSES_TABLE_NAME), 0);

    // No partial state: the create Audit_Entry is written only after a
    // successful put, so a failed write leaves the audit log empty too.
    assert.strictEqual(dynamo.itemCount(AUDIT_TABLE_NAME), 0);
  });

  it("leaves an already-populated Licenses_Table byte-for-byte unchanged", async () => {
    const writeError = new Error("InternalServerError");
    const { dynamo, creator } = makeFailingCreator(writeError);

    // Seed the table with existing License_Records the failed create must not touch.
    dynamo.registerKeySchema(LICENSES_TABLE_NAME, LICENSE_PARTITION_KEY);
    await dynamo.put({ TableName: LICENSES_TABLE_NAME, Item: seedRecord("PDM-1111-2222-3333-4444") });
    await dynamo.put({ TableName: LICENSES_TABLE_NAME, Item: seedRecord("PDM-5555-6666-7777-8888") });

    // Deep snapshot before the attempt.
    const before = dynamo.dump(LICENSES_TABLE_NAME);

    await assert.rejects(
      () => creator.create(INPUT, ACTOR),
      (err: unknown) => err === writeError
    );

    // Req 1.10 — every existing item is preserved exactly (deep-equal snapshot).
    const after = dynamo.dump(LICENSES_TABLE_NAME);
    assert.deepStrictEqual(after, before);
    assert.strictEqual(dynamo.itemCount(LICENSES_TABLE_NAME), 2);

    // The candidate key was never written despite the failure.
    const candidate = after.find(
      (item) => item[LICENSE_PARTITION_KEY] === "PDM-ABCD-EFGH-JKMN-PQRS-TVWX-YZ23-4567"
    );
    assert.strictEqual(candidate, undefined, "the failed create must write no new record");
  });
});
