import { describe, expect, it } from 'vitest';

import {
  createModel,
  createModelId,
  createWorkspace,
  createWorkspaceId,
} from '../../src/index.js';
import {
  projectCatalogSessions,
  type CatalogListSessionsResult,
} from '../../src/claude/catalogSource.js';

describe('catalog SDK projection', () => {
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
