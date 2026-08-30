import type {
  EffortLevel,
  PermissionMode,
  Query,
} from '@anthropic-ai/claude-agent-sdk';

export type ClaudeRuntimeQuery = Pick<
  Query,
  'setModel' | 'setPermissionMode' | 'applyFlagSettings'
>;

export interface ClaudeRuntimeConfig {
  readonly model?: string;
  readonly permissionMode: PermissionMode;
  readonly effort?: EffortLevel;
}

export async function applyClaudeModel(
  query: ClaudeRuntimeQuery,
  model?: string,
): Promise<void> {
  await query.setModel(model);
}

export async function applyClaudePermissionMode(
  query: ClaudeRuntimeQuery,
  permissionMode: PermissionMode,
): Promise<void> {
  await query.setPermissionMode(permissionMode);
}

export async function applyClaudeEffort(
  query: ClaudeRuntimeQuery,
  effort?: EffortLevel,
): Promise<void> {
  await query.applyFlagSettings({ effortLevel: effort ?? null });
}

export async function applyClaudeRuntimeConfig(
  query: ClaudeRuntimeQuery,
  config: ClaudeRuntimeConfig,
): Promise<void> {
  await applyClaudeModel(query, config.model);
  await applyClaudePermissionMode(query, config.permissionMode);
  await applyClaudeEffort(query, config.effort);
}
