import { describe, expect, it } from 'vitest';

import { applyChatEnvelope, createChatState } from '../src/domain/chatReducer';
import { applyHostChatAction, createHostChatState } from '../src/domain/hostReducer';
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

  it('adds a late system message to its completed turn', () => {
    const initial = createHostChatState(chat);
    const started = applyHostChatAction(initial, {
      type: 'chat/turnStarted',
      turnId,
      prompt: '/compact',
      timestamp: '2026-08-29T00:00:00.000Z',
    });
    const completed = applyHostChatAction(started, {
      type: 'chat/turnCompleted',
      turnId,
      timestamp: '2026-08-29T00:00:02.000Z',
    });
    const withSystem = applyHostChatAction(completed, {
      type: 'chat/responsePartAdded',
      turnId,
      part: {
        kind: 'system_message',
        id: 'system-output',
        event: 'local_command_output',
        title: '命令输出',
        content: 'Not enough messages to compact.',
        level: 'info',
      },
      timestamp: '2026-08-29T00:00:03.000Z',
    });

    expect(withSystem.turns[0]?.parts).toContainEqual(expect.objectContaining({
      kind: 'system_message',
      event: 'local_command_output',
    }));
  });

  it('updates and clears transient activity only on the active turn', () => {
    const started = applyHostChatAction(createHostChatState(chat), {
      type: 'chat/turnStarted', turnId, prompt: 'hello', timestamp: 't1',
    });
    const requesting = applyHostChatAction(started, {
      type: 'chat/turnActivityChanged', turnId, activity: 'requesting_model', timestamp: 't2',
    });
    expect(requesting.activeTurn?.activity).toBe('requesting_model');
    const compacting = applyHostChatAction(requesting, {
      type: 'chat/turnActivityChanged', turnId, activity: 'compacting_context', timestamp: 't3',
    });
    expect(compacting.activeTurn?.activity).toBe('compacting_context');
    expect(applyHostChatAction(compacting, {
      type: 'chat/turnActivityChanged', turnId: 'other-turn', activity: null, timestamp: 'wrong',
    })).toBe(compacting);
    const cleared = applyHostChatAction(compacting, {
      type: 'chat/turnActivityChanged', turnId, activity: null, timestamp: 't4',
    });
    expect(cleared.activeTurn).not.toHaveProperty('activity');
    const completed = applyHostChatAction(compacting, {
      type: 'chat/turnCompleted', turnId, timestamp: 't5',
    });
    expect(completed.turns[0]).not.toHaveProperty('activity');
  });

  it('upserts changed system messages in place and ignores identical repeats', () => {
    const initial = createHostChatState(chat);
    const started = applyHostChatAction(initial, {
      type: 'chat/turnStarted',
      turnId,
      prompt: 'index',
      timestamp: 't1',
    });
    const first = applyHostChatAction(started, {
      type: 'chat/responsePartAdded',
      turnId,
      part: {
        kind: 'system_message',
        id: 'task-part',
        event: 'task_started',
        title: '后台任务进度',
        content: 'Indexing',
        level: 'progress',
      },
      timestamp: 't2',
    });
    const repeated = applyHostChatAction(first, {
      type: 'chat/responsePartAdded',
      turnId,
      part: {
        kind: 'system_message',
        id: 'task-part',
        event: 'task_started',
        title: '后台任务进度',
        content: 'Indexing',
        level: 'progress',
      },
      timestamp: 't3',
    });
    const updated = applyHostChatAction(repeated, {
      type: 'chat/responsePartAdded',
      turnId,
      part: {
        kind: 'system_message',
        id: 'task-part',
        event: 'task_notification',
        title: '后台任务进度',
        content: 'Done',
        level: 'success',
      },
      timestamp: 't4',
    });

    expect(repeated).toBe(first);
    expect(updated.activeTurn?.parts).toEqual([expect.objectContaining({
      id: 'task-part',
      event: 'task_notification',
      content: 'Done',
      level: 'success',
    })]);
    expect(updated.modifiedAt).toBe('t4');
  });

  it('removes the selected prompt and all later turns on canonical rewind', () => {
    const initial = createHostChatState(chat);
    const firstStarted = applyHostChatAction(initial, {
      type: 'chat/turnStarted', turnId, prompt: 'first', timestamp: 't1',
    });
    const first = applyHostChatAction(firstStarted, {
      type: 'chat/turnCompleted', turnId, timestamp: 't2',
    });
    const secondId = createTurnId('turn-2');
    const secondStarted = applyHostChatAction(first, {
      type: 'chat/turnStarted', turnId: secondId, prompt: 'second', timestamp: 't3',
    });
    const second = applyHostChatAction(secondStarted, {
      type: 'chat/turnCompleted', turnId: secondId, timestamp: 't4',
    });

    const rewound = applyHostChatAction(second, {
      type: 'chat/rewound', targetTurnId: secondId, timestamp: 't5',
    });

    expect(rewound.turns.map((turn) => turn.id)).toEqual([turnId]);
    expect(rewound.modifiedAt).toBe('t5');
  });
});
