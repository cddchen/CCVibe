import { createHash } from 'node:crypto';

import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';

import type { ChatUri, PartId, ToolCallId, TurnId } from '../domain/ids.js';
import { createPartId, createToolCallId, createTurnId } from '../domain/ids.js';
import type { ResponsePart, ToolCall, Turn } from '../domain/chat.js';
import type { HostStateManager } from '../host/hostStateManager.js';
import type { ChatActionEnvelope } from '../protocol/types.js';

const EMPTY_TURNS: readonly Turn[] = Object.freeze([]);
const INCOMPLETE_TRANSCRIPT = 'incomplete transcript';
const SAFE_TYPE = /^[A-Za-z0-9_.:-]+$/u;
const MAX_DIAGNOSTIC_TYPE_LENGTH = 64;

const CLI_ECHO = /(?:^|\n)\s*<(?:local-command[^>\s]*|command-name|command-message|command-args|command-stdout|command-stderr|local-command-caveat)(?:\s|>)/u;

export interface ClaudeReplayMapperDiagnostic {
  readonly code: string;
  readonly type: string;
}

export type ClaudeReplayMapperDiagnosticCallback = (
  diagnostic: ClaudeReplayMapperDiagnostic,
) => void;

export interface ClaudeReplayMapperOptions {
  /** Used when a transcript record has no timestamp. Defaults to ''. */
  readonly missingTimestamp?: string;
  /** Deterministic per-record fallback, used before missingTimestamp. */
  readonly timestampFallback?: (message: SessionMessage, index: number) => string;
  /** Compatibility aliases for callers using a shorter fallback name. */
  readonly fallbackTimestamp?: (message: SessionMessage, index: number) => string;
  readonly timestamp?: (message: SessionMessage, index: number) => string;
  readonly onDiagnostic?: ClaudeReplayMapperDiagnosticCallback;
  /** Alias retained for Claude-layer callers that use the shorter name. */
  readonly diagnostic?: ClaudeReplayMapperDiagnosticCallback;
}

interface MutableToolCall {
  readonly id: ToolCallId;
  readonly name: string;
  readonly input: string;
  status: 'ready' | 'completed';
  readonly startedAt: string;
  readonly readyAt: string;
  completedAt?: string;
  result?: string;
  error?: string;
}

interface MutableToolPart {
  readonly kind: 'tool_call';
  readonly id: PartId;
  readonly toolCall: MutableToolCall;
}

type MutableResponsePart = Exclude<ResponsePart, { readonly kind: 'tool_call' }> | MutableToolPart;

interface MutableTurn {
  readonly id: TurnId;
  readonly prompt: string;
  readonly parts: MutableResponsePart[];
  readonly startedAt: string;
  lastAt: string;
  status: 'complete' | 'failed';
  error?: string;
  finalized: boolean;
}

interface ToolMapping {
  readonly turn: MutableTurn;
  readonly toolCall: MutableToolCall;
}

type SafeRecord = Record<string, unknown>;

/**
 * Converts SDK session transcript envelopes into immutable CCVibe turns.
 *
 * The SDK's SessionMessage type intentionally leaves `message` as unknown. The
 * runtime narrowing below is therefore local to this Claude-layer adapter and
 * never becomes part of the host/domain protocol surface.
 */
export class ClaudeReplayMapper {
  private readonly missingTimestamp: string;
  private readonly timestampFallback: ((message: SessionMessage, index: number) => string) | undefined;
  private readonly onDiagnostic: ClaudeReplayMapperDiagnosticCallback | undefined;

  public constructor(options: ClaudeReplayMapperOptions = {}) {
    this.missingTimestamp = typeof options.missingTimestamp === 'string' ? options.missingTimestamp : '';
    this.timestampFallback = typeof options.timestampFallback === 'function'
      ? options.timestampFallback
      : typeof options.fallbackTimestamp === 'function'
        ? options.fallbackTimestamp
        : typeof options.timestamp === 'function'
          ? options.timestamp
          : undefined;
    this.onDiagnostic = typeof options.onDiagnostic === 'function'
      ? options.onDiagnostic
      : typeof options.diagnostic === 'function'
        ? options.diagnostic
        : undefined;
  }

  public map(messages: readonly SessionMessage[]): readonly Turn[] {
    const candidates: unknown = messages;
    if (!Array.isArray(candidates)) {
      this.emitDiagnostic('malformed_messages', 'messages');
      return EMPTY_TURNS;
    }

    const turns: MutableTurn[] = [];
    const toolsByRawId = new Map<string, ToolMapping>();
    let currentTurn: MutableTurn | undefined;

    for (const [index, message] of candidates.entries()) {
      const rawMessage: unknown = message;
      const record = asRecord(rawMessage);
      const type = readString(record, 'type');
      const timestamp = this.timestampFor(record, index, rawMessage);

      try {
        switch (type) {
          case 'user': {
            const result = this.mapUserMessage(
              record,
              index,
              timestamp,
              turns,
              currentTurn,
              toolsByRawId,
            );
            currentTurn = result.currentTurn;
            break;
          }
          case 'assistant': {
            const result = this.mapAssistantMessage(
              record,
              index,
              timestamp,
              turns,
              currentTurn,
              toolsByRawId,
            );
            currentTurn = result.currentTurn;
            break;
          }
          case 'system':
            this.emitDiagnostic('unsupported_message', 'system');
            break;
          default:
            this.emitDiagnostic('unsupported_message', type ?? 'unknown');
            break;
        }
      } catch {
        // A malformed transcript row must not prevent later rows from replaying.
        this.emitDiagnostic('malformed_message', type ?? 'unknown');
      }
    }

    for (const turn of turns) {
      this.finalizeTurn(turn);
    }

    return Object.freeze(turns.map(materializeTurn));
  }

  /** Backwards-compatible explicit name for callers that prefer transcript terminology. */
  public mapMessages(messages: readonly SessionMessage[]): readonly Turn[] {
    return this.map(messages);
  }

  public mapSessionMessages(messages: readonly SessionMessage[]): readonly Turn[] {
    return this.map(messages);
  }

  private mapUserMessage(
    record: SafeRecord | undefined,
    index: number,
    timestamp: string,
    turns: MutableTurn[],
    currentTurn: MutableTurn | undefined,
    toolsByRawId: Map<string, ToolMapping>,
  ): { readonly currentTurn: MutableTurn | undefined } {
    const rawMessage = readProperty(record, 'message');
    const content = contentFromEnvelope(rawMessage);
    if (content === undefined) {
      this.emitDiagnostic('malformed_message', 'user');
      return { currentTurn };
    }

    const textParts: string[] = [];
    const toolResults: ToolResult[] = [];
    if (typeof content === 'string') {
      if (!isCliEcho(content)) {
        textParts.push(content);
      }
    } else if (Array.isArray(content)) {
      for (const [blockIndex, rawBlock] of content.entries()) {
        const block = asRecord(rawBlock);
        const blockType = readString(block, 'type');
        if (blockType === 'text') {
          const text = readString(block, 'text');
          if (text !== undefined && !isCliEcho(text)) {
            textParts.push(text);
          }
          continue;
        }
        if (blockType === 'tool_result') {
          const toolResult = this.readToolResult(block);
          if (toolResult === undefined) {
            this.emitDiagnostic('malformed_tool_result', 'tool_result');
          } else {
            toolResults.push(toolResult);
          }
          continue;
        }
        if (blockType !== undefined || rawBlock !== undefined) {
          this.emitDiagnostic('unsupported_content_block', blockType ?? 'unknown');
        } else {
          this.emitDiagnostic('malformed_content_block', `user_${blockIndex}`);
        }
      }
    } else {
      this.emitDiagnostic('malformed_content', 'user');
      return { currentTurn };
    }

    // Tool results belong to the tool's originating turn even if a malformed or
    // mixed envelope also carries user text. Resolve them before opening the
    // next prompt turn.
    for (const toolResult of toolResults) {
      this.completeTool(toolResult, timestamp, toolsByRawId);
    }

    if (textParts.length === 0) {
      return { currentTurn };
    }

    const prompt = textParts.join('\n');
    const nextTurn = this.startTurn(
      prompt,
      record,
      index,
      timestamp,
      turns,
      currentTurn,
    );
    return { currentTurn: nextTurn };
  }

  private mapAssistantMessage(
    record: SafeRecord | undefined,
    index: number,
    timestamp: string,
    turns: MutableTurn[],
    currentTurn: MutableTurn | undefined,
    toolsByRawId: Map<string, ToolMapping>,
  ): { readonly currentTurn: MutableTurn | undefined } {
    const parentToolUseId = readProperty(record, 'parent_tool_use_id');
    if (parentToolUseId !== undefined && parentToolUseId !== null && typeof parentToolUseId !== 'string') {
      this.emitDiagnostic('malformed_message', 'assistant');
      return { currentTurn };
    }
    if (typeof parentToolUseId === 'string' && parentToolUseId.length > 0) {
      this.emitDiagnostic('nested_subagent_message', 'assistant');
      return { currentTurn };
    }

    const rawMessage = readProperty(record, 'message');
    const content = contentFromEnvelope(rawMessage);
    if (content === undefined) {
      this.emitDiagnostic('malformed_message', 'assistant');
      return { currentTurn };
    }
    if (typeof content !== 'string' && !Array.isArray(content)) {
      this.emitDiagnostic('malformed_content', 'assistant');
      return { currentTurn };
    }

    const nextTurn = currentTurn ?? this.startTurn('', record, index, timestamp, turns, undefined);
    nextTurn.lastAt = timestamp;
    nextTurn.finalized = false;

    if (typeof content === 'string') {
      this.appendMarkdown(nextTurn, content, record, index, 0);
      return { currentTurn: nextTurn };
    }

    for (const [blockIndex, rawBlock] of content.entries()) {
      const block = asRecord(rawBlock);
      const blockType = readString(block, 'type');
      switch (blockType) {
        case 'text': {
          const text = readString(block, 'text');
          if (text === undefined) {
            this.emitDiagnostic('malformed_content_block', 'text');
            break;
          }
          this.appendMarkdown(nextTurn, text, record, index, blockIndex);
          break;
        }
        case 'thinking': {
          const thinking = readString(block, 'thinking');
          if (thinking === undefined) {
            this.emitDiagnostic('malformed_content_block', 'thinking');
            break;
          }
          this.appendReasoning(nextTurn, thinking, record, index, blockIndex);
          break;
        }
        case 'tool_use':
          this.appendTool(nextTurn, block, record, index, blockIndex, timestamp, toolsByRawId);
          break;
        default:
          this.emitDiagnostic('unsupported_content_block', blockType ?? 'unknown');
          break;
      }
    }

    return { currentTurn: nextTurn };
  }

  private appendMarkdown(
    turn: MutableTurn,
    content: string,
    record: SafeRecord | undefined,
    messageIndex: number,
    blockIndex: number,
  ): void {
    const id = makePartId(turn.id, recordIdentity(record, messageIndex), blockIndex, 'markdown');
    turn.parts.push(Object.freeze({ kind: 'markdown' as const, id, content }));
  }

  private appendReasoning(
    turn: MutableTurn,
    content: string,
    record: SafeRecord | undefined,
    messageIndex: number,
    blockIndex: number,
  ): void {
    const id = makePartId(turn.id, recordIdentity(record, messageIndex), blockIndex, 'reasoning');
    turn.parts.push(Object.freeze({ kind: 'reasoning' as const, id, content }));
  }

  private appendTool(
    turn: MutableTurn,
    block: SafeRecord | undefined,
    record: SafeRecord | undefined,
    messageIndex: number,
    blockIndex: number,
    timestamp: string,
    toolsByRawId: Map<string, ToolMapping>,
  ): void {
    const rawToolId = readString(block, 'id');
    if (rawToolId === undefined || rawToolId.length === 0) {
      this.emitDiagnostic('malformed_tool_use', 'tool_use');
      return;
    }

    const name = readString(block, 'name') ?? '';
    const input = stableStringify(readProperty(block, 'input'));
    const identity = recordIdentity(record, messageIndex);
    const partId = makePartId(turn.id, identity, blockIndex, 'tool_call', rawToolId);
    const toolCallId = makeToolCallId(turn.id, identity, blockIndex, rawToolId);
    const toolCall: MutableToolCall = {
      id: toolCallId,
      name,
      input,
      status: 'ready',
      startedAt: timestamp,
      readyAt: timestamp,
    };
    const part: MutableToolPart = {
      kind: 'tool_call',
      id: partId,
      toolCall,
    };
    turn.parts.push(part);
    const previous = toolsByRawId.get(rawToolId);
    if (previous !== undefined) {
      this.emitDiagnostic('duplicate_tool_use_id', 'tool_use');
    }
    toolsByRawId.set(rawToolId, { turn, toolCall });
  }

  private readToolResult(block: SafeRecord | undefined): ToolResult | undefined {
    const rawToolId = readString(block, 'tool_use_id');
    if (rawToolId === undefined || rawToolId.length === 0) {
      return undefined;
    }
    const content = readProperty(block, 'content');
    const isError = readProperty(block, 'is_error') === true;
    return {
      rawToolId,
      content: toolResultText(content),
      isError,
    };
  }

  private completeTool(
    toolResult: ToolResult,
    timestamp: string,
    toolsByRawId: Map<string, ToolMapping>,
  ): void {
    const mapping = toolsByRawId.get(toolResult.rawToolId);
    if (mapping === undefined) {
      this.emitDiagnostic('unmatched_tool_result', 'tool_result');
      return;
    }

    toolsByRawId.delete(toolResult.rawToolId);
    mapping.toolCall.status = 'completed';
    mapping.toolCall.completedAt = timestamp;
    delete mapping.toolCall.result;
    delete mapping.toolCall.error;
    if (toolResult.isError) {
      mapping.toolCall.error = toolResult.content;
    } else {
      mapping.toolCall.result = toolResult.content;
    }
    mapping.turn.lastAt = timestamp;
    mapping.turn.finalized = false;
  }

  private startTurn(
    prompt: string,
    record: SafeRecord | undefined,
    messageIndex: number,
    timestamp: string,
    turns: MutableTurn[],
    currentTurn: MutableTurn | undefined,
  ): MutableTurn {
    if (currentTurn !== undefined) {
      this.finalizeTurn(currentTurn);
    }

    const id = makeTurnId(record, messageIndex);
    const turn: MutableTurn = {
      id,
      prompt,
      parts: [],
      startedAt: timestamp,
      lastAt: timestamp,
      status: 'complete',
      finalized: false,
    };
    turns.push(turn);
    return turn;
  }

  private finalizeTurn(turn: MutableTurn): void {
    const incomplete = turn.parts.some(
      (part) => part.kind === 'tool_call' && part.toolCall.status === 'ready',
    );
    if (incomplete) {
      for (const part of turn.parts) {
        if (part.kind !== 'tool_call' || part.toolCall.status !== 'ready') {
          continue;
        }
        part.toolCall.status = 'completed';
        part.toolCall.completedAt = turn.lastAt;
        delete part.toolCall.result;
        part.toolCall.error = INCOMPLETE_TRANSCRIPT;
      }
      turn.status = 'failed';
      turn.error = INCOMPLETE_TRANSCRIPT;
    } else {
      turn.status = 'complete';
      delete turn.error;
    }
    turn.finalized = true;
  }

  private timestampFor(
    record: SafeRecord | undefined,
    index: number,
    rawMessage: unknown,
  ): string {
    const recordTimestamp = readString(record, 'timestamp');
    if (recordTimestamp !== undefined) {
      return recordTimestamp;
    }
    const nestedMessage = readProperty(record, 'message');
    const messageTimestamp = readString(asRecord(nestedMessage), 'timestamp');
    if (messageTimestamp !== undefined) {
      return messageTimestamp;
    }
    if (this.timestampFallback !== undefined) {
      try {
        const fallback = this.timestampFallback(rawMessage as SessionMessage, index);
        if (typeof fallback === 'string') {
          return fallback;
        }
      } catch {
        // A diagnostic/timestamp consumer is observational only.
      }
    }
    return this.missingTimestamp;
  }

  private emitDiagnostic(code: string, type: string): void {
    if (this.onDiagnostic === undefined) {
      return;
    }
    const diagnostic = Object.freeze({ code, type: safeDiagnosticType(type) });
    try {
      this.onDiagnostic(diagnostic);
    } catch {
      // Diagnostics must never change transcript replay behavior.
    }
  }
}

interface ToolResult {
  readonly rawToolId: string;
  readonly content: string;
  readonly isError: boolean;
}

/** Convenience function for one-shot history mapping. */
export function mapClaudeHistory(
  messages: readonly SessionMessage[],
  options: ClaudeReplayMapperOptions = {},
): readonly Turn[] {
  return new ClaudeReplayMapper(options).map(messages);
}

/** Descriptive alias used by older Claude history call sites. */
export const mapSessionMessagesToTurns = mapClaudeHistory;

/** SDK-layer hydration helper; it commits exactly one turnsLoaded action. */
export function hydrateClaudeHistory(
  host: HostStateManager,
  chatUri: ChatUri,
  messages: readonly SessionMessage[],
  timestamp: string,
): ChatActionEnvelope | undefined {
  const turns = mapClaudeHistory(messages);
  return host.dispatch(chatUri, {
    type: 'chat/turnsLoaded',
    turns,
    timestamp,
  });
}

/** Deterministic JSON serialization for tool inputs. */
export function stableStringify(value: unknown): string {
  try {
    return stableStringifyValue(value, new Set<object>());
  } catch {
    return JSON.stringify('[unreadable]');
  }
}

function stableStringifyValue(value: unknown, ancestors: Set<object>): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(`[non-serializable:number:${String(value)}]`);
    case 'undefined':
      return JSON.stringify('[undefined]');
    case 'bigint':
      return JSON.stringify('[non-serializable:bigint]');
    case 'symbol':
      return JSON.stringify('[non-serializable:symbol]');
    case 'function':
      return JSON.stringify('[non-serializable:function]');
    case 'object':
      break;
    default:
      return JSON.stringify('[non-serializable]');
  }

  if (ancestors.has(value)) {
    return JSON.stringify('[cycle]');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      let length: number;
      try {
        length = value.length;
      } catch {
        return JSON.stringify('[unreadable]');
      }
      const items: string[] = [];
      for (let index = 0; index < length; index += 1) {
        let item: unknown;
        try {
          item = value[index];
        } catch {
          item = '[unreadable]';
        }
        try {
          items.push(stableStringifyValue(item, ancestors));
        } catch {
          items.push(JSON.stringify('[unreadable]'));
        }
      }
      return `[${items.join(',')}]`;
    }

    if (!isPlainObject(value)) {
      return JSON.stringify('[non-serializable:object]');
    }

    let keys: string[];
    try {
      keys = Object.keys(value).sort();
    } catch {
      return JSON.stringify('[unreadable]');
    }
    const entries: string[] = [];
    for (const key of keys) {
      let child: unknown;
      try {
        child = value[key];
      } catch {
        child = '[unreadable]';
      }
      entries.push(`${JSON.stringify(key)}:${stableStringifyValue(child, ancestors)}`);
    }
    return `{${entries.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function isPlainObject(value: object): value is SafeRecord {
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
  } catch {
    return false;
  }
  return prototype === Object.prototype || prototype === null;
}

function contentFromEnvelope(value: unknown): unknown {
  if (typeof value === 'string' || Array.isArray(value)) {
    return value;
  }
  const record = asRecord(value);
  return readProperty(record, 'content');
}

function toolResultText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (!Array.isArray(value)) {
    return '';
  }
  const texts: string[] = [];
  for (const rawBlock of value) {
    const block = asRecord(rawBlock);
    if (readString(block, 'type') !== 'text') {
      continue;
    }
    const text = readString(block, 'text');
    if (text !== undefined) {
      texts.push(text);
    }
  }
  return texts.join('');
}

function asRecord(value: unknown): SafeRecord | undefined {
  return typeof value === 'object' && value !== null ? value as SafeRecord : undefined;
}

function readProperty(record: SafeRecord | undefined, key: string): unknown {
  if (record === undefined) {
    return undefined;
  }
  try {
    return record[key];
  } catch {
    return undefined;
  }
}

function readString(record: SafeRecord | undefined, key: string): string | undefined {
  const value = readProperty(record, key);
  return typeof value === 'string' ? value : undefined;
}

function recordIdentity(record: SafeRecord | undefined, messageIndex: number): string {
  const uuid = readString(record, 'uuid');
  return uuid !== undefined && uuid.length > 0 ? `uuid:${uuid}` : `index:${messageIndex}`;
}

function makeTurnId(record: SafeRecord | undefined, messageIndex: number): TurnId {
  const uuid = readString(record, 'uuid');
  if (uuid !== undefined) {
    try {
      return createTurnId(uuid);
    } catch {
      // Invalid, unsafe, and over-length transcript UUIDs use the hashed fallback.
    }
  }
  return createTurnId(`replay_turn_${hash('turn', recordIdentity(record, messageIndex))}`);
}

function makePartId(
  turnId: TurnId,
  identity: string,
  blockIndex: number,
  kind: string,
  rawToolId = '',
): PartId {
  return createPartId(`replay_part_${hash('part', turnId, identity, String(blockIndex), kind, rawToolId)}`);
}

function makeToolCallId(
  turnId: TurnId,
  identity: string,
  blockIndex: number,
  rawToolId: string,
): ToolCallId {
  return createToolCallId(`replay_tool_${hash('tool', turnId, identity, String(blockIndex), rawToolId)}`);
}

function hash(kind: string, ...fields: readonly string[]): string {
  const encoded = [
    'ccvibe-replay-mapper',
    kind,
    ...fields,
  ].map((field) => `${field.length}:${field}`).join('|');
  return createHash('sha256').update(encoded, 'utf8').digest('hex').slice(0, 48);
}

function materializeTurn(turn: MutableTurn): Turn {
  const parts = Object.freeze(turn.parts.map(materializePart));
  const base = {
    id: turn.id,
    prompt: turn.prompt,
    status: turn.status,
    parts,
    startedAt: turn.startedAt,
    completedAt: turn.lastAt,
  } satisfies Omit<Turn, 'error'>;
  const withError = turn.error === undefined ? base : { ...base, error: turn.error };
  return Object.freeze(withError);
}

function materializePart(part: MutableResponsePart): ResponsePart {
  if (part.kind !== 'tool_call') {
    return Object.freeze({ ...part });
  }
  const toolCall = materializeToolCall(part.toolCall);
  return Object.freeze({ kind: 'tool_call' as const, id: part.id, toolCall });
}

function materializeToolCall(toolCall: MutableToolCall): ToolCall {
  const base = {
    id: toolCall.id,
    name: toolCall.name,
    input: toolCall.input,
    status: toolCall.status,
    startedAt: toolCall.startedAt,
    readyAt: toolCall.readyAt,
  } satisfies Omit<ToolCall, 'completedAt' | 'result' | 'error'>;
  const withCompletedAt = toolCall.completedAt === undefined
    ? base
    : { ...base, completedAt: toolCall.completedAt };
  const withResult = toolCall.result === undefined
    ? withCompletedAt
    : { ...withCompletedAt, result: toolCall.result };
  const withError = toolCall.error === undefined
    ? withResult
    : { ...withResult, error: toolCall.error };
  return Object.freeze(withError);
}

function isCliEcho(value: string): boolean {
  return CLI_ECHO.test(value);
}

function safeDiagnosticType(value: string): string {
  return value.length <= MAX_DIAGNOSTIC_TYPE_LENGTH && SAFE_TYPE.test(value) ? value : 'unknown';
}
