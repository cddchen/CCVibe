# desktop-cc-gui（ccgui / "moss"）调研文档

> 主题：这个项目如何管理本机 Claude Code 会话，采用什么架构与传输方式。
> 对照参考：`repos/cui/docs/cui-research.md`（CUI 的 Node 服务方案）。

## 0. 一句话结论

ccgui 是一个 **Tauri（Rust 后端 + React 前端）桌面应用**，但它的核心管理能力被抽到了一个**独立的守护进程二进制 `cc_gui_daemon`** 里。守护进程对外暴露一条 **行分隔 JSON-RPC over TCP**（默认 `127.0.0.1:4732`）通道，桌面端和"浏览器 Web 服务"都是这条通道的**客户端**。这正是"本机跑 CC + 装一个服务即可多端管理"的落地形态 —— 与你想要的 Model A（本地 daemon）几乎一致。

它还在引擎层做了**多引擎抽象**（Claude / Codex / Gemini / OpenCode），Claude 引擎用 `claude -p` print 模式 + stream-json，比 CUI 更完整（partial messages、hook events、fork、强制 session-id、流中 stdin 交互）。

---

## 1. 整体架构（三层 + 单一事件总线）

```
┌─────────────────────┐        ┌─────────────────────┐
│  桌面端 Tauri 应用    │        │   浏览器 (Web)        │
│  React 前端          │        │   同一套 React SPA    │
│  remote_backend.rs   │        │   /app  + /ws         │
└──────────┬──────────┘        └──────────┬──────────┘
           │ TCP 行-JSON-RPC               │ HTTP /api/rpc + WebSocket /ws
           │ 127.0.0.1:4732                │ （由 axum Web 服务承载）
           │                               │
           │                    ┌──────────▼───────────┐
           │                    │  Web 服务 (axum)      │  ← 每个浏览器 WS
           │                    │  既发 SPA 静态资源，   │    都向 4732 再开一条
           │                    │  又做 HTTP/WS ↔ TCP   │    上游 TCP RPC 连接
           │                    │  的桥接代理            │    并双向转发
           │                    └──────────┬───────────┘
           │                               │ TCP 行-JSON-RPC
           ▼                               ▼
        ┌──────────────────────────────────────────────┐
        │           cc_gui_daemon（核心守护进程）          │
        │  • TcpListener.accept() → 每连接一个 task       │
        │  • 全局 broadcast::channel<DaemonEvent>(2048)   │
        │    事件总线，所有客户端订阅同一份流              │
        │  • RPC dispatch（一个大 match）                  │
        │  • DaemonState：workspaces / settings / 引擎    │
        └───────────────────┬──────────────────────────┘
                            │ 派生 / 管理
                            ▼
        ┌──────────────────────────────────────────────┐
        │  引擎层（多引擎抽象 EngineType）                  │
        │  Claude：spawn `claude -p --output-format       │
        │  stream-json --verbose ...`（每 turn 一个子进程）│
        └──────────────────────────────────────────────┘
                            │ 读取
                            ▼
        ~/.claude/projects/{encoded-path}/{session-id}.jsonl
        （Claude Code 官方 transcript，append-only）
```

关键点：**守护进程的 TCP JSON-RPC 是唯一事实源**。桌面端是它的直连客户端；Web 服务是它的"前置代理 + 静态资源服务器"。两者共享同一套 RPC 方法与同一条事件总线。

---

## 2. 守护进程 `cc_gui_daemon`

源码：`src-tauri/src/bin/cc_gui_daemon.rs`（约 2200 行）+ `cc_gui_daemon/` 子模块。

### 2.1 启动与参数
- `fn main`（cc_gui_daemon.rs:2182）：`fix_path_env::fix()` 先从用户 shell 同步 PATH（解决 GUI 启动时拿不到 PATH 的经典坑），再单线程 tokio runtime `block_on`。
- 参数（`parse_args`，:441 起）：
  - `--listen <addr>`（默认 `127.0.0.1:4732`）
  - `--data-dir <path>`（存 `workspaces.json` / `settings.json`）
  - `--token <token>` 或 `--insecure-no-auth`（仅本地开发）；token 也可走环境变量 `CC_GUI_DAEMON_TOKEN`
  - **不给 token 又不加 `--insecure-no-auth` 会直接拒绝启动** —— 默认安全。

### 2.2 接入循环与事件总线
- `main` 里建一个全局 `broadcast::channel::<DaemonEvent>(2048)`（:2200）——**所有客户端共享的事件总线**。
- `TcpListener::bind(config.listen)`（:2207），`loop { listener.accept() }` 每来一个连接 `tokio::spawn(handle_client(...))`（:2220-2228）。
- 每个 `handle_client` 订阅同一个 broadcast，把引擎/会话事件作为 JSON-RPC **通知**（`{method, params}`，无 id）推回该客户端。这就是**多端 fan-out**：桌面端 + 每个浏览器 WS 桥接连接都能收到同一份实时流。

### 2.3 RPC 分发
- 一个大 `match`（dispatch），方法名即能力，例如：`start_web_server` / `stop_web_server` / `get_web_server_status`（:1600-1606）、`list_mcp_server_status`、`respond_to_server_request`（权限/AskUser 回流）等。
- 子模块按域拆分：`daemon_state.rs`（2936 行，状态核心）、`engine_bridge.rs`（引擎桥接）、`git.rs`（2588 行）、`file_access.rs`、`workspace_io.rs`、`session_folders.rs`、`thread_title_generation.rs`、`web_service_runtime.rs`（Web 服务）。

---

## 3. 桌面端如何接入：`remote_backend.rs`

源码：`src-tauri/src/remote_backend.rs`。

- 桌面端有 `BackendMode::Remote`，此时所有操作都通过 `call_remote(state, app, method, params)` 走到守护进程。
- 传输协议（极简 JSON-RPC）：
  - 请求：`{"id": <u64>, "method": <str>, "params": <json>}`，一行一条。
  - 响应：按 `id` 匹配 `{"id", "result"}` 或 `{"id", "error": {message}}`（`read_loop`，:230-248）。
  - 通知（服务端主动推）：`{"method", "params"}` 无 id，转成 Tauri 事件 emit 给前端（:258-269）：
    - `app-server-event`（引擎/会话事件）
    - `terminal-output`（终端输出）
    - `cli-installer-event`（CLI 安装进度）
- 连接管理：`RemoteBackend` 内部维护 `pending: HashMap<id, oneshot>`、`out_tx` 写通道、`connected` 标志、读/写两个 task；断线时把所有 pending 用 `DISCONNECTED_MESSAGE` 失败掉并清理（:160-209、:272-277）。
- 鉴权：连上后若配置了 token，先 `call("auth", {token})`（:196-201）。
- 默认主机 `127.0.0.1:4732`（:15）。

### 自动拉起守护进程：`web_service/daemon_bootstrap.rs`
桌面端调用远端失败（连接错误）时会**自动启动本地守护进程**再重试（`web_service/mod.rs:27` → `maybe_start_local_daemon_for_remote`）：
- 仅当目标是 loopback（`127.0.0.1:` / `localhost:` / `[::1]:`）才允许自动控制（:187）。
- 解析守护进程二进制路径（同目录 / resource_dir / PATH，候选名含 `cc_gui_daemon`、`moss_x_daemon`，:506-522）；dev 下找不到会 `cargo build --bin cc_gui_daemon` 现编（:430-498）。
- 拉起命令：`cc_gui_daemon --listen <host> --token <token>|--insecure-no-auth --data-dir <app_data>`，stdio 全部 null（:42-71），轮询最多 20×100ms 直到端口可连（:73-78）。
- 停止守护进程很克制：`lsof`/`netstat` 找 LISTEN PID → **再用 `ps`/`tasklist` 核对进程名必须是 moss daemon 才 kill**（:139-152、342-347），先 `TERM` 再 `KILL`。这是一个很好的"只杀自己进程"的安全护栏。

---

## 4. 浏览器如何接入：Web 服务（axum）

源码：`src-tauri/src/bin/cc_gui_daemon/web_service_runtime.rs`（1490 行）。

- 由 RPC 方法 `start_web_server(port, token)` 按需启动（不是常驻），内部 `axum::serve`。
- 路由（:145-155）：
  - `GET /` `/welcome` `/login`：纯 HTML 引导页，处理 token（存浏览器 `localStorage["mossx_web_token"]`）。
  - `GET /app` `/app/*path`：返回打包好的 React SPA `index.html`（同一套前端，资源目录可用 `MOSSX_WEB_ASSETS_DIR` 指定）。
  - `POST /api/rpc`：单次 RPC。鉴权后**把请求转发给守护进程 4732**（`call_daemon_rpc`，:635）再回包（`ping` 本地直接答）。
  - `GET /ws`：WebSocket，鉴权后升级。
  - `fallback`：静态资源（带 `sanitize_relative_path` 防目录穿越，:480-490；无扩展名的路径回退到 SPA index，支持前端路由）。
- **WS 桥接的核心**（`handle_socket`，:674-745）：每个浏览器 WS 连接**单独 `TcpStream::connect` 到守护进程 RPC 端点**，先 `authenticate_daemon_connection`，然后双向转发：
  - 浏览器 → 守护进程：WS Text 原样写入 TCP（加 `\n`）。
  - 守护进程 → 浏览器：TCP 每行作为 WS Text 推回。
  - 即浏览器拿到的是和桌面端**完全一样的 JSON-RPC 流**，前端代码几乎可复用。
- 鉴权 `is_authorized`（:750）：token 可来自 query `?token=` 或 header；首次用 query 传入后存 localStorage，之后由前端带上。

> 注意安全边界：Web 服务的鉴权目前是**共享 token**模型（query/header/localStorage），传输是明文 HTTP/WS（局域网/loopback 场景）。要做"公网远程访问"，这一层之上还需要 TLS/隧道/设备配对 —— 这正是你设计里 relay + E2E 要补的部分。

---

## 5. 引擎层与 Claude 会话

源码：`src-tauri/src/engine/`（多引擎），Claude 在 `engine/claude.rs`（2309 行）。

### 5.1 多引擎抽象
- `EngineType`（engine/mod.rs:50）：`Claude` / `Codex` / `Gemini` / `OpenCode`，默认 Claude（:63）。
- 有"能力矩阵"`capability_matrix.rs` 与一堆 `check:*` 脚本（package.json 里的 `check:engine-capability-matrix`、`scan-engine-name-branches` 等）来约束"按引擎能力分支"的写法，避免硬编码引擎名。

### 5.2 Claude 启动参数（claude.rs:820-959）
与 CUI 同属"**每个 turn 起一个 `claude -p` 子进程**"的回合制模型，但参数更全：
```
claude -p [<text> | "" --input-format stream-json]   # 多模态/多行走 stdin
        --output-format stream-json --verbose
        --include-partial-messages          # 流式增量文本
        [--include-hook-events]             # hook 事件
        # 权限模式映射：
        #   full-access → --dangerously-skip-permissions
        #   read-only   → --permission-mode plan
        #   default     → --permission-mode default
        #   current     → --permission-mode acceptEdits
        [--model <m>] [--effort <e>]
        # 会话延续/身份：
        #   fork:     --resume <id> --fork-session
        #   continue: --resume <id> | --continue
        #   new:      --session-id <id>   （强制稳定身份，防并发塌缩到同一会话）
        [--add-dir <spec_root>] [自定义 args]
```
- stdin 始终 piped：用于**流中向 Claude 写回**（例如 `AskUserQuestion` 工具的回答，:949-951）。
- 环境：`CLAUDE_NON_INTERACTIVE=1`、可设 `CLAUDE_HOME`。
- 进程清理：`Drop for ClaudeSession`（:70-105）兜底 `start_kill` 所有活跃子进程；Windows 用 `taskkill /T /F`（:1687）。

### 5.3 与 CUI 的能力差异（Claude 引擎更强的点）
- `--include-partial-messages`：真增量文本流（CUI 未用）。
- `--include-hook-events`：能观测 hook。
- `--fork-session`：原生分叉会话。
- 强制 `--session-id`：新会话给稳定身份，避免并发回合塌缩。
- 流中 stdin 写回：支持 AskUserQuestion 等中途交互。
- 但**仍是回合制 `-p` 封装，不是 PTY**：所以和 CUI 一样，纯本地 slash 命令（local / local-jsx 类）仍无法获得官方 REPL 的完整行为；它通过自己实现命令解析（`engine/commands.rs` 2364 行、`commands_parse_helpers.rs`）来补齐一部分。

### 5.4 ID / 术语模型
- `workspace_id`：一个工作区（项目/工作目录）。
- `thread_id`：一段对话（会话），前端层概念。
- `turn_id`：一次回合 = 一次 `claude -p` 调用。
- Claude `session_id`：官方持久身份，即 transcript 文件名。
- `WorkspaceSession`（backend/app_server.rs:432）承载工作区会话状态；`session_management*.rs`（一大组文件）做目录/归档/批量分配/投影等管理。

### 5.5 历史读取（与 CUI 相同的数据源）
- `engine/claude_history.rs`：读 `<effective-claude-home>/projects/{encoded-path}/{session-id}.jsonl`（:1-4），按 `.jsonl` 列举会话，跳过 `agent-*`（子代理单独处理，`claude_history_subagents.rs`），支持 fork/inline/大 payload 等多种场景（多个 `claude_history_*_tests.rs`）。
- 即历史的事实源仍是 Claude Code 官方 transcript，ccgui 只读不改它，自己的元数据另存（data-dir 下 `workspaces.json` / `settings.json` 等）。

---

## 6. 对照 CUI：两套"本机管理 CC"方案的差异

| 维度 | CUI | ccgui（本项目） |
|---|---|---|
| 形态 | Node 服务 + Web 前端 | Tauri 桌面应用 + 独立 Rust 守护进程 |
| 核心进程 | Node 进程内管理 | **独立 `cc_gui_daemon` 二进制**（可单独部署/控制） |
| 客户端接入 | 浏览器 → Node（SSE） | 桌面端(TCP RPC) **和** 浏览器(HTTP/WS 桥接) 共用同一 RPC |
| 传输 | HTTP + SSE | 行-JSON-RPC over TCP（核心）；浏览器侧 axum HTTP `/api/rpc` + WS `/ws` 桥接到 TCP |
| 事件分发 | 每会话 SSE | **全局 broadcast 事件总线**，多端 fan-out |
| Claude 调用 | `claude -p` stream-json（较旧版本依赖） | `claude -p` stream-json，但加了 partial/hook/fork/session-id/stdin 交互 |
| 引擎 | 仅 Claude | **多引擎**（Claude/Codex/Gemini/OpenCode）+ 能力矩阵 |
| 元数据 | `~/.cui/session-info.db`（SQLite） | data-dir 下 `workspaces.json`/`settings.json` 等 |
| 历史源 | `~/.claude/projects/**/*.jsonl` | 同左 |
| 鉴权 | —— | 守护进程 token（必填，否则拒启）；Web 共享 token + localStorage |
| 交互完整度 | 回合制，缺本地 slash | 回合制 + 自实现命令解析；仍非 PTY |

---

## 7. 对你的平台设计的直接启发

ccgui 基本验证了你选的 **Model A（本地 daemon）** 是可行且干净的，几条可直接借鉴：

1. **"唯一事实源 = 本地守护进程的 RPC 服务"**，桌面/Web/未来 App 都做它的客户端 —— 与你"装一个服务即可多端管理"完全吻合。
2. **统一 JSON-RPC + 全局事件总线 broadcast**：请求/响应按 id 匹配，事件按 `{method,params}` 通知 fan-out。协议极简、易在任意客户端复用。
3. **Web 层做"静态资源 + HTTP/WS↔TCP 桥接"**：浏览器拿到与桌面端一致的流，前端代码近乎复用 —— 你做 Web-first、App-later 时能省一套协议。
4. **守护进程默认安全**：无 token 拒启；只对 loopback 自动拉起；停进程要核对进程名再 kill。
5. **PATH 修复 `fix_path_env`**：GUI/守护进程务必从用户 shell 同步 PATH，否则找不到 `claude`。

它**没有覆盖、需要你补**的恰好是你架构里规划的远程部分：
- 当前 Web 是**明文 + 共享 token**，仅适合 loopback/局域网。要公网远程 → 你的 **outbound 隧道 + relay + 设备配对 + E2E** 这层正是缺口。
- 仍是**回合制 `-p`，非 PTY** → 若要 slash 命令/REPL 完全保真，你之前定的 **PTY-first 通道**仍是 ccgui 没走的路，是你的差异化点。

---

## 8. 关键源码索引

- 守护进程入口与接入循环：`src-tauri/src/bin/cc_gui_daemon.rs`（`main`:2182、`accept`:2220、事件总线:2200、`parse_args`:441）
- 守护进程状态核心：`src-tauri/src/bin/cc_gui_daemon/daemon_state.rs`
- 桌面端 RPC 客户端：`src-tauri/src/remote_backend.rs`（`call`:69、`read_loop`:211、通知映射:258）
- 守护进程自动拉起/停止：`src-tauri/src/web_service/daemon_bootstrap.rs`
- Web 服务（axum，路由/桥接）：`src-tauri/src/bin/cc_gui_daemon/web_service_runtime.rs`（路由:145、`api_rpc`:617、`ws_endpoint`:661、`handle_socket`:674）
- Claude 引擎与启动参数：`src-tauri/src/engine/claude.rs`（参数构建:820-959、Drop 清理:70）
- 多引擎抽象：`src-tauri/src/engine/mod.rs`（`EngineType`:50）
- Claude 历史读取：`src-tauri/src/engine/claude_history.rs`
- 工作区会话：`src-tauri/src/backend/app_server.rs`（`WorkspaceSession`:432）
