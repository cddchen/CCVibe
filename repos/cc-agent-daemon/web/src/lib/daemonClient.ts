export type RpcResult<T> = { id: number; result: T } | { id: number; error: { code: number; message: string } };

export type HistorySession = {
  sessionId: string;
  messageCount: number;
  lastTimestamp?: string;
};

export type Workspace = { id: string; path: string; createdAt: string };

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";

export type DaemonSettings = {
  models: {
    default?: string;
    opus?: string;
    sonnet?: string;
    haiku?: string;
    advisor?: string;
  };
  permissions: {
    allow: string[];
    deny: string[];
    defaultMode?: PermissionMode;
    additionalDirectories: string[];
  };
  effortLevel?: "low" | "medium" | "high" | "xhigh" | "max";
};

export type { ChatMessage } from "./messageBlocks";

type NotificationHandler = (method: string, params: unknown) => void;

export class DaemonClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private onNotify: NotificationHandler | null = null;
  private token: string;

  constructor(token = "") {
    this.token = token || localStorage.getItem("cc_daemon_token") || "";
  }

  setToken(t: string) {
    this.token = t;
    localStorage.setItem("cc_daemon_token", t);
  }

  onNotification(handler: NotificationHandler) {
    this.onNotify = handler;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const q = this.token ? `?token=${encodeURIComponent(this.token)}` : "";
      const override = localStorage.getItem("cc_daemon_ws_url")?.trim();
      let url: string;
      if (override) {
        let base = override.replace(/\/$/, "");
        if (!base.includes("/ws")) base = `${base}/ws`;
        url = `${base}${q}`;
      } else if (import.meta.env.DEV) {
        url = `/ws${q}`;
      } else {
        const proto = location.protocol === "https:" ? "wss:" : "ws:";
        url = `${proto}//${location.host}/ws${q}`;
      }
      this.ws = new WebSocket(url);
      this.ws.onopen = async () => {
        try {
          if (this.token) await this.call("auth", { token: this.token });
          resolve();
        } catch (e) {
          reject(e);
        }
      };
      this.ws.onerror = () => reject(new Error("WebSocket error"));
      this.ws.onmessage = (ev) => {
        const data = JSON.parse(ev.data as string) as { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } };
        if (data.id !== undefined && data.method === undefined) {
          const p = this.pending.get(data.id);
          if (!p) return;
          this.pending.delete(data.id);
          if (data.error) p.reject(new Error(data.error.message));
          else p.resolve(data.result);
          return;
        }
        if (data.method) this.onNotify?.(data.method, data.params);
      };
    });
  }

  call<T>(method: string, params?: unknown): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("not connected"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws!.send(JSON.stringify({ id, method, params: params ?? {} }));
    });
  }

  close() {
    this.ws?.close();
  }
}

export type ModelOption = { id: string; label: string };

export const MODEL_OPTIONS: ModelOption[] = [
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { id: "claude-opus-4-7", label: "Opus 4.7" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
];

export function modelOptionsFromSettings(settings: DaemonSettings): ModelOption[] {
  return [
    { id: settings.models.sonnet ?? "claude-sonnet-4-6", label: "Sonnet" },
    { id: settings.models.opus ?? "claude-opus-4-7", label: "Opus" },
    { id: settings.models.haiku ?? "claude-haiku-4-5-20251001", label: "Haiku" },
  ];
}

export const EFFORT_OPTIONS = [
  { id: "low", label: "低" },
  { id: "medium", label: "中" },
  { id: "high", label: "高" },
  { id: "xhigh", label: "极高" },
  { id: "max", label: "最高" },
] as const;

export const PERMISSION_MODE_OPTIONS = [
  { id: "default", label: "Default" },
  { id: "acceptEdits", label: "Accept Edits" },
  { id: "plan", label: "Plan Mode" },
  { id: "auto", label: "Auto Mode" },
  { id: "bypassPermissions", label: "Bypass Permissions" },
  { id: "dontAsk", label: "Don't Ask" },
] as const satisfies readonly { id: PermissionMode; label: string }[];

function textFromContent(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => {
        if (typeof b === "object" && b && "text" in b) return String((b as { text: string }).text);
        if (typeof b === "object" && b && "type" in b && (b as { type: string }).type === "text" && "text" in b) {
          return String((b as { text: string }).text);
        }
        return "";
      })
      .join("");
  }
  return "";
}

export function extractTextFromSdkMessage(msg: unknown): string {
  const m = msg as {
    type?: string;
    subtype?: string;
    event?: { type?: string; delta?: { type?: string; text?: string } };
    message?: { content?: unknown };
    result?: string;
  };
  if (m.type === "stream_event" && m.event) {
    const ev = m.event as { type?: string; delta?: { type?: string; text?: string } };
    const d = ev.delta;
    if (d?.text && (d.type === "text_delta" || ev.type === "content_block_delta")) return d.text;
    if (typeof (ev as { text?: string }).text === "string") return (ev as { text: string }).text;
  }
  if (m.type === "assistant" && m.message?.content) {
    const full = textFromContent(m.message.content);
    if (full) return full;
  }
  if (m.type === "assistant" && (m as { content?: unknown }).content) {
    return textFromContent((m as { content: unknown }).content);
  }
  if (m.type === "result" && typeof m.result === "string") return m.result;
  return "";
}

export function historyEntryToText(entry: { type?: string; message?: { content?: unknown } }): string {
  if (entry.type !== "user" && entry.type !== "assistant") return "";
  const c = entry.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => (typeof b === "object" && b && "text" in b ? String((b as { text: string }).text) : ""))
      .join("");
  }
  return "";
}