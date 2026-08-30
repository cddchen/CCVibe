import {
  decodeApprovalAuditRow,
  decodeChatBackingRow,
  decodeCommandReceiptRow,
  encodeApprovalAuditRow,
  encodeChatBackingRow,
  encodeCommandReceiptRow,
  migratePersistenceSchema,
  SQL,
} from './schema.js';
import type {
  ApprovalAuditEntry,
  ApprovalAuditRow,
  ChatBackingRow,
  CommandReceiptRow,
  PersistedChatBacking,
  PersistedCommandReceipt,
  PersistenceMigration,
  PersistenceStoreOptions,
  SqliteParameters,
  SqlitePort,
} from './types.js';

export interface PersistenceMigrationOptions {
  readonly now?: () => string;
  readonly migrations?: readonly PersistenceMigration[];
}

export interface CreatePersistenceStoreOptions extends PersistenceStoreOptions {
  /** Run migrations during {@link openPersistenceStore}; defaults to true. */
  readonly migrate?: boolean;
}

export type PersistenceStoreTransaction = <Result>(
  work: (store: PersistenceStore) => Result | PromiseLike<Result>,
) => Promise<Result>;

/**
 * Transactional persistence facade for the Host overlay.
 *
 * Every mutation is encoded before entering the transaction and every SQL
 * value is passed through a positional parameter array. The class contains no
 * SDK transcript handling and no in-memory authoritative chat state.
 */
export class PersistenceStore {
  private readonly port: SqlitePort;
  private readonly now: () => string;
  private readonly transactionScope: boolean;

  public constructor(
    port: SqlitePort,
    options: PersistenceStoreOptions = {},
    transactionScope = false,
  ) {
    this.port = port;
    this.now = options.now ?? (() => new Date().toISOString());
    this.transactionScope = transactionScope;
  }

  /** Apply all missing schema migrations atomically. */
  public migrate(options: PersistenceMigrationOptions = {}): Promise<number> {
    return migratePersistenceSchema(this.port, {
      now: options.now ?? this.now,
      ...(options.migrations === undefined ? {} : { migrations: options.migrations }),
    });
  }

  /** Alias used by callers that name the operation after the schema. */
  public migrateSchema(options: PersistenceMigrationOptions = {}): Promise<number> {
    return this.migrate(options);
  }

  public async getChatBacking(chatUri: string): Promise<PersistedChatBacking | undefined> {
    const row = await this.port.get<ChatBackingRow>(SQL.selectChatBacking, [chatUri]);
    return row === undefined ? undefined : decodeChatBackingRow(row);
  }

  public async listChatBackings(): Promise<readonly PersistedChatBacking[]> {
    const rows = await this.port.all<ChatBackingRow>(SQL.selectChatBackings, []);
    return Object.freeze(rows.map((row) => decodeChatBackingRow(row)));
  }

  /** Upsert a backing; the caller can fan out only after this Promise resolves. */
  public async putChatBacking(backing: PersistedChatBacking): Promise<void> {
    const row = encodeChatBackingRow(backing);
    await this.write((transaction) => transaction.run(SQL.upsertChatBacking, chatBackingParameters(row)));
  }

  public saveChatBacking(backing: PersistedChatBacking): Promise<void> {
    return this.putChatBacking(backing);
  }

  public upsertChatBacking(backing: PersistedChatBacking): Promise<void> {
    return this.putChatBacking(backing);
  }

  public async deleteChatBacking(chatUri: string): Promise<boolean> {
    const result = await this.write((transaction) => transaction.run(SQL.deleteChatBacking, [chatUri]));
    return result.changes > 0;
  }

  public async getCommandReceipt(
    clientId: string,
    commandId: string,
  ): Promise<PersistedCommandReceipt | undefined> {
    const row = await this.port.get<CommandReceiptRow>(SQL.selectCommandReceipt, [clientId, commandId]);
    return row === undefined ? undefined : decodeCommandReceiptRow(row);
  }

  public async listCommandReceipts(chatUri?: string): Promise<readonly PersistedCommandReceipt[]> {
    const query = chatUri === undefined ? SQL.selectCommandReceipts : SQL.selectCommandReceiptsForChat;
    const parameters: SqliteParameters = chatUri === undefined ? [] : [chatUri];
    const rows = await this.port.all<CommandReceiptRow>(query, parameters);
    return Object.freeze(rows.map((row) => decodeCommandReceiptRow(row)));
  }

  /** Store the canonical receipt for a command idempotency key. */
  public async putCommandReceipt(receipt: PersistedCommandReceipt): Promise<void> {
    const row = encodeCommandReceiptRow(receipt);
    await this.write((transaction) => transaction.run(SQL.upsertCommandReceipt, commandReceiptParameters(row)));
  }

  public saveCommandReceipt(receipt: PersistedCommandReceipt): Promise<void> {
    return this.putCommandReceipt(receipt);
  }

  public upsertCommandReceipt(receipt: PersistedCommandReceipt): Promise<void> {
    return this.putCommandReceipt(receipt);
  }

  public async deleteCommandReceipt(clientId: string, commandId: string): Promise<boolean> {
    const result = await this.write((transaction) => transaction.run(SQL.deleteCommandReceipt, [clientId, commandId]));
    return result.changes > 0;
  }

  public async listApprovalAudit(chatUri?: string): Promise<readonly ApprovalAuditEntry[]> {
    const query = chatUri === undefined ? SQL.selectApprovalAudit : SQL.selectApprovalAuditForChat;
    const parameters: SqliteParameters = chatUri === undefined ? [] : [chatUri];
    const rows = await this.port.all<ApprovalAuditRow>(query, parameters);
    return Object.freeze(rows.map((row) => decodeApprovalAuditRow(row)));
  }

  public getApprovalAudit(chatUri?: string): Promise<readonly ApprovalAuditEntry[]> {
    return this.listApprovalAudit(chatUri);
  }

  /** Append an immutable, content-free approval audit record. */
  public async appendApprovalAudit(entry: ApprovalAuditEntry): Promise<void> {
    const row = encodeApprovalAuditRow(entry);
    await this.write((transaction) => transaction.run(SQL.insertApprovalAudit, approvalAuditParameters(row)));
  }

  public saveApprovalAudit(entry: ApprovalAuditEntry): Promise<void> {
    return this.appendApprovalAudit(entry);
  }

  /**
   * Run related writes in one transaction. The scoped store does not begin a
   * nested transaction, so backing, receipt, and audit writes can be composed
   * safely before the caller broadcasts an after-commit action.
   */
  public async transaction<Result>(
    work: (store: PersistenceStore) => Result | PromiseLike<Result>,
  ): Promise<Result> {
    if (this.transactionScope) {
      return await work(this);
    }

    return await this.port.transaction(async (transaction) => {
      const scopedStore = new PersistenceStore(
        transaction,
        { now: this.now },
        true,
      );
      return await work(scopedStore);
    });
  }

  public close(): Promise<void> {
    return Promise.resolve(this.port.close?.());
  }

  private write<Result>(operation: WriteOperation<Result>): Promise<Result> {
    return writeResult(this.port, this.transactionScope, operation);
  }
}

/** Explicit SQLite-oriented alias. No native SQLite module is imported. */
export { PersistenceStore as SqlitePersistenceStore };
export { PersistenceStore as OverlayPersistenceStore };

export function createPersistenceStore(
  port: SqlitePort,
  options: PersistenceStoreOptions = {},
): PersistenceStore {
  return new PersistenceStore(port, options);
}

export async function openPersistenceStore(
  port: SqlitePort,
  options: CreatePersistenceStoreOptions = {},
): Promise<PersistenceStore> {
  const store = new PersistenceStore(port, options);
  if (options.migrate !== false) {
    await store.migrate();
  }
  return store;
}

export const createSqlitePersistenceStore = createPersistenceStore;
export const openSqlitePersistenceStore = openPersistenceStore;

function chatBackingParameters(row: ChatBackingRow): SqliteParameters {
  return [
    row.chat_uri,
    row.sdk_session_id,
    row.cwd,
    row.additional_directories_json,
    row.model,
    row.effort,
    row.permission_mode,
    row.lifecycle,
    row.title,
    row.archived,
    row.created_at,
    row.updated_at,
  ];
}

function commandReceiptParameters(row: CommandReceiptRow): SqliteParameters {
  return [
    row.client_id,
    row.command_id,
    row.chat_uri,
    row.client_seq,
    row.receipt_json,
    row.created_at,
  ];
}

function approvalAuditParameters(row: ApprovalAuditRow): SqliteParameters {
  return [
    row.audit_id,
    row.chat_uri,
    row.approval_id,
    row.turn_id,
    row.status,
    row.decision,
    row.decision_classification,
    row.client_id,
    row.command_id,
    row.requested_at,
    row.occurred_at,
  ];
}

type WriteOperation<Result> = (transaction: SqlitePort) => Result | PromiseLike<Result>;

async function writeResult<Result>(
  port: SqlitePort,
  transactionScope: boolean,
  operation: WriteOperation<Result>,
): Promise<Result> {
  if (transactionScope) {
    return await operation(port);
  }
  return await port.transaction(operation);
}
