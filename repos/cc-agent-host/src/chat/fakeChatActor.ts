import type { TurnInterruptedAction, TurnStartedAction } from '../domain/actions.js';
import type { ChatUri, ClientId, CommandId, TurnId } from '../domain/ids.js';
import type { HostStateManager } from '../host/hostStateManager.js';
import { isPositiveSafeInteger } from '../protocol/limits.js';
import type { ClientAction } from '../protocol/schemas.js';
import type { CommandDeduper, CommandRejection } from './commandDeduper.js';
import type {
  ChatCommandAcceptedValue,
  ChatCommandActor,
  ChatCommandReceipt,
  ChatCommandRejectionCode,
} from './chatCommandActor.js';
import type { SequencerByKey } from './sequencer.js';

export type { ClientAction } from '../protocol/schemas.js';

export type FakeChatActorAcceptedValue = ChatCommandAcceptedValue;
export type FakeChatActorReceipt = ChatCommandReceipt;
export type FakeChatActorRejectionCode = ChatCommandRejectionCode;

export interface FakeChatActorDeps {
  readonly hostStateManager: HostStateManager;
  readonly sequencer: SequencerByKey<ChatUri>;
  readonly commandDeduper: CommandDeduper;
  readonly nowAction: () => string;
  readonly allocateTurnId: () => TurnId;
}

const REJECTION_MESSAGES: Readonly<Record<FakeChatActorRejectionCode, string>> = Object.freeze({
  CHAT_BUSY: 'chat already has an active turn',
  TURN_NOT_ACTIVE: 'turn is not active',
  RESOURCE_NOT_FOUND: 'chat resource was not found',
  INVALID_ACTION: 'invalid chat command',
  INTERACTION_NOT_CONFIGURED: 'chat interaction resolution is not configured',
  INTERACTION_NOT_FOUND: 'interaction request was not found',
  INTERACTION_CHAT_MISMATCH: 'interaction request belongs to another chat',
  INTERACTION_KIND_MISMATCH: 'interaction request has the wrong kind',
  INTERACTION_INVALID: 'invalid interaction resolution',
  INTERACTION_DISPATCH_FAILED: 'interaction resolution could not be published',
  CATALOG_CREATE_UNAVAILABLE: 'catalog chat creation is not configured',
  CATALOG_UNAVAILABLE: 'host catalog is not available',
  WORKSPACE_NOT_FOUND: 'workspace was not found',
  WORKSPACE_UNAVAILABLE: 'workspace is unavailable',
  MODEL_NOT_SUPPORTED: 'model is not supported',
  CATALOG_CREATE_FAILED: 'catalog chat creation failed',
  INTERNAL_ERROR: 'chat command failed',
});

function isFakeChatActorRejectionCode(value: unknown): value is FakeChatActorRejectionCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(REJECTION_MESSAGES, value);
}

/** An internal command failure whose public form is safe to serialize. */
export class FakeChatActorError extends Error {
  public readonly code: FakeChatActorRejectionCode;

  public constructor(code: FakeChatActorRejectionCode) {
    const safeCode = isFakeChatActorRejectionCode(code) ? code : 'INTERNAL_ERROR';
    super(REJECTION_MESSAGES[safeCode]);
    this.name = 'FakeChatActorError';
    this.code = safeCode;
  }
}

/**
 * Converts an actor failure to a stable receipt rejection without exposing an
 * injected dependency's Error, message, stack, or other mutable properties.
 */
export function mapFakeChatActorRejection(error: unknown): CommandRejection {
  if (error instanceof FakeChatActorError && isFakeChatActorRejectionCode(error.code)) {
    return { code: error.code, message: REJECTION_MESSAGES[error.code] };
  }
  return { code: 'INTERNAL_ERROR', message: REJECTION_MESSAGES.INTERNAL_ERROR };
}

function assertClientAction(action: ClientAction): void {
  const candidate = action as unknown as Record<string, unknown>;
  if (typeof candidate !== 'object' || candidate === null) {
    throw new FakeChatActorError('INVALID_ACTION');
  }

  const keys = Object.keys(candidate);
  if (
    candidate.type === 'chat/send' &&
    typeof candidate.prompt === 'string' &&
    keys.length === 2 &&
    keys.includes('type') &&
    keys.includes('prompt')
  ) {
    return;
  }

  if (
    candidate.type === 'chat/interrupt' &&
    typeof candidate.turnId === 'string' &&
    keys.length === 2 &&
    keys.includes('type') &&
    keys.includes('turnId')
  ) {
    return;
  }

  throw new FakeChatActorError('INVALID_ACTION');
}

function requireCommitted(
  envelope: { readonly serverSeq: number } | undefined,
  turnId?: TurnId,
): FakeChatActorAcceptedValue {
  if (envelope === undefined) {
    throw new FakeChatActorError('INTERNAL_ERROR');
  }

  return turnId === undefined
    ? { acceptedAtSeq: envelope.serverSeq }
    : { acceptedAtSeq: envelope.serverSeq, turnId };
}

/**
 * Transport-independent Phase 1 chat command actor.
 *
 * This actor accepts only typed client intents. It owns no transport state and
 * never accepts a caller-provided domain action as a command.
 */
export class FakeChatActor implements ChatCommandActor {
  private readonly hostStateManager: HostStateManager;
  private readonly sequencer: SequencerByKey<ChatUri>;
  private readonly commandDeduper: CommandDeduper;
  private readonly nowAction: () => string;
  private readonly allocateTurnId: () => TurnId;

  public constructor(deps: FakeChatActorDeps) {
    this.hostStateManager = deps.hostStateManager;
    this.sequencer = deps.sequencer;
    this.commandDeduper = deps.commandDeduper;
    this.nowAction = deps.nowAction;
    this.allocateTurnId = deps.allocateTurnId;
  }

  public dispatch(
    clientId: ClientId,
    clientSeq: number,
    commandId: CommandId,
    channel: ChatUri,
    action: ClientAction,
  ): Promise<FakeChatActorReceipt> {
    if (!isPositiveSafeInteger(clientSeq)) {
      throw new RangeError('clientSeq must be a positive safe integer');
    }
    const origin = { clientId, clientSeq, commandId };
    return this.commandDeduper.execute(
      { clientId, commandId },
      () => this.sequencer.enqueue(channel, () => this.dispatchSerialized(origin, channel, action)),
      mapFakeChatActorRejection,
    );
  }

  private dispatchSerialized(
    origin: { readonly clientId: ClientId; readonly clientSeq: number; readonly commandId: CommandId },
    channel: ChatUri,
    action: ClientAction,
  ): FakeChatActorAcceptedValue {
    assertClientAction(action);

    const state = this.hostStateManager.getState(channel);
    if (state === undefined) {
      throw new FakeChatActorError('RESOURCE_NOT_FOUND');
    }

    switch (action.type) {
      case 'chat/send':
        return this.dispatchSend(origin, channel, action.prompt, state.activeTurn !== undefined);
      case 'chat/interrupt':
        return this.dispatchInterrupt(origin, channel, action.turnId, state.activeTurn?.id);
      default:
        throw new FakeChatActorError('INVALID_ACTION');
    }
  }

  private dispatchSend(
    origin: { readonly clientId: ClientId; readonly clientSeq: number; readonly commandId: CommandId },
    channel: ChatUri,
    prompt: string,
    hasActiveTurn: boolean,
  ): FakeChatActorAcceptedValue {
    if (hasActiveTurn) {
      throw new FakeChatActorError('CHAT_BUSY');
    }

    const turnId = this.allocateTurnId();
    const action: TurnStartedAction = {
      type: 'chat/turnStarted',
      turnId,
      prompt,
      timestamp: this.nowAction(),
    };
    const envelope = this.hostStateManager.dispatch(channel, action, origin);
    return requireCommitted(envelope, turnId);
  }

  private dispatchInterrupt(
    origin: { readonly clientId: ClientId; readonly clientSeq: number; readonly commandId: CommandId },
    channel: ChatUri,
    targetTurnId: TurnId,
    activeTurnId: TurnId | undefined,
  ): FakeChatActorAcceptedValue {
    if (activeTurnId === undefined || activeTurnId !== targetTurnId) {
      throw new FakeChatActorError('TURN_NOT_ACTIVE');
    }

    const action: TurnInterruptedAction = {
      type: 'chat/turnInterrupted',
      turnId: targetTurnId,
      timestamp: this.nowAction(),
    };
    const envelope = this.hostStateManager.dispatch(channel, action, origin);
    return requireCommitted(envelope);
  }
}
