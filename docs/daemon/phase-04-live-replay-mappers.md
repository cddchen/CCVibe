# Phase 4：Claude Live/Replay Mapper 与状态桥实施计划

> 状态：已完成（2026-08-25）  
> 目标包：`repos/cc-agent-host`  
> 前置：Phase 0–3 已完成

## 1. 目标

把 Claude SDK 的 provider-native message 转换为稳定 CCVibe domain state：

```text
Live runtime signal
  -> ClaudeLiveMapper
  -> ChatAction[]
  -> HostStateManager

SDK SessionMessage[]
  -> ClaudeReplayMapper
  -> Turn[]
  -> chat/turnsLoaded
  -> chatReducer
```

SDK raw union 只存在于 `src/claude/`，不得进入 JSON-RPC/client protocol。

## 2. 本阶段可表达能力

实现：

- text / thinking streaming；
- tool start / input JSON delta / ready / text result complete；
- turn complete / fail / interrupt；
- chronological transcript user/assistant/tool-result grouping；
- bulk history hydration；
- generation fencing 与 deterministic IDs。

暂缓：usage/cost、citations、thinking signature、rich tool result、nested subagent/task UI、compact boundary、canonical supersession、approval/input。

## 3. Live mapper

新增 `src/claude/liveMapper.ts`：

- 一个 mapper instance 对应 chat runtime generation。
- message-local `index -> block`；`message_start` reset。
- cross-message raw `tool_use_id -> {turnId,partId,toolCallId}`。
- partial stream 是 top-level text/thinking/tool 的唯一 owner；canonical assistant 不重复 append。
- `stream_event` 映射：
  - text/thinking start -> `chat/responsePartAdded`
  - text/thinking delta -> `chat/responsePartDelta`
  - tool_use start -> `chat/toolCallStarted`
  - input_json_delta -> `chat/toolCallInputDelta`
  - tool stop -> `chat/toolCallReady`
- user tool_result -> `chat/toolCallCompleted`；仅投影 text content。
- unsupported blocks/delta no-op，并可通过 injected diagnostic 回报类型名。
- mapper 纯决定 action；timestamp 显式参数，不读时钟。
- deterministic ID 使用 SHA-256 短 hash，避免 SDK ID 中非法 URI 字符与 256-byte 上限；raw tool ID 只作 map key。

## 4. Runtime action bridge

新增 `src/claude/runtimeActionBridge.ts`：

- 修改 registry internal signal observer 为 `(chatUri, signal)`，不把 chatUri 塞进 raw signal。
- 每 chat 记录 current generation；旧 generation signal no-op。
- `runtime/message` 仅 `phase=active` 且有 turnId 时进 live mapper；tail/unmatched 当前不改 terminal turn。
- `turn/result`：
  - completed -> `chat/turnCompleted`
  - failed -> `chat/turnFailed`
  - interrupted/runtime_closed -> `chat/turnInterrupted`
- runtime terminal 若 Host 仍有 active turn：closed -> interrupt；crashed -> fail。
- 每 SDK signal 调 `nowAction()` 一次；同 signal 多 actions 共用 timestamp。
- dispatch actions 保序；no-op 不消费 serverSeq。

## 5. Real chat command actor

新增 `src/chat/claudeChatActor.ts`：

- 公开 `dispatch` 结构兼容 protocol handler 的 command actor interface，不依赖 FakeChatActor class。
- `CommandDeduper(clientId,commandId)` 防重。
- send：先 `chat/turnStarted(origin)`，再 registry.send；runtime failure由 bridge terminal/result action收敛。
- busy/missing/not-subscribed 仍由 Host/handler validation。
- interrupt 直接 registry.interrupt，不等待 send completion。
- protocol handler 抽象 `ChatCommandActor` + common receipt/rejection types，Fake 与 Claude actor 均实现。
- command accepted receipt 与首次 committed envelope seq/turnId 对齐。

## 6. Replay mapper

新增 `src/claude/replayMapper.ts`：

- 输入 official `readonly SessionMessage[]`，对 `message: unknown` 做本地 narrowing。
- 单 pass grouping：
  - user text 开新 turn；turnId 使用 user envelope uuid branded/hashed fallback；
  - assistant text/thinking 完整 part；
  - assistant tool_use 建 tool part/raw map；
  - later user tool_result 完成对应 tool；不新开 turn；
  - system/CLI echo/unknown drop。
- transcript timestamp 结构化读取；缺失使用 injected deterministic fallback（默认空字符串），不得 Date.now。
- tool input stable JSON stringify；tool result仅 text。
- unmatched tool result drop diagnostic。
- incomplete tool call 以 `completed + error='incomplete transcript'` 的 loss-aware fallback，并使 turn failed。
- 输出 immutable `Turn[]`。

新增 `hydrateClaudeHistory(host,chat,messages,timestamp)`：mapper -> `chat/turnsLoaded` -> `HostStateManager.dispatch`；不得直接赋值 ChatState。

## 7. SDK result classification修正

`ClaudeQueryRuntime` 对 `subtype='success' && is_error=true` 必须产生 failed outcome；不能一律 completed。保留 result usage deferred。

## 8. 测试

- text/thinking/tool完整 live lifecycle。
- reused block index跨 message 不冲突。
- canonical assistant不重复 partial text/tool。
- later tool_result cross-message 完成。
- unsupported/no target action reference no-op。
- stale generation signal不改 Host。
- tail message不重开 terminal turn。
- result complete/fail/interrupt唯一 terminal action。
- real actor A/B同 prompt/turn/action，command retry once。
- replay basic/multi-turn/thinking/tool-result/promptless/CLI echo/unknown/incomplete。
- live/replay completed Turn 语义等价 fixture。
- hydration 只经 turnsLoaded action。

## 9. 子代理拆分

1. Live mapper + deterministic IDs + tests。
2. Runtime bridge + actor abstraction/real actor + tests。
3. Replay mapper + hydration + equivalence tests。

## 10. 验收

```bash
npm run typecheck
npm test
npm run build
npm audit
```

要求：Phase 0–3 的 249 tests 保持；无真实网络/subprocess；raw SDK import 仅在 Claude layer/test。

## 11. 完成记录

最终实现包括：

- partial text/thinking/tool stream → typed `ChatAction` 的 deterministic live mapper；
- canonical assistant 去重、cross-message tool result 和 safe diagnostics；
- generation-fenced runtime signal → Host action bridge；
- SDK-free `ChatCommandActor` contract 与真实 `ClaudeChatActor`；
- protocol handler 可在 fake/Claude actor 间替换；
- official `SessionMessage[]` replay mapper、promptless turn、tool result/incomplete transcript；
- safe transcript UUID 保留、非法 identity hash fallback；
- hydration 只经 `chat/turnsLoaded` action，loaded transcript 可替换同 ID stale completed turn；
- live/replay completed turn 语义等价测试。

主代理于 2026-08-25 独立执行：

```text
npm run typecheck  PASS
npm test           PASS — 30 files, 275 tests
npm run build      PASS
npm audit          PASS — 0 vulnerabilities
raw SDK boundary   PASS
```

未启动真实 Claude subprocess；usage、rich tool results、nested subagent UI 和 approval/input 按 roadmap 延后。
