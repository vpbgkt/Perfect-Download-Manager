/**
 * Property + unit tests for the audit query helpers (Req 13.4).
 *
 * Feature: admin-reseller-portal, Property 30: Audit query returns exactly
 * matching entries.
 *
 * The audit log is backed by the in-memory fake document client, whose `query`
 * implementation honors the `KeyConditionExpression` / GSI keys that
 * `lib/audit.ts` issues. For an arbitrary set of written audit entries we assert
 * that `queryByActor` / `queryByTarget` / `queryByAction` return exactly the
 * entries whose actor / target / action match (no missing, no extra), and that
 * `queryByTimeRange` returns exactly the entries whose timestamp falls within
 * the inclusive `[start, end]` range.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { FakeDynamoClient } from "../lib/dev/in-memory-dynamo.ts";
import {
  createAuditLog,
  AUDIT_TABLE_NAME,
  type AuditEntryInput,
} from "../lib/audit.ts";

// Small pools so query keys collide across many generated entries, ensuring
// queries genuinely return multiple matches (and correctly exclude non-matches).
const ACTORS = ["actor-a", "actor-b", "actor-c"];
const TARGETS = ["PDM-AAAA-1111-2222-3333", "PDM-BBBB-4444-5555-6666", "PDM-CCCC-7777-8888-9999"];
const ACTIONS = ["license.create", "license.status.update", "apikey.revoke"];

const BASE_MS = Date.UTC(2024, 0, 1, 0, 0, 0);

/** ISO 8601 UTC timestamp for a minute offset from the base instant. */
function isoAt(minuteOffset: number): string {
  return new Date(BASE_MS + minuteOffset * 60_000).toISOString();
}

/** Sorted list of ids, for order-independent set comparison. */
function ids(entries: { auditId: string }[]): string[] {
  return entries.map((e) => e.auditId).sort();
}

const rawEntryArb = fc.record({
  actor: fc.constantFrom(...ACTORS),
  target: fc.constantFrom(...TARGETS),
  action: fc.constantFrom(...ACTIONS),
  minute: fc.integer({ min: 0, max: 240 }),
});

describe("audit query results", () => {
  // Feature: admin-reseller-portal, Property 30: Audit query returns exactly matching entries
  // Validates: Requirements 13.4
  it("Property 30: queries return exactly the matching entries (no missing, no extra)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(rawEntryArb, { minLength: 0, maxLength: 25 }),
        fc.integer({ min: 0, max: 240 }),
        fc.integer({ min: 0, max: 240 }),
        async (rawEntries, boundA, boundB) => {
          // Materialize entries with unique ids and ISO timestamps.
          const entries: (AuditEntryInput & { auditId: string; timestamp: string })[] =
            rawEntries.map((e, i) => ({
              auditId: `audit-${i}`,
              actor: e.actor,
              actorRole: "admin",
              action: e.action,
              target: e.target,
              sourceIp: "203.0.113.7",
              timestamp: isoAt(e.minute),
            }));

          const fake = new FakeDynamoClient();
          const log = createAuditLog(fake, { tableName: AUDIT_TABLE_NAME });

          for (const entry of entries) {
            await log.writeAuditEntry(entry);
          }

          // queryByActor: exactly the entries with a matching actor.
          for (const actor of ACTORS) {
            const result = await log.queryByActor(actor);
            const expected = entries.filter((e) => e.actor === actor);
            assert.deepStrictEqual(
              ids(result.items),
              ids(expected),
              `queryByActor(${actor}) mismatch`
            );
          }

          // queryByTarget: exactly the entries with a matching target.
          for (const target of TARGETS) {
            const result = await log.queryByTarget(target);
            const expected = entries.filter((e) => e.target === target);
            assert.deepStrictEqual(
              ids(result.items),
              ids(expected),
              `queryByTarget(${target}) mismatch`
            );
          }

          // queryByAction: exactly the entries with a matching action.
          for (const action of ACTIONS) {
            const result = await log.queryByAction(action);
            const expected = entries.filter((e) => e.action === action);
            assert.deepStrictEqual(
              ids(result.items),
              ids(expected),
              `queryByAction(${action}) mismatch`
            );
          }

          // queryByTimeRange: exactly the entries whose timestamp is within
          // the inclusive [start, end] window.
          const start = isoAt(Math.min(boundA, boundB));
          const end = isoAt(Math.max(boundA, boundB));
          const rangeResult = await log.queryByTimeRange({ start, end });
          const expectedRange = entries.filter(
            (e) => e.timestamp >= start && e.timestamp <= end
          );
          assert.deepStrictEqual(
            ids(rangeResult.items),
            ids(expectedRange),
            `queryByTimeRange([${start}, ${end}]) mismatch`
          );
        }
      ),
      { numRuns: 200 }
    );
  });

  // A time-range narrowing is also honored on the actor index (partition + sort).
  it("Property 30: an actor query narrowed by a time range returns exactly the in-range matches", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(rawEntryArb, { minLength: 0, maxLength: 25 }),
        fc.integer({ min: 0, max: 240 }),
        fc.integer({ min: 0, max: 240 }),
        fc.constantFrom(...ACTORS),
        async (rawEntries, boundA, boundB, actor) => {
          const entries = rawEntries.map((e, i) => ({
            auditId: `audit-${i}`,
            actor: e.actor,
            actorRole: "admin",
            action: e.action,
            target: e.target,
            sourceIp: "203.0.113.7",
            timestamp: isoAt(e.minute),
          }));

          const fake = new FakeDynamoClient();
          const log = createAuditLog(fake, { tableName: AUDIT_TABLE_NAME });
          for (const entry of entries) {
            await log.writeAuditEntry(entry);
          }

          const start = isoAt(Math.min(boundA, boundB));
          const end = isoAt(Math.max(boundA, boundB));
          const result = await log.queryByActor(actor, { start, end });
          const expected = entries.filter(
            (e) => e.actor === actor && e.timestamp >= start && e.timestamp <= end
          );
          assert.deepStrictEqual(ids(result.items), ids(expected));
        }
      ),
      { numRuns: 200 }
    );
  });
});

describe("audit query results (examples)", () => {
  it("queryByActor returns only that actor's entries", async () => {
    const fake = new FakeDynamoClient();
    const log = createAuditLog(fake, { tableName: AUDIT_TABLE_NAME });
    await log.writeAuditEntry({
      auditId: "1",
      actor: "actor-a",
      actorRole: "admin",
      action: "license.create",
      target: "PDM-AAAA-1111-2222-3333",
      sourceIp: "1.1.1.1",
      timestamp: isoAt(0),
    });
    await log.writeAuditEntry({
      auditId: "2",
      actor: "actor-b",
      actorRole: "admin",
      action: "license.create",
      target: "PDM-AAAA-1111-2222-3333",
      sourceIp: "1.1.1.1",
      timestamp: isoAt(1),
    });

    const result = await log.queryByActor("actor-a");
    assert.deepStrictEqual(result.items.map((e) => e.auditId), ["1"]);
  });

  it("queryByTimeRange excludes entries outside the inclusive window", async () => {
    const fake = new FakeDynamoClient();
    const log = createAuditLog(fake, { tableName: AUDIT_TABLE_NAME });
    for (let i = 0; i < 5; i++) {
      await log.writeAuditEntry({
        auditId: `e${i}`,
        actor: "actor-a",
        actorRole: "admin",
        action: "license.create",
        target: "PDM-AAAA-1111-2222-3333",
        sourceIp: "1.1.1.1",
        timestamp: isoAt(i * 10),
      });
    }

    const result = await log.queryByTimeRange({ start: isoAt(10), end: isoAt(30) });
    assert.deepStrictEqual(
      result.items.map((e) => e.auditId).sort(),
      ["e1", "e2", "e3"]
    );
  });

  it("an empty log yields empty query results", async () => {
    const fake = new FakeDynamoClient();
    const log = createAuditLog(fake, { tableName: AUDIT_TABLE_NAME });
    const byActor = await log.queryByActor("actor-a");
    const byRange = await log.queryByTimeRange({ start: isoAt(0), end: isoAt(100) });
    assert.deepStrictEqual(byActor.items, []);
    assert.deepStrictEqual(byRange.items, []);
  });
});
