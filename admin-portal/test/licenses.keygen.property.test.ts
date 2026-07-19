// Feature: admin-reseller-portal, Property 7: Generated license keys are unique and well-formed
//
// Validates: Requirements 3.1, 3.3
//
// generateLicenseKey() always produces a key in the canonical form
// `PDM-XXXX-XXXX-XXXX-XXXX`, where each `XXXX` group is exactly four uppercase
// hexadecimal characters (Req 3.1). The create flow writes records with unique
// keys: minting many licenses yields no duplicate keys, and a conditional-put
// collision triggers *bounded* regeneration so the persisted record always ends
// up with a fresh, unique key (Req 3.3).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { generateLicenseKey } from "../lib/licenses/keygen.ts";
import {
  createLicenseCreator,
  LICENSES_TABLE_NAME,
  LICENSE_PARTITION_KEY,
  DEFAULT_MAX_KEY_ATTEMPTS,
  type CreateActor,
  type CreateLicenseInput,
} from "../lib/licenses/create.ts";
import { createAuditLog } from "../lib/audit.ts";
import { FakeDynamoClient } from "../lib/dev/in-memory-dynamo.ts";
import type { DynamoItem } from "../lib/dynamo.ts";

const RUNS = 100;

/** Canonical License_Key shape: PDM-XXXX-XXXX-XXXX-XXXX (uppercase hex groups). */
const LICENSE_KEY_RE = /^PDM-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/;

/** A fixed, already-authorized actor context for create Audit_Entries. */
const ACTOR: CreateActor = {
  actor: "admin-1",
  actorRole: "super_admin",
  sourceIp: "203.0.113.7",
};

/** Arbitrary well-formed License_Key (four uppercase-hex groups). */
const wellFormedKeyArb: fc.Arbitrary<string> = fc
  .array(fc.integer({ min: 0, max: 0xffff }), { minLength: 4, maxLength: 4 })
  .map((groups) => `PDM-${groups.map((g) => g.toString(16).toUpperCase().padStart(4, "0")).join("-")}`);

/** Arbitrary already-authorized create input (no expiry to keep it perpetual). */
const createInputArb: fc.Arbitrary<CreateLicenseInput> = fc.record({
  plan: fc.constantFrom("standard", "pro", "enterprise"),
  maxActivations: fc.integer({ min: 1, max: 50 }),
  owner: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
  features: fc.array(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 5 }),
  resellerAccountId: fc.option(fc.string({ minLength: 1, maxLength: 12 }), { nil: undefined }),
});

/** Build a fresh creator wired to an in-memory DynamoDB fake. */
function makeCreator(options?: { generateKey?: () => string; maxKeyAttempts?: number }) {
  const dynamo = new FakeDynamoClient();
  const audit = createAuditLog(dynamo);
  const creator = createLicenseCreator({
    dynamo,
    audit,
    generateKey: options?.generateKey,
    maxKeyAttempts: options?.maxKeyAttempts,
  });
  return { dynamo, creator };
}

/** Read back the persisted License_Keys from the fake table. */
function persistedKeys(dynamo: FakeDynamoClient): string[] {
  return dynamo
    .allItems(LICENSES_TABLE_NAME)
    .map((item: DynamoItem) => item[LICENSE_PARTITION_KEY] as string);
}

describe("Property 7: Generated license keys are unique and well-formed", () => {
  // --- Clause 1: well-formedness of generateLicenseKey() (Req 3.1) ---
  it("generateLicenseKey() always matches PDM-XXXX-XXXX-XXXX-XXXX with uppercase hex", () => {
    fc.assert(
      // The generator takes no input; the fc.integer seed just drives repeated
      // independent draws so the property exercises many fresh keys.
      fc.property(fc.integer(), () => {
        const key = generateLicenseKey();
        assert.match(key, LICENSE_KEY_RE);
      }),
      { numRuns: RUNS }
    );
  });

  it("generateLicenseKey() produces no duplicates across a large batch", () => {
    fc.assert(
      fc.property(fc.integer({ min: 50, max: 500 }), (count) => {
        const keys = new Set<string>();
        for (let i = 0; i < count; i++) {
          const key = generateLicenseKey();
          assert.match(key, LICENSE_KEY_RE);
          keys.add(key);
        }
        assert.strictEqual(keys.size, count, "generated keys must all be distinct");
      }),
      { numRuns: RUNS }
    );
  });

  // --- Clause 2: create(...) persists unique, well-formed keys (Req 3.1, 3.3) ---
  it("createLicenseCreator(...).create(...) writes unique, well-formed keys", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(createInputArb, { minLength: 1, maxLength: 25 }), async (inputs) => {
        const { dynamo, creator } = makeCreator();

        for (const input of inputs) {
          const result = await creator.create(input, ACTOR);
          assert.strictEqual(result.ok, true, "create should succeed for valid input");
          if (result.ok) {
            assert.match(result.value.licenseKey, LICENSE_KEY_RE);
          }
        }

        const keys = persistedKeys(dynamo);
        // Every requested record was written...
        assert.strictEqual(keys.length, inputs.length);
        // ...each key is well-formed...
        for (const key of keys) assert.match(key, LICENSE_KEY_RE);
        // ...and no two records share a key.
        assert.strictEqual(new Set(keys).size, keys.length, "persisted keys must be unique");
      }),
      { numRuns: RUNS }
    );
  });

  // --- Clause 3: a collision triggers bounded regeneration to a distinct key (Req 3.3) ---
  it("regenerates a fresh, distinct key when the first candidate collides", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Two distinct well-formed keys: the first collides, the second is fresh.
        fc.tuple(wellFormedKeyArb, wellFormedKeyArb).filter(([a, b]) => a !== b),
        async ([takenKey, freshKey]) => {
          const { dynamo, creator: seeder } = makeCreator({
            // Seed the table with a record already claiming `takenKey`.
            generateKey: () => takenKey,
          });
          const seeded = await seeder.create({ maxActivations: 1 }, ACTOR);
          assert.strictEqual(seeded.ok, true);

          // Now a generator that returns the duplicate first, then the fresh key.
          const sequence = [takenKey, freshKey];
          let i = 0;
          const generateKey = () => sequence[Math.min(i++, sequence.length - 1)];

          // Reuse the SAME dynamo (so the collision is real) via a new creator.
          const audit = createAuditLog(dynamo);
          const creator = createLicenseCreator({ dynamo, audit, generateKey });

          const result = await creator.create({ maxActivations: 1 }, ACTOR);
          assert.strictEqual(result.ok, true, "create should recover from the collision");
          if (result.ok) {
            // The persisted key is the fresh one, distinct from the collided key.
            assert.strictEqual(result.value.licenseKey, freshKey);
            assert.notStrictEqual(result.value.licenseKey, takenKey);
          }

          const keys = persistedKeys(dynamo);
          assert.deepStrictEqual([...keys].sort(), [takenKey, freshKey].sort());
          assert.strictEqual(new Set(keys).size, 2, "both keys are distinct and unique");
        }
      ),
      { numRuns: RUNS }
    );
  });

  // --- Clause 4: regeneration is BOUNDED — it gives up rather than looping forever (Req 3.3) ---
  it("gives up with key_generation_failed after bounded attempts on persistent collision", async () => {
    await fc.assert(
      fc.asyncProperty(wellFormedKeyArb, async (takenKey) => {
        const { dynamo, creator } = makeCreator({
          // A generator that ALWAYS returns the same (already-taken) key.
          generateKey: () => takenKey,
        });

        // Seed the collision.
        const seeded = await creator.create({ maxActivations: 1 }, ACTOR);
        assert.strictEqual(seeded.ok, true);

        // Every subsequent attempt collides; after DEFAULT_MAX_KEY_ATTEMPTS it fails.
        const result = await creator.create({ maxActivations: 1 }, ACTOR);
        assert.strictEqual(result.ok, false);
        if (!result.ok) {
          assert.strictEqual(result.error.code, "key_generation_failed");
        }

        // Only the single seeded record exists — no overwrite, no extra write.
        assert.strictEqual(persistedKeys(dynamo).length, 1);
      }),
      { numRuns: RUNS }
    );
  });

  // Sanity: DEFAULT_MAX_KEY_ATTEMPTS is a finite, positive bound.
  it("DEFAULT_MAX_KEY_ATTEMPTS is a finite positive bound", () => {
    assert.ok(Number.isInteger(DEFAULT_MAX_KEY_ATTEMPTS) && DEFAULT_MAX_KEY_ATTEMPTS >= 1);
  });
});
