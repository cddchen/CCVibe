# CCLink

自托管会话中枢：用 **Claude Agent SDK** 在本机封装会话能力，通过 **WebSocket + JSON-RPC 2.0** 把本机的 Claude 智能体连接到你的 Web / App 客户端（Phase 1：仅 loopback + token）。

## 分发给他人（npx，单端口）

打包后 CCLink 会**同时托管 Web UI**，使用者只需一条命令、无需分别起两个进程：

```bash
npx cclink --listen 0.0.0.0:4733 --token <你的token>
```

然后浏览器打开 `http://<本机IP>:4733`，登录页填 token 即可（Web 与 WS 同源，自动连 `ws://<host>:4733/ws`）。

> **前提：每个使用者都要在自己机器上有 Claude 授权。**
> CCLink 用 Claude Agent SDK 在**本机**跑 Claude、访问**本机文件**，所以它跑在使用者自己的电脑上，用他们自己的账号：
> - 环境变量 `ANTHROPIC_API_KEY=sk-ant-...`，或
> - 事先 `claude login`（Claude 订阅登录）。
> 没有授权时，连上后第一次对话就会失败。

### 发布到 npm（维护者操作）

```bash
cd repos/cc-agent-daemon
npm run install:all       # 装好根目录 + web 依赖
npm run build             # 编译 daemon(tsc) + 打包 web(vite) → dist/ 与 web/dist/

# 验证产物（关键：证明 tarball 里同时含 dist/ 与 web/dist/）
npm pack --dry-run        # 检查文件清单包含 dist/ 和 web/dist/
npm pack                  # 生成 cclink-0.1.0.tgz
npx ./cclink-0.1.0.tgz --token test   # 打开 http://127.0.0.1:4733 确认 Web 能加载且 WS 能连

npm publish               # 名字被占用时改用 scope：package.json name 改 @you/cclink，发布加 --access public
```

`prepublishOnly` 会在 `npm publish` 前自动 `install:all && build`，确保发布的包已含最新 `dist/` 与 `web/dist/`。

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