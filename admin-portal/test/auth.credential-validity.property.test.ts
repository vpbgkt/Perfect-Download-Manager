// Feature: admin-reseller-portal, Property 3: Credential validity gate
//
// Validates: Requirements 1.7, 12.1, 12.2, 15.7
//
// Intent: a request authenticates only when its credential is valid.
//
//  - Interactive (Firebase) requests: an invalid / unregistered / revoked ID
//    token, or an idle-expired session (lastSeenAt older than 30 min =
//    SESSION_IDLE_LIMIT_MS), or a missing/never-opened session is rejected.
//    Only a verified token belonging to an admin with a valid role AND an
//    active, non-idle session yields a Principal (Req 1.7, 15.7).
//  - Api_Key requests: only a key whose SHA-256 hash matches an *active*
//    (non-revoked) key owned by a *non-suspended* reseller authenticates.
//    Missing / malformed / revoked / unknown keys are rejected (Req 12.1, 12.2).
//
// These properties are driven entirely by the in-memory DynamoDB fake, the
// FakeTokenVerifier, and a trivial fake EmailSender, with a fixed injected
// clock, so no live Firebase / DynamoDB / Resend is ever touched.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  createAuthenticator,
  sha256Hasher,
  FakeTokenVerifier,
  SESSION_IDLE_LIMIT_MS,
} from "../lib/auth.ts";
import type { EmailSender } from "../lib/email.ts";
import { validateApiKey } from "../lib/validation.ts";
import { FakeDynamoClient } from "../lib/dev/in-memory-dynamo.ts";

const RUNS = 200;

// Default table names the auth layer reads/writes when `tables` is not overridden.
const ADMINS = "pdm-portal-admins";
const API_KEYS = "pdm-portal-apikeys";
const RESELLERS = "pdm-portal-resellers";

const VALID_ROLES = ["super_admin", "admin", "reseller"] as const;

/** Pinned clock so idle-expiry maths are deterministic. */
const NOW = new Date("2024-06-01T12:00:00.000Z");

/** A no-op email sender — never exercised on these code paths. */
const noopEmailSender: EmailSender = {
  async sendOtp() {
    /* intentionally empty */
  },
};

/** Build a fresh, fully-wired authenticator over an empty in-memory store. */
function makeHarness() {
  const dynamo = new FakeDynamoClient();
  dynamo.registerKeySchema(ADMINS, "firebaseUid");
  dynamo.registerKeySchema(API_KEYS, "apiKeyId");
  dynamo.registerKeySchema(RESELLERS, "resellerAccountId");

  const tokenVerifier = new FakeTokenVerifier();
  const auth = createAuthenticator({
    dynamo,
    tokenVerifier,
    emailSender: noopEmailSender,
    hasher: sha256Hasher,
    now: () => NOW,
  });
  return { dynamo, tokenVerifier, auth };
}

const hexChar = fc.constantFrom(..."0123456789abcdef".split(""));
const hex48 = fc.array(hexChar, { minLength: 48, maxLength: 48 }).map((a) => a.join(""));
/** A well-formed Api_Key: `pdm_ak_` + 48 hex chars. */
const validApiKeyArb = hex48.map((h) => `pdm_ak_${h}`);
/** Assorted malformed keys that must never authenticate. */
const malformedApiKeyArb = fc.oneof(
  fc.constant(""),
  fc.string(),
  fc.array(hexChar, { minLength: 0, maxLength: 47 }).map((a) => `pdm_ak_${a.join("")}`),
  fc.string({ minLength: 1 }).map((s) => `ak_${s}`)
);

// ───────────────────────── Interactive credential gate ───────────────────────

const interactiveScenario = fc.record({
  uid: fc.string({ minLength: 1, maxLength: 24 }),
  idToken: fc.string({ minLength: 1, maxLength: 32 }),
  tokenState: fc.constantFrom("valid", "unregistered", "revoked"),
  adminExists: fc.boolean(),
  role: fc.constantFrom("super_admin", "admin", "reseller", "guest", ""),
  sessionState: fc.constantFrom("fresh", "idle", "absent"),
  freshAgeMs: fc.integer({ min: 0, max: SESSION_IDLE_LIMIT_MS }),
  idleAgeMs: fc.integer({ min: SESSION_IDLE_LIMIT_MS + 1, max: SESSION_IDLE_LIMIT_MS * 5 }),
  resellerAccountId: fc.option(fc.string({ minLength: 1, maxLength: 12 }), { nil: null }),
});

describe("Property 3: Credential validity gate", () => {
  it("interactive: authenticates iff a valid token maps to an admin with a valid role and an active, non-idle session", async () => {
    await fc.assert(
      fc.asyncProperty(interactiveScenario, async (s) => {
        const { dynamo, tokenVerifier, auth } = makeHarness();

        // Seed the token according to its state.
        if (s.tokenState === "valid" || s.tokenState === "revoked") {
          tokenVerifier.setToken(s.idToken, { uid: s.uid });
          if (s.tokenState === "revoked") {
            await tokenVerifier.revokeRefreshTokens(s.uid);
          }
        }

        // Seed the admin record (and its session activity) when present.
        if (s.adminExists) {
          let lastSeenAt: string | undefined;
          if (s.sessionState === "fresh") {
            lastSeenAt = new Date(NOW.getTime() - s.freshAgeMs).toISOString();
          } else if (s.sessionState === "idle") {
            lastSeenAt = new Date(NOW.getTime() - s.idleAgeMs).toISOString();
          } else {
            lastSeenAt = undefined; // never-opened / logged-out session
          }
          await dynamo.put({
            TableName: ADMINS,
            Item: {
              firebaseUid: s.uid,
              email: "admin@example.com",
              role: s.role,
              resellerAccountId: s.resellerAccountId,
              lastSeenAt,
            },
          });
        }

        const result = await auth.authenticate({ idToken: s.idToken });

        const roleOk = (VALID_ROLES as readonly string[]).includes(s.role);
        const expectedOk =
          s.tokenState === "valid" &&
          s.adminExists &&
          roleOk &&
          s.sessionState === "fresh";

        assert.strictEqual(
          result.ok,
          expectedOk,
          `token=${s.tokenState} admin=${s.adminExists} role=${s.role} session=${s.sessionState}`
        );

        if (result.ok) {
          assert.strictEqual(result.value.identity, s.uid);
          assert.strictEqual(result.value.role, s.role);
          assert.strictEqual(result.value.authMethod, "firebase");
        }
      }),
      { numRuns: RUNS }
    );
  });

  it("interactive: never authenticates an invalid, unregistered, or revoked token regardless of session state", async () => {
    const badTokenScenario = fc.record({
      uid: fc.string({ minLength: 1, maxLength: 24 }),
      idToken: fc.string({ minLength: 1, maxLength: 32 }),
      tokenState: fc.constantFrom("unregistered", "revoked"),
      role: fc.constantFrom(...VALID_ROLES),
      freshAgeMs: fc.integer({ min: 0, max: SESSION_IDLE_LIMIT_MS }),
    });
    await fc.assert(
      fc.asyncProperty(badTokenScenario, async (s) => {
        const { dynamo, tokenVerifier, auth } = makeHarness();

        // For "revoked", register then revoke; for "unregistered", never register.
        if (s.tokenState === "revoked") {
          tokenVerifier.setToken(s.idToken, { uid: s.uid });
          await tokenVerifier.revokeRefreshTokens(s.uid);
        }

        // A perfectly fresh, valid-role session — yet the token is bad.
        await dynamo.put({
          TableName: ADMINS,
          Item: {
            firebaseUid: s.uid,
            email: "admin@example.com",
            role: s.role,
            lastSeenAt: new Date(NOW.getTime() - s.freshAgeMs).toISOString(),
          },
        });

        const result = await auth.authenticate({ idToken: s.idToken });
        assert.strictEqual(result.ok, false);
      }),
      { numRuns: RUNS }
    );
  });

  it("interactive: rejects any idle-expired session (lastSeenAt older than SESSION_IDLE_LIMIT_MS) even with a valid token", async () => {
    const idleScenario = fc.record({
      uid: fc.string({ minLength: 1, maxLength: 24 }),
      idToken: fc.string({ minLength: 1, maxLength: 32 }),
      role: fc.constantFrom(...VALID_ROLES),
      idleAgeMs: fc.integer({ min: SESSION_IDLE_LIMIT_MS + 1, max: SESSION_IDLE_LIMIT_MS * 20 }),
    });
    await fc.assert(
      fc.asyncProperty(idleScenario, async (s) => {
        const { dynamo, tokenVerifier, auth } = makeHarness();
        tokenVerifier.setToken(s.idToken, { uid: s.uid });
        await dynamo.put({
          TableName: ADMINS,
          Item: {
            firebaseUid: s.uid,
            email: "admin@example.com",
            role: s.role,
            lastSeenAt: new Date(NOW.getTime() - s.idleAgeMs).toISOString(),
          },
        });

        const result = await auth.authenticate({ idToken: s.idToken });
        assert.strictEqual(result.ok, false);
        if (!result.ok) {
          assert.strictEqual(result.error.code, "session_expired");
        }
      }),
      { numRuns: RUNS }
    );
  });

  // ───────────────────────── Api_Key credential gate ─────────────────────────

  const apiKeyScenario = fc.record({
    apiKey: fc.oneof(validApiKeyArb, malformedApiKeyArb),
    keyState: fc.constantFrom("active", "revoked", "unknown"),
    resellerState: fc.constantFrom("active", "suspended", "missing"),
    apiKeyId: fc.string({ minLength: 1, maxLength: 16 }),
    resellerAccountId: fc.string({ minLength: 1, maxLength: 16 }),
    decoyKey: validApiKeyArb,
  });

  it("api-key: authenticates iff a well-formed key hash matches an active key of an active reseller", async () => {
    await fc.assert(
      fc.asyncProperty(apiKeyScenario, async (s) => {
        const { dynamo, auth } = makeHarness();
        const wellFormed = validateApiKey(s.apiKey).ok;

        if (wellFormed && s.keyState !== "unknown") {
          await dynamo.put({
            TableName: API_KEYS,
            Item: {
              apiKeyId: s.apiKeyId,
              resellerAccountId: s.resellerAccountId,
              secretHash: sha256Hasher.hash(s.apiKey),
              state: s.keyState === "active" ? "active" : "revoked",
            },
          });
        } else if (s.keyState === "unknown") {
          // Seed a decoy key with a deliberately non-matching hash so the GSI
          // lookup finds items but none whose secretHash equals the request's.
          await dynamo.put({
            TableName: API_KEYS,
            Item: {
              apiKeyId: s.apiKeyId,
              resellerAccountId: s.resellerAccountId,
              secretHash: sha256Hasher.hash(`${s.decoyKey}::decoy`),
              state: "active",
            },
          });
        }

        if (s.resellerState !== "missing") {
          await dynamo.put({
            TableName: RESELLERS,
            Item: {
              resellerAccountId: s.resellerAccountId,
              orgName: "Org",
              contactEmail: "contact@example.com",
              state: s.resellerState === "active" ? "active" : "suspended",
            },
          });
        }

        const result = await auth.authenticateApiKey({ apiKey: s.apiKey });

        const keyMatch = wellFormed && s.keyState !== "unknown";
        const keyActive = keyMatch && s.keyState === "active";
        const expectedOk = keyActive && s.resellerState === "active";

        assert.strictEqual(
          result.ok,
          expectedOk,
          `wellFormed=${wellFormed} key=${s.keyState} reseller=${s.resellerState}`
        );

        if (result.ok) {
          assert.strictEqual(result.value.identity, s.apiKeyId);
          assert.strictEqual(result.value.role, "reseller");
          assert.strictEqual(result.value.resellerAccountId, s.resellerAccountId);
          assert.strictEqual(result.value.authMethod, "apikey");
          assert.strictEqual(result.value.mfaEnrolled, true);
        }
      }),
      { numRuns: RUNS }
    );
  });

  it("api-key: rejects malformed keys without ever consulting the store", async () => {
    await fc.assert(
      fc.asyncProperty(malformedApiKeyArb, async (apiKey) => {
        fc.pre(!validateApiKey(apiKey).ok);
        const { auth } = makeHarness();
        const result = await auth.authenticateApiKey({ apiKey });
        assert.strictEqual(result.ok, false);
        if (!result.ok) {
          assert.strictEqual(result.error.code, "authentication_failed");
        }
      }),
      { numRuns: RUNS }
    );
  });

  it("api-key: rejects a revoked key or a suspended reseller even when the hash matches", async () => {
    const rejectionScenario = fc.record({
      apiKey: validApiKeyArb,
      apiKeyId: fc.string({ minLength: 1, maxLength: 16 }),
      resellerAccountId: fc.string({ minLength: 1, maxLength: 16 }),
      // At least one disqualifier: revoked key and/or suspended reseller.
      keyRevoked: fc.boolean(),
      resellerSuspended: fc.boolean(),
    });
    await fc.assert(
      fc.asyncProperty(rejectionScenario, async (s) => {
        fc.pre(s.keyRevoked || s.resellerSuspended);
        const { dynamo, auth } = makeHarness();

        await dynamo.put({
          TableName: API_KEYS,
          Item: {
            apiKeyId: s.apiKeyId,
            resellerAccountId: s.resellerAccountId,
            secretHash: sha256Hasher.hash(s.apiKey),
            state: s.keyRevoked ? "revoked" : "active",
          },
        });
        await dynamo.put({
          TableName: RESELLERS,
          Item: {
            resellerAccountId: s.resellerAccountId,
            orgName: "Org",
            contactEmail: "contact@example.com",
            state: s.resellerSuspended ? "suspended" : "active",
          },
        });

        const result = await auth.authenticateApiKey({ apiKey: s.apiKey });
        assert.strictEqual(result.ok, false);
      }),
      { numRuns: RUNS }
    );
  });
});
