import { isAbsolute, normalize } from 'node:path';

import type { ClaudeAgentSdkService } from './claudeAgentSdkService.js';
import {
  createCatalogSession,
  type CatalogModelInput,
  type CatalogSession,
  type CatalogWorkspace,
  type CatalogWorkspaceInput,
} from '../catalog/types.js';
import { createChatUri } from '../domain/resources.js';

/** Deployment-owned workspace/model inputs used by an explicit catalog refresh. */
export interface CatalogSourceSnapshot {
  readonly workspaces?: readonly CatalogWorkspaceInput[];
  readonly models?: readonly CatalogModelInput[];
  readonly defaultModelId?: CatalogModelInput['id'];
}

/** SDK-free source port for deployment-owned catalog configuration. */
export interface CatalogSource {
  load(): CatalogSourceSnapshot | PromiseLike<CatalogSourceSnapshot>;
  /** Optional SDK-backed session listing override for explicit refreshes. */
  listSessions?: (
    ...args: CatalogListSessionsParameters
  ) => CatalogListSessionsResult | PromiseLike<CatalogListSessionsResult>;
}

/** The exact SDK facade call shape stays private to the Claude adapter layer. */
export type CatalogListSessionsParameters = Parameters<ClaudeAgentSdkService['listSessions']>;
export type CatalogListSessionsResult = Awaited<ReturnType<ClaudeAgentSdkService['listSessions']>>;
export type CatalogListSessionInfo = CatalogListSessionsResult[number];

/** Project typed SDK session metadata into the protocol-owned catalog shape. */
export function projectCatalogSessions(
  sdkSessions: CatalogListSessionsResult,
  workspaces: readonly CatalogWorkspace[],
  hostEpoch: string,
): readonly CatalogSession[] {
  const sessions: CatalogSession[] = [];
  for (const sdkSession of sdkSessions) {
    const workspace = findWorkspace(workspaces, sdkSession.cwd);
    const fallbackWorkspace = workspace === undefined && sdkSession.cwd === undefined && workspaces.length === 1
      ? workspaces[0]
      : undefined;
    const resolvedWorkspace = workspace ?? fallbackWorkspace;
    if (resolvedWorkspace === undefined) {
      continue;
    }
    if (!Number.isFinite(sdkSession.lastModified)) {
      throw new TypeError('SDK session lastModified must be finite');
    }
    const updatedAt = new Date(sdkSession.lastModified).toISOString();
    sessions.push(createCatalogSession({
      chatUri: createChatUri(hostEpoch, sdkSession.sessionId),
      sdkSessionRef: sdkSession.sessionId,
      workspaceId: resolvedWorkspace.id,
      title: sessionTitle(sdkSession),
      updatedAt,
      status: 'idle',
      archived: false,
    }));
  }
  return Object.freeze(sessions);
}

function findWorkspace(
  workspaces: readonly CatalogWorkspace[],
  cwd: string | undefined,
): CatalogWorkspace | undefined {
  if (cwd === undefined || !isAbsolute(cwd)) {
    return undefined;
  }
  const normalizedCwd = normalize(cwd);
  return workspaces.find((workspace) => workspace.path === normalizedCwd);
}

function sessionTitle(session: CatalogListSessionInfo): string {
  const candidates = [session.customTitle, session.summary, session.firstPrompt];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return 'Untitled chat';
}
