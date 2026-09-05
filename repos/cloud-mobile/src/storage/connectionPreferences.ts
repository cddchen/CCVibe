import { z } from 'zod';

import type { ConnectionConfig, ConnectionMode } from '../domain/types';
import { createConnectionId, type ConnectionId } from '../protocol/ids';
import { connectionModeFromScheme, normalizeConnectionAddress } from '../protocol/connectionAddress';

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

/**
 * Non-sensitive preferences for every Host configured on this device.
 * Tokens intentionally do not have a field in this type and are stored by
 * the SecureStore adapter using the connectionId as the namespace.
 */
export interface ConnectionPreferencesCollection {
  readonly hosts: readonly ConnectionPreferences[];
  readonly selectedConnectionId?: ConnectionId;
}

/** Store contract for the multi-Host preferences format. */
export interface HostPreferencesStore {
  loadHosts(): Promise<ConnectionPreferencesCollection>;
  saveHosts(collection: ConnectionPreferencesCollection): Promise<void>;
  selectHost(connectionId: ConnectionId | string): Promise<void>;
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
const DEFAULT_HOSTS_PREFERENCES_KEY = 'cloud.connection.hosts';
const storedPreferencesSchema = z.object({
  connectionId: z.string().min(1),
  address: z.string().min(1),
  mode: z.enum(['development', 'production']),
  lastWorkspaceId: z.string().min(1).optional(),
  lastModelId: z.string().min(1).optional(),
}).strict();

const storedHostsSchema = z.object({
  // Version is optional on read so an early development build that wrote the
  // collection without a version can still be upgraded in place.
  version: z.literal(1).optional(),
  selectedConnectionId: z.string().min(1).optional(),
  hosts: z.array(storedPreferencesSchema),
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

/**
 * Creates the versioned Host-list adapter.
 *
 * The old single-connection record remains a migration input. It is never
 * interpreted as a token-bearing record; the token migration is coordinated
 * by CloudRuntime because only that layer owns both stores.
 */
export function createAsyncStorageHostPreferencesAdapter(
  storage: AsyncStoragePort,
  options: { readonly key?: string; readonly legacyKey?: string } | string = {},
): HostPreferencesStore & ConnectionPreferencesStore {
  const key = typeof options === 'string' ? options : options.key ?? DEFAULT_HOSTS_PREFERENCES_KEY;
  const legacyKey = typeof options === 'string' ? DEFAULT_PREFERENCES_KEY : options.legacyKey ?? DEFAULT_PREFERENCES_KEY;
  if (key.trim().length === 0) throw new TypeError('AsyncStorage Host preferences key is required');
  if (legacyKey.trim().length === 0) throw new TypeError('AsyncStorage legacy preferences key is required');

  const loadHosts = async (): Promise<ConnectionPreferencesCollection> => {
    const current = await readCollection(storage, key);
    if (current !== null) return current;

    const legacy = await readLegacyPreferences(storage, legacyKey);
    if (legacy === null) return emptyCollection();
    const migrated = Object.freeze({
      hosts: Object.freeze([legacy]),
      selectedConnectionId: legacy.connectionId,
    });
    // Keep the legacy value until a later successful save. This makes a
    // migration recoverable if the process is terminated between writes.
    await writeCollection(storage, key, migrated);
    return migrated;
  };

  const saveHosts = async (collection: ConnectionPreferencesCollection): Promise<void> => {
    await writeCollection(storage, key, normalizeCollection(collection));
  };

  const selectHost = async (connectionId: ConnectionId | string): Promise<void> => {
    const current = await loadHosts();
    const selected = createConnectionId(String(connectionId));
    if (!current.hosts.some((host) => host.connectionId === selected)) {
      throw new TypeError('connectionId is not configured');
    }
    await saveHosts({ ...current, selectedConnectionId: selected });
  };

  return Object.freeze({
    loadHosts,
    saveHosts,
    selectHost,
    // These three methods retain the old adapter surface for callers that
    // only know about one selected connection.
    load: async () => {
      const collection = await loadHosts();
      return collection.hosts.find((host) => host.connectionId === collection.selectedConnectionId)
        ?? collection.hosts[0]
        ?? null;
    },
    save: async (config: ConnectionConfig | ConnectionPreferences | ConnectionPreferencesInput) => {
      const current = await loadHosts();
      const preferences = normalizePreferences(config);
      const hosts = upsertHost(current.hosts, preferences);
      await saveHosts({ hosts, selectedConnectionId: preferences.connectionId });
    },
    clear: async () => {
      await storage.removeItem(key);
      await storage.removeItem(legacyKey);
    },
  });
}

function emptyCollection(): ConnectionPreferencesCollection {
  return Object.freeze({ hosts: Object.freeze([]) });
}

async function readCollection(
  storage: AsyncStoragePort,
  key: string,
): Promise<ConnectionPreferencesCollection | null> {
  const encoded = await storage.getItem(key);
  if (encoded === null) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(encoded) as unknown;
  } catch {
    return null;
  }
  const parsed = storedHostsSchema.safeParse(decoded);
  if (!parsed.success) return null;
  try {
    return normalizeCollection({
      hosts: parsed.data.hosts.map((host) => ({
        connectionId: createConnectionId(host.connectionId),
        address: host.address,
        mode: host.mode,
        ...(host.lastWorkspaceId === undefined ? {} : { lastWorkspaceId: host.lastWorkspaceId }),
        ...(host.lastModelId === undefined ? {} : { lastModelId: host.lastModelId }),
      })),
      ...(parsed.data.selectedConnectionId === undefined
        ? {}
        : { selectedConnectionId: createConnectionId(parsed.data.selectedConnectionId) }),
    });
  } catch {
    return null;
  }
}

async function readLegacyPreferences(
  storage: AsyncStoragePort,
  key: string,
): Promise<ConnectionPreferences | null> {
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
}

function normalizeCollection(collection: ConnectionPreferencesCollection): ConnectionPreferencesCollection {
  const hosts: ConnectionPreferences[] = [];
  const seen = new Set<ConnectionId>();
  for (const host of collection.hosts) {
    const normalized = normalizePreferences(host);
    if (seen.has(normalized.connectionId)) continue;
    seen.add(normalized.connectionId);
    hosts.push(normalized);
  }
  const selected = collection.selectedConnectionId === undefined
    ? hosts[0]?.connectionId
    : createConnectionId(String(collection.selectedConnectionId));
  return Object.freeze({
    hosts: Object.freeze(hosts),
    ...(selected !== undefined && hosts.some((host) => host.connectionId === selected)
      ? { selectedConnectionId: selected }
      : {}),
  });
}

async function writeCollection(
  storage: AsyncStoragePort,
  key: string,
  collection: ConnectionPreferencesCollection,
): Promise<void> {
  const normalized = normalizeCollection(collection);
  await storage.setItem(key, JSON.stringify({
    version: 1,
    hosts: normalized.hosts.map((host) => ({
      connectionId: host.connectionId,
      address: host.address,
      mode: host.mode,
      ...(host.lastWorkspaceId === undefined ? {} : { lastWorkspaceId: host.lastWorkspaceId }),
      ...(host.lastModelId === undefined ? {} : { lastModelId: host.lastModelId }),
    })),
    ...(normalized.selectedConnectionId === undefined ? {} : { selectedConnectionId: normalized.selectedConnectionId }),
  }));
}

function upsertHost(
  hosts: readonly ConnectionPreferences[],
  host: ConnectionPreferences,
): readonly ConnectionPreferences[] {
  const index = hosts.findIndex((candidate) => candidate.connectionId === host.connectionId);
  if (index < 0) return Object.freeze([...hosts, host]);
  const next = [...hosts];
  next[index] = host;
  return Object.freeze(next);
}

function normalizePreferences(config: ConnectionConfig | ConnectionPreferences | ConnectionPreferencesInput): ConnectionPreferences {
  // The scheme is the source of truth now that the settings UI intentionally
  // hides the development toggle. This also repairs older records whose mode
  // drifted from their persisted address while retaining a fallback for
  // malformed input that will be rejected by address normalization below.
  const mode = connectionModeFromScheme(config.address) ?? config.mode;
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
