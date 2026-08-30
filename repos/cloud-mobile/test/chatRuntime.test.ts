import { describe, expect, it } from 'vitest';

import { createRootUri, type ChatUri } from '../src/protocol/resourceUri';
import type { HostChatState, HostRootCatalogState } from '../src/protocol/hostWire';
import {
  CloudRuntime,
  type CloudRuntimeDependencies,
  type RuntimeSupervisor,
} from '../src/features/runtime/runtimeStore';

const chatUri = 'agent-chat://workspace-a/chat-a' as ChatUri;

function catalog(): HostRootCatalogState {
  return {
    resource: createRootUri(),
    host: { id: 'host-a', displayName: 'dev-host' },
    connection: { status: 'connected', displayStatus: 'online' },
    workspaces: [{ id: 'workspace-a', path: '/srv/cc-agent-host', displayName: 'cc-agent-host', status: 'available' }],
    sessions: [{ chatUri, sdkSessionRef: 'sdk-a', workspaceId: 'workspace-a', title: '连接诊断', updatedAt: 't0', status: 'in_progress', archived: false }],
    models: [{ id: 'model-a', displayName: 'GPT-5.6 Terra', capabilities: [] }],
    defaultModelId: 'model-a',
    modifiedAt: 't0',
  };
}

function chat(): HostChatState {
  return {
    resource: chatUri,
    status: 'input_needed',
    turns: [],
    activeTurn: { id: 'turn-a', prompt: '检查', status: 'active', parts: [], startedAt: 't0' },
    pendingApprovals: [{ id: 'approval-a', turnId: 'turn-a', toolName: '执行命令', input: { command: 'id' }, requestedAt: 't1' }],
    pendingInputs: [{ id: 'input-a', turnId: 'turn-a', questions: [{ header: '环境', question: '选择环境', multiSelect: true, options: [{ label: '远程', description: 'Host' }, { label: '本地', description: '本机' }] }], requestedAt: 't2' }],
    modifiedAt: 't2',
  };
}

function createHarness(): { readonly supervisor: RuntimeSupervisor; readonly calls: { readonly operation: string; readonly params: unknown }[] } {
  const calls: { operation: string; params: unknown }[] = [];
  const connected = { status: 'connected' as const, address: 'wss://test.invalid', hostEpoch: 'epoch-a', lastSeenServerSeq: 0, subscriptions: [createRootUri(), chatUri], resources: [], missing: [] };
  const supervisor: RuntimeSupervisor = {
    getState: () => connected,
    start: () => undefined,
    stop: () => undefined,
    retryNow: () => undefined,
    subscribe: async (resource) => { calls.push({ operation: 'subscribe', params: resource }); },
    createChat: async () => ({ receipt: { status: 'rejected' as const, code: 'UNUSED', message: 'unused' } }),
    dispatchAction: async (params) => {
      calls.push({ operation: 'dispatch', params });
      return { receipt: { status: 'accepted' as const, value: { acceptedAtSeq: 3, turnId: 'turn-b' } } };
    },
    resolveApproval: async (params) => {
      calls.push({ operation: 'approval', params });
      return { receipt: { status: 'accepted' as const, value: { status: 'already_resolved' as const, kind: 'approval' as const, id: params.approvalId } } };
    },
    resolveInput: async (params) => {
      calls.push({ operation: 'input', params });
      return { receipt: { status: 'accepted' as const, value: { status: 'resolved' as const, kind: 'input' as const, id: params.inputId } } };
    },
  };
  return { supervisor, calls };
}

function dependencies(supervisor: RuntimeSupervisor): CloudRuntimeDependencies {
  let next = 0;
  return {
    asyncStorage: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
    tokenStore: { read: async () => null, write: async () => undefined, clear: async () => undefined },
    appState: { currentState: () => 'active', subscribe: () => () => undefined },
    createSupervisor: () => supervisor,
    createId: () => `id-${++next}`,
    clientId: 'client-a',
  };
}

describe('Cloud runtime chat controller', () => {
  it('routes send and interrupt through canonical Host actions without mutating transcript optimistically', async () => {
    const harness = createHarness();
    const runtime = new CloudRuntime(dependencies(harness.supervisor));
    runtime.hydrateForTest({ catalog: catalog(), chat: { resource: chatUri, state: chat() }, supervisor: harness.supervisor });

    await expect(runtime.actions.sendChat({ chatUri, prompt: '  继续检查  ' })).resolves.toMatchObject({ status: 'accepted', operation: 'send' });
    await expect(runtime.actions.interruptChat({ chatUri, turnId: 'turn-a' })).resolves.toMatchObject({ status: 'accepted', operation: 'interrupt' });
    expect(harness.calls.map((call) => call.operation)).toEqual(['dispatch', 'dispatch']);
    expect((harness.calls[0]?.params as { readonly action: unknown }).action).toEqual({ type: 'chat/send', prompt: '继续检查' });
    expect((harness.calls[1]?.params as { readonly action: unknown }).action).toEqual({ type: 'chat/interrupt', turnId: 'turn-a' });
    expect(runtime.getState().sync.resources.find((entry) => entry.resource === chatUri)?.state).toEqual(chat());
  });

  it('routes allow, deny and structured answers with idempotent Host receipts', async () => {
    const harness = createHarness();
    const runtime = new CloudRuntime(dependencies(harness.supervisor));
    runtime.hydrateForTest({ catalog: catalog(), chat: { resource: chatUri, state: chat() }, supervisor: harness.supervisor });

    await expect(runtime.actions.allowApproval({ channel: chatUri, approvalId: 'approval-a', decision: 'allow' })).resolves.toMatchObject({ status: 'already_resolved', operation: 'approval', id: 'approval-a' });
    await expect(runtime.actions.denyApproval({ channel: chatUri, approvalId: 'approval-a', decision: 'deny' })).resolves.toMatchObject({ status: 'already_resolved', operation: 'approval' });
    await expect(runtime.actions.resolveInput({ channel: chatUri, inputId: 'input-a', answers: { '选择环境': '远程、 本地' } })).resolves.toMatchObject({ status: 'accepted', operation: 'input' });
    const approvalParams = harness.calls.find((call) => call.operation === 'approval')?.params as { readonly decision: string; readonly clientSeq: number; readonly commandId: string };
    expect(approvalParams.decision).toBe('allow');
    expect(approvalParams.clientSeq).toBeGreaterThan(0);
    expect(approvalParams.commandId).toContain('allow-');
  });
});
