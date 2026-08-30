import type {
  ApprovalResolvedAction,
  ApprovalRequestedAction,
  ChatAction,
  InputResolvedAction,
  InputRequestedAction,
  ResponsePartAddedAction,
  ResponsePartDeltaAction,
  ToolCallCompletedAction,
  ToolCallInputDeltaAction,
  ToolCallReadyAction,
  ToolCallStartedAction,
  TurnCompletedAction,
  TurnFailedAction,
  TurnInterruptedAction,
  TurnStartedAction,
  TurnsLoadedAction,
} from './actions.js';
import type {
  ActiveTurn,
  ApprovalInput,
  ApprovalSuggestion,
  ChatState,
  CreateChatStateInput,
  InputQuestion,
  PendingInputRequest,
  PendingApproval,
  ResponsePart,
  ToolCall,
  Turn,
} from './chat.js';
import { isInputAnswers, isInputQuestions, isJsonObject } from './chat.js';

const EMPTY_PENDING_INPUTS: readonly PendingInputRequest[] = Object.freeze([]);

function pendingInputsOf(state: ChatState): readonly PendingInputRequest[] {
  return state.pendingInputs ?? EMPTY_PENDING_INPUTS;
}

function hasPendingForTurn(state: ChatState, turnId: Turn['id']): boolean {
  return state.pendingApprovals.some((approval) => approval.turnId === turnId)
    || pendingInputsOf(state).some((request) => request.turnId === turnId);
}

function cloneOpaqueValue(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const known = seen.get(value);
  if (known !== undefined) {
    return known;
  }
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) {
      copy.push(cloneOpaqueValue(item, seen));
    }
    return copy;
  }

  // SDK input is opaque.  Clone only ordinary JSON-like containers while
  // retaining unusual host values untouched instead of trying to interpret
  // or serialize them here.
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return value;
  }

  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const key of Object.keys(value)) {
    Object.defineProperty(copy, key, {
      configurable: true,
      enumerable: true,
      value: cloneOpaqueValue((value as Record<string, unknown>)[key], seen),
      writable: true,
    });
  }
  return copy;
}

function cloneApprovalInput(input: ApprovalInput): ApprovalInput {
  // Approval input is deliberately opaque to this layer.  In particular, do
  // not parse, normalize, or execute it; cloning only prevents caller-owned
  // containers from mutating an already-published snapshot.
  return cloneOpaqueValue(input) as ApprovalInput;
}

function cloneApprovalSuggestion(suggestion: ApprovalSuggestion): ApprovalSuggestion {
  return cloneOpaqueValue(suggestion) as ApprovalSuggestion;
}

function cloneInputQuestion(question: InputQuestion): InputQuestion {
  return {
    question: question.question,
    header: question.header,
    options: question.options.map((option) => {
      const base = {
        label: option.label,
        description: option.description,
      };
      return option.preview === undefined ? base : { ...base, preview: option.preview };
    }),
    multiSelect: question.multiSelect,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isApprovalInput(value: unknown): value is ApprovalInput {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMatchedAskRule(value: unknown): value is PendingApproval['matchedAskRule'] {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && typeof (value as { readonly source?: unknown }).source === 'string'
    && typeof (value as { readonly toolName?: unknown }).toolName === 'string'
    && isOptionalString((value as { readonly ruleContent?: unknown }).ruleContent);
}

function cloneToolCall(toolCall: ToolCall): ToolCall {
  const copy: ToolCall = {
    id: toolCall.id,
    name: toolCall.name,
    input: toolCall.input,
    status: toolCall.status,
    startedAt: toolCall.startedAt,
  };
  const withReadyAt = toolCall.readyAt === undefined ? copy : { ...copy, readyAt: toolCall.readyAt };
  const withCompletedAt = toolCall.completedAt === undefined ? withReadyAt : { ...withReadyAt, completedAt: toolCall.completedAt };
  const withResult = toolCall.result === undefined ? withCompletedAt : { ...withCompletedAt, result: toolCall.result };
  return toolCall.error === undefined ? withResult : { ...withResult, error: toolCall.error };
}

function cloneResponsePart(part: ResponsePart): ResponsePart {
  return part.kind === 'tool_call' ? { ...part, toolCall: cloneToolCall(part.toolCall) } : { ...part };
}

function cloneActiveTurn(turn: ActiveTurn): ActiveTurn {
  return { ...turn, parts: turn.parts.map(cloneResponsePart) };
}

function cloneTurn(turn: Turn): Turn {
  const copy: Turn = {
    id: turn.id,
    prompt: turn.prompt,
    status: turn.status,
    parts: turn.parts.map(cloneResponsePart),
    startedAt: turn.startedAt,
  };
  const withCompletedAt = turn.completedAt === undefined ? copy : { ...copy, completedAt: turn.completedAt };
  return turn.error === undefined ? withCompletedAt : { ...withCompletedAt, error: turn.error };
}

function clonePendingApproval(approval: PendingApproval): PendingApproval {
  const copy: PendingApproval = {
    id: approval.id,
    turnId: approval.turnId,
    requestedAt: approval.requestedAt,
  };
  const withToolCallId = approval.toolCallId === undefined ? copy : { ...copy, toolCallId: approval.toolCallId };
  const withToolName = approval.toolName === undefined ? withToolCallId : { ...withToolCallId, toolName: approval.toolName };
  const withInput = approval.input === undefined ? withToolName : { ...withToolName, input: cloneApprovalInput(approval.input) };
  const withTitle = approval.title === undefined ? withInput : { ...withInput, title: approval.title };
  const withDisplayName = approval.displayName === undefined ? withTitle : { ...withTitle, displayName: approval.displayName };
  const withDescription = approval.description === undefined ? withDisplayName : { ...withDisplayName, description: approval.description };
  const withSuggestions = approval.suggestions === undefined
    ? withDescription
    : { ...withDescription, suggestions: approval.suggestions.map(cloneApprovalSuggestion) };
  const withRequestId = approval.requestId === undefined ? withSuggestions : { ...withSuggestions, requestId: approval.requestId };
  const withSdkRequestId = approval.sdkRequestId === undefined
    ? withRequestId
    : { ...withRequestId, sdkRequestId: approval.sdkRequestId };
  const withToolUseId = approval.toolUseId === undefined ? withSdkRequestId : { ...withSdkRequestId, toolUseId: approval.toolUseId };
  const withToolUseID = approval.toolUseID === undefined ? withToolUseId : { ...withToolUseId, toolUseID: approval.toolUseID };
  const withAgentId = approval.agentId === undefined ? withToolUseID : { ...withToolUseID, agentId: approval.agentId };
  const withAgentID = approval.agentID === undefined ? withAgentId : { ...withAgentId, agentID: approval.agentID };
  const withBlockedPath = approval.blockedPath === undefined ? withAgentID : { ...withAgentID, blockedPath: approval.blockedPath };
  const withDecisionReason = approval.decisionReason === undefined
    ? withBlockedPath
    : { ...withBlockedPath, decisionReason: approval.decisionReason };
  return approval.matchedAskRule === undefined
    ? withDecisionReason
    : { ...withDecisionReason, matchedAskRule: { ...approval.matchedAskRule } };
}

function clonePendingInput(request: PendingInputRequest): PendingInputRequest {
  return {
    id: request.id,
    turnId: request.turnId,
    questions: request.questions.map(cloneInputQuestion),
    requestedAt: request.requestedAt,
  };
}

export function createChatState(input: CreateChatStateInput = {}): ChatState {
  const activeTurn = input.activeTurn === undefined ? undefined : cloneActiveTurn(input.activeTurn);
  const pendingApprovals = (input.pendingApprovals ?? []).map(clonePendingApproval);
  const pendingInputs = (input.pendingInputs ?? []).map(clonePendingInput);
  const base: Omit<ChatState, 'activeTurn' | 'resource'> = {
    status:
      input.status ??
      (pendingApprovals.length > 0 || pendingInputs.length > 0
        ? 'input_needed'
        : activeTurn === undefined ? 'idle' : 'in_progress'),
    turns: (input.turns ?? []).map(cloneTurn),
    pendingApprovals,
    pendingInputs,
    modifiedAt: input.modifiedAt ?? '',
  };

  const withActiveTurn: ChatState =
    activeTurn === undefined ? base : { ...base, activeTurn };

  return input.resource === undefined ? withActiveTurn : { ...withActiveTurn, resource: input.resource };
}

function updateActiveTurn(
  state: ChatState,
  activeTurn: ActiveTurn,
  timestamp: string,
  status: ChatState['status'] = hasPendingForTurn(state, activeTurn.id) ? 'input_needed' : 'in_progress',
): ChatState {
  return { ...state, activeTurn, status, modifiedAt: timestamp };
}

function getActiveTurn(state: ChatState, turnId: TurnStartedAction['turnId']): ActiveTurn | undefined {
  return state.activeTurn?.id === turnId ? state.activeTurn : undefined;
}

function isResponsePartAddedPart(value: unknown): value is ResponsePartAddedAction['part'] {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as { readonly kind?: unknown; readonly id?: unknown; readonly content?: unknown };
  return (
    (candidate.kind === 'markdown' || candidate.kind === 'reasoning') &&
    typeof candidate.id === 'string' &&
    typeof candidate.content === 'string'
  );
}

function findResponsePart(turn: ActiveTurn, partId: ResponsePart['id']): ResponsePart | undefined {
  return turn.parts.find((part) => part.id === partId);
}

function hasToolCall(turn: ActiveTurn, toolCallId: ToolCall['id']): boolean {
  return turn.parts.some((part) => part.kind === 'tool_call' && part.toolCall.id === toolCallId);
}

function replaceResponsePart(
  turn: ActiveTurn,
  partId: ResponsePart['id'],
  replace: (part: ResponsePart) => ResponsePart | undefined,
): ActiveTurn | undefined {
  const index = turn.parts.findIndex((part) => part.id === partId);
  if (index < 0) {
    return undefined;
  }

  const current = turn.parts[index];
  if (current === undefined) {
    return undefined;
  }

  const next = replace(current);
  if (next === undefined || next === current) {
    return undefined;
  }

  const parts = [...turn.parts];
  parts[index] = next;
  return { ...turn, parts };
}

function removeActiveTurn(state: ChatState): Omit<ChatState, 'activeTurn'> {
  const { activeTurn: _activeTurn, ...withoutActiveTurn } = state;
  return withoutActiveTurn;
}

function appendTerminalTurn(
  state: ChatState,
  turn: ActiveTurn,
  status: Exclude<Turn['status'], 'active'>,
  timestamp: string,
  error?: string,
): ChatState {
  if (state.turns.some((existingTurn) => existingTurn.id === turn.id)) {
    return state;
  }

  const terminalTurnBase: Turn = {
    id: turn.id,
    prompt: turn.prompt,
    status,
    parts: turn.parts.map(cloneResponsePart),
    startedAt: turn.startedAt,
    completedAt: timestamp,
  };
  const terminalTurn = error === undefined ? terminalTurnBase : { ...terminalTurnBase, error };
  const withoutActive = removeActiveTurn(state);
  const pendingApprovals = state.pendingApprovals.filter((approval) => approval.turnId !== turn.id);
  const pendingInputs = pendingInputsOf(state).filter((request) => request.turnId !== turn.id);

  const nextState: Omit<ChatState, 'activeTurn'> = {
    ...withoutActive,
    status: status === 'failed' ? 'error' : 'idle',
    turns: [...state.turns, terminalTurn],
    pendingApprovals,
    pendingInputs,
    modifiedAt: timestamp,
  };
  return nextState;
}

function reduceTurnStarted(state: ChatState, action: TurnStartedAction): ChatState {
  if (state.activeTurn !== undefined || state.turns.some((turn) => turn.id === action.turnId)) {
    return state;
  }

  const activeTurn: ActiveTurn = {
    id: action.turnId,
    prompt: action.prompt,
    status: 'active',
    parts: [],
    startedAt: action.timestamp,
  };
  return { ...state, activeTurn, status: 'in_progress', modifiedAt: action.timestamp };
}

function reduceResponsePartAdded(state: ChatState, action: ResponsePartAddedAction): ChatState {
  // Keep the runtime boundary aligned with the type-level lifecycle boundary.
  // Casted JavaScript values must not inject a tool part outside tool actions.
  if (!isResponsePartAddedPart(action.part)) {
    return state;
  }

  const activeTurn = getActiveTurn(state, action.turnId);
  if (activeTurn === undefined || findResponsePart(activeTurn, action.part.id) !== undefined) {
    return state;
  }
  const nextTurn: ActiveTurn = {
    ...activeTurn,
    parts: [...activeTurn.parts, cloneResponsePart(action.part)],
  };
  return updateActiveTurn(state, nextTurn, action.timestamp);
}

function reduceResponsePartDelta(state: ChatState, action: ResponsePartDeltaAction): ChatState {
  const activeTurn = getActiveTurn(state, action.turnId);
  if (activeTurn === undefined || action.delta.length === 0) {
    return state;
  }

  const nextTurn = replaceResponsePart(activeTurn, action.partId, (part) => {
    if (part.kind !== 'markdown' && part.kind !== 'reasoning') {
      return undefined;
    }
    return { ...part, content: `${part.content}${action.delta}` };
  });
  return nextTurn === undefined ? state : updateActiveTurn(state, nextTurn, action.timestamp);
}

function reduceToolCallStarted(state: ChatState, action: ToolCallStartedAction): ChatState {
  const activeTurn = getActiveTurn(state, action.turnId);
  if (
    activeTurn === undefined ||
    findResponsePart(activeTurn, action.partId) !== undefined ||
    hasToolCall(activeTurn, action.toolCallId)
  ) {
    return state;
  }

  const toolCall: ToolCall = {
    id: action.toolCallId,
    name: action.name,
    input: action.input ?? '',
    status: 'started',
    startedAt: action.timestamp,
  };
  const part: ResponsePart = { kind: 'tool_call', id: action.partId, toolCall };
  const nextTurn: ActiveTurn = {
    ...activeTurn,
    parts: [...activeTurn.parts, part],
  };
  return updateActiveTurn(state, nextTurn, action.timestamp);
}

function reduceToolCallInputDelta(state: ChatState, action: ToolCallInputDeltaAction): ChatState {
  const activeTurn = getActiveTurn(state, action.turnId);
  if (activeTurn === undefined || action.delta.length === 0) {
    return state;
  }

  const nextTurn = replaceResponsePart(activeTurn, action.partId, (part) => {
    if (part.kind !== 'tool_call' || part.toolCall.id !== action.toolCallId || part.toolCall.status !== 'started') {
      return undefined;
    }
    const toolCall: ToolCall = { ...part.toolCall, input: `${part.toolCall.input}${action.delta}` };
    return { ...part, toolCall };
  });
  return nextTurn === undefined ? state : updateActiveTurn(state, nextTurn, action.timestamp);
}

function reduceToolCallReady(state: ChatState, action: ToolCallReadyAction): ChatState {
  const activeTurn = getActiveTurn(state, action.turnId);
  if (activeTurn === undefined) {
    return state;
  }

  const nextTurn = replaceResponsePart(activeTurn, action.partId, (part) => {
    if (part.kind !== 'tool_call' || part.toolCall.id !== action.toolCallId || part.toolCall.status !== 'started') {
      return undefined;
    }
    const toolCall: ToolCall = { ...part.toolCall, status: 'ready', readyAt: action.timestamp };
    return { ...part, toolCall };
  });
  return nextTurn === undefined ? state : updateActiveTurn(state, nextTurn, action.timestamp);
}

function reduceToolCallCompleted(state: ChatState, action: ToolCallCompletedAction): ChatState {
  const activeTurn = getActiveTurn(state, action.turnId);
  if (activeTurn === undefined) {
    return state;
  }

  const nextTurn = replaceResponsePart(activeTurn, action.partId, (part) => {
    if (part.kind !== 'tool_call' || part.toolCall.id !== action.toolCallId || part.toolCall.status === 'completed') {
      return undefined;
    }

    const completedToolCall: ToolCall = {
      ...part.toolCall,
      status: 'completed',
      completedAt: action.timestamp,
    };
    const withResult = action.result === undefined ? completedToolCall : { ...completedToolCall, result: action.result };
    const withError = action.error === undefined ? withResult : { ...withResult, error: action.error };
    return { ...part, toolCall: withError };
  });
  return nextTurn === undefined ? state : updateActiveTurn(state, nextTurn, action.timestamp);
}

function reduceApprovalRequested(state: ChatState, action: ApprovalRequestedAction): ChatState {
  const activeTurn = getActiveTurn(state, action.turnId);
  const toolCallId = action.toolCallId;
  if (
    activeTurn === undefined ||
    (toolCallId !== undefined && !hasToolCall(activeTurn, toolCallId)) ||
    state.pendingApprovals.some((approval) => approval.id === action.approvalId) ||
    !isNonEmptyString(action.approvalId) ||
    (toolCallId !== undefined && !isNonEmptyString(toolCallId)) ||
    !isNonEmptyString(action.toolName) ||
    !isApprovalInput(action.input) ||
    (action.title !== undefined && typeof action.title !== 'string') ||
    (action.displayName !== undefined && typeof action.displayName !== 'string') ||
    (action.description !== undefined && typeof action.description !== 'string') ||
    (action.suggestions !== undefined
      && (!Array.isArray(action.suggestions) || !action.suggestions.every(isJsonObject))) ||
    (action.requestId !== undefined && typeof action.requestId !== 'string') ||
    (action.sdkRequestId !== undefined && typeof action.sdkRequestId !== 'string') ||
    (action.toolUseId !== undefined && typeof action.toolUseId !== 'string') ||
    (action.toolUseID !== undefined && typeof action.toolUseID !== 'string') ||
    (action.agentId !== undefined && typeof action.agentId !== 'string') ||
    (action.agentID !== undefined && typeof action.agentID !== 'string') ||
    (action.blockedPath !== undefined && typeof action.blockedPath !== 'string') ||
    (action.decisionReason !== undefined && typeof action.decisionReason !== 'string') ||
    (action.matchedAskRule !== undefined && !isMatchedAskRule(action.matchedAskRule)) ||
    (action.requestedAt !== undefined && typeof action.requestedAt !== 'string')
  ) {
    return state;
  }

  const approval: PendingApproval = {
    id: action.approvalId,
    turnId: action.turnId,
    ...(toolCallId === undefined ? {} : { toolCallId }),
    toolName: action.toolName,
    input: cloneApprovalInput(action.input),
    ...(action.title === undefined ? {} : { title: action.title }),
    ...(action.displayName === undefined ? {} : { displayName: action.displayName }),
    ...(action.description === undefined ? {} : { description: action.description }),
    ...(action.suggestions === undefined
      ? {}
      : { suggestions: action.suggestions.map(cloneApprovalSuggestion) }),
    ...(action.requestId === undefined ? {} : { requestId: action.requestId }),
    ...(action.sdkRequestId === undefined ? {} : { sdkRequestId: action.sdkRequestId }),
    ...(action.toolUseId === undefined ? {} : { toolUseId: action.toolUseId }),
    ...(action.toolUseID === undefined ? {} : { toolUseID: action.toolUseID }),
    ...(action.agentId === undefined ? {} : { agentId: action.agentId }),
    ...(action.agentID === undefined ? {} : { agentID: action.agentID }),
    ...(action.blockedPath === undefined ? {} : { blockedPath: action.blockedPath }),
    ...(action.decisionReason === undefined ? {} : { decisionReason: action.decisionReason }),
    ...(action.matchedAskRule === undefined ? {} : { matchedAskRule: { ...action.matchedAskRule } }),
    requestedAt: action.requestedAt ?? action.timestamp,
  };
  return {
    ...state,
    status: 'input_needed',
    pendingApprovals: [...state.pendingApprovals, approval],
    modifiedAt: action.timestamp,
  };
}

function reduceApprovalResolved(state: ChatState, action: ApprovalResolvedAction): ChatState {
  const activeTurn = getActiveTurn(state, action.turnId);
  if (activeTurn === undefined || (action.decision !== 'allow' && action.decision !== 'deny')) {
    return state;
  }

  const index = state.pendingApprovals.findIndex(
    (approval) => approval.id === action.approvalId && approval.turnId === action.turnId,
  );
  if (index < 0) {
    return state;
  }

  const pendingApprovals = state.pendingApprovals.filter((_, approvalIndex) => approvalIndex !== index);
  return {
    ...state,
    status: pendingApprovals.some((approval) => approval.turnId === action.turnId)
      || pendingInputsOf(state).some((request) => request.turnId === action.turnId)
      ? 'input_needed'
      : 'in_progress',
    pendingApprovals,
    modifiedAt: action.timestamp,
  };
}

function reduceInputRequested(state: ChatState, action: InputRequestedAction): ChatState {
  const activeTurn = getActiveTurn(state, action.turnId);
  const pendingInputs = pendingInputsOf(state);
  if (
    activeTurn === undefined ||
    !isNonEmptyString(action.inputId) ||
    !isInputQuestions(action.questions) ||
    (action.requestedAt !== undefined && typeof action.requestedAt !== 'string') ||
    pendingInputs.some((request) => request.id === action.inputId)
  ) {
    return state;
  }

  const request: PendingInputRequest = {
    id: action.inputId,
    turnId: action.turnId,
    questions: action.questions.map(cloneInputQuestion),
    requestedAt: action.requestedAt ?? action.timestamp,
  };
  return {
    ...state,
    status: 'input_needed',
    pendingInputs: [...pendingInputs, request],
    modifiedAt: action.timestamp,
  };
}

function reduceInputResolved(state: ChatState, action: InputResolvedAction): ChatState {
  const activeTurn = getActiveTurn(state, action.turnId);
  if (activeTurn === undefined) {
    return state;
  }

  const pendingInputs = pendingInputsOf(state);
  const index = pendingInputs.findIndex(
    (request) => request.id === action.inputId && request.turnId === action.turnId,
  );
  if (index < 0 || (action.answers !== undefined && !isInputAnswers(action.answers))) {
    return state;
  }

  const nextPendingInputs = pendingInputs.filter((_, requestIndex) => requestIndex !== index);
  const nextState: ChatState = {
    ...state,
    status: state.pendingApprovals.some((approval) => approval.turnId === action.turnId)
      || nextPendingInputs.some((request) => request.turnId === action.turnId)
      ? 'input_needed'
      : 'in_progress',
    modifiedAt: action.timestamp,
    pendingInputs: nextPendingInputs,
  };
  return nextState;
}

function reduceTurnCompleted(state: ChatState, action: TurnCompletedAction): ChatState {
  const activeTurn = getActiveTurn(state, action.turnId);
  return activeTurn === undefined ? state : appendTerminalTurn(state, activeTurn, 'complete', action.timestamp);
}

function reduceTurnFailed(state: ChatState, action: TurnFailedAction): ChatState {
  const activeTurn = getActiveTurn(state, action.turnId);
  return activeTurn === undefined ? state : appendTerminalTurn(state, activeTurn, 'failed', action.timestamp, action.error);
}

function reduceTurnInterrupted(state: ChatState, action: TurnInterruptedAction): ChatState {
  const activeTurn = getActiveTurn(state, action.turnId);
  return activeTurn === undefined ? state : appendTerminalTurn(state, activeTurn, 'interrupted', action.timestamp);
}

function mergeLoadedTurns(state: ChatState, action: TurnsLoadedAction): readonly Turn[] {
  const activeTurnId = state.activeTurn?.id;
  const result = state.turns.filter((turn) => turn.id !== activeTurnId);
  const seenLoadedIds = new Set<Turn['id']>();

  for (const loadedTurn of action.turns) {
    if (loadedTurn.id === activeTurnId || seenLoadedIds.has(loadedTurn.id)) {
      continue;
    }
    seenLoadedIds.add(loadedTurn.id);

    const existingIndex = result.findIndex((turn) => turn.id === loadedTurn.id);
    if (existingIndex >= 0) {
      const existingTurn = result[existingIndex];
      // A replayed completed transcript is authoritative for the matching
      // completed history row, but never replaces a live/failed/interrupted row.
      if (
        existingTurn !== undefined
        && existingTurn.status === 'complete'
        && !sameTurnValue(existingTurn, loadedTurn)
      ) {
        result[existingIndex] = cloneTurn(loadedTurn);
      }
      continue;
    }

    result.push(cloneTurn(loadedTurn));
  }

  return result;
}

function sameTurnValues(left: readonly Turn[], right: readonly Turn[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((turn, index) => {
    const other = right[index];
    return other !== undefined && (turn === other || sameTurnValue(turn, other));
  });
}

function sameTurnValue(left: Turn, right: Turn): boolean {
  if (
    left.id !== right.id
    || left.prompt !== right.prompt
    || left.status !== right.status
    || left.startedAt !== right.startedAt
    || left.completedAt !== right.completedAt
    || left.error !== right.error
    || left.parts.length !== right.parts.length
  ) {
    return false;
  }

  return left.parts.every((part, index) => {
    const other = right.parts[index];
    if (other === undefined || part.kind !== other.kind || part.id !== other.id) {
      return false;
    }
    if (part.kind === 'markdown' && other.kind === 'markdown') {
      return part.content === other.content;
    }
    if (part.kind === 'reasoning' && other.kind === 'reasoning') {
      return part.content === other.content;
    }
    if (part.kind !== 'tool_call' || other.kind !== 'tool_call') {
      return false;
    }

    const leftTool = part.toolCall;
    const rightTool = other.toolCall;
    return (
      leftTool.id === rightTool.id
      && leftTool.name === rightTool.name
      && leftTool.input === rightTool.input
      && leftTool.status === rightTool.status
      && leftTool.startedAt === rightTool.startedAt
      && leftTool.readyAt === rightTool.readyAt
      && leftTool.completedAt === rightTool.completedAt
      && leftTool.result === rightTool.result
      && leftTool.error === rightTool.error
    );
  });
}

function reduceTurnsLoaded(state: ChatState, action: TurnsLoadedAction): ChatState {
  const turns = mergeLoadedTurns(state, action);
  if (sameTurnValues(state.turns, turns)) {
    return state;
  }
  return { ...state, turns, modifiedAt: action.timestamp };
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'chat/turnStarted':
      return reduceTurnStarted(state, action);
    case 'chat/responsePartAdded':
      return reduceResponsePartAdded(state, action);
    case 'chat/responsePartDelta':
      return reduceResponsePartDelta(state, action);
    case 'chat/toolCallStarted':
      return reduceToolCallStarted(state, action);
    case 'chat/toolCallInputDelta':
      return reduceToolCallInputDelta(state, action);
    case 'chat/toolCallReady':
      return reduceToolCallReady(state, action);
    case 'chat/toolCallCompleted':
      return reduceToolCallCompleted(state, action);
    case 'chat/inputRequested':
      return reduceInputRequested(state, action);
    case 'chat/inputResolved':
      return reduceInputResolved(state, action);
    case 'chat/approvalRequested':
      return reduceApprovalRequested(state, action);
    case 'chat/approvalResolved':
      return reduceApprovalResolved(state, action);
    case 'chat/turnCompleted':
      return reduceTurnCompleted(state, action);
    case 'chat/turnFailed':
      return reduceTurnFailed(state, action);
    case 'chat/turnInterrupted':
      return reduceTurnInterrupted(state, action);
    case 'chat/turnsLoaded':
      return reduceTurnsLoaded(state, action);
    default:
      return state;
  }
}

export function reduceChatActions(initial: ChatState, actions: readonly ChatAction[]): ChatState {
  return actions.reduce(chatReducer, initial);
}
