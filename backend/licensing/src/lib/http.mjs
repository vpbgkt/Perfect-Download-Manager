// Shared helpers for API Gateway (HTTP API v2) Lambda handlers.

/** Parses a JSON body from an API Gateway v2 event, tolerating base64 encoding. */
export function parseBody(event) {
  if (!event || !event.body) {
    return {};
  }
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    },
    body: JSON.stringify(obj)
  };
}

/** Basic input validation shared by activate/validate. */
export function validateInputs(body) {
  const licenseKey = typeof body.licenseKey === "string" ? body.licenseKey.trim() : "";
  const fingerprint = typeof body.fingerprint === "string" ? body.fingerprint.trim() : "";

  // Fingerprint is a SHA-256 hex string from the client (64 hex chars). Reject anything else
  // so it is always safe to use as a DynamoDB map attribute name.
  if (!/^[A-Za-z0-9\-]{8,128}$/.test(licenseKey)) {
    return { error: "invalid_license_key" };
  }
  if (!/^[A-Fa-f0-9]{16,128}$/.test(fingerprint)) {
    return { error: "invalid_fingerprint" };
  }
  return { licenseKey, fingerprint };
}

/** Computes the effective token expiry: the sooner of subscription end and now + ttlDays. */
export function computeTokenExpiry(subscriptionExpiresAt, ttlDays) {
  const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
  const ttlExpiry = new Date(Date.now() + ttlMs);
  if (!subscriptionExpiresAt) {
    return ttlExpiry.toISOString();
  }
  const sub = new Date(subscriptionExpiresAt);
  return (sub < ttlExpiry ? sub : ttlExpiry).toISOString();
}
