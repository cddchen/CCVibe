# Web 前端现代化 UI 技术文档与测试文档计划

## Context

本次任务是为 `cc-agent-daemon` 的 Web 前端做调研并产出**技术设计文档 + 测试文档**，用于后续实现一个现代化、高性能、响应式的 Claude Code 会话管理 UI。

用户目标包括：流式消息渲染、Markdown 渲染、图片展示、长对话高性能渲染、深/浅/系统主题和右上角主题切换、首页按目录聚合会话且新会话优先、Chat 页面顶部导航 + 左侧可折叠会话侧边栏、底部现代化输入栏、发送/停止、permission/model/effort 控制、对话消息现代化样式、模型返回 thinking 片段与工具调用记录可折叠、模型返回 token 数和耗时（秒）展示、新会话实时展示与刷新后的历史展示一致、会话页面不漏出非对话内容等。

当前代码基线已经具备若干可复用能力：
- `web/src/pages/HomePage.tsx`：已通过 `history.listAllLocal` / `workspace.list` / `history.listSessions` 聚合目录和会话，并按最近时间排序。
- `web/src/pages/ChatPage.tsx`：已实现历史加载、`session.resume`、`session.attach`、发送消息、流式通知处理、permission/model/effort 基础控件。
- `web/src/components/VirtualMessageList.tsx`：已使用 `react-virtuoso` 做虚拟列表。
- `web/src/lib/messageBlocks.ts` + `web/src/hooks/useTurnStream.ts`：已支持 Claude SDK 流式事件到结构化消息块的转换。
- `web/src/components/MessageMarkdown.tsx`：已用 `react-markdown` + `remark-gfm` 渲染 Markdown。
- daemon 已有可复用 RPC：`session.interrupt`、`session.detach`、`session.setPermissionMode`、`permission.respond`、`history.*`、`settings.get`。

当前关键缺口：
- UI 仍是 dark-only zinc/violet 硬编码，没有 light/system theme 和主题切换。
- Chat 页面没有左侧会话列表侧边栏。
- 文本输入框固定 `rows={2}`，没有一行起步、最多 4 行自适应。
- busy 状态没有停止按钮；虽然后端已有 `session.interrupt`。
- 图片输入/展示没有端到端协议；daemon `session.sendMessage` 当前只接受 `content: string`（见 `src/rpc/schemas.ts`）。
- Markdown 缺少 custom image/code/link/table rendering、代码复制、懒加载图片等。
- Web 没有专门的 React component test / jsdom / Playwright 测试体系。
- 当前 `ChatNotifyContext` 使用 `acceptAny` 绑定方式，后续应改为按 active session 绑定避免串流。
- 当前消息样式未形成完整规范，需要补充用户/assistant 消息视觉层级、thinking 片段折叠、工具调用记录折叠、token 数和耗时展示。
- 新会话实时渲染与刷新后历史渲染需要统一为同一 message/block view model，避免同一会话前后样式或内容不一致。
- 历史加载和实时事件渲染需要明确过滤非对话内容，避免把 SDK/system/init/debug/raw metadata 等非用户可见内容漏到会话页面。
- 截图路径 `/Users/cdd/Desktop/截屏2026-06-18 下午10.18.44.png` 当前未找到；文档中以用户文字描述为准，并注明后续可补充视觉基准图。

本轮交付范围：**只创建/更新设计文档和测试文档，不实现 UI 代码。**

## Recommended Approach

在仓库内新增 Web 文档目录：

- `docs/web/00-design.md`
- `docs/web/01-layout-navigation.md`
- `docs/web/02-message-rendering.md`
- `docs/web/03-composer-controls.md`
- `docs/web/04-theme-visual-system.md`
- `docs/web/acceptance.md`
- `docs/web/tests/README.md`
- `docs/web/tests/M01-home-history.md`
- `docs/web/tests/M02-chat-layout-routing.md`
- `docs/web/tests/M03-streaming-rendering.md`
- `docs/web/tests/M04-markdown-images.md`
- `docs/web/tests/M05-composer-controls.md`
- `docs/web/tests/M06-theme-responsive.md`
- `docs/web/tests/M07-performance.md`

文档要区分：
1. 当前已实现能力。
2. 目标 UI/交互设计。
3. 需要复用的现有代码路径。
4. 后续实现依赖，尤其是图片消息需要 daemon 协议升级。
5. 每个模块的测试用例和验收标准。

## Documentation Content Plan

### 1. `docs/web/00-design.md` — 总体技术方案

内容：
- 前端现状：React 19 + Vite + TypeScript + Tailwind + `react-virtuoso` + `react-markdown`。
- 当前路由：`/`、`/chat/:workspacePath`、`/chat/:workspacePath/:sessionId`。
- 目标信息架构：`AppShell` + `HomePage` + `ChatPage` + `ChatSidebar` + `ChatTopNav` + `VirtualMessageList` + `Composer` + `ThemeProvider`。
- 数据流：
  - 首页：`history.listAllLocal` → 按 `workspacePath` 聚合 → 按最近时间排序。
  - Chat：`history.loadSession` → `historyEntriesToChatMessages` → `session.resume` → `session.attach` → `ChatNotifyContext` → `useTurnStream`。
  - 新会话：首次发送时 `session.create` + `session.attach` + URL canonicalization。
- 明确图片消息协议依赖：当前 `session.sendMessage.content` 是 string，图片需要后续扩展 schema、`EngineAdapter.send`、`claudeEngine` 输入流和 history parser。
- 明确统一消息视图模型：实时 streaming 与刷新后的 history parser 都输出同一组 `ChatMessage` / `MessageBlock` / metadata，保证新会话、继续会话、刷新页面后一致展示。
- 明确会话数据边界：只渲染用户消息、assistant 文本、thinking、tool_use/tool_result、模型名、token usage、耗时等用户可理解对话信息；过滤 SDK/system/init/debug/raw metadata 等非对话内容。
- 明确本轮文档不是 UI 实现。

关键引用：
- `web/src/App.tsx`
- `web/src/pages/HomePage.tsx`
- `web/src/pages/ChatPage.tsx`
- `web/src/context/DaemonContext.tsx`
- `web/src/context/ChatNotifyContext.tsx`
- `web/src/lib/daemonClient.ts`
- `web/src/lib/messageBlocks.ts`
- `src/rpc/schemas.ts`

### 2. `docs/web/01-layout-navigation.md` — 首页、Chat 布局与导航

内容：
- 首页：
  - 按目录聚合。
  - 目录按 `latestAt` 新到旧排序。
  - 目录内会话按 `lastTimestamp` 新到旧排序。
  - 每个目录展示路径、会话数、最近时间、新对话入口。
  - 空状态、加载状态、断连状态。
- Chat 页面：
  - 顶部导航栏：左上返回按钮、会话标题、目录副标题、右上主题 icon。
  - 左侧边栏：
    - 大屏：常驻/可折叠。
    - 小屏：抽屉式展开。
    - 列出当前目录下会话，最新优先。
    - 点击切换会话。
  - 会话切换流程：
    1. unbind 当前通知。
    2. 对旧 session 调 `session.detach`（如果已 attach）。
    3. `history.loadSession` 新会话。
    4. `session.resume` + `session.attach`。
    5. 使用新 sessionId 重新绑定通知。
    6. 更新 URL。
  - 避免长期使用 `{ acceptAny: true }`，active session 确定后应使用 `sessionIds` 精确绑定。

关键引用：
- `web/src/pages/HomePage.tsx`
- `web/src/pages/ChatPage.tsx`
- `web/src/context/ChatNotifyContext.tsx`

### 3. `docs/web/02-message-rendering.md` — 流式、Markdown、图片、长对话性能

内容：
- 当前可复用能力：
  - `VirtualMessageList` 使用 Virtuoso。
  - `ChatMessageRow`/`MessageMarkdown` 已 memo。
  - `messageBlocks.ts` 支持 text/thinking/tool_use/tool_result。
- 目标流式渲染：
  - 用户消息立即插入。
  - assistant placeholder 立即出现。
  - stream delta 只更新 active assistant message。
  - thinking/text/tool blocks 独立渲染。
  - tool result 定位更新对应 tool card。
  - result/error/interrupted 结束当前 turn。
- 对话样式与元信息目标能力：
  - 用户消息、assistant 消息、system/status 提示使用清晰的现代化视觉层级，避免所有内容混在同一色块。
  - thinking 片段渲染为可折叠区块；流式生成时可显示简短状态，完成后默认折叠或按设计规则保持用户上次展开状态。
  - 工具调用记录渲染为可折叠 tool card；折叠态展示工具名、状态、简短摘要，展开态展示格式化 input/result，避免大 JSON 默认撑开页面。
  - assistant 完成后展示模型返回元信息：model、token usage（如 input/output/total 可得时分项展示）和耗时秒数。
  - 新会话实时消息与刷新页面后的历史消息使用同一 `ChatMessageRow` / `AssistantMessageBody` / metadata renderer，保证样式、折叠状态默认值、token/耗时展示一致。
  - 历史和实时转换层只输出白名单对话块，非对话内容不进入渲染组件。
- 高性能策略：
  - 保留 `react-virtuoso`。
  - 历史消息不可变；只替换当前 streaming assistant message。
  - 高频 delta 用 `requestAnimationFrame` 或短节流批处理。
  - Markdown streaming 阶段可采用轻量渲染，turn 结束后再完整 Markdown 渲染。
  - 图片懒加载。
  - 长代码块/大表格避免阻塞主线程。
- Markdown 目标能力：
  - GFM table/task list/strikethrough。
  - code block language label、copy button、可选语法高亮。
  - external link 安全属性。
  - light/dark token 化 prose 样式。
- 图片展示目标能力：
  - Markdown image custom renderer。
  - `loading="lazy"`。
  - responsive max width/height。
  - alt/caption/error fallback。
  - 点击预览/lightbox。
- 用户图片附件目标能力：
  - file picker / paste / drag-drop。
  - thumbnail preview。
  - image-only send。
  - 多图 + 文本 send。
  - object URL cleanup。
  - MIME/size guardrails。

关键引用：
- `web/src/components/VirtualMessageList.tsx`
- `web/src/components/ChatMessageRow.tsx`
- `web/src/components/AssistantMessageBody.tsx`
- `web/src/components/MessageMarkdown.tsx`
- `web/src/components/ToolUseCard.tsx`
- `web/src/hooks/useTurnStream.ts`
- `web/src/lib/messageBlocks.ts`

### 4. `docs/web/03-composer-controls.md` — 输入栏、发送/停止、模型/权限/强度

内容：
- 输入栏目标：
  - 一行高度起步。
  - 自动增长到最多 4 行。
  - 超过 4 行内部滚动。
  - Enter 发送，Shift+Enter 换行。
  - 文本为空但有图片时可发送。
- 发送/停止：
  - 非 busy：显示发送按钮。
  - busy：显示停止按钮。
  - 停止调用 `session.interrupt`。
  - `interrupted` 状态结束 streaming turn，不清空草稿。
- 图片附件：
  - 预览、删除、错误提示。
  - 发送后清理 object URL。
- metadata row：
  - 左侧 permission dropdown：`session.setPermissionMode`。
  - 右侧 model dropdown：内置模型 + settings 自定义默认 + 自定义输入。
  - effort dropdown：`low/medium/high/xhigh/max`。
  - 小屏换行或横向滚动。
- 权限弹窗可后续增强：展示 tool input，并支持 allow 时传 `updatedInput`、deny 时传 message。

关键引用：
- `web/src/pages/ChatPage.tsx`
- `web/src/lib/daemonClient.ts`
- `src/rpc/router.ts` (`session.interrupt`, `session.setPermissionMode`, `permission.respond`)

### 5. `docs/web/04-theme-visual-system.md` — 主题和视觉系统

内容：
- 新增 `ThemeProvider` 设计：
  - `light` / `dark` / `system` 三种 preference。
  - localStorage 持久化。
  - `prefers-color-scheme` 解析和监听。
  - document root 使用 `class="dark"` 或 `data-theme`。
- Tailwind 策略：
  - 建议 `darkMode: "class"`。
  - 逐步把硬编码 `bg-zinc-*` / `text-zinc-*` 收敛为语义 token。
- 右上角主题 icon：
  - homepage/chat 都展示。
  - 支持点击切换或弹出菜单。
  - accessible label。
- 视觉原则：
  - 现代卡片、柔和边框、轻阴影/blur、适度留白。
  - 保留 violet accent，除非后续截图基准要求变更。
  - 适配浅色模式的 surface/border/text/markdown/code/tool card。
- 截图说明：当前本地未找到用户给出的截图文件；文档按文字描述设计，后续若提供截图可补充 visual baseline。

关键引用：
- `web/src/index.css`
- `web/tailwind.config.js`
- `web/src/pages/HomePage.tsx`
- `web/src/pages/ChatPage.tsx`
- `web/src/components/MessageMarkdown.tsx`

### 6. `docs/web/tests/README.md` — Web 测试总体策略

内容：
- 当前 Web 没有专门 test script；应在后续实现阶段引入：
  - Vitest
  - `@testing-library/react`
  - `@testing-library/user-event`
  - jsdom
  - Playwright（E2E/响应式/视觉）
- fixtures：
  - mock `DaemonClient`
  - mock `ChatNotifyContext`
  - deterministic sessions/history/messages
  - long conversation fixture
  - markdown fixture
  - image fixture
  - thinking/tool folding fixture
  - token usage / elapsed seconds fixture
  - raw SDK/system/init/debug metadata fixture，用于验证非对话内容不会渲染
- 测试分层：
  - unit：message blocks、theme resolver、composer state。
  - component：HomePage、ChatLayout、Composer、MessageMarkdown。
  - integration：mock daemon + session switch + streaming。
  - e2e：真实 Vite 页面 + mock/real daemon。
  - performance smoke：长列表、流式 delta、图片懒加载。

### 7. `docs/web/tests/M01-home-history.md`

覆盖：
- 未连接/加载/空状态。
- 目录聚合。
- 目录最新优先。
- 会话最新优先。
- 展开/收起目录。
- 点击新对话。
- 点击已有会话。
- 手动 workspace 异常不影响其他目录展示。

### 8. `docs/web/tests/M02-chat-layout-routing.md`

覆盖：
- `/chat/:workspacePath` 新对话路由。
- `/chat/:workspacePath/:sessionId` 历史会话路由。
- 新会话首次发送后的实时样式与刷新页面加载同一 session 后的历史样式一致。
- 顶部返回按钮、标题、副标题。
- 左侧 sidebar 展开/收起。
- 移动端 drawer 行为。
- 点击 sidebar session 切换。
- 切换时 unbind/detach old session，load/resume/attach new session。
- URL 更新。
- history load 返回的非对话 system/init/debug/raw metadata 不会显示在会话页面。

### 9. `docs/web/tests/M03-streaming-rendering.md`

覆盖：
- beginTurn 插入 assistant placeholder。
- text delta 追加到 active assistant。
- thinking delta 渲染 thinking block。
- thinking 片段可折叠/展开，默认折叠策略与刷新后历史展示一致。
- tool_use 渲染 tool card。
- tool card 可折叠/展开，折叠态摘要不展示大 JSON，展开态展示格式化 input/result。
- tool_result 更新对应 card。
- result 结束 streaming。
- result 后展示 token usage 和耗时秒数；缺失字段时不展示错误占位。
- error/interrupted 状态处理。
- 实时流式消息完成后与同一消息从 history reload 得到的 DOM/视觉结构保持一致。
- 高频 delta 批处理或限制 rerender 范围。
- 用户滚动离底部时不强制 auto-follow。
- 非对话事件不会生成可见消息行。

### 10. `docs/web/tests/M04-markdown-images.md`

覆盖：
- headings/paragraph/list/table/task list。
- inline code/code block。
- code copy button。
- external link 安全属性。
- Markdown image lazy loading、alt、responsive、error fallback、preview。
- light/dark 下 prose/code/image 样式。
- 图片附件消息展示（依赖协议实现后）。

### 11. `docs/web/tests/M05-composer-controls.md`

覆盖：
- textarea 一行起步。
- 自动增长到最多四行。
- Enter 发送、Shift+Enter 换行。
- 无文本无图片不可发送。
- 有文本可发送。
- 只有图片可发送。
- 图片 paste/drop/file picker preview。
- 删除附件。
- busy 显示停止按钮。
- 停止调用 `session.interrupt`。
- permission/model/effort dropdown 行为。
- 自定义模型输入确认/取消。

### 12. `docs/web/tests/M06-theme-responsive.md`

覆盖：
- system theme 默认解析。
- light/dark/system 切换。
- localStorage 持久化。
- 系统主题变化监听。
- 主题 icon accessible label。
- homepage/chat 双页面主题覆盖。
- 390x844 mobile、768x1024 tablet、1440x900 desktop。
- 移动端 sidebar drawer focus 管理。

### 13. `docs/web/tests/M07-performance.md`

覆盖：
- 5k/10k 消息虚拟列表不会全量 DOM mount。
- 首次 hydrate 长会话保持响应。
- 1k 小 delta 只更新 active row。
- 长代码块/表格滚动稳定。
- 图片懒加载。
- object URL 清理。
- 切换会话不保留旧大数组引用。

### 14. `docs/web/acceptance.md`

按功能验收：
- 首页目录聚合/排序。
- Chat 顶部导航/侧边栏/会话切换。
- 流式消息、Markdown、图片展示。
- thinking 片段和工具调用记录可折叠，折叠/展开状态交互清晰且不影响长对话性能。
- 模型返回完成后展示 token 数和耗时秒数；字段不可得时优雅省略。
- 当前新会话实时展示与刷新页面后的历史展示一致。
- 会话页面只展示对话相关内容，不漏出 SDK/system/init/debug/raw metadata 等非对话内容。
- 自适应输入栏、发送/停止。
- permission/model/effort 控制。
- light/dark/system 主题和右上角切换。
- 大小屏响应式。
- 长对话性能。
- 测试体系文档完整。

## Implementation Steps After Approval

1. 新建 `docs/web/` 和 `docs/web/tests/` 目录。
2. 编写 `00-design.md`，包含现状、目标架构、数据流、当前限制。
3. 编写 `01-layout-navigation.md`，覆盖首页和 Chat 布局、sidebar、路由、会话切换生命周期、新会话/刷新后一致性和非对话内容过滤边界。
4. 编写 `02-message-rendering.md`，覆盖 streaming、Markdown、图片、thinking/tool 折叠、token/耗时元信息、统一历史/实时 renderer、Virtuoso 性能策略。
5. 编写 `03-composer-controls.md`，覆盖输入栏、附件、发送/停止、metadata row。
6. 编写 `04-theme-visual-system.md`，覆盖主题系统、token、右上角主题 icon、响应式视觉原则。
7. 编写 `tests/README.md`，定义测试工具、fixtures、分层策略和未来脚本。
8. 编写 `tests/M01` 至 `M07` 的具体测试用例文档。
9. 编写 `acceptance.md` 验收清单。
10. 做文档自检：路径有效、现状/目标区分清楚、图片协议限制明确、所有用户需求均映射到设计与测试。

## Verification

文档交付后验证：
- `docs/web/00-design.md` 存在并引用上述关键文件。
- `docs/web/01-layout-navigation.md` 覆盖首页聚合排序、Chat top nav、sidebar、会话切换、新会话/刷新一致性、非对话内容过滤。
- `docs/web/02-message-rendering.md` 覆盖 streaming、Markdown、图片、thinking/tool 折叠、token/耗时展示、长对话性能。
- `docs/web/03-composer-controls.md` 覆盖一行起步最多四行 textarea、图片附件、发送/停止、permission/model/effort。
- `docs/web/04-theme-visual-system.md` 覆盖 light/dark/system 和右上角主题切换。
- `docs/web/tests/` 覆盖 M01-M07，并包含 folding、token/elapsed、history reload 一致性、非对话内容不渲染用例。
- `docs/web/acceptance.md` 可逐项映射用户需求。
- 后续实现阶段建议运行：
  - `npm test --prefix /Users/cdd/Documents/cc/repos/cc-agent-daemon`
  - `npm run typecheck --prefix /Users/cdd/Documents/cc/repos/cc-agent-daemon`
  - `npm run build --prefix /Users/cdd/Documents/cc/repos/cc-agent-daemon/web`
  - 未来新增：`npm run test --prefix web`、`npm run test:e2e --prefix web`

## Out of Scope for This Documentation Pass

- 不实现 Web UI。
- 不修改 daemon 协议。
- 不引入新的测试依赖。
- 不提交截图基准；截图文件当前未找到，后续可补充。
