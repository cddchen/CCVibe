import { describe, expect, it } from 'vitest';

import { applyChatEnvelope, createChatState } from '../src/domain/chatReducer';
import type { ActionEnvelope, ChatAction } from '../src/domain/types';
import { createTurnId } from '../src/protocol/ids';
import { createChatUri } from '../src/protocol/resourceUri';

const chat = createChatUri('session-1', 'chat-1');
const turnId = createTurnId('turn-1');

function envelope(serverSeq: number, action: ChatAction): ActionEnvelope<ChatAction, typeof chat> {
  return {
    channel: chat,
    serverSeq,
    serverTime: `2026-08-29T00:00:0${serverSeq}.000Z`,
    action,
  };
}

describe('chat envelope reducer', () => {
  it('applies forward gaps and ignores duplicate or stale envelopes by identity', () => {
    const initial = createChatState(chat);
    const started = applyChatEnvelope(initial, envelope(1, {
      type: 'chat/turnStarted',
      turnId,
      prompt: 'hello',
      timestamp: '2026-08-29T00:00:00.000Z',
    }));
    const completed = applyChatEnvelope(started, envelope(3, {
      type: 'chat/turnCompleted',
      turnId,
      timestamp: '2026-08-29T00:00:03.000Z',
    }));

    expect(completed.lastServerSeq).toBe(3);
    expect(completed.turns[0]?.status).toBe('completed');
    expect(applyChatEnvelope(completed, envelope(3, {
      type: 'chat/textDelta',
      turnId,
      delta: 'ignored',
      timestamp: '2026-08-29T00:00:03.100Z',
    }))).toBe(completed);
    expect(applyChatEnvelope(completed, envelope(2, {
      type: 'chat/textDelta',
      turnId,
      delta: 'ignored',
      timestamp: '2026-08-29T00:00:02.000Z',
    }))).toBe(completed);
  });
});
