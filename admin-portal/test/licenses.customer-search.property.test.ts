// Feature: license-key-management-enhancements
// Property 11: Search yields exactly the viewable matches, each exactly once, across pages
//
// Validates: Requirements 3.2, 3.3, 3.4, 3.5, 3.6, 3.8, 3.10
//
// For any population of License_Records mixing prefixed and legacy keys,
// reseller- and admin-owned records, Customer_Profiles of varying completeness,
// TRIAL# anchors, and RL# counter items, draining the paginated search with
// successive continuation tokens yields exactly the set of Viewable_Records
// whose searchable attributes contain the search term as a case-insensitive
// substring, each exactly once, with no internal items and no records outside
// the caller's ownership scope.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { FakeDynamoClient } from "../lib/dev/in-memory-dynamo.ts";
import {
  createLicenseQuery,
  type LicenseQueryScope,
} from "../lib/licenses/query.ts";
import {
  LICENSES_TABLE_NAME,
  LICENSE_PARTITION_KEY,
  TRIAL_ANCHOR_PREFIX,
  RL_COUNTER_PREFIX,
} from "../lib/licenses/create.ts";
import { SEARCHABLE_CUSTOMER_FIELDS } from "../lib/licenses/customer.ts";

const RUNS = 100;

// ─── Types ───────────────────────────────────────────────────────────────────

interface SeedItem {
  licenseKey: string;
  status: string;
  owner?: string;
  resellerAccountId?: string;
  keyPrefix?: string;
  customerEmail?: string;
  customerName?: string;
  customerPhone?: string;
  customerCountry?: string;
  customerCompany?: string;
  customerNotes?: string;
  features?: string[];
  maxActivations?: number;
  activations?: Record<string, unknown>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function seedTable(items: SeedItem[]) {
  const dynamo = new FakeDynamoClient();
  dynamo.registerKeySchema(LICENSES_TABLE_NAME, LICENSE_PARTITION_KEY);
  for (const item of items) {
    void dynamo.put({ TableName: LICENSES_TABLE_NAME, Item: { ...item } });
  }
  return createLicenseQuery({ dynamo });
}

/** Drain every page of a search into a single array of licenseKeys. */
async function drainSearch(
  query: ReturnType<typeof createLicenseQuery>,
  scope: LicenseQueryScope,
  pageSize: number,
  search?: string
): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  let guard = 0;
  do {
    const page = await query.list(scope, { pageSize, continuationToken: token, search });
    keys.push(...page.items.map((i) => i.licenseKey));
    token = page.nextToken;
    if (++guard > 10_000) throw new Error("pagination did not terminate");
  } while (token);
  return keys;
}

/**
 * Reference implementation of the search predicate: returns true when the term
 * (trimmed, lowercased) is a substring of licenseKey, owner, or any searchable
 * Customer_Field — all compared lowercased (Req 3.2). An empty/whitespace-only
 * term matches every row (Req 3.10).
 */
function refMatchesSearch(item: SeedItem, search: string | undefined): boolean {
  if (search === undefined) return true;
  const needle = search.trim().toLowerCase();
  if (needle.length === 0) return true;

  if (item.licenseKey.toLowerCase().includes(needle)) return true;
  if (typeof item.owner === "string" && item.owner.toLowerCase().includes(needle)) return true;

  for (const field of SEARCHABLE_CUSTOMER_FIELDS) {
    const value = item[field as keyof SeedItem];
    if (typeof value === "string" && value.toLowerCase().includes(needle)) return true;
  }
  return false;
}

/** True when the item is an internal item that must never surface. */
function isInternal(item: SeedItem): boolean {
  return (
    item.licenseKey.startsWith(TRIAL_ANCHOR_PREFIX) ||
    item.licenseKey.startsWith(RL_COUNTER_PREFIX)
  );
}

/** True when the item is visible to the given scope. */
function isVisible(item: SeedItem, scope: LicenseQueryScope): boolean {
  if (isInternal(item)) return false;
  if (scope.role !== "reseller") return true;
  return (
    scope.resellerAccountId != null &&
    item.resellerAccountId === scope.resellerAccountId
  );
}

/**
 * Compute the expected set of licenseKeys that should be returned for a given
 * scope and search term.
 */
function expectedKeys(
  items: SeedItem[],
  scope: LicenseQueryScope,
  search: string | undefined
): string[] {
  return items
    .filter((item) => isVisible(item, scope))
    .filter((item) => refMatchesSearch(item, search))
    .map((item) => item.licenseKey)
    .sort();
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Sample reseller account IDs. */
const RESELLER_IDS = ["res-alpha", "res-beta", "res-gamma"] as const;

/** Sample owners to enable owner-based search matching. */
const OWNERS = ["acme-corp", "globex-inc", "initech-llc", "umbrella-co"] as const;

/** Sample customer emails. */
const EMAILS = [
  "alice@example.com",
  "bob.smith@testdomain.org",
  "charlie@acme-corp.io",
] as const;

/** Sample customer names. */
const NAMES = ["Alice Johnson", "Bob Smith", "Charlie Brown"] as const;

/** Sample customer companies. */
const COMPANIES = ["Acme Corp", "Globex International", "Initech Solutions"] as const;

/** Sample customer phones. */
const PHONES = ["+1 555-1234", "44 20 7946 0958", "9876543210"] as const;

/**
 * Arbitrary for a single population item. Mixes:
 * - Prefixed keys (PDM-PREFIX-...) and legacy keys (PDM-XXXX-XXXX-XXXX-XXXX)
 * - Admin-owned (no resellerAccountId) and reseller-owned records
 * - Customer_Profile fields (partial or full)
 * - TRIAL# anchors
 * - RL# counter items
 */
const itemArb = fc.record({
  kind: fc.constantFrom("prefixed", "legacy", "trial", "rl-counter"),
  idx: fc.nat({ max: 999 }),
  reseller: fc.option(fc.constantFrom(...RESELLER_IDS), { nil: undefined }),
  owner: fc.option(fc.constantFrom(...OWNERS), { nil: undefined }),
  customerEmail: fc.option(fc.constantFrom(...EMAILS), { nil: undefined }),
  customerName: fc.option(fc.constantFrom(...NAMES), { nil: undefined }),
  customerCompany: fc.option(fc.constantFrom(...COMPANIES), { nil: undefined }),
  customerPhone: fc.option(fc.constantFrom(...PHONES), { nil: undefined }),
  customerCountry: fc.option(fc.constantFrom("US", "GB", "IN", "DE"), { nil: undefined }),
  customerNotes: fc.option(fc.constantFrom("VIP customer", "needs follow-up"), { nil: undefined }),
  prefix: fc.option(fc.constantFrom("NEW-YEAR", "VISHAL", "PROMO-2025", "ENTERPRISE"), { nil: undefined }),
});

/**
 * Build a population of items from the generated records, ensuring unique keys.
 */
const populationArb = fc
  .array(itemArb, { minLength: 1, maxLength: 40 })
  .map((rows) => {
    const seen = new Set<string>();
    const items: SeedItem[] = [];
    let counter = 0;

    for (const r of rows) {
      let key: string;
      switch (r.kind) {
        case "trial":
          key = `${TRIAL_ANCHOR_PREFIX}trial-${counter}`;
          break;
        case "rl-counter":
          key = `${RL_COUNTER_PREFIX}ACT#192.168.1.${counter}`;
          break;
        case "prefixed": {
          const pfx = r.prefix ?? "CUSTOM";
          const secret = String(counter).padStart(4, "0");
          key = `PDM-${pfx}-${secret}-AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG`;
          break;
        }
        case "legacy":
        default:
          key = `PDM-${String(counter).padStart(4, "0")}-AAAA-BBBB-CCCC`;
          break;
      }
      counter++;

      if (seen.has(key)) continue;
      seen.add(key);

      const item: SeedItem = {
        licenseKey: key,
        status: "active",
        features: [],
        maxActivations: 5,
        activations: {},
      };

      // Assign ownership
      if (r.kind !== "trial" && r.kind !== "rl-counter") {
        if (r.reseller) item.resellerAccountId = r.reseller;
        if (r.owner) item.owner = r.owner;
      }

      // Assign customer fields only to real license records
      if (r.kind === "prefixed" || r.kind === "legacy") {
        if (r.customerEmail) item.customerEmail = r.customerEmail;
        if (r.customerName) item.customerName = r.customerName;
        if (r.customerCompany) item.customerCompany = r.customerCompany;
        if (r.customerPhone) item.customerPhone = r.customerPhone;
        if (r.customerCountry) item.customerCountry = r.customerCountry;
        if (r.customerNotes) item.customerNotes = r.customerNotes;
        if (r.kind === "prefixed" && r.prefix) item.keyPrefix = r.prefix;
      }

      items.push(item);
    }
    return items;
  });

/**
 * Search terms drawn from a pool that includes values matching owner, email,
 * name, company, phone, key prefix substrings, empty/whitespace (match all),
 * and a non-matching term.
 */
const searchTermArb = fc.constantFrom(
  // Match by owner (Req 3.2)
  "acme", "globex", "initech", "umbrella",
  // Match by customerEmail (Req 3.2, 3.3)
  "alice@example.com", "bob.smith", "testdomain",
  // Match by customerName (Req 3.2)
  "alice", "johnson", "charlie",
  // Match by customerCompany (Req 3.2)
  "acme corp", "globex int", "solutions",
  // Match by customerPhone (Req 3.2)
  "555-1234", "9876543210",
  // Match by key prefix substring in licenseKey (Req 3.8)
  "NEW-YEAR", "VISHAL", "PROMO-2025", "ENTERPRISE",
  // Empty/whitespace — match all (Req 3.10)
  "", "   ", "\t",
  // Non-matching term
  "zzz-no-match-999",
  // Partial licenseKey match
  "PDM",
);

// ─── Property 11 ─────────────────────────────────────────────────────────────

describe("Property 11: Search yields exactly the viewable matches, each exactly once, across pages", () => {
  it("admin search: draining pages returns exactly the expected matches (Req 3.2, 3.3, 3.4, 3.6, 3.8, 3.10)", async () => {
    await fc.assert(
      fc.asyncProperty(
        populationArb,
        searchTermArb,
        fc.integer({ min: 1, max: 7 }),
        async (population, search, pageSize) => {
          const query = seedTable(population);
          const scope: LicenseQueryScope = { role: "admin", resellerAccountId: null };

          const actual = await drainSearch(query, scope, pageSize, search);

          // No duplicates (exactly once — Req 3.4)
          assert.strictEqual(
            new Set(actual).size,
            actual.length,
            "search must produce no duplicate keys"
          );

          // Matches the reference set exactly
          const expected = expectedKeys(population, scope, search);
          assert.deepStrictEqual(
            [...actual].sort(),
            expected,
            `admin search for "${search}" must return exactly the viewable matches`
          );
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("reseller search: draining pages returns only the reseller's own matching records (Req 3.5)", async () => {
    await fc.assert(
      fc.asyncProperty(
        populationArb,
        searchTermArb,
        fc.constantFrom(...RESELLER_IDS),
        fc.integer({ min: 1, max: 5 }),
        async (population, search, resellerId, pageSize) => {
          const query = seedTable(population);
          const scope: LicenseQueryScope = { role: "reseller", resellerAccountId: resellerId };

          const actual = await drainSearch(query, scope, pageSize, search);

          // No duplicates
          assert.strictEqual(
            new Set(actual).size,
            actual.length,
            "reseller search must produce no duplicate keys"
          );

          // Matches the reference set exactly — only own records
          const expected = expectedKeys(population, scope, search);
          assert.deepStrictEqual(
            [...actual].sort(),
            expected,
            `reseller "${resellerId}" search for "${search}" must return only their own matching records`
          );
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("TRIAL# and RL# items never appear in search results (Req 3.6)", async () => {
    await fc.assert(
      fc.asyncProperty(
        populationArb,
        searchTermArb,
        fc.integer({ min: 1, max: 10 }),
        async (population, search, pageSize) => {
          const query = seedTable(population);
          const scope: LicenseQueryScope = { role: "admin", resellerAccountId: null };

          const actual = await drainSearch(query, scope, pageSize, search);

          for (const key of actual) {
            assert.ok(
              !key.startsWith(TRIAL_ANCHOR_PREFIX),
              `TRIAL# item "${key}" must never appear in search results`
            );
            assert.ok(
              !key.startsWith(RL_COUNTER_PREFIX),
              `RL# item "${key}" must never appear in search results`
            );
          }
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("an empty/whitespace search term returns every viewable record (Req 3.10)", async () => {
    await fc.assert(
      fc.asyncProperty(
        populationArb,
        fc.constantFrom("", "   ", "\t", "  \t  "),
        fc.integer({ min: 1, max: 8 }),
        async (population, emptySearch, pageSize) => {
          const query = seedTable(population);
          const scope: LicenseQueryScope = { role: "admin", resellerAccountId: null };

          const actual = await drainSearch(query, scope, pageSize, emptySearch);

          // Empty search should return all viewable records
          const expected = expectedKeys(population, scope, undefined);
          assert.deepStrictEqual(
            [...actual].sort(),
            expected,
            "empty/whitespace search must return all viewable records"
          );
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("searching by a Custom_Key_Prefix returns every record with that prefix in its key (Req 3.8)", async () => {
    await fc.assert(
      fc.asyncProperty(
        populationArb,
        fc.constantFrom("NEW-YEAR", "VISHAL", "PROMO-2025", "ENTERPRISE", "CUSTOM"),
        fc.integer({ min: 1, max: 6 }),
        async (population, prefix, pageSize) => {
          const query = seedTable(population);
          const scope: LicenseQueryScope = { role: "admin", resellerAccountId: null };

          const actual = await drainSearch(query, scope, pageSize, prefix);

          // The prefix is a literal substring of licenseKey for prefixed records,
          // so searching by it must find them (Req 3.8).
          const expected = expectedKeys(population, scope, prefix);
          assert.deepStrictEqual(
            [...actual].sort(),
            expected,
            `prefix search "${prefix}" must return exactly the records containing it`
          );
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("page sizes are respected — each page has at most pageSize items (Req 3.4)", async () => {
    await fc.assert(
      fc.asyncProperty(
        populationArb,
        searchTermArb,
        fc.integer({ min: 1, max: 5 }),
        async (population, search, pageSize) => {
          const query = seedTable(population);
          const scope: LicenseQueryScope = { role: "admin", resellerAccountId: null };

          let token: string | undefined;
          let guard = 0;
          do {
            const page = await query.list(scope, { pageSize, continuationToken: token, search });
            assert.ok(
              page.items.length <= pageSize,
              `page must have at most ${pageSize} items, got ${page.items.length}`
            );
            token = page.nextToken;
            if (++guard > 10_000) throw new Error("pagination did not terminate");
          } while (token);
        }
      ),
      { numRuns: RUNS }
    );
  });
});
