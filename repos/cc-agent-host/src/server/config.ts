import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import {
  createModel,
  createWorkspace,
  type CatalogModel,
  type CatalogWorkspace,
} from '../catalog/types.js';
import { createBearerToken, type BearerToken } from '../security/identity.js';
import { parseModelId, type ModelId } from '../domain/ids.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const DEFAULT_HOST_EPOCH = 'local-development';

const workspaceInputSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  displayName: z.string().min(1),
  status: z.enum(['available', 'unavailable']).optional(),
}).strict();

const modelInputSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().min(1).optional(),
  capabilities: z.array(z.enum([
    'effort',
    'adaptive-thinking',
    'fast-mode',
    'auto-mode',
  ])).optional(),
}).strict();

const workspaceInputsSchema = z.array(workspaceInputSchema);
const modelInputsSchema = z.array(modelInputSchema);

export type AgentHostEnvironment = 'development' | 'production' | 'test';

export interface AgentHostConfigParseOptions {
  /** Injected by the CLI so host epochs change when a process restarts. */
  readonly defaultHostEpoch?: string;
}

/**
 * Validated, SDK-free configuration used by the runnable server entry point.
 * The bearer token is retained only so the startup adapter can close over it;
 * callers must use safeConfigSummary instead of serializing this value.
 */
export interface AgentHostServerConfig {
  readonly environment: AgentHostEnvironment;
  readonly host: string;
  readonly port: number;
  readonly hostEpoch: string;
  readonly bearerToken?: BearerToken;
  readonly requireAuthentication: boolean;
  readonly allowAnonymousDev: boolean;
  readonly allowedWorkspaces: readonly CatalogWorkspace[];
  readonly models: readonly CatalogModel[];
  readonly defaultModelId?: ModelId;
}

export class ConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

/**
 * Parse process-style environment values without reading process state or
 * performing I/O. All error messages name a configuration key and never echo
 * a supplied value, which keeps secrets out of startup logs.
 */
export function parseAgentHostConfig(
  environment: Readonly<Record<string, string | undefined>>,
  options: AgentHostConfigParseOptions = {},
): AgentHostServerConfig {
  const mode = parseEnvironment(environment.CCVIBE_ENV ?? environment.NODE_ENV);
  const host = parseHost(environment.CCVIBE_HOST);
  const port = parsePort(environment.CCVIBE_PORT);
  const hostEpoch = parseOpaqueText(
    environment.CCVIBE_HOST_EPOCH ?? options.defaultHostEpoch ?? DEFAULT_HOST_EPOCH,
    'CCVIBE_HOST_EPOCH',
  );
  const allowAnonymousDev = parseBoolean(
    environment.CCVIBE_ALLOW_ANONYMOUS_DEV,
    'CCVIBE_ALLOW_ANONYMOUS_DEV',
  );
  const allowPublicDev = parseBoolean(
    environment.CCVIBE_ALLOW_PUBLIC_DEV,
    'CCVIBE_ALLOW_PUBLIC_DEV',
  );

  if (allowAnonymousDev && mode !== 'development' && mode !== 'test') {
    throw configurationError('CCVIBE_ALLOW_ANONYMOUS_DEV is only valid in development');
  }
  if (allowPublicDev && mode !== 'development' && mode !== 'test') {
    throw configurationError('CCVIBE_ALLOW_PUBLIC_DEV is only valid in development');
  }
  if (isPublicBind(host) && mode !== 'production' && !allowPublicDev) {
    throw configurationError(
      'public development binding requires CCVIBE_ALLOW_PUBLIC_DEV=true',
    );
  }

  const bearerToken = parseBearerToken(environment.CCVIBE_BEARER_TOKEN);
  if (bearerToken === undefined && !allowAnonymousDev) {
    throw configurationError(
      'CCVIBE_BEARER_TOKEN is required unless explicit development anonymous mode is enabled',
    );
  }
  if (mode === 'production' && bearerToken === undefined) {
    throw configurationError('CCVIBE_BEARER_TOKEN is required in production');
  }

  const allowedWorkspaces = parseWorkspaces(
    readAliasedEnvironment(
      environment,
      'CCVIBE_ALLOWED_WORKSPACES_JSON',
      'CCVIBE_WORKSPACES_JSON',
    ),
  );
  const models = parseModels(
    readAliasedEnvironment(
      environment,
      'CCVIBE_MODEL_CATALOG_JSON',
      'CCVIBE_MODELS_JSON',
    ),
  );
  if (mode === 'production' && allowedWorkspaces.length === 0) {
    throw configurationError('CCVIBE_ALLOWED_WORKSPACES_JSON must contain a workspace in production');
  }
  if (mode === 'production' && models.length === 0) {
    throw configurationError('CCVIBE_MODEL_CATALOG_JSON must contain a model in production');
  }

  const defaultModelId = parseDefaultModelId(
    environment.CCVIBE_DEFAULT_MODEL_ID,
    models,
  );

  return Object.freeze({
    environment: mode,
    host,
    port,
    hostEpoch,
    ...(bearerToken === undefined ? {} : { bearerToken }),
    requireAuthentication: bearerToken !== undefined,
    allowAnonymousDev,
    allowedWorkspaces: Object.freeze([...allowedWorkspaces]),
    models: Object.freeze([...models]),
    ...(defaultModelId === undefined ? {} : { defaultModelId }),
  });
}

/** Load configuration for the real process, generating a fresh epoch if needed. */
export function loadAgentHostConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AgentHostServerConfig {
  return parseAgentHostConfig(environment, { defaultHostEpoch: randomUUID() });
}

/** A deliberately token-free summary suitable for stdout, logs, and telemetry. */
export function safeConfigSummary(config: AgentHostServerConfig): string {
  return [
    `mode=${config.environment}`,
    `bind=${formatHostPort(config.host, config.port)}`,
    `hostEpoch=${config.hostEpoch}`,
    `auth=${config.requireAuthentication ? 'bearer' : 'anonymous-development-only'}`,
    `workspaces=${config.allowedWorkspaces.length}`,
    `models=${config.models.length}`,
  ].join(' ');
}

export function formatHostPort(host: string, port: number): string {
  return host.includes(':') && !host.startsWith('[')
    ? `[${host}]:${port}`
    : `${host}:${port}`;
}

function parseEnvironment(value: string | undefined): AgentHostEnvironment {
  const normalized = value?.trim() || 'development';
  if (normalized === 'development' || normalized === 'production' || normalized === 'test') {
    return normalized;
  }
  throw configurationError('CCVIBE_ENV must be development, production, or test');
}

function parseHost(value: string | undefined): string {
  const host = value?.trim() || DEFAULT_HOST;
  if (
    host.length === 0
    || host.length > 253
    || /[\u0000-\u001f\u007f\s/?#]/u.test(host)
  ) {
    throw configurationError('CCVIBE_HOST must be a valid host name or IP address');
  }
  return host;
}

function parsePort(value: string | undefined): number {
  const normalized = value?.trim() || String(DEFAULT_PORT);
  if (!/^\d+$/u.test(normalized)) {
    throw configurationError('CCVIBE_PORT must be a decimal TCP port');
  }
  const port = Number(normalized);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw configurationError('CCVIBE_PORT must be between 1 and 65535');
  }
  return port;
}

function parseOpaqueText(value: string, key: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0
    || normalized === '.'
    || normalized === '..'
    || /[^\p{L}\p{N}._:-]/u.test(normalized)
    || new TextEncoder().encode(normalized).byteLength > 256
  ) {
    throw configurationError(`${key} must be a short opaque identifier`);
  }
  return normalized;
}

function parseBoolean(value: string | undefined, key: string): boolean {
  if (value === undefined || value.trim() === '') {
    return false;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw configurationError(`${key} must be true or false`);
}

function parseBearerToken(value: string | undefined): BearerToken | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return createBearerToken(value);
  } catch {
    throw configurationError('CCVIBE_BEARER_TOKEN must be a valid opaque credential');
  }
}

function parseWorkspaces(value: string | undefined): readonly CatalogWorkspace[] {
  const inputs = parseJsonArray(value, 'CCVIBE_ALLOWED_WORKSPACES_JSON', workspaceInputsSchema);
  const workspaces: CatalogWorkspace[] = [];
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const input of inputs) {
    let workspace: CatalogWorkspace;
    try {
      workspace = createWorkspace({
        id: input.id,
        path: input.path,
        displayName: input.displayName,
        ...(input.status === undefined ? {} : { status: input.status }),
      });
    } catch {
      throw configurationError('CCVIBE_ALLOWED_WORKSPACES_JSON contains an invalid workspace');
    }
    if (ids.has(workspace.id)) {
      throw configurationError('CCVIBE_ALLOWED_WORKSPACES_JSON contains a duplicate workspace id');
    }
    if (paths.has(workspace.path)) {
      throw configurationError('CCVIBE_ALLOWED_WORKSPACES_JSON contains a duplicate workspace path');
    }
    ids.add(workspace.id);
    paths.add(workspace.path);
    workspaces.push(workspace);
  }
  return Object.freeze(workspaces);
}

function parseModels(value: string | undefined): readonly CatalogModel[] {
  const inputs = parseJsonArray(value, 'CCVIBE_MODEL_CATALOG_JSON', modelInputsSchema);
  const models: CatalogModel[] = [];
  const ids = new Set<string>();
  for (const input of inputs) {
    let model: CatalogModel;
    try {
      model = createModel({
        id: input.id,
        displayName: input.displayName,
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
      });
    } catch {
      throw configurationError('CCVIBE_MODEL_CATALOG_JSON contains an invalid model');
    }
    if (ids.has(model.id)) {
      throw configurationError('CCVIBE_MODEL_CATALOG_JSON contains a duplicate model id');
    }
    ids.add(model.id);
    models.push(model);
  }
  return Object.freeze(models);
}

function parseDefaultModelId(
  value: string | undefined,
  models: readonly CatalogModel[],
): ModelId | undefined {
  const firstModel = models[0];
  if (value === undefined || value.trim() === '') {
    return firstModel?.id;
  }
  const normalized = value.trim();
  if (firstModel === undefined || !models.some((model) => model.id === normalized)) {
    throw configurationError('CCVIBE_DEFAULT_MODEL_ID must identify a model in the catalog');
  }
  try {
    return parseModelId(normalized);
  } catch {
    throw configurationError('CCVIBE_DEFAULT_MODEL_ID must identify a model in the catalog');
  }
}

function parseJsonArray<T>(
  value: string | undefined,
  key: string,
  schema: z.ZodType<T>,
): T {
  if (value === undefined || value.trim() === '') {
    return [] as T;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(value) as unknown;
  } catch {
    throw configurationError(`${key} must be valid JSON`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw configurationError(`${key} contains invalid catalog entries`);
  }
  return parsed.data;
}

function readAliasedEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  canonical: string,
  alias: string,
): string | undefined {
  const value = environment[canonical];
  const aliasValue = environment[alias];
  if (value !== undefined && aliasValue !== undefined && value !== aliasValue) {
    throw configurationError(`${canonical} and ${alias} must not disagree`);
  }
  return value ?? aliasValue;
}

function isPublicBind(host: string): boolean {
  return host === '0.0.0.0' || host === '::' || host === '[::]';
}

function configurationError(message: string): ConfigurationError {
  return new ConfigurationError(message);
}
