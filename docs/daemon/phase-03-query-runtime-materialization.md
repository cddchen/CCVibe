# Phase 3：Query Runtime、Provisional 与 Materialization 实施计划

> 状态：已完成（2026-08-25）  
> 目标包：`repos/cc-agent-host`  
> 前置：Phase 0–2 已完成  
> 本阶段使用 fake SDK Query 验证，不访问模型网络或用户凭据

## 1. 目标

实现单 Host 内多个 Claude chat 的运行时骨架：

```text
ClaudeChatRegistry
  -> ChatBacking (provisional)
  -> materialize single-flight
  -> ClaudeQueryRuntime
       -> one WarmQuery
       -> one Query
       -> one long-lived SDKUserMessage AsyncIterable
       -> one consumer loop
```

核心不变量：

- create chat 不启动 SDK；首次 send 才 materialize。
- 同一 chat/sdk session 的首次并发请求只执行一次 startup/query。
- 不同 chat 可并行 materialize。
- `result` 结束 turn，不结束 Query/runtime。
- iterator done/throw 结束 runtime，不反向把已完成 turn 改为失败。
- input acceptance 与 turn completion 是两个不同 Promise。
- interrupt 直接调用 live `Query.interrupt()`，不排在 `send.completed` 后。
- rebind 前必须 await 旧 runtime drain；异步 continuation 用 generation fencing。
- CCVibe `TurnId` 不伪装成 SDK UUID；运行时显式维护映射。

## 2. Phase 范围

本阶段不做：

- SDK raw message → `ChatAction` 的完整 live mapper（Phase 4）。
- transcript replay mapper（Phase 4）。
- approval/input bridge（Phase 5）。
- SQLite backing persistence（Phase 6）。

Phase 3 通过 typed runtime signals 向上层报告 init/result/tail/runtime terminal；Phase 4 再把其他 SDK stream message 映射成 UI action。

## 3. 文件级任务

## 3.1 `src/claude/asyncInputQueue.ts`

通用但仅在 Claude layer 使用：

```ts
class AsyncInputQueue<T> implements AsyncIterable<T> {
  push(value: T): Promise<void>; // 返回 accepted：consumer yield 该值时 resolve
  close(): void;
  fail(error: unknown): void;
}
```

规则：

- 单 consumer；第二个 iterator 明确拒绝。
- FIFO。
- 空队列 `next()` park；push 立即唤醒。
- `accepted` 在 iterator 返回 `{done:false,value}` 时 resolve。
- close：已缓冲值先 drain，随后 done；parked consumer 被唤醒。
- fail：立即 reject parked/future next，并 reject 尚未 accepted 的 push；已 accepted 不回滚。
- push after close/fail reject。
- close/fail 幂等，首个 terminal 原因获胜。
- 不通过替换 deferred 的方式 rebind；每个 runtime 新建一个 queue。

## 3.2 `src/claude/runtimeTypes.ts`

稳定 CCVibe runtime types，不向 root 导出 raw SDK message：

```ts
type ClaudeRuntimeState = 'starting' | 'running' | 'closing' | 'closed' | 'crashed';

type ClaudeTurnOutcome =
  | { status: 'completed'; resultSubtype: string }
  | { status: 'failed'; resultSubtype?: string; message: string }
  | { status: 'interrupted' }
  | { status: 'runtime_closed'; message: string };

interface ClaudeTurnHandle {
  turnId: TurnId;
  sdkUuid: UUID;
  accepted: Promise<void>;
  completed: Promise<ClaudeTurnOutcome>;
}

type ClaudeRuntimeSignal =
  | { type: 'runtime/init'; generation: number; sdkSessionId: string; capabilities?: ... }
  | { type: 'runtime/message'; generation: number; turnId?: TurnId; phase: 'active'|'tail'|'unmatched'; message: SDKMessage }
  | { type: 'turn/result'; generation: number; turnId: TurnId; outcome: ClaudeTurnOutcome }
  | { type: 'runtime/terminal'; generation: number; state: 'closed'|'crashed'; error?: unknown };
```

`ClaudeRuntimeSignal` 是 Claude layer internal 类型，不从 package root 导出，因为包含 `SDKMessage`。

## 3.3 `src/claude/userMessage.ts`

```ts
function createClaudeUserMessage(input): SDKUserMessage
```

- 注入 `sdkUuid: UUID`，不内部随机生成。
- `message: { role:'user', content:text }`。
- `parent_tool_use_id: null`。
- `session_id: sdkSessionId`。
- 可选 steering 使用 `priority:'now'`；普通 send 不设置 priority。
- runtime validation prompt non-empty、sdk session/UUID non-empty。
- 返回 official `SDKUserMessage`，使用 `satisfies`。

## 3.4 `src/claude/claudeQueryRuntime.ts`

构造输入：

```ts
interface ClaudeQueryRuntimeDeps {
  sdkService: Pick<ClaudeAgentSdkService,'startup'>;
  buildOptions: () => Options;
  createSdkUuid: () => UUID;
  onSignal: (signal: ClaudeRuntimeSignal) => void | Promise<void>;
}
```

API：

```ts
start(): Promise<void>;
send(turnId: TurnId, text: string): ClaudeTurnHandle;
interrupt(turnId: TurnId): Promise<SDKControlInterruptResponse | undefined>;
applyRuntimeConfig(config: ClaudeRuntimeConfig): Promise<void>;
close(): Promise<void>;
```

状态与行为：

- start single-flight；调用 `startup({options})` 一次。
- `WarmQuery.query(queue)` 一次，随后启动 consumer。
- send 可在 starting 时入队，但 completion 只能由 result/terminal settle。
- pending 维护 `sdkUuid -> entry` 和 SDK-visible FIFO。
- result success：优先 `user_message_uuid` 精确匹配，缺失时 FIFO fallback。
- result error：FIFO fallback；分类为 failed，但 Query 保持 running。
- late post-result message 使用 lastCompletedTurnId + phase tail；下一 turn 实际 accepted 前不得错误关联到它。
- iterator done：runtime closed，只 fail pending turns；completed turns不变。
- iterator throw：runtime crashed，fail pending turns。
- signal listener failure隔离并可注入 reporter，不让 consumer crash。
- interrupt 不 await completed；验证 target active/pending；直接调用 `query.interrupt()`。
- close Promise-idempotent：queue close、abort、settle pending、`query.return()`、`warmQuery[Symbol.asyncDispose]()`；所有 cleanup best effort，但最终 state 确定。
- close/start race：late startup result 必须立即 dispose，不能安装新 Query。
- generation 由构造传入；signals 携带 generation。

## 3.5 `src/claude/chatBacking.ts`

```ts
interface ChatBacking {
  chatUri: ChatUri;
  sdkSessionId: string;
  cwd: string;
  additionalDirectories: readonly string[];
  desiredConfig: ClaudeRuntimeConfig;
  lifecycle: 'provisional' | 'materialized';
}
```

纯 constructors/updates：

- create backing defensive copy。
- bind materialized 返回新 object。
- config update 返回新 object。
- 不从 URI 推导 SDK ID。

## 3.6 `src/claude/claudeChatRegistry.ts`

维护：

```text
Map<ChatUri, ChatBacking>
Map<sdkSessionId, RuntimeEntry>
Map<sdkSessionId, materializePromise>
SequencerByKey<ChatUri>
```

API：

- `createProvisional(input)`：只保存 backing，不 startup。
- `materialize(chatUri)`：single-flight，同 SDK ID 最多一个 runtime。
- `send(chatUri, turnId, text)`：sequencer 内 ensure materialized，再 runtime.send。
- `interrupt(chatUri, turnId)`：不排在 send completion 后；读取 live runtime 直接 control。
- `setRuntimeConfig(chatUri, config)`：更新 desired；live runtime 应用。
- `rebind(chatUri)`：同 key single-flight，await old close 后以 resume options 建新 runtime，重放 desired config。
- `release(chatUri)`：close runtime，保留 backing/provisional identity。
- `disposeChat(chatUri)`：close + 删除 backing。
- `shutdown()`：Promise-idempotent，阻止新操作，await 所有 materialize/close，清 maps。

故障：

- materialize 失败清除 flight，可重试；不把 backing 删除。
- late materialize 在 shutdown 后完成时立即 close。
- stale generation terminal signal不得删除新 runtime。

## 4. 子代理拆分

1. **Input queue + user message + runtime types**。
2. **ClaudeQueryRuntime + fake WarmQuery/Query tests**。
3. **ChatBacking + ClaudeChatRegistry + materialization/rebind tests**。

## 5. 验收矩阵

至少覆盖：

- queue FIFO/park/accepted/close/fail/single-consumer。
- official SDKUserMessage shape 与 UUID separation。
- startup/query 各一次，多轮复用。
- 两 turn 两 result 独立 completion。
- result 后 late message，Query 继续。
- result 后 iterator done 不改 completed outcome。
- pending 时 done/throw 失败 pending。
- error result 后可继续第二 turn。
- interrupt 直接、可继续 send、close race exactly-once。
- runtime config replay 使用 Phase 2 helper。
- create provisional 0 startup。
- concurrent first send 1 materialization。
- different chats parallel。
- materialization failure retry。
- release 保留 backing；dispose 删除；shutdown 幂等。

## 6. 验收命令

```bash
npm run typecheck
npm test
npm run build
npm audit
```

要求：

- Phase 0–2 的 198 项测试继续通过。
- 所有新增 runtime 测试使用 official types 约束的 fake，不启动真实 subprocess。
- 业务/protocol 层仍无 SDK raw import。
- 不修改 legacy 删除文件。

## 7. 完成记录

最终实现包括：

- single-consumer、显式 close/fail、accepted handoff 的 `AsyncInputQueue`；
- 注入 SDK UUID 的 official `SDKUserMessage` builder；
- one WarmQuery / one Query / long-lived input 的 `ClaudeQueryRuntime`；
- result 精确 UUID + FIFO fallback、late tail、iterator terminal 和 safe error classification；
- interrupt receipt/result tombstone correlation，避免误完成下一 turn；
- runtime config replay、generation fencing、awaitable idempotent close；
- immutable `ChatBacking`、provisional create 与 explicit chatUri/sdkSessionId mapping；
- install/start 分离的 materialization single-flight、startup-time send/interrupt；
- release/resume、rebind old-close-before-new-start、stale terminal fencing；
- 覆盖所有 flight 的 shutdown loop-until-dry。

主代理于 2026-08-25 独立执行：

```text
npm run typecheck  PASS
npm test           PASS — 26 files, 249 tests
npm run build      PASS
npm audit          PASS — 0 vulnerabilities
```

全部 runtime 测试使用 official SDK 类型约束的 fake，没有启动 Claude subprocess、访问模型网络或读取用户凭据。
