// Feature: admin-reseller-portal, Property 28: Audit entries never contain secrets
//
// For any Mutation, no field of the resulting Audit_Entry contains a Signing_Key,
// an Api_Key plaintext secret, a password, or an MFA/OTP secret — including
// secrets nested anywhere inside the changes map. Non-secret fields and
// identifiers such as apiKeyId are preserved.
//
// Validates: Requirements 11.6, 13.5, 15.1

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { createAuditLog, isSecretKey, AUDIT_TABLE_NAME } from "../lib/audit.ts";
import { FakeDynamoClient } from "../lib/dev/in-memory-dynamo.ts";

const RUNS = 100;

/**
 * A recognizable sentinel embedded in every generated secret value. It must
 * never survive into a persisted audit entry, so the test can detect leakage
 * even if a secret value ends up somewhere unexpected.
 */
const SECRET_SENTINEL = "S3CR3T_SENTINEL_DO_NOT_PERSIST";

/** Attribute names that MUST be scrubbed (each matched by lib/audit's markers). */
const SECRET_KEYS = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "otp",
  "mfa",
  "mfaSecret",
  "otpCode",
  "signingKey",
  "privateKey",
  "apiKeyPlaintext",
  "plaintextSecret",
] as const;

/** Attribute names that must survive scrubbing untouched (no secret markers). */
const SAFE_KEYS = [
  "status",
  "maxActivations",
  "plan",
  "email",
  "apiKeyId", // identifier, NOT a secret — must be preserved
  "note",
  "region",
  "tier",
  "expiresAt",
] as const;

// A secret value always carries the sentinel so leakage is detectable.
const secretValueArb = fc
  .string()
  .map((s) => `${SECRET_SENTINEL}:${s}`);

// A safe (non-secret) value never contains the sentinel.
const safeValueArb = fc.oneof(
  fc.string().filter((s) => !s.includes(SECRET_SENTINEL)),
  fc.integer(),
  fc.boolean()
);

const secretKeyArb = fc.constantFrom(...SECRET_KEYS);
const safeKeyArb = fc.constantFrom(...SAFE_KEYS);

/**
 * A nested object where the "secretness" of every value is tied to its key:
 * secret-named keys always carry a sentinel-bearing secret value, while
 * safe-named keys carry only safe (non-sentinel) values or further nested safe
 * payloads. This mirrors the code's contract — secrets are identified by key
 * name (isSecretKey), so a sentinel must never appear under a non-secret key.
 */
function nestedPayloadArb(depth: number): fc.Arbitrary<Record<string, unknown>> {
  const safeLeaf = depth <= 0 ? safeValueArb : fc.oneof(safeValueArb, nestedPayloadArb(depth - 1));
  return fc
    .record({
      safe: fc.dictionary(safeKeyArb, safeLeaf, { maxKeys: 3 }),
      secret: fc.dictionary(secretKeyArb, secretValueArb, { maxKeys: 3 }),
    })
    .map(({ safe, secret }) => ({ ...safe, ...secret }));
}

// A single change carrying safe values under safe keys and sentinel-bearing
// secret values under secret keys (at arbitrary depth).
const changeArb = fc.record({
  before: nestedPayloadArb(2),
  after: nestedPayloadArb(2),
});

// The changes map: keys are a mix of safe and secret names.
const changesArb = fc.dictionary(fc.oneof(safeKeyArb, secretKeyArb), changeArb, {
  minKeys: 0,
  maxKeys: 6,
});

// A full audit entry input seeded with secret-bearing changes.
const auditInputArb = fc.record({
  actor: fc.string({ minLength: 1 }),
  actorRole: fc.constantFrom("super_admin", "admin", "reseller"),
  action: fc.constantFrom(
    "license.create",
    "license.status.update",
    "apikey.create",
    "reseller.suspend"
  ),
  target: fc.string({ minLength: 1 }),
  sourceIp: fc.constantFrom("127.0.0.1", "10.0.0.1", "203.0.113.5"),
  changes: changesArb,
});

/** Walk every key/value in a value tree, invoking `visit` on each object key. */
function walk(value: unknown, visit: (key: string, val: unknown) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      visit(k, v);
      walk(v, visit);
    }
  }
}

/** Collect every string value found anywhere in a value tree. */
function collectStrings(value: unknown, acc: string[] = []): string[] {
  if (typeof value === "string") acc.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, acc);
  else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectStrings(v, acc);
    }
  }
  return acc;
}

describe("Property 28: audit entries never contain secrets", () => {
  it("persists no secret-bearing keys or values after writeAuditEntry", async () => {
    await fc.assert(
      fc.asyncProperty(auditInputArb, async (input) => {
        const fake = new FakeDynamoClient();
        const audit = createAuditLog(fake, {
          now: () => "2024-01-01T00:00:00.000Z",
          generateId: () => "fixed-id-1",
        });

        const returned = await audit.writeAuditEntry(input);
        const [persisted] = fake.dump(AUDIT_TABLE_NAME);
        assert.ok(persisted, "an entry must be persisted");

        // Both the returned value and the stored item must be secret-free.
        for (const subject of [returned, persisted]) {
          // (1) No object key anywhere is a secret key.
          walk(subject, (key) => {
            assert.strictEqual(
              isSecretKey(key),
              false,
              `secret-bearing key survived: ${key}`
            );
          });

          // (2) No string value anywhere contains the secret sentinel.
          for (const s of collectStrings(subject)) {
            assert.ok(
              !s.includes(SECRET_SENTINEL),
              `secret value survived scrubbing: ${s}`
            );
          }
        }
      }),
      { numRuns: RUNS }
    );
  });

  it("preserves non-secret fields and the apiKeyId identifier", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }).filter((s) => !s.includes(SECRET_SENTINEL)),
        safeValueArb,
        secretValueArb,
        async (apiKeyId, safeVal, secretVal) => {
          const fake = new FakeDynamoClient();
          const audit = createAuditLog(fake, {
            now: () => "2024-01-01T00:00:00.000Z",
            generateId: () => "fixed-id-2",
          });

          const input = {
            actor: "admin-1",
            actorRole: "admin",
            action: "apikey.create",
            target: "target-1",
            sourceIp: "127.0.0.1",
            changes: {
              // Non-secret change carrying an identifier — must be preserved.
              apiKeyId: { before: null, after: { apiKeyId, status: safeVal } },
              // Secret change — must be dropped entirely.
              apiKeyPlaintext: { before: null, after: secretVal },
            },
          };

          const returned = await audit.writeAuditEntry(input);
          const [persisted] = fake.dump(AUDIT_TABLE_NAME);

          // Identifier and its nested safe value are preserved.
          const changes = persisted.changes as Record<string, unknown>;
          assert.ok("apiKeyId" in changes, "apiKeyId change must be preserved");
          const after = (changes.apiKeyId as { after: Record<string, unknown> })
            .after;
          assert.strictEqual(after.apiKeyId, apiKeyId);
          assert.deepStrictEqual(after.status, safeVal);

          // The secret-named change is gone from both views.
          assert.ok(!("apiKeyPlaintext" in changes));
          assert.ok(!("apiKeyPlaintext" in (returned.changes as object)));

          // No sentinel leaked anywhere.
          for (const s of collectStrings(persisted)) {
            assert.ok(!s.includes(SECRET_SENTINEL));
          }
        }
      ),
      { numRuns: RUNS }
    );
  });
});
