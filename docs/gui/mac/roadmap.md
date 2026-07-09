# cc-agent-daemon Mac GUI Roadmap

## 目标

本 roadmap 用于把 `prd.md` 和 `adr.md` 转成可执行的 Mac App 实施顺序、里程碑退出标准和验收门禁。Mac 端以 Web 端已实现行为为产品基准，优先交付连接闭环、会话管理、聊天 MVP，再补齐历史/实时消息一致性、权限交互、性能和发布能力。

## 当前基线

- `cc-agent-daemon` 已提供 WebSocket + JSON-RPC 2.0 能力，主要 RPC 与 PRD 对齐。
- `repos/cc-agent-daemon/web` 已实现可参考的 Web 端流程，包括重连、会话列表、聊天侧栏、历史消息转换、权限响应、AskUserQuestion 和虚拟列表。
- Git 历史中存在 `repos/cc-agent-mac` SwiftUI 骨架，但当前工作树中该目录处于删除状态，必须先恢复或重建。
- `docs/gui/mac/adr.md` 状态为 Proposed；roadmap 按该架构推进，若 ADR 关键决策变更，本文件同步更新。

## 优先级原则

1. 先保证端到端闭环，再做体验增强。
2. 先复用 Web 端已验证行为，再做 Mac 原生差异化。
3. 先完成可单测的协议、状态机和转换逻辑，再堆 UI polish。
4. 安全和数据正确性优先于视觉效果：token、工作区信任、权限归属、session alias 是发布门槛。
5. Liquid Glass 新 API 延后，当前主线只使用 Material / `NSVisualEffectView` 可编译降级方案。

## P0 / P1 / P2 排列

### P0: 必须先完成

- 恢复或重建 `repos/cc-agent-mac` XcodeGen 工程。
- 登录连接、Keychain token、UserDefaults WS 配置。
- `URLSessionWebSocketTask` JSON-RPC client、notification 分发、指数退避重连。
- 会话首页：历史会话按工作目录分组、排序、刷新、添加工作区、active badge。
- 聊天基础闭环：工作区信任、加载历史、新建会话、发送消息、停止、实时 text/thinking/tool_use 渲染。
- 历史消息和实时消息统一模型的核心单测。
- 普通权限 allow/deny，禁止把原始 SDK 事件裸露给用户。

### P1: PRD 完整验收能力

- 历史 assistant/tool/tool_result 完整转换，历史与实时样式一致。
- 权限弹窗支持 `updatedInput` JSON 编辑和拒绝原因。
- `AskUserQuestion` 专用选择器。
- 完整 session alias：disk sessionId、runtimeId、sdkSessionId 任一命中均归属当前会话。
- 聊天页会话侧栏、自动跟随回复、相关偏好持久化。
- 模型、effort、permission mode 与 `settings.get` 对齐，并支持自定义模型。
- Markdown 表格、代码块、图片、链接 QA。

### P2: 发布与体验增强

- 长会话窗口化或分页，工具结果大文本内部滚动。
- Markdown block 缓存和流式性能优化。
- 统一 Material / VisualEffect 设计语言。
- Intel + Apple Silicon universal build。
- Hardened Runtime、签名、notarization 预留。
- Finder 目录选择或拖拽添加工作区。
- 是否由 Mac App 启动/管理 daemon 的产品决策。

## 里程碑

### M0: 工程恢复与基线确认

目标：让 Mac App 工程重新出现在工作树，并建立后续开发的可构建基线。

范围：

- 恢复或重建 `repos/cc-agent-mac`。
- 保留 XcodeGen `project.yml`，删除不应提交的 Xcode 用户态文件。
- 确认 macOS 14 deployment target、MarkdownUI 依赖、entitlements、test target。
- 梳理历史骨架与 Web 端实现差异，形成待办清单。

退出标准：

- `repos/cc-agent-mac/project.yml` 存在且可生成 `.xcodeproj`。
- `xcodegen generate` 可成功执行。
- `xcodebuild -scheme CCAgent -destination 'platform=macOS' build` 可成功或只剩明确外部环境阻塞。
- 工作树不再显示 `repos/cc-agent-mac` 整目录删除。
- 已记录需要从 Web 端移植的核心模块：`daemonClient`、`messageBlocks`、`permissionResponses`、`askUserQuestion`、`chatSessionRouting`。

### M1: 工程与连接闭环

目标：用户能用 Mac App 连接 daemon，断线后能自动恢复到可用状态。

范围：

- App Shell、登录页、连接状态门禁。
- Keychain 保存 token，UserDefaults 保存 WS host/port/TLS。
- WS URL 构造和 token encoding。
- JSON-RPC request/response/notification decode。
- `auth` 和可选 `ping`。
- 非主动断开指数退避重连，最大 30 秒。

退出标准：

- 输入 `127.0.0.1:4733` 和 token 后可连接 daemon 并进入首页。
- token 错误、daemon 不可达时显示明确错误，不崩溃。
- 主动断开不重连；非主动断开进入 connecting 并自动重连。
- 重连成功后触发全局 reconnect nonce，业务页可重新拉取状态。
- 单测覆盖 WS URL、JSON-RPC decode、RPC error、重连退避。

### M2: 会话首页

目标：首页达到 PRD 会话管理验收，能作为进入聊天的稳定入口。

范围：

- `SessionListService` 合并 `history.listAllLocal`、`workspace.list`、`history.listSessions`。
- 目录和目录内会话按最近更新时间倒序。
- 手动添加工作区、刷新、断开连接。
- 目录展开状态持久化。
- `session.listActive` 轮询和状态标识。

退出标准：

- 首页能展示 `~/.claude/projects` 历史会话。
- 历史会话按工作目录分组，排序符合 PRD。
- 手动添加的工作区能展示，并提供“新对话”入口。
- active/running/attachable 状态能在列表中显示。
- 长路径和 sessionId 不撑破布局。
- 单测覆盖 session group 构建、排序、active 状态映射。

### M3: 聊天 MVP

目标：新对话、历史会话、实时输出和停止运行形成可演示闭环。

范围：

- Chat route 和 `ChatViewModel`。
- 进入聊天前 `workspace.checkTrust`，未信任弹窗允许信任当前目录或父目录。
- `history.loadSession` 基础加载。
- `session.create`、`session.attachIfLive`、`session.attach`、`session.resume`、`session.sendMessage`、`session.interrupt`。
- 实时 text、thinking、tool_use 渲染。
- 模型、effort、permission mode 基础控件。

退出标准：

- 能从目录中新建对话并发送首条消息。
- 能打开历史会话并继续发送消息。
- 仍在运行的会话可挂接并继续接收实时事件。
- 运行中停止按钮生效，UI 状态更新为 interrupted 或 stopped。
- thinking 和 tool_use 不以原始 JSON 直接裸露。
- 单测覆盖 stream event 到 message block、send/resume fallback、工作区信任状态。

### M4: Web 等价能力

目标：补齐 Web 端已验证的关键能力，使 Mac 端满足 PRD 主体验收。

范围：

- 完整移植历史 JSONL 到 `ChatMessage` 的转换逻辑。
- 过滤 compact summary、transcript-only、纯 tool_result user message。
- 合并 assistant 多段 block、tool_use 和 tool_result。
- session alias registry，覆盖 disk/runtime/sdk sessionId。
- 权限弹窗支持 `updatedInput` JSON 编辑和拒绝原因。
- `AskUserQuestion` 单选/多选选择器，提交 answers。
- 聊天侧栏、自动跟随回复、偏好持久化。

退出标准：

- 同一会话的历史消息和实时回复使用同一消息样式。
- 历史 tool_result 能正确回填到对应 tool_use 卡片。
- resume 或 system init 后事件不丢失，alias 单测通过。
- 普通权限 allow 可提交编辑后的 `updatedInput`，deny 可提交拒绝原因。
- AskUserQuestion 必须所有问题完成后才能提交，提交内容包含原 input 和 answers。
- 聊天侧栏可收起，当前会话选中态和运行态正确。
- 单测覆盖 history converter、tool result merger、permission builder、AskUserQuestion parser、alias matching。

### M5: 性能、设计和发布准备

目标：完成长会话、Markdown、视觉降级和发布前工程门禁。

范围：

- 长会话窗口化或分页策略。
- Markdown 表格、代码块、图片、链接 QA，必要时替换 Markdown renderer 的局部实现。
- 工具结果大文本限制高度并内部滚动。
- Material / `NSVisualEffectView` 统一封装。
- light/dark/system 主题。
- Intel + Apple Silicon 构建验证。
- Hardened Runtime、签名、notarization 预留检查。

退出标准：

- 长会话滚动无明显卡顿，流式更新只 patch 当前 assistant turn。
- Markdown 代码块和表格不会撑破消息区域；长代码可横向滚动。
- 图片和链接基础展示可用。
- light/dark/system 主题切换可持久化。
- macOS 14/15 下无 Liquid Glass 新 API 编译依赖。
- `xcodebuild ... test` 通过；universal build 路径明确。

## 全局发布门禁

进入可对外试用版本前，必须满足：

- `npm test` 和 `npm run typecheck` 在 `repos/cc-agent-daemon` 通过，或记录非 Mac 端阻塞。
- Mac App build 和核心单测通过。
- 本机 `npm run dev:lan` + Mac App 可完成连接、会话列表、新对话、续聊、停止。
- 权限请求可 allow/deny，断线后不补发旧权限响应。
- token 不出现在普通日志或错误提示中。
- 未信任工作区不能直接创建、恢复或读取会话。
- 已知 P1 缺口必须在发布说明中标注。

## 验收用例矩阵

| 场景 | 目标里程碑 | 验收方式 |
|---|---|---|
| 登录连接 daemon | M1 | 输入 WS 配置和 token 后进入首页 |
| token 错误 | M1 | 展示认证失败，停留登录页 |
| daemon 断开后恢复 | M1 | UI 进入 connecting，daemon 恢复后自动 connected |
| 历史会话首页 | M2 | 按目录分组、目录和会话倒序 |
| 添加工作区 | M2 | `workspace.add` 后列表出现新目录 |
| active badge | M2 | `session.listActive` 轮询后状态更新 |
| 新对话发送 | M3 | `session.create` + `sendMessage` 后流式回复 |
| 历史会话续聊 | M3 | `attach` 失败时 `resume` 后发送成功 |
| 停止运行 | M3 | `session.interrupt` 后状态更新 |
| 历史/实时样式一致 | M4 | 同一会话重开后 tool/thinking/metrics 样式一致 |
| 普通权限请求 | M4 | allow/deny 均能调用 `permission.respond` |
| AskUserQuestion | M4 | 选项提交后 answers 写入 `updatedInput` |
| 长会话性能 | M5 | 真实长历史滚动和流式无明显卡顿 |
| Markdown QA | M5 | 代码块、表格、图片、链接均可读可操作 |

## 依赖与风险

| 项 | 影响 | 当前处理 |
|---|---|---|
| Mac 工程当前工作树缺失 | 无法构建或继续实现 | M0 先恢复工程 |
| XcodeGen 本地依赖 | 无法生成工程 | M0 检查并记录环境阻塞 |
| MarkdownUI 表格能力 | 影响 PRD Markdown 验收 | M5 前封装替换点并实测 |
| session id 多源 | resume/attach 后事件可能丢失 | M4 必须实现 alias registry |
| SwiftUI 长列表 | 长会话卡顿 | M5 做窗口化/分页 |
| Liquid Glass SDK 不可用 | 直接引用会编译失败 | 当前只用 Material / `NSVisualEffectView` |
| 权限请求归属 | 安全风险 | M4 前按当前会话过滤，断线旧请求不补发 |

## 维护规则

- 每完成一个里程碑，更新本文件对应退出标准状态或补充实际偏差。
- ADR 决策变更时，同步调整优先级和里程碑范围。
- Web 端行为变更时，优先确认是否属于 Mac 端等价需求，再更新本 roadmap。
- 不把低优先级视觉增强插入 P0，除非它阻塞 PRD 验收或安全门禁。
