# ADR: cc-agent-daemon Mac GUI 项目架构

## 状态

Proposed

## 背景

Mac GUI 需要实现 `docs/gui/mac/prd.md` 中定义的原生 macOS 客户端能力：连接 cc-agent-daemon、浏览历史会话、按工作目录管理会话、新建/续聊/挂接实时会话、渲染流式消息和工具调用、处理权限确认，并支持 macOS 原生 UI、系统主题、Keychain、Material/Liquid Glass 降级。

cc-agent-daemon 已通过 WebSocket 暴露 JSON-RPC 2.0 接口。Web 端已经完成一版可运行实现，Mac 端应以 Web 端行为为基准，而不是重新定义产品行为。

仓库历史中曾有 `repos/cc-agent-mac` SwiftUI 客户端骨架，可复用工程结构、WebSocket 客户端、Keychain、会话列表聚合、通知路由、流式消息解析和部分 UI。但该骨架尚未完全满足 PRD，尤其缺少完整历史 assistant/tool 解析、AskUserQuestion、权限输入编辑、聊天侧栏和真正自动重连。

## 架构目标

1. 行为与 Web 端一致：同一 daemon RPC，同一会话生命周期，同一消息模型。
2. 原生 macOS 体验：窗口、侧栏、键盘输入、Keychain、系统主题、Material/玻璃样式。
3. 可演进：MVP 可快速落地，后续可以逐步补齐 Markdown 表格、长列表虚拟化、Liquid Glass 新 API。
4. 可测试：协议、状态机、消息转换、权限响应等核心逻辑可脱离 UI 单测。
5. 安全优先：token 安全存储，工作区信任校验，权限请求归属明确。

## 总体决策

### ADR-001: 使用原生 SwiftUI App

**决策**  
Mac GUI 使用原生 SwiftUI App，不使用 WebView 包装 Web 端。

**理由**

- PRD 要求 macOS 原生窗口、侧栏、系统主题、Keychain、响应式布局和玻璃降级。
- SwiftUI 更容易接入 AppKit 能力，例如 `NSVisualEffectView`、`NSOpenPanel`、Keychain。
- 后续发布、签名、notarization、Intel/Apple Silicon universal build 更符合 macOS 原生路径。

**被拒方案**

- WebView 包 Web 版：复用快，但 Keychain、原生窗口、系统风格、长会话性能和权限弹窗体验较弱。
- Electron/Tauri：引入额外运行时，与当前 daemon 和 macOS 原生诉求不匹配。

### ADR-002: 使用 XcodeGen 管理工程

**决策**  
Mac 端工程使用 XcodeGen `project.yml` 生成 `.xcodeproj`。

**理由**

- 避免手工维护 Xcode 工程文件。
- 方便明确 target、依赖、entitlements、最低系统版本、测试 target。
- 历史实现已采用该方案，可延续。

**工程建议**

- 目录：`repos/cc-agent-mac`
- Target：`CCAgent`
- Test Target：`CCAgentTests`
- 最低系统：macOS 14
- 架构：Apple Silicon + Intel
- 依赖：MarkdownUI 作为 Markdown MVP 渲染库

### ADR-003: 使用 URLSessionWebSocketTask + JSON-RPC 2.0

**决策**  
Mac 客户端直接使用 Foundation `URLSessionWebSocketTask` 连接 daemon `/ws`，上层封装 JSON-RPC 2.0 client。

**理由**

- daemon 原生协议就是 WebSocket + JSON-RPC。
- 不需要额外网络依赖。
- 可和 Web 端 `DaemonClient` 保持一致抽象：`call(method:params:)`、pending request、notification handler、断线重连。

**关键要求**

- 每个 RPC request 带递增 id。
- 维护 pending id 到 continuation/callback 的映射。
- 收到带 id 且无 method 的消息视为 RPC response。
- 收到带 method 的消息视为 daemon notification。
- token 可放在 `/ws?token=`，连接后仍执行 `auth` 做显式认证。
- 非主动断开进入重连状态，指数退避，最大 30 秒。

### ADR-004: 使用 MVVM + 服务层

**决策**  
SwiftUI View 只负责渲染和用户交互，业务状态集中在 ViewModel 和 Service。

**理由**

- 聊天页状态复杂：历史加载、实时挂接、session alias、权限弹窗、流式更新、模型切换。
- 把业务逻辑放进 View 会导致难以测试和维护。
- ViewModel 可以直接单测状态变更和 RPC 调用顺序。

**分层**

- App 层：全局连接、路由、主题。
- Networking 层：WebSocket、JSON-RPC、daemon notification。
- Domain/Service 层：会话列表聚合、消息转换、权限响应、工作区信任。
- Feature 层：登录、会话列表、聊天。
- Design 层：主题、玻璃样式、通用组件。

### ADR-005: 历史消息和实时消息使用同一消息模型

**决策**  
历史 JSONL 消息和实时 SDK event 都转换为同一组 UI message/block 模型。

**理由**

- PRD 明确要求“回复中对话和历史消息对话样式一致”。
- Web 端已经证明需要统一处理 text、thinking、tool_use、tool_result、metrics。
- 如果历史和实时分两套渲染逻辑，会出现工具卡片、thinking、token 显示不一致。

**消息模型**

- `ChatMessage`
  - role: user / assistant / system
  - content: plain text 或 structured blocks
  - streaming
  - model
  - metrics
- `MessageBlock`
  - text
  - thinking
  - tool_use
- `ToolResultState`
  - pending / completed / error
  - content
  - isError

### ADR-006: MarkdownUI 作为 MVP，保留渲染替换点

**决策**  
MVP 使用 MarkdownUI 渲染 Markdown，并为代码块、表格和图片保留替换点。

**理由**

- SwiftUI 原生集成成本低。
- 支持基本 Markdown 和文本选择。
- PRD 要求 GFM 表格、代码横向滚动和图片，需要早期实测。若 MarkdownUI 不满足，再局部替换为自定义 renderer 或 WebKit markdown renderer。

**约束**

- Markdown 渲染必须封装在独立组件中，聊天页和消息行不直接依赖具体库。
- 表格和代码块 QA 不通过时，不影响上层消息模型。

### ADR-007: Material / NSVisualEffectView 先行，Liquid Glass 延后接入

**决策**  
当前主线使用 `.ultraThinMaterial` 和 `NSVisualEffectView` 实现玻璃降级样式。Liquid Glass 新 API 只在未来 SDK 明确支持后接入。

**理由**

- 当前本地环境 Xcode 16.3 / macOS SDK 15.4 未发现 `glassEffect`。
- 直接引用新 API 会导致旧 SDK 编译失败，单纯 `#available` 不够。
- 统一封装 `glassCard` modifier，未来可以在内部替换实现。

**实现边界**

- UI 业务组件只调用设计系统提供的 glass modifier。
- 不在业务 View 中直接写系统玻璃 API。

## 模块架构

### 1. App Shell

职责：

- App 启动。
- 全局对象注入。
- 登录态和连接态门禁。
- 主路由：会话首页、聊天页。

建议模块：

- `AppState`
- `AppRoute`
- `RootView`
- `CCAgentApp`

关键状态：

- connection phase: disconnected / connecting / connected
- route: sessionList / chat(workspacePath, sessionId)
- reconnectNonce
- connectionError
- sessionUnlocked

### 2. Auth & Preferences

职责：

- 保存 token、WS 地址、主题和 UI 偏好。
- 提供读取/写入统一入口。

建议模块：

- `CredentialStore`
- `WSConnectionConfig`
- `ThemePreferenceStore`
- `UIPreferencesStore`

存储策略：

- token: Keychain
- WS host/port/TLS: UserDefaults
- theme: UserDefaults
- directory expansion: UserDefaults
- chat sidebar open: UserDefaults
- follow output: UserDefaults

### 3. Networking & RPC

职责：

- 建立 WebSocket。
- 执行 JSON-RPC 请求。
- 接收 daemon notification。
- 处理断线重连。

建议模块：

- `DaemonClient`
- `JSONRPCRequest`
- `JSONRPCResponse`
- `JSONValue`
- `DaemonModels`
- `NotificationRouter`

连接状态机：

1. disconnected
2. connecting
3. connected
4. reconnecting，可复用 connecting phase
5. disconnected by user

重连策略：

- 主动断开：不重连。
- 非主动断开：所有 pending RPC 失败，进入 connecting。
- 重连延迟：`min(1000 * 2^attempt, 30000)` ms。
- 重连成功：触发 reconnect nonce，页面重新拉取 active sessions 和必要历史状态。

### 4. Session List Domain

职责：

- 合并 daemon 历史会话和手动工作区。
- 生成按工作目录分组的会话列表。
- 维护缓存和 active 状态。

建议模块：

- `SessionListService`
- `SessionGroupBuilder`
- `ActiveSessionsPoller`
- `DirectoryExpansionStore`

数据来源：

- `history.listAllLocal`
- `workspace.list`
- `history.listSessions`
- `session.listActive`

排序规则：

- 目录按目录内最新会话时间倒序。
- 目录内会话按 `lastTimestamp` 倒序。
- 手动添加但没有历史会话的目录，可以显示为空目录或仅作为新对话入口，具体由产品确认。

### 5. Chat Domain

职责：

- 管理当前聊天工作区和会话。
- 处理新建、恢复、挂接、发送、停止。
- 管理模型、effort、permission mode。
- 维护实时 run state。

建议模块：

- `ChatViewModel`
- `ChatSessionController`
- `ChatSessionRouting`
- `SessionAliasRegistry`
- `WorkspaceTrustService`

会话 id 策略：

- daemon 事件中可能出现 disk sessionId、runtimeId、sdkSessionId。
- Mac 端必须维护 alias set。
- 任一 id 命中当前会话 alias，即认为属于当前会话。
- `system init` 返回新 sdk session id 时，需要注册 alias 并更新当前 live session。

### 6. Message Pipeline

职责：

- 把实时 SDK event 和历史 JSONL 转成统一 UI message。
- 合并 assistant 多段 block。
- 合并 tool_use 和 tool_result。
- 过滤非对话历史条目。
- 维护 token/耗时指标。

建议模块：

- `MessageBlocksEngine`
- `HistoryMessageConverter`
- `TurnStream`
- `ToolResultMerger`

处理规则：

- `stream_event` text delta 追加到最后一个 text block。
- thinking delta 追加到最后一个 thinking block。
- content block start tool_use 创建 pending tool card。
- user tool_result 更新对应 tool card 结果。
- result 结束当前 turn。
- compact summary、transcript-only、纯 tool_result user message 不渲染为用户消息。

### 7. Permissions

职责：

- 接收 permission/request。
- 展示普通工具权限弹窗。
- 展示 AskUserQuestion 专用问题选择器。
- 构造 permission.respond 参数。

建议模块：

- `PermissionPromptViewModel`
- `PermissionPromptView`
- `AskUserQuestionParser`
- `QuestionPickerView`
- `PermissionResponseBuilder`

普通权限响应：

- allow: 可携带 edited `updatedInput` JSON object。
- deny: 携带拒绝原因 message。

AskUserQuestion 响应：

- 从 input.questions 生成问题 UI。
- 单选或多选。
- 所有问题完成后提交。
- 返回原 input 加 answers。

### 8. UI & Design System

职责：

- 提供统一主题、间距、颜色、玻璃样式和基础组件。
- 隔离系统版本差异。

建议模块：

- `Theme`
- `GlassBackground`
- `VisualEffectView`
- `StatusBadge`
- `ToolUseCard`
- `MessageBubble`
- `MarkdownBlock`

布局建议：

- 登录页：居中 card。
- 首页：`NavigationSplitView` 或单栏 `List`。
- 聊天页：左侧可收起会话侧栏 + 中央消息区 + 底部 composer。
- 小窗口：侧栏自动收起或用覆盖层展示。

## 核心数据流

### 登录连接流

1. 用户输入 host、port、TLS、token。
2. 保存 token 到 Keychain，保存 WS 配置到 UserDefaults。
3. `DaemonClient.connect()` 打开 WebSocket。
4. 执行 `auth`。
5. 可选执行 `ping`。
6. 成功后进入会话首页。
7. 失败则关闭连接并展示错误。

### 会话首页加载流

1. 调用 `history.listAllLocal` 获取 Claude 本地历史。
2. 调用 `workspace.list` 获取手动添加的工作区。
3. 对没有历史数据的手动工作区调用 `history.listSessions`。
4. 合并成 `SessionListData`。
5. 生成 `SessionGroup` 并排序。
6. 轮询 `session.listActive` 更新会话状态标识。

### 打开聊天流

1. 用户点击“新对话”或历史 session。
2. 进入 `chat(workspacePath, sessionId?)` route。
3. 调用 `workspace.checkTrust`。
4. 未信任则弹窗；信任后继续。
5. 历史 session 调用 `history.loadSession`。
6. 历史消息转换成 UI messages 和 tool results。
7. 调用 `session.attachIfLive`，若 live 则订阅实时事件。

### 发送消息流

1. 用户输入消息并发送。
2. 如果没有 live session，调用 `session.create`。
3. 如果有历史 session，优先 `session.attach`；失败则 `session.resume`。
4. 调用 `session.sendMessage`。
5. `TurnStream` 创建 streaming assistant message。
6. daemon 推送 `session/event`，Message Pipeline 增量 patch 当前 assistant message。
7. daemon 推送 result 或 completed status，结束 turn。

### 权限请求流

1. daemon 推送 `permission/request`。
2. `NotificationRouter` 分发给当前会话。
3. 普通工具显示权限弹窗；AskUserQuestion 显示问题选择器。
4. 用户 allow 或 deny。
5. 调用 `permission.respond`。
6. daemon 继续或拒绝工具调用。

### 断线重连流

1. WebSocket 非主动关闭。
2. 当前 pending RPC 全部失败。
3. UI 进入 connecting 状态，但不清空 route 和本地偏好。
4. 指数退避重连。
5. 重连成功后：
   - 重新安装 notification handler。
   - 当前聊天页重新 `attachIfLive`。
   - 首页刷新 `session.listActive` 和必要会话列表。

## RPC 契约

Mac 客户端依赖以下 daemon RPC：

- 认证：`auth`，可选 `ping`。
- 设置：`settings.get`。
- 工作区：`workspace.list`、`workspace.add`、`workspace.checkTrust`。
- 历史：`history.listAllLocal`、`history.listSessions`、`history.loadSession`。
- 会话：`session.create`、`session.resume`、`session.attachIfLive`、`session.attach`、`session.detach`、`session.sendMessage`、`session.interrupt`、`session.setPermissionMode`、`session.listActive`。
- 权限：`permission.respond`。

Mac 客户端必须处理以下 daemon notification：

- `session/event`
- `session/status`
- `permission/request`

## 安全架构

1. token 必须进入 Keychain，不写入普通日志。
2. 局域网连接必须有 token。
3. WS URL 可携带 token，但 UI 不应在错误日志中展示完整 URL。
4. 进入工作目录前必须调用 `workspace.checkTrust`。
5. `session.create`、`session.resume`、`history.loadSession` 前需要确认工作区可信。
6. 权限请求只对当前绑定会话展示。
7. 断线后未处理权限由 daemon 拒绝，客户端重连后不应尝试补发旧权限响应。

## 性能架构

### MVP

- `ScrollView + LazyVStack + ScrollViewReader` 渲染消息。
- 实时流式只更新最后一条 assistant message。
- 消息转换放在 ViewModel/Service 层，View 不做 JSON 解析。

### 扩展

- 长会话超过阈值时只渲染最近 N 条。
- 顶部提供“加载更早消息”。
- Markdown block 做缓存，避免每次流式 delta 重渲染历史消息。
- 工具结果大文本限制高度，内部滚动。

## 测试策略

优先单测非 UI 核心逻辑：

- WS URL 构造和 token encoding。
- JSON-RPC response/notification decode。
- 重连退避。
- Session group 排序。
- Active sessions 状态映射。
- History JSONL 到 ChatMessage 转换。
- SDK stream event 到 MessageBlock 转换。
- Tool result 合并。
- Permission respond 参数构造。
- AskUserQuestion 解析和 answers 构造。
- Session alias 匹配。

集成验证：

- daemon 本地 `127.0.0.1:4733` + token 连接。
- 历史会话读取。
- 新建会话、发送、停止。
- permission/request 往返。
- 断线重连后 attach 当前会话。

## 分阶段落地

### M1: 工程与连接

- 建立 XcodeGen 工程。
- 完成 App Shell、CredentialStore、WSUrl、JSON-RPC、DaemonClient。
- 登录页连接 daemon。
- 完成自动重连状态机。
- 补基础单测。

### M2: 会话首页

- 实现 SessionListService。
- 首页目录分组、排序、展开折叠。
- 添加工作区、刷新、断开。
- active session 轮询和 badge。

### M3: 聊天 MVP

- Chat route 和 ChatViewModel。
- 工作区信任弹窗。
- 历史加载。
- 新建 session、发送消息、停止。
- 实时 text/thinking/tool_use 渲染。
- 模型、effort、permission mode 控件。

### M4: Web 等价能力

- 历史 assistant/tool 完整转换。
- 历史与实时样式一致。
- 权限弹窗支持 updatedInput 和拒绝原因。
- AskUserQuestion。
- 聊天侧栏和自动跟随回复偏好。
- session alias 完整匹配。

### M5: 性能、设计和发布准备

- 长会话滚动优化。
- Markdown 表格、代码块、图片 QA。
- Material/VisualEffect 设计统一。
- Intel + Apple Silicon 构建。
- Hardened Runtime、签名、notarization 预留。

## 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| MarkdownUI 表格能力不足 | 无法满足 PRD 表格渲染 | 封装 MarkdownBlock，必要时替换 renderer |
| SwiftUI 长列表流式卡顿 | 长会话体验差 | 窗口化、分页、缓存 Markdown block |
| session id 多源 | resume/attach 后事件丢失 | 维护 disk/runtime/sdk alias set |
| 断线重连后状态不一致 | 当前会话无法继续接收事件 | 重连后重新 attachIfLive |
| Liquid Glass API 编译不兼容 | 旧 SDK 无法构建 | 当前只用 Material/NSVisualEffectView，未来独立接入 |
| 权限请求归属错误 | 安全风险 | notification 按当前会话绑定过滤，旧权限不补发 |

## 未决问题

1. 手动添加但没有历史会话的工作区是否在首页显示为空目录。
2. Markdown 表格最终采用 MarkdownUI、自定义 renderer 还是局部 WebKit。
3. 新建会话后 native route 是否立即替换为带 sessionId 的 route，建议是。
4. 是否需要支持从 Finder 拖拽目录到首页添加工作区。
5. 是否需要在 Mac App 内启动/管理 daemon 进程。当前 ADR 假设 daemon 独立运行。

## 参考

- PRD: `docs/gui/mac/prd.md`
- Web PRD: `docs/gui/web/prd.md`
- 调研文档: `docs/gui/mac/implementation-research.md`
- daemon RPC: `repos/cc-agent-daemon/src/rpc/router.ts`
- Apple Developer Documentation: `URLSessionWebSocketTask`  
  https://developer.apple.com/documentation/foundation/urlsessionwebsockettask
- Apple Developer Documentation: `NavigationSplitView`  
  https://developer.apple.com/documentation/swiftui/navigationsplitview
- Apple Developer Documentation: `NSVisualEffectView`  
  https://developer.apple.com/documentation/appkit/nsvisualeffectview
- Apple Developer Documentation: Keychain Services  
  https://developer.apple.com/documentation/security/keychain_services
