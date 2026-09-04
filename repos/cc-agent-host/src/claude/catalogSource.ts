import { createHash } from 'node:crypto';
import { basename, isAbsolute, normalize, parse as parsePath } from 'node:path';

import type { ModelInfo, SessionMessage } from '@anthropic-ai/claude-agent-sdk';

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
  type CatalogEffortLevel,
  normalizeCatalogSessionConfiguration,
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

/** Configuration observed while reading one SDK transcript. */
export interface CatalogSessionConfiguration {
  readonly modelId?: CatalogModel['id'];
  readonly effort?: CatalogEffortLevel;
}

/** The SDK fields used to build the protocol-owned model catalog. */
export type CatalogSdkModelInfo = Pick<
  ModelInfo,
  | 'value'
  | 'resolvedModel'
  | 'displayName'
  | 'description'
  | 'supportsEffort'
  | 'supportedEffortLevels'
  | 'supportsAdaptiveThinking'
  | 'supportsFastMode'
  | 'supportsAutoMode'
>;

/**
 * Host-private identity retained from the SDK model directory.
 *
 * The public catalog uses `ModelInfo.value` as its stable selectable id, while
 * SDK runtime/transcript messages can report `resolvedModel` instead. Keeping
 * this pair in the Claude adapter lets the Host canonicalize observations
 * without leaking provider-specific ids to clients.
 */
export interface CatalogSdkModelIdentity {
  readonly modelId: CatalogModel['id'];
  readonly resolvedModel?: string;
}

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
    const workspace = projectCatalogWorkspace(cwd);
    if (paths.has(workspace.path)) {
      continue;
    }
    paths.add(workspace.path);
    workspaces.push(workspace);
  }
  return Object.freeze(workspaces);
}

/**
 * Project one canonical/absolute filesystem path using the same stable ID
 * algorithm as SDK session discovery.
 *
 * The caller that owns filesystem access must resolve symlinks first. This
 * helper only normalizes the path representation and projects protocol data;
 * it never probes the filesystem.
 */
export function projectCatalogWorkspace(path: string): CatalogWorkspace {
  return createCatalogWorkspace(normalizeCatalogWorkspacePath(path));
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
      ...(sdkModel.supportsEffort === true
        || (sdkModel.supportedEffortLevels !== undefined && sdkModel.supportedEffortLevels.length > 0)
        ? ['effort' as const]
        : []),
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
        ...(sdkModel.supportedEffortLevels === undefined
          ? {}
          : { supportedEffortLevels: sdkModel.supportedEffortLevels }),
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

/** Retain only identities for SDK rows that survived public catalog projection. */
export function projectCatalogSdkModelIdentities(
  sdkModels: readonly CatalogSdkModelInfo[],
): readonly CatalogSdkModelIdentity[] {
  const projectedIds = new Set<string>(projectCatalogModels(sdkModels).map((model) => model.id));
  const identities: CatalogSdkModelIdentity[] = [];
  const seenIds = new Set<string>();
  for (const sdkModel of sdkModels) {
    if (
      typeof sdkModel.value !== 'string'
      || !projectedIds.has(sdkModel.value)
      || seenIds.has(sdkModel.value)
    ) {
      continue;
    }
    const resolvedModel = typeof sdkModel.resolvedModel === 'string'
      && sdkModel.resolvedModel.trim().length > 0
      ? sdkModel.resolvedModel.trim()
      : undefined;
    identities.push(Object.freeze({
      modelId: sdkModel.value as CatalogModel['id'],
      ...(resolvedModel === undefined ? {} : { resolvedModel }),
    }));
    seenIds.add(sdkModel.value);
  }
  return Object.freeze(identities);
}

/**
 * Resolve an SDK-observed model back to the public catalog id. The currently
 * selected id wins when aliases share one resolved provider model.
 */
export function resolveCatalogSdkModelId(
  observedModel: unknown,
  identities: readonly CatalogSdkModelIdentity[],
  preferredModelId?: string,
): unknown {
  if (typeof observedModel !== 'string' || observedModel.trim().length === 0) {
    return observedModel;
  }
  const observed = observedModel.trim();
  const exact = identities.find((identity) => identity.modelId === observed);
  if (exact !== undefined) {
    return exact.modelId;
  }
  const preferred = identities.find((identity) => (
    identity.modelId === preferredModelId
    && identity.resolvedModel === observed
  ));
  if (preferred !== undefined) {
    return preferred.modelId;
  }
  return identities.find((identity) => identity.resolvedModel === observed)?.modelId
    ?? observed;
}

/** Project typed SDK session metadata into the protocol-owned catalog shape. */
export function projectCatalogSessions(
  sdkSessions: CatalogListSessionsResult,
  workspaces: readonly CatalogWorkspace[],
  hostEpoch: string,
  configurations?: ReadonlyMap<string, CatalogSessionConfiguration>,
  models: readonly CatalogModel[] = [],
  defaultModelId?: CatalogModel['id'],
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
    const observedConfiguration = configurations?.get(sdkSession.sessionId);
    // Configuration values can originate in persisted overlays or an SDK
    // adapter, so never publish them without resolving against real catalog
    // entries. An empty catalog consequently removes unresolvable values.
    const configuration = normalizeCatalogSessionConfiguration(
      observedConfiguration ?? {},
      models,
      defaultModelId,
    );
    sessions.push(createCatalogSession({
      chatUri: createChatUri(hostEpoch, sdkSession.sessionId),
      sdkSessionRef: sdkSession.sessionId,
      workspaceId: resolvedWorkspace.id,
      title: sessionTitle(sdkSession),
      updatedAt,
      status: 'idle',
      archived: false,
      ...(configuration?.modelId === undefined ? {} : { modelId: configuration.modelId }),
      ...(configuration?.effort === undefined ? {} : { effort: configuration.effort }),
    }));
    sessionIds.add(sdkSession.sessionId);
  }
  return Object.freeze(sessions);
}

/**
 * Read the model emitted in an SDK assistant transcript message.
 *
 * SDKSessionInfo intentionally omits model and effort. Assistant messages do
 * retain their actual model. Newer SDK transcript shapes may expose an effort
 * or effortLevel field, so those values are accepted only after the same
 * catalog/model capability normalization as persisted host configuration.
 */
export function projectSessionConfiguration(
  messages: readonly SessionMessage[],
  models: readonly CatalogModel[] = [],
  defaultModelId?: CatalogModel['id'],
  identities: readonly CatalogSdkModelIdentity[] = [],
): CatalogSessionConfiguration {
  let rawModel: unknown;
  let rawEffort: unknown;
  let modelObserved = false;
  let effortObserved = false;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type !== 'assistant') {
      continue;
    }
    const envelope = asRecord(message?.message);
    if (envelope === undefined) {
      continue;
    }

    if (!modelObserved && typeof envelope.model === 'string' && envelope.model.trim().length > 0) {
      rawModel = envelope.model.trim();
      modelObserved = true;
    }

    if (!effortObserved) {
      if (Object.prototype.hasOwnProperty.call(envelope, 'effort')) {
        rawEffort = envelope.effort;
        effortObserved = true;
      } else if (Object.prototype.hasOwnProperty.call(envelope, 'effortLevel')) {
        rawEffort = envelope.effortLevel;
        effortObserved = true;
      }
    }

    if (modelObserved && effortObserved) {
      break;
    }
  }

  return normalizeCatalogSessionConfiguration(
    {
      modelId: resolveCatalogSdkModelId(rawModel, identities),
      effort: rawEffort,
    },
    models,
    defaultModelId,
  );
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

function normalizeCatalogWorkspacePath(value: string): string {
  if (typeof value !== 'string' || value.includes('\0') || !isAbsolute(value)) {
    throw new TypeError('workspace.path must be an absolute path');
  }
  const normalized = normalize(value);
  const root = parsePath(normalized).root;
  return normalized === root ? normalized : normalized.replace(/[\\/]+$/u, '');
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
