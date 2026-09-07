import { describe, expect, it } from 'vitest';

import { applyHostChatAction, createHostChatState } from '../src/domain/hostReducer';
import { createChatUri } from '../src/protocol/resourceUri';

const chatUri = createChatUri('workspace-performance', 'chat-performance');

describe('Host chat reducer structural sharing', () => {
  it('keeps transcript references stable when an approval is added', () => {
    const started = applyHostChatAction(createHostChatState(chatUri), {
      type: 'chat/turnStarted',
      turnId: 'turn-performance',
      prompt: '检查性能',
      timestamp: '2026-09-06T00:00:00.000Z',
    });
    const withPart = applyHostChatAction(started, {
      type: 'chat/responsePartAdded',
      turnId: 'turn-performance',
      part: { kind: 'markdown', id: 'answer-performance', content: '开始检查。' },
      timestamp: '2026-09-06T00:00:01.000Z',
    });
    const approved = applyHostChatAction(withPart, {
      type: 'chat/approvalRequested',
      turnId: 'turn-performance',
      approvalId: 'approval-performance',
      toolName: 'Bash',
      input: { command: 'npm test' },
      timestamp: '2026-09-06T00:00:02.000Z',
    });

    expect(approved.turns).toBe(withPart.turns);
    expect(approved.activeTurn).toBe(withPart.activeTurn);
    expect(approved.activeTurn?.parts).toBe(withPart.activeTurn?.parts);
  });

  it('reuses completed history and unaffected parts for a text delta', () => {
    let state = applyHostChatAction(createHostChatState(chatUri), {
      type: 'chat/turnStarted', turnId: 'turn-performance', prompt: '检查性能', timestamp: '2026-09-06T00:00:00.000Z',
    });
    state = applyHostChatAction(state, {
      type: 'chat/responsePartAdded', turnId: 'turn-performance', part: { kind: 'reasoning', id: 'reasoning-performance', content: '分析中' }, timestamp: '2026-09-06T00:00:01.000Z',
    });
    state = applyHostChatAction(state, {
      type: 'chat/responsePartAdded', turnId: 'turn-performance', part: { kind: 'markdown', id: 'answer-performance', content: '结果' }, timestamp: '2026-09-06T00:00:02.000Z',
    });
    const before = state;
    const after = applyHostChatAction(before, {
      type: 'chat/responsePartDelta', turnId: 'turn-performance', partId: 'answer-performance', delta: '继续', timestamp: '2026-09-06T00:00:03.000Z',
    });

    expect(after.turns).toBe(before.turns);
    expect(after.activeTurn?.parts[0]).toBe(before.activeTurn?.parts[0]);
    expect(after.activeTurn?.parts[1]).not.toBe(before.activeTurn?.parts[1]);
  });
});
