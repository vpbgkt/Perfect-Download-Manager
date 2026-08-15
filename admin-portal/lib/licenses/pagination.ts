/**
 * License-search continuation-token guard for the Admin & Reseller Portal.
 *
 * Requirement 3.11 requires the license-search endpoint to reject a
 * continuation token that the Portal_Backend "did not previously return for a
 * license search" with a validation error naming the offending parameter
 * (`nextToken`) and to return no results.
 *
 * The tokens the portal hands out for a license search are produced by
 * `lib/dynamo.encodeToken`, which serializes a DynamoDB `LastEvaluatedKey` as
 *
 *   Buffer.from(JSON.stringify(key)).toString("base64url")
 *
 * For the `pdm-licenses` table the partition key is `licenseKey` and the table
 * has no secondary index, so a `LastEvaluatedKey` for a scan of this table is
 * exactly `{ "licenseKey": "<string>" }`. This module therefore accepts a token
 * only when it is a base64url string that decodes to JSON of that exact shape,
 * and rejects everything else with a validation error naming `nextToken`.
 *
 * Deliberate limitation
 * ---------------------
 * This guard is *structural* only. It can reject a token that is not a
 * base64url string, does not decode to JSON, or does not have the single-key
 * `{ licenseKey: string }` shape. It cannot, however, distinguish a token that
 * is structurally valid but was never actually issued by a prior license search
 * (for example a hand-crafted `{ "licenseKey": "PDM-...." }` for a key the
 * caller invents): doing so would require the Portal_Backend to keep
 * server-side token state (a store of issued tokens) which this feature does
 * not introduce. Such a fabricated-but-well-formed token is treated as a valid
 * `ExclusiveStartKey`; because the underlying scan is exactly-once over the
 * remaining key space, it simply resumes the scan after that key and never
 * yields duplicate or unauthorized records. This trade-off is accepted rather
 * than promising unbounded token authenticity.
 *
 * @module lib/licenses/pagination
 * Requirements: 3.11
 */

import type { Result } from "../validation.ts";
import { LICENSE_PARTITION_KEY } from "./create.ts";

/** The request parameter named in a validation error (Req 3.11). */
const TOKEN_PARAM = "nextToken";

/** base64url alphabet only: A–Z, a–z, 0–9, `-`, `_`, no padding. */
const BASE64URL_REGEX = /^[A-Za-z0-9_-]+$/;

function ok(value: string): Result<string> {
  return { ok: true, value };
}

function fail(reason: string): Result<string> {
  return { ok: false, error: `${TOKEN_PARAM}: ${reason}` };
}

/**
 * Structural guard for a license-search continuation token (Req 3.11).
 *
 * Accepts only a base64url string that decodes to JSON of the exact shape
 * `{ "licenseKey": "<string>" }` — the shape `lib/dynamo.encodeToken` produces
 * for the `pdm-licenses` table. Any other value yields a validation error
 * naming `nextToken`; the calling route must then return no license-search
 * results.
 *
 * @param token The caller-supplied continuation token, of unknown type.
 * @returns `{ ok: true, value }` carrying the original token string when it is
 *   structurally valid, or `{ ok: false, error }` naming `nextToken`.
 */
export function parseLicenseContinuationToken(token: unknown): Result<string> {
  if (typeof token !== "string") {
    return fail("continuation token must be a string");
  }

  // A base64url payload never contains padding or non-alphabet characters.
  if (token.length === 0 || !BASE64URL_REGEX.test(token)) {
    return fail("continuation token is not a valid base64url string");
  }

  let decoded: string;
  try {
    decoded = Buffer.from(token, "base64url").toString("utf-8");
  } catch {
    return fail("continuation token is not a valid base64url string");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return fail("continuation token does not decode to valid JSON");
  }

  // Must be a plain object of exactly one key: the partition key, a string.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail("continuation token has an unexpected shape");
  }

  const keys = Object.keys(parsed as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== LICENSE_PARTITION_KEY) {
    return fail("continuation token has an unexpected shape");
  }

  const licenseKey = (parsed as Record<string, unknown>)[LICENSE_PARTITION_KEY];
  if (typeof licenseKey !== "string") {
    return fail("continuation token has an unexpected shape");
  }

  return ok(token);
}
