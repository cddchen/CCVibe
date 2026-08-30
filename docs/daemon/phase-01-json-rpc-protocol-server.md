# Phase 1：Versioned JSON-RPC Protocol Server 实施计划

> 状态：已完成（2026-08-24）  
> 目标包：`repos/cc-agent-host`  
> 前置：Phase 0 Protocol/State Kernel 已完成  
> 本阶段不接 Claude SDK、不写数据库、不实现生产认证

## 1. 目标

在 Phase 0 的纯状态内核上建立第一个可运行的多客户端协议垂直切片：

```text
Fastify / WebSocket connection
  -> JSON-RPC parse + Zod validation
  -> ProtocolServerHandler
  -> LogicalClientRegistry + subscriptions
  -> typed ClientCommandDispatcher
  -> in-memory FakeChatActor
  -> HostStateManager
  -> state/action notifications
```

Phase 1 必须证明：

- 连接身份与逻辑客户端身份分离；同一 `clientId` 可跨 transport 重连。
- 初始化协商协议版本并原子返回初始 snapshot。
- subscribe 总是建立 snapshot baseline；reconnect 只恢复已声明的订阅。
- 同 epoch 且 replay 可覆盖时补 action，epoch 变化或超窗时返回 fresh snapshot。
- 客户端命令通过 `clientId + clientSeq + commandId` 对账和去重。
- 客户端不能发送 `chat/responsePartDelta` 等服务端领域 action；只能发送 typed client command。
- transport 断开不拥有或销毁 chat state。

## 2. 协议版本与命名

首个协议版本：

```text
1.0.0
```

Phase 1 支持的方法：

```text
initialize
subscribe
unsubscribe
reconnect
dispatchAction
```

服务端通知：

```text
state/action
client/replaced
```

`dispatchAction` 保留架构文档中的名称，但其中 `action` 是客户端 intent，不是 `ChatAction`：

```ts
type ClientAction =
  | {
      type: 'chat/send';
      prompt: string;
    }
  | {
      type: 'chat/interrupt';
      turnId: TurnId;
    };
```

Phase 1 fake actor：

- `chat/send`：服务端分配 `turnId` 和 action timestamp，dispatch `chat/turnStarted`。
- `chat/interrupt`：若目标 active turn 匹配，dispatch `chat/turnInterrupted`。
- 不模拟 assistant delta；Claude live mapper 属于后续 Phase。

## 3. JSON-RPC 合同

## 3.1 基础 envelope

```ts
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number;
  result: unknown;
}

interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}
```

请求必须有 id；Phase 1 不接受 fire-and-forget client notification，避免命令没有回执。

稳定错误码：

| code | 名称 | 语义 |
|---:|---|---|
| -32700 | ParseError | JSON 不合法 |
| -32600 | InvalidRequest | envelope 不合法 |
| -32601 | MethodNotFound | 未知 method |
| -32602 | InvalidParams | method params 校验失败 |
| -32603 | InternalError | 未分类内部错误，返回前脱敏 |
| -32001 | NotInitialized | initialize 前调用其他方法 |
| -32002 | UnsupportedProtocol | 无共同协议版本 |
| -32003 | ClientReplaced | 此 connection 已被同 clientId 的新 connection 取代 |
| -32004 | ResourceNotFound | resource 不存在 |
| -32005 | CommandRejected | canonical command rejection |
| -32006 | InvalidHostEpoch | epoch 不匹配，需要 fresh snapshot |

Zod error 只返回稳定 issue path/code，不返回 stack、源码或敏感输入全文。

## 3.2 initialize

```ts
interface InitializeParams {
  channel: RootUri;
  protocolVersions: readonly string[];
  clientId: ClientId;
  clientInfo: {
    name: string;
    version: string;
    platform: string;
  };
  capabilities: {
    partialBlocks: boolean;
    approvalEdits: boolean;
  };
  initialSubscriptions: readonly AgentResource[];
}

interface InitializeResult {
  protocolVersion: '1.0.0';
  hostEpoch: string;
  serverSeq: number;
  snapshots: readonly StateSnapshot[];
  missing: readonly AgentResource[];
}
```

规则：

- `channel` 固定 `agent-root://`。
- 服务端按自身优先顺序选择第一个双方支持版本，不做字符串大小比较。
- 一个 connection 只允许成功 initialize 一次。
- registry 绑定 `connectionId -> clientId`。
- 同一 `clientId` 的新 connection 原子成为 active transport；旧 connection 收到 `client/replaced` 后关闭或拒绝后续请求。
- 初始 subscriptions 去重并替换逻辑客户端的订阅集合。
- 每个存在 resource 返回同一 `fromSeq` cut 的 snapshot；不存在 resource 放入 `missing`。

Phase 1 只有 chat state provider；root/session URI 可通过共享协议类型表达，但未注册时返回 missing，不能伪造空 state。

## 3.3 subscribe / unsubscribe

```ts
interface SubscribeParams {
  channel: AgentResource;
}

interface SubscribeResult {
  snapshot: StateSnapshot;
}

interface UnsubscribeParams {
  channel: AgentResource;
}

interface UnsubscribeResult {
  removed: boolean;
}
```

- subscribe 必须先获得 snapshot baseline，再把该 resource 视为可接收 action。
- 在单线程同步 handler 中先捕获 snapshot cut、登记 subscription；snapshot 返回前到达 action 时 connection 必须 buffer，并只 flush `serverSeq > snapshot.fromSeq`。
- 重复 subscribe 幂等，仍可返回 fresh snapshot。
- unsubscribe 只影响 transport fanout，不释放 chat actor/runtime。

## 3.4 reconnect

```ts
interface ReconnectParams {
  channel: RootUri;
  clientId: ClientId;
  hostEpoch: string;
  lastSeenServerSeq: number;
  subscriptions: readonly AgentResource[];
}
```

结果复用 generic `ReconnectResult`，并返回当前 `hostEpoch`。

规则：

- reconnect 也会绑定/替换 active connection。
- `subscriptions` 是客户端断线前已持有 baseline 的集合，不是新增订阅入口。
- hostEpoch 不同时无条件 fresh snapshot。
- 同 epoch 使用 Phase 0 replay 判断；missing 显式返回。
- 客户端不得把 filtered global seq 空洞当丢包。

## 3.5 dispatchAction

```ts
interface DispatchActionParams {
  channel: ChatUri;
  clientSeq: number;
  commandId: CommandId;
  action: ClientAction;
}

interface DispatchActionResult {
  receipt: CommandReceipt<{
    acceptedAtSeq: number;
    turnId?: TurnId;
  }>;
}
```

规则：

- 当前 connection 必须是该 `clientId` active transport。
- channel 必须已订阅。
- `clientSeq` 为正安全整数；每个 logical client 记录最大已接受 seq。
- `(clientId, commandId)` 交给 `CommandDeduper`；重试返回 canonical receipt。
- `clientSeq` 主要用于 optimistic reconciliation，不单独作为 command effect identity。
- fake actor 的所有 chat command 通过 `SequencerByKey<ChatUri>`。
- `origin` 原样写入最终 `ActionEnvelope`。
- command receipt 必须在 action commit 后返回。

## 4. 文件级任务

## 4.1 `src/protocol/jsonRpc.ts`

- JSON-RPC 基础类型、error constants。
- 纯函数 `parseJsonRpcMessage(text)`。
- 纯函数 `successResponse/errorResponse/notification`。
- 解析错误不得抛到 WebSocket callback。

## 4.2 `src/protocol/schemas.ts`

- Zod schemas 与 inferred types。
- 复用 domain URI/ID parser，通过 transform/refine 构造 branded types。
- 对字符串长度、数组长度、prompt 大小设置 Phase 1 上限。
- unknown keys 使用 strict object；协议升级必须显式增加字段。
- 对外导出的业务类型从 schema 推导，避免 schema/interface 双写漂移。

建议上限：

```text
clientId / commandId / opaque IDs: 256 bytes
clientInfo fields: 128 bytes
subscriptions: 128
prompt: 256 KiB
incoming JSON frame: 512 KiB
```

## 4.3 `src/protocol/stateProvider.ts`

定义 transport-independent 窄接口：

```ts
interface ProtocolStateProvider {
  readonly serverSeq: number;
  snapshot(resource: AgentResource): StateSnapshot | undefined;
  snapshots(resources: readonly AgentResource[]): SnapshotBatch;
  reconnect(lastSeen: number, resources: ReadonlySet<AgentResource>): ReconnectResult;
  onAction(listener: (envelope: ActionEnvelope) => void): Disposable;
}
```

实现 `ChatHostStateProvider` adapter，包装当前 `HostStateManager`。root/session 未注册时返回 missing。

## 4.4 `src/host/logicalClientRegistry.ts`

状态：

```ts
interface LogicalClient {
  clientId: ClientId;
  activeConnectionId: ConnectionId;
  subscriptions: Set<AgentResource>;
  maxAcceptedClientSeq: number;
  capabilities: ...;
}
```

要求：

- `ConnectionId` 增加 branded type与 parser。
- register/replace/close 使用同步原子方法。
- 旧 connection 被 replace 后不能更新 registry。
- transport disconnect 仅移除 active connection binding；保留 logical client 及 subscriptions 供 grace/reconnect。Phase 1 可配置 deterministic grace scheduler/fake clock，不使用裸全局 timer；若不实现清理，则明确 registry 是进程生命周期缓存。
- 对外只返回 readonly snapshot，不泄露可变 Set/Map。

## 4.5 `src/protocol/subscriptionBuffer.ts`

每 connection/resource 的 snapshot-before-action barrier：

```ts
begin(resource): token
receive(envelope): deliver | buffer | ignore
commit(token, fromSeq): readonly ActionEnvelope[]
cancel(token): void
```

纯状态机规则：

- begin 后相关 action buffer。
- commit 只 flush `serverSeq > fromSeq`，保持顺序。
- stale token 不能提交新一轮 subscription。
- 已 active subscription 直接 deliver。
- unsubscribe/cancel 清理 buffer。

## 4.6 `src/chat/fakeChatActor.ts`

仅用于 Phase 1 垂直切片，不冒充 Claude adapter：

- 注入 `HostStateManager`、`SequencerByKey`、`CommandDeduper`、`nowAction()`、`allocateTurnId()`。
- `dispatch(clientId, clientSeq, commandId, channel, ClientAction)`。
- chat/send：验证无 active turn，生成 turn/action，然后 commit。
- chat/interrupt：验证 active turn ID，commit interrupt。
- canonical rejection code：`CHAT_BUSY`、`TURN_NOT_ACTIVE`、`RESOURCE_NOT_FOUND`。
- 所有时间和 ID 由注入依赖生成。

## 4.7 `src/protocol/protocolServerHandler.ts`

transport-independent request handler：

```ts
handle(connection: ProtocolConnection, raw: string): Promise<void>
onConnectionClosed(connectionId): void
```

`ProtocolConnection`：

```ts
interface ProtocolConnection {
  readonly id: ConnectionId;
  send(text: string): void | Promise<void>;
  close(code: number, reason: string): void;
  readonly bufferedAmount: number;
}
```

职责：

- JSON parse、schema validation、method routing。
- initialize gate、active connection fencing。
- snapshot barrier、subscriptions、action fanout。
- 统一响应/错误脱敏。
- connection send failure 不回滚 Host commit；由 reconnect 收敛。

## 4.8 `src/transport/fastifyServer.ts`

实现可复用 factory，不在 import 时自动 listen：

```ts
function createAgentHostServer(options): Promise<FastifyInstance>
```

- `GET /health` 返回 `{ status: 'ok', protocolVersions: ['1.0.0'] }`。
- `/ws` 使用 `@fastify/websocket`。
- `maxPayload = 512 KiB`。
- 文本帧 only；binary close 1003。
- 每 connection 分配注入/默认 UUID-based `ConnectionId`，随机生成只存在 transport shell。
- ping/pong heartbeat；timer 由 server lifecycle 创建并在 close 清理。
- `bufferedAmount` 超过高水位时关闭 slow client；不阻塞 Host。
- Phase 1 默认只允许调用方显式 listen，不提供公网默认监听。

## 4.9 `src/index.ts`

导出稳定 public factories/types；不导出 Zod 内部 schema helper、测试 fake clock 或可变 registry internals。

## 5. 测试矩阵

## 5.1 JSON-RPC/schema

- parse error / invalid request / unknown method / invalid params。
- duplicate keys/unknown params 被拒绝。
- 所有长度、整数、URI 边界。
- 不返回 stack 或原始 prompt。

## 5.2 initialize/client replacement

- 选择共同版本；无共同版本拒绝。
- initialize 前调用其他方法拒绝。
- 同 connection 二次 initialize 拒绝。
- 相同 clientId 的 connection B 替代 A；A 收 notification 并不能再发命令。
- 不同 clientId 不互相替代。

## 5.3 subscription baseline

- snapshot 生成后、响应返回前 action 到达；commit 后只 flush `>fromSeq`。
- 重复 subscribe 不重复 action。
- unsubscribe 后不 fanout。
- missing resource 返回 ResourceNotFound/missing，不创建空 state。

## 5.4 reconnect

- 同 epoch replay。
- replay 超窗 snapshot。
- epoch 变化 snapshot。
- global seq filtered gaps 合法。
- 只恢复参数声明的既有 subscriptions。

## 5.5 commands

- A send 后 A/B 得到同一 prompt、turnId、seq。
- 同 commandId 三次并发/重试只产生一个 turn。
- 同 clientSeq 不同 commandId 的策略明确测试（允许但记录 max；commandId 才是 effect identity）。
- 未订阅 channel 拒绝。
- busy chat 拒绝且无 serverSeq 消耗。
- interrupt 正确 turn 成功，错误 turn canonical rejection。
- receipt 与 envelope origin 一致。

## 5.6 Fastify/WSS

- health endpoint。
- 实际 WebSocket initialize/subscribe/dispatch/action round trip。
- 超大 frame、binary frame、slow-client close policy。
- server close 清理 heartbeat 和 connection registry。

## 6. 子代理拆分

按顺序委派，避免并发写冲突：

1. **Protocol contracts**：JSON-RPC、Zod schemas、ConnectionId、subscription buffer、纯函数测试。
2. **Handler + fake actor**：state provider、logical clients、command dispatcher、ProtocolServerHandler、集成测试。
3. **Fastify/WSS shell**：server factory、health/ws、frame/heartbeat/backpressure 测试。

每批必须只修改分配文件和必要 exports/dependencies，不提交、不 push。

## 7. 验收门槛

```bash
npm run typecheck
npm test
npm run build
npm audit
```

要求：

- 全部退出码 0；
- 旧 105 项 Phase 0 测试继续通过；
- 默认测试不访问外网、不读取用户 home/credentials；
- 实际 WebSocket 测试只绑定 ephemeral loopback port；
- 不恢复或修改 legacy 删除文件；
- 客户端协议中不存在 SDK raw type 或任意 `ChatAction` 写入口。

## 8. 完成记录

最终实现包括：

- strict JSON-RPC 2.0 parser、稳定错误码、重复 key 检测与脱敏参数错误；
- Zod 推导的 initialize/subscribe/unsubscribe/reconnect/dispatchAction 合同；
- logical `clientId` 与 `connectionId` 分离、transport replacement/fencing；
- snapshot-before-action barrier、subscription/reconnect replay 与 same-cut snapshot；
- typed `chat/send` / `chat/interrupt` fake actor、per-chat sequencing 和 command receipts；
- Fastify + `@fastify/websocket` server factory、health、frame 限制、backpressure、heartbeat 和 shutdown；
- binary/oversize/slow-client/handler failure 的 detach-before-close 与 exactly-once cleanup；
- 包入口 `main/types/exports` 和实际 loopback WebSocket 集成测试。

主代理于 2026-08-24 在 `repos/cc-agent-host` 中独立执行：

```text
npm run typecheck  PASS
npm test           PASS — 17 files, 172 tests
npm run build      PASS
npm audit          PASS — 0 vulnerabilities
package self-import PASS
```

根仓库目前没有 npm workspace manifest，因此从仓库根目录按 package name 解析仍需后续 monorepo root wiring；包目录内 self-reference 和构建产物入口已验证。Phase 1 仍未接入 Claude SDK、数据库或生产认证。
