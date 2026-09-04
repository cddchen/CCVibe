# AGENTS.md

## 项目简介

CCVibe 当前的核心产品是 **Cloud**：一个把 Claude Agent SDK 运行在服务端，并通过移动端远程浏览、控制和继续会话的系统。

- `repos/cc-agent-host`：Node.js 22 + TypeScript + Fastify/WebSocket + JSON-RPC 2.0 的服务端 Agent Host。
- `repos/cloud-mobile`：Expo 54 + React Native 0.81 + React 19 的 iOS / Android 客户端。
- `docs/daemon`、`docs/mobile`：架构、协议、阶段计划与验收记录。
- `harness.md`、`vscode-agent-new-structure.md`、`vscode-agent-dataflow.md`：Claude Agent SDK harness 与多客户端状态同步的设计依据。

本仓库不是传统前端加 REST API。它的核心是：服务端持有长生命周期 Agent runtime 和权威状态，客户端通过 Snapshot + Action 协议观察并控制同一份状态。

**核心职责边界（不可逾越）：**

- Claude Agent SDK、Agent loop、模型调用、工具执行、Claude transcript、resume/fork 和服务端文件系统访问属于服务端。
- 工作区、模型、思考强度、权限模式、会话配置和运行状态由 Host 获取、规范化并下发；客户端只请求、选择和展示。
- 移动端不得运行 SDK、shell 或工作区操作，不得复制会话数据库，也不得用本地占位数据掩盖 Host 缺失字段。
- 修复必须落在真正拥有该事实或行为的层。服务端映射错误应修服务端；客户端布局或交互错误应修客户端；禁止用跨职责补丁“看起来修好”。

## 规则适用范围与事实优先级

本项目只维护根目录这一份 `AGENTS.md`。除非用户明确要求，不要在子目录新增同名规则文件。

发生冲突时，按以下顺序判断当前事实：

1. 当前安装版本的 TypeScript 类型、Claude Agent SDK 自带 `.d.ts`。
2. 当前生产代码和网络 schema。
3. 自动化测试与真实 iOS / Android 运行结果。
4. 本文件。
5. `docs/daemon/cc-agent-host-architecture-and-api.md`、当前 roadmap 和 phase 文档。
6. `harness.md`、设计研究和参考项目。

Roadmap、phase plan、smoke 文档和 README 可能包含阶段性快照或旧版本命令。不得只根据文档猜测当前 API；先核对 `package.json`、源码、schema 和测试。若实现与文档冲突，判断真正 owner 后同时修正过期文档。

`AGENTS例子.md` 只提供规则文件的组织方式。其中 PiDeck、Electron、Jotai、Tailwind、shadcn、beUI 等约束不属于本项目，不能照搬。

`/Users/cdd/Documents/vscode`、`/Users/cdd/Documents/ClaudeCodeRemote/vscode` 和 Happier 等目录是参考实现；未经用户明确要求，不修改参考项目。

## 仓库结构与模块职责

```text
CCVibe/
├── repos/
│   ├── cc-agent-host/
│   │   ├── src/
│   │   │   ├── domain/        # ID、资源、ChatState、Action、纯 reducer
│   │   │   ├── catalog/       # 工作区/模型/会话 catalog 与纯投影
│   │   │   ├── protocol/      # JSON-RPC、schema、snapshot/replay/subscription
│   │   │   ├── host/          # 权威状态、serverSeq、逻辑客户端
│   │   │   ├── chat/          # 命令幂等、每会话串行、actor
│   │   │   ├── claude/        # Claude SDK facade/options/runtime/live/replay mapper
│   │   │   ├── interaction/   # approval、AskUserQuestion、first-writer-wins
│   │   │   ├── persistence/   # overlay、receipt、audit、migration
│   │   │   ├── security/      # identity、ACL、auth、redaction
│   │   │   ├── transport/     # Fastify/WSS、心跳、限流、背压
│   │   │   ├── server/        # 环境配置与服务启动装配
│   │   │   └── cli/           # cloud CLI 生命周期
│   │   └── test/              # Vitest，按源码领域镜像组织
│   └── cloud-mobile/
│       ├── app/               # Expo Router 薄路由
│       ├── src/
│       │   ├── domain/        # 客户端纯状态、reducer、view model
│       │   ├── protocol/      # 网络 schema/codec/resource URI
│       │   ├── sync/          # WebSocket、RPC、重连、snapshot/replay
│       │   ├── storage/       # SecureStore / AsyncStorage adapter
│       │   ├── features/      # connection、home、chat、runtime
│       │   └── ui/            # iOS glass、Android material、motion、theme
│       ├── test/              # Node 环境 Vitest
│       ├── ios/、android/     # Expo prebuild 后纳入维护的原生工程
│       └── scripts/           # 双端 release 构建脚本
└── docs/                      # 架构、接口、roadmap、phase 与发布说明
```

根目录没有统一 npm workspace 命令。安装、测试、构建必须分别进入两个包执行，不能假定根目录的 `npm test` 会覆盖全仓库。

## 事实源与身份模型（硬性）

### 事实源必须分离

```text
Claude SDK transcript  = 已完成对话、provider session、resume/fork 的事实源
Host ChatState          = 当前 turn、流式块、工具、pending 交互的运行时事实源
Host catalog/overlay    = 产品配置、backing、receipt、audit 的事实源
Snapshot + Action       = 多客户端同步事实的公开表达
WebSocket connection    = 临时传输，不拥有 session、runtime 或 approval
Mobile local storage    = 连接信息、token、偏好与必要缓存，不是业务权威
```

- 不建立第二套 Claude transcript 数据库；历史正文通过 SDK session API 读取。
- SQLite overlay 只保存 Host 拥有的 backing/config/receipt/audit 等数据，不能复制 SDK 对话正文。
- 客户端缓存只能作为 last-known-good 展示；新 snapshot 到达时必须按协议替换，不能反向覆盖 Host。

### 身份不可混用

| 身份 | 含义 |
| --- | --- |
| `tenantId` / `principalId` | 认证与授权主体 |
| `clientId` | 跨重连稳定的逻辑客户端 |
| `connectionId` | 一次物理 WebSocket 连接 |
| `sessionUri` | 产品会话容器 |
| `chatUri` | 可订阅和发命令的具体聊天资源 |
| `sdkSessionId` | Claude SDK transcript / resume 的 opaque 标识 |
| `runtimeId` | 当前 Query / 子进程实例 |
| `turnId` | 一轮用户输入到终态的领域标识 |
| `commandId` | 客户端命令幂等键 |
| `approvalId` / `inputId` | Host 交互请求标识 |

- 不从 URI 字符串推导 `sdkSessionId`，不把 connection ID 当 session ID。
- `sdkSessionId` 是 provider 私有数据，不能作为公网资源身份。
- 一个 `chatUri` 任一时刻最多有一个 live SDK owner；多客户端共享同一个 actor/runtime，不能各自 resume Query。
- ID 使用现有 branded type 和构造/解析函数，不以普通 `string` 互换不同生命周期的 ID。

## 服务端架构规则（硬性）

### Claude SDK harness 边界

1. Claude SDK 通过 `ClaudeAgentSdkService` 和服务端显式 adapter/bridge 接入。协议、catalog 公共类型和客户端不能接收原始 `SDKMessage`、`Query` 或 SDK 私有 metadata。
2. 新增 SDK 能力时，用官方类型的 `Parameters<>`、`ReturnType<>`、`Awaited<>`、`Pick<>` 和 `satisfies` 推导，不手写一份“差不多”的 SDK union 或 Query 接口。
3. 精确 pin SDK 版本。升级 SDK 时先检查 `.d.ts`、options compile contract、mapper fixture 和真实 startup 行为，再改适配层。
4. `buildClaudeOptions()` 是 Query options 的集中汇聚点。`cwd`、session new/resume、model、effort、permission、setting sources、MCP/plugins/hooks、partial messages 等配置不得散落在调用点重复拼装。
5. 使用 Claude Code preset 和 SDK 自带 agent loop。Host 负责协议、UI 交互桥、会话生命周期和状态投影，不重新实现 Claude 的 planning/tool policy。
6. SDK import 默认限制在 `src/claude/`；`interaction/`、`persistence/` 等模块只有在充当窄集成 bridge、且必须精确复用官方 callback/字段类型时才可直接引用。不得借此把 SDK 类型继续传播到 domain、protocol、catalog wire 或客户端。

### 会话与 Query 生命周期

```text
创建 chat
  → provisional backing（不启动 SDK）
  → 首次 send 时 materialize
  → 建立/恢复长生命周期 Query
  → 多轮 send 复用 Query
  → result 结束 turn，不结束 Query
  → 显式 close、iterator 结束或进程异常才结束 runtime
```

- `createClaudeAgentHost()` 和 import 只装配对象；不得自动 listen、访问网络或提前启动真实 Query。
- 新 chat 在首发前保持 provisional。并发首发必须通过每 chat 串行入口，确保只 materialize 一次。
- 同一 chat 的 send、配置变更、materialize、approval/input 结算按明确顺序串行；不同 chat 可以并行。
- interrupt/abort 是控制操作，不能排在被取消的 send 后等待。取消后 runtime 若仍健康，应允许下一轮继续使用。
- model、effort、permission mode 等 SDK 支持的设置优先热更新；需要重建 Query 的工作目录、plugin/MCP、transport、resume anchor 等变化走安全 rebind，并重放 runtime 配置。
- 客户端离线、App 退到后台或页面卸载，不能自动终止 active turn，也不能自动 deny pending interaction。
- Host 崩溃恢复时，completed transcript 可恢复；未完成 turn 必须标为 interrupted/failed，不能伪装 complete。
- listener、timer、WebSocket、Query、AbortController、pending waiter、数据库连接都必须有配对清理路径；`shutdown()` 应可等待、幂等且不重复 close。

### Catalog、模型与会话配置

- 默认通过 SDK `listSessions()` 从绝对 `cwd` 发现已有工作区，通过短生命周期 SDK Query 的 `supportedModels()` / initialization result 获取模型目录。
- 环境变量里的 workspace/model JSON 是可选的部署覆盖或访问约束，不是客户端正常工作所需的必填 catalog 数据源。
- 没有历史 session 的全新目录无法由 `listSessions()` 推断；此场景通过服务端显式目录配置或受控目录选择能力解决，不能让客户端扫描服务端文件系统。
- SDK `ModelInfo.value` 是公开 catalog 的稳定选择 ID；runtime/transcript 可能返回 `resolvedModel`。`value ↔ resolvedModel` 的规范化由 Claude adapter 完成。
- 多个 catalog alias 指向同一 provider model 时，优先保留当前选中的 canonical model ID；未知值才按 Host 定义的默认模型兜底。
- 历史会话的 model、effort、permission mode 必须在 Host 投影阶段规范化到当前 catalog/能力范围。客户端不维护另一张 provider model 映射表，也不把不存在的值静默改成自己的默认值。
- 客户端标题栏、selector 和会话详情必须展示 Host 下发的当前 canonical 配置，不能出现 `Host模型`、`Host` 等占位值覆盖真实数据。

### 状态、Action 与多客户端收敛

- 所有客户端可见业务变化只能用 versioned domain action 或 snapshot 表达；SDK 原始事件不能进入公网协议。
- 实时路径是 `SDKMessage → mapper → ChatAction → Host reducer → ActionEnvelope → client reducer`。
- 历史路径是 `SessionMessage[] → replay mapper → bulk domain action/reducer → snapshot`，不能绕过 reducer 手写另一种最终状态。
- reducer、mapper normalization、URI/ID 校验、replay 选择和 catalog 投影必须是确定性纯函数。时间、随机 ID、环境变量和 I/O 从 orchestration 边界注入。
- 相同 `state + action` 必须逐字段得到相同结果；reducer 内不得调用 `Date.now()`、`new Date()`、`Math.random()` 或读取 locale/process。
- 服务端先 reducer 提交权威状态，再分配并广播唯一的全局递增 `serverSeq`。
- `serverSeq` 是 Host 全局序号。频道过滤产生空洞是正常现象；客户端只要求新序号大于已应用序号，不能要求严格 `+1`。
- snapshot 的 state 与 `fromSeq` 必须属于同一同步切点。建立订阅或重连时先交付基线，再按序 flush 屏障期间的 action。
- epoch 相同且 replay 窗口覆盖时返回 replay；epoch 改变或窗口失效时返回 fresh snapshot。客户端必须正确支持两条路径。
- 同一 `clientId + commandId` 的重试返回 canonical receipt，不得重复向 SDK 发送。
- 新连接以同一 `clientId` 接管时，旧连接必须 fenced；旧 socket 不能继续发命令或接收状态。

### 权限、结构化输入与安全

- SDK 决定 permission mode 下的工具策略；Host 的 `canUseTool` 是 UI/协议桥，不复制 SDK policy。
- 未配置交互处理时默认 fail closed，绝不自动 allow。
- `AskUserQuestion` / elicitation 是结构化输入，不伪装成普通 permission dialog。
- 多客户端都可以看到 eligible request，但只能有一个有效决议；first-writer-wins，失败方收到 canonical `already_resolved`。
- abort、timeout、dispose 和 runtime crash 必须结算所有 pending waiter，不能悬挂 Promise。
- 未验证的 tool input 只能作为 opaque/read-only JSON 或文本展示，不能由客户端解释并执行。
- ACL 必须在读取状态、注册 actor 或消耗序号前拒绝未授权访问，避免存在性和状态侧漏。

### Transport、持久化与安全边界

- 网络入口保持为 `GET /health` 与 `GET /ws`；聊天控制走 versioned JSON-RPC 2.0，不另建一套 REST 聊天接口或第二条 SDK 通道。
- 所有网络输入先经过严格 Zod schema、大小限制和 URI/ID 校验；未知字段按现有 strict contract 处理。
- Bearer token 只通过 `Authorization` header。禁止进入 URL query、日志、错误、action、analytics 或构建产物。
- 生产公网使用 `wss://` / TLS 反向代理和高熵 token；`ws://`、短配对 token、public bind 只用于显式受信开发场景。
- Transport 负责认证、帧大小、速率、心跳、背压和慢客户端处理；Protocol handler 负责授权、RPC、订阅和连接所有权；两层职责不能混合。
- 持久化采用参数化查询和事务。需要原子可见的变更必须先 commit，再更新内存/广播；失败事务不得产生客户端可见 action。
- 错误跨协议前要结构化和脱敏，不能泄露 token、绝对秘密路径、SDK 堆栈或原始 provider payload。

## 移动端架构规则（硬性）

### 数据与状态

- `app/` 只负责路由参数解析和页面装配；WebSocket、重连、领域状态与业务策略分别归 `sync/`、`domain/` 和 feature/runtime owner。
- 组件不得直接持有 socket 或自行解析 JSON-RPC。网络 `unknown` 必须先由 `src/protocol/hostWire.ts` 等 schema 校验，再进入 domain/store。
- `CloudRuntime` / sync store 是连接与服务端状态的统一入口。不得在页面中再建一套平行全局状态或硬编码 catalog。
- Host 是 workspace、session、model、effort、turn、tool 和 interaction 的唯一权威；客户端只保留连接配置、最近选择、composer draft 和 last-known-good snapshot。
- 首连走 initialize；进入会话订阅 exact `chatUri`；离开页面只解除视图需求，不能把页面生命周期当作服务端 turn 生命周期。
- 断线和刷新期间保持 last-known-good 内容，不能先闪空；reconnect 的 replay/snapshot/fencing 结果都必须可观察且可测试。
- optimistic UI 仅用于协议明确支持对账的命令，必须带 `commandId/clientSeq` 并最终服从 canonical receipt/action。

### 会话交互约束

- Markdown、reasoning、tool lifecycle、approval 和 input 都来自 Host action/snapshot。canonical completion 不得重复追加已经展示的 partial text。
- thinking/reasoning 和 tool block 默认折叠，用户可展开；内容更新不能无故重置用户的展开选择。
- 只有 Host 提供了可靠的开始/完成时间或 duration 时才展示耗时；禁止固定文本或客户端臆造时长。
- active turn 时，如果用户仍处于底部锁定状态，流式内容应持续跟随；用户主动上滑后立即释放跟随，直到用户回到底部或点击“回到底部”。
- “真正底部”按 `contentHeight - viewportHeight` 计算，并包含 composer/inset 对列表的底部占位；不能只滚到屏幕物理底边。
- slash 命令列表从 Host 实时拉取。选择命令时保留输入框现有内容，在预期插入点插入命令；不得直接替换整段输入。
- approval/input 提交后按钮进入 pending，直到 canonical `resolved` / `already_resolved`；第二客户端抢先处理属于正常收敛，不显示成未知系统错误。
- stop/interrupt 走控制命令并立即可用，不应等待普通 send 队列。

### 平台视觉与动效

- 先阅读用户提供的截图、设计稿和 `design/` 参考，再改视觉；完成后在受影响的平台/尺寸做真实截图或模拟器检查，不能只凭 JSX 推断。
- iOS 26 在能力和运行时 API 均可用时使用系统 Liquid Glass；旧 iOS 使用系统 blur + rim/shadow；Reduce Transparency、测试或模块失败时使用同尺寸实体 surface。
- Android 使用 Material 3 的 color/surface/elevation/shape/motion。不要在 Android 伪造 Apple Liquid Glass，也不要对长列表开启持续高成本 blur。
- glass/blur 只用于 header、composer、sheet 和浮动 chrome，不给每条 transcript 内容套材质。
- Bottom sheet 的 backdrop 与面板必须是两个视觉/动画层：backdrop 独立淡入且固定覆盖页面，面板随后从底部进入；不得让灰色背景随面板一起向上移动。
- 异步内容加载后的 sheet 高度必须稳定、可读并受 safe area 约束；内容容器使用明确的 flex/最小最大高度，避免命令返回后浮层偶发塌矮。
- 导航返回必须执行 native pop/back，保留 iOS 交互式返回手势和从左向右退出；不得通过 push 一个旧页面伪造返回。Reduce Motion 时使用克制的 fade/无运动降级。
- 动画优先在 UI thread 使用 Reanimated 的 transform/opacity；避免由 JS 每帧驱动布局。进入、退出、手势打断和 reduced-motion 路径都要定义。
- 正确处理 safe area、键盘 inset、system bars、Android back/predictive back；交互目标至少 44pt（iOS）/48dp（Android）。
- 尊重深色模式、字体缩放、Reduce Motion、Reduce Transparency、VoiceOver/TalkBack 焦点和对比度。
- 大会话使用虚拟列表并只更新变化的 turn/part；输入框 keystroke 不应触发整个 transcript 重渲染。

## TypeScript、纯函数与代码组织

- 两个包都启用 TypeScript strict。Host 还启用 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noUnused*` 等严格选项；新增代码必须在这些约束下建模。
- 禁止新增显式 `any`。外部输入使用 `unknown` + schema/type guard 收窄；第三方边界确实无法表达时，用最窄局部类型并说明原因。
- 不用无依据的 `as`、双重断言或 `@ts-ignore` 绕过类型错误。测试 fake 也应由正式接口/SDK 类型推导。
- 类型/类用 PascalCase，函数/变量用 camelCase，常量用 UPPER_SNAKE_CASE；沿用已有 action 字符串和 URI 构造器，不创造近义命名。
- 派生数据优先纯 selector/projector，不复制进 state。React 使用函数组件和 hook；副作用必须有明确 owner 和 cleanup。
- 新增规则、mapper、reducer、几何、地址规范化、能力判断、fallback 决策时，优先提取可独立单测的纯函数。
- `createClaudeAgentHost.ts`、`protocolServerHandler.ts`、`runtimeStore.ts`、`ChatScreen.tsx` 等已有装配文件体量较大。不要继续把无关策略塞入这些文件；新增复杂逻辑优先抽到同域 helper/service/hook。不要为了顺手而进行无验收边界的大拆分。
- 注释解释“为何如此”、协议不变量、竞态和降级原因，不逐行复述代码。SDK/协议兼容分支、序列屏障、生命周期 race 和安全拒绝必须有必要注释。
- 新增依赖前说明已有依赖为何不足；小功能不引入重型库。

## Bug 修复与开发流程

1. 开始前运行 `git status --short`，确认当前分支和用户已有改动。工作树可能是 dirty；现有改动均视为用户工作，禁止覆盖、回退或顺手格式化无关文件。
2. 先复现和定位 owner：SDK adapter、Host protocol/state、mobile sync/domain 或纯 UI。记录影响范围，检查相邻路径是否存在同类问题。
3. Bug 原则上先添加能失败的回归测试，再做最小实现使其通过。纯视觉问题可用静态契约测试加模拟器/真机视觉证据替代脆弱的像素快照。
4. 修复根因而非症状。尤其禁止在客户端硬编码服务端缺失值、在 UI 重写模型 ID、用定时器掩盖同步竞态，或用导航 push 模拟 back。
5. 先跑最窄的相关测试和 typecheck；通过后根据影响面扩大到包级全量测试、bundle、原生构建或真实 Host smoke。
6. 完成前运行 `git diff --check`，审查 `git diff` 和 `git status --short`，确认只包含目标变更及用户原有变更。
7. 最终报告必须区分“自动化已验证”“真机/模拟器已验证”“尚未验证”；不能把 bundle 成功描述为原生安装包或真机通过。

不要自行执行 `git add`、`git commit`、`git push`、创建 PR 或发布 npm/GitHub Release。只有用户明确要求这些动作时才执行。用户要求打包只授权生成本地构建产物，不等于授权发布或提交代码。

## 测试门禁与命令

测试均使用 Vitest，位于各包的 `test/**/*.test.ts`。日常优先运行受影响的测试文件；协议、状态机、SDK 生命周期、持久化、跨端 contract 或发版前必须运行全量。

### 安装与本地运行

- 锁文件未变化且需要可复现安装时使用 `npm ci`；只有新增/升级依赖或明确需要更新 lockfile 时使用 `npm install`。
- Host 从源码运行：在 `repos/cc-agent-host` 执行 `npm run start:dev`；生产语义的前台进程执行 `npm run start:prod`。不要把真实 token 写进命令历史、文档或仓库。
- CLI 的 `start` 默认可以后台运行，`status` / `stop` 管理同一服务；调试生命周期和日志时使用 `--foreground`。绑定 `0.0.0.0` 或公网接口前必须明确评估 token 与 TLS 边界。
- Mobile 开发：在 `repos/cloud-mobile` 执行 `npm start` 启动 Metro，或用 `npm run ios` / `npm run android` 构建原生开发应用。
- 启动长驻 Host、Metro、模拟器或真机任务后，应向用户报告地址、模式和如何停止；任务结束且用户未要求保留时清理本轮创建的后台进程。

### Host

在 `repos/cc-agent-host` 执行：

```bash
npm run typecheck
npm test
npm run build
npm audit --omit=dev
```

针对性测试：

```bash
npx vitest run test/<domain>/<name>.test.ts
```

Host 当前没有 `lint` script，不要报告“Host lint 通过”；若用户要求全量质量门，应明确说明该包未定义 lint，并以 typecheck/test/build 为当前门禁。

### Mobile

在 `repos/cloud-mobile` 执行：

```bash
npm run typecheck
npm test
npm run lint
npm run bundle:ios
npm run bundle:android
```

针对性测试：

```bash
npx vitest run test/<name>.test.ts
```

- 纯 UI 样式调整至少跑 typecheck、lint 和对应静态契约测试，并做目标平台视觉检查。
- `bundle:ios` / `bundle:android` 只验证 JS/Hermes 导出，不等于 Xcode/Gradle 原生构建成功。
- 涉及 plugin、原生配置、safe area、导航、键盘、glass/material、签名或 release 行为时，必须增加相应 Xcode/Gradle 或模拟器/真机验证。

### 按变更类型选择验证

| 变更 | 最低验证 |
| --- | --- |
| Host 纯 reducer/mapper | typecheck + 对应测试 |
| SDK options/runtime/catalog | typecheck + Claude 相关测试 + build |
| 协议/schema/reconnect/ACL | typecheck + protocol/transport/相关集成测试 + 全量 test + build |
| persistence/migration | typecheck + repository/schema/store 测试 + 全量 test + build |
| Mobile selector/纯交互 | typecheck + 对应测试 + lint |
| Mobile sync/protocol | typecheck + sync/protocol 测试 + 全量 test + lint + 双平台 bundle |
| UI/动效/导航 | typecheck + lint + 对应测试 + 受影响平台视觉/运行验证 |
| 发版/打包 | 两包完整门禁 + iOS/Android 原生 release 构建 + 产物校验 |

测试要求：

- 测行为和公开边界，不把私有实现调用次数当产品合同。
- race、abort、timeout、rebind、reconnect 使用 fake clock/fake SDK/in-memory connection 确定性验证，不依赖真实网络顺序。
- 默认自动化测试不得调用真实模型、消耗线上 token 或要求真实 Claude 子进程；真实 smoke 必须显式进行并在结果中注明。
- 不通过放宽断言、删除测试、增加任意 sleep 或把错误吞掉来“修绿”。

## 版本升级与打包发布

用户要求升级版本时，先确定是否同时发布 Host 与 Mobile；若请求针对整个 Cloud，默认两个包保持同一产品版本。

### 版本号同步

Host：

- `repos/cc-agent-host/package.json`
- `repos/cc-agent-host/package-lock.json` 的根 package/version

Mobile：

- `repos/cloud-mobile/package.json`
- `repos/cloud-mobile/package-lock.json` 的根 package/version
- `repos/cloud-mobile/app.json` 的 Expo `version`
- iOS `CURRENT_PROJECT_VERSION` / `MARKETING_VERSION`
- Android `versionCode` / `versionName`

语义版本与原生 build number/versionCode 是不同概念：营销版本按用户要求升级；iOS build number 与 Android versionCode 必须单调增加，不能只改显示版本。

### 构建命令

在 `repos/cloud-mobile` 使用仓库脚本，不手工拼一套平行发布流程：

```bash
npm run build:ios:device
npm run build:android:release
npm run build:mobile:release
```

默认产物写入 `.build-artifacts/`，文件名由 `package.json` 版本动态生成。不要手改或提交 `dist`、原生 build 目录、archive、IPA、APK 等生成物，除非用户明确要求纳入版本控制。

### 产物验收

- iOS：检查 IPA/Archive 可解压、bundle id、`CFBundleShortVersionString`、`CFBundleVersion`、arm64、provisioning profile 与 `codesign --verify --deep --strict`。
- Android：检查 APK 可解压、package、versionName/versionCode，并用 `apksigner verify --verbose --print-certs` 验证签名。
- 对最终 IPA/APK 计算 SHA-256，并给出可点击的绝对路径。
- 明确披露签名性质：Apple Development IPA 只适用于描述文件登记设备；Android Debug certificate 或测试 keystore 的 APK 不能表述为商店正式签名包。
- 不把本地成功打包自动等同于 TestFlight、App Store、Play Console 已发布。

## 文档、品牌与交付要求

- 修改协议、启动参数、环境变量、catalog 行为、打包脚本或用户流程时，同步更新对应 README/架构/API/phase 文档。
- 架构文档描述“当前已实现行为”与“规划能力”时必须显式区分；历史验收数字不能冒充本次测试结果。
- 对外品牌为独立产品 Cloud / CCVibe。可事实性说明“基于 Claude Agent SDK”，但不得使用 Anthropic/Claude Logo 或文案暗示官方隶属、背书或赞助；遵守 `implementation-notes.md` 的中英文免责声明要求。
- 最终交付先说结果，再列关键变更、验证与剩余限制。引用文件和安装包时使用绝对路径链接。

## 完成前自检

- 这项事实真正属于 Host、SDK 还是客户端？改动是否落在 owner 层？
- 是否引入了第二份 transcript、catalog、model mapping、permission policy 或连接状态？
- SDK raw type 是否越过 adapter；网络 `unknown` 是否经过 schema？
- 同一 action 序列能否让多个客户端逐字段收敛？断线后 replay 与 snapshot 是否都成立？
- 同 chat 的并发首发/配置/取消是否会重复启动或发生死锁？
- 用户主动滚动、后台、断网、第二客户端决议等非理想路径是否被保留？
- iOS 与 Android 是否遵循各自平台材质、动效、返回和可访问性语义？
- 回归测试是否验证了根因，而不是当前实现细节？
- 版本、原生 build number、产物元数据和签名说明是否一致？
- 是否保留了用户原有未提交改动，且没有擅自 commit/push/publish？
