import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
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

  // Serve the built web UI so daemon + UI ship as one process on one port.
  // In dev the web runs under Vite; when packaged, `web/dist` sits next to the
  // compiled daemon (dist/server.js -> ../web/dist). Same-origin means the
  // browser's WS defaults to ws://<host>:<port>/ws (see web/src/lib/wsUrl.ts).
  const webDist = fileURLToPath(new URL("../web/dist", import.meta.url));
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/ws") && !req.url.startsWith("/health")) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "not found" });
    });
    app.log.info(`serving web UI from ${webDist}`);
  }

  const address = await app.listen({ host: config.host, port: config.port });
  app.log.info(`CCLink listening on ${address}`);

  return {
    app,
    close: async () => {
      await app.close();
      ctx.store.close();
    },
  };
}