import { describe, expect, it } from 'vitest';

import { PersistenceStore } from '../../src/persistence/store.js';
import { SQL } from '../../src/persistence/schema.js';
import type {
  ApprovalAuditEntry,
  ApprovalAuditRow,
  ChatBackingRow,
  CommandReceiptRow,
  PersistedChatBacking,
  PersistedCommandReceipt,
  SqliteParameters,
  SqlitePort,
  SqliteRunResult,
} from '../../src/persistence/types.js';

const backing: PersistedChatBacking = {
  chatUri: 'agent-chat://session-a/chat-a',
  sdkSessionId: 'sdk-session-a',
  cwd: '/workspace/project',
  additionalDirectories: ['/workspace/shared'],
  model: 'claude-sonnet',
  effort: 'high',
  permissionMode: 'default',
  lifecycle: 'materialized',
  title: 'A chat',
  archived: false,
  createdAt: '2026-08-27T00:00:00.000Z',
  updatedAt: '2026-08-27T00:00:01.000Z',
};

const receipt: PersistedCommandReceipt = {
  clientId: 'client-a',
  commandId: 'command-a',
  chatUri: backing.chatUri,
  clientSeq: 1,
  receipt: { status: 'accepted', value: { acceptedAtSeq: 2 } },
  createdAt: '2026-08-27T00:00:02.000Z',
};

const audit: ApprovalAuditEntry = {
  auditId: 'audit-a',
  chatUri: backing.chatUri,
  approvalId: 'approval-a',
  turnId: 'turn-a',
  status: 'resolved',
  decision: 'allow',
  decisionClassification: 'user_temporary',
  clientId: 'client-a',
  commandId: 'command-a',
  requestedAt: '2026-08-27T00:00:03.000Z',
  occurredAt: '2026-08-27T00:00:04.000Z',
};

class MemorySqlitePort implements SqlitePort {
  public readonly calls: Array<{ sql: string; parameters: SqliteParameters }> = [];
  public readonly executed: string[] = [];
  private readonly chatBackings = new Map<string, ChatBackingRow>();
  private readonly commandReceipts = new Map<string, CommandReceiptRow>();
  private readonly audits = new Map<string, ApprovalAuditRow>();

  public exec(sql: string): void {
    this.executed.push(sql);
  }

  public run(sql: string, parameters: SqliteParameters): SqliteRunResult {
    this.calls.push({ sql, parameters: [...parameters] });
    if (sql === SQL.upsertChatBacking) {
      const [chatUri, sdkSessionId, cwd, directories, model, effort, permissionMode, lifecycle, title, archived, createdAt, updatedAt] = parameters;
      this.chatBackings.set(chatUri as string, {
        chat_uri: chatUri as string,
        sdk_session_id: sdkSessionId as string,
        cwd: cwd as string,
        additional_directories_json: directories as string,
        model: model as string | null,
        effort: effort as string | null,
        permission_mode: permissionMode as string,
        lifecycle: lifecycle as 'provisional' | 'materialized',
        title: title as string | null,
        archived: archived as 0 | 1,
        created_at: createdAt as string,
        updated_at: updatedAt as string,
      });
      return { changes: 1, lastInsertRowid: 1 };
    }
    if (sql === SQL.deleteChatBacking) {
      const changes = this.chatBackings.delete(parameters[0] as string) ? 1 : 0;
      return { changes, lastInsertRowid: 0 };
    }
    if (sql === SQL.upsertCommandReceipt) {
      const [clientId, commandId, chatUri, clientSeq, receiptJson, createdAt] = parameters;
      this.commandReceipts.set(`${String(clientId)}\u0000${String(commandId)}`, {
        client_id: clientId as string,
        command_id: commandId as string,
        chat_uri: chatUri as string | null,
        client_seq: clientSeq as number | null,
        receipt_json: receiptJson as string,
        created_at: createdAt as string,
      });
      return { changes: 1, lastInsertRowid: 1 };
    }
    if (sql === SQL.deleteCommandReceipt) {
      const changes = this.commandReceipts.delete(`${String(parameters[0])}\u0000${String(parameters[1])}`) ? 1 : 0;
      return { changes, lastInsertRowid: 0 };
    }
    if (sql === SQL.insertApprovalAudit) {
      const [auditId, chatUri, approvalId, turnId, status, decision, classification, clientId, commandId, requestedAt, occurredAt] = parameters;
      this.audits.set(auditId as string, {
        audit_id: auditId as string,
        chat_uri: chatUri as string,
        approval_id: approvalId as string,
        turn_id: turnId as string,
        status: status as ApprovalAuditEntry['status'],
        decision: decision as 'allow' | 'deny' | null,
        decision_classification: classification as 'user_temporary' | 'user_permanent' | 'user_reject' | null,
        client_id: clientId as string | null,
        command_id: commandId as string | null,
        requested_at: requestedAt as string | null,
        occurred_at: occurredAt as string,
      });
      return { changes: 1, lastInsertRowid: 1 };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }

  public get<Row extends object = Record<string, unknown>>(
    sql: string,
    parameters: SqliteParameters,
  ): Row | undefined {
    this.calls.push({ sql, parameters: [...parameters] });
    if (sql === SQL.selectChatBacking) {
      return this.chatBackings.get(parameters[0] as string) as Row | undefined;
    }
    if (sql === SQL.selectCommandReceipt) {
      return this.commandReceipts.get(`${String(parameters[0])}\u0000${String(parameters[1])}`) as Row | undefined;
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }

  public all<Row extends object = Record<string, unknown>>(
    sql: string,
    parameters: SqliteParameters,
  ): readonly Row[] {
    this.calls.push({ sql, parameters: [...parameters] });
    if (sql === SQL.selectChatBackings) {
      return [...this.chatBackings.values()] as unknown as readonly Row[];
    }
    if (sql === SQL.selectCommandReceipts || sql === SQL.selectCommandReceiptsForChat) {
      const rows = [...this.commandReceipts.values()]
        .filter((row) => sql === SQL.selectCommandReceipts || row.chat_uri === parameters[0]);
      return rows as unknown as readonly Row[];
    }
    if (sql === SQL.selectApprovalAudit || sql === SQL.selectApprovalAuditForChat) {
      const rows = [...this.audits.values()]
        .filter((row) => sql === SQL.selectApprovalAudit || row.chat_uri === parameters[0]);
      return rows as unknown as readonly Row[];
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }

  public async transaction<Result>(
    work: (transaction: SqlitePort) => Result | PromiseLike<Result>,
  ): Promise<Result> {
    const chatSnapshot = new Map(this.chatBackings);
    const receiptSnapshot = new Map(this.commandReceipts);
    const auditSnapshot = new Map(this.audits);
    try {
      return await work(this);
    } catch (error) {
      this.chatBackings.clear();
      for (const [key, value] of chatSnapshot) this.chatBackings.set(key, value);
      this.commandReceipts.clear();
      for (const [key, value] of receiptSnapshot) this.commandReceipts.set(key, value);
      this.audits.clear();
      for (const [key, value] of auditSnapshot) this.audits.set(key, value);
      throw error;
    }
  }
}

describe('PersistenceStore', () => {
  it('writes and reads overlay values through parameterized SQL', async () => {
    const port = new MemorySqlitePort();
    const store = new PersistenceStore(port, { now: () => '2026-08-27T00:00:00.000Z' });

    await store.putChatBacking(backing);
    await store.putCommandReceipt(receipt);
    await store.appendApprovalAudit(audit);

    await expect(store.getChatBacking(backing.chatUri)).resolves.toEqual(backing);
    await expect(store.getCommandReceipt(receipt.clientId, receipt.commandId)).resolves.toEqual(receipt);
    await expect(store.listApprovalAudit(backing.chatUri)).resolves.toEqual([audit]);

    expect(port.calls.filter(({ sql }) => sql.includes('?')).every(({ parameters }) => parameters.length > 0)).toBe(true);
    expect(port.calls.some(({ sql }) => sql.includes(backing.chatUri))).toBe(false);
    expect(port.calls.some(({ sql }) => sql.includes('acceptedAtSeq'))).toBe(false);
  });

  it('commits related writes together and exposes them for after-commit fanout', async () => {
    const port = new MemorySqlitePort();
    const store = new PersistenceStore(port);
    const observed: string[] = [];

    await store.transaction(async (transaction) => {
      await transaction.putChatBacking(backing);
      await transaction.putCommandReceipt(receipt);
      await transaction.appendApprovalAudit(audit);
      observed.push('inside-transaction');
    });
    observed.push('after-commit');

    expect(observed).toEqual(['inside-transaction', 'after-commit']);
    await expect(store.getChatBacking(backing.chatUri)).resolves.toEqual(backing);
    await expect(store.getCommandReceipt(receipt.clientId, receipt.commandId)).resolves.toEqual(receipt);
    await expect(store.listApprovalAudit(backing.chatUri)).resolves.toEqual([audit]);
  });

  it('rolls back all overlay writes when a transaction fails', async () => {
    const port = new MemorySqlitePort();
    const store = new PersistenceStore(port);

    await expect(store.transaction(async (transaction) => {
      await transaction.putChatBacking(backing);
      await transaction.putCommandReceipt(receipt);
      await transaction.appendApprovalAudit(audit);
      throw new Error('commit failed');
    })).rejects.toThrow('commit failed');

    await expect(store.getChatBacking(backing.chatUri)).resolves.toBeUndefined();
    await expect(store.getCommandReceipt(receipt.clientId, receipt.commandId)).resolves.toBeUndefined();
    await expect(store.listApprovalAudit(backing.chatUri)).resolves.toEqual([]);
  });
});
