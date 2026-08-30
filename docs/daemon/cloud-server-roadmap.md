# CCVibe Cloud Agent Host 服务端编码路线图

> 状态：执行中  
> 制定日期：2026-08-23  
> 目标包：`repos/cc-agent-host`  
> 参考事实源：`harness.md`、`vscode-agent-new-structure.md`、`vscode-agent-dataflow.md`、VS Code Agent Host、Happier

## 1. 目标与边界

CCVibe Cloud 服务端是在受控服务端进程中运行 Claude Agent SDK、管理多个 Claude 会话，并向多个 Web/Mobile/Desktop 客户端提供一致状态和控制能力的 Agent Host。

第一阶段采用单 Host 进程：

```text
Clients
  -> WSS + JSON-RPC 2.0
  -> ProtocolServer
  -> HostStateManager / subscriptions / replay
  -> ChatActor + per-chat sequencer
  -> ClaudeAgentAdapter
  -> Claude Agent SDK Query
  -> SDK transcript
```

事实源必须保持分离：

- Claude SDK transcript：已完成 provider 对话历史、resume/fork 的事实源。
- Host `ChatState`：当前回合、流式内容、pending approval/input 和 UI overlay 的运行时事实源。
- Host overlay store：`chatUri -> sdkSessionId`、模型/effort/permission、命令回执、审批审计和目录配置。
- WebSocket：临时传输，不拥有 session、runtime 或 approval。

本路线图不恢复当前工作树中已删除的旧 `repos/cc-agent-daemon` 文件。新实现放在 `repos/cc-agent-host`，待新垂直切片通过后再决定兼容或迁移策略。

## 2. 不可违反的架构不变量

### 2.1 身份

以下身份不能互相替代：

```text
tenantId / principalId  认证授权主体
clientId                跨重连稳定的逻辑客户端
connectionId            一次 WebSocket transport
sessionUri              产品会话容器
chatUri                 可订阅的 exact chat
sdkSessionId            Claude SDK transcript/resume 标识
runtimeId               当前 Query/子进程实例
turnId                  一次用户输入到结果的领域回合
approvalId/inputId      Host 交互请求
commandId               客户端命令幂等键
```

- `sdkSessionId` 是 opaque provider data，不能成为公网 chat identity。
- 一个 `chatUri` 任一时刻最多有一个 live SDK owner。
- 多客户端只订阅同一 actor，不各自 resume 或启动 Query。
- 新 chat 可先 provisional；首次 send 才 materialize SDK runtime。

### 2.2 状态与顺序

- 所有客户端可见状态只能由 versioned domain action 或 snapshot 表达。
- SDK 原始 `SDKMessage` 不进入公网协议。
- 服务端必须先执行 reducer，再分配并广播唯一 `serverSeq`。
- `serverSeq` 是 Host 全局单调序号；订阅过滤会产生合法空洞，客户端不得要求 `+1` 连续。
- snapshot 的 `fromSeq` 必须与 snapshot state 属于同一同步截点。
- 同 epoch 且 replay 窗口覆盖时返回 action replay；否则返回 fresh snapshot。
- 同一 chat 的 send、配置、interrupt、approval 和 materialize 串行；不同 chat 可并行。

### 2.3 纯函数边界

Reducer、mapper normalization、URI/ID 校验、replay 选择和状态转换必须是确定性的纯函数：

- 不读取 `Date.now()`、`new Date()`、随机数、locale、环境变量或进程状态。
- 时间、ID、配置和 capability 由命令/adapter 边界生成并作为参数传入。
- 相同 state + action 必须逐字段得到相同结果。
- 可变状态只允许存在于明确的 orchestration shell：HostStateManager、ChatActor、Query pipeline、registry/store adapter。

### 2.4 Claude SDK 类型策略

SDK 接入阶段必须固定精确版本并以 SDK 自带类型为编译期合同：

- 使用 `import type` 引入 `Query`、`Options`、`SDKMessage`、`SDKUserMessage`、`PermissionResult` 等。
- 使用 `Parameters<T>`、`ReturnType<T>`、`Awaited<...>` 推导控制面参数和返回值。
- `buildClaudeOptions()` 返回 SDK `Options`，对象使用 `satisfies Options` 校验。
- 不手写缩减版 `Query`、`SDKMessage` 或 permission union。
- 测试 fake 通过 `Pick<Query, ...>` 或由 SDK 类型推导的窄接口约束，不复制签名。
- SDK raw 类型只存在于 `src/claude/` adapter 内；`src/domain/`、`src/protocol/` 不依赖 SDK。

### 2.5 生命周期

- `result` 结束 turn，不结束长生命周期 Query。
- iterator 结束、进程异常或显式 close 才结束 runtime。
- abort/interrupt 是控制操作，不能排在被取消 send 后方等待。
- 客户端全部离线不能作为停止 active turn 或 pending approval 的条件。
- Host crash 后 completed transcript 可恢复；active turn 标记 interrupted，不能伪装 completed。

## 3. 目录目标

```text
repos/cc-agent-host/
  src/
    domain/        # IDs、状态、actions、纯 reducers
    protocol/      # JSON-RPC contracts、snapshot/replay、subscriptions
    host/          # HostStateManager、logical clients、ChatRegistry
    chat/          # ChatActor、sequencer、command dedupe
    claude/        # SDK facade、options、pipeline、live/replay mapper
    interaction/   # approval、structured input、client tools
    persistence/   # overlay、receipts、audit、lease adapters
    transport/     # Fastify/WSS wiring
    security/      # auth、ACL、limits、workspace isolation policy
  test/
```

依赖方向：

```text
domain <- protocol <- host/chat <- claude/interaction/persistence <- transport
```

`domain` 不依赖 Node API、SDK、Fastify、数据库或 transport。

## 4. Phase 路线

## Phase 0：Protocol/State Kernel

状态：**已完成（2026-08-24）**。

目标：建立无 SDK、无网络、可证明收敛的状态内核。

交付：

- Node 22 + TypeScript strict + Vitest 的新包。
- branded identity 与 resource URI 构造/解析。
- `ChatState`、typed `ChatAction`、`ActionEnvelope`、`StateSnapshot`。
- 纯 `chatReducer`。
- Host 全局 `serverSeq`、有界 replay、snapshot fallback。
- per-key sequencer 和 command single-flight/dedupe 基础件。

退出条件：

- 两个独立 reducer 对同一 action 序列逐字段相等。
- snapshot 与并发后续 action 无丢失、无重复。
- filtered channel 的全局 seq 空洞不触发错误。
- replay 边界和超窗 snapshot 行为有测试。
- 相同 command 并发/重试只执行一次。
- `typecheck`、`test`、`build` 全绿。

详细计划：[`phase-00-protocol-state-kernel.md`](./phase-00-protocol-state-kernel.md)

## Phase 1：Versioned JSON-RPC Protocol Server

状态：**已完成（2026-08-24）**。

目标：用 fake actor 完成多客户端 initialize/subscribe/reconnect/dispatch 垂直链路。

交付：

- Fastify + WebSocket + JSON-RPC 2.0。
- Zod/JSON Schema 参数验证和稳定错误码。
- `initialize` 协议版本/capability 协商。
- 逻辑 `clientId` 与短暂重叠的 `connectionId`。
- root/session/chat subscriptions。
- `reconnect(hostEpoch,lastSeenServerSeq,subscriptions)`。
- 带 `origin(clientId,clientSeq,commandId)` 的 command 对账。
- frame、heartbeat、slow-client 基础限制。

退出条件：两个内存客户端完成订阅、断线 replay、超窗 snapshot 和重复命令测试；transport 不拥有 chat actor。

## Phase 2：Claude SDK Facade 与 Harness Options

状态：**已完成（2026-08-24）**。

目标：建立唯一 SDK 依赖边界和可升级的编译期合同。

交付：

- 精确 pin `@anthropic-ai/claude-agent-sdk`。
- `ClaudeAgentSdkService`：lazy import、startup/query、session catalog/messages 的窄 facade。
- 集中的 `buildClaudeOptions()`。
- Claude Code preset、`settingSources`、cwd/additional directories、model/effort、permission mode、partial messages、checkpoint、MCP/plugins/hooks 的类型安全配置。
- SDK compile-contract tests 与 fake Query。

退出条件：业务层无 SDK raw types；SDK patch 签名变化能通过 typecheck 暴露；options 关键字段均有直接测试。

## Phase 3：ChatActor、Provisional/Materialization 与 Query Pipeline

状态：**已完成（2026-08-25）**。

目标：单 Host 可安全管理多个长生命周期 Claude Query。

交付：

- `chatUri -> ChatBacking` 与 `sdkSessionId -> runtime` 反向索引。
- provisional create，首次 send 才 materialize。
- per-chat sequencer；不同 chat 并行。
- streaming input queue 与长生命周期 Query consumer。
- turn/runtime 生命周期分离。
- hot update：model、effort、permission mode。
- rebind：transport、workspace roots、plugins/MCP/custom agent/resume anchor 变化。
- interrupt 绕过普通 send 队列但保持状态串行提交。

退出条件：并发首发只启动一次；多轮 result 后继续发送；interrupt 后可继续；runtime crash 与 turn failure 区分。

## Phase 4：Claude Live Mapper、Replay Mapper 与 Transcript Recovery

状态：**已完成（2026-08-25）**。

目标：历史和实时都收敛到同一领域状态边界。

交付：

- `SDKMessage -> AgentSignal/ChatAction` live mapper。
- `SessionMessage[] -> Turn[]` replay mapper。
- tool use/result、thinking、subagent、usage、error 的稳定 domain 表达。
- SDK `listSessions/getSessionMessages` 主历史路径。
- history hydration 通过 bulk domain action/reducer，不直接手写最终 state。
- completed transcript + live overlay 合成 fresh snapshot。

退出条件：live/replay fixture 对 completed `Turn[]` 语义等价；SDK raw message 从不离开 adapter；Host 重启可恢复 completed turns。

## Phase 5：Approval、Structured Input 与 Client Tools

状态：**已完成（2026-08-27）**。详细设计与交接边界：[`phase-05-interaction-bridge.md`](./phase-05-interaction-bridge.md)。

目标：多客户端交互请求 first-writer-wins，并正确结算唯一 SDK waiter。

交付：

- actor-owned pending request registry。
- `ApprovalRequested/Resolved/Expired` actions。
- eligible-many、first-valid-decision-wins。
- `AskUserQuestion` 独立 `InputRequest` 状态机。
- SDK `AbortSignal`、timeout、dispose 清理。
- client tool owner/capability 选择与 disconnect grace。
- loser 返回 canonical `AlreadyResolved`。

退出条件：相反并发决议恰好一个获胜；断开创建者不自动 deny；所有订阅者最终状态一致；Host crash 语义明确为 waiter 作废和 turn interrupted。

## Phase 6：Overlay Persistence、Receipts 与恢复

状态：**已完成（2026-08-27）**。详细设计与交接边界：[`phase-06-overlay-persistence.md`](./phase-06-overlay-persistence.md)。

目标：Host 重启后恢复产品状态，不复制 SDK 对话正文。

交付：

- SQLite adapter，schema migration。
- chat backing、model/effort/permission、workspace roots、title/archive。
- command receipts/idempotency。
- approval audit 和 terminal status。
- 事务提交后广播（after-commit fanout）。
- action replay 仍可先保留内存；重启依赖 epoch + fresh snapshot。

退出条件：重启后 backing/config 恢复；重复 command 不重复写 SDK；失败事务不广播。

## Phase 7：安全与生产加固

状态：**已完成（2026-08-27）**。详细设计与交接边界：[`phase-07-security-production.md`](./phase-07-security-production.md)。

目标：可安全部署为远程服务。

交付：

- principal/tenant/session ACL 与 approve capability。
- WSS、短期 ticket/Authorization，禁止长期凭据进入 URL 日志。
- heartbeat、frame/rate/backpressure、队列高水位。
- workspace/worktree、凭据、资源和 egress 隔离策略。
- structured logs、metrics、redaction、SDK upgrade canary。
- graceful shutdown：停止接单、drain turn、关闭 Query、刷新 transcript。

退出条件：权限、限流、慢客户端、敏感信息脱敏和 shutdown 恢复场景有自动化验证。

## Phase 8：多 Host Affinity 与 Fencing（按负载启用）

目标：在确有容量需求后横向扩容，避免 split brain。

交付：

- tenant/workspace shard affinity。
- session owner lease + fencing generation。
- gateway-to-owner routing。
- shared SDK SessionStore 与共享 workspace/制品策略。
- 可选 Redis 用于路由/presence/wakeup；必要时才持久化 action journal/outbox。

退出条件：旧 owner 的写入被 fence；同一 `sdkSessionId` 不会被两个 Host 同时 materialize；迁移只在 safe point 执行。

## 5. 测试层级

每个 Phase 至少包含：

1. 纯函数 property/example tests。
2. orchestration race tests（fake clock/fake SDK）。
3. protocol contract tests。
4. SDK fixture tests（从 Phase 2 起）。
5. 真实 SDK smoke/replay-record E2E（从 Phase 3 起，默认离线 fixture）。

固定验证命令最终统一为：

```bash
npm run typecheck
npm test
npm run build
```

真实网络/凭据测试必须显式 opt-in，不能成为默认单元测试前提。

## 6. 审核规则

具体编码和测试由 Haiku 子代理按 Phase 文档执行，主代理负责：

- 确认改动只在当前 Phase 范围内。
- 审核 SDK 类型是否来自官方声明。
- 审核 reducer/mapper 是否确定性纯函数。
- 审核身份、seq、生命周期是否被混用。
- 运行 typecheck/test/build，并针对 race/边界补充测试。
- 不在测试失败、实现部分完成或存在未解决错误时宣告 Phase 完成。

## 7. 明确不做

在 Phase 0–6 不做：

- PostgreSQL/Kafka/NATS 对话事件库。
- 每 token 一条数据库事件。
- 每 WebSocket 一个 SDK Query。
- 客户端上传本地历史并与 SDK transcript 合并。
- 让 Web/Mobile 解析 SDK raw union。
- 在协议重构中顺手无保护升级 SDK。
- 把持久化 approval row 描述为可跨进程恢复已经死亡的 SDK promise。
