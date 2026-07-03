// POST /activate  { licenseKey, fingerprint }
// Activates a license for a machine and returns a signed license token.

import { getPrivateKeyPem, TOKEN_TTL_DAYS } from "./lib/config.mjs";
import { getLicense, recordActivation } from "./lib/licenses.mjs";
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
