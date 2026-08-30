import { describe, expect, it } from 'vitest';

import {
  createSessionGroupingSelector,
  groupSessionsByWorkspace,
  type SessionSummary,
} from '../src/domain/sessions';

const sessions: readonly SessionSummary[] = [
  {
    id: 'session-2',
    workspaceId: 'workspace-b',
    workspaceName: 'Beta',
    title: 'Older',
    updatedAt: '2026-08-28T10:00:00.000Z',
    status: 'idle',
  },
  {
    id: 'session-1',
    workspaceId: 'workspace-a',
    workspaceName: 'Alpha',
    title: 'Latest',
    updatedAt: '2026-08-29T10:00:00.000Z',
    status: 'running',
  },
  {
    id: 'session-3',
    workspaceId: 'workspace-a',
    workspaceName: 'Alpha',
    title: 'Older',
    updatedAt: '2026-08-28T10:00:00.000Z',
    status: 'completed',
  },
];

describe('session grouping selector', () => {
  it('groups by workspace and sorts groups and sessions deterministically', () => {
    expect(groupSessionsByWorkspace(sessions)).toEqual([
      {
        workspaceId: 'workspace-a',
        workspaceName: 'Alpha',
        sessions: [sessions[1], sessions[2]],
      },
      {
        workspaceId: 'workspace-b',
        workspaceName: 'Beta',
        sessions: [sessions[0]],
      },
    ]);
  });

  it('keeps the result reference stable for the same input references', () => {
    const selector = createSessionGroupingSelector();
    const first = selector(sessions);
    expect(selector(sessions)).toBe(first);
    expect(selector([...sessions])).toEqual(first);
  });
});
