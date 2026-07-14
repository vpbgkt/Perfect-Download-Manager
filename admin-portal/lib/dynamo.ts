/**
 * DynamoDB access layer for the Admin & Reseller Portal.
 *
 * Wraps AWS SDK v3 DynamoDBDocumentClient with:
 * - `removeUndefinedValues` marshalling (matching existing licensing backend)
 * - Conditional-write helper (collision-free PutItem via attribute_not_exists)
 * - Map-update helper for nested map attributes (e.g. activations map)
 * - UpdateItem ADD atomic-counter helper for rate-limit/quota counters
 * - Paginated query/scan helpers returning items + continuation tokens
 *
 * Exports a factory for the real client and a DynamoClient interface for DI.
 *
 * @module lib/dynamo
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  PutCommandInput,
  GetCommandInput,
  UpdateCommandInput,
  DeleteCommandInput,
  QueryCommandInput,
  ScanCommandInput,
} from "@aws-sdk/lib-dynamodb";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Generic record (DynamoDB item). */
export type DynamoItem = Record<string, unknown>;

/** Result of a paginated query or scan. */
export interface PaginatedResult<T = DynamoItem> {
  items: T[];
  nextToken: string | undefined;
}

/** Thrown when a conditional write fails (e.g. item already exists). */
export class ConditionalCheckFailedError extends Error {
  constructor(message?: string) {
    super(message ?? "The conditional request failed");
    this.name = "ConditionalCheckFailedException";
  }
}

/** Interface that both the real client and in-memory fake implement. */
export interface DynamoClient {
  /** Put item. Throws ConditionalCheckFailedError on condition failure. */
  put(params: PutCommandInput): Promise<void>;

  /** Get item by key. Returns the item or null. */
  get(params: GetCommandInput): Promise<DynamoItem | null>;

  /** Update item. Throws ConditionalCheckFailedError on condition failure. */
  update(params: UpdateCommandInput): Promise<DynamoItem | undefined>;

  /** Delete item. */
  delete(params: DeleteCommandInput): Promise<void>;

  /** Query with pagination. */
  query(params: QueryCommandInput): Promise<PaginatedResult>;

  /** Scan with pagination. */
  scan(params: ScanCommandInput): Promise<PaginatedResult>;

  // ─── Higher-level helpers ─────────────────────────────────────────────────

  /**
   * Conditional put: writes only if the partition key does not already exist.
   * Throws ConditionalCheckFailedError on collision.
   */
  conditionalPut(
    tableName: string,
    item: DynamoItem,
    partitionKeyName: string
  ): Promise<void>;

  /**
   * Update a nested map attribute. Sets `mapAttr.#nestedKey = value`.
   * Creates the map if absent.
   */
  mapUpdate(
    tableName: string,
    key: DynamoItem,
    mapAttr: string,
    nestedKey: string,
    value: unknown
  ): Promise<void>;

  /**
   * Remove a key from a nested map attribute.
   * Throws ConditionalCheckFailedError if the key does not exist.
   */
  mapRemove(
    tableName: string,
    key: DynamoItem,
    mapAttr: string,
    nestedKey: string
  ): Promise<void>;

  /**
   * Atomic counter increment via UpdateItem ADD.
   * Returns the new counter value after increment.
   * Supports optional condition expression for quota enforcement.
   */
  atomicIncrement(
    tableName: string,
    key: DynamoItem,
    counterAttr: string,
    incrementBy: number,
    options?: {
      conditionExpression?: string;
      expressionAttributeNames?: Record<string, string>;
      expressionAttributeValues?: Record<string, unknown>;
      /** Additional SET expressions to apply atomically (e.g. TTL). */
      additionalSetExpressions?: string;
    }
  ): Promise<number>;

  /**
   * Paginated query helper.
   * @param pageSize Max items per page (Limit).
   * @param continuationToken Opaque token from a previous page.
   */
  paginatedQuery(
    params: Omit<QueryCommandInput, "Limit" | "ExclusiveStartKey">,
    pageSize: number,
    continuationToken?: string
  ): Promise<PaginatedResult>;

  /**
   * Paginated scan helper.
   * @param pageSize Max items per page (Limit).
   * @param continuationToken Opaque token from a previous page.
   */
  paginatedScan(
    params: Omit<ScanCommandInput, "Limit" | "ExclusiveStartKey">,
    pageSize: number,
    continuationToken?: string
  ): Promise<PaginatedResult>;
}

// ─── Real Client Factory ─────────────────────────────────────────────────────

const DEFAULT_REGION = "ap-south-1";

/**
 * Creates a real DynamoClient backed by AWS SDK v3 DynamoDBDocumentClient.
 */
export function createDynamoClient(
  region: string = DEFAULT_REGION
): DynamoClient {
  const ddb = new DynamoDBClient({ region });
  const docClient = DynamoDBDocumentClient.from(ddb, {
    marshallOptions: { removeUndefinedValues: true },
  });

  return {
    async put(params) {
      try {
        await docClient.send(new PutCommand(params));
      } catch (err: unknown) {
        if (isConditionalCheckFailed(err)) {
          throw new ConditionalCheckFailedError();
        }
        throw err;
      }
    },

    async get(params) {
      const res = await docClient.send(new GetCommand(params));
      return (res.Item as DynamoItem) ?? null;
    },

    async update(params) {
      try {
        const res = await docClient.send(
          new UpdateCommand({ ...params, ReturnValues: "ALL_NEW" })
        );
        return res.Attributes as DynamoItem | undefined;
      } catch (err: unknown) {
        if (isConditionalCheckFailed(err)) {
          throw new ConditionalCheckFailedError();
        }
        throw err;
      }
    },

    async delete(params) {
      await docClient.send(new DeleteCommand(params));
    },

    async query(params) {
      const res = await docClient.send(new QueryCommand(params));
      return {
        items: (res.Items as DynamoItem[]) ?? [],
        nextToken: res.LastEvaluatedKey
          ? encodeToken(res.LastEvaluatedKey)
          : undefined,
      };
    },

    async scan(params) {
      const res = await docClient.send(new ScanCommand(params));
      return {
        items: (res.Items as DynamoItem[]) ?? [],
        nextToken: res.LastEvaluatedKey
          ? encodeToken(res.LastEvaluatedKey)
          : undefined,
      };
    },

    async conditionalPut(tableName, item, partitionKeyName) {
      await this.put({
        TableName: tableName,
        Item: item,
        ConditionExpression: `attribute_not_exists(#pk)`,
        ExpressionAttributeNames: { "#pk": partitionKeyName },
      });
    },

    async mapUpdate(tableName, key, mapAttr, nestedKey, value) {
      await this.update({
        TableName: tableName,
        Key: key,
        UpdateExpression: `SET #map.#key = :val`,
        ExpressionAttributeNames: {
          "#map": mapAttr,
          "#key": nestedKey,
        },
        ExpressionAttributeValues: { ":val": value },
      });
    },

    async mapRemove(tableName, key, mapAttr, nestedKey) {
      try {
        await docClient.send(
          new UpdateCommand({
            TableName: tableName,
            Key: key,
            UpdateExpression: `REMOVE #map.#key`,
            ConditionExpression: `attribute_exists(#map.#key)`,
            ExpressionAttributeNames: {
              "#map": mapAttr,
              "#key": nestedKey,
            },
          })
        );
      } catch (err: unknown) {
        if (isConditionalCheckFailed(err)) {
          throw new ConditionalCheckFailedError();
        }
        throw err;
      }
    },

    async atomicIncrement(tableName, key, counterAttr, incrementBy, options) {
      const names: Record<string, string> = {
        "#counter": counterAttr,
        ...(options?.expressionAttributeNames ?? {}),
      };
      const values: Record<string, unknown> = {
        ":inc": incrementBy,
        ...(options?.expressionAttributeValues ?? {}),
      };

      let updateExpr = `ADD #counter :inc`;
      if (options?.additionalSetExpressions) {
        updateExpr += ` SET ${options.additionalSetExpressions}`;
      }

      try {
        const res = await docClient.send(
          new UpdateCommand({
            TableName: tableName,
            Key: key,
            UpdateExpression: updateExpr,
            ConditionExpression: options?.conditionExpression,
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
            ReturnValues: "ALL_NEW",
          })
        );
        return (res.Attributes?.[counterAttr] as number) ?? incrementBy;
      } catch (err: unknown) {
        if (isConditionalCheckFailed(err)) {
          throw new ConditionalCheckFailedError();
        }
        throw err;
      }
    },

    async paginatedQuery(params, pageSize, continuationToken) {
      const input: QueryCommandInput = {
        ...params,
        Limit: pageSize,
        ExclusiveStartKey: continuationToken
          ? decodeToken(continuationToken)
          : undefined,
      };
      return this.query(input);
    },

    async paginatedScan(params, pageSize, continuationToken) {
      const input: ScanCommandInput = {
        ...params,
        Limit: pageSize,
        ExclusiveStartKey: continuationToken
          ? decodeToken(continuationToken)
          : undefined,
      };
      return this.scan(input);
    },
  };
}

// ─── Token Encoding ──────────────────────────────────────────────────────────

/** Encode DynamoDB LastEvaluatedKey as an opaque base64 continuation token. */
function encodeToken(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key)).toString("base64url");
}

/** Decode a continuation token back into a DynamoDB ExclusiveStartKey. */
function decodeToken(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token, "base64url").toString("utf-8"));
}

// ─── Error Detection ─────────────────────────────────────────────────────────

function isConditionalCheckFailed(err: unknown): boolean {
  if (err && typeof err === "object" && "name" in err) {
    return (err as { name: string }).name === "ConditionalCheckFailedException";
  }
  return false;
}
