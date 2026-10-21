/**
 * Product Plan management for the Admin & Reseller Portal.
 *
 * Admin-configured product plans (e.g. "3 Months License", "12 Months License")
 * are stored in the `pdm-portal-plans` DynamoDB table. Non-admin users purchase
 * licenses by selecting one of these active plans.
 *
 * Each plan defines:
 *  - Display name and sort order
 *  - Duration in months (auto-calculates license expiry)
 *  - Base price in credits (account discount applied on top)
 *  - Default max activations and feature flags
 *  - Active/inactive status
 *
 * @module lib/plans
 */

import { randomUUID } from "node:crypto";
import type { DynamoClient, DynamoItem } from "./dynamo.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

/** DynamoDB table storing product plans. */
export const PLANS_TABLE_NAME = "pdm-portal-plans";

/** Partition key of the plans table. */
export const PLAN_PARTITION_KEY = "planId";

/** GSI for querying active plans in display order. */
export const STATUS_SORT_INDEX = "status-sortOrder-index";

// ─── Types ───────────────────────────────────────────────────────────────────

/** A product plan record stored in DynamoDB. */
export interface ProductPlan {
  planId: string;
  name: string;
  durationMonths: number;
  price: number;
  maxActivations: number;
  features: string[];
  status: "active" | "inactive";
  sortOrder: number;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

/** Input for creating a new plan. */
export interface CreatePlanInput {
  name: string;
  durationMonths: number;
  price: number;
  maxActivations?: number;
  features?: string[];
  sortOrder?: number;
  description?: string;
}

/** Input for updating an existing plan. */
export interface UpdatePlanInput {
  name?: string;
  durationMonths?: number;
  price?: number;
  maxActivations?: number;
  features?: string[];
  status?: "active" | "inactive";
  sortOrder?: number;
  description?: string;
}

// ─── Result Helpers ──────────────────────────────────────────────────────────

interface Ok<T> {
  ok: true;
  value: T;
}
interface Fail {
  ok: false;
  error: { code: string; message: string };
}
type Result<T> = Ok<T> | Fail;

function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}
function fail(error: { code: string; message: string }): Fail {
  return { ok: false, error };
}

// ─── Plan Manager ────────────────────────────────────────────────────────────

export interface PlanManager {
  /** List all active plans, ordered by sortOrder. */
  listActive(): Promise<ProductPlan[]>;

  /** List ALL plans (active + inactive) — admin view. */
  listAll(): Promise<ProductPlan[]>;

  /** Get a single plan by ID. */
  getPlan(planId: string): Promise<Result<ProductPlan>>;

  /** Create a new plan (admin only). */
  createPlan(input: CreatePlanInput): Promise<Result<ProductPlan>>;

  /** Update an existing plan (admin only). */
  updatePlan(planId: string, input: UpdatePlanInput): Promise<Result<ProductPlan>>;

  /** Soft-delete a plan (set status to inactive). */
  deactivatePlan(planId: string): Promise<Result<ProductPlan>>;
}

/** Factory: inject DynamoDB client and optional table name override. */
export function createPlanManager(deps: {
  dynamo: DynamoClient;
  tableName?: string;
  clock?: () => string;
  idGen?: () => string;
}): PlanManager {
  const { dynamo } = deps;
  const tableName = deps.tableName ?? PLANS_TABLE_NAME;
  const clock = deps.clock ?? (() => new Date().toISOString());
  const idGen = deps.idGen ?? (() => `plan_${randomUUID()}`);

  function toPlan(item: DynamoItem): ProductPlan {
    const raw = item as Record<string, unknown>;
    return {
      planId: raw.planId as string,
      name: raw.name as string,
      durationMonths: raw.durationMonths as number,
      price: raw.price as number,
      maxActivations: (raw.maxActivations as number) ?? 1,
      features: (raw.features as string[]) ?? [],
      status: (raw.status as "active" | "inactive") ?? "active",
      sortOrder: (raw.sortOrder as number) ?? 0,
      description: raw.description as string | undefined,
      createdAt: raw.createdAt as string,
      updatedAt: raw.updatedAt as string,
    };
  }

  return {
    async listActive(): Promise<ProductPlan[]> {
      const result = await dynamo.query({
        TableName: tableName,
        IndexName: STATUS_SORT_INDEX,
        KeyConditionExpression: "#status = :active",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":active": "active" },
        ScanIndexForward: true, // ascending sortOrder
      });
      return result.items.map(toPlan);
    },

    async listAll(): Promise<ProductPlan[]> {
      const result = await dynamo.paginatedScan(
        { TableName: tableName },
        100
      );
      return result.items.map(toPlan).sort((a, b) => a.sortOrder - b.sortOrder);
    },

    async getPlan(planId: string): Promise<Result<ProductPlan>> {
      const item = await dynamo.get({
        TableName: tableName,
        Key: { [PLAN_PARTITION_KEY]: planId },
      });
      if (!item) {
        return fail({ code: "not_found", message: "Plan not found" });
      }
      return ok(toPlan(item));
    },

    async createPlan(input: CreatePlanInput): Promise<Result<ProductPlan>> {
      // Validate
      if (!input.name || input.name.trim().length === 0) {
        return fail({ code: "validation_error", message: "Plan name is required" });
      }
      if (!input.durationMonths || input.durationMonths < 1) {
        return fail({ code: "validation_error", message: "Duration must be at least 1 month" });
      }
      if (input.price === undefined || input.price < 0) {
        return fail({ code: "validation_error", message: "Price must be non-negative" });
      }

      const now = clock();
      const plan: ProductPlan = {
        planId: idGen(),
        name: input.name.trim(),
        durationMonths: input.durationMonths,
        price: input.price,
        maxActivations: input.maxActivations ?? 1,
        features: input.features ?? [],
        status: "active",
        sortOrder: input.sortOrder ?? 0,
        description: input.description?.trim(),
        createdAt: now,
        updatedAt: now,
      };

      await dynamo.put({
        TableName: tableName,
        Item: plan as unknown as DynamoItem,
      });

      return ok(plan);
    },

    async updatePlan(planId: string, input: UpdatePlanInput): Promise<Result<ProductPlan>> {
      // Fetch existing
      const existing = await dynamo.get({
        TableName: tableName,
        Key: { [PLAN_PARTITION_KEY]: planId },
      });
      if (!existing) {
        return fail({ code: "not_found", message: "Plan not found" });
      }

      const current = toPlan(existing);
      const now = clock();

      // Merge updates
      const updated: ProductPlan = {
        ...current,
        name: input.name?.trim() ?? current.name,
        durationMonths: input.durationMonths ?? current.durationMonths,
        price: input.price ?? current.price,
        maxActivations: input.maxActivations ?? current.maxActivations,
        features: input.features ?? current.features,
        status: input.status ?? current.status,
        sortOrder: input.sortOrder ?? current.sortOrder,
        description: input.description !== undefined ? input.description?.trim() : current.description,
        updatedAt: now,
      };

      // Validate
      if (updated.name.length === 0) {
        return fail({ code: "validation_error", message: "Plan name cannot be empty" });
      }
      if (updated.durationMonths < 1) {
        return fail({ code: "validation_error", message: "Duration must be at least 1 month" });
      }
      if (updated.price < 0) {
        return fail({ code: "validation_error", message: "Price must be non-negative" });
      }

      await dynamo.put({
        TableName: tableName,
        Item: updated as unknown as DynamoItem,
      });

      return ok(updated);
    },

    async deactivatePlan(planId: string): Promise<Result<ProductPlan>> {
      return this.updatePlan(planId, { status: "inactive" });
    },
  };
}
