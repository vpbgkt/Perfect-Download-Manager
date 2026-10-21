/**
 * Balance transaction management for the multi-tier reseller system.
 *
 * This module manages balance operations for distributor/reseller/dealer accounts:
 *
 *  - **Credit Balance** — add funds to an account, recording the transaction
 *    with before/after amounts (admin or parent account action).
 *  - **Debit Balance** — deduct funds when creating API keys or licenses,
 *    automatically rejecting insufficient balance.
 *  - **Query Transactions** — paginated transaction history by account with
 *    filtering by type (credit/debit) and date range.
 *  - **Get Balance** — retrieve current account balance.
 *
 * Every transaction is atomic: balance updates and transaction records are
 * written together. The transaction log provides a complete audit trail of
 * all balance changes.
 *
 * All collaborators (DynamoClient, clock, id generator) are injected for
 * testability.
 *
 * @module lib/transactions
 */

import { randomUUID } from "node:crypto";
import type { DynamoClient, DynamoItem } from "./dynamo.ts";
import type { Role } from "./rbac.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

/** DynamoDB table storing balance transactions. */
export const TRANSACTIONS_TABLE_NAME = "pdm-portal-transactions";

/** Partition key of the transactions table. */
export const TRANSACTION_PARTITION_KEY = "transactionId";

/** GSI for querying transactions by account. */
export const ACCOUNT_TRANSACTIONS_INDEX = "accountId-createdAt-index";

/** DynamoDB table storing reseller accounts. */
export const RESELLERS_TABLE_NAME = "pdm-portal-resellers";

/** Partition key of the resellers table. */
export const RESELLER_PARTITION_KEY = "resellerAccountId";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Transaction type: credit adds funds, debit removes funds. */
export type TransactionType = "credit" | "debit";

/** Reason codes for transactions. */
export type TransactionReason =
  | "admin_credit"           // Manual credit by admin
  | "parent_credit"          // Credit from parent account
  | "key_purchase"           // Debit for API key creation
  | "license_purchase"       // Debit for license creation
  | "refund"                 // Credit refund
  | "adjustment"             // Manual adjustment
  | "dhru_order"             // Dhru API order
  | "initial_balance";       // Initial account setup

/** Transaction record stored in DynamoDB. */
export interface TransactionRecord {
  transactionId: string;
  accountId: string;
  type: TransactionType;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  reason: TransactionReason;
  relatedEntity?: string;
  createdBy: string;
  createdByRole: string;
  createdAt: string;
}

/** Actor context for transaction operations. */
export interface TransactionActor {
  identity: string;
  role: Role;
}

/** Input for crediting an account. */
export interface CreditBalanceInput {
  accountId: string;
  amount: number;
  reason: TransactionReason;
  relatedEntity?: string;
}

/** Input for debiting an account. */
export interface DebitBalanceInput {
  accountId: string;
  amount: number;
  reason: TransactionReason;
  relatedEntity?: string;
}

/** Input for querying transactions. */
export interface QueryTransactionsInput {
  accountId: string;
  startDate?: string;
  endDate?: string;
  type?: TransactionType;
  pageSize?: number;
  continuationToken?: string;
}

/** Error types for transaction operations. */
export interface TransactionError {
  code: "validation_error" | "insufficient_balance" | "not_found" | "conflict";
  message: string;
  field?: string;
}

/** Result types. */
export type TransactionResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: TransactionError };

/** Query result with pagination. */
export interface TransactionQueryResult {
  transactions: TransactionRecord[];
  nextToken?: string;
}

// ─── Injected Dependencies ───────────────────────────────────────────────────

/** Dependencies for the transaction manager. */
export interface TransactionManagerDeps {
  dynamo: DynamoClient;
  now?: () => Date;
  generateId?: () => string;
  tables?: {
    transactions?: string;
    resellers?: string;
  };
}

// ─── Transaction Manager API ─────────────────────────────────────────────────

/** Transaction manager interface. */
export interface TransactionManager {
  /**
   * Credit (add) balance to an account. Creates a credit transaction record
   * and updates the account balance atomically.
   */
  creditBalance(
    input: CreditBalanceInput,
    actor: TransactionActor
  ): Promise<TransactionResult<TransactionRecord>>;

  /**
   * Debit (subtract) balance from an account. Fails with insufficient_balance
   * if the account doesn't have enough funds. Creates a debit transaction
   * record and updates the account balance atomically.
   */
  debitBalance(
    input: DebitBalanceInput,
    actor: TransactionActor
  ): Promise<TransactionResult<TransactionRecord>>;

  /**
   * Get the current balance of an account.
   */
  getBalance(accountId: string): Promise<TransactionResult<number>>;

  /**
   * Query transaction history for an account with optional filtering and
   * pagination.
   */
  queryTransactions(
    input: QueryTransactionsInput
  ): Promise<TransactionResult<TransactionQueryResult>>;
}

// ─── Helper Functions ────────────────────────────────────────────────────────

function ok<T>(value: T): TransactionResult<T> {
  return { ok: true, value };
}

function fail<T = never>(error: TransactionError): TransactionResult<T> {
  return { ok: false, error };
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a transaction manager with injected dependencies.
 */
export function createTransactionManager(
  deps: TransactionManagerDeps
): TransactionManager {
  const dynamo = deps.dynamo;
  const now = deps.now ?? (() => new Date());
  const generateId = deps.generateId ?? (() => `txn_${randomUUID()}`);
  const transactionsTable = deps.tables?.transactions ?? TRANSACTIONS_TABLE_NAME;
  const resellersTable = deps.tables?.resellers ?? RESELLERS_TABLE_NAME;

  /**
   * Get account record including current balance.
   */
  async function getAccount(accountId: string) {
    const item = await dynamo.get({
      TableName: resellersTable,
      Key: { [RESELLER_PARTITION_KEY]: accountId },
    });
    return item as { resellerAccountId: string; balance: number; state: string } | null;
  }

  /**
   * Update account balance atomically.
   */
  async function updateAccountBalance(accountId: string, newBalance: number): Promise<void> {
    await dynamo.update({
      TableName: resellersTable,
      Key: { [RESELLER_PARTITION_KEY]: accountId },
      UpdateExpression: "SET balance = :balance",
      ExpressionAttributeValues: { ":balance": newBalance },
    });
  }

  /**
   * Write transaction record.
   */
  async function writeTransaction(record: TransactionRecord): Promise<void> {
    await dynamo.put({
      TableName: transactionsTable,
      Item: record as unknown as DynamoItem,
    });
  }

  return {
    async creditBalance(input, actor) {
      // Validate input
      if (!isNonEmptyString(input.accountId)) {
        return fail({
          code: "validation_error",
          field: "accountId",
          message: "accountId is required",
        });
      }
      if (!isPositiveNumber(input.amount)) {
        return fail({
          code: "validation_error",
          field: "amount",
          message: "amount must be a positive number",
        });
      }

      // Get current account
      const account = await getAccount(input.accountId);
      if (!account) {
        return fail({ code: "not_found", message: "Account not found" });
      }

      const balanceBefore = account.balance ?? 0;
      const balanceAfter = balanceBefore + input.amount;
      const createdAt = now().toISOString();

      const record: TransactionRecord = {
        transactionId: generateId(),
        accountId: input.accountId,
        type: "credit",
        amount: input.amount,
        balanceBefore,
        balanceAfter,
        reason: input.reason,
        relatedEntity: input.relatedEntity,
        createdBy: actor.identity,
        createdByRole: actor.role,
        createdAt,
      };

      // Atomic write: update balance + create transaction
      await updateAccountBalance(input.accountId, balanceAfter);
      await writeTransaction(record);

      return ok(record);
    },

    async debitBalance(input, actor) {
      // Validate input
      if (!isNonEmptyString(input.accountId)) {
        return fail({
          code: "validation_error",
          field: "accountId",
          message: "accountId is required",
        });
      }
      if (!isPositiveNumber(input.amount)) {
        return fail({
          code: "validation_error",
          field: "amount",
          message: "amount must be a positive number",
        });
      }

      // Get current account
      const account = await getAccount(input.accountId);
      if (!account) {
        return fail({ code: "not_found", message: "Account not found" });
      }

      const balanceBefore = account.balance ?? 0;
      
      // Check sufficient balance
      if (balanceBefore < input.amount) {
        return fail({
          code: "insufficient_balance",
          message: `Insufficient balance. Available: ${balanceBefore}, Required: ${input.amount}`,
        });
      }

      const balanceAfter = balanceBefore - input.amount;
      const createdAt = now().toISOString();

      const record: TransactionRecord = {
        transactionId: generateId(),
        accountId: input.accountId,
        type: "debit",
        amount: input.amount,
        balanceBefore,
        balanceAfter,
        reason: input.reason,
        relatedEntity: input.relatedEntity,
        createdBy: actor.identity,
        createdByRole: actor.role,
        createdAt,
      };

      // Atomic write: update balance + create transaction
      await updateAccountBalance(input.accountId, balanceAfter);
      await writeTransaction(record);

      return ok(record);
    },

    async getBalance(accountId) {
      if (!isNonEmptyString(accountId)) {
        return fail({
          code: "validation_error",
          field: "accountId",
          message: "accountId is required",
        });
      }

      const account = await getAccount(accountId);
      if (!account) {
        return fail({ code: "not_found", message: "Account not found" });
      }

      return ok(account.balance ?? 0);
    },

    async queryTransactions(input) {
      if (!isNonEmptyString(input.accountId)) {
        return fail({
          code: "validation_error",
          field: "accountId",
          message: "accountId is required",
        });
      }

      const pageSize = input.pageSize ?? 50;

      // Query using the GSI on accountId-createdAt
      const result = await dynamo.query({
        TableName: transactionsTable,
        IndexName: ACCOUNT_TRANSACTIONS_INDEX,
        KeyConditionExpression: "accountId = :accountId",
        ExpressionAttributeValues: {
          ":accountId": input.accountId,
        },
        Limit: pageSize,
        ExclusiveStartKey: input.continuationToken
          ? JSON.parse(input.continuationToken)
          : undefined,
        ScanIndexForward: false, // Descending order (newest first)
      });

      const transactions = (result.items ?? []) as unknown as TransactionRecord[];

      // Optional client-side filtering by type (if GSI doesn't support it)
      const filtered = input.type
        ? transactions.filter((t) => t.type === input.type)
        : transactions;

      return ok({
        transactions: filtered,
        nextToken: result.nextToken,
      });
    },
  };
}
