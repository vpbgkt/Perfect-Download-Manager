// Per-IP rate limiting for the /trial endpoint — now a thin delegate over the shared
// attempt-limiter (`attemptLimit.mjs`).
//
// The standalone fixed-window counter that used to live here has been unified with the activation
// and validation Attempt_Counters. This module survives only to preserve the exact public surface
// that `trial.mjs` depends on — `clientIp(event)` and `checkRateLimit("TRIAL", ip)` — so
// `trial.mjs` and its observable behaviour are unchanged (Req 10.1).
//
// The TRIAL bucket keeps the same `RL#TRIAL#<ip>` item shape, the same `{ allowed, count }` result,
// the same in-place window reset, and the same numeric `ttl` self-expiry the previous
// implementation used; those semantics now come from `attemptLimit.mjs`.

import { docClient, TABLE_NAME } from "./config.mjs";
import { createAttemptLimiter, resolveLimits, clientIp } from "./attemptLimit.mjs";

// Re-export the request-context IP extractor unchanged, so existing importers keep working.
export { clientIp };

// One limiter over the shared collaborators. Limits and windows (including the TRIAL bucket) are
// resolved from the environment exactly as they are for every other bucket.
const limiter = createAttemptLimiter({
  docClient,
  tableName: TABLE_NAME,
  limits: resolveLimits(process.env)
});

/**
 * Fixed-window rate check for a logical bucket ("TRIAL") + IP. Returns { allowed, count },
 * delegating the atomic increment and in-place window reset to the shared attempt-limiter.
 */
export async function checkRateLimit(bucket, ip) {
  const { allowed, count } = await limiter.increment(bucket, ip);
  return { allowed, count };
}
