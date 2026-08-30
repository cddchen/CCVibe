import type { UUID } from 'node:crypto';

import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  createClaudeUserMessage,
  type CreateClaudeUserMessageInput,
} from '../../src/claude/userMessage.js';

const sdkUuid: UUID = '00000000-0000-4000-8000-000000000001';
const sdkSessionId = '00000000-0000-4000-8000-000000000002';

function input(overrides: Partial<CreateClaudeUserMessageInput> = {}): CreateClaudeUserMessageInput {
  return {
    prompt: 'hello Claude',
    sdkUuid,
    sdkSessionId,
    ...overrides,
  };
}

describe('createClaudeUserMessage', () => {
  it('returns the official SDKUserMessage shape with explicit UUID/session fields', () => {
    const message = createClaudeUserMessage(input());

    expectTypeOf(message).toEqualTypeOf<SDKUserMessage>();
    expect(message).toEqual({
      type: 'user',
      message: { role: 'user', content: 'hello Claude' },
      parent_tool_use_id: null,
      uuid: sdkUuid,
      session_id: sdkSessionId,
    });
  });

  it('marks steering messages with priority now and leaves ordinary sends unprioritized', () => {
    const ordinary = createClaudeUserMessage(input());
    const steering = createClaudeUserMessage(input({ steering: true }));

    expect(ordinary).not.toHaveProperty('priority');
    expect(steering).toMatchObject({ priority: 'now' });
  });

  it.each([
    ['empty prompt', { prompt: '' }],
    ['whitespace prompt', { prompt: '   ' }],
    ['empty session', { sdkSessionId: '' }],
    ['empty UUID', { sdkUuid: '' as UUID }],
  ])('rejects %s at runtime', (_name, overrides) => {
    expect(() => createClaudeUserMessage(input(overrides))).toThrow(TypeError);
  });

  it('rejects forged steering values', () => {
    const forged = input({ steering: 'now' as unknown as boolean });

    expect(() => createClaudeUserMessage(forged)).toThrow(TypeError);
  });
});
