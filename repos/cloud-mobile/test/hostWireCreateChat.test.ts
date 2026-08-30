import { describe, expect, it } from 'vitest';

import {
  parseHostCreateChatResult,
  parseHostDispatchActionResult,
  parseHostRpcResult,
} from '../src/protocol/hostWire';

describe('Host Phase 1 command receipts', () => {
  it('parses the exact accepted ChatUri receipt returned by catalog/createChat', () => {
    const result = parseHostCreateChatResult({
      receipt: {
        status: 'accepted',
        value: { chatUri: 'agent-chat://session-a/chat-a' },
      },
    });

    expect(result.receipt).toEqual({
      status: 'accepted',
      value: { chatUri: 'agent-chat://session-a/chat-a' },
    });
    expect(parseHostRpcResult('catalog/createChat', {
      receipt: { status: 'rejected', code: 'WORKSPACE_NOT_FOUND', message: 'workspace unavailable' },
    })).toMatchObject({ receipt: { status: 'rejected', code: 'WORKSPACE_NOT_FOUND' } });
  });

  it('parses accepted dispatchAction receipts and rejects malformed or extra fields', () => {
    expect(parseHostDispatchActionResult({
      receipt: { status: 'accepted', value: { acceptedAtSeq: 12, turnId: 'turn-a' } },
    })).toEqual({
      receipt: { status: 'accepted', value: { acceptedAtSeq: 12, turnId: 'turn-a' } },
    });

    expect(() => parseHostCreateChatResult({
      receipt: { status: 'accepted', value: { chatUri: 'not-a-chat-uri' } },
    })).toThrow(TypeError);
    expect(() => parseHostDispatchActionResult({
      receipt: { status: 'accepted', value: { acceptedAtSeq: 12 }, extra: true },
    })).toThrow(TypeError);
  });
});
