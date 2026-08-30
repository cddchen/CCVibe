# cc-agent-host 架构与接口设计

> 基于当前实现（`repos/cc-agent-host`，协议版本 `1.0.0`）整理。本文描述已实现的行为，不把规划中的能力当作现有接口。

## 1. 定位与边界

`@ccvibe/agent-host` 是一个 Node.js（>= 22.4）服务端宿主：通过 Fastify 提供健康检查、通过 WebSocket 承载 JSON-RPC 2.0，并将 Claude Agent SDK 的会话与流式事件投影为独立于 SDK 的聊天状态和动作流。

- 网络入口：`GET /health`、`GET /ws`（WebSocket）。没有 REST 聊天接口。
- 客户端协议：JSON-RPC 2.0，当前协商版本为 `1.0.0`。
- 状态模型：服务端权威的 `ChatState`；所有变更以有序 `state/action` 通知广播。
- SDK 边界：只有 `claude/` 层接触 `@anthropic-ai/claude-agent-sdk`；协议、领域模型和客户端都不依赖 SDK 类型。
- 持久化边界：可选 SQLite overlay 仅保存会话 backing、命令回执和审批审计；聊天转录历史仍由 Claude SDK 的 session API 读取。

## 2. 总体架构

```text
Client
  │ HTTP GET /health
  └─ WebSocket /ws（Bearer 鉴权、帧/速率/背压限制）
       │ JSON-RPC 2.0
       ▼
ProtocolServerHandler
  ├─ 初始化、订阅、重连、ACL 与逻辑客户端所有权
  ├─ Snapshot / Replay + 订阅屏障，确保快照与动作流不会乱序
  └─ ChatCommandActor
       ├─ CommandDeduper（clientId + commandId 幂等）
       ├─ 每 ChatUri 串行化（SequencerByKey）
       └─ ClaudeChatRegistry
            ├─ provisional backing → 首次 send 时 materialize runtime
            ├─ ClaudeQueryRuntime / Claude Agent SDK
            └─ ClaudeRuntimeActionBridge / mapper
                 │ 标准 ChatAction
                 ▼
HostStateManager ── ReplayBuffer ── ProtocolServerHandler fan-out
       │
       ├─ ChatHostStateProvider（快照、重放适配）
       └─ PendingInteractionRegistry（工具审批、AskUserQuestion）

可选：OverlayRepository / SQLite
  chat_backings、command_receipts、approval_audit
```

### 2.1 核心职责

| 模块 | 职责 | 不负责 |
| --- | --- | --- |
| `transport/fastifyServer` | HTTP/WSS 生命周期、Bearer 验证、心跳、尺寸/速率/队列/慢客户端限制 | JSON-RPC 业务和 SDK 调用 |
| `protocol/ProtocolServerHandler` | RPC 校验、版本协商、订阅、重连、连接替换、ACL 及动作扇出 | 持有 Claude SDK 原始事件 |
| `host/HostStateManager` | reducer 后的权威状态、全局递增 `serverSeq`、回放缓冲 | 网络连接与持久化事务 |
| `chat/ClaudeChatActor` | 客户端命令幂等、同聊天串行化、发起/中断 turn | 直接解析 SDK 消息 |
| `claude/ClaudeChatRegistry` | backing/runtime 生命周期、首发延迟 materialize、runtime 重绑/释放 | 协议和授权 |
| `claude/*Mapper` | SDK 流式消息/历史消息映射为 `ChatAction` | 向客户端泄露 SDK 类型 |
| `interaction/PendingInteractionRegistry` | 将工具授权和结构化提问挂起，等待客户端 resolve 或超时 | 自动放行工具 |
| `persistence/*` | overlay 的事务读写、迁移、审计 | 复制 Claude transcript |

### 2.2 关键不变量

1. `createClaudeAgentHost()` 只装配对象和路由；不会 listen、启动 SDK query、读取凭据或访问网络。
2. `createChat()` 只创建 `provisional` backing；首个 `chat/send` 才启动/恢复 Claude runtime。
3. 每个已提交的状态变更都有单调递增的全局 `serverSeq`，并通过 reducer 形成不可变状态。
4. 同一 `clientId + commandId` 的命令回传同一回执；同一聊天的命令串行执行。
5. Snapshot/reconnect 期间通过订阅屏障暂存动作，先返回基线再按 `serverSeq` 发送，避免漏发和乱序。
6. 新连接使用同一 `clientId` 时，旧连接被 fenced，收到 `client/replaced` 后以 WebSocket `4001` 关闭。
7. 未配置 `canUseTool` 时，不会自动同意工具操作；请求会进入交互注册表等待客户端决议。

## 3. 生命周期与数据流

### 3.1 启动与关闭

```text
createClaudeAgentHost(options)
  → 组装 state / registry / actor / protocol handler / Fastify
  → host.server.listen(...)
  → 接受 /ws

host.shutdown()
  → 停止 transport、以 1001 关闭 WebSocket
  → dispose protocol handler
  → shutdown chat registry 并 drain runtime
  → 等待持久化队列、关闭 overlay repository
```

`shutdown()` 是 Promise 幂等的。应用必须显式调用 `host.server.listen()`；factory 不会自行监听端口。

### 3.2 发送一条消息

```text
dispatchAction(chat/send)
  → ACL + 已订阅校验
  → 去重、按 chatUri 串行
  → 提交 chat/turnStarted（得到 acceptedAtSeq）
  → materialize/复用 Claude runtime，提交 prompt
  → SDK 流事件映射为 response/tool/interaction/terminal ChatAction
  → HostStateManager 提交、递增 serverSeq
  → 已订阅且仍被授权的连接收到 state/action
```

`dispatchAction` 的成功仅表示命令已被 host 接受；模型完成由之后的 `chat/turnCompleted`、`chat/turnFailed` 或 `chat/turnInterrupted` 通知表示。

## 4. 资源、状态与消息信封

### 4.1 资源 URI

| 类型 | 格式 | 当前状态提供者支持 |
| --- | --- | --- |
| Root | `agent-root://` | 协议可声明，chat provider 返回 missing |
| Session | `agent-session://{sessionId}` | 协议可声明，chat provider 返回 missing |
| Chat | `agent-chat://{sessionId}/{chatId}` | 支持快照、订阅、命令、重连 |

URI segment 为不透明 ID，不能含空白、`/`、`?`、`#`、反斜杠、`.` 或 `..`。

### 4.2 状态快照

```json
{
  "resource": "agent-chat://session-1/chat-1",
  "fromSeq": 42,
  "state": {
    "resource": "agent-chat://session-1/chat-1",
    "status": "in_progress",
    "turns": [],
    "activeTurn": { "id": "turn-1", "prompt": "解释架构", "status": "active", "parts": [], "startedAt": "..." },
    "pendingApprovals": [],
    "pendingInputs": [],
    "modifiedAt": "..."
  }
}
```

`ChatState.status` 取值：`idle`、`in_progress`、`input_needed`、`error`。turn 终态为 `complete`、`failed` 或 `interrupted`。

### 4.3 动作通知

服务端通知格式固定为：

```json
{
  "jsonrpc": "2.0",
  "method": "state/action",
  "params": {
    "channel": "agent-chat://session-1/chat-1",
    "serverSeq": 43,
    "serverTime": "...",
    "origin": { "clientId": "client-a", "clientSeq": 7, "commandId": "cmd-7" },
    "action": { "type": "chat/responsePartDelta", "turnId": "turn-1", "partId": "part-1", "delta": "...", "timestamp": "..." }
  }
}
```

`origin` 仅在由客户端命令引起的动作上存在。`action.type` 当前包括：

- turn：`chat/turnStarted`、`chat/turnCompleted`、`chat/turnFailed`、`chat/turnInterrupted`、`chat/turnsLoaded`
- 文本/推理：`chat/responsePartAdded`、`chat/responsePartDelta`
- 工具：`chat/toolCallStarted`、`chat/toolCallInputDelta`、`chat/toolCallReady`、`chat/toolCallCompleted`
- 交互：`chat/approvalRequested`、`chat/approvalResolved`、`chat/inputRequested`、`chat/inputResolved`

客户端应当按 `serverSeq` 应用动作；重连后若 host epoch 未变化且回放仍可用，按 replay 应用，否则用 snapshot 覆盖本地状态。

## 5. 网络接口设计

### 5.1 HTTP

| 方法与路径 | 鉴权 | 响应 |
| --- | --- | --- |
| `GET /health` | 不要求 Bearer，但含 token 形 query 会被拒绝 | `200 {"status":"ok","protocolVersions":["1.0.0"]}` |
| `GET /ws` | 取决于 transport 配置；有 verifier 时默认 required | 升级为 WebSocket |

Bearer 只允许 `Authorization: Bearer <token>`；URL 中 `token`、`access_token`、`id_token`、`authorization`、`bearer` 等参数一律返回 `401 {"error":"authentication_failed"}`，避免凭据进入 URL/日志。

### 5.2 JSON-RPC 通用规则

- 每条客户端请求必须含 `jsonrpc: "2.0"`、字符串/有限数字 `id`、`method` 和对象 `params`。
- 客户端 notifications 不被接收；服务端以 notifications 推送状态。
- 顶层和参数对象采用严格 schema，未知字段会导致 `Invalid params`。
- 所有 ID 为不透明非空字符串；`clientSeq` 必须是正安全整数；时间戳是 ISO 字符串，由 host 生成。

### 5.3 RPC 方法

#### `initialize`

建立逻辑客户端、协商版本，并为 initial subscriptions 返回同一切点的快照。

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
  "channel":"agent-root://",
  "protocolVersions":["1.0.0"],
  "clientId":"client-a",
  "clientInfo":{"name":"cc-link","version":"1.0.0","platform":"android"},
  "capabilities":{"partialBlocks":true,"approvalEdits":true},
  "initialSubscriptions":["agent-chat://session-1/chat-1"]
}}
```

返回：`protocolVersion`、`hostEpoch`、`serverSeq`、`snapshots[]`、`missing[]`。成功后才可执行其余 RPC。

#### `subscribe` / `unsubscribe`

```json
{"jsonrpc":"2.0","id":2,"method":"subscribe","params":{"channel":"agent-chat://session-1/chat-1"}}
{"jsonrpc":"2.0","id":3,"method":"unsubscribe","params":{"channel":"agent-chat://session-1/chat-1"}}
```

`subscribe` 返回 `{ "snapshot": StateSnapshot }`；`unsubscribe` 返回 `{ "removed": true|false }`。订阅并不授予发送或审批权限。

#### `reconnect`

用已存在的 `clientId` 替换断开的连接，恢复其声明过的订阅。

```json
{"jsonrpc":"2.0","id":4,"method":"reconnect","params":{
  "channel":"agent-root://",
  "clientId":"client-a",
  "hostEpoch":"host-epoch-abc",
  "lastSeenServerSeq":42,
  "subscriptions":["agent-chat://session-1/chat-1"]
}}
```

若 `hostEpoch` 一致且 replay buffer 覆盖所需区间，结果为 `{type:"replay", actions, missing, throughSeq, serverSeq, hostEpoch}`；否则为 `{type:"snapshot", snapshots, missing, throughSeq, serverSeq, hostEpoch}`。`hostEpoch` 变化时客户端必须接受 snapshot 路径。

#### `dispatchAction`

```json
{"jsonrpc":"2.0","id":5,"method":"dispatchAction","params":{
  "channel":"agent-chat://session-1/chat-1",
  "clientSeq":7,
  "commandId":"cmd-7",
  "action":{"type":"chat/send","prompt":"请总结当前项目"}
}}
```

支持的 action：

| action | 字段 | 成功回执 |
| --- | --- | --- |
| `chat/send` | `prompt`，最大 256 KiB | `acceptedAtSeq`、`turnId` |
| `chat/interrupt` | `turnId` | `acceptedAtSeq` |

成功格式：`{ "receipt": { "status":"accepted", "value": { ... } } }`。拒绝格式为 `{ "receipt": { "status":"rejected", "code":"CHAT_BUSY", "message":"..." } }`；常见 code：`CHAT_BUSY`、`TURN_NOT_ACTIVE`、`RESOURCE_NOT_FOUND`、`INVALID_ACTION`、`INTERNAL_ERROR`。

#### `chat/resolveApproval`

回应先前 `chat/approvalRequested`。该命令需要对频道的 `approve` 权限。

```json
{"jsonrpc":"2.0","id":6,"method":"chat/resolveApproval","params":{
  "channel":"agent-chat://session-1/chat-1",
  "clientSeq":8,
  "commandId":"cmd-8",
  "approvalId":"approval-1",
  "decision":"allow",
  "updatedInput":{"path":"/tmp/example"},
  "decisionClassification":"user_temporary",
  "message":"允许本次操作"
}}
```

可选字段：`updatedPermissions`（JSON 对象数组）、`interrupt`。成功回执 value 为 `{status:"resolved"|"already_resolved",kind:"approval",id,acceptedAtSeq}`。

#### `chat/resolveInput`

回应 `chat/inputRequested`（Claude 的 AskUserQuestion）。同样需要 `approve` 权限。

```json
{"jsonrpc":"2.0","id":7,"method":"chat/resolveInput","params":{
  "channel":"agent-chat://session-1/chat-1",
  "clientSeq":9,
  "commandId":"cmd-9",
  "inputId":"input-1",
  "answers":{"请选择部署方式":"Docker"}
}}
```

`answers` 可省略，表示取消等待输入。成功回执 value 的 `kind` 为 `input`。

### 5.4 服务端通知

| method | params | 语义 |
| --- | --- | --- |
| `state/action` | `ActionEnvelope` | 已订阅频道的一条状态动作 |
| `client/replaced` | `{reason:"client connection replaced"}` | 同 `clientId` 的新连接接管，旧 socket 随后关闭 |

### 5.5 错误码

| code | 名称 | 含义 |
| ---: | --- | --- |
| -32700 | ParseError | 非法 JSON / 超尺寸协议帧 |
| -32600 | InvalidRequest | 不符合 JSON-RPC 信封 |
| -32601 | MethodNotFound | 未实现方法 |
| -32602 | InvalidParams | 参数不符合严格 schema；data 仅含安全 issues |
| -32603 | InternalError | 未分类的内部失败 |
| -32001 | NotInitialized | 未 initialize/reconnect 就调用后续方法 |
| -32002 | UnsupportedProtocol | 无可协商协议版本 |
| -32003 | ClientReplaced | 当前连接已被替换 |
| -32004 | ResourceNotFound | 资源或逻辑客户端不存在 |
| -32005 | CommandRejected | 命令层拒绝 |
| -32006 | InvalidHostEpoch | host epoch 无效 |
| -32007 | AuthorizationDenied | 未认证或 ACL 未授权；不泄露资源/策略原因 |

## 6. 安全与运行限制

| 控制项 | 默认/固定值 | 行为 |
| --- | ---: | --- |
| 单入站 JSON 文本帧 | 512 KiB | 超限 `1009` |
| prompt | 256 KiB | schema 拒绝 |
| 心跳 | 30 s / 90 s timeout | 超时 `1001` |
| 慢客户端输出高水位 | 1 MiB（2 × frame limit） | `1013` 断开 |
| 入站速率 | 120 条 / 60 s | 超限 `1008` |
| 待处理帧 | 128 | 超限 `1013` |
| 活跃订阅 | 128 | 超限 `1008` |
| 二进制 WebSocket 帧 | 不支持 | `1003` 断开 |

上述 transport 参数均可在 `AgentHostServerOptions` / `ClaudeAgentHostOptions` 中覆盖。ACL 同时要求 principal 自身 capability 和资源 ACL grant；`send`、`interrupt`、`subscribe`、`approve` 是独立能力。

## 7. 宿主程序集成 API（TypeScript）

```ts
import { createClaudeAgentHost } from '@ccvibe/agent-host';

const host = await createClaudeAgentHost({
  hostEpoch: crypto.randomUUID(),
  nowServer: () => new Date().toISOString(),
  nowAction: () => new Date().toISOString(),
  server: {
    bearerTokenVerifier: async (token) => verifyAndMapToPrincipal(token),
    fastifyOptions: { logger: true },
  },
});

host.createChat({
  chatUri: 'agent-chat://session-1/chat-1',
  cwd: '/absolute/project/path',
  desiredConfig: { permissionMode: 'default', model: '...', effort: 'medium' },
});

await host.server.listen({ host: '127.0.0.1', port: 8787 });
// 关闭时：await host.shutdown()
```

`ClaudeAgentHost` 暴露：

| API | 用途 |
| --- | --- |
| `createChat(input)` | 仅内存创建 provisional backing |
| `createChatPersisted(input)` | 先事务保存 overlay，再注册内存 chat |
| `loadPersistedChats()` | 恢复所有 backing，不启动 SDK runtime |
| `disposeChatPersisted(chatUri)` | 先删 durable overlay，再释放 runtime/内存状态 |
| `loadHistory(chatUri, timestamp?)` | 调用 SDK `getSessionMessages`，映射并提交 `turnsLoaded` |
| `shutdown()` | 有序且幂等地关闭 host |

`ChatBacking` 将 host chat identity 与 SDK session identity 明确分离：`chatUri`、`sdkSessionId`、绝对路径 `cwd`、可选 `additionalDirectories`、`desiredConfig`（`permissionMode`，可选 `model`/`effort`）和 lifecycle（`provisional`/`materialized`）。

## 8. 可选持久化模型

SQLite schema 当前版本为 3，含三张表：

- `chat_backings`：`chat_uri`、唯一 `sdk_session_id`、cwd、目录、runtime 配置、lifecycle、title、archived、时间戳。
- `command_receipts`：以 `(client_id, command_id)` 为主键保存幂等回执。
- `approval_audit`：请求/解决/超时/中断/取消等审批审计记录。

持久化适配器须满足 `ClaudeAgentHostOverlayRepository`。它不是协议 API；产品层可利用这些方法构建会话列表、归档和审计接口。当前 host 不保存动作流或完整 transcript，历史加载必须走 SDK session messages。

## 9. 客户端实现建议

1. 连接后先 `initialize`；收到 `snapshots` 后保存 `hostEpoch`、`serverSeq`。
2. 只在成功订阅的 chat 上发送命令；为每个客户端维持递增 `clientSeq`，并为每个命令生成稳定 `commandId`，以便网络重试。
3. 先处理 RPC 响应，再按 `serverSeq` 处理 `state/action`；不要把 send 的 accepted 回执误认为回答已经完成。
4. 断线后以相同 `clientId` 调用 `reconnect`；对 replay 追加，对 snapshot 覆盖。
5. 收到 `approvalRequested` / `inputRequested` 时显示 UI，并使用返回的 ID 仅决议一次；可能得到 `already_resolved`。
6. 收到 `client/replaced` 或 socket `4001` 时停止旧连接的所有写入与 UI 状态推进。

