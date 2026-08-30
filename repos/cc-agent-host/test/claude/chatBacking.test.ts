import { describe, expect, it } from 'vitest';

import {
  createChatBacking,
  createChatUri,
  markChatBackingMaterialized,
  updateChatBackingConfig,
  type ClaudeRuntimeConfig,
} from '../../src/index.js';

const chatUri = createChatUri('host-session', 'chat-one');
const config: ClaudeRuntimeConfig = {
  model: 'claude-sonnet',
  permissionMode: 'default',
  effort: 'high',
};

function input(overrides: Record<string, unknown> = {}) {
  return {
    chatUri,
    sdkSessionId: 'sdk-session-opaque',
    cwd: '/workspace/project/../project/',
    additionalDirectories: [
      '/workspace/project',
      '/workspace/shared/../shared',
      '/workspace/shared',
      '/workspace/extra/',
    ],
    desiredConfig: config,
    ...overrides,
  };
}

describe('ChatBacking', () => {
  it('keeps explicit SDK identity and normalizes paths with defensive copies', () => {
    const sourceDirectories = ['/workspace/project', '/workspace/shared/../shared'];
    const sourceConfig = { ...config };
    const backing = createChatBacking(input({
      additionalDirectories: sourceDirectories,
      desiredConfig: sourceConfig,
    }));

    expect(backing).toMatchObject({
      chatUri,
      sdkSessionId: 'sdk-session-opaque',
      cwd: '/workspace/project',
      additionalDirectories: ['/workspace/shared'],
      desiredConfig: sourceConfig,
      lifecycle: 'provisional',
    });
    expect(backing.additionalDirectories).not.toBe(sourceDirectories);
    expect(backing.desiredConfig).not.toBe(sourceConfig);

    sourceDirectories.push('/workspace/new');
    sourceConfig.model = 'mutated';
    expect(backing.additionalDirectories).toEqual(['/workspace/shared']);
    expect(backing.desiredConfig.model).toBe('claude-sonnet');
  });

  it('returns immutable transition snapshots without mutating the original', () => {
    const provisional = createChatBacking(input());
    const materialized = markChatBackingMaterialized(provisional);
    const updated = updateChatBackingConfig(materialized, {
      permissionMode: 'plan',
    });

    expect(provisional.lifecycle).toBe('provisional');
    expect(materialized.lifecycle).toBe('materialized');
    expect(updated.lifecycle).toBe('materialized');
    expect(updated.desiredConfig).toEqual({ permissionMode: 'plan' });
    expect(Object.isFrozen(provisional)).toBe(true);
    expect(Object.isFrozen(provisional.additionalDirectories)).toBe(true);
    expect(Object.isFrozen(provisional.desiredConfig)).toBe(true);
    expect(() => markChatBackingMaterialized(materialized)).toThrow(TypeError);
  });

  it.each([
    ['invalid URI', { chatUri: 'agent-chat://session-only' }],
    ['empty SDK id', { sdkSessionId: '  ' }],
    ['relative cwd', { cwd: 'workspace/project' }],
    ['relative additional directory', { additionalDirectories: ['/absolute', 'relative'] }],
  ])('rejects %s', (_name, overrides) => {
    expect(() => createChatBacking(input(overrides))).toThrow();
  });

  it('rejects a caller-forged lifecycle on creation and forged lifecycle values on transitions', () => {
    expect(() => createChatBacking({
      ...input(),
      lifecycle: 'materialized',
    } as never)).toThrow(TypeError);
    expect(() => markChatBackingMaterialized({
      ...input(),
      lifecycle: 'forged',
    } as never)).toThrow(TypeError);
  });
});
