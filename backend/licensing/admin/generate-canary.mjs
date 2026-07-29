// Generates the licensing CANARY token (anti key-swap, C2).
//
// The canary is a fixed claims payload signed with the licensing PRIVATE key (read from SSM).
// It is embedded in the client as LicensingConfig.LicensingCanaryToken. At startup the client
// verifies it with the embedded PUBLIC key; if an attacker swaps the public key for their own to
// sign forged license tokens, the canary (signed by the real key) no longer verifies and the app
// disables activation. Producing a valid canary requires this private key, which never leaves AWS.
//
// The private key is read into memory only, used to sign, and never printed or logged.
//
// Usage:
//   node admin/generate-canary.mjs --region ap-south-1 --param /pdm/licensing/private-key

import crypto from "node:crypto";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { signToken } from "../src/lib/tokens.mjs";

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const region = arg("region", process.env.AWS_REGION || "ap-south-1");
const paramName = arg("param", "/pdm/licensing/private-key");

const ssm = new SSMClient({ region });
const res = await ssm.send(new GetParameterCommand({ Name: paramName, WithDecryption: true }));
const privateKeyPem = res.Parameter?.Value;
if (!privateKeyPem) {
  console.error("Signing key not found in SSM:", paramName);
  process.exit(1);
}

// Fixed, non-secret canary claims. Shape mirrors a license payload so it flows through the same
// verification path on the client; only the SIGNATURE matters for the key-trust check.
const claims = {
  v: 1,
  type: "canary",
  licenseKey: "PDM-CANARY-0000-0000-0000",
  fingerprint: "canary",
  issuedAt: new Date().toISOString(),
  nonce: crypto.randomBytes(16).toString("hex")
};

const token = signToken(JSON.stringify(claims), privateKeyPem);

console.log("=== Embed this as LicensingConfig.LicensingCanaryToken ===");
console.log(token);
