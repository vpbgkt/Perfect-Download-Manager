// POST /validate  { licenseKey, fingerprint }
// Re-checks an already-activated license (heartbeat) and returns a fresh signed token,
// or a revocation message the client acts on.

import { getPrivateKeyPem, TOKEN_TTL_DAYS, docClient, TABLE_NAME } from "./lib/config.mjs";
import { getLicense, touchActivation } from "./lib/licenses.mjs";
import { issueToken } from "./lib/tokens.mjs";
import { parseBody, json, validateInputs, computeTokenExpiry } from "./lib/http.mjs";
import {
  createAttemptLimiter,
  resolveLimits,
  clientIp,
  BUCKET_VALIDATE_TOTAL
} from "./lib/attemptLimit.mjs";

const RATE_LIMITED_BODY = Object.freeze({ valid: false, message: "rate_limited" });

const limiter = createAttemptLimiter({
  docClient,
  tableName: TABLE_NAME,
  limits: resolveLimits(process.env)
});

export const handler = async (event) => {
  const ip = clientIp(event);

  // Per-IP total-request attempt counter (Req 8.2). Fail-open: a counter failure never blocks
  // a legitimate request (Req 8.7).
  let totalAllowed = true;
  try {
    const result = await limiter.increment(BUCKET_VALIDATE_TOTAL, ip);
    totalAllowed = result.allowed;
  } catch (err) {
    // Fail open — log without key material (Req 8.7).
    console.log(JSON.stringify({ event: "attempt_counter_failure", bucket: BUCKET_VALIDATE_TOTAL }));
  }

  if (!totalAllowed) {
    return json(429, RATE_LIMITED_BODY);
  }

  const body = parseBody(event);
  const input = validateInputs(body);
  if (input.error) {
    return json(400, { valid: false, message: input.error });
  }

  const { licenseKey, fingerprint } = input;

  const license = await getLicense(licenseKey);
  if (!license) {
    return json(200, { valid: false, revoked: true, message: "License key not found." });
  }

  if (license.status === "revoked") {
    return json(200, { valid: false, revoked: true, message: "This license has been revoked." });
  }
  if (license.status === "suspended") {
    return json(200, { valid: false, revoked: true, message: "This license is suspended." });
  }

  if (license.expiresAt && new Date(license.expiresAt) < new Date()) {
    return json(200, { valid: false, message: "This license has expired." });
  }

  // The machine must be a known activation for this key.
  const activations = license.activations ?? {};
  if (!Object.prototype.hasOwnProperty.call(activations, fingerprint)) {
    return json(200, {
      valid: false,
      message: "This device is not activated for the license."
    });
  }

  const nowIso = new Date().toISOString();
  try {
    await touchActivation(licenseKey, fingerprint, nowIso);
  } catch {
    // A failed heartbeat write is non-fatal for issuing the token.
  }

  const privateKeyPem = await getPrivateKeyPem();
  const tokenExpiry = computeTokenExpiry(license.expiresAt, TOKEN_TTL_DAYS);

  const { token, payload } = issueToken({
    licenseKey,
    fingerprint,
    expiresAt: tokenExpiry,
    // Signed entitlement cutoff (null = perpetual) so the client's "time left" tracks the
    // real licence, not the short re-validation window.
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
