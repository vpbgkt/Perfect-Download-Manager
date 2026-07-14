import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateLicenseKey,
  validateMaxActivations,
  validateIso8601Utc,
  validateStatus,
  validateReleaseUrl,
  validateChecksum,
  validateSeoTitle,
  validateSeoDescription,
  validateApiKey,
  validateEmailOtp,
} from "../lib/validation.ts";

describe("validateLicenseKey", () => {
  it("accepts a valid license key", () => {
    const result = validateLicenseKey("PDM-ABCD-1234-EF56-7890");
    assert.deepStrictEqual(result, { ok: true, value: "PDM-ABCD-1234-EF56-7890" });
  });

  it("rejects lowercase hex", () => {
    const result = validateLicenseKey("PDM-abcd-1234-ef56-7890");
    assert.strictEqual(result.ok, false);
  });

  it("rejects missing prefix", () => {
    const result = validateLicenseKey("ABC-ABCD-1234-EF56-7890");
    assert.strictEqual(result.ok, false);
  });

  it("rejects wrong group count", () => {
    const result = validateLicenseKey("PDM-ABCD-1234-EF56");
    assert.strictEqual(result.ok, false);
  });

  it("rejects non-string input", () => {
    const result = validateLicenseKey(12345);
    assert.strictEqual(result.ok, false);
  });

  it("trims whitespace", () => {
    const result = validateLicenseKey("  PDM-AAAA-BBBB-CCCC-DDDD  ");
    assert.deepStrictEqual(result, { ok: true, value: "PDM-AAAA-BBBB-CCCC-DDDD" });
  });
});

describe("validateMaxActivations", () => {
  it("accepts integer >= 1", () => {
    assert.deepStrictEqual(validateMaxActivations(1), { ok: true, value: 1 });
    assert.deepStrictEqual(validateMaxActivations(100), { ok: true, value: 100 });
  });

  it("rejects zero", () => {
    assert.strictEqual(validateMaxActivations(0).ok, false);
  });

  it("rejects negative numbers", () => {
    assert.strictEqual(validateMaxActivations(-5).ok, false);
  });

  it("rejects non-integers", () => {
    assert.strictEqual(validateMaxActivations(1.5).ok, false);
  });

  it("rejects NaN", () => {
    assert.strictEqual(validateMaxActivations(NaN).ok, false);
  });

  it("rejects Infinity", () => {
    assert.strictEqual(validateMaxActivations(Infinity).ok, false);
  });

  it("rejects string input", () => {
    assert.strictEqual(validateMaxActivations("5").ok, false);
  });
});

describe("validateIso8601Utc", () => {
  it("accepts valid UTC timestamp with Z", () => {
    const result = validateIso8601Utc("2024-06-15T10:30:00Z");
    assert.deepStrictEqual(result, { ok: true, value: "2024-06-15T10:30:00Z" });
  });

  it("accepts fractional seconds", () => {
    const result = validateIso8601Utc("2024-01-01T00:00:00.123Z");
    assert.deepStrictEqual(result, { ok: true, value: "2024-01-01T00:00:00.123Z" });
  });

  it("accepts +00:00 offset", () => {
    const result = validateIso8601Utc("2024-03-20T15:45:30+00:00");
    assert.deepStrictEqual(result, { ok: true, value: "2024-03-20T15:45:30+00:00" });
  });

  it("rejects non-UTC offsets", () => {
    assert.strictEqual(validateIso8601Utc("2024-03-20T15:45:30+05:30").ok, false);
  });

  it("rejects date-only", () => {
    assert.strictEqual(validateIso8601Utc("2024-01-01").ok, false);
  });

  it("rejects invalid dates like month 13", () => {
    assert.strictEqual(validateIso8601Utc("2024-13-01T00:00:00Z").ok, false);
  });

  it("rejects non-string input", () => {
    assert.strictEqual(validateIso8601Utc(1234567890).ok, false);
  });
});

describe("validateStatus", () => {
  it("accepts 'active'", () => {
    assert.deepStrictEqual(validateStatus("active"), { ok: true, value: "active" });
  });

  it("accepts 'revoked'", () => {
    assert.deepStrictEqual(validateStatus("revoked"), { ok: true, value: "revoked" });
  });

  it("accepts 'suspended'", () => {
    assert.deepStrictEqual(validateStatus("suspended"), { ok: true, value: "suspended" });
  });

  it("rejects other strings", () => {
    assert.strictEqual(validateStatus("deleted").ok, false);
    assert.strictEqual(validateStatus("ACTIVE").ok, false);
  });

  it("rejects non-string input", () => {
    assert.strictEqual(validateStatus(null).ok, false);
  });
});

describe("validateReleaseUrl", () => {
  it("accepts virtual-hosted style URL", () => {
    const url = "https://pdm-updates-452359090613-aps1.s3.amazonaws.com/v1.2.3/installer.msi";
    assert.deepStrictEqual(validateReleaseUrl(url), { ok: true, value: url });
  });

  it("accepts virtual-hosted with region", () => {
    const url = "https://pdm-updates-452359090613-aps1.s3.ap-south-1.amazonaws.com/v1.2.3/installer.msi";
    assert.deepStrictEqual(validateReleaseUrl(url), { ok: true, value: url });
  });

  it("accepts path-style URL", () => {
    const url = "https://s3.amazonaws.com/pdm-updates-452359090613-aps1/v1.2.3/installer.msi";
    assert.deepStrictEqual(validateReleaseUrl(url), { ok: true, value: url });
  });

  it("accepts path-style with region", () => {
    const url = "https://s3.ap-south-1.amazonaws.com/pdm-updates-452359090613-aps1/v1.2.3/installer.msi";
    assert.deepStrictEqual(validateReleaseUrl(url), { ok: true, value: url });
  });

  it("rejects HTTP URLs", () => {
    const url = "http://pdm-updates-452359090613-aps1.s3.amazonaws.com/file.msi";
    assert.strictEqual(validateReleaseUrl(url).ok, false);
  });

  it("rejects wrong bucket", () => {
    const url = "https://other-bucket.s3.amazonaws.com/file.msi";
    assert.strictEqual(validateReleaseUrl(url).ok, false);
  });

  it("rejects non-S3 URLs", () => {
    const url = "https://example.com/file.msi";
    assert.strictEqual(validateReleaseUrl(url).ok, false);
  });

  it("rejects non-string input", () => {
    assert.strictEqual(validateReleaseUrl(123).ok, false);
  });
});

describe("validateChecksum", () => {
  it("accepts a valid 64-char hex string", () => {
    const hex = "a".repeat(64);
    assert.deepStrictEqual(validateChecksum(hex), { ok: true, value: hex });
  });

  it("normalizes to lowercase", () => {
    const upper = "A".repeat(64);
    assert.deepStrictEqual(validateChecksum(upper), { ok: true, value: "a".repeat(64) });
  });

  it("rejects too-short strings", () => {
    assert.strictEqual(validateChecksum("abc123").ok, false);
  });

  it("rejects too-long strings", () => {
    assert.strictEqual(validateChecksum("a".repeat(65)).ok, false);
  });

  it("rejects non-hex characters", () => {
    assert.strictEqual(validateChecksum("g".repeat(64)).ok, false);
  });

  it("rejects non-string input", () => {
    assert.strictEqual(validateChecksum(null).ok, false);
  });
});

describe("validateSeoTitle", () => {
  it("accepts title between 1 and 70 chars", () => {
    assert.deepStrictEqual(validateSeoTitle("Hello World"), { ok: true, value: "Hello World" });
  });

  it("accepts 1-character title", () => {
    assert.strictEqual(validateSeoTitle("A").ok, true);
  });

  it("accepts 70-character title", () => {
    assert.strictEqual(validateSeoTitle("x".repeat(70)).ok, true);
  });

  it("rejects empty string", () => {
    assert.strictEqual(validateSeoTitle("").ok, false);
  });

  it("rejects whitespace-only string (trimmed to empty)", () => {
    assert.strictEqual(validateSeoTitle("   ").ok, false);
  });

  it("rejects 71+ characters", () => {
    assert.strictEqual(validateSeoTitle("x".repeat(71)).ok, false);
  });

  it("rejects non-string input", () => {
    assert.strictEqual(validateSeoTitle(42).ok, false);
  });
});

describe("validateSeoDescription", () => {
  it("accepts description between 50 and 160 chars", () => {
    const desc = "x".repeat(100);
    assert.deepStrictEqual(validateSeoDescription(desc), { ok: true, value: desc });
  });

  it("accepts exactly 50 characters", () => {
    assert.strictEqual(validateSeoDescription("x".repeat(50)).ok, true);
  });

  it("accepts exactly 160 characters", () => {
    assert.strictEqual(validateSeoDescription("x".repeat(160)).ok, true);
  });

  it("rejects 49 characters", () => {
    assert.strictEqual(validateSeoDescription("x".repeat(49)).ok, false);
  });

  it("rejects 161 characters", () => {
    assert.strictEqual(validateSeoDescription("x".repeat(161)).ok, false);
  });

  it("rejects non-string input", () => {
    assert.strictEqual(validateSeoDescription(undefined).ok, false);
  });
});

describe("validateApiKey", () => {
  it("accepts a valid API key", () => {
    const key = "pdm_ak_" + "a1b2c3d4".repeat(6);
    assert.deepStrictEqual(validateApiKey(key), { ok: true, value: key });
  });

  it("rejects missing prefix", () => {
    const key = "abc_ak_" + "a".repeat(48);
    assert.strictEqual(validateApiKey(key).ok, false);
  });

  it("rejects wrong length after prefix", () => {
    const key = "pdm_ak_" + "a".repeat(47);
    assert.strictEqual(validateApiKey(key).ok, false);
  });

  it("rejects uppercase hex in secret part", () => {
    const key = "pdm_ak_" + "A".repeat(48);
    assert.strictEqual(validateApiKey(key).ok, false);
  });

  it("rejects non-hex characters", () => {
    const key = "pdm_ak_" + "g".repeat(48);
    assert.strictEqual(validateApiKey(key).ok, false);
  });

  it("rejects non-string input", () => {
    assert.strictEqual(validateApiKey(undefined).ok, false);
  });
});

describe("validateEmailOtp", () => {
  it("accepts a valid 6-digit OTP", () => {
    assert.deepStrictEqual(validateEmailOtp("123456"), { ok: true, value: "123456" });
  });

  it("accepts all zeros", () => {
    assert.deepStrictEqual(validateEmailOtp("000000"), { ok: true, value: "000000" });
  });

  it("rejects 5 digits", () => {
    assert.strictEqual(validateEmailOtp("12345").ok, false);
  });

  it("rejects 7 digits", () => {
    assert.strictEqual(validateEmailOtp("1234567").ok, false);
  });

  it("rejects letters", () => {
    assert.strictEqual(validateEmailOtp("12345a").ok, false);
  });

  it("rejects non-string input", () => {
    assert.strictEqual(validateEmailOtp(123456).ok, false);
  });

  it("trims whitespace", () => {
    assert.deepStrictEqual(validateEmailOtp("  654321  "), { ok: true, value: "654321" });
  });
});
