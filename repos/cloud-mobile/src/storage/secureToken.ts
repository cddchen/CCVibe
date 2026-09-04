import { createConnectionId, type ConnectionId } from '../protocol/ids';

export interface SecureStorePort {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

export interface TokenStore {
  read(): Promise<string | null>;
  write(token: string): Promise<void>;
  clear(): Promise<void>;
  /** Optional namespaced methods; absent on legacy injected stores. */
  readForHost?(connectionId: ConnectionId | string): Promise<string | null>;
  writeForHost?(connectionId: ConnectionId | string, token: string): Promise<void>;
  clearForHost?(connectionId: ConnectionId | string): Promise<void>;
}

/**
 * Token operations scoped to one configured Host. The legacy TokenStore
 * methods above remain available for migration from the original single-host
 * build; new runtime code uses these names whenever they are present.
 */
export interface HostTokenStore {
  readForHost(connectionId: ConnectionId | string): Promise<string | null>;
  writeForHost(connectionId: ConnectionId | string, token: string): Promise<void>;
  clearForHost(connectionId: ConnectionId | string): Promise<void>;
}

export type MultiHostTokenStore = TokenStore & HostTokenStore;

const DEFAULT_TOKEN_KEY = 'cloud.host.token';

export function createSecureStoreTokenAdapter(
  secureStore: SecureStorePort,
  key = DEFAULT_TOKEN_KEY,
): MultiHostTokenStore {
  if (key.trim().length === 0) {
    throw new TypeError('SecureStore token key is required');
  }
  const read = (): Promise<string | null> => secureStore.getItemAsync(key);
  const write = async (token: string): Promise<void> => {
    validateToken(token);
    await secureStore.setItemAsync(key, token);
  };
  const clear = (): Promise<void> => secureStore.deleteItemAsync(key);
  const readForHost = (connectionId: ConnectionId | string): Promise<string | null> => (
    secureStore.getItemAsync(hostTokenKey(key, connectionId))
  );
  const writeForHost = async (connectionId: ConnectionId | string, token: string): Promise<void> => {
    validateToken(token);
    await secureStore.setItemAsync(hostTokenKey(key, connectionId), token);
  };
  const clearForHost = (connectionId: ConnectionId | string): Promise<void> => (
    secureStore.deleteItemAsync(hostTokenKey(key, connectionId))
  );
  return Object.freeze({
    read,
    write,
    clear,
    readForHost,
    writeForHost,
    clearForHost,
  });
}

export async function createExpoSecureStoreTokenAdapter(key = DEFAULT_TOKEN_KEY): Promise<MultiHostTokenStore> {
  const secureStore = await import('expo-secure-store');
  return createSecureStoreTokenAdapter(secureStore, key);
}

/**
 * Derives a stable, non-sensitive SecureStore key. Only the opaque local
 * connection id is included; the bearer token is never used in key material,
 * logs, or AsyncStorage values.
 */
export function hostTokenKey(baseKey: string, connectionId: ConnectionId | string): string {
  if (typeof baseKey !== 'string' || baseKey.trim().length === 0) {
    throw new TypeError('SecureStore token key is required');
  }
  const id = String(createConnectionId(String(connectionId)));
  return `${baseKey}.host.${encodeURIComponent(id)}`;
}

function validateToken(token: string): void {
  if (typeof token !== 'string' || token.trim().length === 0) {
    throw new TypeError('connection token is required');
  }
}
