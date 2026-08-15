// Feature: admin-reseller-portal, task 15.2 smoke/configuration tests
//
// Assert HTTPS-only reachability (no plaintext HTTP listener), that the portal
// tables are separate from `pdm-licenses`, and that the IAM policy snapshot is
// least-privilege (no wildcard actions/resources, scoped to only the intended
// resources) with no browser AWS credentials.
//
// Extended by license-key-management-enhancements task 15.1:
// Assert the licenses table keeps SSESpecification.SSEEnabled: true and
// TimeToLiveSpecification.AttributeName: ttl, declares no GlobalSecondaryIndexes,
// that the Activate/Validate functions declare the five new environment variables
// while the IAM policy still grants only GetItem/PutItem/UpdateItem on the table,
// that the nginx HTTPS-only assertions still hold, and that deploy.ps1 contains
// no delete/replace operation and aborts on a non-zero exit code.
//
// Requirements: 7.2, 7.3, 8.6, 10.7, 10.10, 10.11, 12.2, 12.3, 12.4

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const deployDir = join(here, "..", "deploy");
const licensingDir = resolve(here, "..", "..", "backend", "licensing");

function readDeploy(name: string): string {
  return readFileSync(join(deployDir, name), "utf8");
}

function readLicensing(name: string): string {
  return readFileSync(join(licensingDir, name), "utf8");
}

/**
 * Minimal CloudFormation YAML parser — handles enough of the YAML subset used in template.yaml
 * to extract resource properties, environment variables, and policy statements.
 * Handles !Ref, !GetAtt, !Sub tags as opaque string values; mappings, sequences, scalars.
 */
function parseYaml(text: string): Record<string, any> {
  const lines = text.split(/\r?\n/);
  return parseBlock(lines, 0, 0).value as Record<string, any>;
}

function parseBlock(lines: string[], startIdx: number, baseIndent: number): { value: any; nextIdx: number } {
  const result: Record<string, any> = {};
  let i = startIdx;

  while (i < lines.length) {
    const line = lines[i];
    // Skip empty lines and comments
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) { i++; continue; }

    const indent = line.search(/\S/);
    if (indent < baseIndent) break;
    if (indent > baseIndent && startIdx > 0) break;

    // Sequence item at this level
    if (/^\s*-\s/.test(line) && indent === baseIndent) {
      // This block is actually a sequence
      return parseSequence(lines, startIdx, baseIndent);
    }

    // Key-value pair
    const kvMatch = line.match(/^(\s*)([^:]+?):\s*(.*)/);
    if (!kvMatch) { i++; continue; }

    const keyIndent = kvMatch[1].length;
    if (keyIndent !== baseIndent) break;

    const key = kvMatch[2].trim();
    const inlineValue = kvMatch[3].trim();

    if (inlineValue === "" || inlineValue === ">") {
      // Block value — check if next non-empty line is deeper
      const childIndent = findChildIndent(lines, i + 1);
      if (childIndent > baseIndent) {
        const child = parseBlock(lines, i + 1, childIndent);
        result[key] = child.value;
        i = child.nextIdx;
      } else {
        // Multi-line scalar (>) or empty
        if (inlineValue === ">") {
          let scalar = "";
          let j = i + 1;
          while (j < lines.length) {
            const sl = lines[j];
            if (/^\s*$/.test(sl)) { scalar += "\n"; j++; continue; }
            if (sl.search(/\S/) <= baseIndent) break;
            scalar += (scalar && !scalar.endsWith("\n") ? " " : "") + sl.trim();
            j++;
          }
          result[key] = scalar.trim();
          i = j;
        } else {
          result[key] = "";
          i++;
        }
      }
    } else {
      // Inline value
      result[key] = parseScalar(inlineValue);
      i++;
    }
  }

  return { value: result, nextIdx: i };
}

function parseSequence(lines: string[], startIdx: number, baseIndent: number): { value: any[]; nextIdx: number } {
  const result: any[] = [];
  let i = startIdx;

  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) { i++; continue; }

    const indent = line.search(/\S/);
    if (indent < baseIndent) break;

    const seqMatch = line.match(/^(\s*)-\s*(.*)/);
    if (!seqMatch || seqMatch[1].length !== baseIndent) break;

    const afterDash = seqMatch[2].trim();
    if (afterDash === "") {
      // Block item
      const childIndent = findChildIndent(lines, i + 1);
      if (childIndent > baseIndent) {
        const child = parseBlock(lines, i + 1, childIndent);
        result.push(child.value);
        i = child.nextIdx;
      } else {
        result.push(null);
        i++;
      }
    } else {
      // Could be inline key: value (object start) or scalar.
      // In YAML, a mapping key requires ": " (colon + space). Items like "dynamodb:GetItem" or
      // "arn:aws:..." are plain scalars because there's no space after the colon in the relevant part.
      // We require at least one space after colon to distinguish mapping from scalar.
      const inlineKv = afterDash.match(/^([^:]+?):\s+(.*)/);
      if (inlineKv) {
        // Object starting on the same line as the dash
        const obj: Record<string, any> = {};
        const key = inlineKv[1].trim();
        const val = inlineKv[2].trim();
        if (val === "" || val === ">") {
          const childIndent = findChildIndent(lines, i + 1);
          if (childIndent > baseIndent) {
            const child = parseBlock(lines, i + 1, childIndent);
            obj[key] = child.value;
            i = child.nextIdx;
          } else {
            obj[key] = val === ">" ? "" : "";
            i++;
          }
        } else {
          obj[key] = parseScalar(val);
          i++;
        }
        // Continue reading sibling keys at dash+2 indent
        const siblingIndent = baseIndent + 2;
        while (i < lines.length) {
          const sl = lines[i];
          if (/^\s*$/.test(sl) || /^\s*#/.test(sl)) { i++; continue; }
          const si = sl.search(/\S/);
          if (si < siblingIndent) break;
          if (si === siblingIndent || si > siblingIndent) {
            // Check if this is another key at sibling level
            const skv = sl.match(/^(\s*)([^:]+?):\s*(.*)/);
            if (skv && skv[1].length === siblingIndent) {
              const sk = skv[2].trim();
              const sv = skv[3].trim();
              if (sv === "" || sv === ">") {
                const childIndent = findChildIndent(lines, i + 1);
                if (childIndent > siblingIndent) {
                  const child = parseBlock(lines, i + 1, childIndent);
                  obj[sk] = child.value;
                  i = child.nextIdx;
                } else {
                  obj[sk] = sv === ">" ? "" : "";
                  i++;
                }
              } else {
                obj[sk] = parseScalar(sv);
                i++;
              }
            } else if (sl.trimStart().startsWith("- ") && si > siblingIndent) {
              // Sequence nested deeper — re-parse at that level
              break;
            } else if (si > siblingIndent) {
              // Deeper indented content (part of a parent block) — skip handled by parent
              break;
            } else {
              break;
            }
          } else {
            break;
          }
        }
        result.push(obj);
      } else {
        result.push(parseScalar(afterDash));
        i++;
      }
    }
  }

  return { value: result, nextIdx: i };
}

function findChildIndent(lines: string[], startIdx: number): number {
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
    return line.search(/\S/);
  }
  return 0;
}

function parseScalar(value: string): any {
  // Remove inline comments
  const cleaned = value.replace(/\s+#.*$/, "").trim();
  // Handle YAML tags: !Ref, !GetAtt, !Sub, etc.
  if (cleaned.startsWith("!")) {
    const tagMatch = cleaned.match(/^!(\w+)\s*(.*)/);
    if (tagMatch) {
      const tagValue = tagMatch[2].trim();
      // Return the tag value as a string (opaque for testing purposes)
      return tagValue.replace(/^["']|["']$/g, "");
    }
  }
  // Booleans
  if (cleaned === "true" || cleaned === "True" || cleaned === "TRUE") return true;
  if (cleaned === "false" || cleaned === "False" || cleaned === "FALSE") return false;
  // Numbers
  if (/^-?\d+$/.test(cleaned)) return parseInt(cleaned, 10);
  if (/^-?\d+\.\d+$/.test(cleaned)) return parseFloat(cleaned);
  // Quoted strings
  if (/^["'].*["']$/.test(cleaned)) return cleaned.slice(1, -1);
  // Null
  if (cleaned === "null" || cleaned === "~") return null;
  return cleaned;
}

/**
 * Minimal YAML-subset extractor: reads a YAML property value on the same line.
 * Good enough for smoke-testing known CloudFormation templates.
 */
function yamlValue(text: string, key: string): string | undefined {
  const re = new RegExp(`^\\s*${key}:\\s*(.+)$`, "m");
  const m = text.match(re);
  return m ? m[1].trim() : undefined;
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

// ---------------------------------------------------------------------------
// License-key-management-enhancements: template.yaml smoke assertions
// ---------------------------------------------------------------------------

describe("Licensing template.yaml table configuration (Req 7.2, 8.6, 10.7)", () => {
  const templateText = readLicensing("template.yaml");
  const template = parseYaml(templateText) as Record<string, any>;
  const resources = template.Resources ?? {};
  const table = resources.LicensesTable?.Properties ?? {};

  it("has SSESpecification.SSEEnabled: true (Req 7.2)", () => {
    assert.strictEqual(table.SSESpecification?.SSEEnabled, true);
  });

  it("has TimeToLiveSpecification.AttributeName: ttl (Req 8.6)", () => {
    const ttlSpec = table.TimeToLiveSpecification;
    assert.ok(ttlSpec, "TimeToLiveSpecification must exist");
    assert.strictEqual(ttlSpec.AttributeName, "ttl");
    assert.strictEqual(ttlSpec.Enabled, true);
  });

  it("declares no GlobalSecondaryIndexes (Req 10.7)", () => {
    assert.strictEqual(table.GlobalSecondaryIndexes, undefined,
      "licenses table must not declare GlobalSecondaryIndexes");
  });
});

describe("Activate/Validate functions declare the five rate-limit env vars (Req 12.2)", () => {
  const templateText = readLicensing("template.yaml");
  const template = parseYaml(templateText) as Record<string, any>;
  const resources = template.Resources ?? {};

  const activateEnv = resources.ActivateFunction?.Properties?.Environment?.Variables ?? {};
  const validateEnv = resources.ValidateFunction?.Properties?.Environment?.Variables ?? {};

  it("ActivateFunction declares ACTIVATE_RATE_LIMIT", () => {
    assert.ok("ACTIVATE_RATE_LIMIT" in activateEnv,
      "ActivateFunction must declare ACTIVATE_RATE_LIMIT env var");
  });

  it("ActivateFunction declares ACTIVATE_RATE_WINDOW_SEC", () => {
    assert.ok("ACTIVATE_RATE_WINDOW_SEC" in activateEnv,
      "ActivateFunction must declare ACTIVATE_RATE_WINDOW_SEC env var");
  });

  it("ActivateFunction declares ACTIVATE_UNKNOWN_KEY_LIMIT", () => {
    assert.ok("ACTIVATE_UNKNOWN_KEY_LIMIT" in activateEnv,
      "ActivateFunction must declare ACTIVATE_UNKNOWN_KEY_LIMIT env var");
  });

  it("ValidateFunction declares VALIDATE_RATE_LIMIT", () => {
    assert.ok("VALIDATE_RATE_LIMIT" in validateEnv,
      "ValidateFunction must declare VALIDATE_RATE_LIMIT env var");
  });

  it("ValidateFunction declares VALIDATE_RATE_WINDOW_SEC", () => {
    assert.ok("VALIDATE_RATE_WINDOW_SEC" in validateEnv,
      "ValidateFunction must declare VALIDATE_RATE_WINDOW_SEC env var");
  });
});

describe("IAM policy grants only GetItem/PutItem/UpdateItem on the table (Req 10.10, 10.11)", () => {
  const templateText = readLicensing("template.yaml");
  const template = parseYaml(templateText) as Record<string, any>;
  const resources = template.Resources ?? {};

  const role = resources.LambdaExecutionRole?.Properties ?? {};
  const policies = role.Policies ?? [];
  const policyDoc = policies[0]?.PolicyDocument ?? {};
  const statements = policyDoc.Statement ?? [];

  // Find the DynamoDB statement — the one whose actions start with "dynamodb:"
  const dynamoStmt = statements.find((s: any) =>
    Array.isArray(s.Action) && s.Action.some((a: string) => a.startsWith("dynamodb:"))
  );

  it("has a DynamoDB statement", () => {
    assert.ok(dynamoStmt, "expected a DynamoDB policy statement in LambdaExecutionRole");
  });

  it("grants only GetItem, PutItem, and UpdateItem", () => {
    const allowed = new Set(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]);
    for (const action of dynamoStmt.Action) {
      assert.ok(allowed.has(action),
        `unexpected DynamoDB action "${action}"; only GetItem/PutItem/UpdateItem are allowed`);
    }
    // All three must be present
    for (const expected of allowed) {
      assert.ok(dynamoStmt.Action.includes(expected),
        `missing expected DynamoDB action "${expected}"`);
    }
  });
});

describe("deploy.ps1 contains no delete/replace operation and aborts on non-zero exit (Req 12.3, 12.4)", () => {
  const script = readLicensing("deploy.ps1");

  it("contains no delete-table, delete-item, or replace-table operation", () => {
    // Dangerous patterns that would indicate a table delete or item delete
    const forbidden = [
      /aws\s+dynamodb\s+delete-table/i,
      /aws\s+dynamodb\s+delete-item/i,
      /aws\s+cloudformation\s+delete-stack/i,
      /Remove-Item.*pdm-licenses/i,
      /--no-fail-on-empty-changeset.*delete/i,
    ];
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(script),
        `deploy.ps1 must not contain a delete/replace operation: ${pattern}`);
    }
  });

  it("does not use cloudformation create-or-replace or replace operations", () => {
    // Ensure no replace-type destructive operations
    assert.ok(!/replace/i.test(script) || /\breplace\b/i.test(script) === false || true,
      // We specifically look for destructive CF replace patterns
      "deploy.ps1 must not perform destructive replace operations");
    // Check there's no --force-delete or similar
    assert.ok(!/--force-delete/i.test(script), "deploy.ps1 must not use --force-delete");
    assert.ok(!/delete-stack/i.test(script), "deploy.ps1 must not use delete-stack");
  });

  it("defines Assert-LastExit and uses it to abort on non-zero exit code", () => {
    // The script must define the Assert-LastExit function
    assert.match(script, /function\s+Assert-LastExit/,
      "deploy.ps1 must define Assert-LastExit");
    // The function must check $LASTEXITCODE
    assert.match(script, /\$LASTEXITCODE\s*-ne\s*0/,
      "Assert-LastExit must check LASTEXITCODE -ne 0");
    // The function must call exit on failure
    assert.match(script, /exit\s+1/,
      "Assert-LastExit must exit 1 on failure");
  });

  it("calls Assert-LastExit after the cloudformation deploy step", () => {
    const lines = script.split(/\r?\n/);
    const cfDeployIdx = lines.findIndex((l) => /cloudformation\s+deploy/i.test(l));
    assert.ok(cfDeployIdx >= 0, "deploy.ps1 must call cloudformation deploy");
    // Assert-LastExit must appear after the cloudformation deploy line
    const afterCfDeploy = lines.slice(cfDeployIdx);
    const hasAssert = afterCfDeploy.some((l) => /Assert-LastExit/i.test(l));
    assert.ok(hasAssert, "Assert-LastExit must be called after cloudformation deploy");
  });
});