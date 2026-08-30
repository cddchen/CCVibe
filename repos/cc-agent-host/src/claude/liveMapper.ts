import { createHash } from 'node:crypto';

import type {
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKUserMessage,
  SDKUserMessageReplay,
} from '@anthropic-ai/claude-agent-sdk';

import type {
  ChatAction,
  ResponsePartAddedAction,
  ResponsePartDeltaAction,
  ToolCallCompletedAction,
  ToolCallInputDeltaAction,
  ToolCallReadyAction,
  ToolCallStartedAction,
} from '../domain/actions.js';
import {
  createPartId,
  createToolCallId,
  type PartId,
  type ToolCallId,
  type TurnId,
} from '../domain/ids.js';

export interface ClaudeLiveMapperDiagnostic {
  readonly code: string;
  readonly type: string;
}

export type ClaudeLiveMapperDiagnosticCallback = (
  diagnostic: ClaudeLiveMapperDiagnostic,
) => void;

export type ClaudeLiveMapperUnsupportedCallback = (type: string) => void;

export interface ClaudeLiveMapperOptions {
  readonly generation: number | string;
  readonly onDiagnostic?: ClaudeLiveMapperDiagnosticCallback;
  readonly onUnsupported?: ClaudeLiveMapperUnsupportedCallback;
  readonly diagnostic?: ClaudeLiveMapperDiagnosticCallback;
}

type BlockKind = 'markdown' | 'reasoning' | 'tool_call';
type BlockState = 'active' | 'stopped' | 'ready';

interface ActiveBlock {
  readonly kind: BlockKind;
  readonly turnId: TurnId;
  readonly partId: PartId;
  readonly toolCallId?: ToolCallId;
  state: BlockState;
}

interface ToolMapping {
  readonly turnId: TurnId;
  readonly partId: PartId;
  readonly toolCallId: ToolCallId;
}

const EMPTY_ACTIONS: readonly ChatAction[] = Object.freeze([]);
const SAFE_TYPE = /^[A-Za-z0-9_.:-]+$/u;
const MAX_DIAGNOSTIC_TYPE_LENGTH = 64;

/**
 * Converts provider stream envelopes into domain actions.
 *
 * A mapper belongs to one runtime generation. The message-local block index map
 * is reset for every streamed assistant message, while tool mappings survive
 * until the later user tool_result message completes them.
 */
export class ClaudeLiveMapper {
  private readonly generation: string;
  private readonly onDiagnostic: ClaudeLiveMapperDiagnosticCallback | undefined;
  private readonly onUnsupported: ClaudeLiveMapperUnsupportedCallback | undefined;
  private readonly blocksByIndex = new Map<number, ActiveBlock>();
  private readonly toolsByRawId = new Map<string, ToolMapping>();

  private messageOrdinal = 0;
  private messageEnvelopeId: string | undefined;

  public constructor(options: ClaudeLiveMapperOptions);
  public constructor(
    generation: number | string,
    onDiagnostic?: ClaudeLiveMapperDiagnosticCallback,
  );
  public constructor(
    optionsOrGeneration: ClaudeLiveMapperOptions | number | string,
    onDiagnostic?: ClaudeLiveMapperDiagnosticCallback,
  ) {
    const options: ClaudeLiveMapperOptions =
      typeof optionsOrGeneration === 'object'
        ? optionsOrGeneration
        : onDiagnostic === undefined
          ? { generation: optionsOrGeneration }
          : { generation: optionsOrGeneration, onDiagnostic };

    validateGeneration(options.generation);
    this.generation = String(options.generation);
    this.onDiagnostic = options.onDiagnostic ?? options.diagnostic;
    this.onUnsupported = options.onUnsupported;
  }

  /**
   * Maps one official SDK message. The supplied timestamp is the only timestamp
   * used by the returned actions.
   */
  public mapMessage(
    message: SDKMessage,
    turnId: TurnId,
    timestamp: string,
  ): readonly ChatAction[] {
    switch (message.type) {
      case 'stream_event':
        return this.mapPartialAssistantMessage(message, turnId, timestamp);
      case 'user':
        return this.mapUserMessage(message, timestamp);
      case 'assistant':
        return this.mapCanonicalAssistantMessage(message.parent_tool_use_id);
      default:
        this.emitDiagnostic('unsupported_message', message.type);
        return EMPTY_ACTIONS;
    }
  }

  /** Backwards-compatible short name for internal Claude-layer callers. */
  public map(message: SDKMessage, turnId: TurnId, timestamp: string): readonly ChatAction[] {
    return this.mapMessage(message, turnId, timestamp);
  }

  /** Clears all message-local and cross-message state for this generation. */
  public reset(): void {
    this.blocksByIndex.clear();
    this.toolsByRawId.clear();
    this.messageOrdinal = 0;
    this.messageEnvelopeId = undefined;
  }

  /**
   * Removes state belonging to one turn. This is useful when a runtime is
   * retired after its terminal action has been committed.
   */
  public clearTurn(turnId: TurnId): void {
    for (const [index, block] of this.blocksByIndex) {
      if (block.turnId === turnId) {
        this.blocksByIndex.delete(index);
      }
    }
    for (const [rawToolUseId, mapping] of this.toolsByRawId) {
      if (mapping.turnId === turnId) {
        this.toolsByRawId.delete(rawToolUseId);
      }
    }
  }

  private mapPartialAssistantMessage(
    message: SDKPartialAssistantMessage,
    turnId: TurnId,
    timestamp: string,
  ): readonly ChatAction[] {
    if (message.parent_tool_use_id !== null) {
      this.emitDiagnostic('nested_subagent_message', 'stream_event');
      return EMPTY_ACTIONS;
    }

    const event = message.event;
    switch (event.type) {
      case 'message_start':
        this.blocksByIndex.clear();
        this.messageOrdinal += 1;
        this.messageEnvelopeId = event.message.id || message.uuid;
        return EMPTY_ACTIONS;
      case 'content_block_start':
        return this.mapContentBlockStart(event.index, event.content_block, turnId, timestamp, message.uuid);
      case 'content_block_delta':
        return this.mapContentBlockDelta(event.index, event.delta, turnId, timestamp);
      case 'content_block_stop':
        return this.mapContentBlockStop(event.index, turnId, timestamp);
      case 'message_delta':
      case 'message_stop':
        return EMPTY_ACTIONS;
      default: {
        const eventType = (event as unknown as { readonly type?: unknown }).type;
        this.emitDiagnostic(
          'unsupported_stream_event',
          typeof eventType === 'string' ? eventType : 'unknown',
        );
        return EMPTY_ACTIONS;
      }
    }
  }

  private mapContentBlockStart(
    index: number,
    contentBlock: Extract<SDKPartialAssistantMessage['event'], { type: 'content_block_start' }>['content_block'],
    turnId: TurnId,
    timestamp: string,
    messageUuid: string,
  ): readonly ChatAction[] {
    if (this.blocksByIndex.has(index)) {
      this.emitDiagnostic('duplicate_block_index', 'content_block_start');
      return EMPTY_ACTIONS;
    }

    const envelopeId = this.messageEnvelopeId ?? messageUuid;
    switch (contentBlock.type) {
      case 'text': {
        const partId = this.createPartId(turnId, envelopeId, index, 'markdown', '');
        const block: ActiveBlock = {
          kind: 'markdown',
          turnId,
          partId,
          state: 'active',
        };
        this.blocksByIndex.set(index, block);
        const part = Object.freeze({ kind: 'markdown' as const, id: partId, content: contentBlock.text });
        const action: ResponsePartAddedAction = Object.freeze({
          type: 'chat/responsePartAdded',
          turnId,
          part,
          timestamp,
        });
        return freezeActions([action]);
      }
      case 'thinking': {
        const partId = this.createPartId(turnId, envelopeId, index, 'reasoning', '');
        const block: ActiveBlock = {
          kind: 'reasoning',
          turnId,
          partId,
          state: 'active',
        };
        this.blocksByIndex.set(index, block);
        const part = Object.freeze({
          kind: 'reasoning' as const,
          id: partId,
          content: contentBlock.thinking,
        });
        const action: ResponsePartAddedAction = Object.freeze({
          type: 'chat/responsePartAdded',
          turnId,
          part,
          timestamp,
        });
        return freezeActions([action]);
      }
      case 'tool_use': {
        const partId = this.createPartId(turnId, envelopeId, index, 'tool_call', contentBlock.id);
        const toolCallId = this.createToolCallId(turnId, envelopeId, index, contentBlock.id);
        const block: ActiveBlock = {
          kind: 'tool_call',
          turnId,
          partId,
          toolCallId,
          state: 'active',
        };
        this.blocksByIndex.set(index, block);
        this.toolsByRawId.set(contentBlock.id, { turnId, partId, toolCallId });
        const action: ToolCallStartedAction = Object.freeze({
          type: 'chat/toolCallStarted',
          turnId,
          partId,
          toolCallId,
          name: contentBlock.name,
          input: '',
          timestamp,
        });
        return freezeActions([action]);
      }
      default: {
        const blockType = (contentBlock as unknown as { readonly type?: unknown }).type;
        this.emitDiagnostic(
          'unsupported_content_block',
          typeof blockType === 'string' ? blockType : 'unknown',
        );
        return EMPTY_ACTIONS;
      }
    }
  }

  private mapContentBlockDelta(
    index: number,
    delta: Extract<SDKPartialAssistantMessage['event'], { type: 'content_block_delta' }>['delta'],
    turnId: TurnId,
    timestamp: string,
  ): readonly ChatAction[] {
    const block = this.blocksByIndex.get(index);
    if (block === undefined) {
      this.emitDiagnostic('missing_block_target', 'content_block_delta');
      return EMPTY_ACTIONS;
    }
    if (block.turnId !== turnId || block.state !== 'active') {
      this.emitDiagnostic('mismatched_block_target', 'content_block_delta');
      return EMPTY_ACTIONS;
    }

    if (block.kind === 'markdown' && delta.type === 'text_delta') {
      return this.responsePartDelta(block, delta.text, turnId, timestamp);
    }
    if (block.kind === 'reasoning' && delta.type === 'thinking_delta') {
      return this.responsePartDelta(block, delta.thinking, turnId, timestamp);
    }
    if (block.kind === 'tool_call' && delta.type === 'input_json_delta') {
      return this.toolCallInputDelta(block, delta.partial_json, turnId, timestamp);
    }

    this.emitDiagnostic('unsupported_or_mismatched_delta', delta.type);
    return EMPTY_ACTIONS;
  }

  private responsePartDelta(
    block: ActiveBlock,
    delta: string,
    turnId: TurnId,
    timestamp: string,
  ): readonly ChatAction[] {
    if (delta.length === 0) {
      return EMPTY_ACTIONS;
    }
    const action: ResponsePartDeltaAction = Object.freeze({
      type: 'chat/responsePartDelta',
      turnId,
      partId: block.partId,
      delta,
      timestamp,
    });
    return freezeActions([action]);
  }

  private toolCallInputDelta(
    block: ActiveBlock,
    delta: string,
    turnId: TurnId,
    timestamp: string,
  ): readonly ChatAction[] {
    if (block.toolCallId === undefined || delta.length === 0) {
      return EMPTY_ACTIONS;
    }
    const action: ToolCallInputDeltaAction = Object.freeze({
      type: 'chat/toolCallInputDelta',
      turnId,
      partId: block.partId,
      toolCallId: block.toolCallId,
      delta,
      timestamp,
    });
    return freezeActions([action]);
  }

  private mapContentBlockStop(
    index: number,
    turnId: TurnId,
    timestamp: string,
  ): readonly ChatAction[] {
    const block = this.blocksByIndex.get(index);
    if (block === undefined) {
      this.emitDiagnostic('missing_block_target', 'content_block_stop');
      return EMPTY_ACTIONS;
    }
    if (block.turnId !== turnId || block.state !== 'active') {
      this.emitDiagnostic('mismatched_block_target', 'content_block_stop');
      return EMPTY_ACTIONS;
    }

    block.state = 'stopped';
    if (block.kind !== 'tool_call' || block.toolCallId === undefined) {
      return EMPTY_ACTIONS;
    }

    block.state = 'ready';
    const action: ToolCallReadyAction = Object.freeze({
      type: 'chat/toolCallReady',
      turnId,
      partId: block.partId,
      toolCallId: block.toolCallId,
      timestamp,
    });
    return freezeActions([action]);
  }

  private mapUserMessage(
    message: SDKUserMessage | SDKUserMessageReplay,
    timestamp: string,
  ): readonly ChatAction[] {
    if (message.parent_tool_use_id !== null) {
      this.emitDiagnostic('nested_subagent_message', 'user');
      return EMPTY_ACTIONS;
    }

    const content = message.message.content;
    if (typeof content === 'string' || !Array.isArray(content)) {
      return EMPTY_ACTIONS;
    }

    const actions: ChatAction[] = [];
    for (const block of content) {
      if (block.type !== 'tool_result') {
        continue;
      }

      const mapping = this.toolsByRawId.get(block.tool_use_id);
      if (mapping === undefined) {
        this.emitDiagnostic('unmatched_tool_result', 'tool_result');
        continue;
      }

      this.toolsByRawId.delete(block.tool_use_id);
      const resultText = extractToolResultText(block.content);
      const base = {
        type: 'chat/toolCallCompleted' as const,
        turnId: mapping.turnId,
        partId: mapping.partId,
        toolCallId: mapping.toolCallId,
        timestamp,
      };
      const action: ToolCallCompletedAction =
        block.is_error === true
          ? Object.freeze({ ...base, error: resultText })
          : Object.freeze({ ...base, result: resultText });
      actions.push(action);
    }

    return freezeActions(actions);
  }

  private mapCanonicalAssistantMessage(parentToolUseId: string | null): readonly ChatAction[] {
    if (parentToolUseId !== null) {
      this.emitDiagnostic('nested_subagent_message', 'assistant');
      return EMPTY_ACTIONS;
    }

    // The partial stream owns top-level text/thinking/tool projection. A
    // canonical assistant frame is deliberately not replayed here: without a
    // matching partial frame it is still safer to defer/drop than to duplicate
    // content when both forms are delivered by the SDK.
    return EMPTY_ACTIONS;
  }

  private createPartId(
    turnId: TurnId,
    envelopeId: string,
    index: number,
    kind: BlockKind,
    rawToolUseId: string,
  ): PartId {
    const seed = this.hashSeed(turnId, envelopeId, index, kind, rawToolUseId, 'part');
    return createPartId(`part_${seed}`);
  }

  private createToolCallId(
    turnId: TurnId,
    envelopeId: string,
    index: number,
    rawToolUseId: string,
  ): ToolCallId {
    const seed = this.hashSeed(turnId, envelopeId, index, 'tool_call', rawToolUseId, 'tool');
    return createToolCallId(`tool_${seed}`);
  }

  private hashSeed(
    turnId: TurnId,
    envelopeId: string,
    index: number,
    kind: BlockKind,
    rawToolUseId: string,
    outputKind: 'part' | 'tool',
  ): string {
    const fields = [
      'ccvibe-live-mapper',
      outputKind,
      this.generation,
      turnId,
      envelopeId,
      String(this.messageOrdinal),
      String(index),
      kind,
      rawToolUseId,
    ];
    const encoded = fields.map((field) => `${field.length}:${field}`).join('|');
    return createHash('sha256').update(encoded, 'utf8').digest('hex').slice(0, 48);
  }

  private emitDiagnostic(code: string, type: string): void {
    const safeType = safeDiagnosticType(type);
    if (this.onDiagnostic !== undefined) {
      const diagnostic = Object.freeze({ code, type: safeType });
      try {
        this.onDiagnostic(diagnostic);
      } catch {
        // Diagnostics are observational and must never affect mapping.
      }
    }
    if (this.onUnsupported !== undefined && isUnsupportedDiagnostic(code)) {
      try {
        this.onUnsupported(safeType);
      } catch {
        // Diagnostics are observational and must never affect mapping.
      }
    }
  }
}

function extractToolResultText(
  content:
    | string
    | readonly { readonly type: string; readonly text?: string }[]
    | undefined,
): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('');
}

function freezeActions(actions: readonly ChatAction[]): readonly ChatAction[] {
  return actions.length === 0 ? EMPTY_ACTIONS : Object.freeze([...actions]);
}

function safeDiagnosticType(type: string): string {
  if (type.length <= MAX_DIAGNOSTIC_TYPE_LENGTH && SAFE_TYPE.test(type)) {
    return type;
  }
  return 'unknown';
}

function isUnsupportedDiagnostic(code: string): boolean {
  return code.startsWith('unsupported_') || code === 'nested_subagent_message';
}

function validateGeneration(generation: number | string): void {
  if (typeof generation === 'number') {
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      throw new RangeError('generation must be a positive integer');
    }
    return;
  }
  if (typeof generation !== 'string' || generation.trim().length === 0) {
    throw new TypeError('generation must be a non-empty value');
  }
}
