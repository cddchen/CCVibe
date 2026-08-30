import type { ChatAction, ChatState, ChatTurn } from './types';
import { decideServerSeqApply } from '../sync/serverSeq';
import type { ActionEnvelope } from './types';
import type { ChatUri } from '../protocol/resourceUri';

function freezeTurns(turns: readonly ChatTurn[]): readonly ChatTurn[] {
  return Object.freeze([...turns]);
}

export function createChatState(resource: ChatUri): ChatState {
  return Object.freeze({ resource, turns: freezeTurns([]), lastServerSeq: 0 });
}

function updateTurn(state: ChatState, turnId: ChatTurn['id'], update: (turn: ChatTurn) => ChatTurn): ChatState {
  let changed = false;
  const turns = state.turns.map((turn) => {
    if (turn.id !== turnId) return turn;
    changed = true;
    return Object.freeze(update(turn));
  });
  return changed ? Object.freeze({ ...state, turns: freezeTurns(turns) }) : state;
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'chat/turnStarted': {
      if (state.turns.some((turn) => turn.id === action.turnId)) return state;
      const turn: ChatTurn = Object.freeze({
        id: action.turnId,
        prompt: action.prompt,
        text: '',
        status: 'running',
        startedAt: action.timestamp,
      });
      return Object.freeze({
        ...state,
        turns: freezeTurns([...state.turns, turn]),
        activeTurnId: action.turnId,
        lastUpdatedAt: action.timestamp,
      });
    }
    case 'chat/textDelta': {
      const next = updateTurn(state, action.turnId, (turn) => ({ ...turn, text: `${turn.text}${action.delta}` }));
      return next === state ? state : Object.freeze({ ...next, lastUpdatedAt: action.timestamp });
    }
    case 'chat/turnCompleted': {
      const next = updateTurn(state, action.turnId, (turn) => ({
        ...turn,
        status: 'completed',
        completedAt: action.timestamp,
      }));
      return next === state
        ? state
        : Object.freeze({ ...next, activeTurnId: next.activeTurnId === action.turnId ? undefined : next.activeTurnId, lastUpdatedAt: action.timestamp });
    }
    case 'chat/turnFailed': {
      const next = updateTurn(state, action.turnId, (turn) => ({
        ...turn,
        status: 'failed',
        error: action.error,
        completedAt: action.timestamp,
      }));
      return next === state
        ? state
        : Object.freeze({ ...next, activeTurnId: next.activeTurnId === action.turnId ? undefined : next.activeTurnId, lastUpdatedAt: action.timestamp });
    }
  }
}

export function applyChatEnvelope(
  state: ChatState,
  envelope: ActionEnvelope<ChatAction, ChatUri>,
): ChatState {
  if (envelope.channel !== state.resource || !decideServerSeqApply(state.lastServerSeq, envelope.serverSeq).apply) {
    return state;
  }
  const reduced = chatReducer(state, envelope.action);
  return reduced === state
    ? Object.freeze({ ...state, lastServerSeq: envelope.serverSeq })
    : Object.freeze({ ...reduced, lastServerSeq: envelope.serverSeq });
}
