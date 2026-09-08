# 功能 4：后台任务进度单块归并实施计划

## 目标

同一个 Claude SDK 后台任务的 `task_started`、高频 `task_progress`、`task_updated` 和最终 `task_notification` 在一轮对话中始终占用同一个“后台任务进度”折叠块；新进度更新该块，不新增平级块。不同任务仍各自独立。

## 现状调研

- 当前 SDK 版本为 `@anthropic-ai/claude-agent-sdk 0.3.220`。官方类型确认上述四类消息都包含稳定 `task_id`；`background_tasks_changed` 文档明确说它是全量 level signal，且不应与 edge stream 做关联，因此不参与单任务归并。
- 当前 `systemMessageProjection` 会把每个 task event 投影成普通 `system_message`，但没有保留内部关联键。
- `ClaudeLiveMapper` 使用 SDK message UUID 生成 part id，所以每次进度都是新 part；Host 和 Mobile reducer 对重复 part id 的现有语义是直接忽略。
- replay mapper 同样按 transcript row identity 生成新 part，若只修实时路径，会造成重新载入历史后重新展开为多个块。

## 设计

1. 在 `src/claude/` 内部投影类型中从官方消息读取 `task_id` 作为非公开 grouping identity；原始 SDK 类型仍不得越过 Claude adapter。
2. 对四类 task event 使用 `generation + turnId + task_id` 生成稳定 part id，并统一标题为“后台任务进度”。非 task system event 保持 message UUID identity。
3. 将 `chat/responsePartAdded` 对“同 id 的 system_message”语义收紧为幂等 upsert：字段完全相同则 no-op，内容/level/title 改变则原位替换；不同 kind 或普通重复 part 仍 no-op。
4. Mobile reducer实现相同的确定性 upsert，确保 action replay 与 Host snapshot 逐字段收敛。
5. replay mapper对同 turn、同 task id 的记录原位替换，最终历史 snapshot 只保留一个块；最终通知把 level 投影为 success/error/warning，进度阶段为 progress。
6. 不把 `background_tasks_changed` 合并进 task 块，不解析或执行 tool payload，不跨 turn 移动 part。

## 预计改动

- `repos/cc-agent-host/src/claude/systemMessageProjection.ts`
- `repos/cc-agent-host/src/claude/liveMapper.ts`
- `repos/cc-agent-host/src/claude/replayMapper.ts`
- `repos/cc-agent-host/src/domain/chatReducer.ts`
- `repos/cloud-mobile/src/domain/hostReducer.ts`
- 对应 Host/Mobile mapper 与 reducer 测试

## 测试与验收

- 同 task 的 start → 多次 progress → update → notification 始终一个 part，保持原数组位置并更新终态。
- 不同 task id 生成两个块；重复相同事件幂等；`background_tasks_changed` 独立。
- 实时 actions、Host reducer、Mobile reducer、replay snapshot 得到等价结构。
- Host `typecheck + Claude/reducer tests + build`；Mobile `typecheck + reducer tests + lint`。

## 子代理边界

实现 Host 归并根因和 Mobile reducer 镜像语义，不改 ChatScreen 视觉组件，避免与功能 1–3 并发冲突。
