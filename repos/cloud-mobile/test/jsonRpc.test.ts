import { describe, expect, it } from 'vitest';

import {
  encodeJsonRpcEnvelope,
  parseJsonRpcEnvelope,
} from '../src/protocol/jsonRpc';

describe('strict JSON-RPC envelope codec', () => {
  it('parses a valid request and keeps structured params', () => {
    const result = parseJsonRpcEnvelope(
      '{"jsonrpc":"2.0","id":"request-1","method":"catalog/get","params":{"channel":"agent-root://"}}',
    );

    expect(result).toEqual({
      ok: true,
      value: {
        jsonrpc: '2.0',
        id: 'request-1',
        method: 'catalog/get',
        params: { channel: 'agent-root://' },
      },
    });
  });

  it('rejects malformed input, unknown envelope fields, and duplicate keys', () => {
    expect(parseJsonRpcEnvelope('{')).toEqual({
      ok: false,
      error: { kind: 'parse_error', code: -32700, message: 'Parse error' },
    });
    expect(parseJsonRpcEnvelope({
      jsonrpc: '2.0',
      id: 1,
      method: 'catalog/get',
      unexpected: true,
    })).toEqual({
      ok: false,
      error: { kind: 'invalid_request', code: -32600, message: 'Invalid Request' },
    });
    expect(parseJsonRpcEnvelope(
      '{"jsonrpc":"2.0","id":1,"method":"catalog/get","id":2}',
    )).toEqual({
      ok: false,
      error: { kind: 'invalid_request', code: -32600, message: 'Invalid Request' },
    });
  });

  it('round-trips a response and rejects non-JSON-RPC payloads', () => {
    const encoded = encodeJsonRpcEnvelope({
      jsonrpc: '2.0',
      id: 7,
      result: { ok: true },
    });

    expect(parseJsonRpcEnvelope(encoded)).toEqual({
      ok: true,
      value: { jsonrpc: '2.0', id: 7, result: { ok: true } },
    });
    expect(parseJsonRpcEnvelope(null)).toEqual({
      ok: false,
      error: { kind: 'invalid_request', code: -32600, message: 'Invalid Request' },
    });
  });
});
