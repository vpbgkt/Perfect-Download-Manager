// Feature: admin-reseller-portal, Property 19: Release URL validation
//
// For any submitted MSI_Url or Portable_Zip_Url, the value is accepted only if
// it is an `https` URL whose host is the S3 bucket
// `pdm-updates-452359090613-aps1`; otherwise the request is rejected.
//
// Validates: Requirements 8.3

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { validateReleaseUrl } from "../lib/validation.ts";

const NUM_RUNS = 100;

const S3_BUCKET = "pdm-updates-452359090613-aps1";

/** AWS region tokens used to build regional S3 endpoints. */
const regionArb = fc.constantFrom(
  "ap-south-1",
  "us-east-1",
  "us-west-2",
  "eu-west-1",
  "ap-southeast-2"
);

/** A URL-safe object-key path segment (no slashes, non-empty). */
const keySegmentArb = fc
  .string({ minLength: 1, maxLength: 12, unit: "grapheme-ascii" })
  .map((s) => s.replace(/[^A-Za-z0-9._-]/g, "x"))
  // Exclude empty and dot segments ("." / "..") that URL path normalization
  // would collapse, which would change the pathname the validator inspects.
  .filter((s) => s.length > 0 && s !== "." && s !== "..");

/** An object key such as `v1.2.3/installer.msi`. */
const objectKeyArb = fc
  .array(keySegmentArb, { minLength: 1, maxLength: 4 })
  .map((parts) => parts.join("/"));

// ---------------------------------------------------------------------------
// Generators for VALID release URLs (all four accepted host forms)
// ---------------------------------------------------------------------------

const validUrlArb = fc.oneof(
  // Virtual-hosted style, no region
  objectKeyArb.map(
    (key) => `https://${S3_BUCKET}.s3.amazonaws.com/${key}`
  ),
  // Virtual-hosted style with region
  fc
    .tuple(regionArb, objectKeyArb)
    .map(([region, key]) => `https://${S3_BUCKET}.s3.${region}.amazonaws.com/${key}`),
  // Path style, no region
  objectKeyArb.map((key) => `https://s3.amazonaws.com/${S3_BUCKET}/${key}`),
  // Path style with region
  fc
    .tuple(regionArb, objectKeyArb)
    .map(([region, key]) => `https://s3.${region}.amazonaws.com/${S3_BUCKET}/${key}`)
);

// ---------------------------------------------------------------------------
// Generators for INVALID release URLs
// ---------------------------------------------------------------------------

// A host that is definitely not the target bucket / S3 endpoint.
const wrongHostArb = fc.constantFrom(
  "example.com",
  "other-bucket.s3.amazonaws.com",
  "pdm-updates.s3.amazonaws.com",
  "evil.com",
  "s3.amazonaws.com.attacker.net",
  "attacker.net"
);

const invalidUrlArb = fc.oneof(
  // Correct bucket but wrong (non-https) scheme.
  fc
    .tuple(
      fc.constantFrom("http", "ftp", "s3", "file"),
      objectKeyArb
    )
    .map(([scheme, key]) => `${scheme}://${S3_BUCKET}.s3.amazonaws.com/${key}`),
  // https but wrong host entirely.
  fc.tuple(wrongHostArb, objectKeyArb).map(([host, key]) => `https://${host}/${key}`),
  // https path-style pointing at a different bucket.
  objectKeyArb.map((key) => `https://s3.amazonaws.com/some-other-bucket/${key}`),
  // Bucket name only appears as a path segment on a non-S3 host.
  objectKeyArb.map((key) => `https://cdn.example.com/${S3_BUCKET}/${key}`),
  // Arbitrary junk strings.
  fc.string({ maxLength: 40 })
);

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe("Property 19: Release URL validation", () => {
  it("accepts any https URL under the S3 bucket, echoing the trimmed value", () => {
    fc.assert(
      fc.property(validUrlArb, (url) => {
        const result = validateReleaseUrl(url);
        assert.strictEqual(result.ok, true, `expected accept for ${url}`);
        if (result.ok) {
          assert.strictEqual(result.value, url);
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("accepts valid URLs regardless of surrounding whitespace", () => {
    fc.assert(
      fc.property(validUrlArb, (url) => {
        const result = validateReleaseUrl(`  ${url}  `);
        assert.strictEqual(result.ok, true, `expected accept for padded ${url}`);
        if (result.ok) {
          assert.strictEqual(result.value, url);
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("rejects URLs that are not https or not under the target bucket", () => {
    fc.assert(
      fc.property(invalidUrlArb, (url) => {
        const result = validateReleaseUrl(url);
        assert.strictEqual(result.ok, false, `expected reject for ${url}`);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("rejects any non-string input", () => {
    const nonStringArb = fc.oneof(
      fc.integer(),
      fc.double(),
      fc.boolean(),
      fc.constant(null),
      fc.constant(undefined),
      fc.object(),
      fc.array(fc.anything())
    );
    fc.assert(
      fc.property(nonStringArb, (value) => {
        const result = validateReleaseUrl(value);
        assert.strictEqual(result.ok, false);
      }),
      { numRuns: NUM_RUNS }
    );
  });
});
