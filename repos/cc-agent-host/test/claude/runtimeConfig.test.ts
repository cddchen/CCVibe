import type {
  EffortLevel,
  PermissionMode,
  Query,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  applyClaudeEffort,
  applyClaudeModel,
  applyClaudePermissionMode,
  applyClaudeRuntimeConfig,
  type ClaudeRuntimeQuery,
} from '../../src/claude/runtimeConfig.js';

type RuntimeCall =
  | ['setModel', Parameters<Query['setModel']>[0]]
  | ['setPermissionMode', Parameters<Query['setPermissionMode']>[0]]
  | ['applyFlagSettings', Parameters<Query['applyFlagSettings']>[0]];
type RuntimeStage = RuntimeCall[0];

type FakeQuery = {
  query: ClaudeRuntimeQuery;
  calls: RuntimeCall[];
  failure: Error;
};

function makeFakeQuery(failAt?: RuntimeStage): FakeQuery {
  const calls: RuntimeCall[] = [];
  const failure = new Error(`${failAt ?? 'no'} failure`);
  const maybeFail = (stage: RuntimeStage): void => {
    if (stage === failAt) {
      throw failure;
    }
  };

  const query: ClaudeRuntimeQuery = {
    setModel: async (model: Parameters<Query['setModel']>[0]): Promise<void> => {
      calls.push(['setModel', model]);
      maybeFail('setModel');
    },
    setPermissionMode: async (
      permissionMode: Parameters<Query['setPermissionMode']>[0],
    ): Promise<void> => {
      calls.push(['setPermissionMode', permissionMode]);
      maybeFail('setPermissionMode');
    },
    applyFlagSettings: async (
      settings: Parameters<Query['applyFlagSettings']>[0],
    ): Promise<void> => {
      calls.push(['applyFlagSettings', settings]);
      maybeFail('applyFlagSettings');
    },
  };

  return { query, calls, failure };
}

describe('Claude runtime config helpers', () => {
  it('uses the official setter parameter types and applies individual values', async () => {
    const { query, calls } = makeFakeQuery();
    const model: Parameters<Query['setModel']>[0] = 'claude-sonnet';
    const permissionMode: PermissionMode = 'acceptEdits';
    const effort: EffortLevel = 'high';

    await applyClaudeModel(query, model);
    await applyClaudePermissionMode(query, permissionMode);
    await applyClaudeEffort(query, effort);

    expect(calls).toEqual([
      ['setModel', model],
      ['setPermissionMode', permissionMode],
      ['applyFlagSettings', { effortLevel: effort }],
    ]);
  });

  it('always applies all settings in order, including an undefined model and cleared effort', async () => {
    const { query, calls } = makeFakeQuery();

    await applyClaudeRuntimeConfig(query, {
      permissionMode: 'plan',
    });

    expect(calls).toEqual([
      ['setModel', undefined],
      ['setPermissionMode', 'plan'],
      ['applyFlagSettings', { effortLevel: null }],
    ]);
  });

  it.each<RuntimeStage>(['setModel', 'setPermissionMode', 'applyFlagSettings'])(
    'propagates the original %s failure and stops later stages',
    async (failAt) => {
      const { query, calls, failure } = makeFakeQuery(failAt);

      await expect(
        applyClaudeRuntimeConfig(query, {
          model: 'claude-opus',
          permissionMode: 'bypassPermissions',
          effort: 'max',
        }),
      ).rejects.toBe(failure);

      const expectedCalls: RuntimeCall[] = [['setModel', 'claude-opus']];
      if (failAt === 'setPermissionMode' || failAt === 'applyFlagSettings') {
        expectedCalls.push(['setPermissionMode', 'bypassPermissions']);
      }
      if (failAt === 'applyFlagSettings') {
        expectedCalls.push(['applyFlagSettings', { effortLevel: 'max' }]);
      }
      expect(calls).toEqual(expectedCalls);
    },
  );

  it('has no dependency on a setEffort method', () => {
    type SetEffortDependency = Extract<keyof ClaudeRuntimeQuery, 'setEffort'>;

    expectTypeOf<SetEffortDependency>().toEqualTypeOf<never>();
  });
});
