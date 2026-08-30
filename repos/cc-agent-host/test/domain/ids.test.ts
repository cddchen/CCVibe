import { describe, expect, it } from 'vitest';

import {
  AGENT_ROOT_URI,
  createChatUri,
  createConnectionId,
  createInputRequestId,
  createSessionUri,
  parseChatUri,
  parseConnectionId,
  parseInputRequestId,
  parseResourceUri,
  parseRootUri,
  parseSessionUri,
  resourceKind,
  type ConnectionId,
} from '../../src/index.js';

describe('agent resource URIs', () => {
  it('constructs and parses a branded connection id', () => {
    const connection: ConnectionId = createConnectionId('connection-1');

    expect(connection).toBe(parseConnectionId(connection));
    expect(() => createConnectionId('')).toThrow(TypeError);
    expect(() => createConnectionId('connection/1')).toThrow(TypeError);
    expect(() => createConnectionId('x'.repeat(257))).toThrow(RangeError);
  });

  it('constructs and parses a branded structured-input request id', () => {
    const input = createInputRequestId('input-1');

    expect(input).toBe(parseInputRequestId(input));
    expect(() => createInputRequestId('')).toThrow(TypeError);
    expect(() => createInputRequestId('input/1')).toThrow(TypeError);
    expect(() => createInputRequestId('x'.repeat(257))).toThrow(RangeError);
  });

  it('constructs and parses the root, session, and chat resources', () => {
    const session = createSessionUri('session-1');
    const chat = createChatUri('session-1', 'chat-1');

    expect(createSessionUri('session-1')).toBe('agent-session://session-1');
    expect(session).toBe(parseSessionUri(session));
    expect(chat).toBe(parseChatUri(chat));
    expect(parseRootUri(AGENT_ROOT_URI)).toBe(AGENT_ROOT_URI);
    expect(parseResourceUri(AGENT_ROOT_URI)).toEqual({ kind: 'root', uri: AGENT_ROOT_URI });
    expect(parseResourceUri(session)).toEqual({ kind: 'session', uri: session, sessionId: 'session-1' });
    expect(parseResourceUri(chat)).toEqual({
      kind: 'chat',
      uri: chat,
      sessionId: 'session-1',
      chatId: 'chat-1',
    });
    expect(resourceKind(AGENT_ROOT_URI)).toBe('root');
    expect(resourceKind(session)).toBe('session');
    expect(resourceKind(chat)).toBe('chat');
  });

  it.each([
    'agent-root://extra',
    'agent-session://',
    'agent-session://session-1/extra',
    'agent-chat://session-1',
    'agent-chat://session-1/',
    'agent-chat:///chat-1',
    'agent-chat://session-1/chat-1/extra',
    'wrong-scheme://session-1',
    'agent-session://session-1?query=1',
    'agent-chat://session-1/chat-1#fragment',
    'agent-chat://session-1/..',
    'agent-chat://session-1/%2e%2e',
  ])('rejects malformed resource URI %s', (value) => {
    expect(() => parseResourceUri(value)).toThrow(TypeError);
  });

  it('does not classify malformed resources', () => {
    expect(() => resourceKind('agent-chat://session-1')).toThrow(TypeError);
    expect(() => parseRootUri('agent-session://session-1')).toThrow(TypeError);
  });

  it('does not derive a provider session identity from a chat URI', () => {
    const chat = parseResourceUri(createChatUri('opaque-session', 'opaque-chat'));
    expect(chat.kind).toBe('chat');
    if (chat.kind === 'chat') {
      expect(chat).not.toHaveProperty('sdkSessionId');
      expect(chat.sessionId).toBe('opaque-session');
      expect(chat.chatId).toBe('opaque-chat');
    }
  });
});
