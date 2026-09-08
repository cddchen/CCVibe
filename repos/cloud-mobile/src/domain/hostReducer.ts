import type {
  HostCatalogAction,
  HostChatAction,
  HostChatState,
  HostRootCatalogState,
} from '../protocol/hostWire';
import type { ChatUri, RootUri } from '../protocol/resourceUri';

type HostTurn = HostChatState['turns'][number];
type HostActiveTurn = NonNullable<HostChatState['activeTurn']>;
type HostResponsePart = HostActiveTurn['parts'][number];

function sameSystemMessagePart(
  left: Extract<HostResponsePart, { readonly kind: 'system_message' }>,
  right: Extract<HostResponsePart, { readonly kind: 'system_message' }>,
): boolean {
  return left.id === right.id
    && left.event === right.event
    && left.title === right.title
    && left.content === right.content
    && left.level === right.level;
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.isFrozen(values) ? values : Object.freeze([...values]);
}

export function createHostChatState(resource: ChatUri, modifiedAt = ''): HostChatState {
  return Object.freeze({
    resource,
    status: 'idle' as const,
    turns: freezeArray([]),
    pendingApprovals: freezeArray([]),
    pendingInputs: freezeArray([]),
    modifiedAt,
  });
}

export function applyHostRootCatalogAction(
  state: HostRootCatalogState,
  action: HostCatalogAction,
): HostRootCatalogState {
  switch (action.type) {
    case 'catalog/hostUpdated':
      return Object.freeze({ ...state, host: Object.freeze({ ...action.host }), connection: Object.freeze({ ...action.connection }), modifiedAt: action.timestamp });
    case 'catalog/workspacesReplaced':
      return Object.freeze({ ...state, workspaces: freezeArray(action.workspaces), modifiedAt: action.timestamp });
    case 'catalog/modelsReplaced':
      return action.defaultModelId === undefined
        ? Object.freeze({ ...state, models: freezeArray(action.models), modifiedAt: action.timestamp })
        : Object.freeze({ ...state, models: freezeArray(action.models), defaultModelId: action.defaultModelId, modifiedAt: action.timestamp });
    case 'catalog/sessionsReplaced':
      return Object.freeze({ ...state, sessions: freezeArray(action.sessions), modifiedAt: action.timestamp });
    case 'catalog/chatCreated':
    case 'catalog/chatUpdated': {
      const index = state.sessions.findIndex((session) => session.chatUri === action.session.chatUri);
      const sessions = [...state.sessions];
      if (index < 0) {
        sessions.push(action.session);
      } else {
        sessions[index] = action.session;
      }
      return Object.freeze({ ...state, sessions: freezeArray(sessions), modifiedAt: action.timestamp });
    }
    case 'catalog/chatRemoved':
      return Object.freeze({
        ...state,
        sessions: freezeArray(state.sessions.filter((session) => session.chatUri !== action.chatUri)),
        modifiedAt: action.timestamp,
      });
  }
}

export function applyHostChatAction(state: HostChatState, action: HostChatAction): HostChatState {
  const pendingInputs = state.pendingInputs ?? [];
  switch (action.type) {
    case 'chat/turnStarted': {
      if (state.activeTurn !== undefined || state.turns.some((turn) => turn.id === action.turnId)) return state;
      const activeTurn: HostActiveTurn = {
        id: action.turnId,
        prompt: action.prompt,
        status: 'active',
        parts: freezeArray([]),
        startedAt: action.timestamp,
      };
      return freezeChat({ ...state, activeTurn, status: 'in_progress', modifiedAt: action.timestamp, pendingInputs });
    }
    case 'chat/turnActivityChanged': {
      const activeTurn = state.activeTurn;
      if (activeTurn === undefined || activeTurn.id !== action.turnId
        || activeTurn.activity === action.activity
        || (action.activity === null && activeTurn.activity === undefined)) return state;
      if (action.activity === null) {
        const withoutActivity: HostActiveTurn = {
          id: activeTurn.id,
          prompt: activeTurn.prompt,
          status: activeTurn.status,
          parts: activeTurn.parts,
          startedAt: activeTurn.startedAt,
        };
        return updateActiveTurn(state, withoutActivity, action.timestamp);
      }
      return updateActiveTurn(state, { ...activeTurn, activity: action.activity }, action.timestamp);
    }
    case 'chat/responsePartAdded': {
      const activeTurn = state.activeTurn;
      if (activeTurn !== undefined) {
        const existingIndex = activeTurn.parts.findIndex((part) => part.id === action.part.id);
        if (existingIndex >= 0) {
          const existing = activeTurn.parts[existingIndex];
          if (existing === undefined || existing.kind !== 'system_message' || action.part.kind !== 'system_message') return state;
          if (sameSystemMessagePart(existing, action.part)) return state;
          const parts = [...activeTurn.parts];
          parts[existingIndex] = action.part;
          return updateActiveTurn(state, { ...activeTurn, parts: freezeArray(parts) }, action.timestamp);
        }
        const parts = [...activeTurn.parts, action.part];
        return updateActiveTurn(state, { ...activeTurn, parts: freezeArray(parts) }, action.timestamp);
      }
      const turnIndex = state.turns.findIndex((turn) => turn.id === action.turnId);
      const turn = state.turns[turnIndex];
      if (turnIndex < 0 || turn === undefined) return state;
      const existingIndex = turn.parts.findIndex((part) => part.id === action.part.id);
      if (existingIndex >= 0) {
        const existing = turn.parts[existingIndex];
        if (existing === undefined || existing.kind !== 'system_message' || action.part.kind !== 'system_message') return state;
        if (sameSystemMessagePart(existing, action.part)) return state;
        const parts = [...turn.parts];
        parts[existingIndex] = action.part;
        const turns = [...state.turns];
        turns[turnIndex] = Object.freeze({ ...turn, parts: freezeArray(parts) });
        return freezeChat({ ...state, turns: freezeArray(turns), pendingInputs, modifiedAt: action.timestamp });
      }
      const turns = [...state.turns];
      turns[turnIndex] = Object.freeze({ ...turn, parts: freezeArray([...turn.parts, action.part]) });
      return freezeChat({ ...state, turns: freezeArray(turns), pendingInputs, modifiedAt: action.timestamp });
    }
    case 'chat/responsePartDelta': {
      const activeTurn = state.activeTurn;
      if (activeTurn === undefined || action.delta.length === 0) return state;
      const parts = activeTurn.parts.map((part) => {
        if (part.id !== action.partId || (part.kind !== 'markdown' && part.kind !== 'reasoning')) return part;
        return { ...part, content: `${part.content}${action.delta}` };
      });
      if (parts.every((part, index) => part === activeTurn.parts[index])) return state;
      return updateActiveTurn(state, { ...activeTurn, parts: freezeArray(parts) }, action.timestamp);
    }
    case 'chat/toolCallStarted': {
      const activeTurn = state.activeTurn;
      if (
        activeTurn === undefined
        || activeTurn.parts.some((part) => part.id === action.partId)
        || activeTurn.parts.some((part) => part.kind === 'tool_call' && part.toolCall.id === action.toolCallId)
      ) return state;
      const toolCall = {
        id: action.toolCallId,
        name: action.name,
        input: action.input ?? '',
        status: 'started' as const,
        startedAt: action.timestamp,
      };
      const part: HostResponsePart = { kind: 'tool_call', id: action.partId, toolCall };
      return updateActiveTurn(state, { ...activeTurn, parts: freezeArray([...activeTurn.parts, part]) }, action.timestamp);
    }
    case 'chat/toolCallInputDelta': {
      const activeTurn = state.activeTurn;
      if (activeTurn === undefined || action.delta.length === 0) return state;
      const parts = activeTurn.parts.map((part) => {
        if (part.id !== action.partId || part.kind !== 'tool_call' || part.toolCall.id !== action.toolCallId || part.toolCall.status !== 'started') return part;
        return { ...part, toolCall: { ...part.toolCall, input: `${part.toolCall.input}${action.delta}` } };
      });
      if (parts.every((part, index) => part === activeTurn.parts[index])) return state;
      return updateActiveTurn(state, { ...activeTurn, parts: freezeArray(parts) }, action.timestamp);
    }
    case 'chat/toolCallReady': {
      const activeTurn = state.activeTurn;
      if (activeTurn === undefined) return state;
      const parts = activeTurn.parts.map((part) => {
        if (part.id !== action.partId || part.kind !== 'tool_call' || part.toolCall.id !== action.toolCallId || part.toolCall.status !== 'started') return part;
        return { ...part, toolCall: { ...part.toolCall, status: 'ready' as const, readyAt: action.timestamp } };
      });
      if (parts.every((part, index) => part === activeTurn.parts[index])) return state;
      return updateActiveTurn(state, { ...activeTurn, parts: freezeArray(parts) }, action.timestamp);
    }
    case 'chat/toolCallCompleted': {
      const activeTurn = state.activeTurn;
      if (activeTurn === undefined) return state;
      const parts = activeTurn.parts.map((part) => {
        if (part.id !== action.partId || part.kind !== 'tool_call' || part.toolCall.id !== action.toolCallId || part.toolCall.status === 'completed') return part;
        const base = { ...part.toolCall, status: 'completed' as const, completedAt: action.timestamp };
        const toolCall = action.result === undefined
          ? action.error === undefined ? base : { ...base, error: action.error }
          : action.error === undefined ? { ...base, result: action.result } : { ...base, result: action.result, error: action.error };
        return { ...part, toolCall };
      });
      if (parts.every((part, index) => part === activeTurn.parts[index])) return state;
      return updateActiveTurn(state, { ...activeTurn, parts: freezeArray(parts) }, action.timestamp);
    }
    case 'chat/approvalRequested': {
      const activeTurn = state.activeTurn;
      if (
        activeTurn === undefined
        || state.pendingApprovals.some((approval) => approval.id === action.approvalId)
        || (action.toolCallId !== undefined && !hasToolCall(activeTurn, action.toolCallId))
      ) return state;
      const pendingApproval = {
        id: action.approvalId,
        turnId: action.turnId,
        ...(action.toolCallId === undefined ? {} : { toolCallId: action.toolCallId }),
        toolName: action.toolName,
        input: action.input,
        ...(action.title === undefined ? {} : { title: action.title }),
        ...(action.displayName === undefined ? {} : { displayName: action.displayName }),
        ...(action.description === undefined ? {} : { description: action.description }),
        ...(action.suggestions === undefined ? {} : { suggestions: action.suggestions }),
        ...(action.requestId === undefined ? {} : { requestId: action.requestId }),
        ...(action.sdkRequestId === undefined ? {} : { sdkRequestId: action.sdkRequestId }),
        ...(action.toolUseId === undefined ? {} : { toolUseId: action.toolUseId }),
        ...(action.toolUseID === undefined ? {} : { toolUseID: action.toolUseID }),
        ...(action.agentId === undefined ? {} : { agentId: action.agentId }),
        ...(action.agentID === undefined ? {} : { agentID: action.agentID }),
        ...(action.blockedPath === undefined ? {} : { blockedPath: action.blockedPath }),
        ...(action.decisionReason === undefined ? {} : { decisionReason: action.decisionReason }),
        ...(action.matchedAskRule === undefined ? {} : { matchedAskRule: action.matchedAskRule }),
        requestedAt: action.requestedAt ?? action.timestamp,
      };
      return freezeChat({
        ...state,
        status: 'input_needed',
        pendingApprovals: freezeArray([...state.pendingApprovals, pendingApproval]),
        pendingInputs,
        modifiedAt: action.timestamp,
      });
    }
    case 'chat/approvalResolved': {
      if (state.activeTurn?.id !== action.turnId) return state;
      const pendingApprovals = state.pendingApprovals.filter((approval) => !(approval.id === action.approvalId && approval.turnId === action.turnId));
      if (pendingApprovals.length === state.pendingApprovals.length) return state;
      return freezeChat({
        ...state,
        status: hasPendingForTurn(pendingApprovals, pendingInputs, action.turnId) ? 'input_needed' : 'in_progress',
        pendingApprovals: freezeArray(pendingApprovals),
        pendingInputs,
        modifiedAt: action.timestamp,
      });
    }
    case 'chat/inputRequested': {
      if (
        state.activeTurn?.id !== action.turnId
        || pendingInputs.some((request) => request.id === action.inputId)
      ) return state;
      const pendingInput = {
        id: action.inputId,
        turnId: action.turnId,
        questions: action.questions,
        requestedAt: action.requestedAt ?? action.timestamp,
      };
      return freezeChat({
        ...state,
        status: 'input_needed',
        pendingApprovals: state.pendingApprovals,
        pendingInputs: freezeArray([...pendingInputs, pendingInput]),
        modifiedAt: action.timestamp,
      });
    }
    case 'chat/inputResolved': {
      if (state.activeTurn?.id !== action.turnId) return state;
      const nextPendingInputs = pendingInputs.filter((request) => !(request.id === action.inputId && request.turnId === action.turnId));
      if (nextPendingInputs.length === pendingInputs.length) return state;
      return freezeChat({
        ...state,
        status: hasPendingForTurn(state.pendingApprovals, nextPendingInputs, action.turnId) ? 'input_needed' : 'in_progress',
        pendingInputs: freezeArray(nextPendingInputs),
        modifiedAt: action.timestamp,
      });
    }
    case 'chat/turnCompleted':
      return completeActiveTurn(state, action.turnId, 'complete', action.timestamp);
    case 'chat/turnFailed':
      return completeActiveTurn(state, action.turnId, 'failed', action.timestamp, action.error);
    case 'chat/turnInterrupted':
      return completeActiveTurn(state, action.turnId, 'interrupted', action.timestamp);
    case 'chat/rewound': {
      const targetIndex = state.turns.findIndex((turn) => turn.id === action.targetTurnId);
      if (targetIndex < 0 || state.activeTurn !== undefined) return state;
      return freezeChat({
        ...state,
        status: 'idle',
        turns: freezeArray(state.turns.slice(0, targetIndex)),
        pendingApprovals: freezeArray([]),
        pendingInputs: freezeArray([]),
        modifiedAt: action.timestamp,
      });
    }
    case 'chat/turnsLoaded': {
      const existing = new Map(state.turns.map((turn) => [turn.id, turn]));
      for (const turn of action.turns) {
        if (!existing.has(turn.id)) existing.set(turn.id, turn);
      }
      const turns = [...existing.values()];
      return turns.length === state.turns.length
        ? state
        : freezeChat({ ...state, turns: freezeArray(turns), pendingInputs, modifiedAt: action.timestamp });
    }
  }
}

function updateActiveTurn(state: HostChatState, activeTurn: HostActiveTurn, timestamp: string): HostChatState {
  return freezeChat({
    ...state,
    activeTurn,
    status: hasPendingForTurn(state.pendingApprovals, state.pendingInputs ?? [], activeTurn.id) ? 'input_needed' : 'in_progress',
    pendingInputs: state.pendingInputs ?? [],
    modifiedAt: timestamp,
  });
}

function completeActiveTurn(
  state: HostChatState,
  turnId: string,
  status: 'complete' | 'failed' | 'interrupted',
  timestamp: string,
  error?: string,
): HostChatState {
  const activeTurn = state.activeTurn;
  if (activeTurn === undefined || activeTurn.id !== turnId) return state;
  const base: HostTurn = {
    id: activeTurn.id,
    prompt: activeTurn.prompt,
    status,
    parts: freezeArray(activeTurn.parts),
    startedAt: activeTurn.startedAt,
    completedAt: timestamp,
    ...(error === undefined ? {} : { error }),
  };
  const pendingInputs = (state.pendingInputs ?? []).filter((request) => request.turnId !== turnId);
  const pendingApprovals = state.pendingApprovals.filter((approval) => approval.turnId !== turnId);
  return freezeChat({
    ...state,
    activeTurn: undefined,
    status: status === 'failed' ? 'error' : 'idle',
    turns: freezeArray([...state.turns, base]),
    pendingApprovals: freezeArray(pendingApprovals),
    pendingInputs: freezeArray(pendingInputs),
    modifiedAt: timestamp,
  });
}

function hasToolCall(turn: HostActiveTurn, toolCallId: string): boolean {
  return turn.parts.some((part) => part.kind === 'tool_call' && part.toolCall.id === toolCallId);
}

function hasPendingForTurn(
  approvals: readonly { readonly turnId: string }[],
  inputs: readonly { readonly turnId: string }[],
  turnId: string,
): boolean {
  return approvals.some((approval) => approval.turnId === turnId) || inputs.some((input) => input.turnId === turnId);
}

function freezeChat(state: HostChatState): HostChatState {
  const pendingInputs = state.pendingInputs ?? [];
  const activeTurn = state.activeTurn === undefined
    ? undefined
    : Object.isFrozen(state.activeTurn) && Object.isFrozen(state.activeTurn.parts)
      ? state.activeTurn
      : Object.freeze({
          ...state.activeTurn,
          parts: freezeArray(state.activeTurn.parts),
        });
  return Object.freeze({
    ...state,
    ...(activeTurn === undefined ? { activeTurn: undefined } : { activeTurn }),
    turns: freezeArray(state.turns),
    pendingApprovals: freezeArray(state.pendingApprovals),
    pendingInputs: freezeArray(pendingInputs),
  });
}

export function resourceStateKind(resource: string): 'root' | 'chat' {
  return resource === 'agent-root://' ? 'root' : 'chat';
}

export type HostResourceState =
  | { readonly resource: RootUri; readonly state: HostRootCatalogState; readonly lastServerSeq: number }
  | { readonly resource: ChatUri; readonly state: HostChatState; readonly lastServerSeq: number };
