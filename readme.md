# 仓库现状说明

> 更新时间：2026-06-18  
> 调研范围：`/Users/cdd/Documents/cc` 工作区，重点是 `repos/cc-agent-daemon`，并参考 `repos/desktop-cc-gui`、`repos/cui`、`repos/claude-code-analysis`。

## 一句话结论

当前工作区的核心目标是构建一个 **本地 Claude Agent SDK Daemon**：在用户本机运行一个 TypeScript/Node 守护进程，通过 **WebSocket + JSON-RPC 2.0** 向 Web / App 客户端暴露 Claude Code 会话管理能力。

`repos/cc-agent-daemon` 已经不只是设计文档，而是有了可运行的 Phase 1 原型：后端 daemon、RPC、鉴权、会话管理、历史读取、权限回流、SQLite 元数据和 React Web 测试 UI 均已有实现。

## 工作区结构

```text
/Users/cdd/Documents/cc
├── docs/
│   ├── ccgui-research.md
│   ├── cc-integration-p-vs-agent-sdk.md
│   ├── claude-agent-sdk-integration.md
│   └── daemon/
│       ├── 00-design.md
│       ├── acceptance.md
│       └── tests/M01-M08.md
├── .plans/
│   └── parsed-questing-fern.md
└── repos/
    ├── cc-agent-daemon/        # 当前主实现，TypeScript daemon + React Web UI；目录本身不是 git repo
    ├── desktop-cc-gui/         # 参考项目，Tauri + Rust daemon 架构
    ├── cui/                    # 参考项目
    └── claude-code-analysis/   # 参考/分析项目
```

注意：`/Users/cdd/Documents/cc` 根目录本身不是 git 仓库；真正的参考仓库位于 `repos/` 下。其中 `cc-agent-daemon` 目录当前也不是 git repo。

## 核心项目：`repos/cc-agent-daemon`

### 项目定位

`cc-agent-daemon` 是一个本地守护进程，封装 `@anthropic-ai/claude-agent-sdk`，让浏览器或未来移动 App 可以连接本机 daemon 来管理 Claude Code 会话。

Phase 1 目标：

- 本地优先：默认绑定 `127.0.0.1`
- token 鉴权：支持 URL query token / header token / RPC `auth`
- WebSocket + JSON-RPC 2.0：客户端无关，方便未来移动端接入
- 多客户端会话订阅：多个客户端可 attach 到同一会话并接收事件流
- 权限回流：SDK `canUseTool` 请求通过 `permission/request` 推给客户端，再由 `permission.respond` 回答
- 历史只读：读取本机 `~/.claude/projects/**/*.jsonl`
- 元数据存储：保存 workspace、session meta、folder 预留结构

### 技术栈

后端：

- Node.js `>=22.4.0`
- TypeScript
- Fastify
- `@fastify/websocket`
- Zod
- `@anthropic-ai/claude-agent-sdk`
- Node 内置 `node:sqlite`
- Vitest

前端：

- React 19
- Vite
- React Router
- React Markdown
- React Virtuoso
- Tailwind CSS

说明：早期设计中提到过 `better-sqlite3`，但当前实际实现使用的是 Node 内置 `node:sqlite`，所以运行时要求 Node `>=22.4.0`。

## 已实现能力

### 1. 服务与配置

已实现文件：

- `src/index.ts`
- `src/config.ts`
- `src/server.ts`
- `src/app/context.ts`

能力：

- `GET /health` 健康检查
- `GET /ws` WebSocket 入口
- `--listen`、`--port`、`--data-dir`、`--token`、`--insecure-no-auth` 参数解析
- `CC_AGENT_DAEMON_TOKEN` 环境变量
- loopback 本地开发可用 `--insecure-no-auth`
- LAN 监听 `0.0.0.0` 时强制要求 token，禁止 insecure 模式

### 2. JSON-RPC 协议层

已实现文件：

- `src/rpc/protocol.ts`
- `src/rpc/router.ts`
- `src/rpc/schemas.ts`
- `src/rpc/connection.ts`

能力：

- JSON-RPC 2.0 请求 / 响应
- notification：无 `id` 请求不返回响应
- parse error / invalid request / method not found / unauthorized / invalid params / internal error
- Zod 参数校验
- 明确不支持 batch request

### 3. 鉴权与安全

已实现文件：

- `src/security/auth.ts`
- `src/security/workspaceGuard.ts`

能力：

- token 生成、加载、校验
- URL query token 提取
- header `x-cc-daemon-token`
- insecure 模式跳过鉴权，仅用于本地开发
- workspace allowlist
- `realpath` canonical path 校验
- 防止通过 symlink 逃逸 allowlist

### 4. 会话管理

已实现文件：

- `src/session/claudeEngine.ts`
- `src/session/runner.ts`
- `src/session/registry.ts`
- `src/session/types.ts`

能力：

- 基于 `@anthropic-ai/claude-agent-sdk` 的 `query(...)`
- 流式输入
- 支持 `cwd`、`model`、`permissionMode`、`allowedTools`、`disallowedTools`
- 支持 `settingSources`、`systemPrompt`、`effort`
- 支持 resume / fork session
- 支持 `interrupt()`
- 支持动态 `setPermissionMode()`
- 多客户端订阅同一 session runner
- 广播 `session/event`
- 广播 `session/status`
- 处理 SDK 初始化后返回的真实 `session_id`
- runtime id 与 SDK session id 的 alias 机制

### 5. 权限审批回流

已实现文件：

- `src/permission/registry.ts`

能力：

- SDK `canUseTool` 触发后生成 pending permission request
- 向客户端推送 `permission/request`
- 客户端通过 `permission.respond` 返回 allow / deny
- pending request 按 `sessionId::requestId` 管理
- 只允许 owner connection 响应
- 超时默认 deny
- 会话结束或连接断开时批量 deny

### 6. 本地历史读取

已实现文件：

- `src/history/paths.ts`
- `src/history/reader.ts`

能力：

- 扫描 `~/.claude/projects/*`
- 识别 `.jsonl` session
- 跳过 `agent-*` session
- 读取 JSONL 消息
- 读取消息中的 `cwd` 来恢复 workspace path
- 基于 `parentUuid` 尽力重建消息链
- 按 workspace 列出历史 session

### 7. 元数据存储

已实现文件：

- `src/store/db.ts`

实际使用：`node:sqlite`。

已建表：

- `workspaces`
- `session_meta`
- `folders`
- `session_folder`

能力：

- workspace 增删查
- session meta upsert / migrate / delete
- symlink workspace 会保存 canonical realpath
- folder 表结构已预留，但产品能力尚未接入

### 8. Claude settings 读取

已实现文件：

- `src/settings/reader.ts`

能力：

- 读取个人 Claude settings 中的模型配置
- 读取 permissions allow / deny / defaultMode / additionalDirectories
- 读取 effortLevel

### 9. Web 测试 UI

位置：

- `repos/cc-agent-daemon/web/`

能力：

- 连接 daemon
- 保存 WS URL / token 到 localStorage
- 首页展示本地历史项目和会话
- 添加 workspace
- 新建对话
- 加载历史 session
- resume 历史 session
- 发送消息
- 模型选择和自定义模型名
- effort 选择
- 权限 allow / deny 弹窗
- 展示 assistant message、tool use、tool result
- 使用虚拟列表承载消息流

## 主要 RPC 方法

基础：

- `ping`
- `auth`
- `settings.get`

Session：

- `session.create`
- `session.sendMessage`
- `session.resume`
- `session.fork`
- `session.interrupt`
- `session.setPermissionMode`
- `session.attach`
- `session.detach`
- `session.listActive`
- `session.delete`
- `session.setMeta`

History：

- `history.listAllLocal`
- `history.listSessions`
- `history.loadSession`

Workspace：

- `workspace.list`
- `workspace.add`
- `workspace.remove`

Permission：

- `permission.respond`

MCP：

- `mcp.listServerStatus`：目前是 stub，固定返回空列表

服务端通知：

- `session/event`
- `session/status`
- `permission/request`

## 当前验证结果

本次调研已在本机执行以下命令：

```bash
npm test --prefix /Users/cdd/Documents/cc/repos/cc-agent-daemon
npm run typecheck --prefix /Users/cdd/Documents/cc/repos/cc-agent-daemon
npm run build --prefix /Users/cdd/Documents/cc/repos/cc-agent-daemon/web
```

结果：

- 后端测试：通过
  - 15 个 test files 全部通过
  - 74 个 tests 全部通过
- 后端 TypeScript typecheck：通过
- Web UI 生产构建：通过
  - Vite 成功构建
  - 307 个模块 transformed

尚未在本次调研中验证：

- 真实 API key 环境下的 `session.create` 到 Claude Agent SDK 端到端调用
- 长时间运行 daemon 的稳定性
- 多客户端真实并发 attach / detach 场景
- 移动端接入

## 已有文档

设计与验收：

- `docs/daemon/00-design.md`
- `docs/daemon/acceptance.md`
- `docs/daemon/tests/M01-server.md`
- `docs/daemon/tests/M02-rpc.md`
- `docs/daemon/tests/M03-session.md`
- `docs/daemon/tests/M04-permission.md`
- `docs/daemon/tests/M05-history.md`
- `docs/daemon/tests/M06-store.md`
- `docs/daemon/tests/M07-security.md`
- `docs/daemon/tests/M08-events.md`

背景调研：

- `docs/ccgui-research.md`
- `docs/cc-integration-p-vs-agent-sdk.md`
- `docs/claude-agent-sdk-integration.md`
- `.plans/parsed-questing-fern.md`

## 快速运行

后端 daemon：

```bash
cd /Users/cdd/Documents/cc/repos/cc-agent-daemon
npm install --legacy-peer-deps
npm run dev -- --insecure-no-auth --port 4733
```

健康检查：

```bash
curl http://127.0.0.1:4733/health
```

Web UI：

```bash
cd /Users/cdd/Documents/cc/repos/cc-agent-daemon/web
npm install
npm run dev
```

浏览器打开：

```text
http://127.0.0.1:5174
```

LAN 模式需要显式 token，不能使用 `--insecure-no-auth`：

```bash
TOKEN=$(openssl rand -hex 16)
npm run dev -- --listen 0.0.0.0:4733 --token "$TOKEN"
npm run dev --prefix web -- --host 0.0.0.0
```

## 主要缺口 / 待办

1. **MCP 状态还是 stub**
   - `mcp.listServerStatus` 当前固定返回 `{ servers: [] }`。

2. **folder 能力未产品化**
   - 数据表已有 `folders`、`session_folder`，但缺少 RPC、UI 和完整 store 方法。

3. **session meta 未充分接入列表展示**
   - `session.setMeta` 可以写 `customName`、`pinned`、`archived`，但历史列表展示与排序尚未完整合并这些元数据。

4. **Web UI 管理能力不完整**
   - 后端已有 `workspace.remove`、`session.delete`、`session.setMeta`，但前端入口不完整或未覆盖。

5. **权限 UI 仍较基础**
   - 后端支持 `updatedInput`，但前端主要是 allow / deny，没有编辑工具输入的交互。

6. **前端测试缺失**
   - 后端测试覆盖较完整；Web UI 暂未看到对应测试。

7. **真实 Claude SDK E2E 未验证**
   - 当前测试多数是 mock / Fastify WS 层集成，还需要带真实认证环境的端到端验证。

8. **active session 是内存态**
   - daemon 重启后只能从 Claude 历史 JSONL resume，没有 daemon 自身的 active session 持久恢复。

9. **session stop 语义需继续确认**
   - 删除 active session 已有 registry 层逻辑，但 SDK query/input stream 的真实终止语义还应继续验证。

## 参考仓库 git 状态

执行 `git status --short --branch` 的结果：

- `repos/desktop-cc-gui`：`main...origin/main`，工作区干净
- `repos/cui`：`main...origin/main`，存在未跟踪文件 `docs/cui-research.md`
- `repos/claude-code-analysis`：`main...origin/main`，工作区干净
- `repos/cc-agent-daemon`：不是 git 仓库

## 当前总体判断

`cc-agent-daemon` 已经达到 **Phase 1 可运行原型** 状态：基础链路清晰，后端测试和类型检查通过，Web UI 可以构建。接下来重点应放在真实 Claude SDK 端到端验证、前端管理能力补齐、MCP/metadata/folder 产品化，以及长时间运行与多客户端并发稳定性验证。
