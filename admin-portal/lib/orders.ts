/**
 * License Order management for the Admin & Reseller Portal.
 *
 * Every license purchase by a distributor/reseller/dealer is recorded as an
 * Order_Record in the `pdm-portal-orders` DynamoDB table. Orders capture:
 *
 *  - The purchasing account and pricing breakdown
 *  - The resulting license key
 *  - Whether the order originated from the dashboard or the API
 *  - Order status (completed, failed, refunded)
 *
 * Admin-created licenses (free) are NOT recorded as orders since they
 * don't involve balance transactions.
 *
 * All collaborators (DynamoClient, clock, id generator) are injected for
 * testability.
 *
 * @module lib/orders
 */

import { randomUUID } from "node:crypto";
import type { DynamoClient, DynamoItem } from "./dynamo.ts";
import type { Role } from "./rbac.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

/** DynamoDB table storing license orders. */
export const ORDERS_TABLE_NAME = "pdm-portal-orders";

/** Partition key of the orders table. */
export const ORDER_PARTITION_KEY = "orderId";

/** GSI for querying orders by account. */
export const ACCOUNT_ORDERS_INDEX = "accountId-createdAt-index";

// ─── Types ───────────────────────────────────────────────────────────────────

/** How the order was placed. */
export type OrderSource = "dashboard" | "api";

/** Order status. */
export type OrderStatus = "completed" | "failed" | "refunded";

/** An order record stored in DynamoDB. */
export interface OrderRecord {
  orderId: string;
  accountId: string;
  licenseKey: string;
  plan: string;
  quantity: number;
  basePrice: number;
  discountPercent: number;
  discountAmount: number;
  finalPrice: number;
  balanceBefore: number;
  balanceAfter: number;
  status: OrderStatus;
  source: OrderSource;
  transactionId?: string;
  createdAt: string;
}

/** Summary shape for order list results. */
export interface OrderSummary {
  orderId: string;
  accountId: string;
  licenseKey: string;
  plan: string;
  quantity: number;
  basePrice: number;
  discountPercent: number;
  discountAmount: number;
  finalPrice: number;
  balanceBefore: number;
  balanceAfter: number;
  status: OrderStatus;
  source: OrderSource;
  transactionId?: string;
  createdAt: string;
}

/** The caller's authorization scope for order queries. */
export interface OrderQueryScope {
  role: Role;
  resellerAccountId: string | null;
}

/** Input for creating an order record. */
export interface CreateOrderInput {
  accountId: string;
  licenseKey: string;
  plan: string;
  quantity: number;
  basePrice: number;
  discountPercent: number;
  discountAmount: number;
  finalPrice: number;
  balanceBefore: number;
  balanceAfter: number;
  status: OrderStatus;
  source: OrderSource;
  transactionId?: string;
}

/** Input for querying orders. */
export interface QueryOrdersInput {
  accountId?: string;
  pageSize?: number;
  continuationToken?: string;
}

/** Error types for order operations. */
export interface OrderError {
  code: "validation_error" | "not_found";
  message: string;
  field?: string;
}

/** Result types. */
export type OrderResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: OrderError };

/** Paginated order list result. */
export interface OrderListResult {
  items: OrderSummary[];
  nextToken?: string;
}

// ─── Injected Dependencies ───────────────────────────────────────────────────

/** Dependencies for the order manager. */
export interface OrderManagerDeps {
  dynamo: DynamoClient;
  now?: () => Date;
  generateId?: () => string;
  tableName?: string;
}

// ─── Order Manager API ───────────────────────────────────────────────────────

/** Order manager interface. */
export interface OrderManager {
  /**
   * Create a new order record in the orders table.
   */
  createOrder(input: CreateOrderInput): Promise<OrderResult<OrderRecord>>;

  /**
   * List orders for a specific account (ownership-scoped) or all orders
   * (admin only) with pagination.
   */
  listOrders(
    scope: OrderQueryScope,
    input?: QueryOrdersInput
  ): Promise<OrderResult<OrderListResult>>;

  /**
   * Get a single order by ID, ownership-scoped.
   */
  getOrder(
    scope: OrderQueryScope,
    orderId: string
  ): Promise<OrderResult<OrderRecord>>;
}

// ─── Helper Functions ────────────────────────────────────────────────────────

function ok<T>(value: T): OrderResult<T> {
  return { ok: true, value };
}

function fail<T = never>(error: OrderError): OrderResult<T> {
  return { ok: false, error };
}

/** Default page size for order listings. */
const DEFAULT_PAGE_SIZE = 50;

/** Maximum page size for order listings. */
const MAX_PAGE_SIZE = 100;

function clampPageSize(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return DEFAULT_PAGE_SIZE;
  }
  const floored = Math.floor(requested);
  if (floored < 1) return 1;
  if (floored > MAX_PAGE_SIZE) return MAX_PAGE_SIZE;
  return floored;
}

/** Project a raw DynamoDB item to an OrderSummary. */
function toOrderSummary(item: Record<string, unknown>): OrderSummary {
  return {
    orderId: String(item.orderId ?? ""),
    accountId: String(item.accountId ?? ""),
    licenseKey: String(item.licenseKey ?? ""),
    plan: String(item.plan ?? "standard"),
    quantity: typeof item.quantity === "number" ? item.quantity : 1,
    basePrice: typeof item.basePrice === "number" ? item.basePrice : 0,
    discountPercent: typeof item.discountPercent === "number" ? item.discountPercent : 0,
    discountAmount: typeof item.discountAmount === "number" ? item.discountAmount : 0,
    finalPrice: typeof item.finalPrice === "number" ? item.finalPrice : 0,
    balanceBefore: typeof item.balanceBefore === "number" ? item.balanceBefore : 0,
    balanceAfter: typeof item.balanceAfter === "number" ? item.balanceAfter : 0,
    status: (item.status as OrderStatus) ?? "completed",
    source: (item.source as OrderSource) ?? "dashboard",
    transactionId: typeof item.transactionId === "string" ? item.transactionId : undefined,
    createdAt: typeof item.createdAt === "string" ? item.createdAt : "",
  };
}

/** Check if caller's scope authorizes viewing this order. */
function isOrderVisibleTo(
  item: Record<string, unknown>,
  scope: OrderQueryScope
): boolean {
  if (scope.role === "admin" || scope.role === "super_admin") {
    return true;
  }
  return (
    scope.resellerAccountId != null &&
    item.accountId === scope.resellerAccountId
  );
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create an order manager with injected dependencies.
 */
export function createOrderManager(deps: OrderManagerDeps): OrderManager {
  const dynamo = deps.dynamo;
  const now = deps.now ?? (() => new Date());
  const generateId = deps.generateId ?? (() => `ord_${randomUUID()}`);
  const tableName = deps.tableName ?? ORDERS_TABLE_NAME;

  return {
    async createOrder(input) {
      // Validate required fields
      if (!input.accountId) {
        return fail({
          code: "validation_error",
          field: "accountId",
          message: "accountId is required",
        });
      }
      if (!input.licenseKey) {
        return fail({
          code: "validation_error",
          field: "licenseKey",
          message: "licenseKey is required",
        });
      }

      const createdAt = now().toISOString();
      const record: OrderRecord = {
        orderId: generateId(),
        accountId: input.accountId,
        licenseKey: input.licenseKey,
        plan: input.plan || "standard",
        quantity: input.quantity || 1,
        basePrice: input.basePrice,
        discountPercent: input.discountPercent,
        discountAmount: input.discountAmount,
        finalPrice: input.finalPrice,
        balanceBefore: input.balanceBefore,
        balanceAfter: input.balanceAfter,
        status: input.status,
        source: input.source,
        transactionId: input.transactionId,
        createdAt,
      };

      await dynamo.put({
        TableName: tableName,
        Item: record as unknown as DynamoItem,
      });

      return ok(record);
    },

    async listOrders(scope, input) {
      const pageSize = clampPageSize(input?.pageSize);

      // If a specific accountId is provided and the caller is not admin,
      // they can only query their own account.
      if (input?.accountId) {
        if (
          scope.role !== "admin" &&
          scope.role !== "super_admin" &&
          input.accountId !== scope.resellerAccountId
        ) {
          return fail({ code: "not_found", message: "Not found" });
        }
      }

      // For non-admin callers, always scope to their own accountId.
      const queryAccountId =
        scope.role === "admin" || scope.role === "super_admin"
          ? input?.accountId
          : scope.resellerAccountId;

      if (queryAccountId) {
        // Use the GSI to query by accountId
        let continuationToken: Record<string, unknown> | undefined;
        if (input?.continuationToken) {
          try {
            continuationToken = JSON.parse(input.continuationToken);
          } catch {
            return fail({
              code: "validation_error",
              message: "Invalid continuation token",
            });
          }
        }

        const result = await dynamo.query({
          TableName: tableName,
          IndexName: ACCOUNT_ORDERS_INDEX,
          KeyConditionExpression: "accountId = :accountId",
          ExpressionAttributeValues: {
            ":accountId": queryAccountId,
          },
          Limit: pageSize,
          ExclusiveStartKey: continuationToken,
          ScanIndexForward: false, // newest first
        });

        const items = (result.items as Record<string, unknown>[]).map(
          toOrderSummary
        );

        return ok({
          items,
          nextToken: result.nextToken,
        });
      }

      // Admin with no specific account — scan all orders
      const page = await dynamo.paginatedScan(
        { TableName: tableName },
        pageSize,
        input?.continuationToken
      );

      const items = (page.items as Record<string, unknown>[])
        .filter((item) => isOrderVisibleTo(item, scope))
        .map(toOrderSummary);

      return ok({ items, nextToken: page.nextToken });
    },

    async getOrder(scope, orderId) {
      const item = await dynamo.get({
        TableName: tableName,
        Key: { [ORDER_PARTITION_KEY]: orderId },
      });

      if (!item) {
        return fail({ code: "not_found", message: "Order not found" });
      }

      if (!isOrderVisibleTo(item, scope)) {
        return fail({ code: "not_found", message: "Order not found" });
      }

      return ok(item as unknown as OrderRecord);
    },
  };
}
