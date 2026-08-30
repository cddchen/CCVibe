import type { TurnStartedAction, TurnFailedAction } from '../domain/actions.js';
import type { ActionOrigin } from '../protocol/types.js';
import {
  clientActionSchema,
  type ClientAction,
} from '../protocol/schemas.js';
import { parseChatUri, parseRootUri } from '../domain/resources.js';
import {
  parseClientId,
  parseCommandId,
  parseApprovalId,
  parseInputRequestId,
  parseModelId,
  parseTurnId,
  parseWorkspaceId,
  type ChatUri,
  type ClientId,
  type CommandId,
  type TurnId,
} from '../domain/ids.js';
import type { HostStateManager } from '../host/hostStateManager.js';
import type { ClaudeChatRegistry } from '../claude/claudeChatRegistry.js';
import type {
  ChatCommandAcceptedValue,
  ChatCommandActor,
  ChatCommandReceipt,
  ChatCommandRejectionCode,
  CatalogChatCreator,
  CatalogChatCreateEffect,
  CatalogCreateChatInput,
  CatalogCreateChatReceipt,
  ChatApprovalResolutionInput,
  ChatInputResolutionInput,
  ChatInteractionResolutionReceipt,
  ChatInteractionResolutionResult,
  ChatInteractionResolutionValue,
  ChatInteractionResolver,
} from './chatCommandActor.js';
import { CommandDeduper, type CommandRejection } from './commandDeduper.js';
import type { SequencerByKey } from './sequencer.js';
import { isPositiveSafeInteger } from '../protocol/limits.js';

export type ClaudeChatActorAcceptedValue = ChatCommandAcceptedValue;
export type ClaudeChatActorReceipt = ChatCommandReceipt;
export type ClaudeChatActorRejectionCode = ChatCommandRejectionCode;
export type ClaudeChatInteractionResolutionReceipt = ChatInteractionResolutionReceipt;
export type ClaudeChatInteractionResolutionValue = ChatInteractionResolutionValue;

export interface ClaudeChatActorRegistry {
  send(chatUri: ChatUri, turnId: TurnId, text: string): Promise<unknown>;
  interrupt(chatUri: ChatUri, turnId: TurnId): Promise<unknown | undefined>;
}

export interface ClaudeChatActorDeps {
  readonly hostStateManager: HostStateManager;
  readonly registry?: Pick<ClaudeChatRegistry, 'send' | 'interrupt'> | ClaudeChatActorRegistry;
  /** Descriptive alias accepted by callers that name the dependency explicitly. */
  readonly chatRegistry?: Pick<ClaudeChatRegistry, 'send' | 'interrupt'> | ClaudeChatActorRegistry;
  readonly sequencer: SequencerByKey<ChatUri>;
  readonly commandDeduper: CommandDeduper;
  readonly nowAction: () => string;
  readonly allocateTurnId: () => TurnId;
  /** Optional host-owned resolver for SDK permission/input waiters. */
  readonly interactionResolver?: ChatInteractionResolver;
  /** Optional root-catalog create effect; command dedupe remains actor-owned. */
  readonly createChat?: CatalogChatCreateEffect;
}

const REJECTION_MESSAGES: Readonly<Record<ClaudeChatActorRejectionCode, string>> = Object.freeze({
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
const RUNTIME_FAILURE_MESSAGE = 'chat runtime failed';

/** An internal actor failure whose public form is always canonical and safe. */
export class ClaudeChatActorError extends Error {
  public readonly code: ClaudeChatActorRejectionCode;

  public constructor(code: ClaudeChatActorRejectionCode) {
    const safeCode = isRejectionCode(code) ? code : 'INTERNAL_ERROR';
    super(REJECTION_MESSAGES[safeCode]);
    this.name = 'ClaudeChatActorError';
    this.code = safeCode;
  }
}

export function mapClaudeChatActorRejection(error: unknown): CommandRejection {
  if (error instanceof ClaudeChatActorError && isRejectionCode(error.code)) {
    return { code: error.code, message: REJECTION_MESSAGES[error.code] };
  }
  return { code: 'INTERNAL_ERROR', message: REJECTION_MESSAGES.INTERNAL_ERROR };
}

/**
 * Real Claude-backed chat command actor.
 *
 * Command dedupe is shared across send and interrupt, while send serialization
 * is deliberately owned by this actor and is separate from the registry's
 * runtime/materialization sequencer.
 */
export class ClaudeChatActor implements ChatCommandActor, CatalogChatCreator {
  private readonly hostStateManager: HostStateManager;
  private readonly registry: ClaudeChatActorRegistry;
  private readonly sequencer: SequencerByKey<ChatUri>;
  private readonly commandDeduper: CommandDeduper;
  private readonly nowAction: () => string;
  private readonly allocateTurnId: () => TurnId;
  private readonly interactionResolver: ChatInteractionResolver | undefined;
  private readonly createChatEffect: CatalogChatCreateEffect | undefined;

  public constructor(deps: ClaudeChatActorDeps) {
    if (typeof deps !== 'object' || deps === null) {
      throw new TypeError('deps must be an object');
    }
    if (typeof deps.hostStateManager?.getState !== 'function') {
      throw new TypeError('hostStateManager must be provided');
    }
    const registry = deps.registry ?? deps.chatRegistry;
    if (typeof registry?.send !== 'function' || typeof registry.interrupt !== 'function') {
      throw new TypeError('registry must provide send and interrupt');
    }
    if (typeof deps.sequencer?.enqueue !== 'function') {
      throw new TypeError('sequencer must be provided');
    }
    if (typeof deps.commandDeduper?.execute !== 'function') {
      throw new TypeError('commandDeduper must be provided');
    }
    if (typeof deps.nowAction !== 'function') {
      throw new TypeError('nowAction must be provided');
    }

    this.hostStateManager = deps.hostStateManager;
    this.registry = registry;
    this.sequencer = deps.sequencer;
    this.commandDeduper = deps.commandDeduper;
    this.nowAction = deps.nowAction;
    this.allocateTurnId = deps.allocateTurnId ?? (() => {
      throw new ClaudeChatActorError('INTERNAL_ERROR');
    });
    this.interactionResolver = deps.interactionResolver;
    this.createChatEffect = deps.createChat;
  }

  public dispatch(
    clientId: ClientId,
    clientSeq: number,
    commandId: CommandId,
    channel: ChatUri,
    action: ClientAction,
  ): Promise<ClaudeChatActorReceipt> {
    if (!isPositiveSafeInteger(clientSeq)) {
      throw new RangeError('clientSeq must be a positive safe integer');
    }

    const parsedClientId = parseIdentifier(clientId, parseClientId, 'clientId');
    const parsedCommandId = parseIdentifier(commandId, parseCommandId, 'commandId');
    const parsedChannel = parseIdentifier(channel, parseChatUri, 'chatUri');
    const origin: ActionOrigin = {
      clientId: parsedClientId,
      clientSeq,
      commandId: parsedCommandId,
    };

    return this.commandDeduper.execute(
      { clientId: parsedClientId, commandId: parsedCommandId },
      () => {
        const parsedAction = parseClientAction(action);
        return parsedAction.type === 'chat/send'
          ? this.sequencer.enqueue(parsedChannel, () => this.dispatchSend(origin, parsedChannel, parsedAction.prompt))
          : this.dispatchInterrupt(parsedChannel, parsedAction.turnId);
      },
      mapClaudeChatActorRejection,
    );
  }

  public createChat(
    clientId: ClientId,
    clientSeq: number,
    commandId: CommandId,
    channel: import('../domain/ids.js').RootUri,
    input: CatalogCreateChatInput,
  ): Promise<CatalogCreateChatReceipt> {
    if (!isPositiveSafeInteger(clientSeq)) {
      throw new RangeError('clientSeq must be a positive safe integer');
    }

    const parsedClientId = parseIdentifier(clientId, parseClientId, 'clientId');
    const parsedCommandId = parseIdentifier(commandId, parseCommandId, 'commandId');
    const parsedChannel = parseIdentifier(channel, parseRootUri, 'rootUri');
    const parsedInput: CatalogCreateChatInput = {
      workspaceId: parseIdentifier(input.workspaceId, parseWorkspaceId, 'workspaceId'),
      modelId: parseIdentifier(input.modelId, parseModelId, 'modelId'),
      ...(input.initialPrompt === undefined ? {} : { initialPrompt: input.initialPrompt }),
    };
    const origin: ActionOrigin = {
      clientId: parsedClientId,
      clientSeq,
      commandId: parsedCommandId,
    };

    return this.commandDeduper.execute(
      { clientId: parsedClientId, commandId: parsedCommandId },
      async () => {
        if (this.createChatEffect === undefined) {
          throw new ClaudeChatActorError('CATALOG_CREATE_UNAVAILABLE');
        }
        const chatUri = await this.createChatEffect(parsedChannel, parsedInput, origin);
        return { chatUri: parseIdentifier(chatUri, parseChatUri, 'chatUri') };
      },
      mapClaudeChatActorRejection,
    );
  }

  public resolveApproval(
    clientId: ClientId,
    clientSeq: number,
    commandId: CommandId,
    channel: ChatUri,
    input: ChatApprovalResolutionInput,
  ): Promise<ClaudeChatInteractionResolutionReceipt> {
    return this.resolveInteraction(
      clientId,
      clientSeq,
      commandId,
      channel,
      input.approvalId,
      'approval',
      () => this.resolveApprovalSerialized(channel, input),
    );
  }

  public resolveInput(
    clientId: ClientId,
    clientSeq: number,
    commandId: CommandId,
    channel: ChatUri,
    input: ChatInputResolutionInput,
  ): Promise<ClaudeChatInteractionResolutionReceipt> {
    return this.resolveInteraction(
      clientId,
      clientSeq,
      commandId,
      channel,
      input.inputId,
      'input',
      () => this.resolveInputSerialized(channel, input),
    );
  }

  private resolveInteraction(
    clientId: ClientId,
    clientSeq: number,
    commandId: CommandId,
    channel: ChatUri,
    id: string,
    kind: 'approval' | 'input',
    effect: () => Promise<ClaudeChatInteractionResolutionValue>,
  ): Promise<ClaudeChatInteractionResolutionReceipt> {
    if (!isPositiveSafeInteger(clientSeq)) {
      throw new RangeError('clientSeq must be a positive safe integer');
    }

    const parsedClientId = parseIdentifier(clientId, parseClientId, 'clientId');
    const parsedCommandId = parseIdentifier(commandId, parseCommandId, 'commandId');
    const parsedChannel = parseIdentifier(channel, parseChatUri, 'chatUri');
    if (kind === 'approval') {
      parseIdentifier(id, parseApprovalId, 'approvalId');
    } else {
      parseIdentifier(id, parseInputRequestId, 'inputId');
    }

    return this.commandDeduper.execute(
      { clientId: parsedClientId, commandId: parsedCommandId },
      () => this.sequencer.enqueue(parsedChannel, effect),
      mapClaudeChatActorRejection,
    ) as Promise<ClaudeChatInteractionResolutionReceipt>;
  }

  private async resolveApprovalSerialized(
    channel: ChatUri,
    input: ChatApprovalResolutionInput,
  ): Promise<ClaudeChatInteractionResolutionValue> {
    const state = this.hostStateManager.getState(channel);
    if (state === undefined) {
      throw new ClaudeChatActorError('RESOURCE_NOT_FOUND');
    }
    const resolver = this.interactionResolver;
    if (resolver === undefined) {
      throw new ClaudeChatActorError('INTERACTION_NOT_CONFIGURED');
    }
    const result = await resolver.resolveApproval({ ...input, chatUri: channel });
    return this.mapInteractionResolution(result, 'approval', input.approvalId);
  }

  private async resolveInputSerialized(
    channel: ChatUri,
    input: ChatInputResolutionInput,
  ): Promise<ClaudeChatInteractionResolutionValue> {
    const state = this.hostStateManager.getState(channel);
    if (state === undefined) {
      throw new ClaudeChatActorError('RESOURCE_NOT_FOUND');
    }
    const resolver = this.interactionResolver;
    if (resolver === undefined) {
      throw new ClaudeChatActorError('INTERACTION_NOT_CONFIGURED');
    }
    const result = await resolver.resolveInput({ ...input, chatUri: channel });
    return this.mapInteractionResolution(result, 'input', input.inputId);
  }

  private mapInteractionResolution(
    result: ChatInteractionResolutionResult,
    kind: 'approval' | 'input',
    id: string,
  ): ClaudeChatInteractionResolutionValue {
    if (result.status === 'resolved' || result.status === 'already_resolved') {
      if (result.kind !== kind || result.id !== id) {
        throw new ClaudeChatActorError('INTERACTION_KIND_MISMATCH');
      }
      return {
        status: result.status,
        kind,
        id,
        acceptedAtSeq: this.hostStateManager.serverSeq,
      };
    }

    switch (result.status) {
      case 'not_found':
        throw new ClaudeChatActorError('INTERACTION_NOT_FOUND');
      case 'chat_mismatch':
        throw new ClaudeChatActorError('INTERACTION_CHAT_MISMATCH');
      case 'kind_mismatch':
        throw new ClaudeChatActorError('INTERACTION_KIND_MISMATCH');
      case 'rejected':
        throw new ClaudeChatActorError(
          result.code === 'dispatch_failed' || result.code === 'disposed'
            ? 'INTERACTION_DISPATCH_FAILED'
            : 'INTERACTION_INVALID',
        );
      default:
        throw new ClaudeChatActorError('INTERNAL_ERROR');
    }
  }

  private async dispatchSend(
    origin: ActionOrigin,
    channel: ChatUri,
    prompt: string,
  ): Promise<ClaudeChatActorAcceptedValue> {
    const state = this.hostStateManager.getState(channel);
    if (state === undefined) {
      throw new ClaudeChatActorError('RESOURCE_NOT_FOUND');
    }
    if (state.activeTurn !== undefined) {
      throw new ClaudeChatActorError('CHAT_BUSY');
    }

    const turnId = parseIdentifier(this.allocateTurnId(), parseTurnId, 'turnId');
    const started: TurnStartedAction = {
      type: 'chat/turnStarted',
      turnId,
      prompt,
      timestamp: this.requireActionTimestamp(),
    };
    const startedEnvelope = this.hostStateManager.dispatch(channel, started, origin);
    if (startedEnvelope === undefined) {
      throw new ClaudeChatActorError('INTERNAL_ERROR');
    }

    try {
      // Registry.send resolves at runtime installation/handle creation, not at
      // turn completion. Runtime signals own subsequent live actions.
      await this.registry.send(channel, turnId, prompt);
    } catch {
      this.failStartedTurn(channel, turnId, origin);
    }

    return {
      acceptedAtSeq: startedEnvelope.serverSeq,
      turnId,
    };
  }

  private async dispatchInterrupt(
    channel: ChatUri,
    targetTurnId: TurnId,
  ): Promise<ClaudeChatActorAcceptedValue> {
    const state = this.hostStateManager.getState(channel);
    if (state === undefined) {
      throw new ClaudeChatActorError('RESOURCE_NOT_FOUND');
    }
    if (state.activeTurn?.id !== targetTurnId) {
      throw new ClaudeChatActorError('TURN_NOT_ACTIVE');
    }

    try {
      const result = await this.registry.interrupt(channel, targetTurnId);
      if (result === undefined) {
        throw new ClaudeChatActorError('TURN_NOT_ACTIVE');
      }
    } catch (error) {
      if (error instanceof ClaudeChatActorError) {
        throw error;
      }
      throw new ClaudeChatActorError('INTERNAL_ERROR');
    }

    // The runtime signal bridge commits the terminal action before interrupt()
    // resolves. This watermark therefore includes that action without the actor
    // duplicating it.
    return { acceptedAtSeq: this.hostStateManager.serverSeq };
  }

  private failStartedTurn(channel: ChatUri, turnId: TurnId, origin: ActionOrigin): void {
    try {
      const activeTurn = this.hostStateManager.getState(channel)?.activeTurn;
      if (activeTurn?.id !== turnId) {
        return;
      }
      const failed: TurnFailedAction = {
        type: 'chat/turnFailed',
        turnId,
        error: RUNTIME_FAILURE_MESSAGE,
        timestamp: this.requireActionTimestamp(),
      };
      this.hostStateManager.dispatch(channel, failed, origin);
    } catch {
      // A runtime installation failure remains an accepted command even if
      // best-effort terminal projection itself cannot be committed.
    }
  }

  private requireActionTimestamp(): string {
    try {
      const timestamp = this.nowAction();
      if (typeof timestamp !== 'string') {
        throw new TypeError('nowAction must return a string');
      }
      return timestamp;
    } catch {
      throw new ClaudeChatActorError('INTERNAL_ERROR');
    }
  }
}

function isRejectionCode(value: unknown): value is ClaudeChatActorRejectionCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(REJECTION_MESSAGES, value);
}

function parseClientAction(value: ClientAction): ClientAction {
  const parsed = clientActionSchema.safeParse(value as unknown);
  if (!parsed.success) {
    throw new ClaudeChatActorError('INVALID_ACTION');
  }
  return parsed.data;
}

function parseIdentifier<T extends string>(
  value: T,
  parser: (candidate: string) => T,
  label: string,
): T {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a valid identifier`);
  }
  try {
    return parser(value);
  } catch {
    throw new TypeError(`${label} must be a valid identifier`);
  }
}
