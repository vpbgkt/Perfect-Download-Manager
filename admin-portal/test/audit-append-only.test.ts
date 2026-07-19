/**
 * Property test: the Audit_Log is append-only (Req 13.3).
 *
 * Feature: admin-reseller-portal, Property 29: Audit log is append-only
 *
 * Drives {@link createAuditLog} with the in-memory fake document client and
 * asserts that a sequence of writes only ever *adds* items: every write grows
 * the table by exactly one, all previously written entries stay byte-for-byte
 * identical, and a write that reuses an existing auditId is rejected (the
 * conditional put fails) without overwriting the existing entry. The audit log
 * exposes no operation that updates or deletes an existing entry.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  createAuditLog,
  AUDIT_TABLE_NAME,
  AUDIT_PARTITION_KEY,
  type AuditEntryInput,
} from "../lib/audit.ts";
import { ConditionalCheckFailedError } from "../lib/dynamo.ts";
import { createDynamoFake } from "../lib/dev/in-memory-dynamo.ts";

const NUM_RUNS = 200;

/** Generator for a single audit entry input with an explicit unique-ish id. */
function auditInputArb(): fc.Arbitrary<AuditEntryInput> {
  return fc.record({
    actor: fc.string({ minLength: 1, maxLength: 20 }),
    actorRole: fc.constantFrom("super_admin", "admin", "reseller"),
    action: fc.constantFrom(
      "license.create",
      "license.status.update",
      "reseller.create",
      "apikey.revoke"
    ),
    target: fc.string({ minLength: 1, maxLength: 24 }),
    sourceIp: fc.ipV4(),
    changes: fc.option(
      fc.dictionary(
        fc.string({ minLength: 1, maxLength: 8 }),
        fc.record({
          before: fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
          after: fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
        }),
        { maxKeys: 4 }
      ),
      { nil: undefined }
    ),
  });
}

describe("Property 29: Audit log is append-only (Req 13.3)", () => {
  it("every write only adds one item and never mutates prior entries", async () => {
    // Feature: admin-reseller-portal, Property 29: Audit log is append-only
    await fc.assert(
      fc.asyncProperty(
        fc.array(auditInputArb(), { minLength: 1, maxLength: 30 }),
        async (inputs) => {
          const client = createDynamoFake();
          // Deterministic id/clock injection: unique ids, monotonic timestamps.
          let counter = 0;
          const audit = createAuditLog(client, {
            generateId: () => `audit-${counter++}`,
            now: () => new Date(1_700_000_000_000 + counter * 1000).toISOString(),
          });

          const snapshots: string[] = [];

          for (let i = 0; i < inputs.length; i++) {
            const before = client.allItems(AUDIT_TABLE_NAME);
            const beforeCount = before.length;

            await audit.writeAuditEntry(inputs[i]);

            const after = client.allItems(AUDIT_TABLE_NAME);

            // Count increases by exactly one per write (append-only add).
            assert.strictEqual(
              after.length,
              beforeCount + 1,
              `write ${i} should add exactly one item`
            );

            // All previously written entries remain byte-for-byte unchanged.
            const afterById = new Map(
              after.map((it) => [it[AUDIT_PARTITION_KEY] as string, JSON.stringify(it)])
            );
            for (const prev of before) {
              const id = prev[AUDIT_PARTITION_KEY] as string;
              assert.strictEqual(
                afterById.get(id),
                JSON.stringify(prev),
                `previous entry ${id} must be unchanged after write ${i}`
              );
            }

            snapshots.push(JSON.stringify(after));
          }

          // Final table holds exactly one entry per write.
          assert.strictEqual(client.itemCount(AUDIT_TABLE_NAME), inputs.length);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it("reusing an existing auditId is rejected and does not overwrite the entry", async () => {
    // Feature: admin-reseller-portal, Property 29: Audit log is append-only
    await fc.assert(
      fc.asyncProperty(
        auditInputArb(),
        auditInputArb(),
        fc.string({ minLength: 1, maxLength: 16 }),
        async (first, second, sharedId) => {
          const client = createDynamoFake();
          const audit = createAuditLog(client, {
            generateId: () => "unused",
            now: () => "2023-11-14T00:00:00.000Z",
          });

          // Write the first entry under a fixed id.
          const written = await audit.writeAuditEntry({ ...first, auditId: sharedId });
          const storedBefore = client.allItems(AUDIT_TABLE_NAME);
          assert.strictEqual(storedBefore.length, 1);
          const originalSnapshot = JSON.stringify(storedBefore[0]);

          // A second write reusing the same auditId must be rejected.
          await assert.rejects(
            () => audit.writeAuditEntry({ ...second, auditId: sharedId }),
            ConditionalCheckFailedError,
            "reusing an auditId must fail the conditional put"
          );

          // The existing entry is untouched: still one item, byte-for-byte same.
          const storedAfter = client.allItems(AUDIT_TABLE_NAME);
          assert.strictEqual(storedAfter.length, 1, "no new item added on collision");
          assert.strictEqual(
            JSON.stringify(storedAfter[0]),
            originalSnapshot,
            "existing entry must not be overwritten"
          );
          assert.strictEqual(storedAfter[0][AUDIT_PARTITION_KEY], sharedId);
          // The returned first entry's id matches what remains persisted.
          assert.strictEqual(written.auditId, sharedId);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it("the audit log exposes no update or delete operation", () => {
    // Feature: admin-reseller-portal, Property 29: Audit log is append-only
    const client = createDynamoFake();
    const audit = createAuditLog(client);
    const keys = Object.keys(audit);
    for (const forbidden of ["update", "delete", "remove", "overwrite", "put"]) {
      assert.ok(
        !keys.includes(forbidden),
        `audit log must not expose a "${forbidden}" operation`
      );
    }
    // Only append + read (query) operations are exposed.
    assert.deepStrictEqual(
      keys.sort(),
      ["queryByAction", "queryByActor", "queryByTarget", "queryByTimeRange", "writeAuditEntry"].sort()
    );
  });
});
