import { isAbsolute, normalize, parse as parsePath } from 'node:path';

import type { ChatStatus } from '../domain/chat.js';
import {
  createRootUri,
  parseChatUri,
  parseModelId,
  parseRootUri,
  parseWorkspaceId,
  type ChatUri,
  type ModelId,
  type RootUri,
  type WorkspaceId,
} from '../domain/index.js';

export type CatalogConnectionStatus = 'connected' | 'degraded' | 'disconnected';
export type CatalogDisplayStatus = 'online' | 'degraded' | 'offline';
export type CatalogWorkspaceStatus = 'available' | 'unavailable';
export type CatalogModelCapability =
  | 'effort'
  | 'adaptive-thinking'
  | 'fast-mode'
  | 'auto-mode';

/** Effort values exposed by the Claude Agent SDK. */
export type CatalogEffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type CatalogPermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';

export interface CatalogPermissionModeOption {
  readonly id: CatalogPermissionMode;
  readonly displayName: string;
  readonly description: string;
}

export interface CatalogHostIdentity {
  readonly id: string;
  readonly displayName: string;
}

export interface CatalogConnectionState {
  readonly status: CatalogConnectionStatus;
  readonly displayStatus: CatalogDisplayStatus;
}

export interface CatalogWorkspace {
  readonly id: WorkspaceId;
  readonly path: string;
  readonly displayName: string;
  readonly status: CatalogWorkspaceStatus;
}

export interface CatalogModel {
  readonly id: ModelId;
  readonly displayName: string;
  readonly description?: string;
  readonly capabilities: readonly CatalogModelCapability[];
  readonly supportedEffortLevels?: readonly CatalogEffortLevel[];
}

/**
 * Untrusted session configuration observed at a host boundary.
 *
 * SDK transcripts and persisted overlays can contain provider-specific model
 * ids or values from a newer SDK.  Keep this input deliberately wider than
 * the catalog-owned output so callers must resolve it before publishing a
 * session.
 */
export interface CatalogSessionConfigurationInput {
  readonly modelId?: unknown;
  readonly effort?: unknown;
}

/** Configuration after it has been resolved against the real model catalog. */
export interface CatalogSessionConfiguration {
  readonly modelId?: ModelId;
  readonly effort?: CatalogEffortLevel;
}

export interface CatalogSession {
  readonly chatUri: ChatUri;
  /** Opaque backing reference; the protocol never exposes SDK objects. */
  readonly sdkSessionRef: string;
  readonly workspaceId: WorkspaceId;
  readonly title: string;
  readonly updatedAt: string;
  readonly status: ChatStatus;
  readonly archived: boolean;
  /** The model selected for this session, when the SDK/transcript exposes it. */
  readonly modelId?: ModelId;
  /** The effort selected for this session, when known from the host overlay. */
  readonly effort?: CatalogEffortLevel;
  readonly permissionMode?: CatalogPermissionMode;
}

export interface RootCatalogState {
  readonly resource: RootUri;
  readonly host: CatalogHostIdentity;
  readonly connection: CatalogConnectionState;
  readonly workspaces: readonly CatalogWorkspace[];
  readonly sessions: readonly CatalogSession[];
  readonly models: readonly CatalogModel[];
  readonly permissionModes: readonly CatalogPermissionModeOption[];
  readonly defaultPermissionMode: CatalogPermissionMode;
  readonly defaultModelId?: ModelId;
  readonly modifiedAt: string;
}

export interface RootCatalogStateInput {
  readonly resource?: RootUri;
  readonly host: CatalogHostIdentity;
  readonly connection?: CatalogConnectionState;
  readonly workspaces?: readonly CatalogWorkspace[];
  readonly sessions?: readonly CatalogSession[];
  readonly models?: readonly CatalogModel[];
  readonly defaultModelId?: ModelId;
  readonly modifiedAt: string;
}

export interface CatalogWorkspaceInput {
  readonly id: WorkspaceId | string;
  readonly path: string;
  readonly displayName: string;
  readonly status?: CatalogWorkspaceStatus;
}

export interface CatalogModelInput {
  readonly id: ModelId | string;
  readonly displayName: string;
  readonly description?: string;
  readonly capabilities?: readonly CatalogModelCapability[];
  readonly supportedEffortLevels?: readonly CatalogEffortLevel[];
}

export function createWorkspace(input: CatalogWorkspaceInput): CatalogWorkspace {
  const id = parseWorkspaceId(String(input.id));
  const path = normalizeAbsolutePath(input.path, 'workspace.path');
  const displayName = requiredText(input.displayName, 'workspace.displayName');
  const status = input.status ?? 'available';
  if (status !== 'available' && status !== 'unavailable') {
    throw new TypeError('workspace.status is invalid');
  }
  return freezeWorkspace({ id, path, displayName, status });
}

export function createModel(input: CatalogModelInput): CatalogModel {
  const id = parseModelId(String(input.id));
  const displayName = requiredText(input.displayName, 'model.displayName');
  const description = input.description === undefined
    ? undefined
    : requiredText(input.description, 'model.description');
  const capabilities = uniqueCapabilities(input.capabilities ?? []);
  const supportedEffortLevels = input.supportedEffortLevels === undefined
    ? undefined
    : uniqueEffortLevels(input.supportedEffortLevels);
  return freezeModel({
    id,
    displayName,
    ...(description === undefined ? {} : { description }),
    capabilities,
    ...(supportedEffortLevels === undefined ? {} : { supportedEffortLevels }),
  });
}

/**
 * Resolve an observed session configuration to values the public catalog can
 * actually represent.
 *
 * Model ids are matched only against real catalog entries.  Unknown, malformed
 * or absent ids use the declared default when it is present in that catalog,
 * otherwise the first real model.  There is intentionally no opaque-id
 * fallback: leaking a provider id here makes the client unable to render a
 * selectable model. Effort is retained only when it is a known level and the
 * selected model advertises the effort capability. When the SDK provides an
 * explicit supported-level list, the value must also be present in that list;
 * no new/default level is invented by the host.
 */
export function normalizeCatalogSessionConfiguration(
  input: CatalogSessionConfigurationInput,
  models: readonly CatalogModel[],
  defaultModelId?: ModelId,
): CatalogSessionConfiguration {
  const observedModelId = input.modelId;
  const requestedModelId = typeof observedModelId === 'string'
    ? models.find((model) => model.id === observedModelId.trim())?.id
    : undefined;
  const declaredDefaultModelId = defaultModelId === undefined
    ? undefined
    : models.find((model) => model.id === defaultModelId)?.id;
  const modelId = requestedModelId ?? declaredDefaultModelId ?? models[0]?.id;
  const model = modelId === undefined
    ? undefined
    : models.find((candidate) => candidate.id === modelId);
  const effort = isCatalogEffortLevel(input.effort)
    && model !== undefined
    && isCatalogEffortSupported(model, input.effort)
    ? input.effort
    : undefined;

  return {
    ...(modelId === undefined ? {} : { modelId }),
    ...(effort === undefined ? {} : { effort }),
  };
}

export function createCatalogSession(input: CatalogSession): CatalogSession {
  const chatUri = parseChatUri(String(input.chatUri));
  const sdkSessionRef = requiredText(input.sdkSessionRef, 'session.sdkSessionRef');
  const workspaceId = parseWorkspaceId(String(input.workspaceId));
  const title = requiredText(input.title, 'session.title');
  const updatedAt = requiredText(input.updatedAt, 'session.updatedAt');
  if (!isChatStatus(input.status)) {
    throw new TypeError('session.status is invalid');
  }
  if (typeof input.archived !== 'boolean') {
    throw new TypeError('session.archived must be a boolean');
  }
  const modelId = input.modelId === undefined ? undefined : parseModelId(String(input.modelId));
  const effort = input.effort === undefined ? undefined : parseEffortLevel(input.effort);
  const permissionMode = input.permissionMode === undefined ? undefined : parsePermissionMode(input.permissionMode);
  return freezeSession({
    chatUri,
    sdkSessionRef,
    workspaceId,
    title,
    updatedAt,
    status: input.status,
    archived: input.archived,
    ...(modelId === undefined ? {} : { modelId }),
    ...(effort === undefined ? {} : { effort }),
    ...(permissionMode === undefined ? {} : { permissionMode }),
  });
}

export function createRootCatalogState(input: RootCatalogStateInput): RootCatalogState {
  const resource = input.resource === undefined ? createRootUri() : parseRootUri(String(input.resource));
  const host = freezeHost(input.host);
  const connection = freezeConnection(input.connection ?? {
    status: 'connected',
    displayStatus: 'online',
  });
  const workspaces = Object.freeze((input.workspaces ?? []).map((workspace) => createWorkspace(workspace)));
  const models = Object.freeze((input.models ?? []).map((model) => createModel(model)));
  const requestedDefaultModelId = input.defaultModelId === undefined
    ? undefined
    : parseModelId(String(input.defaultModelId));
  const defaultModelId = models.find((model) => model.id === requestedDefaultModelId)?.id
    ?? models[0]?.id;
  const parsedSessions = (input.sessions ?? []).map((session) => createCatalogSession(session));
  const sessions = Object.freeze(models.length === 0
    ? parsedSessions
    : parsedSessions.map((session) => normalizeSessionForModels(session, models, defaultModelId)));
  const modifiedAt = requiredText(input.modifiedAt, 'catalog.modifiedAt');
  const permissionModes = DEFAULT_PERMISSION_MODE_OPTIONS;
  return Object.freeze({
    resource,
    host,
    connection,
    workspaces,
    sessions,
    models,
    permissionModes,
    defaultPermissionMode: 'default',
    ...(defaultModelId === undefined ? {} : { defaultModelId }),
    modifiedAt,
  });
}

function normalizeSessionForModels(
  session: CatalogSession,
  models: readonly CatalogModel[],
  defaultModelId?: ModelId,
): CatalogSession {
  const configuration = normalizeCatalogSessionConfiguration(session, models, defaultModelId);
  const { modelId: _modelId, effort: _effort, ...withoutConfiguration } = session;
  return createCatalogSession({ ...withoutConfiguration, ...configuration });
}

export const DEFAULT_PERMISSION_MODE_OPTIONS: readonly CatalogPermissionModeOption[] = Object.freeze([
  Object.freeze({ id: 'default', displayName: '每次询问', description: '按 Claude Agent SDK 的默认规则，在需要时申请权限。' }),
  Object.freeze({ id: 'acceptEdits', displayName: '自动接受编辑', description: '自动允许文件编辑，其他敏感操作仍按规则处理。' }),
  Object.freeze({ id: 'plan', displayName: '规划模式', description: '只分析和制定计划，不执行修改型工具。' }),
  Object.freeze({ id: 'dontAsk', displayName: '不询问', description: '不弹出权限申请；未预先允许的操作会被拒绝。' }),
  Object.freeze({ id: 'auto', displayName: '自动判断', description: '由 Claude 的权限分类器判断允许或拒绝。' }),
  Object.freeze({ id: 'bypassPermissions', displayName: '跳过权限检查', description: '允许所有工具调用；仅在可信环境中使用。' }),
]);

export function cloneCatalogState(state: RootCatalogState): RootCatalogState {
  return createRootCatalogState(state);
}

function freezeHost(input: CatalogHostIdentity): CatalogHostIdentity {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError('catalog.host must be an object');
  }
  return Object.freeze({
    id: requiredText(input.id, 'host.id'),
    displayName: requiredText(input.displayName, 'host.displayName'),
  });
}

function freezeConnection(input: CatalogConnectionState): CatalogConnectionState {
  if (
    input.status !== 'connected'
    && input.status !== 'degraded'
    && input.status !== 'disconnected'
  ) {
    throw new TypeError('catalog.connection.status is invalid');
  }
  if (
    input.displayStatus !== 'online'
    && input.displayStatus !== 'degraded'
    && input.displayStatus !== 'offline'
  ) {
    throw new TypeError('catalog.connection.displayStatus is invalid');
  }
  return Object.freeze({ status: input.status, displayStatus: input.displayStatus });
}

function freezeWorkspace(input: CatalogWorkspace): CatalogWorkspace {
  return Object.freeze({ ...input });
}

function freezeModel(input: CatalogModel): CatalogModel {
  return Object.freeze({
    ...input,
    capabilities: Object.freeze([...input.capabilities]),
    ...(input.supportedEffortLevels === undefined
      ? {}
      : { supportedEffortLevels: Object.freeze([...input.supportedEffortLevels]) }),
  });
}

function uniqueEffortLevels(values: readonly CatalogEffortLevel[]): readonly CatalogEffortLevel[] {
  const result: CatalogEffortLevel[] = [];
  for (const value of values) {
    const parsed = parseEffortLevel(value);
    if (!result.includes(parsed)) result.push(parsed);
  }
  return Object.freeze(result);
}

function freezeSession(input: CatalogSession): CatalogSession {
  return Object.freeze({ ...input });
}

function uniqueCapabilities(
  capabilities: readonly CatalogModelCapability[],
): readonly CatalogModelCapability[] {
  const seen = new Set<CatalogModelCapability>();
  const result: CatalogModelCapability[] = [];
  for (const capability of capabilities) {
    if (!isCatalogModelCapability(capability)) {
      throw new TypeError('model.capabilities contains an invalid value');
    }
    if (!seen.has(capability)) {
      seen.add(capability);
      result.push(capability);
    }
  }
  return Object.freeze(result);
}

function isCatalogModelCapability(value: unknown): value is CatalogModelCapability {
  return value === 'effort'
    || value === 'adaptive-thinking'
    || value === 'fast-mode'
    || value === 'auto-mode';
}

function isChatStatus(value: unknown): value is ChatStatus {
  return value === 'idle' || value === 'in_progress' || value === 'input_needed' || value === 'error';
}

function parseEffortLevel(value: unknown): CatalogEffortLevel {
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max') {
    return value;
  }
  throw new TypeError('session.effort is invalid');
}

function isCatalogEffortLevel(value: unknown): value is CatalogEffortLevel {
  return value === 'low'
    || value === 'medium'
    || value === 'high'
    || value === 'xhigh'
    || value === 'max';
}

function isCatalogEffortSupported(model: CatalogModel, effort: CatalogEffortLevel): boolean {
  // The capability flag is the coarse SDK truth. A model without it cannot
  // publish an effort value even when a stale overlay happens to contain one.
  if (!model.capabilities.includes('effort')) {
    return false;
  }
  // When present, the level list is the SDK's authoritative thinking-level
  // detail. An omitted list means no additional level was asserted here; the
  // host preserves only the already-observed known value.
  return model.supportedEffortLevels === undefined
    || model.supportedEffortLevels.includes(effort);
}

function parsePermissionMode(value: unknown): CatalogPermissionMode {
  if (value === 'default' || value === 'acceptEdits' || value === 'bypassPermissions'
    || value === 'plan' || value === 'dontAsk' || value === 'auto') return value;
  throw new TypeError('session.permissionMode is invalid');
}

function normalizeAbsolutePath(value: string, label: string): string {
  if (typeof value !== 'string' || value.includes('\0') || !isAbsolute(value)) {
    throw new TypeError(`${label} must be an absolute path`);
  }
  const normalized = normalize(value);
  const root = parsePath(normalized).root;
  return normalized === root ? normalized : normalized.replace(/[\\/]+$/u, '');
}

function requiredText(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}
