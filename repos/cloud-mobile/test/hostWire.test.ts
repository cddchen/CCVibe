import { describe, expect, it } from 'vitest';

import {
  parseHostReconnectResult,
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
  it('accepts the real RootCatalogState shape and projects it separately for UI', () => {
    const snapshot = parseHostStateSnapshot({ resource: root, state: rootState, fromSeq: 4 });

    expect(snapshot.resource).toBe(root);
    expect(snapshot.state).toMatchObject({
      host: { displayName: 'Host A' },
      sessions: [{ chatUri: chat, status: 'in_progress', archived: false }],
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
});
