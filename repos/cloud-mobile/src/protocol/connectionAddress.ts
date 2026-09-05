import type { ConnectionConfig, ConnectionMode } from '../domain/types';
import { createConnectionId, type ConnectionId } from './ids';

export { createConnectionId } from './ids';

export interface NormalizeConnectionAddressOptions {
  readonly mode?: ConnectionMode;
  readonly allowInsecure?: boolean;
}

export type ConnectionAddressOptions = ConnectionMode | NormalizeConnectionAddressOptions;

/**
 * Return the security mode implied by a URL scheme without parsing or
 * normalizing the rest of the address. This is intentionally conservative:
 * malformed/unknown schemes return undefined and must still go through URL
 * validation before they can be persisted.
 */
export function connectionModeFromScheme(rawAddress: string): ConnectionMode | undefined {
  const scheme = /^\s*([a-z][a-z\d+.-]*):/iu.exec(rawAddress)?.[1]?.toLowerCase();
  switch (scheme) {
    case 'http':
    case 'ws':
      return 'development';
    case 'https':
    case 'wss':
      return 'production';
    default:
      return undefined;
  }
}

function resolveOptions(options: ConnectionAddressOptions): Required<Pick<NormalizeConnectionAddressOptions, 'mode' | 'allowInsecure'>> {
  if (typeof options === 'string') {
    return { mode: options, allowInsecure: options === 'development' };
  }
  const mode = options.mode ?? 'production';
  return { mode, allowInsecure: options.allowInsecure === true && mode === 'development' };
}

function canonicalPath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/u, '');
  return trimmed === '' ? '/ws' : trimmed;
}

export function normalizeConnectionAddress(
  rawAddress: string,
  options: ConnectionAddressOptions = 'production',
): string {
  if (typeof rawAddress !== 'string' || rawAddress.trim().length === 0) {
    throw new TypeError('connection address is required');
  }

  const { mode, allowInsecure } = resolveOptions(options);
  let parsed: URL;
  try {
    parsed = new URL(rawAddress.trim());
  } catch {
    throw new TypeError('connection address must be a valid URL');
  }

  const isSecure = parsed.protocol === 'https:' || parsed.protocol === 'wss:';
  const isInsecure = parsed.protocol === 'http:' || parsed.protocol === 'ws:';
  if (!isSecure && !(isInsecure && mode === 'development' && allowInsecure)) {
    throw new TypeError('connection address must use https/wss, or explicit development http/ws');
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new TypeError('connection address must not contain credentials');
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new TypeError('connection address must not contain query or fragment data');
  }
  if (parsed.hostname.length === 0) {
    throw new TypeError('connection address host is required');
  }

  const protocol = isSecure ? 'wss:' : 'ws:';
  const path = canonicalPath(parsed.pathname);
  return `${protocol}//${parsed.host}${path}`;
}

export interface ConnectionConfigInput {
  readonly connectionId: ConnectionId | string;
  readonly address: string;
  readonly token: string;
  readonly mode: ConnectionMode;
}

export function normalizeConnectionConfig(input: ConnectionConfigInput): ConnectionConfig {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError('connection config is required');
  }
  if (typeof input.token !== 'string' || input.token.trim().length === 0) {
    throw new TypeError('connection token is required');
  }
  const connectionId = createConnectionId(String(input.connectionId));
  const address = normalizeConnectionAddress(input.address, input.mode);
  return Object.freeze({
    connectionId,
    address,
    token: input.token.trim(),
    mode: input.mode,
  });
}

export function serializeConnectionConfigForLog(config: ConnectionConfig): string {
  return JSON.stringify({
    connectionId: config.connectionId,
    address: config.address,
    mode: config.mode,
    hasToken: config.token.length > 0,
  });
}
