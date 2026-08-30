/**
 * Persistence contracts deliberately do not import a database implementation.
 *
 * The package currently supports Node versions older than the first supported
 * `node:sqlite` release.  Keeping this port structural means that a host can
 * provide node:sqlite, a test database, or another SQLite-compatible adapter
 * without making the domain layer depend on a runtime-specific module.
 */

/** Values accepted by SQLite parameter binding. */
export type SqliteValue = string | number | bigint | Uint8Array | null;

/** A positional parameter list. Callers must never interpolate values into SQL. */
export type SqliteParameters = readonly SqliteValue[];

export interface SqliteRunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

/**
 * The smallest async-compatible SQLite port used by the persistence store.
 *
 * `exec` is reserved for static schema statements. Queries and mutations must
 * use `run`, `get`, or `all` and provide a parameter array, including an empty
 * array for a statement without placeholders.
 */
export interface SqlitePort {
  exec(sql: string): void | PromiseLike<void>;
  run(sql: string, parameters: SqliteParameters): SqliteRunResult | PromiseLike<SqliteRunResult>;
  get<Row extends object = Record<string, unknown>>(
    sql: string,
    parameters: SqliteParameters,
  ): Row | undefined | PromiseLike<Row | undefined>;
  all<Row extends object = Record<string, unknown>>(
    sql: string,
    parameters: SqliteParameters,
  ): readonly Row[] | PromiseLike<readonly Row[]>;
  transaction<Result>(
    work: (transaction: SqlitePort) => Result | PromiseLike<Result>,
  ): Result | PromiseLike<Result>;
  close?(): void | PromiseLike<void>;
}

/** Explicit aliases used by callers that prefer storage-oriented terminology. */
export type SqliteStoragePort = SqlitePort;
export type PersistenceStorageAdapter = SqlitePort;

export type ChatBackingLifecycle = 'provisional' | 'materialized';

/**
 * Provider-neutral overlay persisted for one product chat.
 *
 * This is intentionally not a transcript or action shape. Claude SDK session
 * identity is retained as an opaque string, while the SDK transcript remains
 * the source of truth for conversation content.
 */
export interface PersistedChatBacking {
  readonly chatUri: string;
  readonly sdkSessionId: string;
  readonly cwd: string;
  readonly additionalDirectories: readonly string[];
  readonly model?: string;
  readonly effort?: string;
  readonly permissionMode: string;
  readonly lifecycle: ChatBackingLifecycle;
  readonly title?: string;
  readonly archived: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** SQLite row representation of {@link PersistedChatBacking}. */
export interface ChatBackingRow {
  readonly chat_uri: string;
  readonly sdk_session_id: string;
  readonly cwd: string;
  readonly additional_directories_json: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly permission_mode: string;
  readonly lifecycle: ChatBackingLifecycle;
  readonly title: string | null;
  readonly archived: 0 | 1;
  readonly created_at: string;
  readonly updated_at: string;
}

export type CommandReceiptStatus = 'accepted' | 'rejected';

/** JSON-safe command receipt payload. No SDK message or action is represented here. */
export type CommandReceiptPayload =
  | {
      readonly status: 'accepted';
      readonly value: JsonValue;
    }
  | {
      readonly status: 'rejected';
      readonly code: string;
      readonly message: string;
    };

/**
 * Idempotency record for a `(clientId, commandId)` pair.
 *
 * `chatUri` and `clientSeq` are optional because command deduplication can be
 * useful for host-level commands as well as chat commands.
 */
export interface PersistedCommandReceipt {
  readonly clientId: string;
  readonly commandId: string;
  readonly chatUri?: string;
  readonly clientSeq?: number;
  readonly receipt: CommandReceiptPayload;
  readonly createdAt: string;
}

/** SQLite row representation of {@link PersistedCommandReceipt}. */
export interface CommandReceiptRow {
  readonly client_id: string;
  readonly command_id: string;
  readonly chat_uri: string | null;
  readonly client_seq: number | null;
  readonly receipt_json: string;
  readonly created_at: string;
}

export type ApprovalAuditStatus =
  | 'requested'
  | 'resolved'
  | 'expired'
  | 'interrupted'
  | 'cancelled';

export type ApprovalDecision = 'allow' | 'deny';
export type ApprovalDecisionClassification = 'user_temporary' | 'user_permanent' | 'user_reject';

/**
 * Append-only, content-free approval audit entry.
 *
 * Tool input, output, token text, and action bodies are intentionally absent.
 */
export interface ApprovalAuditEntry {
  readonly auditId: string;
  readonly chatUri: string;
  readonly approvalId: string;
  readonly turnId: string;
  readonly status: ApprovalAuditStatus;
  readonly decision?: ApprovalDecision;
  readonly decisionClassification?: ApprovalDecisionClassification;
  readonly clientId?: string;
  readonly commandId?: string;
  readonly requestedAt?: string;
  readonly occurredAt: string;
}

/** SQLite row representation of {@link ApprovalAuditEntry}. */
export interface ApprovalAuditRow {
  readonly audit_id: string;
  readonly chat_uri: string;
  readonly approval_id: string;
  readonly turn_id: string;
  readonly status: ApprovalAuditStatus;
  readonly decision: ApprovalDecision | null;
  readonly decision_classification: ApprovalDecisionClassification | null;
  readonly client_id: string | null;
  readonly command_id: string | null;
  readonly requested_at: string | null;
  readonly occurred_at: string;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

/** Schema metadata row used while selecting and applying migrations. */
export interface SchemaMigrationRow {
  readonly version: number;
  readonly name: string;
  readonly applied_at: string;
}

/** Migration definition. Statements are static and contain no caller values. */
export interface PersistenceMigration {
  readonly version: number;
  readonly name: string;
  readonly statements: readonly string[];
}

export interface PersistenceStoreOptions {
  readonly now?: () => string;
}

/** Structural subset needed to wrap a synchronous or async SQLite library. */
export interface SqliteStatementLike {
  run(...parameters: SqliteValue[]): SqliteRunResult;
  get(...parameters: SqliteValue[]): unknown;
  all(...parameters: SqliteValue[]): readonly unknown[];
}

export interface SqliteDatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatementLike;
  close?(): void;
}

/** A common result shape for operation-level persistence errors. */
export interface PersistenceErrorDetails {
  readonly operation: string;
  readonly cause: unknown;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Runtime JSON guard shared by codecs and storage adapters. */
export function isJsonValue(value: unknown, ancestors: readonly object[] = []): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value !== 'object' || ancestors.includes(value)) {
    return false;
  }

  const nextAncestors = [...ancestors, value];
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item, nextAncestors));
  }
  if (!isPlainRecord(value)) {
    return false;
  }
  return Object.keys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined
      && descriptor.enumerable
      && 'value' in descriptor
      && isJsonValue(descriptor.value, nextAncestors);
  });
}

export function isJsonObject(value: unknown): value is JsonObject {
  return isPlainRecord(value) && isJsonValue(value);
}

/** Defensive recursive clone used at persistence boundaries. */
export function cloneJsonValue<T extends JsonValue>(value: T): T {
  return cloneJson(value, new WeakSet<object>()) as T;
}

function cloneJson(value: JsonValue, ancestors: WeakSet<object>): JsonValue {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (ancestors.has(value)) {
    throw new TypeError('JSON value must not contain cycles');
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    const copy = value.map((item) => cloneJson(item, ancestors));
    ancestors.delete(value);
    return Object.freeze(copy);
  }

  const copy: Record<string, JsonValue> = {};
  const objectValue = value as { readonly [key: string]: JsonValue };
  for (const key of Object.keys(value)) {
    copy[key] = cloneJson(objectValue[key]!, ancestors);
  }
  ancestors.delete(value);
  return Object.freeze(copy);
}

export function freezePersistedChatBacking(value: PersistedChatBacking): PersistedChatBacking {
  Object.freeze(value.additionalDirectories);
  return Object.freeze(value);
}

export function freezePersistedCommandReceipt(value: PersistedCommandReceipt): PersistedCommandReceipt {
  return Object.freeze({
    ...value,
    receipt: cloneJsonValue(value.receipt),
  });
}

export function freezeApprovalAuditEntry(value: ApprovalAuditEntry): ApprovalAuditEntry {
  return Object.freeze(value);
}
