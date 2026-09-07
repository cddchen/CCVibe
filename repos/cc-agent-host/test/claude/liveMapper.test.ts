import type { UUID } from 'node:crypto';

import type {
  SDKAssistantMessage,
  SDKCompactBoundaryMessage,
  SDKInformationalMessage,
  SDKLocalCommandOutputMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKSystemMessage,
  SDKUserMessage,
  SDKUserMessageReplay,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import {
  createTurnId,
  parsePartId,
  parseToolCallId,
  type ChatAction,
  type TurnId,
} from '../../src/index.js';
import { ClaudeLiveMapper } from '../../src/claude/liveMapper.js';

const SESSION_ID = '00000000-0000-4000-8000-000000000010';
const TURN_ID = createTurnId('turn-live-1');

type StreamEvent = SDKPartialAssistantMessage['event'];
type MessageStartEvent = Extract<StreamEvent, { readonly type: 'message_start' }>;
type ContentBlockStartEvent = Extract<StreamEvent, { readonly type: 'content_block_start' }>;
type ContentBlockDeltaEvent = Extract<StreamEvent, { readonly type: 'content_block_delta' }>;
type ContentBlockStopEvent = Extract<StreamEvent, { readonly type: 'content_block_stop' }>;

type StreamMessageOverrides = Partial<Pick<SDKPartialAssistantMessage, 'parent_tool_use_id'>> & {
  readonly uuid?: UUID;
};

function partial(event: StreamEvent, overrides: StreamMessageOverrides = {}): SDKPartialAssistantMessage {
  return {
    type: 'stream_event',
    event,
    parent_tool_use_id: overrides.parent_tool_use_id ?? null,
    uuid: overrides.uuid ?? '00000000-0000-4000-8000-000000000011',
    session_id: SESSION_ID,
  } satisfies SDKPartialAssistantMessage;
}

function emptyUsage(): MessageStartEvent['message']['usage'] {
  return {
    cache_creation: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    fallback_credit: null,
    inference_geo: null,
    input_tokens: 0,
    iterations: null,
    output_tokens: 0,
    output_tokens_details: null,
    server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
    service_tier: null,
    speed: null,
  };
}

function messageStart(
  id: string,
  uuid: UUID = '00000000-0000-4000-8000-000000000011',
): SDKPartialAssistantMessage {
  const message = {
    id,
    container: null,
    content: [],
    context_management: null,
    diagnostics: null,
    model: 'claude-sonnet',
    role: 'assistant',
    stop_details: null,
    stop_reason: null,
    stop_sequence: null,
    type: 'message',
    usage: emptyUsage(),
  } satisfies MessageStartEvent['message'];
  return partial(
    {
      type: 'message_start',
      message,
    } satisfies MessageStartEvent,
    { uuid },
  );
}

function textStart(index: number, text: string): SDKPartialAssistantMessage {
  return partial({
    type: 'content_block_start',
    index,
    content_block: { type: 'text', text, citations: null },
  } satisfies ContentBlockStartEvent);
}

function thinkingStart(index: number, thinking: string): SDKPartialAssistantMessage {
  return partial({
    type: 'content_block_start',
    index,
    content_block: { type: 'thinking', thinking, signature: 'signature' },
  } satisfies ContentBlockStartEvent);
}

function toolStart(index: number, id: string, name = 'read_file'): SDKPartialAssistantMessage {
  return partial({
    type: 'content_block_start',
    index,
    content_block: { type: 'tool_use', id, name, input: {} },
  } satisfies ContentBlockStartEvent);
}

function textDelta(index: number, text: string): SDKPartialAssistantMessage {
  return partial({
    type: 'content_block_delta',
    index,
    delta: { type: 'text_delta', text },
  } satisfies ContentBlockDeltaEvent);
}

function thinkingDelta(index: number, thinking: string): SDKPartialAssistantMessage {
  return partial({
    type: 'content_block_delta',
    index,
    delta: { type: 'thinking_delta', thinking, estimated_tokens: null },
  } satisfies ContentBlockDeltaEvent);
}

function inputDelta(index: number, partialJson: string): SDKPartialAssistantMessage {
  return partial({
    type: 'content_block_delta',
    index,
    delta: { type: 'input_json_delta', partial_json: partialJson },
  } satisfies ContentBlockDeltaEvent);
}

function blockStop(index: number): SDKPartialAssistantMessage {
  return partial({ type: 'content_block_stop', index } satisfies ContentBlockStopEvent);
}

function userMessage(
  content: SDKUserMessage['message']['content'],
  replay = false,
): SDKUserMessage | SDKUserMessageReplay {
  if (replay) {
    return {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-000000000012',
      session_id: SESSION_ID,
      isReplay: true,
    } satisfies SDKUserMessageReplay;
  }
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    uuid: '00000000-0000-4000-8000-000000000012',
    session_id: SESSION_ID,
  } satisfies SDKUserMessage;
}

function canonicalAssistant(parentToolUseId: string | null = null): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: {
      id: 'canonical-message',
      container: null,
      content: [{ type: 'text', text: 'canonical', citations: null }],
      context_management: null,
      diagnostics: null,
      model: 'claude-sonnet',
      role: 'assistant',
      stop_details: null,
      stop_reason: 'end_turn',
      stop_sequence: null,
      type: 'message',
      usage: emptyUsage(),
    },
    parent_tool_use_id: parentToolUseId,
    uuid: '00000000-0000-4000-8000-000000000013',
    session_id: SESSION_ID,
  } satisfies SDKAssistantMessage;
}

function mapSequence(
  mapper: ClaudeLiveMapper,
  messages: readonly SDKMessage[],
  turnId: TurnId = TURN_ID,
): readonly ChatAction[] {
  return messages.flatMap((message, index) => mapper.mapMessage(message, turnId, `t-${index}`));
}

describe('ClaudeLiveMapper', () => {
  it('maps streamed text and thinking blocks without duplicating their initial content', () => {
    const mapper = new ClaudeLiveMapper({ generation: 1 });

    expect(mapper.mapMessage(messageStart('message-text'), TURN_ID, 'start')).toEqual([]);
    const textAdded = mapper.mapMessage(textStart(0, 'initial '), TURN_ID, 'text-start');
    const textDeltaAction = mapper.mapMessage(textDelta(0, 'text'), TURN_ID, 'text-delta');
    const thinkingAdded = mapper.mapMessage(thinkingStart(1, 'initial thinking'), TURN_ID, 'thinking-start');
    const thinkingDeltaAction = mapper.mapMessage(thinkingDelta(1, ' + delta'), TURN_ID, 'thinking-delta');

    expect(textAdded[0]).toMatchObject({
      type: 'chat/responsePartAdded',
      turnId: TURN_ID,
      part: { kind: 'markdown', content: 'initial ' },
      timestamp: 'text-start',
    });
    expect(textDeltaAction[0]).toMatchObject({
      type: 'chat/responsePartDelta',
      turnId: TURN_ID,
      delta: 'text',
      timestamp: 'text-delta',
    });
    expect(thinkingAdded[0]).toMatchObject({
      type: 'chat/responsePartAdded',
      turnId: TURN_ID,
      part: { kind: 'reasoning', content: 'initial thinking' },
    });
    expect(thinkingDeltaAction[0]).toMatchObject({
      type: 'chat/responsePartDelta',
      turnId: TURN_ID,
      delta: ' + delta',
    });
    expect(mapper.mapMessage(blockStop(0), TURN_ID, 'text-stop')).toEqual([]);
    expect(mapper.mapMessage(textDelta(0, 'late'), TURN_ID, 'late-delta')).toEqual([]);
  });

  it('maps the complete tool lifecycle and a later string/text tool result', () => {
    const mapper = new ClaudeLiveMapper({ generation: 4 });

    mapper.mapMessage(messageStart('message-tool'), TURN_ID, 'start');
    const started = mapper.mapMessage(toolStart(0, 'tool-use/raw id', 'read_file'), TURN_ID, 'tool-start');
    const input = mapper.mapMessage(inputDelta(0, '{"path":"'), TURN_ID, 'input-1');
    const inputEnd = mapper.mapMessage(inputDelta(0, 'README.md"}'), TURN_ID, 'input-2');
    const ready = mapper.mapMessage(blockStop(0), TURN_ID, 'tool-ready');
    const completed = mapper.mapMessage(
      userMessage(
        [
          {
            type: 'tool_result',
            tool_use_id: 'tool-use/raw id',
            content: [
              { type: 'text', text: 'first' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ignored' } },
              { type: 'text', text: 'second' },
            ],
          },
        ],
        true,
      ),
      TURN_ID,
      'tool-complete',
    );

    expect(started[0]).toMatchObject({
      type: 'chat/toolCallStarted',
      turnId: TURN_ID,
      name: 'read_file',
      input: '',
    });
    expect(input).toHaveLength(1);
    expect(inputEnd).toHaveLength(1);
    expect(ready[0]).toMatchObject({ type: 'chat/toolCallReady', timestamp: 'tool-ready' });
    expect(completed[0]).toMatchObject({
      type: 'chat/toolCallCompleted',
      result: 'firstsecond',
      timestamp: 'tool-complete',
    });
    expect(completed[0]).not.toHaveProperty('error');
    expect(mapper.mapMessage(userMessage([{ type: 'tool_result', tool_use_id: 'tool-use/raw id', content: 'again' }]), TURN_ID, 'again')).toEqual([]);
    expect(mapper.mapMessage(inputDelta(0, 'after-ready'), TURN_ID, 'after-ready')).toEqual([]);
  });

  it('maps error results exactly once and removes the private raw tool mapping', () => {
    const mapper = new ClaudeLiveMapper({ generation: 5 });
    mapper.mapMessage(messageStart('message-error'), TURN_ID, 'start');
    mapper.mapMessage(toolStart(0, 'raw-error-tool'), TURN_ID, 'tool-start');

    const result = mapper.mapMessage(
      userMessage([{ type: 'tool_result', tool_use_id: 'raw-error-tool', is_error: true, content: 'permission denied' }]),
      TURN_ID,
      'error-result',
    );

    expect(result[0]).toMatchObject({
      type: 'chat/toolCallCompleted',
      error: 'permission denied',
    });
    expect(result[0]).not.toHaveProperty('result');
    expect(mapper.mapMessage(userMessage([{ type: 'tool_result', tool_use_id: 'raw-error-tool', is_error: true, content: 'duplicate' }]), TURN_ID, 'duplicate')).toEqual([]);
  });

  it('projects SDK system events as collapsed-message domain parts', () => {
    const mapper = new ClaudeLiveMapper({ generation: 6 });
    const compact = {
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'manual', pre_tokens: 4_096, post_tokens: 1_024, duration_ms: 250 },
      uuid: '00000000-0000-4000-8000-000000000021',
      session_id: SESSION_ID,
    } satisfies SDKCompactBoundaryMessage;
    const output = {
      type: 'system',
      subtype: 'local_command_output',
      content: 'Not enough messages to compact.',
      uuid: '00000000-0000-4000-8000-000000000022',
      session_id: SESSION_ID,
    } satisfies SDKLocalCommandOutputMessage;
    const warning = {
      type: 'system',
      subtype: 'informational',
      content: 'A hook prevented continuation.',
      level: 'warning',
      prevent_continuation: true,
      uuid: '00000000-0000-4000-8000-000000000023',
      session_id: SESSION_ID,
    } satisfies SDKInformationalMessage;

    const actions = mapSequence(mapper, [compact, output, warning]);

    expect(actions).toHaveLength(3);
    expect(actions[0]).toMatchObject({
      type: 'chat/responsePartAdded',
      part: {
        kind: 'system_message',
        event: 'compact_boundary',
        title: '上下文压缩',
        level: 'success',
      },
    });
    expect(actions[1]).toMatchObject({
      part: { kind: 'system_message', title: '命令输出', content: 'Not enough messages to compact.' },
    });
    expect(actions[2]).toMatchObject({
      part: { kind: 'system_message', title: '系统提示', level: 'warning' },
    });
    expect(new Set(actions.map((action) => action.type))).toEqual(new Set(['chat/responsePartAdded']));
  });

  it('maps the SDK init message without exposing its session identity', () => {
    const mapper = new ClaudeLiveMapper({ generation: 7 });
    const init = {
      type: 'system',
      subtype: 'init',
      apiKeySource: 'user',
      claude_code_version: '2.1.220',
      cwd: '/tmp/project',
      tools: ['Read'],
      mcp_servers: [{ name: 'local', status: 'connected' }],
      model: 'claude-sonnet',
      permissionMode: 'default',
      slash_commands: ['/compact'],
      output_style: 'default',
      skills: ['review'],
      plugins: [],
      uuid: '00000000-0000-4000-8000-000000000024',
      session_id: SESSION_ID,
    } satisfies SDKSystemMessage;

    const actions = mapper.mapMessage(init, TURN_ID, 'init-time');

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      type: 'chat/responsePartAdded',
      part: {
        kind: 'system_message',
        event: 'init',
        title: '运行环境初始化',
        content: expect.stringContaining('claude-sonnet'),
      },
    });
    expect(JSON.stringify(actions)).not.toContain(SESSION_ID);
  });

  it('uses different deterministic ids when a block index is reused by another message', () => {
    const first = new ClaudeLiveMapper({ generation: 9 });
    const second = new ClaudeLiveMapper({ generation: 9 });

    const firstActions = mapSequence(first, [messageStart('message-a'), textStart(0, '')]);
    const secondActions = mapSequence(second, [messageStart('message-a'), textStart(0, '')]);
    expect(secondActions).toEqual(firstActions);

    const reused = first.mapMessage(messageStart('message-b'), TURN_ID, 'new-start');
    expect(reused).toEqual([]);
    const secondMessage = first.mapMessage(textStart(0, ''), TURN_ID, 'new-text');
    expect(secondMessage[0]).not.toEqual(firstActions[0]);
    expect((secondMessage[0] as { readonly part?: { readonly id?: string } }).part?.id).not.toBe(
      (firstActions[0] as { readonly part?: { readonly id?: string } }).part?.id,
    );
  });

  it('drops canonical assistant content so stream text and tools have one owner', () => {
    const canonicalOnly = new ClaudeLiveMapper({ generation: 2 });
    expect(canonicalOnly.mapMessage(canonicalAssistant(), TURN_ID, 'canonical-only')).toEqual([]);

    const mapper = new ClaudeLiveMapper({ generation: 2 });
    mapper.mapMessage(messageStart('message-canonical'), TURN_ID, 'start');
    const streamed = mapper.mapMessage(textStart(0, 'streamed'), TURN_ID, 'stream');

    expect(mapper.mapMessage(canonicalAssistant(), TURN_ID, 'canonical')).toEqual([]);
    expect(streamed).toHaveLength(1);
    expect(mapper.mapMessage(canonicalAssistant('nested-tool'), TURN_ID, 'nested')).toEqual([]);
  });

  it('no-ops missing or mismatched targets and isolates diagnostic callback failures', () => {
    const diagnostics: Array<{ readonly code: string; readonly type: string }> = [];
    const mapper = new ClaudeLiveMapper({
      generation: 3,
      onDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
        throw new Error('diagnostic consumer failed');
      },
    });

    expect(mapper.mapMessage(textDelta(0, 'missing'), TURN_ID, 'missing')).toEqual([]);
    mapper.mapMessage(messageStart('message-diagnostics'), TURN_ID, 'start');
    mapper.mapMessage(thinkingStart(0, 'thinking'), TURN_ID, 'thinking-start');
    expect(mapper.mapMessage(thinkingDelta(0, 'wrong-turn'), createTurnId('other-turn'), 'wrong-turn')).toEqual([]);
    expect(mapper.mapMessage(
      partial({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'redacted_thinking', data: 'safe-only-diagnostic' },
      } satisfies ContentBlockStartEvent),
      TURN_ID,
      'unsupported',
    )).toEqual([]);

    expect(diagnostics).toEqual([
      { code: 'missing_block_target', type: 'content_block_delta' },
      { code: 'mismatched_block_target', type: 'content_block_delta' },
      { code: 'unsupported_content_block', type: 'redacted_thinking' },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain('safe-only-diagnostic');

    const stillWorks = mapper.mapMessage(textStart(2, ''), TURN_ID, 'still-works');
    expect(stillWorks).toHaveLength(1);
  });

  it('returns immutable actions and equal inputs produce equal outputs', () => {
    const first = new ClaudeLiveMapper({ generation: 12 });
    const second = new ClaudeLiveMapper({ generation: 12 });
    const firstActions = mapSequence(first, [messageStart('same-message'), textStart(0, 'same')]);
    const secondActions = mapSequence(second, [messageStart('same-message'), textStart(0, 'same')]);
    const directActions = first.mapMessage(textStart(1, 'direct'), TURN_ID, 'direct');

    expect(secondActions).toEqual(firstActions);
    expect(Object.isFrozen(directActions)).toBe(true);
    expect(Object.isFrozen(directActions[0])).toBe(true);
    const firstPart = (directActions[0] as Extract<ChatAction, { type: 'chat/responsePartAdded' }>).part;
    expect(Object.isFrozen(firstPart)).toBe(true);

    const toolMapper = new ClaudeLiveMapper({ generation: 13 });
    toolMapper.mapMessage(messageStart('id-parser'), TURN_ID, 'start');
    const toolAction = toolMapper.mapMessage(toolStart(0, 'raw/with spaces'), TURN_ID, 'tool');
    const toolPart = toolAction[0] as Extract<ChatAction, { type: 'chat/toolCallStarted' }>;
    expect(parsePartId(toolPart.partId)).toBe(toolPart.partId);
    expect(parseToolCallId(toolPart.toolCallId)).toBe(toolPart.toolCallId);
    expect(new TextEncoder().encode(toolPart.partId).byteLength).toBeLessThanOrEqual(256);
    expect(new TextEncoder().encode(toolPart.toolCallId).byteLength).toBeLessThanOrEqual(256);
    expect(toolPart.toolCallId).not.toContain('raw');
  });
});
