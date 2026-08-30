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
