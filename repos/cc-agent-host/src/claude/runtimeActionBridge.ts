import type { ChatAction } from '../domain/actions.js';
import type { ActiveTurn } from '../domain/chat.js';
import type { ChatUri, TurnId } from '../domain/ids.js';
import { parseChatUri } from '../domain/resources.js';
import type { HostStateManager } from '../host/hostStateManager.js';
import type { ChatActionEnvelope } from '../protocol/types.js';
import { ClaudeLiveMapper } from './liveMapper.js';
import type { ClaudeRuntimeSignal } from './runtimeTypes.js';

export interface ClaudeLiveMapperDiagnostic {
  readonly code: string;
  readonly type: string;
}

const EMPTY_ENVELOPES: readonly ChatActionEnvelope[] = Object.freeze([]);
const DEFAULT_CRASH_MESSAGE = 'Claude runtime crashed';
const MAX_SAFE_ERROR_BYTES = 1024;

/** The SDK-free mapper surface accepted by the runtime bridge. */
export interface ClaudeLiveMapperLike {
  mapMessage(message: unknown, turnId: TurnId, timestamp: string): readonly ChatAction[];
  clearTurn(turnId: TurnId): void;
  reset(): void;
}

/** Creates one mapper for one Claude runtime generation. */
export type ClaudeLiveMapperFactory = (
  generation: number,
  onDiagnostic?: (diagnostic: ClaudeLiveMapperDiagnostic) => void,
) => ClaudeLiveMapperLike;

/** Bridge diagnostics are observational and never contain raw protocol data. */
export type ClaudeRuntimeActionBridgeDiagnostic = (error: unknown) => void;

export interface ClaudeRuntimeActionBridgeOptions {
  readonly hostStateManager: HostStateManager;
  readonly nowAction: () => string;
  readonly liveMapperFactory?: ClaudeLiveMapperFactory;
  readonly diagnostic?: ClaudeRuntimeActionBridgeDiagnostic;
}

interface MapperEntry {
  readonly generation: number;
  readonly mapper: ClaudeLiveMapperLike;
}

/**
 * Converts internal Claude runtime signals into Host chat actions.
 *
 * The public signal parameter is intentionally `unknown`: SDK-bearing signal
 * details stay inside the Claude layer while this bridge can still be passed
 * directly to the registry's internal signal observer.
 */
export class ClaudeRuntimeActionBridge {
  private readonly hostStateManager: HostStateManager;
  private readonly nowAction: () => string;
  private readonly liveMapperFactory: ClaudeLiveMapperFactory;
  private readonly diagnostic: ClaudeRuntimeActionBridgeDiagnostic | undefined;
  private readonly mappers = new Map<ChatUri, MapperEntry>();

  public constructor(options: ClaudeRuntimeActionBridgeOptions) {
    if (typeof options !== 'object' || options === null) {
      throw new TypeError('options must be an object');
    }
    if (typeof options.hostStateManager?.dispatch !== 'function') {
      throw new TypeError('hostStateManager must be provided');
    }
    if (typeof options.nowAction !== 'function') {
      throw new TypeError('nowAction must be provided');
    }
    if (options.liveMapperFactory !== undefined && typeof options.liveMapperFactory !== 'function') {
      throw new TypeError('liveMapperFactory must be a function when provided');
    }
    if (options.diagnostic !== undefined && typeof options.diagnostic !== 'function') {
      throw new TypeError('diagnostic must be a function when provided');
    }

    this.hostStateManager = options.hostStateManager;
    this.nowAction = options.nowAction;
    this.diagnostic = options.diagnostic;
    this.liveMapperFactory = options.liveMapperFactory ?? defaultLiveMapperFactory;
  }

  /**
   * Handles one registry signal and returns the envelopes committed by it.
   * Invalid or stale signals are observational no-ops.
   */
  public handle(chatUri: ChatUri, signal: unknown): readonly ChatActionEnvelope[] {
    const parsedChatUri = parseChatUriSafely(chatUri);
    if (parsedChatUri === undefined || !isClaudeRuntimeSignal(signal)) {
      return EMPTY_ENVELOPES;
    }

    const runtimeSignal = signal;
    const entry = this.mapperFor(parsedChatUri, runtimeSignal.generation);
    if (entry === undefined) {
      return EMPTY_ENVELOPES;
    }

    switch (runtimeSignal.type) {
      case 'runtime/init':
        return EMPTY_ENVELOPES;
      case 'runtime/message':
        return this.handleMessage(parsedChatUri, entry, runtimeSignal);
      case 'turn/result':
        return this.handleResult(parsedChatUri, entry, runtimeSignal);
      case 'runtime/terminal':
        return this.handleTerminal(parsedChatUri, entry, runtimeSignal);
      default:
        return EMPTY_ENVELOPES;
    }
  }

  private handleMessage(
    chatUri: ChatUri,
    entry: MapperEntry,
    signal: Extract<ClaudeRuntimeSignal, { readonly type: 'runtime/message' }>,
  ): readonly ChatActionEnvelope[] {
    if (signal.phase !== 'active' || signal.turnId === undefined) {
      return EMPTY_ENVELOPES;
    }

    const timestamp = this.timestamp();
    if (timestamp === undefined) {
      return EMPTY_ENVELOPES;
    }

    let actions: readonly ChatAction[];
    try {
      actions = entry.mapper.mapMessage(signal.message, signal.turnId, timestamp);
    } catch (error) {
      this.report(error);
      return EMPTY_ENVELOPES;
    }
    if (!Array.isArray(actions)) {
      this.report(new TypeError('live mapper must return an action array'));
      return EMPTY_ENVELOPES;
    }
    return this.dispatchActions(chatUri, actions);
  }

  private handleResult(
    chatUri: ChatUri,
    entry: MapperEntry,
    signal: Extract<ClaudeRuntimeSignal, { readonly type: 'turn/result' }>,
  ): readonly ChatActionEnvelope[] {
    const timestamp = this.timestamp();
    if (timestamp === undefined) {
      this.clearTurn(entry.mapper, signal.turnId);
      return EMPTY_ENVELOPES;
    }

    let action: ChatAction;
    switch (signal.outcome.status) {
      case 'completed':
        action = {
          type: 'chat/turnCompleted',
          turnId: signal.turnId,
          timestamp,
        };
        break;
      case 'failed':
        action = {
          type: 'chat/turnFailed',
          turnId: signal.turnId,
          error: safeErrorMessage(signal.outcome.message, 'Claude turn failed'),
          timestamp,
        };
        break;
      case 'interrupted':
      case 'runtime_closed':
        action = {
          type: 'chat/turnInterrupted',
          turnId: signal.turnId,
          timestamp,
        };
        break;
      default:
        this.clearTurn(entry.mapper, signal.turnId);
        return EMPTY_ENVELOPES;
    }

    try {
      return this.dispatchActions(chatUri, [action]);
    } finally {
      this.clearTurn(entry.mapper, signal.turnId);
    }
  }

  private handleTerminal(
    chatUri: ChatUri,
    entry: MapperEntry,
    signal: Extract<ClaudeRuntimeSignal, { readonly type: 'runtime/terminal' }>,
  ): readonly ChatActionEnvelope[] {
    const activeTurn = this.activeTurn(chatUri);
    if (activeTurn === undefined) {
      return EMPTY_ENVELOPES;
    }

    const timestamp = this.timestamp();
    if (timestamp === undefined) {
      this.clearTurn(entry.mapper, activeTurn.id);
      return EMPTY_ENVELOPES;
    }

    const action: ChatAction = signal.state === 'closed'
      ? {
          type: 'chat/turnInterrupted',
          turnId: activeTurn.id,
          timestamp,
        }
      : {
          type: 'chat/turnFailed',
          turnId: activeTurn.id,
          error: DEFAULT_CRASH_MESSAGE,
          timestamp,
        };

    try {
      return this.dispatchActions(chatUri, [action]);
    } finally {
      this.clearTurn(entry.mapper, activeTurn.id);
    }
  }

  private mapperFor(chatUri: ChatUri, generation: number): MapperEntry | undefined {
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      return undefined;
    }

    const current = this.mappers.get(chatUri);
    if (current !== undefined && generation < current.generation) {
      return undefined;
    }
    if (current !== undefined && generation === current.generation) {
      return current;
    }

    if (current !== undefined) {
      this.resetMapper(current.mapper);
    }

    const mapper = this.createMapper(generation);
    if (mapper === undefined) {
      return undefined;
    }
    const next = { generation, mapper } satisfies MapperEntry;
    this.mappers.set(chatUri, next);
    return next;
  }

  private createMapper(generation: number): ClaudeLiveMapperLike | undefined {
    try {
      const mapper = this.liveMapperFactory(generation, (diagnostic) => {
        this.report(diagnostic);
      });
      if (
        typeof mapper?.mapMessage !== 'function'
        || typeof mapper.clearTurn !== 'function'
        || typeof mapper.reset !== 'function'
      ) {
        throw new TypeError('liveMapperFactory returned an invalid mapper');
      }
      return mapper;
    } catch (error) {
      this.report(error);
      return undefined;
    }
  }

  private dispatchActions(
    chatUri: ChatUri,
    actions: readonly ChatAction[],
  ): readonly ChatActionEnvelope[] {
    if (actions.length === 0) {
      return EMPTY_ENVELOPES;
    }

    const envelopes: ChatActionEnvelope[] = [];
    for (const action of actions) {
      try {
        const envelope = this.hostStateManager.dispatch(chatUri, action);
        if (envelope !== undefined) {
          envelopes.push(envelope);
        }
      } catch (error) {
        this.report(error);
      }
    }
    return envelopes.length === 0 ? EMPTY_ENVELOPES : Object.freeze(envelopes);
  }

  private activeTurn(chatUri: ChatUri): ActiveTurn | undefined {
    try {
      return this.hostStateManager.getState(chatUri)?.activeTurn;
    } catch (error) {
      this.report(error);
      return undefined;
    }
  }

  private timestamp(): string | undefined {
    try {
      const timestamp = this.nowAction();
      return typeof timestamp === 'string' ? timestamp : undefined;
    } catch (error) {
      this.report(error);
      return undefined;
    }
  }

  private clearTurn(mapper: ClaudeLiveMapperLike, turnId: TurnId): void {
    try {
      mapper.clearTurn(turnId);
    } catch (error) {
      this.report(error);
    }
  }

  private resetMapper(mapper: ClaudeLiveMapperLike): void {
    try {
      mapper.reset();
    } catch (error) {
      this.report(error);
    }
  }

  private report(error: unknown): void {
    if (this.diagnostic === undefined) {
      return;
    }
    try {
      this.diagnostic(error);
    } catch {
      // Diagnostics are observational and must never escape signal handling.
    }
  }
}

function defaultLiveMapperFactory(
  generation: number,
  onDiagnostic?: (diagnostic: ClaudeLiveMapperDiagnostic) => void,
): ClaudeLiveMapperLike {
  const mapper = new ClaudeLiveMapper({
    generation,
    ...(onDiagnostic === undefined ? {} : { onDiagnostic }),
  });
  return {
    mapMessage: (message, turnId, timestamp) => mapper.mapMessage(
      message as Parameters<ClaudeLiveMapper['mapMessage']>[0],
      turnId,
      timestamp,
    ),
    clearTurn: (turnId) => mapper.clearTurn(turnId),
    reset: () => mapper.reset(),
  };
}

function parseChatUriSafely(value: unknown): ChatUri | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  try {
    return parseChatUri(value);
  } catch {
    return undefined;
  }
}

function isClaudeRuntimeSignal(value: unknown): value is ClaudeRuntimeSignal {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(candidate.generation)
    || (candidate.generation as number) <= 0
    || typeof candidate.type !== 'string'
  ) {
    return false;
  }

  switch (candidate.type) {
    case 'runtime/init':
      return typeof candidate.sdkSessionId === 'string';
    case 'runtime/message':
      return (
        (candidate.phase === 'active' || candidate.phase === 'tail' || candidate.phase === 'unmatched')
        && (candidate.turnId === undefined || typeof candidate.turnId === 'string')
        && typeof candidate.message === 'object'
        && candidate.message !== null
      );
    case 'turn/result':
      return (
        typeof candidate.turnId === 'string'
        && typeof candidate.outcome === 'object'
        && candidate.outcome !== null
        && isClaudeTurnOutcome(candidate.outcome)
      );
    case 'runtime/terminal':
      return candidate.state === 'closed' || candidate.state === 'crashed';
    default:
      return false;
  }
}

function isClaudeTurnOutcome(value: object): boolean {
  const status = (value as { readonly status?: unknown }).status;
  return status === 'completed'
    || status === 'failed'
    || status === 'interrupted'
    || status === 'runtime_closed';
}

function safeErrorMessage(value: unknown, fallback: string): string {
  const message = value instanceof Error
    ? value.message
    : typeof value === 'string'
      ? value
      : '';
  const normalized = message.trim();
  if (normalized.length === 0) {
    return fallback;
  }
  if (new TextEncoder().encode(normalized).byteLength <= MAX_SAFE_ERROR_BYTES) {
    return normalized;
  }
  let truncated = normalized;
  while (new TextEncoder().encode(`${truncated}...`).byteLength > MAX_SAFE_ERROR_BYTES) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}...`;
}
