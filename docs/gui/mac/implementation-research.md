# cc-agent-daemon Mac GUI 实现方案调研

本文基于 `docs/gui/mac/prd.md`、`docs/gui/web/prd.md`、`repos/cc-agent-daemon` 的 RPC 实现，以及仓库历史中 `repos/cc-agent-mac` 的 SwiftUI 客户端代码调研整理。目标是判断 macOS 原生客户端的可落地实现路径、模块边界、复用点和风险。

## 结论

1. 推荐使用原生 SwiftUI App，而不是把 Web 版包进 WebView。原因是 PRD 要求 macOS 原生体验、Keychain 凭据、窗口/侧栏/系统主题、Liquid Glass 降级，这些用 SwiftUI 更直接。
2. 通信层使用 `URLSessionWebSocketTask` + JSON-RPC 2.0，和 Web 端 `DaemonClient` 保持同一行为：token 认证、pending RPC、daemon notification 分发、断线重连。
3. UI 和业务行为以 Web 端为基准迁移。仓库历史中的 `repos/cc-agent-mac` 已有可复用骨架，但不是完整实现，尤其需要补齐历史 assistant/tool 渲染、权限输入编辑、AskUserQuestion、聊天侧栏和自动重连策略。
4. 当前本机环境是 Xcode 16.3 / macOS SDK 15.4，SDK 中没有 `glassEffect`。现阶段可编译方案应使用 SwiftUI material + `NSVisualEffectView` 作为玻璃降级；真正的 Liquid Glass API 等升级到支持该 API 的 Xcode/macOS SDK 后再加条件分支。
5. Mac 端建议最低支持 macOS 14，兼容 Intel 和 Apple Silicon；项目可以沿用 XcodeGen 生成 Xcode 工程，避免手工维护 `.xcodeproj`。

## 现有实现可复用点

仓库当前工作树里 `repos/cc-agent-mac` 被删除，但 Git 历史中已有一版实现，读取方式为 `git show HEAD:repos/cc-agent-mac/...`。可复用模块如下：

- 工程结构：`project.yml` 已定义 `CCAgent` app、`CCAgentTests`、macOS 14 deployment target、MarkdownUI 依赖、Hardened Runtime、entitlements。
- 应用状态：`AppState.swift` 已有登录门禁、路由、连接校验、断开处理。
- WebSocket 客户端：`DaemonClient.swift` 已有 `URLSessionWebSocketTask`、JSON-RPC 请求 id、pending continuation、notification handler。
- 凭据存储：`CredentialStore.swift` 使用 Keychain 保存 token，UserDefaults 保存 WS 配置。
- 会话列表：`SessionListService.swift` 已按 Web 版思路合并 `history.listAllLocal`、`workspace.list`、`history.listSessions`。
- 通知路由：`NotificationRouter.swift` 已支持 `session/event`、`session/status`、`permission/request`，并按 sessionId/runtimeId/sdkSessionId 过滤。
- 流式消息：`MessageBlocks.swift`、`TurnStream.swift` 已能处理 text/thinking/tool_use、tool_result、token 和耗时。
- UI 基础：`LoginView`、`SessionListView`、`ChatView`、`MessageRow`、`ToolUseCard`、`PermissionPromptView` 已有 MVP 雏形。
- 设计降级：`GlassBackground.swift`、`VisualEffectView.swift` 已有 material + `NSVisualEffectView` 方案。
- 测试：已有 WS URL、重连退避、会话路由的单元测试样例。

## 关键缺口

1. 自动重连不完整  
   历史 `DaemonClient` 有 `scheduleReconnect()`，但断线处理直接触发 `onSessionLost()` 回登录，未按 PRD 执行最大 30 秒指数退避。需要改成：非主动断开进入 `connecting`，调度重连；多次失败仍停留登录/错误态由 UI 决定。

2. 历史消息解析不完整  
   历史 `ChatViewModel.loadHistory` 只渲染 user 文本，没有用 `MessageBlocksEngine` 把 assistant block、thinking、tool_use、tool_result、metrics 合并成和实时回复一致的样式。需要移植 Web 端 `historyEntriesToChatMessages` 和 `buildToolResultsFromHistory` 的完整逻辑。

3. 权限弹窗能力不足  
   旧 `PermissionPromptView` 只允许/拒绝，未展示/编辑 `updatedInput`，也没有拒绝原因输入。需要补齐普通工具权限弹窗，并实现 `AskUserQuestion` 专用选择器。

4. 会话别名和实时挂接不足  
   Web 端会维护 runtimeId、sdkSessionId、disk sessionId 的 alias，避免新建、resume、init 后事件匹配丢失。Mac 端当前只用 `liveSessionId` 简单匹配，resume 或 init 替换 sessionId 后需要重新绑定或维护 alias set。

5. 聊天侧栏未达到 PRD  
   历史 `ChatView` 只有单聊天窗口，没有 PRD 要求的“侧栏按目录展示全部会话、可收起、响应式”。建议聊天页也使用 `NavigationSplitView` 或自定义 `HSplitView`，复用 `SessionListService` 的分组结果。

6. Markdown/GFM 表格风险  
   历史版本使用 MarkdownUI。它适合原生 Markdown 渲染，但 PRD 明确要求代码和表格效果，需要实测 GFM 表格、长代码横向滚动、图片、链接。如果 MarkdownUI 不满足表格需求，应补自定义 table/code block renderer，或在消息区局部使用 WebKit 渲染 Markdown HTML。

7. Liquid Glass 不能直接写死新 API  
   当前 SDK 没有 `glassEffect`，即使写 `#available(macOS 26, *)` 也会因符号不存在而无法编译。当前主线应只保留 `Material`/`NSVisualEffectView`，未来 SDK 升级后再在单独扩展里接入 `glassEffect`。

## 推荐架构

### 工程与平台

- 目录：`repos/cc-agent-mac`
- 工程管理：XcodeGen `project.yml`
- 语言：Swift 6 或 Swift 5.9+，SwiftUI + AppKit bridge
- 最低系统：macOS 14
- 架构：arm64 + x86_64
- 依赖：
  - MarkdownUI：Markdown 渲染 MVP
  - 无额外 WebSocket 库，直接使用 Foundation `URLSessionWebSocketTask`

### 模块划分

应用入口：

- `Sources/App/CCAgentApp.swift`：WindowGroup、根视图、最小窗口尺寸。
- `Sources/App/AppState.swift`：全局 client、notification router、路由、登录门禁、连接错误。
- `Sources/App/AppRoute.swift`：`sessionList`、`chat(workspacePath:sessionId:)`，必要时拆出。

认证与连接：

- `Sources/Auth/CredentialStore.swift`：Keychain token、UserDefaults WS 配置。
- `Sources/Auth/WSUrl.swift`：`ws/wss://host:port/ws?token=` 构造。
- `Sources/Networking/DaemonClient.swift`：WebSocket、JSON-RPC、重连、pending RPC、notification。
- `Sources/Networking/JSONRPC.swift`、`JSONValue.swift`、`DaemonModels.swift`：协议和模型。
- `Sources/Networking/NotificationRouter.swift`：notification 分发和 session alias 匹配。

会话首页：

- `Features/SessionList/SessionListView.swift`：目录分组列表、刷新、断开、添加工作区。
- `Features/SessionList/SessionListService.swift`：会话聚合、排序、缓存。
- `Features/SessionList/ActiveSessionsPoller.swift`：每 8 秒轮询 `session.listActive`。
- `Features/SessionList/DirectoryExpansionStore.swift`：目录展开状态。

聊天：

- `Features/Chat/ChatView.swift`：聊天页布局、侧栏、头部、消息区、输入区、弹窗。
- `Features/Chat/ChatViewModel.swift`：信任校验、历史加载、attach/resume/create/send/stop、模型和权限模式。
- `Features/Chat/TurnStream.swift`：实时 turn 合并。
- `Features/Chat/MessageBlocks.swift`：SDK 事件和历史 JSONL 到 UI message 的统一转换。
- `Features/Chat/ChatSessionRouting.swift`：事件匹配、alias、daemon status 到 UI status。
- `Features/Chat/Views/*`：消息气泡、assistant block、Markdown、工具卡、权限弹窗、AskUserQuestion、模型控制。

设计系统：

- `Sources/Design/Theme.swift`：颜色、间距、字体。
- `Sources/Design/GlassBackground.swift`：玻璃样式统一入口。
- `Sources/Design/VisualEffectView.swift`：`NSVisualEffectView` bridge。

测试：

- `Tests/CCAgentTests/WSUrlTests.swift`
- `ReconnectBackoffTests.swift`
- `JSONRPCTests.swift`
- `SessionListServiceTests.swift`
- `MessageBlocksHistoryTests.swift`
- `PermissionResponseTests.swift`
- `ChatSessionRoutingTests.swift`

## RPC 对齐

Mac 端应和 Web 端使用同一批 daemon RPC：

- 认证：`auth`，可保留 `ping` 作为连接后健康校验。
- 设置：`settings.get`。
- 工作区：`workspace.list`、`workspace.add`、`workspace.checkTrust`。
- 历史：`history.listAllLocal`、`history.listSessions`、`history.loadSession`。
- 会话：`session.create`、`session.resume`、`session.attachIfLive`、`session.attach`、`session.detach`、`session.sendMessage`、`session.interrupt`、`session.setPermissionMode`、`session.listActive`。
- 权限：`permission.respond`。

Mac 端必须处理 daemon notification：

- `session/event`：SDK 原始事件、system init、assistant/user/result。
- `session/status`：running、completed、error、interrupted。
- `permission/request`：工具权限请求和 AskUserQuestion。

## UI 实现建议

### 登录页

- 使用 `Form` 或紧凑 card 布局，输入 host、port、TLS、token。
- token 用 `SecureField`，支持显示/隐藏。
- token 存 Keychain，WS 配置存 UserDefaults。
- 连接流程：保存配置 -> WebSocket open -> `auth` -> `ping` -> 进入会话首页。

### 会话首页

- 用 `NavigationSplitView` 或主窗口 `VStack + List`。
- 目录用 `DisclosureGroup`，展开状态持久化。
- 会话行展示 sessionId 前缀、消息数、相对时间、active badge。
- 添加工作区优先支持手输路径；后续可加 `NSOpenPanel` 选择目录。

### 聊天页

- 推荐三段布局：
  - 左侧：全部会话侧栏，可收起，宽度 280-340。
  - 中间：消息列表。
  - 底部：composer + 模型/effort/权限模式控件。
- 进入时先 `workspace.checkTrust`，未信任弹 modal。
- 历史会话加载后立即 `session.attachIfLive`；新消息发送时 `session.attach`，失败后按历史 sessionId `session.resume`。
- 新建会话拿到 sessionId 后更新 native route 的 `sessionId`，不需要 URL，但需要标题和侧栏选中态同步。

### 消息列表性能

- MVP 可用 `ScrollView + LazyVStack + ScrollViewReader`。
- 如果历史消息超过 1000-2000 行，建议做窗口化：
  - 初始只渲染最近 N 条。
  - 顶部提供“加载更早消息”。
  - 工具结果和消息块保留在 ViewModel，不在 View 中重复解析。
- 保证实时流式更新只 patch 最后一条 assistant message，不重建整个数组中的历史消息。

### Markdown 和工具渲染

- Markdown MVP 使用 MarkdownUI，并开启 text selection。
- 代码块必须横向滚动或限制宽度；表格必须实测，不满足时单独实现 table renderer。
- thinking 使用 `DisclosureGroup`，流式阶段默认展开。
- tool_use 使用卡片展示工具名、状态、输入摘要、JSON input、result/error。

### 权限交互

- 普通权限弹窗：
  - 工具名。
  - `updatedInput` JSON 编辑器。
  - 拒绝原因输入。
  - 允许/拒绝。
- AskUserQuestion：
  - 解析 `input.questions`。
  - 单选用 Picker/按钮组，多选用 Toggle 列表。
  - 所有问题答完才允许提交。
  - 返回 `{ ...rawInput, answers: [question: answerString] }`。

## Liquid Glass 降级策略

当前建议实现一个统一的 `glassCard` modifier，内部先只使用可编译的降级方案：

- macOS 14/15：`.ultraThinMaterial` + `NSVisualEffectView(material: .hudWindow)`。
- 未来 macOS 26 SDK：在独立文件或条件编译扩展中接入系统 Liquid Glass API。

注意：仅用 `#available(macOS 26, *)` 不能解决旧 SDK 编译问题；如果编译 SDK 不含新 API，直接引用会编译失败。因此当前主线不要直接调用 `glassEffect`。

## 实施顺序

### M1：恢复工程骨架和连接闭环

1. 恢复/重建 `repos/cc-agent-mac` XcodeGen 工程。
2. 实现 `CredentialStore`、`WSUrl`、`JSONValue`、`JSONRPC`、`DaemonClient`。
3. 登录页完成 host/port/TLS/token 连接。
4. 补真正自动重连：非主动断开 -> connecting -> 指数退避 -> 成功后通知 UI reload。
5. 单测覆盖 WS URL、JSON-RPC decode、重连退避。

### M2：会话首页

1. 实现 `SessionListService`，对齐 Web 端会话聚合逻辑。
2. 首页按目录分组、排序、展开/折叠。
3. 添加工作区、刷新、断开。
4. `session.listActive` 轮询和 active badge。

### M3：聊天 MVP

1. 工作区信任弹窗。
2. 历史会话加载和 `attachIfLive`。
3. 新建 session、发送消息、停止。
4. 实时流式 text/thinking/tool_use 渲染。
5. 模型、effort、permissionMode 控件。

### M4：补齐 Web 等价能力

1. 完整移植历史 message block 转换，保证历史和实时 assistant 样式一致。
2. 工具结果从历史中合并。
3. 权限弹窗支持 updatedInput、拒绝原因。
4. AskUserQuestion 专用选择器。
5. 聊天页侧栏、收起状态、自动跟随回复偏好。

### M5：性能和发布

1. 长会话滚动性能测试。
2. Markdown 表格/代码/图片 QA。
3. Intel + Apple Silicon 构建。
4. Hardened Runtime、entitlements、签名/notarization 预留。

## 风险与取舍

- Markdown 表格：原生渲染体验可能不如 Web；需要早测真实 Claude 输出。
- SwiftUI 长列表：`LazyVStack` 对持续流式 patch 的稳定性要压测；必要时改成分页/窗口化。
- session alias：daemon 同时存在 runtimeId、SDK sessionId、磁盘 sessionId，Mac 端必须像 Web 一样维护 alias，否则 resume 后事件容易丢。
- Liquid Glass：当前 SDK 不支持新 API，短期只能用 Material/VisualEffect 降级。
- 权限请求归属：daemon 要求由持有该会话权限的连接响应；Mac 端断线/重连后要重新 attach 或提示用户恢复会话。

## 验收建议

1. `npm run dev:lan` 启动 daemon，Mac App 使用 `127.0.0.1:4733` + token 连接成功。
2. 首页能看到 `~/.claude/projects` 历史，排序和 Web 端一致。
3. 添加工作目录后可新建对话。
4. 新对话流式输出 text/thinking/tool_use，停止按钮生效。
5. 关闭再打开历史会话，assistant、tool、metrics 样式与实时回复一致。
6. daemon 推送权限请求时，Mac 能允许/拒绝并支持修改 updatedInput。
7. AskUserQuestion 能显示选项并回传 answers。
8. 断开 daemon 后 App 进入 connecting 并自动重连，成功后会话列表刷新。
9. macOS 14/15 上使用 material/visual effect 降级样式，深色/浅色/系统主题正常。

## 参考

- 本地环境核对：Xcode 16.3，macOS SDK 15.4；SDK 中未发现 `glassEffect` 符号。
- Apple Developer Documentation: `URLSessionWebSocketTask`  
  https://developer.apple.com/documentation/foundation/urlsessionwebsockettask
- Apple Developer Documentation: `NavigationSplitView`  
  https://developer.apple.com/documentation/swiftui/navigationsplitview
- Apple Developer Documentation: `NSVisualEffectView`  
  https://developer.apple.com/documentation/appkit/nsvisualeffectview
- Apple Developer Documentation: Keychain Services  
  https://developer.apple.com/documentation/security/keychain_services
