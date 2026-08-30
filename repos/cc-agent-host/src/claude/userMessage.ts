import type { UUID } from 'node:crypto';

import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export interface CreateClaudeUserMessageInput {
  readonly prompt: string;
  readonly sdkUuid: UUID;
  readonly sdkSessionId: string;
  readonly steering?: boolean;
}

/**
 * Builds the SDK user message used by the long-lived Claude query input.
 * UUID allocation belongs to the runtime so the CCVibe turn-to-SDK mapping is
 * explicit and testable.
 */
export function createClaudeUserMessage(
  input: CreateClaudeUserMessageInput,
): SDKUserMessage {
  validateInput(input);

  const message = {
    type: 'user',
    message: {
      role: 'user',
      content: input.prompt,
    },
    parent_tool_use_id: null,
    uuid: input.sdkUuid,
    session_id: input.sdkSessionId,
    ...(input.steering === true ? { priority: 'now' } : {}),
  } satisfies SDKUserMessage;

  return message;
}

function validateInput(input: CreateClaudeUserMessageInput): void {
  if (!isRecord(input)) {
    throw new TypeError('input must be an object');
  }
  if (typeof input.prompt !== 'string' || input.prompt.trim().length === 0) {
    throw new TypeError('prompt must be a non-empty string');
  }
  if (typeof input.sdkSessionId !== 'string' || input.sdkSessionId.trim().length === 0) {
    throw new TypeError('sdkSessionId must be a non-empty string');
  }
  if (typeof input.sdkUuid !== 'string' || input.sdkUuid.trim().length === 0) {
    throw new TypeError('sdkUuid must be a non-empty UUID');
  }
  if (input.steering !== undefined && typeof input.steering !== 'boolean') {
    throw new TypeError('steering must be a boolean when provided');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
