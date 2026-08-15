// Feature: license-key-management-enhancements
// Property 14: Attempt_Counters are independent per-bucket fixed windows
//
// Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.10, 8.11, 11.10
//
// For any sequence of Activation_Endpoint and Validation_Endpoint requests from
// one source IP, each request increments exactly the total-request
// Attempt_Counter of its own endpoint — held as an item distinct from the other
// endpoint's counter and from the unknown-key counter, keyed by an `RL#` prefix
// and carrying a numeric epoch-second `ttl` — regardless of whether the
// presented License_Key resolves; requests up to and including the configured
// limit within one Attempt_Window are allowed and every further request in that
// window is rejected; the first request after the window has elapsed opens a new
// window with the counted total set to 1 and is processed; a peek never writes;
// and the counter identity is derived only from the request-context source IP,
// with every request whose context carries no source IP attributed to one shared
// counter per endpoint.
//
// The test imports the backend module `backend/licensing/src/lib/attemptLimit.mjs`
// directly and drives it through an injected clock (`now`) and a minimal
// in-memory DynamoDB document-client stub that honours the exact UpdateItem
// grammar the module emits: `ADD reqCount :one`, `SET … = if_not_exists(…)`, and
// the in-place window-reset `SET reqCount = :one, …`. The stub also counts every
// write so the non-writing `peek` path (Req 8.5) can be asserted precisely.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  createAttemptLimiter,
  resolveLimits,
  clientIp,
  BUCKET_ACTIVATE_TOTAL,
  BUCKET_ACTIVATE_UNKNOWN,
  BUCKET_VALIDATE_TOTAL,
  BUCKET_TRIAL,
} from "../../backend/licensing/src/lib/attemptLimit.mjs";

const RUNS = 100;

const TABLE = "pdm-licenses";
const ALL_BUCKETS = [
  BUCKET_ACTIVATE_TOTAL,
  BUCKET_ACTIVATE_UNKNOWN,
  BUCKET_VALIDATE_TOTAL,
  BUCKET_TRIAL,
];

// ─── Minimal .send()-based DynamoDB document-client stub ──────────────────────
//
// The module calls `docClient.send(new UpdateCommand(...))` and
// `docClient.send(new GetCommand(...))`. This stub inspects `command.input`,
// applies the small slice of UpdateExpression syntax the module uses, and
// returns `{ Attributes }` (ALL_NEW) for updates or `{ Item }` for gets. It
// tracks read/write counts so the non-writing peek can be verified.

interface StubItem {
  licenseKey: string;
  reqCount?: number;
  windowStart?: number;
  ttl?: number;
  [k: string]: unknown;
}

/** Split a comma-separated assignment list at top level (ignores commas inside parens). */
function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(input.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(input.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

class FakeDocClient {
  readonly store = new Map<string, StubItem>();
  writes = 0;
  reads = 0;

  async send(command: {
    input?: Record<string, unknown>;
    [k: string]: unknown;
  }): Promise<{ Attributes?: StubItem; Item?: StubItem }> {
    const input = (command.input ?? command) as Record<string, unknown>;
    const key = (input.Key as { licenseKey: string }).licenseKey;

    if (typeof input.UpdateExpression === "string") {
      this.writes++;
      const expr = input.UpdateExpression;
      const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>;
      const values = (input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;

      const resolveName = (t: string): string => (t.startsWith("#") ? names[t] : t);
      const resolveVal = (t: string): unknown => (t.startsWith(":") ? values[t] : t);

      const item: StubItem = this.store.get(key) ?? { licenseKey: key };

      // ADD <attr> <:value>  — numeric increment on a possibly-absent attribute.
      const add = /ADD\s+(\w+)\s+(:\w+)/i.exec(expr);
      if (add) {
        const attr = add[1];
        const inc = Number(resolveVal(add[2]));
        const current = typeof item[attr] === "number" ? (item[attr] as number) : 0;
        item[attr] = current + inc;
      }

      // SET clause (everything after the first "SET ").
      const setIdx = expr.search(/\bSET\b/i);
      if (setIdx >= 0) {
        const setBody = expr.slice(setIdx + 3).trim();
        for (const assignment of splitTopLevel(setBody)) {
          const eq = assignment.indexOf("=");
          const lhs = assignment.slice(0, eq).trim();
          const rhs = assignment.slice(eq + 1).trim();
          const attr = resolveName(lhs);
          const inf = /^if_not_exists\(\s*(\S+?)\s*,\s*(\S+?)\s*\)$/.exec(rhs);
          if (inf) {
            const existingAttr = resolveName(inf[1]);
            if (!(existingAttr in item)) {
              item[attr] = resolveVal(inf[2]);
            }
          } else {
            item[attr] = resolveVal(rhs);
          }
        }
      }

      this.store.set(key, item);
      return { Attributes: structuredClone(item) };
    }

    // GetCommand: no UpdateExpression.
    this.reads++;
    const found = this.store.get(key);
    return found ? { Item: structuredClone(found) } : {};
  }
}

/** Build a limiter over a fresh stub with an injected millisecond clock. */
function makeLimiter(
  limits: Record<string, { limit: number; windowSec: number }>,
  clock: { ms: number }
) {
  const client = new FakeDocClient();
  const limiter = createAttemptLimiter({
    docClient: client,
    tableName: TABLE,
    limits,
    now: () => clock.ms,
  });
  return { client, limiter };
}

function keyFor(bucket: string, ip: string): string {
  return `RL#${bucket}#${ip}`;
}

// ─── Arbitraries ──────────────────────────────────────────────────────────────

const bucketArb = fc.constantFrom(...ALL_BUCKETS);
const ipArb = fc.constantFrom("203.0.113.7", "198.51.100.42", "unknown", "::1", "10.0.0.1");
const limitArb = fc.integer({ min: 1, max: 12 });
const windowArb = fc.integer({ min: 60, max: 3600 });
const baseSecArb = fc.integer({ min: 0, max: 2_000_000_000 });

/** A per-bucket limits map covering all buckets with the same limit/window. */
function uniformLimits(limit: number, windowSec: number) {
  const out: Record<string, { limit: number; windowSec: number }> = {};
  for (const b of ALL_BUCKETS) out[b] = { limit, windowSec };
  return out;
}

describe("Property 14: Attempt_Counters are independent per-bucket fixed windows", () => {
  // ── Clause 1: fixed-window counting and the allowed boundary (Req 8.1–8.4, 8.6) ──
  // Within one window the i-th request has count === i, allowed === (i <= limit),
  // so the limit-th passes and the (limit+1)-th (and beyond) is rejected. Each
  // stored counter carries an `RL#`-prefixed key and a numeric ttl.
  it("counts sequentially within a window; the limit-th passes and the next is rejected", async () => {
    await fc.assert(
      fc.asyncProperty(
        bucketArb,
        ipArb,
        limitArb,
        windowArb,
        baseSecArb,
        fc.integer({ min: 0, max: 5 }), // extra requests past the limit
        async (bucket, ip, limit, windowSec, baseSec, extra) => {
          const clock = { ms: baseSec * 1000 };
          const { client, limiter } = makeLimiter(uniformLimits(limit, windowSec), clock);
          const total = limit + extra;

          for (let i = 1; i <= total; i++) {
            const res = await limiter.increment(bucket, ip);
            assert.strictEqual(res.count, i, `request ${i} must have count ${i}`);
            assert.strictEqual(res.limit, limit);
            assert.strictEqual(res.allowed, i <= limit, `request ${i} allowed must be i<=limit`);
          }

          // The stored counter uses the RL# key and a numeric epoch-second ttl.
          const stored = client.store.get(keyFor(bucket, ip));
          assert.ok(stored, "counter item must exist");
          assert.ok(stored!.licenseKey.startsWith("RL#"), "key must begin with RL#");
          assert.strictEqual(typeof stored!.ttl, "number");
          assert.ok(Number.isFinite(stored!.ttl as number));
          assert.strictEqual(stored!.ttl, baseSec + windowSec, "ttl opens at windowStart+windowSec");
          assert.strictEqual(stored!.windowStart, baseSec);
        }
      ),
      { numRuns: RUNS }
    );
  });

  // ── Clause 2: per-bucket independence (Req 8.2, 8.5-as-separate-item, 8.6) ──
  // Two distinct buckets for the same IP keep independent counts in distinct
  // items; incrementing one never changes the other's stored counter. This
  // covers total-vs-unknown-key separation (RL#ACT vs RL#ACTUNKNOWN) too.
  it("keeps distinct buckets independent for the same IP", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(bucketArb, { minLength: 2, maxLength: 2 }),
        ipArb,
        limitArb,
        windowArb,
        baseSecArb,
        fc.array(fc.boolean(), { minLength: 0, maxLength: 20 }), // true -> bucketA, false -> bucketB
        async ([bucketA, bucketB], ip, limit, windowSec, baseSec, hits) => {
          const clock = { ms: baseSec * 1000 };
          const { client, limiter } = makeLimiter(uniformLimits(limit, windowSec), clock);

          let countA = 0;
          let countB = 0;
          for (const goA of hits) {
            if (goA) {
              countA++;
              const r = await limiter.increment(bucketA, ip);
              assert.strictEqual(r.count, countA);
            } else {
              countB++;
              const r = await limiter.increment(bucketB, ip);
              assert.strictEqual(r.count, countB);
            }
          }

          const itemA = client.store.get(keyFor(bucketA, ip));
          const itemB = client.store.get(keyFor(bucketB, ip));
          assert.strictEqual(itemA?.reqCount ?? 0, countA);
          assert.strictEqual(itemB?.reqCount ?? 0, countB);
          // Distinct backing items.
          assert.notStrictEqual(keyFor(bucketA, ip), keyFor(bucketB, ip));
        }
      ),
      { numRuns: RUNS }
    );
  });

  // ── Clause 3: per-IP independence (Req 8.10 identity by source IP) ──
  // The same bucket counts each source IP separately.
  it("keeps distinct source IPs independent within one bucket", async () => {
    await fc.assert(
      fc.asyncProperty(
        bucketArb,
        fc.uniqueArray(ipArb, { minLength: 2, maxLength: 2 }),
        limitArb,
        windowArb,
        baseSecArb,
        fc.array(fc.boolean(), { minLength: 0, maxLength: 20 }),
        async (bucket, [ipA, ipB], limit, windowSec, baseSec, hits) => {
          const clock = { ms: baseSec * 1000 };
          const { client, limiter } = makeLimiter(uniformLimits(limit, windowSec), clock);

          let countA = 0;
          let countB = 0;
          for (const goA of hits) {
            if (goA) {
              countA++;
              await limiter.increment(bucket, ipA);
            } else {
              countB++;
              await limiter.increment(bucket, ipB);
            }
          }

          assert.strictEqual(client.store.get(keyFor(bucket, ipA))?.reqCount ?? 0, countA);
          assert.strictEqual(client.store.get(keyFor(bucket, ipB))?.reqCount ?? 0, countB);
        }
      ),
      { numRuns: RUNS }
    );
  });

  // ── Clause 4: window reset after elapsed time (Req 8.11) ──
  // After the window elapses, the first request opens a new window with count 1
  // and is processed (allowed); a request that arrives before the window elapses
  // keeps accumulating.
  it("resets to count 1 on the first request after the window elapses", async () => {
    await fc.assert(
      fc.asyncProperty(
        bucketArb,
        ipArb,
        limitArb,
        windowArb,
        baseSecArb,
        fc.integer({ min: 1, max: 8 }), // requests in the first window
        async (bucket, ip, limit, windowSec, baseSec, firstWindowHits) => {
          const clock = { ms: baseSec * 1000 };
          const { client, limiter } = makeLimiter(uniformLimits(limit, windowSec), clock);

          let last = 0;
          for (let i = 1; i <= firstWindowHits; i++) {
            const r = await limiter.increment(bucket, ip);
            last = r.count;
          }
          assert.strictEqual(last, firstWindowHits);

          // Advance strictly less than the window: still the same window.
          if (windowSec > 1) {
            clock.ms = (baseSec + windowSec - 1) * 1000;
            const stillSame = await limiter.increment(bucket, ip);
            assert.strictEqual(stillSame.count, firstWindowHits + 1, "sub-window request keeps counting");
          }

          // Advance to exactly the window boundary: a fresh window opens.
          const afterWindowStart = baseSec + windowSec;
          clock.ms = (afterWindowStart + windowSec) * 1000; // well past the boundary
          const reset = await limiter.increment(bucket, ip);
          assert.strictEqual(reset.count, 1, "first request in the new window counts 1");
          assert.strictEqual(reset.allowed, true, "a fresh-window request is processed");
          assert.strictEqual(reset.windowStart, afterWindowStart + windowSec);

          const stored = client.store.get(keyFor(bucket, ip));
          assert.strictEqual(stored?.reqCount, 1);
          assert.strictEqual(stored?.windowStart, afterWindowStart + windowSec);
          assert.strictEqual(stored?.ttl, afterWindowStart + windowSec + windowSec);
        }
      ),
      { numRuns: RUNS }
    );
  });

  // ── Clause 5: peek never writes (Req 8.5) ──
  // A peek performs a read only: it never increments write count, never creates
  // an item, and never changes an existing counter. It reports the current count
  // and allowed = count <= limit, and reads an elapsed window as empty.
  it("peek reports state without ever writing", async () => {
    await fc.assert(
      fc.asyncProperty(
        bucketArb,
        ipArb,
        limitArb,
        windowArb,
        baseSecArb,
        fc.integer({ min: 0, max: 6 }), // prior increments
        async (bucket, ip, limit, windowSec, baseSec, priorHits) => {
          const clock = { ms: baseSec * 1000 };
          const { client, limiter } = makeLimiter(uniformLimits(limit, windowSec), clock);

          // Peek on an empty counter never creates anything.
          const empty = await limiter.peek(bucket, ip);
          assert.deepStrictEqual(empty, { allowed: true, count: 0 });
          assert.strictEqual(client.writes, 0, "peek must not write");
          assert.strictEqual(client.store.size, 0, "peek must not create an item");

          // Establish a counter, remember the write count, then peek repeatedly.
          for (let i = 0; i < priorHits; i++) await limiter.increment(bucket, ip);
          const writesAfterIncrements = client.writes;
          const storedBefore = structuredClone(client.store.get(keyFor(bucket, ip)) ?? null);

          const peeked = await limiter.peek(bucket, ip);
          assert.strictEqual(peeked.count, priorHits, "peek reports the accumulated count");
          assert.strictEqual(peeked.allowed, priorHits <= limit);
          assert.strictEqual(client.writes, writesAfterIncrements, "peek adds no writes");
          assert.deepStrictEqual(
            client.store.get(keyFor(bucket, ip)) ?? null,
            storedBefore,
            "peek leaves the stored counter byte-identical"
          );

          // After the window elapses, peek reads it as empty and still writes nothing.
          clock.ms = (baseSec + windowSec) * 1000;
          const elapsed = await limiter.peek(bucket, ip);
          assert.deepStrictEqual(elapsed, { allowed: true, count: 0 });
          assert.strictEqual(client.writes, writesAfterIncrements, "peek on elapsed window writes nothing");
        }
      ),
      { numRuns: RUNS }
    );
  });

  // ── Clause 6: counter identity from the request-context source IP (Req 8.10) ──
  // clientIp reads only requestContext.http.sourceIp; any request missing it is
  // attributed to the shared "unknown" counter, and two such requests share one
  // counter per bucket.
  it("derives the counter IP only from requestContext.http.sourceIp, sharing 'unknown' otherwise", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          // Events that carry a source IP.
          fc.record({
            requestContext: fc.record({
              http: fc.record({ sourceIp: fc.constantFrom("203.0.113.9", "198.51.100.1", "8.8.8.8") }),
            }),
          }).map((e) => ({ event: e, expected: e.requestContext.http.sourceIp })),
          // Events with no source IP in context (and a decoy body/header that must be ignored).
          fc.record({
            headers: fc.record({ "x-forwarded-for": fc.constantFrom("1.2.3.4", "9.9.9.9") }),
            body: fc.record({ sourceIp: fc.constantFrom("5.5.5.5", "7.7.7.7") }),
          }).map((e) => ({ event: e, expected: "unknown" })),
          fc.constant({ event: {}, expected: "unknown" }),
          fc.constant({ event: undefined, expected: "unknown" })
        ),
        (sample) => {
          assert.strictEqual(clientIp(sample.event as never), sample.expected);
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("attributes every context-less request to one shared 'unknown' counter per bucket", async () => {
    await fc.assert(
      fc.asyncProperty(
        bucketArb,
        limitArb,
        windowArb,
        baseSecArb,
        fc.integer({ min: 1, max: 6 }),
        async (bucket, limit, windowSec, baseSec, hits) => {
          const clock = { ms: baseSec * 1000 };
          const { client, limiter } = makeLimiter(uniformLimits(limit, windowSec), clock);

          // A mix of context-less events all resolve to "unknown".
          const eventsWithoutIp = [{}, { requestContext: {} }, { requestContext: { http: {} } }];
          let expected = 0;
          for (let i = 0; i < hits; i++) {
            const ev = eventsWithoutIp[i % eventsWithoutIp.length];
            const ip = clientIp(ev as never);
            assert.strictEqual(ip, "unknown");
            expected++;
            await limiter.increment(bucket, ip);
          }

          // Exactly one shared counter for all of them.
          assert.strictEqual(client.store.size, 1);
          assert.strictEqual(client.store.get(keyFor(bucket, "unknown"))?.reqCount, expected);
        }
      ),
      { numRuns: RUNS }
    );
  });

  // ── Clause 7: total and unknown-key counters are distinct items (Req 8.6) ──
  // resolveLimits wires ACTUNKNOWN to the activation window; the total and
  // unknown-key counters for one IP live in separate items and are counted
  // independently, so incrementing the total never disturbs the unknown-key one.
  it("holds the total-request and unknown-key counters as distinct, independent items", async () => {
    await fc.assert(
      fc.asyncProperty(
        ipArb,
        baseSecArb,
        fc.integer({ min: 0, max: 8 }),
        fc.integer({ min: 0, max: 8 }),
        async (ip, baseSec, totalHits, unknownHits) => {
          const clock = { ms: baseSec * 1000 };
          const limits = resolveLimits({}); // built-in defaults
          const { client, limiter } = makeLimiter(limits, clock);

          for (let i = 0; i < totalHits; i++) await limiter.increment(BUCKET_ACTIVATE_TOTAL, ip);
          for (let i = 0; i < unknownHits; i++) await limiter.increment(BUCKET_ACTIVATE_UNKNOWN, ip);

          const totalKey = keyFor(BUCKET_ACTIVATE_TOTAL, ip);
          const unknownKey = keyFor(BUCKET_ACTIVATE_UNKNOWN, ip);
          assert.notStrictEqual(totalKey, unknownKey, "keys must differ");
          assert.strictEqual(client.store.get(totalKey)?.reqCount ?? 0, totalHits);
          assert.strictEqual(client.store.get(unknownKey)?.reqCount ?? 0, unknownHits);
        }
      ),
      { numRuns: RUNS }
    );
  });
});
