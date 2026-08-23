# CCVibe 远程 Agent 多客户端架构调研

> 调研日期：2026-08-22  
> 范围：`cc-agent-daemon`、Web/macOS 客户端、VS Code Agent Host 的 `claudeAgent` 实现、Claude Agent SDK 0.3.x。  
> 配套图：[remote-multi-client-agent-architecture.html](../../repos/cc-agent-daemon/docs/remote-multi-client-agent-architecture.html)

## 1. 结论

CCVibe 当前已经具备“一个进程内 runner 向多个 WebSocket 连接广播 SDK 消息”的最小能力，但还不是多客户端一致性协议。核心缺口不在 WebSocket 选型，而在其上缺少六项语义：

1. 稳定的逻辑客户端身份和协议协商；
2. 可订阅的服务端权威状态，而不是裸 `SDKMessage`；
3. `Snapshot(fromSeq) + ActionEnvelope(serverSeq, origin)` 的无缝历史/实时切换；
4. 客户端命令幂等、同一 chat 单写者串行化；
5. 审批作为所有客户端可见的状态，并由一次原子决议收敛；
6. SDK transcript、Host overlay、live runtime 三类状态的清晰所有权。

推荐保留 **WSS + JSON-RPC 2.0**，在其上增加 Agent Host 风格的版本化协议。不要把 WebSocket 换成另一种 transport 来掩盖状态协议缺失；SSE 无法自然承载双向审批和控制，gRPC 也不会自动解决重连、replay 和冲突。

推荐的事实源是两层而非一套重复的事件数据库：

- **Claude SDK transcript**：已完成对话、工具调用和工具结果的 provider-native 历史事实源；冷打开时通过 SDK `listSessions()` / `getSessionMessages()` 读取并映射为稳定 `Turn[]`。
- **Agent Host `ChatState`**：当前回合、流式 block、pending approval/input、运行状态和 UI overlay 的同步事实源；通过 snapshot + typed actions 投影到所有客户端。

Host 只需持久化 exact chat → `sdkSessionId` 的 opaque backing、模型/effort/permission、标题/归档等 overlay，以及审计/幂等所需的小量数据。若未来要求跨 Host 故障继续精确 replay 活跃 UI，再把 action journal 持久化；它仍不应替代 SDK transcript。

## 2. 当前实现已经有什么

| 能力 | 代码证据 | 判断 |
|---|---|---|
| WebSocket + JSON-RPC | `src/server.ts:24-55` | transport 基础可复用 |
| 多 socket 订阅 runner | `src/session/runner.ts:86-103` | 有广播集合，但无逻辑 client/subscription 生命周期 |
| 当前 turn 内存回放 | `src/session/runner.ts:36-37,121-128` | 仅 4000 条原始消息；result 后清空 |
| 自动重连 | `web/src/lib/daemonClient.ts:83-130`、`DaemonClient.swift:123-179` | 只重建 socket，不补洞 |
| 本地历史读取 | `src/history/reader.ts`、`rpc/router.ts:259-266` | 自行解析 Claude JSONL，已处理部分 tool-result 分支 |
| Claude Agent SDK | `src/session/claudeEngine.ts:1-107` | 已引入，不是待引入；当前锁定安装为 0.3.179 |
| SDK streaming input | `claudeEngine.ts:32-46,61-95` | 使用长生命周期 `AsyncIterable<SDKUserMessage>`，方向正确 |
| 审批回流 | `runner.ts:208-228`、`permission/registry.ts` | 能完成单连接 round-trip |
| 元数据持久化 | `src/store/db.ts:31-56` | 仅 workspace/session overlay，无 live state/approval/command |

因此正确的改造方式是“扩展现有 daemon 的协议与状态层”，不是新建另一套后端或替换 SDK。

## 3. Gap 矩阵

### P0：多客户端正确性

| Gap | 当前证据 | 直接后果 | 目标 |
|---|---|---|---|
| 连接 ID 被当作客户端 ID | `connection.ts:1-12` 每个 socket 都生成 `conn_*` | 重连后服务端认成新客户端，无法续订/去重 | 持久 `clientId`，transport 可替换且短暂重叠 |
| 无协议版本/capabilities | `protocol.ts` 只有通用 JSON-RPC shape | 客户端和 SDK action 演进只能同时升级 | `initialize` 协商 SemVer、client info、capabilities |
| 裸 SDK 消息成为公网协议 | `runner.ts:72-84,121-128` 的 `message: unknown` | SDK patch release 可破坏所有客户端；Web/Swift 各自重复 reducer | daemon 内统一映射为 typed domain actions |
| 无序号、event ID 和去重 | `events/types.ts:8-29` | 断线不知道漏了什么，重复 attach 无法判重 | `serverSeq`、`origin(clientId,clientSeq)`、必要时 `eventId` |
| 历史和实时之间存在竞态 | Web 先 `history.loadSession`，后 `attachIfLive`：`ChatPage.tsx:376-418`；mac 同样为 `ChatViewModel.swift:519-552` | 两次 RPC 之间产生的 delta 可能丢失或重复 | 一次原子 `subscribe/open` 返回 snapshot，随后只应用 `seq > fromSeq` |
| replay 只在当前 turn 且 result 后清空 | `runner.ts:121-128` | 完成瞬间断线的客户端无法补齐；长 turn 超窗静默丢数据 | 有界 action replay；超窗/epoch 变化则 fresh snapshot |
| user prompt 只在发起端本地插入 | `session.sendMessage` 只入 SDK：`router.ts:93-109`；Web 客户端本地 begin/append | 其他客户端无法确定同一 turn 的 prompt/ID | 服务端先产生 `ChatTurnStarted(prompt, turnId)` 再送 SDK |
| turn ID 由客户端时间生成 | Web `useTurnStream.ts:54-65`；mac `TurnStream.swift:14-34` | 多端同一回合拥有不同 ID | server/actor 分配稳定 `turnId` |
| 命令没有幂等键 | `sessionSendParams` 只有 `sessionId/content` | RPC 超时重试可重复发送 prompt/interrupt | `commandId + clientSeq`，服务端缓存/持久化结果 |
| 同一 runner 没有命令 sequencer | `runner.ts:236-249` 直接调用 engine | 两客户端可同时 send、interrupt、改 mode，顺序取决于事件循环 | 每个 exact chat 一个 mailbox/sequencer |
| resume 会删除已活跃 runner | `router.ts:112-132` 的 `existing -> remove` | B 客户端 resume 可终止 A 客户端正在看的会话 | materialize-if-absent；已有 owner 时 attach/forward，不重启 |
| 审批只发给创建时连接 | `runner.ts:180,208-223` 捕获 `permissionConn` | 其他设备不可见、不可决定 | pending approval 进入 `ChatState`，广播给所有有资格订阅者 |
| 审批绑定 socket 且断线即 deny | `permission/registry.ts:5-10,44-75`；`server.ts:57-60` | 手机切网会把正在等待的工具误拒绝 | 审批属于 session/turn；连接断开不改变其决议 |
| 决议未广播 | `permission.respond` 只返回调用方 `ok`：`router.ts:305-313` | 其他端继续显示旧弹窗 | 原子状态转移后广播 `ApprovalResolved` |

### P1：远程服务可靠性与安全

| Gap | 当前证据/事实 | 目标 |
|---|---|---|
| 全局 token、无 principal/tenant/role | `/ws` 只校验一个 token：`server.ts:24-34` | 用户/设备身份、session ACL、审批 capability |
| token 可出现在 query string | `server.ts:25`，客户端 URL 构造 | 生产 WSS 使用短期 ticket 或 Authorization/cookie，避免日志泄漏 |
| 无 heartbeat、frame limit、rate limit、backpressure | `socket.send(JSON.stringify(...))`：`server.ts:39-40` | ping/pong、最大帧、命令速率、队列水位、slow-client 断开与可恢复 replay |
| 断线后 subscription 由 UI 猜测恢复 | Web `onReconnect` 只触发页面重载逻辑 | reconnect 请求携带 subscriptions + lastSeenSeq |
| metadata/catalog 变化不广播 | `store/db.ts` 写 SQLite 后无 action | root/session/chat channel action |
| history parser 绑定私有 JSONL layout | `history/reader.ts` 手工构建 parentUuid chain | SDK `listSessions/getSessionMessages` + 单独 replay mapper；旧 parser 仅兼容 fallback |
| SDK 生命周期判断过早 | `runner.ts:197-206` 看到 result 即 completed 并清 buffer | mapper/Query 迭代结束共同定义终态；error result 与 process crash 分开 |
| 审批 promise 只在内存 | `PermissionRegistry.pending` | 明确 crash 语义；审批审计可持久化，但不能声称恢复已死亡的 SDK callback |
| 无 sandbox/resource/egress 隔离 | SDK 直接使用传入 cwd | 每 session/workspace 隔离、资源配额、凭据代理和网络 allowlist |

### P2：横向扩容

| Gap | 风险 | 目标 |
|---|---|---|
| runner registry 仅进程内 | 任意网关/Host 都可能错误 resume 同一 SDK session | tenant/workspace affinity + exact chat 单 owner |
| 无 lease/fencing | split brain 会让两个 SDK 进程同时写 transcript/worktree | owner lease + fencing token；旧 owner 的 append/command 被拒绝 |
| 无跨网关事件路由 | 客户端连到非 owner 节点收不到流 | gateway 将命令路由到 owner；pub/sub 只做唤醒/分发 |
| 本地 transcript 不能跨 Host | 容器迁移后 resume 失败 | Claude SDK `SessionStore` + 同一工作目录/制品恢复策略 |

## 4. 推荐领域模型与状态所有权

身份必须分开，不能继续靠 alias 猜测：

```text
tenantId / principalId     认证与授权主体
clientId                   一个安装/浏览器 profile 的稳定逻辑客户端
connectionId               一次 WebSocket transport
sessionUri                 CCVibe 的工作空间/编排容器
chatUri                    用户看到的 exact conversation，CCVibe 稳定 ID
sdkSessionId               Claude provider backing，首次 SDK init 后才产生
runtimeId                  当前 Query/子进程实例，不出现在用户 URL
turnId                     一次用户 prompt 到 result 的领域回合
toolCallId / approvalId    SDK tool_use 与 Host 审批状态的稳定关联
```

关键不变量：

- 一个 `chatUri` 在任一时刻最多有一个 live SDK owner；多个客户端只订阅，不拥有 runner。
- 新 chat 可以先有 `chatUri` 和 `lifecycle=creating`；只有 SDK init 后才绑定真实 `sdkSessionId`。
- `sdkSessionId` 是 provider opaque data，不直接替代 `chatUri`。
- 同一 chat 的 send/control/approval 串行；不同 chat 可以并行。
- SDK transcript 记录 provider conversation；Host overlay 记录 provider 不完整提供的产品状态。

## 5. 传输协议

### 5.1 Transport 决策

- 主通道：**WSS + JSON-RPC 2.0**。现有 Fastify/Swift/Web 实现可扩展，支持双向命令、审批、流式 action。
- 可选 HTTP：大附件上传、历史分页/导出。HTTP 返回值必须带 `throughSeq`，随后仍从 WSS 订阅，不能形成无序的第二事实源。
- 集群内：先直接 owner routing；只有多网关后才引入 Redis/NATS。消息总线是 delivery accelerator，不是对话事实源。

### 5.2 握手与重连

```ts
type InitializeParams = {
  protocolVersions: string[];
  clientId: string;
  clientInfo: { name: string; version: string; platform: string };
  capabilities: { partialBlocks: boolean; approvalEdits: boolean };
  initialSubscriptions: string[];
};

type InitializeResult = {
  protocolVersion: string;
  hostEpoch: string;
  serverSeq: number;
  snapshots: StateSnapshot[];
};

type ReconnectParams = {
  clientId: string;
  hostEpoch: string;
  lastSeenServerSeq: number;
  subscriptions: string[];
};

type ReconnectResult =
  | { type: "replay"; actions: ActionEnvelope[]; missing: string[] }
  | { type: "snapshot"; snapshots: StateSnapshot[] };
```

同一 `clientId` 的新 transport 可与旧 transport 短暂重叠，最新 transport 生效；服务端保留一个短 grace window。`hostEpoch` 变化说明进程内 active state/replay buffer 已失效，客户端必须接受 fresh snapshot。

### 5.3 Action envelope

```ts
type StateSnapshot<T = unknown> = {
  resource: string;       // root/session/chat URI
  state: T;
  fromSeq: number;
};

type ActionEnvelope<A = DomainAction> = {
  channel: string;
  action: A;
  serverSeq: number;
  origin?: { clientId: string; clientSeq: number; commandId: string };
  rejected?: { code: string; message: string };
  serverTime: string;
};
```

客户端只维护 reducer state：

1. snapshot 到达前先 buffer action；
2. 应用 snapshot；
3. 只 replay `serverSeq > fromSeq`；
4. 检测序号缺口后停止猜测，立即 reconnect；
5. 本端 optimistic action 通过 `origin` 对账，不能再次 append。

建议的 durable/domain action 至少包括：

```text
ChatCreated / ChatBackingBound / ChatMetaChanged
ChatTurnStarted / ChatTextDelta / ChatReasoningDelta
ChatToolCallStarted / ChatToolCallDelta / ChatToolCallReady / ChatToolCallCompleted
ChatUsageChanged / ChatTurnCompleted / ChatTurnFailed / ChatTurnInterrupted
ApprovalRequested / ApprovalResolved / ApprovalExpired
InputRequested / InputAnswered / InputCancelled
SessionActiveChanged / SessionCatalogChanged
```

不要传原始 `SDKMessage`。可在受控 debug/telemetry 通道保留脱敏 raw frame，不能成为 UI 合同。

## 6. 历史打开与新流式对话

### 6.1 打开本地历史

推荐服务端实现一个原子 `chat.subscribe`：

```text
Client                         Agent Host                         Claude SDK
  | chat.subscribe(chatUri)       |                                  |
  |------------------------------>| sequencer 中 materialize state   |
  |                               | getSessionMessages(sdkSessionId)  |
  |                               |--------------------------------->|
  |                               | replay mapper -> Turn[]           |
  |                               | register subscriber               |
  | snapshot{state, fromSeq=N}     |                                  |
  |<------------------------------|                                  |
  | action{serverSeq=N+1...}       |                                  |
  |<------------------------------|                                  |
```

服务端在同一 chat sequencer 操作内得到 snapshot 截点并登记 subscription。客户端即使在 snapshot 响应前收到 action，也先 buffer，然后只应用 `seq > fromSeq`。这消除了当前 `history.loadSession` 与 `attachIfLive` 之间的竞态。

冷态 completed turns 从 SDK transcript 的 replay mapper 得到；若 live actor 存在，再叠加其 `activeTurn`、pending approval/input。不要把 JSONL 原始 row 下发给客户端再让 Web 和 Swift 各自解释。

### 6.2 新对话产生流式数据

```text
Client A           Host/Chat sequencer          SDK Query           Client B
  | send(commandId,prompt) |                       |                    |
  |----------------------->| dedupe + allocate turnId                  |
  |                        | reduce ChatTurnStarted(prompt)             |
  |<--- accepted/action ---|------------------------------------------->|
  |                        | SDKUserMessage ---------->|                |
  |                        |<----- stream_event / assistant / tool -----|
  |                        | map -> typed action -> reduce/broadcast     |
  |<-----------------------|------------------------------------------->|
  |                        |<----- result / iterator lifecycle ----------|
  |<------ complete -------|------------------------------------------->|
```

服务端先接纳 prompt 并生成 `ChatTurnStarted`，再写 SDK input。这样所有客户端都得到同一个 prompt 和 `turnId`。文本/tool 参数 delta 可按 20–50 ms 或大小阈值合并后发 action，降低帧数；完整 assistant/tool result 由 SDK transcript 持久化，fresh snapshot 可重建 completed turns。

`ResultMessage` 是回合结果，不应直接等同于整个 long-lived Query 的死亡。streaming input session 在多数 error result 后仍可继续；只有 crash/iterator 结束才表示 transport 失效。Host 应把 `turn lifecycle` 和 `query/process lifecycle` 分开建模。

## 7. 多客户端审批

### 7.1 目标语义

默认适合 CCVibe 个人多设备的策略是：**所有有 `approve` capability 的在线客户端都看到 pending；第一个有效决议获胜；所有客户端看到相同 resolved state。** 企业场景可额外支持 assigned approver，但不是第一版必需。

```text
SDK canUseTool
  -> Host 原子 register pending promise
  -> reduce + broadcast ApprovalRequested
  -> 任一 eligible client 提交 decide(approvalId, expectedVersion, commandId)
  -> sequencer/DB CAS: pending(v1) -> approved|denied(v2)
  -> reduce + broadcast ApprovalResolved
  -> 仅一次 resolve SDK promise
```

决议请求：

```ts
type ApprovalDecisionCommand = {
  approvalId: string;
  commandId: string;
  expectedVersion: number;
  decision: "allow" | "deny";
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: unknown[];
  message?: string;
};
```

必须满足：

- 状态转移验证 tenant/session/principal/capability/deadline；
- 单 Host 内由 chat sequencer 保证 first-writer-wins；多 Host/持久审计模式使用 `UPDATE ... WHERE status='pending' AND version=?` CAS；
- winner 先提交权威状态并广播，再 resolve SDK promise，避免 tool result 先于 resolved action；
- loser 收到 `AlreadyResolved` 和 canonical decision/version，而不是模糊的 unknown request；
- socket 断开不 deny；timeout worker 走同一 CAS 和 `ApprovalExpired` action；
- `AskUserQuestion` 是结构化用户输入，状态与审批分开，避免把多选答案压成 allow/deny；
- SDK `suggestions/updatedPermissions` 需要完整透传，才能支持“允许一次/始终允许”。

### 7.2 无法回避的故障边界

`canUseTool` 等待的是 live SDK 进程中的 JavaScript promise。即使把 approval row 持久化，Host/SDK 子进程崩溃后也不存在原 promise，不能声称“审批后原地继续”。第一版应定义：

- 客户端断线：turn 继续，其他客户端可审批；
- gateway 断线但 owner 存活：重连 replay/snapshot 后继续；
- Agent Host/SDK crash：active turn 标为 `interrupted-by-host-crash`，completed transcript 可 resume，pending approval 作废并留下审计；用户从新 turn 继续。

若产品必须跨进程等待数小时，需要单独验证 SDK hook `defer` 工作流并设计“退出进程—外部审批—resume 新执行”的业务语义；这不是把 pending promise 写数据库即可获得的能力。

## 8. 服务端组件设计

```text
WSS Clients
    |
Protocol Server
  - auth / initialize / reconnect
  - logical clients / subscriptions / replay buffer
    |
Agent Host State Manager
  - root/session/chat reducers
  - serverSeq + snapshots + action broadcast
    |
Chat Registry / Sequencer
  - exact chat single owner
  - command dedupe / active turn / approval registry
    |
ClaudeAgent Adapter
  - provider backing mapping
  - live mapper / replay mapper
  - Query lifecycle / canUseTool / hooks
    |
Claude Agent SDK subprocess
  - transcript / resume / fork / tools

Side stores:
  SQLite (single host) -> Postgres (remote HA): overlay, command receipts, approval audit, owner lease
  SessionStore: shared SDK transcript mirror
  Redis/NATS (only when needed): gateway-to-owner routing and fan-out
```

### 单 Host 第一阶段

- 延续当前 TypeScript daemon/Fastify；新增 `ProtocolServerHandler`、`HostStateManager`、`ClaudeAgentAdapter`，而不是引入独立微服务。
- 一个 Host 可拥有多个 chat actor；一个 chat 一个 SDK Query，不同 chat 并发。
- bounded replay 存内存；`hostEpoch` 改变或超窗时从 SDK transcript + overlay 生成 snapshot。
- SQLite 继续存 overlay，可新增 command receipt 和 approval audit，但不复制完整 transcript。

### 多 Host 第二阶段

- 以 tenant/workspace 做 affinity shard；网关根据 chat owner 转发。
- owner lease 带 fencing token；所有 state write/SDK materialize 验证 fence。
- Claude `SessionStore` 解决 transcript 跨 Host，工作目录仍需持久卷/worktree sync，二者缺一不可。
- pub/sub 只传 action/wakeup；fresh snapshot 永远可从 owner/事实源得到。

## 9. Claude Agent SDK 接入判断

### 9.1 当前状态

CCVibe 已经使用 SDK：`package.json` 声明 `^0.3.178`，lock/node_modules 当前为 0.3.179；`claudeEngine.ts` 已使用 `query({ prompt: AsyncIterable, includePartialMessages: true, canUseTool })`。因此工作不是“要不要引入”，而是“建立稳定 provider adapter 并补齐 SDK 能力”。

截至本次调研，npm 当前版本页为 0.3.238。不要在协议重构中顺手无保护升级：

1. 把依赖从 caret 改为 exact version，防止部署解析到未经验证的新 CLI；
2. 先用当前 0.3.179 建立 raw fixture → domain action 的 contract tests；
3. 独立升级到当前 patch，跑历史 replay、streaming、permission、resume/fork、subagent fixtures；
4. 通过后再更新 exact pin。

### 9.2 应使用的 SDK 能力

- `listSessions()` / `getSessionMessages()`：替换自研 JSONL 读取为主路径；独立 replay mapper 生成 `Turn[]`。
- `SessionStore`：远程/多 Host transcript mirror；它是 SDK transcript storage，不是 CCVibe 的 multi-client action log。官方明确为 local-first、best-effort mirror，必须监控 `mirror_error`。
- streaming input：继续使用一个长生命周期 AsyncIterable；在 chat sequencer 中控制 enqueue，不让多客户端直接操作 Query。
- `includePartialMessages`：仅在 adapter 内累积 raw delta，映射为稳定 domain action。
- `canUseTool` + AbortSignal：桥接审批并在 SDK cancel 时清理；权限规则和 mode 由 SDK 先计算，Host 不重复实现整套规则。
- hooks：用于每次工具调用都必须执行的安全/审计逻辑；不能把必须执行的安全检查只放在 `canUseTool`，因为自动批准工具不会调用它。
- `startup()`/warm query：可在性能数据证明 cold start 是瓶颈后使用，不是多客户端正确性的前置项。

### 9.3 Adapter 必须隔离的变化

- `SDKMessage` union 和 Claude Code bundled binary 会随 SDK patch 演进；对外只暴露 CCVibe action version。
- live mapper 与 replay mapper 输入不同，不能硬复用同一分支；但二者输出必须经同一 `ChatState`/`Turn` 不变量验证。
- partial stream 只有主 session token delta；subagent attribution 应用完整消息的 `parent_tool_use_id`。
- `result` 后仍应消费 iterator 到正确生命周期边界；process crash 与正常/限制型 result 区分。

## 10. 借鉴 VS Code `claudeAgent` 的边界

### 直接借鉴

| 设计 | 参考证据 | CCVibe 用法 |
|---|---|---|
| 逻辑 client 跨 transport | `protocolServerHandler.ts:204-260` | `clientId` record + reconnect grace |
| 协议协商和初始订阅 | `protocolServerHandler.ts:573-661` | `initialize` |
| reconnect replay/fresh snapshot | `protocolServerHandler.ts:733-897` | 同 epoch replay，超窗 snapshot |
| snapshot/action 截点 | `agentHostStateManager.ts:643-705`、`agentSubscription.ts:138-207` | `fromSeq` 消除历史/实时竞态 |
| reducer 后统一广播 | `agentHostStateManager.ts:1538-1667` | 所有客户端收相同 action |
| origin 对账 | `common/.../actions.ts:125-145` | optimistic state 不重复 |
| SDK raw → AgentSignal | `claudeSdkMessageRouter.ts:68-93` | provider adapter |
| replay 独立 mapper | `claudeAgent.ts:1987-2017`、`claudeReplayMapper.ts:31-60` | transcript → `Turn[]` |
| 审批先注册再发信号 | `claudeAgentSession.ts:1259-1290`、`pendingRequestRegistry.ts:11-43` | 防止同步 auto-approve 丢响应 |
| chat/sdk backing 分离 | `claudeAgent.ts:1886-1892` | `chatUri -> sdkSessionId` opaque mapping |

### 不能照搬

- VS Code 的 replay 只有 1000 条进程内 action（`protocolServerHandler.ts:73-76,388-393`）；远程 CCVibe 必须有 `hostEpoch + snapshot fallback`，需要 HA 精确 replay 时再持久化 action journal。
- VS Code 是单 Agent Host 状态机，进程内 first-writer 已足够；多 Host 审批需要 owner fencing 或 DB CAS。
- VS Code 的 client tool ownership、reverse filesystem RPC 和 VS Code URI 体系不能直接成为 CCVibe 公网协议。
- 不复制其完整 `AgentService`；抽取逻辑 client、subscription、state reducer、provider adapter 四个概念即可。

## 11. 迁移顺序

### Phase A：协议与状态骨架（P0）

1. 定义 versioned domain actions、`ChatState` reducer、ID 模型。
2. 增加 `initialize/reconnect/subscribe`、`hostEpoch/serverSeq/fromSeq/origin`。
3. `SessionRunner` 外增加 chat sequencer；所有 send/control 经命令幂等层。
4. 服务端生成 prompt/turn action，Web/mac 客户端改成相同 reducer。
5. 先保留旧 `session/event` 作为 feature-flag 兼容通道，完成双端切换后删除。

### Phase B：历史与审批（P0）

1. 新增 `ClaudeLiveMapper` 与 `ClaudeReplayMapper`。
2. 实现原子 `chat.subscribe`，移除客户端 `load history -> attach` 两步竞态。
3. 把 permission/request 投影成 chat action；实现 eligible-many/first-wins/resolved broadcast。
4. 区分 `AskUserQuestion` 与 approval。

### Phase C：远程生产化（P1）

1. principal/tenant/session ACL、WSS、短期连接凭据。
2. heartbeat、frame/rate/backpressure、slow-client 恢复。
3. sandbox/worktree/资源/egress/credential proxy。
4. SDK exact pin、升级 canary、fixture 与 SessionStore conformance tests。

### Phase D：按实际负载扩容（P2）

1. tenant/workspace shard affinity；owner lease/fencing。
2. shared SessionStore + 工作目录持久化。
3. 多 gateway 路由/pubsub；必要时持久 action journal/outbox。

不要在 Phase A 前引入 NATS/Kafka。当前风险是协议不确定性，不是吞吐量。

## 12. 必须锁定的验收用例

1. A/B 同时打开 chat，A 发 prompt，B 收到同一 user message、turn ID、文本/tool delta 和完成态。
2. B 在第 N 个 delta 后断线；同 epoch 重连只补 `N+1...`，无重复字符/tool call。
3. snapshot 生成期间产生 action；客户端最终状态与服务端 reducer state 完全相同。
4. `send(commandId=X)` 因超时重试三次，只产生一个 prompt/turn/SDK input。
5. A/B 同时对同一 approval 做相反决定，恰好一个获胜；两端最终 prompt 消失且决议相同。
6. 创建会话的客户端断线，审批不自动 deny，另一个 eligible 客户端仍可处理。
7. replay 超窗或 hostEpoch 变化，客户端丢弃本地 confirmed state 并用 fresh snapshot 收敛。
8. B 对 live chat 调用 resume 不会终止 A 的 Query，而是 attach 到已有 owner。
9. 慢客户端超过高水位被断开，不阻塞 SDK/其他客户端；重连仍能收敛。
10. Host crash 后 completed transcript 可重建；active turn 明确显示 interrupted，不出现伪 completed。
11. live mapper 与 replay mapper 对同一 fixture 的 completed `Turn[]` 语义等价。
12. SDK patch 升级后，streaming、parallel tools、AskUserQuestion、permission suggestions、resume/fork、subagent fixtures 全绿。

## 13. 官方资料

- [Claude Agent SDK Hosting](https://code.claude.com/docs/en/agent-sdk/hosting)
- [Session management](https://code.claude.com/docs/en/agent-sdk/sessions)
- [SessionStore](https://code.claude.com/docs/en/agent-sdk/session-storage)
- [Streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- [Streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output)
- [Permissions](https://code.claude.com/docs/en/agent-sdk/permissions)
- [Approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input)
- [Agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)
- [Secure deployment](https://code.claude.com/docs/en/agent-sdk/secure-deployment)
- [npm package](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk?activeTab=versions)

