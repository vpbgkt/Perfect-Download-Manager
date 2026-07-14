// Feature: admin-reseller-portal, license read-path properties
//
// Property 2:  Reseller ownership isolation      (Req 2.4, 2.7, 4.2, 4.6, 7.2, 12.4, 15.5)
// Property 15: License view exposes full shape    (Req 4.5, 7.1, 7.6)
// Property 16: List excludes trial anchors         (Req 4.1)
// Property 17: Pagination covers all exactly once   (Req 4.3)
// Property 18: Search returns exactly authorized matches (Req 4.4)

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
} from "../lib/licenses/create.ts";

const RUNS = 100;

interface SeedLicense {
  licenseKey: string;
  status: string;
  plan?: string;
  owner?: string;
  features?: string[];
  maxActivations?: number;
  expiresAt?: string;
  createdAt?: string;
  activations?: Record<string, { activatedAt?: string; lastSeenAt?: string }>;
  resellerAccountId?: string;
}

function seed(items: SeedLicense[]) {
  const dynamo = new FakeDynamoClient();
  dynamo.registerKeySchema(LICENSES_TABLE_NAME, LICENSE_PARTITION_KEY);
  for (const it of items) {
    void dynamo.put({ TableName: LICENSES_TABLE_NAME, Item: { ...it } });
  }
  return createLicenseQuery({ dynamo });
}

/** Drain every page of a list into a single array of licenseKeys. */
async function listAllKeys(
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

// A generator of a mixed population of PDM licenses (some reseller-owned) plus
// trial anchors.
const populationArb = fc
  .array(
    fc.record({
      idx: fc.nat({ max: 9999 }),
      reseller: fc.option(fc.constantFrom("r1", "r2", "r3"), { nil: undefined }),
      isTrial: fc.boolean(),
      owner: fc.option(fc.constantFrom("acme", "globex", "initech"), { nil: undefined }),
    }),
    { minLength: 0, maxLength: 40 }
  )
  .map((rows) => {
    const seen = new Set<string>();
    const out: SeedLicense[] = [];
    let counter = 0;
    for (const r of rows) {
      const key = r.isTrial
        ? `${TRIAL_ANCHOR_PREFIX}${counter}`
        : `PDM-0000-0000-0000-${String(counter).padStart(4, "0")}`;
      counter++;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        licenseKey: key,
        status: "active",
        plan: "standard",
        owner: r.owner,
        features: [],
        maxActivations: 5,
        createdAt: "2025-01-01T00:00:00.000Z",
        activations: {},
        resellerAccountId: r.isTrial ? undefined : r.reseller,
      });
    }
    return out;
  });

describe("Property 16: License list excludes trial anchors", () => {
  it("never returns a TRIAL# item to an admin", async () => {
    await fc.assert(
      fc.asyncProperty(populationArb, fc.integer({ min: 1, max: 10 }), async (pop, pageSize) => {
        const query = seed(pop);
        const keys = await listAllKeys(query, { role: "admin", resellerAccountId: null }, pageSize);
        for (const k of keys) {
          assert.ok(!k.startsWith(TRIAL_ANCHOR_PREFIX), `trial anchor ${k} leaked into list`);
        }
        // Coverage: exactly the non-trial items are returned.
        const expected = pop
          .filter((i) => !i.licenseKey.startsWith(TRIAL_ANCHOR_PREFIX))
          .map((i) => i.licenseKey)
          .sort();
        assert.deepStrictEqual([...keys].sort(), expected);
      }),
      { numRuns: RUNS }
    );
  });

  it("never exposes a TRIAL# anchor through view()", async () => {
    await fc.assert(
      fc.asyncProperty(fc.nat({ max: 500 }), async (n) => {
        const trialKey = `${TRIAL_ANCHOR_PREFIX}${n}`;
        const query = seed([
          { licenseKey: trialKey, status: "active" },
        ]);
        const v = await query.view({ role: "admin", resellerAccountId: null }, trialKey);
        assert.strictEqual(v, null);
      }),
      { numRuns: RUNS }
    );
  });
});

describe("Property 2: Reseller ownership isolation", () => {
  it("a reseller lists only its own records and never sees others'", async () => {
    await fc.assert(
      fc.asyncProperty(
        populationArb,
        fc.constantFrom("r1", "r2", "r3"),
        fc.integer({ min: 1, max: 8 }),
        async (pop, reseller, pageSize) => {
          const query = seed(pop);
          const keys = await listAllKeys(query, { role: "reseller", resellerAccountId: reseller }, pageSize);
          const expected = pop
            .filter((i) => !i.licenseKey.startsWith(TRIAL_ANCHOR_PREFIX) && i.resellerAccountId === reseller)
            .map((i) => i.licenseKey)
            .sort();
          assert.deepStrictEqual([...keys].sort(), expected);
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("view() reports a non-owned or unknown key as not-found", async () => {
    await fc.assert(
      fc.asyncProperty(populationArb, fc.constantFrom("r1", "r2", "r3"), async (pop, reseller) => {
        const query = seed(pop);
        for (const item of pop) {
          const v = await query.view({ role: "reseller", resellerAccountId: reseller }, item.licenseKey);
          const shouldSee =
            !item.licenseKey.startsWith(TRIAL_ANCHOR_PREFIX) &&
            item.resellerAccountId === reseller;
          if (shouldSee) {
            assert.ok(v !== null && v.licenseKey === item.licenseKey);
          } else {
            assert.strictEqual(v, null);
          }
        }
      }),
      { numRuns: RUNS }
    );
  });

  it("a reseller with no account owns nothing", async () => {
    await fc.assert(
      fc.asyncProperty(populationArb, async (pop) => {
        const query = seed(pop);
        const keys = await listAllKeys(query, { role: "reseller", resellerAccountId: null }, 5);
        assert.deepStrictEqual(keys, []);
      }),
      { numRuns: RUNS }
    );
  });
});

describe("Property 15: License view exposes the full record shape", () => {
  it("returns every persisted scalar plus activations and their count", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          suffix: fc.nat({ max: 9999 }),
          plan: fc.constantFrom("standard", "pro", "enterprise"),
          owner: fc.string({ maxLength: 20 }),
          maxActivations: fc.integer({ min: 1, max: 50 }),
          fps: fc.array(
            fc.string({ minLength: 4, maxLength: 8, unit: fc.constantFrom(..."0123456789abcdef") }),
            { maxLength: 6 }
          ),
        }),
        async (r) => {
          const activations: Record<string, { activatedAt: string; lastSeenAt: string }> = {};
          for (const fp of r.fps) {
            activations[fp] = { activatedAt: "2025-01-02T00:00:00.000Z", lastSeenAt: "2025-02-02T00:00:00.000Z" };
          }
          const key = `PDM-1111-2222-3333-${String(r.suffix).padStart(4, "0")}`;
          const query = seed([
            {
              licenseKey: key,
              status: "active",
              plan: r.plan,
              owner: r.owner,
              features: ["a", "b"],
              maxActivations: r.maxActivations,
              expiresAt: "2030-01-01T00:00:00.000Z",
              createdAt: "2025-01-01T00:00:00.000Z",
              activations,
            },
          ]);
          const v = await query.view({ role: "admin", resellerAccountId: null }, key);
          assert.ok(v !== null);
          if (!v) return;
          assert.strictEqual(v.licenseKey, key);
          assert.strictEqual(v.status, "active");
          assert.strictEqual(v.plan, r.plan);
          assert.strictEqual(v.owner, r.owner);
          assert.deepStrictEqual(v.features, ["a", "b"]);
          assert.strictEqual(v.maxActivations, r.maxActivations);
          assert.strictEqual(v.expiresAt, "2030-01-01T00:00:00.000Z");
          assert.strictEqual(v.createdAt, "2025-01-01T00:00:00.000Z");
          // activationCount is shown alongside maxActivations (Req 7.6).
          const uniqueFps = new Set(r.fps);
          assert.strictEqual(v.activationCount, uniqueFps.size);
          assert.strictEqual(v.activations.length, uniqueFps.size);
          for (const entry of v.activations) {
            assert.ok(uniqueFps.has(entry.fingerprint));
            assert.strictEqual(entry.activatedAt, "2025-01-02T00:00:00.000Z");
            assert.strictEqual(entry.lastSeenAt, "2025-02-02T00:00:00.000Z");
          }
        }
      ),
      { numRuns: RUNS }
    );
  });
});

describe("Property 17: Pagination covers all results exactly once", () => {
  it("draining pages visits every authorized record exactly once with no duplicates", async () => {
    await fc.assert(
      fc.asyncProperty(populationArb, fc.integer({ min: 1, max: 7 }), async (pop, pageSize) => {
        const query = seed(pop);
        const keys = await listAllKeys(query, { role: "admin", resellerAccountId: null }, pageSize);
        // No duplicates.
        assert.strictEqual(new Set(keys).size, keys.length);
        // Exactly the non-trial set.
        const expected = pop
          .filter((i) => !i.licenseKey.startsWith(TRIAL_ANCHOR_PREFIX))
          .map((i) => i.licenseKey)
          .sort();
        assert.deepStrictEqual([...keys].sort(), expected);
      }),
      { numRuns: RUNS }
    );
  });
});

describe("Property 18: Search returns exactly authorized matches", () => {
  it("returns exactly the authorized records whose key or owner contains the term", async () => {
    await fc.assert(
      fc.asyncProperty(
        populationArb,
        fc.constantFrom("acme", "globex", "initech", "PDM", "0001"),
        async (pop, term) => {
          const query = seed(pop);
          const keys = await listAllKeys(query, { role: "admin", resellerAccountId: null }, 6, term);
          const needle = term.toLowerCase();
          const expected = pop
            .filter((i) => !i.licenseKey.startsWith(TRIAL_ANCHOR_PREFIX))
            .filter(
              (i) =>
                i.licenseKey.toLowerCase().includes(needle) ||
                (typeof i.owner === "string" && i.owner.toLowerCase().includes(needle))
            )
            .map((i) => i.licenseKey)
            .sort();
          assert.deepStrictEqual([...keys].sort(), expected);
        }
      ),
      { numRuns: RUNS }
    );
  });
});
