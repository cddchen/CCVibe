import { z } from 'zod';

import type { ConnectionConfig, ConnectionMode } from '../domain/types';
import { createConnectionId, type ConnectionId } from '../protocol/ids';
import { normalizeConnectionAddress } from '../protocol/connectionAddress';

export interface AsyncStoragePort {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface ConnectionPreferences {
  readonly connectionId: ConnectionId;
  readonly address: string;
  readonly mode: ConnectionMode;
  readonly lastWorkspaceId?: string;
  readonly lastModelId?: string;
}

export interface ConnectionPreferencesStore {
  load(): Promise<ConnectionPreferences | null>;
  save(config: ConnectionConfig | ConnectionPreferences | ConnectionPreferencesInput): Promise<void>;
  clear(): Promise<void>;
}

export interface ConnectionPreferencesInput {
  readonly connectionId: ConnectionId | string;
  readonly address: string;
  readonly mode: ConnectionMode;
  readonly lastWorkspaceId?: string;
  readonly lastModelId?: string;
  /** Accepted for boundary compatibility, but deliberately never persisted. */
  readonly token?: string;
}

const DEFAULT_PREFERENCES_KEY = 'cloud.connection.preferences';
const storedPreferencesSchema = z.object({
  connectionId: z.string().min(1),
  address: z.string().min(1),
  mode: z.enum(['development', 'production']),
  lastWorkspaceId: z.string().min(1).optional(),
  lastModelId: z.string().min(1).optional(),
}).strict();

export function createAsyncStorageConnectionPreferencesAdapter(
  storage: AsyncStoragePort,
  key = DEFAULT_PREFERENCES_KEY,
): ConnectionPreferencesStore {
  if (key.trim().length === 0) {
    throw new TypeError('AsyncStorage preferences key is required');
  }
  return Object.freeze({
    load: async () => {
      const encoded = await storage.getItem(key);
      if (encoded === null) return null;
      let decoded: unknown;
      try {
        decoded = JSON.parse(encoded) as unknown;
      } catch {
        return null;
      }
      const parsed = storedPreferencesSchema.safeParse(decoded);
      if (!parsed.success) return null;
      try {
        return Object.freeze({
          connectionId: createConnectionId(parsed.data.connectionId),
          address: normalizeConnectionAddress(parsed.data.address, parsed.data.mode),
          mode: parsed.data.mode,
          ...(parsed.data.lastWorkspaceId === undefined ? {} : { lastWorkspaceId: parsed.data.lastWorkspaceId }),
          ...(parsed.data.lastModelId === undefined ? {} : { lastModelId: parsed.data.lastModelId }),
        });
      } catch {
        return null;
      }
    },
    save: async (config: ConnectionConfig | ConnectionPreferences | ConnectionPreferencesInput) => {
      const preferences = normalizePreferences(config);
      await storage.setItem(key, JSON.stringify({
        connectionId: preferences.connectionId,
        address: preferences.address,
        mode: preferences.mode,
        ...(preferences.lastWorkspaceId === undefined ? {} : { lastWorkspaceId: preferences.lastWorkspaceId }),
        ...(preferences.lastModelId === undefined ? {} : { lastModelId: preferences.lastModelId }),
      }));
    },
    clear: () => storage.removeItem(key),
  });
}

function normalizePreferences(config: ConnectionConfig | ConnectionPreferences | ConnectionPreferencesInput): ConnectionPreferences {
  const mode = config.mode;
  const lastWorkspaceId = 'lastWorkspaceId' in config ? config.lastWorkspaceId : undefined;
  const lastModelId = 'lastModelId' in config ? config.lastModelId : undefined;
  return Object.freeze({
    connectionId: createConnectionId(String(config.connectionId)),
    address: normalizeConnectionAddress(config.address, mode),
    mode,
    ...(lastWorkspaceId === undefined ? {} : { lastWorkspaceId }),
    ...(lastModelId === undefined ? {} : { lastModelId }),
  });
}
