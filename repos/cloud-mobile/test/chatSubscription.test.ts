import { describe, expect, it } from 'vitest';

import { createChatUri, createRootUri, type ChatUri } from '../src/protocol/resourceUri';
import { createConnectionId } from '../src/protocol/ids';
import type { HostChatState, HostRootCatalogState } from '../src/protocol/hostWire';
import {
  CloudRuntime,
  type CloudRuntimeDependencies,
  type RuntimeSupervisor,
} from '../src/features/runtime/runtimeStore';
import { TransportClosedError } from '../src/sync/transport';
import type { SyncStore } from '../src/sync/syncState';
import type { ConnectionPreferencesCollection } from '../src/storage/connectionPreferences';

const chatA = createChatUri('workspace-a', 'chat-a');
const chatB = createChatUri('workspace-b', 'chat-b');

function catalog(): HostRootCatalogState {
  return {
    resource: createRootUri(),
    host: { id: 'host-a', displayName: 'Host A' },
    connection: { status: 'connected', displayStatus: 'online' },
    workspaces: [
      { id: 'workspace-a', path: '/workspace/a', displayName: 'Workspace A', status: 'available' },
      { id: 'workspace-b', path: '/workspace/b', displayName: 'Workspace B', status: 'available' },
    ],
    sessions: [
      { chatUri: chatA, sdkSessionRef: 'sdk-a', workspaceId: 'workspace-a', title: 'Chat A', updatedAt: 't0', status: 'idle', archived: false },
      { chatUri: chatB, sdkSessionRef: 'sdk-b', workspaceId: 'workspace-b', title: 'Chat B', updatedAt: 't0', status: 'idle', archived: false },
    ],
    models: [{ id: 'model-a', displayName: 'Model A', capabilities: [] }],
    defaultModelId: 'model-a',
    modifiedAt: 't0',
  };
}

function chatState(chatUri: ChatUri): HostChatState {
  return {
    resource: chatUri,
    status: 'idle',
    turns: [],
    pendingApprovals: [],
    pendingInputs: [],
    modifiedAt: 't0',
  };
}

function dependencies(supervisor: RuntimeSupervisor): CloudRuntimeDependencies {
  return {
    asyncStorage: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
    tokenStore: { read: async () => null, write: async () => undefined, clear: async () => undefined },
    appState: { currentState: () => 'active', subscribe: () => () => undefined },
    createSupervisor: () => supervisor,
    createId: (() => {
      let sequence = 0;
      return () => `id-${++sequence}`;
    })(),
    clientId: 'client-a',
  };
}

function connectedState() {
  return {
    status: 'connected' as const,
    address: 'wss://host.example.test',
    hostEpoch: 'epoch-a',
    lastSeenServerSeq: 0,
    subscriptions: [createRootUri(), chatA, chatB],
    resources: [],
    missing: [],
  };
}

function createSupervisor(subscribe: (resource: string) => Promise<void>): RuntimeSupervisor {
  return {
    getState: connectedState,
    start: () => undefined,
    stop: () => undefined,
    retryNow: () => undefined,
    subscribe,
    createChat: async () => ({ receipt: { status: 'rejected' as const, code: 'UNUSED', message: 'unused' } }),
    dispatchAction: async () => ({ receipt: { status: 'accepted' as const, value: { acceptedAtSeq: 1 } } }),
  };
}

describe('Cloud chat subscription loading state', () => {
  it('publishes loading immediately, keeps the last snapshot, and clears loading after a deferred snapshot', async () => {
    let resolveSubscription: (() => void) | undefined;
    const supervisor = createSupervisor(() => new Promise<void>((resolve) => { resolveSubscription = resolve; }));
    const runtime = new CloudRuntime(dependencies(supervisor));
    runtime.hydrateForTest({ catalog: catalog(), chat: { resource: chatA, state: chatState(chatA) }, supervisor });

    const pending = runtime.actions.subscribeChat(chatA);

    expect(runtime.getState().chatSubscriptions[String(chatA)]).toEqual({ status: 'loading' });
    expect(runtime.getState().sync.resources.some((entry) => entry.resource === chatA)).toBe(true);

    resolveSubscription?.();
    await expect(pending).resolves.toBe(true);
    expect(runtime.getState().chatSubscriptions[String(chatA)]).toEqual({ status: 'ready' });
  });

  it('deduplicates concurrent requests and exposes a retryable error that recovers', async () => {
    let calls = 0;
    let rejectFirst: ((reason?: unknown) => void) | undefined;
    const supervisor = createSupervisor(() => {
      calls += 1;
      if (calls === 1) return new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
      return Promise.resolve();
    });
    const runtime = new CloudRuntime(dependencies(supervisor));
    runtime.hydrateForTest({ catalog: catalog(), chat: { resource: chatA, state: chatState(chatA) }, supervisor });

    const first = runtime.actions.subscribeChat(chatA);
    const duplicate = runtime.actions.subscribeChat(chatA);
    expect(runtime.getState().chatSubscriptions[String(chatA)]).toEqual({ status: 'loading' });
    rejectFirst?.(new TransportClosedError(1006, 'socket closed'));
    await expect(first).resolves.toBe(false);
    await expect(duplicate).resolves.toBe(false);
    expect(calls).toBe(1);
    expect(runtime.getState().chatSubscriptions[String(chatA)]).toEqual({ status: 'error', code: 'CLOSED' });

    await expect(runtime.actions.subscribeChat(chatA)).resolves.toBe(true);
    expect(calls).toBe(2);
    expect(runtime.getState().chatSubscriptions[String(chatA)]).toEqual({ status: 'ready' });
    expect(runtime.getState().operationError).toBeUndefined();
  });

  it('does not let an older route request publish its error over the current chat', async () => {
    let rejectA: ((reason?: unknown) => void) | undefined;
    let resolveB: (() => void) | undefined;
    const supervisor = createSupervisor((resource) => resource === chatA
      ? new Promise<void>((_resolve, reject) => { rejectA = reject; })
      : new Promise<void>((resolve) => { resolveB = resolve; }));
    const runtime = new CloudRuntime(dependencies(supervisor));
    runtime.hydrateForTest({ catalog: catalog(), supervisor });

    const pendingA = runtime.actions.subscribeChat(chatA);
    const pendingB = runtime.actions.subscribeChat(chatB);
    expect(runtime.getState().chatSubscriptions[String(chatA)]).toEqual({ status: 'loading' });
    expect(runtime.getState().chatSubscriptions[String(chatB)]).toEqual({ status: 'loading' });

    rejectA?.(new TransportClosedError(1006, 'stale socket closed'));
    await expect(pendingA).resolves.toBe(false);
    expect(runtime.getState().operationError).toBeUndefined();

    resolveB?.();
    await expect(pendingB).resolves.toBe(true);
    expect(runtime.getState().chatSubscriptions[String(chatB)]).toEqual({ status: 'ready' });
    expect(runtime.getState().chatSubscriptions[String(chatA)]).toEqual({ status: 'error', code: 'CLOSED' });
  });

  it('fences a pending request when the Host is disconnected before it settles', async () => {
    let resolveSubscription: (() => void) | undefined;
    const supervisor = createSupervisor(() => new Promise<void>((resolve) => { resolveSubscription = resolve; }));
    const runtime = new CloudRuntime(dependencies(supervisor));
    runtime.hydrateForTest({ catalog: catalog(), supervisor });

    const pending = runtime.actions.subscribeChat(chatA);
    runtime.actions.disconnect();
    expect(runtime.getState().chatSubscriptions).toEqual({});
    expect(runtime.getState().sync.status).toBe('idle');

    resolveSubscription?.();
    await expect(pending).resolves.toBe(true);
    expect(runtime.getState().chatSubscriptions).toEqual({});
    expect(runtime.getState().operationError).toBeUndefined();
  });

  it('clears the lifecycle at reconnect and Host replacement boundaries', async () => {
    const stores: SyncStore[] = [];
    const pendingSubscriptions: Array<{ readonly resource: string; readonly resolve: () => void }> = [];
    let hostCollection: ConnectionPreferencesCollection = { hosts: [] };
    const tokens = new Map<string, string>();
    const runtime = new CloudRuntime({
      asyncStorage: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
      tokenStore: {
        read: async () => null,
        write: async () => undefined,
        clear: async () => undefined,
        readForHost: async (connectionId: string) => tokens.get(connectionId) ?? null,
        writeForHost: async (connectionId: string, token: string) => { tokens.set(connectionId, token); },
        clearForHost: async (connectionId: string) => { tokens.delete(connectionId); },
      },
      hostPreferencesStore: {
        loadHosts: async () => hostCollection,
        saveHosts: async (next) => { hostCollection = next; },
        selectHost: async (connectionId) => { hostCollection = { ...hostCollection, selectedConnectionId: createConnectionId(String(connectionId)) }; },
      },
      appState: { currentState: () => 'active', subscribe: () => () => undefined },
      connectionTimeoutMs: 100,
      createId: (() => {
        let sequence = 0;
        return () => `id-${++sequence}`;
      })(),
      clientId: 'client-a',
      createSupervisor: (options) => {
        if (options.store === undefined) throw new Error('test supervisor requires a sync store');
        stores.push(options.store);
        return {
          getState: () => options.store?.getState() ?? connectedState(),
          start: () => options.store?.dispatch({ type: 'connection/status', status: 'connected' }),
          stop: () => undefined,
          retryNow: () => undefined,
          subscribe: async (resource) => await new Promise<void>((resolve) => { pendingSubscriptions.push({ resource, resolve }); }),
          createChat: async () => ({ receipt: { status: 'rejected' as const, code: 'UNUSED', message: 'unused' } }),
          dispatchAction: async () => ({ receipt: { status: 'accepted' as const, value: { acceptedAtSeq: 1 } } }),
        } satisfies RuntimeSupervisor;
      },
    });

    await expect(runtime.actions.connect({ hostUrl: 'https://one.example.test', token: 'token-a', developmentMode: false }, null)).resolves.toEqual({ ok: true });
    const firstSubscription = runtime.actions.subscribeChat(chatA);
    expect(runtime.getState().chatSubscriptions[String(chatA)]).toEqual({ status: 'loading' });
    stores[0]?.dispatch({ type: 'connection/status', status: 'reconnecting' });
    expect(runtime.getState().chatSubscriptions).toEqual({});
    stores[0]?.dispatch({ type: 'connection/status', status: 'connected' });
    expect(runtime.getState().chatSubscriptions).toEqual({});
    pendingSubscriptions[0]?.resolve();
    await expect(firstSubscription).resolves.toBe(true);
    expect(runtime.getState().chatSubscriptions).toEqual({});

    const replacementSubscription = runtime.actions.subscribeChat(chatA);
    await expect(runtime.actions.connect({ hostUrl: 'https://two.example.test', token: 'token-b', developmentMode: false }, 'connection-b')).resolves.toEqual({ ok: true });
    expect(runtime.getState().chatSubscriptions).toEqual({});
    pendingSubscriptions[1]?.resolve();
    await expect(replacementSubscription).resolves.toBe(true);
    expect(runtime.getState().chatSubscriptions).toEqual({});
  });

  it('clears a stale subscribe error when reconnect reaches a fresh connected snapshot', async () => {
    const stores: SyncStore[] = [];
    let rejectSubscription: ((reason?: unknown) => void) | undefined;
    const supervisor: RuntimeSupervisor = {
      getState: connectedState,
      start: () => stores[0]?.dispatch({ type: 'connection/status', status: 'connected' }),
      stop: () => undefined,
      retryNow: () => undefined,
      subscribe: () => new Promise<void>((_resolve, reject) => { rejectSubscription = reject; }),
      createChat: async () => ({ receipt: { status: 'rejected' as const, code: 'UNUSED', message: 'unused' } }),
      dispatchAction: async () => ({ receipt: { status: 'accepted' as const, value: { acceptedAtSeq: 1 } } }),
    };
    const runtime = new CloudRuntime({
      ...dependencies(supervisor),
      createSupervisor: (options) => {
        if (options.store === undefined) throw new Error('test supervisor requires a sync store');
        stores.push(options.store);
        return supervisor;
      },
    });

    await expect(runtime.actions.connect({ hostUrl: 'https://one.example.test', token: 'token-a', developmentMode: false }, null)).resolves.toEqual({ ok: true });
    const pending = runtime.actions.subscribeChat(chatA);
    rejectSubscription?.(new TransportClosedError(1006, 'socket closed'));
    await expect(pending).resolves.toBe(false);
    expect(runtime.getState().operationError).toMatchObject({ operation: 'subscribe', chatUri: chatA });

    stores[0]?.dispatch({ type: 'connection/status', status: 'reconnecting' });
    expect(runtime.getState().operationError).toBeUndefined();
    stores[0]?.dispatch({ type: 'connection/status', status: 'connected' });
    expect(runtime.getState().operationError).toBeUndefined();
    expect(runtime.getState().chatSubscriptions).toEqual({});
  });
});
