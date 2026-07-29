// Lightweight per-IP rate limiting (M1), backed by the existing DynamoDB table.
//
// A fixed-window counter keyed by client IP. One atomic UpdateItem per call (~1 WCU, pennies at
// scale) and no new dependencies, so cold-start and cost are unaffected. Items self-expire via
// DynamoDB TTL on the `ttl` attribute (a Number epoch) — a name deliberately distinct from the
// license records' ISO `expiresAt`, so TTL never touches real license/trial rows.
//
// Primary use: blunt trial-farming, where an attacker rotates machine fingerprints to mint endless
// trials. This is best-effort abuse friction, not a hard security boundary — the signed token model
// remains the real control.

import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLE_NAME } from "./config.mjs";

const LIMIT = Number(process.env.TRIAL_RATE_LIMIT || "20");
const WINDOW_SEC = Number(process.env.TRIAL_RATE_WINDOW_SEC || "3600");

/** Extracts the caller IP from an API Gateway HTTP API (v2) event. */
export function clientIp(event) {
  return event?.requestContext?.http?.sourceIp || "unknown";
}

/**
 * Fixed-window rate check for a logical bucket ("TRIAL") + IP. Returns { allowed, count }.
 * Increments atomically; when the stored window has elapsed but TTL has not yet purged the row,
 * the window is reset in place.
 */
export async function checkRateLimit(bucket, ip) {
  const nowSec = Math.floor(Date.now() / 1000);
  const key = `RL#${bucket}#${ip}`;

  const res = await docClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { licenseKey: key },
    UpdateExpression:
      "ADD reqCount :one SET #ttl = if_not_exists(#ttl, :exp), windowStart = if_not_exists(windowStart, :now)",
    ExpressionAttributeNames: { "#ttl": "ttl" },
    ExpressionAttributeValues: { ":one": 1, ":exp": nowSec + WINDOW_SEC, ":now": nowSec },
    ReturnValues: "ALL_NEW"
  }));

  let count = Number(res.Attributes?.reqCount ?? 1);
  const windowStart = Number(res.Attributes?.windowStart ?? nowSec);

  if (nowSec - windowStart >= WINDOW_SEC) {
    // Window elapsed (TTL purge lags by up to 48h); reset the counter in place.
    await docClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { licenseKey: key },
      UpdateExpression: "SET reqCount = :one, windowStart = :now, #ttl = :exp",
      ExpressionAttributeNames: { "#ttl": "ttl" },
      ExpressionAttributeValues: { ":one": 1, ":now": nowSec, ":exp": nowSec + WINDOW_SEC }
    }));
    count = 1;
  }

  return { allowed: count <= LIMIT, count };
}
