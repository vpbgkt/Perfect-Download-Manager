import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCustomerField,
  isEmailFormat,
  isCountryCode,
  isPhoneFormat,
  evaluateCustomerProfile,
  MAX_NAME_LENGTH,
  MAX_NOTES_LENGTH,
} from "../lib/licenses/customer.ts";

// These are example/unit tests covering the boundary rows of the design's
// normalization table for Requirement 4. They exercise the pure predicates,
// per-field normalization, and the whole-body evaluation contract directly.

describe("normalizeCustomerField", () => {
  it("customerEmail trims then lowercases, including mixed case (4.2)", () => {
    assert.strictEqual(
      normalizeCustomerField("customerEmail", "  Jane.DOE@Example.COM  "),
      "jane.doe@example.com"
    );
  });

  it("customerCountry trims then uppercases a two-letter code (4.4)", () => {
    assert.strictEqual(normalizeCustomerField("customerCountry", "  us  "), "US");
    assert.strictEqual(normalizeCustomerField("customerCountry", "Gb"), "GB");
  });

  it("customerName trims and collapses each interior whitespace run to one space (4.11)", () => {
    assert.strictEqual(
      normalizeCustomerField("customerName", "  Jane\t\t  \nDoe   Smith  "),
      "Jane Doe Smith"
    );
  });

  it("customerCompany collapses interior whitespace runs to one space (4.11)", () => {
    assert.strictEqual(
      normalizeCustomerField("customerCompany", "Acme    \t  Corp   Ltd"),
      "Acme Corp Ltd"
    );
  });

  it("customerPhone collapses interior whitespace runs to one space (4.11)", () => {
    assert.strictEqual(
      normalizeCustomerField("customerPhone", "  +1   (555)   123   4567  "),
      "+1 (555) 123 4567"
    );
  });

  it("customerNotes trims only, leaving interior whitespace and newlines unchanged (4.12)", () => {
    assert.strictEqual(
      normalizeCustomerField("customerNotes", "  line one\n\n  line   two\t  "),
      "line one\n\n  line   two"
    );
  });

  it("leaves Unicode characters intact while collapsing whitespace for names (4.11)", () => {
    assert.strictEqual(
      normalizeCustomerField("customerName", "  José    Núñez  "),
      "José Núñez"
    );
    // Emoji and combining marks are preserved verbatim.
    assert.strictEqual(
      normalizeCustomerField("customerName", "Zoë   😀   Café"),
      "Zoë 😀 Café"
    );
  });

  it("leaves Unicode characters intact in notes with trim-only normalization (4.12)", () => {
    assert.strictEqual(
      normalizeCustomerField("customerNotes", "  お客様のメモ  😀  "),
      "お客様のメモ  😀"
    );
  });

  it("is a fixed point: normalizing its own output returns that output (4.8)", () => {
    const cases: Array<[Parameters<typeof normalizeCustomerField>[0], string]> = [
      ["customerEmail", "  Jane.DOE@Example.COM  "],
      ["customerCountry", "  us  "],
      ["customerName", "  Jane\t\t  Doe  "],
      ["customerCompany", "Acme    Corp"],
      ["customerPhone", "  +1   (555)  1234567 "],
      ["customerNotes", "  line one\n\n  line   two  "],
    ];
    for (const [field, raw] of cases) {
      const once = normalizeCustomerField(field, raw);
      const twice = normalizeCustomerField(field, once);
      assert.strictEqual(twice, once, `${field} normalization not idempotent`);
    }
  });
});

describe("isEmailFormat", () => {
  it("accepts a simple well-formed address", () => {
    assert.strictEqual(isEmailFormat("jane.doe@example.com"), true);
  });

  it("accepts a 1-character local part and a 3-character domain", () => {
    assert.strictEqual(isEmailFormat("a@a.co"), true);
  });

  it("accepts a Unicode local part with no whitespace", () => {
    assert.strictEqual(isEmailFormat("jösé@example.com"), true);
  });

  it("rejects an empty string", () => {
    assert.strictEqual(isEmailFormat(""), false);
  });

  it("rejects a value longer than 254 characters", () => {
    const local = "a".repeat(250);
    const tooLong = `${local}@ex.com`; // 250 + 1 + 6 = 257
    assert.strictEqual(tooLong.length > 254, true);
    assert.strictEqual(isEmailFormat(tooLong), false);
  });

  it("accepts exactly 254 characters with a 64-char local part", () => {
    const local = "a".repeat(64); // max local part
    const domain = "a".repeat(185) + ".com"; // 189 chars, contains a dot
    const value = `${local}@${domain}`;
    assert.strictEqual(value.length, 254);
    assert.strictEqual(isEmailFormat(value), true);
  });

  it("rejects a local part longer than 64 characters", () => {
    const value = `${"a".repeat(65)}@example.com`;
    assert.strictEqual(isEmailFormat(value), false);
  });

  it("rejects missing @, and more than one @", () => {
    assert.strictEqual(isEmailFormat("janedoe.example.com"), false);
    assert.strictEqual(isEmailFormat("jane@doe@example.com"), false);
  });

  it("rejects a domain shorter than 3 chars or without a dot", () => {
    assert.strictEqual(isEmailFormat("a@bc"), false);
    assert.strictEqual(isEmailFormat("a@example"), false);
  });

  it("rejects a domain that begins or ends with a dot", () => {
    assert.strictEqual(isEmailFormat("a@.example.com"), false);
    assert.strictEqual(isEmailFormat("a@example.com."), false);
  });

  it("rejects any whitespace", () => {
    assert.strictEqual(isEmailFormat("jane doe@example.com"), false);
    assert.strictEqual(isEmailFormat("jane@exa mple.com"), false);
  });
});

describe("isCountryCode", () => {
  it("accepts exactly two uppercase letters", () => {
    assert.strictEqual(isCountryCode("US"), true);
    assert.strictEqual(isCountryCode("GB"), true);
  });

  it("rejects lowercase, one letter, three letters, or digits", () => {
    assert.strictEqual(isCountryCode("us"), false);
    assert.strictEqual(isCountryCode("U"), false);
    assert.strictEqual(isCountryCode("USA"), false);
    assert.strictEqual(isCountryCode("U1"), false);
  });
});

describe("isPhoneFormat", () => {
  it("accepts 7 to 20 chars with at least 7 digits and a single leading +", () => {
    assert.strictEqual(isPhoneFormat("1234567"), true); // exactly 7 chars, 7 digits
    assert.strictEqual(isPhoneFormat("+1 (555) 123-4567"), true);
  });

  it("rejects fewer than 7 characters and fewer than 7 digits", () => {
    assert.strictEqual(isPhoneFormat("123456"), false); // 6 chars
    assert.strictEqual(isPhoneFormat("(1) 234"), false); // 7 chars but only 4 digits
  });

  it("rejects more than 20 characters", () => {
    assert.strictEqual(isPhoneFormat("123456789012345678901"), false); // 21 digits
    assert.strictEqual("123456789012345678901".length, 21);
  });

  it("accepts exactly 20 characters", () => {
    const value = "+123 456 789 0123456"; // 20 chars, >=7 digits
    assert.strictEqual(value.length, 20);
    assert.strictEqual(isPhoneFormat(value), true);
  });

  it("allows the + only as the first character and at most once", () => {
    assert.strictEqual(isPhoneFormat("123+4567"), false); // + not leading
    assert.strictEqual(isPhoneFormat("+12345+67"), false); // two +
  });

  it("rejects disallowed characters", () => {
    assert.strictEqual(isPhoneFormat("1234567a"), false);
    assert.strictEqual(isPhoneFormat("123.456.7"), false); // '.' not allowed
  });
});

describe("evaluateCustomerProfile — length straddles (4.6)", () => {
  it("accepts a customerName of exactly 120 characters and rejects 121", () => {
    const ok = evaluateCustomerProfile({ customerName: "a".repeat(MAX_NAME_LENGTH) });
    assert.deepStrictEqual(ok.errors, []);
    assert.strictEqual(ok.set.customerName, "a".repeat(MAX_NAME_LENGTH));

    const bad = evaluateCustomerProfile({ customerName: "a".repeat(MAX_NAME_LENGTH + 1) });
    assert.strictEqual(bad.errors.length, 1);
    assert.strictEqual(bad.errors[0].field, "customerName");
    assert.strictEqual(bad.set.customerName, undefined);
  });

  it("accepts a customerCompany of exactly 120 characters and rejects 121", () => {
    const ok = evaluateCustomerProfile({ customerCompany: "a".repeat(MAX_NAME_LENGTH) });
    assert.deepStrictEqual(ok.errors, []);
    assert.strictEqual(ok.set.customerCompany, "a".repeat(MAX_NAME_LENGTH));

    const bad = evaluateCustomerProfile({ customerCompany: "a".repeat(MAX_NAME_LENGTH + 1) });
    assert.strictEqual(bad.errors.length, 1);
    assert.strictEqual(bad.errors[0].field, "customerCompany");
  });

  it("accepts a customerNotes of exactly 1000 characters and rejects 1001", () => {
    const ok = evaluateCustomerProfile({ customerNotes: "a".repeat(MAX_NOTES_LENGTH) });
    assert.deepStrictEqual(ok.errors, []);
    assert.strictEqual(ok.set.customerNotes, "a".repeat(MAX_NOTES_LENGTH));

    const bad = evaluateCustomerProfile({ customerNotes: "a".repeat(MAX_NOTES_LENGTH + 1) });
    assert.strictEqual(bad.errors.length, 1);
    assert.strictEqual(bad.errors[0].field, "customerNotes");
  });

  it("measures the straddle against the normalized (collapsed) length for names", () => {
    // A long interior whitespace run collapses to a single space, so a raw
    // string well over 120 chars normalizes to exactly 120 and passes.
    const rawOk = "a".repeat(60) + " ".repeat(20) + "b".repeat(59); // len 139
    const normalizedOk = normalizeCustomerField("customerName", rawOk);
    assert.strictEqual(normalizedOk.length, MAX_NAME_LENGTH);
    const ok = evaluateCustomerProfile({ customerName: rawOk });
    assert.deepStrictEqual(ok.errors, []);
    assert.strictEqual(ok.set.customerName, normalizedOk);

    // One more retained character pushes the normalized form to 121 -> rejected.
    const rawBad = "a".repeat(60) + " ".repeat(20) + "b".repeat(60); // normalizes to 121
    const normalizedBad = normalizeCustomerField("customerName", rawBad);
    assert.strictEqual(normalizedBad.length, MAX_NAME_LENGTH + 1);
    const bad = evaluateCustomerProfile({ customerName: rawBad });
    assert.strictEqual(bad.errors.length, 1);
    assert.strictEqual(bad.errors[0].field, "customerName");
  });
});

describe("evaluateCustomerProfile — normalize-then-validate and Unicode (4.9)", () => {
  it("normalizes mixed-case email and a two-letter country before storing", () => {
    const result = evaluateCustomerProfile({
      customerEmail: "  Jane.DOE@Example.COM  ",
      customerCountry: " gb ",
    });
    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.set.customerEmail, "jane.doe@example.com");
    assert.strictEqual(result.set.customerCountry, "GB");
  });

  it("stores Unicode notes verbatim after trim-only normalization", () => {
    const result = evaluateCustomerProfile({ customerNotes: "  Café ☕ お客様  " });
    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.set.customerNotes, "Café ☕ お客様");
  });

  it("reports every offending field and writes nothing to set", () => {
    const result = evaluateCustomerProfile({
      customerEmail: "not-an-email",
      customerCountry: "USA",
      customerPhone: "12", // too short / too few digits
    });
    const offending = result.errors.map((e) => e.field).sort();
    assert.deepStrictEqual(offending, [
      "customerCountry",
      "customerEmail",
      "customerPhone",
    ]);
    assert.deepStrictEqual(result.set, {});
  });
});

describe("evaluateCustomerProfile — whitespace-only values land in clear (4.13)", () => {
  it("routes whitespace-only, empty, and null values to clear, not errors or set", () => {
    const result = evaluateCustomerProfile({
      customerName: "   \t\n  ",
      customerCompany: "",
      customerEmail: null,
      customerNotes: "\u00a0", // non-breaking space also trims to empty
    });
    assert.deepStrictEqual(result.errors, []);
    assert.deepStrictEqual(result.set, {});
    assert.deepStrictEqual(
      [...result.clear].sort(),
      ["customerCompany", "customerEmail", "customerName", "customerNotes"]
    );
  });

  it("omits absent (undefined / missing) fields from all three collections", () => {
    const result = evaluateCustomerProfile({ customerPhone: undefined });
    assert.deepStrictEqual(result.set, {});
    assert.deepStrictEqual(result.clear, []);
    assert.deepStrictEqual(result.errors, []);
  });
});
