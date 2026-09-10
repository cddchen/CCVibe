import type { HostRootCatalogState } from '../../protocol/hostWire';
import type { WorkspaceSortPreference } from '../../domain/types';

export type { WorkspaceSortPreference } from '../../domain/types';

export type HomeMode = 'loading' | 'disconnected' | 'ready' | 'no-workspace' | 'no-model' | 'error';

export interface HomeSelectorError {
  readonly code: string;
  readonly message?: string;
  readonly operation?: 'create' | 'subscribe' | 'send' | 'workspace' | 'refresh' | 'preference';
}

export interface HomeSelectorInput {
  readonly phase: 'loading' | 'ready' | 'unconfigured' | 'error';
  readonly syncStatus: string;
  readonly catalog: HostRootCatalogState | undefined;
  readonly selectedWorkspaceId: string | undefined;
  readonly selectedModelId: string | undefined;
  readonly workspaceSortPreference: WorkspaceSortPreference;
  readonly operationError: HomeSelectorError | undefined;
}

export interface HomeWorkspaceItem {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly available: boolean;
}

export interface HomeModelItem {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly supportedEffortLevels: readonly ('low' | 'medium' | 'high' | 'xhigh' | 'max')[];
}

export interface HomePermissionModeItem {
  readonly id: NonNullable<HostRootCatalogState['permissionModes']>[number]['id'];
  readonly displayName: string;
  readonly description: string;
}

export type HomeSessionStatus = 'idle' | 'running' | 'waiting' | 'error';

export interface HomeSessionItem {
  readonly id: string;
  readonly chatUri: HostRootCatalogState['sessions'][number]['chatUri'];
  readonly title: string;
  readonly updatedAt: string;
  readonly status: HomeSessionStatus;
}

export interface HomeSessionGroup {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly sessions: readonly HomeSessionItem[];
}

export interface HomeViewModel {
  readonly mode: HomeMode;
  readonly hostName: string | undefined;
  readonly hostStatus: 'online' | 'degraded' | 'offline' | 'connecting';
  readonly hostStatusLabel: string;
  readonly workspaces: readonly HomeWorkspaceItem[];
  readonly models: readonly HomeModelItem[];
  readonly selectedWorkspaceId: string | undefined;
  readonly selectedModelId: string | undefined;
  readonly selectedWorkspaceName: string | undefined;
  readonly selectedModelName: string | undefined;
  readonly workspaceSortPreference: WorkspaceSortPreference;
  readonly permissionModes: readonly HomePermissionModeItem[];
  readonly defaultPermissionMode: HostRootCatalogState['defaultPermissionMode'] | undefined;
  readonly groups: readonly HomeSessionGroup[];
  readonly operationError: HomeSelectorError | undefined;
}

export function selectHomeViewModel(input: HomeSelectorInput): HomeViewModel {
  const catalog = input.catalog;
  const mode = resolveMode(input, catalog);
  const workspaces = catalog?.workspaces.map((workspace) => Object.freeze({
    id: workspace.id,
    name: workspace.displayName,
    path: workspace.path,
    available: workspace.status === 'available',
  })) ?? [];
  const models = catalog?.models.map((model) => Object.freeze({
    id: model.id,
    displayName: model.displayName,
    ...(model.description === undefined ? {} : { description: model.description }),
    supportedEffortLevels: Object.freeze([...(model.supportedEffortLevels ?? [])]),
  })) ?? [];
  const selectedWorkspace = workspaces.find((workspace) => workspace.available && workspace.id === input.selectedWorkspaceId)
    ?? workspaces.find((workspace) => workspace.available);
  const selectedModel = models.find((model) => model.id === input.selectedModelId)
    ?? models.find((model) => model.id === catalog?.defaultModelId)
    ?? models[0];
  const hostStatus = resolveHostStatus(input, catalog);

  return Object.freeze({
    mode,
    hostName: catalog?.host.displayName,
    hostStatus,
    hostStatusLabel: hostStatusLabel(hostStatus),
    workspaces: Object.freeze(workspaces),
    models: Object.freeze(models),
    selectedWorkspaceId: selectedWorkspace?.id,
    selectedModelId: selectedModel?.id,
    selectedWorkspaceName: selectedWorkspace?.name,
    selectedModelName: selectedModel?.displayName,
    permissionModes: Object.freeze((catalog?.permissionModes ?? []).map((mode) => Object.freeze({ ...mode }))),
    defaultPermissionMode: catalog?.defaultPermissionMode,
    workspaceSortPreference: input.workspaceSortPreference,
    groups: groupSessions(catalog, input.workspaceSortPreference),
    operationError: input.operationError,
  });
}

function resolveMode(input: HomeSelectorInput, catalog: HostRootCatalogState | undefined): HomeMode {
  if (input.phase === 'loading') return 'loading';
  if (input.phase === 'error') return 'error';
  if (catalog === undefined) {
    return input.syncStatus === 'paused' || input.syncStatus === 'error' || input.syncStatus === 'replaced'
      ? 'disconnected'
      : 'loading';
  }
  if (catalog.workspaces.every((workspace) => workspace.status !== 'available')) return 'no-workspace';
  if (catalog.models.length === 0) return 'no-model';
  return 'ready';
}

function resolveHostStatus(
  input: HomeSelectorInput,
  catalog: HostRootCatalogState | undefined,
): HomeViewModel['hostStatus'] {
  if (input.syncStatus === 'connecting' || input.syncStatus === 'reconnecting') return 'connecting';
  if (catalog?.connection.displayStatus === 'online') return 'online';
  if (catalog?.connection.displayStatus === 'degraded') return 'degraded';
  return 'offline';
}

function hostStatusLabel(status: HomeViewModel['hostStatus']): string {
  switch (status) {
    case 'online': return '已连接';
    case 'degraded': return '连接不稳定';
    case 'connecting': return '连接中';
    case 'offline': return '未连接';
  }
}

function groupSessions(
  catalog: HostRootCatalogState | undefined,
  workspaceSortPreference: WorkspaceSortPreference,
): readonly HomeSessionGroup[] {
  if (catalog === undefined) return Object.freeze([]);
  const workspaceNames = new Map(catalog.workspaces.map((workspace) => [workspace.id, workspace.displayName]));
  const grouped = new Map<string, { readonly workspaceName: string; readonly sessions: HomeSessionItem[] }>();

  for (const session of catalog.sessions) {
    if (session.archived) continue;
    const item: HomeSessionItem = Object.freeze({
      id: session.chatUri,
      chatUri: session.chatUri,
      title: session.title,
      updatedAt: session.updatedAt,
      status: mapSessionStatus(session.status),
    });
    const current = grouped.get(session.workspaceId);
    if (current === undefined) {
      grouped.set(session.workspaceId, {
        workspaceName: workspaceNames.get(session.workspaceId) ?? session.workspaceId,
        sessions: [item],
      });
    } else {
      current.sessions.push(item);
    }
  }

  const groups = [...grouped.entries()].map(([workspaceId, group]) => {
    const sessions = [...group.sessions].sort(compareSessions);
    return {
      workspaceId,
      workspaceName: group.workspaceName,
      sessions: Object.freeze(sessions),
      latestUpdatedAt: sessions[0]?.updatedAt,
    };
  });

  groups.sort((left, right) => {
    if (workspaceSortPreference === 'recent_workspace') {
      const recent = compareOptionalText(right.latestUpdatedAt, left.latestUpdatedAt);
      if (recent !== 0) return recent;
    }
    return left.workspaceName.localeCompare(right.workspaceName) || left.workspaceId.localeCompare(right.workspaceId);
  });

  return Object.freeze(groups.map(({ workspaceId, workspaceName, sessions }) => Object.freeze({
    workspaceId,
    workspaceName,
    sessions,
  })));
}

function compareSessions(left: HomeSessionItem, right: HomeSessionItem): number {
  return right.updatedAt.localeCompare(left.updatedAt)
    || left.title.localeCompare(right.title)
    || left.id.localeCompare(right.id);
}

function compareOptionalText(left: string | undefined, right: string | undefined): number {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return -1;
  if (right === undefined) return 1;
  return left.localeCompare(right);
}

function mapSessionStatus(status: HostRootCatalogState['sessions'][number]['status']): HomeSessionStatus {
  switch (status) {
    case 'in_progress': return 'running';
    case 'input_needed': return 'waiting';
    case 'error': return 'error';
    case 'idle': return 'idle';
  }
}
