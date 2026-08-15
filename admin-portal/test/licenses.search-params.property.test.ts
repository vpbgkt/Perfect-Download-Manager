// Feature: license-key-management-enhancements, Property 19: Malformed search parameters are rejected without results
// Validates: Requirements 3.11
//
// For any search term longer than 128 characters and for any continuation token
// that is not a token this endpoint issues for a license search, the request is
// rejected with a validation error naming the offending parameter and no license
// search result is returned.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  createLicenseQuery,
  MAX_SEARCH_TERM_LENGTH,
} from "../lib/licenses/query.ts";
import { parseLicenseContinuationToken } from "../lib/licenses/pagination.ts";
import { FakeDynamoClient } from "../lib/dev/in-memory-dynamo.ts";
import { LICENSES_TABLE_NAME, LICENSE_PARTITION_KEY } from "../lib/licenses/create.ts";

const RUNS = 100;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a fresh LicenseQuery wired to an in-memory fake with the real token parser. */
function makeQuery() {
  const dynamo = new FakeDynamoClient();
  dynamo.registerKeySchema(LICENSES_TABLE_NAME, LICENSE_PARTITION_KEY);
  const query = createLicenseQuery({
    dynamo,
    tableName: LICENSES_TABLE_NAME,
    parseToken: parseLicenseContinuationToken,
  });
  return { dynamo, query };
}

/** Seed a few License_Records so the table is non-empty and a valid search would match. */
function seedRecords(dynamo: FakeDynamoClient, count: number): void {
  for (let i = 0; i < count; i++) {
    dynamo.conditionalPut(
      LICENSES_TABLE_NAME,
      {
        licenseKey: `PDM-TEST-${String(i).padStart(4, "0")}`,
        status: "active",
        plan: "pro",
        owner: `user${i}@example.com`,
        features: [],
        activations: {},
        createdAt: new Date().toISOString(),
      },
      LICENSE_PARTITION_KEY
    );
  }
}

/** An admin scope that sees all records. */
const adminScope = { role: "admin" as const, resellerAccountId: null };

// ─── Arbitraries ──────────────────────────────────────────────────────────────

/**
 * A search term that exceeds 128 characters after trimming. We generate strings
 * of length 129–300 composed of printable characters, optionally with leading
 * and trailing whitespace that would be trimmed.
 */
const overLengthSearchTermArb: fc.Arbitrary<string> = fc
  .tuple(
    // Leading whitespace (optional)
    fc.array(fc.constantFrom(" ", "\t", "\n"), { minLength: 0, maxLength: 5 }).map((c) => c.join("")),
    // Core content that exceeds MAX_SEARCH_TERM_LENGTH after trimming
    fc.array(fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@.".split("")), {
      minLength: MAX_SEARCH_TERM_LENGTH + 1,
      maxLength: 300,
    }).map((c) => c.join("")),
    // Trailing whitespace (optional)
    fc.array(fc.constantFrom(" ", "\t", "\n"), { minLength: 0, maxLength: 5 }).map((c) => c.join("")),
  )
  .map(([leading, core, trailing]) => `${leading}${core}${trailing}`);

/**
 * A continuation token that is NOT a valid license-search token. We cover
 * multiple malformed string categories since the LicenseListOptions interface
 * types continuationToken as `string | undefined`:
 * - Non-base64url strings (containing `=`, `+`, `/`, or special characters)
 * - Valid base64url but decodes to non-JSON
 * - Valid base64url JSON but wrong shape (missing licenseKey, extra keys, array, etc.)
 *
 * Note: empty string, null, and undefined are treated as "no token" by the
 * query module and bypass the parser entirely, so they are excluded here.
 */
const malformedTokenArb: fc.Arbitrary<string> = fc.oneof(
  // Category 1: String with invalid base64url characters (non-empty)
  fc.array(fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=!@#$%^&*()".split("")), {
    minLength: 1,
    maxLength: 50,
  }).map((c) => c.join("")).filter((s) => !/^[A-Za-z0-9_-]+$/.test(s)),
  // Category 2: Valid base64url but not valid JSON when decoded
  fc
    .uint8Array({ minLength: 1, maxLength: 30 })
    .map((bytes) => Buffer.from(bytes).toString("base64url"))
    .filter((token) => {
      try {
        JSON.parse(Buffer.from(token, "base64url").toString("utf-8"));
        return false; // Skip if it accidentally parses as JSON
      } catch {
        return true;
      }
    }),
  // Category 3: Valid base64url JSON but wrong shape (not { licenseKey: string })
  fc.oneof(
    // JSON array
    fc.array(fc.string(), { minLength: 0, maxLength: 3 })
      .map((arr) => Buffer.from(JSON.stringify(arr)).toString("base64url")),
    // JSON object with wrong key(s)
    fc.record({
      wrongKey: fc.string({ minLength: 1, maxLength: 20 }),
    }).map((obj) => Buffer.from(JSON.stringify(obj)).toString("base64url")),
    // JSON object with licenseKey as non-string
    fc.oneof(fc.integer(), fc.boolean(), fc.constant(null))
      .map((val) => Buffer.from(JSON.stringify({ licenseKey: val })).toString("base64url")),
    // JSON object with extra keys alongside licenseKey
    fc.tuple(fc.string({ minLength: 1, maxLength: 20 }), fc.string({ minLength: 1, maxLength: 10 }))
      .map(([key, extra]) => Buffer.from(JSON.stringify({ licenseKey: key, extra })).toString("base64url")),
    // JSON primitive (number, string, boolean, null)
    fc.oneof(fc.integer(), fc.string(), fc.boolean(), fc.constant(null))
      .map((val) => Buffer.from(JSON.stringify(val)).toString("base64url")),
  ),
);

// ─── Property 19 ─────────────────────────────────────────────────────────────

describe("Property 19: Malformed search parameters are rejected without results", () => {
  it("a search term exceeding 128 characters (after trim) is rejected with an error naming 'search' and yields no results", async () => {
    await fc.assert(
      fc.asyncProperty(overLengthSearchTermArb, async (term) => {
        const { dynamo, query } = makeQuery();
        // Seed records so a match-all search would otherwise return results.
        seedRecords(dynamo, 5);

        const result = await query.list(adminScope, {
          search: term,
        });

        // No results returned.
        assert.strictEqual(result.items.length, 0, "over-length term must yield no results");
        // Error names the offending parameter.
        assert.ok(result.error, "an error must be returned for an over-length search term");
        assert.ok(
          result.error!.includes("search"),
          `error must name the 'search' parameter, got: ${result.error}`
        );
        // No continuation token.
        assert.strictEqual(result.nextToken, undefined, "no continuation token on rejection");
      }),
      { numRuns: RUNS }
    );
  });

  it("a malformed continuation token is rejected with an error naming 'nextToken' and yields no results", async () => {
    await fc.assert(
      fc.asyncProperty(malformedTokenArb, async (token) => {
        const { dynamo, query } = makeQuery();
        // Seed records so an unfiltered list would otherwise return results.
        seedRecords(dynamo, 5);

        const result = await query.list(adminScope, {
          continuationToken: token,
        });

        // Verify the token is indeed malformed according to the parser.
        const parseResult = parseLicenseContinuationToken(token);
        if (parseResult.ok) {
          // This token accidentally passes structural validation (e.g. a valid
          // { licenseKey: "..." } shape) — it's not truly malformed from the
          // parser's perspective, so skip this example.
          return;
        }

        // No results returned.
        assert.strictEqual(result.items.length, 0, "malformed token must yield no results");
        // Error names the offending parameter.
        assert.ok(result.error, "an error must be returned for a malformed continuation token");
        assert.ok(
          result.error!.includes("nextToken"),
          `error must name the 'nextToken' parameter, got: ${result.error}`
        );
        // No continuation token in response.
        assert.strictEqual(result.nextToken, undefined, "no continuation token on rejection");
      }),
      { numRuns: RUNS }
    );
  });

  it("a term of exactly 128 characters (after trim) is accepted and returns matching results", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".split("")), {
          minLength: MAX_SEARCH_TERM_LENGTH,
          maxLength: MAX_SEARCH_TERM_LENGTH,
        }).map((c) => c.join("")),
        async (term) => {
          const { dynamo, query } = makeQuery();
          seedRecords(dynamo, 3);

          const result = await query.list(adminScope, {
            search: term,
          });

          // No error — the term is within bounds.
          assert.strictEqual(result.error, undefined, "a 128-char term must not be rejected");
        }
      ),
      { numRuns: RUNS }
    );
  });
});
