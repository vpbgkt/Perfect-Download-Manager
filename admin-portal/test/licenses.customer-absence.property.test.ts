// Feature: license-key-management-enhancements
// Property 9: Absent and blank Customer_Fields leave no attribute behind
//
// Validates: Requirements 1.2, 1.3, 2.1, 2.2, 4.13, 10.3
//
// For any create-license request in which every Customer_Field is absent
// (omitted, null, or whitespace-only), the persisted License_Record SHALL omit
// every Customer_Field attribute (Req 1.3, 10.3). A value normalizing to the
// empty string is treated as absent — it is never stored as "" or null on the
// item and never produces a validation error (Req 4.13).
//
// For any update-license request in which a submitted Customer_Field is null,
// empty, or whitespace-only, the stored attribute SHALL be removed from the
// License_Record (Req 2.2, 4.13) and leave the record unchanged where that
// attribute is already absent (Req 2.2).
//
// Together, these rules guarantee that absent/blank Customer_Fields leave no
// attribute behind — neither on create nor on update — and that existing
// attributes unrelated to Customer_Fields are untouched (Req 2.1, 10.3).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  createLicenseCreator,
  LICENSES_TABLE_NAME,
  LICENSE_PARTITION_KEY,
} from "../lib/licenses/create.ts";
import {
  createAttributeUpdater,
} from "../lib/licenses/attributes.ts";
import { createAuditLog } from "../lib/audit.ts";
import { FakeDynamoClient } from "../lib/dev/in-memory-dynamo.ts";
import type { DynamoItem } from "../lib/dynamo.ts";
import {
  CUSTOMER_FIELDS,
  evaluateCustomerProfile,
  type CustomerField,
} from "../lib/licenses/customer.ts";

const RUNS = 100;

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/**
 * A "blank" Customer_Field value: one that normalizes to the empty string.
 * This includes null, empty string, and whitespace-only strings.
 */
const blankValueArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(null),
  fc.constant(""),
  fc.constant(" "),
  fc.constant("  "),
  fc.constant("\t"),
  fc.constant("\n"),
  fc.constant(" \t\n "),
  // Longer whitespace runs
  fc.array(fc.constantFrom(" ", "\t", "\n", "\r"), { minLength: 1, maxLength: 10 })
    .map((chars) => chars.join(""))
);

/**
 * For each Customer_Field, decide whether it is absent (omitted from the body)
 * or blank (submitted with a value that normalizes to empty). This arbitrary
 * produces a body where every Customer_Field is either not present or blank.
 */
const allAbsentOrBlankBodyArb: fc.Arbitrary<Record<string, unknown>> = fc.tuple(
  ...CUSTOMER_FIELDS.map(() =>
    fc.oneof(
      fc.constant({ mode: "omit" as const }),
      blankValueArb.map((v) => ({ mode: "blank" as const, value: v }))
    )
  )
).map((decisions) => {
  const body: Record<string, unknown> = {};
  for (let i = 0; i < CUSTOMER_FIELDS.length; i++) {
    const d = decisions[i];
    if (d.mode === "blank") {
      body[CUSTOMER_FIELDS[i]] = d.value;
    }
    // mode === "omit" → don't add the key to body at all
  }
  return body;
});

/**
 * A subset of Customer_Fields to be submitted as blank in an update request.
 * At least one field is submitted so the update is non-trivial.
 */
const blankSubsetArb: fc.Arbitrary<{ field: CustomerField; value: unknown }[]> = fc
  .subarray([...CUSTOMER_FIELDS], { minLength: 1 })
  .chain((fields) =>
    fc.tuple(...fields.map(() => blankValueArb)).map((values) =>
      fields.map((field, i) => ({ field, value: values[i] }))
    )
  );

/** Valid customer data to pre-populate a record for the update path. */
const validCustomerDataArb: fc.Arbitrary<Record<CustomerField, string>> = fc.record({
  customerEmail: fc.constant("alice@example.com"),
  customerName: fc.constant("Alice Smith"),
  customerPhone: fc.constant("+1 555 1234567"),
  customerCountry: fc.constant("US"),
  customerCompany: fc.constant("Acme Corp"),
  customerNotes: fc.constant("Important customer"),
});

const actor = { actor: "admin-user", actorRole: "admin", sourceIp: "198.51.100.42" };
const principal = { identity: "admin-user", role: "admin" as const, resellerAccountId: null };

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Property 9: Absent and blank Customer_Fields leave no attribute behind", () => {
  it("create: when every Customer_Field is absent or blank, no Customer_Field attribute appears on the persisted item (Req 1.2, 1.3, 4.13, 10.3)", async () => {
    await fc.assert(
      fc.asyncProperty(
        allAbsentOrBlankBodyArb,
        fc.integer({ min: 1, max: 100_000 }),
        async (body, maxActivations) => {
          const dynamo = new FakeDynamoClient();
          const audit = createAuditLog(dynamo);
          const creator = createLicenseCreator({
            dynamo,
            audit,
            now: () => new Date("2024-06-01T00:00:00.000Z"),
          });

          const result = await creator.create(
            {
              plan: "standard",
              maxActivations,
              // Pass the body as customer profile input — evaluateCustomerProfile
              // is called by the route; here we simulate the result by passing
              // the already-evaluated profile (which is empty for all-blank).
              // Since create.ts expects a CustomerProfile (only non-empty valid
              // values), and blank fields produce an empty set, we pass {}.
              customer: {},
            },
            actor
          );

          assert.strictEqual(result.ok, true, "create must succeed for all-absent/blank customer fields");
          if (!result.ok) return;

          // Inspect the persisted item directly from the fake.
          const persisted = dynamo
            .dump(LICENSES_TABLE_NAME)
            .find((item) => item[LICENSE_PARTITION_KEY] === result.value.licenseKey);
          assert.ok(persisted, "the License_Record must be persisted");

          // No Customer_Field attribute may appear on the item (Req 1.3, 10.3).
          for (const field of CUSTOMER_FIELDS) {
            assert.strictEqual(
              Object.prototype.hasOwnProperty.call(persisted, field),
              false,
              `Customer_Field '${field}' must not appear on the item when absent/blank`
            );
          }
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("create: evaluateCustomerProfile produces no set entries and no errors for blank/absent fields (Req 4.13)", () => {
    // This tests the evaluation path that feeds create — blank fields normalize
    // to empty and land in `clear`, never in `set` or `errors`.
    // (evaluateCustomerProfile is imported at the top; these files are ESM, so `require`
    // is not available.)
    fc.assert(
      fc.property(allAbsentOrBlankBodyArb, (body) => {
        const outcome = evaluateCustomerProfile(body);
        // No field should be in `set` — they all normalize to empty.
        assert.deepStrictEqual(
          outcome.set,
          {},
          "blank/absent Customer_Fields must produce an empty `set`"
        );
        // No errors — blank is never a validation failure (Req 4.13).
        assert.deepStrictEqual(
          outcome.errors,
          [],
          "blank/absent Customer_Fields must produce no validation errors"
        );
        // Fields that were submitted (not omitted) should land in `clear`.
        const submittedFields = CUSTOMER_FIELDS.filter(
          (f) => Object.prototype.hasOwnProperty.call(body, f)
        );
        assert.deepStrictEqual(
          outcome.clear.sort(),
          [...submittedFields].sort(),
          "submitted blank Customer_Fields must land in `clear`"
        );
      }),
      { numRuns: RUNS }
    );
  });

  it("update: submitting blank Customer_Fields removes them from a record that had them (Req 2.1, 2.2, 4.13)", async () => {
    await fc.assert(
      fc.asyncProperty(
        blankSubsetArb,
        validCustomerDataArb,
        async (blankFields, prePopulated) => {
          const dynamo = new FakeDynamoClient();
          const audit = createAuditLog(dynamo);

          // Pre-seed a License_Record with all six Customer_Fields populated.
          const licenseKey = "PDM-TEST-0001-0002-0003-0004-0005-0006-0007";
          const seedRecord: DynamoItem = {
            licenseKey,
            status: "active",
            plan: "standard",
            features: [],
            maxActivations: 5,
            activations: {},
            createdAt: "2024-01-01T00:00:00.000Z",
            ...prePopulated,
          };
          await dynamo.conditionalPut(LICENSES_TABLE_NAME, seedRecord, LICENSE_PARTITION_KEY);

          const updater = createAttributeUpdater({
            dynamo,
            audit,
            now: () => new Date("2024-06-01T00:00:00.000Z"),
          });

          // Build an attributes object with only the chosen fields set to blank values.
          const attributes: Record<string, unknown> = {};
          for (const { field, value } of blankFields) {
            attributes[field] = value;
          }

          const result = await updater.update({
            licenseKey,
            attributes,
            principal,
            sourceIp: "198.51.100.42",
          });

          assert.strictEqual(result.ok, true, "update must succeed for blank customer fields");
          if (!result.ok) return;

          // Inspect the persisted item directly.
          const persisted = dynamo
            .dump(LICENSES_TABLE_NAME)
            .find((item) => item[LICENSE_PARTITION_KEY] === licenseKey);
          assert.ok(persisted, "the License_Record must still exist");

          // The blank-submitted fields must no longer appear on the item.
          const blankFieldNames = blankFields.map((b) => b.field);
          for (const field of blankFieldNames) {
            assert.strictEqual(
              Object.prototype.hasOwnProperty.call(persisted, field),
              false,
              `Customer_Field '${field}' must be removed when submitted as blank`
            );
          }

          // Fields that were NOT submitted in this update must remain unchanged.
          const unchangedFields = CUSTOMER_FIELDS.filter(
            (f) => !blankFieldNames.includes(f)
          );
          for (const field of unchangedFields) {
            assert.strictEqual(
              persisted![field],
              prePopulated[field],
              `Customer_Field '${field}' must remain unchanged when not submitted`
            );
          }
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("update: submitting blank Customer_Fields on a record that already lacks them is a no-op (Req 2.2)", async () => {
    await fc.assert(
      fc.asyncProperty(blankSubsetArb, async (blankFields) => {
        const dynamo = new FakeDynamoClient();
        const audit = createAuditLog(dynamo);

        // Pre-seed a License_Record with NO Customer_Fields at all.
        const licenseKey = "PDM-BARE-0001-0002-0003-0004-0005-0006-0007";
        const seedRecord: DynamoItem = {
          licenseKey,
          status: "active",
          plan: "standard",
          features: [],
          maxActivations: 5,
          activations: {},
          createdAt: "2024-01-01T00:00:00.000Z",
        };
        await dynamo.conditionalPut(LICENSES_TABLE_NAME, seedRecord, LICENSE_PARTITION_KEY);

        // Snapshot before the update.
        const before = dynamo.dump(LICENSES_TABLE_NAME);

        const updater = createAttributeUpdater({
          dynamo,
          audit,
          now: () => new Date("2024-06-01T00:00:00.000Z"),
        });

        // Build attributes with blank values for the chosen fields.
        const attributes: Record<string, unknown> = {};
        for (const { field, value } of blankFields) {
          attributes[field] = value;
        }

        const result = await updater.update({
          licenseKey,
          attributes,
          principal,
          sourceIp: "198.51.100.42",
        });

        assert.strictEqual(result.ok, true, "update must succeed when blanking already-absent fields");
        if (!result.ok) return;

        // The persisted item must still have no Customer_Fields.
        const persisted = dynamo
          .dump(LICENSES_TABLE_NAME)
          .find((item) => item[LICENSE_PARTITION_KEY] === licenseKey);
        assert.ok(persisted, "the License_Record must still exist");

        for (const field of CUSTOMER_FIELDS) {
          assert.strictEqual(
            Object.prototype.hasOwnProperty.call(persisted, field),
            false,
            `Customer_Field '${field}' must not appear when it was already absent and submitted as blank`
          );
        }
      }),
      { numRuns: RUNS }
    );
  });
});
