import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  createAuthenticator,
  sha256Hasher,
  FakeTokenVerifier,
  type Principal,
  type Clock,
} from "../lib/auth.ts";
import type { Role } from "../lib/rbac.ts";
import { FakeDynamoClient } from "../lib/dev/in-memory-dynamo.ts";
import { FakeEmailSender } from "../lib/email.ts";

// Feature: admin-reseller-portal, Property 4: MFA-enrollment gate on mutations

const RUNS = 100;
const ADMINS_TABLE = "pdm-portal-admins";
const ROLES: Role[] = ["super_admin", "admin", "reseller"];

/** A fixed clock so OTP issue/verify happen at a single, pinned instant. */
const FIXED_NOW = new Date("2024-01-01T00:00:00.000Z");
const fixedClock: Clock = () => new Date(FIXED_NOW.getTime());

/** Build an authenticator wired entirely to in-memory fakes. */
function makeAuthenticator(otp?: string) {
  const dynamo = new FakeDynamoClient();
  // Pin the partition key so repeated puts update (not duplicate) the record.
  dynamo.registerKeySchema(ADMINS_TABLE, "firebaseUid");
  const auth = createAuthenticator({
    dynamo,
    tokenVerifier: new FakeTokenVerifier(),
    emailSender: new FakeEmailSender(),
    hasher: sha256Hasher,
    now: fixedClock,
    otpGenerator: otp ? () => otp : undefined,
  });
  return { auth, dynamo };
}

/** Arbitrary Principal with a controllable `mfaEnrolled` flag. */
function principalArb(mfaEnrolled: boolean): fc.Arbitrary<Principal> {
  return fc.record({
    identity: fc.string({ minLength: 1, maxLength: 32 }),
    role: fc.constantFrom(...ROLES),
    resellerAccountId: fc.option(fc.string({ minLength: 1, maxLength: 16 }), {
      nil: null,
    }),
    authMethod: fc.constantFrom("firebase" as const, "apikey" as const),
  }).map((p) => ({ ...p, mfaEnrolled }));
}

describe("auth property: MFA-enrollment gate on mutations", () => {
  // Validates: Requirements 1.5
  it("Property 4: an un-enrolled principal is blocked with code 'mfa_required'", () => {
    const { auth } = makeAuthenticator();
    fc.assert(
      fc.property(principalArb(false), (principal) => {
        const outcome = auth.requireMfaEnrolled(principal);
        assert.equal(outcome.ok, false);
        assert.equal(outcome.ok === false && outcome.error.code, "mfa_required");
      }),
      { numRuns: RUNS }
    );
  });

  // Validates: Requirements 1.5
  it("Property 4: an enrolled principal passes the gate (ok)", () => {
    const { auth } = makeAuthenticator();
    fc.assert(
      fc.property(principalArb(true), (principal) => {
        const outcome = auth.requireMfaEnrolled(principal);
        assert.equal(outcome.ok, true);
      }),
      { numRuns: RUNS }
    );
  });

  // Validates: Requirements 1.5
  it("Property 4: the gate is decided solely by mfaEnrolled", () => {
    fc.assert(
      fc.property(fc.boolean(), principalArb(true), (enrolled, base) => {
        const { auth } = makeAuthenticator();
        const principal: Principal = { ...base, mfaEnrolled: enrolled };
        const outcome = auth.requireMfaEnrolled(principal);
        return outcome.ok === enrolled;
      }),
      { numRuns: RUNS }
    );
  });

  // Validates: Requirements 1.5
  it("Property 4 (end-to-end): verifyOtp success flips mfaEnrolled=true and the principal passes the gate", async () => {
    await fc.assert(
      fc.asyncProperty(
        // A valid 6-digit OTP code.
        fc.stringMatching(/^[0-9]{6}$/),
        fc.string({ minLength: 1, maxLength: 24 }),
        fc.constantFrom(...ROLES),
        fc.option(fc.string({ minLength: 1, maxLength: 16 }), { nil: null }),
        async (otp, uid, role, resellerAccountId) => {
          const { auth, dynamo } = makeAuthenticator(otp);

          // Seed an admin that has NOT yet enrolled the OTP factor.
          await dynamo.put({
            TableName: ADMINS_TABLE,
            Item: {
              firebaseUid: uid,
              email: `${uid}@example.test`,
              role,
              resellerAccountId,
              mfaEnrolled: false,
            },
          });

          // Before enrollment the gate blocks a principal built from this record.
          const preGate = auth.requireMfaEnrolled({
            identity: uid,
            role,
            resellerAccountId,
            mfaEnrolled: false,
            authMethod: "firebase",
          });
          assert.equal(preGate.ok, false);

          // Issue an OTP (persists only its hash) then verify the correct code.
          const issued = await auth.requestOtp({ firebaseUid: uid });
          assert.equal(issued.ok, true);

          const verified = await auth.verifyOtp({ firebaseUid: uid, otp });
          assert.equal(verified.ok, true);
          if (verified.ok) {
            // The returned principal is now enrolled...
            assert.equal(verified.value.mfaEnrolled, true);
            // ...and therefore passes the MFA-enrollment gate.
            const postGate = auth.requireMfaEnrolled(verified.value);
            assert.equal(postGate.ok, true);
          }

          // The persisted record reflects the enrollment for later requests.
          const stored = await dynamo.get({
            TableName: ADMINS_TABLE,
            Key: { firebaseUid: uid },
          });
          assert.equal(stored?.mfaEnrolled, true);
        }
      ),
      { numRuns: RUNS }
    );
  });
});
