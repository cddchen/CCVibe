import type { HostChatState, HostRootCatalogState } from '../protocol/hostWire';
import type { ChatUri, RootUri } from '../protocol/resourceUri';

export type WorkspaceAvailability = 'available' | 'unavailable';
export type SessionViewStatus = 'idle' | 'running' | 'waiting' | 'error';

export interface WorkspaceViewModel {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly status: WorkspaceAvailability;
}

export interface SessionViewModel {
  readonly id: string;
  readonly chatUri: ChatUri;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly status: SessionViewStatus;
  readonly archived: boolean;
}

export interface ModelViewModel {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly capabilities: readonly string[];
}

export interface RootCatalogViewModel {
  readonly resource: RootUri;
  readonly host: { readonly id: string; readonly displayName: string };
  readonly connection: { readonly status: string; readonly displayStatus: string };
  readonly workspaces: readonly WorkspaceViewModel[];
  readonly sessions: readonly SessionViewModel[];
  readonly models: readonly ModelViewModel[];
  readonly defaultModelId?: string;
  readonly lastServerSeq: number;
  readonly modifiedAt: string;
}

export interface ChatViewModel {
  readonly resource?: ChatUri;
  readonly status: HostChatState['status'];
  readonly turns: HostChatState['turns'];
  readonly activeTurn?: HostChatState['activeTurn'];
  readonly pendingApprovals: HostChatState['pendingApprovals'];
  readonly pendingInputs: HostChatState['pendingInputs'];
  readonly modifiedAt: string;
  readonly lastServerSeq: number;
}

export function projectRootCatalog(state: HostRootCatalogState, lastServerSeq: number): RootCatalogViewModel {
  const workspaceNames = new Map(state.workspaces.map((workspace) => [workspace.id, workspace.displayName]));
  return Object.freeze({
    resource: state.resource,
    host: Object.freeze({ ...state.host }),
    connection: Object.freeze({ ...state.connection }),
    workspaces: Object.freeze(state.workspaces.map((workspace) => Object.freeze({
      id: workspace.id,
      name: workspace.displayName,
      path: workspace.path,
      status: workspace.status,
    }))),
    sessions: Object.freeze(state.sessions.map((session) => Object.freeze({
      id: session.chatUri,
      chatUri: session.chatUri,
      workspaceId: session.workspaceId,
      workspaceName: workspaceNames.get(session.workspaceId) ?? session.workspaceId,
      title: session.title,
      updatedAt: session.updatedAt,
      status: projectSessionStatus(session.status),
      archived: session.archived,
    }))),
    models: Object.freeze(state.models.map((model) => Object.freeze({
      id: model.id,
      displayName: model.displayName,
      ...(model.description === undefined ? {} : { description: model.description }),
      capabilities: Object.freeze([...model.capabilities]),
    }))),
    ...(state.defaultModelId === undefined ? {} : { defaultModelId: state.defaultModelId }),
    lastServerSeq,
    modifiedAt: state.modifiedAt,
  });
}

export function projectChat(state: HostChatState, lastServerSeq: number): ChatViewModel {
  return Object.freeze({
    ...(state.resource === undefined ? {} : { resource: state.resource }),
    status: state.status,
    turns: state.turns,
    ...(state.activeTurn === undefined ? {} : { activeTurn: state.activeTurn }),
    pendingApprovals: state.pendingApprovals,
    pendingInputs: state.pendingInputs,
    modifiedAt: state.modifiedAt,
    lastServerSeq,
  });
}

function projectSessionStatus(status: HostRootCatalogState['sessions'][number]['status']): SessionViewStatus {
  switch (status) {
    case 'in_progress': return 'running';
    case 'input_needed': return 'waiting';
    case 'error': return 'error';
    case 'idle': return 'idle';
  }
}
