/**
 * Role-Based Access Control (RBAC) library.
 *
 * Encodes the static role→permission matrix and exposes a pure
 * `hasPermission(role, permission)` function used by the auth middleware
 * to gate every Portal_Backend operation.
 *
 * Reseller permissions are additionally constrained to `resellerAccountId`
 * ownership at the data layer (Req 2.4, 2.7) — that enforcement lives in
 * the auth/query layers, not here. This module answers: "Does role X hold
 * permission Y at all?"
 */

/** The portal roles: admin roles (super_admin, admin) and account hierarchy (distributor, reseller, dealer) (Req 2.1). */
export type Role = "super_admin" | "admin" | "distributor" | "reseller" | "dealer";

/** Every named permission that gates a Portal_Backend operation. */
export type Permission =
  | "license:create"
  | "license:read"
  | "license:update"
  | "release:read"
  | "release:update"
  | "seo:read"
  | "seo:update"
  | "reseller:manage"
  | "admin:manage"
  | "apikey:create"
  | "apikey:revoke"
  | "apikey:update"
  | "audit:read"
  | "account:create"           // Create sub-accounts (distributor→reseller, reseller→dealer)
  | "account:manage"           // Manage sub-accounts (suspend, reactivate)
  | "balance:view"             // View own balance
  | "balance:add"              // Add balance to accounts
  | "balance:view_transactions" // View transaction history
  | "hierarchy:view"           // View account hierarchy
  | "order:read";              // View order history

/**
 * Static permission matrix.
 *
 * - `super_admin` holds ALL permissions (Req 2.6).
 * - `admin` holds license:*, release:*, seo:*, audit:read but NOT
 *   reseller:manage, admin:manage, or apikey:* (Req 2.5).
 * - `distributor` can create/manage resellers, create API keys, view balance & hierarchy
 * - `reseller` can create/manage dealers, create API keys, view balance & hierarchy
 *   (ownership-scoped at the data layer) (Req 2.4).
 * - `dealer` can only create licenses and view own balance (most restricted tier).
 */
export const PERMISSION_MATRIX: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  super_admin: new Set<Permission>([
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
    "account:create",
    "account:manage",
    "balance:view",
    "balance:add",
    "balance:view_transactions",
    "hierarchy:view",
    "order:read",
  ]),

  admin: new Set<Permission>([
    "license:create",
    "license:read",
    "license:update",
    "release:read",
    "release:update",
    "seo:read",
    "seo:update",
    "audit:read",
    "balance:view",
    "balance:view_transactions",
    "order:read",
  ]),

  distributor: new Set<Permission>([
    "license:create",
    "license:read",
    "license:update",
    "apikey:create",
    "account:create",        // Can create resellers
    "account:manage",        // Can manage resellers
    "balance:view",
    "balance:view_transactions",
    "hierarchy:view",
    "order:read",
  ]),

  reseller: new Set<Permission>([
    "license:create",
    "license:read",
    "license:update",
    "apikey:create",
    "account:create",        // Can create dealers
    "account:manage",        // Can manage dealers
    "balance:view",
    "balance:view_transactions",
    "hierarchy:view",
    "order:read",
  ]),

  dealer: new Set<Permission>([
    "license:create",
    "license:read",
    "license:update",
    "balance:view",
    "balance:view_transactions",
    "order:read",
  ]),
};

/**
 * Pure authorization check: does `role` hold `permission`?
 *
 * Returns `true` when the role's entry in the permission matrix includes
 * the given permission, `false` otherwise.
 *
 * This function does NOT enforce ownership scoping — reseller calls must
 * additionally pass an ownership check at the data layer.
 */
export function hasPermission(role: Role, permission: Permission): boolean {
  // Guard against inherited Object.prototype keys (e.g. "valueOf",
  // "constructor", "toString"): a plain index access would resolve those to
  // prototype members rather than `undefined`, so we require an own entry that
  // is actually a Set before consulting it.
  if (!Object.prototype.hasOwnProperty.call(PERMISSION_MATRIX, role)) {
    return false;
  }
  const permissions = PERMISSION_MATRIX[role];
  if (!(permissions instanceof Set)) {
    return false;
  }
  return permissions.has(permission);
}
