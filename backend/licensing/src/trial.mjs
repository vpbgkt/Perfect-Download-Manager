// POST /trial  { fingerprint }
// Returns a SIGNED trial anchor for this machine. The server records the first-seen time per
// fingerprint, so reinstalling the app, deleting local files, or editing the registry cannot
// reset the trial — the same fingerprint always gets back its original start date.

import crypto from "node:crypto";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLE_NAME, getPrivateKeyPem } from "./lib/config.mjs";
import { signClaims } from "./lib/tokens.mjs";
import { parseBody, json } from "./lib/http.mjs";
import { clientIp, checkRateLimit } from "./lib/rateLimit.mjs";

const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || "14");

export const handler = async (event) => {
  const body = parseBody(event);
  const fingerprint = typeof body.fingerprint === "string" ? body.fingerprint.trim() : "";

  if (!/^[A-Fa-f0-9]{16,128}$/.test(fingerprint)) {
    return json(400, { ok: false, message: "invalid_fingerprint" });
  }

  // M1: throttle trial-anchor requests per IP to blunt fingerprint-rotation trial farming.
  // A rate-limited caller simply gets no server anchor and falls back to a local trial start.
  try {
    const rl = await checkRateLimit("TRIAL", clientIp(event));
    if (!rl.allowed) {
      return json(429, { ok: false, message: "rate_limited" });
    }
  } catch {
    // A rate-limiter failure must never block a legitimate trial; fail open.
  }

  const key = `TRIAL#${fingerprint}`;
  const nowIso = new Date().toISOString();

  // Read the existing anchor, or create one atomically if this fingerprint is new.
  let trialStartUtc = nowIso;
  const existing = await docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: { licenseKey: key } }));
  if (existing.Item && existing.Item.trialStartUtc) {
    trialStartUtc = existing.Item.trialStartUtc;
  } else {
    try {
      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: { licenseKey: key, type: "trial", trialStartUtc: nowIso, createdAt: nowIso },
        ConditionExpression: "attribute_not_exists(licenseKey)"
      }));
      trialStartUtc = nowIso;
    } catch {
      // Lost a race: another request created it first. Re-read the authoritative value.
      const reread = await docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: { licenseKey: key } }));
      trialStartUtc = reread.Item?.trialStartUtc ?? nowIso;
    }
  }

  const privateKeyPem = await getPrivateKeyPem();
  const claims = {
    v: 1,
    type: "trial",
    fingerprint,
    trialStartUtc,
    trialDays: TRIAL_DAYS,
    issuedAt: nowIso,
    nonce: crypto.randomBytes(16).toString("hex")
  };
  const { token } = signClaims(claims, privateKeyPem);

  return json(200, { ok: true, token, trialStartUtc, trialDays: TRIAL_DAYS });
};
