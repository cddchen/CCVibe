import { describe, expect, it } from 'vitest';

import {
  CATALOG_ACTION_TYPES,
  ChatHostStateProvider,
  createChatUri,
  createPartId,
  createRootCatalogState,
  createRootUri,
  createSessionUri,
  createTurnId,
  createWorkspace,
  createWorkspaceId,
  HostStateManager,
  HostStateProvider,
  type ChatAction,
} from '../../src/index.js';

const chat = createChatUri('session-1', 'chat-1');
const otherChat = createChatUri('session-1', 'chat-2');
const root = createRootUri();
const session = createSessionUri('session-1');

function turnStarted(turnId: string): ChatAction {
  return {
    type: 'chat/turnStarted',
    turnId: createTurnId(turnId),
    prompt: `prompt-${turnId}`,
    timestamp: `action-${turnId}`,
  };
}

function createHost(replayCapacity = 4): HostStateManager {
  const host = new HostStateManager({ now: () => 'server-time', replayCapacity });
  host.registerChat(chat);
  host.registerChat(otherChat);
  return host;
}

function registerCatalog(host: HostStateManager): void {
  host.registerCatalog(root, createRootCatalogState({
    resource: root,
    host: { id: 'host-a', displayName: 'Host A' },
    workspaces: [createWorkspace({
      id: createWorkspaceId('workspace-a'),
      path: '/tmp/workspace-a',
      displayName: 'Workspace A',
    })],
    modifiedAt: 'catalog-0',
  }));
}

describe('ChatHostStateProvider', () => {
  it('keeps root and session resources generic and reports them missing', () => {
    const host = createHost();
    host.dispatch(chat, turnStarted('turn-1'));
    const provider = new ChatHostStateProvider(host, { hostEpoch: 'epoch-1' });

    expect(provider.snapshot(root)).toBeUndefined();
    expect(provider.snapshot(session)).toBeUndefined();

    const batch = provider.snapshots([chat, root, session, chat]);
    expect(batch.snapshots.map((snapshot) => snapshot.resource)).toEqual([chat]);
    expect(batch.missing).toEqual([root, session]);
    expect(batch.serverSeq).toBe(1);
    expect(batch.throughSeq).toBe(1);
    expect(Object.isFrozen(batch)).toBe(true);
    expect(Object.isFrozen(batch.snapshots)).toBe(true);
    expect(Object.isFrozen(batch.missing)).toBe(true);
  });

  it('returns the current epoch and synchronized replay cut', () => {
    const host = createHost();
    host.dispatch(chat, turnStarted('turn-1'));
    host.dispatch(otherChat, turnStarted('turn-2'));
    const provider = new ChatHostStateProvider(host, 'epoch-1');

    const result = provider.reconnect(0, new Set([chat, root]));

    expect(result.type).toBe('replay');
    expect(result.hostEpoch).toBe('epoch-1');
    expect(result.serverSeq).toBe(2);
    expect(result.throughSeq).toBe(2);
    expect(result.missing).toEqual([root]);
    if (result.type === 'replay') {
      expect(result.actions.map((action) => action.serverSeq)).toEqual([1]);
    }
  });

  it('falls back to a same-cut snapshot while keeping missing resources explicit', () => {
    const host = createHost(1);
    host.dispatch(chat, turnStarted('turn-1'));
    host.dispatch(otherChat, turnStarted('turn-2'));
    const provider = new ChatHostStateProvider(host, { hostEpoch: 'epoch-2' });

    const result = provider.reconnect(0, new Set([chat, root]));

    expect(result.type).toBe('snapshot');
    expect(result.hostEpoch).toBe('epoch-2');
    expect(result.serverSeq).toBe(2);
    expect(result.throughSeq).toBe(2);
    expect(result.missing).toEqual([root]);
    if (result.type === 'snapshot') {
      expect(result.snapshots).toHaveLength(1);
      expect(result.snapshots[0]?.resource).toBe(chat);
      expect(result.snapshots[0]?.fromSeq).toBe(2);
    }
  });

  it('disposes action listeners without owning the Host lifetime', () => {
    const host = createHost();
    const provider = new ChatHostStateProvider(host, 'epoch-1');
    const received: number[] = [];
    const disposable = provider.onAction((envelope) => received.push(envelope.serverSeq));

    host.dispatch(chat, turnStarted('turn-1'));
    disposable.dispose();
    host.dispatch(chat, {
      type: 'chat/responsePartAdded',
      turnId: createTurnId('turn-1'),
      part: { kind: 'markdown', id: createPartId('part-1'), content: 'answer' },
      timestamp: 'part-1',
    });

    expect(received).toEqual([1]);
  });

  it('returns root and chat snapshots from one global sequence cut', () => {
    const host = createHost();
    registerCatalog(host);
    host.dispatchCatalog(root, {
      type: CATALOG_ACTION_TYPES.hostUpdated,
      host: { id: 'host-a', displayName: 'Host A' },
      connection: { status: 'degraded', displayStatus: 'degraded' },
      timestamp: 'catalog-1',
    });
    host.dispatch(chat, turnStarted('turn-1'));
    const provider = new HostStateProvider(host, 'epoch-1');

    const batch = provider.snapshots([root, chat, root]);

    expect(batch.missing).toEqual([]);
    expect(batch.serverSeq).toBe(2);
    expect(batch.snapshots.map((snapshot) => snapshot.resource)).toEqual([root, chat]);
    expect(batch.snapshots.map((snapshot) => snapshot.fromSeq)).toEqual([2, 2]);
    expect(batch.snapshots[0]?.state).toMatchObject({
      host: { id: 'host-a', displayName: 'Host A' },
      connection: { status: 'degraded', displayStatus: 'degraded' },
    });
  });

  it('replays root catalog actions together with chat actions', () => {
    const host = createHost();
    registerCatalog(host);
    host.dispatchCatalog(root, {
      type: CATALOG_ACTION_TYPES.workspacesReplaced,
      workspaces: [],
      timestamp: 'catalog-1',
    });
    host.dispatch(chat, turnStarted('turn-1'));
    const provider = new HostStateProvider(host, 'epoch-1');

    const result = provider.reconnect(0, new Set([root, chat]));

    expect(result.type).toBe('replay');
    expect(result.missing).toEqual([]);
    if (result.type === 'replay') {
      expect(result.actions.map((action) => action.serverSeq)).toEqual([1, 2]);
      expect(result.actions[0]?.channel).toBe(root);
      expect(result.actions[1]?.channel).toBe(chat);
    }
  });

  it('includes root state in same-cut snapshot reconnects and action subscriptions', () => {
    const host = createHost(1);
    registerCatalog(host);
    host.dispatchCatalog(root, {
      type: CATALOG_ACTION_TYPES.workspacesReplaced,
      workspaces: [],
      timestamp: 'catalog-1',
    });
    host.dispatch(chat, turnStarted('turn-1'));
    const provider = new HostStateProvider(host, 'epoch-1');
    const received: string[] = [];
    const disposable = provider.onAction((envelope) => received.push(envelope.channel));

    host.dispatchCatalog(root, {
      type: CATALOG_ACTION_TYPES.hostUpdated,
      host: { id: 'host-a', displayName: 'Host A' },
      connection: { status: 'degraded', displayStatus: 'degraded' },
      timestamp: 'catalog-2',
    });
    const result = provider.reconnect(0, new Set([root, chat]));
    disposable.dispose();

    expect(received).toEqual([root]);
    expect(result.type).toBe('snapshot');
    if (result.type === 'snapshot') {
      expect(result.missing).toEqual([]);
      expect(result.snapshots.map((snapshot) => snapshot.resource)).toEqual([root, chat]);
      expect(result.snapshots.map((snapshot) => snapshot.fromSeq)).toEqual([3, 3]);
    }
  });
});
