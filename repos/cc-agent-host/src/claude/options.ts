import { isAbsolute, normalize, parse, sep } from 'node:path';

import type {
  CanUseTool,
  EffortLevel,
  McpServerConfig,
  OnElicitation,
  Options,
  PermissionMode,
  SdkPluginConfig,
  Settings,
} from '@anthropic-ai/claude-agent-sdk';

export interface ClaudeSessionStart {
  readonly kind: 'new';
  readonly sessionId: string;
}

export interface ClaudeSessionResume {
  readonly kind: 'resume';
  readonly sessionId: string;
  readonly resumeSessionAt?: string;
}

export type ClaudeSession = ClaudeSessionStart | ClaudeSessionResume;

export interface BuildClaudeOptionsInput {
  readonly cwd: string;
  readonly additionalDirectories?: readonly string[];
  readonly abortController: AbortController;
  readonly session: ClaudeSession;
  readonly model?: string;
  readonly effort?: EffortLevel;
  readonly permissionMode: PermissionMode;
  readonly canUseTool: CanUseTool;
  readonly onElicitation?: OnElicitation;
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
  readonly plugins?: readonly SdkPluginConfig[];
  readonly hooks?: Options['hooks'];
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly agent?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly settings?: Settings;
  readonly stderr?: NonNullable<Options['stderr']>;
}

const DEFAULT_DISALLOWED_TOOLS = ['WebSearch'] as const;
const SETTING_SOURCES = ['user', 'project', 'local'] as const;

export function buildClaudeOptions(input: BuildClaudeOptionsInput): Options {
  const cwd = normalizeAbsolutePath(input.cwd, 'cwd');
  const additionalDirectories = normalizeAdditionalDirectories(
    input.additionalDirectories,
    cwd,
  );
  const session = validateSession(input.session);
  const allowedTools = copyNonEmptyArray(input.allowedTools);
  const disallowedTools = dedupe([
    ...DEFAULT_DISALLOWED_TOOLS,
    ...(input.disallowedTools ?? []),
  ]);
  const plugins = copyPlugins(input.plugins);
  const mcpServers = copyNonEmptyRecord(input.mcpServers);
  const hooks = copyHooks(input.hooks);
  const settings = copyNonEmptySettings(input.settings);
  const env = copyNonEmptyRecord(input.env);

  const options = {
    abortController: input.abortController,
    cwd,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: [...SETTING_SOURCES],
    includePartialMessages: true,
    forwardSubagentText: true,
    enableFileCheckpointing: true,
    allowDangerouslySkipPermissions: true,
    permissionMode: input.permissionMode,
    canUseTool: input.canUseTool,
    disallowedTools,
    ...(session.kind === 'new'
      ? { sessionId: session.sessionId }
      : {
          resume: session.sessionId,
          ...(session.resumeSessionAt === undefined
            ? {}
            : { resumeSessionAt: session.resumeSessionAt }),
        }),
    ...(additionalDirectories === undefined ? {} : { additionalDirectories }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.effort === undefined ? {} : { effort: input.effort }),
    ...(input.onElicitation === undefined ? {} : { onElicitation: input.onElicitation }),
    ...(allowedTools === undefined ? {} : { allowedTools }),
    ...(plugins === undefined ? {} : { plugins }),
    ...(mcpServers === undefined ? {} : { mcpServers }),
    ...(hooks === undefined ? {} : { hooks }),
    ...(input.agent === undefined ? {} : { agent: input.agent }),
    ...(settings === undefined ? {} : { settings }),
    ...(env === undefined ? {} : { env }),
    ...(input.stderr === undefined ? {} : { stderr: input.stderr }),
  } satisfies Options;

  return options;
}

function validateSession(session: ClaudeSession): ClaudeSession {
  if (!isRecord(session)) {
    throw new TypeError('session must be an object');
  }
  if (session.kind !== 'new' && session.kind !== 'resume') {
    throw new TypeError("session.kind must be 'new' or 'resume'");
  }
  if (typeof session.sessionId !== 'string' || session.sessionId.length === 0) {
    throw new TypeError('session.sessionId must be a non-empty string');
  }

  if (session.kind === 'new') {
    if (Object.hasOwn(session, 'resumeSessionAt')) {
      throw new TypeError('resumeSessionAt is only valid for resumed sessions');
    }
    return { kind: 'new', sessionId: session.sessionId };
  }

  if (
    session.resumeSessionAt !== undefined
    && typeof session.resumeSessionAt !== 'string'
  ) {
    throw new TypeError('session.resumeSessionAt must be a string when provided');
  }

  return session.resumeSessionAt === undefined
    ? { kind: 'resume', sessionId: session.sessionId }
    : {
        kind: 'resume',
        sessionId: session.sessionId,
        resumeSessionAt: session.resumeSessionAt,
      };
}

function normalizeAdditionalDirectories(
  directories: readonly string[] | undefined,
  cwd: string,
): string[] | undefined {
  if (directories === undefined || directories.length === 0) {
    return undefined;
  }

  const result: string[] = [];
  const seen = new Set<string>([cwd]);
  for (const [index, directory] of directories.entries()) {
    const normalized = normalizeAbsolutePath(
      directory,
      `additionalDirectories[${String(index)}]`,
    );
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result.length === 0 ? undefined : result;
}

function normalizeAbsolutePath(value: string, name: string): string {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute path`);
  }
  const normalized = normalize(value);
  const root = parse(normalized).root;
  return normalized === root ? normalized : normalized.replace(new RegExp(`${escapeRegExp(sep)}+$`), '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function copyNonEmptyArray<T>(values: readonly T[] | undefined): T[] | undefined {
  return values === undefined || values.length === 0 ? undefined : [...values];
}

function copyPlugins(
  plugins: readonly SdkPluginConfig[] | undefined,
): SdkPluginConfig[] | undefined {
  return plugins === undefined || plugins.length === 0
    ? undefined
    : plugins.map((plugin) => ({ ...plugin }));
}

function copyHooks(hooks: Options['hooks']): Options['hooks'] {
  if (hooks === undefined) {
    return undefined;
  }

  const copied: NonNullable<Options['hooks']> = {};
  for (const [event, matchers] of Object.entries(hooks)) {
    if (matchers === undefined || matchers.length === 0) {
      continue;
    }
    copied[event as keyof NonNullable<Options['hooks']>] = matchers.map((matcher) => ({
      ...matcher,
      hooks: [...matcher.hooks],
    }));
  }
  return Object.keys(copied).length === 0 ? undefined : copied;
}

function copyNonEmptyRecord<T>(
  record: Readonly<Record<string, T>> | undefined,
): Record<string, T> | undefined {
  return record === undefined || Object.keys(record).length === 0
    ? undefined
    : { ...record };
}

function copyNonEmptySettings(settings: Settings | undefined): Settings | undefined {
  if (settings === undefined || Object.keys(settings).length === 0) {
    return undefined;
  }
  return copyPlainContainers(settings);
}

function copyPlainContainers<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => copyPlainContainers(item)) as T;
  }
  if (!isPlainRecord(value)) {
    return value;
  }

  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    copy[key] = copyPlainContainers(item);
  }
  return copy as T;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}
