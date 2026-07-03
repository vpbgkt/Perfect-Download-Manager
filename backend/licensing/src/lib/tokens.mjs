// Signed license token creation.
//
// A token is a compact, tamper-evident structure:  base64url(payload) "." base64url(signature)
// where payload is canonical JSON and signature is ECDSA P-256 (SHA-256) in DER form — the
// exact format the .NET client verifies with ECDsa.VerifyData(..., DSASignatureFormat.Rfc3279DerSequence).
//
// The private key never leaves the server (loaded from SSM SecureString). A cracker cannot
// mint a valid token without it, so patching the client to "accept any key" still cannot
// produce the signed entitlement the app checks for.

import crypto from "node:crypto";

/** Base64url-encode a Buffer or string (no padding). */
function b64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Builds the canonical JSON payload string. Property order is fixed so the client and server
 * agree byte-for-byte on what was signed.
 */
export function buildPayload({ licenseKey, fingerprint, expiresAt, features, plan, owner }) {
  // Deterministic key order — do not reorder.
  const payload = {
    v: 1,
    licenseKey,
    fingerprint,
    plan: plan ?? "standard",
    owner: owner ?? null,
    features: Array.isArray(features) ? features : [],
    issuedAt: new Date().toISOString(),
    expiresAt, // ISO string
    nonce: crypto.randomBytes(16).toString("hex")
  };
  return JSON.stringify(payload);
}

/**
 * Signs a payload string with the PEM-encoded EC private key and returns the compact token.
 */
export function signToken(payloadJson, privateKeyPem) {
  const key = crypto.createPrivateKey(privateKeyPem);
  const signature = crypto.sign("sha256", Buffer.from(payloadJson, "utf8"), {
    key,
    dsaEncoding: "der"
  });
  return `${b64url(payloadJson)}.${b64url(signature)}`;
}

/**
 * Convenience: build + sign in one call.
 */
export function issueToken(claims, privateKeyPem) {
  const payload = buildPayload(claims);
  return { token: signToken(payload, privateKeyPem), payload: JSON.parse(payload) };
}
