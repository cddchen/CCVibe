import { isAbsolute, normalize, parse, sep } from 'node:path';

import type { ChatUri } from '../domain/ids.js';
import { parseChatUri } from '../domain/resources.js';
import type { ClaudeRuntimeConfig } from './runtimeConfig.js';

export type ChatBackingLifecycle = 'provisional' | 'materialized';

/**
 * The stable host-to-Claude identity and the values needed to build a runtime.
 *
 * A backing is package-owned and immutable. In particular, the SDK session id
 * is stored explicitly; it is never inferred from the host chat URI.
 */
export interface ChatBacking {
  readonly chatUri: ChatUri;
  readonly sdkSessionId: string;
  readonly cwd: string;
  readonly additionalDirectories: readonly string[];
  readonly desiredConfig: ClaudeRuntimeConfig;
  readonly lifecycle: ChatBackingLifecycle;
}

export interface CreateChatBackingInput {
  readonly chatUri: ChatUri;
  readonly sdkSessionId: string;
  readonly cwd: string;
  readonly additionalDirectories?: readonly string[];
  readonly desiredConfig: ClaudeRuntimeConfig;
}

/** Create a validated, provisional backing without deriving any SDK identity. */
export function createChatBacking(input: CreateChatBackingInput): ChatBacking {
  assertRecord(input, 'input');
  if (Object.hasOwn(input, 'lifecycle')) {
    throw new TypeError('lifecycle is managed by chat backing transitions');
  }

  const chatUri = parseChatUriValue(input.chatUri);
  const sdkSessionId = validateSdkSessionId(input.sdkSessionId);
  const cwd = normalizeAbsolutePath(input.cwd, 'cwd');
  const additionalDirectories = normalizeAdditionalDirectories(
    input.additionalDirectories,
    cwd,
  );
  const desiredConfig = copyRuntimeConfig(input.desiredConfig);

  return freezeBacking({
    chatUri,
    sdkSessionId,
    cwd,
    additionalDirectories,
    desiredConfig,
    lifecycle: 'provisional',
  });
}

/** Promote a provisional backing after its runtime has materialized. */
export function markChatBackingMaterialized(backing: ChatBacking): ChatBacking {
  const normalized = validateBacking(backing);
  if (normalized.lifecycle !== 'provisional') {
    throw new TypeError('only a provisional backing can be materialized');
  }

  return freezeBacking({
    ...normalized,
    lifecycle: 'materialized',
  });
}

/** Return a new backing with a defensive snapshot of the desired config. */
export function updateChatBackingConfig(
  backing: ChatBacking,
  desiredConfig: ClaudeRuntimeConfig,
): ChatBacking {
  const normalized = validateBacking(backing);
  const copiedConfig = copyRuntimeConfig(desiredConfig);

  return freezeBacking({
    ...normalized,
    desiredConfig: copiedConfig,
  });
}

function validateBacking(backing: ChatBacking): ChatBacking {
  assertRecord(backing, 'backing');
  const chatUri = parseChatUriValue(backing.chatUri);
  const sdkSessionId = validateSdkSessionId(backing.sdkSessionId);
  const cwd = normalizeAbsolutePath(backing.cwd, 'cwd');
  const additionalDirectories = normalizeAdditionalDirectories(
    backing.additionalDirectories,
    cwd,
  );
  const desiredConfig = copyRuntimeConfig(backing.desiredConfig);

  if (backing.lifecycle !== 'provisional' && backing.lifecycle !== 'materialized') {
    throw new TypeError('backing.lifecycle must be provisional or materialized');
  }

  return freezeBacking({
    chatUri,
    sdkSessionId,
    cwd,
    additionalDirectories,
    desiredConfig,
    lifecycle: backing.lifecycle,
  });
}

function parseChatUriValue(value: ChatUri): ChatUri {
  if (typeof value !== 'string') {
    throw new TypeError('chatUri must be a valid chat URI');
  }
  return parseChatUri(value);
}

function validateSdkSessionId(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('sdkSessionId must be a non-empty string');
  }
  return value;
}

function normalizeAdditionalDirectories(
  directories: readonly string[] | undefined,
  cwd: string,
): readonly string[] {
  if (directories !== undefined && !Array.isArray(directories)) {
    throw new TypeError('additionalDirectories must be an array when provided');
  }

  const result: string[] = [];
  const seen = new Set<string>([cwd]);
  for (const [index, directory] of (directories ?? []).entries()) {
    const normalized = normalizeAbsolutePath(
      directory,
      `additionalDirectories[${String(index)}]`,
    );
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return Object.freeze(result);
}

function normalizeAbsolutePath(value: string, name: string): string {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute path`);
  }

  const normalized = normalize(value);
  const root = parse(normalized).root;
  return normalized === root
    ? normalized
    : normalized.replace(new RegExp(`${escapeRegExp(sep)}+$`), '');
}

function copyRuntimeConfig(config: ClaudeRuntimeConfig): ClaudeRuntimeConfig {
  assertRecord(config, 'desiredConfig');
  if (typeof config.permissionMode !== 'string' || config.permissionMode.trim().length === 0) {
    throw new TypeError('desiredConfig.permissionMode must be a non-empty string');
  }
  if (config.model !== undefined && typeof config.model !== 'string') {
    throw new TypeError('desiredConfig.model must be a string when provided');
  }
  if (config.effort !== undefined && typeof config.effort !== 'string') {
    throw new TypeError('desiredConfig.effort must be a string when provided');
  }

  return Object.freeze({
    permissionMode: config.permissionMode,
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(config.effort === undefined ? {} : { effort: config.effort }),
  });
}

function freezeBacking(backing: ChatBacking): ChatBacking {
  Object.freeze(backing.additionalDirectories);
  Object.freeze(backing.desiredConfig);
  return Object.freeze(backing);
}

function assertRecord(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
