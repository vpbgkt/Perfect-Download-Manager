// Mints a new license key and writes it to the DynamoDB table.
//
// Usage:
//   node admin/create-license.mjs --region ap-south-1 --table pdm-licenses \
//        --owner "Jane Doe" --plan standard --max-activations 3 --expires 2027-01-01 --features pro,priority
//
// --expires is optional (omit for a perpetual license).

import crypto from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

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

// Generates a key like PDM-4F2A-9C1B-7E30-D5A8 using crypto-strong randomness.
function generateKey() {
  const group = () => crypto.randomBytes(2).toString("hex").toUpperCase();
  return `PDM-${group()}-${group()}-${group()}-${group()}`;
}

const licenseKey = generateKey();

const ddb = new DynamoDBClient({ region });
const doc = DynamoDBDocumentClient.from(ddb, { marshallOptions: { removeUndefinedValues: true } });

await doc.send(new PutCommand({
  TableName: table,
  Item: {
    licenseKey,
    status: "active",
    plan,
    owner: owner ?? undefined,
    features,
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
  "| Expires:", expires ?? "never", "| Features:", features.join(",") || "(none)");
