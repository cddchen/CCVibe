# Cloud 项目 harness 与 agent 协作入口

本入口于 2026-09-08 根据当前工作树、包脚本、Host options/runtime、Mobile sync/runtime 和功能计划核对；本次没有运行产品测试或真实 SDK。事实优先级与强制门禁见 [AGENTS.md](AGENTS.md)。下方「VS Code 历史参考」保留原研究全文，其类型、路径、版本和测试数字均不是 Cloud 当前事实。

## Cloud 事实索引

| 事实与 owner | 本仓库核对入口 | 维护边界 |
| --- | --- | --- |
| SDK adapter 与 options 汇聚 | `repos/cc-agent-host/src/claude/claudeAgentSdkService.ts`、`src/claude/options.ts`（后者相对 Host 包） | SDK 类型在服务端 adapter 收敛；修改前核对安装的 `.d.ts` |
| Host 装配与长生命周期 Query | `repos/cc-agent-host/src/claude/createClaudeAgentHost.ts`、`repos/cc-agent-host/src/claude/claudeQueryRuntime.ts` | result 结束 turn；interrupt 是控制路径；勿把它们当作关闭整个 Query |
| Live/replay 与权威状态 | `repos/cc-agent-host/src/claude/runtimeActionBridge.ts`、`repos/cc-agent-host/src/claude/replayMapper.ts`、`repos/cc-agent-host/src/domain/chatReducer.ts` | mapper 投影为领域状态；SDK transcript 与 Host overlay 分离；`system/init` 是 runtime/catalog 控制面信号，不生成 turn part，`system/status` 是瞬时 activity |
| RPC、订阅与恢复 | `repos/cc-agent-host/src/protocol/protocolServerHandler.ts`、`repos/cc-agent-host/src/protocol/schemas.ts` | 公共 wire、授权和 snapshot/replay 边界 |
| 移动端连接及同步 | `repos/cloud-mobile/src/features/runtime/runtimeStore.ts`、`repos/cloud-mobile/src/sync/reconcile.ts`、`repos/cloud-mobile/src/protocol/hostWire.ts` | Host 事实经 schema 和 sync 进入展示，snapshot 替换、replay 应用 action |
| 会话进入与加载反馈 | `repos/cloud-mobile/app/chat/[chatId].tsx`、`repos/cloud-mobile/src/features/chat/ChatScreen.tsx`、`repos/cloud-mobile/src/features/runtime/CloudRuntimeProvider.tsx`、`repos/cloud-mobile/test/chatSubscription.test.ts` | 路由立即挂载标题和框架；历史投影等待 native-stack transitionEnd 后可取消的一帧调度。Runtime 按 chatUri 提供订阅 pending/ready/error 并合并并发请求，以连接 generation 隔离旧完成回调，断开保留 last-known-good。selector 缓存同时检查 selector/equality identity，避免路由变化时复用旧投影。正常本机 Host 的 Simulator 录屏已证明框架/顶部同步条先于正文，真实弱网与初始深链等边界的证据范围见计划 22 |
| 完成态 assistant Markdown | `repos/cloud-mobile/src/features/chat/ChatScreen.tsx`、`repos/cloud-mobile/patches/react-native-enriched-markdown+0.5.0.patch`、`repos/cloud-mobile/test/enrichedMarkdownContract.test.ts` | 完成态使用精确固定的 `react-native-enriched-markdown@0.5.0` GitHub container renderer，使 GFM table 走原生表格容器；非表格文本保留 `selectable`，但当前表格单元格不可选，也不承诺跨表格边界连续选区。流式消息仍走原生 `Text`；可复现 package patch 持有 iOS inline code 父字号/逐行 glyph 背景、nested fenced code 列表范围/缩进，以及 Android 回移的 `ArrowKeyMovementMethod` 选区 owner 修复（不得主动清理系统 `Selection`）。Android 原生编译已验证，真实拖选手势仍需设备 smoke。公式支持全链路关闭 |
| Mobile bottom sheet 生命周期 | `repos/cloud-mobile/src/ui/motion/BottomSheetMotion.tsx`、`repos/cloud-mobile/src/features/chat/ChatScreen.tsx`、`repos/cloud-mobile/test/chatPopoverMotion.test.ts` | `BottomSheetFrame` 先独立挂载并淡入 scrim，scrim 完成后才挂载 panel 进入动画，避免 iOS native Modal 首帧先绘制 panel 终态。关闭顺序是 panel/scrim 退出 → `Modal visible=false` → iOS native `onDismiss`；从加号菜单切到权限设置、以及 approval/input 互换，都只能在该关闭完成信号后挂载下一 Modal，不能用固定时长猜测。motion cycle 隔离过期动画回调；Android 在受控 `visible=false` 提交后完成同一交接。该路径已用签名 iPhone Simulator 对真实 Host 会话验证重复开关、权限选择与关闭后列表拖动，并逐帧核对入场无终态闪帧 |
| 产品配置持久化 | `repos/cc-agent-host/src/persistence/overlayRepository.ts`、`repos/cloud-mobile/src/storage/connectionPreferences.ts` | Host overlay 与客户端连接/偏好各有 owner，不能扩成第二份 transcript |
| Mobile 弹窗材质 | `repos/cloud-mobile/src/features/home/HomeScreen.tsx`、`repos/cloud-mobile/src/features/chat/ChatScreen.tsx`、`repos/cloud-mobile/src/ui/glass/GlassPanel.tsx` | 首页 picker、会话模型/权限/结构化输入及加号菜单采用同一 GlassPanel 材质层级（82/regular/elevation5/extraLarge）；加号菜单不再强制实体。iOS Liquid Glass/blur/实体与 Android Material 的能力降级仍归 GlassSurface。2026-09-11 已核对首页模型和加号菜单 Simulator 截图；完整验收范围及剩余平台项见计划 23 |

这张表是定位入口，不是全面架构审计。未覆盖的细节由任务架构师沿源码核实后补充，不从历史参考推导。

## 文档如何协作

| 文档 | 唯一主要职责 | 谁维护 |
| --- | --- | --- |
| `harness.md` | 当前事实、owner、证据入口、漂移和知识导航 | 架构师收敛；开发者提交变更证据，测试员核对 |
| `AGENTS.md` | 全项目必须遵守的规则和验证矩阵 | 架构师仅将稳定、可验证约束提升为规则 |
| `docs/cloud-feature-plans/`、`docs/daemon/phase-*.md`、`docs/mobile/phase-*.md` | 单任务目标、计划、交接、实现偏差和验收记录 | 按阶段单写者交接 |
| `docs/daemon/cc-agent-host-architecture-and-api.md` 及包 README | 架构/API 与操作说明 | 开发者随行为更新，架构师复核 |
| `.codex/agents/*.toml` | 三个角色的执行指令与模型配置 | 架构师；不复制全部项目规则 |

现有功能计划 08、11 展示了「根因/产品语义 → 实施 → 验证 → 代理边界」的交接形式；其历史完成状态不代表新任务验证通过。新任务沿用对应目录，不覆盖旧验收记录。

## 架构师 → 开发者 → 测试员 → 架构师

1. **架构师调研**：读根规则、本入口、相关计划及事实 owner；检查分支和 dirty 基线。记录事实、来源、置信度和漂移，明确范围、非目标与验收标准，再将可独立执行的计划写入现有计划目录。
2. **开发者实现**：读取计划及其证据，使用 Luna Max 在分配的文件范围编码并做针对性验证；原则上先证明回归测试失败。发现方案与真实类型/行为冲突，向架构师回报证据，不跨职责补丁。完成后追加实现与偏差记录。
3. **测试员独立验收**：使用独立的 Luna Max 子代理，从验收条件检查当前 diff、回归测试和失败路径；开发者交接后再运行受影响门禁。记录实际命令、环境、结果和缺口，不把开发者报告直接当成验证证据。问题返回开发者，修复后验证受影响范围。
4. **架构师收敛**：审查代码、测试与文档的一致性；把本次证明的持久事实更新到本入口，将必要的稳定规则更新到 AGENTS，将操作/API 变化放回其 owner 文档。只有验收要求满足才将计划标为完成。

默认由当前主代理承担架构师，或显式调用 `cloud-architect`；`cloud-developer` 和 `cloud-tester` 配置为 `gpt-5.6-luna` / `max`。主代理模型继承当前会话。仅要求调研/计划时，到计划交付为止；要求实现时继续完整闭环，不额外增加计划审批。

调度必须传递：仓库路径、计划路径、任务目标、允许修改文件、禁止范围、依赖/前置结果、验收条件、回报位置。三个角色都先读本文件和根 AGENTS，不能依赖原对话记忆。父代理统一调度，开发者和测试员不递归派生。相同文件/共享文档串行写入；独立模块只有在接口和写入范围明确后才并行。测试验收以开发者交接的稳定代码为基线，期间如代码再次变化需记录并重验。

### 计划最小交接结构

- 状态：调研中 / 可实施 / 实施中 / 待验收 / 需返工 / 已完成 / 阻塞；阻塞写明原因、owner、解除条件。
- 目标、范围和非目标；当前分支与已有改动摘要。
- 事实证据：`事实 → owner → 文件/符号 → 置信度 → 漂移/动作`。
- 方案、备选取舍、依赖与实施顺序；按角色分配文件范围。
- 验收条目：可观察行为、正常/失败/竞态路径、测试入口、所需平台。
- 实现记录：改动、偏差、原因、harness/API/README 更新位置或无需更新的理由。
- 验证记录：命令、执行目录、日期/环境、退出结果、证据路径；分别列自动化、真机/模拟器、尚未验证。
- 收敛记录：未解决风险、返工结果和架构师最终结论。

## 验证地图

两个包分别执行脚本；完整强制矩阵见 AGENTS「按变更类型选择验证」。Host 无 lint script。

| 边界 | 现有测试入口 | 命令 owner |
| --- | --- | --- |
| Host SDK/runtime/options | `repos/cc-agent-host/test/claude/` | Host `package.json` 的 typecheck、test、build |
| Host 状态/协议/存储 | `repos/cc-agent-host/test/domain/`、`test/protocol/`、`test/persistence/`（后二者相对 Host 包） | 同上；按矩阵扩大到全量 |
| Mobile schema/sync/runtime | `repos/cloud-mobile/test/hostWire.test.ts`、`repos/cloud-mobile/test/syncState.test.ts`、`repos/cloud-mobile/test/runtimeFlow.test.ts` | Mobile typecheck、test、lint、双平台 bundle |
| 平台视觉与原生行为 | `repos/cloud-mobile/test/` 的相关静态契约 + 受影响平台实测 | Mobile ios/android 与 build 脚本；bundle 不证明原生通过 |

### iOS Simulator 连接本机 Host 的 live smoke

需要验证 SecureStore、真实 WebSocket、历史会话或聊天 UI 时，先检查本机 Host，而不是直接启动第二个实例：

```bash
curl -fsS http://127.0.0.1:8787/health
```

- 已返回 Host health 时，复用现有进程、地址和 token；不得为了测试重启、替换或停止用户已运行的 Host。
- 没有 Host 监听时，才自行启动后台实例：`npx @cddchen/cloud@latest start --token="$CCVIBE_LOCAL_HOST_TOKEN" --global`。`CCVIBE_LOCAL_HOST_TOKEN` 使用操作者在仓库和共享日志之外提供的本地测试值；也可省略 `--token`，使用 CLI 打印的一次性配对 token。记录启动输出的地址，并按 AGENTS 的长驻进程规则报告和清理本轮创建的实例。
- iOS Simulator 上从当前工作区运行可连接 smoke，使用：

  ```bash
  cd /Users/cdd/Documents/ClaudeCodeRemote/CCVibe/repos/cloud-mobile
  npm run ios
  ```

  模拟器可连接 `http://127.0.0.1:8787`（客户端规范化为 `ws://127.0.0.1:8787/ws`）；真机使用 Host 输出的局域网地址。
- `CODE_SIGNING_ALLOWED=NO` 生成的 Simulator `.app` 只可作为原生编译/资源安装证据，不可用于上述连接 smoke。该产物没有 Keychain 所需的 `application-identifier` / `keychain-access-groups` entitlement，Expo SecureStore 会以 `-34018` 失败，使界面在发起 WebSocket 前就显示连接配置读写失败。

只改文档/agent 配置时检查 TOML、路径、引用及 `git diff --check`，无需消耗模型 token 或跑产品全量构建。角色约束属于指令，并非操作系统写权限隔离。自定义角色的自动发现及实际模型选择需在支持该配置的 Codex 会话中验证；工具未提供角色选择时，父代理应读取对应 TOML 指令并显式传入 Luna/max，不能声称配置自动生效。若运行环境不支持该模型，报告限制，不静默换模型。

配置格式依据：[OpenAI 自定义子代理文档](https://learn.chatgpt.com/docs/agent-configuration/subagents)。可用提示：「按项目 harness 流程实现 X，由架构师先写计划，再让 cloud-developer 和 cloud-tester 使用 Luna Max 完成开发及独立验收。」

---

# VS Code 历史参考（原文保留，非 Cloud 当前事实）

以下内容是先前对外部 VS Code 项目的研究快照；其中的“当前”均指该研究时点与参考项目，本次未复验这些外部结论。

## 结论

这个目录里的“agent harness”不是一个单独类，而是一套分层适配系统：

```text
Agent Host 注册
  → ClaudeAgent（平台 IAgent 适配层）
  → ClaudeAgentSession（会话状态与重建边界）
  → buildOptions（唯一的 SDK harness 配置汇聚点）
  → Claude SDK Query / subprocess
  → ClaudeSdkPipeline（流、并发、取消、重绑定）
  → Mapper / Permission / MCP / Elicitation
  → AgentSignal + 持久化
```

当前真正具有约束力的顺序是：

1. TypeScript 类型和 SDK `sdk.d.ts`
2. 生产代码，尤其 `buildOptions`
3. 单元、集成和 E2E 测试
4. `CONTEXT.md`
5. `roadmap.md`
6. 各 `phaseN-plan.md`
7. `smoke.md`

后面几类文档包含明显历史漂移，不能直接视为当前事实。

---

## 1. Agent harness 实际设置

### 1.1 注册与 SDK 装载

Claude SDK service 在 Agent Host 初始化时注册，Claude provider 当前默认启用：

- 本地 Agent Host：[agentHostMain.ts](/Users/cdd/Documents/vscode/src/vs/platform/agentHost/node/agentHostMain.ts:193)
- Remote Agent Host：[agentHostServerMain.ts](/Users/cdd/Documents/vscode/src/vs/platform/agentHost/node/agentHostServerMain.ts:330)
- 当前环境变量是 `VSCODE_AGENT_HOST_CLAUDE_AGENT_ENABLED`：[agentService.ts](/Users/cdd/Documents/vscode/src/vs/platform/agentHost/common/agentService.ts:212)
- 配置默认值是 `true`：[agentHostStarter.config.contribution.ts](/Users/cdd/Documents/vscode/src/vs/platform/agentHost/common/agentHostStarter.config.contribution.ts:247)

SDK 通过 `IClaudeAgentSdkService` 封装，负责：

- SDK 分发包描述
- 环境变量覆盖
- 延迟加载 SDK
- startup、session replay、model enumeration 等 API 的窄接口
- 编译期 SDK API 漂移检查

见 [claudeAgentSdkService.ts](/Users/cdd/Documents/vscode/src/vs/platform/agentHost/node/claude/claudeAgentSdkService.ts:40)。

### 1.2 `buildOptions` 是 harness 的中心

所有关键 SDK 选项集中在 [claudeSdkOptions.ts](/Users/cdd/Documents/vscode/src/vs/platform/agentHost/node/claude/claudeSdkOptions.ts:118)，没有散落在每个调用点。

| 设置面 | 当前设置 | 实际约束 |
|---|---|---|
| 工作目录 | `cwd`、`additionalDirectories` | 主工作区映射为 SDK cwd；额外根目录仅在可表示时加入 |
| SDK 运行时 | `executable: process.execPath` | Claude SDK 子进程复用当前 Node/Electron executable |
| 认证传输 | proxy 或 native | proxy 写入本地 `ANTHROPIC_BASE_URL` 和每会话 bearer；native 继承 Anthropic/API OAuth 凭据 |
| 权限 | `allowDangerouslySkipPermissions: true`、`permissionMode`、`canUseTool` | SDK 先执行自身 permission mode；需要交互时回调 Host |
| 工具限制 | `disallowedTools: ['WebSearch']` | CAPI transport 不支持 WebSearch，因此硬禁用 |
| 流式输出 | `includePartialMessages: true` | token/块级实时输出；mapper 必须防止 canonical message 再次重复发文本 |
| 子代理 | `forwardSubagentText: true` | 子代理的 text/thinking 不只保留 tool envelope |
| 文件状态 | `enableFileCheckpointing: true` | 开启 SDK 能力，但平台 undo 仍主要走 DB snapshot，并未直接依赖 `rewindFiles` |
| 会话启动 | 新会话用 `sessionId`，恢复用 `resume` | `resumeSessionAt` 只允许出现在恢复路径 |
| 原生配置 | `settingSources: ['user','project','local']` | SDK 会加载 CLAUDE.md、rules、hooks、agents、native plugins/MCP；明确不包括 managed |
| 系统提示词 | Claude Code preset | 使用的是 Claude Code agent harness 行为，不是裸 Anthropic messages 调用 |
| 插件 | `Options.plugins` | 主要承载客户端推送插件；native customization 由 `settingSources` 自动加载 |
| MCP | `mcpServers`、`deniedMcpServers` | 合并外部 MCP、客户端 MCP 和 Host server tools |
| 临时指令 | `UserPromptSubmit` hook | 仅注入本轮 Host instructions，不污染磁盘配置和长期会话设置 |

对应完整返回对象见 [claudeSdkOptions.ts](/Users/cdd/Documents/vscode/src/vs/platform/agentHost/node/claude/claudeSdkOptions.ts:151)。

一个很关键的设计是：

```ts
systemPrompt: { type: 'preset', preset: 'claude_code' },
settingSources: ['user', 'project', 'local'],
```

这意味着 VS Code 接入的是 Claude Code SDK 自带的 agent loop、工具系统和 customization 语义；VS Code harness 负责传输、UI 权限、会话协议和持久化适配，而不是重新实现一套 Claude agent loop。

---

## 2. 会话阶段如何划分

### 阶段 A：Provisional session

`createSession` 时先创建 provisional session，不立即启动 SDK：

- [ClaudeAgentSession.createProvisional](/Users/cdd/Documents/vscode/src/vs/platform/agentHost/node/claude/claudeAgentSession.ts:235)

这一阶段只建立：

- 平台 session identity
- 配置和 customization diff
- abort controller
- 持久化所需的轻量状态

这样列表、恢复、customization 编辑等操作不需要提前拉起 SDK 子进程。

### 阶段 B：Materialization

第一次真正发送消息前执行 materialize：

- [ClaudeAgentSession.materialize](/Users/cdd/Documents/vscode/src/vs/platform/agentHost/node/claude/claudeAgentSession.ts:580)

materialize 依次冻结或解析：

1. transport：proxy/native
2. 主工作目录和 additional roots
3. permission mode
4. client plugins、MCP、server tools
5. selected custom agent
6. telemetry context
7. `buildOptions`
8. `sdk.startup`
9. pipeline、DB ref、配置监听器

这里是“会话配置快照”形成的边界。

### 阶段 C：Turn 前重协调

每次发送之前，[ClaudeAgentSession.send](/Users/cdd/Documents/vscode/src/vs/platform/agentHost/node/claude/claudeAgentSession.ts:1043) 会检查：

- client tools 是否改变
- plugins/customizations 是否改变
- MCP revision 是否改变
- additional roots 是否改变
- resume/truncate anchor 是否改变
- transport 是否切换

变化按成本分为三类：

| 类型 | 示例 | 处理方式 |
|---|---|---|
| 热更新 | model、effort、permission mode | 调用 Query runtime setter |
| 重建 | plugin、agent、工作目录、transport、resume anchor | yield 当前 Query，使用相同 session 重新 startup |
| 控制操作 | abort、steering | 直接作用于 pipeline，不进入普通消息队列 |

因此 session 对客户端保持同一个对象 identity，但底层 Query 可以安全更换。

### 阶段 D：长生命周期 Pipeline

[ClaudeSdkPipeline](/Users/cdd/Documents/vscode/src/vs/platform/agentHost/node/claude/claudeSdkPipeline.ts:428) 负责：

- prompt async queue
- 长生命周期 SDK Query
- send 串行化
- result 与请求头对应
- abort/rebind race
- runtime 配置重放
- 完整 drain 后才发 `ChatTurnComplete`

Agent 的外层消息入口位于 [claudeAgent.ts](/Users/cdd/Documents/vscode/src/vs/platform/agentHost/node/claude/claudeAgent.ts:2275)。普通发送被 session sequencer 串行化；abort 则刻意绕过 sequencer，避免“取消请求排在被取消请求后面”的死锁。

---

## 3. 权限、工具和 MCP 的约束边界

权限 bridge 位于 [claudeCanUseTool.ts](/Users/cdd/Documents/vscode/src/vs/platform/agentHost/node/claude/claudeCanUseTool.ts:62)。

设计分工是：

- SDK：决定 permission mode 下哪些工具自动允许/拒绝
- Host：展示确认 UI，等待用户决定
- `canUseTool`：纯 UI/协议桥，不重新实现 SDK policy
- abort/dispose：必须解除所有 pending confirmation

两个特殊路径：

- `ExitPlanMode` 是 permission gate，同时更新 session permission configuration。
- `AskUserQuestion` 是结构化输入，不应伪装成普通 tool permission。

MCP elicitation 由独立 bridge 处理：[claudeElicitationBridge.ts](/Users/cdd/Documents/vscode/src/vs/platform/agentHost/node/claude/claudeElicitationBridge.ts:23)。无法表达、格式无效或会话取消时统一返回 cancel。

Server tools 只有在“永远不需要确认”时才会加入 `allowedTools`，避免 SDK 自动放行本应由 Host 确认的操作，见 [claudeAgentSession.ts](/Users/cdd/Documents/vscode/src/vs/platform/agentHost/node/claude/claudeAgentSession.ts:830)。

---

## 4. 各类文档分别起什么作用

| 文档 | 作用 | 约束强度 | 当前问题 |
|---|---|---:|---|
| `CONTEXT.md` | 术语、对象关系、跨阶段不变量、设计决策日志 | 较高 | 部分段落被后续阶段推翻但未完全清理 |
| `roadmap.md` | 北极星、Phase 稳定编号、目标架构、退出条件 | 中等 | 混有历史 SDK 版本和已变化配置 |
| `phaseN-plan.md` | 单阶段 PR 交接文档：范围、决策、测试、验收和实现偏差 | 中低 | 本质是阶段快照，不能覆盖后续实现 |
| `smoke.md` | 人工 UI/日志验收、PR 证据清单 | 低 | 引用的脚本当前不存在，且启用变量、最新阶段等信息过期 |
| 源码测试 | 把文档不变量翻译成可执行约束 | 最高 | 个别 load-bearing option 仍缺少直接断言 |

### `CONTEXT.md`

它定义了 materialization、SDK transcript、overlay、canonical/partial message、permission bridge 等核心关系。例如 provisional → materialized 的两阶段模型见 [CONTEXT.md](/Users/cdd/Documents/vscode/src/vs/platform/agentHost/node/claude/CONTEXT.md:30)。

但它也存在历史痕迹，例如早期描述暗示所有请求都走 proxy，而 Phase 19 后已有 native transport。因此应读取“最近的决策段落”，不能只读开头。

### `roadmap.md`

Phase 编号是稳定引用 ID，不等于实际交付顺序。官方写明的真实顺序是：

```text
1 → 1.5 → 2 → 3 → 4 → 5 → 6 → 9 → 13 → 7 → 8
  → 10 → 10.5 → 11 → 12 → 6.5 → 6.7 → 14
  → 15 → 16 → 17 → 18 → 19
```

证据见 [roadmap.md](/Users/cdd/Documents/vscode/src/vs/platform/agentHost/node/claude/roadmap.md:87)。

它仍写过 SDK `0.2.112`，而当前根依赖已经是 `0.3.220`：[package.json](/Users/cdd/Documents/vscode/package.json:173)。因此版本描述只能作为当时的基线。

### Phase plan

Phase plan 的价值主要在解释“为什么这样实现”，特别是：

- 被否决的方案
- SDK 实测行为
- 兼容性问题
- 验收测试为何选择某个边界

例如 Phase 17 明确纠正了一个重要误解：hooks 是否执行由 `settingSources` 决定；`includeHookEvents` 只影响 hook event 是否流入消息流，不决定 hook 本身是否运行，见 [phase17-plan.md](/Users/cdd/Documents/vscode/src/vs/platform/agentHost/node/claude/phase17-plan.md:277)。

当前代码没有设置 `includeHookEvents`，但 roadmap 部分位置仍声称它是必需且已开启。这属于明确的文档漂移。

### `smoke.md`

它原本是 Phase 4–9 的人工验收手册，覆盖注册、认证、模型、tool permission、file edit 等。

但是当前文档引用：

- `scripts/launch-smoke.sh`
- `scripts/verify-claude-logs.sh`

见 [smoke.md](/Users/cdd/Documents/vscode/src/vs/platform/agentHost/node/claude/smoke.md:39)，而这些脚本当前不存在。文档还保留旧环境变量 `VSCODE_AGENT_HOST_ENABLE_CLAUDE` 和默认关闭语义。

所以它目前是“历史操作记录”，不是可直接执行的 release gate。

---

## 5. Phase 可以按能力重新分组

虽然编号不能重排，但从架构角度可归成六层：

| 能力层 | Phase | 解决的问题 |
|---|---|---|
| 传输基础 | 1、1.5、2、3 | CAPI gateway、本地 proxy、SDK facade/options |
| Provider 骨架 | 4、5、6、6.1、10.5 | 注册、schema、session、pipeline、materialization |
| 交互运行时 | 7、8、8.5、9、10、10.6 | permission、file edits、配置热更新、取消/steering |
| 会话连续性 | 13、12、6.5、6.7 | replay、subagent、fork、truncate |
| Customization/分发 | 11、15、16、17、18、19 | plugins、分发、磁盘扫描、hooks、telemetry、native transport |
| 收敛加固 | 14 | hardening、日志、telemetry、错误处理 |

Phase 14 没有独立 `phase14-plan.md`，roadmap 的完成状态也不如其他阶段清晰；不过它所描述的部分 telemetry/hardening 能力已经分散落入后续实现，不能简单判断为“完全未实现”。

---

## 6. Test harness 与覆盖范围

静态统计显示 Claude 相关测试约有：

- 40 个直接包含 Claude test declaration 的文件
- 729 个直接 `test(...)`
- 115 个直接 `suite(...)`

这是源码静态计数，不代表本次实际执行结果；本次分析没有运行测试。

### 核心单元测试

| 测试文件 | 主要覆盖 |
|---|---|
| [claudeAgent.test.ts](/Users/cdd/Documents/vscode/src/vs/platform/agentHost/test/node/claudeAgent.test.ts:1) | provider/session 生命周期、provisional/materialize、恢复、模型、权限、工具、customization、MCP、fork/truncate、shutdown |
| [claudeSdkOptions.test.ts](/Users/cdd/Documents/vscode/src/vs/platform/agentHost/test/node/claudeSdkOptions.test.ts:1) | proxy/native env、敏感环境过滤、MCP 映射、插件投影、resume anchor、additional dirs、临时 prompt hook |
| [claudeSdkPipeline.test.ts](/Users/cdd/Documents/vscode/src/vs/platform/agentHost/test/node/claudeSdkPipeline.test.ts:1) | queue、abort、rebind、race、runtime config replay、consumer handoff、dispose |
| [claudeMapSessionEvents.test.ts](/Users/cdd/Documents/vscode/src/vs/platform/agentHost/test/node/claudeMapSessionEvents.test.ts:1) | partial/canonical 映射、文本/思考/tool lifecycle、拒绝、usage、文件编辑、去重 |
| [claudeReplayMapper.test.ts](/Users/cdd/Documents/vscode/src/vs/platform/agentHost/test/node/claudeReplayMapper.test.ts:1) | JSONL transcript、turn grouping、tool/subagent、compact boundary、异常消息、fork anchor |

这些单元测试大量使用 fake SDK、内存 DB、DI stub。优点是 race、取消和异常分支可以确定性覆盖；缺点是不能独立证明真实 SDK 子进程的行为。

### Proxy integration

[claudeAgent.integrationTest.ts](/Users/cdd/Documents/vscode/src/vs/platform/agentHost/test/node/claudeAgent.integrationTest.ts:1) 使用真实 `ClaudeProxyService`、真实 Agent 和 recording/fake SDK service，覆盖：

- HTTP proxy round-trip
- session bearer 和 nonce
- SSE
- `canUseTool` / `onElicitation` 是否穿透到最终 Options
- Read tool permission round-trip

它验证了 Host 和 proxy 的真实组合，但并不是“真实 Claude SDK 子进程集成测试”。

### Replay/record E2E

Claude provider 的 E2E 配置在 [claudeAgentHostE2E.integrationTest.ts](/Users/cdd/Documents/vscode/src/vs/platform/agentHost/test/node/e2e/providers/claudeAgentHostE2E.integrationTest.ts:1)。

默认模式：

- 使用已提交 replay fixtures
- 无 token
- 无网络
- 仍通过真实 SDK 驱动请求，并由 replay proxy 应答

设置 `AGENT_HOST_REPLAY_RECORD=1` 后才访问真实 CAPI 重新录制。

共享 E2E suite 覆盖：

- 基础 turn/context/model
- attachment/truncate
- 文件工具和工作目录
- plugin skill、MCP elicitation
- subagent、side chat、多聊天
- replay/恢复

当前显式缺口：

- `supportsPlanMode: false`：功能已接好，但共享 prompt 不能稳定驱动 Claude 调用 `ExitPlanMode`
- `supportsChatForkE2E: false`：客户端 turn id 无法可靠映射为 SDK UUID

见 [Claude E2E 配置](/Users/cdd/Documents/vscode/src/vs/platform/agentHost/test/node/e2e/providers/claudeAgentHostE2E.integrationTest.ts:83)。

---
