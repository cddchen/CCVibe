import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import {
  createChatUri,
  createChatState,
  createTurnId,
  HostStateManager,
} from '../../src/index.js';
import { ClaudeLiveMapper } from '../../src/claude/liveMapper.js';
import {
  ClaudeReplayMapper,
  hydrateClaudeHistory,
  mapClaudeHistory,
  stableStringify,
} from '../../src/claude/replayMapper.js';
import { chatReducer } from '../../src/domain/chatReducer.js';
import type { ChatAction } from '../../src/domain/actions.js';
import type { Turn } from '../../src/domain/chat.js';

type TranscriptType = 'user' | 'assistant' | 'system';

function session(
  type: TranscriptType,
  uuid: string,
  message: unknown,
  timestamp?: string,
): SessionMessage {
  const record: Record<string, unknown> = {
    type,
    uuid,
    session_id: 'session-test',
    message,
    parent_tool_use_id: null,
    parent_agent_id: null,
  };
  if (timestamp !== undefined) {
    record.timestamp = timestamp;
  }
  return record as SessionMessage;
}

function user(uuid: string, content: unknown, timestamp?: string): SessionMessage {
  return session('user', uuid, { role: 'user', content }, timestamp);
}

function assistant(uuid: string, content: unknown, timestamp?: string): SessionMessage {
  return session('assistant', uuid, { role: 'assistant', content }, timestamp);
}

function toolUse(id: string, name: string, input: unknown): Record<string, unknown> {
  return { type: 'tool_use', id, name, input };
}

function toolResult(
  toolUseId: string,
  content: unknown,
  isError = false,
): Record<string, unknown> {
  return { type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError };
}

function liveCompletedTurn(): Turn {
  const turnId = createTurnId('live-equivalent-turn');
  const partId = 'live-equivalent-part' as Turn['parts'][number]['id'];
  const mapper = new ClaudeLiveMapper({ generation: 1 });
  const start: ChatAction = {
    type: 'chat/turnStarted',
    turnId,
    prompt: 'Read the file.',
    timestamp: 't1',
  };
  const messageStart: ChatAction[] = [];
  const stream = mapper.mapMessage({
    type: 'stream_event',
    parent_tool_use_id: null,
    uuid: '00000000-0000-4000-8000-000000000001',
    session_id: 'session-test',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: 'Done.', citations: null },
    },
  }, turnId, 't2');
  const actions: ChatAction[] = [start, ...messageStart, ...stream];
  const state = actions.reduce(chatReducer, createChatState({ modifiedAt: '' }));
  const completed = chatReducer(state, {
    type: 'chat/turnCompleted',
    turnId,
    timestamp: 't3',
  });
  const turn = completed.turns[0];
  if (turn === undefined) {
    throw new Error(`missing live turn ${partId}`);
  }
  return turn;
}

describe('ClaudeReplayMapper', () => {
  it('maps text, thinking, and multiple chronological turns', () => {
    const turns = mapClaudeHistory([
      user('user-1', [{ type: 'text', text: 'First prompt' }, { type: 'text', text: 'continued' }], 't1'),
      assistant('assistant-1', [
        { type: 'text', text: 'Answer' },
        { type: 'thinking', thinking: 'Reasoning' },
      ], 't2'),
      user('user-2', [{ type: 'text', text: 'Second prompt' }], 't3'),
      assistant('assistant-2', [{ type: 'text', text: 'Second answer' }], 't4'),
    ]);

    expect(turns).toHaveLength(2);
    expect(turns[0]?.id).toBe('user-1');
    expect(turns[1]?.id).toBe('user-2');
    expect(turns[0]).toMatchObject({
      prompt: 'First prompt\ncontinued',
      status: 'complete',
      startedAt: 't1',
      completedAt: 't2',
      parts: [
        { kind: 'markdown', content: 'Answer' },
        { kind: 'reasoning', content: 'Reasoning' },
      ],
    });
    expect(turns[1]).toMatchObject({
      prompt: 'Second prompt',
      status: 'complete',
      startedAt: 't3',
      completedAt: 't4',
      parts: [{ kind: 'markdown', content: 'Second answer' }],
    });
  });

  it('maps promptless assistant content before the first user prompt', () => {
    const turns = new ClaudeReplayMapper({ missingTimestamp: 'fallback' }).map([
      assistant('assistant-first', [{ type: 'text', text: 'Already here' }]),
      user('user-first', 'Now ask', 'user-time'),
    ]);

    expect(turns).toHaveLength(2);
    expect(turns[0]?.id).toBe('assistant-first');
    expect(turns[0]).toMatchObject({ prompt: '', startedAt: 'fallback', completedAt: 'fallback' });
    expect(turns[1]).toMatchObject({ prompt: 'Now ask', startedAt: 'user-time' });
  });

  it('hashes invalid, over-length, and missing transcript identities deterministically', () => {
    const invalid = user('invalid/turn', 'Invalid identity', 't1');
    const oversized = user('x'.repeat(257), 'Oversized identity', 't2');
    const missing = {
      type: 'user',
      session_id: 'session-test',
      message: { role: 'user', content: 'Missing identity' },
      parent_tool_use_id: null,
      parent_agent_id: null,
      timestamp: 't3',
    } as unknown as SessionMessage;
    const messages = [invalid, oversized, missing] as const;

    const first = mapClaudeHistory(messages);
    const second = mapClaudeHistory(messages);
    const firstIds = first.map((turn) => turn.id);

    expect(second.map((turn) => turn.id)).toEqual(firstIds);
    expect(firstIds).toHaveLength(3);
    expect(new Set(firstIds).size).toBe(3);
    for (const id of firstIds) {
      expect(id).toMatch(/^replay_turn_[a-f0-9]{48}$/u);
      expect(new TextEncoder().encode(id).byteLength).toBeLessThanOrEqual(256);
    }
    expect(firstIds).not.toContain('invalid/turn');
    expect(firstIds).not.toContain('x'.repeat(257));
  });

  it('completes multiple cross-message tool results and stable-sorts input', () => {
    const turns = mapClaudeHistory([
      user('user-tool', 'Use tools', 't1'),
      assistant('assistant-tool', [
        toolUse('raw/tool A', 'read_file', { b: 2, a: 1 }),
        toolUse('raw/tool B', 'write_file', { nested: { z: 1, a: true }, array: [2, 1] }),
      ], 't2'),
      user('result-tool', [
        toolResult('raw/tool A', [{ type: 'text', text: 'first' }, { type: 'image' }, { type: 'text', text: ' result' }]),
        toolResult('raw/tool B', 'permission denied', true),
      ], 't3'),
    ]);

    const parts = turns[0]?.parts ?? [];
    expect(turns[0]).toMatchObject({ status: 'complete', completedAt: 't3' });
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({
      kind: 'tool_call',
      toolCall: {
        name: 'read_file',
        input: '{"a":1,"b":2}',
        status: 'completed',
        result: 'first result',
        completedAt: 't3',
      },
    });
    expect(parts[1]).toMatchObject({
      kind: 'tool_call',
      toolCall: {
        name: 'write_file',
        input: '{"array":[2,1],"nested":{"a":true,"z":1}}',
        status: 'completed',
        error: 'permission denied',
        completedAt: 't3',
      },
    });
    expect(parts[0]).not.toHaveProperty('toolCall.result', undefined);
    expect(parts[1]).not.toHaveProperty('toolCall.result');
  });

  it('does not open turns for CLI echoes, system rows, unknown rows, or tool-only envelopes', () => {
    const diagnostics: Array<{ readonly code: string; readonly type: string }> = [];
    const mapper = new ClaudeReplayMapper({
      onDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
        throw new Error('diagnostics are isolated');
      },
    });
    const unknown = { type: 'future_message', message: {} } as unknown as SessionMessage;
    const turns = mapper.map([
      user('echo-1', '<local-command-stdout>ignored</local-command-stdout>', 'echo'),
      user('echo-2', [{ type: 'text', text: '<command-name>ignored</command-name>' }], 'echo-2'),
      user('echo-3', '<command-args>--ignored</command-args>', 'echo-3'),
      user('echo-4', '<command-stdout>ignored output</command-stdout>', 'echo-4'),
      user('echo-5', [{ type: 'text', text: '<command-stderr>ignored error</command-stderr>' }], 'echo-5'),
      session('system', 'system-1', { subtype: 'init' }, 'system'),
      unknown,
      user('real-1', [toolResult('missing', 'ignored')], 'tool-only'),
      user('real-2', 'real prompt', 'prompt'),
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.prompt).toBe('real prompt');
    expect(diagnostics).toContainEqual({ code: 'unsupported_message', type: 'system' });
    expect(diagnostics).toContainEqual({ code: 'unsupported_message', type: 'future_message' });
    expect(diagnostics).toContainEqual({ code: 'unmatched_tool_result', type: 'tool_result' });
  });

  it('marks incomplete ready tools and their containing turn as loss-aware failure', () => {
    const turns = mapClaudeHistory([
      user('incomplete-user', 'Run it', 't1'),
      assistant('incomplete-assistant', [toolUse('unfinished', 'bash', { command: 'pwd' })], 't2'),
    ]);

    expect(turns[0]).toMatchObject({
      status: 'failed',
      error: 'incomplete transcript',
      completedAt: 't2',
      parts: [{
        kind: 'tool_call',
        toolCall: {
          status: 'completed',
          completedAt: 't2',
          error: 'incomplete transcript',
        },
      }],
    });
  });

  it('isolates malformed messages and keeps deterministic IDs, timestamps, and immutability', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const malformed = null as unknown as SessionMessage;
    const messages = [
      malformed,
      user('deterministic-user', 'Prompt'),
      assistant('deterministic-assistant', [
        { type: 'tool_use', id: 'id/with spaces', name: 'inspect', input: { cycle: cyclic, absent: undefined } },
      ]),
    ] as readonly SessionMessage[];
    const first = new ClaudeReplayMapper({
      timestampFallback: (_message, index) => `fallback-${index}`,
    }).map(messages);
    const second = new ClaudeReplayMapper({
      timestampFallback: (_message, index) => `fallback-${index}`,
    }).map(messages);

    expect(second).toEqual(first);
    expect(first[0]?.startedAt).toBe('fallback-1');
    expect(first[0]?.completedAt).toBe('fallback-2');
    const tool = first[0]?.parts[0];
    if (tool?.kind !== 'tool_call') {
      throw new Error('missing deterministic tool');
    }
    expect(tool.toolCall.input).toBe('{"absent":"[undefined]","cycle":{"self":"[cycle]"}}');
    expect(tool.id).not.toContain('id/with spaces');
    expect(tool.toolCall.id).not.toContain('id/with spaces');
    expect(new TextEncoder().encode(first[0]?.id ?? '').byteLength).toBeLessThanOrEqual(256);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0])).toBe(true);
    expect(Object.isFrozen(first[0]?.parts)).toBe(true);
    expect(Object.isFrozen(tool)).toBe(true);
    expect(Object.isFrozen(tool.toolCall)).toBe(true);
  });

  it('uses defensive stable serialization placeholders without throwing', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(stableStringify({ z: 1, a: [undefined, Infinity, cycle] })).toBe(
      '{"a":["[undefined]","[non-serializable:number:Infinity]",{"self":"[cycle]"}],"z":1}',
    );
  });

  it('hydrates through one turnsLoaded action and replaces stale same-ID history', () => {
    const host = new HostStateManager({ now: () => 'server-time', replayCapacity: 8 });
    const chat = createChatUri('session-hydrate', 'chat-hydrate');
    const current = mapClaudeHistory([user('hydrate-user', 'Hydrate me', 't1')])[0];
    if (current === undefined) {
      throw new Error('missing hydration fixture');
    }
    host.registerChat(chat, createChatState({
      resource: chat,
      turns: [{ ...current, prompt: 'stale prompt' }],
      modifiedAt: 'old',
    }));

    const envelope = hydrateClaudeHistory(
      host,
      chat,
      [user('hydrate-user', 'Hydrate me', 't1')],
      'hydrate-action',
    );

    expect(envelope?.action.type).toBe('chat/turnsLoaded');
    expect(envelope?.action.timestamp).toBe('hydrate-action');
    expect(host.serverSeq).toBe(1);
    expect(host.getState(chat)?.turns[0]?.prompt).toBe('Hydrate me');

    const repeat = hydrateClaudeHistory(
      host,
      chat,
      [user('hydrate-user', 'Hydrate me', 't1')],
      'hydrate-again',
    );
    expect(repeat).toBeUndefined();
    expect(host.serverSeq).toBe(1);
  });

  it('keeps completed live and replay fixtures semantically equivalent', () => {
    const replay = mapClaudeHistory([
      user('live-equivalent-user', 'Read the file.', 't1'),
      assistant('live-equivalent-assistant', [{ type: 'text', text: 'Done.' }], 't3'),
    ])[0];
    const live = liveCompletedTurn();
    expect(replay).toBeDefined();
    expect(replay?.prompt).toBe(live.prompt);
    expect(replay?.status).toBe(live.status);
    expect(replay?.parts.map((part) => ({ kind: part.kind, content: part.kind === 'tool_call' ? undefined : part.content })))
      .toEqual(live.parts.map((part) => ({ kind: part.kind, content: part.kind === 'tool_call' ? undefined : part.content })));
    expect(replay?.startedAt).toBe(live.startedAt);
    expect(replay?.completedAt).toBe(live.completedAt);
  });
});

