// POST /activate  { licenseKey, fingerprint }
// Activates a license for a machine and returns a signed license token.

import { getPrivateKeyPem, TOKEN_TTL_DAYS, docClient, TABLE_NAME } from "./lib/config.mjs";
import { getLicense, recordActivation } from "./lib/licenses.mjs";
import { issueToken } from "./lib/tokens.mjs";
import { parseBody, json, validateInputs, computeTokenExpiry } from "./lib/http.mjs";
import {
  createAttemptLimiter,
  resolveLimits,
  clientIp,
  BUCKET_ACTIVATE_TOTAL,
  BUCKET_ACTIVATE_UNKNOWN
} from "./lib/attemptLimit.mjs";

// Shared frozen 429 body — identical for every rejection, no key echo, no existence hint
// (Req 8.8). Returned before any token is issued or any activations write is attempted (Req 8.12).
const RATE_LIMITED_BODY = Object.freeze({ valid: false, message: "rate_limited" });

// One limiter instance per container, resolved from the environment (Req 8.9).
const limiter = createAttemptLimiter({
  docClient,
  tableName: TABLE_NAME,
  limits: resolveLimits(process.env)
});

/**
 * Wraps an attempt-counter call so that any failure is treated as "not limited" and logged
 * without key material (Req 8.7). Returns the counter result on success, or a permissive
 * fallback on failure.
 */
async function safeCounter(fn, bucket) {
  try {
    return await fn();
  } catch (err) {
    console.log(JSON.stringify({ event: "attempt_counter_failure", bucket }));
    return { allowed: true, count: 0 };
  }
}

export const handler = async (event) => {
  const ip = clientIp(event);

  // --- Rate limiting preamble (Req 8.1, 8.3) ---
  // Step 1: Increment the total-request counter for this IP.
  const totalResult = await safeCounter(
    () => limiter.increment(BUCKET_ACTIVATE_TOTAL, ip),
    BUCKET_ACTIVATE_TOTAL
  );
  if (!totalResult.allowed) {
    return json(429, RATE_LIMITED_BODY);
  }

  // Step 2: Peek at the unknown-key counter (non-writing, Req 8.5).
  const unknownPeek = await safeCounter(
    () => limiter.peek(BUCKET_ACTIVATE_UNKNOWN, ip),
    BUCKET_ACTIVATE_UNKNOWN
  );
  if (!unknownPeek.allowed) {
    return json(429, RATE_LIMITED_BODY);
  }

  // --- Existing input validation and key lookup (byte-identical responses, Req 10.1) ---
  const body = parseBody(event);
  const input = validateInputs(body);
  if (input.error) {
    return json(400, { valid: false, message: input.error });
  }

  const { licenseKey, fingerprint } = input;

  const license = await getLicense(licenseKey);
  if (!license) {
    // No License_Record resolves — increment the unknown-key counter (Req 8.4).
    const unknownResult = await safeCounter(
      () => limiter.increment(BUCKET_ACTIVATE_UNKNOWN, ip),
      BUCKET_ACTIVATE_UNKNOWN
    );
    if (!unknownResult.allowed) {
      return json(429, RATE_LIMITED_BODY);
    }
    return json(200, { valid: false, message: "License key not found." });
  }

  if (license.status === "revoked") {
    return json(200, { valid: false, message: "This license has been revoked." });
  }
  if (license.status === "suspended") {
    return json(200, { valid: false, message: "This license is suspended." });
  }
  if (license.status !== "active") {
    return json(200, { valid: false, message: "This license is not active." });
  }

  if (license.expiresAt && new Date(license.expiresAt) < new Date()) {
    return json(200, { valid: false, message: "This license has expired." });
  }

  const nowIso = new Date().toISOString();
  const activation = await recordActivation(license, fingerprint, nowIso);
  if (!activation.ok) {
    return json(200, {
      valid: false,
      message: "Activation limit reached for this license. Deactivate another device first."
    });
  }

  const privateKeyPem = await getPrivateKeyPem();
  const tokenExpiry = computeTokenExpiry(license.expiresAt, TOKEN_TTL_DAYS);

  const { token, payload } = issueToken({
    licenseKey,
    fingerprint,
    expiresAt: tokenExpiry,
    // The real entitlement cutoff, signed so the client can display "time left" from it
    // instead of from the short token TTL. null = perpetual licence.
    subscriptionExpiresAt: license.expiresAt ?? null,
    features: license.features ?? [],
    plan: license.plan ?? "standard",
    owner: license.owner ?? null,
    maxConn: license.maxConn,
    maxParallel: license.maxParallel
  }, privateKeyPem);

  return json(200, {
    valid: true,
    token,
    owner: payload.owner,
    plan: payload.plan,
    features: payload.features,
    subscriptionExpiresAt: license.expiresAt ?? null,
    tokenExpiresAt: payload.expiresAt
  });
};
