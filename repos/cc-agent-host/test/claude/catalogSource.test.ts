import { describe, expect, it } from 'vitest';

import {
  createModel,
  createModelId,
  createWorkspace,
  createWorkspaceId,
} from '../../src/index.js';
import {
  projectCatalogModels,
  projectCatalogSessions,
  projectCatalogWorkspaces,
  type CatalogSdkModelInfo,
  type CatalogListSessionsResult,
} from '../../src/claude/catalogSource.js';

describe('catalog SDK projection', () => {
  it('discovers stable, deduplicated workspaces from absolute session cwds', () => {
    const sessions = [
      {
        sessionId: 'session-a',
        summary: 'A',
        lastModified: 1,
        cwd: '/tmp/project/./',
        fileSize: 1,
      },
      {
        sessionId: 'session-b',
        summary: 'B',
        lastModified: 2,
        cwd: '/tmp/project',
        fileSize: 1,
      },
      {
        sessionId: 'session-c',
        summary: 'C',
        lastModified: 3,
        cwd: 'relative-project',
        fileSize: 1,
      },
    ] satisfies CatalogListSessionsResult;

    const first = projectCatalogWorkspaces(sessions);
    const second = projectCatalogWorkspaces(sessions);

    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      path: '/tmp/project',
      displayName: 'project',
      status: 'available',
    });
    expect(first[0]?.id).toMatch(/^workspace-[0-9a-f]{32}$/u);
  });

  it('projects only supported model fields and capability flags', () => {
    const models = [
      {
        value: 'sonnet',
        displayName: ' Claude Sonnet ',
        description: 'Fast model',
        supportsEffort: true,
        supportsAdaptiveThinking: true,
        supportsFastMode: false,
        supportsAutoMode: true,
        resolvedModel: 'claude-sonnet-5',
      },
      {
        value: 'invalid model',
        displayName: 'Invalid',
        description: 'not representable',
      },
    ] satisfies CatalogSdkModelInfo[];

    expect(projectCatalogModels(models)).toEqual([{
      id: createModelId('sonnet'),
      displayName: 'Claude Sonnet',
      description: 'Fast model',
      capabilities: ['effort', 'adaptive-thinking', 'auto-mode'],
    }]);
  });

  it('projects the typed listSessions result without leaking SDK metadata', () => {
    const workspace = createWorkspace({
      id: createWorkspaceId('workspace-a'),
      path: '/tmp/project',
      displayName: 'Project',
    });
    const _model = createModel({
      id: createModelId('model-a'),
      displayName: 'Model A',
    });
    const sdkSessions = [{
      sessionId: 'session-a',
      summary: 'SDK summary',
      customTitle: 'Pinned title',
      firstPrompt: 'first prompt',
      lastModified: 1_700_000_000_000,
      cwd: '/tmp/project',
      fileSize: 123,
    }] satisfies CatalogListSessionsResult;

    const sessions = projectCatalogSessions(sdkSessions, [workspace], 'epoch-1');

    expect(sessions).toEqual([{
      chatUri: 'agent-chat://epoch-1/session-a',
      sdkSessionRef: 'session-a',
      workspaceId: createWorkspaceId('workspace-a'),
      title: 'Pinned title',
      updatedAt: '2023-11-14T22:13:20.000Z',
      status: 'idle',
      archived: false,
    }]);
    expect(sessions[0]).not.toHaveProperty('fileSize');
    expect(sessions[0]).not.toHaveProperty('cwd');
    void _model;
  });
});
