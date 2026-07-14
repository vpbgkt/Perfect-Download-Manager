import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hasPermission, PERMISSION_MATRIX, type Role, type Permission } from "../lib/rbac.ts";

describe("rbac", () => {
  describe("hasPermission", () => {
    it("super_admin holds all permissions", () => {
      const allPermissions: Permission[] = [
        "license:create",
        "license:read",
        "license:update",
        "release:read",
        "release:update",
        "seo:read",
        "seo:update",
        "reseller:manage",
        "admin:manage",
        "apikey:create",
        "apikey:revoke",
        "apikey:update",
        "audit:read",
      ];

      for (const perm of allPermissions) {
        assert.strictEqual(
          hasPermission("super_admin", perm),
          true,
          `super_admin should hold ${perm}`
        );
      }
    });

    it("admin holds license, release, seo, and audit:read but not management permissions", () => {
      // Admin has these
      const adminAllowed: Permission[] = [
        "license:create",
        "license:read",
        "license:update",
        "release:read",
        "release:update",
        "seo:read",
        "seo:update",
        "audit:read",
      ];

      for (const perm of adminAllowed) {
        assert.strictEqual(
          hasPermission("admin", perm),
          true,
          `admin should hold ${perm}`
        );
      }

      // Admin does NOT have these (Req 2.5)
      const adminDenied: Permission[] = [
        "reseller:manage",
        "admin:manage",
        "apikey:create",
        "apikey:revoke",
        "apikey:update",
      ];

      for (const perm of adminDenied) {
        assert.strictEqual(
          hasPermission("admin", perm),
          false,
          `admin should NOT hold ${perm}`
        );
      }
    });

    it("reseller holds only license permissions", () => {
      // Reseller has these
      const resellerAllowed: Permission[] = [
        "license:create",
        "license:read",
        "license:update",
      ];

      for (const perm of resellerAllowed) {
        assert.strictEqual(
          hasPermission("reseller", perm),
          true,
          `reseller should hold ${perm}`
        );
      }

      // Reseller does NOT have these
      const resellerDenied: Permission[] = [
        "release:read",
        "release:update",
        "seo:read",
        "seo:update",
        "reseller:manage",
        "admin:manage",
        "apikey:create",
        "apikey:revoke",
        "apikey:update",
        "audit:read",
      ];

      for (const perm of resellerDenied) {
        assert.strictEqual(
          hasPermission("reseller", perm),
          false,
          `reseller should NOT hold ${perm}`
        );
      }
    });
  });

  describe("PERMISSION_MATRIX", () => {
    it("exports the matrix as a frozen record of sets", () => {
      const roles: Role[] = ["super_admin", "admin", "reseller"];
      for (const role of roles) {
        assert.ok(
          PERMISSION_MATRIX[role] instanceof Set,
          `PERMISSION_MATRIX[${role}] should be a Set`
        );
      }
    });

    it("super_admin set contains all 13 permissions", () => {
      assert.strictEqual(PERMISSION_MATRIX.super_admin.size, 13);
    });

    it("admin set contains 8 permissions", () => {
      assert.strictEqual(PERMISSION_MATRIX.admin.size, 8);
    });

    it("reseller set contains 3 permissions", () => {
      assert.strictEqual(PERMISSION_MATRIX.reseller.size, 3);
    });
  });
});
