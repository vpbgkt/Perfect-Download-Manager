/**
 * Property test for OTP lockout after repeated failures (`lib/auth.ts`).
 *
 * Exercises the portal-owned account-lockout gate over the email-OTP second
 * factor: ≥5 failed OTP attempts within a 15-minute window lock the account for
 * ≥15 minutes, and every further `verifyOtp` — even with the correct code — is
 * rejected with `account_locked` during the lock window. Failures spread beyond
 * the 15-minute window never trip the lock (the rolling counter resets), and
 * once the lock window elapses a correct OTP succeeds again.
 *
 * Time is driven by an injected mutable clock so the window/lock boundaries can
 * be crossed deterministically; the stored OTP hash is seeded directly with
 * `sha256Hasher.hash(knownOtp)` and a far-future `otpExpiresAt`.
 *
 * @module test/auth.otp-lockout.property
 */

import { describe, it } from "node:test";
import fc from "fast-check";
import {
  createAuthenticator,
  sha256Hasher,
  FakeTokenVerifier,
  MAX_OTP_FAILURES,
  OTP_FAILURE_WINDOW_MS,
  OTP_LOCK_DURATION_MS,
  type AdminRecord,
} from "../lib/auth.ts";
import { FakeEmailSender } from "../lib/email.ts";
import { FakeDynamoClient } from "../lib/dev/in-memory-dynamo.ts";

// Feature: admin-reseller-portal, Property 6: OTP lockout after repeated failures

const RUNS = 100;
const ADMINS_TABLE = "pdm-portal-admins";

/** Fixed epoch base so all generated timestamps are well-formed ISO dates. */
const BASE_MS = Date.parse("2024-01-01T00:00:00.000Z");
/** Far-future OTP expiry so the seeded code stays valid across all time jumps. */
const FAR_FUTURE_MS = BASE_MS + 10_000 * OTP_LOCK_DURATION_MS;

// ─── Arbitraries ──────────────────────────────────────────────────────────────

/** A well-formed 6-digit OTP code. */
const otpArb = fc
  .integer({ min: 0, max: 999_999 })
  .map((n) => n.toString().padStart(6, "0"));

/** A non-empty Firebase UID usable as the admin partition key. */
const uidArb = fc.uuid();

/** One of the three valid portal roles. */
const roleArb = fc.constantFrom("super_admin", "admin", "reseller") as fc.Arbitrary<
  AdminRecord["role"]
>;

/** A starting epoch time (ms) for the first failed attempt. */
const startMsArb = fc
  .integer({ min: 0, max: 5_000_000 })
  .map((offset) => BASE_MS + offset);

// ─── Harness ──────────────────────────────────────────────────────────────────

interface Harness {
  verifyOtp: (uid: string, otp: string) => ReturnType<
    ReturnType<typeof createAuthenticator>["verifyOtp"]
  >;
  setNow: (ms: number) => void;
}

/**
 * Build an authenticator seeded with a single admin whose pending OTP hash is
 * `sha256Hasher.hash(knownOtp)` with a far-future expiry, wired to a mutable
 * clock. Returns thin accessors for driving `verifyOtp` and advancing time.
 */
function makeHarness(
  uid: string,
  role: AdminRecord["role"],
  knownOtp: string
): Harness {
  const clock = { ms: BASE_MS };
  const fake = new FakeDynamoClient();
  // Identify admin rows by firebaseUid so re-writes overwrite in place.
  fake.registerKeySchema(ADMINS_TABLE, "firebaseUid");

  const record: AdminRecord = {
    firebaseUid: uid,
    email: `${uid}@example.com`,
    role,
    mfaEnrolled: false,
    otpHash: sha256Hasher.hash(knownOtp),
    otpExpiresAt: new Date(FAR_FUTURE_MS).toISOString(),
  };
  // Seed directly (put is fire-and-forget on the in-memory fake).
  void fake.put({ TableName: ADMINS_TABLE, Item: record as unknown as Record<string, unknown> });

  const auth = createAuthenticator({
    dynamo: fake,
    tokenVerifier: new FakeTokenVerifier(),
    emailSender: new FakeEmailSender(),
    now: () => new Date(clock.ms),
  });

  return {
    verifyOtp: (u, otp) => auth.verifyOtp({ firebaseUid: u, otp }),
    setNow: (ms) => {
      clock.ms = ms;
    },
  };
}

/** A 6-digit code guaranteed to differ from `correct`. */
function differentOtp(correct: string, candidate: string): string {
  if (candidate !== correct) return candidate;
  const bumped = (Number(correct) + 1) % 1_000_000;
  return bumped.toString().padStart(6, "0");
}

// ─── Properties ─────────────────────────────────────────────────────────────

describe("auth property: OTP lockout after repeated failures", () => {
  // Validates: Requirements 1.6
  it("Property 6: MAX_OTP_FAILURES failures within the window lock the account and reject the correct OTP", async () => {
    await fc.assert(
      fc.asyncProperty(
        uidArb,
        roleArb,
        otpArb,
        otpArb,
        startMsArb,
        // MAX_OTP_FAILURES ascending offsets, each inside the failure window.
        fc.array(fc.integer({ min: 0, max: OTP_FAILURE_WINDOW_MS }), {
          minLength: MAX_OTP_FAILURES,
          maxLength: MAX_OTP_FAILURES,
        }),
        // How far into the lock window the correct OTP is submitted.
        fc.integer({ min: 0, max: OTP_LOCK_DURATION_MS - 1 }),
        async (uid, role, correctOtp, wrongCandidate, startMs, offsets, lockOffset) => {
          const wrongOtp = differentOtp(correctOtp, wrongCandidate);
          const h = makeHarness(uid, role, correctOtp);
          const deltas = [...offsets].sort((a, b) => a - b);

          // Drive MAX_OTP_FAILURES wrong attempts, all within the window.
          for (const d of deltas) {
            h.setNow(startMs + d);
            const res = await h.verifyOtp(uid, wrongOtp);
            // Each failed attempt is reported as the uniform auth failure.
            if (res.ok) return false;
            if (res.error.code !== "authentication_failed") return false;
          }

          // Now inside the lock window: even the CORRECT OTP is rejected.
          const lockTime = startMs + deltas[deltas.length - 1] + lockOffset;
          h.setNow(lockTime);
          const locked = await h.verifyOtp(uid, correctOtp);
          return locked.ok === false && locked.error.code === "account_locked";
        }
      ),
      { numRuns: RUNS }
    );
  });

  // Validates: Requirements 1.6
  it("Property 6: failures spread beyond the window never lock the account (rolling counter resets)", async () => {
    await fc.assert(
      fc.asyncProperty(
        uidArb,
        roleArb,
        otpArb,
        otpArb,
        startMsArb,
        // Strictly more than MAX_OTP_FAILURES attempts, each > window apart.
        fc.integer({ min: MAX_OTP_FAILURES + 1, max: MAX_OTP_FAILURES + 4 }),
        fc.array(fc.integer({ min: 1, max: OTP_FAILURE_WINDOW_MS }), {
          minLength: MAX_OTP_FAILURES + 4,
          maxLength: MAX_OTP_FAILURES + 4,
        }),
        async (uid, role, correctOtp, wrongCandidate, startMs, count, extraGaps) => {
          const wrongOtp = differentOtp(correctOtp, wrongCandidate);
          const h = makeHarness(uid, role, correctOtp);

          // Space each failure strictly beyond the window from the previous one,
          // so the rolling counter resets to 1 on every attempt.
          let t = startMs;
          for (let i = 0; i < count; i++) {
            if (i > 0) t += OTP_FAILURE_WINDOW_MS + extraGaps[i];
            h.setNow(t);
            const res = await h.verifyOtp(uid, wrongOtp);
            if (res.ok) return false;
            // Never a lock, always the uniform failure — the counter reset.
            if (res.error.code !== "authentication_failed") return false;
          }

          // The account is not locked: the correct OTP still succeeds.
          h.setNow(t + 1);
          const ok = await h.verifyOtp(uid, correctOtp);
          return ok.ok === true && ok.value.mfaEnrolled === true;
        }
      ),
      { numRuns: RUNS }
    );
  });

  // Validates: Requirements 1.6
  it("Property 6: after the lock window elapses the correct OTP succeeds again", async () => {
    await fc.assert(
      fc.asyncProperty(
        uidArb,
        roleArb,
        otpArb,
        otpArb,
        startMsArb,
        fc.array(fc.integer({ min: 0, max: OTP_FAILURE_WINDOW_MS }), {
          minLength: MAX_OTP_FAILURES,
          maxLength: MAX_OTP_FAILURES,
        }),
        // How far past the end of the lock window the correct OTP is retried.
        fc.integer({ min: 1, max: OTP_LOCK_DURATION_MS }),
        async (uid, role, correctOtp, wrongCandidate, startMs, offsets, afterLock) => {
          const wrongOtp = differentOtp(correctOtp, wrongCandidate);
          const h = makeHarness(uid, role, correctOtp);
          const deltas = [...offsets].sort((a, b) => a - b);

          // Trip the lock with MAX_OTP_FAILURES failures inside the window.
          let lastFailureTime = startMs;
          for (const d of deltas) {
            lastFailureTime = startMs + d;
            h.setNow(lastFailureTime);
            const res = await h.verifyOtp(uid, wrongOtp);
            if (res.ok) return false;
          }

          // Confirm the lock is in force mid-window.
          h.setNow(lastFailureTime + 1);
          const stillLocked = await h.verifyOtp(uid, correctOtp);
          if (stillLocked.ok || stillLocked.error.code !== "account_locked") {
            return false;
          }

          // Advance past the lock window end; the correct OTP now succeeds.
          const lockUntil = lastFailureTime + OTP_LOCK_DURATION_MS;
          h.setNow(lockUntil + afterLock);
          const unlocked = await h.verifyOtp(uid, correctOtp);
          return unlocked.ok === true && unlocked.value.mfaEnrolled === true;
        }
      ),
      { numRuns: RUNS }
    );
  });
});
