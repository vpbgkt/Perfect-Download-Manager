// Feature: license-key-management-enhancements
// Property 21: Customer email is non-unique and both credential paths behave identically
//
// Validates: Requirements 1.5, 1.6, 1.7, 2.10
//
// For any customerEmail value and for any number of License_Records carrying it,
// every create and update succeeds without rejection and every such record
// remains retrievable as a Viewable_Record; and for any create-license request,
// a Reseller_API (Api_Key) caller and an equivalent Reseller_User caller produce
// the same validation outcome, the same normalized stored attributes, and the
// same resellerAccountId on the created record.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  createLicenseCreator,
  type CreateLicenseInput,
} from "../lib/licenses/create.ts";
import { createAttributeUpdater } from "../lib/licenses/attributes.ts";
import { createLicenseQuery } from "../lib/licenses/query.ts";
import { createAuditLog } from "../lib/audit.ts";
import { FakeDynamoClient } from "../lib/dev/in-memory-dynamo.ts";
import {
  evaluateCustomerProfile,
  normalizeCustomerField,
  CUSTOMER_FIELDS,
} from "../lib/licenses/customer.ts";

const RUNS = 100;

// ─── Helpers for string generation (fast-check 4.1.1 has no stringOf) ────────

/** Build a string arbitrary from a character pool using array + join. */
function strFrom(chars: string[], min: number, max: number) {
  return fc.array(fc.constantFrom(...chars), { minLength: min, maxLength: max })
    .map((arr) => arr.join(""));
}

const LOWER_ALPHA_NUM = "abcdefghijklmnopqrstuvwxyz0123456789".split("");
const LOWER_ALPHA = "abcdefghijklmnopqrstuvwxyz".split("");

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** A valid email that passes validation after normalization. */
const validEmailArb = fc
  .tuple(
    strFrom(LOWER_ALPHA_NUM, 1, 15),
    strFrom(LOWER_ALPHA_NUM, 1, 10),
    strFrom(LOWER_ALPHA, 2, 5)
  )
  .map(([local, domain, tld]) => `${local}@${domain}.${tld}`)
  .filter((email) => {
    const outcome = evaluateCustomerProfile({ customerEmail: email });
    return outcome.errors.length === 0 && "customerEmail" in outcome.set;
  });

/** The number of records to create sharing the same email (2–6). */
const duplicateCountArb = fc.integer({ min: 2, max: 6 });

/** A valid maxActivations value. */
const maxActivationsArb = fc.integer({ min: 1, max: 100 });

/** A valid optional customer profile body (may include fields beyond email). */
const optionalExtraFieldsArb = fc.record({
  customerName: fc.option(
    strFrom("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz ".split(""), 1, 30),
    { nil: undefined }
  ),
  customerCompany: fc.option(
    strFrom("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz ".split(""), 1, 30),
    { nil: undefined }
  ),
  customerCountry: fc.option(
    fc.constantFrom("US", "GB", "IN", "DE", "FR"),
    { nil: undefined }
  ),
});

/** Reseller account ID used for credential-path equivalence tests. */
const resellerIdArb = fc.constantFrom("res-alpha", "res-beta", "res-gamma");

// ─── Test helpers ────────────────────────────────────────────────────────────

function buildDeps() {
  const dynamo = new FakeDynamoClient();
  const audit = createAuditLog(dynamo);
  const creator = createLicenseCreator({ dynamo, audit });
  const updater = createAttributeUpdater({ dynamo, audit });
  const query = createLicenseQuery({ dynamo });
  return { dynamo, creator, updater, query };
}

const adminActor = { actor: "admin-uid-1", actorRole: "admin", sourceIp: "198.51.100.1" };
const adminScope = { role: "admin" as const, resellerAccountId: null };

// ─── Property 21 ─────────────────────────────────────────────────────────────

describe("Property 21: Customer email is non-unique and both credential paths behave identically", () => {
  it("multiple License_Records can carry the same customerEmail without rejection, and all remain retrievable (Req 1.5, 2.10)", async () => {
    await fc.assert(
      fc.asyncProperty(
        validEmailArb,
        duplicateCountArb,
        maxActivationsArb,
        optionalExtraFieldsArb,
        async (email, count, maxActivations, extras) => {
          const { creator, query } = buildDeps();

          // Create N records all carrying the same customerEmail.
          const createdKeys: string[] = [];
          for (let i = 0; i < count; i++) {
            const body: Record<string, unknown> = { customerEmail: email };
            if (extras.customerName) body.customerName = extras.customerName;
            if (extras.customerCompany) body.customerCompany = extras.customerCompany;
            if (extras.customerCountry) body.customerCountry = extras.customerCountry;

            const outcome = evaluateCustomerProfile(body);
            assert.strictEqual(outcome.errors.length, 0, "profile must be valid");

            const result = await creator.create(
              { maxActivations, customer: outcome.set },
              adminActor
            );
            assert.strictEqual(
              result.ok,
              true,
              `create ${i + 1}/${count} must succeed despite duplicate email`
            );
            if (!result.ok) return;
            createdKeys.push(result.value.licenseKey);
          }

          // Every created record must be independently retrievable.
          for (const key of createdKeys) {
            const viewed = await query.view(adminScope, key);
            assert.ok(viewed, `record ${key} must be viewable`);
            assert.strictEqual(
              viewed.customerEmail,
              normalizeCustomerField("customerEmail", email),
              "stored email must equal the normalized submitted email"
            );
          }

          // Searching by the shared email must return every record carrying it.
          const searchResult = await query.list(adminScope, { search: email, pageSize: 100 });
          const foundKeys = searchResult.items.map((item) => item.licenseKey).sort();
          assert.deepStrictEqual(
            foundKeys,
            [...createdKeys].sort(),
            "searching by the shared email must return all records carrying it"
          );
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("updating customerEmail to a value already carried by another record succeeds (Req 2.10)", async () => {
    await fc.assert(
      fc.asyncProperty(
        validEmailArb,
        maxActivationsArb,
        async (sharedEmail, maxActivations) => {
          const { creator, updater, query } = buildDeps();

          // Create the first record with the email.
          const body1: Record<string, unknown> = { customerEmail: sharedEmail };
          const outcome1 = evaluateCustomerProfile(body1);
          assert.strictEqual(outcome1.errors.length, 0);

          const result1 = await creator.create(
            { maxActivations, customer: outcome1.set },
            adminActor
          );
          assert.strictEqual(result1.ok, true);
          if (!result1.ok) return;

          // Create a second record with no email initially.
          const result2 = await creator.create(
            { maxActivations },
            adminActor
          );
          assert.strictEqual(result2.ok, true);
          if (!result2.ok) return;

          // Update the second record to carry the same email.
          const updateResult = await updater.update({
            licenseKey: result2.value.licenseKey,
            attributes: { customerEmail: sharedEmail },
            principal: { identity: adminActor.actor, role: "admin", resellerAccountId: null },
            sourceIp: adminActor.sourceIp,
          });
          assert.strictEqual(
            updateResult.ok,
            true,
            "updating to a duplicate email must succeed without rejection"
          );

          // Both records must remain retrievable with the same email.
          const viewed1 = await query.view(adminScope, result1.value.licenseKey);
          const viewed2 = await query.view(adminScope, result2.value.licenseKey);
          assert.ok(viewed1);
          assert.ok(viewed2);
          assert.strictEqual(
            viewed1.customerEmail,
            normalizeCustomerField("customerEmail", sharedEmail)
          );
          assert.strictEqual(
            viewed2.customerEmail,
            normalizeCustomerField("customerEmail", sharedEmail)
          );
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("a Reseller_API caller and an equivalent Reseller_User caller produce the same validation, stored attributes, and resellerAccountId (Req 1.6, 1.7)", async () => {
    await fc.assert(
      fc.asyncProperty(
        validEmailArb,
        maxActivationsArb,
        resellerIdArb,
        optionalExtraFieldsArb,
        async (email, maxActivations, resellerId, extras) => {
          // Build two independent environments to isolate any ordering effects.
          const depsApiKey = buildDeps();
          const depsFirebase = buildDeps();

          // Construct the same request body for both paths.
          const body: Record<string, unknown> = { customerEmail: email };
          if (extras.customerName) body.customerName = extras.customerName;
          if (extras.customerCompany) body.customerCompany = extras.customerCompany;
          if (extras.customerCountry) body.customerCountry = extras.customerCountry;

          // Evaluate the customer profile (shared, deterministic).
          const outcome = evaluateCustomerProfile(body);

          // Both credential paths use the same normalized input and reseller.
          const input: CreateLicenseInput = {
            maxActivations,
            customer: outcome.errors.length === 0 && Object.keys(outcome.set).length > 0
              ? outcome.set
              : undefined,
            resellerAccountId: resellerId,
          };

          // Simulate the Api_Key (Reseller_API) credential path.
          const apiKeyActor = {
            actor: `apikey-${resellerId}`,
            actorRole: "reseller",
            sourceIp: "203.0.113.10",
          };
          const resultApiKey = await depsApiKey.creator.create(input, apiKeyActor);

          // Simulate the Firebase (interactive Reseller_User) credential path.
          const firebaseActor = {
            actor: `firebase-uid-${resellerId}`,
            actorRole: "reseller",
            sourceIp: "203.0.113.20",
          };
          const resultFirebase = await depsFirebase.creator.create(input, firebaseActor);

          // Both must produce the same validation outcome (both succeed or both
          // fail with the same error code).
          assert.strictEqual(
            resultApiKey.ok,
            resultFirebase.ok,
            "both credential paths must produce the same success/failure outcome"
          );

          if (!resultApiKey.ok || !resultFirebase.ok) {
            if (!resultApiKey.ok && !resultFirebase.ok) {
              assert.strictEqual(
                resultApiKey.error.code,
                resultFirebase.error.code,
                "both paths must fail with the same error code"
              );
            }
            return;
          }

          // Both succeeded: the stored attributes must be equivalent.
          const recApi = resultApiKey.value;
          const recFb = resultFirebase.value;

          // Same resellerAccountId on both records (Req 1.7).
          assert.strictEqual(
            recApi.resellerAccountId,
            resellerId,
            "Api_Key path must set resellerAccountId to the caller's reseller account"
          );
          assert.strictEqual(
            recFb.resellerAccountId,
            resellerId,
            "Firebase path must set resellerAccountId to the caller's reseller account"
          );

          // Same normalized Customer_Fields stored.
          for (const field of CUSTOMER_FIELDS) {
            assert.strictEqual(
              recApi[field],
              recFb[field],
              `${field}: both paths must store the same normalized value`
            );
          }

          // Same plan, maxActivations, status, features.
          assert.strictEqual(recApi.plan, recFb.plan);
          assert.strictEqual(recApi.maxActivations, recFb.maxActivations);
          assert.strictEqual(recApi.status, recFb.status);
          assert.deepStrictEqual(recApi.features, recFb.features);

          // Both records are retrievable as Viewable_Records within their
          // reseller scope.
          const resellerScope = { role: "reseller" as const, resellerAccountId: resellerId };

          const viewedApi = await depsApiKey.query.view(resellerScope, recApi.licenseKey);
          const viewedFb = await depsFirebase.query.view(resellerScope, recFb.licenseKey);
          assert.ok(viewedApi, "Api_Key-created record must be viewable by the reseller");
          assert.ok(viewedFb, "Firebase-created record must be viewable by the reseller");
        }
      ),
      { numRuns: RUNS }
    );
  });
});
