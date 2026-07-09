# cc-agent-daemon gui支持Mac端

Mac GUI 通过 cc-agent-daemon 暴露的 WebSocket + JSON-RPC 2.0 接口，连接并控制本机或局域网内的 Claude Agent SDK 会话。


## 产品目标

1. 提供MacOS GUI可访问的 Claude 会话管理界面，支持连接 daemon、浏览历史会话、新建/续聊/挂接实时会话。
2. 按工作目录组织会话，目录与目录内会话按最近会话时间倒序展示。
3. 在聊天页提供接近 Claude Code 的实时输出体验：流式消息、thinking、工具调用、权限确认、停止运行、模型/思考强度/权限模式切换。
4. 支持mac intel&arm，开发模式支持本机与局域网联调。

## 技术范围

1. 原生 macOS SwiftUI App。macOS 原生窗口、侧栏、系统主题、Keychain、Material/Liquid Glass 降级和长期性能优化。
2. XcodeGen + Xcode 工程。最低支持 macOS 14，支持 Intel + Apple Silicon。
3. 通信协议：URLSessionWebSocketTask + JSON-RPC 2.0。直接连接 cc-agent-daemon 的 /ws，复用 Web 端同一套 RPC 语义：auth、history.*、workspace.*、session.*、permission.respond。
4. 认证与本地存储：Keychain + UserDefaults。token 存 Keychain；WS 地址、主题、目录展开、侧栏状态、自动跟随等偏好存 UserDefaults。
5. UI 框架：SwiftUI 为主，必要时桥接 AppKit。主界面用 NavigationSplitView/List/DisclosureGroup/ScrollView。玻璃效果、特殊 macOS 能力用 NSViewRepresentable 桥接 AppKit。
6. Markdown 渲染：MarkdownUI 作为 MVP。用 MarkdownUI 实现 Markdown、代码、链接等基础渲染。表格、长代码横向滚动和图片要重点实测；
7. 玻璃效果方案：Material / NSVisualEffectView 先行。 当前 Xcode 16.3 / macOS SDK 15.4 没有 glassEffect，不能直接依赖 Liquid Glass API。短期用 .ultraThinMaterial + NSVisualEffectView 降级；未来 SDK 支持后再条件接入 Liquid Glass。
8. 会话性能：SwiftUI Lazy 渲染 + 分页/窗口化预案。MVP 用 ScrollView + LazyVStack + ScrollViewReader。如果会话过长，改为只渲染最近 N 条并提供加载更早消息，避免流式更新导致全量重绘。
9. 测试方案：单测优先覆盖协议和转换逻辑。 重点测 WS URL、JSON-RPC、重连退避、会话分组排序、历史 message block 转换、权限响应构造、session alias 匹配。

## 功能要求

### 1. 登录与连接

- 登录页包含 WS 地址输入框、token 输入框、显示/隐藏 token 按钮、连接按钮、主题切换按钮。
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

- 路由(TODO)
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
- 要求回复中对话和历史消息对话样式一致

### 6. 主题与本地偏好

- 支持 light、dark、system 三种主题偏好。
- 首页目录展开状态、聊天侧栏展开状态、自动跟随回复状态需要本地持久化。
- 连接切换只断开当前 WebSocket，不清空本地 token 和地址，方便重新连接。
- 采用liquid glass样式，不支持的系统版本降级普通样式

## 模块划分

1. 应用入口与全局状态
  - 负责 App 启动、页面切换、登录态判断、全局连接状态管理。
  - 根据连接状态展示登录页、会话首页或聊天页。
2. 连接与认证模块
  - 负责配置 daemon 地址、端口、token。
  - 建立 WebSocket 连接，完成 token 校验。
  - 处理连接中、连接成功、连接失败、断线重连等状态。
3. 会话列表模块
  - 负责展示所有工作目录和目录下的历史会话。
  - 按目录最近会话时间排序。
  - 支持添加工作目录、刷新列表、展开/折叠目录。
  - 展示会话状态，例如运行中、可挂接、已完成等。
4. 聊天会话模块
  - 负责新建会话、打开历史会话、续聊、挂接实时会话。
  - 处理消息发送、停止运行、会话状态更新。
  - 管理当前工作目录、当前 session、模型、思考强度、权限模式。
5. 消息渲染模块
  - 负责展示用户消息、assistant 回复、历史消息和实时流式消息。
  - 支持 Markdown、代码块、表格、链接、图片。
  - 支持 thinking 折叠展示、工具调用卡片、工具结果展示。
  - 需要保证历史消息和实时回复样式一致。
6. 权限交互模块
  - 负责处理 daemon 推送的工具权限请求。
  - 支持允许、拒绝、编辑工具输入、填写拒绝原因。
  - 对 AskUserQuestion 这类交互问题提供专门的选项式回答界面。
7. 工作区信任模块
  - 负责判断当前工作目录是否可信。
  - 未信任目录进入聊天前需要弹窗确认。
  - 支持信任当前目录或父目录。
8. 本地偏好与主题模块
  - 负责 light、dark、system 主题切换。
  - 保存目录展开状态、侧栏展开状态、自动跟随回复状态。
  - 保存连接配置，token 需要安全存储。
9. UI/设计系统模块
  - 负责整体布局、侧栏、弹窗、按钮、输入区、状态标识等统一样式。
  - macOS 端采用原生 SwiftUI 风格。
  - 支持 Liquid Glass；不支持的系统版本降级为普通 Material/VisualEffect 样式。
10. RPC 通信适配模块
  - 封装和 daemon 的 JSON-RPC 调用。
  - 对上层提供会话、历史、工作区、权限、设置等能力。
  - 处理 daemon 主动推送的会话事件、状态事件和权限请求。

## RPC 依赖

Mac GUI 通过 WebSocket 连接 cc-agent-daemon，使用 JSON-RPC 2.0 调用 daemon 能力。
1. 连接认证
  - auth：提交 token，完成连接认证。
  - 可选 ping：连接后做健康校验。
2. 设置读取
  - settings.get：读取 daemon/Claude 相关设置，例如默认模型、权限模式、思考强度等。
3. 工作区管理
  - workspace.list：获取已信任/已添加的工作目录。
  - workspace.add：添加或信任新的工作目录。
  - workspace.checkTrust：检查某个目录是否已被信任。
4. 历史会话
  - history.listAllLocal：读取本机 Claude 历史项目和会话。
  - history.listSessions：读取指定工作目录下的历史会话。
  - history.loadSession：加载指定 session 的历史消息。
5. 会话生命周期
  - session.create：在指定工作目录创建新会话。
  - session.resume：基于历史 session 恢复/续聊。
  - session.attachIfLive：如果会话仍在运行，则挂接到实时会话。
  - session.attach：订阅某个实时会话事件。
  - session.detach：取消订阅某个实时会话事件。
  - session.sendMessage：向会话发送用户消息。
  - session.interrupt：停止当前运行中的会话。
  - session.setPermissionMode：切换当前会话的权限模式。
  - session.listActive：获取当前 daemon 中仍活跃的会话列表。
6. 权限响应
  - permission.respond：响应工具权限请求，支持允许、拒绝、修改工具输入、返回拒绝原因。
7. daemon 主动推送事件
  - session/event：会话运行中的 SDK 消息事件，例如 assistant 输出、tool_use、tool_result、system init、result。
  - session/status：会话状态变化，例如 running、completed、error、interrupted。
  - permission/request：工具权限请求或用户问题请求。

## UI 要求

1. 页面采用响应式布局：侧边列表栏可收起展开，并且缩放尺寸响应式展示UI
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

1. 连接验收
  - Mac GUI 能输入 daemon 地址、端口和 token。
  - 能成功连接 cc-agent-daemon。
  - token 错误或连接失败时能显示明确错误。
  - 断线后能自动重连或回到可恢复状态。
2. 会话首页验收
  - 能展示本机 Claude 历史会话。
  - 会话按工作目录分组。
  - 工作目录按最近会话时间倒序排列。
  - 目录内会话按最近更新时间倒序排列。
  - 能手动添加工作目录。
  - 能刷新会话列表。
  - 能显示运行中或可挂接会话的状态标识。
3. 聊天页验收
  - 能从目录中新建对话。
  - 能打开历史会话。
  - 能对历史会话继续发送消息。
  - 如果会话仍在运行，能挂接并继续接收实时输出。
  - 能停止运行中的会话。
  - 能切换模型、思考强度和权限模式。
4. 消息渲染验收
  - 用户消息、assistant 回复、历史消息、实时流式消息能正确展示。
  - 历史消息和实时回复样式保持一致。
  - Markdown 能正常渲染代码块、表格、链接、图片。
  - thinking 内容能折叠/展开。
  - 工具调用能以卡片形式展示工具名、输入、状态和结果。
  - 长会话滚动流畅，不出现明显卡顿。
5. 权限交互验收
  - 工具权限请求能弹窗展示。
  - 用户能允许或拒绝工具调用。
  - 用户能编辑允许时提交的工具输入。
  - 用户能填写拒绝原因。
  - AskUserQuestion 能以选项形式展示并提交答案。
6. 工作区信任验收
  - 进入未信任工作目录时能弹窗提示。
  - 用户能信任当前目录或父目录。
  - 未信任目录不能直接创建或读取会话。
7. UI 和主题验收
  - 支持 light、dark、system 主题。
  - 侧栏可展开、收起。
  - 窗口缩放时布局能响应式适配。
  - 长路径、sessionId、工具输入等不会撑破 UI。
  - 支持 Liquid Glass；不支持的系统版本能降级到普通样式。
8. 安全验收
  - daemon 默认必须使用 token。
  - token 需要安全保存。
  - 局域网连接不能使用无认证模式。
  - 工具权限请求断开连接后不能被错误继续执行。