import type {
  ApprovalAuditEntry,
  ApprovalAuditRow,
  ApprovalAuditStatus,
  ChatBackingRow,
  CommandReceiptPayload,
  CommandReceiptRow,
  JsonValue,
  PersistedChatBacking,
  PersistedCommandReceipt,
  PersistenceMigration,
  SchemaMigrationRow,
  SqliteParameters,
  SqlitePort,
  SqliteRunResult,
  SqliteDatabaseLike,
  SqliteStatementLike,
  SqliteValue,
} from './types.js';
import {
  cloneJsonValue,
  freezeApprovalAuditEntry,
  freezePersistedChatBacking,
  freezePersistedCommandReceipt,
  isJsonObject,
  isJsonValue,
} from './types.js';

export const PERSISTENCE_SCHEMA_NAME = 'ccvibe-agent-host' as const;
export const SCHEMA_MIGRATIONS_TABLE = 'schema_migrations' as const;
export const CHAT_BACKINGS_TABLE = 'chat_backings' as const;
export const COMMAND_RECEIPTS_TABLE = 'command_receipts' as const;
export const APPROVAL_AUDIT_TABLE = 'approval_audit' as const;

export const LATEST_SCHEMA_VERSION = 3 as const;
export const PERSISTENCE_SCHEMA_VERSION = LATEST_SCHEMA_VERSION;
export const SCHEMA_VERSION = LATEST_SCHEMA_VERSION;

/** Static DDL for schema metadata. This statement has no caller values. */
export const CREATE_SCHEMA_MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS ${SCHEMA_MIGRATIONS_TABLE} (
  version INTEGER PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
)
` as const;

const CREATE_CHAT_BACKINGS_TABLE = `
CREATE TABLE IF NOT EXISTS ${CHAT_BACKINGS_TABLE} (
  chat_uri TEXT PRIMARY KEY NOT NULL,
  sdk_session_id TEXT NOT NULL UNIQUE,
  cwd TEXT NOT NULL,
  additional_directories_json TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  permission_mode TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('provisional', 'materialized')),
  title TEXT,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
` as const;

const CREATE_COMMAND_RECEIPTS_TABLE = `
CREATE TABLE IF NOT EXISTS ${COMMAND_RECEIPTS_TABLE} (
  client_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  chat_uri TEXT,
  client_seq INTEGER,
  receipt_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (client_id, command_id)
)
` as const;

const CREATE_APPROVAL_AUDIT_TABLE = `
CREATE TABLE IF NOT EXISTS ${APPROVAL_AUDIT_TABLE} (
  audit_id TEXT PRIMARY KEY NOT NULL,
  chat_uri TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('requested', 'resolved', 'expired', 'interrupted', 'cancelled')),
  decision TEXT CHECK (decision IS NULL OR decision IN ('allow', 'deny')),
  decision_classification TEXT CHECK (
    decision_classification IS NULL OR
    decision_classification IN ('user_temporary', 'user_permanent', 'user_reject')
  ),
  client_id TEXT,
  command_id TEXT,
  requested_at TEXT,
  occurred_at TEXT NOT NULL
)
` as const;

const CREATE_APPROVAL_AUDIT_INDEX = `
CREATE INDEX IF NOT EXISTS ccvibe_approval_audit_chat_time
  ON ${APPROVAL_AUDIT_TABLE} (chat_uri, occurred_at, audit_id)
` as const;

const CREATE_COMMAND_RECEIPTS_INDEX = `
CREATE INDEX IF NOT EXISTS ccvibe_command_receipts_chat_time
  ON ${COMMAND_RECEIPTS_TABLE} (chat_uri, created_at)
` as const;

const CHAT_BACKING_COLUMNS = [
  'chat_uri',
  'sdk_session_id',
  'cwd',
  'additional_directories_json',
  'model',
  'effort',
  'permission_mode',
  'lifecycle',
  'title',
  'archived',
  'created_at',
  'updated_at',
] as const;

const COMMAND_RECEIPT_COLUMNS = [
  'client_id',
  'command_id',
  'chat_uri',
  'client_seq',
  'receipt_json',
  'created_at',
] as const;

const APPROVAL_AUDIT_COLUMNS = [
  'audit_id',
  'chat_uri',
  'approval_id',
  'turn_id',
  'status',
  'decision',
  'decision_classification',
  'client_id',
  'command_id',
  'requested_at',
  'occurred_at',
] as const;

/** Versioned, ordered, idempotent migrations. */
export const PERSISTENCE_MIGRATIONS: readonly PersistenceMigration[] = Object.freeze([
  Object.freeze({
    version: 1,
    name: 'create-chat-backing-overlay',
    statements: Object.freeze([CREATE_SCHEMA_MIGRATIONS_TABLE, CREATE_CHAT_BACKINGS_TABLE]),
  }),
  Object.freeze({
    version: 2,
    name: 'create-command-receipts',
    statements: Object.freeze([CREATE_COMMAND_RECEIPTS_TABLE, CREATE_COMMAND_RECEIPTS_INDEX]),
  }),
  Object.freeze({
    version: 3,
    name: 'create-approval-audit',
    statements: Object.freeze([CREATE_APPROVAL_AUDIT_TABLE, CREATE_APPROVAL_AUDIT_INDEX]),
  }),
]);

/** Short aliases for consumers that use the conventional migration name. */
export const MIGRATIONS = PERSISTENCE_MIGRATIONS;
export const migrations = PERSISTENCE_MIGRATIONS;

export const SQL = Object.freeze({
  selectAppliedMigrations: `
SELECT version, name, applied_at
FROM ${SCHEMA_MIGRATIONS_TABLE}
ORDER BY version ASC
`,
  insertMigration: `
INSERT OR IGNORE INTO ${SCHEMA_MIGRATIONS_TABLE} (version, name, applied_at)
VALUES (?, ?, ?)
`,
  selectChatBacking: `
SELECT chat_uri, sdk_session_id, cwd, additional_directories_json,
       model, effort, permission_mode, lifecycle, title, archived,
       created_at, updated_at
FROM ${CHAT_BACKINGS_TABLE}
WHERE chat_uri = ?
`,
  selectChatBackings: `
SELECT chat_uri, sdk_session_id, cwd, additional_directories_json,
       model, effort, permission_mode, lifecycle, title, archived,
       created_at, updated_at
FROM ${CHAT_BACKINGS_TABLE}
ORDER BY updated_at ASC, chat_uri ASC
`,
  upsertChatBacking: `
INSERT INTO ${CHAT_BACKINGS_TABLE} (
  chat_uri, sdk_session_id, cwd, additional_directories_json, model,
  effort, permission_mode, lifecycle, title, archived, created_at, updated_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(chat_uri) DO UPDATE SET
  sdk_session_id = excluded.sdk_session_id,
  cwd = excluded.cwd,
  additional_directories_json = excluded.additional_directories_json,
  model = excluded.model,
  effort = excluded.effort,
  permission_mode = excluded.permission_mode,
  lifecycle = excluded.lifecycle,
  title = excluded.title,
  archived = excluded.archived,
  created_at = excluded.created_at,
  updated_at = excluded.updated_at
`,
  deleteChatBacking: `DELETE FROM ${CHAT_BACKINGS_TABLE} WHERE chat_uri = ?`,
  selectCommandReceipt: `
SELECT client_id, command_id, chat_uri, client_seq, receipt_json, created_at
FROM ${COMMAND_RECEIPTS_TABLE}
WHERE client_id = ? AND command_id = ?
`,
  selectCommandReceipts: `
SELECT client_id, command_id, chat_uri, client_seq, receipt_json, created_at
FROM ${COMMAND_RECEIPTS_TABLE}
ORDER BY created_at ASC, client_id ASC, command_id ASC
`,
  selectCommandReceiptsForChat: `
SELECT client_id, command_id, chat_uri, client_seq, receipt_json, created_at
FROM ${COMMAND_RECEIPTS_TABLE}
WHERE chat_uri = ?
ORDER BY created_at ASC, client_id ASC, command_id ASC
`,
  upsertCommandReceipt: `
INSERT INTO ${COMMAND_RECEIPTS_TABLE} (
  client_id, command_id, chat_uri, client_seq, receipt_json, created_at
)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(client_id, command_id) DO UPDATE SET
  chat_uri = excluded.chat_uri,
  client_seq = excluded.client_seq,
  receipt_json = excluded.receipt_json,
  created_at = excluded.created_at
`,
  deleteCommandReceipt: `
DELETE FROM ${COMMAND_RECEIPTS_TABLE}
WHERE client_id = ? AND command_id = ?
`,
  selectApprovalAuditForChat: `
SELECT audit_id, chat_uri, approval_id, turn_id, status, decision,
       decision_classification, client_id, command_id, requested_at, occurred_at
FROM ${APPROVAL_AUDIT_TABLE}
WHERE chat_uri = ?
ORDER BY occurred_at ASC, audit_id ASC
`,
  selectApprovalAudit: `
SELECT audit_id, chat_uri, approval_id, turn_id, status, decision,
       decision_classification, client_id, command_id, requested_at, occurred_at
FROM ${APPROVAL_AUDIT_TABLE}
ORDER BY occurred_at ASC, audit_id ASC
`,
  insertApprovalAudit: `
INSERT INTO ${APPROVAL_AUDIT_TABLE} (
  audit_id, chat_uri, approval_id, turn_id, status, decision,
  decision_classification, client_id, command_id, requested_at, occurred_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`,
  deleteApprovalAuditForChat: `DELETE FROM ${APPROVAL_AUDIT_TABLE} WHERE chat_uri = ?`,
});

export type AppliedMigrationVersionInput = number | readonly number[] | ReadonlySet<number>;

/**
 * Select migrations without consulting a database. A number denotes a
 * contiguous current version; a collection denotes the exact versions that
 * have already been recorded, which also makes recovery from a partially
 * populated metadata table deterministic.
 */
export function selectPendingMigrations(
  applied: AppliedMigrationVersionInput = 0,
  migrations: readonly PersistenceMigration[] = PERSISTENCE_MIGRATIONS,
): readonly PersistenceMigration[] {
  const ordered = validateMigrations(migrations);
  const appliedVersions = normalizeAppliedVersions(applied, ordered);
  return Object.freeze(ordered.filter((migration) => !appliedVersions.has(migration.version)));
}

export const selectMigrations = selectPendingMigrations;
export const pendingMigrations = selectPendingMigrations;

/** Return the highest version in a validated migration set, or zero when empty. */
export function latestMigrationVersion(
  migrations: readonly PersistenceMigration[] = PERSISTENCE_MIGRATIONS,
): number {
  const ordered = validateMigrations(migrations);
  return ordered.length === 0 ? 0 : ordered[ordered.length - 1]!.version;
}

export function isSchemaMigrationRow(value: unknown): value is SchemaMigrationRow {
  return tryValidateSchemaMigrationRow(value) !== undefined;
}

export function validateSchemaMigrationRow(value: unknown): SchemaMigrationRow {
  const validated = tryValidateSchemaMigrationRow(value);
  if (validated === undefined) {
    throw new TypeError('invalid schema migration row');
  }
  return validated;
}

function tryValidateSchemaMigrationRow(value: unknown): SchemaMigrationRow | undefined {
  if (!isRecord(value)
    || !isSafeInteger(value.version)
    || value.version < 1
    || typeof value.name !== 'string'
    || value.name.length === 0
    || typeof value.applied_at !== 'string'
    || value.applied_at.length === 0) {
    return undefined;
  }

  return Object.freeze({
    version: value.version,
    name: value.name,
    applied_at: value.applied_at,
  });
}

/** Encode a provider-neutral backing into its SQLite row. */
export function encodeChatBackingRow(value: PersistedChatBacking): ChatBackingRow {
  if (!isRecord(value)) {
    throw new TypeError('chat backing must be an object');
  }
  const chatUri = nonEmptyString(value.chatUri, 'chatUri');
  const sdkSessionId = nonEmptyString(value.sdkSessionId, 'sdkSessionId');
  const cwd = nonEmptyString(value.cwd, 'cwd');
  const additionalDirectories = validateStringArray(value.additionalDirectories, 'additionalDirectories');
  const permissionMode = nonEmptyString(value.permissionMode, 'permissionMode');
  const lifecycle = validateLifecycle(value.lifecycle);
  const createdAt = nonEmptyString(value.createdAt, 'createdAt');
  const updatedAt = nonEmptyString(value.updatedAt, 'updatedAt');
  const model = optionalString(value.model, 'model');
  const effort = optionalString(value.effort, 'effort');
  const title = optionalString(value.title, 'title');

  return Object.freeze({
    chat_uri: chatUri,
    sdk_session_id: sdkSessionId,
    cwd,
    additional_directories_json: encodeJson(additionalDirectories, 'additionalDirectories'),
    model,
    effort,
    permission_mode: permissionMode,
    lifecycle,
    title,
    archived: encodeBoolean(value.archived, 'archived'),
    created_at: createdAt,
    updated_at: updatedAt,
  });
}

export const encodeChatBacking = encodeChatBackingRow;

/** Decode and validate an untyped SQLite result row. */
export function decodeChatBackingRow(value: unknown): PersistedChatBacking {
  const row = validateChatBackingRow(value);
  const additionalDirectories = decodeStringArray(row.additional_directories_json, 'additionalDirectories');
  return freezePersistedChatBacking({
    chatUri: row.chat_uri,
    sdkSessionId: row.sdk_session_id,
    cwd: row.cwd,
    additionalDirectories,
    ...(row.model === null ? {} : { model: row.model }),
    ...(row.effort === null ? {} : { effort: row.effort }),
    permissionMode: row.permission_mode,
    lifecycle: row.lifecycle,
    ...(row.title === null ? {} : { title: row.title }),
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export const decodeChatBacking = decodeChatBackingRow;

export function isChatBackingRow(value: unknown): value is ChatBackingRow {
  return tryValidateChatBackingRow(value) !== undefined;
}

export function validateChatBackingRow(value: unknown): ChatBackingRow {
  const validated = tryValidateChatBackingRow(value);
  if (validated === undefined) {
    throw new TypeError('invalid chat backing row');
  }
  return validated;
}

function tryValidateChatBackingRow(value: unknown): ChatBackingRow | undefined {
  if (!isRecord(value)
    || !hasExactKeys(value, CHAT_BACKING_COLUMNS)
    || typeof value.chat_uri !== 'string'
    || value.chat_uri.length === 0
    || typeof value.sdk_session_id !== 'string'
    || value.sdk_session_id.length === 0
    || typeof value.cwd !== 'string'
    || value.cwd.length === 0
    || typeof value.additional_directories_json !== 'string'
    || typeof value.model !== 'string' && value.model !== null
    || typeof value.effort !== 'string' && value.effort !== null
    || typeof value.permission_mode !== 'string'
    || value.permission_mode.length === 0
    || !isLifecycle(value.lifecycle)
    || typeof value.title !== 'string' && value.title !== null
    || !isBooleanFlag(value.archived)
    || typeof value.created_at !== 'string'
    || value.created_at.length === 0
    || typeof value.updated_at !== 'string'
    || value.updated_at.length === 0) {
    return undefined;
  }

  return Object.freeze({
    chat_uri: value.chat_uri,
    sdk_session_id: value.sdk_session_id,
    cwd: value.cwd,
    additional_directories_json: value.additional_directories_json,
    model: value.model,
    effort: value.effort,
    permission_mode: value.permission_mode,
    lifecycle: value.lifecycle,
    title: value.title,
    archived: value.archived,
    created_at: value.created_at,
    updated_at: value.updated_at,
  });
}

export function encodeCommandReceiptRow(value: PersistedCommandReceipt): CommandReceiptRow {
  if (!isRecord(value)) {
    throw new TypeError('command receipt must be an object');
  }
  const clientId = nonEmptyString(value.clientId, 'clientId');
  const commandId = nonEmptyString(value.commandId, 'commandId');
  const chatUri = optionalString(value.chatUri, 'chatUri');
  const clientSeq = optionalSafeInteger(value.clientSeq, 'clientSeq');
  const createdAt = nonEmptyString(value.createdAt, 'createdAt');
  const receipt = validateCommandReceiptPayload(value.receipt);

  return Object.freeze({
    client_id: clientId,
    command_id: commandId,
    chat_uri: chatUri,
    client_seq: clientSeq,
    receipt_json: encodeJson(receipt, 'receipt'),
    created_at: createdAt,
  });
}

export const encodeCommandReceipt = encodeCommandReceiptRow;

export function decodeCommandReceiptRow(value: unknown): PersistedCommandReceipt {
  const row = validateCommandReceiptRow(value);
  const decoded = decodeJson(row.receipt_json, 'receipt');
  const receipt = validateCommandReceiptPayload(decoded);
  return freezePersistedCommandReceipt({
    clientId: row.client_id,
    commandId: row.command_id,
    ...(row.chat_uri === null ? {} : { chatUri: row.chat_uri }),
    ...(row.client_seq === null ? {} : { clientSeq: row.client_seq }),
    receipt,
    createdAt: row.created_at,
  });
}

export const decodeCommandReceipt = decodeCommandReceiptRow;

export function isCommandReceiptRow(value: unknown): value is CommandReceiptRow {
  return tryValidateCommandReceiptRow(value) !== undefined;
}

export function validateCommandReceiptRow(value: unknown): CommandReceiptRow {
  const validated = tryValidateCommandReceiptRow(value);
  if (validated === undefined) {
    throw new TypeError('invalid command receipt row');
  }
  return validated;
}

function tryValidateCommandReceiptRow(value: unknown): CommandReceiptRow | undefined {
  if (!isRecord(value)
    || !hasExactKeys(value, COMMAND_RECEIPT_COLUMNS)
    || typeof value.client_id !== 'string'
    || value.client_id.length === 0
    || typeof value.command_id !== 'string'
    || value.command_id.length === 0
    || typeof value.chat_uri !== 'string' && value.chat_uri !== null
    || !isNullableSafeInteger(value.client_seq)
    || typeof value.receipt_json !== 'string'
    || value.receipt_json.length === 0
    || typeof value.created_at !== 'string'
    || value.created_at.length === 0) {
    return undefined;
  }

  return Object.freeze({
    client_id: value.client_id,
    command_id: value.command_id,
    chat_uri: value.chat_uri,
    client_seq: value.client_seq,
    receipt_json: value.receipt_json,
    created_at: value.created_at,
  });
}

export function encodeApprovalAuditRow(value: ApprovalAuditEntry): ApprovalAuditRow {
  if (!isRecord(value)) {
    throw new TypeError('approval audit entry must be an object');
  }
  const auditId = nonEmptyString(value.auditId, 'auditId');
  const chatUri = nonEmptyString(value.chatUri, 'chatUri');
  const approvalId = nonEmptyString(value.approvalId, 'approvalId');
  const turnId = nonEmptyString(value.turnId, 'turnId');
  const status = validateApprovalAuditStatus(value.status);
  const decision = optionalDecision(value.decision);
  const decisionClassification = optionalDecisionClassification(value.decisionClassification);
  const clientId = optionalString(value.clientId, 'clientId');
  const commandId = optionalString(value.commandId, 'commandId');
  const requestedAt = optionalString(value.requestedAt, 'requestedAt');
  const occurredAt = nonEmptyString(value.occurredAt, 'occurredAt');

  return Object.freeze({
    audit_id: auditId,
    chat_uri: chatUri,
    approval_id: approvalId,
    turn_id: turnId,
    status,
    decision,
    decision_classification: decisionClassification,
    client_id: clientId,
    command_id: commandId,
    requested_at: requestedAt,
    occurred_at: occurredAt,
  });
}

export const encodeApprovalAudit = encodeApprovalAuditRow;

export function decodeApprovalAuditRow(value: unknown): ApprovalAuditEntry {
  const row = validateApprovalAuditRow(value);
  return freezeApprovalAuditEntry({
    auditId: row.audit_id,
    chatUri: row.chat_uri,
    approvalId: row.approval_id,
    turnId: row.turn_id,
    status: row.status,
    ...(row.decision === null ? {} : { decision: row.decision }),
    ...(row.decision_classification === null ? {} : { decisionClassification: row.decision_classification }),
    ...(row.client_id === null ? {} : { clientId: row.client_id }),
    ...(row.command_id === null ? {} : { commandId: row.command_id }),
    ...(row.requested_at === null ? {} : { requestedAt: row.requested_at }),
    occurredAt: row.occurred_at,
  });
}

export const decodeApprovalAudit = decodeApprovalAuditRow;

export function isApprovalAuditRow(value: unknown): value is ApprovalAuditRow {
  return tryValidateApprovalAuditRow(value) !== undefined;
}

export function validateApprovalAuditRow(value: unknown): ApprovalAuditRow {
  const validated = tryValidateApprovalAuditRow(value);
  if (validated === undefined) {
    throw new TypeError('invalid approval audit row');
  }
  return validated;
}

function tryValidateApprovalAuditRow(value: unknown): ApprovalAuditRow | undefined {
  if (!isRecord(value)
    || !hasExactKeys(value, APPROVAL_AUDIT_COLUMNS)
    || typeof value.audit_id !== 'string'
    || value.audit_id.length === 0
    || typeof value.chat_uri !== 'string'
    || value.chat_uri.length === 0
    || typeof value.approval_id !== 'string'
    || value.approval_id.length === 0
    || typeof value.turn_id !== 'string'
    || value.turn_id.length === 0
    || !isApprovalAuditStatus(value.status)
    || !isNullableDecision(value.decision)
    || !isNullableDecisionClassification(value.decision_classification)
    || !isNullableNonEmptyString(value.client_id)
    || !isNullableNonEmptyString(value.command_id)
    || !isNullableNonEmptyString(value.requested_at)
    || typeof value.occurred_at !== 'string'
    || value.occurred_at.length === 0) {
    return undefined;
  }

  if (value.status === 'requested' && (value.decision !== null || value.decision_classification !== null)) {
    return undefined;
  }
  if (value.status === 'resolved' && value.decision === null) {
    return undefined;
  }
  if ((value.client_id === null) !== (value.command_id === null)) {
    return undefined;
  }

  return Object.freeze({
    audit_id: value.audit_id,
    chat_uri: value.chat_uri,
    approval_id: value.approval_id,
    turn_id: value.turn_id,
    status: value.status,
    decision: value.decision,
    decision_classification: value.decision_classification,
    client_id: value.client_id,
    command_id: value.command_id,
    requested_at: value.requested_at,
    occurred_at: value.occurred_at,
  });
}

export function encodeJson<T extends JsonValue>(value: T, field = 'value'): string {
  if (!isJsonValue(value)) {
    throw new TypeError(`${field} must be JSON-safe`);
  }
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new TypeError(`${field} could not be encoded as JSON`);
    }
    return encoded;
  } catch (error) {
    if (error instanceof TypeError) {
      throw error;
    }
    throw new TypeError(`${field} could not be encoded as JSON`);
  }
}

export function decodeJson(value: string, field = 'value'): JsonValue {
  if (typeof value !== 'string') {
    throw new TypeError(`${field} must be a JSON string`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new TypeError(`${field} must contain valid JSON`);
  }
  if (!isJsonValue(parsed)) {
    throw new TypeError(`${field} must contain a JSON-safe value`);
  }
  return cloneJsonValue(parsed);
}

export function isCommandReceiptPayload(value: unknown): value is CommandReceiptPayload {
  try {
    validateCommandReceiptPayload(value);
    return true;
  } catch {
    return false;
  }
}

export function validateCommandReceiptPayload(value: unknown): CommandReceiptPayload {
  if (!isJsonObject(value) || typeof value.status !== 'string') {
    throw new TypeError('receipt must be a JSON object with a status');
  }
  if (value.status === 'accepted') {
    if (!hasExactKeys(value, ['status', 'value']) || !Object.hasOwn(value, 'value') || !isJsonValue(value.value)) {
      throw new TypeError('accepted receipt must contain a JSON-safe value');
    }
    return Object.freeze({ status: 'accepted', value: cloneJsonValue(value.value) });
  }
  if (value.status === 'rejected') {
    if (!hasExactKeys(value, ['status', 'code', 'message'])
      || typeof value.code !== 'string'
      || value.code.trim().length === 0
      || typeof value.message !== 'string'
      || value.message.trim().length === 0) {
      throw new TypeError('rejected receipt must contain code and message');
    }
    return Object.freeze({ status: 'rejected', code: value.code, message: value.message });
  }
  throw new TypeError('receipt.status must be accepted or rejected');
}

/**
 * Apply all missing migrations in one database transaction. The migration
 * selection itself remains pure; this shell only coordinates the port.
 */
export async function migratePersistenceSchema(
  port: SqlitePort,
  options: {
    readonly now?: () => string;
    readonly migrations?: readonly PersistenceMigration[];
  } = {},
): Promise<number> {
  const migrations = options.migrations ?? PERSISTENCE_MIGRATIONS;
  const now = options.now ?? (() => new Date().toISOString());
  validateMigrations(migrations);

  return await port.transaction(async (transaction) => {
    await transaction.exec(CREATE_SCHEMA_MIGRATIONS_TABLE);
    const rows = await transaction.all<SchemaMigrationRow>(SQL.selectAppliedMigrations, []);
    const applied = rows
      .map((row) => validateSchemaMigrationRow(row).version);
    const pending = selectPendingMigrations(applied, migrations);
    for (const migration of pending) {
      for (const statement of migration.statements) {
        await transaction.exec(statement);
      }
      await transaction.run(SQL.insertMigration, [migration.version, migration.name, nonEmptyString(now(), 'appliedAt')]);
    }
    return latestMigrationVersion(migrations);
  });
}

export const migrate = migratePersistenceSchema;
export const applyMigrations = migratePersistenceSchema;

/**
 * Wrap a synchronous SQLite implementation without importing `node:sqlite`.
 * The wrapper owns BEGIN/COMMIT/ROLLBACK and still exposes parameter arrays to
 * the store. It is intentionally structural so it can also wrap test doubles.
 */
export function createSqlitePort(database: SqliteDatabaseLike): SqlitePort {
  return {
    exec(sql) {
      database.exec(sql);
    },
    run(sql, parameters) {
      return database.prepare(sql).run(...parameters);
    },
    get<Row extends object = Record<string, unknown>>(sql: string, parameters: SqliteParameters) {
      return database.prepare(sql).get(...parameters) as Row | undefined;
    },
    all<Row extends object = Record<string, unknown>>(sql: string, parameters: SqliteParameters) {
      return database.prepare(sql).all(...parameters) as readonly Row[];
    },
    async transaction<Result>(work: (transaction: SqlitePort) => Result | PromiseLike<Result>) {
      database.exec('BEGIN');
      try {
        const result = await work(createSqlitePort(database));
        database.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          database.exec('ROLLBACK');
        } catch {
          // Preserve the original transaction error.
        }
        throw error;
      }
    },
    close() {
      database.close?.();
    },
  };
}

export const createSqliteStorageAdapter = createSqlitePort;

function normalizeAppliedVersions(
  applied: AppliedMigrationVersionInput,
  migrations: readonly PersistenceMigration[],
): ReadonlySet<number> {
  const max = latestMigrationVersion(migrations);
  const values = typeof applied === 'number'
    ? Array.from({ length: applied }, (_unused, index) => index + 1)
    : [...applied];

  const result = new Set<number>();
  for (const version of values) {
    if (!isSafeInteger(version) || version < 0 || version > max) {
      throw new RangeError(`invalid applied migration version: ${String(version)}`);
    }
    if (version > 0) {
      result.add(version);
    }
  }
  return result;
}

function validateMigrations(migrations: readonly PersistenceMigration[]): readonly PersistenceMigration[] {
  if (!Array.isArray(migrations)) {
    throw new TypeError('migrations must be an array');
  }
  let previous = 0;
  const normalized: PersistenceMigration[] = [];
  for (const migration of migrations) {
    if (!isRecord(migration)
      || !isSafeInteger(migration.version)
      || migration.version <= 0
      || migration.version <= previous
      || typeof migration.name !== 'string'
      || migration.name.length === 0
      || !Array.isArray(migration.statements)
      || migration.statements.length === 0
      || !migration.statements.every((statement) => typeof statement === 'string' && statement.length > 0)) {
      throw new TypeError('migrations must have strictly increasing versions and static statements');
    }
    previous = migration.version;
    normalized.push(Object.freeze({
      version: migration.version,
      name: migration.name,
      statements: Object.freeze([...migration.statements]),
    }));
  }
  return Object.freeze(normalized);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isNullableSafeInteger(value: unknown): value is number | null {
  return value === null || isSafeInteger(value);
}

function isBooleanFlag(value: unknown): value is 0 | 1 {
  return value === 0 || value === 1;
}

function encodeBoolean(value: unknown, field: string): 0 | 1 {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${field} must be a boolean`);
  }
  return value ? 1 : 0;
}

function isLifecycle(value: unknown): value is 'provisional' | 'materialized' {
  return value === 'provisional' || value === 'materialized';
}

function validateLifecycle(value: unknown): 'provisional' | 'materialized' {
  if (!isLifecycle(value)) {
    throw new TypeError('lifecycle must be provisional or materialized');
  }
  return value;
}

function validateStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array`);
  }
  if (!value.every((item) => typeof item === 'string' && item.trim().length > 0)) {
    throw new TypeError(`${field} must contain non-empty strings`);
  }
  return Object.freeze([...value]);
}

function decodeStringArray(value: string, field: string): readonly string[] {
  const decoded = decodeJson(value, field);
  return validateStringArray(decoded, field);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return nonEmptyString(value, field);
}

function optionalSafeInteger(value: unknown, field: string): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function isNullableNonEmptyString(value: unknown): value is string | null {
  return value === null || typeof value === 'string' && value.length > 0;
}

function validateApprovalAuditStatus(value: unknown): ApprovalAuditStatus {
  if (!isApprovalAuditStatus(value)) {
    throw new TypeError('invalid approval audit status');
  }
  return value;
}

function isApprovalAuditStatus(value: unknown): value is ApprovalAuditStatus {
  return value === 'requested'
    || value === 'resolved'
    || value === 'expired'
    || value === 'interrupted'
    || value === 'cancelled';
}

function optionalDecision(value: unknown): 'allow' | 'deny' | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (value !== 'allow' && value !== 'deny') {
    throw new TypeError('decision must be allow or deny');
  }
  return value;
}

function isNullableDecision(value: unknown): value is 'allow' | 'deny' | null {
  return value === null || value === 'allow' || value === 'deny';
}

function optionalDecisionClassification(value: unknown):
  'user_temporary' | 'user_permanent' | 'user_reject' | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (value !== 'user_temporary' && value !== 'user_permanent' && value !== 'user_reject') {
    throw new TypeError('invalid decision classification');
  }
  return value;
}

function isNullableDecisionClassification(value: unknown):
  value is 'user_temporary' | 'user_permanent' | 'user_reject' | null {
  return value === null
    || value === 'user_temporary'
    || value === 'user_permanent'
    || value === 'user_reject';
}

// Keep these aliases available to implementations that use the port's value
// vocabulary when building SQL arguments in their own adapters.
export type {
  SqliteParameters,
  SqlitePort,
  SqliteRunResult,
  SqliteValue,
  SqliteStatementLike,
};
