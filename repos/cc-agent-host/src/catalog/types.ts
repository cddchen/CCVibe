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
}

export interface RootCatalogState {
  readonly resource: RootUri;
  readonly host: CatalogHostIdentity;
  readonly connection: CatalogConnectionState;
  readonly workspaces: readonly CatalogWorkspace[];
  readonly sessions: readonly CatalogSession[];
  readonly models: readonly CatalogModel[];
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
  return freezeModel({
    id,
    displayName,
    ...(description === undefined ? {} : { description }),
    capabilities,
  });
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
  return freezeSession({
    chatUri,
    sdkSessionRef,
    workspaceId,
    title,
    updatedAt,
    status: input.status,
    archived: input.archived,
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
  const sessions = Object.freeze((input.sessions ?? []).map((session) => createCatalogSession(session)));
  const defaultModelId = input.defaultModelId === undefined
    ? undefined
    : parseModelId(String(input.defaultModelId));
  const modifiedAt = requiredText(input.modifiedAt, 'catalog.modifiedAt');
  return Object.freeze({
    resource,
    host,
    connection,
    workspaces,
    sessions,
    models,
    ...(defaultModelId === undefined ? {} : { defaultModelId }),
    modifiedAt,
  });
}

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
  return Object.freeze({ ...input, capabilities: Object.freeze([...input.capabilities]) });
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
