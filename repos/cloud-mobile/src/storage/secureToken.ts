export interface SecureStorePort {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

export interface TokenStore {
  read(): Promise<string | null>;
  write(token: string): Promise<void>;
  clear(): Promise<void>;
}

const DEFAULT_TOKEN_KEY = 'cloud.host.token';

export function createSecureStoreTokenAdapter(
  secureStore: SecureStorePort,
  key = DEFAULT_TOKEN_KEY,
): TokenStore {
  if (key.trim().length === 0) {
    throw new TypeError('SecureStore token key is required');
  }
  return Object.freeze({
    read: () => secureStore.getItemAsync(key),
    write: async (token: string) => {
      if (typeof token !== 'string' || token.trim().length === 0) {
        throw new TypeError('connection token is required');
      }
      await secureStore.setItemAsync(key, token);
    },
    clear: () => secureStore.deleteItemAsync(key),
  });
}

export async function createExpoSecureStoreTokenAdapter(key = DEFAULT_TOKEN_KEY): Promise<TokenStore> {
  const secureStore = await import('expo-secure-store');
  return createSecureStoreTokenAdapter(secureStore, key);
}
