import { describe, expect, it } from 'vitest';

import {
  CATALOG_ACTION_TYPES,
  catalogReducer,
  createCatalogSession,
  createModel,
  createRootCatalogState,
  createWorkspace,
  createChatUri,
  createModelId,
  createWorkspaceId,
  createRootUri,
  type CatalogSession,
} from '../../src/index.js';

const root = createRootUri();
const workspaceId = createWorkspaceId('workspace-a');
const modelId = createModelId('model-a');
const workspace = createWorkspace({
  id: workspaceId,
  path: '/tmp/workspace-a',
  displayName: 'Workspace A',
});
const model = createModel({
  id: modelId,
  displayName: 'Model A',
  capabilities: ['effort', 'adaptive-thinking'],
});

function session(chatId: string): CatalogSession {
  return createCatalogSession({
    chatUri: createChatUri('workspace-a', chatId),
    sdkSessionRef: `sdk-${chatId}`,
    workspaceId,
    title: `Chat ${chatId}`,
    updatedAt: '2026-08-29T00:00:00.000Z',
    status: 'idle',
    archived: false,
  });
}

describe('root catalog domain', () => {
  it('creates an immutable state and reduces host, workspace, model, and chat projections', () => {
    const initial = createRootCatalogState({
      resource: root,
      host: { id: 'host-a', displayName: 'Host A' },
      modifiedAt: 't0',
    });
    const withCatalog = catalogReducer(initial, {
      type: CATALOG_ACTION_TYPES.workspacesReplaced,
      workspaces: [workspace],
      timestamp: 't1',
    });
    const withModel = catalogReducer(withCatalog, {
      type: CATALOG_ACTION_TYPES.modelsReplaced,
      models: [model],
      defaultModelId: modelId,
      timestamp: 't2',
    });
    const withChat = catalogReducer(withModel, {
      type: CATALOG_ACTION_TYPES.chatCreated,
      session: session('chat-a'),
      timestamp: 't3',
    });

    expect(withChat.resource).toBe(root);
    expect(withChat.workspaces).toEqual([workspace]);
    expect(withChat.models).toEqual([model]);
    expect(withChat.defaultModelId).toBe(modelId);
    expect(withChat.sessions).toHaveLength(1);
    expect(Object.isFrozen(withChat)).toBe(true);
    expect(Object.isFrozen(withChat.sessions)).toBe(true);
    expect(() => (withChat.sessions as CatalogSession[]).push(session('chat-b'))).toThrow();
  });

  it('upserts the same chat without duplicates and supports removal', () => {
    const initial = createRootCatalogState({
      host: { id: 'host-a', displayName: 'Host A' },
      modifiedAt: 't0',
      sessions: [session('chat-a')],
    });
    const same = catalogReducer(initial, {
      type: CATALOG_ACTION_TYPES.chatCreated,
      session: session('chat-a'),
      timestamp: 't1',
    });
    const removed = catalogReducer(same, {
      type: CATALOG_ACTION_TYPES.chatRemoved,
      chatUri: createChatUri('workspace-a', 'chat-a'),
      timestamp: 't2',
    });

    expect(same).toBe(initial);
    expect(removed.sessions).toEqual([]);
  });
});
