import { describe, expect, it } from 'vitest';

import {
  selectHomeViewModel,
  type HomeSelectorInput,
} from '../src/features/home/homeSelectors';
import { createRootUri, parseChatUri } from '../src/protocol/resourceUri';

const root = createRootUri();

function catalog(overrides: Partial<NonNullable<HomeSelectorInput['catalog']>> = {}): NonNullable<HomeSelectorInput['catalog']> {
  return {
    resource: root,
    host: { id: 'host-a', displayName: '真实 Host' },
    connection: { status: 'connected', displayStatus: 'online' },
    workspaces: [{ id: 'workspace-a', path: '/workspace/a', displayName: '真实工作区', status: 'available' }],
    sessions: [{
      chatUri: parseChatUri('agent-chat://session-a/chat-a'),
      sdkSessionRef: 'opaque-sdk-ref',
      workspaceId: 'workspace-a',
      title: '真实会话',
      updatedAt: '2026-08-29T00:00:00.000Z',
      status: 'idle',
      archived: false,
    }],
    models: [{ id: 'model-a', displayName: '真实模型', capabilities: [] }],
    modifiedAt: '2026-08-29T00:00:00.000Z',
    ...overrides,
  };
}

function input(overrides: Partial<HomeSelectorInput> = {}): HomeSelectorInput {
  return {
    phase: 'ready',
    syncStatus: 'connected',
    catalog: catalog(),
    selectedWorkspaceId: 'workspace-a',
    selectedModelId: 'model-a',
    operationError: undefined,
    ...overrides,
  };
}

describe('home selectors', () => {
  it('projects real Host catalog values and groups sessions by workspace', () => {
    const result = selectHomeViewModel(input());

    expect(result.hostName).toBe('真实 Host');
    expect(result.workspaces[0]?.name).toBe('真实工作区');
    expect(result.models[0]?.displayName).toBe('真实模型');
    expect(result.groups[0]?.workspaceName).toBe('真实工作区');
    expect(result.groups[0]?.sessions[0]?.title).toBe('真实会话');
    expect(result.mode).toBe('ready');
  });

  it('keeps complete explicit states for loading, disconnected, empty catalogs, and errors', () => {
    expect(selectHomeViewModel(input({ phase: 'loading', catalog: undefined })).mode).toBe('loading');
    expect(selectHomeViewModel(input({ syncStatus: 'paused', catalog: undefined })).mode).toBe('disconnected');
    expect(selectHomeViewModel(input({ catalog: catalog({ workspaces: [] }) })).mode).toBe('no-workspace');
    expect(selectHomeViewModel(input({ catalog: catalog({ models: [] }) })).mode).toBe('no-model');
    expect(selectHomeViewModel(input({ phase: 'error', operationError: { code: 'HOST_ERROR' } })).mode).toBe('error');
  });

  it('falls back from stale selections to the Host default and available values', () => {
    const result = selectHomeViewModel(input({
      selectedWorkspaceId: 'missing-workspace',
      selectedModelId: 'missing-model',
      catalog: catalog({ defaultModelId: 'model-a' }),
    }));

    expect(result.selectedWorkspaceId).toBe('workspace-a');
    expect(result.selectedModelId).toBe('model-a');
  });
});
