import { describe, expect, it } from 'vitest';

import {
  createConnectionId,
  normalizeConnectionAddress,
  normalizeConnectionConfig,
  serializeConnectionConfigForLog,
} from '../src/protocol/connectionAddress';

describe('connection address contract', () => {
  it('normalizes secure web addresses to websocket addresses', () => {
    expect(normalizeConnectionAddress('https://Cloud.Example.com///', 'production')).toBe(
      'wss://cloud.example.com/ws',
    );
    expect(normalizeConnectionAddress('wss://cloud.example.com/agent/', 'production')).toBe(
      'wss://cloud.example.com/agent',
    );
  });

  it('allows ws only when development mode is explicit', () => {
    expect(normalizeConnectionAddress('http://127.0.0.1:8787/', 'development')).toBe(
      'ws://127.0.0.1:8787/ws',
    );
    expect(() => normalizeConnectionAddress('ws://127.0.0.1:8787', 'production')).toThrow();
  });

  it('rejects credentials and query strings so tokens cannot enter URLs', () => {
    expect(() => normalizeConnectionAddress('https://user:pass@cloud.example.com', 'production')).toThrow();
    expect(() => normalizeConnectionAddress('https://cloud.example.com?token=secret', 'production')).toThrow();
  });

  it('redacts bearer tokens from serialized connection diagnostics', () => {
    const token = 'bearer-secret-value';
    const config = normalizeConnectionConfig({
      connectionId: createConnectionId('connection-1'),
      address: 'https://cloud.example.com',
      token,
      mode: 'production',
    });

    expect(config.address).toBe('wss://cloud.example.com/ws');
    expect(config.address).not.toContain(token);
    expect(serializeConnectionConfigForLog(config)).not.toContain(token);
  });
});
