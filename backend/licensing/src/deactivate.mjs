// POST /deactivate  { licenseKey, fingerprint, token }
// Releases this machine's activation seat so the license can be moved to another PC.
//
// AUTHORIZATION (token-gated): the caller must present the current server-signed license token.
// The token is verified with the PUBLIC key and its claims must match the { licenseKey, fingerprint }
// being released. Only the legitimate holder on the bound machine ever received such a token, so a
// third party who merely knows a key + fingerprint cannot grief-release someone else's seat. The
// handler needs no private key (verification is public-key only), so it runs on a minimal
// DynamoDB-only IAM role.
//
// Self-service scope: a valid caller can only FREE a seat (never read data or steal a license). The
// blast radius is limited to releasing an activation the caller could re-create anyway.

import { getLicense, removeActivation } from "./lib/licenses.mjs";
import { verifyToken } from "./lib/tokens.mjs";
import { parseBody, json, validateInputs } from "./lib/http.mjs";
import { clientIp, checkRateLimit } from "./lib/rateLimit.mjs";

const PUBLIC_KEY_B64 = process.env.PUBLIC_KEY_B64 || "";

export const handler = async (event) => {
  const body = parseBody(event);
  const input = validateInputs(body);
  if (input.error) {
    return json(400, { ok: false, message: input.error });
  }

  const { licenseKey, fingerprint } = input;
  const token = typeof body.token === "string" ? body.token : "";

  // Per-IP throttle (defense in depth against release-loop griefing). Fails open so a limiter
  // hiccup never blocks a legitimate deactivation.
  try {
    const rl = await checkRateLimit("DEACT", clientIp(event));
    if (!rl.allowed) {
      return json(429, { ok: false, message: "rate_limited" });
    }
  } catch {
    // ignore limiter errors
  }

  // Token-gate. Verify the signature and require the claims to match the seat being released.
  const claims = verifyToken(token, PUBLIC_KEY_B64);
  const authorized =
    claims &&
    typeof claims.licenseKey === "string" &&
    typeof claims.fingerprint === "string" &&
    claims.licenseKey.toLowerCase() === licenseKey.toLowerCase() &&
    claims.fingerprint.toLowerCase() === fingerprint.toLowerCase();

  if (!authorized) {
    return json(401, { ok: false, message: "unauthorized" });
  }
  // NOTE: token expiry is intentionally NOT enforced — a user in grace/expired state must still be
  // able to release their own seat. A valid signature + claim match already proves prior ownership.

  const license = await getLicense(licenseKey);
  if (!license) {
    // Nothing to release. Report success so the client can still clear local state cleanly.
    return json(200, { ok: true, released: false, message: "License key not found." });
  }

  const activations = license.activations ?? {};
  const wasActivated = Object.prototype.hasOwnProperty.call(activations, fingerprint);

  // Idempotent removal: frees the slot against the activation cap.
  await removeActivation(licenseKey, fingerprint);

  return json(200, { ok: true, released: wasActivated });
};
