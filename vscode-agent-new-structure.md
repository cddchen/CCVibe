基于 VS Code 的 `ClaudeAgent` 实现重新分析后，正确边界应当是：

> Claude Agent SDK 负责 SDK session、API 调用、Claude transcript 持久化和 resume/fork；远程服务端负责把 SDK 状态投影为稳定的多客户端协议状态。

不需要再做一套 PostgreSQL 对话事件库。核心方案应是：

```text
Claude SDK transcript      = 对话历史事实源
Agent Host ChatState       = 当前 UI / 运行态事实源
Snapshot + ActionEnvelope  = 多客户端同步机制
WebSocket connection       = 临时传输通道，不拥有 session
```

更新后的架构图：

`remote-multi-client-agent-architecture.html`

决策记录：

`implementation-notes.md`

## 一、先区分三个身份

VS Code 实现最重要的设计，是不把几个 session 概念混为一谈：

```text
Agent Host Session
└── Chat URI
    └── Claude SDK Session ID
```

- Agent Host Session：客户端看到的逻辑容器。
- Chat URI：具体可订阅、可发送消息的对话通道。
- SDK Session ID：Claude SDK 的真实 transcript/resume 标识。

映射应明确保存：

```ts
interface ChatBacking {
  chatUri: string;
  sdkSessionId: string;
}
```

VS Code 中就是显式维护 `chatUri → backing`，并反向用 `sdkSessionId` 找运行实例：

`claudeAgent.ts`

不要：

- 用 WebSocket connection ID 代替 session ID。
- 假定 Host session ID 等于 SDK session ID。
- 通过 URI 字符串推导 SDK session。
- 多个 Host 进程同时 resume 同一个 SDK session。

## 二、服务端应该是什么结构

推荐一个有状态 Agent Host shard 同时管理多个 SDK session：

```text
Web / Mobile / Desktop
          │
          │ JSON-RPC 2.0 over WSS
          ▼
ProtocolServerHandler
          │
          ├── SubscriptionManager
          ├── HostStateManager
          │     ├── RootState
          │     ├── SessionState
          │     └── ChatState
          │
          └── ClaudeAgent
                ├── Map<chatUri, ChatBacking>
                ├── Map<sdkSessionId, ClaudeAgentSession>
                └── SequencerByKey<sdkSessionId>
                         │
                         ▼
                  ClaudeSdkPipeline
                         │
                         ▼
                  WarmQuery / Claude SDK
                         │
                         ▼
                  SDK JSONL transcript
```

一个 Host 进程可以运行很多 `ClaudeAgentSession`：

- 同一个 SDK session 的操作串行。
- 不同 SDK session 并行。
- 多个客户端只订阅状态，不拥有 runner/query。

参考实现使用会话级 Sequencer，把首次 materialize 和 send 放在同一个串行区间，避免两个客户端同时首发造成两次 SDK 启动：

`claudeAgent.ts`  
`claudeAgent.ts`

## 三、接口传输方案

首选：

- WebSocket
- JSON-RPC 2.0
- URI channel subscription
- Snapshot + typed action
- 全局 `serverSeq`
- 客户端 `clientSeq`

不建议 SSE，因为审批、abort、steering、客户端工具和反向资源读取都是双向操作。

### 初始化

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "channel": "agent-root://",
    "protocolVersions": ["1.0.0"],
    "clientId": "device-a",
    "initialSubscriptions": ["agent-root://"]
  }
}
```

服务端返回：

```json
{
  "protocolVersion": "1.0.0",
  "serverSeq": 1824,
  "snapshots": [
    {
      "resource": "agent-root://",
      "fromSeq": 1824,
      "state": {}
    }
  ]
}
```

### 订阅具体 session/chat

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "subscribe",
  "params": {
    "channel": "agent-chat://session-1/default",
    "view": {
      "turns": 50
    }
  }
}
```

返回完整 `ChatState`：

```ts
interface ChatState {
  resource: string;
  title: string;
  status: "idle" | "in_progress" | "input_needed" | "error";

  turns: Turn[];
  turnsNextCursor?: string;

  activeTurn?: ActiveTurn;
  pendingInput?: InputRequest[];
  draft?: Message;
}
```

历史很长时只返回最近 N 个 turn，旧历史通过 cursor 分页。附件、大型工具输出使用资源引用，不直接塞进 WebSocket JSON。

## 四、不要把 SDK 原始消息直接当客户端协议

SDK 的 `SDKMessage`：

- 会随 SDK 版本变化；
- live stream 和磁盘 `SessionMessage` 结构不同；
- `result`、`stream_event` 等消息不一定写入 transcript；
- tool result 可能出现在后续 user envelope 中。

参考实现明确分成两条 mapper：

```text
实时：
SDKMessage → AgentSignal → ChatAction → ChatState reducer

冷恢复：
SessionMessage[] → Turn[] → ChatState snapshot
```

冷恢复 mapper 的代码证据：

`claudeReplayMapper.ts`

因此对外协议应该采用领域 Action：

```ts
type ChatAction =
  | { type: "chat/turnStarted"; turnId: string; message: Message }
  | { type: "chat/responsePart"; turnId: string; part: ResponsePart }
  | { type: "chat/delta"; turnId: string; partId: string; content: string }
  | { type: "chat/toolCallStart"; turnId: string; toolCallId: string }
  | { type: "chat/toolCallComplete"; turnId: string; toolCallId: string }
  | { type: "chat/inputRequested"; request: InputRequest }
  | { type: "chat/turnComplete"; turnId: string };
```

每个 action 包一层 envelope：

```ts
interface ActionEnvelope {
  channel: string;
  action: ChatAction | SessionAction;
  serverSeq: number;
  origin?: {
    clientId: string;
    clientSeq: number;
  };
}
```

参考结构：

`actions.ts`

优点是所有客户端用同一个 reducer，一定能归约出相同状态。

## 五、新会话如何下发

Claude SDK 的新 session 在第一次真正 `startup/query` 前可能还没有 transcript。

参考实现的流程是：

```text
createSession
  ↓
创建 Host session URI
  ↓
创建 Chat URI
  ↓
生成 provisional sdkSessionId
  ↓
第一次 send
  ↓
SDK startup({ sessionId })
  ↓
收到 system/init
  ↓
持久化 backing/overlay
  ↓
广播 sessionAdded
```

参考实现会延迟 `sessionAdded`，直到 provisional chat 被 materialize，防止其他客户端看到一个重启后无法恢复的会话：

`claudeAgent.ts`

建议接口：

```json
{
  "method": "createSession",
  "params": {
    "channel": "agent-session://uuid",
    "provider": "claude",
    "workingDirectories": ["file:///workspace"],
    "model": {
      "id": "claude-sonnet-4-6",
      "config": {
        "thinkingLevel": "high"
      }
    }
  }
}
```

创建者可以立即得到：

```json
{
  "session": "agent-session://uuid",
  "chat": "agent-chat://uuid/default",
  "lifecycle": "creating"
}
```

其他客户端收到：

```json
{
  "method": "root/sessionAdded",
  "params": {
    "summary": {
      "resource": "agent-session://uuid",
      "status": "in_progress"
    }
  }
}
```

下发时机有两个选择：

- 推荐：SDK backing 成功 materialize 后广播。
- 或者立即广播，但必须持久化 provisional catalog，并显式使用 `lifecycle: creating`。

## 六、模型和 effort 怎么设置

要通过接口设置，但不要把它们设计成两个可能竞态的独立字段。

参考实现把 effort 放在 `ModelSelection.config.thinkingLevel`：

```ts
interface ModelSelection {
  id: string;
  config?: {
    thinkingLevel?: "low" | "medium" | "high" | "xhigh" | "max";
  };
}
```

代码证据：

`claudeModelConfig.ts`

推荐消息发送格式：

```json
{
  "method": "dispatchAction",
  "params": {
    "channel": "agent-chat://uuid/default",
    "clientSeq": 31,
    "action": {
      "type": "chat/turnStarted",
      "turnId": "turn-uuid",
      "message": {
        "text": "检查这个项目",
        "origin": { "kind": "user" },
        "model": {
          "id": "claude-opus-4-6",
          "config": {
            "thinkingLevel": "high"
          }
        }
      }
    }
  }
}
```

服务端在同一 sequencer 中执行：

```ts
await session.setModel(model.id);
await session.setEffort(model.config?.thinkingLevel);
await session.send(message);
```

具体 SDK 语义：

- `Query.setModel()`：更新 live Query，在下一次用户请求生效。
- `Query.applyFlagSettings({ effortLevel })`：同样在下一次请求生效。
- 物化前：写入 SDK `Options.model/effort`。
- Query 崩溃或 resume/rebind：重新回放当前 model/effort。
- 跨 transport，例如 Copilot proxy → Anthropic native：不能原地热切换，应在下一次 send 前 resume/rebind。

参考实现：

`claudeSdkPipeline.ts`  
`claudeAgent.ts`

模型选择还需要保存一份 Host overlay，因为 SDK catalog 不一定完整提供用户最后选择的 effort、permission mode 和附加目录。

## 七、客户端下线后再回来

客户端本地只保存：

```ts
interface LocalConnectionState {
  clientId: string;
  lastSeenServerSeq: number;
  subscriptions: string[];
  cachedSnapshots: Record<string, unknown>;
  pendingOptimisticActions: Action[];
}
```

不要保存并上传一份“本地对话历史”去和 SDK 合并。SDK transcript 才是对话历史源。

### 情况一：短暂断线，Host 进程没重启

客户端：

```json
{
  "method": "reconnect",
  "params": {
    "channel": "agent-root://",
    "clientId": "device-a",
    "lastSeenServerSeq": 1824,
    "subscriptions": [
      "agent-root://",
      "agent-session://uuid",
      "agent-chat://uuid/default"
    ]
  }
}
```

如果 replay buffer 能覆盖：

```json
{
  "type": "replay",
  "actions": []
}
```

客户端按 `serverSeq` 继续 reducer。

参考实现就是有界内存 action replay：

`protocolServerHandler.ts`  
`protocolServerHandler.ts`

### 情况二：断线太久，action buffer 已经覆盖

服务端返回：

```json
{
  "type": "snapshot",
  "snapshots": []
}
```

客户端：

1. 保留本地 cache 仅用于瞬时展示。
2. 收到 snapshot 后替换 confirmed state。
3. 只应用 `serverSeq > snapshot.fromSeq` 的后续 action。
4. 本地未确认写操作根据 `origin.clientSeq` 判断是否已经被服务端处理。

### 情况三：Host 也重启了

服务端重新：

1. `listSessions()` 获取 SDK session catalog。
2. 根据 Host 保存的 backing 找到 `sdkSessionId`。
3. `getSessionMessages(sdkSessionId)` 读取 SDK transcript。
4. replay mapper 转成 `Turn[]`。
5. 构造新的 ChatState snapshot。
6. 用户下一次发送时用 SDK `resume` 重新 materialize Query。

SDK service 已直接提供这些能力：

`claudeAgentSdkService.ts`

Anthropic 官方的 session browser 示例也说明 session catalog/transcript 可直接读取，不需要启动 agent 子进程，并支持 fork/resume：[Building a session browser](https://platform.claude.com/cookbook/claude-agent-sdk-05-building-a-session-browser)。

但必须接受：

- 已写入 SDK transcript 的 completed turns 可以恢复。
- 尚未落盘的流式 delta 可能丢失。
- Host 进程内等待中的 `canUseTool` promise 无法跨进程恢复。
- Host 崩溃时的 active turn 应标记 interrupted，下一次 resume 后继续新 turn。

## 八、运行中客户端下线是否停止 Agent

不应该。

资源释放条件应是：

```ts
canRelease =
  !session.hasActiveTurn &&
  !session.hasPendingPermission &&
  !session.hasPendingUserInput;
```

客户端数量为零不能直接 dispose Query。

对于不同工具类型需要区分：

- Claude 内建工具：客户端全部下线后仍可继续。
- 服务端 MCP 工具：仍可继续。
- 审批请求：保留 runtime 和 pending state，等待客户端回来。
- 客户端提供的工具：绑定具体 `activeClient`；owner 下线后设置 grace timeout，超时失败或重新选择兼容客户端。

审批只应由 Host 的 pending registry 结算一次。多个客户端同时响应时，第一个 `respond(requestId)` 成功，其余返回 already resolved。

## 九、部署和扩容方案

不建议把 Claude session 当普通无状态 HTTP 请求，在任意 pod 上处理。

推荐：

```text
Edge Gateway
    │
    │ tenant/workspace/session affinity
    ▼
Agent Host Shard A
  ├── SDK session 1
  ├── SDK session 2
  └── SDK session 3

Agent Host Shard B
  ├── SDK session 4
  └── SDK session 5
```

每个 shard：

- 一个长期运行的 Node.js Agent Host。
- 一个 Protocol Server。
- 多个 ClaudeAgentSession/WarmQuery。
- 可持久化的 SDK transcript 目录。
- workspace 和凭据隔离。
- Host overlay DB。
- 有界 action replay buffer。

扩容按 tenant/workspace 分片，而不是按每个 WebSocket 或请求随机负载均衡。

网关只需要维护：

```text
tenant/workspace → hostShard
```

Redis 可用于：

- shard 路由表；
- presence；
- host lease；
- 限流。

不需要 Redis/NATS 保存对话正文。

如果要迁移 SDK session：

1. 等当前 turn 结束。
2. shutdown 并等待 SDK 子进程真正退出、刷新 transcript。
3. 确保目标 Host 能访问相同 workspace、transcript 和凭据。
4. 获得 session lease。
5. 目标 Host 使用 `resume` materialize。

Anthropic 官方也明确区分：Agent SDK 是运行在你自己管理的进程中的，而 Managed Agents 才运行在 Anthropic 基础设施中。[Managed Agents migration](https://platform.claude.com/docs/en/managed-agents/migration)。

最终推荐栈是：

```text
Node.js 22
Fastify 或原生 ws
JSON-RPC 2.0 over WSS
Zod / JSON Schema 协议验证
Agent Host StateManager + reducers
Claude Agent SDK
SQLite 作为 Host overlay/catalog
SDK transcript persistent volume
可选 Redis：shard routing/presence
```

这里 SQLite 只保存 Host overlay，不保存重复的对话内容。单个 Host shard 内不需要 PostgreSQL、Kafka 或 NATS。