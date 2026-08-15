// Feature: license-key-management-enhancements, Property 20: Collision retry
// keeps the prefix, is bounded at five attempts, and reports the key it wrote.
//
// Property 20: Collision retry keeps the prefix, is bounded at five attempts,
//              and reports the key it wrote
// Validates: Requirements 5.8, 5.9, 5.14
//
// For any Custom_Key_Prefix and for any number of consecutive key collisions,
//   - each retry regenerates only the Key_Secret_Component and leaves the
//     normalized prefix unchanged (Req 5.9),
//   - at most 5 write attempts are made for one create-license request (Req 5.9),
//   - a request whose 5 attempts all collide returns an error stating the
//     License_Record was not created and leaves every item in the
//     Licenses_Table unchanged (Req 5.9), and
//   - a successful request stores the normalized prefix as one additive
//     attribute (Req 5.8) and returns in its response the complete generated
//     License_Key including that prefix (Req 5.14).
//
// The create flow is driven against the in-memory DynamoDB fake with a scripted
// collision sequence: the first N generated keys are pre-seeded into the table
// so their conditional writes collide, then a fresh key succeeds (or, for the
// bounded case, every one of the 5 attempts collides). The persisted state is
// inspected straight off the fake (dump) — the authoritative source of truth.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  createLicenseCreator,
  DEFAULT_MAX_KEY_ATTEMPTS,
  LICENSES_TABLE_NAME,
  LICENSE_PARTITION_KEY,
} from "../lib/licenses/create.ts";
import { createAuditLog } from "../lib/audit.ts";
import { FakeDynamoClient } from "../lib/dev/in-memory-dynamo.ts";

const RUNS = 100;

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("");

/** One alnum segment of 1–6 symbols. */
const segmentArb = fc
  .array(fc.constantFrom(...ALNUM), { minLength: 1, maxLength: 6 })
  .map((chars) => chars.join(""));

/** Already-normalized Custom_Key_Prefix: alnum segments joined by single hyphens. */
const prefixArb = fc
  .array(segmentArb, { minLength: 1, maxLength: 4 })
  .map((segments) => segments.join("-"))
  .filter((p) => p.length >= 1 && p.length <= 32);

/** A prefix that is either an already-normalized value or absent (undefined). */
const optionalPrefixArb = fc.option(prefixArb, { nil: undefined });

/** A Key_Secret_Component stand-in; scripted, so only distinctness matters. */
const secretArb = fc
  .array(fc.constantFrom(...ALNUM), { minLength: 8, maxLength: 16 })
  .map((chars) => chars.join(""));

/** Assemble a License_Key exactly as the generator does: PDM(-PREFIX)-<secret>. */
function buildKey(prefix: string | undefined, secret: string): string {
  return prefix !== undefined && prefix !== ""
    ? `PDM-${prefix}-${secret}`
    : `PDM-${secret}`;
}

/**
 * A scripted key generator that returns one key per attempt, built from the
 * (fixed) prefix argument it is handed and the next scripted secret. It records
 * every prefix argument and every key it produced so the test can prove the
 * prefix stayed fixed and only the secret changed.
 */
function makeScriptedGenerator(secrets: string[]) {
  const prefixSeen: (string | undefined)[] = [];
  const keysProduced: string[] = [];
  let calls = 0;
  const generateKey = (prefix?: string): string => {
    prefixSeen.push(prefix);
    const secret = secrets[Math.min(calls, secrets.length - 1)];
    calls += 1;
    const key = buildKey(prefix, secret);
    keysProduced.push(key);
    return key;
  };
  return {
    generateKey,
    prefixSeen,
    keysProduced,
    get calls() {
      return calls;
    },
  };
}

/** Build a fresh creator wired to an in-memory fake with a scripted generator. */
function makeCreator(generateKey: (prefix?: string) => string) {
  const dynamo = new FakeDynamoClient();
  const audit = createAuditLog(dynamo);
  const creator = createLicenseCreator({ dynamo, audit, generateKey });
  return { dynamo, creator };
}

/** Seed the licenses table with pre-existing records that later writes collide with. */
function seedColliding(dynamo: FakeDynamoClient, keys: string[]): void {
  for (const licenseKey of keys) {
    dynamo.conditionalPut(
      LICENSES_TABLE_NAME,
      { licenseKey, status: "active", plan: "seed", activations: {}, createdAt: "seed" },
      LICENSE_PARTITION_KEY
    );
  }
}

const actor = { actor: "admin-user", actorRole: "admin", sourceIp: "198.51.100.42" };

describe("Property 20: Collision retry keeps the prefix, is bounded at five attempts, and reports the key it wrote", () => {
  it("regenerates only the secret across collisions, then succeeds within the bound, storing the prefix and returning the exact key written (Req 5.8, 5.9, 5.14)", async () => {
    await fc.assert(
      fc.asyncProperty(
        optionalPrefixArb,
        // Collisions strictly below the bound so a fresh key still succeeds.
        fc.integer({ min: 0, max: DEFAULT_MAX_KEY_ATTEMPTS - 1 }),
        // Enough distinct secrets to cover every attempt (colliding + fresh).
        fc.uniqueArray(secretArb, {
          minLength: DEFAULT_MAX_KEY_ATTEMPTS,
          maxLength: DEFAULT_MAX_KEY_ATTEMPTS,
        }),
        fc.integer({ min: 1, max: 100_000 }),
        async (prefix, collisions, secrets, maxActivations) => {
          const collidingSecrets = secrets.slice(0, collisions);
          const freshSecret = secrets[collisions];
          const scriptSecrets = [...collidingSecrets, freshSecret];

          const gen = makeScriptedGenerator(scriptSecrets);
          const { dynamo, creator } = makeCreator(gen.generateKey);

          // Pre-seed exactly the colliding keys so the first N writes fail.
          const collidingKeys = collidingSecrets.map((s) => buildKey(prefix, s));
          seedColliding(dynamo, collidingKeys);

          const freshKey = buildKey(prefix, freshSecret);

          const result = await creator.create({ maxActivations, keyPrefix: prefix }, actor);

          // Succeeds within the bound.
          assert.strictEqual(result.ok, true, "create should succeed once a fresh key is minted");
          if (!result.ok) return;

          // Bounded: exactly one attempt per collision plus the successful one,
          // and never more than the 5-attempt budget (Req 5.9).
          assert.strictEqual(gen.calls, collisions + 1);
          assert.ok(gen.calls <= DEFAULT_MAX_KEY_ATTEMPTS);

          // Prefix stays fixed across every retry — only the secret regenerates
          // (Req 5.9): every prefix argument equals the request's prefix, and
          // every produced key differs only in its secret tail.
          for (const seen of gen.prefixSeen) {
            assert.strictEqual(seen, prefix);
          }
          assert.deepStrictEqual(
            gen.keysProduced,
            scriptSecrets.map((s) => buildKey(prefix, s))
          );

          // Reports the key it wrote (Req 5.14): the returned record carries the
          // exact fresh key, complete with the prefix.
          assert.strictEqual(result.value.licenseKey, freshKey);

          // Stores the normalized prefix as one additive attribute (Req 5.8),
          // and only when a prefix was supplied.
          if (prefix !== undefined) {
            assert.strictEqual(result.value.keyPrefix, prefix);
          } else {
            assert.strictEqual(result.value.keyPrefix, undefined);
          }

          // The persisted record matches what was returned (authoritative state).
          const persisted = dynamo
            .dump(LICENSES_TABLE_NAME)
            .find((item) => item[LICENSE_PARTITION_KEY] === freshKey);
          assert.ok(persisted, "the successfully minted License_Record must be persisted");
          assert.strictEqual(persisted!.keyPrefix, prefix ?? undefined);

          // The colliding keys are untouched (still exactly the seeds).
          for (const key of collidingKeys) {
            const seed = dynamo
              .dump(LICENSES_TABLE_NAME)
              .find((item) => item[LICENSE_PARTITION_KEY] === key);
            assert.ok(seed, "seeded colliding keys must remain present");
            assert.strictEqual(seed!.plan, "seed", "seeded colliding records must be unchanged");
          }
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("returns a not-created error and leaves the Licenses_Table unchanged when all five attempts collide (Req 5.9)", async () => {
    await fc.assert(
      fc.asyncProperty(
        optionalPrefixArb,
        // Every one of the 5 attempts collides.
        fc.uniqueArray(secretArb, {
          minLength: DEFAULT_MAX_KEY_ATTEMPTS,
          maxLength: DEFAULT_MAX_KEY_ATTEMPTS,
        }),
        fc.integer({ min: 1, max: 100_000 }),
        async (prefix, secrets, maxActivations) => {
          const gen = makeScriptedGenerator(secrets);
          const { dynamo, creator } = makeCreator(gen.generateKey);

          // Pre-seed all five keys so every conditional write collides.
          const collidingKeys = secrets.map((s) => buildKey(prefix, s));
          seedColliding(dynamo, collidingKeys);

          // Snapshot the authoritative table state before the doomed create.
          const before = dynamo.dump(LICENSES_TABLE_NAME);

          const result = await creator.create({ maxActivations, keyPrefix: prefix }, actor);

          // Returns an error stating the record was not created (Req 5.9).
          assert.strictEqual(result.ok, false, "create must fail when all attempts collide");

          // Bounded at exactly 5 attempts (Req 5.9).
          assert.strictEqual(gen.calls, DEFAULT_MAX_KEY_ATTEMPTS);

          // Prefix stayed fixed across all attempts — only the secret changed.
          for (const seen of gen.prefixSeen) {
            assert.strictEqual(seen, prefix);
          }

          // Every item in the Licenses_Table is unchanged (Req 5.9).
          const after = dynamo.dump(LICENSES_TABLE_NAME);
          assert.deepStrictEqual(after, before);
        }
      ),
      { numRuns: RUNS }
    );
  });
});
