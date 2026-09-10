import { describe, expect, it } from 'vitest';

import { createChatUri, createRootUri, type ChatUri } from '../src/protocol/resourceUri';
import type { HostCreateChatParams, HostRootCatalogState } from '../src/protocol/hostWire';
import {
  CloudRuntime,
  type CloudRuntimeDependencies,
  type RuntimeSupervisor,
} from '../src/features/runtime/runtimeStore';
import { TransportRpcError } from '../src/sync/transport';

function createCatalog(): HostRootCatalogState {
  return {
    resource: createRootUri(),
    host: { id: 'host-a', displayName: 'Host A' },
    connection: { status: 'connected' as const, displayStatus: 'online' as const },
    workspaces: [{ id: 'workspace-a', path: '/workspace/a', displayName: 'Workspace A', status: 'available' as const }],
    sessions: [],
    models: [{ id: 'model-a', displayName: 'Model A', capabilities: [] as const }],
    defaultModelId: 'model-a',
    modifiedAt: 't0',
  };
}

function createSupervisorHarness(): {
  readonly supervisor: RuntimeSupervisor;
  readonly calls: string[];
  readonly createParams: { commandId?: string };
  readonly dispatchParams: { clientSeq?: number; commandId?: string; action?: unknown };
} {
  const calls: string[] = [];
  const chatUri = 'agent-chat://session-a/chat-a' as ChatUri;
  const createParams: { commandId?: string } = {};
  const dispatchParams: { clientSeq?: number; commandId?: string; action?: unknown } = {};
  const supervisor: RuntimeSupervisor = {
    getState: () => ({
      status: 'connected',
      address: 'wss://host.example.test',
      hostEpoch: 'epoch-a',
      lastSeenServerSeq: 0,
      subscriptions: [createRootUri()],
      resources: [{ resource: createRootUri(), state: createCatalog(), lastServerSeq: 0 }],
      missing: [],
    }),
    start: () => undefined,
    stop: () => undefined,
    retryNow: () => undefined,
    subscribe: async (resource) => { calls.push(`subscribe:${resource}`); },
    createChat: async (params) => {
      calls.push('create');
      createParams.commandId = params.commandId;
      return { receipt: { status: 'accepted' as const, value: { chatUri } } };
    },
    dispatchAction: async (params) => {
      calls.push('send');
      dispatchParams.clientSeq = params.clientSeq;
      dispatchParams.commandId = params.commandId;
      dispatchParams.action = params.action;
      return { receipt: { status: 'rejected' as const, code: 'CHAT_BUSY', message: 'busy' } };
    },
  };
  return { supervisor, calls, createParams, dispatchParams };
}

function dependencies(supervisor: RuntimeSupervisor): CloudRuntimeDependencies {
  return {
    asyncStorage: {
      getItem: async () => null,
      setItem: async () => undefined,
      removeItem: async () => undefined,
    },
    tokenStore: {
      read: async () => null,
      write: async () => undefined,
      clear: async () => undefined,
    },
    appState: { currentState: () => 'active', subscribe: () => () => undefined },
    createSupervisor: () => supervisor,
    createId: (() => {
      let next = 0;
      return () => `id-${++next}`;
    })(),
    clientId: 'client-a',
  };
}

describe('Cloud runtime new-chat flow', () => {
  it('canonicalizes stale composer preferences before creating a chat', async () => {
    const harness = createSupervisorHarness();
    let created: HostCreateChatParams | undefined;
    const chatUri = createChatUri('session-canonical', 'chat-canonical');
    const supervisor: RuntimeSupervisor = {
      ...harness.supervisor,
      createChat: async (params) => {
        created = params;
        return { receipt: { status: 'accepted' as const, value: { chatUri } } };
      },
      dispatchAction: async () => ({ receipt: { status: 'accepted' as const, value: { acceptedAtSeq: 1 } } }),
    };
    const runtime = new CloudRuntime(dependencies(supervisor));
    runtime.hydrateForTest({
      catalog: {
        ...createCatalog(),
        models: [{ id: 'model-default', displayName: 'Default', capabilities: ['effort'], supportedEffortLevels: ['low'] }],
        defaultModelId: 'model-default',
        permissionModes: [{ id: 'default', displayName: '默认', description: 'Host 默认权限' }],
        defaultPermissionMode: 'default',
      },
      selection: {
        workspaceId: 'workspace-a',
        modelId: 'removed-model',
        effort: 'high',
        permissionMode: 'plan',
      },
      syncStatus: 'connected',
      supervisor,
    });

    expect(runtime.getState().selection).toEqual({ workspaceId: 'workspace-a', modelId: 'model-default', permissionMode: 'default' });
    const result = await runtime.actions.createChatAndSend({
      prompt: '使用当前配置',
      workspaceId: 'workspace-a',
      modelId: 'removed-model',
      effort: 'high',
      permissionMode: 'plan',
    });

    expect(result).toEqual({ status: 'accepted', chatUri });
    expect(created).toMatchObject({
      workspaceId: 'workspace-a',
      modelId: 'model-default',
      permissionMode: 'default',
    });
    expect(created).not.toHaveProperty('effort');
  });

  it('refreshes sessions through the connected supervisor and keeps the Host snapshot authoritative', async () => {
    const harness = createSupervisorHarness();
    let refreshCalls = 0;
    const supervisor: RuntimeSupervisor = {
      ...harness.supervisor,
      refreshCatalog: async () => {
        refreshCalls += 1;
        return {
          snapshot: {
            resource: createRootUri(),
            state: createCatalog(),
            fromSeq: 4,
          },
        };
      },
    };
    const runtime = new CloudRuntime(dependencies(supervisor));
    runtime.hydrateForTest({ catalog: createCatalog(), syncStatus: 'connected', supervisor });

    const result = await runtime.actions.refreshSessions();

    expect(result.status).toBe('accepted');
    expect(refreshCalls).toBe(1);
    expect(runtime.getState().refreshingSessions).toBe(false);
    expect(runtime.getState().operationError).toBeUndefined();
  });

  it('normalizes refresh failures while preserving last-known-good sessions', async () => {
    const harness = createSupervisorHarness();
    const previous = {
      ...createCatalog(),
      sessions: [{
        chatUri: createChatUri('session-a', 'chat-a'),
        sdkSessionRef: 'sdk-a',
        workspaceId: 'workspace-a',
        title: 'Existing session',
        updatedAt: '2026-09-08T00:00:00.000Z',
        status: 'idle' as const,
        archived: false,
      }],
    };
    const supervisor: RuntimeSupervisor = {
      ...harness.supervisor,
      refreshCatalog: async () => {
        throw new TransportRpcError({ code: -32005, message: 'Command rejected' });
      },
    };
    const runtime = new CloudRuntime(dependencies(supervisor));
    runtime.hydrateForTest({ catalog: previous, syncStatus: 'connected', supervisor });

    const result = await runtime.actions.refreshSessions();

    expect(result).toMatchObject({ status: 'error', operation: 'refresh', code: 'RPC_ERROR' });
    expect(runtime.getState().refreshingSessions).toBe(false);
    expect(runtime.getState().operationError).toMatchObject({ operation: 'refresh', code: 'RPC_ERROR' });
    expect(runtime.getState().sync.resources[0]).toMatchObject({ state: { sessions: previous.sessions } });
  });

  it('does not issue a refresh request while disconnected', async () => {
    const harness = createSupervisorHarness();
    const runtime = new CloudRuntime(dependencies(harness.supervisor));

    const result = await runtime.actions.refreshSessions();

    expect(result).toEqual({ status: 'error', operation: 'refresh', code: 'NOT_CONNECTED' });
    expect(runtime.getState().operationError).toEqual({ operation: 'refresh', code: 'NOT_CONNECTED' });
  });

  it('creates, subscribes, sends with independent command identities, and preserves a failed send for retry', async () => {
    const harness = createSupervisorHarness();
    const runtime = new CloudRuntime(dependencies(harness.supervisor));
    runtime.hydrateForTest({ catalog: createCatalog(), syncStatus: 'connected', supervisor: harness.supervisor });

    const result = await runtime.actions.createChatAndSend({
      prompt: '检查连接',
      workspaceId: 'workspace-a',
      modelId: 'model-a',
    });

    expect(result).toMatchObject({ status: 'error', chatUri: 'agent-chat://session-a/chat-a', operation: 'send' });
    expect(runtime.getState().pendingSend).toEqual({
      chatUri: 'agent-chat://session-a/chat-a',
      prompt: '检查连接',
    });
    expect(harness.calls).toEqual(['create', 'subscribe:agent-chat://session-a/chat-a', 'send']);

    expect(harness.dispatchParams.action).toEqual({ type: 'chat/send', prompt: '检查连接' });
    expect(harness.dispatchParams.clientSeq).toBeGreaterThan(1);
    expect(harness.dispatchParams.commandId).not.toBe(harness.createParams.commandId);
  });

  it('subscribes before sending a configuration mutation to the Host', async () => {
    const harness = createSupervisorHarness();
    const chatUri = 'agent-chat://session-a/chat-a' as ChatUri;
    let configured: unknown;
    const supervisor: RuntimeSupervisor = {
      ...harness.supervisor,
      configureChat: async (params) => {
        configured = params;
        return { config: { modelId: params.modelId, effort: params.effort, permissionMode: params.permissionMode ?? 'default' } };
      },
    };
    const runtime = new CloudRuntime(dependencies(supervisor));
    runtime.hydrateForTest({ catalog: createCatalog(), syncStatus: 'connected', supervisor });

    const result = await runtime.actions.configureChat({ channel: chatUri, modelId: 'model-a', effort: 'high', permissionMode: 'plan' });

    expect(result).toMatchObject({ status: 'accepted', operation: 'configure', chatUri });
    expect(harness.calls).toContain(`subscribe:${chatUri}`);
    expect(configured).toEqual({ channel: chatUri, modelId: 'model-a', effort: 'high', permissionMode: 'plan' });
  });

  it('resolves a manually entered workspace through the Host and selects its returned id', async () => {
    const harness = createSupervisorHarness();
    const resolvedWorkspace = {
      id: 'workspace-resolved',
      path: '/tmp/resolved-workspace',
      displayName: 'Resolved Workspace',
      status: 'available' as const,
    };
    let params: unknown;
    const supervisor: RuntimeSupervisor = {
      ...harness.supervisor,
      resolveWorkspace: async (request) => {
        params = request;
        return { workspace: resolvedWorkspace };
      },
    };
    const runtime = new CloudRuntime(dependencies(supervisor));
    runtime.hydrateForTest({ catalog: createCatalog(), syncStatus: 'connected', supervisor });

    const result = await runtime.actions.resolveWorkspace('/tmp/resolved-workspace');

    expect(result).toEqual({ status: 'accepted', workspace: resolvedWorkspace });
    expect(params).toEqual({ channel: 'agent-root://', path: '/tmp/resolved-workspace' });
    expect(runtime.getState().selection.workspaceId).toBe('workspace-resolved');
  });

  it('maps stable Host workspace validation codes to local user-facing copy', async () => {
    const harness = createSupervisorHarness();
    const path = '/private/secret/path';
    const supervisor: RuntimeSupervisor = {
      ...harness.supervisor,
      resolveWorkspace: async () => {
        throw new TransportRpcError({
          code: -32004,
          message: 'Resource not found',
          data: { code: 'WORKSPACE_NOT_FOUND' },
        });
      },
    };
    const runtime = new CloudRuntime(dependencies(supervisor));
    runtime.hydrateForTest({ catalog: createCatalog(), syncStatus: 'connected', supervisor });

    const result = await runtime.actions.resolveWorkspace(path);

    expect(result).toEqual({
      status: 'error',
      operation: 'workspace',
      code: 'WORKSPACE_NOT_FOUND',
      message: '找不到这个工作区路径',
    });
    expect(runtime.getState().operationError).toEqual({
      operation: 'workspace',
      code: 'WORKSPACE_NOT_FOUND',
      message: '找不到这个工作区路径',
    });
    expect(JSON.stringify(result)).not.toContain(path);
    expect(JSON.stringify(result)).not.toContain('Resource not found');
  });
});
