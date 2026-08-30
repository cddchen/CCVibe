import { describe, expect, it } from 'vitest';

import { createSecureStoreTokenAdapter } from '../src/storage/secureToken';
import { createAsyncStorageConnectionPreferencesAdapter } from '../src/storage/connectionPreferences';

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
});
