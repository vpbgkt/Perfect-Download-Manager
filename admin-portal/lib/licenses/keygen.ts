/**
 * License_Key generation for the Admin & Reseller Portal.
 *
 * Produces identifiers in the canonical License_Key format
 * `PDM-XXXX-XXXX-XXXX-XXXX`, where each `XXXX` group is exactly four
 * **uppercase** hexadecimal characters. Randomness comes from
 * `crypto.randomBytes`, matching the existing backend key minter
 * (`backend/licensing/admin/create-license.mjs`) so portal-minted keys are
 * indistinguishable from historically-issued ones.
 *
 * Each group is 2 random bytes rendered as 4 hex characters, giving a 64-bit
 * key space that makes collisions astronomically unlikely; the create flow
 * still guards against collisions with a conditional write plus bounded
 * regeneration (see `lib/licenses/create.ts`).
 *
 * @module lib/licenses/keygen
 * Requirements: 3.1, 3.3
 */

import { randomBytes } from "node:crypto";

/** Human-readable prefix shared by every License_Key. */
export const LICENSE_KEY_PREFIX = "PDM";

/** Number of 4-hex-character groups following the prefix. */
export const LICENSE_KEY_GROUPS = 4;

/**
 * A pluggable key generator. Injecting this into the create flow lets tests
 * force collisions (by returning a fixed value) and verify uniqueness/format
 * without relying on real randomness.
 */
export type KeyGenerator = () => string;

/** Render a single 4-character uppercase-hex group from 2 random bytes. */
function group(): string {
  return randomBytes(2).toString("hex").toUpperCase();
}

/**
 * Generate a cryptographically-random License_Key of the form
 * `PDM-XXXX-XXXX-XXXX-XXXX` (each `XXXX` is four uppercase hex characters).
 */
export function generateLicenseKey(): string {
  const groups: string[] = [];
  for (let i = 0; i < LICENSE_KEY_GROUPS; i++) {
    groups.push(group());
  }
  return `${LICENSE_KEY_PREFIX}-${groups.join("-")}`;
}
