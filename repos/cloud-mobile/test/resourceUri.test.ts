import { describe, expect, it } from 'vitest';

import {
  AGENT_ROOT_URI,
  createChatUri,
  createSessionUri,
  parseResourceUri,
} from '../src/protocol/resourceUri';

describe('resource URI contract', () => {
  it('round-trips root, session, and chat resources', () => {
    expect(parseResourceUri(AGENT_ROOT_URI)).toEqual({ kind: 'root', uri: AGENT_ROOT_URI });
    expect(parseResourceUri(createSessionUri('workspace-1'))).toEqual({
      kind: 'session',
      uri: 'agent-session://workspace-1',
      sessionId: 'workspace-1',
    });
    expect(parseResourceUri(createChatUri('session-1', 'chat-1'))).toEqual({
      kind: 'chat',
      uri: 'agent-chat://session-1/chat-1',
      sessionId: 'session-1',
      chatId: 'chat-1',
    });
  });

  it('rejects traversal, query, fragment, and encoded separator segments', () => {
    expect(() => parseResourceUri('agent-session://..')).toThrow();
    expect(() => parseResourceUri('agent-chat://session/chat?token=secret')).toThrow();
    expect(() => parseResourceUri('agent-chat://session/chat#fragment')).toThrow();
    expect(() => parseResourceUri('agent-chat://session%2Fother/chat')).toThrow();
  });
});
