import { describe, expect, it } from 'vitest';

import {
  decodeApprovalAuditRow,
  decodeChatBackingRow,
  decodeCommandReceiptRow,
  encodeApprovalAuditRow,
  encodeChatBackingRow,
  encodeCommandReceiptRow,
  encodeJson,
  isChatBackingRow,
  isCommandReceiptPayload,
  latestMigrationVersion,
  PERSISTENCE_MIGRATIONS,
  selectPendingMigrations,
  validateApprovalAuditRow,
  validateChatBackingRow,
  validateCommandReceiptPayload,
} from '../../src/persistence/schema.js';
import { migratePersistenceSchema, SQL } from '../../src/persistence/schema.js';
import type {
  ApprovalAuditEntry,
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
  clientSeq: 4,
  receipt: {
    status: 'accepted',
    value: { acceptedAtSeq: 12, turnId: 'turn-a' },
  },
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

describe('persistence schema codecs', () => {
  it('selects ordered missing migrations from a pure version input', () => {
    expect(selectPendingMigrations(0).map((migration) => migration.version)).toEqual([1, 2, 3]);
    expect(selectPendingMigrations(1).map((migration) => migration.version)).toEqual([2, 3]);
    expect(selectPendingMigrations([1, 3]).map((migration) => migration.version)).toEqual([2]);
    expect(selectPendingMigrations(new Set([1, 2, 3]))).toEqual([]);
    expect(latestMigrationVersion()).toBe(3);
    expect(() => selectPendingMigrations(4)).toThrow(RangeError);
    expect(() => selectPendingMigrations([-1])).toThrow(RangeError);
  });

  it('rejects non-monotonic migration definitions', () => {
    expect(() => selectPendingMigrations(0, [
      { version: 2, name: 'two', statements: ['SELECT 2'] },
      { version: 1, name: 'one', statements: ['SELECT 1'] },
    ])).toThrow(TypeError);
  });

  it('round-trips backing values and keeps SQLite null/boolean encoding explicit', () => {
    const row = encodeChatBackingRow(backing);
    expect(row).toEqual({
      chat_uri: backing.chatUri,
      sdk_session_id: backing.sdkSessionId,
      cwd: backing.cwd,
      additional_directories_json: '["/workspace/shared"]',
      model: backing.model,
      effort: backing.effort,
      permission_mode: backing.permissionMode,
      lifecycle: backing.lifecycle,
      title: backing.title,
      archived: 0,
      created_at: backing.createdAt,
      updated_at: backing.updatedAt,
    });
    expect(decodeChatBackingRow(row)).toEqual(backing);
    expect(Object.isFrozen(row)).toBe(true);
    expect(Object.isFrozen(decodeChatBackingRow(row).additionalDirectories)).toBe(true);

    const minimal = encodeChatBackingRow({
      ...backing,
      archived: true,
      ...({ model: undefined, effort: undefined, title: undefined } as unknown as Partial<PersistedChatBacking>),
    } as PersistedChatBacking);
    expect(minimal.model).toBeNull();
    expect(minimal.effort).toBeNull();
    expect(minimal.title).toBeNull();
    expect(minimal.archived).toBe(1);
    expect(decodeChatBackingRow(minimal)).toEqual({
      ...backing,
      model: undefined,
      effort: undefined,
      title: undefined,
      archived: true,
    });
  });

  it('validates malformed or non-JSON backing rows before they reach storage', () => {
    const row = encodeChatBackingRow(backing);
    expect(isChatBackingRow(row)).toBe(true);
    expect(() => validateChatBackingRow({ ...row, archived: 2 })).toThrow(TypeError);
    expect(() => decodeChatBackingRow({ ...row, additional_directories_json: '{bad' })).toThrow(TypeError);
    expect(() => encodeChatBackingRow({ ...backing, additionalDirectories: ['/workspace', 1] as never })).toThrow(TypeError);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => encodeJson(cyclic as never)).toThrow(TypeError);
  });

  it('round-trips canonical command receipts without persisting action/transcript fields', () => {
    const row = encodeCommandReceiptRow(receipt);
    expect(row).toEqual({
      client_id: receipt.clientId,
      command_id: receipt.commandId,
      chat_uri: receipt.chatUri,
      client_seq: receipt.clientSeq,
      receipt_json: '{"status":"accepted","value":{"acceptedAtSeq":12,"turnId":"turn-a"}}',
      created_at: receipt.createdAt,
    });
    expect(decodeCommandReceiptRow(row)).toEqual(receipt);
    expect(isCommandReceiptPayload(receipt.receipt)).toBe(true);
    expect(() => validateCommandReceiptPayload({ status: 'rejected', code: 'X' })).toThrow(TypeError);

    const rejected = encodeCommandReceiptRow({
      ...receipt,
      receipt: { status: 'rejected', code: 'NOPE', message: 'not accepted' },
    });
    expect(decodeCommandReceiptRow(rejected).receipt).toEqual({
      status: 'rejected',
      code: 'NOPE',
      message: 'not accepted',
    });

    expect(() => decodeCommandReceiptRow({
      ...row,
      receipt_json: JSON.stringify({ status: 'accepted', value: undefined }),
    })).toThrow(TypeError);
  });

  it('round-trips content-free approval audit entries and rejects unknown terminal status', () => {
    const row = encodeApprovalAuditRow(audit);
    expect(row).toEqual({
      audit_id: 'audit-a',
      chat_uri: backing.chatUri,
      approval_id: 'approval-a',
      turn_id: 'turn-a',
      status: 'resolved',
      decision: 'allow',
      decision_classification: 'user_temporary',
      client_id: 'client-a',
      command_id: 'command-a',
      requested_at: audit.requestedAt,
      occurred_at: audit.occurredAt,
    });
    expect(decodeApprovalAuditRow(row)).toEqual(audit);
    expect(() => validateApprovalAuditRow({ ...row, status: 'pending' })).toThrow(TypeError);

    const requested = encodeApprovalAuditRow({
      ...audit,
      status: 'requested',
      ...({
        decision: undefined,
        decisionClassification: undefined,
        clientId: undefined,
        commandId: undefined,
        requestedAt: undefined,
      } as unknown as Partial<ApprovalAuditEntry>),
    } as ApprovalAuditEntry);
    expect(requested.decision).toBeNull();
    expect(requested.client_id).toBeNull();
    expect(decodeApprovalAuditRow(requested)).toEqual({
      ...audit,
      status: 'requested',
      decision: undefined,
      decisionClassification: undefined,
      clientId: undefined,
      commandId: undefined,
      requestedAt: undefined,
    });
  });
});

describe('persistence migration shell', () => {
  class MigrationPort implements SqlitePort {
    public readonly executions: string[] = [];
    public readonly runs: Array<{ sql: string; parameters: SqliteParameters }> = [];
    public readonly applied: Array<{ version: number; name: string; applied_at: string }> = [];

    public exec(sql: string): void {
      this.executions.push(sql);
    }

    public run(sql: string, parameters: SqliteParameters): SqliteRunResult {
      this.runs.push({ sql, parameters });
      if (sql === SQL.insertMigration) {
        const [version, name, appliedAt] = parameters;
        this.applied.push({ version: version as number, name: name as string, applied_at: appliedAt as string });
      }
      return { changes: 1, lastInsertRowid: 1 };
    }

    public get<Row extends object = Record<string, unknown>>(
      _sql: string,
      _parameters: SqliteParameters,
    ): Row | undefined {
      return undefined;
    }

    public all<Row extends object = Record<string, unknown>>(
      _sql: string,
      _parameters: SqliteParameters,
    ): readonly Row[] {
      return this.applied as unknown as readonly Row[];
    }

    public async transaction<Result>(
      work: (transaction: SqlitePort) => Result | PromiseLike<Result>,
    ): Promise<Result> {
      return await work(this);
    }
  }

  it('applies each missing migration once, in one transaction, with bound metadata', async () => {
    const port = new MigrationPort();
    const first = await migratePersistenceSchema(port, { now: () => '2026-08-27T00:00:00.000Z' });
    const second = await migratePersistenceSchema(port, { now: () => '2026-08-27T00:00:01.000Z' });

    expect(first).toBe(3);
    expect(second).toBe(3);
    expect(port.applied.map((migration) => migration.version)).toEqual([1, 2, 3]);
    expect(port.runs.every(({ sql, parameters }) => sql.includes('?') && parameters.length === 3)).toBe(true);
    expect(PERSISTENCE_MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3]);
  });
});
