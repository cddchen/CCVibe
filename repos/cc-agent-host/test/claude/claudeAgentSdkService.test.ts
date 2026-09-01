import type {
  AnyZodRawShape,
  InferShape,
  ModelInfo,
  Query,
  SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import {
  ClaudeAgentSdkService,
  type ClaudeAgentSdkServiceOptions,
} from '../../src/claude/claudeAgentSdkService.js';
import type {
  ClaudeSdkBindingName,
  ClaudeSdkBindings,
} from '../../src/claude/sdkBindings.js';

type BindingResult<K extends ClaudeSdkBindingName> = Awaited<ReturnType<ClaudeSdkBindings[K]>>;

type BindingParameters<K extends ClaudeSdkBindingName> = Parameters<ClaudeSdkBindings[K]>;

const queryResult = Object.create(null) as ReturnType<ClaudeSdkBindings['query']>;
const warmQueryResult = Object.create(null) as BindingResult<'startup'>;
const sessionsResult = [] as BindingResult<'listSessions'>;
const sessionInfoResult = Object.create(null) as NonNullable<BindingResult<'getSessionInfo'>>;
const sessionMessagesResult = [] as BindingResult<'getSessionMessages'>;
const subagentsResult = [] as BindingResult<'listSubagents'>;
const subagentMessagesResult = [] as BindingResult<'getSubagentMessages'>;
const forkResult = Object.create(null) as BindingResult<'forkSession'>;
const mcpServerResult = Object.create(null) as ReturnType<ClaudeSdkBindings['createSdkMcpServer']>;
const toolResult = Object.create(null) as ReturnType<ClaudeSdkBindings['tool']>;

const textToolShape = { text: z.string() };
const countToolShape = { count: z.number(), enabled: z.boolean() };

if (false) {
  const service = new ClaudeAgentSdkService();
  const textTool = service.tool('text', 'text tool', textToolShape, async (args) => {
    expectTypeOf(args).toEqualTypeOf<{ text: string }>();
    return { content: [] };
  });
  const countTool = service.tool('count', 'count tool', countToolShape, async (args) => {
    expectTypeOf(args).toEqualTypeOf<{ count: number; enabled: boolean }>();
    return { content: [] };
  });

  expectTypeOf(textTool).toEqualTypeOf<Promise<SdkMcpToolDefinition<typeof textToolShape>>>();
  expectTypeOf(countTool).toEqualTypeOf<Promise<SdkMcpToolDefinition<typeof countToolShape>>>();

  // @ts-expect-error The handler argument must be inferred from textToolShape.
  void service.tool('invalid', 'invalid handler', textToolShape, async (_args: { count: number }) => ({ content: [] }));
}

function fakeTool<Schema extends AnyZodRawShape>(
  ...args: [
    name: string,
    description: string,
    inputSchema: Schema,
    handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>,
    extras?: NonNullable<BindingParameters<'tool'>[4]>,
  ]
): SdkMcpToolDefinition<Schema> {
  return Object.assign(toolResult, {
    name: args[0],
    description: args[1],
    inputSchema: args[2],
    handler: args[3],
  }) as SdkMcpToolDefinition<Schema>;
}

function makeFakeBindings(calls: Map<ClaudeSdkBindingName, readonly unknown[]>): ClaudeSdkBindings {
  const record = (name: ClaudeSdkBindingName, args: readonly unknown[]): void => {
    calls.set(name, args);
  };

  return {
    query: (...args: BindingParameters<'query'>): ReturnType<ClaudeSdkBindings['query']> => {
      record('query', args);
      return queryResult;
    },
    startup: (...args: BindingParameters<'startup'>): ReturnType<ClaudeSdkBindings['startup']> => {
      record('startup', args);
      return Promise.resolve(warmQueryResult);
    },
    listSessions: (...args: BindingParameters<'listSessions'>): ReturnType<ClaudeSdkBindings['listSessions']> => {
      record('listSessions', args);
      return Promise.resolve(sessionsResult);
    },
    getSessionInfo: (...args: BindingParameters<'getSessionInfo'>): ReturnType<ClaudeSdkBindings['getSessionInfo']> => {
      record('getSessionInfo', args);
      return Promise.resolve(sessionInfoResult);
    },
    getSessionMessages: (...args: BindingParameters<'getSessionMessages'>): ReturnType<ClaudeSdkBindings['getSessionMessages']> => {
      record('getSessionMessages', args);
      return Promise.resolve(sessionMessagesResult);
    },
    listSubagents: (...args: BindingParameters<'listSubagents'>): ReturnType<ClaudeSdkBindings['listSubagents']> => {
      record('listSubagents', args);
      return Promise.resolve(subagentsResult);
    },
    getSubagentMessages: (...args: BindingParameters<'getSubagentMessages'>): ReturnType<ClaudeSdkBindings['getSubagentMessages']> => {
      record('getSubagentMessages', args);
      return Promise.resolve(subagentMessagesResult);
    },
    forkSession: (...args: BindingParameters<'forkSession'>): ReturnType<ClaudeSdkBindings['forkSession']> => {
      record('forkSession', args);
      return Promise.resolve(forkResult);
    },
    deleteSession: (...args: BindingParameters<'deleteSession'>): ReturnType<ClaudeSdkBindings['deleteSession']> => {
      record('deleteSession', args);
      return Promise.resolve();
    },
    createSdkMcpServer: (
      ...args: BindingParameters<'createSdkMcpServer'>
    ): ReturnType<ClaudeSdkBindings['createSdkMcpServer']> => {
      record('createSdkMcpServer', args);
      return mcpServerResult;
    },
    tool: <Schema extends AnyZodRawShape>(
      ...args: [
        name: string,
        description: string,
        inputSchema: Schema,
        handler: (handlerArgs: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>,
        extras?: NonNullable<BindingParameters<'tool'>[4]>,
      ]
    ): SdkMcpToolDefinition<Schema> => {
      record('tool', args);
      return fakeTool(...args);
    },
  };
}

function makeService(
  loadSdk: NonNullable<ClaudeAgentSdkServiceOptions['loadSdk']>,
  onLoadError?: NonNullable<ClaudeAgentSdkServiceOptions['onLoadError']>,
): ClaudeAgentSdkService {
  if (onLoadError === undefined) {
    return new ClaudeAgentSdkService({ loadSdk });
  }
  return new ClaudeAgentSdkService({ loadSdk, onLoadError });
}

describe('ClaudeAgentSdkService loading', () => {
  it('loads lazily and shares one in-flight load between concurrent calls', async () => {
    let loadCalls = 0;
    let resolveLoad!: (bindings: ClaudeSdkBindings) => void;
    const load = new Promise<ClaudeSdkBindings>((resolve) => {
      resolveLoad = resolve;
    });
    const calls = new Map<ClaudeSdkBindingName, readonly unknown[]>();
    const bindings = makeFakeBindings(calls);
    const service = makeService(() => {
      loadCalls += 1;
      return load;
    });

    const first = service.listSessions();
    const second = service.getSessionInfo('session-id');
    expect(loadCalls).toBe(0);
    await Promise.resolve();
    expect(loadCalls).toBe(1);

    resolveLoad(bindings);
    await expect(first).resolves.toBe(sessionsResult);
    await expect(second).resolves.toBe(sessionInfoResult);
    expect(loadCalls).toBe(1);
  });

  it('caches a successfully loaded module for later calls', async () => {
    let loadCalls = 0;
    const calls = new Map<ClaudeSdkBindingName, readonly unknown[]>();
    const bindings = makeFakeBindings(calls);
    const service = makeService(async () => {
      loadCalls += 1;
      return bindings;
    });

    await expect(service.listSessions()).resolves.toBe(sessionsResult);
    await expect(service.listSubagents('session-id')).resolves.toBe(subagentsResult);
    expect(loadCalls).toBe(1);
  });

  it('reports each failed attempt, preserves the original error, and retries', async () => {
    let loadCalls = 0;
    const firstError = new Error('first load failed');
    const reported: unknown[] = [];
    const calls = new Map<ClaudeSdkBindingName, readonly unknown[]>();
    const bindings = makeFakeBindings(calls);
    const service = makeService(
      async () => {
        loadCalls += 1;
        if (loadCalls === 1) {
          throw firstError;
        }
        return bindings;
      },
      (error) => {
        reported.push(error);
      },
    );

    await expect(service.listSessions()).rejects.toBe(firstError);
    expect(reported).toEqual([firstError]);
    await expect(service.listSessions()).resolves.toBe(sessionsResult);
    expect(loadCalls).toBe(2);
    expect(reported).toEqual([firstError]);
  });

  it('swallows reporter failures without replacing the loader error', async () => {
    const loadError = new Error('load failed');
    const reporterError = new Error('reporter failed');
    const service = makeService(
      async () => {
        throw loadError;
      },
      () => {
        throw reporterError;
      },
    );

    await expect(service.listSessions()).rejects.toBe(loadError);
  });

  it('swallows async reporter rejection without replacing the loader error or leaking it', async () => {
    const loadError = new Error('load failed');
    const reporterError = new Error('async reporter failed');
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown): void => {
      unhandled.push(error);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      const service = makeService(
        async () => {
          throw loadError;
        },
        async () => {
          throw reporterError;
        },
      );

      await expect(service.listSessions()).rejects.toBe(loadError);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('ClaudeAgentSdkService passthrough facade', () => {
  it('reads supported models from an initialized Query and always cleans up the probe', async () => {
    const calls = new Map<ClaudeSdkBindingName, readonly unknown[]>();
    const models = [{
      value: 'sonnet',
      displayName: 'Claude Sonnet',
      description: 'A model',
    }] satisfies ModelInfo[];
    let queryClosed = 0;
    let warmClosed = 0;
    const query = {
      supportedModels: async () => models,
      close: () => {
        queryClosed += 1;
      },
    } as unknown as Query;
    const warm = {
      query: () => query,
      close: () => {
        warmClosed += 1;
      },
    } as unknown as BindingResult<'startup'>;
    const defaultBindings = makeFakeBindings(calls);
    const bindings: ClaudeSdkBindings = {
      ...defaultBindings,
      startup: (...args: BindingParameters<'startup'>): ReturnType<ClaudeSdkBindings['startup']> => {
        calls.set('startup', args);
        return Promise.resolve(warm);
      },
    };
    const service = makeService(async () => bindings);

    await expect(service.listSupportedModels('/tmp/project')).resolves.toEqual(models);
    expect(queryClosed).toBe(1);
    expect(warmClosed).toBe(1);
    expect((calls.get('startup')?.[0] as { options?: { cwd?: string } } | undefined)?.options?.cwd)
      .toBe('/tmp/project');
  });

  it('falls back to initializationResult.models for older Query implementations', async () => {
    const calls = new Map<ClaudeSdkBindingName, readonly unknown[]>();
    const models = [{
      value: 'opus',
      displayName: 'Claude Opus',
      description: 'A model',
    }] satisfies ModelInfo[];
    const query = {
      initializationResult: async () => ({ models }),
      close: () => undefined,
    } as unknown as Query;
    const warm = {
      query: () => query,
      close: () => undefined,
    } as unknown as BindingResult<'startup'>;
    const defaultBindings = makeFakeBindings(calls);
    const bindings: ClaudeSdkBindings = {
      ...defaultBindings,
      startup: (...args: BindingParameters<'startup'>): ReturnType<ClaudeSdkBindings['startup']> => {
        calls.set('startup', args);
        return Promise.resolve(warm);
      },
    };
    const service = makeService(async () => bindings);

    await expect(service.listSupportedModels()).resolves.toEqual(models);
  });

  it('preserves every binding argument and result identity', async () => {
    const calls = new Map<ClaudeSdkBindingName, readonly unknown[]>();
    const bindings = makeFakeBindings(calls);
    const service = makeService(async () => bindings);

    const queryParams: BindingParameters<'query'> = [{ prompt: 'hello' }];
    const startupParams: BindingParameters<'startup'> = [{ initializeTimeoutMs: 1000 }];
    const listSessionsOptions: BindingParameters<'listSessions'>[0] = { limit: 10 };
    const sessionInfoOptions: BindingParameters<'getSessionInfo'>[1] = { dir: '/tmp/project' };
    const sessionMessagesOptions: BindingParameters<'getSessionMessages'>[1] = { limit: 5 };
    const listSubagentsOptions: BindingParameters<'listSubagents'>[1] = { dir: '/tmp/project' };
    const subagentMessagesOptions: BindingParameters<'getSubagentMessages'>[2] = { offset: 2 };
    const forkOptions: BindingParameters<'forkSession'>[1] = { title: 'fork' };
    const deleteOptions: BindingParameters<'deleteSession'>[1] = { dir: '/tmp/project' };
    const mcpOptions: BindingParameters<'createSdkMcpServer'>[0] = { name: 'server' };
    const toolInputSchema = Object.create(null) as BindingParameters<'tool'>[2];
    const toolHandler = Object.create(null) as BindingParameters<'tool'>[3];
    const toolExtras = Object.create(null) as NonNullable<BindingParameters<'tool'>[4]>;
    const toolParams: BindingParameters<'tool'> = [
      'name',
      'description',
      toolInputSchema,
      toolHandler,
      toolExtras,
    ];

    await expect(service.query(...queryParams)).resolves.toBe(queryResult);
    await expect(service.startup(...startupParams)).resolves.toBe(warmQueryResult);
    await expect(service.listSessions(listSessionsOptions)).resolves.toBe(sessionsResult);
    await expect(service.getSessionInfo('session-id', sessionInfoOptions)).resolves.toBe(sessionInfoResult);
    await expect(service.getSessionMessages('session-id', sessionMessagesOptions)).resolves.toBe(sessionMessagesResult);
    await expect(service.listSubagents('session-id', listSubagentsOptions)).resolves.toBe(subagentsResult);
    await expect(
      service.getSubagentMessages('session-id', 'agent-id', subagentMessagesOptions),
    ).resolves.toBe(subagentMessagesResult);
    await expect(service.forkSession('session-id', forkOptions)).resolves.toBe(forkResult);
    await expect(service.deleteSession('session-id', deleteOptions)).resolves.toBeUndefined();
    await expect(service.createSdkMcpServer(mcpOptions)).resolves.toBe(mcpServerResult);
    await expect(service.tool(...toolParams)).resolves.toBe(toolResult);

    expect(calls.get('query')?.[0]).toBe(queryParams[0]);
    expect(calls.get('startup')?.[0]).toBe(startupParams[0]);
    expect(calls.get('listSessions')?.[0]).toBe(listSessionsOptions);
    expect(calls.get('getSessionInfo')?.[1]).toBe(sessionInfoOptions);
    expect(calls.get('getSessionMessages')?.[1]).toBe(sessionMessagesOptions);
    expect(calls.get('listSubagents')?.[1]).toBe(listSubagentsOptions);
    expect(calls.get('getSubagentMessages')?.[2]).toBe(subagentMessagesOptions);
    expect(calls.get('forkSession')?.[1]).toBe(forkOptions);
    expect(calls.get('deleteSession')?.[1]).toBe(deleteOptions);
    expect(calls.get('createSdkMcpServer')?.[0]).toBe(mcpOptions);
    expect(calls.get('tool')?.[2]).toBe(toolInputSchema);
    expect(calls.get('tool')?.[3]).toBe(toolHandler);
    expect(calls.get('tool')?.[4]).toBe(toolExtras);
  });
});
