import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import {
  ClaudeRuntimeActionBridge,
  HostStateManager,
  createChatUri,
  createTurnId,
} from '../../src/index.js';
import type { TurnId } from '../../src/domain/ids.js';
import type { ClaudeRuntimeSignal } from '../../src/claude/runtimeTypes.js';

const chat = createChatUri('session-bridge', 'chat-bridge');
const turn = createTurnId('turn-bridge');

function makeHost(): HostStateManager {
  const host = new HostStateManager({ now: () => 'server-time', replayCapacity: 64 });
  host.registerChat(chat);
  host.dispatch(chat, {
    type: 'chat/turnStarted',
    turnId: turn,
    prompt: 'hello',
    timestamp: 'started',
  });
  return host;
}

function stream(event: unknown, uuid = 'stream-message'): SDKMessage {
  return {
    type: 'stream_event',
    event,
    parent_tool_use_id: null,
    uuid,
    session_id: 'sdk-session',
  } as unknown as SDKMessage;
}

function userToolResult(): SDKMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'raw-tool', content: 'tool output' }],
    },
    parent_tool_use_id: null,
    uuid: 'tool-result-message',
    session_id: 'sdk-session',
  } as unknown as SDKMessage;
}

function runtimeMessage(
  message: SDKMessage,
  options: {
    readonly generation?: number;
    readonly phase?: 'active' | 'tail' | 'unmatched';
    readonly turnId?: TurnId;
    readonly omitTurnId?: boolean;
  } = {},
): ClaudeRuntimeSignal {
  return {
    type: 'runtime/message',
    generation: options.generation ?? 1,
    phase: options.phase ?? 'active',
    message,
    ...(options.omitTurnId
      ? {}
      : options.turnId === undefined
        ? { turnId: turn }
        : { turnId: options.turnId }),
  };
}

describe('ClaudeRuntimeActionBridge', () => {
  it('projects text, thinking, and tool live actions into one completed Host turn', () => {
    const host = makeHost();
    let clock = 0;
    const bridge = new ClaudeRuntimeActionBridge({
      hostStateManager: host,
      nowAction: () => `action-${clock += 1}`,
    });

    const messages: SDKMessage[] = [
      stream({ type: 'message_start', message: { id: 'assistant-message' } }),
      stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'hello ' } }),
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } }),
      stream({ type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: 'reason' } }),
      stream({ type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: ' more' } }),
      stream({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'raw-tool', name: 'read_file', input: {} } }),
      stream({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":"x"}' } }),
      stream({ type: 'content_block_stop', index: 2 }),
      userToolResult(),
    ];
    const envelopes = messages.flatMap((message) => bridge.handle(chat, runtimeMessage(message)));
    envelopes.push(...bridge.handle(chat, {
      type: 'turn/result',
      generation: 1,
      turnId: turn,
      outcome: { status: 'completed', resultSubtype: 'success' },
    }));

    expect(envelopes.map((envelope) => envelope.action.type)).toEqual([
      'chat/responsePartAdded',
      'chat/responsePartDelta',
      'chat/responsePartAdded',
      'chat/responsePartDelta',
      'chat/toolCallStarted',
      'chat/toolCallInputDelta',
      'chat/toolCallReady',
      'chat/toolCallCompleted',
      'chat/turnCompleted',
    ]);
    expect(new Set(envelopes.slice(0, 8).map((envelope) => envelope.action.timestamp))).toEqual(
      new Set(['action-2', 'action-3', 'action-4', 'action-5', 'action-6', 'action-7', 'action-8', 'action-9']),
    );
    expect(host.getState(chat)?.turns[0]).toMatchObject({
      id: turn,
      status: 'complete',
      parts: [
        { kind: 'markdown', content: 'hello world' },
        { kind: 'reasoning', content: 'reason more' },
        {
          kind: 'tool_call',
          toolCall: {
            name: 'read_file',
            input: '{"path":"x"}',
            status: 'completed',
            result: 'tool output',
          },
        },
      ],
    });
  });

  it('ignores stale generations and tail or unmatched messages without consuming Host sequences', () => {
    const host = makeHost();
    const bridge = new ClaudeRuntimeActionBridge({ hostStateManager: host, nowAction: () => 'unused' });
    const startSeq = host.serverSeq;

    bridge.handle(chat, { type: 'runtime/init', generation: 2, sdkSessionId: 'sdk-new' });
    bridge.handle(chat, runtimeMessage(
      stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'stale' } }),
      { generation: 1 },
    ));
    bridge.handle(chat, runtimeMessage(
      stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'tail' } }),
      { generation: 2, phase: 'tail' },
    ));
    bridge.handle(chat, runtimeMessage(
      stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'unmatched' } }),
      { generation: 2, phase: 'unmatched', omitTurnId: true },
    ));

    expect(host.serverSeq).toBe(startSeq);
    expect(host.getState(chat)?.activeTurn?.parts).toEqual([]);
  });

  it('maps a terminal signal once and uses a canonical safe crash error', () => {
    const host = makeHost();
    const bridge = new ClaudeRuntimeActionBridge({ hostStateManager: host, nowAction: () => 'terminal-time' });

    const first = bridge.handle(chat, {
      type: 'runtime/terminal',
      generation: 1,
      state: 'crashed',
      error: new Error('secret runtime detail'),
    });
    const duplicate = bridge.handle(chat, {
      type: 'runtime/terminal',
      generation: 1,
      state: 'crashed',
      error: new Error('another detail'),
    });

    expect(first).toHaveLength(1);
    expect(first[0]?.action).toEqual({
      type: 'chat/turnFailed',
      turnId: turn,
      error: 'Claude runtime crashed',
      timestamp: 'terminal-time',
    });
    expect(duplicate).toEqual([]);
    expect(host.getState(chat)?.turns).toHaveLength(1);
    expect(host.serverSeq).toBe(2);
  });
});
