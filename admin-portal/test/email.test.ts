import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeEmailSender, ResendEmailSender, type EmailSender } from "../lib/email.ts";

describe("lib/email", () => {
  describe("FakeEmailSender", () => {
    it("implements the EmailSender interface", () => {
      const sender: EmailSender = new FakeEmailSender();
      assert.ok(sender);
      assert.strictEqual(typeof sender.sendOtp, "function");
    });

    it("captures sent OTP messages", async () => {
      const sender = new FakeEmailSender();
      await sender.sendOtp("user@example.com", "123456");

      assert.strictEqual(sender.sent.length, 1);
      assert.strictEqual(sender.sent[0].to, "user@example.com");
      assert.strictEqual(sender.sent[0].otp, "123456");
      assert.ok(sender.sent[0].sentAt instanceof Date);
    });

    it("lastMessage returns the most recent send", async () => {
      const sender = new FakeEmailSender();
      await sender.sendOtp("a@test.com", "111111");
      await sender.sendOtp("b@test.com", "222222");

      const last = sender.lastMessage();
      assert.strictEqual(last?.to, "b@test.com");
      assert.strictEqual(last?.otp, "222222");
    });

    it("lastMessage returns undefined when nothing has been sent", () => {
      const sender = new FakeEmailSender();
      assert.strictEqual(sender.lastMessage(), undefined);
    });

    it("clear resets captured messages", async () => {
      const sender = new FakeEmailSender();
      await sender.sendOtp("user@example.com", "000000");
      assert.strictEqual(sender.sent.length, 1);

      sender.clear();
      assert.strictEqual(sender.sent.length, 0);
      assert.strictEqual(sender.lastMessage(), undefined);
    });

    it("sendOtp resolves without throwing", async () => {
      const sender = new FakeEmailSender();
      await assert.doesNotReject(() => sender.sendOtp("x@y.com", "999999"));
    });
  });

  describe("ResendEmailSender", () => {
    it("throws when no API key is available", () => {
      // Ensure env var is not set for this test
      const original = process.env.RESEND_API_KEY;
      delete process.env.RESEND_API_KEY;

      assert.throws(
        () => {
          new ResendEmailSender();
        },
        /missing Resend API key/
      );

      // Restore
      if (original !== undefined) {
        process.env.RESEND_API_KEY = original;
      }
    });
  });
});
