import { describe, expect, it } from 'vitest';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';

import {
  createModel,
  createModelId,
  createWorkspace,
  createWorkspaceId,
} from '../../src/index.js';
import {
  projectCatalogModels,
  projectCatalogSessions,
  projectSessionConfiguration,
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
        supportedEffortLevels: ['low', 'medium', 'high'],
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
      supportedEffortLevels: ['low', 'medium', 'high'],
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

  it('projects optional session model and effort fields without requiring them', () => {
    const workspace = createWorkspace({
      id: createWorkspaceId('workspace-config'),
      path: '/tmp/config-project',
      displayName: 'Config Project',
    });
    const sessions = projectCatalogSessions([{
      sessionId: 'session-config',
      summary: 'Configured',
      lastModified: 1_700_000_000_000,
      cwd: workspace.path,
    }], [workspace], 'epoch-config', new Map([
      ['session-config', { modelId: createModelId('sonnet'), effort: 'high' }],
    ]), [createModel({
      id: createModelId('sonnet'),
      displayName: 'Sonnet',
      capabilities: ['effort'],
    })]);
    expect(sessions[0]).toMatchObject({ modelId: 'sonnet', effort: 'high' });
  });

  it('normalizes configuration-map values before publishing sessions', () => {
    const workspace = createWorkspace({
      id: createWorkspaceId('workspace-map-normalize'),
      path: '/tmp/map-normalize-project',
      displayName: 'Map Normalize Project',
    });
    const first = createModel({
      id: createModelId('first'),
      displayName: 'First',
      supportedEffortLevels: ['low', 'medium'],
    });
    const sessions = projectCatalogSessions([{
      sessionId: 'session-map-normalize',
      summary: 'Configured',
      lastModified: 1_700_000_000_000,
      cwd: workspace.path,
    }], [workspace], 'epoch-map-normalize', new Map([
      ['session-map-normalize', {
        modelId: createModelId('provider-model-not-in-catalog'),
        effort: 'xhigh',
      }],
    ]), [first]);

    expect(sessions[0]).toMatchObject({ modelId: first.id });
    expect(sessions[0]).not.toHaveProperty('effort');
  });

  it('uses the first real model when a session configuration is absent', () => {
    const workspace = createWorkspace({
      id: createWorkspaceId('workspace-empty-config'),
      path: '/tmp/empty-config-project',
      displayName: 'Empty Config Project',
    });
    const first = createModel({ id: createModelId('first-empty'), displayName: 'First Empty' });
    const second = createModel({ id: createModelId('second-empty'), displayName: 'Second Empty' });
    const sessions = projectCatalogSessions([{
      sessionId: 'session-empty-config',
      summary: 'No config',
      lastModified: 1_700_000_000_000,
      cwd: workspace.path,
    }], [workspace], 'epoch-empty-config', undefined, [first, second]);

    expect(sessions[0]).toMatchObject({ modelId: first.id });
  });

  it('extracts the latest actual assistant model from SDK transcript messages', () => {
    const messages = [
      {
        type: 'assistant',
        uuid: 'assistant-a',
        session_id: 'session-a',
        message: { role: 'assistant', model: 'old-model', content: [] },
        parent_tool_use_id: null,
        parent_agent_id: null,
      },
      {
        type: 'assistant',
        uuid: 'assistant-b',
        session_id: 'session-a',
        message: { role: 'assistant', model: 'sonnet', content: [] },
        parent_tool_use_id: null,
        parent_agent_id: null,
      },
    ] as const;
    expect(projectSessionConfiguration(messages as never, [createModel({ id: createModelId('sonnet'), displayName: 'Sonnet' })])).toEqual({ modelId: createModelId('sonnet') });
    expect(projectSessionConfiguration([{ ...messages[0], message: { role: 'assistant', model: 'not valid model', content: [] } }] as never)).toEqual({});
  });

  it('maps an unknown transcript model to the declared default and filters unsupported effort', () => {
    const models = [
      createModel({
        id: createModelId('first'),
        displayName: 'First',
        supportedEffortLevels: ['low', 'medium'],
      }),
      createModel({
        id: createModelId('default'),
        displayName: 'Default',
        supportedEffortLevels: ['low', 'medium', 'high'],
      }),
    ];
    const message = {
      type: 'assistant',
      uuid: 'assistant-unknown',
      session_id: 'session-unknown',
      message: { role: 'assistant', model: 'provider-specific-model', effort: 'xhigh', content: [] },
      parent_tool_use_id: null,
      parent_agent_id: null,
    } satisfies SessionMessage;

    expect(projectSessionConfiguration([message], models, createModelId('default')))
      .toEqual({ modelId: createModelId('default') });
    expect(projectSessionConfiguration([message], models))
      .toEqual({ modelId: createModelId('first') });
  });

  it('keeps only an effort level supported by the final catalog model', () => {
    const model = createModel({
      id: createModelId('sonnet'),
      displayName: 'Sonnet',
      capabilities: ['effort'],
      supportedEffortLevels: ['low', 'medium', 'high'],
    });
    const base = {
      type: 'assistant' as const,
      uuid: 'assistant-effort',
      session_id: 'session-effort',
      parent_tool_use_id: null,
      parent_agent_id: null,
    };

    expect(projectSessionConfiguration([{
      ...base,
      message: { role: 'assistant', model: 'sonnet', effort: 'high', content: [] },
    }], [model])).toEqual({ modelId: model.id, effort: 'high' });
    expect(projectSessionConfiguration([{
      ...base,
      message: { role: 'assistant', model: 'sonnet', effort: 'max', content: [] },
    }], [model])).toEqual({ modelId: model.id });
  });
});
