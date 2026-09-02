import { parseChatUri } from '../domain/resources.js';
import type { ChatUri, RootUri } from '../domain/ids.js';
import {
  createCatalogSession,
  createModel,
  createRootCatalogState,
  createWorkspace,
  normalizeCatalogSessionConfiguration,
  type CatalogModel,
  type CatalogSession,
  type CatalogWorkspace,
  type RootCatalogState,
} from './types.js';

export const CATALOG_ACTION_TYPES = {
  hostUpdated: 'catalog/hostUpdated',
  workspaceUpserted: 'catalog/workspaceUpserted',
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
      readonly type: typeof CATALOG_ACTION_TYPES.workspaceUpserted;
      readonly workspace: CatalogWorkspace;
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
    case CATALOG_ACTION_TYPES.workspaceUpserted:
      return upsertWorkspace(state, action.workspace, timestamp);
    case CATALOG_ACTION_TYPES.workspacesReplaced: {
      const workspaces = action.workspaces.map((workspace) => createWorkspace(workspace));
      if (sameArray(state.workspaces, workspaces, sameWorkspace)) {
        return state;
      }
      return createRootCatalogState({ ...state, workspaces, modifiedAt: timestamp });
    }
    case CATALOG_ACTION_TYPES.modelsReplaced: {
      const models = action.models.map((model) => createModel(model));
      const requestedDefaultModelId = action.defaultModelId ?? state.defaultModelId;
      const defaultModelId = models.find((model) => model.id === requestedDefaultModelId)?.id
        ?? models[0]?.id;
      if (
        sameArray(state.models, models, sameModel)
        && state.defaultModelId === defaultModelId
      ) {
        return state;
      }
      const next = createRootCatalogState({
        ...state,
        models,
        ...(defaultModelId === undefined ? {} : { defaultModelId }),
        modifiedAt: timestamp,
      });
      return normalizeCatalogSessions(next, timestamp);
    }
    case CATALOG_ACTION_TYPES.sessionsReplaced: {
      const sessions = action.sessions.map((session) => normalizeCatalogSession(state, session));
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

function upsertWorkspace(
  state: RootCatalogState,
  workspaceInput: CatalogWorkspace,
  timestamp: string,
): RootCatalogState {
  const workspace = createWorkspace(workspaceInput);
  const index = state.workspaces.findIndex((candidate) => candidate.id === workspace.id);
  if (index < 0) {
    return createRootCatalogState({
      ...state,
      workspaces: [...state.workspaces, workspace],
      modifiedAt: timestamp,
    });
  }
  const current = state.workspaces[index];
  if (current !== undefined && sameWorkspace(current, workspace)) {
    return state;
  }
  const workspaces = [...state.workspaces];
  workspaces[index] = workspace;
  return createRootCatalogState({ ...state, workspaces, modifiedAt: timestamp });
}

function upsertSession(
  state: RootCatalogState,
  sessionInput: CatalogSession,
  timestamp: string,
): RootCatalogState {
  const session = normalizeCatalogSession(state, sessionInput);
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

function normalizeCatalogSession(
  state: RootCatalogState,
  sessionInput: CatalogSession,
): CatalogSession {
  const session = createCatalogSession(sessionInput);
  // A reducer state with no model catalog has no authority to reinterpret a
  // session's selected configuration.  Refresh/publish supplies the real
  // catalog before sessions are normalized; until then retain the existing
  // state rather than inventing a missing model or deleting user metadata.
  if (state.models.length === 0) {
    return session;
  }
  const configuration = normalizeCatalogSessionConfiguration(
    session,
    state.models,
    state.defaultModelId,
  );
  const { modelId: _modelId, effort: _effort, ...withoutConfiguration } = session;
  return createCatalogSession({ ...withoutConfiguration, ...configuration });
}

function normalizeCatalogSessions(
  state: RootCatalogState,
  timestamp: string,
): RootCatalogState {
  const sessions = state.sessions.map((session) => normalizeCatalogSession(state, session));
  if (sameArray(state.sessions, sessions, sameSession)) {
    return state;
  }
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
    && sameStringArray(left.capabilities, right.capabilities)
    && sameOptionalStringArray(left.supportedEffortLevels, right.supportedEffortLevels);
}

function sameSession(left: CatalogSession, right: CatalogSession): boolean {
  return left.chatUri === right.chatUri
    && left.sdkSessionRef === right.sdkSessionRef
    && left.workspaceId === right.workspaceId
    && left.title === right.title
    && left.updatedAt === right.updatedAt
    && left.status === right.status
    && left.archived === right.archived
    && left.modelId === right.modelId
    && left.effort === right.effort
    && left.permissionMode === right.permissionMode;
}

function sameOptionalStringArray(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  return left === undefined || right === undefined ? left === right : sameStringArray(left, right);
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
