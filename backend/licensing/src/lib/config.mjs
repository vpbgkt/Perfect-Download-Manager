// Runtime configuration + cached secrets for the licensing Lambdas.

import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

const region = process.env.AWS_REGION || "ap-south-1";

export const TABLE_NAME = process.env.LICENSE_TABLE || "pdm-licenses";
export const PRIVATE_KEY_PARAM = process.env.PRIVATE_KEY_PARAM || "/pdm/licensing/private-key";

// Token lifetime: how long a signed token remains valid offline before the client must
// re-validate online. Short enough to enforce revocation promptly, long enough to tolerate
// brief outages.
export const TOKEN_TTL_DAYS = Number(process.env.TOKEN_TTL_DAYS || "14");

const ddb = new DynamoDBClient({ region });
export const docClient = DynamoDBDocumentClient.from(ddb, {
  marshallOptions: { removeUndefinedValues: true }
});

const ssm = new SSMClient({ region });

let cachedPrivateKey = null;

/**
 * Loads the EC private key PEM from SSM Parameter Store (SecureString) once per container.
 * The key is decrypted by SSM/KMS on read; it is never written to logs.
 */
export async function getPrivateKeyPem() {
  if (cachedPrivateKey) {
    return cachedPrivateKey;
  }

  const res = await ssm.send(new GetParameterCommand({
    Name: PRIVATE_KEY_PARAM,
    WithDecryption: true
  }));

  cachedPrivateKey = res.Parameter?.Value;
  if (!cachedPrivateKey) {
    throw new Error("Signing key not configured");
  }
  return cachedPrivateKey;
}
