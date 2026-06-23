import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ThemeToggle } from "../components/ThemeToggle";
import { VirtualMessageList } from "../components/VirtualMessageList";
import { QuestionPicker } from "../components/QuestionPicker";
import { parseAskUserQuestion } from "../lib/askUserQuestion";
import { useDaemon } from "../context/DaemonContext";
import { useChatNotify } from "../context/ChatNotifyContext";
import { useTurnStream } from "../hooks/useTurnStream";
import {
  EFFORT_OPTIONS,
  MODEL_OPTIONS,
  PERMISSION_MODE_OPTIONS,
  modelOptionsFromSettings,
  type DaemonSettings,
  type ModelOption,
  type PermissionMode,
} from "../lib/daemonClient";
import {
  MODEL_KIND_OPTIONS,
  applyDraftModelValue,
  chooseModelKind,
  customModelFromObservedModel,
  modelDisplayState,
  modelValueFromObservedModel,
  resumableSessionForModelChange,
  selectedModelValue,
  type ModelKind,
} from "../lib/chatModelControls";
import { chatNotifyBindOptions, shouldReplaceChatUrlFromInit } from "../lib/chatSessionRouting";
import {
  clearCachedSessionList,
  getCachedSessionList,
  loadSessionList,
  sessionGroups,
  type SessionListData,
} from "../lib/sessionListCache";
import { type TrustInfo } from "../lib/workspaceTrust";
import {
  CHAT_FOLLOW_OUTPUT_KEY,
  CHAT_SIDEBAR_OPEN_KEY,
  HOME_EXPANDED_DIRS_KEY,
  readBooleanPreference,
  readExpandedPreference,
  writeBooleanPreference,
  writeExpandedPreference,
} from "../lib/uiPreferences";
import {
  buildPermissionRespondParams,
  permissionInputText,
  type PermissionRequest,
} from "../lib/permissionResponses";
import {
  buildToolResultsFromHistory,
  historyEntriesToChatMessages,
  type ChatMessage,
  type ToolResultState,
} from "../lib/messageBlocks";

type Effort = (typeof EFFORT_OPTIONS)[number]["id"];
type SessionRunState = "running" | "completed" | "error" | "interrupted";

type SessionEventMeta = {
  sessionId: string;
  runtimeId: string;
  sdkSessionId: string;
};

function sessionMetaIds(meta: SessionEventMeta): string[] {
  return [meta.sessionId, meta.runtimeId, meta.sdkSessionId].filter(Boolean);
}

function isMetaForSession(meta: SessionEventMeta, sessionId: string | null): boolean {
  return !!sessionId && sessionMetaIds(meta).includes(sessionId);
}

function statusLabel(state: SessionRunState | undefined) {
  if (state === "running") return "对话中";
  if (state === "error") return "异常";
  if (state === "interrupted") return "已停止";
  return null;
}

function replaceChatUrl(workspacePath: string, sessionId: string) {
  const path = `/chat/${encodeURIComponent(workspacePath)}/${encodeURIComponent(sessionId)}`;
  window.history.replaceState(null, "", path);
}

function chatUrl(workspacePath: string, sessionId?: string) {
  const base = `/chat/${encodeURIComponent(workspacePath)}`;
  return sessionId ? `${base}/${encodeURIComponent(sessionId)}` : base;
}

function formatTime(iso?: string) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

function titleForSession(sessionId: string | null) {
  return sessionId ? `会话 ${sessionId.slice(0, 8)}…` : "新对话";
}

export function ChatPage() {
  const navigate = useNavigate();
  const { workspacePath: wpEnc, sessionId: sessionIdParam } = useParams();
  const workspacePath = wpEnc ? decodeURIComponent(wpEnc) : "";
  const historySessionId = sessionIdParam ? decodeURIComponent(sessionIdParam) : null;

  const { client, connected } = useDaemon();
  const { bind } = useChatNotify();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [historyToolResults, setHistoryToolResults] = useState<Record<string, ToolResultState>>({});
  const [input, setInput] = useState("");
  const [modelOptions, setModelOptions] = useState<ModelOption[]>(MODEL_OPTIONS);
  const [model, setModel] = useState(MODEL_OPTIONS[0].id);
  const [draftModel, setDraftModel] = useState(MODEL_OPTIONS[0].id);
  const [customModel, setCustomModel] = useState("");
  const [customModelEditing, setCustomModelEditing] = useState(false);
  const [effort, setEffort] = useState<Effort>("high");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("acceptEdits");
  const [liveSessionId, setLiveSessionId] = useState<string | null>(historySessionId);
  const [sessionStates, setSessionStates] = useState<Record<string, SessionRunState>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [sessionList, setSessionList] = useState<SessionListData>(() => getCachedSessionList() ?? { workspaces: [], sessionsByPath: {} });
  const [sidebarOpen, setSidebarOpen] = useState(() => readBooleanPreference(CHAT_SIDEBAR_OPEN_KEY, true));
  const [sidebarExpanded, setSidebarExpanded] = useState<Record<string, boolean>>(() => readExpandedPreference(HOME_EXPANDED_DIRS_KEY));
  const [followOutput, setFollowOutput] = useState(() => readBooleanPreference(CHAT_FOLLOW_OUTPUT_KEY, true));
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [trusted, setTrusted] = useState(false);
  const [trustPrompt, setTrustPrompt] = useState<TrustInfo | null>(null);
  const [perm, setPerm] = useState<PermissionRequest | null>(null);
  const [permissionUpdatedInput, setPermissionUpdatedInput] = useState("{}");
  const [permissionDenyMessage, setPermissionDenyMessage] = useState("用户拒绝");

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const customModelInputRef = useRef<HTMLInputElement | null>(null);
  const { beginTurn, onSdkEvent, endTurn, resetTurn, toolResults: liveToolResults } = useTurnStream(setMessages);
  const streamRef = useRef({ onSdkEvent, endTurn, beginTurn, resetTurn });
  streamRef.current = { onSdkEvent, endTurn, beginTurn, resetTurn };

  const modelRef = useRef(model);
  const effortRef = useRef(effort);
  const permissionModeRef = useRef(permissionMode);
  const liveSessionIdRef = useRef(liveSessionId);
  const refreshSessionsAfterTurnRef = useRef(false);
  const sessionAliasesRef = useRef<Record<string, Set<string>>>({});
  modelRef.current = model;
  effortRef.current = effort;
  permissionModeRef.current = permissionMode;
  liveSessionIdRef.current = liveSessionId;

  const registerSessionAliases = (ids: string[]) => {
    const valid = [...new Set(ids.filter(Boolean))];
    if (valid.length <= 1) return;
    for (const id of valid) {
      const next = new Set(sessionAliasesRef.current[id] ?? []);
      for (const other of valid) next.add(other);
      sessionAliasesRef.current[id] = next;
    }
  };

  const setRunStateForIds = (ids: string[], state: SessionRunState) => {
    const expanded = new Set<string>();
    for (const id of ids.filter(Boolean)) {
      expanded.add(id);
      for (const alias of sessionAliasesRef.current[id] ?? []) expanded.add(alias);
    }
    if (expanded.size === 0) return;
    setSessionStates((current) => {
      const next = { ...current };
      for (const id of expanded) next[id] = state;
      return next;
    });
  };

  const loadSessions = async (force = false) => {
    if (!client || !connected) return;
    try {
      setSessionList(await loadSessionList(client, { force }));
    } catch (e) {
      console.warn("[ChatPage] list sessions failed", e);
    }
  };

  useEffect(() => {
    if (!client || !connected) return;
    let cancelled = false;
    void client.call<{ settings: DaemonSettings }>("settings.get").then(({ settings }) => {
      if (cancelled) return;
      const options = modelOptionsFromSettings(settings);
      setModelOptions(options);
      if (settings.models.default) {
        setCustomModel((current) => customModelFromObservedModel(settings.models.default ?? "", options, current));
      }
      if (settings.permissions.defaultMode) setPermissionMode(settings.permissions.defaultMode);
      if (settings.effortLevel) setEffort(settings.effortLevel);
      if (!historySessionId && !liveSessionIdRef.current) {
        const observedDefault = settings.models.default ?? options[0]?.id ?? modelRef.current;
        const nextModel = modelValueFromObservedModel(observedDefault, options, modelRef.current);
        setModel(nextModel);
        setDraftModel(nextModel);
      }
    }).catch((e) => {
      console.warn("[ChatPage] settings.get failed", e);
    });
    return () => {
      cancelled = true;
    };
  }, [client, connected, historySessionId]);

  useEffect(() => {
    void loadSessions();
  }, [client, connected, workspacePath]);

  useEffect(() => {
    streamRef.current.resetTurn();
    setHistoryToolResults({});
    setMessages([]);
    setLiveSessionId(historySessionId);
    setStatus(historySessionId ? "加载会话…" : null);
  }, [historySessionId]);

  useEffect(() => {
    const max = 24 * 4;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [input]);

  useEffect(() => {
    const unbind = bind(
      chatNotifyBindOptions(liveSessionId),
      {
        onSdkEvent: (msg, meta) => {
          const active = isMetaForSession(meta, liveSessionIdRef.current ?? historySessionId);
          const m = msg as { type?: string; subtype?: string };
          if (active) streamRef.current.onSdkEvent(msg);
          if (m.type === "result" && m.subtype !== "error_during_execution" && m.subtype !== "error") {
            setRunStateForIds(sessionMetaIds(meta), "completed");
            if (active) {
              setStatus(null);
              streamRef.current.endTurn();
            }
            if (refreshSessionsAfterTurnRef.current) {
              refreshSessionsAfterTurnRef.current = false;
              void loadSessions(true);
            }
          }
        },
        onStatus: (st, err, meta) => {
          const active = isMetaForSession(meta, liveSessionIdRef.current ?? historySessionId);
          if (st === "running") {
            setRunStateForIds(sessionMetaIds(meta), "running");
            if (active) setStatus(null);
          } else if (st === "completed") {
            setRunStateForIds(sessionMetaIds(meta), "completed");
            if (active) setStatus(null);
          } else if (st === "error") {
            setRunStateForIds(sessionMetaIds(meta), "error");
            if (active) setStatus(err ? `${st}: ${err}` : st);
          } else {
            if (active) setStatus(err ? `${st}: ${err}` : st);
          }
          if ((st === "completed" || st === "error") && active) {
            streamRef.current.endTurn();
          }
          if (st === "completed" || st === "error") {
            if (refreshSessionsAfterTurnRef.current) {
              refreshSessionsAfterTurnRef.current = false;
              void loadSessions(true);
            }
          }
        },
        onPermission: (p) => {
          setPerm(p);
          setPermissionUpdatedInput(permissionInputText(p.input));
          setPermissionDenyMessage("用户拒绝");
        },
        onInit: (info, meta) => {
          const active = isMetaForSession(meta, liveSessionIdRef.current ?? historySessionId) || (!historySessionId && !liveSessionIdRef.current);
          if (!active) return;
          if (info.sessionId) {
            registerSessionAliases([...sessionMetaIds(meta), info.sessionId, historySessionId ?? "", liveSessionIdRef.current ?? ""]);
            setLiveSessionId(info.sessionId);
            setRunStateForIds([...sessionMetaIds(meta), info.sessionId], "running");
            if (shouldReplaceChatUrlFromInit(historySessionId)) replaceChatUrl(workspacePath, info.sessionId);
          }
          if (info.model) {
            const observedModel = modelValueFromObservedModel(info.model, modelOptions, modelRef.current);
            setModel(observedModel);
            setDraftModel(observedModel);
            setCustomModel((current) => customModelFromObservedModel(info.model ?? "", modelOptions, current));
          }
        },
      },
    );
    return unbind;
  }, [bind, historySessionId, liveSessionId, modelOptions, workspacePath]);

  const hydratedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!client || !connected || !workspacePath) return;
    let cancelled = false;
    setTrusted(false);
    setTrustPrompt(null);
    void client.call<TrustInfo>("workspace.checkTrust", { path: workspacePath })
      .then((info) => {
        if (cancelled) return;
        if (info.trusted) {
          setTrusted(true);
          setTrustPrompt(null);
        } else {
          setTrusted(false);
          setTrustPrompt(info);
        }
      })
      .catch((e) => {
        if (!cancelled) setStatus(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [client, connected, workspacePath]);

  useEffect(() => {
    if (!historySessionId) {
      hydratedRef.current = null;
      setMessages([]);
      setHistoryToolResults({});
      setLiveSessionId(null);
      setStatus(null);
      return;
    }
    if (!client || !connected || !workspacePath) return;
    if (!trusted) return;
    if (hydratedRef.current === historySessionId) return;

    let cancelled = false;
    (async () => {
      try {
        setStatus("加载会话…");
        const { messages: hist } = await client.call<{ messages: unknown[] }>("history.loadSession", {
          sessionId: historySessionId,
          workspacePath,
        });
        if (cancelled) return;
        setHistoryToolResults(buildToolResultsFromHistory(hist));
        const loaded = historyEntriesToChatMessages(
          hist as Parameters<typeof historyEntriesToChatMessages>[0],
        );
        setMessages(loaded);
        hydratedRef.current = historySessionId;
        setLiveSessionId(historySessionId);

        const lastAssistant = [...loaded].reverse().find((m) => m.role === "assistant" && m.model);
        if (lastAssistant?.model) {
          const observedModel = modelValueFromObservedModel(lastAssistant.model, modelOptions, modelRef.current);
          setModel(observedModel);
          setDraftModel(observedModel);
          setCustomModel((current) => customModelFromObservedModel(lastAssistant.model ?? "", modelOptions, current));
        }

        const { sessionId } = await client.call<{ sessionId: string }>("session.resume", {
          sessionId: historySessionId,
          cwd: workspacePath,
          permissionMode: permissionModeRef.current,
          model: modelRef.current,
          effort: effortRef.current,
        });
        if (cancelled) return;
        setLiveSessionId(sessionId);
        await client.call("session.attach", { sessionId });
        setStatus(null);
      } catch (e) {
        setStatus(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [client, connected, workspacePath, historySessionId, modelOptions, trusted]);

  useEffect(() => {
    return () => {
      const sid = liveSessionIdRef.current;
      if (client && sid) void client.call("session.detach", { sessionId: sid }).catch(() => {});
    };
  }, [client]);

  const resumeLive = async (diskSessionId: string, opts?: { model?: string; effort?: Effort }) => {
    if (!client) throw new Error("no client");
    const { sessionId } = await client.call<{ sessionId: string }>("session.resume", {
      sessionId: diskSessionId,
      cwd: workspacePath,
      permissionMode: permissionModeRef.current,
      model: opts?.model ?? modelRef.current,
      effort: opts?.effort ?? effortRef.current,
    });
    registerSessionAliases([diskSessionId, sessionId]);
    setLiveSessionId(sessionId);
    await client.call("session.attach", { sessionId });
    return sessionId;
  };

  const applyModel = async (next: string) => {
    setModel(next);
    setDraftModel(next);
    setCustomModelEditing(false);
    const disk = resumableSessionForModelChange(historySessionId);
    if (!disk || !client || busy) return;
    try {
      setStatus("切换模型…");
      await resumeLive(disk, { model: next });
      setStatus(null);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  };

  const onModelKindChange = async (kind: ModelKind) => {
    const state = chooseModelKind(kind, model, modelOptions, customModel);
    if ("error" in state) {
      setStatus(state.error);
      return;
    }
    setModel(state.model);
    setDraftModel(state.draftModel);
    setCustomModelEditing(state.customModelEditing);
    if (kind === "custom" && state.model === model && state.customModelEditing) {
      window.setTimeout(() => customModelInputRef.current?.focus(), 0);
      return;
    }
    await applyModel(state.model);
  };

  const applyDraftModel = async () => {
    const state = applyDraftModelValue(model, draftModel);
    if (state.model === model && state.draftModel === model) {
      setDraftModel(state.draftModel);
      setCustomModelEditing(state.customModelEditing);
      return;
    }
    setCustomModel(state.model);
    await applyModel(state.model);
  };

  const onEffortChange = async (next: Effort) => {
    setEffort(next);
    const disk = historySessionId;
    if (!disk || !client || busy) return;
    try {
      await resumeLive(disk, { effort: next });
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  };

  const onPermissionModeChange = async (next: PermissionMode) => {
    setPermissionMode(next);
    permissionModeRef.current = next;
    if (!liveSessionId || !client || busy) return;
    try {
      await client.call("session.setPermissionMode", { sessionId: liveSessionId, mode: next });
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  };

  const ensureSession = async (): Promise<string> => {
    if (!client) throw new Error("no client");

    const diskId = liveSessionId ?? historySessionId;
    if (diskId) {
      try {
        await client.call("session.attach", { sessionId: diskId });
        return diskId;
      } catch {
        if (historySessionId) return resumeLive(historySessionId);
        throw new Error("active session is no longer available");
      }
    }

    const { sessionId } = await client.call<{ sessionId: string }>("session.create", {
      cwd: workspacePath,
      model,
      effort,
      permissionMode: permissionModeRef.current,
      settingSources: ["user", "project"],
    });
    registerSessionAliases([sessionId, historySessionId ?? ""]);
    setLiveSessionId(sessionId);
    refreshSessionsAfterTurnRef.current = true;
    hydratedRef.current = sessionId;
    replaceChatUrl(workspacePath, sessionId);
    await client.call("session.attach", { sessionId });
    return sessionId;
  };

  const send = async () => {
    if (!trusted) return;
    const text = input.trim();
    if (!text || !client || busy) return;
    setInput("");
    setStatus("running");
    streamRef.current.beginTurn();
    setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", content: text }]);

    try {
      let sid = await ensureSession();
      setRunStateForIds([sid, historySessionId ?? "", liveSessionIdRef.current ?? ""], "running");
      try {
        await client.call("session.sendMessage", { sessionId: sid, content: text });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.includes("unknown session")) throw e;
        if (!historySessionId) throw e;
        sid = await resumeLive(historySessionId);
        setRunStateForIds([sid, historySessionId], "running");
        await client.call("session.sendMessage", { sessionId: sid, content: text });
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
      streamRef.current.endTurn();
      setRunStateForIds([liveSessionIdRef.current ?? "", historySessionId ?? ""], "error");
    }
  };

  const stop = async () => {
    if (!client || !liveSessionId) return;
    try {
      await client.call("session.interrupt", { sessionId: liveSessionId });
      streamRef.current.endTurn();
      setRunStateForIds([liveSessionId, historySessionId ?? ""], "interrupted");
      setStatus("已停止");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  };

  const respondPerm = async (behavior: "allow" | "deny") => {
    if (!client || !perm) return;
    try {
      await client.call("permission.respond", buildPermissionRespondParams(perm, behavior, {
        updatedInputText: permissionUpdatedInput,
        denyMessage: permissionDenyMessage,
      }));
      setPerm(null);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  };

  const askQuestion = useMemo(
    () => (perm?.toolName === "AskUserQuestion" ? parseAskUserQuestion(perm.input) : null),
    [perm],
  );

  const respondAsk = async (updatedInput: Record<string, unknown> | null) => {
    if (!client || !perm) return;
    try {
      await client.call(
        "permission.respond",
        updatedInput
          ? { sessionId: perm.sessionId, requestId: perm.requestId, behavior: "allow", updatedInput }
          : { sessionId: perm.sessionId, requestId: perm.requestId, behavior: "deny", message: "用户取消了问题" },
      );
      setPerm(null);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  };

  const trustDir = async (path: string) => {
    if (!client) return;
    try {
      await client.call("workspace.add", { path });
      clearCachedSessionList();
      setTrustPrompt(null);
      setTrusted(true);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  };

  const activeSessionId = liveSessionId ?? historySessionId;
  const activeRunState = activeSessionId ? sessionStates[activeSessionId] : undefined;
  const busy = activeRunState === "running";
  const allToolResults = { ...historyToolResults, ...liveToolResults };
  const selectedModel = selectedModelValue(model, modelOptions, customModelEditing);
  const modelDisplay = modelDisplayState(model, modelOptions, effort, customModelEditing);
  const sidebarGroups = useMemo(() => sessionGroups(sessionList), [sessionList]);
  const toggleSidebarOpen = () => setSidebarOpen((open) => {
    const next = !open;
    writeBooleanPreference(CHAT_SIDEBAR_OPEN_KEY, next);
    return next;
  });
  const toggleSidebarGroup = (path: string, open: boolean) => setSidebarExpanded((current) => {
    const next = { ...current, [path]: !open };
    writeExpandedPreference(HOME_EXPANDED_DIRS_KEY, next);
    return next;
  });
  const toggleFollowOutput = () => setFollowOutput((current) => {
    const next = !current;
    writeBooleanPreference(CHAT_FOLLOW_OUTPUT_KEY, next);
    return next;
  });

  return (
    <div className="h-full overflow-hidden bg-zinc-50 text-zinc-950 dark:bg-zinc-950 dark:text-zinc-50">
      <div className="flex h-full min-h-0">
        <aside className={`${sidebarOpen ? "hidden w-0 lg:flex lg:w-80" : "hidden lg:flex lg:w-16"} shrink-0 flex-col border-r border-zinc-200 bg-white/80 dark:border-zinc-800 dark:bg-zinc-950/80`}>
          <div className="flex items-center justify-between gap-2 border-b border-zinc-200 p-3 dark:border-zinc-800">
            {sidebarOpen && <span className="text-sm font-medium">全部会话</span>}
            <button type="button" className="rounded-lg px-2 py-1 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={toggleSidebarOpen}>
              {sidebarOpen ? "收起" : "展开"}
            </button>
          </div>
          {sidebarOpen && (
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              <Link to={chatUrl(workspacePath)} className="mb-2 block rounded-2xl px-3 py-2 text-sm font-medium text-violet-600 hover:bg-violet-50 dark:text-violet-400 dark:hover:bg-violet-950/30">
                + 当前目录新对话
              </Link>
              {sidebarGroups.map((g) => {
                const open = sidebarExpanded[g.workspace.path] ?? true;
                return (
                  <div key={g.workspace.id} className="mb-2 overflow-hidden rounded-2xl border border-zinc-100 dark:border-zinc-800">
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs hover:bg-zinc-50 dark:hover:bg-zinc-900"
                      onClick={() => toggleSidebarGroup(g.workspace.path, open)}
                    >
                      <span className="min-w-0 flex-1 truncate font-medium text-zinc-700 dark:text-zinc-300">{g.workspace.path}</span>
                      <span className="shrink-0 text-zinc-400">{open ? "▼" : "▶"}</span>
                    </button>
                    {open && (
                      <div className="border-t border-zinc-100 p-1 dark:border-zinc-800">
                        <Link to={chatUrl(g.workspace.path)} className="mb-1 block rounded-xl px-2 py-1.5 text-xs font-medium text-violet-600 hover:bg-violet-50 dark:text-violet-400 dark:hover:bg-violet-950/30">
                          + 新对话
                        </Link>
                        {g.sessions.map((s) => {
                          const runLabel = statusLabel(sessionStates[s.sessionId]);
                          return (
                            <Link
                              key={`${g.workspace.path}:${s.sessionId}`}
                              to={chatUrl(g.workspace.path, s.sessionId)}
                              onClick={() => setMobileSidebarOpen(false)}
                              className={`mb-1 block rounded-xl px-2 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-900 ${g.workspace.path === workspacePath && s.sessionId === historySessionId ? "bg-zinc-100 dark:bg-zinc-900" : ""}`}
                            >
                              <div className="flex items-center gap-2">
                                <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-700 dark:text-zinc-300">{s.sessionId.slice(0, 12)}…</span>
                                {runLabel && <span className="shrink-0 rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 dark:bg-violet-950/50 dark:text-violet-300">{runLabel}</span>}
                              </div>
                              <div className="mt-1 flex justify-between gap-2 text-[11px] text-zinc-500">
                                <span>{s.messageCount} 条</span>
                                <span>{formatTime(s.lastTimestamp)}</span>
                              </div>
                            </Link>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </aside>

        {mobileSidebarOpen && (
          <div className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={() => setMobileSidebarOpen(false)}>
            <aside className="h-full w-80 max-w-[86vw] overflow-y-auto border-r border-zinc-200 bg-white p-3 shadow-xl dark:border-zinc-800 dark:bg-zinc-950" onClick={(e) => e.stopPropagation()}>
              <div className="mb-3 flex items-center justify-between">
                <span className="text-sm font-medium">全部会话</span>
                <button type="button" className="rounded-lg px-2 py-1 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={() => setMobileSidebarOpen(false)}>关闭</button>
              </div>
              <Link to={chatUrl(workspacePath)} onClick={() => setMobileSidebarOpen(false)} className="mb-2 block rounded-2xl px-3 py-2 text-sm font-medium text-violet-600 hover:bg-violet-50 dark:text-violet-400 dark:hover:bg-violet-950/30">
                + 当前目录新对话
              </Link>
              {sidebarGroups.map((g) => {
                const open = sidebarExpanded[g.workspace.path] ?? true;
                return (
                  <div key={g.workspace.id} className="mb-2 overflow-hidden rounded-2xl border border-zinc-100 dark:border-zinc-800">
                    <button type="button" className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs hover:bg-zinc-50 dark:hover:bg-zinc-900" onClick={() => toggleSidebarGroup(g.workspace.path, open)}>
                      <span className="min-w-0 flex-1 truncate font-medium">{g.workspace.path}</span>
                      <span className="shrink-0 text-zinc-400">{open ? "▼" : "▶"}</span>
                    </button>
                    {open && (
                      <div className="border-t border-zinc-100 p-1 dark:border-zinc-800">
                        <Link to={chatUrl(g.workspace.path)} onClick={() => setMobileSidebarOpen(false)} className="mb-1 block rounded-xl px-2 py-1.5 text-xs font-medium text-violet-600 hover:bg-violet-50 dark:text-violet-400 dark:hover:bg-violet-950/30">
                          + 新对话
                        </Link>
                        {g.sessions.map((s) => {
                          const runLabel = statusLabel(sessionStates[s.sessionId]);
                          return (
                            <Link key={`${g.workspace.path}:${s.sessionId}`} to={chatUrl(g.workspace.path, s.sessionId)} onClick={() => setMobileSidebarOpen(false)} className={`mb-1 block rounded-xl px-2 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-900 ${g.workspace.path === workspacePath && s.sessionId === historySessionId ? "bg-zinc-100 dark:bg-zinc-900" : ""}`}>
                              <div className="flex items-center gap-2">
                                <span className="min-w-0 flex-1 truncate font-mono text-xs">{s.sessionId.slice(0, 12)}…</span>
                                {runLabel && <span className="shrink-0 rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 dark:bg-violet-950/50 dark:text-violet-300">{runLabel}</span>}
                              </div>
                              <div className="mt-1 text-[11px] text-zinc-500">{formatTime(s.lastTimestamp)} · {s.messageCount} 条</div>
                            </Link>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </aside>
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="shrink-0 z-20 border-b border-zinc-200 bg-white/85 px-3 py-3 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/85">
            <div className="flex items-center gap-3">
              <button type="button" className="rounded-xl px-2 py-1 text-sm hover:bg-zinc-100 lg:hidden dark:hover:bg-zinc-800" onClick={() => setMobileSidebarOpen(true)}>☰</button>
              <Link to="/" className="rounded-xl px-2 py-1 text-sm text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100">
                ← 返回
              </Link>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{titleForSession(activeSessionId)}</div>
                <div className="truncate text-xs text-zinc-500">{workspacePath}</div>
              </div>
              <ThemeToggle />
            </div>
          </header>

          <main className="relative min-h-0 flex-1 bg-gradient-to-b from-zinc-50 to-white dark:from-zinc-950 dark:to-zinc-950">
            <div className="mx-auto flex h-full w-full max-w-4xl flex-col">
              <VirtualMessageList
                messages={messages}
                toolResults={allToolResults}
                followOutput={followOutput}
                emptyHint={
                  <p className="text-center mt-12">发送消息开始对话（需本机 ANTHROPIC_API_KEY）</p>
                }
              />
            </div>
            <button
              type="button"
              aria-label={followOutput ? "关闭自动跟随会话" : "开启自动跟随会话"}
              title={followOutput ? "跟随回复：开启" : "跟随回复：关闭"}
              onClick={toggleFollowOutput}
              className={`absolute right-4 bottom-4 rounded-full border px-3 py-2 text-xs font-medium shadow-lg backdrop-blur transition ${followOutput ? "border-violet-200 bg-violet-600 text-white hover:bg-violet-500 dark:border-violet-800" : "border-zinc-200 bg-white/90 text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900/90 dark:text-zinc-200 dark:hover:bg-zinc-800"}`}
            >
              {followOutput ? "跟随回复" : "不跟随"}
            </button>
          </main>

          {status && (
            <div className="shrink-0 border-t border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-700 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300">
              {status}
            </div>
          )}

          <footer className="shrink-0 z-10 border-t border-zinc-200 bg-white/90 p-3 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90 md:p-4">
            <div className="mx-auto flex max-w-4xl flex-col gap-3 rounded-3xl border border-zinc-200 bg-zinc-50/80 p-3 shadow-lg shadow-zinc-200/50 dark:border-zinc-800 dark:bg-zinc-900/70 dark:shadow-black/20">
              {askQuestion ? (
                <QuestionPicker
                  ask={askQuestion}
                  onSubmit={(u) => void respondAsk(u)}
                  onCancel={() => void respondAsk(null)}
                />
              ) : (
              <>
              <div className="flex items-end gap-2">
                <textarea
                  ref={textareaRef}
                  rows={1}
                  className="max-h-24 min-h-11 flex-1 resize-none rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-violet-500/40 dark:border-zinc-700 dark:bg-zinc-950"
                  placeholder="输入消息…"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  disabled={!connected}
                />
                {busy ? (
                  <button
                    type="button"
                    onClick={() => void stop()}
                    disabled={!connected || !liveSessionId}
                    className="shrink-0 rounded-2xl bg-zinc-900 px-5 py-3 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-zinc-200"
                  >
                    停止
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void send()}
                    disabled={!connected || !input.trim()}
                    className="shrink-0 rounded-2xl bg-violet-600 px-5 py-3 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-40"
                  >
                    发送
                  </button>
                )}
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-zinc-500">
                <select
                  aria-label="权限模式"
                  className="max-w-[11rem] cursor-pointer appearance-none truncate rounded-full border border-zinc-200 bg-white/90 px-3 py-1.5 font-medium text-zinc-700 shadow-sm transition hover:border-violet-300 hover:bg-violet-50 hover:text-violet-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950/90 dark:text-zinc-200 dark:hover:border-violet-700 dark:hover:bg-violet-950/30 dark:hover:text-violet-200"
                  value={permissionMode}
                  onChange={(e) => void onPermissionModeChange(e.target.value as PermissionMode)}
                  disabled={!connected || busy}
                >
                  {PERMISSION_MODE_OPTIONS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
                <div
                  className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5 rounded-full border border-zinc-200 bg-white/70 p-1 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/70"
                  title={modelDisplay.summary}
                >
                  <select
                    aria-label="模型种类"
                    className="cursor-pointer appearance-none rounded-full bg-transparent px-3 py-1 font-medium text-zinc-700 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:text-zinc-200 dark:hover:bg-zinc-800"
                    value={selectedModel}
                    onChange={(e) => void onModelKindChange(e.target.value as ModelKind)}
                    disabled={!connected || busy}
                  >
                    {MODEL_KIND_OPTIONS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                  </select>
                  {modelDisplay.editable ? (
                    <input
                      ref={customModelInputRef}
                      aria-label="自定义模型名称"
                      type="text"
                      className="min-w-0 w-36 rounded-full bg-zinc-100 px-3 py-1 font-medium text-zinc-800 outline-none transition focus:ring-2 focus:ring-violet-500/40 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-800 dark:text-zinc-100"
                      value={draftModel}
                      onChange={(e) => setDraftModel(e.target.value)}
                      onBlur={() => void applyDraftModel()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          e.currentTarget.blur();
                        }
                      }}
                      disabled={!connected || busy}
                      placeholder="gpt-5.5"
                    />
                  ) : (
                    <span
                      aria-label="模型名称"
                      className="rounded-full bg-zinc-100 px-3 py-1 font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
                    >
                      {modelDisplay.name}
                    </span>
                  )}
                  <select
                    aria-label="思考强度"
                    className="cursor-pointer appearance-none rounded-full bg-transparent px-3 py-1 font-medium text-zinc-700 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:text-zinc-200 dark:hover:bg-zinc-800"
                    value={effort}
                    onChange={(e) => void onEffortChange(e.target.value as Effort)}
                    disabled={!connected || busy}
                  >
                    {EFFORT_OPTIONS.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
                  </select>
                </div>
              </div>
              </>
              )}
            </div>
          </footer>
        </div>
      </div>

      {trustPrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-lg rounded-3xl border border-zinc-200 bg-white p-6 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
            <h3 className="mb-1 font-medium">信任此工作目录?</h3>
            <p className="mb-4 break-all font-mono text-sm text-zinc-500">{trustPrompt.path}</p>
            <p className="mb-4 text-sm text-zinc-500">该目录尚未加入信任列表,信任后才能打开会话。</p>
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className="rounded-xl bg-zinc-100 px-4 py-2 text-sm hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700" onClick={() => navigate("/")}>取消</button>
              <button type="button" className="rounded-xl bg-zinc-100 px-4 py-2 text-sm hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700" onClick={() => void trustDir(trustPrompt.parent)}>信任父目录</button>
              <button type="button" className="rounded-xl bg-violet-600 px-4 py-2 text-sm text-white hover:bg-violet-500" onClick={() => void trustDir(trustPrompt.path)}>信任此目录</button>
            </div>
          </div>
        </div>
      )}

      {perm && !askQuestion && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-2xl rounded-3xl border border-zinc-200 bg-white p-6 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
            <h3 className="mb-1 font-medium">工具权限</h3>
            <p className="mb-4 font-mono text-sm text-zinc-500">{perm.toolName}</p>
            <label className="mb-3 block text-xs font-medium text-zinc-500">
              允许时提交给工具的输入（JSON object）
              <textarea
                className="mt-1 h-44 w-full resize-y rounded-2xl border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs text-zinc-800 outline-none focus:ring-2 focus:ring-violet-500/40 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                value={permissionUpdatedInput}
                onChange={(e) => setPermissionUpdatedInput(e.target.value)}
                spellCheck={false}
              />
            </label>
            <label className="mb-4 block text-xs font-medium text-zinc-500">
              拒绝原因
              <input
                className="mt-1 w-full rounded-2xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-800 outline-none focus:ring-2 focus:ring-violet-500/40 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                value={permissionDenyMessage}
                onChange={(e) => setPermissionDenyMessage(e.target.value)}
              />
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" className="rounded-xl bg-zinc-100 px-4 py-2 text-sm hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700" onClick={() => void respondPerm("deny")}>拒绝</button>
              <button type="button" className="rounded-xl bg-violet-600 px-4 py-2 text-sm text-white hover:bg-violet-500" onClick={() => void respondPerm("allow")}>允许</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
