// One-time setup: generate the ECDSA P-256 signing key pair.
//   - The PRIVATE key is stored in SSM Parameter Store as a SecureString (server-only).
//   - The PUBLIC key (SubjectPublicKeyInfo, base64) is printed to embed in the .NET client.
//
// Usage:
//   node admin/generate-keys.mjs --region ap-south-1 --param /pdm/licensing/private-key
//
// Re-running rotates the key. After rotation, update the public key embedded in the client
// and re-issue tokens (old tokens stop verifying). Do this deliberately.

import crypto from "node:crypto";
import { SSMClient, PutParameterCommand } from "@aws-sdk/client-ssm";

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const region = arg("region", process.env.AWS_REGION || "ap-south-1");
const paramName = arg("param", "/pdm/licensing/private-key");

const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
  namedCurve: "prime256v1"
});

const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
const publicSpkiDer = publicKey.export({ type: "spki", format: "der" });
const publicBase64 = Buffer.from(publicSpkiDer).toString("base64");

const ssm = new SSMClient({ region });
await ssm.send(new PutParameterCommand({
  Name: paramName,
  Value: privatePem,
  Type: "SecureString",
  Overwrite: true,
  Description: "PDM licensing ECDSA P-256 private signing key"
}));

console.log("Private key stored in SSM SecureString:", paramName, `(region ${region})`);
console.log("");
console.log("=== Embed this PUBLIC KEY (base64 SPKI) in the .NET client ===");
console.log(publicBase64);
console.log("");
console.log("Set it as PdmLicensing.PublicKeyBase64 (see src/PDM.Licensing/Aws/LicensingConfig.cs).");
