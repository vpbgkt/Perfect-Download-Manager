// Feature: license-key-management-enhancements
// Property 6: A failing random source produces no key and no write
//
// Validates: Requirements 6.8
//
// The Key_Generator draws every byte of a Key_Secret_Component from an
// injectable cryptographically secure source and consults no fallback. When
// that source throws, or under-delivers (returns fewer bytes than requested) at
// an arbitrary point, the generator surfaces a KeyGenerationError instead of a
// weaker key: generateSecretComponent and generateLicenseKey produce no key at
// all, with or without a Custom_Key_Prefix.
//
// Downstream, license creation maps that KeyGenerationError to
// { code: "key_generation_failed" } BEFORE any write. This is asserted against
// the in-memory DynamoDB fake by taking a deep snapshot of every table
// (pdm-licenses and pdm-portal-audit) before the attempt and asserting it is
// deep-equal afterwards — no License_Record is written and no Audit_Entry is
// appended.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  SECRET_GROUPS,
  SECRET_GROUP_SIZE,
  KeyGenerationError,
  generateSecretComponent,
  generateLicenseKey,
  type RandomBytes,
} from "../lib/licenses/keygen.ts";
import {
  createLicenseCreator,
  LICENSES_TABLE_NAME,
  LICENSE_PARTITION_KEY,
} from "../lib/licenses/create.ts";
import { createAuditLog, AUDIT_TABLE_NAME } from "../lib/audit.ts";
import { FakeDynamoClient } from "../lib/dev/in-memory-dynamo.ts";
import type { DynamoItem } from "../lib/dynamo.ts";

const RUNS = 100;

/** Number of Key_Secret_Component symbols: 7 groups × 4 symbols = 28. */
const SECRET_LENGTH = SECRET_GROUPS * SECRET_GROUP_SIZE;

// ---------------------------------------------------------------------------
// A byte source that fails at an arbitrary point
// ---------------------------------------------------------------------------

/** How the injected byte source misbehaves once it runs out of "good" bytes. */
type FailMode = "throw" | "short";

/**
 * Build a {@link RandomBytes} source that delivers `goodBytes` in-range bytes
 * (spread across however many calls the generator makes) and then, on the first
 * request it cannot fully satisfy, either throws or returns a short buffer.
 *
 * Because a full Key_Secret_Component needs {@link SECRET_LENGTH} (28) symbols
 * and the generator requests the outstanding count in one draw, any
 * `goodBytes < 28` guarantees the failure fires at an arbitrary point in the
 * draw — modelling both a throwing source and one that under-delivers.
 */
function failingSource(goodBytes: number, mode: FailMode): RandomBytes {
  let delivered = 0;
  return (n: number): Uint8Array => {
    const remaining = goodBytes - delivered;
    if (remaining >= n) {
      // Can satisfy this request from the remaining budget of good bytes.
      delivered += n;
      // All-zero bytes are in range (0 < ACCEPT_LIMIT) and map to a valid symbol.
      return new Uint8Array(n);
    }
    if (mode === "throw") {
      throw new Error("simulated random source failure");
    }
    // Short read: hand back only what is left (0..remaining < n requested).
    delivered = goodBytes;
    return new Uint8Array(Math.max(0, remaining));
  };
}

/** Arbitrary for the failure configuration: how many good bytes, then how it fails. */
const failureArb = fc.record({
  goodBytes: fc.integer({ min: 0, max: SECRET_LENGTH - 1 }),
  mode: fc.constantFrom<FailMode>("throw", "short"),
});

/** Arbitrary legal, already-normalized Custom_Key_Prefix, or none. */
const prefixArb = fc.option(
  fc
    .array(fc.constantFrom(..."ABCDEFGHJKMNPQRSTVWXYZ0123456789".split("")), {
      minLength: 1,
      maxLength: 32,
    })
    .map((chars) => chars.join("")),
  { nil: undefined }
);

// ---------------------------------------------------------------------------
// Table snapshotting
// ---------------------------------------------------------------------------

/** Deep snapshot of every table this flow could touch, keyed by table name. */
function snapshotTables(dynamo: FakeDynamoClient): Record<string, DynamoItem[]> {
  return {
    [LICENSES_TABLE_NAME]: dynamo.dump(LICENSES_TABLE_NAME),
    [AUDIT_TABLE_NAME]: dynamo.dump(AUDIT_TABLE_NAME),
  };
}

/** A canonical `PDM-XXXX-XXXX-XXXX-XXXX` seed License_Key (uppercase hex groups). */
const seedKeyArb = fc
  .tuple(
    fc.integer({ min: 0, max: 0xffff }),
    fc.integer({ min: 0, max: 0xffff }),
    fc.integer({ min: 0, max: 0xffff }),
    fc.integer({ min: 0, max: 0xffff })
  )
  .map(
    (groups) =>
      `PDM-${groups
        .map((n) => n.toString(16).toUpperCase().padStart(4, "0"))
        .join("-")}`
  );

/** A small set of distinct pre-existing License_Records to prove nothing is lost. */
const seedRecordsArb = fc
  .uniqueArray(seedKeyArb, { minLength: 0, maxLength: 5 })
  .map((keys) =>
    keys.map((licenseKey) => ({
      licenseKey,
      status: "active",
      plan: "standard",
      features: [],
      maxActivations: 3,
      activations: {},
      createdAt: "2020-01-01T00:00:00.000Z",
    }))
  );

// ---------------------------------------------------------------------------
// Property 6
// ---------------------------------------------------------------------------

describe("Property 6: a failing random source produces no key and no write", () => {
  it("generateSecretComponent throws KeyGenerationError and yields no secret (Req 6.8)", () => {
    fc.assert(
      fc.property(failureArb, ({ goodBytes, mode }) => {
        const source = failingSource(goodBytes, mode);
        assert.throws(
          () => generateSecretComponent(source),
          KeyGenerationError,
          "a failing byte source must surface a KeyGenerationError, never a weaker secret"
        );
      }),
      { numRuns: RUNS }
    );
  });

  it("generateLicenseKey throws KeyGenerationError and yields no key, with or without a prefix (Req 6.8)", () => {
    fc.assert(
      fc.property(failureArb, prefixArb, ({ goodBytes, mode }, prefix) => {
        const source = failingSource(goodBytes, mode);
        let produced: string | undefined;
        assert.throws(
          () => {
            produced = generateLicenseKey(prefix, source);
          },
          KeyGenerationError,
          "a failing byte source must abort key generation, never fall back"
        );
        assert.strictEqual(produced, undefined, "no License_Key may be produced");
      }),
      { numRuns: RUNS }
    );
  });

  it("create() maps the failure to key_generation_failed and leaves every table deep-equal (Req 6.8)", async () => {
    await fc.assert(
      fc.asyncProperty(
        failureArb,
        prefixArb,
        seedRecordsArb,
        async ({ goodBytes, mode }, prefix, seedRecords) => {
          const dynamo = new FakeDynamoClient();
          const audit = createAuditLog(dynamo);

          // Pre-seed existing License_Records so "no write" is a meaningful,
          // non-trivial deep-equal (nothing added, nothing mutated, nothing lost).
          for (const record of seedRecords) {
            await dynamo.conditionalPut(
              LICENSES_TABLE_NAME,
              record as unknown as DynamoItem,
              LICENSE_PARTITION_KEY
            );
          }

          const before = snapshotTables(dynamo);

          const creator = createLicenseCreator({
            dynamo,
            audit,
            now: () => new Date("2024-06-01T00:00:00.000Z"),
            // The injected generator draws from the failing source, so every
            // attempt throws a KeyGenerationError before any write.
            generateKey: (p?: string) =>
              generateLicenseKey(p, failingSource(goodBytes, mode)),
          });

          const result = await creator.create(
            {
              plan: "standard",
              maxActivations: 5,
              keyPrefix: prefix,
            },
            { actor: "admin-user", actorRole: "admin", sourceIp: "198.51.100.7" }
          );

          // No key: the create fails cleanly with the mapped error code.
          assert.strictEqual(result.ok, false, "create must not succeed");
          if (!result.ok) {
            assert.strictEqual(
              result.error.code,
              "key_generation_failed",
              "a KeyGenerationError must map to key_generation_failed before any write"
            );
          }

          // No write: every table is byte-for-byte identical to the snapshot.
          const after = snapshotTables(dynamo);
          assert.deepStrictEqual(
            after,
            before,
            "a failing random source must leave every table unchanged"
          );
          // Explicitly: no License_Record added and no Audit_Entry appended.
          assert.strictEqual(
            dynamo.itemCount(LICENSES_TABLE_NAME),
            seedRecords.length,
            "no License_Record may be written"
          );
          assert.strictEqual(
            dynamo.itemCount(AUDIT_TABLE_NAME),
            0,
            "no Audit_Entry may be appended"
          );
        }
      ),
      { numRuns: RUNS }
    );
  });
});
