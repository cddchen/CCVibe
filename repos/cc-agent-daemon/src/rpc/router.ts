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
  historyListParams,
  workspaceAddParams,
  workspaceRemoveParams,
  workspaceCheckTrustParams,
  permissionRespondParams,
  conversationOpenParams,
  conversationIdParams,
  conversationGetParams,
  conversationSendParams,
  conversationSetModelParams,
  conversationSetEffortParams,
  conversationSetPermissionModeParams,
} from "./schemas.js";
import { dirname, resolve } from "node:path";
import { assertCwdAllowed, canonicalPath } from "../security/workspaceGuard.js";
import { validateToken } from "../security/auth.js";
import { listAllLocalProjects, listSessions } from "../history/reader.js";
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
    return {
      settings: await readClaudePersonalSettings(),
      runtime: {
        autoReclaimMs: ctx.config.autoReclaimMs,
        maxThreads: ctx.config.maxThreads,
      },
    };
  },

  auth: withSchema(authParams, async (ctx, conn, { token }) => {
    if (!validateToken(ctx.token, token)) {
      throw rpcError(RPC_ERROR.UNAUTHORIZED, "invalid token");
    }
    conn.authenticated = true;
    return { ok: true };
  }),

  "conversation.open": withSchema(conversationOpenParams, async (ctx, conn, p) => {
    requireAuth(conn, ctx);
    assertCwdAllowed(p.workspacePath, ctx.store.getWorkspacePaths());
    conn.permissionClientId = conn.id;
    return ctx.conversations.open({
      conversationId: p.conversationId,
      workspacePath: canonicalPath(p.workspacePath),
      subscribe: p.subscribe,
    }, conn);
  }),

  "conversation.get": withSchema(conversationGetParams, async (ctx, conn, p) => {
    requireAuth(conn, ctx);
    const conversation = ctx.store.getConversation(p.conversationId);
    if (!conversation) throw rpcError(RPC_ERROR.INVALID_PARAMS, "unknown conversation");
    assertCwdAllowed(conversation.workspacePath, ctx.store.getWorkspacePaths());
    return ctx.conversations.get(p.conversationId);
  }),

  "conversation.send": withSchema(conversationSendParams, async (ctx, conn, p) => {
    requireAuth(conn, ctx);
    const conversation = ctx.store.getConversation(p.conversationId);
    if (!conversation) throw rpcError(RPC_ERROR.INVALID_PARAMS, "unknown conversation");
    assertCwdAllowed(conversation.workspacePath, ctx.store.getWorkspacePaths());
    conn.permissionClientId = conn.id;
    return ctx.conversations.send(p.conversationId, p.content, conn, p.clientMessageId);
  }),

  "conversation.setModel": withSchema(conversationSetModelParams, async (ctx, conn, p) => {
    requireAuth(conn, ctx);
    return { model: await ctx.conversations.setModel(p.conversationId, p.model) };
  }),

  "conversation.setEffort": withSchema(conversationSetEffortParams, async (ctx, conn, p) => {
    requireAuth(conn, ctx);
    return { effort: await ctx.conversations.setEffort(p.conversationId, p.effort) };
  }),

  "conversation.setPermissionMode": withSchema(conversationSetPermissionModeParams, async (ctx, conn, p) => {
    requireAuth(conn, ctx);
    await ctx.conversations.setPermissionMode(p.conversationId, p.mode);
    return { ok: true };
  }),

  "conversation.interrupt": withSchema(conversationIdParams, async (ctx, conn, p) => {
    requireAuth(conn, ctx);
    const receipt = await ctx.conversations.interrupt(p.conversationId);
    return { ok: true, stillQueued: receipt?.still_queued ?? [] };
  }),

  "conversation.detach": withSchema(conversationIdParams, async (ctx, conn, p) => {
    requireAuth(conn, ctx);
    ctx.conversations.detach(p.conversationId, conn.id);
    return { ok: true };
  }),

  "conversation.listActive": async (ctx, conn) => {
    requireAuth(conn, ctx);
    return { sessions: ctx.sessions.listActive() };
  },

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
    const conversation = ctx.store.getConversation(p.conversationId);
    if (!conversation) throw rpcError(RPC_ERROR.INVALID_PARAMS, "unknown conversation");
    const runner = ctx.sessions.get(conversation.conversationId)
      ?? (conversation.sdkSessionId ? ctx.sessions.get(conversation.sdkSessionId) : undefined);
    if (!runner?.hasSubscriber(conn.id)) {
      throw rpcError(RPC_ERROR.INVALID_PARAMS, "connection is not subscribed to the conversation");
    }
    const ok = ctx.permissions.respond(runner.runtimeId, p.requestId, {
      behavior: p.behavior,
      updatedInput: p.updatedInput,
      updatedPermissions: p.updatedPermissions,
      message: p.message,
    });
    if (!ok) throw rpcError(RPC_ERROR.INVALID_PARAMS, "permission request already resolved");
    return { ok: true };
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
