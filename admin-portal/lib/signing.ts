/**
 * Server-only Release_Manifest builder + ECDSA (P-256) signer.
 *
 * This module runs exclusively inside the Next.js Node process. It builds the
 * client-compatible update manifest, fetches the ECDSA updates signing key from
 * AWS SSM SecureString **at use-time**, signs the manifest payload, and returns
 * only the signed manifest — the private key is NEVER returned, logged, or
 * exposed to any caller or response (Req 8.5, 15.1, 15.2).
 *
 * The manifest shape and signing scheme mirror `backend/updates/sign-release.ps1`
 * so the desktop auto-updater's `.NET` verifier accepts manifests produced here:
 *
 *   - Property order: Version, Channel, PackageUrl, PackageSizeBytes,
 *     PackageSha256, ReleasedUtc, (ReleaseNotes when non-empty).
 *   - `ReleaseNotes` is omitted from the signed payload when empty
 *     (JsonIgnoreCondition.WhenWritingNull parity).
 *   - The signature covers the compact JSON of the manifest WITHOUT the
 *     `Signature` field, computed as ECDSA-SHA256 with DER encoding, base64.
 *
 * SSM access is abstracted behind {@link SsmParameterStore} so tests can supply
 * an in-memory PEM and never touch live AWS.
 *
 * @module lib/signing
 * Requirements: 8.5, 15.1, 15.2
 */

import { createPrivateKey, sign as cryptoSign } from "node:crypto";

// ─── SSM abstraction (injectable) ────────────────────────────────────────────

/**
 * Minimal abstraction over AWS SSM SecureString retrieval. Injecting this means
 * tests supply an in-memory implementation and never require live AWS, while
 * production reads the decrypted key from Parameter Store at the moment of use.
 */
export interface SsmParameterStore {
  /**
   * Fetch and decrypt a SecureString parameter value by name. MUST throw if the
   * parameter is absent or cannot be decrypted.
   */
  getSecureParameter(name: string): Promise<string>;
}

/** Default SSM parameter path holding the ECDSA updates signing key. */
export const DEFAULT_SIGNING_KEY_PARAM = "/pdm/updates/private-key";

// ─── Manifest types ──────────────────────────────────────────────────────────

/**
 * Inputs required to build a manifest, projected by `lib/release` from the
 * portal's Release_Metadata. Contains NO key material.
 */
export interface ManifestInput {
  /** Release version string (e.g. "1.2.0"). */
  version: string;
  /** Update channel (e.g. "Stable" | "Beta"). */
  channel: string;
  /** HTTPS S3 URL of the downloadable package (portable-zip). */
  packageUrl: string;
  /** Size of the package in bytes. */
  packageSizeBytes: number;
  /** Lowercase 64-char hex SHA-256 of the package. */
  packageSha256: string;
  /** ISO 8601 UTC release timestamp. */
  releasedUtc: string;
  /** Optional human-readable release notes. Omitted from the manifest when empty. */
  releaseNotes?: string;
}

/**
 * The unsigned manifest object in the exact property order the desktop client's
 * verifier expects. `ReleaseNotes` is present only when non-empty.
 */
export interface UnsignedManifest {
  Version: string;
  Channel: string;
  PackageUrl: string;
  PackageSizeBytes: number;
  PackageSha256: string;
  ReleasedUtc: string;
  ReleaseNotes?: string;
}

/** A fully-signed manifest: the unsigned fields plus the base64 `Signature`. */
export interface SignedManifest extends UnsignedManifest {
  Signature: string;
}

/**
 * Build the unsigned manifest object with the canonical property order and the
 * empty-release-notes omission rule. This is a pure projection and contains no
 * key material — safe to expose in responses.
 */
export function buildManifest(input: ManifestInput): UnsignedManifest {
  const manifest: UnsignedManifest = {
    Version: input.version,
    Channel: input.channel,
    PackageUrl: input.packageUrl,
    PackageSizeBytes: input.packageSizeBytes,
    PackageSha256: input.packageSha256,
    ReleasedUtc: input.releasedUtc,
  };
  // Mirror the PowerShell signer: only attach ReleaseNotes when it is truthy so
  // the signed payload matches the client's WhenWritingNull serialization.
  if (input.releaseNotes) {
    manifest.ReleaseNotes = input.releaseNotes;
  }
  return manifest;
}

/**
 * Compute the exact byte payload that gets signed: the compact JSON of the
 * unsigned manifest (property order preserved, no `Signature` field). Exported
 * so tests can verify a produced signature against this canonical payload.
 */
export function manifestSigningPayload(manifest: UnsignedManifest): string {
  return JSON.stringify(manifest);
}

// ─── Signer ──────────────────────────────────────────────────────────────────

/** Dependencies for {@link createManifestSigner}. */
export interface SignerDeps {
  /** SSM abstraction from which the signing key is fetched at use-time. */
  ssm: SsmParameterStore;
  /** SSM parameter name of the signing key (defaults to {@link DEFAULT_SIGNING_KEY_PARAM}). */
  keyParamName?: string;
}

/** The manifest-signing API. */
export interface ManifestSigner {
  /**
   * Build and sign a manifest from the given input. Fetches the signing key
   * from SSM at the moment of use, signs the canonical payload, and returns the
   * signed manifest. The private key is never returned or retained.
   */
  signManifest(input: ManifestInput): Promise<SignedManifest>;
}

/**
 * Create a {@link ManifestSigner} bound to an injected {@link SsmParameterStore}.
 *
 * Security invariants:
 *  - The key is read from SSM only inside {@link ManifestSigner.signManifest},
 *    used to produce the signature, and then dropped (never returned, cached,
 *    logged, or written anywhere outside SSM) — Req 15.1, 15.2.
 */
export function createManifestSigner(deps: SignerDeps): ManifestSigner {
  const keyParamName = deps.keyParamName ?? DEFAULT_SIGNING_KEY_PARAM;

  return {
    async signManifest(input: ManifestInput): Promise<SignedManifest> {
      const manifest = buildManifest(input);
      const payload = manifestSigningPayload(manifest);

      // Fetch the decrypted PEM at use-time; it lives only in this local scope.
      const privateKeyPem = await deps.ssm.getSecureParameter(keyParamName);
      const key = createPrivateKey(privateKeyPem);
      const signature = cryptoSign("sha256", Buffer.from(payload, "utf8"), {
        key,
        dsaEncoding: "der",
      });

      // Return only the signed manifest — the key never escapes this function.
      return { ...manifest, Signature: signature.toString("base64") };
    },
  };
}

// ─── Production SSM adapter ──────────────────────────────────────────────────

/**
 * Real {@link SsmParameterStore} backed by AWS SDK v3 `@aws-sdk/client-ssm`. The
 * SDK is imported lazily so merely importing this module (as tests do) never
 * loads or requires live AWS credentials.
 */
export function createSsmParameterStore(region = "ap-south-1"): SsmParameterStore {
  return {
    async getSecureParameter(name: string): Promise<string> {
      const { SSMClient, GetParameterCommand } = await import("@aws-sdk/client-ssm");
      const client = new SSMClient({ region });
      const res = await client.send(
        new GetParameterCommand({ Name: name, WithDecryption: true })
      );
      const value = res.Parameter?.Value;
      if (!value) {
        throw new Error(`SSM parameter ${name} is empty or missing`);
      }
      return value;
    },
  };
}
