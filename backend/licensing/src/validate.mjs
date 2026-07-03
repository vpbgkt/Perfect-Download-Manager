// POST /validate  { licenseKey, fingerprint }
// Re-checks an already-activated license (heartbeat) and returns a fresh signed token,
// or a revocation message the client acts on.

import { getPrivateKeyPem, TOKEN_TTL_DAYS } from "./lib/config.mjs";
import { getLicense, touchActivation } from "./lib/licenses.mjs";
import { issueToken } from "./lib/tokens.mjs";
import { parseBody, json, validateInputs, computeTokenExpiry } from "./lib/http.mjs";

export const handler = async (event) => {
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
    features: license.features ?? [],
    plan: license.plan ?? "standard",
    owner: license.owner ?? null
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
