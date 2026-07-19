// Feature: admin-reseller-portal, task 15.2 smoke/configuration tests
//
// Assert HTTPS-only reachability (no plaintext HTTP listener), that the portal
// tables are separate from `pdm-licenses`, and that the IAM policy snapshot is
// least-privilege (no wildcard actions/resources, scoped to only the intended
// resources) with no browser AWS credentials.
//
// Requirements: 12.7, 14.5, 15.3, 15.6

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const deployDir = join(here, "..", "deploy");

function readDeploy(name: string): string {
  return readFileSync(join(deployDir, name), "utf8");
}

describe("Nginx config is HTTPS-only (Req 12.7, 15.3)", () => {
  const conf = readDeploy("nginx.conf");

  it("has a TLS-terminated 443 listener", () => {
    assert.match(conf, /listen\s+443\s+ssl/);
    assert.match(conf, /ssl_certificate\s+/);
    assert.match(conf, /ssl_certificate_key\s+/);
  });

  it("has NO plaintext HTTP listener (no non-ssl listen 80)", () => {
    // Any `listen 80` (with or without IPv6 form) that is not marked `ssl`
    // would be a plaintext listener — none may exist.
    const listenLines = conf
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^listen\s/.test(l) && !l.startsWith("#"));
    for (const line of listenLines) {
      assert.ok(/\sssl\b/.test(line), `plaintext listener found: "${line}"`);
      assert.ok(!/\b80\b/.test(line), `plaintext port 80 listener found: "${line}"`);
    }
    assert.ok(listenLines.length > 0, "expected at least one (ssl) listener");
  });

  it("enforces HSTS and forwards the HTTPS scheme upstream", () => {
    assert.match(conf, /Strict-Transport-Security/);
    assert.match(conf, /X-Forwarded-Proto\s+https/);
  });
});

describe("systemd unit supervises the stateless Next.js process (Req 15.3)", () => {
  const unit = readDeploy("pdm-portal.service");

  it("runs the production Next.js server and restarts on failure", () => {
    assert.match(unit, /ExecStart=.*npm run start/);
    assert.match(unit, /Restart=on-failure/);
  });

  it("does not bake in any AWS secret credentials", () => {
    assert.ok(!/AWS_SECRET_ACCESS_KEY/.test(unit));
    assert.ok(!/AWS_ACCESS_KEY_ID/.test(unit));
  });
});

describe("IAM policy is least-privilege with no browser credentials (Req 15.6)", () => {
  const raw = readDeploy("iam-policy.json");
  const policy = JSON.parse(raw) as {
    Version: string;
    Statement: Array<{ Sid?: string; Effect: string; Action: string[]; Resource: string[] }>;
  };

  it("is valid JSON with only Allow statements", () => {
    assert.strictEqual(policy.Version, "2012-10-17");
    assert.ok(Array.isArray(policy.Statement) && policy.Statement.length > 0);
    for (const stmt of policy.Statement) {
      assert.strictEqual(stmt.Effect, "Allow");
    }
  });

  it("never grants a wildcard action or a wildcard resource", () => {
    for (const stmt of policy.Statement) {
      for (const action of stmt.Action) {
        assert.notStrictEqual(action, "*", `wildcard action in ${stmt.Sid}`);
        // No service-wide wildcard like "dynamodb:*".
        assert.ok(!/:\*$/.test(action), `service-wide wildcard action "${action}" in ${stmt.Sid}`);
      }
      for (const resource of stmt.Resource) {
        assert.notStrictEqual(resource, "*", `wildcard resource in ${stmt.Sid}`);
      }
    }
  });

  it("scopes DynamoDB access to pdm-licenses AND the separate portal tables (Req 14.5)", () => {
    const allResources = policy.Statement.flatMap((s) => s.Resource);
    const hasLicenses = allResources.some((r) => /table\/pdm-licenses(\/|$)/.test(r));
    const portalTables = allResources.filter((r) => /table\/pdm-portal-/.test(r));
    assert.ok(hasLicenses, "policy must grant access to pdm-licenses");
    assert.ok(portalTables.length > 0, "policy must grant access to the portal tables");
    // The portal tables are distinct from the licenses table (separate stores).
    for (const r of portalTables) {
      assert.ok(!/table\/pdm-licenses(\/|$)/.test(r));
    }
  });

  it("scopes SSM to the signing-key path and S3 to the release bucket only", () => {
    const ssm = policy.Statement.find((s) => s.Action.some((a) => a.startsWith("ssm:")));
    assert.ok(ssm, "expected an SSM statement");
    for (const r of ssm!.Resource) {
      assert.match(r, /parameter\/pdm\/updates\/private-key$/);
    }

    const s3 = policy.Statement.find((s) => s.Action.some((a) => a.startsWith("s3:")));
    assert.ok(s3, "expected an S3 statement");
    for (const r of s3!.Resource) {
      assert.match(r, /^arn:aws:s3:::pdm-updates-452359090613-aps1\/\*$/);
    }
  });
});
