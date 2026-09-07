import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';

export interface ClaudeRewindPoint {
  readonly userMessageUuid: string;
  /** Absent when rewinding the first prompt, which requires a fresh transcript. */
  readonly previousAssistantUuid?: string;
}

type SafeRecord = Record<string, unknown>;

/** Resolve the two different SDK identifiers needed for a pre-prompt rewind. */
export function resolveClaudeRewindPoint(
  messages: readonly SessionMessage[],
  targetUserMessageUuid: string,
): ClaudeRewindPoint | undefined {
  let previousAssistantUuid: string | undefined;

  for (const message of messages) {
    const record = asRecord(message);
    const type = readString(record, 'type');
    const uuid = readString(record, 'uuid');
    if (type === 'user' && uuid === targetUserMessageUuid && hasUserPrompt(record)) {
      return previousAssistantUuid === undefined
        ? Object.freeze({ userMessageUuid: uuid })
        : Object.freeze({ userMessageUuid: uuid, previousAssistantUuid });
    }
    if (type === 'assistant' && uuid !== undefined && isTopLevel(record)) {
      previousAssistantUuid = uuid;
    }
  }
  return undefined;
}

/** Resolve by product turn order after SDK forkSession has remapped transcript UUIDs. */
export function resolveClaudeRewindPointAtTurn(
  messages: readonly SessionMessage[],
  targetTurnIndex: number,
): ClaudeRewindPoint | undefined {
  if (!Number.isSafeInteger(targetTurnIndex) || targetTurnIndex < 0) return undefined;
  let promptIndex = 0;
  for (const message of messages) {
    const record = asRecord(message);
    if (readString(record, 'type') !== 'user' || !hasUserPrompt(record)) continue;
    const uuid = readString(record, 'uuid');
    if (promptIndex === targetTurnIndex) {
      return uuid === undefined ? undefined : resolveClaudeRewindPoint(messages, uuid);
    }
    promptIndex += 1;
  }
  return undefined;
}

function hasUserPrompt(record: SafeRecord | undefined): boolean {
  if (!isTopLevel(record)) return false;
  const envelope = asRecord(record?.message);
  const content = envelope?.content;
  if (typeof content === 'string') return content.length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    const candidate = asRecord(block);
    return candidate?.type === 'text' && typeof candidate.text === 'string' && candidate.text.length > 0;
  });
}

function isTopLevel(record: SafeRecord | undefined): boolean {
  return record?.parent_tool_use_id === null || record?.parent_tool_use_id === undefined;
}

function asRecord(value: unknown): SafeRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as SafeRecord
    : undefined;
}

function readString(record: SafeRecord | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
