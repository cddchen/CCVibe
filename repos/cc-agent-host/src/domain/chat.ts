import type {
  ApprovalId,
  ChatUri,
  InputRequestId,
  PartId,
  ToolCallId,
  TurnId,
} from './ids.js';

export type ChatStatus = 'idle' | 'in_progress' | 'input_needed' | 'error';
export type TurnStatus = 'active' | 'complete' | 'failed' | 'interrupted';
export type ToolCallStatus = 'started' | 'ready' | 'completed';
export type ApprovalDecision = 'allow' | 'deny';

/** Values that can safely cross the JSON protocol boundary. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

/**
 * The stable, SDK-independent projection of an AskUserQuestion option.
 *
 * The Claude SDK currently requires all three of `label`, `description`, and
 * the parent question's `multiSelect` flag.  Keeping this shape in domain
 * code means that clients never need to consume the SDK's raw input union.
 */
export interface InputQuestionOption {
  readonly label: string;
  readonly description: string;
  readonly preview?: string;
}

export type InputOption = InputQuestionOption;

/** A single structured question presented to a client. */
export interface InputQuestion {
  readonly question: string;
  readonly header: string;
  readonly options: readonly InputQuestionOption[];
  readonly multiSelect: boolean;
}

/** Answers keyed by the exact question text, as returned by the SDK tool. */
export type InputAnswers = Readonly<Record<string, string>>;
export type StructuredInputAnswers = InputAnswers;

/** SDK tool input is intentionally opaque to the reducer and adapter-independent. */
export type ApprovalInput = Readonly<Record<string, unknown>>;

/** UI-safe permission suggestion projection; never expose the SDK union itself. */
export type ApprovalSuggestion = JsonObject;

export interface ApprovalMatchedAskRule {
  readonly source: string;
  readonly toolName: string;
  readonly ruleContent?: string;
}

export interface ToolCall {
  readonly id: ToolCallId;
  readonly name: string;
  readonly input: string;
  readonly status: ToolCallStatus;
  readonly startedAt: string;
  readonly readyAt?: string;
  readonly completedAt?: string;
  readonly result?: string;
  readonly error?: string;
}

export type ResponsePart =
  | {
      readonly kind: 'markdown';
      readonly id: PartId;
      readonly content: string;
    }
  | {
      readonly kind: 'reasoning';
      readonly id: PartId;
      readonly content: string;
    }
  | {
      readonly kind: 'tool_call';
      readonly id: PartId;
      readonly toolCall: ToolCall;
    };

export interface ActiveTurn {
  readonly id: TurnId;
  readonly prompt: string;
  readonly status: 'active';
  readonly parts: readonly ResponsePart[];
  readonly startedAt: string;
}

export interface Turn {
  readonly id: TurnId;
  readonly prompt: string;
  readonly status: TurnStatus;
  readonly parts: readonly ResponsePart[];
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly error?: string;
}

export interface PendingApproval {
  readonly id: ApprovalId;
  readonly turnId: TurnId;
  /** The tool call may be absent for host-level permission prompts. */
  readonly toolCallId?: ToolCallId;
  /** SDK callback context projected for a UI; absent optional fields stay absent. */
  readonly toolName?: string;
  readonly input?: ApprovalInput;
  readonly title?: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly suggestions?: readonly ApprovalSuggestion[];
  readonly requestId?: string;
  /** Normalized alias used by host adapters that distinguish SDK IDs. */
  readonly sdkRequestId?: string;
  readonly toolUseId?: string;
  readonly toolUseID?: string;
  readonly agentId?: string;
  readonly agentID?: string;
  readonly blockedPath?: string;
  readonly decisionReason?: string;
  readonly matchedAskRule?: ApprovalMatchedAskRule;
  readonly requestedAt: string;
}

/** A structured AskUserQuestion request waiting for one client response. */
export interface PendingInputRequest {
  readonly id: InputRequestId;
  readonly turnId: TurnId;
  readonly questions: readonly InputQuestion[];
  readonly requestedAt: string;
}

export interface ChatState {
  readonly resource?: ChatUri;
  readonly status: ChatStatus;
  readonly turns: readonly Turn[];
  readonly activeTurn?: ActiveTurn;
  readonly pendingApprovals: readonly PendingApproval[];
  /** Omitted for legacy/empty snapshots; present once structured input is used. */
  readonly pendingInputs?: readonly PendingInputRequest[];
  readonly modifiedAt: string;
}

export interface CreateChatStateInput {
  readonly resource?: ChatUri;
  readonly status?: ChatStatus;
  readonly turns?: readonly Turn[];
  readonly activeTurn?: ActiveTurn;
  readonly pendingApprovals?: readonly PendingApproval[];
  readonly pendingInputs?: readonly PendingInputRequest[];
  readonly modifiedAt?: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Runtime guard used at the domain boundary for values that may be serialized as JSON. */
export function isJsonValue(value: unknown, ancestors: readonly object[] = []): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value !== 'object') {
    return false;
  }
  if (ancestors.includes(value)) {
    return false;
  }
  const nextAncestors = [...ancestors, value];
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item, nextAncestors));
  }
  if (!isPlainRecord(value)) {
    return false;
  }
  return Object.values(value).every((item) => isJsonValue(item, nextAncestors));
}

export function isJsonObject(value: unknown): value is JsonObject {
  return isPlainRecord(value) && isJsonValue(value);
}

/** Strictly validates the official AskUserQuestion question projection. */
export function isInputQuestion(value: unknown): value is InputQuestion {
  if (!isPlainRecord(value)) {
    return false;
  }
  if (
    typeof value.question !== 'string' ||
    typeof value.header !== 'string' ||
    typeof value.multiSelect !== 'boolean' ||
    !Array.isArray(value.options) ||
    value.options.length < 2 ||
    value.options.length > 4
  ) {
    return false;
  }

  return value.options.every((option) => {
    if (!isPlainRecord(option) || typeof option.label !== 'string' || typeof option.description !== 'string') {
      return false;
    }
    return option.preview === undefined || typeof option.preview === 'string';
  });
}

/** Validates the SDK's 1–4 question cardinality and each question's JSON-safe shape. */
export function isInputQuestions(value: unknown): value is readonly InputQuestion[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 4 && value.every(isInputQuestion);
}

/** Validates structured answers without allowing arbitrary/SDK values to leak into actions. */
export function isInputAnswers(value: unknown): value is InputAnswers {
  return isPlainRecord(value) && Object.values(value).every((answer) => typeof answer === 'string');
}
