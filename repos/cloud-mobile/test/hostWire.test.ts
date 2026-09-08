import { describe, expect, it } from 'vitest';

import {
  parseHostActionEnvelope,
  parseHostReconnectResult,
  parseHostCatalogRefreshResult,
  parseHostResolveWorkspaceResult,
  parseHostStateSnapshot,
  type HostChatState,
  type HostRootCatalogState,
} from '../src/protocol/hostWire';
import { projectRootCatalog } from '../src/domain/viewModels';

const root = 'agent-root://';
const chat = 'agent-chat://workspace-a/chat-a';

const rootState = {
  resource: root,
  host: { id: 'host-a', displayName: 'Host A' },
  connection: { status: 'connected', displayStatus: 'online' },
  workspaces: [{ id: 'workspace-a', path: '/tmp/workspace-a', displayName: 'Workspace A', status: 'available' }],
  sessions: [{
    chatUri: chat,
    sdkSessionRef: 'sdk-chat-a',
    workspaceId: 'workspace-a',
    title: 'Canonical chat',
    updatedAt: '2026-08-29T00:00:00.000Z',
    status: 'in_progress',
    archived: false,
    modelId: 'claude-sonnet',
    effort: 'high',
  }],
  models: [{
    id: 'claude-sonnet',
    displayName: 'Claude Sonnet',
    description: 'A model',
    capabilities: ['effort', 'adaptive-thinking'],
  }],
  defaultModelId: 'claude-sonnet',
  modifiedAt: '2026-08-29T00:00:00.000Z',
} as const;

const chatState = {
  resource: chat,
  status: 'in_progress',
  turns: [{
    id: 'turn-a',
    prompt: 'hello',
    status: 'active',
    parts: [{ kind: 'markdown', id: 'part-a', content: 'answer' }],
    startedAt: '2026-08-29T00:00:00.000Z',
  }],
  activeTurn: {
    id: 'turn-a',
    prompt: 'hello',
    status: 'active',
    parts: [{ kind: 'markdown', id: 'part-a', content: 'answer' }],
    startedAt: '2026-08-29T00:00:00.000Z',
  },
  pendingApprovals: [],
  pendingInputs: [],
  modifiedAt: '2026-08-29T00:00:00.000Z',
} as const;

describe('Host wire contract adapter', () => {
  it('accepts normalized turn activity and rejects raw SDK status values', () => {
    const base = { channel: chat, serverSeq: 1, serverTime: 't1' };
    expect(parseHostActionEnvelope({
      ...base,
      action: { type: 'chat/turnActivityChanged', turnId: 'turn-a', activity: 'requesting_model', timestamp: 't1' },
    }).action).toMatchObject({ activity: 'requesting_model' });
    expect(() => parseHostActionEnvelope({
      ...base,
      action: { type: 'chat/turnActivityChanged', turnId: 'turn-a', activity: 'requesting', timestamp: 't1' },
    })).toThrow();
  });

  it('accepts a normalized status system part and rejects a raw SDK status envelope', () => {
    const base = {
      channel: chat,
      serverSeq: 1,
      serverTime: 't1',
    };
    expect(parseHostActionEnvelope({
      ...base,
      action: {
        type: 'chat/responsePartAdded',
        turnId: 'turn-a',
        part: {
          kind: 'system_message',
          id: 'part-status',
          event: 'status',
          title: '运行状态',
          content: '{"status":"requesting"}',
          level: 'progress',
        },
        timestamp: 't1',
      },
    }).action).toMatchObject({ type: 'chat/responsePartAdded', part: { event: 'status' } });
    expect(() => parseHostActionEnvelope({
      ...base,
      action: { type: 'system', subtype: 'status', status: 'requesting' },
    })).toThrow();
  });

  it('parses only a canonical root snapshot for catalog/refresh', () => {
    const result = parseHostCatalogRefreshResult({
      snapshot: { resource: root, state: rootState, fromSeq: 9 },
    });
    expect(result.snapshot.resource).toBe(root);
    expect(result.snapshot.fromSeq).toBe(9);
    expect(() => parseHostCatalogRefreshResult({
      snapshot: { resource: root, state: rootState, fromSeq: 9 },
      extra: true,
    })).toThrow();
    expect(() => parseHostCatalogRefreshResult({
      snapshot: { resource: chat, state: chatState, fromSeq: 9 },
    })).toThrow();
  });

  it('accepts the real RootCatalogState shape and projects it separately for UI', () => {
    const snapshot = parseHostStateSnapshot({ resource: root, state: rootState, fromSeq: 4 });

    expect(snapshot.resource).toBe(root);
    expect(snapshot.state).toMatchObject({
      host: { displayName: 'Host A' },
      sessions: [{ chatUri: chat, status: 'in_progress', archived: false, modelId: 'claude-sonnet', effort: 'high' }],
    });

    const view = projectRootCatalog(snapshot.state as HostRootCatalogState, 4);
    expect(view.sessions[0]).toMatchObject({
      chatUri: chat,
      workspaceName: 'Workspace A',
      status: 'running',
    });
    expect(view.sessions[0]).not.toHaveProperty('sdkSessionRef');
  });

  it('rejects the Phase 0 drifted session shape before it reaches domain code', () => {
    expect(() => parseHostStateSnapshot({
      resource: root,
      state: {
        ...rootState,
        sessions: [{
          id: 'session-a',
          workspaceId: 'workspace-a',
          workspaceName: 'Workspace A',
          title: 'drifted',
          updatedAt: '2026-08-29T00:00:00.000Z',
          status: 'running',
        }],
      },
      fromSeq: 1,
    })).toThrow();
  });

  it('keeps session model metadata backward-compatible when fields are absent', () => {
    const legacySession = { ...rootState.sessions[0] };
    delete (legacySession as { modelId?: string }).modelId;
    delete (legacySession as { effort?: string }).effort;
    const snapshot = parseHostStateSnapshot({
      resource: root,
      state: { ...rootState, sessions: [legacySession] },
      fromSeq: 1,
    });
    const session = (snapshot.state as HostRootCatalogState).sessions[0];
    expect(session?.modelId).toBeUndefined();
    expect(session?.effort).toBeUndefined();
  });

  it('parses exact Host chat snapshots and replay actions, including catalog action names', () => {
    const snapshot = parseHostStateSnapshot({ resource: chat, state: chatState, fromSeq: 2 });
    expect(snapshot.resource).toBe(chat);
    expect((snapshot.state as HostChatState).activeTurn?.parts[0]).toEqual({ kind: 'markdown', id: 'part-a', content: 'answer' });

    const result = parseHostReconnectResult({
      type: 'replay',
      hostEpoch: 'epoch-1',
      throughSeq: 4,
      serverSeq: 4,
      missing: [],
      actions: [{
        channel: root,
        action: { type: 'catalog/sessionsReplaced', sessions: rootState.sessions, timestamp: 't4' },
        serverSeq: 4,
        serverTime: 't4',
      }],
    });

    expect(result.type).toBe('replay');
    if (result.type === 'replay') {
      expect(result.actions[0]?.action.type).toBe('catalog/sessionsReplaced');
    }
  });

  it('accepts normalized system-message parts in snapshots and actions', () => {
    const systemPart = {
      kind: 'system_message',
      id: 'system-compact',
      event: 'compact_boundary',
      title: '上下文压缩',
      content: '压缩完成',
      level: 'success',
    } as const;
    const snapshot = parseHostStateSnapshot({
      resource: chat,
      state: {
        ...chatState,
        activeTurn: { ...chatState.activeTurn, parts: [systemPart] },
      },
      fromSeq: 3,
    });
    expect((snapshot.state as HostChatState).activeTurn?.parts[0]).toEqual(systemPart);

    const replay = parseHostReconnectResult({
      type: 'replay',
      hostEpoch: 'epoch-1',
      throughSeq: 4,
      serverSeq: 4,
      missing: [],
      actions: [{
        channel: chat,
        serverSeq: 4,
        serverTime: '2026-08-29T00:00:04.000Z',
        action: {
          type: 'chat/responsePartAdded',
          turnId: 'turn-a',
          part: systemPart,
          timestamp: '2026-08-29T00:00:04.000Z',
        },
      }],
    });
    expect(replay.type).toBe('replay');
  });

  it('parses the Host-resolved workspace returned by catalog/resolveWorkspace', () => {
    const workspace = parseHostResolveWorkspaceResult({
      workspace: {
        id: 'workspace-resolved',
        path: '/tmp/resolved-workspace',
        displayName: 'Resolved Workspace',
        status: 'available',
      },
    });

    expect(workspace.workspace).toEqual({
      id: 'workspace-resolved',
      path: '/tmp/resolved-workspace',
      displayName: 'Resolved Workspace',
      status: 'available',
    });
    expect(() => parseHostResolveWorkspaceResult({ workspace: { id: 'made-up' } })).toThrow();
  });
});
