// Feature: license-key-management-enhancements — verification result logic (unit)
//
// Validates: Requirements 12.7, 12.8, 12.9, 12.12
//
// Req 12.7: IF any post-deployment verification check reports a failure, THEN THE
// Deployment_Process SHALL report the failing check and SHALL NOT report the
// deployment as successful.
//
// Req 12.8: IF any post-deployment verification check reports a failure, THEN THE
// Deployment_Process SHALL leave the deployed configuration in place and SHALL
// perform a rollback only when an operator requests the rollback.
//
// Req 12.9: WHEN the Deployment_Process completes, THE Deployment_Process SHALL
// produce a written summary covering the code changes, the License_Record
// attribute additions, the API changes, the Portal_Frontend changes, the security
// changes, the tests performed, the deployment outcome, and the remaining
// limitations and follow-up recommendations.
//
// Req 12.12: IF the Deployment_Process cannot complete a verification check because
// the deployed environment is unreachable, THEN THE Deployment_Process SHALL report
// that check as not verified rather than as passed.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  determineOutcome,
  writeDeploymentSummary,
  buildSummarySections,
  // @ts-ignore — .mjs module
} from "../../backend/licensing/verify-deployment.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CheckResult = { name: string; status: string; detail?: string };

function allPassed(): CheckResult[] {
  return [
    { name: "1. Portal health", status: "passed", detail: "200 OK" },
    { name: "2. Customer_Field round-trip", status: "passed" },
    { name: "3. Prefixed key activation", status: "passed" },
    { name: "4. Legacy key activation", status: "passed" },
    { name: "5. Rate limit (429)", status: "passed" },
    { name: "6. Error log entries", status: "passed" },
  ];
}

function withOneFailed(): CheckResult[] {
  return [
    { name: "1. Portal health", status: "passed" },
    { name: "2. Customer_Field round-trip", status: "failed", detail: "Mismatch on customerEmail" },
    { name: "3. Prefixed key activation", status: "passed" },
    { name: "4. Legacy key activation", status: "passed" },
    { name: "5. Rate limit (429)", status: "passed" },
    { name: "6. Error log entries", status: "passed" },
  ];
}

function withUnreachable(): CheckResult[] {
  return [
    { name: "1. Portal health", status: "not_verified", detail: "Environment unreachable" },
    { name: "2. Customer_Field round-trip", status: "passed" },
    { name: "3. Prefixed key activation", status: "not_verified", detail: "API_URL not configured" },
    { name: "4. Legacy key activation", status: "not_verified", detail: "API_URL not configured" },
    { name: "5. Rate limit (429)", status: "not_verified", detail: "API_URL not configured" },
    { name: "6. Error log entries", status: "passed" },
  ];
}

function withMixedFailures(): CheckResult[] {
  return [
    { name: "1. Portal health", status: "failed", detail: "GET /api/health → 503" },
    { name: "2. Customer_Field round-trip", status: "not_verified", detail: "Unreachable" },
    { name: "3. Prefixed key activation", status: "passed" },
    { name: "4. Legacy key activation", status: "passed" },
    { name: "5. Rate limit (429)", status: "failed", detail: "No 429 received" },
    { name: "6. Error log entries", status: "passed" },
  ];
}

// ---------------------------------------------------------------------------
// determineOutcome — Req 12.7, 12.12
// ---------------------------------------------------------------------------

describe("determineOutcome (Req 12.7, 12.12)", () => {
  it("reports SUCCESSFUL when all checks pass", () => {
    const outcome = determineOutcome(allPassed());
    assert.strictEqual(outcome.status, "SUCCESSFUL");
    assert.ok(outcome.detail.includes("passed"), "detail mentions passed");
  });

  it("reports FAILED when any check fails — blocks success report (Req 12.7)", () => {
    const outcome = determineOutcome(withOneFailed());
    assert.strictEqual(outcome.status, "FAILED");
    assert.ok(
      outcome.detail.includes("Customer_Field round-trip"),
      "detail names the failing check"
    );
    assert.ok(outcome.status !== "SUCCESSFUL", "must not report as successful");
  });

  it("reports PARTIALLY VERIFIED when environment is unreachable (Req 12.12)", () => {
    const outcome = determineOutcome(withUnreachable());
    assert.strictEqual(outcome.status, "PARTIALLY VERIFIED");
    assert.ok(
      outcome.detail.includes("not_verified") || outcome.detail.includes("could not be verified"),
      "detail explains that checks were not verified"
    );
    assert.ok(outcome.status !== "SUCCESSFUL", "unreachable must not be reported as passed");
  });

  it("FAILED takes precedence over PARTIALLY VERIFIED when both exist", () => {
    const outcome = determineOutcome(withMixedFailures());
    assert.strictEqual(outcome.status, "FAILED");
    assert.ok(
      outcome.detail.includes("failed"),
      "detail mentions the failure count"
    );
  });

  it("counts all failing checks in the detail", () => {
    const outcome = determineOutcome(withMixedFailures());
    // Both checks 1 and 5 failed
    assert.ok(outcome.detail.includes("Portal health"), "names first failing check");
    assert.ok(outcome.detail.includes("Rate limit"), "names second failing check");
  });

  it("handles an empty check list without crashing", () => {
    const outcome = determineOutcome([]);
    assert.strictEqual(outcome.status, "SUCCESSFUL");
  });
});

// ---------------------------------------------------------------------------
// writeDeploymentSummary — Req 12.8 (rollback), 12.9 (required sections)
// ---------------------------------------------------------------------------

describe("writeDeploymentSummary — rollback logic (Req 12.8)", () => {
  it("does NOT mention rollback will proceed when operator flag is absent", () => {
    const summary = writeDeploymentSummary(withOneFailed(), {
      rollbackRequested: false,
    });
    // The summary should indicate no rollback occurs.
    assert.ok(
      summary.includes("NOT performed") || summary.includes("not performed") || summary.includes("No rollback"),
      "summary must state rollback is not performed without operator flag"
    );
    assert.ok(
      !summary.includes("rollback will proceed"),
      "must not say rollback will proceed"
    );
  });

  it("mentions rollback will proceed when operator flag IS set", () => {
    const summary = writeDeploymentSummary(withOneFailed(), {
      rollbackRequested: true,
    });
    assert.ok(
      summary.includes("rollback will proceed") || summary.includes("REQUESTED"),
      "summary must indicate rollback proceeds when operator requested"
    );
  });

  it("never triggers rollback language for a successful deployment", () => {
    const summary = writeDeploymentSummary(allPassed(), {
      rollbackRequested: false,
    });
    assert.ok(
      !summary.includes("rollback will proceed"),
      "successful deployment must not mention rollback proceeding"
    );
  });

  it("reports rollback not performed even when unreachable checks exist", () => {
    const summary = writeDeploymentSummary(withUnreachable(), {
      rollbackRequested: false,
    });
    assert.ok(
      summary.includes("NOT performed") || summary.includes("not performed") || summary.includes("No rollback"),
      "unreachable results without operator flag must not trigger rollback"
    );
  });
});

describe("writeDeploymentSummary — required sections (Req 12.9)", () => {
  const summary = writeDeploymentSummary(allPassed(), {
    timestamp: "2025-06-15T12:00:00.000Z",
    sourceIp: "203.0.113.99",
    attemptWindow: 3600,
    rollbackRequested: false,
  });

  it("contains the CODE CHANGES section", () => {
    assert.ok(summary.includes("CODE CHANGES"), "summary must have a code changes section");
  });

  it("contains the LICENSE_RECORD ATTRIBUTE ADDITIONS section", () => {
    assert.ok(
      summary.includes("LICENSE_RECORD ATTRIBUTE ADDITIONS") || summary.includes("ATTRIBUTE ADDITIONS"),
      "summary must have an attribute additions section"
    );
  });

  it("contains the API CHANGES section", () => {
    assert.ok(summary.includes("API CHANGES"), "summary must have an API changes section");
  });

  it("contains the PORTAL_FRONTEND CHANGES section", () => {
    assert.ok(
      summary.includes("PORTAL_FRONTEND CHANGES") || summary.includes("FRONTEND CHANGES"),
      "summary must have a frontend changes section"
    );
  });

  it("contains the SECURITY CHANGES section", () => {
    assert.ok(summary.includes("SECURITY CHANGES"), "summary must have a security changes section");
  });

  it("contains the TESTS PERFORMED section", () => {
    assert.ok(summary.includes("TESTS PERFORMED"), "summary must have a tests performed section");
  });

  it("contains the DEPLOYMENT OUTCOME section", () => {
    assert.ok(summary.includes("DEPLOYMENT OUTCOME"), "summary must have a deployment outcome section");
  });

  it("contains the REMAINING LIMITATIONS section", () => {
    assert.ok(
      summary.includes("REMAINING LIMITATIONS") || summary.includes("LIMITATIONS"),
      "summary must have a limitations section"
    );
  });

  it("contains the follow-up recommendations", () => {
    assert.ok(
      summary.includes("Follow-up recommendations") || summary.includes("FOLLOW-UP"),
      "summary must include follow-up recommendations"
    );
  });

  it("includes the provided timestamp", () => {
    assert.ok(summary.includes("2025-06-15T12:00:00.000Z"), "summary must include the timestamp");
  });

  it("includes the verification source IP", () => {
    assert.ok(summary.includes("203.0.113.99"), "summary must include the source IP");
  });

  it("includes the attempt window", () => {
    assert.ok(summary.includes("3600"), "summary must include the attempt window");
  });
});

// ---------------------------------------------------------------------------
// buildSummarySections — structural content checks (Req 12.9)
// ---------------------------------------------------------------------------

describe("buildSummarySections (Req 12.9)", () => {
  const sections = buildSummarySections();

  it("codeChanges mentions keygen rewrite", () => {
    assert.ok(sections.codeChanges.includes("keygen"), "must reference keygen changes");
  });

  it("codeChanges mentions attemptLimit", () => {
    assert.ok(
      sections.codeChanges.includes("attemptLimit"),
      "must reference attempt limiting module"
    );
  });

  it("attributeAdditions lists all 7 new attributes", () => {
    const expected = [
      "keyPrefix", "customerEmail", "customerName",
      "customerPhone", "customerCountry", "customerCompany", "customerNotes",
    ];
    for (const attr of expected) {
      assert.ok(
        sections.attributeAdditions.includes(attr),
        `attributeAdditions must mention ${attr}`
      );
    }
  });

  it("apiChanges references activation and validation limiting", () => {
    assert.ok(sections.apiChanges.includes("activate") || sections.apiChanges.includes("/activate"),
      "must mention activation endpoint");
    assert.ok(sections.apiChanges.includes("validate") || sections.apiChanges.includes("/validate"),
      "must mention validation endpoint");
  });

  it("frontendChanges references customer inputs", () => {
    assert.ok(
      sections.frontendChanges.includes("customer") || sections.frontendChanges.includes("Customer"),
      "must mention customer-related frontend changes"
    );
  });

  it("securityChanges mentions 140-bit entropy", () => {
    assert.ok(sections.securityChanges.includes("140"), "must mention 140-bit entropy");
  });

  it("testsPerformed lists property tests", () => {
    assert.ok(
      sections.testsPerformed.includes("Property") || sections.testsPerformed.includes("property"),
      "must reference property tests"
    );
  });

  it("limitations mentions continuation-token structural guard", () => {
    assert.ok(
      sections.limitations.includes("continuation-token") || sections.limitations.includes("Continuation"),
      "must mention continuation-token limitation"
    );
  });
});
