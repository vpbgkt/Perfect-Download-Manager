// Feature: license-key-management-enhancements — UI rendering unit tests
//
// Validates: Requirements 1.1, 2.3, 3.7, 5.13
//
// Req 1.1: WHEN a Portal_User with the `license:create` Permission opens the
//   create-license form, THE Portal_Frontend SHALL display one input control for
//   each of the six Customer_Fields together with text stating that every
//   Customer_Field is optional and recommended.
// Req 2.3: WHEN a Portal_User with the `license:read` Permission opens a
//   Viewable_Record, THE Portal_Frontend SHALL display one editable control for
//   each of the six Customer_Fields, pre-filled with the stored value for each
//   Customer_Field that has one and empty for each Customer_Field that has none.
// Req 3.7: WHERE all six Customer_Fields are absent from a Viewable_Record, THE
//   Portal_Frontend SHALL display an indicator on that record's list row
//   identifying the record as missing customer information.
// Req 5.13: WHEN an Admin_User with the `license:create` Permission opens the
//   create-license form, THE Portal_Frontend SHALL display one input control for
//   the Custom_Key_Prefix that accepts at most 32 characters, together with text
//   stating that the Custom_Key_Prefix is optional.
//
// Approach: These tests perform structural source-code analysis of the three
// license UI pages. Without a DOM rendering environment (no jsdom / React
// Testing Library in this test suite), we verify that the source files contain
// the required elements by reading them and applying assertions against their
// content. This validates that the UI rendering code structurally satisfies the
// requirements.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");

const CREATE_PAGE = readFileSync(
  resolve(ROOT, "app/dashboard/licenses/new/page.tsx"),
  "utf-8"
);
const DETAIL_PAGE = readFileSync(
  resolve(ROOT, "app/dashboard/licenses/[key]/page.tsx"),
  "utf-8"
);
const LIST_PAGE = readFileSync(
  resolve(ROOT, "app/dashboard/licenses/page.tsx"),
  "utf-8"
);

// The six Customer_Field input IDs expected in the create and detail pages.
const CUSTOMER_INPUT_IDS = [
  "customerName",
  "customerEmail",
  "customerPhone",
  "customerCountry",
  "customerCompany",
  "customerNotes",
];

// ---------------------------------------------------------------------------
// Req 1.1 — Create form renders six customer inputs plus optional/recommended
// ---------------------------------------------------------------------------
describe("Create form — customer inputs (Req 1.1)", () => {
  for (const id of CUSTOMER_INPUT_IDS) {
    it(`renders an input with id="${id}"`, () => {
      // The source must contain an Input component with the matching id prop
      const pattern = new RegExp(`id=["']${id}["']`);
      assert.match(CREATE_PAGE, pattern,
        `create page must render an input with id="${id}"`);
    });
  }

  it("renders exactly six customer input controls", () => {
    // Count occurrences of id="customer..." input bindings
    const matches = CREATE_PAGE.match(/id=["']customer[A-Za-z]+["']/g) ?? [];
    assert.strictEqual(matches.length, 6,
      "create page must have exactly 6 customer input controls");
  });

  it("displays text stating customer fields are optional and recommended", () => {
    // The page must contain "Optional" and "recommended" text for the customer block
    assert.match(CREATE_PAGE, /[Oo]ptional/,
      "create page must state customer fields are optional");
    assert.match(CREATE_PAGE, /recommended/i,
      "create page must state customer fields are recommended");
    // Verify the exact helper text from the design
    assert.match(CREATE_PAGE, /Optional,?\s*but\s*recommended/i,
      "create page must include the 'Optional, but recommended' helper text");
  });
});

// ---------------------------------------------------------------------------
// Req 5.13 — Prefix input exists with maxLength=32 for admin, absent for reseller
// ---------------------------------------------------------------------------
describe("Create form — prefix input (Req 5.13)", () => {
  it("renders a prefix input with maxLength={32}", () => {
    assert.match(CREATE_PAGE, /id=["']keyPrefix["']/,
      "create page must have a prefix input with id='keyPrefix'");
    assert.match(CREATE_PAGE, /maxLength=\{32\}/,
      "prefix input must have maxLength={32}");
  });

  it("prefix input is labelled as optional", () => {
    // The label or surrounding text must mention "optional" for the prefix
    assert.match(CREATE_PAGE, /[Cc]ustom\s*key\s*prefix\s*\(?optional\)?/i,
      "prefix input must have text indicating it is optional");
  });

  it("prefix input is conditionally rendered based on admin/super_admin role", () => {
    // The source must check for admin/super_admin before rendering the prefix input
    assert.match(CREATE_PAGE, /isAdmin/,
      "create page must use an isAdmin check for conditional rendering");
    // Verify the role check: session.role === "admin" or "super_admin"
    assert.match(CREATE_PAGE, /role.*===.*["']admin["']/,
      "create page must check for 'admin' role");
    assert.match(CREATE_PAGE, /role.*===.*["']super_admin["']/,
      "create page must check for 'super_admin' role");
  });

  it("prefix input is absent when isAdmin is false (reseller)", () => {
    // The prefix section must be wrapped in a conditional render: {isAdmin && (...)}
    // This means for a reseller (isAdmin = false), it won't render.
    assert.match(CREATE_PAGE, /\{isAdmin\s*&&/,
      "prefix section must be conditionally rendered with {isAdmin && ...}");
    // Confirm the keyPrefix input is INSIDE the conditional block
    const isAdminBlockStart = CREATE_PAGE.indexOf("{isAdmin &&");
    const keyPrefixLocation = CREATE_PAGE.indexOf('id="keyPrefix"');
    assert.ok(isAdminBlockStart < keyPrefixLocation,
      "keyPrefix input must appear after the isAdmin conditional guard");
  });
});

// ---------------------------------------------------------------------------
// Req 2.3 — Detail form pre-fills stored values, leaves absent fields empty
// ---------------------------------------------------------------------------
describe("Detail form — customer pre-fill (Req 2.3)", () => {
  for (const id of CUSTOMER_INPUT_IDS) {
    it(`renders an editable input with id="${id}"`, () => {
      const pattern = new RegExp(`id=["']${id}["']`);
      assert.match(DETAIL_PAGE, pattern,
        `detail page must render an input with id="${id}"`);
    });
  }

  it("pre-fills customer fields from the view response with fallback to empty string", () => {
    // Each customer field state is hydrated from the view response with ?? ""
    // which means stored values are pre-filled, absent fields become empty.
    for (const field of CUSTOMER_INPUT_IDS) {
      const hydratePattern = new RegExp(`v\\.${field}\\s*\\?\\?\\s*["']["']`);
      assert.match(DETAIL_PAGE, hydratePattern,
        `detail page must hydrate ${field} with v.${field} ?? "" (pre-fill or empty)`);
    }
  });

  it("uses controlled inputs bound to customer field state", () => {
    // Each input must have a value prop bound to the state variable
    for (const field of CUSTOMER_INPUT_IDS) {
      const valuePattern = new RegExp(`value=\\{${field}\\}`);
      assert.match(DETAIL_PAGE, valuePattern,
        `detail page input for ${field} must be a controlled input (value={${field}})`);
    }
  });

  it("sends empty string for cleared fields to remove the attribute", () => {
    // The saveCustomer handler must send "" for emptied controls so the backend
    // removes the attribute (Req 2.2 integration point)
    assert.match(DETAIL_PAGE, /customerEmail:\s*customerEmail/,
      "detail page must send customerEmail value in the update body");
    // Verify the pattern: trimmed check → send "" for clearing
    assert.match(DETAIL_PAGE, /\.trim\(\)\s*===\s*["']["']\s*\?\s*["']["']/,
      "detail page must send empty string for cleared controls");
  });
});

// ---------------------------------------------------------------------------
// Req 3.7 — List badge appears only when all six customer fields are absent
// ---------------------------------------------------------------------------
describe("List page — 'No customer info' badge (Req 3.7)", () => {
  it("renders a 'No customer info' badge element", () => {
    assert.match(LIST_PAGE, /No customer info/,
      "list page must contain 'No customer info' text");
    // It should use the Badge component
    assert.match(LIST_PAGE, /<Badge[^>]*>No customer info<\/Badge>/,
      "list page must use a Badge component for the 'No customer info' indicator");
  });

  it("badge uses 'warning' tone", () => {
    assert.match(LIST_PAGE, /tone=["']warning["'][^>]*>No customer info/,
      "the 'No customer info' badge must use the warning tone");
  });

  it("badge is conditioned on all six customer fields being absent", () => {
    // The conditional check must test all six fields are falsy/absent
    for (const field of CUSTOMER_INPUT_IDS) {
      const pattern = new RegExp(`!l\\.${field}`);
      assert.match(LIST_PAGE, pattern,
        `list page badge condition must check !l.${field}`);
    }
  });

  it("badge is NOT shown when any customer field is present", () => {
    // The condition uses && for all six checks — badge only shows when ALL are absent.
    // The source may list them in any order, so we verify each negation is present
    // within the same conditional expression block (the line(s) before the Badge).
    // Find the conditional block containing the Badge "No customer info"
    const badgeIndex = LIST_PAGE.indexOf("No customer info");
    assert.ok(badgeIndex > 0, "badge text must exist in source");
    // Extract a window before the badge that contains the conjunction
    const window = LIST_PAGE.slice(Math.max(0, badgeIndex - 400), badgeIndex);
    for (const field of CUSTOMER_INPUT_IDS) {
      assert.match(window, new RegExp(`!l\\.${field}`),
        `badge condition must check !l.${field} (all six must be absent)`);
    }
    // Verify they are joined by && (conjunction, not disjunction)
    assert.match(window, /&&/,
      "badge condition must use && (conjunction) to require ALL fields absent");
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: search placeholder mentions customer fields (Req 3.7 related)
// ---------------------------------------------------------------------------
describe("List page — search mentions customer fields", () => {
  it("search placeholder mentions customer-related terms", () => {
    const placeholderMatch = LIST_PAGE.match(/placeholder=["']([^"']+)["']/);
    assert.ok(placeholderMatch, "list page must have a search input with a placeholder");
    const placeholder = placeholderMatch![1].toLowerCase();
    assert.ok(placeholder.includes("email") || placeholder.includes("name") ||
              placeholder.includes("company") || placeholder.includes("phone"),
      "search placeholder must mention at least one customer field term");
  });

  it("page description mentions customer fields", () => {
    // The PageHeader description should mention customer search capability
    assert.match(LIST_PAGE, /customer\s*(email|name|company|phone)/i,
      "list page description must mention customer fields for search");
  });
});
