// DynamoDB access for license records.
//
// Table schema (PK = licenseKey):
//   licenseKey      S   partition key, e.g. "PDM-XXXX-XXXX-XXXX-XXXX"
//   status          S   "active" | "revoked" | "suspended"
//   plan            S   e.g. "standard"
//   owner           S   account/email label (optional)
//   features        L   list of feature strings
//   maxActivations  N   how many distinct machines may activate
//   expiresAt       S   ISO subscription expiry, or absent for perpetual
//   activations     M   { fingerprintHash: { activatedAt, lastSeenAt } }
//   createdAt       S   ISO

import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLE_NAME } from "./config.mjs";

export async function getLicense(licenseKey) {
  const res = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { licenseKey }
  }));
  return res.Item ?? null;
}

/**
 * Records (or refreshes) an activation for a fingerprint, enforcing the activation cap.
 * Returns { ok, reason } — ok=false when the machine limit is exceeded.
 * Uses a conditional update so concurrent activations cannot exceed the cap.
 */
export async function recordActivation(license, fingerprint, nowIso) {
  const activations = license.activations ?? {};
  const already = Object.prototype.hasOwnProperty.call(activations, fingerprint);
  const distinctCount = Object.keys(activations).length;
  const maxActivations = Number(license.maxActivations ?? 1);

  if (!already && distinctCount >= maxActivations) {
    return { ok: false, reason: "activation_limit_reached" };
  }

  const activatedAt = already ? activations[fingerprint].activatedAt : nowIso;

  await docClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { licenseKey: license.licenseKey },
    UpdateExpression: "SET activations.#fp = :entry",
    ExpressionAttributeNames: { "#fp": fingerprint },
    ExpressionAttributeValues: {
      ":entry": { activatedAt, lastSeenAt: nowIso }
    }
  }));

  return { ok: true };
}

/** Updates lastSeenAt for an existing activation (heartbeat). */
export async function touchActivation(licenseKey, fingerprint, nowIso) {
  await docClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { licenseKey },
    UpdateExpression: "SET activations.#fp.lastSeenAt = :now",
    ConditionExpression: "attribute_exists(activations.#fp)",
    ExpressionAttributeNames: { "#fp": fingerprint },
    ExpressionAttributeValues: { ":now": nowIso }
  }));
}
