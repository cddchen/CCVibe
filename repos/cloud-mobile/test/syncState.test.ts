import { describe, expect, it } from 'vitest';

import {
  applyHostAction,
  applyInitializeResult,
  applyReconnectResult,
  createSyncState,
} from '../src/sync/syncState';
import { parseHostActionEnvelope, parseHostReconnectResult, parseHostStateSnapshot } from '../src/protocol/hostWire';

const root = 'agent-root://';
const chat = 'agent-chat://workspace-a/chat-a';

function rootSnapshot(fromSeq: number, modifiedAt = `t${fromSeq}`) {
  return parseHostStateSnapshot({
    resource: root,
    state: {
      resource: root,
      host: { id: 'host-a', displayName: 'Host A' },
      connection: { status: 'connected', displayStatus: 'online' },
      workspaces: [{ id: 'workspace-a', path: '/tmp/workspace-a', displayName: 'Workspace A', status: 'available' }],
      sessions: [],
      models: [],
      modifiedAt,
    },
    fromSeq,
  });
}

function chatSnapshot(fromSeq: number, modifiedAt = `t${fromSeq}`) {
  return parseHostStateSnapshot({
    resource: chat,
    state: {
      resource: chat,
      status: 'idle',
      turns: [],
      pendingApprovals: [],
      pendingInputs: [],
      modifiedAt,
    },
    fromSeq,
  });
}

describe('pure synchronized state coordination', () => {
  it('converges replay and same-cut snapshots while retaining the real Host state shape', () => {
    const initial = createSyncState({ address: 'wss://cloud.example.test', subscriptions: [root, chat] });
    const initialized = applyInitializeResult(initial, {
      protocolVersion: '1.0.0',
      hostEpoch: 'epoch-1',
      serverSeq: 0,
      snapshots: [rootSnapshot(0), chatSnapshot(0)],
      missing: [],
    }, [root, chat]);

    const replay = parseHostReconnectResult({
      type: 'replay',
      hostEpoch: 'epoch-1',
      throughSeq: 2,
      serverSeq: 2,
      missing: [],
      actions: [
        {
          channel: root,
          serverSeq: 1,
          serverTime: 't1',
          action: {
            type: 'catalog/modelsReplaced',
            models: [{ id: 'model-a', displayName: 'Model A', capabilities: [] }],
            defaultModelId: 'model-a',
            timestamp: 't1',
          },
        },
        {
          channel: chat,
          serverSeq: 2,
          serverTime: 't2',
          action: { type: 'chat/turnStarted', turnId: 'turn-a', prompt: 'hello', timestamp: 't2' },
        },
      ],
    });
    const replayed = applyReconnectResult(initialized, replay);

    const snapshotted = applyReconnectResult(initialized, parseHostReconnectResult({
      type: 'snapshot',
      hostEpoch: 'epoch-1',
      throughSeq: 2,
      serverSeq: 2,
      missing: [],
      snapshots: [
        parseHostStateSnapshot({
          resource: root,
          state: {
            ...rootSnapshot(0).state,
            models: [{ id: 'model-a', displayName: 'Model A', capabilities: [] }],
            defaultModelId: 'model-a',
            modifiedAt: 't1',
          },
          fromSeq: 2,
        }),
        parseHostStateSnapshot({
          resource: chat,
          state: {
            ...chatSnapshot(0).state,
            status: 'in_progress',
            turns: [],
            activeTurn: { id: 'turn-a', prompt: 'hello', status: 'active', parts: [], startedAt: 't2' },
            modifiedAt: 't2',
          },
          fromSeq: 2,
        }),
      ],
    }));

    expect(replayed.lastSeenServerSeq).toBe(2);
    expect(replayed.resources).toEqual(snapshotted.resources);
    expect(replayed.resources[0]?.state).toMatchObject({ models: [{ id: 'model-a' }] });
    expect(replayed.resources[1]?.state).toMatchObject({ status: 'in_progress' });
  });

  it('allows a lower sequence only when the Host epoch changes and ignores stale actions', () => {
    const initial = createSyncState({ address: 'wss://cloud.example.test', subscriptions: [root] });
    const current = applyInitializeResult(initial, {
      protocolVersion: '1.0.0',
      hostEpoch: 'epoch-old',
      serverSeq: 8,
      snapshots: [rootSnapshot(8)],
      missing: [],
    }, [root]);
    const replaced = applyReconnectResult(current, parseHostReconnectResult({
      type: 'snapshot',
      hostEpoch: 'epoch-new',
      throughSeq: 1,
      serverSeq: 1,
      missing: [],
      snapshots: [rootSnapshot(1)],
    }));

    const duplicate = applyHostAction(replaced, parseHostActionEnvelope({
      channel: root,
      serverSeq: 1,
      serverTime: 'old',
      action: { type: 'catalog/workspacesReplaced', workspaces: [], timestamp: 'old' },
    }));
    expect(replaced.hostEpoch).toBe('epoch-new');
    expect(replaced.lastSeenServerSeq).toBe(1);
    expect(duplicate).toBe(replaced);
  });
});
