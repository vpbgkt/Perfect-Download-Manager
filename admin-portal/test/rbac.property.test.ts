import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  hasPermission,
  PERMISSION_MATRIX,
  type Role,
  type Permission,
} from "../lib/rbac.ts";

// Feature: admin-reseller-portal, Property 1: Permission matrix governs authorization

const ROLES: Role[] = ["super_admin", "admin", "reseller"];

const PERMISSIONS: Permission[] = [
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

const RUNS = 100;

describe("rbac property: permission matrix governs authorization", () => {
  // Validates: Requirements 2.2, 2.3, 2.5, 2.6
  it("Property 1: hasPermission returns true iff permission is in the role's set", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ROLES),
        fc.constantFrom(...PERMISSIONS),
        (role, permission) => {
          const expected = PERMISSION_MATRIX[role].has(permission);
          return hasPermission(role, permission) === expected;
        }
      ),
      { numRuns: RUNS }
    );
  });

  // Validates: Requirements 2.5, 2.6
  it("Property 1: super_admin holds admin:manage and reseller:manage while admin does not", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Permission>("admin:manage", "reseller:manage"),
        (managePermission) => {
          return (
            hasPermission("super_admin", managePermission) === true &&
            hasPermission("admin", managePermission) === false
          );
        }
      ),
      { numRuns: RUNS }
    );
  });

  // Validates: Requirements 2.2, 2.3
  it("Property 1: unknown roles return false for any permission", () => {
    const knownRoles = new Set<string>(ROLES);
    fc.assert(
      fc.property(
        fc.string(),
        fc.constantFrom(...PERMISSIONS),
        (maybeRole, permission) => {
          fc.pre(!knownRoles.has(maybeRole));
          return hasPermission(maybeRole as Role, permission) === false;
        }
      ),
      { numRuns: RUNS }
    );
  });

  // Validates: Requirements 2.2, 2.3
  it("Property 1: unknown permissions return false for any known role", () => {
    const knownPermissions = new Set<string>(PERMISSIONS);
    fc.assert(
      fc.property(
        fc.constantFrom(...ROLES),
        fc.string(),
        (role, maybePermission) => {
          fc.pre(!knownPermissions.has(maybePermission));
          return hasPermission(role, maybePermission as Permission) === false;
        }
      ),
      { numRuns: RUNS }
    );
  });

  // Validates: Requirements 2.2, 2.3
  it("Property 1: hasPermission is deterministic across repeated calls", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ROLES),
        fc.oneof(fc.constantFrom(...PERMISSIONS), fc.string()),
        (role, permission) => {
          const first = hasPermission(role, permission as Permission);
          const second = hasPermission(role, permission as Permission);
          const third = hasPermission(role, permission as Permission);
          return first === second && second === third;
        }
      ),
      { numRuns: RUNS }
    );
  });
});
