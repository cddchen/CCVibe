import type { UUID } from 'node:crypto';

import type {
  CanUseTool,
  NonNullableUsage,
  Options,
  Query,
  SDKMessage,
  SDKResultSuccess,
  SDKUserMessage,
  SessionMessage,
  WarmQuery,
} from '@anthropic-ai/claude-agent-sdk';
import WebSocket from 'ws';
import { describe, expect, it } from 'vitest';

import {
  createChatUri,
  createClientId,
  createCommandId,
  createClaudeAgentHost,
  createAccessControlList,
  createModel,
  createModelId,
  createPrincipal,
  createRootUri,
  createTurnId,
  createWorkspace,
  createWorkspaceId,
  parseChatUri,
  type ClaudeAgentHostOverlayRepository,
  type ClaudeAgentHostRuntime,
  type ClaudeAgentHostRuntimeSession,
  type ClaudeAgentHostSdkService,
  type CatalogSdkModelInfo,
  type CatalogListSessionsResult,
  type CatalogSource,
} from '../../src/index.js';
import type { ClaudeAgentSdkService } from '../../src/claude/claudeAgentSdkService.js';
import {
  toPersistedChatBacking,
  type PersistedChatBacking,
  type SaveChatBackingInput,
} from '../../src/persistence/overlayRepository.js';

const SDK_SESSION_ID = 'sdk-session-1';
const SDK_UUID: UUID = '00000000-0000-4000-8000-000000000101';
const MESSAGE_UUID: UUID = '00000000-0000-4000-8000-000000000102';
const chat = createChatUri('session-1', 'chat-1');
const root = createRootUri();

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

type TestQuery = Pick<
  Query,
  'interrupt' | 'setModel' | 'setPermissionMode' | 'applyFlagSettings' | 'close'
> & AsyncGenerator<SDKMessage, void>;

class FakeQuery implements TestQuery {
  public readonly configCalls: Array<readonly [string, unknown]> = [];
  public returnCalls = 0;
  private readonly messages: SDKMessage[] = [];
  private readonly waitingNext: Array<Deferred<IteratorResult<SDKMessage, void>>> = [];
  private ended = false;

  public next(..._args: [] | [unknown]): Promise<IteratorResult<SDKMessage, void>> {
    const message = this.messages.shift();
    if (message !== undefined) {
      return Promise.resolve({ done: false, value: message });
    }
    if (this.ended) {
      return Promise.resolve({ done: true, value: undefined });
    }
    const next = deferred<IteratorResult<SDKMessage, void>>();
    this.waitingNext.push(next);
    return next.promise;
  }

  public return(_value?: void | PromiseLike<void>): Promise<IteratorResult<SDKMessage, void>> {
    this.returnCalls += 1;
    this.end();
    return Promise.resolve({ done: true, value: undefined });
  }

  public throw(error?: unknown): Promise<IteratorResult<SDKMessage, void>> {
    return Promise.reject(error ?? new Error('fake query throw'));
  }

  public [Symbol.asyncIterator](): AsyncGenerator<SDKMessage, void> {
    return this;
  }

  public interrupt(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  public async setModel(model?: string): Promise<void> {
    this.configCalls.push(['setModel', model]);
  }

  public async setPermissionMode(
    mode: Parameters<Query['setPermissionMode']>[0],
  ): Promise<void> {
    this.configCalls.push(['setPermissionMode', mode]);
  }

  public async applyFlagSettings(
    settings: Parameters<Query['applyFlagSettings']>[0],
  ): Promise<void> {
    this.configCalls.push(['applyFlagSettings', settings]);
  }

  public close(): void {
    this.end();
  }

  public yield(message: SDKMessage): void {
    const waiter = this.waitingNext.shift();
    if (waiter === undefined) {
      this.messages.push(message);
      return;
    }
    waiter.resolve({ done: false, value: message });
  }

  private end(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    for (const waiter of this.waitingNext.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }
}

class FakeWarmQuery implements Pick<WarmQuery, 'query' | 'close'>, AsyncDisposable {
  public queryCalls = 0;
  public disposeCalls = 0;
  public queryInput: AsyncIterable<SDKUserMessage> | undefined;

  public constructor(public readonly queryValue: FakeQuery) {}

  public query(prompt: string | AsyncIterable<SDKUserMessage>): Query {
    if (typeof prompt === 'string') {
      throw new TypeError('expected streaming input');
    }
    this.queryCalls += 1;
    this.queryInput = prompt;
    return this.queryValue as unknown as Query;
  }

  public close(): void {}

  public async [Symbol.asyncDispose](): Promise<void> {
    this.disposeCalls += 1;
  }

  public async acceptNext(): Promise<SDKUserMessage> {
    const input = this.queryInput;
    if (input === undefined) {
      throw new Error('query input has not been installed');
    }
    const result = await input[Symbol.asyncIterator]().next();
    if (result.done) {
      throw new Error('runtime input ended');
    }
    return result.value;
  }
}

interface ServiceHarness {
  readonly service: ClaudeAgentHostSdkService;
  readonly query: FakeQuery;
  readonly warm: FakeWarmQuery;
  readonly startupOptions: Options[];
  readonly historyCalls: Array<readonly [string, Parameters<ClaudeAgentSdkService['getSessionMessages']>[1]]>;
}

function serviceHarness(messages: readonly SessionMessage[] = []): ServiceHarness {
  const query = new FakeQuery();
  const warm = new FakeWarmQuery(query);
  const startupOptions: Options[] = [];
  const historyCalls: Array<readonly [string, Parameters<ClaudeAgentSdkService['getSessionMessages']>[1]]> = [];
  const service: ClaudeAgentHostSdkService = {
    startup: async (...args: Parameters<ClaudeAgentSdkService['startup']>): Promise<WarmQuery> => {
      const options = args[0]?.options;
      if (options !== undefined) {
        startupOptions.push(options);
      }
      return warm;
    },
    getSessionMessages: async (...args: Parameters<ClaudeAgentSdkService['getSessionMessages']>): Promise<SessionMessage[]> => {
      const sessionId = args[0];
      const options = args[1];
      if (options === undefined) {
        throw new Error('history options are required');
      }
      historyCalls.push([sessionId, options]);
      return [...messages];
    },
  };
  return { service, query, warm, startupOptions, historyCalls };
}

class PersistedRuntime implements ClaudeAgentHostRuntime {
  public state: 'starting' | 'running' | 'closing' | 'closed' | 'crashed' = 'starting';
  public closeCalls = 0;

  public constructor(public readonly session: ClaudeAgentHostRuntimeSession) {}

  public async start(): Promise<void> {
    this.state = 'running';
  }

  public send(
    turnId: ReturnType<typeof createTurnId>,
    _text: string,
  ): ReturnType<ClaudeAgentHostRuntime['send']> {
    return {
      turnId,
      sdkUuid: MESSAGE_UUID,
      accepted: Promise.resolve(),
      completed: new Promise(() => undefined),
    };
  }

  public interrupt(_turnId: ReturnType<typeof createTurnId>): Promise<unknown | undefined> {
    return Promise.resolve(undefined);
  }

  public applyRuntimeConfig(_config: Parameters<ClaudeAgentHostRuntime['applyRuntimeConfig']>[0]): Promise<void> {
    return Promise.resolve();
  }

  public async close(): Promise<void> {
    this.closeCalls += 1;
    this.state = 'closed';
  }
}

class FakeOverlayRepository implements ClaudeAgentHostOverlayRepository {
  public readonly rows = new Map<string, PersistedChatBacking>();
  public readonly calls: string[] = [];
  public failSave: unknown;
  public failDelete: unknown;
  public closeCalls = 0;

  public async saveChatBacking(input: SaveChatBackingInput): Promise<PersistedChatBacking> {
    this.calls.push('save:start');
    if (this.failSave !== undefined) {
      throw this.failSave;
    }
    const row: PersistedChatBacking = 'backing' in input
      ? toPersistedChatBacking(input, () => 'persisted-time')
      : {
          chatUri: input.chatUri,
          sdkSessionId: input.sdkSessionId,
          cwd: input.cwd,
          additionalDirectories: [...input.additionalDirectories],
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.effort === undefined ? {} : { effort: input.effort }),
          permissionMode: input.permissionMode,
          lifecycle: input.lifecycle,
          ...(input.title === undefined ? {} : { title: input.title }),
          archived: input.archived ?? false,
          createdAt: input.createdAt ?? 'persisted-time',
          updatedAt: input.updatedAt ?? input.createdAt ?? 'persisted-time',
        };
    this.rows.set(row.chatUri, row);
    this.calls.push('save:commit');
    return row;
  }

  public async listChatBackings(): Promise<readonly PersistedChatBacking[]> {
    this.calls.push('list');
    return Object.freeze([...this.rows.values()]);
  }

  public async deleteChatBacking(chatUri: string): Promise<boolean> {
    this.calls.push('delete:start');
    if (this.failDelete !== undefined) {
      throw this.failDelete;
    }
    const deleted = this.rows.delete(chatUri);
    this.calls.push('delete:commit');
    return deleted;
  }

  public async updateChatBacking(
    chatUri: string,
    patch: Readonly<{ readonly lifecycle: 'provisional' | 'materialized' }>,
  ): Promise<PersistedChatBacking | undefined> {
    this.calls.push('update:commit');
    const current = this.rows.get(chatUri);
    if (current === undefined) {
      return undefined;
    }
    const updated: PersistedChatBacking = {
      ...current,
      lifecycle: patch.lifecycle,
      updatedAt: 'persisted-updated-time',
    };
    this.rows.set(chatUri, updated);
    return updated;
  }

  public close(): void {
    this.closeCalls += 1;
    this.calls.push('close');
  }
}

function persistedHostOptions(
  service: ClaudeAgentHostSdkService,
  repository: ClaudeAgentHostOverlayRepository,
  sessions: ClaudeAgentHostRuntimeSession[],
): Parameters<typeof createClaudeAgentHost>[0] {
  return {
    ...baseOptions(service),
    overlayRepository: repository,
    runtimeFactory: ({ session }) => {
      sessions.push(session);
      return new PersistedRuntime(session);
    },
  };
}

function baseOptions(service: ClaudeAgentHostSdkService): Parameters<typeof createClaudeAgentHost>[0] {
  return {
    hostEpoch: 'epoch-1',
    nowServer: () => 'server-time',
    nowAction: () => 'action-time',
    sdkService: service,
    createSdkSessionId: () => SDK_SESSION_ID,
    createSdkUuid: () => SDK_UUID,
    heartbeatIntervalMs: 0,
    fastifyOptions: { logger: false },
  };
}

class Inbox {
  private readonly messages: Array<Record<string, unknown>> = [];
  private readonly waiters: Array<{
    readonly predicate: (message: Record<string, unknown>) => boolean;
    readonly resolve: (message: Record<string, unknown>) => void;
    readonly reject: (error: Error) => void;
  }> = [];
  private error: Error | undefined;

  public constructor(public readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      const index = this.waiters.findIndex((waiter) => waiter.predicate(message));
      const waiter = index < 0 ? undefined : this.waiters.splice(index, 1)[0];
      if (waiter === undefined) {
        this.messages.push(message);
      } else {
        waiter.resolve(message);
      }
    });
    socket.on('error', (error: Error) => {
      this.error = error;
      for (const waiter of this.waiters.splice(0)) {
        waiter.reject(error);
      }
    });
  }

  public next(
    predicate: (message: Record<string, unknown>) => boolean = () => true,
  ): Promise<Record<string, unknown>> {
    if (this.error !== undefined) {
      return Promise.reject(this.error);
    }
    const index = this.messages.findIndex(predicate);
    if (index >= 0) {
      return Promise.resolve(this.messages.splice(index, 1)[0] as Record<string, unknown>);
    }
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.waiters.push({ predicate, resolve, reject });
    });
  }
}

async function openClient(url: string): Promise<Inbox> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return new Inbox(socket);
}

async function listen(host: Awaited<ReturnType<typeof createClaudeAgentHost>>): Promise<string> {
  await host.server.listen({ host: '127.0.0.1', port: 0 });
  const address = host.server.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('host did not bind');
  }
  return `ws://127.0.0.1:${address.port}/ws`;
}

async function closeClient(client: Inbox | undefined): Promise<void> {
  if (client === undefined || client.socket.readyState === WebSocket.CLOSED) {
    return;
  }
  await new Promise<void>((resolve) => {
    client.socket.once('close', resolve);
    client.socket.close();
  });
}

function rpc(id: string, method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

async function call(
  client: Inbox,
  id: string,
  method: string,
  params: unknown,
): Promise<Record<string, unknown>> {
  client.socket.send(rpc(id, method, params));
  return client.next((message) => message.id === id);
}

function initializeParams(): Record<string, unknown> {
  return {
    channel: root,
    protocolVersions: ['1.0.0'],
    clientId: createClientId('client-1'),
    clientInfo: { name: 'composition-test', version: '1', platform: 'node' },
    capabilities: { partialBlocks: true, approvalEdits: false },
    initialSubscriptions: [chat],
  };
}

function streamText(text: string): SDKMessage[] {
  return [
    {
      type: 'stream_event',
      parent_tool_use_id: null,
      uuid: MESSAGE_UUID,
      session_id: SDK_SESSION_ID,
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text, citations: null },
      },
    },
    {
      type: 'stream_event',
      parent_tool_use_id: null,
      uuid: MESSAGE_UUID,
      session_id: SDK_SESSION_ID,
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: ' world' },
      },
    },
    {
      type: 'stream_event',
      parent_tool_use_id: null,
      uuid: MESSAGE_UUID,
      session_id: SDK_SESSION_ID,
      event: { type: 'content_block_stop', index: 0 },
    },
  ] satisfies SDKMessage[];
}

function successMessage(userMessageUuid: string): SDKResultSuccess {
  const usage = Object.create(null) as NonNullableUsage;
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: 'done',
    stop_reason: 'end_turn',
    total_cost_usd: 0,
    usage,
    modelUsage: {},
    permission_denials: [],
    uuid: MESSAGE_UUID,
    session_id: SDK_SESSION_ID,
    user_message_uuid: userMessageUuid,
  };
}

function historyMessages(): SessionMessage[] {
  return [
    {
      type: 'user',
      uuid: 'history-user',
      session_id: SDK_SESSION_ID,
      message: { role: 'user', content: 'history prompt' },
      parent_tool_use_id: null,
      parent_agent_id: null,
      timestamp: 'history-start',
    } as SessionMessage,
    {
      type: 'assistant',
      uuid: 'history-assistant',
      session_id: SDK_SESSION_ID,
      message: { role: 'assistant', content: [{ type: 'text', text: 'history answer' }] },
      parent_tool_use_id: null,
      parent_agent_id: null,
      timestamp: 'history-end',
    } as SessionMessage,
  ];
}

describe('createClaudeAgentHost', () => {
  it('does not read a catalog source or SDK sessions during factory construction', async () => {
    const harness = serviceHarness();
    let sourceCalls = 0;
    let sessionCalls = 0;
    const catalogSource: CatalogSource = {
      load: () => {
        sourceCalls += 1;
        return { workspaces: [], models: [] };
      },
      listSessions: () => {
        sessionCalls += 1;
        return [];
      },
    };
    const host = await createClaudeAgentHost({
      ...baseOptions(harness.service),
      catalogSource,
    });

    expect(sourceCalls).toBe(0);
    expect(sessionCalls).toBe(0);
    expect(harness.startupOptions).toHaveLength(0);
    await host.shutdown();
  });

  it('refreshes workspace, model, and SDK session projections through catalog actions', async () => {
    const harness = serviceHarness();
    const workspace = createWorkspace({
      id: createWorkspaceId('workspace-refresh'),
      path: '/tmp/refresh-project',
      displayName: 'Refresh Project',
    });
    const model = createModel({
      id: createModelId('model-refresh'),
      displayName: 'Refresh Model',
      capabilities: ['effort'],
    });
    const sdkSessions = [{
      sessionId: 'sdk-session-refresh',
      summary: 'SDK session summary',
      lastModified: 1_700_000_000_000,
      cwd: workspace.path,
      fileSize: 99,
    }] satisfies CatalogListSessionsResult;
    let sessionCalls = 0;
    const catalogSource: CatalogSource = {
      load: () => ({
        workspaces: [workspace],
        models: [model],
        defaultModelId: model.id,
      }),
      listSessions: () => {
        sessionCalls += 1;
        return sdkSessions;
      },
    };
    const host = await createClaudeAgentHost({
      ...baseOptions(harness.service),
      catalogSource,
    });
    const actions: string[] = [];
    const dispose = host.hostStateManager.subscribeAll((envelope) => {
      if (envelope.channel === root) {
        actions.push(envelope.action.type);
      }
    });

    try {
      const state = await host.refreshCatalog();

      expect(sessionCalls).toBe(1);
      expect(state.workspaces).toEqual([workspace]);
      expect(state.models).toEqual([model]);
      expect(state.defaultModelId).toBe(model.id);
      expect(state.sessions).toMatchObject([{
        chatUri: 'agent-chat://epoch-1/sdk-session-refresh',
        sdkSessionRef: 'sdk-session-refresh',
        workspaceId: workspace.id,
        title: 'SDK session summary',
        updatedAt: '2023-11-14T22:13:20.000Z',
        status: 'idle',
        archived: false,
      }]);
      expect(actions).toEqual([
        'catalog/workspacesReplaced',
        'catalog/modelsReplaced',
        'catalog/sessionsReplaced',
      ]);
      expect(host.hostStateManager.serverSeq).toBe(3);
    } finally {
      dispose();
      await host.shutdown();
    }
  });

  it('discovers the default catalog from SDK sessions and Query models', async () => {
    const harness = serviceHarness();
    const sdkSessions = [{
      sessionId: 'sdk-session-auto',
      summary: 'Auto discovered session',
      lastModified: 1_700_000_000_000,
      cwd: '/tmp/auto-project',
      fileSize: 99,
    }] satisfies CatalogListSessionsResult;
    const sdkModels = [{
      value: 'sonnet',
      displayName: 'Claude Sonnet',
      description: 'SDK model',
      supportsAdaptiveThinking: true,
    }] satisfies CatalogSdkModelInfo[];
    const service: ClaudeAgentHostSdkService = {
      ...harness.service,
      listSessions: () => sdkSessions,
      listSupportedModels: () => sdkModels,
    };
    const host = await createClaudeAgentHost(baseOptions(service));

    try {
      const first = await host.refreshCatalog();
      const second = await host.refreshCatalog();

      expect(first.workspaces).toHaveLength(1);
      expect(first.workspaces).toEqual(second.workspaces);
      expect(first.workspaces[0]).toMatchObject({
        path: '/tmp/auto-project',
        displayName: 'auto-project',
      });
      expect(first.models).toEqual([{
        id: 'sonnet',
        displayName: 'Claude Sonnet',
        description: 'SDK model',
        capabilities: ['adaptive-thinking'],
      }]);
      expect(first.defaultModelId).toBe('sonnet');
      expect(first.sessions).toMatchObject([{
        sdkSessionRef: 'sdk-session-auto',
        workspaceId: first.workspaces[0]?.id,
      }]);
      expect(host.registry.getBacking(parseChatUri('agent-chat://epoch-1/sdk-session-auto'))?.lifecycle)
        .toBe('materialized');
    } finally {
      await host.shutdown();
    }
  });

  it('restores history with a catalog model fallback and no unsupported effort', async () => {
    const firstModel = createModel({
      id: createModelId('first-model'),
      displayName: 'First Model',
      supportedEffortLevels: ['low', 'medium'],
    });
    const defaultModel = createModel({
      id: createModelId('default-model'),
      displayName: 'Default Model',
      supportedEffortLevels: ['low', 'medium', 'high'],
    });
    const workspace = createWorkspace({
      id: createWorkspaceId('workspace-history-fallback'),
      path: '/tmp/history-fallback-project',
      displayName: 'History Fallback Project',
    });
    const harness = serviceHarness([{
      type: 'assistant',
      uuid: 'history-fallback-assistant',
      session_id: 'sdk-session-history-fallback',
      message: {
        role: 'assistant',
        model: 'provider-model-not-in-catalog',
        effort: 'xhigh',
        content: [],
      },
      parent_tool_use_id: null,
      parent_agent_id: null,
    } as SessionMessage]);
    const catalogSource: CatalogSource = {
      load: () => ({
        workspaces: [workspace],
        models: [firstModel, defaultModel],
        defaultModelId: defaultModel.id,
      }),
      listSessions: () => [{
        sessionId: 'sdk-session-history-fallback',
        summary: 'History fallback',
        lastModified: 1_700_000_000_000,
        cwd: workspace.path,
      }],
    };
    const host = await createClaudeAgentHost({
      ...baseOptions(harness.service),
      catalogSource,
    });

    try {
      const state = await host.refreshCatalog();
      expect(state.sessions).toMatchObject([{
        modelId: defaultModel.id,
      }]);
      expect(state.sessions[0]).not.toHaveProperty('effort');
      expect(host.registry.getBacking(parseChatUri('agent-chat://epoch-1/sdk-session-history-fallback')))
        .toMatchObject({ desiredConfig: { model: defaultModel.id } });
      expect(host.registry.getBacking(parseChatUri('agent-chat://epoch-1/sdk-session-history-fallback'))?.desiredConfig)
        .not.toHaveProperty('effort');
    } finally {
      await host.shutdown();
    }
  });

  it('resolves a real host workspace path and publishes an incremental catalog action', async () => {
    const harness = serviceHarness();
    const calls: string[] = [];
    const existingWorkspace = createWorkspace({
      id: createWorkspaceId('workspace-existing'),
      path: '/tmp/existing-project',
      displayName: 'Existing Project',
    });
    const host = await createClaudeAgentHost({
      ...baseOptions(harness.service),
      workspaceFilesystem: {
        realpath: async (path: string): Promise<string> => {
          calls.push(`realpath:${path}`);
          return '/tmp/canonical-project';
        },
        stat: async (path: string) => {
          calls.push(`stat:${path}`);
          return { isDirectory: () => true };
        },
      },
    });
    host.hostStateManager.dispatchCatalog(root, {
      type: 'catalog/workspacesReplaced',
      workspaces: [existingWorkspace],
      timestamp: 'catalog-existing',
    });
    const client = await openClient(await listen(host));

    try {
      await call(client, 'initialize', 'initialize', {
        ...initializeParams(),
        initialSubscriptions: [root],
      });
      const response = await call(client, 'resolve-workspace', 'catalog/resolveWorkspace', {
        channel: root,
        path: '/tmp/requested-project/..',
      });

      const returnedWorkspace = (response.result as { readonly workspace: { readonly path: string; readonly id: string } }).workspace;
      expect(calls).toEqual([
        'realpath:/tmp/requested-project/..',
        'stat:/tmp/canonical-project',
      ]);
      expect(returnedWorkspace).toMatchObject({
        path: '/tmp/canonical-project',
        displayName: 'canonical-project',
      });
      expect(host.hostStateManager.getCatalogState(root)?.workspaces).toHaveLength(2);
      expect(host.hostStateManager.getCatalogState(root)?.workspaces).toContainEqual(returnedWorkspace);
    } finally {
      await closeClient(client);
      await host.shutdown();
    }
  });

  it('keeps the last known good catalog when refresh fails', async () => {
    const harness = serviceHarness();
    const workspace = createWorkspace({
      id: createWorkspaceId('workspace-stable'),
      path: '/tmp/stable-project',
      displayName: 'Stable Project',
    });
    let fail = false;
    const failure = new Error('catalog source unavailable');
    const catalogSource: CatalogSource = {
      load: () => {
        if (fail) {
          throw failure;
        }
        return { workspaces: [workspace], models: [] };
      },
      listSessions: () => [],
    };
    const host = await createClaudeAgentHost({
      ...baseOptions(harness.service),
      catalogSource,
    });

    try {
      const previous = await host.refreshCatalog();
      const previousSeq = host.hostStateManager.serverSeq;
      fail = true;

      await expect(host.refreshCatalog()).rejects.toBe(failure);
      expect(host.hostStateManager.getCatalogState(root)).toBe(previous);
      expect(host.hostStateManager.serverSeq).toBe(previousSeq);
    } finally {
      await host.shutdown();
    }
  });

  it('creates one provisional catalog chat idempotently and materializes only on first send', async () => {
    const harness = serviceHarness();
    let chatIdCalls = 0;
    const host = await createClaudeAgentHost({
      ...baseOptions(harness.service),
      createChatId: () => `catalog-chat-${chatIdCalls += 1}`,
    });
    host.hostStateManager.dispatchCatalog(root, {
      type: 'catalog/workspacesReplaced',
      workspaces: [createWorkspace({
        id: createWorkspaceId('workspace-a'),
        path: '/tmp/project',
        displayName: 'Workspace A',
      })],
      timestamp: 'catalog-workspace',
    });
    host.hostStateManager.dispatchCatalog(root, {
      type: 'catalog/modelsReplaced',
      models: [createModel({
        id: createModelId('model-a'),
        displayName: 'Model A',
        capabilities: ['effort'],
        supportedEffortLevels: ['low', 'medium', 'high'],
      })],
      defaultModelId: createModelId('model-a'),
      timestamp: 'catalog-model',
    });
    const client = await openClient(await listen(host));

    try {
      await expect(call(client, 'initialize', 'initialize', {
        ...initializeParams(),
        initialSubscriptions: [root],
      })).resolves.toMatchObject({ result: { snapshots: [{ resource: root }] } });

      const first = await call(client, 'create-1', 'catalog/createChat', {
        channel: root,
        workspaceId: createWorkspaceId('workspace-a'),
        modelId: createModelId('model-a'),
        effort: 'high',
        initialPrompt: 'first title',
        clientSeq: 1,
        commandId: createCommandId('catalog-create-1'),
      });
      const firstChat = (first.result as { readonly receipt: { readonly value: { readonly chatUri: string } } }).receipt.value.chatUri;
      const firstChatUri = parseChatUri(firstChat);
      expect(first).toMatchObject({
        result: { receipt: { status: 'accepted', value: { chatUri: firstChat } } },
      });
      expect(host.registry.size).toBe(1);
      expect(host.registry.getBacking(firstChatUri)?.lifecycle).toBe('provisional');
      expect(host.registry.getBacking(firstChatUri)?.desiredConfig.effort).toBe('high');
      expect(harness.startupOptions).toHaveLength(0);
      expect(chatIdCalls).toBe(1);

      const catalogAction = await client.next((message) => (
        message.method === 'state/action'
        && (message.params as { readonly action?: { readonly type?: unknown } } | undefined)?.action?.type === 'catalog/chatCreated'
      ));
      expect(catalogAction).toMatchObject({
        params: {
          channel: root,
          action: {
            type: 'catalog/chatCreated',
            session: { modelId: 'model-a', effort: 'high' },
          },
        },
      });

      const retry = await call(client, 'create-2', 'catalog/createChat', {
        channel: root,
        workspaceId: createWorkspaceId('workspace-a'),
        modelId: createModelId('model-a'),
        clientSeq: 2,
        commandId: createCommandId('catalog-create-1'),
      });
      expect((retry.result as { readonly receipt: unknown }).receipt).toEqual((first.result as { readonly receipt: unknown }).receipt);
      expect(host.registry.size).toBe(1);
      expect(chatIdCalls).toBe(1);

      await call(client, 'subscribe-created', 'subscribe', { channel: firstChat });

      client.socket.send(rpc('send-created', 'dispatchAction', {
        channel: firstChat,
        clientSeq: 3,
        commandId: createCommandId('send-created'),
        action: { type: 'chat/send', prompt: 'materialize now' },
      }));
      await client.next((message) => (
        message.method === 'state/action'
        && (message.params as { readonly channel?: unknown; readonly action?: { readonly type?: unknown } } | undefined)?.channel === firstChat
        && (message.params as { readonly action?: { readonly type?: unknown } } | undefined)?.action?.type === 'chat/turnStarted'
      ));
      await client.next((message) => message.id === 'send-created');
      expect(harness.startupOptions).toHaveLength(1);
      expect(host.registry.getBacking(firstChatUri)?.lifecycle).toBe('materialized');

      const configured = await call(client, 'configure-created', 'chat/configure', {
        channel: firstChat,
        permissionMode: 'plan',
      });
      expect(configured).toMatchObject({
        result: { config: { modelId: 'model-a', effort: 'high', permissionMode: 'plan' } },
      });
      expect(host.registry.getBacking(firstChatUri)?.desiredConfig).toMatchObject({
        model: 'model-a',
        effort: 'high',
        permissionMode: 'plan',
      });
      expect(harness.query.configCalls).toContainEqual(['setPermissionMode', 'plan']);
      const configuredAction = await client.next((message) => (
        message.method === 'state/action'
        && (message.params as { readonly action?: { readonly type?: unknown; readonly session?: { readonly permissionMode?: unknown } } } | undefined)?.action?.type === 'catalog/chatUpdated'
        && (message.params as { readonly action?: { readonly session?: { readonly permissionMode?: unknown } } } | undefined)?.action?.session?.permissionMode === 'plan'
      ));
      expect(configuredAction).toMatchObject({ params: { action: { session: { permissionMode: 'plan' } } } });
    } finally {
      await closeClient(client);
      await host.shutdown();
    }
  });

  it('drops unsupported createChat effort before backing and catalog publication', async () => {
    const harness = serviceHarness();
    const host = await createClaudeAgentHost(baseOptions(harness.service));
    host.hostStateManager.dispatchCatalog(root, {
      type: 'catalog/workspacesReplaced',
      workspaces: [createWorkspace({
        id: createWorkspaceId('workspace-create-effort'),
        path: '/tmp/create-effort-project',
        displayName: 'Create Effort Project',
      })],
      timestamp: 'catalog-workspace-create-effort',
    });
    host.hostStateManager.dispatchCatalog(root, {
      type: 'catalog/modelsReplaced',
      models: [createModel({
        id: createModelId('model-create-effort'),
        displayName: 'Create Effort Model',
        capabilities: ['effort'],
        supportedEffortLevels: ['low', 'medium'],
      })],
      defaultModelId: createModelId('model-create-effort'),
      timestamp: 'catalog-model-create-effort',
    });
    const client = await openClient(await listen(host));

    try {
      await call(client, 'initialize', 'initialize', {
        ...initializeParams(),
        initialSubscriptions: [root],
      });
      const response = await call(client, 'create-unsupported-effort', 'catalog/createChat', {
        channel: root,
        workspaceId: createWorkspaceId('workspace-create-effort'),
        modelId: createModelId('model-create-effort'),
        effort: 'high',
        clientSeq: 1,
        commandId: createCommandId('create-unsupported-effort'),
      });
      expect(response).toMatchObject({ result: { receipt: { status: 'accepted' } } });
      const action = await client.next((message) => (
        message.method === 'state/action'
        && (message.params as { readonly action?: { readonly type?: unknown } } | undefined)?.action?.type === 'catalog/chatCreated'
      ));
      const session = (action.params as { readonly action: { readonly session: { readonly effort?: unknown; readonly modelId?: unknown } } }).action.session;
      expect(session).toMatchObject({ modelId: 'model-create-effort' });
      expect(session).not.toHaveProperty('effort');
      const backing = host.registry.listBackings()[0];
      expect(backing?.desiredConfig).not.toHaveProperty('effort');
    } finally {
      await closeClient(client);
      await host.shutdown();
    }
  });

  it('composes an unlistened server and registers chats without SDK startup', async () => {
    const harness = serviceHarness();
    const host = await createClaudeAgentHost(baseOptions(harness.service));
    const backing = host.createChat({
      chatUri: chat,
      cwd: '/tmp/project',
      desiredConfig: { permissionMode: 'default' },
    });

    expect(host.server.server.listening).toBe(false);
    expect(backing.sdkSessionId).toBe(SDK_SESSION_ID);
    expect(backing.lifecycle).toBe('provisional');
    expect(host.hostStateManager.getState(chat)?.status).toBe('idle');
    expect(harness.startupOptions).toHaveLength(0);

    const health = await host.server.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok', protocolVersions: ['1.0.0'] });
    await host.shutdown();
  });

  it('single-flights concurrent first sends through one startup and query', async () => {
    const harness = serviceHarness();
    const sdkUuids: readonly UUID[] = [
      '00000000-0000-4000-8000-000000000111',
      '00000000-0000-4000-8000-000000000112',
    ];
    let uuidIndex = 0;
    const host = await createClaudeAgentHost({
      ...baseOptions(harness.service),
      createSdkUuid: () => {
        const uuid = sdkUuids[uuidIndex];
        uuidIndex += 1;
        if (uuid === undefined) {
          throw new Error('test UUIDs exhausted');
        }
        return uuid;
      },
    });
    host.createChat({ chatUri: chat, cwd: '/tmp/project', desiredConfig: { permissionMode: 'default' } });

    const first = host.registry.send(chat, createTurnId('concurrent-a'), 'first');
    const second = host.registry.send(chat, createTurnId('concurrent-b'), 'second');
    const handles = await Promise.all([first, second]);
    expect(handles.map((handle) => handle.turnId)).toEqual([
      createTurnId('concurrent-a'),
      createTurnId('concurrent-b'),
    ]);
    expect(harness.startupOptions).toHaveLength(1);
    expect(harness.warm.queryCalls).toBe(1);
    const input = harness.warm.queryInput;
    if (input === undefined) {
      throw new Error('runtime input has not been installed');
    }
    const iterator = input[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    await host.shutdown();
  });

  it('runs the real actor, runtime, bridge, and protocol over loopback WSS', async () => {
    const harness = serviceHarness();
    const host = await createClaudeAgentHost(baseOptions(harness.service));
    host.createChat({ chatUri: chat, cwd: '/tmp/project', desiredConfig: { permissionMode: 'default' } });
    const client = await openClient(await listen(host));

    try {
      await expect(call(client, 'initialize', 'initialize', initializeParams())).resolves.toMatchObject({
        result: { snapshots: [{ resource: chat }] },
      });
      client.socket.send(rpc('send', 'dispatchAction', {
        channel: chat,
        clientSeq: 1,
        commandId: createCommandId('send-1'),
        action: { type: 'chat/send', prompt: 'hello' },
      }));

      const started = await client.next((message) => (
        message.method === 'state/action'
        && (message.params as { action?: { type?: unknown } } | undefined)?.action?.type === 'chat/turnStarted'
      ));
      expect(started).toMatchObject({ params: { action: { type: 'chat/turnStarted', prompt: 'hello' } } });
      await client.next((message) => message.id === 'send');

      const userMessage = await harness.warm.acceptNext();
      expect(userMessage.message).toEqual({ role: 'user', content: 'hello' });
      for (const message of streamText('hello')) {
        harness.query.yield(message);
      }
      if (userMessage.uuid === undefined) {
        throw new Error('runtime user message is missing its UUID');
      }
      harness.query.yield(successMessage(userMessage.uuid));

      const actions: string[] = ['chat/turnStarted'];
      while (!actions.includes('chat/turnCompleted')) {
        const message = await client.next((candidate) => candidate.method === 'state/action');
        const action = (message.params as { action: { type: string } }).action;
        actions.push(action.type);
      }
      expect(actions).toContain('chat/responsePartAdded');
      expect(actions).toContain('chat/responsePartDelta');
      expect(actions).toContain('chat/turnCompleted');
      expect(host.hostStateManager.getState(chat)?.turns[0]).toMatchObject({
        prompt: 'hello',
        status: 'complete',
        parts: [{ kind: 'markdown', content: 'hello world' }],
      });
      expect(harness.warm.queryCalls).toBe(1);
      expect(harness.startupOptions).toHaveLength(1);
    } finally {
      await closeClient(client);
      await host.shutdown();
    }
  });

  it('applies the host ACL to loopback protocol commands before actor state changes', async () => {
    const harness = serviceHarness();
    const alice = createPrincipal({
      principalId: 'alice',
      tenantId: 'tenant-a',
      capabilities: ['subscribe'],
    });
    const acl = createAccessControlList([{
      resource: chat,
      tenantId: 'tenant-a',
      grants: [{ principalId: 'alice', capabilities: ['subscribe'] }],
    }]);
    const host = await createClaudeAgentHost({
      ...baseOptions(harness.service),
      principal: alice,
      acl,
    });
    host.createChat({ chatUri: chat, cwd: '/tmp/project', desiredConfig: { permissionMode: 'default' } });
    const client = await openClient(await listen(host));

    try {
      await expect(call(client, 'initialize', 'initialize', initializeParams())).resolves.toMatchObject({
        result: { snapshots: [{ resource: chat }] },
      });
      const denied = await call(client, 'send', 'dispatchAction', {
        channel: chat,
        clientSeq: 1,
        commandId: createCommandId('acl-denied-send'),
        action: { type: 'chat/send', prompt: 'must be denied' },
      });
      expect(denied).toEqual({
        jsonrpc: '2.0',
        id: 'send',
        error: { code: -32007, message: 'Authorization denied' },
      });
      expect(host.hostStateManager.serverSeq).toBe(0);
      expect(harness.startupOptions).toHaveLength(0);
    } finally {
      await closeClient(client);
      await host.shutdown();
    }
  });

  it('parks the official CanUseTool callback and resolves it through the protocol', async () => {
    const harness = serviceHarness();
    const host = await createClaudeAgentHost(baseOptions(harness.service));
    host.createChat({ chatUri: chat, cwd: '/tmp/project', desiredConfig: { permissionMode: 'default' } });
    const client = await openClient(await listen(host));

    try {
      await call(client, 'initialize', 'initialize', initializeParams());
      client.socket.send(rpc('send', 'dispatchAction', {
        channel: chat,
        clientSeq: 1,
        commandId: createCommandId('interaction-send'),
        action: { type: 'chat/send', prompt: 'permission prompt' },
      }));
      await client.next((message) => (
        message.method === 'state/action'
        && (message.params as { action?: { type?: unknown } } | undefined)?.action?.type === 'chat/turnStarted'
      ));
      await client.next((message) => message.id === 'send');

      const callback = harness.startupOptions[0]?.canUseTool;
      if (callback === undefined) {
        throw new Error('host did not install an SDK permission callback');
      }
      const waiter = callback('Bash', { command: 'echo approved' }, {
        signal: new AbortController().signal,
        toolUseID: 'tool-use-interaction',
        requestId: 'request-interaction',
      });
      const requested = await client.next((message) => (
        message.method === 'state/action'
        && (message.params as { action?: { type?: unknown } } | undefined)?.action?.type === 'chat/approvalRequested'
      ));
      const approvalId = (requested.params as { action: { approvalId: string } }).action.approvalId;
      const resolved = await call(client, 'resolve', 'chat/resolveApproval', {
        channel: chat,
        clientSeq: 2,
        commandId: createCommandId('resolve-interaction'),
        approvalId,
        decision: 'allow',
      });
      expect(resolved.result).toMatchObject({
        receipt: { status: 'accepted', value: { status: 'resolved', kind: 'approval', id: approvalId } },
      });
      await expect(waiter).resolves.toMatchObject({
        behavior: 'allow',
        updatedInput: { command: 'echo approved' },
      });

      const retry = await call(client, 'resolve-retry', 'chat/resolveApproval', {
        channel: chat,
        clientSeq: 3,
        commandId: createCommandId('resolve-retry'),
        approvalId,
        decision: 'deny',
      });
      expect(retry.result).toMatchObject({
        receipt: { status: 'accepted', value: { status: 'already_resolved', kind: 'approval', id: approvalId } },
      });

      const inputWaiter = callback('AskUserQuestion', {
        questions: [{
          question: 'Which mode should be used?',
          header: 'Mode',
          multiSelect: false,
          options: [
            { label: 'Fast', description: 'Use the fast mode' },
            { label: 'Safe', description: 'Use the safe mode' },
          ],
        }],
      }, {
        signal: new AbortController().signal,
        toolUseID: 'input-tool-interaction',
        requestId: 'input-request-interaction',
      });
      const inputRequested = await client.next((message) => (
        message.method === 'state/action'
        && (message.params as { action?: { type?: unknown } } | undefined)?.action?.type === 'chat/inputRequested'
      ));
      const inputId = (inputRequested.params as { action: { inputId: string } }).action.inputId;
      const inputResolved = await call(client, 'resolve-input', 'chat/resolveInput', {
        channel: chat,
        clientSeq: 4,
        commandId: createCommandId('resolve-input-interaction'),
        inputId,
        answers: { 'Which mode should be used?': 'Safe' },
      });
      expect(inputResolved.result).toMatchObject({
        receipt: { status: 'accepted', value: { status: 'resolved', kind: 'input', id: inputId } },
      });
      await expect(inputWaiter).resolves.toMatchObject({
        behavior: 'allow',
        updatedInput: { answers: { 'Which mode should be used?': 'Safe' } },
      });
      expect(host.interactionRegistry.size).toBe(0);
    } finally {
      await closeClient(client);
      await host.shutdown();
    }
  });

  it('uses the exact history arguments and hydrates through turnsLoaded', async () => {
    const harness = serviceHarness(historyMessages());
    const host = await createClaudeAgentHost(baseOptions(harness.service));
    host.createChat({
      chatUri: chat,
      cwd: '/tmp/project',
      desiredConfig: { permissionMode: 'default' },
    });

    const envelope = await host.loadHistory(chat, 'history-action');
    expect(harness.historyCalls).toEqual([
      [SDK_SESSION_ID, { dir: '/tmp/project', includeSystemMessages: true }],
    ]);
    expect(envelope?.action).toMatchObject({ type: 'chat/turnsLoaded', timestamp: 'history-action' });
    expect(host.hostStateManager.getState(chat)?.turns).toMatchObject([
      { prompt: 'history prompt', status: 'complete' },
    ]);
    await host.shutdown();
  });

  it('does not register a chat when the persisted write fails', async () => {
    const harness = serviceHarness();
    const repository = new FakeOverlayRepository();
    const failure = new Error('database unavailable');
    repository.failSave = failure;
    const host = await createClaudeAgentHost(persistedHostOptions(harness.service, repository, []));

    await expect(host.createChatPersisted({
      chatUri: chat,
      cwd: '/tmp/project',
      desiredConfig: { permissionMode: 'default' },
    })).rejects.toBe(failure);
    expect(host.registry.size).toBe(0);
    expect(host.hostStateManager.getState(chat)).toBeUndefined();
    expect(repository.calls).toEqual(['list', 'save:start']);
    await host.shutdown();
  });

  it('restores a materialized backing with its SDK session and resumes after restart', async () => {
    const harness = serviceHarness();
    const repository = new FakeOverlayRepository();
    const firstSessions: ClaudeAgentHostRuntimeSession[] = [];
    const firstHost = await createClaudeAgentHost(
      persistedHostOptions(harness.service, repository, firstSessions),
    );
    await firstHost.createChatPersisted({
      chatUri: chat,
      sdkSessionId: 'persisted-sdk-session',
      cwd: '/tmp/project',
      desiredConfig: { permissionMode: 'default', model: 'sonnet', effort: 'high' },
      title: 'Persisted chat',
      archived: true,
    });
    await firstHost.registry.materialize(chat);
    expect(repository.rows.get(chat)?.lifecycle).toBe('materialized');
    expect(firstSessions).toEqual([{
      kind: 'new',
      sessionId: 'persisted-sdk-session',
    }]);
    await firstHost.shutdown();

    const secondSessions: ClaudeAgentHostRuntimeSession[] = [];
    const secondService: ClaudeAgentHostSdkService = {
      ...harness.service,
      listSessions: () => [{
        sessionId: 'persisted-sdk-session',
        summary: 'SDK title should not replace overlay metadata',
        lastModified: 1_700_000_000_000,
        cwd: '/tmp/project',
      }],
      listSupportedModels: () => [{
        value: 'sonnet',
        displayName: 'Claude Sonnet',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high'],
      } as CatalogSdkModelInfo],
    };
    const secondHost = await createClaudeAgentHost(
      persistedHostOptions(secondService, repository, secondSessions),
    );
    const restored = await secondHost.loadPersistedChats();
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({
      chatUri: chat,
      sdkSessionId: 'persisted-sdk-session',
      lifecycle: 'materialized',
    });
    const refreshed = await secondHost.refreshCatalog();
    expect(refreshed.sessions).toMatchObject([{
      chatUri: chat,
      sdkSessionRef: 'persisted-sdk-session',
      title: 'Persisted chat',
      archived: true,
      modelId: 'sonnet',
      effort: 'high',
    }]);
    await secondHost.registry.send(chat, createTurnId('restart-turn'), 'resume');
    expect(secondSessions).toEqual([{
      kind: 'resume',
      sessionId: 'persisted-sdk-session',
    }]);
    await secondHost.shutdown();
  });

  it('keeps SDK transcript loading outside the overlay persistence path', async () => {
    const harness = serviceHarness(historyMessages());
    const repository = new FakeOverlayRepository();
    const host = await createClaudeAgentHost(persistedHostOptions(harness.service, repository, []));
    await host.createChatPersisted({
      chatUri: chat,
      cwd: '/tmp/project',
      desiredConfig: { permissionMode: 'default' },
    });

    expect(harness.historyCalls).toHaveLength(0);
    expect(JSON.stringify([...repository.rows.values()])).not.toContain('history prompt');
    await host.loadHistory(chat, 'history-action');
    expect(harness.historyCalls).toHaveLength(1);
    expect(JSON.stringify([...repository.rows.values()])).not.toContain('history answer');
    await host.shutdown();
  });

  it('deletes persistence before memory and closes the repository on shutdown', async () => {
    const harness = serviceHarness();
    const repository = new FakeOverlayRepository();
    const host = await createClaudeAgentHost(persistedHostOptions(harness.service, repository, []));
    await host.createChatPersisted({
      chatUri: chat,
      cwd: '/tmp/project',
      desiredConfig: { permissionMode: 'default' },
    });

    expect(await host.disposeChatPersisted(chat)).toBe(true);
    expect(repository.rows.has(chat)).toBe(false);
    expect(host.registry.getBacking(chat)).toBeUndefined();
    expect(host.hostStateManager.getState(chat)).toBeUndefined();
    await host.shutdown();
    expect(repository.closeCalls).toBe(1);
    expect(repository.calls.indexOf('delete:commit')).toBeLessThan(repository.calls.indexOf('close'));
  });

  it('preserves injected permission callback and safely denies by default', async () => {
    const defaultHarness = serviceHarness();
    const defaultHost = await createClaudeAgentHost(baseOptions(defaultHarness.service));
    defaultHost.createChat({ chatUri: chat, cwd: '/tmp/project', desiredConfig: { permissionMode: 'default' } });
    await defaultHost.chatRegistry.send(chat, createTurnId('default-turn'), 'default');
    const defaultOptions = defaultHarness.startupOptions[0];
    if (defaultOptions?.canUseTool === undefined) {
      throw new Error('default permission callback was not installed');
    }
    await defaultOptions.canUseTool('Bash', {}, {
      signal: new AbortController().signal,
      toolUseID: 'tool-1',
      requestId: 'request-1',
    });
    await expect(defaultOptions.canUseTool('Bash', {}, {
      signal: new AbortController().signal,
      toolUseID: 'tool-1',
      requestId: 'request-1',
    })).resolves.toEqual({ behavior: 'deny', message: 'Tool approval is not configured' });
    await defaultHost.shutdown();

    const injectedHarness = serviceHarness();
    const injected: CanUseTool = async () => ({ behavior: 'deny', message: 'injected' });
    const injectedHost = await createClaudeAgentHost({
      ...baseOptions(injectedHarness.service),
      canUseTool: injected,
    });
    injectedHost.createChat({ chatUri: chat, cwd: '/tmp/project', desiredConfig: { permissionMode: 'default' } });
    await injectedHost.chatRegistry.send(chat, createTurnId('injected-turn'), 'injected');
    expect(injectedHarness.startupOptions[0]?.canUseTool).toBe(injected);
    await injectedHost.shutdown();
  });

  it('prevents duplicate chat or SDK identities without extra host state', async () => {
    const harness = serviceHarness();
    const host = await createClaudeAgentHost(baseOptions(harness.service));
    host.createChat({ chatUri: chat, cwd: '/tmp/project', desiredConfig: { permissionMode: 'default' } });
    expect(() => host.createChat({
      chatUri: chat,
      cwd: '/tmp/project',
      desiredConfig: { permissionMode: 'default' },
    })).toThrow('chat resource is already registered');
    const secondChat = createChatUri('session-1', 'chat-2');
    expect(() => host.createChat({
      chatUri: secondChat,
      cwd: '/tmp/project',
      desiredConfig: { permissionMode: 'default' },
    })).toThrow('sdkSessionId is already registered');
    expect(host.chatRegistry.size).toBe(1);
    expect(host.hostStateManager.getState(secondChat)).toBeUndefined();
    await host.shutdown();
  });

  it('closes live sockets and drains runtime resources once', async () => {
    const harness = serviceHarness();
    const host = await createClaudeAgentHost(baseOptions(harness.service));
    host.createChat({ chatUri: chat, cwd: '/tmp/project', desiredConfig: { permissionMode: 'default' } });
    const client = await openClient(await listen(host));
    await call(client, 'initialize', 'initialize', initializeParams());
    client.socket.send(rpc('send', 'dispatchAction', {
      channel: chat,
      clientSeq: 1,
      commandId: createCommandId('shutdown-send'),
      action: { type: 'chat/send', prompt: 'shutdown' },
    }));
    await client.next((message) => message.method === 'state/action');
    await client.next((message) => message.id === 'send');

    const firstShutdown = host.shutdown();
    expect(host.shutdown()).toBe(firstShutdown);
    await firstShutdown;
    if (client.socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => client.socket.once('close', resolve));
    }
    expect(client.socket.readyState).toBe(WebSocket.CLOSED);
    expect(harness.query.returnCalls).toBe(1);
    expect(harness.warm.disposeCalls).toBe(1);
    expect(() => host.createChat({
      chatUri: createChatUri('session-1', 'after-shutdown'),
      cwd: '/tmp/project',
      desiredConfig: { permissionMode: 'default' },
    })).toThrow('shutting down');
    await expect(host.loadHistory(chat)).rejects.toThrow('shutting down');
  });
});
