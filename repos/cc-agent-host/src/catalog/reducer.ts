import { parseChatUri } from '../domain/resources.js';
import type { ChatUri, RootUri } from '../domain/ids.js';
import {
  createCatalogSession,
  createModel,
  createRootCatalogState,
  createWorkspace,
  type CatalogModel,
  type CatalogSession,
  type CatalogWorkspace,
  type RootCatalogState,
} from './types.js';

export const CATALOG_ACTION_TYPES = {
  hostUpdated: 'catalog/hostUpdated',
  workspacesReplaced: 'catalog/workspacesReplaced',
  modelsReplaced: 'catalog/modelsReplaced',
  sessionsReplaced: 'catalog/sessionsReplaced',
  chatCreated: 'catalog/chatCreated',
  chatUpdated: 'catalog/chatUpdated',
  chatRemoved: 'catalog/chatRemoved',
} as const;

export type CatalogAction =
  | {
      readonly type: typeof CATALOG_ACTION_TYPES.hostUpdated;
      readonly host: RootCatalogState['host'];
      readonly connection: RootCatalogState['connection'];
      readonly timestamp: string;
    }
  | {
      readonly type: typeof CATALOG_ACTION_TYPES.workspacesReplaced;
      readonly workspaces: readonly CatalogWorkspace[];
      readonly timestamp: string;
    }
  | {
      readonly type: typeof CATALOG_ACTION_TYPES.modelsReplaced;
      readonly models: readonly CatalogModel[];
      readonly defaultModelId?: RootCatalogState['defaultModelId'];
      readonly timestamp: string;
    }
  | {
      readonly type: typeof CATALOG_ACTION_TYPES.sessionsReplaced;
      readonly sessions: readonly CatalogSession[];
      readonly timestamp: string;
    }
  | {
      readonly type: typeof CATALOG_ACTION_TYPES.chatCreated;
      readonly session: CatalogSession;
      readonly timestamp: string;
    }
  | {
      readonly type: typeof CATALOG_ACTION_TYPES.chatUpdated;
      readonly session: CatalogSession;
      readonly timestamp: string;
    }
  | {
      readonly type: typeof CATALOG_ACTION_TYPES.chatRemoved;
      readonly chatUri: ChatUri;
      readonly timestamp: string;
    };

export function catalogReducer(state: RootCatalogState, action: CatalogAction): RootCatalogState {
  const timestamp = requiredTimestamp(action.timestamp);
  switch (action.type) {
    case CATALOG_ACTION_TYPES.hostUpdated: {
      const next = createRootCatalogState({ ...state, host: action.host, connection: action.connection, modifiedAt: timestamp });
      return sameHostState(state, next) ? state : next;
    }
    case CATALOG_ACTION_TYPES.workspacesReplaced: {
      const workspaces = action.workspaces.map((workspace) => createWorkspace(workspace));
      if (sameArray(state.workspaces, workspaces, sameWorkspace)) {
        return state;
      }
      return createRootCatalogState({ ...state, workspaces, modifiedAt: timestamp });
    }
    case CATALOG_ACTION_TYPES.modelsReplaced: {
      const models = action.models.map((model) => createModel(model));
      const defaultModelId = action.defaultModelId;
      if (
        sameArray(state.models, models, sameModel)
        && state.defaultModelId === defaultModelId
      ) {
        return state;
      }
      return createRootCatalogState({
        ...state,
        models,
        ...(defaultModelId === undefined ? {} : { defaultModelId }),
        modifiedAt: timestamp,
      });
    }
    case CATALOG_ACTION_TYPES.sessionsReplaced: {
      const sessions = action.sessions.map((session) => createCatalogSession(session));
      if (sameArray(state.sessions, sessions, sameSession)) {
        return state;
      }
      return createRootCatalogState({ ...state, sessions, modifiedAt: timestamp });
    }
    case CATALOG_ACTION_TYPES.chatCreated:
      return upsertSession(state, action.session, timestamp);
    case CATALOG_ACTION_TYPES.chatUpdated:
      return upsertSession(state, action.session, timestamp);
    case CATALOG_ACTION_TYPES.chatRemoved: {
      const chatUri = parseChatUri(String(action.chatUri));
      const sessions = state.sessions.filter((session) => session.chatUri !== chatUri);
      if (sessions.length === state.sessions.length) {
        return state;
      }
      return createRootCatalogState({ ...state, sessions, modifiedAt: timestamp });
    }
  }
}

function upsertSession(
  state: RootCatalogState,
  sessionInput: CatalogSession,
  timestamp: string,
): RootCatalogState {
  const session = createCatalogSession(sessionInput);
  const index = state.sessions.findIndex((candidate) => candidate.chatUri === session.chatUri);
  if (index < 0) {
    return createRootCatalogState({
      ...state,
      sessions: [...state.sessions, session],
      modifiedAt: timestamp,
    });
  }
  const current = state.sessions[index];
  if (current !== undefined && sameSession(current, session)) {
    return state;
  }
  const sessions = [...state.sessions];
  sessions[index] = session;
  return createRootCatalogState({ ...state, sessions, modifiedAt: timestamp });
}

function sameHostState(left: RootCatalogState, right: RootCatalogState): boolean {
  return left.host.id === right.host.id
    && left.host.displayName === right.host.displayName
    && left.connection.status === right.connection.status
    && left.connection.displayStatus === right.connection.displayStatus;
}

function sameWorkspace(left: CatalogWorkspace, right: CatalogWorkspace): boolean {
  return left.id === right.id
    && left.path === right.path
    && left.displayName === right.displayName
    && left.status === right.status;
}

function sameModel(left: CatalogModel, right: CatalogModel): boolean {
  return left.id === right.id
    && left.displayName === right.displayName
    && left.description === right.description
    && sameStringArray(left.capabilities, right.capabilities);
}

function sameSession(left: CatalogSession, right: CatalogSession): boolean {
  return left.chatUri === right.chatUri
    && left.sdkSessionRef === right.sdkSessionRef
    && left.workspaceId === right.workspaceId
    && left.title === right.title
    && left.updatedAt === right.updatedAt
    && left.status === right.status
    && left.archived === right.archived;
}

function sameArray<T>(left: readonly T[], right: readonly T[], equal: (a: T, b: T) => boolean): boolean {
  return left.length === right.length && left.every((value, index) => {
    const other = right[index];
    return other !== undefined && equal(value, other);
  });
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return sameArray(left, right, (a, b) => a === b);
}

function requiredTimestamp(value: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('catalog action timestamp must be a non-empty string');
  }
  return value;
}

export type CatalogChannel = RootUri;
