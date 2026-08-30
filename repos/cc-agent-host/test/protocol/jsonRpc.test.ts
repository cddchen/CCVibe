import { describe, expect, it } from 'vitest';

import {
  errorResponse,
  JSON_RPC_ERRORS,
  MAX_JSON_FRAME_BYTES,
  notification,
  parseJsonRpcMessage,
  parseJsonRpcNotification,
  successResponse,
} from '../../src/index.js';

function expectError(value: unknown, code: number): void {
  expect(value).toMatchObject({ jsonrpc: '2.0', id: null, error: { code } });
}

describe('JSON-RPC contracts', () => {
  it('parses a request and constructs pure responses and notifications', () => {
    const params = { value: 'safe' };
    const parsed = parseJsonRpcMessage(JSON.stringify({ jsonrpc: '2.0', id: 'request-1', method: 'test', params }));

    expect(parsed).toEqual({ jsonrpc: '2.0', id: 'request-1', method: 'test', params });
    expect(successResponse(7, { accepted: true })).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { accepted: true },
    });
    expect(errorResponse('request-1', JSON_RPC_ERRORS.InvalidParams)).toEqual({
      jsonrpc: '2.0',
      id: 'request-1',
      error: { code: -32602, message: 'Invalid params' },
    });
    expect(notification('state/action', { serverSeq: 3 })).toEqual({
      jsonrpc: '2.0',
      method: 'state/action',
      params: { serverSeq: 3 },
    });
    expect(parseJsonRpcNotification('{"jsonrpc":"2.0","method":"state/action"}')).toEqual({
      jsonrpc: '2.0',
      method: 'state/action',
    });
  });

  it('returns a safe parse error for malformed JSON without echoing input', () => {
    const parsed = parseJsonRpcMessage('{"jsonrpc":"2.0","id":1,"method":"dispatchAction","params":{"prompt":"secret prompt"}');

    expectError(parsed, -32700);
    expect(JSON.stringify(parsed)).not.toContain('secret prompt');
    expect(JSON.stringify(parsed)).not.toContain('SyntaxError');
  });

  it('rejects invalid envelopes, unknown keys, duplicate keys, and non-request ids', () => {
    const invalidEnvelopes = [
      '{"jsonrpc":"2.0","id":1,"method":"test","extra":"secret"}',
      '{"jsonrpc":"1.0","id":1,"method":"test"}',
      '{"jsonrpc":"2.0","id":true,"method":"test"}',
      '{"jsonrpc":"2.0","id":null,"method":"test"}',
      '{"jsonrpc":"2.0","id":1,"method":"test","params":null}',
      '{"jsonrpc":"2.0","id":1,"method":"test","jsonrpc":"2.0"}',
    ];

    for (const raw of invalidEnvelopes) {
      const parsed = parseJsonRpcMessage(raw);
      expectError(parsed, -32600);
      expect(JSON.stringify(parsed)).not.toContain('secret');
    }

    const notification = parseJsonRpcMessage('{"jsonrpc":"2.0","method":"client/notification"}');
    expectError(notification, -32600);
  });

  it('rejects frames beyond the documented UTF-8 limit', () => {
    const oversized = `{"jsonrpc":"2.0","id":1,"method":"test","params":{"value":"${'x'.repeat(MAX_JSON_FRAME_BYTES)}"}}`;
    const parsed = parseJsonRpcMessage(oversized);

    expectError(parsed, -32700);
  });

  it('does not treat a duplicate escaped key as a last-write-wins request', () => {
    const parsed = parseJsonRpcMessage('{"jsonrpc":"2.0","id":1,"method":"test","params":{"a":1,"\\u0061":2}}');

    expectError(parsed, -32600);
  });
});
