import { describe, expect, it } from 'vitest';

import { CloudRuntime, type CloudRuntimeDependencies, type RuntimeSupervisor } from '../src/features/runtime/runtimeStore';
import { createConnectionId } from '../src/protocol/ids';
import type { ConnectionPreferencesCollection } from '../src/storage/connectionPreferences';
import { createAsyncStorageHostPreferencesAdapter, type HostPreferencesStore } from '../src/storage/connectionPreferences';
import type { HostTokenStore, TokenStore } from '../src/storage/secureToken';
import type { SyncStore } from '../src/sync/syncState';

function preferencesStore(initial: ConnectionPreferencesCollection = { hosts: [] }) {
  let value = initial;
  return {
    loadHosts: async () => value,
    saveHosts: async (next: ConnectionPreferencesCollection) => { value = next; },
    selectHost: async (connectionId: string) => { value = { ...value, selectedConnectionId: createConnectionId(connectionId) }; },
    current: () => value,
  };
}

function tokenStore(initial: Record<string, string> = {}): TokenStore & HostTokenStore & { readonly values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    read: async () => null,
    write: async () => undefined,
    clear: async () => undefined,
    readForHost: async (connectionId) => values.get(String(connectionId)) ?? null,
    writeForHost: async (connectionId, token) => { values.set(String(connectionId), token); },
    clearForHost: async (connectionId) => { values.delete(String(connectionId)); },
  };
}

function dependencies(
  hostStore: HostPreferencesStore,
  tokens: TokenStore,
  behavior: 'connected' | 'error' = 'connected',
): CloudRuntimeDependencies {
  let next = 0;
  return {
    asyncStorage: {
      getItem: async () => null,
      setItem: async () => undefined,
      removeItem: async () => undefined,
    },
    tokenStore: tokens,
    hostPreferencesStore: hostStore,
    appState: { currentState: () => 'active', subscribe: () => () => undefined },
    connectionTimeoutMs: 100,
    createId: () => `id-${++next}`,
    clientId: 'client-test',
    createSupervisor: (options) => createSupervisor(options.store, behavior),
  };
}

function createSupervisor(store: SyncStore | undefined, behavior: 'connected' | 'error'): RuntimeSupervisor {
  if (store === undefined) throw new Error('test supervisor requires a sync store');
  return {
    getState: () => store.getState(),
    start: () => {
      store.dispatch({ type: 'connection/status', status: behavior, ...(behavior === 'error' ? { errorCode: 'CONNECTION' } : {}) });
    },
    stop: () => undefined,
    retryNow: () => undefined,
    subscribe: async () => undefined,
    createChat: async () => { throw new Error('not used'); },
    dispatchAction: async () => { throw new Error('not used'); },
  };
}

describe('multi-Host runtime connection flow', () => {
  it('restores all Host-scoped composer preferences on initialization', async () => {
    const hosts = preferencesStore({
      hosts: [{
        connectionId: createConnectionId('connection-a'),
        address: 'wss://one.example.test/ws',
        mode: 'production',
        lastWorkspaceId: 'workspace-a',
        lastModelId: 'model-a',
        lastPermissionMode: 'plan',
        lastEffort: 'high',
      }],
      selectedConnectionId: createConnectionId('connection-a'),
    });
    const runtime = new CloudRuntime(dependencies(hosts, tokenStore({ 'connection-a': 'token-a' })));

    await runtime.initialize();

    expect(runtime.getState().selection).toEqual({
      workspaceId: 'workspace-a',
      modelId: 'model-a',
      permissionMode: 'plan',
      effort: 'high',
    });
    runtime.dispose();
  });

  it('reads one Host token through the scoped Runtime action without touching preferences', async () => {
    const hosts = preferencesStore({
      hosts: [{
        connectionId: createConnectionId('connection-a'),
        address: 'wss://one.example.test/ws',
        mode: 'production',
      }],
      selectedConnectionId: createConnectionId('connection-a'),
    });
    const tokens = tokenStore({ 'connection-a': 'token-a' });
    const runtime = new CloudRuntime(dependencies(hosts, tokens));

    await runtime.initialize();

    await expect(runtime.actions.readHostToken('connection-a')).resolves.toBe('token-a');
    expect(JSON.stringify(hosts.current())).not.toContain('token-a');
    runtime.dispose();
  });

  it('propagates scoped token read failures so the editor can show an explicit error', async () => {
    const hosts = preferencesStore({
      hosts: [{
        connectionId: createConnectionId('connection-a'),
        address: 'wss://one.example.test/ws',
        mode: 'production',
      }],
      selectedConnectionId: createConnectionId('connection-a'),
    });
    const tokens = tokenStore();
    tokens.readForHost = async () => { throw new Error('secure store unavailable'); };
    const runtime = new CloudRuntime(dependencies(hosts, tokens));

    await runtime.initialize();

    await expect(runtime.actions.readHostToken('connection-a')).rejects.toThrow('secure store unavailable');
    runtime.dispose();
  });

  it('rejects scoped token reads for an unknown Host id', async () => {
    const runtime = new CloudRuntime(dependencies(preferencesStore(), tokenStore({ 'connection-a': 'token-a' })));

    await runtime.initialize();

    await expect(runtime.actions.readHostToken('connection-a')).rejects.toThrow('connectionId is not configured');
    runtime.dispose();
  });

  it('restores and switches the Host-scoped workspace sort preference', async () => {
    const hosts = preferencesStore({
      hosts: [
        {
          connectionId: createConnectionId('connection-a'),
          address: 'wss://one.example.test/ws',
          mode: 'production',
          lastWorkspaceSortPreference: 'recent_workspace',
        },
        {
          connectionId: createConnectionId('connection-b'),
          address: 'wss://two.example.test/ws',
          mode: 'production',
        },
      ],
      selectedConnectionId: createConnectionId('connection-a'),
    });
    const runtime = new CloudRuntime(dependencies(hosts, tokenStore({ 'connection-a': 'token-a', 'connection-b': 'token-b' })));
    await runtime.initialize();

    expect(runtime.getState().workspaceSortPreference).toBe('recent_workspace');
    await expect(runtime.actions.switchConnection('connection-b')).resolves.toEqual({ ok: true });
    expect(runtime.getState().workspaceSortPreference).toBe('default');
    await expect(runtime.actions.switchConnection('connection-a')).resolves.toEqual({ ok: true });
    expect(runtime.getState().workspaceSortPreference).toBe('recent_workspace');
    runtime.dispose();
  });

  it('persists a workspace sort change and exposes storage failure', async () => {
    const base = preferencesStore({
      hosts: [{
        connectionId: createConnectionId('connection-a'),
        address: 'wss://one.example.test/ws',
        mode: 'production',
      }],
      selectedConnectionId: createConnectionId('connection-a'),
    });
    let failSave = false;
    const hosts: HostPreferencesStore = {
      loadHosts: base.loadHosts,
      selectHost: base.selectHost,
      saveHosts: async (next) => {
        if (failSave) throw new Error('storage unavailable');
        await base.saveHosts(next);
      },
    };
    const runtime = new CloudRuntime(dependencies(hosts, tokenStore({ 'connection-a': 'token-a' })));
    await runtime.initialize();

    await runtime.actions.setWorkspaceSortPreference('recent_workspace');
    expect(runtime.getState().workspaceSortPreference).toBe('recent_workspace');
    expect(base.current().hosts[0]).toMatchObject({ lastWorkspaceSortPreference: 'recent_workspace' });

    failSave = true;
    await runtime.actions.setWorkspaceSortPreference('default');
    expect(runtime.getState().workspaceSortPreference).toBe('default');
    expect(runtime.getState().operationError).toMatchObject({ operation: 'preference', code: 'STORAGE_UNAVAILABLE' });
    runtime.dispose();
  });

  it('keeps composer preferences isolated when switching Hosts', async () => {
    const hosts = preferencesStore({
      hosts: [
        {
          connectionId: createConnectionId('connection-a'),
          address: 'wss://one.example.test/ws',
          mode: 'production',
          lastModelId: 'model-a',
          lastPermissionMode: 'plan',
          lastEffort: 'high',
        },
        {
          connectionId: createConnectionId('connection-b'),
          address: 'wss://two.example.test/ws',
          mode: 'production',
          lastModelId: 'model-b',
          lastPermissionMode: 'default',
          lastEffort: 'low',
        },
      ],
      selectedConnectionId: createConnectionId('connection-a'),
    });
    const runtime = new CloudRuntime(dependencies(hosts, tokenStore({ 'connection-a': 'token-a', 'connection-b': 'token-b' })));
    await runtime.initialize();

    await expect(runtime.actions.switchConnection('connection-b')).resolves.toEqual({ ok: true });
    expect(runtime.getState().selection).toMatchObject({ modelId: 'model-b', permissionMode: 'default', effort: 'low' });

    await expect(runtime.actions.switchConnection('connection-a')).resolves.toEqual({ ok: true });
    expect(runtime.getState().selection).toMatchObject({ modelId: 'model-a', permissionMode: 'plan', effort: 'high' });
    runtime.dispose();
  });

  it('persists setter changes as a complete selection and removes a cleared default effort', async () => {
    const hosts = preferencesStore({
      hosts: [{
        connectionId: createConnectionId('connection-a'),
        address: 'wss://one.example.test/ws',
        mode: 'production',
        lastModelId: 'model-a',
        lastPermissionMode: 'plan',
        lastEffort: 'high',
        lastWorkspaceSortPreference: 'recent_workspace',
      }],
      selectedConnectionId: createConnectionId('connection-a'),
    });
    const runtime = new CloudRuntime(dependencies(hosts, tokenStore({ 'connection-a': 'token-a' })));
    await runtime.initialize();

    runtime.actions.setPermissionMode('default');
    runtime.actions.setModel('model-b');
    runtime.actions.setEffort(undefined);
    await Promise.resolve();

    expect(hosts.current().hosts[0]).toMatchObject({
      lastModelId: 'model-b',
      lastPermissionMode: 'default',
      lastWorkspaceSortPreference: 'recent_workspace',
    });
    expect(hosts.current().hosts[0]).not.toHaveProperty('lastEffort');
    runtime.dispose();
  });

  it('migrates the legacy token into the selected Host namespace on initialization', async () => {
    const values = new Map<string, string>([
      ['cloud.connection.preferences', JSON.stringify({
        connectionId: 'connection-legacy',
        address: 'https://legacy.example.test',
        mode: 'production',
      })],
    ]);
    const storage = {
      getItem: async (key: string) => values.get(key) ?? null,
      setItem: async (key: string, value: string) => { values.set(key, value); },
      removeItem: async (key: string) => { values.delete(key); },
    };
    const hostStore = createAsyncStorageHostPreferencesAdapter(storage);
    const tokens = tokenStore();
    let legacy = 'legacy-token';
    const migrationTokens: TokenStore & HostTokenStore = {
      ...tokens,
      read: async () => legacy,
      clear: async () => { legacy = ''; },
    };
    const runtime = new CloudRuntime({
      ...dependencies(hostStore, migrationTokens),
      createSupervisor: (options) => createSupervisor(options.store, 'connected'),
    });

    await runtime.initialize();
    expect(runtime.getState().selectedConnectionId).toBe('connection-legacy');
    expect(tokens.values.get('connection-legacy')).toBe('legacy-token');
    expect(legacy).toBe('');
    runtime.dispose();
  });

  it('waits for a connected supervisor before reporting success and stores a Host token by id', async () => {
    const hosts = preferencesStore();
    const tokens = tokenStore();
    const runtime = new CloudRuntime(dependencies(hosts, tokens));

    const result = await runtime.actions.connect({
      hostUrl: 'https://one.example.test',
      token: 'token-one',
      developmentMode: false,
    }, null);

    expect(result).toEqual({ ok: true });
    expect(runtime.getState().selectedConnectionId).toBe('connection-id-1');
    expect(runtime.getState().savedConnections).toHaveLength(1);
    expect(tokens.values.get('connection-id-1')).toBe('token-one');
  });

  it('fences the old supervisor when switching Host and reports failed initialization', async () => {
    const hosts = preferencesStore();
    const tokens = tokenStore({ 'connection-a': 'token-a', 'connection-b': 'token-b' });
    let stopCount = 0;
    const dependencySet = dependencies(hosts, tokens);
    const runtime = new CloudRuntime({
      ...dependencySet,
      createSupervisor: (options) => {
        const supervisor = createSupervisor(options.store, 'connected');
        return { ...supervisor, stop: () => { stopCount += 1; } };
      },
    });

    await runtime.actions.connect({ hostUrl: 'https://one.example.test', token: 'token-a', developmentMode: false }, 'connection-a');
    await runtime.actions.connect({ hostUrl: 'https://two.example.test', token: 'token-b', developmentMode: false }, 'connection-b');
    expect(stopCount).toBe(1);
    expect(runtime.getState().selectedConnectionId).toBe('connection-b');

    const failing = new CloudRuntime({
      ...dependencies(preferencesStore(), tokenStore()),
      createSupervisor: (options) => createSupervisor(options.store, 'error'),
    });
    const result = await failing.actions.connect({ hostUrl: 'https://failed.example.test', token: 'token-failed', developmentMode: false }, null);
    expect(result.ok).toBe(false);
    expect(failing.getState().operationError?.code).toBe('CONNECTION');
    expect(failing.getState().savedConnections).toHaveLength(1);
  });

  it('switches to the selected Host only after its own token and connection succeed', async () => {
    const hosts = preferencesStore({
      hosts: [
        { connectionId: createConnectionId('connection-a'), address: 'wss://one.example.test/ws', mode: 'production' },
        { connectionId: createConnectionId('connection-b'), address: 'wss://two.example.test/ws', mode: 'production' },
      ],
      selectedConnectionId: createConnectionId('connection-a'),
    });
    const tokens = tokenStore({ 'connection-a': 'token-a', 'connection-b': 'token-b' });
    let stopCount = 0;
    const runtime = new CloudRuntime({
      ...dependencies(hosts, tokens),
      createSupervisor: (options) => {
        const supervisor = createSupervisor(options.store, 'connected');
        return { ...supervisor, stop: () => { stopCount += 1; } };
      },
    });
    await runtime.initialize();

    await expect(runtime.actions.switchConnection('connection-b')).resolves.toEqual({ ok: true });
    expect(stopCount).toBe(1);
    expect(runtime.getState().selectedConnectionId).toBe('connection-b');
    expect(hosts.current().selectedConnectionId).toBe('connection-b');
    runtime.dispose();
  });

  it('stops the previous Host when the selected Host has no token', async () => {
    const hosts = preferencesStore({
      hosts: [
        { connectionId: createConnectionId('connection-a'), address: 'wss://one.example.test/ws', mode: 'production' },
        { connectionId: createConnectionId('connection-b'), address: 'wss://two.example.test/ws', mode: 'production' },
      ],
      selectedConnectionId: createConnectionId('connection-a'),
    });
    const tokens = tokenStore({ 'connection-a': 'token-a' });
    let stopCount = 0;
    const runtime = new CloudRuntime({
      ...dependencies(hosts, tokens),
      createSupervisor: (options) => {
        const supervisor = createSupervisor(options.store, 'connected');
        return { ...supervisor, stop: () => { stopCount += 1; } };
      },
    });
    await runtime.initialize();

    await expect(runtime.actions.switchConnection('connection-b')).resolves.toEqual({
      ok: false,
      errors: { token: '请输入该 Host 的 Token' },
    });
    expect(stopCount).toBe(1);
    expect(runtime.getState()).toMatchObject({
      selectedConnectionId: 'connection-b',
      tokenAvailable: false,
      phase: 'unconfigured',
    });
    runtime.dispose();
  });
});
