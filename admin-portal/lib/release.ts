/**
 * Release_Metadata store + manifest publisher for the Admin & Reseller Portal.
 *
 * Responsibilities:
 *  - Read/persist Release_Metadata (version, MSI_Url, Portable_Zip_Url, MSI +
 *    portable SHA-256 checksums, release notes) in the `pdm-portal-releases`
 *    table (Req 8.1, 8.2).
 *  - Validate submitted S3 URLs and checksums; on any failure the request is
 *    rejected and the stored Release_Metadata is left unchanged (Req 8.3, 8.4).
 *  - Project the metadata into the client-compatible manifest shape
 *    (`Version, Channel, PackageUrl, PackageSizeBytes, PackageSha256,
 *    ReleasedUtc, ReleaseNotes, Signature`) where `PackageUrl`/`PackageSha256`
 *    map from the portable-zip fields the desktop auto-updater consumes.
 *  - Sign the manifest server-side via `lib/signing` (SSM key, never exposed)
 *    and publish `manifest.json` to the release S3 bucket (Req 8.5, 15.1, 15.2).
 *  - Write an Audit_Entry recording the actor, previous version, and new
 *    version (Req 8.6).
 *
 * Every external collaborator (DynamoDB, the manifest signer, the S3 object
 * store, the audit log, and the clock) is injected so the module can be
 * exercised entirely with in-memory fakes and never touch live AWS.
 *
 * @module lib/release
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 15.1, 15.2
 */

import type { AuditLog } from "./audit.ts";
import type { DynamoClient, DynamoItem } from "./dynamo.ts";
import type { ManifestSigner, SignedManifest } from "./signing.ts";
import { validateChecksum, validateReleaseUrl } from "./validation.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

/** DynamoDB table backing the editable Release_Metadata. */
export const RELEASE_TABLE_NAME = "pdm-portal-releases";

/** Partition key attribute of the release table. */
export const RELEASE_PARTITION_KEY = "releaseId";

/** The single, canonical release record id ("current release"). */
export const CURRENT_RELEASE_ID = "current";

/** S3 release bucket the signed manifest is published to (Req 8). */
export const RELEASE_BUCKET = "pdm-updates-452359090613-aps1";

/** Default update channel when none is supplied. */
export const DEFAULT_CHANNEL = "Stable";

/** Audit action recorded on a release publish. */
export const RELEASE_AUDIT_ACTION = "release.update";

// ─── Types ───────────────────────────────────────────────────────────────────

/** The persisted Release_Metadata record shape (mirrors the table schema). */
export interface ReleaseMetadata {
  releaseId: string;
  version: string;
  msiUrl: string;
  portableZipUrl: string;
  msiSha256: string;
  portableSha256: string;
  releaseNotes: string;
  /** Optional size (bytes) of the portable-zip package, surfaced as PackageSizeBytes. */
  portableSizeBytes?: number;
  /** Update channel; defaults to {@link DEFAULT_CHANNEL}. */
  channel?: string;
  updatedAt: string;
}

/** Client-submitted Release_Metadata payload for a publish (Req 8.2). */
export interface ReleaseSubmission {
  version: string;
  msiUrl: string;
  portableZipUrl: string;
  msiSha256: string;
  portableSha256: string;
  releaseNotes?: string;
  portableSizeBytes?: number;
  channel?: string;
}

/** Actor context recorded on the resulting Audit_Entry (Req 8.6). */
export interface ReleaseActor {
  actor: string;
  actorRole: string;
  sourceIp: string;
}

/** A validation failure: which field was rejected and why (Req 8.3, 8.4). */
export interface ReleaseValidationError {
  field: string;
  reason: string;
}

/** Discriminated-union result returned by {@link ReleaseStore.publish}. */
export type ReleaseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ReleaseValidationError };

/** The successful outcome of a publish: persisted metadata + signed manifest. */
export interface PublishOutcome {
  metadata: ReleaseMetadata;
  manifest: SignedManifest;
}

// ─── S3 abstraction (injectable) ─────────────────────────────────────────────

/**
 * Minimal abstraction over S3 object writes. Injecting this means tests supply
 * an in-memory store and never touch live AWS, while production writes the
 * signed `manifest.json` to the release bucket.
 */
export interface ReleaseObjectStore {
  /** Write an object to the release bucket. */
  putObject(params: {
    key: string;
    body: string;
    contentType: string;
  }): Promise<void>;
}

// ─── Dependencies ────────────────────────────────────────────────────────────

/** Dependencies for {@link createReleaseStore}. */
export interface ReleaseStoreDeps {
  dynamo: DynamoClient;
  signer: ManifestSigner;
  objectStore: ReleaseObjectStore;
  audit: AuditLog;
  /** Clock injection for deterministic tests. Returns an ISO 8601 UTC string. */
  now?: () => string;
  /** Table-name override (defaults to {@link RELEASE_TABLE_NAME}). */
  tableName?: string;
}

/** The release-store API surface. */
export interface ReleaseStore {
  /**
   * Return the current Release_Metadata, or `null` when none has been
   * published yet (Req 8.1).
   */
  getCurrent(): Promise<ReleaseMetadata | null>;

  /**
   * Validate, persist, sign, publish, and audit a Release_Metadata submission
   * (Req 8.2–8.6). On a validation failure nothing is persisted and the stored
   * metadata is left unchanged (Req 8.3, 8.4).
   */
  publish(
    submission: ReleaseSubmission,
    actor: ReleaseActor
  ): Promise<ReleaseResult<PublishOutcome>>;
}

// ─── Manifest projection ─────────────────────────────────────────────────────

/**
 * Project persisted Release_Metadata into the manifest signer's input. The
 * portable-zip fields map to `PackageUrl`/`PackageSha256`/`PackageSizeBytes`
 * (the fields the desktop auto-updater consumes). Contains NO key material.
 */
export function projectManifestInput(
  metadata: ReleaseMetadata,
  releasedUtc: string
): {
  version: string;
  channel: string;
  packageUrl: string;
  packageSizeBytes: number;
  packageSha256: string;
  releasedUtc: string;
  releaseNotes?: string;
} {
  return {
    version: metadata.version,
    channel: metadata.channel ?? DEFAULT_CHANNEL,
    packageUrl: metadata.portableZipUrl,
    packageSizeBytes: metadata.portableSizeBytes ?? 0,
    packageSha256: metadata.portableSha256,
    releasedUtc,
    releaseNotes: metadata.releaseNotes || undefined,
  };
}

/** S3 object key for the published manifest of a given channel. */
export function manifestObjectKey(channel: string): string {
  return `${channel.toLowerCase()}/manifest.json`;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a {@link ReleaseStore} from injected collaborators.
 */
export function createReleaseStore(deps: ReleaseStoreDeps): ReleaseStore {
  const dynamo = deps.dynamo;
  const signer = deps.signer;
  const objectStore = deps.objectStore;
  const audit = deps.audit;
  const now = deps.now ?? (() => new Date().toISOString());
  const tableName = deps.tableName ?? RELEASE_TABLE_NAME;

  async function getCurrent(): Promise<ReleaseMetadata | null> {
    const item = await dynamo.get({
      TableName: tableName,
      Key: { [RELEASE_PARTITION_KEY]: CURRENT_RELEASE_ID },
    });
    return (item as ReleaseMetadata | null) ?? null;
  }

  async function publish(
    submission: ReleaseSubmission,
    actor: ReleaseActor
  ): Promise<ReleaseResult<PublishOutcome>> {
    // ── Validate every client-supplied input BEFORE any persistence so a
    //    rejected request leaves the stored Release_Metadata unchanged
    //    (Req 8.3, 8.4, 15.4).
    if (typeof submission.version !== "string" || submission.version.trim().length === 0) {
      return fail("version", "Version must be a non-empty string");
    }

    const msiUrl = validateReleaseUrl(submission.msiUrl);
    if (!msiUrl.ok) return fail("msiUrl", msiUrl.error);

    const portableZipUrl = validateReleaseUrl(submission.portableZipUrl);
    if (!portableZipUrl.ok) return fail("portableZipUrl", portableZipUrl.error);

    const msiSha256 = validateChecksum(submission.msiSha256);
    if (!msiSha256.ok) return fail("msiSha256", msiSha256.error);

    const portableSha256 = validateChecksum(submission.portableSha256);
    if (!portableSha256.ok) return fail("portableSha256", portableSha256.error);

    // Read the previous version for the audit trail (Req 8.6).
    const previous = await getCurrent();
    const timestamp = now();

    const metadata: ReleaseMetadata = {
      releaseId: CURRENT_RELEASE_ID,
      version: submission.version.trim(),
      msiUrl: msiUrl.value,
      portableZipUrl: portableZipUrl.value,
      msiSha256: msiSha256.value,
      portableSha256: portableSha256.value,
      releaseNotes: submission.releaseNotes ?? "",
      channel: submission.channel ?? DEFAULT_CHANNEL,
      portableSizeBytes: submission.portableSizeBytes,
      updatedAt: timestamp,
    };

    // ── Project → sign server-side → publish → persist → audit.
    //    The signer fetches the SSM key at use-time and returns only the signed
    //    manifest; no key material is present in `manifest` (Req 8.5, 15.1, 15.2).
    const manifest = await signer.signManifest(
      projectManifestInput(metadata, timestamp)
    );

    await objectStore.putObject({
      key: manifestObjectKey(metadata.channel ?? DEFAULT_CHANNEL),
      body: JSON.stringify(manifest, null, 2),
      contentType: "application/json",
    });

    await dynamo.put({
      TableName: tableName,
      Item: metadata as unknown as DynamoItem,
    });

    // Audit records actor + previous/new version only — no key material (Req 8.6).
    await audit.writeAuditEntry({
      actor: actor.actor,
      actorRole: actor.actorRole,
      action: RELEASE_AUDIT_ACTION,
      target: CURRENT_RELEASE_ID,
      sourceIp: actor.sourceIp,
      timestamp,
      changes: {
        version: {
          before: previous?.version ?? null,
          after: metadata.version,
        },
      },
    });

    return { ok: true, value: { metadata, manifest } };
  }

  return { getCurrent, publish };
}

function fail(field: string, reason: string): ReleaseResult<never> {
  return { ok: false, error: { field, reason } };
}

// ─── Production S3 adapter ───────────────────────────────────────────────────

/**
 * Real {@link ReleaseObjectStore} backed by AWS SDK v3 `@aws-sdk/client-s3`. The
 * SDK is imported lazily so merely importing this module never loads or
 * requires live AWS credentials.
 */
export function createS3ReleaseObjectStore(
  bucket = RELEASE_BUCKET,
  region = "ap-south-1"
): ReleaseObjectStore {
  return {
    async putObject(params) {
      const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
      const client = new S3Client({ region });
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: params.key,
          Body: params.body,
          ContentType: params.contentType,
        })
      );
    },
  };
}
