import type {
  CanUseTool,
  McpServerConfig,
  OnElicitation,
  Options,
  SdkPluginConfig,
  Settings,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  buildClaudeOptions,
  type BuildClaudeOptionsInput,
} from '../../src/claude/options.js';

const canUseTool = Object.create(null) as CanUseTool;

function baseInput(
  session: BuildClaudeOptionsInput['session'] = { kind: 'new', sessionId: 'new-session' },
): BuildClaudeOptionsInput {
  return {
    cwd: '/workspace/project',
    abortController: new AbortController(),
    session,
    permissionMode: 'default',
    canUseTool,
  };
}

describe('buildClaudeOptions session projection', () => {
  it('sets the load-bearing Claude Code harness options for a new session', () => {
    const abortController = new AbortController();
    const input: BuildClaudeOptionsInput = {
      ...baseInput(),
      abortController,
      model: 'claude-sonnet',
      effort: 'high',
      permissionMode: 'acceptEdits',
      agent: 'main-agent',
    };

    const options = buildClaudeOptions(input);

    expectTypeOf(options).toEqualTypeOf<Options>();
    expect(options).toMatchObject({
      abortController,
      cwd: '/workspace/project',
      sessionId: 'new-session',
      model: 'claude-sonnet',
      effort: 'high',
      permissionMode: 'acceptEdits',
      agent: 'main-agent',
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
      includePartialMessages: true,
      forwardSubagentText: true,
      enableFileCheckpointing: true,
      allowDangerouslySkipPermissions: true,
      disallowedTools: ['WebSearch'],
    });
    expect(options.canUseTool).toBe(canUseTool);
    expect(options).not.toHaveProperty('resume');
    expect(options).not.toHaveProperty('resumeSessionAt');
  });

  it('uses only resume fields for a resumed session', () => {
    const options = buildClaudeOptions(baseInput({
      kind: 'resume',
      sessionId: 'resumed-session',
      resumeSessionAt: 'message-id',
    }));

    expect(options).toMatchObject({
      resume: 'resumed-session',
      resumeSessionAt: 'message-id',
    });
    expect(options).not.toHaveProperty('sessionId');
  });

  it.each([
    ['missing session', undefined],
    ['unknown kind', { kind: 'fork', sessionId: 'session' }],
    ['missing session id', { kind: 'new' }],
    ['empty session id', { kind: 'resume', sessionId: '' }],
    ['resume point on new session', { kind: 'new', sessionId: 'session', resumeSessionAt: 'message' }],
    ['invalid resume point', { kind: 'resume', sessionId: 'session', resumeSessionAt: 42 }],
  ])('rejects forged runtime session input: %s', (_name, session) => {
    const input = { ...baseInput(), session } as unknown as BuildClaudeOptionsInput;
    expect(() => buildClaudeOptions(input)).toThrow(TypeError);
  });
});

describe('buildClaudeOptions paths and optional values', () => {
  it('normalizes and deduplicates absolute additional directories and removes cwd', () => {
    const additionalDirectories = [
      '/workspace/project',
      '/workspace/other/../shared',
      '/workspace/shared',
      '/workspace/extra/',
    ];
    const input = {
      ...baseInput(),
      cwd: '/workspace/project/../project/',
      additionalDirectories,
    };

    const options = buildClaudeOptions(input);

    expect(options.cwd).toBe('/workspace/project');
    expect(options.additionalDirectories).toEqual([
      '/workspace/shared',
      '/workspace/extra',
    ]);
    expect(options.additionalDirectories).not.toBe(additionalDirectories);
  });

  it('rejects relative cwd and additional directory paths', () => {
    expect(() => buildClaudeOptions({ ...baseInput(), cwd: 'relative/project' })).toThrow(
      'cwd must be an absolute path',
    );
    expect(() => buildClaudeOptions({
      ...baseInput(),
      additionalDirectories: ['/absolute', 'relative'],
    })).toThrow('additionalDirectories[1] must be an absolute path');
  });

  it('omits absent and empty optional containers while retaining the WebSearch default', () => {
    const options = buildClaudeOptions({
      ...baseInput(),
      additionalDirectories: [],
      allowedTools: [],
      plugins: [],
      mcpServers: {},
      hooks: {},
      settings: {},
      env: {},
    });

    for (const key of [
      'additionalDirectories',
      'allowedTools',
      'plugins',
      'mcpServers',
      'hooks',
      'settings',
      'env',
      'model',
      'effort',
      'onElicitation',
      'agent',
      'stderr',
    ]) {
      expect(options).not.toHaveProperty(key);
    }
    expect(options.disallowedTools).toEqual(['WebSearch']);
  });

  it('merges and deduplicates caller disallowed tools after WebSearch', () => {
    const options = buildClaudeOptions({
      ...baseInput(),
      disallowedTools: ['Bash', 'WebSearch', 'Bash', 'Edit'],
    });

    expect(options.disallowedTools).toEqual(['WebSearch', 'Bash', 'Edit']);
  });
});

describe('buildClaudeOptions defensive projection', () => {
  it('copies mutable containers while preserving callbacks and the MCP SDK instance', () => {
    const onElicitation = Object.create(null) as OnElicitation;
    const stderr = (): void => undefined;
    const hook = Object.create(null) as NonNullable<NonNullable<Options['hooks']>['PreToolUse']>[number]['hooks'][number];
    const hooks: NonNullable<Options['hooks']> = {
      PreToolUse: [{ matcher: 'Bash', hooks: [hook] }],
    };
    const instance = Object.create(null);
    const sdkServer = {
      type: 'sdk',
      name: 'embedded',
      instance,
    } as McpServerConfig;
    const mcpServers: Record<string, McpServerConfig> = { embedded: sdkServer };
    const plugins: SdkPluginConfig[] = [{ type: 'local', path: '/plugin' }];
    const settings: Settings = {
      env: { FROM_SETTINGS: 'original' },
      policyHelper: { path: '/helper', timeoutMs: 100 },
    };
    const env: Record<string, string | undefined> = { TOKEN: 'original' };
    const allowedTools = ['Read'];

    const options = buildClaudeOptions({
      ...baseInput(),
      additionalDirectories: ['/workspace/shared'],
      allowedTools,
      plugins,
      mcpServers,
      hooks,
      settings,
      env,
      onElicitation,
      stderr,
    });

    expect(options.onElicitation).toBe(onElicitation);
    expect(options.stderr).toBe(stderr);
    expect(options.hooks?.PreToolUse?.[0]?.hooks[0]).toBe(hook);
    expect(options.mcpServers?.embedded).toBe(sdkServer);
    expect(options.mcpServers?.embedded).toMatchObject({ instance });

    allowedTools.push('Edit');
    plugins[0]!.path = '/mutated-plugin';
    mcpServers.replacement = { command: 'replacement' };
    hooks.PreToolUse!.push({ hooks: [] });
    hooks.PreToolUse![0]!.hooks.push(hook);
    settings.env!.FROM_SETTINGS = 'mutated';
    settings.policyHelper!.timeoutMs = 999;
    env.TOKEN = 'mutated';

    expect(options.allowedTools).toEqual(['Read']);
    expect(options.plugins).toEqual([{ type: 'local', path: '/plugin' }]);
    expect(options.mcpServers).toEqual({ embedded: sdkServer });
    expect(options.hooks?.PreToolUse).toHaveLength(1);
    expect(options.hooks?.PreToolUse?.[0]?.hooks).toEqual([hook]);
    expect((options.settings as Settings).env).toEqual({ FROM_SETTINGS: 'original' });
    expect((options.settings as Settings).policyHelper?.timeoutMs).toBe(100);
    expect(options.env).toEqual({ TOKEN: 'original' });
  });

  it('is deterministic and isolates an existing result from later input mutation', () => {
    const input = {
      ...baseInput({ kind: 'resume', sessionId: 'session' }),
      additionalDirectories: ['/workspace/shared', '/workspace/shared'],
      allowedTools: ['Read', 'Edit'],
      disallowedTools: ['Bash', 'WebSearch'],
      plugins: [{ type: 'local' as const, path: '/plugin' }],
      env: { FIXED: 'value' },
      settings: { env: { NESTED: 'value' } },
    } satisfies BuildClaudeOptionsInput;

    const first = buildClaudeOptions(input);
    const second = buildClaudeOptions(input);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);

    input.additionalDirectories[0] = '/workspace/mutated';
    input.allowedTools[0] = 'Bash';
    input.disallowedTools.push('Write');
    input.plugins[0]!.path = '/mutated';
    input.env.FIXED = 'mutated';
    input.settings.env!.NESTED = 'mutated';

    expect(first.additionalDirectories).toEqual(['/workspace/shared']);
    expect(first.allowedTools).toEqual(['Read', 'Edit']);
    expect(first.disallowedTools).toEqual(['WebSearch', 'Bash']);
    expect(first.plugins).toEqual([{ type: 'local', path: '/plugin' }]);
    expect(first.env).toEqual({ FIXED: 'value' });
    expect((first.settings as Settings).env).toEqual({ NESTED: 'value' });
  });
});
