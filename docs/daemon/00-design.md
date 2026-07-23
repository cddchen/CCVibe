# cc-agent-daemon 技术方案（Phase 1）

独立 TypeScript 守护进程：封装 **Claude Agent SDK**，经 **WebSocket + JSON-RPC 2.0** 向 Web/App 暴露会话能力。默认 **127.0.0.1 + token**，会话事实源在本机。

## 模块

| 模块 | 路径 | 职责 |
|---|---|---|
| server | `src/server.ts` | Fastify、`/health`、`/ws`、token 闸 |
| rpc | `src/rpc/` | 路由、Zod 校验、JSON-RPC |
| session | `src/session/` | SessionRunner、Registry、EngineAdapter、Claude 引擎 |
| permission | `src/permission/` | canUseTool ↔ `permission.respond` |
| history | `src/history/` | 读 `~/.claude/projects/**/*.jsonl` |
| store | `src/store/db.ts` | `node:sqlite` 元数据 |
| security | `src/security/` | token、工作区白名单 |

## 运行

```bash
cd repos/cc-agent-daemon
npm install --legacy-peer-deps
npm run dev -- --insecure-no-auth --port 4733
```

- 健康：`GET http://127.0.0.1:4733/health`
- WS：`ws://127.0.0.1:4733/ws`（有 token 时 `?token=` + RPC `auth`）

## RPC 子集

`ping`、`auth`、`session.*`、`history.*`、`workspace.*`、`permission.respond`、`mcp.listServerStatus`

通知：`session/event`、`session/status`、`runtime/status`、`turn/status`、`permission/request`

设计与接入资料：

- [Claude Agent SDK 全面接入指南](./01-claude-agent-sdk-integration-guide.md)
- [P0 修复与运行时架构](./02-p0-runtime-architecture.md)
- [JSON-RPC 接口与参数定义](./03-json-rpc-api-reference.md)
- `.plans/parsed-questing-fern.md`
