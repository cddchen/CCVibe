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
    workspaceSortPreference: 'default',
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

  it('sorts workspace groups by their latest unarchived session when requested', () => {
    const result = selectHomeViewModel(input({
      workspaceSortPreference: 'recent_workspace',
      catalog: catalog({
        workspaces: [
          { id: 'workspace-z', path: '/workspace/z', displayName: 'Zeta', status: 'available' },
          { id: 'workspace-a', path: '/workspace/a', displayName: 'Alpha', status: 'available' },
          { id: 'workspace-b', path: '/workspace/b', displayName: 'Beta', status: 'available' },
        ],
        sessions: [
          {
            chatUri: parseChatUri('agent-chat://workspace-z/chat-old'),
            sdkSessionRef: 'sdk-z-old',
            workspaceId: 'workspace-z',
            title: 'Zeta old',
            updatedAt: '2026-08-28T00:00:00.000Z',
            status: 'idle',
            archived: false,
          },
          {
            chatUri: parseChatUri('agent-chat://workspace-z/chat-new'),
            sdkSessionRef: 'sdk-z-new',
            workspaceId: 'workspace-z',
            title: 'Zeta new',
            updatedAt: '2026-08-30T00:00:00.000Z',
            status: 'idle',
            archived: false,
          },
          {
            chatUri: parseChatUri('agent-chat://workspace-a/chat-archived'),
            sdkSessionRef: 'sdk-a-archived',
            workspaceId: 'workspace-a',
            title: 'Archived should not count',
            updatedAt: '2026-09-01T00:00:00.000Z',
            status: 'idle',
            archived: true,
          },
          {
            chatUri: parseChatUri('agent-chat://workspace-a/chat-a'),
            sdkSessionRef: 'sdk-a',
            workspaceId: 'workspace-a',
            title: 'Alpha latest',
            updatedAt: '2026-08-29T00:00:00.000Z',
            status: 'idle',
            archived: false,
          },
          {
            chatUri: parseChatUri('agent-chat://workspace-b/chat-b'),
            sdkSessionRef: 'sdk-b',
            workspaceId: 'workspace-b',
            title: 'Beta latest',
            updatedAt: '2026-08-29T00:00:00.000Z',
            status: 'idle',
            archived: false,
          },
        ],
      }),
    }));

    expect(result.groups.map((group) => group.workspaceId)).toEqual([
      'workspace-z',
      'workspace-a',
      'workspace-b',
    ]);
    expect(result.groups[0]?.sessions.map((session) => session.title)).toEqual(['Zeta new', 'Zeta old']);
  });

  it('keeps the default workspace-name ordering and deterministic recent ties', () => {
    const baseCatalog = catalog({
      workspaces: [
        { id: 'workspace-b', path: '/workspace/b', displayName: 'Same', status: 'available' },
        { id: 'workspace-a', path: '/workspace/a', displayName: 'Same', status: 'available' },
      ],
      sessions: [
        {
          chatUri: parseChatUri('agent-chat://workspace-b/chat-b'),
          sdkSessionRef: 'sdk-b',
          workspaceId: 'workspace-b',
          title: 'B',
          updatedAt: '2026-08-29T00:00:00.000Z',
          status: 'idle',
          archived: false,
        },
        {
          chatUri: parseChatUri('agent-chat://workspace-a/chat-a'),
          sdkSessionRef: 'sdk-a',
          workspaceId: 'workspace-a',
          title: 'A',
          updatedAt: '2026-08-29T00:00:00.000Z',
          status: 'idle',
          archived: false,
        },
      ],
    });

    expect(selectHomeViewModel(input({ catalog: baseCatalog })).groups.map((group) => group.workspaceId))
      .toEqual(['workspace-a', 'workspace-b']);
    expect(selectHomeViewModel(input({ catalog: baseCatalog, workspaceSortPreference: 'recent_workspace' })).groups.map((group) => group.workspaceId))
      .toEqual(['workspace-a', 'workspace-b']);
  });
});
