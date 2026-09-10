# SDK init 控制面消息过滤计划

状态：已完成。

## 目标、范围与非目标

目标：Claude Agent SDK 的 `system/init` 仅作为 Host runtime/catalog 的控制面信号，不再写入任一 turn 的 `system_message`，历史回放同样过滤普通 init，从而消除每条 Agent 回复旁的“运行环境初始化”折叠块。

范围：Host live runtime bridge、历史 replay projector/mapper、相关回归测试，以及描述当前 system-message 行为的文档。Mobile 已按公共 `system_message` 通用渲染，问题 owner 在 Host，不修改 Mobile 以隐藏服务端错误事实。

非目标：不改变 SDK Query 生命周期、slash command、MCP/skill/tool 发现、catalog 的 model/permission 更新、其他 system subtype、初始化失败或 runtime crash 的现有错误语义。本次不新增一个尚无 SDK 事件依据的“能力变化”聊天消息；能力仍由 Host catalog/runtime 状态表达。

当前分支工作树已有 Mobile、版本、harness 与其他功能计划改动，均视为用户工作并保留。任务相关 Host 源码在调研时无未提交修改。

## 事实证据

| 事实 | Owner | 文件/符号 | 置信度 | 漂移/动作 |
| --- | --- | --- | --- | --- |
| SDK `system/init` 携带 session、model、permission、tools/MCP/skill/command/capability 等初始化元数据 | Claude SDK adapter | 安装的 `sdk.d.ts`、`ClaudeQueryRuntime.handleInitMessage` | 高 | 保留 `runtime/init` 信号，不向 domain 暴露原始 payload |
| runtime init 当前被写成当前 active turn 的永久 `system_message` | Host live projection | `ClaudeRuntimeActionBridge.handleInit` | 高 | 改为控制面 no-op，catalog observer 继续消费 signal |
| replay 当前把 init 投影并附着到第一条或所在 turn | Host replay projection | `projectRecordedSystemMessage`、`ClaudeReplayMapper.mapSystemMessage` | 高 | projector 对 `init` 返回 `undefined`，live/replay 共用过滤语义 |
| Mobile 会把所有公共 `system_message` 默认折叠展示 | Mobile selector | `chatSelectors.projectPart` | 高 | 不在客户端按 event 特判隐藏 |
| 普通 send 应复用长生命周期 Query；result 只结束 turn | Host runtime/registry | `ClaudeQueryRuntime`、`ClaudeChatRegistry.send` | 高 | 不以重建 runtime 掩盖展示问题 |

## 方案与实施顺序

1. 先修改 Host 回归测试，使 live `runtime/init` 断言为不增加 action/serverSeq/turn part，同时保留 stale generation 和 tail 过滤覆盖。
2. 修改 replay 测试，验证 leading init、turn 内 init 和重复 init 都不会生成 part，也不会创建空 turn；其他 system subtype 继续恢复。
3. 在 Claude system projector 统一过滤 `init`；在 runtime bridge 中移除将 `runtime/init` 转成 response part 的逻辑。`createClaudeAgentHost` 对 runtime init 的 catalog model/permission 更新保持不变。
4. 更新 system-message 功能计划及必要架构说明，明确 `init`/`status` 是控制面例外。
5. 运行 Host 针对性测试、typecheck、全量 test、build，最后检查 `git diff --check` 与目标 diff。

备选方案是不改 Host，只在 Mobile 过滤 `event === 'init'`。该方案会让错误内容继续进入权威状态、网络 action、snapshot 与 replay，违反 owner 边界错误，因此不采用。

## 角色与文件范围

- 架构师（主代理）：本计划、最终 diff/文档收敛、harness 事实更新判断。
- 开发者（`gpt-5.6-luna` / `max`）：仅修改 `repos/cc-agent-host/src/claude/systemMessageProjection.ts`、`runtimeActionBridge.ts`、对应 `test/claude/*.test.ts` 和本计划的实现记录；不得修改 Mobile、版本或其他 dirty 文件。
- 测试员（独立 `gpt-5.6-luna` / `max`）：开发完成后只读审查目标 diff并运行门禁；仅把验证结果追加到本计划。如发现问题，报告架构师，不直接扩展范围。

## 验收条目

- Live：active turn 存在时收到普通 `runtime/init`，不产生 `chat/responsePartAdded`，不增加 `serverSeq`，turn parts 不出现 init。
- Control plane：同一 signal 仍可由 Host 装配层更新 catalog 中的 model 与 permission mode；SDK session identity/capability 不进入公网 transcript。
- Replay：leading init、turn 内 init 和多个 runtime generation 留下的 init 均不恢复为 part，也不创建空 turn。
- 相邻行为：`local_command_output`、compact boundary、hook/task/notification 等可见 system 消息保持；status 瞬时状态和 compact failure 语义不回退。
- 自动化：Host `typecheck`、相关 Vitest、全量 `npm test`、`npm run build` 通过；根目录 `git diff --check` 通过。
- 平台：无 Mobile UI 代码变化，不要求模拟器/真机视觉验收；不运行真实模型/SDK token smoke，并在结果中披露。

## 实现记录

2026-09-08 开发者实施：

- 先行修改回归断言后运行 `npx vitest run test/claude/runtimeActionBridge.test.ts test/claude/replayMapper.test.ts test/claude/liveMapper.test.ts`，旧实现按预期失败 3 项：live bridge 仍为 init dispatch、replay 仍附着 3 个 init part、共享 live mapper projector 仍返回 init action。
- `systemMessageProjection.ts` 在统一 `projectSystemRecord()` 入口过滤 `subtype: 'init'`，因此 live/replay 均不再投影普通 init；`status` 的瞬时状态与 compact failure 分支保持原逻辑。
- `runtimeActionBridge.ts` 保留 `mapperFor(chatUri, generation)` 在 signal 分派前执行，以推进/维护 generation fence；随后 `runtime/init` 直接返回空 envelope，不调用 action 时钟、不 dispatch、不生成 response part。移除了仅服务于旧 init response-part 的 hash/id 代码。`createClaudeAgentHost` 的 catalog observer 未改动，仍消费同一 init signal 更新 model/permission。
- 共享 projector 既被 `ClaudeLiveMapper` 使用，故同步更新既有 `test/claude/liveMapper.test.ts` 的 init 契约；未修改 Mobile、版本文件或其他 Host 文件。
- 旧实现失败后，针对性命令再次通过：`npx vitest run test/claude/runtimeActionBridge.test.ts test/claude/replayMapper.test.ts test/claude/liveMapper.test.ts`（3 files / 30 tests）；`npm run typecheck`（退出码 0）；根目录 `git diff --check`（退出码 0）。未运行真实 SDK/model smoke；全量 `npm test` 与 `npm run build` 留待独立测试员验收。

2026-09-08 返工记录：

- 独立验收发现 `test/claude/claudeQueryRuntime.test.ts` 仍把 `runtime/init.systemMessage` 当作展示契约，导致该文件 16 tests 中 1 项失败，并使 Host 全量测试 460 项中 1 项失败。
- 仅更新该测试：保留并断言 `sdkSessionId`、`model`、`permissionMode`、`capabilities` 等控制面字段，改为明确断言 init signal 不具有 `systemMessage`；未改变生产语义、Mobile 或其他 dirty 文件。
- 返工后验证：`npx vitest run test/claude/claudeQueryRuntime.test.ts`（1 file / 16 tests passed）；`npx vitest run test/claude/runtimeActionBridge.test.ts test/claude/replayMapper.test.ts test/claude/liveMapper.test.ts`（3 files / 30 tests passed）；`npm run typecheck`（退出码 0）。

## 验证记录

2026-09-08 测试员独立验收（Host，工作树基线含其他用户改动）：

- 环境：仓库 `/Users/cdd/Documents/ClaudeCodeRemote/CCVibe`；Node `v26.8.1`；npm `11.19.0`；安装 Claude Agent SDK `@anthropic-ai/claude-agent-sdk@0.3.220`。实际核对 `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`：`SDKSystemMessage` 的 `subtype: 'init'` 携带 `session_id`、`model`、`permissionMode` 等初始化字段，`SessionMessage.message` 为 `unknown`；未把 SDK 类型事实从该安装版本之外推导。
- 只读审查：`ClaudeRuntimeActionBridge.handle()` 在 `runtime/init` 分支前仍调用 `mapperFor(chatUri, generation)`，所以 generation fence 仍推进并重置旧 mapper；init 分支返回冻结空 envelopes，不调用 action timestamp、不 dispatch。`projectSystemRecord()` 对 `init` 统一返回 `undefined`，因此 live/replay 都不产生 `system_message`；`createClaudeAgentHost` 的 `onSignal` observer 未改动，仍从同一 init signal 更新 catalog model/permission。`sdkSessionId` 仍只位于内部 runtime/backing 事实，init projection 不进入 transcript。
- 针对性命令（执行目录 `repos/cc-agent-host`）：`npx vitest run test/claude/runtimeActionBridge.test.ts test/claude/replayMapper.test.ts test/claude/liveMapper.test.ts test/claude/createClaudeAgentHost.test.ts`，退出码 `0`，4 files / 54 tests passed。覆盖 live init no-op、generation/stale tail fence、leading/in-turn/repeated replay init 过滤、live/replay 其他 system/status、catalog model alias observer。
- `npm run typecheck`（执行目录 `repos/cc-agent-host`），退出码 `0`。
- `npm run build`（执行目录 `repos/cc-agent-host`），退出码 `0`；仅验证 TypeScript build，不等同真实 SDK/model smoke 或原生构建。
- 额外针对性命令 `npx vitest run test/claude/claudeQueryRuntime.test.ts` 暴露 1 个未同步回归断言：`test/claude/claudeQueryRuntime.test.ts:465-478` 仍期待 `runtime/init.systemMessage.event === 'init'`，当前 projector 按本计划过滤后该可选字段缺失；该测试 16 tests 中 1 failed。测试员未修改测试或源码，已将问题交回架构师/开发者处理。
- `npm test`（执行目录 `repos/cc-agent-host`）退出码 `1`：46 files / 460 tests 中 459 passed、1 failed，唯一失败同上 `claudeQueryRuntime.test.ts` init systemMessage 旧断言。
- 根目录 `git diff --check` 退出码 `0`。未运行真实 Claude SDK/model token smoke；本任务无 Mobile UI 代码变化，不需要模拟器/真机视觉验证。除本验证记录外，测试员未修改源码、测试、Mobile、版本、harness 或其他 dirty 文件；未执行 git add/commit/push。

2026-09-08 返工后独立复验：

- 返工 diff 审查：仅修改 `test/claude/claudeQueryRuntime.test.ts`，将旧的 init 展示契约改为控制面元数据契约，并明确断言 `runtime/init` 不具有 `systemMessage`；`runtimeActionBridge.ts`、`systemMessageProjection.ts` 及其他目标实现未再变化，未越过开发者文件范围。
- 环境仍为仓库 `/Users/cdd/Documents/ClaudeCodeRemote/CCVibe`、Node `v26.8.1`、npm `11.19.0`、Claude Agent SDK `0.3.220`。针对性命令（执行目录 `repos/cc-agent-host`）：`npx vitest run test/claude/claudeQueryRuntime.test.ts test/claude/runtimeActionBridge.test.ts test/claude/replayMapper.test.ts test/claude/liveMapper.test.ts test/claude/createClaudeAgentHost.test.ts`，退出码 `0`，5 files / 70 tests passed。
- `npm run typecheck`（执行目录 `repos/cc-agent-host`），退出码 `0`；`npm test`，退出码 `0`，47 files / 460 tests passed；`npm run build`，退出码 `0`。
- 根目录 `git diff --check` 及目标文件 diff-check 均退出码 `0`。自动化验收全部通过，结论：可接受。未运行真实 Claude SDK/model token smoke；本任务无 Mobile UI 代码变化，不需要模拟器/真机视觉验证；未执行 git add/commit/push。

## 收敛记录

2026-09-08 架构师收敛：

- 接受返工后实现与独立测试结论。普通 `system/init` 已从 live/replay transcript 投影中移除；runtime/catalog observer 和 generation fence 保留，未把问题下推给 Mobile 特判隐藏。
- 同步修正功能 7、Host 架构/API、Phase 4 mapper 文档及 `harness.md` 的过期事实；`AGENTS.md` 已有“修复落在事实 owner 层”和 SDK/control-plane 边界规则，无需为单个 subtype 重复新增强制条款。
- 自动化验收以返工后 5 个目标文件 70 tests、Host 全量 47 files / 460 tests、typecheck、build 和 `git diff --check` 全部通过为完成依据。
- 剩余限制：未运行真实 Claude SDK/model token smoke；未观察生产日志确认实际 init 频率。本修复直接过滤错误的 transcript 投影，因此不依赖 init 是逐轮发送还是仅在 Query 重建时发送。无 Mobile UI 代码变化，无需模拟器/真机视觉验证。
