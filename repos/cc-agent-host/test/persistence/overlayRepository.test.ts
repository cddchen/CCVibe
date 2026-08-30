import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createChatBacking,
  createChatUri,
  markChatBackingMaterialized,
} from '../../src/index.js';
import {
  OverlayConflictError,
  OverlayRepository,
  encodeApprovalAuditRow,
  encodeChatBackingRow,
  encodeCommandReceiptRow,
} from '../../src/persistence/overlayRepository.js';
import {
  createSqlitePort,
  migratePersistenceSchema,
} from '../../src/persistence/schema.js';
import { PersistenceStore } from '../../src/persistence/store.js';
import type {
  ApprovalAuditEntry,
  PersistedChatBacking,
  PersistedCommandReceipt,
  SqliteDatabaseLike,
  SqlitePort,
} from '../../src/persistence/types.js';

type DatabaseSyncLike = SqliteDatabaseLike & { readonly close: () => void };

const require = createRequire(import.meta.url);
const sqlite = require('node:sqlite') as {
  readonly DatabaseSync: new (filename: string) => DatabaseSyncLike;
};

const chatUri = createChatUri('session-restart', 'chat-overlay');

const backing: PersistedChatBacking = {
  chatUri,
  sdkSessionId: 'sdk-session-explicit',
  cwd: '/workspace/project',
  additionalDirectories: ['/workspace/shared'],
  model: 'claude-sonnet',
  effort: 'high',
  permissionMode: 'default',
  lifecycle: 'materialized',
  title: 'Persisted chat',
  archived: false,
  createdAt: '2026-08-27T00:00:00.000Z',
  updatedAt: '2026-08-27T00:00:00.000Z',
};

const receipt: PersistedCommandReceipt = {
  clientId: 'client-a',
  commandId: 'command-a',
  chatUri,
  clientSeq: 3,
  receipt: {
    status: 'accepted',
    value: { acceptedAtSeq: 12, turnId: 'turn-a' },
  },
  createdAt: '2026-08-27T00:00:01.000Z',
};

const requestedAudit: ApprovalAuditEntry = {
  auditId: 'audit-requested',
  chatUri,
  approvalId: 'approval-a',
  turnId: 'turn-a',
  status: 'requested',
  requestedAt: '2026-08-27T00:00:02.000Z',
  occurredAt: '2026-08-27T00:00:02.000Z',
};

const resolvedAudit: ApprovalAuditEntry = {
  auditId: 'audit-resolved',
  chatUri,
  approvalId: 'approval-a',
  turnId: 'turn-a',
  status: 'resolved',
  decision: 'allow',
  decisionClassification: 'user_temporary',
  clientId: 'client-a',
  commandId: 'command-a',
  requestedAt: '2026-08-27T00:00:02.000Z',
  occurredAt: '2026-08-27T00:00:03.000Z',
};

async function openRepository(filename = ':memory:'): Promise<{
  readonly database: DatabaseSyncLike;
  readonly repository: OverlayRepository;
}> {
  const database = new sqlite.DatabaseSync(filename);
  const port = createSqlitePort(database);
  await migratePersistenceSchema(port, { now: () => '2026-08-27T00:00:00.000Z' });
  const store = new PersistenceStore(port, { now: () => '2026-08-27T00:00:04.000Z' });
  return { database, repository: new OverlayRepository(store, { now: () => '2026-08-27T00:00:04.000Z' }) };
}

describe('OverlayRepository', () => {
  it('keeps backing/config rows explicit and writes only parameterized overlay fields', async () => {
    const { database, repository } = await openRepository();
    try {
      const domainBacking = markChatBackingMaterialized(createChatBacking({
        chatUri,
        sdkSessionId: backing.sdkSessionId,
        cwd: `${backing.cwd}/./`,
        additionalDirectories: backing.additionalDirectories,
        desiredConfig: {
          model: 'claude-sonnet',
          effort: 'high',
          permissionMode: 'default',
        },
      }));
      const saved = await repository.saveChatBacking({
        backing: domainBacking,
        title: backing.title!,
        archived: backing.archived,
        createdAt: backing.createdAt,
        updatedAt: backing.updatedAt,
      });

      expect(saved).toEqual(backing);
      expect(encodeChatBackingRow(saved)).toEqual({
        chat_uri: chatUri,
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
      const raw = database.prepare(
        'SELECT * FROM chat_backings WHERE chat_uri = ?',
      ).get(chatUri) as Record<string, unknown>;
      expect(raw).not.toHaveProperty('token');
      expect(raw).not.toHaveProperty('action');
      expect(raw).not.toHaveProperty('transcript');
    } finally {
      database.close();
    }
  });

  it('deduplicates the same command receipt and rejects a conflicting retry without overwrite', async () => {
    const { database, repository } = await openRepository();
    try {
      const first = await repository.saveCommandReceipt(receipt);
      const retry = await repository.saveCommandReceipt({ ...receipt, receipt: {
        status: 'accepted',
        value: { acceptedAtSeq: 12, turnId: 'turn-a' },
      } });

      expect(retry).toEqual(first);
      await expect(repository.saveCommandReceipt({
        ...receipt,
        receipt: { status: 'rejected', code: 'CONFLICT', message: 'different effect' },
      })).rejects.toBeInstanceOf(OverlayConflictError);
      expect(await repository.getCommandReceipt(receipt.clientId, receipt.commandId)).toEqual(first);

      const row = database.prepare(
        'SELECT * FROM command_receipts WHERE client_id = ? AND command_id = ?',
      ).get(receipt.clientId, receipt.commandId) as Record<string, unknown>;
      expect(row.receipt_json).toBe('{"status":"accepted","value":{"acceptedAtSeq":12,"turnId":"turn-a"}}');
      expect(encodeCommandReceiptRow(first).receipt_json).not.toContain('different effect');
    } finally {
      database.close();
    }
  });

  it('updates overlay metadata/config and restores it from a new repository after restart', async () => {
    const directory = await mkdtemp(join('/tmp', 'ccvibe-overlay-restart-'));
    const filename = join(directory, 'overlay.sqlite');
    const first = await openRepository(filename);
    try {
      await first.repository.saveChatBacking(backing);
      await first.repository.updateChatConfig(chatUri, {
        model: 'claude-opus',
        effort: 'max',
        permissionMode: 'plan',
      });
      await first.repository.updateChatMetadata(chatUri, { title: 'After restart', archived: true });
      await first.repository.appendApprovalAudit(requestedAudit);
      await first.repository.appendApprovalAudit(resolvedAudit);
    } finally {
      first.database.close();
    }

    const second = await openRepository(filename);
    try {
      expect(await second.repository.listChatBackings()).toEqual([{
        ...backing,
        model: 'claude-opus',
        effort: 'max',
        permissionMode: 'plan',
        title: 'After restart',
        archived: true,
        updatedAt: '2026-08-27T00:00:04.000Z',
      }]);
      expect(await second.repository.listApprovalAudit({ chatUri })).toEqual([
        requestedAudit,
        resolvedAudit,
      ]);
    } finally {
      second.database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rolls back related writes when a transaction fails and keeps audit rows content-free', async () => {
    const { database, repository } = await openRepository();
    try {
      const failure = new Error('deliberate transaction failure');
      await expect(repository.transaction(async (store) => {
        await store.putChatBacking(backing);
        await store.appendApprovalAudit({
          ...requestedAudit,
          auditId: 'audit-rolled-back',
        });
        throw failure;
      })).rejects.toBe(failure);

      expect(await repository.getChatBacking(chatUri)).toBeUndefined();
      expect(await repository.listApprovalAudit()).toEqual([]);

      const contentBearing = {
        ...resolvedAudit,
        auditId: 'audit-content-free',
        input: 'secret token/action body',
      };
      await repository.appendApprovalAudit(contentBearing);
      const stored = await repository.listApprovalAudit({ approvalId: resolvedAudit.approvalId });
      expect(stored).toEqual([{
        ...resolvedAudit,
        auditId: 'audit-content-free',
      }]);
      expect(stored[0]).not.toHaveProperty('input');
      expect(encodeApprovalAuditRow(stored[0]!)).not.toHaveProperty('input');
    } finally {
      database.close();
    }
  });

  it('forwards close to the underlying persistence port', async () => {
    const close = vi.fn(() => Promise.resolve());
    const port: SqlitePort = {
      exec: vi.fn(),
      run: vi.fn(),
      get: vi.fn(),
      all: vi.fn(),
      transaction: vi.fn(),
      close,
    };
    const repository = new OverlayRepository(port);

    await expect(repository.close()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  });
});
