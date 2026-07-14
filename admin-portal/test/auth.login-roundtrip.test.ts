// Feature: admin-reseller-portal, task 4.8 login round-trip unit tests
//
// Mocked Firebase Admin SDK verify + mocked Resend EmailSender:
//   verified token -> OTP requested -> OTP verified -> session opened;
//   logout invalidates the credential; an unauthenticated request is rejected
//   (the Next middleware turns this rejection into a login redirect).
//
// Requirements: 1.1, 1.2, 1.8

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeDynamoClient } from "../lib/dev/in-memory-dynamo.ts";
import {
  createAuthenticator,
  FakeTokenVerifier,
  type AdminRecord,
} from "../lib/auth.ts";
import { FakeEmailSender } from "../lib/email.ts";

const ADMINS_TABLE = "pdm-portal-admins";

function setup() {
  const dynamo = new FakeDynamoClient();
  dynamo.registerKeySchema(ADMINS_TABLE, "firebaseUid");
  const tokenVerifier = new FakeTokenVerifier();
  const emailSender = new FakeEmailSender();
  const clock = { ms: Date.parse("2025-06-15T12:00:00.000Z") };
  const auth = createAuthenticator({
    dynamo,
    tokenVerifier,
    emailSender,
    now: () => new Date(clock.ms),
  });

  const admin: AdminRecord = {
    firebaseUid: "uid-1",
    email: "admin@example.com",
    role: "admin",
    mfaEnrolled: false,
  };
  void dynamo.put({ TableName: ADMINS_TABLE, Item: admin as unknown as Record<string, unknown> });
  tokenVerifier.setToken("valid-token", { uid: "uid-1" });

  return { dynamo, tokenVerifier, emailSender, auth, clock };
}

describe("login round-trip (Req 1.1, 1.2, 1.8)", () => {
  it("verified token -> OTP requested -> OTP verified -> session opened", async () => {
    const { auth, emailSender } = setup();

    // 1. OTP requested (login initiates the email-OTP challenge).
    const requested = await auth.requestOtp({ firebaseUid: "uid-1" });
    assert.strictEqual(requested.ok, true);
    const msg = emailSender.lastMessage();
    assert.ok(msg, "an OTP email should have been sent");
    assert.strictEqual(msg?.to, "admin@example.com");
    const otp = msg!.otp;

    // 2. OTP verified -> session opened, factor enrolled.
    const verified = await auth.verifyOtp({ firebaseUid: "uid-1", otp });
    assert.strictEqual(verified.ok, true);
    if (verified.ok) {
      assert.strictEqual(verified.value.role, "admin");
      assert.strictEqual(verified.value.mfaEnrolled, true);
    }

    // 3. Subsequent request with the verified Firebase token now authenticates.
    const authed = await auth.authenticate({ idToken: "valid-token" });
    assert.strictEqual(authed.ok, true);
    if (authed.ok) assert.strictEqual(authed.value.identity, "uid-1");
  });

  it("logout invalidates the credential; later requests are rejected", async () => {
    const { auth, emailSender } = setup();
    await auth.requestOtp({ firebaseUid: "uid-1" });
    await auth.verifyOtp({ firebaseUid: "uid-1", otp: emailSender.lastMessage()!.otp });

    // Session is active before logout.
    assert.strictEqual((await auth.authenticate({ idToken: "valid-token" })).ok, true);

    // Logout revokes the refresh token and clears the session-activity record.
    const out = await auth.logout({ firebaseUid: "uid-1" });
    assert.strictEqual(out.ok, true);

    // The same token is now rejected (revoked + no active session).
    const after = await auth.authenticate({ idToken: "valid-token" });
    assert.strictEqual(after.ok, false);
  });

  it("an unauthenticated request (unknown/invalid token) is rejected", async () => {
    const { auth } = setup();
    const res = await auth.authenticate({ idToken: "no-such-token" });
    assert.strictEqual(res.ok, false);
    if (!res.ok) assert.strictEqual(res.error.code, "authentication_failed");
  });

  it("a valid token with no opened session is treated as unauthenticated", async () => {
    // No OTP verification has occurred, so there is no session-activity record.
    const { auth } = setup();
    const res = await auth.authenticate({ idToken: "valid-token" });
    assert.strictEqual(res.ok, false);
    if (!res.ok) assert.strictEqual(res.error.code, "session_expired");
  });
});
