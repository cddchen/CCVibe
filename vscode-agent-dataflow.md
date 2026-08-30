我先沿着目标 mapper 向上、向下追踪：SDK 事件输入、领域 Action 定义、reducer/ChatState，以及 snapshot、`serverSeq`、重连补偿协议。最后会把现状证据、推荐数据流、关键 TypeScript 实现和参数定义合在一起说明。

从首轮检索看，这套思路并不是待设计的空架构：仓库已有 `ActionEnvelope.serverSeq`、共享 reducer、任务事件重放，以及客户端订阅快照机制。接下来重点是确认它们是否已经形成“同一条有序状态机链路”，以及断线窗口失效时目前究竟在哪里降级为 snapshot。

协议层已经明确吻合你描述的四段语义：`Snapshot { state, fromSeq }`、在线 `ActionEnvelope`、重连 `replay`、超过 1000 条环形窗口后 `snapshot`。这里有一个需要特别指出的边界：`serverSeq` 是宿主进程级全局序号，不是每个 chat 独立序号；客户端按订阅 URI 过滤，但续传游标必须仍使用全局值。现在继续补齐 Claude SDK 历史与实时 mapper 的具体映射表。

这里还发现一个会影响“多个客户端完全相同 ChatState”的关键事实：`chatReducer` 目前在部分 action 上调用客户端本地 `Date.now()` 生成 `modifiedAt`。因此 action 顺序相同虽能保证主体 UI 结构一致，却不能严格保证状态对象逐字段相等；要做到强收敛，时间戳必须进入 Action，由服务端一次生成、所有 reducer 原样消费。我会把它作为现状缺口和具体改法写进结论，而不是把“已有协议”误判成“已经严格一致”。

## 结论

你描述的架构在当前代码中已经实现了大约 80%：

```text
Claude SDKMessage
  → Claude provider mapper
  → AgentSignal(action)
  → AgentSideEffects 路由
  → AgentHostStateManager
  → chatReducer 得到权威 ChatState
  → ActionEnvelope(serverSeq)
  → 多客户端使用同一个 chatReducer
```

订阅和重连协议也已经具备：

```text
首次订阅 → Snapshot(state, fromSeq)
在线更新 → ActionEnvelope(serverSeq)
短时重连 → Replay(actions > lastSeenServerSeq)
重放窗口失效 → Snapshot[]
```

但要严格达到“多个客户端完全相同的 UI 状态”，当前还有两个关键缺口：

1. Claude 历史恢复没有经过领域 Action/reducer，而是 `SessionMessage[] → Turn[] → 直接写入 ChatState`。
2. `chatReducer` 内部多处调用客户端本地 `Date.now()`，同一批 Action 在不同客户端可能产生不同的 `modifiedAt`。

因此推荐保留现有协议，只补齐：

- 历史恢复通过现有 `ChatTurnsLoaded` Action 进入 reducer。
- 时间戳由服务端写入 Action，reducer 不再读取本地时钟。
- 在线 envelope 增加重复序号防御；因为 `serverSeq` 是全局序号且按订阅过滤，不能要求严格 `+1` 连续。
- replay capacity 从硬编码参数化。

---

## 1. 当前实际数据流

### 1.1 Claude 实时消息

入口是 `claudeMapSessionEvents.ts`：

```ts
export function mapSDKMessageToAgentSignals(
	message: SDKMessage,
	chat: URI,
	turnId: string,
	state: ClaudeMapperState,
	logService: ILogService,
	registry: SubagentRegistry,
	clientToolOwner?: (toolName: string) => string | undefined,
	turnDuration?: number,
): AgentSignal[]
```

参数含义：

| 参数 | 含义 |
|---|---|
| `message` | Claude Agent SDK 的原始实时消息 |
| `chat` | Action 所属的 chat channel URI |
| `turnId` | 当前领域层 turn ID |
| `state` | 每个 Claude session 独占的跨消息 mapper 状态 |
| `logService` | 协议漂移、未知 tool result 等诊断日志 |
| `registry` | subagent spawn/父子工具调用关联 |
| `clientToolOwner` | client tool 名称到客户端 ID 的解析器 |
| `turnDuration` | provider 测量的轮次耗时，单位毫秒 |

路由规则：

```ts
switch (message.type) {
	case 'stream_event':
		return mapStreamEvent(/* ... */);

	case 'result':
		return mapResult(/* ... */);

	case 'assistant':
		return mapAssistantCanonical(/* ... */);

	case 'user':
		return mapUserMessage(/* ... */);

	case 'system':
		return mapSubagentSystemMessage(/* ... */);

	default:
		return [];
}
```

Mapper 并不把 SDK 消息透传到 workbench，而是只输出 `AgentSignal`。其中领域状态更新使用：

```ts
{
	kind: 'action',
	resource: chat,
	action: ChatAction
}
```

### 1.2 SDK 事件到领域 Action 的映射

核心映射位于 `claudeMapSessionEvents.ts`：

| SDK 消息/事件 | 领域 Action | 关键参数 |
|---|---|---|
| `message_start` | 无 Action | 重置 message 级 mapper 状态 |
| `content_block_start:text` | `chat/responsePart` | `turnId`、Markdown part、`partId` |
| `content_block_start:thinking` | `chat/responsePart` | Reasoning part |
| `text_delta` | `chat/delta` | `turnId`、`partId`、`content` |
| `thinking_delta` | `chat/reasoning` | `turnId`、`partId`、`content` |
| `content_block_start:tool_use` | `chat/toolCallStart` | `toolCallId`、`toolName`、`displayName`、`contributor` |
| `input_json_delta` | `chat/toolCallDelta` | `toolCallId`、JSON partial input |
| `content_block_stop` | `chat/toolCallReady` | 最终 `toolInput`、`invocationMessage`、`confirmed` |
| `user.tool_result` | `chat/toolCallComplete` | `result.success/content/error` |
| `result:success` | `chat/usage` | token usage、model |
| `result:error` | `chat/error` | `duration`、`errorType`、message |
| 最终队列排空 | `chat/turnComplete` | `turnId`、`duration` |

例如文本块：

```ts
{
	kind: 'action',
	resource: chat,
	action: {
		type: ActionType.ChatResponsePart,
		turnId,
		part: {
			kind: ResponsePartKind.Markdown,
			id: makeContentBlockPartId(turnId, state, event.index, logService),
			content: '',
		},
	},
}
```

后续 delta：

```ts
{
	kind: 'action',
	resource: chat,
	action: {
		type: ActionType.ChatDelta,
		turnId,
		partId,
		content: event.delta.text,
	},
}
```

这里强制满足：

```text
ChatResponsePart → ChatDelta
ChatToolCallStart → ChatToolCallDelta → ChatToolCallReady → ChatToolCallComplete
```

这很重要，因为 reducer 对不存在的 part/tool call 更新会直接 no-op。

### 1.3 Mapper 跨消息状态

`ClaudeMapperState` 主要解决 SDK 的两种 ID 作用域：

- `content_block.index`：只在单条 assistant message 内有效。
- `tool_use_id`：跨 assistant/user 消息关联 `tool_use → tool_result`。

关键状态可以抽象成：

```ts
class ClaudeMapperState {
	// message-local: index → tool
	private readonly activeToolBlocks =
		new Map<number, {
			toolUseId: string;
			toolName: string;
			isClientTool: boolean;
		}>();

	// cross-message: toolUseId → turn/name/input/status
	readonly toolCalls = new ClaudeToolCallRegistry();

	private currentMessageId?: string;

	// file edit 的 after-snapshot 结果
	private readonly completedFileEdits =
		new Map<string, ToolResultFileEditContent>();
}
```

`partId` 使用：

```ts
`${turnId}#${messageId}#${contentBlockIndex}`
```

而不是简单的 `${turnId}#${index}`。原因是一次协议 turn 可以包含多条 SDK assistant message，每条消息的 `index` 都会从 0 开始。

---

## 2. Action 如何变成权威 ChatState

Mapper 输出的 signal 经 `agentSideEffects.ts` 路由后进入：

```ts
this._stateManager.dispatchServerAction(chatChannel, action);
```

服务端权威状态管理器会：

1. 根据 Action 类型选择 reducer。
2. 更新服务端 `ChatState`。
3. 分配单调递增 `serverSeq`。
4. 广播 envelope。

关键实现见 `agentHostStateManager.ts`：

```ts
const envelope: ActionEnvelope = {
	channel,
	action,
	serverSeq: ++this._serverSeq,
	origin,
};

this._onDidEmitEnvelope.fire(envelope);
```

`ActionEnvelope` 定义是：

```ts
export interface ActionEnvelope {
	readonly channel: URI;
	readonly action: StateAction;
	readonly serverSeq: number;
	readonly origin: ActionOrigin | undefined;
	readonly rejectionReason?: string;
}

export interface ActionOrigin {
	clientId: string;
	clientSeq: number;
}
```

参数语义：

| 字段 | 语义 |
|---|---|
| `channel` | Action 作用的资源 URI，例如某个 chat |
| `action` | reducer 可消费的领域 Action |
| `serverSeq` | agent host 进程级全局提交序号 |
| `origin` | client 乐观写入时的 `{ clientId, clientSeq }` |
| `rejectionReason` | 服务端拒绝 client action 时用于回滚乐观状态 |

注意：`serverSeq` 是全局序号，不是 per-chat 序号。因此某个 chat 客户端收到 `100 → 105` 是正常的，中间序号可能属于未订阅的其他 channel。

---

## 3. reducer 如何得到 ChatState

共享 reducer 位于 `reducer.ts`。

典型文本状态转换：

```ts
case ActionType.ChatResponsePart:
	return {
		...state,
		activeTurn: {
			...state.activeTurn!,
			responseParts: [
				...state.activeTurn!.responseParts,
				action.part,
			],
		},
	};

case ActionType.ChatDelta:
	return updateResponsePart(
		state,
		action.turnId,
		action.partId,
		part => part.kind === ResponsePartKind.Markdown
			? { ...part, content: part.content + action.content }
			: part,
	);
```

工具调用状态机：

```text
Streaming
  ├─ toolCallDelta → Streaming
  └─ toolCallReady
       ├─ confirmed → Running
       └─ 未确认 → PendingConfirmation

Running
  └─ toolCallComplete
       ├─ requiresResultConfirmation → PendingResultConfirmation
       └─ 否则 → Completed
```

例如 `ChatToolCallStart` 创建领域状态：

```ts
{
	kind: ResponsePartKind.ToolCall,
	toolCall: {
		toolCallId: action.toolCallId,
		toolName: action.toolName,
		displayName: action.displayName,
		contributor: action.contributor,
		_meta: action._meta,
		status: ToolCallStatus.Streaming,
	},
}
```

服务端和所有客户端都复用同一个 `chatReducer`。这正是多客户端 UI 收敛的基础。

---

## 4. 首次订阅和 snapshot

Snapshot 定义：

```ts
export interface Snapshot {
	resource: URI;
	state:
		| RootState
		| SessionState
		| ChatState
		| TerminalState
		| ChangesetState
		| ResourceWatchState
		| AnnotationsState;
	fromSeq: number;
}
```

其中：

- `state` 是订阅时服务端的权威状态。
- `fromSeq` 表示 snapshot 已经包含了所有 `serverSeq <= fromSeq` 的状态变化。
- 客户端只应在此基础上应用 `serverSeq > fromSeq` 的 Action。

服务端生成 chat snapshot 的代码见 `agentHostStateManager.ts`：

```ts
return {
	resource,
	state: chatState,
	fromSeq: this._serverSeq,
};
```

客户端在 snapshot 返回前会缓存在线 Action，然后只补 snapshot 水位之后的 envelope，见 `agentSubscription.ts`：

```ts
receiveEnvelope(envelope: ActionEnvelope): void {
	if (!this._isRelevantEnvelope(envelope)) {
		return;
	}

	if (this._confirmedState === undefined) {
		(this._bufferedEnvelopes ??= []).push(envelope);
		return;
	}

	this._reconcile(envelope, isOwnAction);
}

protected _onSnapshotApplied(fromSeq: number): void {
	for (const envelope of this._bufferedEnvelopes ?? []) {
		if (envelope.serverSeq > fromSeq) {
			this._reconcile(envelope, isOwnAction);
		}
	}
}
```

这解决了典型竞态：

```text
服务端生成 snapshot(fromSeq=10)
        ↓
seq=11 在线 Action 先到客户端
        ↓
snapshot RPC 响应后到
```

最终客户端会保留 snapshot 10，并补上 11，不会丢事件，也不会重复应用 10。

这里的“完整 snapshot”准确含义应是：

> 当前已物化状态的完整权威视图。

协议中的 `ChatState` 支持 `turnsNextCursor`，因此未来它可以只是完整的“当前历史窗口”，不必等同于 provider 所有永久历史。

---

## 5. 在线 Action Envelope

服务端 replay buffer 当前容量硬编码为 1000，见 `protocolServerHandler.ts`：

```ts
const REPLAY_BUFFER_CAPACITY = 1000;
```

所有已提交 Action 同时进入 replay buffer 和在线广播：

```ts
this._replayBuffer.push(envelope);

if (this._replayBuffer.length > REPLAY_BUFFER_CAPACITY) {
	this._replayBuffer.shift();
}

this._broadcastAction(envelope);
```

广播只发给订阅了相关 channel 的客户端。

客户端在线收到 Action 时目前只是：

```ts
const envelope = msg.params;
this._serverSeq = Math.max(this._serverSeq, envelope.serverSeq);
this._onDidAction.fire(envelope);
```

然后 subscription manager 按 URI 和 Action 类型过滤，再调用相同 reducer。

---

## 6. 重连：优先补 Action，失效后 snapshot

重连参数定义：

```ts
export interface ReconnectParams {
	channel: 'ahp-root://';
	clientId: string;
	lastSeenServerSeq: number;
	subscriptions: URI[];
}
```

| 参数 | 含义 |
|---|---|
| `clientId` | 原逻辑客户端 ID，重连后保持不变 |
| `lastSeenServerSeq` | 客户端确认处理过的最大服务端序号 |
| `subscriptions` | 断线前仍由客户端持有的订阅 URI |
| `channel` | reconnect RPC 固定走 root channel |

返回值是 discriminated union：

```ts
type ReconnectResult =
	| {
		type: 'replay';
		actions: ActionEnvelope[];
		missing: URI[];
	}
	| {
		type: 'snapshot';
		snapshots: Snapshot[];
	};
```

服务端判断窗口是否有效，见 `protocolServerHandler.ts`：

```ts
const oldestBuffered = this._replayBuffer.length > 0
	? this._replayBuffer[0].serverSeq
	: this._stateManager.serverSeq;

const canReplay =
	params.lastSeenServerSeq >= oldestBuffered;
```

可以 replay 时：

```ts
const actions = this._replayBuffer.filter(envelope =>
	envelope.serverSeq > params.lastSeenServerSeq
	&& this._isRelevantToClient(client, envelope)
);

return {
	type: 'replay',
	actions,
	missing,
};
```

否则：

```ts
return {
	type: 'snapshot',
	snapshots,
};
```

客户端应用策略见 `remoteAgentHostProtocolClient.ts`：

```ts
if (result.type === 'replay') {
	for (const envelope of result.actions) {
		this._onDidAction.fire(envelope);
	}
} else {
	for (const snapshot of result.snapshots) {
		this._subscriptionManager.applyReconnectSnapshot(
			snapshot.resource,
			snapshot.state,
			snapshot.fromSeq,
		);
	}
}
```

fresh snapshot 会清除基于旧 confirmed state 的 pending optimistic actions，避免把旧乐观状态错误叠加到新基线，见 `agentSubscription.ts`。

### 一个保守的边界问题

现在的条件：

```ts
lastSeenServerSeq >= oldestBuffered
```

理论上可以改成：

```ts
lastSeenServerSeq >= oldestBuffered - 1
```

因为客户端若看到 `oldestBuffered - 1`，buffer 中正好还保留下一条所需 Action。

当前实现不会造成错误，只会在边界处比必要情况更早发送 snapshot。

---

## 7. Claude SDK 历史路径和实时路径目前不统一

Claude 历史恢复目前走 `claudeReplayMapper.ts`：

```ts
SessionMessage[]
	→ mapSessionMessagesToTurns()
	→ Turn[]
```

随后 `claudeAgent.ts` 调用：

```ts
const messages =
	await sdkService.getSessionMessages(sdkSessionId, {
		includeSystemMessages: true,
	});

const turns =
	mapSessionMessagesToTurns(messages, routingUri, logService);
```

最终恢复时直接构造：

```ts
state: {
	...createChatState(chatSummary),
	turns,
	draft,
}
```

相关代码在 `agentHostStateManager.ts`。

这意味着当前实际路径是：

```text
历史：SDK SessionMessage → Turn[] → 直接 seed ChatState
实时：SDK SDKMessage → ChatAction → chatReducer → ChatState
```

历史和实时分别维护工具名称、tool result、reasoning、subagent 元数据等规则，长期存在映射漂移风险。

### 推荐改法：使用现有 bulk Action

不建议强行把 SDK 历史伪造成所有实时 delta，因为 SDK transcript 没有完整的 `stream_event` 和 `result` 信封。

更合适的是复用现有 `ChatTurnsLoaded` 领域 Action：

```ts
function hydrateChatHistory(
	summary: ChatSummary,
	turns: readonly Turn[],
	turnsNextCursor?: string,
): ChatState {
	const initial = createChatState(summary);

	return chatReducer(initial, {
		type: ActionType.ChatTurnsLoaded,
		turns: [...turns],
		turnsNextCursor,
	});
}
```

然后恢复代码变成：

```ts
const mappedTurns =
	mapSessionMessagesToTurns(messages, chatUri, logService);

const chatState =
	hydrateChatHistory(chatSummary, mappedTurns);

installRestoredChatState(chatUri, chatState);
```

这形成统一的领域边界：

```text
历史 SDK 消息
  → provider history mapper
  → ChatTurnsLoaded
  → chatReducer
  → snapshot

实时 SDK 消息
  → provider live mapper
  → ChatResponsePart / ChatDelta / ChatToolCall*
  → chatReducer
  → ActionEnvelope
```

历史 mapper 仍然负责 provider-specific normalization，但只有 reducer 能写入最终领域状态。

---

## 8. 严格多客户端一致性的必要修正

### 8.1 reducer 必须是确定性的

当前 reducer 有多处：

```ts
modifiedAt: new Date(Date.now()).toISOString()
```

例如 `reducer.ts`：

```ts
case ActionType.ChatTurnStarted:
	return {
		...state,
		activeTurn: { /* ... */ },
		modifiedAt: new Date(Date.now()).toISOString(),
	};
```

服务端、客户端 A、客户端 B 在不同时间运行 reducer：

```text
Host.modifiedAt    = 10:00:00.001
ClientA.modifiedAt = 10:00:00.018
ClientB.modifiedAt = 10:00:00.043
```

主体 UI 可能一样，但 `ChatState` 并不逐字段相等。

推荐由 Action 携带服务端确定的时间：

```ts
interface ChatTurnCompleteAction {
	type: ActionType.ChatTurnComplete;
	turnId: string;
	duration: number;

	/** 服务端生成的领域变更时间 */
	modifiedAt: string;
}
```

Reducer 只消费 Action：

```ts
case ActionType.ChatTurnComplete:
	return endTurn(
		state,
		action.turnId,
		TurnState.Complete,
		action.duration,
		action.modifiedAt,
	);
```

对于 `ChatTurnStarted` 已经有 `startedAt`，可以直接：

```ts
modifiedAt: action.startedAt
```

更一般的规则是：

> reducer 不得读取 `Date.now()`、随机数、环境配置、locale 或客户端私有状态；所有影响结果的值都必须在 Action 内。

### 8.2 在线 envelope 应去重，但不能检查 `+1`

推荐客户端维护最大已应用序号：

```ts
private _lastAppliedServerSeq = 0;

private applyEnvelope(envelope: ActionEnvelope): void {
	if (envelope.serverSeq <= this._lastAppliedServerSeq) {
		return; // 重复 envelope 或旧连接迟到消息
	}

	this._lastAppliedServerSeq = envelope.serverSeq;
	this._subscriptionManager.receiveEnvelope(envelope);
}
```

不能写成：

```ts
if (envelope.serverSeq !== last + 1) {
	resnapshot();
}
```

因为 `serverSeq` 是全局序号，而服务端只发送与客户端订阅相关的 Action。其他 channel 的 Action 会天然制造序号空洞。

若未来确实需要检测订阅流丢包，应增加以下二者之一：

- per-subscription `channelSeq`；
- per-client filtered stream sequence。

不要复用全局 `serverSeq` 做连续性检查。

### 8.3 replay buffer 应参数化

建议：

```ts
export interface IProtocolReplayOptions {
	/** 最大保留 Action 数量 */
	readonly maxActions: number;

	/** 可选的最长保留时间 */
	readonly maxAgeMs?: number;
}

const DEFAULT_REPLAY_OPTIONS: IProtocolReplayOptions = {
	maxActions: 1000,
	maxAgeMs: 5 * 60_000,
};
```

当前 1000 是整个 host 的全局 Action 数量。多 session 高频输出会快速挤掉低频 chat 的重连窗口，因此生产环境通常应同时考虑：

- action 数量；
- 时间跨度；
- 内存字节数；
- 是否按 channel 分桶。

---

## 9. 推荐的最终协议不变量

实现和测试应明确锁定这些不变量：

1. Provider SDK 类型不得出现在 renderer/workbench 协议中。
2. 所有 UI 状态变化必须表示为领域 Action 或初始 hydration Action。
3. 服务端先运行 reducer，再提交唯一 `serverSeq`。
4. snapshot 的 `fromSeq` 必须与 snapshot state 原子对应。
5. snapshot 到达前收到的 Action 必须缓存。
6. snapshot 后只应用 `serverSeq > fromSeq` 的 Action。
7. replay 必须保持原始 Action 顺序。
8. replay 窗口失效时不得混合“部分 replay + snapshot”，而应整体以 snapshot 为新基线。
9. reducer 必须纯且确定，不得读取本地时间或随机值。
10. `ResponsePart → Delta`、`ToolCallStart → Delta/Ready/Complete` 的先后关系必须由 mapper 保证。
11. `tool_use_id → turnId` 必须跨 SDK message 保存。
12. snapshot 是权威状态；重连 snapshot 时旧 confirmed state 和旧 optimistic pending 必须被清理或显式 rebase。

总体上，现有 AHP 订阅/重连协议已经非常接近这套设计。最值得优先处理的不是重写传输层，而是统一 Claude 历史 hydration 边界，并彻底清除 reducer 中的本地时钟依赖。