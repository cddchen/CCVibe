import { createHash } from 'node:crypto';
import { basename, isAbsolute, normalize, parse as parsePath } from 'node:path';

import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk';

import type { ClaudeAgentSdkService } from './claudeAgentSdkService.js';
import {
  createCatalogSession,
  createModel,
  createWorkspace,
  type CatalogModelInput,
  type CatalogModel,
  type CatalogSession,
  type CatalogWorkspace,
  type CatalogWorkspaceInput,
} from '../catalog/types.js';
import { createWorkspaceId } from '../domain/ids.js';
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

/** The SDK fields used to build the protocol-owned model catalog. */
export type CatalogSdkModelInfo = Pick<
  ModelInfo,
  | 'value'
  | 'resolvedModel'
  | 'displayName'
  | 'description'
  | 'supportsEffort'
  | 'supportsAdaptiveThinking'
  | 'supportsFastMode'
  | 'supportsAutoMode'
>;

/**
 * Derive stable workspaces from SDK sessions. Claude's session index is the
 * only discovery source available to the host, so a directory with no saved
 * session is intentionally absent from this result.
 */
export function projectCatalogWorkspaces(
  sdkSessions: CatalogListSessionsResult,
): readonly CatalogWorkspace[] {
  const workspaces: CatalogWorkspace[] = [];
  const paths = new Set<string>();
  for (const session of sdkSessions) {
    const cwd = session.cwd;
    if (cwd === undefined || !isAbsolute(cwd)) {
      continue;
    }
    const normalized = normalize(cwd);
    const root = parsePath(normalized).root;
    const path = normalized === root ? normalized : normalized.replace(/[\\/]+$/u, '');
    if (paths.has(path)) {
      continue;
    }
    paths.add(path);
    workspaces.push({
      ...createCatalogWorkspace(path),
    });
  }
  return Object.freeze(workspaces);
}

/** Project SDK model metadata into the deliberately small wire catalog shape. */
export function projectCatalogModels(
  sdkModels: readonly CatalogSdkModelInfo[],
): readonly CatalogModel[] {
  const models: CatalogModel[] = [];
  const ids = new Set<string>();
  for (const sdkModel of sdkModels) {
    // Invalid SDK rows should not make the entire host catalog unavailable.
    // The SDK normally guarantees these fields, but this boundary also keeps
    // accidental metadata/shape changes out of the protocol.
    if (
      typeof sdkModel.value !== 'string'
      || sdkModel.value.trim().length === 0
      || typeof sdkModel.displayName !== 'string'
      || sdkModel.displayName.trim().length === 0
      || ids.has(sdkModel.value)
    ) {
      continue;
    }

    const capabilities = [
      ...(sdkModel.supportsEffort === true ? ['effort' as const] : []),
      ...(sdkModel.supportsAdaptiveThinking === true ? ['adaptive-thinking' as const] : []),
      ...(sdkModel.supportsFastMode === true ? ['fast-mode' as const] : []),
      ...(sdkModel.supportsAutoMode === true ? ['auto-mode' as const] : []),
    ];
    try {
      const description = typeof sdkModel.description === 'string'
        && sdkModel.description.trim().length > 0
        ? sdkModel.description.trim()
        : undefined;
      const model = createModel({
        id: sdkModel.value,
        displayName: sdkModel.displayName.trim(),
        ...(description === undefined ? {} : { description }),
        capabilities,
      });
      ids.add(sdkModel.value);
      models.push(model);
    } catch {
      // The SDK model value must be a valid opaque protocol id. Ignore a row
      // that cannot be represented rather than leaking raw SDK details.
    }
  }
  return Object.freeze(models);
}

/** Project typed SDK session metadata into the protocol-owned catalog shape. */
export function projectCatalogSessions(
  sdkSessions: CatalogListSessionsResult,
  workspaces: readonly CatalogWorkspace[],
  hostEpoch: string,
): readonly CatalogSession[] {
  const sessions: CatalogSession[] = [];
  const sessionIds = new Set<string>();
  for (const sdkSession of sdkSessions) {
    if (sessionIds.has(sdkSession.sessionId)) {
      continue;
    }
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
    sessionIds.add(sdkSession.sessionId);
  }
  return Object.freeze(sessions);
}

function createCatalogWorkspace(path: string): CatalogWorkspace {
  const displayName = basename(path) || path;
  const digest = createHash('sha256').update(path, 'utf8').digest('hex').slice(0, 32);
  return {
    ...createWorkspace({
      id: createWorkspaceId(`workspace-${digest}`),
      path,
      displayName,
    }),
  };
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
