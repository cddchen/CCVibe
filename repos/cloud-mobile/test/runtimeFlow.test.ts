import { describe, expect, it } from 'vitest';

import { createRootUri, type ChatUri } from '../src/protocol/resourceUri';
import {
  CloudRuntime,
  type CloudRuntimeDependencies,
  type RuntimeSupervisor,
} from '../src/features/runtime/runtimeStore';

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
});
