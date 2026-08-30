import type { SessionSummary } from './types';

export type { SessionSummary } from './types';

export interface SessionGroup {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly sessions: readonly SessionSummary[];
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareSessions(left: SessionSummary, right: SessionSummary): number {
  const updated = compareText(right.updatedAt, left.updatedAt);
  if (updated !== 0) return updated;
  const title = compareText(left.title, right.title);
  if (title !== 0) return title;
  return compareText(left.id, right.id);
}

function compareSessionValue(left: SessionSummary, right: SessionSummary): boolean {
  return left.id === right.id
    && left.workspaceId === right.workspaceId
    && left.workspaceName === right.workspaceName
    && left.title === right.title
    && left.updatedAt === right.updatedAt
    && left.status === right.status;
}

function equalSessionLists(left: readonly SessionSummary[], right: readonly SessionSummary[]): boolean {
  return left.length === right.length && left.every((session, index) => {
    const other = right[index];
    return other !== undefined && compareSessionValue(session, other);
  });
}

export function groupSessionsByWorkspace(sessions: readonly SessionSummary[]): readonly SessionGroup[] {
  const sorted = [...sessions].sort(compareSessions);
  const groups = new Map<string, { readonly workspaceName: string; readonly sessions: SessionSummary[] }>();

  for (const session of sorted) {
    const group = groups.get(session.workspaceId);
    if (group === undefined) {
      groups.set(session.workspaceId, { workspaceName: session.workspaceName, sessions: [session] });
    } else {
      group.sessions.push(session);
      if (compareText(session.workspaceName, group.workspaceName) < 0) {
        groups.set(session.workspaceId, { workspaceName: session.workspaceName, sessions: group.sessions });
      }
    }
  }

  const result = [...groups.entries()]
    .map(([workspaceId, group]) => Object.freeze({
      workspaceId,
      workspaceName: group.workspaceName,
      sessions: Object.freeze([...group.sessions]),
    }))
    .sort((left, right) => compareText(left.workspaceName, right.workspaceName) || compareText(left.workspaceId, right.workspaceId));
  return Object.freeze(result);
}

export function createSessionGroupingSelector(): (sessions: readonly SessionSummary[]) => readonly SessionGroup[] {
  let previousInput: readonly SessionSummary[] | undefined;
  let previousOutput: readonly SessionGroup[] | undefined;

  return (sessions) => {
    if (previousInput === sessions && previousOutput !== undefined) {
      return previousOutput;
    }
    if (previousInput !== undefined && previousOutput !== undefined && equalSessionLists(previousInput, sessions)) {
      previousInput = sessions;
      return previousOutput;
    }
    const output = groupSessionsByWorkspace(sessions);
    previousInput = sessions;
    previousOutput = output;
    return output;
  };
}
