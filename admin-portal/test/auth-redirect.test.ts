import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getSafeRedirectPath } from "../lib/auth-redirect.ts";

describe("getSafeRedirectPath", () => {
  const origin = "https://portal.example";

  it("preserves a same-origin path, query, and hash", () => {
    assert.strictEqual(
      getSafeRedirectPath("/dashboard/accounts?status=active#results", origin),
      "/dashboard/accounts?status=active#results"
    );
  });

  it("falls back for external and protocol-relative destinations", () => {
    assert.strictEqual(getSafeRedirectPath("https://attacker.example", origin), "/dashboard");
    assert.strictEqual(getSafeRedirectPath("//attacker.example/path", origin), "/dashboard");
  });

  it("falls back for backslash-based external destinations and non-path values", () => {
    assert.strictEqual(getSafeRedirectPath("/\\attacker.example", origin), "/dashboard");
    assert.strictEqual(getSafeRedirectPath("dashboard", origin), "/dashboard");
  });
});
