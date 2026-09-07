import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { resolveClaudeRewindPoint, resolveClaudeRewindPointAtTurn } from '../../src/claude/rewindPoint.js';

function message(type: 'user' | 'assistant', uuid: string, content: unknown, parent: string | null = null): SessionMessage {
  return {
    type,
    uuid,
    session_id: 'session-a',
    parent_tool_use_id: parent,
    parent_agent_id: null,
    message: { role: type, content },
  } as SessionMessage;
}

describe('resolveClaudeRewindPoint', () => {
  it('uses the target user UUID for files and the preceding assistant UUID for conversation state', () => {
    expect(resolveClaudeRewindPoint([
      message('user', 'user-1', 'first'),
      message('assistant', 'assistant-1', [{ type: 'text', text: 'answer' }]),
      message('assistant', 'sidechain', [{ type: 'text', text: 'subagent' }], 'tool-1'),
      message('user', 'user-2', [{ type: 'text', text: 'second' }]),
    ], 'user-2')).toEqual({
      userMessageUuid: 'user-2',
      previousAssistantUuid: 'assistant-1',
    });
  });

  it('has no conversation anchor before the first prompt', () => {
    expect(resolveClaudeRewindPoint([
      message('user', 'user-1', 'first'),
      message('assistant', 'assistant-1', 'answer'),
    ], 'user-1')).toEqual({ userMessageUuid: 'user-1' });
  });

  it('does not mistake tool-result user envelopes for prompts', () => {
    expect(resolveClaudeRewindPoint([
      message('user', 'tool-result', [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }]),
    ], 'tool-result')).toBeUndefined();
  });

  it('falls back to turn order after forkSession remaps UUIDs', () => {
    expect(resolveClaudeRewindPointAtTurn([
      message('user', 'fork-user-1', 'first'),
      message('assistant', 'fork-assistant-1', 'answer'),
      message('user', 'fork-user-2', 'second'),
    ], 1)).toEqual({
      userMessageUuid: 'fork-user-2',
      previousAssistantUuid: 'fork-assistant-1',
    });
  });
});
