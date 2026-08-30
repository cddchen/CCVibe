import type {
  ApprovalDecision,
  ApprovalInput,
  ApprovalSuggestion,
  InputAnswers,
  InputQuestion,
  ResponsePart,
  Turn,
} from './chat.js';
import type { ApprovalId, InputRequestId, PartId, ToolCallId, TurnId } from './ids.js';

export const CHAT_ACTION_TYPES = {
  turnStarted: 'chat/turnStarted',
  responsePartAdded: 'chat/responsePartAdded',
  responsePartDelta: 'chat/responsePartDelta',
  toolCallStarted: 'chat/toolCallStarted',
  toolCallInputDelta: 'chat/toolCallInputDelta',
  toolCallReady: 'chat/toolCallReady',
  toolCallCompleted: 'chat/toolCallCompleted',
  inputRequested: 'chat/inputRequested',
  inputResolved: 'chat/inputResolved',
  approvalRequested: 'chat/approvalRequested',
  approvalResolved: 'chat/approvalResolved',
  turnCompleted: 'chat/turnCompleted',
  turnFailed: 'chat/turnFailed',
  turnInterrupted: 'chat/turnInterrupted',
  turnsLoaded: 'chat/turnsLoaded',
} as const;

export type ChatActionType = (typeof CHAT_ACTION_TYPES)[keyof typeof CHAT_ACTION_TYPES];

interface ChatActionBase<TType extends ChatActionType> {
  readonly type: TType;
  readonly timestamp: string;
}

export interface TurnStartedAction extends ChatActionBase<'chat/turnStarted'> {
  readonly turnId: TurnId;
  readonly prompt: string;
}

export interface ResponsePartAddedAction extends ChatActionBase<'chat/responsePartAdded'> {
  readonly turnId: TurnId;
  readonly part: Extract<ResponsePart, { readonly kind: 'markdown' | 'reasoning' }>;
}

export interface ResponsePartDeltaAction extends ChatActionBase<'chat/responsePartDelta'> {
  readonly turnId: TurnId;
  readonly partId: PartId;
  readonly delta: string;
}

export interface ToolCallStartedAction extends ChatActionBase<'chat/toolCallStarted'> {
  readonly turnId: TurnId;
  readonly partId: PartId;
  readonly toolCallId: ToolCallId;
  readonly name: string;
  readonly input?: string;
}

export interface ToolCallInputDeltaAction extends ChatActionBase<'chat/toolCallInputDelta'> {
  readonly turnId: TurnId;
  readonly partId: PartId;
  readonly toolCallId: ToolCallId;
  readonly delta: string;
}

export interface ToolCallReadyAction extends ChatActionBase<'chat/toolCallReady'> {
  readonly turnId: TurnId;
  readonly partId: PartId;
  readonly toolCallId: ToolCallId;
}

export interface ToolCallCompletedAction extends ChatActionBase<'chat/toolCallCompleted'> {
  readonly turnId: TurnId;
  readonly partId: PartId;
  readonly toolCallId: ToolCallId;
  readonly result?: string;
  readonly error?: string;
}

export interface ApprovalRequestedAction extends ChatActionBase<'chat/approvalRequested'> {
  readonly turnId: TurnId;
  readonly approvalId: ApprovalId;
  /** SDK permission prompts can be emitted before a tool-call part is materialized. */
  readonly toolCallId?: ToolCallId;
  readonly toolName: string;
  /** Opaque SDK input; the reducer stores it but never interprets or executes it. */
  readonly input: ApprovalInput;
  readonly title?: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly suggestions?: readonly ApprovalSuggestion[];
  readonly requestId?: string;
  readonly sdkRequestId?: string;
  readonly toolUseId?: string;
  readonly toolUseID?: string;
  readonly agentId?: string;
  readonly agentID?: string;
  readonly blockedPath?: string;
  readonly decisionReason?: string;
  readonly matchedAskRule?: {
    readonly source: string;
    readonly toolName: string;
    readonly ruleContent?: string;
  };
  /** Optional explicit request timestamp; `timestamp` remains the action commit time. */
  readonly requestedAt?: string;
}

export interface ApprovalResolvedAction extends ChatActionBase<'chat/approvalResolved'> {
  readonly turnId: TurnId;
  readonly approvalId: ApprovalId;
  readonly decision: ApprovalDecision;
  readonly updatedInput?: ApprovalInput;
  readonly updatedPermissions?: readonly ApprovalSuggestion[];
  readonly message?: string;
  readonly interrupt?: boolean;
  readonly decisionClassification?: 'user_temporary' | 'user_permanent' | 'user_reject';
}

export interface InputRequestedAction extends ChatActionBase<'chat/inputRequested'> {
  readonly turnId: TurnId;
  readonly inputId: InputRequestId;
  readonly questions: readonly InputQuestion[];
  /** Optional explicit request timestamp; `timestamp` remains the action commit time. */
  readonly requestedAt?: string;
}

export interface InputResolvedAction extends ChatActionBase<'chat/inputResolved'> {
  readonly turnId: TurnId;
  readonly inputId: InputRequestId;
  /** Empty/omitted answers represent a cancellation of the waiting input. */
  readonly answers?: InputAnswers;
}

export interface TurnCompletedAction extends ChatActionBase<'chat/turnCompleted'> {
  readonly turnId: TurnId;
}

export interface TurnFailedAction extends ChatActionBase<'chat/turnFailed'> {
  readonly turnId: TurnId;
  readonly error: string;
}

export interface TurnInterruptedAction extends ChatActionBase<'chat/turnInterrupted'> {
  readonly turnId: TurnId;
}

export interface TurnsLoadedAction extends ChatActionBase<'chat/turnsLoaded'> {
  readonly turns: readonly Turn[];
}

export type ChatAction =
  | TurnStartedAction
  | ResponsePartAddedAction
  | ResponsePartDeltaAction
  | ToolCallStartedAction
  | ToolCallInputDeltaAction
  | ToolCallReadyAction
  | ToolCallCompletedAction
  | InputRequestedAction
  | InputResolvedAction
  | ApprovalRequestedAction
  | ApprovalResolvedAction
  | TurnCompletedAction
  | TurnFailedAction
  | TurnInterruptedAction
  | TurnsLoadedAction;

export type ActionOf<TType extends ChatActionType> = Extract<ChatAction, { type: TType }>;
