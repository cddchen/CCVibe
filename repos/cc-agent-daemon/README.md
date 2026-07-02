# cc-agent-daemon

本地守护进程：用 **Claude Agent SDK** 封装会话能力，通过 **WebSocket + JSON-RPC 2.0** 向 Web / App 客户端暴露管理接口（Phase 1：仅 loopback + token）。

## 快速开始

```bash
cd repos/cc-agent-daemon
npm run install:all
```

### 默认开发启动（0.0.0.0 + token `cddchen`）

本仓库日常联调推荐：**daemon 与 web 均监听所有网卡**，固定 token **`cddchen`**。

**一条命令（推荐）** — 同一终端同时起 daemon + Web：

```bash
npm run dev:all
```

浏览器打开 http://localhost:5174 ；开发模式下登录页会预填 token `cddchen`，WS 默认走 Vite 代理（`5174` → 本机 `4733`），无需再开第二个终端。

仍要分开起时：

```bash
# 终端 1：daemon（0.0.0.0:4733）
npm run dev:lan

# 终端 2：Web UI（0.0.0.0:5174，/ws 代理到本机 4733）
npm run dev:web
```

| 项 | 值 |
|---|---|
| Daemon 监听 | `0.0.0.0:4733` |
| Web 监听 | `0.0.0.0:5174`（`vite.config.ts` 已 `host: true`） |
| Token | `cddchen` |
| 本机 Web | http://localhost:5174 |
| 局域网 Web | http://\<本机 IP\>:5174 |
| 直连 WS（登录页） | `ws://<本机 IP>:4733` 或本机 `ws://127.0.0.1:4733` |

等价于手动：

```bash
npm run dev -- --listen 0.0.0.0:4733 --token cddchen
```

- HTTP 健康检查：`GET http://127.0.0.1:4733/health`
- WebSocket：`ws://<host>:4733/ws?token=cddchen`；连接后也可 RPC：`{"id":1,"method":"auth","params":{"token":"cddchen"}}`

### 仅本机、无 token（不推荐用于局域网）

```bash
npm run dev -- --insecure-no-auth --port 4733
```

`--insecure-no-auth` 时 WebSocket 可省略 token。

## 脚本

| 命令 | 说明 |
|---|---|
| `npm run dev` | 开发（需自行传 `--listen` / `--token` 等） |
| `npm run dev:lan` | **默认**：`0.0.0.0:4733`，token `cddchen` |
| `npm run dev:web` | 仅 Web UI（`web/` 下 Vite） |
| `npm run dev:all` | **一条命令**：`dev:lan` + `dev:web`（需先 `install:all`） |
| `npm run install:all` | 根目录 + `web/` 依赖一次装好 |
| `npm run build` / `npm start` | 编译与运行 |
| `npm test` | Vitest |
| `npm run typecheck` | 类型检查 |

## Web 测试 UI（React）

与上文 **默认开发启动** 相同：终端 1 `npm run dev:lan`，终端 2 `cd web && npm run dev`。

浏览器打开 http://localhost:5174（或局域网 `http://<IP>:5174`）— 登录页填 WS 与 token `cddchen`；添加工作目录、按目录浏览会话、新对话/续聊，支持模型与思考强度（`effort`）。

### 自定义 token（生产或对外暴露时）

勿将固定 token 用于公网；可改用随机 token：

```bash
TOKEN=$(openssl rand -hex 16)
echo "Token: $TOKEN"
npm run dev -- --listen 0.0.0.0:4733 --token "$TOKEN"
```

手机/其他电脑：Web `http://<本机局域网 IP>:5174`，WS `ws://<本机局域网 IP>:4733`，token 与启动参数一致。

设计见 `../../docs/daemon/` 与 `.plans/parsed-questing-fern.md`。