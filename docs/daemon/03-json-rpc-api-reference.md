# cc-agent-daemon JSON-RPC 接口与事件契约

最后同步代码日期：2026-07-24。本版本不兼容旧 `session.*` API，也不会向客户端透传 Claude Agent SDK 原始消息。

## 契约代码指向

| 契约 | 代码文件 |
|---|---|
| JSON-RPC 和错误码 | [`src/rpc/protocol.ts`](../../repos/cc-agent-daemon/src/rpc/protocol.ts) |
| 所有公开参数 Zod 定义 | [`src/rpc/schemas.ts`](../../repos/cc-agent-daemon/src/rpc/schemas.ts) |
| RPC 方法实现与公开方法清单 | [`src/rpc/router.ts`](../../repos/cc-agent-daemon/src/rpc/router.ts) |
| Conversation、Message、Event 类型 | [`src/conversation/types.ts`](../../repos/cc-agent-daemon/src/conversation/types.ts) |
| SDK 原始消息到领域消息的投影 | [`src/conversation/projector.ts`](../../repos/cc-agent-daemon/src/conversation/projector.ts) |
| 历史 JSONL 到领域消息的映射 | [`src/conversation/messages.ts`](../../repos/cc-agent-daemon/src/conversation/messages.ts) |
| 会话打开、发送和配置编排 | [`src/conversation/service.ts`](../../repos/cc-agent-daemon/src/conversation/service.ts) |
| Runtime、事件序列与订阅重放 | [`src/session/runner.ts`](../../repos/cc-agent-daemon/src/session/runner.ts) |
| Web 协议类型与 reducer | [`daemonClient.ts`](../../repos/cc-agent-daemon/web/src/lib/daemonClient.ts)、[`messageBlocks.ts`](../../repos/cc-agent-daemon/web/src/lib/messageBlocks.ts) |

## 传输

- HTTP 与 Web 共用 daemon 端口，WebSocket 为 `/ws`。
- JSON-RPC 2.0，不支持 batch。
- token 可通过 `/ws?token=...` 或 `auth` 方法认证。
- 实时推送只有一个 notification method：`conversation/event`。

## Conversation API

### `conversation.open`

参数定义：[`conversationOpenParams`](../../repos/cc-agent-daemon/src/rpc/schemas.ts)

```ts
{ conversationId?: string; workspacePath: string; subscribe?: boolean }
```

打开或创建稳定 Conversation。只查看历史不会 spawn Claude Runtime；已有 Runtime 时返回 JSONL 历史与唯一 active turn 的合成快照，并在 `subscribe !== false` 时订阅后续事件。

返回 [`ConversationSnapshot`](../../repos/cc-agent-daemon/src/conversation/types.ts)：

```ts
{
  revision: number;
  conversation: { id: string; sdkSessionId?: string; workspacePath: string };
  runtime: { state: ConversationRuntimeState; runtimeId?: string };
  config: ResolvedConversationConfig;
  currentTurn?: { turnId: string; status: string };
  messages: ConversationMessage[];
}
```

`revision` 是快照生成时的最新事件序号。客户端不得用较旧快照覆盖已经处理的更大 `sequence` 事件。

### `conversation.get`

参数定义：[`conversationGetParams`](../../repos/cc-agent-daemon/src/rpc/schemas.ts)

```ts
{ conversationId: string }
```

返回完整快照，不创建、不订阅、不 spawn。快照的数据源与 `conversation.open` 相同：已完成历史来自 JSONL，daemon 只覆盖当前尚未收到 SDK `result` 的 active turn。

### `conversation.send`

参数定义：[`conversationSendParams`](../../repos/cc-agent-daemon/src/rpc/schemas.ts)

```ts
{ conversationId: string; content: string; clientMessageId?: string }
```

仅发送消息时创建或恢复 Claude Runtime。同一 Conversation 复用一个活跃 Runtime；并发首次发送的 Runtime 创建过程 single-flight。`clientMessageId` 用于幂等重试。

每个 Conversation 同时最多存在一个 active turn。前一 turn 尚未收到 SDK `result` 时再次发送会返回 JSON-RPC 错误 `-32603`，message 为 `conversation already has an active turn`；daemon 不维护待发送队列。前端应保持发送按钮禁用，或展示该错误后等待当前 turn 完成/中断。

返回：`{ accepted: true; conversationId: string; turnId: string }`。

## 历史、实时状态与多设备续接

数据归属规则：

1. Claude Agent SDK 的本地 JSONL 是所有已完成 turn 的唯一权威数据源。
2. daemon 的 [`SessionRunner`](../../repos/cc-agent-daemon/src/session/runner.ts) 每个 Conversation 最多保存一个尚未收到 `result` 的 active turn，包括用户消息、思考、工具调用、工具结果和流式 Agent 消息快照。
3. `conversation.open/get` 先读取 JSONL。若存在 active turn，则按 `turnId` 删除 JSONL 中该 turn 的所有消息，再整体加入 daemon 的 active-turn 快照；不能按 `message.id` 同时保留两份。
4. SDK 发出 `result` 后，daemon 先向所有订阅连接发布最终 `message_end`/`turn_status`，随后立即清理 active turn、实时消息和事件回放缓冲。此后重新打开会话只从 JSONL 读取该 turn，不等待或检查 JSONL 文件。
5. 若 `result` 恰好发生在服务端读取 JSONL 的过程中，服务端会重新读取一次 JSONL，避免返回“旧历史且 active turn 已清空”的中间快照。

多设备行为：第二台设备调用 `conversation.open({ subscribe: true })` 时，会获得包含当前 active turn 完整状态的 `ConversationSnapshot`，同时被加入同一 Runner 的订阅者集合；后续流式消息、权限请求与权限处理结果都会通过 `conversation/event` 推送给所有订阅设备。

### 配置与控制

| 方法 | 参数定义 | 参数 | 行为 |
|---|---|---|---|
| `conversation.setModel` | [`conversationSetModelParams`](../../repos/cc-agent-daemon/src/rpc/schemas.ts) | `{ conversationId, model }` | 持久化切换消息；活跃 Runtime 原地切换 |
| `conversation.setEffort` | [`conversationSetEffortParams`](../../repos/cc-agent-daemon/src/rpc/schemas.ts) | `{ conversationId, effort }` | 持久化切换消息；活跃 Runtime 原地应用 |
| `conversation.setPermissionMode` | [`conversationSetPermissionModeParams`](../../repos/cc-agent-daemon/src/rpc/schemas.ts) | `{ conversationId, mode }` | 持久化并原地应用权限模式 |
| `conversation.interrupt` | [`conversationIdParams`](../../repos/cc-agent-daemon/src/rpc/schemas.ts) | `{ conversationId }` | 中断当前 Turn，不关闭 Runtime |
| `conversation.detach` | [`conversationIdParams`](../../repos/cc-agent-daemon/src/rpc/schemas.ts) | `{ conversationId }` | 当前连接取消订阅 |
| `conversation.listActive` | 无 | `{}` | 返回活跃 Runtime 列表 |

模型优先级：Conversation 最新 `model_changed` > 历史最新 Agent model > Claude settings model > sonnet。具体解析见 [`src/conversation/config.ts`](../../repos/cc-agent-daemon/src/conversation/config.ts)。

Effort 优先级：Conversation 最新 `effort_changed` > Claude settings effort > `high`。

### `permission.respond`

参数定义：[`permissionRespondParams`](../../repos/cc-agent-daemon/src/rpc/schemas.ts)

```ts
{
  conversationId: string;
  requestId: string | number;
  behavior: "allow" | "deny";
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: Array<Record<string, unknown>>;
  message?: string;
}
```

权限请求按 Conversation 归属，客户端无需知道 Runtime 或 SDK Session 身份。

权限响应规则：

1. `permission_request` 广播给该 Conversation 当前的所有订阅连接。
2. 任意已订阅连接都可以调用 `permission.respond`；只打开历史但设置了 `subscribe: false` 的连接无权响应。
3. 服务端以 `requestId` 原子结算，第一个到达的有效响应生效并传回 Claude Agent SDK。
4. 同一请求的后续响应返回 `INVALID_PARAMS (-32602)`，message 为 `permission request already resolved`。
5. 未订阅该 Conversation 的连接响应时返回 `INVALID_PARAMS (-32602)`，message 为 `connection is not subscribed to the conversation`。
6. 首个响应生效后，服务端向全部订阅设备广播 `permission_resolved`，客户端据此关闭权限弹窗。某台设备断开不会自动拒绝仍可由其他设备处理的请求。

## Message 领域模型

完整定义：[`ConversationMessage`](../../repos/cc-agent-daemon/src/conversation/types.ts)。历史和实时流使用相同类型。

| `type` | 关键字段 | 说明 |
|---|---|---|
| `user_message` | `id, turnId, timestamp, status, content` | 用户消息 |
| `agent_message` | `id, turnId, timestamp, status, model?, content[], metrics?` | Agent 完整消息快照 |
| `tool_result` | `id, turnId, status, toolCallId, content, isError` | 工具结果 |
| `model_changed` | `family, modelId` | 模型配置消息 |
| `effort_changed` | `effort` | Effort 配置消息 |
| `permission_mode_changed` | `mode` | 权限模式消息 |
| `system_message` | `subtype?, content` | 可展示系统消息 |

Agent 内容块：

```ts
type AgentContent =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | {
      type: "tool_call";
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
      status: "building" | "pending" | "waiting_permission" | "running" | "completed" | "failed" | "denied";
    };
```

客户端不拼接 token delta。收到相同 `message.id` 的新快照时直接整体替换。

## 唯一实时通知：`conversation/event`

Envelope 定义：[`ConversationEventEnvelope`](../../repos/cc-agent-daemon/src/conversation/types.ts)

```ts
{
  version: 1;
  sequence: number;
  conversationId: string;
  sessionId: string;
  runtimeId: string;
  timestamp: string;
  event: ConversationEvent;
}
```

`conversationId` 是客户端业务主键；`sessionId/runtimeId` 仅用于诊断。`sequence` 在单个 Runtime 内递增，客户端应丢弃不大于已处理序号的事件。

消息生命周期事件：

```ts
{ type: "message_start" | "message_update" | "message_end"; message: ConversationMessage }
```

三个阶段都携带完整 Message：`start` 创建槽位，`update` 整体替换，`end` 提供最终快照。

其他事件：

| event.type | 字段 | 用途 |
|---|---|---|
| `conversation_status` | `status, error?` | 会话状态 |
| `runtime_status` | `status, error?` | Runtime 生命周期 |
| `runtime_initialized` | `sdkSessionId, model?, cwd?, slashCommands?` | SDK init 信息 |
| `turn_status` | `turnId, status, error?, resultSubtype?` | 单轮状态 |
| `permission_request` | `requestId, toolName, input, toolUseId?, ...` | 广播给全部 Conversation 订阅者 |
| `permission_resolved` | `requestId, behavior, reason?` | 首个权限响应生效后广播，所有客户端关闭对应权限 UI |

权限结算事件：

```ts
{
  type: "permission_resolved";
  requestId: string;
  behavior: "allow" | "deny";
  reason?: string;
}
```

`reason` 仅在拒绝、超时或 SDK 取消请求时可能存在。客户端应使用 `requestId` 关联本地权限 UI，不要依赖工具名称或 `toolUseId` 猜测请求是否已经处理。

## 其他公开接口

| 方法 | 说明 |
|---|---|
| `ping`、`auth`、`settings.get` | 基础能力 |
| `workspace.list/add/remove/checkTrust` | 工作区白名单；参数见 [`src/rpc/schemas.ts`](../../repos/cc-agent-daemon/src/rpc/schemas.ts) |
| `history.listAllLocal`、`history.listSessions` | 只返回本机历史摘要，不返回原始 SDK 消息 |

## 已移除接口

以下调用返回 `METHOD_NOT_FOUND (-32601)`：

- 全部 `session.*`。
- `history.loadSession`。
- `mcp.listServerStatus`。
- 旧通知 `session/event`、`session/status`、`runtime/status`、`turn/status`、`permission/request`。

## 客户端 reducer 规则

1. 用 `conversation.open` 的 `messages` 初始化，并记录 `revision`。
2. 只处理匹配 `conversationId` 且 `sequence` 更大的事件。
3. 消息事件按 `message.id` upsert，存在则整体替换。
4. 工具 UI 从 `tool_call.status` 和 `tool_result` 派生。
5. 权限状态必须按 `(conversationId, requestId)` 管理，不能只保存一个全局弹窗。SDK 可能并行产生多个权限请求；客户端应去重排队，一次展示一个，收到匹配的 `permission_resolved` 后移除该请求并继续展示下一条。
6. 客户端自己的 `permission.respond` 若因其他设备抢先处理而失败，不得清除队列中的其他请求，应等待/消费对应的 resolved 事件。
7. 客户端不导入 Claude Agent SDK 类型，不解析 `stream_event/assistant/result`。

Web 实现见 [`ChatNotifyContext.tsx`](../../repos/cc-agent-daemon/web/src/context/ChatNotifyContext.tsx) 和 [`ChatPage.tsx`](../../repos/cc-agent-daemon/web/src/pages/ChatPage.tsx)。
