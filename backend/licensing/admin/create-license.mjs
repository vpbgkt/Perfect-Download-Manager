// Mints a new license key and writes it to the DynamoDB table.
//
// Usage:
//   node admin/create-license.mjs --region ap-south-1 --table pdm-licenses \
//        --owner "Jane Doe" --plan standard --max-activations 3 --expires 2027-01-01 --features pro,priority \
//        --prefix NEW-YEAR
//
// --expires is optional (omit for a perpetual license).
// --prefix is optional; the value is normalized and validated through the
// shared Key_Generator mirror before any write. An invalid prefix aborts the
// run with a non-zero exit and no PutCommand.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { validateKeyPrefix, generateLicenseKey } from "./lib/keygen.mjs";

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const region = arg("region", process.env.AWS_REGION || "ap-south-1");
const table = arg("table", "pdm-licenses");
const owner = arg("owner", null);
const plan = arg("plan", "standard");
const maxActivations = Number(arg("max-activations", "3"));
const expires = arg("expires", null);
const features = arg("features", "").split(",").map((s) => s.trim()).filter(Boolean);

// Signed entitlements embedded in every token minted for this key. 0 = no client-imposed
// cap (full speed) for a licensed install; the client falls back to its free-tier defaults
// (2 connections / 1 parallel) only when there is no valid token. Override per-plan as needed.
const maxConn = Number(arg("max-conn", "0"));
const maxParallel = Number(arg("max-parallel", "0"));

// Optional Custom_Key_Prefix. Normalize and validate it through the shared
// Key_Generator mirror before constructing the item. A rejected prefix aborts
// the run with a non-zero exit and no PutCommand (Req 5.11).
const prefixArg = arg("prefix", null);
const prefixResult = validateKeyPrefix(prefixArg);
if (!prefixResult.ok) {
  console.error(`invalid prefix: ${prefixResult.error}`);
  process.exit(1);
}
// Normalized prefix (a string) when present, otherwise undefined.
const keyPrefix = prefixResult.value;

// Generate the License_Key, embedding the normalized prefix when supplied.
const licenseKey = generateLicenseKey(keyPrefix);

const ddb = new DynamoDBClient({ region });
const doc = DynamoDBDocumentClient.from(ddb, { marshallOptions: { removeUndefinedValues: true } });

await doc.send(new PutCommand({
  TableName: table,
  Item: {
    licenseKey,
    status: "active",
    plan,
    owner: owner ?? undefined,
    keyPrefix,
    features,
    maxConn,
    maxParallel,
    maxActivations,
    expiresAt: expires ? new Date(expires).toISOString() : undefined,
    activations: {},
    createdAt: new Date().toISOString()
  },
  ConditionExpression: "attribute_not_exists(licenseKey)"
}));

console.log("Created license key:");
console.log("  ", licenseKey);
console.log("Plan:", plan, "| Max activations:", maxActivations,
  "| Expires:", expires ?? "never", "| Features:", features.join(",") || "(none)",
  "| Prefix:", keyPrefix ?? "(none)");
console.log("Entitlements: maxConn:", maxConn || "(uncapped)", "| maxParallel:", maxParallel || "(uncapped)");
