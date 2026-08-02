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
export function buildPayload({ licenseKey, fingerprint, expiresAt, features, plan, owner, maxConn, maxParallel }) {
  // Deterministic key order — do not reorder.
  //
  // maxConn / maxParallel are SIGNED numeric entitlements. The client derives its
  // per-download connection cap and simultaneous-download cap from these values rather
  // than from a local boolean, so patching an "isLicensed" flag no longer unlocks premium
  // throughput — the numbers themselves only exist inside a token signed by this server.
  // A value <= 0 means "no client-imposed cap" (full speed) for a licensed install.
  const payload = {
    v: 2,
    licenseKey,
    fingerprint,
    plan: plan ?? "standard",
    owner: owner ?? null,
    features: Array.isArray(features) ? features : [],
    maxConn: Number.isFinite(maxConn) ? Number(maxConn) : 0,
    maxParallel: Number.isFinite(maxParallel) ? Number(maxParallel) : 0,
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

/**
 * Signs an already-constructed claims object (property order is the caller's responsibility).
 * Used for non-license tokens such as the trial anchor.
 */
export function signClaims(claims, privateKeyPem) {
  const json = JSON.stringify(claims);
  return { token: signToken(json, privateKeyPem), payload: claims };
}

/** base64url-decode to a Buffer. */
function b64urlDecode(s) {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = t.length % 4;
  if (pad === 2) t += "==";
  else if (pad === 3) t += "=";
  else if (pad === 1) throw new Error("invalid base64url length");
  return Buffer.from(t, "base64");
}

/**
 * Verifies a compact token (base64url(payload).base64url(sig)) against the PUBLIC key (SPKI base64)
 * using ECDSA P-256 / SHA-256 / DER — the mirror of signToken and of the .NET client's verifier.
 * Returns the parsed claims object on success, or null on any malformation / signature failure.
 *
 * Verification uses only the public key, so any handler that calls this needs no access to the
 * private signing key (no SSM/KMS permission required).
 */
export function verifyToken(token, publicKeySpkiBase64) {
  if (typeof token !== "string" || token.length === 0 || !publicKeySpkiBase64) {
    return null;
  }
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1 || token.indexOf(".", dot + 1) >= 0) {
    return null; // must have exactly one separator
  }
  let payloadBytes;
  let signature;
  try {
    payloadBytes = b64urlDecode(token.slice(0, dot));
    signature = b64urlDecode(token.slice(dot + 1));
  } catch {
    return null;
  }
  try {
    const key = crypto.createPublicKey({
      key: Buffer.from(publicKeySpkiBase64, "base64"),
      format: "der",
      type: "spki"
    });
    const ok = crypto.verify("sha256", payloadBytes, { key, dsaEncoding: "der" }, signature);
    if (!ok) {
      return null;
    }
    return JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return null;
  }
}
