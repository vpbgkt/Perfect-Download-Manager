// Feature: admin-reseller-portal, Property 5: Uniform authentication-failure response
//
// Property 5: Uniform authentication-failure response
// Validates: Requirements 1.3
//
// Intent: every distinct invalid-credential path — an unknown Firebase uid, an
// invalid/rejected Firebase token, a wrong OTP, a malformed OTP, an
// unknown/malformed/revoked Api_Key, and a suspended reseller — must collapse to
// the SAME uniform failure that never discloses which field was wrong. Across
// all of these varied failing inputs the returned error must be byte-for-byte
// the exported `AUTHENTICATION_FAILED` (code "authentication_failed", identical
// message); i.e. the failure is indistinguishable regardless of the specific
// cause.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  createAuthenticator,
  AUTHENTICATION_FAILED,
  FakeTokenVerifier,
  sha256Hasher,
  type AuthOutcome,
  type Principal,
  type AdminRecord,
  type ApiKeyRecord,
  type ResellerAccountRecord,
} from "../lib/auth.ts";
import { FakeEmailSender } from "../lib/email.ts";
import { FakeDynamoClient } from "../lib/dev/in-memory-dynamo.ts";

// ─── Fixtures: table names + pinned clock ─────────────────────────────────────

const TABLES = {
  admins: "pdm-portal-admins",
  apiKeys: "pdm-portal-apikeys",
  resellers: "pdm-portal-resellers",
  apiKeySecretHashIndex: "secretHash-index",
} as const;

/** A pinned instant so no scenario ever drifts into a time-based error branch. */
const NOW = new Date("2024-06-15T12:00:00.000Z");
const clock = () => NOW;

// ─── Scenario descriptors ─────────────────────────────────────────────────────

type Scenario =
  | { kind: "unknownUid"; idToken: string; uid: string }
  | { kind: "invalidToken"; idToken: string }
  | { kind: "wrongOtp"; uid: string; correctOtp: string; submittedOtp: string }
  | { kind: "malformedOtp"; uid: string; submittedOtp: string }
  | { kind: "unknownApiKey"; apiKey: string }
  | { kind: "malformedApiKey"; apiKey: string }
  | { kind: "revokedApiKey"; apiKey: string; apiKeyId: string; resellerAccountId: string }
  | { kind: "suspendedReseller"; apiKey: string; apiKeyId: string; resellerAccountId: string };

/**
 * Build a fresh, fully-isolated authenticator + backing fakes, seed exactly the
 * records the scenario needs to reach its intended failure branch, then execute
 * the matching auth operation and return its outcome.
 */
async function runScenario(scenario: Scenario): Promise<AuthOutcome<Principal | void>> {
  const dynamo = new FakeDynamoClient();
  dynamo.registerKeySchema(TABLES.admins, "firebaseUid");
  dynamo.registerKeySchema(TABLES.apiKeys, "apiKeyId");
  dynamo.registerKeySchema(TABLES.resellers, "resellerAccountId");

  const tokenVerifier = new FakeTokenVerifier();
  const emailSender = new FakeEmailSender();

  const auth = createAuthenticator({
    dynamo,
    tokenVerifier,
    emailSender,
    now: clock,
    tables: TABLES,
  });

  const seedAdmin = async (record: AdminRecord) => {
    await dynamo.put({ TableName: TABLES.admins, Item: record as unknown as Record<string, unknown> });
  };
  const seedApiKey = async (record: ApiKeyRecord) => {
    await dynamo.put({ TableName: TABLES.apiKeys, Item: record as unknown as Record<string, unknown> });
  };
  const seedReseller = async (record: ResellerAccountRecord) => {
    await dynamo.put({ TableName: TABLES.resellers, Item: record as unknown as Record<string, unknown> });
  };

  switch (scenario.kind) {
    case "unknownUid": {
      // Token verifies to a uid that has no admin record.
      tokenVerifier.setToken(scenario.idToken, { uid: scenario.uid });
      return auth.authenticate({ idToken: scenario.idToken });
    }

    case "invalidToken": {
      // Token is not registered → the verifier rejects (throws).
      return auth.authenticate({ idToken: scenario.idToken });
    }

    case "wrongOtp": {
      await seedAdmin({
        firebaseUid: scenario.uid,
        email: `${scenario.uid}@example.com`,
        role: "admin",
        mfaEnrolled: true,
        otpHash: sha256Hasher.hash(scenario.correctOtp),
        otpExpiresAt: new Date(NOW.getTime() + 5 * 60 * 1000).toISOString(),
        failedOtp: 0,
      });
      return auth.verifyOtp({ firebaseUid: scenario.uid, otp: scenario.submittedOtp });
    }

    case "malformedOtp": {
      await seedAdmin({
        firebaseUid: scenario.uid,
        email: `${scenario.uid}@example.com`,
        role: "admin",
        mfaEnrolled: true,
        otpHash: sha256Hasher.hash("123456"),
        otpExpiresAt: new Date(NOW.getTime() + 5 * 60 * 1000).toISOString(),
        failedOtp: 0,
      });
      return auth.verifyOtp({ firebaseUid: scenario.uid, otp: scenario.submittedOtp });
    }

    case "unknownApiKey": {
      // Well-formed key but no matching secretHash row exists.
      return auth.authenticateApiKey({ apiKey: scenario.apiKey });
    }

    case "malformedApiKey": {
      return auth.authenticateApiKey({ apiKey: scenario.apiKey });
    }

    case "revokedApiKey": {
      await seedApiKey({
        apiKeyId: scenario.apiKeyId,
        resellerAccountId: scenario.resellerAccountId,
        secretHash: sha256Hasher.hash(scenario.apiKey),
        state: "revoked",
      });
      // Owning reseller is healthy so the failure is attributable only to the key.
      await seedReseller({
        resellerAccountId: scenario.resellerAccountId,
        orgName: "Org",
        contactEmail: "org@example.com",
        state: "active",
      });
      return auth.authenticateApiKey({ apiKey: scenario.apiKey });
    }

    case "suspendedReseller": {
      await seedApiKey({
        apiKeyId: scenario.apiKeyId,
        resellerAccountId: scenario.resellerAccountId,
        secretHash: sha256Hasher.hash(scenario.apiKey),
        state: "active",
      });
      await seedReseller({
        resellerAccountId: scenario.resellerAccountId,
        orgName: "Org",
        contactEmail: "org@example.com",
        state: "suspended",
      });
      return auth.authenticateApiKey({ apiKey: scenario.apiKey });
    }
  }
}

/** Assert an outcome is exactly the uniform authentication failure. */
function assertUniformFailure(outcome: AuthOutcome<unknown>): void {
  assert.strictEqual(outcome.ok, false, "expected the operation to fail");
  if (outcome.ok) return; // narrows the type
  // Byte-for-byte identical to the exported constant (code + message).
  assert.deepStrictEqual(outcome.error, AUTHENTICATION_FAILED);
  assert.strictEqual(outcome.error.code, "authentication_failed");
  assert.strictEqual(outcome.error.message, AUTHENTICATION_FAILED.message);
}

// ─── Arbitraries ──────────────────────────────────────────────────────────────

const HEX = "0123456789abcdef";
const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

const idArb = fc.string({ unit: fc.constantFrom(...ALNUM), minLength: 1, maxLength: 20 });
const hex48Arb = fc.string({ unit: fc.constantFrom(...HEX), minLength: 48, maxLength: 48 });
const validApiKeyArb = hex48Arb.map((h) => `pdm_ak_${h}`);
const otp6Arb = fc.integer({ min: 0, max: 999999 }).map((n) => String(n).padStart(6, "0"));

/** Two distinct well-formed 6-digit codes (correct vs. submitted). */
const wrongOtpPairArb = fc
  .tuple(otp6Arb, otp6Arb)
  .filter(([correct, submitted]) => correct !== submitted);

/** Any string that is NOT a well-formed 6-digit OTP. */
const malformedOtpArb = fc.string({ maxLength: 12 }).filter((s) => !/^\d{6}$/.test(s.trim()));

/** Any string that is NOT a well-formed Api_Key. */
const malformedApiKeyArb = fc
  .string({ maxLength: 60 })
  .filter((s) => !/^pdm_ak_[0-9a-f]{48}$/.test(s.trim()));

const scenarioArb: fc.Arbitrary<Scenario> = fc.oneof(
  fc.record({ kind: fc.constant("unknownUid" as const), idToken: idArb, uid: idArb }),
  fc.record({ kind: fc.constant("invalidToken" as const), idToken: fc.string() }),
  fc.record({
    kind: fc.constant("wrongOtp" as const),
    uid: idArb,
    pair: wrongOtpPairArb,
  }).map(({ kind, uid, pair }) => ({
    kind,
    uid,
    correctOtp: pair[0],
    submittedOtp: pair[1],
  })),
  fc.record({ kind: fc.constant("malformedOtp" as const), uid: idArb, submittedOtp: malformedOtpArb }),
  fc.record({ kind: fc.constant("unknownApiKey" as const), apiKey: validApiKeyArb }),
  fc.record({ kind: fc.constant("malformedApiKey" as const), apiKey: malformedApiKeyArb }),
  fc.record({
    kind: fc.constant("revokedApiKey" as const),
    apiKey: validApiKeyArb,
    apiKeyId: idArb,
    resellerAccountId: idArb,
  }),
  fc.record({
    kind: fc.constant("suspendedReseller" as const),
    apiKey: validApiKeyArb,
    apiKeyId: idArb,
    resellerAccountId: idArb,
  })
);

// ─── The property ─────────────────────────────────────────────────────────────

describe("Property 5: Uniform authentication-failure response", () => {
  it("every distinct invalid-credential path returns byte-for-byte AUTHENTICATION_FAILED", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const outcome = await runScenario(scenario);
        assertUniformFailure(outcome);
      }),
      { numRuns: 200 }
    );
  });

  it("all invalid-credential paths are mutually indistinguishable (identical error)", async () => {
    await fc.assert(
      fc.asyncProperty(
        idArb,
        idArb,
        wrongOtpPairArb,
        malformedOtpArb,
        validApiKeyArb,
        malformedApiKeyArb,
        idArb,
        idArb,
        async (uid, uid2, [correct, submitted], badOtp, apiKey, badKey, apiKeyId, resellerId) => {
          const scenarios: Scenario[] = [
            { kind: "unknownUid", idToken: `tok-${uid}`, uid },
            { kind: "invalidToken", idToken: `unregistered-${uid2}` },
            { kind: "wrongOtp", uid, correctOtp: correct, submittedOtp: submitted },
            { kind: "malformedOtp", uid, submittedOtp: badOtp },
            { kind: "unknownApiKey", apiKey },
            { kind: "malformedApiKey", apiKey: badKey },
            { kind: "revokedApiKey", apiKey, apiKeyId, resellerAccountId: resellerId },
            { kind: "suspendedReseller", apiKey, apiKeyId, resellerAccountId: resellerId },
          ];

          const errors = [];
          for (const scenario of scenarios) {
            const outcome = await runScenario(scenario);
            assertUniformFailure(outcome);
            assert.strictEqual(outcome.ok, false);
            if (!outcome.ok) errors.push(outcome.error);
          }

          // Pairwise indistinguishability: every error equals every other error.
          for (const error of errors) {
            assert.deepStrictEqual(error, errors[0]);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
