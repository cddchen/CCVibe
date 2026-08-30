# cc-agent-host 模型关系图与字段说明

> 基于 `repos/cc-agent-host/src` 当前实现整理。本文把 TypeScript 的 interface/type/class 按职责归类；同义别名不重复展开。Claude Agent SDK 自身的类型只在 Claude 边界使用，本文仅说明本项目对它们的适配模型。

## 1. 模型关系图

```text
┌───────────────────────── 客户端与协议边界 ─────────────────────────┐
│ JsonRpcRequest + *Params                                            │
│       │                                                              │
│       ▼                                                              │
│ ProtocolServerHandler                                                │
│   ├── ConnectionContext ────── ProtocolConnection                    │
│   ├── LogicalClientRegistry ── LogicalClientSnapshot                 │
│   ├── SubscriptionBuffer ──── SubscriptionToken                      │
│   └── ChatCommandActor                                               │
└────────────────────────────────┬───────────────────────────────────┘
                                 │
                     CommandReceipt / ChatAction
                                 │
┌────────────────────────── 聊天领域层 ──────────────────────────────┐
│ ChatState                                                            │
│   ├── Turn / ActiveTurn ── ResponsePart ── ToolCall                  │
│   ├── PendingApproval                                               │
│   └── PendingInputRequest                                           │
│ ChatAction ── ActionEnvelope ── HostStateManager ── ReplayBuffer    │
└────────────────────────────────┬───────────────────────────────────┘
                                 │
                           ClaudeChatActor
                                 │
┌──────────────────────── Claude 运行时边界 ─────────────────────────┐
│ ChatBacking (ChatUri ↔ sdkSessionId)                                 │
│       │                                                              │
│ ClaudeChatRegistry ── ClaudeChatRuntime ── ClaudeQueryRuntime        │
│       │                                      │                         │
│       └── ClaudeRuntimeSignal ── RuntimeActionBridge ── ChatAction   │
│                                                                      │
│ PendingInteractionRegistry ── approval/input request ↔ client resolve│
└─────────────────────────────────────────────────────────────────────┘

┌───────────────────────── 横切基础设施 ─────────────────────────────┐
│ Principal + ACL → protocol authorization                             │
│ TransportProtocolConnection + RateLimitState → Fastify/WSS           │
│ PersistedChatBacking / CommandReceipt / ApprovalAudit → SQLite       │
└─────────────────────────────────────────────────────────────────────┘
```

## 2. 阅读方式与边界

| 类别 | 含义 | 典型模型 |
| --- | --- | --- |
| 领域值 | 可写入状态、序列化或跨层传递的业务数据 | `ChatState`、`Turn`、`ChatAction` |
| 协议 DTO | WebSocket JSON-RPC 的请求/响应/通知数据 | `InitializeParams`、`ActionEnvelope` |
| 能力契约 | 一个组件需要另一个组件提供的行为 | `ChatCommandActor`、`ProtocolStateProvider` |
| 运行时状态 | 仅在进程内维持并发、连接、生命周期正确性 | `ConnectionContext`、`PendingTurn` |
| 基础设施数据 | 安全、网络和持久化的配置/行模型 | `Principal`、`RateLimitState`、`ChatBackingRow` |

## 3. 基础标识与资源模型

来源：`domain/ids.ts`、`domain/resources.ts`。

| 模型 | 字段/组成 | 用途 |
| --- | --- | --- |
| `Brand<T, Name>` | `T & { readonly __brand: Name }` | 编译期品牌工具；阻止将不同 ID 的 string 混用。 |
| `ClientId` | branded string | 稳定逻辑客户端身份，跨 WebSocket 重连保留。 |
| `ConnectionId` | branded string | 一条物理 transport 连接身份。 |
| `CommandId` | branded string | 命令幂等键，与 `ClientId` 共同唯一。 |
| `SessionUri` | branded string | `agent-session://{sessionId}`。 |
| `ChatUri` | branded string | `agent-chat://{sessionId}/{chatId}`；聊天状态和命令的频道。 |
| `RootUri` | branded string | 固定根资源 `agent-root://`。 |
| `TurnId` / `PartId` / `ToolCallId` | branded string | 分别标识轮次、回复块、工具调用。 |
| `ApprovalId` / `InputRequestId` | branded string | 分别标识待审批和待回答请求。 |
| `AgentResource` | `RootUri \| SessionUri \| ChatUri` | 所有协议资源的联合类型。 |
| `ParsedRootResource` | `kind: 'root'`, `uri` | 根 URI 校验后的结构化结果。 |
| `ParsedSessionResource` | `kind: 'session'`, `uri`, `sessionId` | session URI 的解析结果。 |
| `ParsedChatResource` | `kind: 'chat'`, `uri`, `sessionId`, `chatId` | chat URI 的解析结果。 |

URI segment 是不透明标识，不允许路径分隔符、查询/片段、`.`、`..` 或空白字符。

## 4. 聊天状态模型

来源：`domain/chat.ts`。

| 模型 | 字段级说明 | 用途 |
| --- | --- | --- |
| `ChatStatus` | `idle \| in_progress \| input_needed \| error` | Chat 的聚合状态。 |
| `TurnStatus` | `active \| complete \| failed \| interrupted` | 单轮对话的生命周期。 |
| `ToolCallStatus` | `started \| ready \| completed` | 工具输入与执行的生命周期。 |
| `ApprovalDecision` | `allow \| deny` | 用户工具决议。 |
| `JsonPrimitive` / `JsonValue` / `JsonObject` | 有限 number、string、boolean、null、数组/普通对象 | 可安全穿越协议边界的 JSON 值。 |
| `InputQuestionOption` | `label`, `description`, 可选 `preview` | 一个可供用户选择的答案。 |
| `InputQuestion` | `question`, `header`, `options`, `multiSelect` | AskUserQuestion 的 UI 投影。 |
| `InputAnswers` | `Record<question, answer>` | 用户作答；key 是问题原文。 |
| `ApprovalInput` | `Readonly<Record<string, unknown>>` | 工具输入的透明载体，领域 reducer 不解释它。 |
| `ApprovalSuggestion` | `JsonObject` | 展示给客户端的权限/编辑建议。 |
| `ApprovalMatchedAskRule` | `source`, `toolName`, 可选 `ruleContent` | 与审批匹配的规则来源。 |
| `ToolCall` | `id`, `name`, `input`, `status`, `startedAt`, 可选 `readyAt/completedAt/result/error` | 模型调用工具的完整状态。 |
| `ResponsePart` | `kind`、`id`；markdown/reasoning 有 `content`，tool_call 有 `toolCall` | 一个回复由多个可流式更新的块组成。 |
| `ActiveTurn` | `id`, `prompt`, 固定 `status: active`, `parts`, `startedAt` | 当前唯一进行中的轮次。 |
| `Turn` | `id`, `prompt`, `status`, `parts`, `startedAt`, 可选 `completedAt/error` | 历史或终态轮次。 |
| `PendingApproval` | `id`, `turnId`, 可选 `toolCallId`；工具、输入、标题、建议、请求标识、规则、`requestedAt` | 等待用户批准/拒绝的工具请求。 |
| `PendingInputRequest` | `id`, `turnId`, `questions`, `requestedAt` | 等待用户回答的结构化问题。 |
| `ChatState` | 可选 `resource`；`status`, `turns`, 可选 `activeTurn`, `pendingApprovals`, 可选 `pendingInputs`, `modifiedAt` | 客户端同步到的权威聊天聚合。 |
| `CreateChatStateInput` | `ChatState` 的可选初始化字段 | 创建空或测试状态。 |

## 5. 聊天动作模型

来源：`domain/actions.ts`。所有动作共有 `type` 和 `timestamp`，并通过 `ChatAction` 联合类型交给 reducer。

| 动作模型 | 专有字段 | 对 `ChatState` 的意义 |
| --- | --- | --- |
| `TurnStartedAction` | `turnId`, `prompt` | 创建 `activeTurn`。 |
| `ResponsePartAddedAction` | `turnId`, `part` | 增加 markdown 或 reasoning 内容块。 |
| `ResponsePartDeltaAction` | `turnId`, `partId`, `delta` | 追加流式文本。 |
| `ToolCallStartedAction` | `turnId`, `partId`, `toolCallId`, `name`, 可选 `input` | 创建工具调用块。 |
| `ToolCallInputDeltaAction` | `turnId`, `partId`, `toolCallId`, `delta` | 追加流式工具输入。 |
| `ToolCallReadyAction` | `turnId`, `partId`, `toolCallId` | 标记工具输入已准备。 |
| `ToolCallCompletedAction` | `turnId`, `partId`, `toolCallId`, 可选 `result/error` | 标记工具完成。 |
| `ApprovalRequestedAction` | `turnId`, `approvalId`, 工具信息、输入、建议、可选 SDK 标识/规则 | 创建待审批项。 |
| `ApprovalResolvedAction` | `turnId`, `approvalId`, `decision`，可选编辑/权限/消息/中断/分类 | 移除待审批并记录决议。 |
| `InputRequestedAction` | `turnId`, `inputId`, `questions` | 创建待输入项，chat 进入 `input_needed`。 |
| `InputResolvedAction` | `turnId`, `inputId`, 可选 `answers` | 解除对应待输入项。 |
| `TurnCompletedAction` | `turnId` | active turn 归档为 complete。 |
| `TurnFailedAction` | `turnId`, `error` | active turn 归档为 failed。 |
| `TurnInterruptedAction` | `turnId` | active turn 归档为 interrupted。 |
| `TurnsLoadedAction` | `turns` | 从 SDK history 批量水合历史。 |

`ChatActionType` 是全部动作 type 的联合；`ActionOf<T>` 依据 type 提取动作子类型。

## 6. 状态同步、重放与订阅模型

来源：`protocol/types.ts`、`protocol/replayBuffer.ts`、`protocol/subscriptionBuffer.ts`、`protocol/stateProvider.ts`。

| 模型 | 字段级说明 | 用途 |
| --- | --- | --- |
| `ActionOrigin` | `clientId`, `clientSeq`, `commandId` | 标记一条服务端 action 是哪个客户端命令引起的。 |
| `ActionEnvelope<A,R>` | `channel`, `action`, `serverSeq`, `serverTime`, 可选 `origin` | action 广播/重放的最小信封；`serverSeq` 全局单调递增。 |
| `StateSnapshot<S,R>` | `resource`, `state`, `fromSeq` | 某资源在动作序列切点的完整状态。 |
| `ReconnectResultCut` | `throughSeq`, `serverSeq`, 可选 `hostEpoch` | replay/snapshot 的一致性水位。 |
| `ReplayReconnectResult` | `type: 'replay'`, `actions`, `missing`，加 result cut | 客户端在本地状态上追加 action。 |
| `SnapshotReconnectResult` | `type: 'snapshot'`, `snapshots`, `missing`，加 result cut | 客户端用 snapshot 重新建立状态。 |
| `ReconnectResult` | replay 或 snapshot 联合 | 重连的统一结果。 |
| `ChatActionEnvelope` / `ChatStateSnapshot` / `ChatReconnectResult` | 针对 `ChatAction`、`ChatState`、`ChatUri` 的别名 | 减少聊天路径上的泛型噪声。 |
| `ReplayBufferOptions` | `maxActions` | 回放缓冲上限。 |
| `ReplayBuffer` | 内部维护按 seq 的 action | 保存有限历史，判断是否可以 replay。 |
| `SubscriptionToken` | `resource`, `id` | 建立订阅屏障的能力令牌。 |
| `SubscriptionReceiveResult` | `buffer`、`deliver` 或忽略结果 | action 到达某订阅时的路由决定。 |
| `SubscriptionBuffer` | 每资源的 pending/active 状态和暂存 actions | 确保先 snapshot，后发送 snapshot 之后的 action。 |
| `SnapshotBatch` | `snapshots`, `missing`, `throughSeq`, `serverSeq` | 批量 snapshot 的同一全局切点。 |
| `ProtocolStateProvider` | `serverSeq`; `snapshot`, `snapshots`, `reconnect`, `onAction` | 协议层读取/订阅状态的抽象端口。 |
| `ChatHostStateProvider` | `HostStateManager` + `hostEpoch` | 将 chat 状态适配到泛型协议 provider；root/session 当前返回 missing。 |

## 7. Host 与逻辑客户端模型

来源：`host/hostStateManager.ts`、`host/logicalClientRegistry.ts`。

| 模型 | 字段级说明 | 用途 |
| --- | --- | --- |
| `HostStateManagerDeps` | `now`, `replayCapacity`, 可选 `onListenerError` | 创建 host 状态仓库的依赖。 |
| `EnvelopeListener` | `(ChatActionEnvelope) => unknown` | 订阅状态动作的监听函数。 |
| `HostStateManager` | 内部 `states`, replay buffer, listeners, `serverSeq` | reducer 后的权威内存状态、动作序列与重放源。 |
| `ClientCapabilities` | `partialBlocks`, `approvalEdits` | 客户端 UI/协议能力声明。 |
| `LogicalClientSnapshot` | `clientId`, `activeConnectionId`, `subscriptions`, `maxAcceptedClientSeq`, `capabilities` | 一个逻辑客户端的只读观测模型。 |
| `LogicalClientRegistrationOptions` | 可选 `capabilities`, `subscriptions`, `maxAcceptedClientSeq` | 注册时可恢复的逻辑客户端数据。 |
| `LogicalClientRegistration` | options + `clientId`, `connectionId` | 连接绑定/接管输入。 |
| `LogicalClientRegistrationResult` | `client`, 可选 `replacedConnectionId` | 注册结果，供 handler fence 旧连接。 |
| `LogicalClientRegistry` | 内部 clients、active/fenced connection 映射 | 保持 client 身份跨 socket 连接，并防止旧连接回写。 |

## 8. 协议连接运行时模型

来源：`protocol/protocolServerHandler.ts`。

| 模型 | 字段级说明 | 用途 |
| --- | --- | --- |
| `ProtocolConnection` | `id`, 可选 `principal/authentication/auth`; `send`, `close`, `bufferedAmount` | 协议层所需的最小 transport 契约。 |
| `ProtocolAuthenticatedContext` | `authenticated: true`, `principal`, `scheme: 'Bearer'` | transport 完成 bearer 校验后的身份。 |
| `ProtocolAnonymousContext` | `authenticated: false`, `scheme: 'Anonymous'` | 明确的匿名连接上下文。 |
| `ProtocolAuthorizationOptions` | 可选 ACL；固定 principal 或 connection resolver；可选 `required` | Handler 的授权配置。 |
| `ProtocolServerHandlerOptions` | `hostEpoch`, versions, `stateProvider`, client registry, actor, resources, authorization | Handler 的组合根输入。 |
| `ReconnectRpcResult` | `ReconnectResult` + 必有 `hostEpoch` | RPC 对外的 reconnect 结果。 |
| `ConnectionContext`（私有） | `connection`, `id`, `principal`, `subscriptions`, active/known resources, held actions, request/send tail, clientId, initialized/fenced/failed/closed/outputHold | **一条物理连接的完整短生命周期状态。** |
| `SubscribeTransaction`（私有） | `resource`, token, `wasActive`, `wasKnown` | subscribe 失败后恢复连接状态。 |
| `ProtocolRequestError`（私有） | `descriptor`, `data` | 可安全映射为 JSON-RPC 失败的内部异常。 |
| `ProtocolServerHandler` | connections、ACL、actor、state provider 等 | 负责 JSON-RPC 生命周期、授权、订阅、重连、动作扇出。 |

`ConnectionContext` 与 `LogicalClientSnapshot` 的区别：前者属于 socket，后者属于 client identity。一个逻辑客户端重连时会产生新的 `ConnectionContext`，但复用同一个 `ClientId`。

## 9. JSON-RPC DTO 模型

来源：`protocol/jsonRpc.ts`、`protocol/schemas.ts`。

| 模型 | 字段级说明 | 用途 |
| --- | --- | --- |
| `JsonRpcRequest<P>` | `jsonrpc`, `id`, `method`, 可选 `params` | 客户端请求。 |
| `JsonRpcNotification<P>` | `jsonrpc`, `method`, 可选 `params` | 服务端单向通知。 |
| `JsonRpcSuccess<R>` | `jsonrpc`, `id`, `result` | 成功响应。 |
| `JsonRpcFailure` | `jsonrpc`, `id/null`, `error` | 错误响应。 |
| `JsonRpcError` | `code`, `message`, 可选 `data` | JSON-RPC 错误内容。 |
| `InitializeParams` | `channel`, `protocolVersions`, `clientId`, `clientInfo`, `capabilities`, `initialSubscriptions` | 建立逻辑客户端与首批订阅。 |
| `InitializeResult` | `protocolVersion`, `hostEpoch`, `serverSeq`, `snapshots`, `missing` | 初始化返回的同步基线。 |
| `SubscribeParams` / `SubscribeResult` | `channel` / `snapshot` | 新订阅及其状态基线。 |
| `UnsubscribeParams` / `UnsubscribeResult` | `channel` / `removed` | 取消订阅。 |
| `ReconnectParams` | `channel`, `clientId`, `hostEpoch`, `lastSeenServerSeq`, `subscriptions` | 恢复逻辑客户端和状态。 |
| `ClientAction` | `chat/send {prompt}` 或 `chat/interrupt {turnId}` | 客户端可发起的聊天动作。 |
| `DispatchActionParams` | `channel`, `clientSeq`, `commandId`, `action` | 带幂等与顺序信息的客户端命令。 |
| `DispatchActionResult` | `receipt` | send/interrupt 结果。 |
| `ResolveApprovalParams` | channel/client sequence/command/approval ID/decision；可选编辑、分类、消息、中断 | 审批决议 DTO。 |
| `ResolveInputParams` | channel/client sequence/command/input ID；可选 answers | 结构化输入决议 DTO。 |
| `InteractionResolutionResult` | `receipt` | 输入或审批决议回执。 |
| `SafeValidationIssue` | `path`, `code` | schema 校验失败时安全返回的错误细节。 |

## 10. 命令执行与交互契约模型

来源：`chat/chatCommandActor.ts`、`chat/commandDeduper.ts`、`chat/claudeChatActor.ts`、`chat/sequencer.ts`。

| 模型 | 字段级说明 | 用途 |
| --- | --- | --- |
| `ChatCommandAcceptedValue` | `acceptedAtSeq`, 可选 `turnId` | 成功接受聊天命令的最小值。 |
| `ChatCommandReceipt` | `CommandReceipt<ChatCommandAcceptedValue>` | `dispatchAction` 的统一回执。 |
| `ChatApprovalResolutionInput` | `approvalId`, `decision`，可选 input/permissions/classification/message/interrupt | actor 接收的审批领域输入。 |
| `ChatInputResolutionInput` | `inputId`, 可选 `answers` | actor 接收的输入领域输入。 |
| `ChatInteractionResolutionState` | `status: resolved/already_resolved`, `kind`, `id` | interaction resolver 的稳定状态。 |
| `ChatInteractionResolutionValue` | 上述字段 + `acceptedAtSeq` | 已被 host 提交后的决议值。 |
| `ChatInteractionResolutionReceipt` | `CommandReceipt<...>` | 交互命令的幂等回执。 |
| `ChatInteractionResolutionResult` | resolved/already-resolved/not-found/chat-mismatch/kind-mismatch/rejected 联合 | resolver 的完整返回面。 |
| `ChatInteractionResolver` | `resolveApproval`, `resolveInput` | actor 到 pending registry 的端口。 |
| `ChatCommandActor` | `dispatch`，可选 resolveApproval/resolveInput | **协议与实际聊天后端之间的统一命令端口。** |
| `CommandKey` | `clientId`, `commandId` | 命令幂等键。 |
| `AcceptedCommandReceipt<T>` | `status: accepted`, `value` | 通用成功命令结果。 |
| `RejectedCommandReceipt` | `status: rejected`, `code`, `message` | 通用安全拒绝结果。 |
| `CommandDeduper` | in-flight/completed receipt 缓存 | 相同命令重试不会重复触发副作用。 |
| `SequencerByKey<K>` | 每 key 一条 Promise tail | 同一 `ChatUri` 的命令严格串行。 |
| `ClaudeChatActor` | state manager、registry、deduper、sequencer、交互 resolver 等依赖 | 真实 Claude 后端的命令 actor。 |
| `FakeChatActor` | fake state / rejection 配置 | 测试后端。 |

## 11. Claude backing、registry 与 query runtime 模型

来源：`claude/chatBacking.ts`、`claude/claudeChatRegistry.ts`、`claude/runtimeTypes.ts`、`claude/claudeQueryRuntime.ts`。

| 模型 | 字段级说明 | 用途 |
| --- | --- | --- |
| `ChatBackingLifecycle` | `provisional \| materialized` | backing 是否尚未启动 runtime。 |
| `ChatBacking` | `chatUri`, `sdkSessionId`, `cwd`, `additionalDirectories`, `desiredConfig`, `lifecycle` | **Host chat 与 Claude SDK session 之间的稳定映射。** |
| `CreateChatBackingInput` | 除 lifecycle 外的 backing 字段 | 创建 provisional backing。 |
| `ClaudeRuntimeConfig` | `permissionMode`；可选 `model`, `effort` | 希望应用给 Claude query 的运行时配置。 |
| `ClaudeRuntimeQuery` | SDK query 的 `setModel/setPermissionMode/setEffort` 子集 | runtime config 的适配端口。 |
| `ClaudeRuntimeState` | `starting/running/closing/closed/crashed` | Query runtime 生命周期。 |
| `ClaudeTurnOutcome` | completed（result subtype）、failed（消息）、interrupted、runtime_closed | 一次 Claude turn 的最终结果。 |
| `ClaudeTurnHandle` | `turnId`, `sdkUuid`, `accepted: Promise`, `completed: Promise` | 发送 turn 后的异步句柄。 |
| `ClaudeRuntimeSignal` | init/message/result/terminal；含 generation、turn、SDK message 或错误 | Claude runtime 向 registry/bridge 上报的内部事件。 |
| `ClaudeChatRuntime` | `start/send/interrupt/applyRuntimeConfig/close/state` | registry 所依赖的 runtime 最小面。 |
| `ClaudeChatRuntimeSession` | `kind: new/resume`, `sessionId` | runtime 启动/恢复模式。 |
| `ClaudeChatRuntimeFactoryInput` | `backing`, `generation`, `session`, `onSignal`, 可选 `canUseTool` | 构建一个 chat runtime 的依赖。 |
| `ClaudeChatRegistryOptions` | `sequencer`, `runtimeFactory`, 可选 signal/materialization/permission hooks | registry 的组合配置。 |
| `ClaudeChatRegistrySnapshot` | `backing`, 可选 `runtimeState` | registry 的观测快照。 |
| `RuntimeEntry`（私有） | `chatUri`, `sdkSessionId`, `generation`, `runtime` | 已安装 runtime 的登记项。 |
| `RuntimeHolder`（私有） | 可选 `runtime` | 并发安装期间的 runtime 暂存位。 |
| `ClaudeChatRegistry` | backings、runtimes、各种 in-flight map、active turn IDs | 管理 materialize、rebind、release、dispose、shutdown。 |
| `ClaudeQueryRuntimeDeps` | generation/session ID、SDK service、options factory、UUID factory、signal 回调 | 创建一个长期 SDK Query runtime 的依赖。 |
| `ClaudeSendOptions` | 可选 `steering` | 普通发送或 steering 发送。 |
| `PendingTurn`（私有） | turn ID、SDK UUID、completion deferred、接受/中断/结果标记 | 对齐 host turn 与 SDK 消息/结果。 |
| `PendingConfigApplication`（私有） | config version、config、deferred、settled | 延迟/串行应用 runtime config。 |
| `ClaudeQueryRuntime` | input queue、pending turn maps、SDK query 生命周期 | 一个长期 `WarmQuery/Query` 及输入流的拥有者。 |

## 12. Claude 流映射与交互等待模型

来源：`claude/runtimeActionBridge.ts`、`claude/liveMapper.ts`、`interaction/pendingInteractionRegistry.ts`。

| 模型 | 字段级说明 | 用途 |
| --- | --- | --- |
| `ClaudeLiveMapperDiagnostic` | `kind`, 可选 type/detail | 映射异常或不支持消息的诊断。 |
| `ClaudeLiveMapperLike` | `map`, `finish`, `dispose` 等能力 | runtime action bridge 依赖的 mapper 契约。 |
| `ClaudeRuntimeActionBridgeOptions` | host state manager、时间、mapper factory、诊断 | signal→domain action 的桥接配置。 |
| `ClaudeRuntimeActionBridge` | 每 chat/turn 的 mapper 入口 | 将 raw SDK signal 投影成 `ChatAction`。 |
| `InteractionKind` | `approval \| input` | 待交互种类。 |
| `InteractionId` / `InteractionChat` / `InteractionTurn` | string 别名 | interaction 层的 ID。 |
| `RequestApprovalInput` | chat/turn、工具信息、SDK permission context、超时信息 | 登记工具审批。 |
| `RequestInputInput` | chat/turn、AskUserQuestion、超时信息 | 登记用户输入。 |
| `ResolveApprovalInput` | chat、approval ID、allow/deny、可选编辑/分类 | 解决审批。 |
| `ResolveInputInput` | chat、input ID、可选 answers | 解决输入。 |
| `PendingApprovalSnapshot` | approval 的可公开等待视图 | 诊断或管理 pending 项。 |
| `PendingInputSnapshot` | input 的可公开等待视图 | 同上。 |
| `PendingInteractionRegistry` | 活跃 entries、tombstone、timer | 将 SDK callback 变成等待客户端 RPC 的 Promise。 |
| `InteractionTimer` | `setTimeout`, `clearTimeout` | 交互超时抽象，可测试。 |
| `CanUseToolContext` | chat URI、当前 turn resolver 等 | 为 SDK `canUseTool` 绑定 host 上下文。 |

## 13. 身份、认证与 ACL 模型

来源：`security/identity.ts`、`security/auth.ts`、`security/acl.ts`。

| 模型 | 字段级说明 | 用途 |
| --- | --- | --- |
| `PrincipalId` / `TenantId` / `Capability` / `BearerToken` | branded string | 安全边界中的标识与凭据。 |
| `Principal` | `principalId`, `tenantId`, `capabilities` | 已认证主体。 |
| `PrincipalInput` | 与 Principal 同构的创建输入 | 规范化/校验 principal。 |
| `BuiltInCapability` | read/subscribe/send/configure/interrupt/approve/delete/admin 等 | 内置权限集合。 |
| `AuthorizationHeaders` / `AuthorizationInput` | `authorization` 或 header/string 输入 | bearer 提取输入。 |
| `BearerExtraction` | 成功含 token，失败含原因 | 解析 Authorization header。 |
| `AuthenticationResult` | 成功含 principal，失败是固定安全形状 | 认证处理结果。 |
| `ResourceAction` | 资源操作名称 | ACL 检查动作语义。 |
| `AuthorizationAction` | ResourceAction 或 Capability | 授权检查输入。 |
| `AclGrant` | 可选 tenant/principal，`capabilities` | 资源 ACL 中的一条 grant。 |
| `ResourceAcl` | `resource`, `tenantId`, 可选 tenant capabilities/grants | 一个资源的访问控制策略。 |
| `AccessControlList` | `resources: ResourceAcl[]` | 多资源 ACL 值对象。 |
| `AuthorizationResult` | `Allow` 或 `Deny { reason }` | 纯 ACL 计算结果。 |
| `AclAction` | replace/add/remove grant/resource 等动作 | 可重放的 ACL 变更词汇。 |

## 14. Transport、认证与限流模型

来源：`transport/auth.ts`、`transport/fastifyServer.ts`、`transport/limits.ts`。

| 模型 | 字段级说明 | 用途 |
| --- | --- | --- |
| `BearerVerificationContext` | `transport`, 可选 `remoteAddress` | 传给 token verifier 的安全元数据，不携带 header/token。 |
| `BearerTokenVerifier` | `(token, context) => principal/empty` | transport 的认证端口。 |
| `TransportAuthenticationContext` | authenticated principal 或 anonymous | transport 附加到 protocol connection 的认证状态。 |
| `AgentHostProtocolHandler` | `handle`, `onConnectionClosed`, 可选 `dispose` | Fastify/WSS 调用的协议处理端口。 |
| `AgentHostServerOptions` | handler、Fastify、心跳、背压、认证、帧/速率/订阅限制 | WSS host 配置。 |
| `TransportProtocolConnection` | ProtocolConnection + `authentication/auth/principal` | transport 适配后的协议连接。 |
| `WebSocketTransportSocket` | `readyState`, `bufferedAmount`, `send`, `close` | ws socket 最小抽象。 |
| `LiveTransport`（私有） | socket、connection、listener、heartbeat、queue/rate/subscription state | 一条活跃 WSS 连接的运行态。 |
| `IncomingFrameDecision` | allow/binary/too-large 等 | 入站帧检查结果。 |
| `QueueLimitDecision` | `allowed`, pending count | 入站 handler 队列限制。 |
| `RateLimitPolicy` | 窗口、最大消息/字节 | 连接级速率策略。 |
| `RateLimitState` | 当前窗口开始时间、消息数、字节数 | 限流计数状态。 |
| `RateLimitEvent` / `RateLimitDecision` | 本次帧消耗与是否允许 | 限流计算输入/输出。 |
| `BufferedAmountDecision` | `allowed`, buffered bytes | 慢客户端背压判断。 |
| `SubscriptionLimitState` / `SubscriptionLimitDecision` | 当前资源集合与允许/拒绝结果 | transport 层预防订阅数量滥用。 |

## 15. Overlay 持久化模型

来源：`persistence/types.ts`、`persistence/overlayRepository.ts`、`persistence/store.ts`。

| 模型 | 字段级说明 | 用途 |
| --- | --- | --- |
| `PersistedChatBacking` | backing 字段 + `title`, `archived`, `createdAt`, `updatedAt` | 可跨进程恢复的 chat 元数据。 |
| `ChatBackingRow` | snake_case SQLite 列：URI、SDK session、cwd、JSON 配置、lifecycle、title、archived、时间 | 数据库行模型。 |
| `CommandReceiptStatus` | `accepted \| rejected` | 持久化回执状态。 |
| `CommandReceiptPayload` | accepted/rejected JSON-safe 回执结构 | 持久化幂等结果。 |
| `PersistedCommandReceipt` | `clientId`, `commandId`, 可选 chat/seq，`receipt`, `createdAt` | 命令回执持久化记录。 |
| `CommandReceiptRow` | SQLite 列形式的回执 | 数据库存储模型。 |
| `ApprovalAuditStatus` | requested/resolved/expired/interrupted/cancelled | 审批审计生命周期。 |
| `ApprovalAuditEntry` | audit/chat/approval/turn IDs、status、可选决议/客户端/命令/时间 | 审计领域记录。 |
| `ApprovalAuditRow` | SQLite 列形式的审批记录 | 数据库存储模型。 |
| `SchemaMigrationRow` | `version`, `name`, `appliedAt` | 已应用迁移。 |
| `PersistenceMigration` | `version`, `name`, `up` | 一条 schema migration。 |
| `SqliteValue` / `SqliteParameters` | SQLite 可绑定值及参数数组 | 数据库底层值模型。 |
| `SqliteRunResult` | `changes`, 可选 `lastInsertRowid` | SQL 执行结果。 |
| `SqlitePort` | `run/get/all/transaction/close` | SQLite 最小端口。 |
| `PersistenceStore` | migrate、CRUD、transaction、close | SQLite 原子存储封装。 |
| `OverlayRepository` | chat backing、command receipt、approval audit 的领域仓储 | 提供 host 可选的 durable overlay。 |
| `ChatBackingWriteInput` / `DomainChatBackingWriteInput` | 原始 persisted 输入或从 `ChatBacking` 写入 | 保存 chat backing。 |
| `ChatBackingPatch` | lifecycle/title/archived 等局部字段 | 局部更新 backing。 |
| `ApprovalAuditFilter` | audit ID/chat URI/status 等查询条件 | 审计检索。 |
| `OverlayValidationError` / `OverlayConflictError` | field/message 或冲突 key | 仓储错误语义。 |

## 16. 组合根模型

来源：`claude/createClaudeAgentHost.ts`。

| 模型 | 字段级说明 | 用途 |
| --- | --- | --- |
| `ClaudeAgentHostOptions` | host epoch、两个 clock、SDK/runtime factory、tool callback、interaction 配置、overlay、server 和授权配置 | 组合完整 host 的依赖注入入口。 |
| `ClaudeAgentHost` | `server`, `hostStateManager`, `registry`, interaction/SDK/repository；create/load/dispose/history/shutdown 方法 | 应用层拿到的完整 host 实例。 |
| `ClaudeAgentHostCreateChatInput` | `chatUri`, 可选 `sdkSessionId`，cwd/目录/desired config，加 title/archived | 创建 chat/backing 的应用输入。 |
| `ClaudeAgentHostOverlayRepository` | save/list/delete/get/update backing，可选 close | host 需要的最小持久化端口。 |
| `ClaudeAgentHostRuntime` / `Factory` / `FactoryInput` | package-root 暴露的 SDK-free runtime 测试替代契约 | 支持离线测试和运行时替换。 |

## 17. 最关键的四个模型

| 模型 | 生命周期 | 解决的问题 |
| --- | --- | --- |
| `ChatState` | chat 存在期间 | 向客户端表达“当前聊天发生了什么”。 |
| `ConnectionContext` | 一条 WebSocket 存活期间 | 保证单连接请求/响应顺序、订阅一致性和安全退出。 |
| `ClaudeChatRegistry` | host 存活期间 | 保证 `ChatUri → sdkSessionId → runtime` 映射、懒启动与安全释放。 |
| `ChatCommandActor` | host 存活期间 | 将已授权的客户端意图变成可幂等、按 chat 串行执行的聊天动作。 |

