# cc-agent-daemon GUI 支持 Web 端

Web GUI 通过 cc-agent-daemon 暴露的 WebSocket + JSON-RPC 2.0 接口，连接并控制本机或局域网内的 Claude Agent SDK 会话。当前文档按 `repos/cc-agent-daemon/web` 已编码实现补全，用于描述现有 Web 端产品能力、模块划分和接口依赖。

## 产品目标

1. 提供浏览器可访问的 Claude 会话管理界面，支持连接 daemon、浏览历史会话、新建/续聊/挂接实时会话。
2. 按工作目录组织会话，目录与目录内会话按最近会话时间倒序展示。
3. 在聊天页提供接近 Claude Code 的实时输出体验：流式消息、thinking、工具调用、权限确认、停止运行、模型/思考强度/权限模式切换。
4. 支持桌面浏览器和移动端浏览器访问，开发模式支持本机与局域网联调。

## 技术范围

- 前端：React 19 + React Router 7 + Vite + Tailwind CSS。
- 通信：浏览器 WebSocket 连接 daemon `/ws`，RPC 使用 JSON-RPC 2.0。
- 渲染：`react-markdown` + `remark-gfm` 渲染 Markdown，`react-virtuoso` 虚拟列表渲染长会话。
- 存储：连接信息、主题、目录展开状态、聊天侧栏状态、自动跟随回复状态使用 `localStorage`。

## 功能要求

### 1. 登录与连接

- 登录页包含 WS 地址输入框、token 输入框、显示/隐藏 token 按钮、连接按钮、主题切换按钮。
- 开发环境 token 默认预填 `cddchen`；WS 默认地址根据当前页面推导：
  - Vite 开发端口 `5174` 下默认走同源 `/ws` 代理。
  - 其他端口默认连接当前 host 的 `4733` 端口。
- 点击连接后保存 WS 地址和 token 到本地，并建立 WebSocket。
- 连接成功进入会话首页；连接中显示全屏加载态；连接失败回到登录页并展示错误。
- WebSocket 断开后自动重连，重连间隔指数退避，最大 30 秒。

### 2. 会话首页

- 首页展示连接状态、刷新、切换连接、主题切换。
- 支持手动添加工作目录，调用 daemon 将目录加入信任/工作区列表。
- 会话列表按工作目录分组展示：
  - 自动读取 `~/.claude/projects` 中已有历史会话。
  - 合并手动添加的工作目录。
  - 目录按该目录最近会话时间倒序排序。
  - 目录内会话按最近更新时间倒序排序。
- 每个目录展示目录路径、会话数量、最近更新时间，并支持展开/折叠。
- 每个目录下提供“新对话”入口；每个会话展示 sessionId 摘要、消息数、最近更新时间。
- 对运行中或可挂接的会话展示状态标识，状态定时刷新。

### 3. 聊天页

- 路由：
  - `/chat/:workspacePath`：指定工作目录的新对话。
  - `/chat/:workspacePath/:sessionId`：打开历史会话或实时会话。
- 进入聊天页后先检查工作目录信任状态；未信任时弹窗要求信任当前目录或父目录。
- 打开历史会话时从 daemon 加载 JSONL 历史消息，并尝试挂接仍存活的实时会话。
- 新对话首条消息发送前创建 session；创建成功后将 URL 替换为带 sessionId 的会话地址。
- 已有会话发送消息时优先 attach；若运行态丢失，则按历史 sessionId resume 后继续发送。
- 支持：
  - 输入消息，Enter 发送，Shift+Enter 换行。
  - 运行中停止当前会话。
  - 模型选择：Sonnet、Opus、Haiku、自定义模型。
  - 思考强度选择：low、medium、high、xhigh、max。
  - 权限模式选择：default、acceptEdits、plan、auto、bypassPermissions、dontAsk。
  - 侧栏按目录展示全部会话，桌面端可收起，移动端以抽屉展示。
  - 自动跟随回复开关。

### 4. 消息与工具渲染

- 用户消息以纯文本气泡展示。
- Assistant 消息按结构化 block 渲染：
  - `text`：Markdown + GFM，支持代码块、表格、图片、链接。
  - `thinking`：可折叠 thinking 区块，流式阶段默认展开。
  - `tool_use`：工具调用卡片，展示工具名、状态、输入摘要、可展开 JSON 输入与结果。
- 支持流式增量更新，实时显示模型、token 用量、耗时。
- 历史消息加载时过滤 compact summary、transcript-only 和纯 tool result 用户消息，避免展示非真实对话内容。
- 长会话必须使用虚拟列表渲染，避免大量消息导致页面卡顿。

### 5. 权限与问题交互

- daemon 推送 `permission/request` 时，聊天页弹出工具权限确认。
- 普通工具权限支持：
  - 查看工具名。
  - 编辑允许时提交的 `updatedInput` JSON object。
  - 填写拒绝原因。
  - 允许或拒绝。
- `AskUserQuestion` 工具使用专门的问题选择器：
  - 支持单选和多选。
  - 所有问题必须完成选择后才能提交。
  - 提交时把答案写回 `updatedInput.answers`。

### 6. 主题与本地偏好

- 支持 light、dark、system 三种主题偏好。
- 首页目录展开状态、聊天侧栏展开状态、自动跟随回复状态需要本地持久化。
- 连接切换只断开当前 WebSocket，不清空本地 token 和地址，方便重新连接。

## 模块划分

### 应用入口

- `src/App.tsx`：注册全局 Provider，并通过 `Gate` 按连接状态切换登录页和业务路由。
- `src/main.tsx`：React 挂载入口。

### 连接与通知

- `context/DaemonContext.tsx`：管理 token、WS 地址、连接状态、连接/断开、重连计数。
- `lib/daemonClient.ts`：封装 WebSocket JSON-RPC 调用、pending 请求、通知分发、断线重连、模型/权限/effort 常量。
- `context/ChatNotifyContext.tsx`：把 daemon notification 分发给当前会话，支持按 sessionId/runtimeId/sdkSessionId 过滤。
- `lib/wsUrl.ts`：生成默认 WS 地址和带 token 的 `/ws` URL。

### 首页与会话列表

- `pages/HomePage.tsx`：首页 UI、工作目录添加、刷新、目录折叠、会话入口。
- `lib/sessionListCache.ts`：合并 `history.listAllLocal`、`workspace.list`、`history.listSessions`，并按最近时间生成目录分组。
- `hooks/useActiveSessions.ts`：轮询 `session.listActive`，生成运行中/存活状态标识。
- `lib/activeSessionBadge.ts`：会话状态标识文案与样式。

### 聊天主流程

- `pages/ChatPage.tsx`：聊天页状态编排，负责工作区信任、历史加载、实时挂接、新建/恢复会话、发送/停止、权限响应、模型/effort/权限模式切换、侧栏。
- `hooks/useTurnStream.ts`：把 SDK 流事件合并成当前 assistant turn，维护流式 block、工具结果、模型、token 和耗时。
- `lib/chatSessionRouting.ts`：会话路由替换、通知绑定策略、daemon 运行状态到 UI 状态的映射。
- `lib/chatModelControls.ts`：模型种类、自定义模型、历史会话切换模型时的 resume 逻辑。

### 消息渲染

- `components/VirtualMessageList.tsx`：虚拟列表与自动跟随。
- `components/ChatMessageRow.tsx`：用户/assistant 消息气泡。
- `components/AssistantMessageBody.tsx`：assistant block 渲染。
- `components/MessageMarkdown.tsx`：Markdown/GFM 渲染。
- `components/ToolUseCard.tsx`：工具调用卡片。
- `components/ModelReplyFeedback.tsx`：流式回复、thinking、工具调用中的反馈状态。
- `lib/messageBlocks.ts`：SDK 事件和 JSONL 历史消息到 UI 消息块的转换、合并和过滤。

### 权限、信任和偏好

- `components/QuestionPicker.tsx`、`lib/askUserQuestion.ts`：`AskUserQuestion` 解析与答案构造。
- `lib/permissionResponses.ts`：普通权限请求的 allow/deny 参数构造。
- `lib/workspaceTrust.ts`：工作区信任信息类型与路径辅助。
- `context/ThemeContext.tsx`、`components/ThemeToggle.tsx`：主题偏好与切换。
- `lib/uiPreferences.ts`：首页和聊天页本地偏好读写。

## RPC 依赖

Web 端依赖 daemon 的以下 JSON-RPC 方法：

- 连接认证：`auth`。
- 设置：`settings.get`。
- 工作区：`workspace.list`、`workspace.add`、`workspace.checkTrust`。
- 历史会话：`history.listAllLocal`、`history.listSessions`、`history.loadSession`。
- 会话生命周期：`session.create`、`session.resume`、`session.attachIfLive`、`session.attach`、`session.detach`、`session.sendMessage`、`session.interrupt`、`session.setPermissionMode`、`session.listActive`。
- 权限：`permission.respond`。

Web 端处理 daemon 主动推送：

- `session/event`：SDK 流事件、system init、assistant/user/result 消息。
- `session/status`：running、completed、error、interrupted 等运行状态。
- `permission/request`：工具权限与 AskUserQuestion 请求。

## UI 要求

1. 页面采用响应式布局：桌面端聊天页显示可收起侧栏，移动端使用抽屉侧栏。
2. 列表、路径、sessionId、工具输入等长文本必须截断或可滚动，不得撑破布局。
3. 会话消息区域必须支持长列表高性能滚动，流式回复时不应造成明显卡顿。
4. Markdown 必须支持代码块、表格、链接、图片基础展示；代码块和表格需要横向滚动。
5. 工具调用、thinking、权限弹窗、信任弹窗必须有明确状态，不把原始 SDK 事件直接裸露给用户。
6. 支持深色模式和系统主题跟随。

## 安全要求

1. daemon 默认需要 token；WebSocket URL 必须携带 token 或连接后执行 `auth`。
2. daemon 绑定 `0.0.0.0` 时必须使用 token；不允许在局域网模式使用无认证连接。
3. 会话创建、恢复、历史读取必须经过工作区信任/allowlist 校验。
4. 工具权限请求必须由拥有该会话权限客户端连接响应，断开连接时未处理权限应被拒绝。

## 验收标准

1. 启动 `npm run dev:all` 后，浏览器打开 `http://localhost:5174`，使用默认 token 能连接 daemon。
2. 首页能展示本机 Claude 历史会话，并按目录最近时间倒序排序。
3. 手动添加工作目录后，该目录可出现在首页，并可进入新对话。
4. 新对话发送首条消息后，URL 自动变为 `/chat/:workspacePath/:sessionId`，并实时展示回复。
5. 打开已有会话能加载历史消息；若会话仍在运行，能挂接并继续接收事件。
6. 运行中可停止；停止后列表和聊天页状态正确更新。
7. 工具权限请求能弹窗允许/拒绝；`AskUserQuestion` 能以选项形式回答。
8. 长会话滚动、Markdown、代码块、表格、工具结果展示正常。
