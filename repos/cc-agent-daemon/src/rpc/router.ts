import type { ZodType } from "zod";
import {
  RPC_ERROR,
  type JsonRpcError,
  type JsonRpcRequest,
  type JsonRpcSuccess,
} from "./protocol.js";
import type { ClientConnection } from "./connection.js";
import type { AppContext } from "../app/context.js";
import {
  authParams,
  sessionCreateParams,
  sessionIdParams,
  sessionSendParams,
  sessionResumeParams,
  sessionForkParams,
  sessionSetPermissionParams,
  sessionSetMetaParams,
  historyListParams,
  historyLoadParams,
  workspaceAddParams,
  workspaceRemoveParams,
  workspaceCheckTrustParams,
  permissionRespondParams,
} from "./schemas.js";
import { dirname, resolve } from "node:path";
import { assertCwdAllowed, canonicalPath } from "../security/workspaceGuard.js";
import { validateToken } from "../security/auth.js";
import { listAllLocalProjects, listSessions, loadSessionMessages } from "../history/reader.js";
import { projectSessionsDir } from "../history/paths.js";
import { log } from "../logger.js";
import { readClaudePersonalSettings } from "../settings/reader.js";

type Handler = (ctx: AppContext, conn: ClientConnection, params: unknown) => Promise<unknown>;

function withSchema<T>(schema: ZodType<T>, fn: (ctx: AppContext, conn: ClientConnection, params: T) => Promise<unknown>): Handler {
  return async (ctx, conn, raw) => {
    const parsed = schema.safeParse(raw ?? {});
    if (!parsed.success) {
      throw rpcError(RPC_ERROR.INVALID_PARAMS, parsed.error.message);
    }
    return fn(ctx, conn, parsed.data);
  };
}

function rpcError(code: number, message: string): Error & { rpcCode: number } {
  const e = new Error(message) as Error & { rpcCode: number };
  e.rpcCode = code;
  return e;
}

const handlers: Record<string, Handler> = {
  ping: async () => ({ ok: true }),

  "settings.get": async (ctx, conn) => {
    requireAuth(conn, ctx);
    return { settings: await readClaudePersonalSettings() };
  },

  auth: withSchema(authParams, async (ctx, conn, { token }) => {
    if (!validateToken(ctx.token, token)) {
      throw rpcError(RPC_ERROR.UNAUTHORIZED, "invalid token");
    }
    conn.authenticated = true;
    return { ok: true };
  }),

  "session.create": withSchema(sessionCreateParams, async (ctx, conn, p) => {
    requireAuth(conn, ctx);
    log.info("rpc session.create", { cwd: p.cwd, conn: conn.id });
    assertCwdAllowed(p.cwd, ctx.store.getWorkspacePaths());
    conn.permissionClientId = conn.id;
    const workspacePath = canonicalPath(p.cwd);
    const sessionId = await ctx.sessions.create(
      {
        cwd: workspacePath,
        model: p.model,
        permissionMode: p.permissionMode,
        allowedTools: p.allowedTools,
        disallowedTools: p.disallowedTools,
        systemPrompt: p.systemPrompt,
        settingSources: p.settingSources,
        effort: p.effort,
      },
      conn,
      p.initialMessage,
      (sdkSessionId, runtimeId) => ctx.store.migrateSessionMeta(runtimeId, sdkSessionId, workspacePath),
    );
    ctx.store.upsertSessionMeta(sessionId, workspacePath, {});
    return { sessionId };
  }),

  "session.sendMessage": withSchema(sessionSendParams, async (ctx, conn, p) => {
    requireAuth(conn, ctx);
    const runner = ctx.sessions.get(p.sessionId);
    if (!runner) {
      const active = ctx.sessions.listActive();
      log.warn("rpc session.sendMessage unknown session", {
        sessionId: p.sessionId,
        active: active.map((s) => s.sessionId),
      });
      throw rpcError(
        RPC_ERROR.INVALID_PARAMS,
        `unknown session (active: ${active.map((s) => s.sessionId).join(", ") || "none"})`,
      );
    }
    log.info("rpc session.sendMessage", { sessionId: p.sessionId, len: p.content.length });
    await runner.send(p.content);
    return { accepted: true };
  }),

  "session.resume": withSchema(sessionResumeParams, async (ctx, conn, p) => {
    requireAuth(conn, ctx);
    assertCwdAllowed(p.cwd, ctx.store.getWorkspacePaths());
    const workspacePath = canonicalPath(p.cwd);
    conn.permissionClientId = conn.id;
    const existing = ctx.sessions.get(p.sessionId);
    if (existing) await ctx.sessions.remove(p.sessionId);
    const sessionId = await ctx.sessions.create(
      {
        cwd: workspacePath,
        resumeSessionId: p.sessionId,
        permissionMode: p.permissionMode,
        model: p.model,
        effort: p.effort,
      },
      conn,
      undefined,
      (sdkSessionId, runtimeId) => ctx.store.migrateSessionMeta(runtimeId, sdkSessionId, workspacePath),
    );
    ctx.store.upsertSessionMeta(sessionId, workspacePath, {});
    return { sessionId };
  }),

  "session.fork": withSchema(sessionForkParams, async (ctx, conn, p) => {
    requireAuth(conn, ctx);
    assertCwdAllowed(p.cwd, ctx.store.getWorkspacePaths());
    const workspacePath = canonicalPath(p.cwd);
    conn.permissionClientId = conn.id;
    const sessionId = await ctx.sessions.create(
      {
        cwd: workspacePath,
        forkSessionId: p.sessionId,
        permissionMode: p.permissionMode,
        model: p.model,
        effort: p.effort,
      },
      conn,
      undefined,
      (sdkSessionId, runtimeId) => ctx.store.migrateSessionMeta(runtimeId, sdkSessionId, workspacePath),
    );
    ctx.store.upsertSessionMeta(sessionId, workspacePath, {});
    return { sessionId };
  }),

  "session.interrupt": withSchema(sessionIdParams, async (ctx, conn, p) => {
    requireAuth(conn, ctx);
    const runner = ctx.sessions.get(p.sessionId);
    if (!runner) throw rpcError(RPC_ERROR.INVALID_PARAMS, "unknown session");
    await runner.interrupt();
    return { ok: true };
  }),

  "session.setPermissionMode": withSchema(sessionSetPermissionParams, async (ctx, conn, p) => {
    requireAuth(conn, ctx);
    const runner = ctx.sessions.get(p.sessionId);
    if (!runner) throw rpcError(RPC_ERROR.INVALID_PARAMS, "unknown session");
    await runner.setPermissionMode(p.mode);
    return { ok: true };
  }),

  "session.attachIfLive": withSchema(sessionIdParams, async (ctx, conn, p) => {
    requireAuth(conn, ctx);
    const runner = ctx.sessions.get(p.sessionId);
    if (!runner) return { attached: false };
    conn.permissionClientId = conn.id;
    runner.subscribe(conn);
    return {
      attached: true,
      sessionId: runner.sessionId ?? p.sessionId,
      status: runner.getStatus(),
    };
  }),

  "session.attach": withSchema(sessionIdParams, async (ctx, conn, p) => {
    requireAuth(conn, ctx);
    const runner = ctx.sessions.get(p.sessionId);
    if (!runner) throw rpcError(RPC_ERROR.INVALID_PARAMS, "unknown session");
    runner.subscribe(conn);
    return { ok: true };
  }),

  "session.detach": withSchema(sessionIdParams, async (ctx, conn, p) => {
    requireAuth(conn, ctx);
    const runner = ctx.sessions.get(p.sessionId);
    if (runner) runner.unsubscribe(conn.id);
    return { ok: true };
  }),

  "session.listActive": async (ctx, conn) => {
    requireAuth(conn, ctx);
    return { sessions: ctx.sessions.listActive() };
  },

  "session.delete": withSchema(sessionIdParams, async (ctx, conn, p) => {
    requireAuth(conn, ctx);
    const runner = ctx.sessions.get(p.sessionId);
    const canonicalSessionId = runner?.sessionId ?? p.sessionId;
    await ctx.sessions.remove(p.sessionId);
    ctx.store.deleteSessionMeta(p.sessionId);
    ctx.store.deleteSessionMeta(canonicalSessionId);
    return { ok: true };
  }),

  "session.setMeta": withSchema(sessionSetMetaParams, async (ctx, conn, p) => {
    requireAuth(conn, ctx);
    const runner = ctx.sessions.get(p.sessionId);
    const sessionId = runner?.sessionId ?? p.sessionId;
    const workspacePath = runner?.cwd ?? "";
    if (runner?.sessionId && runner.sessionId !== p.sessionId) {
      ctx.store.migrateSessionMeta(p.sessionId, runner.sessionId, workspacePath);
    }
    ctx.store.upsertSessionMeta(sessionId, workspacePath, {
      customName: p.customName,
      pinned: p.pinned,
      archived: p.archived,
    });
    return { ok: true };
  }),

  "history.listAllLocal": async (ctx, conn) => {
    requireAuth(conn, ctx);
    const projects = (await listAllLocalProjects())
      .map((project) => {
        let workspacePath = project.workspacePath;
        try {
          workspacePath = canonicalPath(project.workspacePath);
        } catch {}
        return { ...project, workspacePath };
      })
      .filter((p) => p.sessions.length > 0);
    log.info("rpc history.listAllLocal", {
      projects: projects.length,
      sessions: projects.reduce((n, x) => n + x.sessions.length, 0),
    });
    return { projects };
  },

  "history.listSessions": withSchema(historyListParams, async (ctx, conn, p) => {
    requireAuth(conn, ctx);
    assertCwdAllowed(p.workspacePath, ctx.store.getWorkspacePaths());
    const workspacePath = canonicalPath(p.workspacePath);
    const dir = projectSessionsDir(workspacePath);
    const sessions = await listSessions(workspacePath);
    log.info("rpc history.listSessions", { workspacePath, dir, count: sessions.length });
    return { sessions };
  }),

  "history.loadSession": withSchema(historyLoadParams, async (ctx, conn, p) => {
    requireAuth(conn, ctx);
    if (!p.workspacePath) {
      throw rpcError(RPC_ERROR.INVALID_PARAMS, "workspacePath required");
    }
    assertCwdAllowed(p.workspacePath, ctx.store.getWorkspacePaths());
    return { messages: await loadSessionMessages(p.sessionId, canonicalPath(p.workspacePath)) };
  }),

  "workspace.list": async (ctx, conn) => {
    requireAuth(conn, ctx);
    return { workspaces: ctx.store.listWorkspaces() };
  },

  "workspace.add": withSchema(workspaceAddParams, async (ctx, conn, p) => {
    requireAuth(conn, ctx);
    return {
      workspace: ctx.store.addWorkspace(p.path),
    };
  }),

  "workspace.checkTrust": withSchema(workspaceCheckTrustParams, async (ctx, conn, p) => {
    requireAuth(conn, ctx);
    const roots = ctx.store.getWorkspacePaths();
    let path: string;
    try {
      path = canonicalPath(p.path);
    } catch {
      path = resolve(p.path);
    }
    const parent = dirname(path);
    let trusted = false;
    try {
      assertCwdAllowed(p.path, roots);
      trusted = true;
    } catch {}
    return { trusted, path, parent };
  }),

  "workspace.remove": withSchema(workspaceRemoveParams, async (ctx, conn, p) => {
    requireAuth(conn, ctx);
    return {
      ok: ctx.store.removeWorkspace(p.id),
    };
  }),

  "permission.respond": withSchema(permissionRespondParams, async (ctx, conn, p) => {
    requireAuth(conn, ctx);
    const ok = ctx.permissions.respond(p.sessionId, p.requestId, conn.id, {
      behavior: p.behavior,
      updatedInput: p.updatedInput,
      message: p.message,
    });
    if (!ok) throw rpcError(RPC_ERROR.INVALID_PARAMS, "unknown permission request");
    return { ok: true };
  }),

  "mcp.listServerStatus": withSchema(sessionIdParams, async (ctx, conn) => {
    requireAuth(conn, ctx);
    return {
      servers: [],
    };
  }),
};

function requireAuth(conn: ClientConnection, ctx: AppContext): void {
  if (ctx.token === null) {
    conn.authenticated = true;
    return;
  }
  if (!conn.authenticated) {
    throw rpcError(RPC_ERROR.UNAUTHORIZED, "unauthorized");
  }
}

export async function dispatch(
  ctx: AppContext,
  conn: ClientConnection,
  req: JsonRpcRequest,
): Promise<JsonRpcSuccess | JsonRpcError | undefined> {
  const isNotification = req.id === undefined;
  const respond = (res: Omit<JsonRpcSuccess, "jsonrpc"> | Omit<JsonRpcError, "jsonrpc">) =>
    isNotification ? undefined : ({ jsonrpc: "2.0", ...res } as JsonRpcSuccess | JsonRpcError);

  if (req.id === null) {
    return respond({ id: null, error: { code: RPC_ERROR.INVALID_REQUEST, message: "invalid request id" } });
  }

  const id: number | string | null = req.id === undefined ? null : req.id;

  if (req.jsonrpc !== undefined && req.jsonrpc !== "2.0") {
    return respond({ id, error: { code: RPC_ERROR.INVALID_REQUEST, message: "invalid jsonrpc version" } });
  }
  if (typeof req.method !== "string") {
    return respond({ id, error: { code: RPC_ERROR.INVALID_REQUEST, message: "invalid request" } });
  }

  if (req.method !== "auth" && !conn.authenticated && ctx.token !== null) {
    return respond({ id, error: { code: RPC_ERROR.UNAUTHORIZED, message: "unauthorized" } });
  }

  const handler = handlers[req.method];
  if (!handler) {
    return respond({ id, error: { code: RPC_ERROR.METHOD_NOT_FOUND, message: `unknown method: ${req.method}` } });
  }

  try {
    const result = await handler(ctx, conn, req.params);
    return respond({ id: req.id as number | string, result });
  } catch (err) {
    const e = err as Error & { rpcCode?: number };
    return respond({
      id,
      error: {
        code: e.rpcCode ?? RPC_ERROR.INTERNAL,
        message: e.message || "internal error",
      },
    });
  }
}