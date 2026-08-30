import type { PermissionDecisionClassification } from '@anthropic-ai/claude-agent-sdk';

import type { ChatBacking } from '../claude/chatBacking.js';
import type { CommandReceipt } from '../chat/commandDeduper.js';
import {
  APPROVAL_AUDIT_TABLE,
  CHAT_BACKINGS_TABLE,
  COMMAND_RECEIPTS_TABLE,
  SQL,
} from './schema.js';
import { PersistenceStore } from './store.js';
import type {
  ApprovalAuditEntry,
  ApprovalAuditRow,
  ApprovalAuditStatus,
  ChatBackingRow,
  CommandReceiptRow,
  JsonValue,
  PersistedChatBacking,
  PersistedCommandReceipt,
  PersistenceStoreOptions,
  SqlitePort,
} from './types.js';

/** Provider-neutral backing shape exposed alongside the repository API. */
export type { PersistedChatBacking } from './types.js';

/** Stable table names. Migrations and adapters should use these names. */
export const OVERLAY_TABLES = Object.freeze({
  chatBackings: CHAT_BACKINGS_TABLE,
  commandReceipts: COMMAND_RECEIPTS_TABLE,
  approvalAudit: APPROVAL_AUDIT_TABLE,
} as const);

export type OverlayTableName = (typeof OVERLAY_TABLES)[keyof typeof OVERLAY_TABLES];

/** A write input may omit timestamps when the repository clock is configured. */
export type ChatBackingWriteInput = Omit<
  PersistedChatBacking,
  'createdAt' | 'updatedAt' | 'archived'
> & {
  readonly archived?: boolean;
  readonly createdAt?: string;
  readonly updatedAt?: string;
};

/** A domain backing can be persisted without making the domain depend on SQLite. */
export interface DomainChatBackingWriteInput {
  readonly backing: ChatBacking;
  readonly title?: string;
  readonly archived?: boolean;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export type SaveChatBackingInput = ChatBackingWriteInput | DomainChatBackingWriteInput;

export interface ChatBackingPatch {
  readonly sdkSessionId?: string;
  readonly cwd?: string;
  readonly additionalDirectories?: readonly string[];
  readonly model?: string;
  readonly effort?: string;
  readonly permissionMode?: string;
  readonly lifecycle?: 'provisional' | 'materialized';
  readonly title?: string;
  readonly archived?: boolean;
  readonly updatedAt?: string;
}

export type CommandReceiptPayload = PersistedCommandReceipt['receipt'];

/** A write input may use the injected clock for `createdAt`. */
export type CommandReceiptWriteInput = Omit<PersistedCommandReceipt, 'createdAt'> & {
  readonly createdAt?: string;
};

/** Optional filters are applied inside one parameterized SQL query. */
export interface ApprovalAuditFilter {
  readonly chatUri?: string;
  readonly approvalId?: string;
  readonly status?: ApprovalAuditStatus;
}

export class OverlayValidationError extends TypeError {
  public readonly field: string;

  public constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = 'OverlayValidationError';
    this.field = field;
  }
}

export class OverlayConflictError extends Error {
  public readonly key: string;

  public constructor(key: string) {
    super(`persisted overlay conflicts with an existing record: ${key}`);
    this.name = 'OverlayConflictError';
    this.key = key;
  }
}

/**
 * Encode a provider-neutral backing into the exact SQLite row shape.
 *
 * This function is pure. It intentionally has no transcript, action, or SDK
 * message fields; only the product overlay is represented.
 */
export function encodeChatBackingRow(input: PersistedChatBacking): ChatBackingRow {
  const backing = normalizePersistedChatBacking(input);
  return Object.freeze({
    chat_uri: backing.chatUri,
    sdk_session_id: backing.sdkSessionId,
    cwd: backing.cwd,
    additional_directories_json: encodeJsonArray(backing.additionalDirectories, 'additionalDirectories'),
    model: backing.model ?? null,
    effort: backing.effort ?? null,
    permission_mode: backing.permissionMode,
    lifecycle: backing.lifecycle,
    title: backing.title ?? null,
    archived: backing.archived ? 1 : 0,
    created_at: backing.createdAt,
    updated_at: backing.updatedAt,
  });
}

/** Decode and strictly validate one backing row returned by the storage port. */
export function decodeChatBackingRow(row: unknown): PersistedChatBacking {
  const value = expectExactRecord(row, CHAT_BACKING_COLUMNS, 'chat backing row');
  const archived = decodeArchived(value.archived, 'archived');
  const directories = decodeJsonArray(value.additional_directories_json, 'additionalDirectories');
  const model = nullableNonEmptyString(value.model, 'model');
  const effort = nullableNonEmptyString(value.effort, 'effort');
  const title = nullableNonEmptyString(value.title, 'title');
  return freezePersistedChatBackingValue({
    chatUri: nonEmptyString(value.chat_uri, 'chatUri'),
    sdkSessionId: nonEmptyString(value.sdk_session_id, 'sdkSessionId'),
    cwd: nonEmptyString(value.cwd, 'cwd'),
    additionalDirectories: directories.map((directory, index) =>
      nonEmptyString(directory, `additionalDirectories[${String(index)}]`)),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    permissionMode: nonEmptyString(value.permission_mode, 'permissionMode'),
    lifecycle: decodeLifecycle(value.lifecycle),
    ...(title === undefined ? {} : { title }),
    archived,
    createdAt: nonEmptyString(value.created_at, 'createdAt'),
    updatedAt: nonEmptyString(value.updated_at, 'updatedAt'),
  });
}

/** Alias retained for callers that name the codec after the overlay. */
export const encodeChatOverlayRow = encodeChatBackingRow;
export const decodeChatOverlayRow = decodeChatBackingRow;

/** Encode a JSON-safe command receipt without accepting arbitrary SDK values. */
export function encodeCommandReceiptRow(input: PersistedCommandReceipt): CommandReceiptRow {
  const receipt = normalizePersistedCommandReceipt(input);
  return Object.freeze({
    client_id: receipt.clientId,
    command_id: receipt.commandId,
    chat_uri: receipt.chatUri ?? null,
    client_seq: receipt.clientSeq ?? null,
    receipt_json: encodeReceipt(receipt.receipt),
    created_at: receipt.createdAt,
  });
}

/** Decode one receipt row and clone/freeze the receipt payload. */
export function decodeCommandReceiptRow(row: unknown): PersistedCommandReceipt {
  const value = expectExactRecord(row, COMMAND_RECEIPT_COLUMNS, 'command receipt row');
  const chatUri = nullableNonEmptyString(value.chat_uri, 'chatUri');
  const clientSeq = decodeOptionalNonNegativeInteger(value.client_seq, 'clientSeq');
  return freezePersistedCommandReceiptValue({
    clientId: nonEmptyString(value.client_id, 'clientId'),
    commandId: nonEmptyString(value.command_id, 'commandId'),
    ...(chatUri === undefined ? {} : { chatUri }),
    ...(clientSeq === undefined ? {} : { clientSeq }),
    receipt: decodeReceipt(value.receipt_json),
    createdAt: nonEmptyString(value.created_at, 'createdAt'),
  });
}

/** Aliases retained for storage-oriented callers. */
export const encodeReceiptRow = encodeCommandReceiptRow;
export const decodeReceiptRow = decodeCommandReceiptRow;

/**
 * Encode an append-only, content-free approval audit entry.
 * Tool input/output, token text, and action bodies cannot enter this row.
 */
export function encodeApprovalAuditRow(input: ApprovalAuditEntry): ApprovalAuditRow {
  const entry = normalizeApprovalAuditEntry(input);
  return Object.freeze({
    audit_id: entry.auditId,
    chat_uri: entry.chatUri,
    approval_id: entry.approvalId,
    turn_id: entry.turnId,
    status: entry.status,
    decision: entry.decision ?? null,
    decision_classification: entry.decisionClassification ?? null,
    client_id: entry.clientId ?? null,
    command_id: entry.commandId ?? null,
    requested_at: entry.requestedAt ?? null,
    occurred_at: entry.occurredAt,
  });
}

/** Decode one approval audit row; no SDK prompt body is reconstructed. */
export function decodeApprovalAuditRow(row: unknown): ApprovalAuditEntry {
  const value = expectExactRecord(row, APPROVAL_AUDIT_COLUMNS, 'approval audit row');
  const decision = decodeDecision(value.decision, 'decision');
  const classification = decodeDecisionClassification(
    value.decision_classification,
    'decisionClassification',
  );
  const clientId = nullableNonEmptyString(value.client_id, 'clientId');
  const commandId = nullableNonEmptyString(value.command_id, 'commandId');
  const requestedAt = nullableNonEmptyString(value.requested_at, 'requestedAt');
  if ((clientId === undefined) !== (commandId === undefined)) {
    throw new OverlayValidationError('approval audit row', 'clientId and commandId must be paired');
  }

  return freezeApprovalAuditEntryValue({
    auditId: nonEmptyString(value.audit_id, 'auditId'),
    chatUri: nonEmptyString(value.chat_uri, 'chatUri'),
    approvalId: nonEmptyString(value.approval_id, 'approvalId'),
    turnId: nonEmptyString(value.turn_id, 'turnId'),
    status: decodeApprovalStatus(value.status),
    ...(decision === undefined ? {} : { decision }),
    ...(classification === undefined ? {} : { decisionClassification: classification }),
    ...(clientId === undefined ? {} : { clientId }),
    ...(commandId === undefined ? {} : { commandId }),
    ...(requestedAt === undefined ? {} : { requestedAt }),
    occurredAt: nonEmptyString(value.occurred_at, 'occurredAt'),
  });
}

/** Alias using the singular audit terminology used by the row type. */
export const encodeApprovalAuditEntryRow = encodeApprovalAuditRow;
export const decodeApprovalAuditEntryRow = decodeApprovalAuditRow;

/** Convert a domain ChatBacking into a persistence overlay without SQLite knowledge. */
export function toPersistedChatBacking(
  input: DomainChatBackingWriteInput,
  now?: () => string,
): PersistedChatBacking {
  if (!isRecord(input) || !isRecord(input.backing)) {
    throw new OverlayValidationError('backing', 'must be a domain ChatBacking object');
  }
  const timestamp = resolveTimestampPair(input.createdAt, input.updatedAt, now);
  const backing = input.backing;
  return normalizePersistedChatBacking({
    chatUri: backing.chatUri,
    sdkSessionId: backing.sdkSessionId,
    cwd: backing.cwd,
    additionalDirectories: [...backing.additionalDirectories],
    ...(backing.desiredConfig.model === undefined ? {} : { model: backing.desiredConfig.model }),
    ...(backing.desiredConfig.effort === undefined ? {} : { effort: backing.desiredConfig.effort }),
    permissionMode: backing.desiredConfig.permissionMode,
    lifecycle: backing.lifecycle,
    ...(input.title === undefined ? {} : { title: input.title }),
    archived: input.archived ?? false,
    createdAt: timestamp.createdAt,
    updatedAt: timestamp.updatedAt,
  });
}

/**
 * Repository over the storage port. The repository owns no mutable cache:
 * every read is decoded from the current transaction, making restart behavior
 * explicit and keeping SQLite out of `src/domain`.
 */
export class OverlayRepository {
  private readonly store: PersistenceStore;
  private readonly now: (() => string) | undefined;

  public constructor(storage: SqlitePort | PersistenceStore, options?: PersistenceStoreOptions);
  public constructor(options: { readonly storage: SqlitePort | PersistenceStore } & PersistenceStoreOptions);
  public constructor(
    storageOrOptions: SqlitePort | PersistenceStore | ({ readonly storage: SqlitePort | PersistenceStore } & PersistenceStoreOptions),
    options: PersistenceStoreOptions = {},
  ) {
    const candidate = isRecord(storageOrOptions) && 'storage' in storageOrOptions
      ? storageOrOptions.storage
      : storageOrOptions;
    if (!isSqlitePort(candidate) && !isPersistenceStore(candidate)) {
      throw new TypeError('OverlayRepository requires a PersistenceStore or SqlitePort');
    }
    this.store = isPersistenceStore(candidate)
      ? candidate
      : new PersistenceStore(candidate, options);
    this.now = isRecord(storageOrOptions) && 'storage' in storageOrOptions
      ? optionalClock(storageOrOptions.now) ?? defaultClock
      : optionalClock(options.now) ?? defaultClock;
  }

  /** Save or create one backing. The result is visible only after commit. */
  public async saveChatBacking(input: SaveChatBackingInput): Promise<PersistedChatBacking> {
    const backing = isDomainInput(input)
      ? toPersistedChatBacking(input, this.now)
      : normalizeChatBackingWriteInput(input, this.now);
    await this.inTransaction((transaction) => transaction.putChatBacking(backing));
    return backing;
  }

  /** Common aliases for host composition code. */
  public putChatBacking(input: SaveChatBackingInput): Promise<PersistedChatBacking> {
    return this.saveChatBacking(input);
  }

  public saveChatOverlay(input: SaveChatBackingInput): Promise<PersistedChatBacking> {
    return this.saveChatBacking(input);
  }

  public async getChatBacking(chatUri: string): Promise<PersistedChatBacking | undefined> {
    const key = nonEmptyString(chatUri, 'chatUri');
    return this.inTransaction((transaction) => transaction.getChatBacking(key));
  }

  public loadChatBacking(chatUri: string): Promise<PersistedChatBacking | undefined> {
    return this.getChatBacking(chatUri);
  }

  public getChatOverlay(chatUri: string): Promise<PersistedChatBacking | undefined> {
    return this.getChatBacking(chatUri);
  }

  public async listChatBackings(): Promise<readonly PersistedChatBacking[]> {
    return this.inTransaction((transaction) => transaction.listChatBackings());
  }

  public listChatOverlays(): Promise<readonly PersistedChatBacking[]> {
    return this.listChatBackings();
  }

  /** Update one backing atomically; an absent chat returns `undefined`. */
  public async updateChatBacking(
    chatUri: string,
    patch: ChatBackingPatch,
  ): Promise<PersistedChatBacking | undefined> {
    const key = nonEmptyString(chatUri, 'chatUri');
    if (!isRecord(patch)) {
      throw new OverlayValidationError('patch', 'must be an object');
    }
    return this.inTransaction(async (transaction) => {
      const current = await transaction.getChatBacking(key);
      if (current === undefined) {
        return undefined;
      }
      const updated = normalizePersistedChatBacking({
        ...current,
        ...(patch.sdkSessionId === undefined ? {} : { sdkSessionId: patch.sdkSessionId }),
        ...(patch.cwd === undefined ? {} : { cwd: patch.cwd }),
        ...(patch.additionalDirectories === undefined
          ? {}
          : { additionalDirectories: [...patch.additionalDirectories] }),
        ...(patch.model === undefined ? {} : { model: patch.model }),
        ...(patch.effort === undefined ? {} : { effort: patch.effort }),
        ...(patch.permissionMode === undefined ? {} : { permissionMode: patch.permissionMode }),
        ...(patch.lifecycle === undefined ? {} : { lifecycle: patch.lifecycle }),
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.archived === undefined ? {} : { archived: patch.archived }),
        updatedAt: patch.updatedAt ?? this.timestamp(),
      });
      await transaction.putChatBacking(updated);
      return updated;
    });
  }

  public updateChatConfig(
    chatUri: string,
    config: Pick<PersistedChatBacking, 'permissionMode'> & Partial<Pick<PersistedChatBacking, 'model' | 'effort'>>,
  ): Promise<PersistedChatBacking | undefined> {
    return this.updateChatBacking(chatUri, {
      ...(config.model === undefined ? {} : { model: config.model }),
      ...(config.effort === undefined ? {} : { effort: config.effort }),
      permissionMode: config.permissionMode,
    });
  }

  public updateChatMetadata(
    chatUri: string,
    patch: Pick<ChatBackingPatch, 'title' | 'archived' | 'updatedAt'>,
  ): Promise<PersistedChatBacking | undefined> {
    return this.updateChatBacking(chatUri, patch);
  }

  public async deleteChatBacking(chatUri: string): Promise<boolean> {
    const key = nonEmptyString(chatUri, 'chatUri');
    return this.inTransaction((transaction) => transaction.deleteChatBacking(key));
  }

  public deleteChat(chatUri: string): Promise<boolean> {
    return this.deleteChatBacking(chatUri);
  }

  /**
   * Persist one command receipt exactly once for `(clientId, commandId)`.
   * A retry with the same canonical receipt is idempotent; a differing retry
   * fails in the transaction and never overwrites the original effect record.
   */
  public async saveCommandReceipt(
    input: CommandReceiptWriteInput,
  ): Promise<PersistedCommandReceipt> {
    const receipt = normalizeCommandReceiptWriteInput(input, this.now);
    return this.inTransaction(async (transaction) => {
      const existing = await transaction.getCommandReceipt(receipt.clientId, receipt.commandId);
      if (existing !== undefined) {
        if (!sameCommandReceipt(existing, receipt)) {
          throw new OverlayConflictError(commandReceiptKey(receipt.clientId, receipt.commandId));
        }
        return existing;
      }
      await transaction.putCommandReceipt(receipt);
      return receipt;
    });
  }

  public putCommandReceipt(input: CommandReceiptWriteInput): Promise<PersistedCommandReceipt> {
    return this.saveCommandReceipt(input);
  }

  public async getCommandReceipt(
    clientId: string,
    commandId: string,
  ): Promise<PersistedCommandReceipt | undefined> {
    const client = nonEmptyString(clientId, 'clientId');
    const command = nonEmptyString(commandId, 'commandId');
    return this.inTransaction((transaction) => transaction.getCommandReceipt(client, command));
  }

  public loadCommandReceipt(
    clientId: string,
    commandId: string,
  ): Promise<PersistedCommandReceipt | undefined> {
    return this.getCommandReceipt(clientId, commandId);
  }

  public async listCommandReceipts(chatUri?: string): Promise<readonly PersistedCommandReceipt[]> {
    const key = chatUri === undefined ? undefined : nonEmptyString(chatUri, 'chatUri');
    return this.inTransaction((transaction) => transaction.listCommandReceipts(key));
  }

  /** Append a content-free approval audit entry after a successful transaction. */
  public async appendApprovalAudit(input: ApprovalAuditEntry): Promise<ApprovalAuditEntry> {
    const entry = normalizeApprovalAuditEntry(input);
    return this.inTransaction(async (transaction) => {
      const existing = (await transaction.listApprovalAudit()).find(
        (candidate) => candidate.auditId === entry.auditId,
      );
      if (existing !== undefined) {
        if (!sameApprovalAudit(existing, entry)) {
          throw new OverlayConflictError(`approval-audit:${entry.auditId}`);
        }
        return existing;
      }
      await transaction.appendApprovalAudit(entry);
      return entry;
    });
  }

  public recordApprovalAudit(input: ApprovalAuditEntry): Promise<ApprovalAuditEntry> {
    return this.appendApprovalAudit(input);
  }

  public async getApprovalAudit(auditId: string): Promise<ApprovalAuditEntry | undefined> {
    const key = nonEmptyString(auditId, 'auditId');
    return this.inTransaction(async (transaction) => (await transaction.listApprovalAudit())
      .find((entry) => entry.auditId === key));
  }

  public async listApprovalAudit(
    filter: ApprovalAuditFilter = {},
  ): Promise<readonly ApprovalAuditEntry[]> {
    if (!isRecord(filter)) {
      throw new OverlayValidationError('filter', 'must be an object');
    }
    const normalized = normalizeApprovalAuditFilter(filter);
    return this.inTransaction(async (transaction) => {
      const entries = await transaction.listApprovalAudit(normalized.chatUri);
      return Object.freeze(entries.filter((entry) => (
        (normalized.approvalId === undefined || entry.approvalId === normalized.approvalId)
        && (normalized.status === undefined || entry.status === normalized.status)
      )));
    });
  }

  public listApprovalAudits(
    filter: ApprovalAuditFilter = {},
  ): Promise<readonly ApprovalAuditEntry[]> {
    return this.listApprovalAudit(filter);
  }

  /** Run a caller operation in the storage port's transaction boundary. */
  public async transaction<Result>(
    work: (storage: PersistenceStore) => Result | PromiseLike<Result>,
  ): Promise<Result> {
    if (typeof work !== 'function') {
      throw new TypeError('transaction work must be a function');
    }
    return this.store.transaction(work);
  }

  /** Close the underlying persistence store when the host is shutting down. */
  public close(): ReturnType<PersistenceStore['close']> {
    return this.store.close();
  }

  private timestamp(): string {
    const timestamp = this.now?.();
    return nonEmptyString(timestamp, 'now()');
  }

  private async inTransaction<Result>(
    work: (storage: PersistenceStore) => Result | PromiseLike<Result>,
  ): Promise<Result> {
    return this.store.transaction(work);
  }
}

/** SQL aliases retained for adapters that consume repository query constants. */
export const SELECT_CHAT_BACKING_SQL = SQL.selectChatBacking;
export const LIST_CHAT_BACKINGS_SQL = SQL.selectChatBackings;
export const UPSERT_CHAT_BACKING_SQL = SQL.upsertChatBacking;
export const UPDATE_CHAT_BACKING_SQL = SQL.upsertChatBacking;
export const DELETE_CHAT_BACKING_SQL = SQL.deleteChatBacking;
export const SELECT_COMMAND_RECEIPT_SQL = SQL.selectCommandReceipt;
export const LIST_COMMAND_RECEIPTS_SQL = SQL.selectCommandReceipts;
export const LIST_COMMAND_RECEIPTS_FOR_CHAT_SQL = SQL.selectCommandReceiptsForChat;
export const INSERT_COMMAND_RECEIPT_SQL = SQL.upsertCommandReceipt;
export const SELECT_APPROVAL_AUDIT_BY_ID_SQL = `
  SELECT audit_id, chat_uri, approval_id, turn_id, status, decision,
         decision_classification, client_id, command_id, requested_at, occurred_at
    FROM ${APPROVAL_AUDIT_TABLE}
   WHERE audit_id = ?
`;
export const INSERT_APPROVAL_AUDIT_SQL = SQL.insertApprovalAudit;

const CHAT_BACKING_COLUMNS = [
  'chat_uri', 'sdk_session_id', 'cwd', 'additional_directories_json',
  'model', 'effort', 'permission_mode', 'lifecycle', 'title', 'archived',
  'created_at', 'updated_at',
] as const;

const COMMAND_RECEIPT_COLUMNS = [
  'client_id', 'command_id', 'chat_uri', 'client_seq', 'receipt_json', 'created_at',
] as const;

const APPROVAL_AUDIT_COLUMNS = [
  'audit_id', 'chat_uri', 'approval_id', 'turn_id', 'status', 'decision',
  'decision_classification', 'client_id', 'command_id', 'requested_at', 'occurred_at',
] as const;

function normalizeChatBackingWriteInput(
  input: ChatBackingWriteInput,
  now?: () => string,
): PersistedChatBacking {
  if (!isRecord(input)) {
    throw new OverlayValidationError('chatBacking', 'must be an object');
  }
  const timestamp = resolveTimestampPair(input.createdAt, input.updatedAt, now);
  return normalizePersistedChatBacking({
    chatUri: input.chatUri,
    sdkSessionId: input.sdkSessionId,
    cwd: input.cwd,
    additionalDirectories: input.additionalDirectories,
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.effort === undefined ? {} : { effort: input.effort }),
    permissionMode: input.permissionMode,
    lifecycle: input.lifecycle,
    ...(input.title === undefined ? {} : { title: input.title }),
    archived: input.archived ?? false,
    createdAt: timestamp.createdAt,
    updatedAt: timestamp.updatedAt,
  });
}

function resolveTimestampPair(
  createdAt: string | undefined,
  updatedAt: string | undefined,
  now?: () => string,
): { readonly createdAt: string; readonly updatedAt: string } {
  const fallback = createdAt === undefined && updatedAt === undefined
    ? nonEmptyString(now?.(), 'createdAt/updatedAt')
    : undefined;
  const resolvedCreatedAt = nonEmptyString(createdAt ?? fallback, 'createdAt');
  const resolvedUpdatedAt = nonEmptyString(updatedAt ?? createdAt ?? fallback, 'updatedAt');
  return { createdAt: resolvedCreatedAt, updatedAt: resolvedUpdatedAt };
}

function normalizePersistedChatBacking(input: PersistedChatBacking): PersistedChatBacking {
  if (!isRecord(input)) {
    throw new OverlayValidationError('chatBacking', 'must be an object');
  }
  const additionalDirectories = input.additionalDirectories;
  if (!Array.isArray(additionalDirectories)) {
    throw new OverlayValidationError('additionalDirectories', 'must be an array');
  }
  const model = optionalNonEmptyString(input.model, 'model');
  const effort = optionalNonEmptyString(input.effort, 'effort');
  const title = optionalNonEmptyString(input.title, 'title');
  return freezePersistedChatBackingValue({
    chatUri: nonEmptyString(input.chatUri, 'chatUri'),
    sdkSessionId: nonEmptyString(input.sdkSessionId, 'sdkSessionId'),
    cwd: nonEmptyString(input.cwd, 'cwd'),
    additionalDirectories: additionalDirectories.map((directory, index) =>
      nonEmptyString(directory, `additionalDirectories[${String(index)}]`)),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    permissionMode: nonEmptyString(input.permissionMode, 'permissionMode'),
    lifecycle: decodeLifecycle(input.lifecycle),
    ...(title === undefined ? {} : { title }),
    archived: expectBoolean(input.archived, 'archived'),
    createdAt: nonEmptyString(input.createdAt, 'createdAt'),
    updatedAt: nonEmptyString(input.updatedAt, 'updatedAt'),
  });
}

function normalizeCommandReceiptWriteInput(
  input: CommandReceiptWriteInput,
  now?: () => string,
): PersistedCommandReceipt {
  if (!isRecord(input)) {
    throw new OverlayValidationError('commandReceipt', 'must be an object');
  }
  const createdAt = nonEmptyString(input.createdAt ?? now?.(), 'createdAt');
  const chatUri = optionalNonEmptyString(input.chatUri, 'chatUri');
  const clientSeq = input.clientSeq === undefined
    ? undefined
    : expectNonNegativeInteger(input.clientSeq, 'clientSeq');
  return normalizePersistedCommandReceipt({
    clientId: nonEmptyString(input.clientId, 'clientId'),
    commandId: nonEmptyString(input.commandId, 'commandId'),
    ...(chatUri === undefined ? {} : { chatUri }),
    ...(clientSeq === undefined ? {} : { clientSeq }),
    receipt: input.receipt,
    createdAt,
  });
}

function normalizePersistedCommandReceipt(input: PersistedCommandReceipt): PersistedCommandReceipt {
  if (!isRecord(input)) {
    throw new OverlayValidationError('commandReceipt', 'must be an object');
  }
  const chatUri = optionalNonEmptyString(input.chatUri, 'chatUri');
  const clientSeq = input.clientSeq === undefined
    ? undefined
    : expectNonNegativeInteger(input.clientSeq, 'clientSeq');
  const receipt = normalizeReceipt(input.receipt);
  return freezePersistedCommandReceiptValue({
    clientId: nonEmptyString(input.clientId, 'clientId'),
    commandId: nonEmptyString(input.commandId, 'commandId'),
    ...(chatUri === undefined ? {} : { chatUri }),
    ...(clientSeq === undefined ? {} : { clientSeq }),
    receipt,
    createdAt: nonEmptyString(input.createdAt, 'createdAt'),
  });
}

function normalizeReceipt(receipt: unknown): CommandReceiptPayload {
  if (!isRecord(receipt)) {
    throw new OverlayValidationError('receipt', 'must be an object');
  }
  const keys = Object.keys(receipt).sort();
  if (receipt.status === 'accepted') {
    expectKeys(keys, ['status', 'value'], 'accepted receipt');
    return Object.freeze({ status: 'accepted', value: strictCloneJson(receipt.value, 'receipt.value') });
  }
  if (receipt.status === 'rejected') {
    expectKeys(keys, ['code', 'message', 'status'], 'rejected receipt');
    return Object.freeze({
      status: 'rejected',
      code: nonEmptyString(receipt.code, 'receipt.code'),
      message: nonEmptyString(receipt.message, 'receipt.message'),
    });
  }
  throw new OverlayValidationError('receipt.status', 'must be accepted or rejected');
}

function decodeReceipt(raw: unknown): CommandReceiptPayload {
  const parsed = decodeJson(raw, 'receipt_json');
  return normalizeReceipt(parsed);
}

function encodeReceipt(receipt: CommandReceiptPayload): string {
  const normalized = normalizeReceipt(receipt);
  return encodeJson(normalized, 'receipt');
}

function normalizeApprovalAuditEntry(input: ApprovalAuditEntry): ApprovalAuditEntry {
  if (!isRecord(input)) {
    throw new OverlayValidationError('approvalAudit', 'must be an object');
  }
  const decision = optionalDecision(input.decision, 'decision');
  const classification = optionalDecisionClassification(
    input.decisionClassification,
    'decisionClassification',
  );
  const clientId = optionalNonEmptyString(input.clientId, 'clientId');
  const commandId = optionalNonEmptyString(input.commandId, 'commandId');
  if ((clientId === undefined) !== (commandId === undefined)) {
    throw new OverlayValidationError('approvalAudit', 'clientId and commandId must be paired');
  }
  const status = decodeApprovalStatus(input.status);
  if (status === 'requested' && (decision !== undefined || classification !== undefined)) {
    throw new OverlayValidationError('approvalAudit', 'requested entries cannot contain a decision');
  }
  if (status === 'resolved' && decision === undefined) {
    throw new OverlayValidationError('approvalAudit', 'resolved entries require a decision');
  }
  const requestedAt = input.requestedAt === undefined
    ? undefined
    : nonEmptyString(input.requestedAt, 'requestedAt');
  return freezeApprovalAuditEntryValue({
    auditId: nonEmptyString(input.auditId, 'auditId'),
    chatUri: nonEmptyString(input.chatUri, 'chatUri'),
    approvalId: nonEmptyString(input.approvalId, 'approvalId'),
    turnId: nonEmptyString(input.turnId, 'turnId'),
    status,
    ...(decision === undefined ? {} : { decision }),
    ...(classification === undefined ? {} : { decisionClassification: classification }),
    ...(clientId === undefined ? {} : { clientId }),
    ...(commandId === undefined ? {} : { commandId }),
    ...(requestedAt === undefined ? {} : { requestedAt }),
    occurredAt: nonEmptyString(input.occurredAt, 'occurredAt'),
  });
}

function normalizeApprovalAuditFilter(filter: ApprovalAuditFilter): ApprovalAuditFilter {
  return {
    ...(filter.chatUri === undefined ? {} : { chatUri: nonEmptyString(filter.chatUri, 'chatUri') }),
    ...(filter.approvalId === undefined
      ? {}
      : { approvalId: nonEmptyString(filter.approvalId, 'approvalId') }),
    ...(filter.status === undefined ? {} : { status: decodeApprovalStatus(filter.status) }),
  };
}

function sameCommandReceipt(
  left: PersistedCommandReceipt,
  right: PersistedCommandReceipt,
): boolean {
  return left.clientId === right.clientId
    && left.commandId === right.commandId
    && left.chatUri === right.chatUri
    && left.clientSeq === right.clientSeq
    && left.createdAt === right.createdAt
    && encodeReceipt(left.receipt) === encodeReceipt(right.receipt);
}

function sameApprovalAudit(left: ApprovalAuditEntry, right: ApprovalAuditEntry): boolean {
  return encodeJson(left, 'approvalAudit') === encodeJson(right, 'approvalAudit');
}

function commandReceiptKey(clientId: string, commandId: string): string {
  return `${clientId}\u0000${commandId}`;
}

function expectExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  field: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new OverlayValidationError(field, 'must be an object');
  }
  expectKeys(Object.keys(value).sort(), [...expectedKeys].sort(), field);
  return value;
}

function expectKeys(actual: readonly string[], expected: readonly string[], field: string): void {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (left.length !== right.length || left.some((key, index) => key !== right[index])) {
    throw new OverlayValidationError(field, 'contains an unexpected or missing field');
  }
}

function strictCloneJson(value: unknown, field: string, ancestors = new WeakSet<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (Number.isFinite(value)) {
      return value;
    }
    throw new OverlayValidationError(field, 'must contain only finite numbers');
  }
  if (typeof value !== 'object') {
    throw new OverlayValidationError(field, 'must be JSON-safe');
  }
  if (ancestors.has(value)) {
    throw new OverlayValidationError(field, 'must not contain cycles');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new OverlayValidationError(field, 'must contain only ordinary arrays');
      }
      const source = value as unknown[];
      const copy: JsonValue[] = [];
      for (let index = 0; index < source.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(source, String(index));
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
          throw new OverlayValidationError(field, 'must not contain sparse or accessor arrays');
        }
        copy.push(strictCloneJson(descriptor.value, `${field}[${String(index)}]`, ancestors));
      }
      for (const key of Reflect.ownKeys(source)) {
        if (typeof key === 'symbol' || (key !== 'length' && !isArrayIndex(key, source.length))) {
          throw new OverlayValidationError(field, 'may contain only indexed array properties');
        }
      }
      return Object.freeze(copy);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new OverlayValidationError(field, 'must contain only plain objects');
    }
    const source = value as Record<string, unknown>;
    const copy: Record<string, JsonValue> = {};
    for (const key of Reflect.ownKeys(source)) {
      if (typeof key !== 'string') {
        throw new OverlayValidationError(field, 'may contain only string keys');
      }
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new OverlayValidationError(field, 'may contain only enumerable data properties');
      }
      copy[key] = strictCloneJson(descriptor.value, `${field}.${key}`, ancestors);
    }
    return Object.freeze(copy);
  } finally {
    ancestors.delete(value);
  }
}

function encodeJson(value: unknown, field: string): string {
  const normalized = strictCloneJson(value, field);
  const encoded = JSON.stringify(normalized);
  if (encoded === undefined) {
    throw new OverlayValidationError(field, 'must be JSON-safe');
  }
  return encoded;
}

function decodeJson(value: unknown, field: string): JsonValue {
  if (typeof value !== 'string') {
    throw new OverlayValidationError(field, 'must be a JSON string');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new OverlayValidationError(field, 'contains invalid JSON');
  }
  return strictCloneJson(parsed, field);
}

function encodeJsonArray(value: readonly string[], field: string): string {
  return encodeJson(value, field);
}

function decodeJsonArray(value: unknown, field: string): readonly unknown[] {
  const decoded = decodeJson(value, field);
  if (!Array.isArray(decoded)) {
    throw new OverlayValidationError(field, 'must encode an array');
  }
  return decoded;
}

function isArrayIndex(value: string, length: number): boolean {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    return false;
  }
  const index = Number(value);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function isRecord(value: unknown): value is Record<string, any> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSqlitePort(value: unknown): value is SqlitePort {
  return isObjectLike(value)
    && typeof value.exec === 'function'
    && typeof value.run === 'function'
    && typeof value.get === 'function'
    && typeof value.all === 'function'
    && typeof value.transaction === 'function';
}

function isPersistenceStore(value: unknown): value is PersistenceStore {
  return isObjectLike(value)
    && typeof value.getChatBacking === 'function'
    && typeof value.listChatBackings === 'function'
    && typeof value.putChatBacking === 'function'
    && typeof value.deleteChatBacking === 'function'
    && typeof value.getCommandReceipt === 'function'
    && typeof value.listCommandReceipts === 'function'
    && typeof value.putCommandReceipt === 'function'
    && typeof value.listApprovalAudit === 'function'
    && typeof value.appendApprovalAudit === 'function'
    && typeof value.transaction === 'function';
}

function optionalClock(value: unknown): (() => string) | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'function') {
    throw new TypeError('now must be a function');
  }
  return value as () => string;
}

function isDomainInput(input: SaveChatBackingInput): input is DomainChatBackingWriteInput {
  return isRecord(input) && 'backing' in input;
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const defaultClock = (): string => new Date().toISOString();

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OverlayValidationError(field, 'must be a non-empty string');
  }
  return value;
}

function optionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return nonEmptyString(value, field);
}

function nullableNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === null) {
    return undefined;
  }
  return nonEmptyString(value, field);
}

function expectBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new OverlayValidationError(field, 'must be a boolean');
  }
  return value;
}

function decodeArchived(value: unknown, field: string): boolean {
  if (value === 0) {
    return false;
  }
  if (value === 1) {
    return true;
  }
  throw new OverlayValidationError(field, 'must be 0/1');
}

function expectNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new OverlayValidationError(field, 'must be a non-negative safe integer');
  }
  return value;
}

function decodeOptionalNonNegativeInteger(value: unknown, field: string): number | undefined {
  if (value === null) {
    return undefined;
  }
  return expectNonNegativeInteger(value, field);
}

function decodeLifecycle(value: unknown): 'provisional' | 'materialized' {
  if (value === 'provisional' || value === 'materialized') {
    return value;
  }
  throw new OverlayValidationError('lifecycle', 'must be provisional or materialized');
}

function decodeDecision(value: unknown, field: string): 'allow' | 'deny' | undefined {
  if (value === null) {
    return undefined;
  }
  return optionalDecision(value, field);
}

function optionalDecision(value: unknown, field: string): 'allow' | 'deny' | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value !== 'allow' && value !== 'deny') {
    throw new OverlayValidationError(field, 'must be allow or deny');
  }
  return value;
}

function decodeDecisionClassification(
  value: unknown,
  field: string,
): PermissionDecisionClassification | undefined {
  if (value === null) {
    return undefined;
  }
  return optionalDecisionClassification(value, field);
}

function optionalDecisionClassification(
  value: unknown,
  field: string,
): PermissionDecisionClassification | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value !== 'user_temporary' && value !== 'user_permanent' && value !== 'user_reject') {
    throw new OverlayValidationError(field, 'must be a supported permission classification');
  }
  return value;
}

function decodeApprovalStatus(value: unknown): ApprovalAuditStatus {
  if (
    value === 'requested'
    || value === 'resolved'
    || value === 'expired'
    || value === 'interrupted'
    || value === 'cancelled'
  ) {
    return value;
  }
  throw new OverlayValidationError('status', 'must be a supported approval audit status');
}

function freezePersistedChatBackingValue(value: PersistedChatBacking): PersistedChatBacking {
  return Object.freeze({
    ...value,
    additionalDirectories: Object.freeze([...value.additionalDirectories]),
  });
}

function freezePersistedCommandReceiptValue(value: PersistedCommandReceipt): PersistedCommandReceipt {
  return Object.freeze({
    ...value,
    receipt: normalizeReceipt(value.receipt),
  });
}

function freezeApprovalAuditEntryValue(value: ApprovalAuditEntry): ApprovalAuditEntry {
  return Object.freeze(value);
}

// Keep the official CommandReceipt type available to consumers that want a
// typed adapter while persisting only the JSON-safe provider-neutral payload.
export type JsonCommandReceipt<T extends JsonValue = JsonValue> = CommandReceipt<T>;
