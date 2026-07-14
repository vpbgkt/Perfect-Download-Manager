import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

describe("project setup", () => {
  it("node:test runner works", () => {
    assert.strictEqual(1 + 1, 2);
  });

  it("fast-check property tests work", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        return a + b === b + a;
      }),
      { numRuns: 100 }
    );
  });
});
