# Phase 0：Protocol/State Kernel 实施计划

> 状态：已完成（2026-08-24）  
> 目标包：`repos/cc-agent-host`  
> Phase 性质：纯 TypeScript 内核，不接 Claude SDK、不启动网络、不写数据库  
> 前置文档：[`cloud-server-roadmap.md`](./cloud-server-roadmap.md)

## 1. 目标

建立可独立验证的多客户端状态同步内核。Phase 0 完成后，应能用内存对象证明：

- 服务端和任意客户端使用同一 action 序列可得到完全相同的 `ChatState`。
- snapshot 与实时 action 的水位衔接不会丢失或重复状态。
- 同一 Host 的 action 使用全局 `serverSeq`，按 channel 过滤后的序号空洞合法。
- replay 窗口失效会明确退化到 fresh snapshot。
- 同一 chat 的命令顺序确定，重复 `commandId` 只产生一个副作用。

Phase 0 不实现 Claude SDK adapter、Fastify、WebSocket、Zod schema、SQLite 或 UI reducer。

## 2. 包与工具链

新建：

```text
repos/cc-agent-host/
  package.json
  package-lock.json
  tsconfig.json
  tsconfig.build.json
  vitest.config.ts
  src/
  test/
```

约束：

- Node `>=22.4.0`。
- TypeScript `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`。
- ESM。
- Vitest。
- `typecheck`、`test`、`build` 脚本必须存在。
- Phase 0 production dependencies 应为空；测试/构建只需 TypeScript、Vitest 和 Node types。

## 3. 文件级任务

## 3.1 `src/domain/ids.ts`

定义 branded string：

```ts
type Brand<T, Name extends string> = T & { readonly __brand: Name };

type ClientId = Brand<string, 'ClientId'>;
type CommandId = Brand<string, 'CommandId'>;
type SessionUri = Brand<string, 'SessionUri'>;
type ChatUri = Brand<string, 'ChatUri'>;
type TurnId = Brand<string, 'TurnId'>;
type PartId = Brand<string, 'PartId'>;
type ToolCallId = Brand<string, 'ToolCallId'>;
type ApprovalId = Brand<string, 'ApprovalId'>;
```

提供纯构造/解析函数。构造函数只验证输入并 branding，不生成随机 ID。测试使用显式 fixture ID。

URI 规范：

```text
agent-root://
agent-session://<opaque-id>
agent-chat://<session-id>/<chat-id>
```

要求：

- 拒绝空 segment、query、fragment、路径穿越和错误 scheme。
- 不从 `chatUri` 推导 `sdkSessionId`。
- 提供 `resourceKind()`，不依赖 Node `URL` 的环境差异也可接受；若使用 `URL`，输出必须通过测试固定。

## 3.2 `src/domain/chat.ts`

定义最小稳定领域模型：

```ts
type ChatStatus = 'idle' | 'in_progress' | 'input_needed' | 'error';
type TurnStatus = 'active' | 'complete' | 'failed' | 'interrupted';

type ResponsePart =
  | { kind: 'markdown'; id: PartId; content: string }
  | { kind: 'reasoning'; id: PartId; content: string }
  | { kind: 'tool_call'; id: PartId; toolCall: ToolCall };

interface Turn { ... }
interface ActiveTurn { ... }
interface ChatState { ... }
```

Phase 0 支持：

- user prompt；
- markdown/reasoning part + delta；
- tool start/input delta/ready/complete；
- turn complete/fail/interrupt；
- history bulk load；
- pending approval request/resolve。

所有时间戳均是 action 字段，不由 reducer 生成。

## 3.3 `src/domain/actions.ts`

使用 string literal discriminated union，协议名采用稳定的 namespace：

```text
chat/turnStarted
chat/responsePartAdded
chat/responsePartDelta
chat/toolCallStarted
chat/toolCallInputDelta
chat/toolCallReady
chat/toolCallCompleted
chat/approvalRequested
chat/approvalResolved
chat/turnCompleted
chat/turnFailed
chat/turnInterrupted
chat/turnsLoaded
```

要求：

- action 携带 reducer 所需全部确定性数据。
- 不包含 SDK 类型或 `unknown` raw payload。
- `chat/turnsLoaded` 是 history hydration 的 bulk action；它不伪造实时 token delta。
- tool input delta 在 Phase 0 可保存为字符串 partial JSON，不在 reducer 中解析不完整 JSON。

## 3.4 `src/domain/chatReducer.ts`

实现：

```ts
function createChatState(input: CreateChatStateInput): ChatState;
function chatReducer(state: ChatState, action: ChatAction): ChatState;
function reduceChatActions(initial: ChatState, actions: readonly ChatAction[]): ChatState;
```

规则：

- 纯函数、不可变更新。
- 不抛出由乱序/重复 action 引发的进程级异常；无效目标 action 应返回原 state。
- `turnStarted` 在已有 active turn 时必须采用明确策略：拒绝/no-op，不覆盖旧 turn。
- delta 只更新匹配 turn/part/tool。
- turn terminal action 将 active turn append 到 `turns` 并清理 pending approval。
- `turnsLoaded` 合并历史窗口时按 `turnId` 去重，并保留 live `activeTurn`。
- 每次状态变更的 `modifiedAt` 只能取 action 中的时间。

建议把数组/part/tool 更新拆成小型纯 helper，并直接单测关键 helper 行为。

## 3.5 `src/protocol/types.ts`

定义：

```ts
interface ActionOrigin {
  clientId: ClientId;
  clientSeq: number;
  commandId: CommandId;
}

interface ActionEnvelope<A = ChatAction> {
  channel: ChatUri;
  action: A;
  serverSeq: number;
  serverTime: string;
  origin?: ActionOrigin;
}

interface StateSnapshot<S = ChatState> {
  resource: ChatUri;
  state: S;
  fromSeq: number;
}

type ReconnectResult =
  | { type: 'replay'; actions: readonly ActionEnvelope[]; missing: readonly ChatUri[] }
  | { type: 'snapshot'; snapshots: readonly StateSnapshot[] };
```

`serverSeq` 仅要求正整数、全局单调；不定义 per-channel 连续性。

## 3.6 `src/protocol/replayBuffer.ts`

实现一个容量可配置的有界 replay buffer：

```ts
interface ReplayBufferOptions { readonly maxActions: number }

class ReplayBuffer {
  append(envelope: ActionEnvelope): void;
  replayAfter(lastSeenServerSeq: number, channels: ReadonlySet<ChatUri>): ...;
}
```

核心纯函数单独导出：

```ts
function canReplayFrom(oldestBufferedSeq: number | undefined, currentServerSeq: number, lastSeen: number): boolean;
function selectReplayActions(...): readonly ActionEnvelope[];
```

边界：若最早保留的是 seq 10，客户端 lastSeen=9，仍可从 10 完整 replay。空 buffer 且 lastSeen <= current seq 时不应凭空返回 action。

## 3.7 `src/host/hostStateManager.ts`

职责：

- 维护 `Map<ChatUri, ChatState>`。
- 维护 Host 全局 `serverSeq`。
- dispatch 顺序固定为：读取 state → reducer → 存 state → `++serverSeq` → 创建 envelope → append replay → emit。
- 仅当 reducer 产生状态变化时提交 envelope；no-op action 不消耗 seq。
- snapshot state 与 `fromSeq` 在同一同步调用中捕获。
- 提供 `reconnect(lastSeen, channels)`：窗口可用时 replay，否则给每个存在 channel 的 fresh snapshot，并报告 missing。

依赖注入：

```ts
interface HostStateManagerDeps {
  readonly now: () => string;
  readonly replayCapacity: number;
}
```

`now()` 只能在 orchestration shell 调用一次并写入 envelope，reducer 不调用。

## 3.8 `src/chat/sequencer.ts`

实现可复用 `SequencerByKey<K>`：

- 同 key FIFO 串行；
- 不同 key 可并行；
- 某任务 reject 后队列仍可继续；
- 空闲 key 自动清理，避免 Map 泄漏；
- 返回原任务结果/错误。

禁止使用轮询和全局锁。

## 3.9 `src/chat/commandDeduper.ts`

实现进程内 command single-flight + receipt cache：

```ts
interface CommandKey { clientId: ClientId; commandId: CommandId }

type CommandReceipt<T> =
  | { status: 'accepted'; value: T }
  | { status: 'rejected'; code: string; message: string };
```

要求：

- 同 key 并发调用共享一个 Promise。
- 完成后重复调用返回 canonical receipt，不再执行 effect。
- 容量可配置，使用确定性 insertion-order eviction。
- effect reject 时转换成由调用者提供的 canonical rejection，不能缓存原始可变 Error 对象。
- Phase 0 仅内存；Phase 6 替换为持久 receipt adapter 时保持接口。

## 3.10 `src/index.ts`

只导出稳定公共 API；不要导出测试 helper 或可变内部数据结构。

## 4. 测试矩阵

## 4.1 IDs/URI

- 合法 root/session/chat URI。
- 错 scheme、空 segment、query、fragment、`..` 被拒绝。
- chat identity 与 sdk identity 无关联字段。

## 4.2 Reducer determinism

- 相同 initial/action 序列执行两次，使用 deep equality 完全相同。
- reducer 源码行为不依赖测试时钟；不同外部时钟不影响 action reduction。
- prompt、markdown/reasoning delta、tool lifecycle、approval、turn terminal 全链路。
- 未知 part/tool/turn 的 delta 为 reference-equal no-op。
- `turnsLoaded` 去重且不覆盖 active turn。
- terminal action 清理属于该 turn 的 pending approval。

## 4.3 Host sequencing/snapshot

- 不同 channel 共享一个全局 seq。
- channel A 客户端看到 seq 1、3 是合法的，seq 2 可属于 B。
- no-op 不消耗 seq、不广播。
- snapshot `fromSeq=N` 后的 action 只需应用 `>N`。
- 模拟 snapshot 响应延迟：先收到 N+1，应用 snapshot 后补 N+1，结果等于 Host state。

## 4.4 Replay

- 容量内 replay 保序。
- oldest=10、lastSeen=9 可 replay。
- lastSeen 早于窗口时 fresh snapshot。
- 只返回订阅 channel 的 action，但保留原全局 seq 空洞。
- missing resource 明确返回。

## 4.5 Sequencer

- 同 key 严格 FIFO。
- 两个 key 可在第一个 key 未结束时同时开始。
- reject 不阻断后续任务。
- 完成后 key 清理。

## 4.6 Command dedupe

- 相同 key 三个并发调用 effect 仅执行一次。
- 完成后重试返回相同 receipt。
- 不同 client 的相同 commandId 不冲突。
- eviction 后旧 key 可重新执行。
- rejected receipt 稳定可序列化。

## 5. 验收命令

在 `repos/cc-agent-host` 中：

```bash
npm run typecheck
npm test
npm run build
```

全部必须退出码 0。测试不得访问网络、用户 home、Claude credentials 或真实 SDK。

## 6. 子代理任务拆分

为了避免并发写冲突，Phase 0 分三步委派，每一步完成并审核后再进入下一步：

1. **Bootstrap + Domain**：包配置、IDs、ChatState/actions/reducer 和单测。
2. **Protocol + Host**：envelope/snapshot/replay/HostStateManager 和单测。
3. **Concurrency primitives**：SequencerByKey、CommandDeduper、公共 exports 和单测。

每个 Haiku 子代理必须：

- 先读本计划与已存在代码。
- 只修改分配到的文件。
- 不恢复或删除工作树中的旧文件。
- 不提交、不 push。
- 运行自己范围内的测试并返回命令与原始结论。

## 7. 主代理审核清单

- [x] 无生产依赖和非 Phase 0 能力。
- [x] 领域层无 SDK/Node/Fastify/DB 依赖。
- [x] reducer 无时钟、随机数、环境读取和原地 mutation。
- [x] `serverSeq` 只在 Host commit 点分配。
- [x] replay 边界使用 `oldest - 1` 语义。
- [x] filtered stream 不检查 `serverSeq + 1`。
- [x] dedupe key 至少包含 client identity + command identity。
- [x] public API 不泄露内部可变集合。
- [x] typecheck/test/build 全绿。
- [x] `git diff` 不包含对 52 个预-existing 删除文件的恢复或额外修改。

## 8. 完成记录

最终实现包括：

- root/session/chat 通用的 resource-generic envelope、snapshot 与 replay 类型；
- chat-only `HostStateManager`、全局 `serverSeq`、snapshot/reconnect 和 listener 隔离；
- O(1) 淘汰的有界 replay 环形缓冲；
- 确定性 `ChatState` reducer、tool/approval/turn 状态转换和 history bulk hydration；
- `SequencerByKey` 与进程内 `CommandDeduper`；
- command accepted value 的 JSON-safe defensive snapshot；
- 领域、协议、Host、并发和编译期类型测试。

主代理于 2026-08-24 在 `repos/cc-agent-host` 中独立执行：

```text
npm run typecheck  PASS
npm test           PASS — 9 files, 105 tests
npm run build      PASS
npm audit          PASS — 0 vulnerabilities
```

Phase 0 没有接入网络、数据库或 Claude SDK；这些能力按 roadmap 从 Phase 1 开始逐层加入。
