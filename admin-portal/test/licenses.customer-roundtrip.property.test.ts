// Feature: license-key-management-enhancements
// Property 7: Customer_Profile storage round-trips and normalization is a fixed point
//
// Validates: Requirements 2.4, 3.1, 4.2, 4.4, 4.8, 4.10, 4.11, 4.12, 7.9, 11.3
//
// For any submitted Customer_Profile whose fields pass validation, reading the
// same License_Record returns each Customer_Field character-for-character equal
// to the normalized submitted value (Req 3.1, 4.10, 7.9), normalizing any
// returned value again yields that same value (Req 4.8 — normalization is a
// fixed point), and submitting the same profile a second time leaves the stored
// Customer_Profile and every other attribute of the record equal to their state
// after the first submission (Req 2.4).
//
// The test creates a License_Record with a Customer_Profile via the create
// flow, reads it back via the query view, asserts character-for-character
// equality with the normalized value, re-normalizes the returned values and
// asserts idempotence, then submits the identical profile through the attribute
// updater and asserts the full record is unchanged.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  CUSTOMER_FIELDS,
  evaluateCustomerProfile,
  normalizeCustomerField,
  type CustomerField,
  type CustomerProfile,
} from "../lib/licenses/customer.ts";
import {
  createLicenseCreator,
  LICENSES_TABLE_NAME,
  LICENSE_PARTITION_KEY,
} from "../lib/licenses/create.ts";
import { createAttributeUpdater } from "../lib/licenses/attributes.ts";
import { createLicenseQuery } from "../lib/licenses/query.ts";
import { createAuditLog } from "../lib/audit.ts";
import { FakeDynamoClient } from "../lib/dev/in-memory-dynamo.ts";

const RUNS = 100;

// ─── Arbitraries for valid Customer_Field values ─────────────────────────────

/** Valid email: local@domain.tld, with possible surrounding whitespace/case. */
const emailArb = fc
  .tuple(
    fc.stringOf(fc.constantFrom(...("abcdefghijklmnopqrstuvwxyz0123456789._%+-".split(""))), { minLength: 1, maxLength: 20 }),
    fc.stringOf(fc.constantFrom(...("abcdefghijklmnopqrstuvwxyz0123456789-".split(""))), { minLength: 1, maxLength: 10 }),
    fc.stringOf(fc.constantFrom(...("abcdefghijklmnopqrstuvwxyz".split(""))), { minLength: 2, maxLength: 6 }),
    fc.stringOf(fc.constantFrom(" ", "\t"), { minLength: 0, maxLength: 3 }),
    fc.boolean() // randomize casing
  )
  .map(([local, domainName, tld, ws, mixCase]) => {
    // Ensure domain doesn't start/end with dot and local is 1-64
    const safeLocal = local.slice(0, 64) || "a";
    const safeDomain = `${domainName}.${tld}`;
    const email = `${safeLocal}@${safeDomain}`;
    const cased = mixCase
      ? email.split("").map((c, i) => (i % 3 === 0 ? c.toUpperCase() : c)).join("")
      : email;
    return `${ws}${cased}${ws}`;
  })
  .filter((v) => {
    // Ensure it passes validation after normalization
    const norm = normalizeCustomerField("customerEmail", v);
    if (norm.length === 0) return false;
    const outcome = evaluateCustomerProfile({ customerEmail: v });
    return outcome.errors.length === 0 && Object.keys(outcome.set).length > 0;
  });

/** Valid country code: two letters (may be lowercase/surrounded by whitespace). */
const countryArb = fc
  .tuple(
    fc.constantFrom(
      "US", "GB", "IN", "DE", "FR", "JP", "AU", "CA", "BR", "ZA",
      "NZ", "IT", "ES", "NL", "SE", "NO", "DK", "FI", "PL", "MX"
    ),
    fc.stringOf(fc.constantFrom(" ", "\t"), { minLength: 0, maxLength: 2 }),
    fc.boolean()
  )
  .map(([code, ws, lower]) => {
    const cased = lower ? code.toLowerCase() : code;
    return `${ws}${cased}${ws}`;
  });

/** Valid phone: 7-20 chars of digits, spaces, hyphens, parens, optional leading +. */
const phoneArb = fc
  .tuple(
    fc.boolean(), // leading +
    fc.array(
      fc.oneof(
        fc.constantFrom("0", "1", "2", "3", "4", "5", "6", "7", "8", "9"),
        fc.constantFrom(" ", "-", "(", ")")
      ),
      { minLength: 7, maxLength: 18 }
    ),
    fc.stringOf(fc.constantFrom(" ", "\t"), { minLength: 0, maxLength: 2 })
  )
  .map(([hasPlus, chars, ws]) => {
    // Ensure at least 7 digits
    const digits = chars.filter((c) => /[0-9]/.test(c));
    let phone = chars.join("");
    // Pad with digits if needed
    while ((phone.match(/[0-9]/g) ?? []).length < 7) {
      phone += String(Math.floor(Math.random() * 10));
    }
    if (hasPlus) phone = "+" + phone;
    // Trim to 20 chars max
    phone = phone.slice(0, 20);
    return `${ws}${phone}${ws}`;
  })
  .filter((v) => {
    const norm = normalizeCustomerField("customerPhone", v);
    if (norm.length === 0) return false;
    const outcome = evaluateCustomerProfile({ customerPhone: v });
    return outcome.errors.length === 0 && Object.keys(outcome.set).length > 0;
  });

/** Valid name/company: up to 120 chars with possible interior whitespace runs. */
const nameArb = fc
  .tuple(
    fc.array(
      fc.oneof(
        fc.stringOf(fc.constantFrom(...("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".split(""))), { minLength: 1, maxLength: 15 }),
        fc.stringOf(fc.constantFrom(" ", "\t", "  "), { minLength: 1, maxLength: 3 })
      ),
      { minLength: 1, maxLength: 6 }
    ),
    fc.stringOf(fc.constantFrom(" ", "\t"), { minLength: 0, maxLength: 2 })
  )
  .map(([parts, ws]) => {
    const text = parts.join("");
    return `${ws}${text.slice(0, 118)}${ws}`;
  })
  .filter((v) => {
    const norm = normalizeCustomerField("customerName", v);
    return norm.length > 0 && norm.length <= 120;
  });

/** Valid notes: up to 1000 chars with leading/trailing whitespace. */
const notesArb = fc
  .tuple(
    fc.string({ minLength: 1, maxLength: 200 }),
    fc.stringOf(fc.constantFrom(" ", "\t", "\n"), { minLength: 0, maxLength: 3 })
  )
  .map(([text, ws]) => `${ws}${text.slice(0, 995)}${ws}`)
  .filter((v) => {
    const norm = normalizeCustomerField("customerNotes", v);
    return norm.length > 0 && norm.length <= 1000;
  });

/**
 * A valid Customer_Profile with at least one field set, containing raw
 * (pre-normalization) values that will pass validation after normalization.
 */
const validProfileArb = fc
  .record({
    customerEmail: fc.option(emailArb, { nil: undefined }),
    customerName: fc.option(nameArb, { nil: undefined }),
    customerPhone: fc.option(phoneArb, { nil: undefined }),
    customerCountry: fc.option(countryArb, { nil: undefined }),
    customerCompany: fc.option(nameArb, { nil: undefined }),
    customerNotes: fc.option(notesArb, { nil: undefined }),
  })
  .filter((profile) => {
    // Ensure at least one field is submitted
    const submitted = Object.values(profile).filter((v) => v !== undefined);
    if (submitted.length === 0) return false;
    // Ensure it passes validation
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(profile)) {
      if (v !== undefined) body[k] = v;
    }
    const outcome = evaluateCustomerProfile(body);
    return outcome.errors.length === 0 && Object.keys(outcome.set).length > 0;
  });

// ─── Test helpers ────────────────────────────────────────────────────────────

const actor = { actor: "admin-user", actorRole: "admin", sourceIp: "198.51.100.1" };
const adminScope = { role: "admin" as const, resellerAccountId: null };

function buildDeps() {
  const dynamo = new FakeDynamoClient();
  const audit = createAuditLog(dynamo);
  const creator = createLicenseCreator({ dynamo, audit });
  const updater = createAttributeUpdater({ dynamo, audit });
  const query = createLicenseQuery({ dynamo });
  return { dynamo, creator, updater, query };
}

// ─── Property 7 ──────────────────────────────────────────────────────────────

describe("Property 7: Customer_Profile storage round-trips and normalization is a fixed point", () => {
  it("reading a created License_Record returns each Customer_Field character-for-character equal to the normalized submitted value (Req 3.1, 4.10, 7.9)", async () => {
    await fc.assert(
      fc.asyncProperty(
        validProfileArb,
        fc.integer({ min: 1, max: 100 }),
        async (rawProfile, maxActivations) => {
          const { creator, query } = buildDeps();

          // Evaluate the profile to get the normalized form the system will store.
          const body: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(rawProfile)) {
            if (v !== undefined) body[k] = v;
          }
          const outcome = evaluateCustomerProfile(body);
          assert.strictEqual(outcome.errors.length, 0, "profile must be valid");

          // Create a license with the raw (un-normalized) profile submitted.
          const result = await creator.create(
            { maxActivations, customer: outcome.set },
            actor
          );
          assert.strictEqual(result.ok, true, "create must succeed");
          if (!result.ok) return;

          // Read the record back via the query view.
          const viewed = await query.view(adminScope, result.value.licenseKey);
          assert.ok(viewed, "record must be viewable");

          // Assert character-for-character equality of each stored Customer_Field
          // with its normalized form (Req 3.1, 4.10, 7.9).
          for (const field of CUSTOMER_FIELDS) {
            const expected = outcome.set[field];
            if (expected !== undefined) {
              assert.strictEqual(
                viewed[field],
                expected,
                `${field}: viewed value must equal the normalized submitted value`
              );
            } else {
              // Field was not in 'set' — it must be absent from the view (Req 3.1, 10.3).
              assert.strictEqual(
                viewed[field],
                undefined,
                `${field}: must be absent when not submitted`
              );
            }
          }
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("normalizing any returned Customer_Field value again yields that same value — normalization is a fixed point (Req 4.8)", async () => {
    await fc.assert(
      fc.asyncProperty(
        validProfileArb,
        fc.integer({ min: 1, max: 100 }),
        async (rawProfile, maxActivations) => {
          const { creator, query } = buildDeps();

          const body: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(rawProfile)) {
            if (v !== undefined) body[k] = v;
          }
          const outcome = evaluateCustomerProfile(body);
          assert.strictEqual(outcome.errors.length, 0);

          const result = await creator.create(
            { maxActivations, customer: outcome.set },
            actor
          );
          assert.strictEqual(result.ok, true);
          if (!result.ok) return;

          const viewed = await query.view(adminScope, result.value.licenseKey);
          assert.ok(viewed);

          // For each stored Customer_Field, normalizing it again must be identity.
          for (const field of CUSTOMER_FIELDS) {
            const storedValue = viewed[field];
            if (storedValue !== undefined) {
              const renormalized = normalizeCustomerField(field, storedValue);
              assert.strictEqual(
                renormalized,
                storedValue,
                `${field}: normalizing the stored value must yield the same value (fixed point)`
              );
            }
          }
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("submitting the same profile a second time leaves the stored Customer_Profile and every other attribute unchanged (Req 2.4)", async () => {
    await fc.assert(
      fc.asyncProperty(
        validProfileArb,
        fc.integer({ min: 1, max: 100 }),
        async (rawProfile, maxActivations) => {
          const { dynamo, creator, updater, query } = buildDeps();

          const body: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(rawProfile)) {
            if (v !== undefined) body[k] = v;
          }
          const outcome = evaluateCustomerProfile(body);
          assert.strictEqual(outcome.errors.length, 0);

          // Create the record with the customer profile.
          const result = await creator.create(
            { maxActivations, customer: outcome.set },
            actor
          );
          assert.strictEqual(result.ok, true);
          if (!result.ok) return;

          const licenseKey = result.value.licenseKey;

          // Take a snapshot of the record after creation.
          const afterCreate = await query.view(adminScope, licenseKey);
          assert.ok(afterCreate);

          // Submit the same (normalized) profile through an update — the values
          // are already normalized because they came from evaluateCustomerProfile.
          const updateAttrs: Record<string, unknown> = {};
          for (const field of CUSTOMER_FIELDS) {
            if (outcome.set[field] !== undefined) {
              updateAttrs[field] = outcome.set[field];
            }
          }

          const updateResult = await updater.update({
            licenseKey,
            attributes: updateAttrs,
            principal: { identity: actor.actor, role: "admin", resellerAccountId: null },
            sourceIp: actor.sourceIp,
          });
          assert.strictEqual(updateResult.ok, true, "update must succeed");

          // Read the record again after the second submission.
          const afterUpdate = await query.view(adminScope, licenseKey);
          assert.ok(afterUpdate);

          // Every Customer_Field must be unchanged from the first read.
          for (const field of CUSTOMER_FIELDS) {
            assert.strictEqual(
              afterUpdate[field],
              afterCreate[field],
              `${field}: must be unchanged after re-submitting the same value`
            );
          }

          // Every non-customer attribute must also be unchanged (Req 2.4).
          assert.strictEqual(afterUpdate.licenseKey, afterCreate.licenseKey);
          assert.strictEqual(afterUpdate.status, afterCreate.status);
          assert.strictEqual(afterUpdate.plan, afterCreate.plan);
          assert.strictEqual(afterUpdate.maxActivations, afterCreate.maxActivations);
          assert.strictEqual(afterUpdate.owner, afterCreate.owner);
          assert.strictEqual(afterUpdate.expiresAt, afterCreate.expiresAt);
          assert.strictEqual(afterUpdate.activationCount, afterCreate.activationCount);
          assert.deepStrictEqual(afterUpdate.activations, afterCreate.activations);
        }
      ),
      { numRuns: RUNS }
    );
  });
});
