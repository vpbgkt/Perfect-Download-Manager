/**
 * In-memory fake DynamoDB document client for tests.
 *
 * Implements the {@link DynamoClient} interface from `lib/dynamo.ts` with the
 * same observable semantics the real AWS SDK v3 document client exposes, so the
 * shared libraries (dynamo helpers, audit, licenses, rate-limit, …) can be
 * exercised without a live DynamoDB:
 *
 * - **Conditional / append-only writes** — `conditionalPut` writes only when the
 *   partition key does not already exist, otherwise throws
 *   {@link ConditionalCheckFailedError} (never overwrites).
 * - **Nested map updates** — `mapUpdate` / `mapRemove` on a map attribute.
 * - **Atomic counters** — `atomicIncrement` via an ADD-style increment with an
 *   optional condition expression.
 * - **GSI-aware queries** — `query` / `paginatedQuery` evaluate the
 *   `KeyConditionExpression` (resolving `ExpressionAttributeNames` /
 *   `ExpressionAttributeValues`) against every stored item, supporting the
 *   `=`, `<`, `<=`, `>`, `>=`, `BETWEEN … AND …`, and `begins_with(…)` operators
 *   over a partition key plus an optional sort key. An `IndexName` restricts the
 *   result to items that carry the attributes referenced by the condition, which
 *   mirrors how a Global Secondary Index only projects items that have its keys.
 *
 * Table key schemas are discovered lazily: the first `conditionalPut` (or an
 * explicit {@link FakeDynamoClient.registerKeySchema}) records the partition key
 * used for identity of subsequent `get` / `put` / `update` / `delete` calls.
 *
 * @module test/fakes/dynamo-fake
 */

import {
  ConditionalCheckFailedError,
  type DynamoClient,
  type DynamoItem,
  type PaginatedResult,
} from "../dynamo.ts";

/** Partition (and optional sort) key attribute names for a table. */
interface KeySchema {
  pk: string;
  sk?: string;
}

/** Deep clone helper so stored items are isolated from callers' references. */
function clone<T>(value: T): T {
  return structuredClone(value);
}

// ─── Key-condition evaluation ─────────────────────────────────────────────────

/** Resolve an expression token that may be an `#alias` name or a literal attr. */
function resolveAttrName(token: string, names: Record<string, string> | undefined): string {
  if (token.startsWith("#")) {
    const resolved = names?.[token];
    if (resolved === undefined) {
      throw new Error(`Missing ExpressionAttributeName for ${token}`);
    }
    return resolved;
  }
  return token;
}

/** Resolve an expression token that may be a `:value` placeholder or a literal. */
function resolveValue(token: string, values: Record<string, unknown> | undefined): unknown {
  if (token.startsWith(":")) {
    if (!values || !(token in values)) {
      throw new Error(`Missing ExpressionAttributeValue for ${token}`);
    }
    return values[token];
  }
  return token;
}

/** Order comparison usable for numbers and ISO-8601 / lexicographic strings. */
function lessThan(a: unknown, b: unknown): boolean {
  return (a as number | string) < (b as number | string);
}
function equalTo(a: unknown, b: unknown): boolean {
  return a === b;
}

/**
 * Evaluate a single key-condition clause against an item. Returns false when the
 * referenced attribute is absent (the item is not part of the queried key space).
 */
function evaluateClause(
  item: DynamoItem,
  clause: string,
  names: Record<string, string> | undefined,
  values: Record<string, unknown> | undefined
): boolean {
  const trimmed = clause.trim();

  // begins_with(#attr, :val)
  const beginsWith = /^begins_with\s*\(\s*(\S+)\s*,\s*(\S+)\s*\)$/i.exec(trimmed);
  if (beginsWith) {
    const attr = resolveAttrName(beginsWith[1], names);
    const prefix = resolveValue(beginsWith[2], values);
    const actual = item[attr];
    return (
      typeof actual === "string" &&
      typeof prefix === "string" &&
      actual.startsWith(prefix)
    );
  }

  // #attr BETWEEN :lo AND :hi   (the inner AND is protected by the caller)
  const between = /^(\S+)\s+BETWEEN\s+(\S+)\s+(?:AND|%%AND%%)\s+(\S+)$/i.exec(trimmed);
  if (between) {
    const attr = resolveAttrName(between[1], names);
    const lo = resolveValue(between[2], values);
    const hi = resolveValue(between[3], values);
    const actual = item[attr];
    if (actual === undefined) return false;
    return !lessThan(actual, lo) && !lessThan(hi, actual);
  }

  // #attr <op> :val
  const binary = /^(\S+)\s*(<=|>=|<>|=|<|>)\s*(\S+)$/.exec(trimmed);
  if (binary) {
    const attr = resolveAttrName(binary[1], names);
    const op = binary[2];
    const val = resolveValue(binary[3], values);
    const actual = item[attr];
    if (actual === undefined) return false;
    switch (op) {
      case "=":
        return equalTo(actual, val);
      case "<>":
        return !equalTo(actual, val);
      case "<":
        return lessThan(actual, val);
      case "<=":
        return lessThan(actual, val) || equalTo(actual, val);
      case ">":
        return lessThan(val, actual);
      case ">=":
        return lessThan(val, actual) || equalTo(actual, val);
      default:
        return false;
    }
  }

  throw new Error(`Unsupported key-condition clause: "${trimmed}"`);
}

/** Determine the sort-key attribute referenced by a range clause, if any. */
function sortAttrFromClauses(
  clauses: string[],
  names: Record<string, string> | undefined
): string | undefined {
  for (const clause of clauses) {
    const trimmed = clause.trim();
    const between = /^(\S+)\s+BETWEEN\s+/i.exec(trimmed);
    if (between) return resolveAttrName(between[1], names);
    const range = /^(\S+)\s*(<=|>=|<|>)\s*\S+$/.exec(trimmed);
    if (range) return resolveAttrName(range[1], names);
  }
  return undefined;
}

/**
 * Evaluate a full `KeyConditionExpression` against an item. Clauses are joined
 * by top-level `AND`; a `BETWEEN … AND …` clause's inner `AND` is protected so
 * the split does not break it.
 */
function evaluateKeyCondition(
  item: DynamoItem,
  expression: string,
  names: Record<string, string> | undefined,
  values: Record<string, unknown> | undefined
): boolean {
  const clauses = splitClauses(expression);
  return clauses.every((clause) => evaluateClause(item, clause, names, values));
}

/** Split a key-condition expression into clauses on top-level `AND`. */
function splitClauses(expression: string): string[] {
  const protectedExpr = expression.replace(
    /BETWEEN\s+(\S+)\s+AND\s+(\S+)/gi,
    (_m, lo, hi) => `BETWEEN ${lo} %%AND%% ${hi}`
  );
  return protectedExpr.split(/\s+AND\s+/i).map((c) => c.trim()).filter(Boolean);
}

// ─── Fake client ──────────────────────────────────────────────────────────────

/** In-memory {@link DynamoClient} used by the test-suite. */
export class FakeDynamoClient implements DynamoClient {
  private readonly tables = new Map<string, DynamoItem[]>();
  private readonly schemas = new Map<string, KeySchema>();

  /** Register (or override) the key schema for a table. */
  registerKeySchema(tableName: string, pk: string, sk?: string): void {
    this.schemas.set(tableName, { pk, sk });
  }

  /** Read-only snapshot of all items in a table (cloned). */
  dump(tableName: string): DynamoItem[] {
    return (this.tables.get(tableName) ?? []).map(clone);
  }

  /**
   * Read-only snapshot of all items in a table (cloned). Alias of {@link dump}
   * exposed for tests that speak the `allItems` vocabulary.
   */
  allItems(tableName: string): DynamoItem[] {
    return this.dump(tableName);
  }

  /** Number of items currently stored in a table. */
  itemCount(tableName: string): number {
    return this.tables.get(tableName)?.length ?? 0;
  }

  private table(tableName: string): DynamoItem[] {
    let store = this.tables.get(tableName);
    if (!store) {
      store = [];
      this.tables.set(tableName, store);
    }
    return store;
  }

  /** Compare an item to a key object across the table's schema (or the key's own attrs). */
  private sameKey(tableName: string, item: DynamoItem, key: DynamoItem): boolean {
    const schema = this.schemas.get(tableName);
    if (schema) {
      if (item[schema.pk] !== key[schema.pk]) return false;
      if (schema.sk !== undefined && item[schema.sk] !== key[schema.sk]) return false;
      return true;
    }
    // No known schema: match on every attribute present in the key object.
    return Object.keys(key).every((k) => item[k] === key[k]);
  }

  async put(params: { TableName?: string; Item?: DynamoItem }): Promise<void> {
    const tableName = params.TableName!;
    const item = clone(params.Item!);
    const store = this.table(tableName);
    const idx = store.findIndex((existing) => this.sameKey(tableName, existing, item));
    if (idx >= 0) {
      store[idx] = item;
    } else {
      store.push(item);
    }
  }

  async get(params: { TableName?: string; Key?: DynamoItem }): Promise<DynamoItem | null> {
    const tableName = params.TableName!;
    const key = params.Key!;
    const found = this.table(tableName).find((item) => this.sameKey(tableName, item, key));
    return found ? clone(found) : null;
  }

  async update(params: {
    TableName?: string;
    Key?: DynamoItem;
    UpdateExpression?: string;
    ConditionExpression?: string;
    ExpressionAttributeNames?: Record<string, string>;
    ExpressionAttributeValues?: Record<string, unknown>;
  }): Promise<DynamoItem | undefined> {
    const tableName = params.TableName!;
    const key = params.Key!;
    const store = this.table(tableName);
    let idx = store.findIndex((item) => this.sameKey(tableName, item, key));

    if (idx < 0) {
      // UpdateItem creates the item when it does not exist (unless a condition
      // requires attribute_exists, which we treat as a failed condition).
      if (params.ConditionExpression && /attribute_exists/i.test(params.ConditionExpression)) {
        throw new ConditionalCheckFailedError();
      }
      store.push(clone(key));
      idx = store.length - 1;
    }

    const item = store[idx];
    applyUpdateExpression(
      item,
      params.UpdateExpression ?? "",
      params.ExpressionAttributeNames,
      params.ExpressionAttributeValues,
      params.ConditionExpression
    );
    return clone(item);
  }

  async delete(params: { TableName?: string; Key?: DynamoItem }): Promise<void> {
    const tableName = params.TableName!;
    const key = params.Key!;
    const store = this.table(tableName);
    const idx = store.findIndex((item) => this.sameKey(tableName, item, key));
    if (idx >= 0) store.splice(idx, 1);
  }

  async query(params: {
    TableName?: string;
    IndexName?: string;
    KeyConditionExpression?: string;
    ExpressionAttributeNames?: Record<string, string>;
    ExpressionAttributeValues?: Record<string, unknown>;
    Limit?: number;
    ExclusiveStartKey?: Record<string, unknown>;
    ScanIndexForward?: boolean;
  }): Promise<PaginatedResult> {
    const tableName = params.TableName!;
    const expression = params.KeyConditionExpression ?? "";
    const names = params.ExpressionAttributeNames;
    const values = params.ExpressionAttributeValues;

    let items = this.table(tableName).filter((item) =>
      evaluateKeyCondition(item, expression, names, values)
    );

    // Order by the sort key (ascending by default) to mirror DynamoDB.
    const sortAttr = sortAttrFromClauses(splitClauses(expression), names);
    if (sortAttr) {
      items = [...items].sort((a, b) => {
        const av = a[sortAttr];
        const bv = b[sortAttr];
        if (av === bv) return 0;
        return lessThan(av, bv) ? -1 : 1;
      });
      if (params.ScanIndexForward === false) items.reverse();
    }

    // Pagination via an opaque numeric offset token.
    const startOffset = params.ExclusiveStartKey
      ? Number((params.ExclusiveStartKey as { __offset?: number }).__offset ?? 0)
      : 0;
    const windowed = params.Limit !== undefined ? items.slice(startOffset, startOffset + params.Limit) : items.slice(startOffset);
    const nextOffset = startOffset + windowed.length;
    const hasMore = params.Limit !== undefined && nextOffset < items.length;

    return {
      items: windowed.map(clone),
      nextToken: hasMore ? encodeOffset(nextOffset) : undefined,
    };
  }

  async scan(params: {
    TableName?: string;
    Limit?: number;
    ExclusiveStartKey?: Record<string, unknown>;
  }): Promise<PaginatedResult> {
    const tableName = params.TableName!;
    const items = this.table(tableName);
    const startOffset = params.ExclusiveStartKey
      ? Number((params.ExclusiveStartKey as { __offset?: number }).__offset ?? 0)
      : 0;
    const windowed = params.Limit !== undefined ? items.slice(startOffset, startOffset + params.Limit) : items.slice(startOffset);
    const nextOffset = startOffset + windowed.length;
    const hasMore = params.Limit !== undefined && nextOffset < items.length;
    return {
      items: windowed.map(clone),
      nextToken: hasMore ? encodeOffset(nextOffset) : undefined,
    };
  }

  async conditionalPut(
    tableName: string,
    item: DynamoItem,
    partitionKeyName: string
  ): Promise<void> {
    if (!this.schemas.has(tableName)) {
      this.schemas.set(tableName, { pk: partitionKeyName });
    }
    const store = this.table(tableName);
    const exists = store.some(
      (existing) => existing[partitionKeyName] === item[partitionKeyName]
    );
    if (exists) {
      throw new ConditionalCheckFailedError();
    }
    store.push(clone(item));
  }

  async mapUpdate(
    tableName: string,
    key: DynamoItem,
    mapAttr: string,
    nestedKey: string,
    value: unknown
  ): Promise<void> {
    const store = this.table(tableName);
    let item = store.find((existing) => this.sameKey(tableName, existing, key));
    if (!item) {
      item = clone(key);
      store.push(item);
    }
    const map = (item[mapAttr] as Record<string, unknown> | undefined) ?? {};
    map[nestedKey] = clone(value);
    item[mapAttr] = map;
  }

  async mapRemove(
    tableName: string,
    key: DynamoItem,
    mapAttr: string,
    nestedKey: string
  ): Promise<void> {
    const store = this.table(tableName);
    const item = store.find((existing) => this.sameKey(tableName, existing, key));
    const map = item?.[mapAttr] as Record<string, unknown> | undefined;
    if (!item || !map || !(nestedKey in map)) {
      throw new ConditionalCheckFailedError();
    }
    delete map[nestedKey];
  }

  async atomicIncrement(
    tableName: string,
    key: DynamoItem,
    counterAttr: string,
    incrementBy: number,
    options?: {
      conditionExpression?: string;
      expressionAttributeNames?: Record<string, string>;
      expressionAttributeValues?: Record<string, unknown>;
      additionalSetExpressions?: string;
    }
  ): Promise<number> {
    const store = this.table(tableName);
    let item = store.find((existing) => this.sameKey(tableName, existing, key));
    if (!item) {
      item = clone(key);
      store.push(item);
    }

    const current = typeof item[counterAttr] === "number" ? (item[counterAttr] as number) : 0;
    const next = current + incrementBy;

    if (
      options?.conditionExpression &&
      !evaluateSimpleCondition(
        item,
        counterAttr,
        next,
        options.conditionExpression,
        options.expressionAttributeNames,
        options.expressionAttributeValues
      )
    ) {
      throw new ConditionalCheckFailedError();
    }

    item[counterAttr] = next;
    return next;
  }

  async paginatedQuery(
    params: {
      TableName?: string;
      IndexName?: string;
      KeyConditionExpression?: string;
      ExpressionAttributeNames?: Record<string, string>;
      ExpressionAttributeValues?: Record<string, unknown>;
      ScanIndexForward?: boolean;
    },
    pageSize: number,
    continuationToken?: string
  ): Promise<PaginatedResult> {
    return this.query({
      ...params,
      Limit: pageSize,
      ExclusiveStartKey: continuationToken ? decodeOffset(continuationToken) : undefined,
    });
  }

  async paginatedScan(
    params: { TableName?: string },
    pageSize: number,
    continuationToken?: string
  ): Promise<PaginatedResult> {
    return this.scan({
      ...params,
      Limit: pageSize,
      ExclusiveStartKey: continuationToken ? decodeOffset(continuationToken) : undefined,
    });
  }
}

// ─── Update-expression + condition helpers ────────────────────────────────────

/** Apply a subset of DynamoDB `UpdateExpression` syntax to an in-memory item. */
function applyUpdateExpression(
  item: DynamoItem,
  expression: string,
  names: Record<string, string> | undefined,
  values: Record<string, unknown> | undefined,
  conditionExpression?: string
): void {
  if (conditionExpression && /attribute_exists/i.test(conditionExpression)) {
    // Best-effort: verify the referenced nested path exists.
    const match = /attribute_exists\s*\(\s*([^)]+)\s*\)/i.exec(conditionExpression);
    if (match) {
      const path = match[1].split(".").map((p) => resolveAttrName(p.trim(), names));
      let cursor: unknown = item;
      for (const segment of path) {
        if (cursor === null || typeof cursor !== "object" || !(segment in (cursor as object))) {
          throw new ConditionalCheckFailedError();
        }
        cursor = (cursor as Record<string, unknown>)[segment];
      }
    }
  }

  // SET clauses: "SET #a.#b = :v, #c = :d"
  const setMatch = /SET\s+(.+?)(?:\s+REMOVE\s+|\s+ADD\s+|$)/is.exec(expression);
  if (setMatch) {
    for (const assignment of setMatch[1].split(",")) {
      const [lhs, rhs] = assignment.split("=");
      if (!lhs || rhs === undefined) continue;
      const path = lhs.trim().split(".").map((p) => resolveAttrName(p.trim(), names));
      const value = clone(resolveValue(rhs.trim(), values));
      setNested(item, path, value);
    }
  }

  // REMOVE clauses: "REMOVE #a.#b"
  const removeMatch = /REMOVE\s+(.+?)(?:\s+SET\s+|\s+ADD\s+|$)/is.exec(expression);
  if (removeMatch) {
    for (const target of removeMatch[1].split(",")) {
      const path = target.trim().split(".").map((p) => resolveAttrName(p.trim(), names));
      removeNested(item, path);
    }
  }

  // ADD clause: "ADD #counter :inc"
  const addMatch = /ADD\s+(\S+)\s+(\S+)/i.exec(expression);
  if (addMatch) {
    const attr = resolveAttrName(addMatch[1], names);
    const inc = resolveValue(addMatch[2], values);
    const current = typeof item[attr] === "number" ? (item[attr] as number) : 0;
    item[attr] = current + (inc as number);
  }
}

function setNested(root: DynamoItem, path: string[], value: unknown): void {
  let cursor: Record<string, unknown> = root;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i];
    if (typeof cursor[seg] !== "object" || cursor[seg] === null) {
      cursor[seg] = {};
    }
    cursor = cursor[seg] as Record<string, unknown>;
  }
  cursor[path[path.length - 1]] = value;
}

function removeNested(root: DynamoItem, path: string[]): void {
  let cursor: Record<string, unknown> = root;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i];
    if (typeof cursor[seg] !== "object" || cursor[seg] === null) return;
    cursor = cursor[seg] as Record<string, unknown>;
  }
  delete cursor[path[path.length - 1]];
}

/**
 * Evaluate a simple counter condition of the form `#counter <= :max` or
 * `attribute_not_exists(#counter) OR #counter <= :max`, using the prospective
 * next counter value. Returns true when the write is permitted.
 */
function evaluateSimpleCondition(
  item: DynamoItem,
  counterAttr: string,
  nextValue: number,
  condition: string,
  names: Record<string, string> | undefined,
  values: Record<string, unknown> | undefined
): boolean {
  const parts = condition.split(/\s+OR\s+/i);
  return parts.some((part) => {
    const trimmed = part.trim();
    if (/attribute_not_exists/i.test(trimmed)) {
      return !(counterAttr in item);
    }
    const binary = /^(\S+)\s*(<=|>=|<|>|=)\s*(\S+)$/.exec(trimmed);
    if (!binary) return true;
    const val = resolveValue(binary[3], values);
    const op = binary[2];
    switch (op) {
      case "<=":
        return nextValue <= (val as number);
      case "<":
        return nextValue < (val as number);
      case ">=":
        return nextValue >= (val as number);
      case ">":
        return nextValue > (val as number);
      case "=":
        return nextValue === (val as number);
      default:
        return true;
    }
  });
}

// ─── Continuation-token encoding ──────────────────────────────────────────────

function encodeOffset(offset: number): string {
  return Buffer.from(JSON.stringify({ __offset: offset })).toString("base64url");
}

function decodeOffset(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token, "base64url").toString("utf-8"));
}

// ─── Alternate constructor surface ────────────────────────────────────────────

/**
 * Alias of {@link FakeDynamoClient}. Some tests refer to the in-memory client as
 * `DynamoFake`; it is the exact same implementation (subclass with no changes),
 * so both names resolve to one consistent behaviour.
 */
export class DynamoFake extends FakeDynamoClient {}

/**
 * Factory returning a fresh in-memory {@link FakeDynamoClient}. Provided for
 * tests that prefer a `createDynamoFake()` call over `new FakeDynamoClient()`.
 */
export function createDynamoFake(): FakeDynamoClient {
  return new FakeDynamoClient();
}
