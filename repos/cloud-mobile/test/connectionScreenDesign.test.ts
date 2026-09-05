import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  deriveConnectionMode,
  deriveDevelopmentMode,
  validateConnectionForm,
  type ConnectionFormValues,
} from '../src/features/connection/connectionForm';
import {
  CloudRuntime,
  type CloudRuntimeDependencies,
  type RuntimeSupervisor,
} from '../src/features/runtime/runtimeStore';
import { createConnectionId, type ConnectionId } from '../src/protocol/ids';
import { CLOUD_DESIGN_TOKENS } from '../src/ui/theme/cloudTheme';
import type {
  ConnectionPreferencesCollection,
  HostPreferencesStore,
} from '../src/storage/connectionPreferences';
import type { HostTokenStore, TokenStore } from '../src/storage/secureToken';
import { type SyncStore } from '../src/sync/syncState';

const projectRoot = path.resolve(__dirname, '..');
const connectionScreenPath = path.join(projectRoot, 'src/features/connection/ConnectionScreen.tsx');

function readConnectionScreen(): string {
  return fs.readFileSync(connectionScreenPath, 'utf8');
}

function sourceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) {
    throw new Error(`source markers not found: ${startMarker} -> ${endMarker}`);
  }
  return source.slice(start, end);
}

interface MutableHostPreferencesStore extends HostPreferencesStore {
  current(): ConnectionPreferencesCollection;
}

function createHostPreferencesStore(
  initial: ConnectionPreferencesCollection = { hosts: [] },
): MutableHostPreferencesStore {
  let value = initial;
  return {
    loadHosts: async () => value,
    saveHosts: async (next) => { value = next; },
    selectHost: async (connectionId) => {
      const selectedConnectionId = createConnectionId(String(connectionId));
      value = { ...value, selectedConnectionId };
    },
    current: () => value,
  };
}

type TestTokenStore = TokenStore & HostTokenStore & {
  readonly values: Map<string, string>;
  readonly clearedHostIds: ConnectionId[];
};

function createTokenStore(initial: Record<string, string> = {}): TestTokenStore {
  const values = new Map(Object.entries(initial));
  const clearedHostIds: ConnectionId[] = [];
  return {
    values,
    clearedHostIds,
    read: async () => null,
    write: async () => undefined,
    clear: async () => undefined,
    readForHost: async (connectionId) => values.get(String(connectionId)) ?? null,
    writeForHost: async (connectionId, token) => { values.set(String(connectionId), token); },
    clearForHost: async (connectionId) => {
      const id = createConnectionId(String(connectionId));
      clearedHostIds.push(id);
      values.delete(String(id));
    },
  };
}

interface SupervisorStats {
  startCount: number;
  stopCount: number;
}

function createSupervisor(
  store: SyncStore | undefined,
  stats: SupervisorStats,
): RuntimeSupervisor {
  if (store === undefined) throw new Error('test supervisor requires a sync store');
  return {
    getState: () => store.getState(),
    start: () => {
      stats.startCount += 1;
      store.dispatch({ type: 'connection/status', status: 'connected' });
    },
    stop: () => { stats.stopCount += 1; },
    retryNow: () => undefined,
    subscribe: async () => undefined,
    createChat: async () => { throw new Error('not used'); },
    dispatchAction: async () => { throw new Error('not used'); },
  };
}

function createDependencies(
  hostPreferencesStore: HostPreferencesStore,
  tokenStore: TokenStore,
  stats: SupervisorStats,
): CloudRuntimeDependencies {
  let nextId = 0;
  return {
    asyncStorage: {
      getItem: async () => null,
      setItem: async () => undefined,
      removeItem: async () => undefined,
    },
    tokenStore,
    hostPreferencesStore,
    appState: { currentState: () => 'active', subscribe: () => () => undefined },
    clientId: 'connection-screen-test',
    createId: () => `id-${++nextId}`,
    connectionTimeoutMs: 100,
    createSupervisor: (options) => createSupervisor(options.store, stats),
  };
}

function values(hostUrl: string, token: string): ConnectionFormValues {
  return { hostUrl, token, developmentMode: false };
}

describe('connection settings pure boundaries', () => {
  it('derives development/production mode exclusively from the URL scheme', () => {
    expect(deriveConnectionMode('ws://127.0.0.1:8787')).toBe('development');
    expect(deriveConnectionMode('http://127.0.0.1:8787')).toBe('development');
    expect(deriveConnectionMode('wss://cloud.example.test')).toBe('production');
    expect(deriveConnectionMode('https://cloud.example.test')).toBe('production');
    expect(deriveConnectionMode('ftp://cloud.example.test')).toBeUndefined();

    expect(deriveDevelopmentMode('  WS://127.0.0.1:8787 ')).toBe(true);
    expect(deriveDevelopmentMode('https://cloud.example.test')).toBe(false);

    const secureInput = validateConnectionForm({
      hostUrl: 'https://cloud.example.test',
      token: 'secret',
      developmentMode: true,
    });
    expect(secureInput).toMatchObject({ ok: true, config: { mode: 'production' } });

    const developmentInput = validateConnectionForm({
      hostUrl: 'ws://127.0.0.1:8787',
      token: 'secret',
      developmentMode: false,
    });
    expect(developmentInput).toMatchObject({ ok: true, config: { mode: 'development' } });
  });

});

describe('connection settings source contract', () => {
  it('renders list/detail/edit/new as mutually exclusive screen states', () => {
    const source = readConnectionScreen();
    expect(source).toMatch(/export type ConnectionSettingsView = 'list' \| 'detail' \| 'edit' \| 'new';/u);

    const screenRender = sourceBetween(source, 'return (', '\n}\n\ninterface HostListProps');
    expect(screenRender).toContain("{view === 'list' ? (");
    expect(screenRender).toContain(": view === 'detail' && focusedHost !== undefined ? (");
    expect(screenRender).toContain('<HostList');
    expect(screenRender).toContain('<HostDetail');
    expect(screenRender).toContain('<HostEditor');

    const hostList = sourceBetween(source, 'function HostList(', 'interface HostDetailProps');
    expect(hostList).toContain('host.address');
    expect(hostList).toContain('const selected =');
    expect(hostList).toContain('name="check"');
    expect(hostList).toContain('name="chevron-right"');
    expect(hostList).toContain('testID="connection-add"');
    expect(hostList).not.toContain('host.token');
    expect(hostList).not.toContain('tokenAvailable');
    expect(hostList).not.toContain('tokenAvailability');

    const selector = sourceBetween(source, 'export function selectConnectionScreenState', 'export function formForHost');
    expect(selector).toContain('state.savedConnections.find');
    expect(selector).toContain('selectedHost');
    expect(selector).toContain('tokenAvailability: state.tokenAvailability');

    const hostForm = sourceBetween(source, 'export function formForHost', 'function canKeepStoredToken');
    expect(hostForm).toContain('hostUrl: host.address');
    expect(hostForm).toContain('token: \'\'');
    expect(hostForm).toContain('deriveDevelopmentMode(host.address)');
  });

  it('keeps detail and editor controls aligned with the design states', () => {
    const source = readConnectionScreen();
    const detail = sourceBetween(source, 'function HostDetail(', 'interface HostEditorProps');
    expect(detail).toContain('主机详情');
    expect(detail).toContain('已保护');
    expect(detail).toContain('不会显示明文');
    expect(detail).toContain('testID="connection-delete"');
    expect(detail).toContain('testID="connection-edit"');
    expect(detail).toContain('testID="connection-submit"');

    const editor = sourceBetween(source, 'function HostEditor(', 'interface ReadOnlyFieldProps');
    expect(editor).toContain("editing ? '编辑主机' : '新增主机'");
    expect(editor).toContain('testID="connection-save"');
    expect(editor).toContain('testID="connection-submit"');
    expect(editor).toContain('secureTextEntry');
    expect(editor).toContain('留空则保留已保存的 Token');
    expect(editor).toContain('Token 会安全保存，不会显示在列表中');
  });

  it('uses native back only at the list route boundary and returns nested states to list', () => {
    const source = readConnectionScreen();
    const backHandler = sourceBetween(source, 'const goBack = (): void => {', 'const openDetail =');
    expect(backHandler).toContain("if (view === 'list')");
    expect(backHandler).toContain('router.back();');
    expect(backHandler).toContain('showList();');
    expect(backHandler).not.toContain('router.push');
  });

  it('keeps a failed connection on the settings screen for inline retry', () => {
    const source = readConnectionScreen();
    const connectHandler = sourceBetween(source, 'const connect = async (): Promise<void> => {', 'const requestDelete =');
    expect(connectHandler).toMatch(/if \(!result\.ok\) \{\s*setErrors\(result\.errors\);\s*return;/u);
    const errorIndex = connectHandler.indexOf('setErrors(result.errors);');
    const replaceIndex = connectHandler.indexOf("router.replace('/');");
    expect(errorIndex).toBeGreaterThanOrEqual(0);
    expect(replaceIndex).toBeGreaterThan(errorIndex);
  });

  it('keeps safe-area, font-scaling, and minimum touch-target contracts in the screen', () => {
    const source = readConnectionScreen();
    expect(CLOUD_DESIGN_TOKENS.minTouchTarget).toBeGreaterThanOrEqual(44);
    expect(source).toContain('<SafeAreaView');
    expect(source).toContain('useSafeAreaInsets');
    expect(source).toContain('paddingBottom: Math.max(insets.bottom, 28)');
    expect(source).toContain('width: CLOUD_DESIGN_TOKENS.minTouchTarget');
    expect(source).toContain('height: CLOUD_DESIGN_TOKENS.minTouchTarget');
    expect(source).toContain('allowFontScaling');
    expect(source).toContain('ellipsizeMode="middle"');
    expect(source).toContain('minHeight: 52');
  });
});

describe('connection settings runtime actions', () => {
  it('persists a new Host with scoped credentials without starting a supervisor', async () => {
    const hostStore = createHostPreferencesStore();
    const tokens = createTokenStore();
    const stats: SupervisorStats = { startCount: 0, stopCount: 0 };
    const runtime = new CloudRuntime(createDependencies(hostStore, tokens, stats));

    await runtime.initialize();
    await expect(runtime.actions.saveConnection(values('https://save-only.example.test', 'save-token'), null))
      .resolves.toEqual({ ok: true });

    expect(stats.startCount).toBe(0);
    expect(stats.stopCount).toBe(0);
    expect(runtime.getState().phase).toBe('unconfigured');
    expect(hostStore.current().hosts).toHaveLength(1);
    expect(hostStore.current().hosts[0]).toMatchObject({
      connectionId: 'connection-id-1',
      address: 'wss://save-only.example.test/ws',
      mode: 'production',
    });
    expect(tokens.values.get('connection-id-1')).toBe('save-token');
    expect(JSON.stringify(hostStore.current())).not.toContain('save-token');
    runtime.dispose();
  });

  it('deletes a non-current Host without stopping the current supervisor, then deletes current without replacement', async () => {
    const hostStore = createHostPreferencesStore();
    const tokens = createTokenStore();
    const stats: SupervisorStats = { startCount: 0, stopCount: 0 };
    const runtime = new CloudRuntime(createDependencies(hostStore, tokens, stats));

    await expect(runtime.actions.connect(values('https://one.example.test', 'token-one'), null))
      .resolves.toEqual({ ok: true });
    const currentId = createConnectionId('connection-id-1');
    const nonCurrentId = createConnectionId('connection-two');
    await expect(runtime.actions.saveConnection(
      values('https://two.example.test', 'token-two'),
      nonCurrentId,
    )).resolves.toEqual({ ok: true });
    expect(stats.startCount).toBe(1);
    expect(stats.stopCount).toBe(0);

    await expect(runtime.actions.deleteConnection(nonCurrentId)).resolves.toEqual({ ok: true });
    expect(stats.stopCount).toBe(0);
    expect(tokens.clearedHostIds).toContainEqual(nonCurrentId);
    expect(tokens.values.get(String(currentId))).toBe('token-one');
    expect(runtime.getState()).toMatchObject({
      selectedConnectionId: currentId,
      savedConnection: { connectionId: currentId },
      phase: 'ready',
    });

    await expect(runtime.actions.deleteConnection(currentId)).resolves.toEqual({ ok: true });
    expect(stats.startCount).toBe(1);
    expect(stats.stopCount).toBe(1);
    expect(tokens.clearedHostIds).toContainEqual(currentId);
    expect(tokens.values.has(String(currentId))).toBe(false);
    expect(runtime.getState()).toMatchObject({
      savedConnections: [],
      phase: 'unconfigured',
      tokenAvailable: false,
    });
    expect(runtime.getState().selectedConnectionId).toBeUndefined();
    expect(runtime.getState().savedConnection).toBeUndefined();
    runtime.dispose();
  });
});
