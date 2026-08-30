import type {
  ActionEnvelope,
  ModelOption,
  RootCatalogState,
  SessionSummary,
  StateSnapshot,
  WorkspaceSummary,
} from './types';
import { decideServerSeqApply } from '../sync/serverSeq';
import { createRootUri, type RootUri } from '../protocol/resourceUri';

export type CatalogAction =
  | { readonly type: 'catalog/workspaceUpserted'; readonly workspace: WorkspaceSummary }
  | { readonly type: 'catalog/sessionUpserted'; readonly session: SessionSummary }
  | { readonly type: 'catalog/sessionRemoved'; readonly sessionId: string }
  | { readonly type: 'catalog/modelsReplaced'; readonly models: readonly ModelOption[]; readonly defaultModelId?: string };

export type CatalogActionEnvelope = ActionEnvelope<CatalogAction, RootUri>;
export type CatalogSnapshot = StateSnapshot<RootCatalogState, RootUri>;
export type CatalogSync =
  | {
      readonly type: 'replay';
      readonly actions: readonly CatalogActionEnvelope[];
      readonly throughSeq: number;
    }
  | {
      readonly type: 'snapshot';
      readonly snapshot: CatalogSnapshot;
      readonly throughSeq: number;
    };

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

export function createRootCatalogState(resource: RootUri = createRootUri()): RootCatalogState {
  return Object.freeze({
    resource,
    workspaces: freezeArray([]),
    sessions: freezeArray([]),
    models: freezeArray([]),
    lastServerSeq: 0,
  });
}

export function catalogReducer(state: RootCatalogState, envelope: CatalogActionEnvelope): RootCatalogState {
  if (envelope.channel !== state.resource || !decideServerSeqApply(state.lastServerSeq, envelope.serverSeq).apply) {
    return state;
  }

  const action = envelope.action;
  switch (action.type) {
    case 'catalog/workspaceUpserted': {
      const workspaces = state.workspaces.some((workspace) => workspace.id === action.workspace.id)
        ? state.workspaces.map((workspace) => workspace.id === action.workspace.id ? action.workspace : workspace)
        : [...state.workspaces, action.workspace];
      return Object.freeze({ ...state, workspaces: freezeArray(workspaces), lastServerSeq: envelope.serverSeq });
    }
    case 'catalog/sessionUpserted': {
      const sessions = state.sessions.some((session) => session.id === action.session.id)
        ? state.sessions.map((session) => session.id === action.session.id ? action.session : session)
        : [...state.sessions, action.session];
      return Object.freeze({ ...state, sessions: freezeArray(sessions), lastServerSeq: envelope.serverSeq });
    }
    case 'catalog/sessionRemoved': {
      const sessions = state.sessions.filter((session) => session.id !== action.sessionId);
      if (sessions.length === state.sessions.length) {
        return Object.freeze({ ...state, lastServerSeq: envelope.serverSeq });
      }
      return Object.freeze({ ...state, sessions: freezeArray(sessions), lastServerSeq: envelope.serverSeq });
    }
    case 'catalog/modelsReplaced':
      return Object.freeze({
        ...state,
        models: freezeArray(action.models),
        ...(action.defaultModelId === undefined ? { defaultModelId: undefined } : { defaultModelId: action.defaultModelId }),
        lastServerSeq: envelope.serverSeq,
      });
  }
}

export function applyCatalogSync(
  current: RootCatalogState,
  payload: CatalogSync,
): RootCatalogState {
  assertSyncCut(current.lastServerSeq, payload.throughSeq);

  if (payload.type === 'snapshot') {
    if (payload.snapshot.resource !== current.resource || payload.snapshot.state.resource !== current.resource) {
      throw new TypeError('catalog snapshot resource does not match current resource');
    }
    if (!Number.isSafeInteger(payload.snapshot.fromSeq) || payload.snapshot.fromSeq < 0) {
      throw new RangeError('catalog snapshot fromSeq must be a non-negative safe integer');
    }
    if (payload.snapshot.fromSeq > payload.throughSeq) {
      throw new RangeError('catalog snapshot fromSeq cannot exceed throughSeq');
    }
    return Object.freeze({ ...payload.snapshot.state, lastServerSeq: payload.throughSeq });
  }

  let next = current;
  for (const envelope of payload.actions) {
    if (envelope.serverSeq > payload.throughSeq) {
      throw new RangeError('catalog replay action cannot exceed throughSeq');
    }
    next = catalogReducer(next, envelope);
  }
  return next.lastServerSeq === payload.throughSeq
    ? next
    : Object.freeze({ ...next, lastServerSeq: payload.throughSeq });
}

function assertSyncCut(currentSeq: number, throughSeq: number): void {
  if (!Number.isSafeInteger(throughSeq) || throughSeq < 0) {
    throw new RangeError('catalog throughSeq must be a non-negative safe integer');
  }
  if (throughSeq < currentSeq) {
    throw new RangeError('catalog sync cut cannot move serverSeq backwards');
  }
}
