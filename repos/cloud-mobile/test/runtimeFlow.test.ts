import { describe, expect, it } from 'vitest';

import { createRootUri, type ChatUri } from '../src/protocol/resourceUri';
import {
  CloudRuntime,
  type CloudRuntimeDependencies,
  type RuntimeSupervisor,
} from '../src/features/runtime/runtimeStore';
import { TransportRpcError } from '../src/sync/transport';

function createCatalog() {
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
