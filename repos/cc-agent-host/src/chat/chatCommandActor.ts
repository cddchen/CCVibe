import type {
  ApprovalId,
  ChatUri,
  ClientId,
  CommandId,
  InputRequestId,
  ModelId,
  RootUri,
  TurnId,
  WorkspaceId,
} from '../domain/ids.js';
import type { ApprovalInput, ApprovalSuggestion, InputAnswers } from '../domain/chat.js';
import type { ClientAction } from '../protocol/schemas.js';
import type { CommandReceipt } from './commandDeduper.js';

/** The SDK-free value returned when a chat command is authoritatively accepted. */
export interface ChatCommandAcceptedValue {
  readonly acceptedAtSeq: number;
  readonly turnId?: TurnId;
}

/** The common receipt returned by all transport-independent chat actors. */
export type ChatCommandReceipt = CommandReceipt<ChatCommandAcceptedValue>;

/** SDK-free catalog create intent owned by the chat command actor. */
export interface CatalogCreateChatInput {
  readonly workspaceId: WorkspaceId;
  readonly modelId: ModelId;
  readonly initialPrompt?: string;
}

export interface CatalogCreateChatValue {
  readonly chatUri: ChatUri;
}

export type CatalogCreateChatReceipt = CommandReceipt<CatalogCreateChatValue>;

export type CatalogChatCreateEffect = (
  channel: RootUri,
  input: CatalogCreateChatInput,
  origin: import('../protocol/types.js').ActionOrigin,
) => ChatUri | PromiseLike<ChatUri>;

/** Separate catalog command surface; ChatCommandActor.dispatch remains chat-only. */
export interface CatalogChatCreator {
  createChat(
    clientId: ClientId,
    clientSeq: number,
    commandId: CommandId,
    channel: RootUri,
    input: CatalogCreateChatInput,
  ): Promise<CatalogCreateChatReceipt>;
}

/** SDK-free permission decision fields accepted by the protocol boundary. */
export interface ChatApprovalResolutionInput {
  readonly approvalId: ApprovalId;
  readonly decision: 'allow' | 'deny';
  readonly updatedInput?: ApprovalInput;
  readonly updatedPermissions?: readonly ApprovalSuggestion[];
  readonly decisionClassification?: 'user_temporary' | 'user_permanent' | 'user_reject';
  readonly message?: string;
  readonly interrupt?: boolean;
}

/** SDK-free structured-input decision fields accepted by the protocol boundary. */
export interface ChatInputResolutionInput {
  readonly inputId: InputRequestId;
  readonly answers?: InputAnswers;
}

/** The resolver's state-only result before the actor adds its host watermark. */
export interface ChatInteractionResolutionState {
  readonly status: 'resolved' | 'already_resolved';
  readonly kind: 'approval' | 'input';
  readonly id: string;
}

/** The stable value returned by an interaction resolution command. */
export interface ChatInteractionResolutionValue extends ChatInteractionResolutionState {
  /** Host watermark after this resolution (unchanged for already_resolved). */
  readonly acceptedAtSeq: number;
}

export type ChatInteractionResolutionReceipt = CommandReceipt<ChatInteractionResolutionValue>;

/** Structural subset of the registry result, without SDK types. */
export type ChatInteractionResolutionResult =
  | ChatInteractionResolutionState
  | {
      readonly status: 'not_found' | 'chat_mismatch' | 'kind_mismatch';
      readonly kind: 'approval' | 'input';
      readonly id: string;
    }
  | {
      readonly status: 'rejected';
      readonly kind: 'approval' | 'input';
      readonly id: string;
      readonly code: string;
      readonly message: string;
    };

/** SDK-free resolver used by the real actor; implementations may be synchronous. */
export interface ChatInteractionResolver {
  resolveApproval(
    input: ChatApprovalResolutionInput & { readonly chatUri: ChatUri },
  ): ChatInteractionResolutionResult | PromiseLike<ChatInteractionResolutionResult>;
  resolveInput(
    input: ChatInputResolutionInput & { readonly chatUri: ChatUri },
  ): ChatInteractionResolutionResult | PromiseLike<ChatInteractionResolutionResult>;
}

/** Explicit actor-prefixed aliases for package consumers. */
export type ChatCommandActorAcceptedValue = ChatCommandAcceptedValue;
export type ChatCommandActorReceipt = ChatCommandReceipt;

/** Stable rejection codes that chat actors may expose to clients. */
export type ChatCommandRejectionCode =
  | 'CHAT_BUSY'
  | 'TURN_NOT_ACTIVE'
  | 'RESOURCE_NOT_FOUND'
  | 'INVALID_ACTION'
  | 'INTERACTION_NOT_CONFIGURED'
  | 'INTERACTION_NOT_FOUND'
  | 'INTERACTION_CHAT_MISMATCH'
  | 'INTERACTION_KIND_MISMATCH'
  | 'INTERACTION_INVALID'
  | 'INTERACTION_DISPATCH_FAILED'
  | 'CATALOG_CREATE_UNAVAILABLE'
  | 'CATALOG_UNAVAILABLE'
  | 'WORKSPACE_NOT_FOUND'
  | 'WORKSPACE_UNAVAILABLE'
  | 'MODEL_NOT_SUPPORTED'
  | 'CATALOG_CREATE_FAILED'
  | 'INTERNAL_ERROR';

/**
 * SDK-free command surface consumed by the protocol handler.
 *
 * Implementations may use different runtime backends, but they all accept the
 * same validated client intent and return the same safe receipt shape.
 */
export interface ChatCommandActor {
  dispatch(
    clientId: ClientId,
    clientSeq: number,
    commandId: CommandId,
    channel: ChatUri,
    action: ClientAction,
  ): Promise<ChatCommandReceipt>;

  /** Optional host-catalog command; dispatch above remains chat-action-only. */
  createChat?(
    clientId: ClientId,
    clientSeq: number,
    commandId: CommandId,
    channel: RootUri,
    input: CatalogCreateChatInput,
  ): Promise<CatalogCreateChatReceipt>;

  /** Resolve one pending SDK permission request, when interaction support is installed. */
  resolveApproval?(
    clientId: ClientId,
    clientSeq: number,
    commandId: CommandId,
    channel: ChatUri,
    input: ChatApprovalResolutionInput,
  ): Promise<ChatInteractionResolutionReceipt>;

  /** Resolve one pending SDK structured-input request, when interaction support is installed. */
  resolveInput?(
    clientId: ClientId,
    clientSeq: number,
    commandId: CommandId,
    channel: ChatUri,
    input: ChatInputResolutionInput,
  ): Promise<ChatInteractionResolutionReceipt>;
}
