import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ThemeToggle } from "../components/ThemeToggle";
import { useDaemon } from "../context/DaemonContext";
import { useActiveSessions } from "../hooks/useActiveSessions";
import { activeBadgeClassName, activeBadgeLabel } from "../lib/activeSessionBadge";
import {
  getCachedSessionList,
  loadSessionList,
  sessionGroups,
  type SessionListData,
} from "../lib/sessionListCache";
import { HOME_EXPANDED_DIRS_KEY, readExpandedPreference, writeExpandedPreference } from "../lib/uiPreferences";

function encodePath(p: string) {
  return encodeURIComponent(p);
}

function formatTime(iso?: string) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

export function HomePage() {
  const { client, connected, error, disconnect, reconnectNonce } = useDaemon();
  const activeMap = useActiveSessions(client, connected, reconnectNonce);
  const [sessionList, setSessionList] = useState<SessionListData>(() => getCachedSessionList() ?? { workspaces: [], sessionsByPath: {} });
  const [loading, setLoading] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => readExpandedPreference(HOME_EXPANDED_DIRS_KEY));

  const load = useCallback(async (force = false) => {
    if (!client || !connected) return;
    setLoading(true);
    try {
      setSessionList(await loadSessionList(client, { force }));
    } catch (e) {
      console.error("[HomePage] load failed", e);
    } finally {
      setLoading(false);
    }
  }, [client, connected]);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => sessionGroups(sessionList), [sessionList]);

  const addWorkspace = async () => {
    if (!client || !newPath.trim()) return;
    await client.call("workspace.add", { path: newPath.trim() });
    setNewPath("");
    await load(true);
  };

  return (
    <div className="h-full flex flex-col overflow-hidden bg-zinc-50 text-zinc-950 dark:bg-zinc-950 dark:text-zinc-50">
      <header className="shrink-0 border-b border-zinc-200 bg-white/85 px-4 py-4 backdrop-blur md:px-6 dark:border-zinc-800 dark:bg-zinc-950/85">
        <div className="mx-auto flex max-w-5xl flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">CC 会话</h1>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              {connected ? "已连接 daemon" : error ? `未连接：${error}` : "连接中…"}
            </p>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <button
              type="button"
              onClick={() => void load(true)}
              className="rounded-xl bg-zinc-900 px-3 py-1.5 text-white hover:bg-zinc-700 dark:bg-zinc-800 dark:hover:bg-zinc-700"
            >
              刷新
            </button>
            <button
              type="button"
              onClick={disconnect}
              className="rounded-xl border border-zinc-200 px-3 py-1.5 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              切换连接
            </button>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-8 md:px-6">
        <div className="mx-auto max-w-5xl">
          <section className="mb-8 rounded-3xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/50">
            <h2 className="mb-3 text-sm font-medium text-zinc-600 dark:text-zinc-300">添加工作目录</h2>
            <div className="flex gap-2">
              <input
                className="min-w-0 flex-1 rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-2.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                placeholder="/Users/you/project"
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void addWorkspace()}
              />
              <button
                type="button"
                onClick={() => void addWorkspace()}
                className="rounded-2xl bg-violet-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-violet-500"
              >
                添加
              </button>
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-sm font-medium text-zinc-600 dark:text-zinc-300">按目录</h2>
            {!connected && <p className="text-sm text-zinc-500">请先连接 daemon；如果 daemon 开启了 token，请在右上角填写 Token。</p>}
            {connected && loading && <p className="text-sm text-zinc-500">加载中…</p>}
            {connected && !loading && groups.length === 0 && (
              <p className="text-sm text-zinc-500">
                未在 ~/.claude/projects 下发现会话。请在本机用 Claude Code 聊过天，或手动添加工作目录。
              </p>
            )}
            <ul className="space-y-3">
              {groups.map((g) => {
                const open = expanded[g.workspace.path] ?? true;
                return (
                  <li key={g.workspace.id} className="overflow-hidden rounded-3xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900/50">
                    <button
                      type="button"
                      className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                      onClick={() => setExpanded((e) => {
                        const next = { ...e, [g.workspace.path]: !open };
                        writeExpandedPreference(HOME_EXPANDED_DIRS_KEY, next);
                        return next;
                      })}
                    >
                      <div className="min-w-0">
                        <div className="truncate font-medium">{g.workspace.path}</div>
                        <div className="mt-0.5 text-xs text-zinc-500">
                          {g.sessions.length} 个会话 · 最近 {formatTime(g.latestAt)}
                        </div>
                      </div>
                      <span className="ml-2 shrink-0 text-sm text-zinc-400">{open ? "▼" : "▶"}</span>
                    </button>
                    {open && (
                      <ul className="divide-y divide-zinc-100 border-t border-zinc-100 dark:divide-zinc-800/80 dark:border-zinc-800">
                        <li>
                          <Link
                            to={`/chat/${encodePath(g.workspace.path)}`}
                            className="block px-4 py-3 text-sm font-medium text-violet-600 hover:bg-zinc-50 dark:text-violet-400 dark:hover:bg-zinc-800/40"
                          >
                            + 新对话
                          </Link>
                        </li>
                        {g.sessions.map((s) => (
                          <li key={s.sessionId}>
                            <Link
                              to={`/chat/${encodePath(g.workspace.path)}/${encodeURIComponent(s.sessionId)}`}
                              className="block px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
                            >
                              <div className="flex justify-between gap-2 text-sm">
                                <span className="flex min-w-0 items-center gap-2 truncate font-mono text-zinc-700 dark:text-zinc-300">
                                  {s.sessionId.slice(0, 8)}…
                                  {activeMap[s.sessionId] && (
                                    <span className={activeBadgeClassName(activeMap[s.sessionId])}>
                                      {activeBadgeLabel(activeMap[s.sessionId])}
                                    </span>
                                  )}
                                </span>
                                <span className="shrink-0 text-zinc-500">{formatTime(s.lastTimestamp)}</span>
                              </div>
                              <div className="mt-0.5 text-xs text-zinc-500">{s.messageCount} 条消息</div>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        </div>
      </main>
    </div>
  );
}
