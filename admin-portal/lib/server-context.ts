/**
 * Server-side composition point for the Admin & Reseller Portal.
 *
 * Constructs the {@link Authenticator}'s external collaborators — the DynamoDB
 * document client, the Firebase Admin SDK token verifier, and the email sender —
 * from environment configuration, lazily and memoized.
 *
 * ### Local dev mode
 * When `PORTAL_LOCAL_DEV=1`, the portal runs with an **in-memory** data store
 * (no AWS) seeded with a single super_admin from `DEV_ADMIN_*`, a no-op email
 * sender, and the email-OTP step disabled — so the whole UI can be exercised
 * locally with only Firebase configured. This must NEVER be enabled in
 * production. `PORTAL_DISABLE_OTP=1` disables just the OTP step against real AWS.
 *
 * @module lib/server-context
 * Requirements: 1.1, 1.2, 1.4, 1.8, 15.6
 */

import {
  createAuthenticator,
  createFirebaseTokenVerifier,
  type Authenticator,
  type TokenVerifier,
} from "./auth.ts";
import { createDynamoClient, type DynamoClient } from "./dynamo.ts";
import { FakeEmailSender, ResendEmailSender, type EmailSender } from "./email.ts";
import { FakeDynamoClient } from "./dev/in-memory-dynamo.ts";

/** The lazily-constructed, request-time server dependencies. */
export interface ServerContext {
  authenticator: Authenticator;
  tokenVerifier: TokenVerifier;
  dynamo: DynamoClient;
  emailSender: EmailSender;
  /** True when the email-OTP step is disabled (local dev or PORTAL_DISABLE_OTP). */
  otpDisabled: boolean;
  /** True when running against the in-memory local-dev store. */
  localDev: boolean;
}

/** Default AWS region, matching the existing licensing backend (`ap-south-1`). */
const DEFAULT_REGION = "ap-south-1";

/** Portal DynamoDB tables (+ pdm-licenses) and their partition keys. */
const TABLE_KEYS: Record<string, string> = {
  "pdm-licenses": "licenseKey",
  "pdm-portal-admins": "firebaseUid",
  "pdm-portal-resellers": "resellerAccountId",
  "pdm-portal-apikeys": "apiKeyId",
  "pdm-portal-counters": "counterKey",
  "pdm-portal-seo": "pageId",
  "pdm-portal-releases": "releaseId",
  "pdm-portal-audit": "auditId",
};

function isTrue(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

/**
 * Build an in-memory DynamoDB client seeded with the dev super_admin so the
 * login flow and dashboard work locally without AWS. Data is per-process and
 * resets on restart.
 */
function buildLocalDynamo(): DynamoClient {
  const fake = new FakeDynamoClient();
  for (const [table, pk] of Object.entries(TABLE_KEYS)) {
    fake.registerKeySchema(table, pk);
  }

  const uid = process.env.DEV_ADMIN_UID;
  if (uid) {
    void fake.put({
      TableName: "pdm-portal-admins",
      Item: {
        firebaseUid: uid,
        email: process.env.DEV_ADMIN_EMAIL ?? "admin@example.com",
        role: process.env.DEV_ADMIN_ROLE ?? "super_admin",
        mfaEnrolled: false,
        createdAt: new Date().toISOString(),
      },
    });
  }
  return fake;
}

/**
 * The server context is cached on `globalThis` so it survives module
 * re-instantiation during Next.js dev (Turbopack HMR) and is shared across all
 * Route Handlers in the process. Without this, the in-memory local-dev store
 * would differ per request and an opened session would appear lost.
 */
const GLOBAL_KEY = "__PDM_SERVER_CONTEXT__";
type GlobalWithCtx = typeof globalThis & { [GLOBAL_KEY]?: ServerContext };

/**
 * Build (once) and return the shared server context.
 */
export function getServerContext(): ServerContext {
  const g = globalThis as GlobalWithCtx;
  if (g[GLOBAL_KEY]) return g[GLOBAL_KEY];

  const region = process.env.AWS_REGION ?? DEFAULT_REGION;
  const localDev = isTrue(process.env.PORTAL_LOCAL_DEV);
  const otpDisabled = localDev || isTrue(process.env.PORTAL_DISABLE_OTP);

  const dynamo = localDev ? buildLocalDynamo() : createDynamoClient(region);
  const tokenVerifier = createFirebaseTokenVerifier();

  // Use a no-op email sender when OTP is disabled or no Resend key is present,
  // so the app boots without RESEND_API_KEY during local development.
  const emailSender: EmailSender =
    otpDisabled || !process.env.RESEND_API_KEY
      ? new FakeEmailSender()
      : new ResendEmailSender({
          apiKey: process.env.RESEND_API_KEY,
          from: process.env.OTP_EMAIL_FROM,
        });

  const authenticator = createAuthenticator({
    dynamo,
    tokenVerifier,
    emailSender,
  });

  g[GLOBAL_KEY] = { authenticator, tokenVerifier, dynamo, emailSender, otpDisabled, localDev };
  return g[GLOBAL_KEY];
}

/** Reset the memoized context. Intended for tests. */
export function resetServerContext(): void {
  delete (globalThis as GlobalWithCtx)[GLOBAL_KEY];
}

/** Override the memoized context with explicit collaborators (tests/local). */
export function setServerContext(context: ServerContext): void {
  (globalThis as GlobalWithCtx)[GLOBAL_KEY] = context;
}
