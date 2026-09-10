import { describe, expect, it } from 'vitest';

import { createSecureStoreTokenAdapter } from '../src/storage/secureToken';
import {
  createAsyncStorageConnectionPreferencesAdapter,
  createAsyncStorageHostPreferencesAdapter,
} from '../src/storage/connectionPreferences';
import { createConnectionId } from '../src/protocol/ids';

describe('mobile storage adapters', () => {
  it('uses only the SecureStore port for token reads and writes', async () => {
    const values = new Map<string, string>();
    const calls: string[] = [];
    const tokenStore = createSecureStoreTokenAdapter({
      getItemAsync: async (key) => { calls.push(`get:${key}`); return values.get(key) ?? null; },
      setItemAsync: async (key, value) => { calls.push(`set:${key}`); values.set(key, value); },
      deleteItemAsync: async (key) => { calls.push(`delete:${key}`); values.delete(key); },
    }, 'cloud-token');

    await tokenStore.write('secret-token');
    await expect(tokenStore.read()).resolves.toBe('secret-token');
    await tokenStore.clear();
    expect(calls).toEqual(['set:cloud-token', 'get:cloud-token', 'delete:cloud-token']);
  });

  it('persists only non-sensitive connection preferences through AsyncStorage', async () => {
    let stored: string | null = null;
    const preferences = createAsyncStorageConnectionPreferencesAdapter({
      getItem: async () => stored,
      setItem: async (_key, value) => { stored = value; },
      removeItem: async () => { stored = null; },
    }, 'cloud-preferences');

    await preferences.save({
      connectionId: 'connection-a',
      address: 'https://cloud.example.test',
      mode: 'production',
      token: 'must-not-persist',
    });

    expect(stored).not.toContain('must-not-persist');
    expect(await preferences.load()).toEqual({
      connectionId: 'connection-a',
      address: 'wss://cloud.example.test/ws',
      mode: 'production',
    });
  });

  it('persists the three Host-scoped composer preferences and restores them after a reload', async () => {
    let stored: string | null = null;
    const preferences = createAsyncStorageConnectionPreferencesAdapter({
      getItem: async () => stored,
      setItem: async (_key, value) => { stored = value; },
      removeItem: async () => { stored = null; },
    }, 'cloud-preferences');

    await preferences.save({
      connectionId: 'connection-a',
      address: 'https://cloud.example.test',
      mode: 'production',
      lastModelId: 'model-a',
      lastPermissionMode: 'plan',
      lastEffort: 'high',
    });

    expect(await preferences.load()).toEqual({
      connectionId: 'connection-a',
      address: 'wss://cloud.example.test/ws',
      mode: 'production',
      lastModelId: 'model-a',
      lastPermissionMode: 'plan',
      lastEffort: 'high',
    });
  });

  it('persists the Host-scoped workspace sort preference', async () => {
    let stored: string | null = null;
    const preferences = createAsyncStorageConnectionPreferencesAdapter({
      getItem: async () => stored,
      setItem: async (_key, value) => { stored = value; },
      removeItem: async () => { stored = null; },
    }, 'cloud-preferences');

    await preferences.save({
      connectionId: 'connection-a',
      address: 'https://cloud.example.test',
      mode: 'production',
      lastWorkspaceSortPreference: 'recent_workspace',
    });

    expect(await preferences.load()).toEqual({
      connectionId: 'connection-a',
      address: 'wss://cloud.example.test/ws',
      mode: 'production',
      lastWorkspaceSortPreference: 'recent_workspace',
    });
  });

  it('accepts version 1 Host records without a sort field for Runtime defaulting', async () => {
    const values = new Map<string, string>([
      ['cloud.connection.hosts', JSON.stringify({
        version: 1,
        hosts: [{
          connectionId: 'connection-a',
          address: 'https://cloud.example.test',
          mode: 'production',
        }],
        selectedConnectionId: 'connection-a',
      })],
    ]);
    const storage = {
      getItem: async (key: string) => values.get(key) ?? null,
      setItem: async (key: string, value: string) => { values.set(key, value); },
      removeItem: async (key: string) => { values.delete(key); },
    };
    const hosts = createAsyncStorageHostPreferencesAdapter(storage);

    await expect(hosts.loadHosts()).resolves.toMatchObject({
      hosts: [{ connectionId: 'connection-a' }],
      selectedConnectionId: 'connection-a',
    });
    expect((await hosts.loadHosts()).hosts[0]).not.toHaveProperty('lastWorkspaceSortPreference');
  });

  it('migrates the legacy single Host record into a selected Host collection', async () => {
    const values = new Map<string, string>([
      ['cloud.connection.preferences', JSON.stringify({
        connectionId: 'connection-old',
        address: 'https://old.example.test',
        mode: 'production',
        lastWorkspaceId: 'workspace-old',
      })],
    ]);
    const storage = {
      getItem: async (key: string) => values.get(key) ?? null,
      setItem: async (key: string, value: string) => { values.set(key, value); },
      removeItem: async (key: string) => { values.delete(key); },
    };

    const hosts = createAsyncStorageHostPreferencesAdapter(storage);
    await expect(hosts.loadHosts()).resolves.toEqual({
      hosts: [{
        connectionId: 'connection-old',
        address: 'wss://old.example.test/ws',
        mode: 'production',
        lastWorkspaceId: 'workspace-old',
      }],
      selectedConnectionId: 'connection-old',
    });
    expect(values.get('cloud.connection.hosts')).toContain('connection-old');
    expect(values.get('cloud.connection.hosts')).not.toContain('token');
  });

  it('keeps composer preferences isolated per Host and allows the default effort to clear', async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: async (key: string) => values.get(key) ?? null,
      setItem: async (key: string, value: string) => { values.set(key, value); },
      removeItem: async (key: string) => { values.delete(key); },
    };
    const hosts = createAsyncStorageHostPreferencesAdapter(storage);

    await hosts.saveHosts({
      hosts: [
        {
          connectionId: createConnectionId('connection-a'),
          address: 'https://a.example.test',
          mode: 'production',
          lastModelId: 'model-a',
          lastPermissionMode: 'plan',
          lastEffort: 'high',
        },
        {
          connectionId: createConnectionId('connection-b'),
          address: 'https://b.example.test',
          mode: 'production',
          lastModelId: 'model-b',
          lastPermissionMode: 'default',
        },
      ],
      selectedConnectionId: createConnectionId('connection-a'),
    });

    expect((await hosts.loadHosts()).hosts[1]).toMatchObject({
      connectionId: 'connection-b',
      lastModelId: 'model-b',
      lastPermissionMode: 'default',
    });
    expect((await hosts.loadHosts()).hosts[1]).not.toHaveProperty('lastEffort');

    await hosts.saveHosts({
      hosts: [{
        connectionId: createConnectionId('connection-a'),
        address: 'https://a.example.test',
        mode: 'production',
        lastModelId: 'model-a',
        lastPermissionMode: 'plan',
      }],
      selectedConnectionId: createConnectionId('connection-a'),
    });
    expect((await hosts.loadHosts()).hosts[0]).not.toHaveProperty('lastEffort');
  });

  it('keeps Host tokens in separate SecureStore namespaces', async () => {
    const values = new Map<string, string>();
    const calls: string[] = [];
    const tokenStore = createSecureStoreTokenAdapter({
      getItemAsync: async (key) => { calls.push(`get:${key}`); return values.get(key) ?? null; },
      setItemAsync: async (key, value) => { calls.push(`set:${key}`); values.set(key, value); },
      deleteItemAsync: async (key) => { calls.push(`delete:${key}`); values.delete(key); },
    });

    await tokenStore.writeForHost('connection-a', 'token-a');
    await tokenStore.writeForHost('connection-b', 'token-b');
    await expect(tokenStore.readForHost('connection-a')).resolves.toBe('token-a');
    await expect(tokenStore.readForHost('connection-b')).resolves.toBe('token-b');
    expect([...values.keys()]).toEqual([
      'cloud.host.token.host.connection-a',
      'cloud.host.token.host.connection-b',
    ]);
    expect([...values.keys()].join('|')).not.toContain('token-a');
    expect([...values.keys()].join('|')).not.toContain('token-b');
  });
});
