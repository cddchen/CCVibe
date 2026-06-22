import Fastify from "fastify";
import websocket from "@fastify/websocket";
import type { AppContext } from "./app/context.js";
import type { DaemonConfig } from "./config.js";
import { dispatch } from "./rpc/router.js";
import { parseJsonRpcWire } from "./rpc/protocol.js";
import { createConnectionId } from "./rpc/connection.js";
import { extractTokenFromUrl, validateToken } from "./security/auth.js";

export type RunningServer = {
  app: ReturnType<typeof Fastify>;
  close: () => Promise<void>;
};

export async function startServer(ctx: AppContext, config: DaemonConfig): Promise<RunningServer> {
  const app = Fastify({ logger: true });
  await app.register(websocket);

  app.get("/health", async () => ({ ok: true }));

  app.get("/ws", { websocket: true }, (socket, req) => {
    const tokenFromQuery = extractTokenFromUrl(req.url);
    const tokenHeader = req.headers["x-cc-daemon-token"];
    const presented =
      tokenFromQuery ??
      (typeof tokenHeader === "string" ? tokenHeader : undefined);

    if (!validateToken(ctx.token, presented)) {
      socket.close(4401, "unauthorized");
      return;
    }

    const conn = {
      id: createConnectionId(),
      authenticated: ctx.token === null,
      send: (payload: unknown) => {
        if (socket.readyState === 1) socket.send(JSON.stringify(payload));
      },
      close: () => socket.close(),
    };

    socket.on("message", (buf: Buffer) => {
      const raw = buf.toString();
      const parsed = parseJsonRpcWire(raw);
      if ("error" in parsed) {
        conn.send(parsed.error);
        return;
      }
      void dispatch(ctx, conn, parsed.request).then((res) => {
        if (res) conn.send(res);
      });
    });

    socket.on("close", () => {
      ctx.sessions.onClientDisconnect(conn.id);
      ctx.permissions.denyAllForConnection(conn.id);
    });
  });

  const address = await app.listen({ host: config.host, port: config.port });
  app.log.info(`cc-agent-daemon listening on ${address}`);

  return {
    app,
    close: async () => {
      await app.close();
      ctx.store.close();
    },
  };
}