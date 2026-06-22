# cc-agent-daemon

本地守护进程：用 **Claude Agent SDK** 封装会话能力，通过 **WebSocket + JSON-RPC 2.0** 向 Web / App 客户端暴露管理接口（Phase 1：仅 loopback + token）。

## 快速开始

```bash
cd repos/cc-agent-daemon
npm install --legacy-peer-deps
npm run dev -- --insecure-no-auth --port 4733
```

- HTTP 健康检查：`GET http://127.0.0.1:4733/health`
- WebSocket：`ws://127.0.0.1:4733/ws?token=<token>`（`--insecure-no-auth` 时可省略 token）
- 有 token 时首条 RPC：`{"id":1,"method":"auth","params":{"token":"..."}}`

## 脚本

| 命令 | 说明 |
|---|---|
| `npm run dev` | 开发 |
| `npm run build` / `npm start` | 编译与运行 |
| `npm test` | Vitest |
| `npm run typecheck` | 类型检查 |

## Web 测试 UI（React）

```bash
# 终端 1：daemon
npm run dev -- --insecure-no-auth --port 4733

# 终端 2：前端（代理 /ws → daemon）
cd web && npm install && npm run dev
```

浏览器打开 http://127.0.0.1:5174 — 添加工作目录、按目录浏览会话、新对话/续聊，支持模型与思考强度（`effort`）。

### 局域网访问

LAN 模式必须显式配置 token，不能使用 `--insecure-no-auth`：

```bash
# 终端 1：daemon 监听所有网卡
TOKEN=$(openssl rand -hex 16)
echo "Token: $TOKEN"
npm run dev -- --listen 0.0.0.0:4733 --token "$TOKEN"

# 终端 2：前端对外暴露
npm run dev --prefix web -- --host 0.0.0.0
```

手机/其他电脑访问：`http://<本机局域网 IP>:5174`。如果需要直连 WS，在首页填写 `ws://<本机局域网 IP>:4733` 并输入同一个 token。

设计见 `../../docs/daemon/` 与 `.plans/parsed-questing-fern.md`。