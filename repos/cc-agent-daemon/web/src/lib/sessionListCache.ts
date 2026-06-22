import type { HistorySession, Workspace } from "./daemonClient";

export type SessionListData = {
  workspaces: Workspace[];
  sessionsByPath: Record<string, HistorySession[]>;
};

export type SessionGroup = {
  workspace: Workspace;
  sessions: HistorySession[];
  latestAt: string;
};

type RpcClient = {
  call<T>(method: string, params?: unknown): Promise<T>;
};

let cached: SessionListData | null = null;
let pending: Promise<SessionListData> | null = null;

export function getCachedSessionList(): SessionListData | null {
  return cached;
}

export function setCachedSessionList(next: SessionListData): SessionListData {
  cached = next;
  return next;
}

export function clearCachedSessionList(): void {
  cached = null;
  pending = null;
}

export function sessionGroups(data: SessionListData): SessionGroup[] {
  const groups = data.workspaces.map((workspace) => {
    const sessions = [...(data.sessionsByPath[workspace.path] ?? [])].sort((a, b) =>
      (b.lastTimestamp ?? "").localeCompare(a.lastTimestamp ?? ""),
    );
    return {
      workspace,
      sessions,
      latestAt: sessions[0]?.lastTimestamp ?? workspace.createdAt,
    };
  });
  groups.sort((a, b) => b.latestAt.localeCompare(a.latestAt));
  return groups;
}

export async function loadSessionList(client: RpcClient, opts?: { force?: boolean }): Promise<SessionListData> {
  if (!opts?.force && cached) return cached;
  if (!opts?.force && pending) return pending;

  pending = fetchSessionList(client).then((next) => {
    cached = next;
    pending = null;
    return next;
  }).catch((error) => {
    pending = null;
    throw error;
  });
  return pending;
}

async function fetchSessionList(client: RpcClient): Promise<SessionListData> {
  const { projects } = await client.call<{
    projects: { workspacePath: string; sessions: HistorySession[] }[];
  }>("history.listAllLocal");
  const sessionsByPath: Record<string, HistorySession[]> = {};
  const workspaces: Workspace[] = [];

  for (const p of projects) {
    sessionsByPath[p.workspacePath] = p.sessions;
    workspaces.push({
      id: p.workspacePath,
      path: p.workspacePath,
      createdAt: p.sessions[0]?.lastTimestamp ?? new Date().toISOString(),
    });
  }

  const { workspaces: manual } = await client.call<{ workspaces: Workspace[] }>("workspace.list");
  for (const w of manual) {
    let shouldShow = w.path in sessionsByPath;
    if (!(w.path in sessionsByPath) || sessionsByPath[w.path].length === 0) {
      try {
        const { sessions } = await client.call<{ sessions: HistorySession[] }>("history.listSessions", {
          workspacePath: w.path,
        });
        sessionsByPath[w.path] = sessions;
        shouldShow = true;
      } catch (error) {
        console.warn("[sessionListCache] skipping unavailable workspace", w.path, error);
      }
    }
    if (shouldShow && !workspaces.some((existing) => existing.path === w.path)) workspaces.push(w);
  }

  return { workspaces, sessionsByPath };
}
