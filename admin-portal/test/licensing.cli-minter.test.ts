// Feature: license-key-management-enhancements — CLI minter unit tests
//
// Validates: Requirements 5.11, 11.1
//
// Req 5.11: WHEN an operator runs the admin command-line license minter with a
// Custom_Key_Prefix argument, THE Key_Generator SHALL apply the normalization of
// criterion 5.3 and produce a License_Key satisfying criteria 5.1 and 5.6, and
// THE admin command-line license minter SHALL reject a prefix that criterion 5.4
// or criterion 5.5 rejects, reporting an error naming the prefix and creating no
// License_Record.
//
// These unit tests exercise the CLI minter's --prefix handling by spawning the
// actual script as a child process with a deliberately bad DynamoDB endpoint (so
// no real write can occur) and verifying exit codes, stderr output, and key
// format on stdout.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const execFileAsync = promisify(execFile);

const CLI_SCRIPT = path.resolve(
  fileURLToPath(import.meta.url),
  "../../../backend/licensing/admin/create-license.mjs"
);

// We point at a non-routable endpoint so that if validation passes and the
// script attempts a DynamoDB write, it will fail with a network error rather
// than touching a real table. This lets us distinguish "rejected before write"
// (exit 1 with prefix error message) from "attempted write" (exit non-zero with
// a different error, or a timeout).
const DUMMY_ARGS = [
  "--region", "us-east-1",
  "--table", "nonexistent-table",
  "--owner", "test-user",
  "--plan", "standard",
  "--max-activations", "1",
];

/**
 * Spawn the CLI minter with additional arguments. Uses a short timeout and a
 * non-routable DynamoDB endpoint (via AWS_ENDPOINT_URL) to prevent real writes.
 */
async function runCli(
  extraArgs: string[],
  options?: { timeout?: number }
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const timeout = options?.timeout ?? 10_000;
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [CLI_SCRIPT, ...DUMMY_ARGS, ...extraArgs],
      {
        timeout,
        env: {
          ...process.env,
          // Force the AWS SDK to use a non-routable endpoint so PutCommand
          // fails with a connection error rather than hitting real infra.
          AWS_ENDPOINT_URL: "http://192.0.2.1:1",
          // Disable any real credential lookup to speed up failure.
          AWS_ACCESS_KEY_ID: "fake",
          AWS_SECRET_ACCESS_KEY: "fake",
        },
      }
    );
    return { code: 0, stdout, stderr };
  } catch (err: any) {
    return {
      code: err.code === "ETIMEDOUT" ? null : (err.status ?? err.code ?? 1),
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

describe("CLI minter --prefix handling (Req 5.11, 11.1)", () => {
  // -------------------------------------------------------------------------
  // 1. Prefix normalization: the CLI normalizes before validating (Req 5.3)
  // -------------------------------------------------------------------------
  describe("--prefix normalization", () => {
    it("normalizes lowercase to uppercase", async () => {
      // "hello" normalizes to "HELLO" which is valid (5 chars, A-Z only).
      // The script will pass validation and attempt a DynamoDB write which
      // will fail with a network error — that's fine; the important thing is
      // it does NOT exit 1 with "invalid prefix".
      const result = await runCli(["--prefix", "hello"]);
      // A write attempt means the prefix was accepted (not rejected).
      assert.notStrictEqual(result.stderr.includes("invalid prefix"), true,
        "a valid prefix after normalization must not be rejected");
    });

    it("normalizes underscores and whitespace to hyphens", async () => {
      // "new_year" → "NEW-YEAR" (valid)
      const result = await runCli(["--prefix", "new_year"]);
      assert.ok(
        !result.stderr.includes("invalid prefix"),
        "underscores should normalize to hyphens and pass validation"
      );
    });

    it("collapses consecutive hyphens into one", async () => {
      // "A--B" → "A-B" (valid)
      const result = await runCli(["--prefix", "A--B"]);
      assert.ok(
        !result.stderr.includes("invalid prefix"),
        "consecutive hyphens should collapse and pass validation"
      );
    });

    it("strips leading and trailing whitespace and hyphens", async () => {
      // "  -PROMO-  " → "PROMO" (valid)
      const result = await runCli(["--prefix", "  -PROMO-  "]);
      assert.ok(
        !result.stderr.includes("invalid prefix"),
        "leading/trailing whitespace and hyphens should be stripped"
      );
    });
  });

  // -------------------------------------------------------------------------
  // 2. Rejection of illegal prefixes (Req 5.4, 5.5)
  // -------------------------------------------------------------------------
  describe("rejection of illegal prefixes", () => {
    it("rejects a prefix with illegal characters (Req 5.4) with non-zero exit and no write", async () => {
      // "HELLO@WORLD" → normalized "HELLO@WORLD", '@' is illegal.
      const result = await runCli(["--prefix", "HELLO@WORLD"]);
      assert.strictEqual(result.code, 1,
        "an illegal-character prefix must cause exit code 1");
      assert.ok(
        result.stderr.includes("invalid prefix"),
        "stderr must report 'invalid prefix' for a charset violation"
      );
      // No stdout key output means no write was attempted.
      assert.ok(
        !result.stdout.includes("Created license key"),
        "no License_Record should be created when the prefix is rejected"
      );
    });

    it("rejects a prefix that is too long after normalization (Req 5.5)", async () => {
      // 33 valid characters → exceeds MAX_CUSTOM_PREFIX_LENGTH (32)
      const tooLong = "A".repeat(33);
      const result = await runCli(["--prefix", tooLong]);
      assert.strictEqual(result.code, 1,
        "a too-long prefix must cause exit code 1");
      assert.ok(
        result.stderr.includes("invalid prefix"),
        "stderr must report 'invalid prefix' for a length violation"
      );
      assert.ok(
        !result.stdout.includes("Created license key"),
        "no License_Record should be created when the prefix is rejected"
      );
    });

    it("rejects a prefix containing only special characters that normalize to empty (Req 5.5)", async () => {
      // "___" normalizes to "" after replacing underscores with hyphens and
      // stripping leading/trailing hyphens → length 0 < MIN (1).
      const result = await runCli(["--prefix", "___"]);
      assert.strictEqual(result.code, 1,
        "a prefix normalizing to empty must cause exit code 1");
      assert.ok(
        result.stderr.includes("invalid prefix"),
        "stderr must report 'invalid prefix' for a length violation"
      );
      assert.ok(
        !result.stdout.includes("Created license key"),
        "no License_Record should be created when the prefix is rejected"
      );
    });

    it("rejects a prefix with Unicode characters (Req 5.4)", async () => {
      const result = await runCli(["--prefix", "HÉLLO"]);
      assert.strictEqual(result.code, 1,
        "a prefix with non-ASCII chars must cause exit code 1");
      assert.ok(
        result.stderr.includes("invalid prefix"),
        "stderr must report 'invalid prefix' for a charset violation"
      );
    });
  });

  // -------------------------------------------------------------------------
  // 3. Acceptance of a legal prefix producing a conforming key (Req 5.1, 5.6)
  // -------------------------------------------------------------------------
  describe("acceptance of a legal prefix", () => {
    it("produces a conforming key with a valid prefix (Req 5.1, 5.6)", async () => {
      // Use the keygen module directly to confirm that a legal prefix produces
      // a key matching the grammar, since the CLI prints the key only after a
      // successful DynamoDB write (which we cannot do with a dummy endpoint).
      const prefix = "PROMO";
      const key = generateLicenseKey(prefix);
      assert.ok(key.startsWith("PDM-PROMO-"),
        `key "${key}" must start with PDM-PROMO-`);
      assert.match(key, /^PDM-PROMO-[A-Z0-9]{4}(-[A-Z0-9]{4}){6}$/,
        `key "${key}" must match PDM-<PREFIX>-<7×4 secret> grammar`);
      assert.ok(key.length >= 8 && key.length <= 128,
        "key length must be between 8 and 128 characters (Req 5.6)");
    });

    it("does not reject a valid prefix (process exits due to write, not prefix rejection)", async () => {
      // With a valid prefix the CLI proceeds to the DynamoDB write. Since
      // we use a non-routable endpoint, it will fail with a network error —
      // but that's a write error, NOT a prefix rejection.
      const result = await runCli(["--prefix", "VALID"]);
      // If exit code is 1 AND stderr mentions "invalid prefix", the prefix was
      // wrongly rejected. Any other failure (network error) is expected.
      if (result.code !== 0) {
        assert.ok(
          !result.stderr.includes("invalid prefix"),
          "a valid prefix must not be rejected by the CLI"
        );
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Direct module tests: validate the keygen module the CLI uses, confirming the
// integration pathway without needing a successful DynamoDB write.
// ---------------------------------------------------------------------------

// Import the exact module the CLI uses (static import, matching parity test pattern).
import {
  validateKeyPrefix,
  normalizeKeyPrefix,
  generateLicenseKey,
  KEY_ALPHABET,
// @ts-ignore — .mjs module without type declarations
} from "../../backend/licensing/admin/lib/keygen.mjs";

// A License_Key is PDM-<secret> or PDM-<PREFIX>-<secret> where the secret is
// always 7 groups of 4 Key_Alphabet symbols (34 chars). The prefix may itself
// contain hyphens (e.g. NEW-YEAR), so we verify structure by checking the
// overall charset/length and confirming the trailing secret pattern.
const KEY_GRAMMAR = /^PDM-(?:[A-Z0-9]+(?:-[A-Z0-9]+)*-)?[A-Z0-9]{4}(?:-[A-Z0-9]{4}){6}$/;

describe("CLI minter keygen module integration (Req 5.11, 11.1)", () => {

  it("normalizes a lowercase prefix to uppercase before validation", () => {
    const normalized = normalizeKeyPrefix("new-year");
    assert.strictEqual(normalized, "NEW-YEAR");
    const result = validateKeyPrefix("new-year");
    assert.ok(result.ok, "normalized 'new-year' → 'NEW-YEAR' should be valid");
    assert.strictEqual(result.value, "NEW-YEAR");
  });

  it("normalizes underscores and whitespace runs to single hyphens", () => {
    const normalized = normalizeKeyPrefix("  hello__world  ");
    assert.strictEqual(normalized, "HELLO-WORLD");
  });

  it("rejects a prefix with illegal characters after normalization", () => {
    const result = validateKeyPrefix("BAD@PREFIX");
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.length > 0, "error message must be non-empty");
  });

  it("rejects a prefix exceeding 32 characters after normalization", () => {
    const result = validateKeyPrefix("A".repeat(33));
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.length > 0);
  });

  it("rejects a prefix that normalizes to empty (length < 1)", () => {
    // "---" → stripped leading/trailing hyphens → ""
    const result = validateKeyPrefix("---");
    assert.strictEqual(result.ok, false);
  });

  it("treats null, undefined, and whitespace-only as absent (ok, undefined)", () => {
    for (const absent of [null, undefined, "   ", "\t\n"]) {
      const result = validateKeyPrefix(absent);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.value, undefined);
    }
  });

  it("generates a key matching the grammar with no prefix", () => {
    const key = generateLicenseKey(undefined);
    // PDM-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX (PDM + 7 groups of 4)
    assert.match(key, KEY_GRAMMAR, `key "${key}" must match the expected grammar`);
    assert.ok(key.length >= 8 && key.length <= 128,
      "key length must be between 8 and 128 characters (Req 5.6)");
  });

  it("generates a key matching the grammar with a valid prefix", () => {
    const prefix = "NEW-YEAR";
    const key = generateLicenseKey(prefix);
    assert.ok(key.startsWith("PDM-NEW-YEAR-"),
      `key "${key}" must start with PDM-<PREFIX>-`);
    assert.match(key, KEY_GRAMMAR,
      `key "${key}" must match the key grammar (Req 5.1, 5.6)`);
    assert.ok(key.length >= 8 && key.length <= 128,
      "key length must be between 8 and 128 characters (Req 5.6)");
  });

  it("generates a key whose secret component uses only Key_Alphabet symbols", () => {
    const prefix = "TEST";
    const key = generateLicenseKey(prefix);
    // Strip the prefix: "PDM-TEST-" → remainder is the secret component
    const secretPart = key.replace(`PDM-${prefix}-`, "");
    const symbols = secretPart.replace(/-/g, "");
    for (const ch of symbols) {
      assert.ok(KEY_ALPHABET.includes(ch),
        `symbol '${ch}' in secret component is not in KEY_ALPHABET`);
    }
  });

  it("generates a key that the backend input validator accepts", () => {
    // The backend validator regex from src/lib/http.mjs: ^[A-Za-z0-9\-]{8,128}$
    const backendValidatorPattern = /^[A-Za-z0-9-]{8,128}$/;
    const key = generateLicenseKey("CAMPAIGN");
    assert.match(key, backendValidatorPattern,
      "the generated key must pass the backend's shared input validator");
  });
});
