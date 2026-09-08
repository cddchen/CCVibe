# 功能 1：用户消息十行折叠实施计划

## 目标

聊天记录中的用户原始消息默认最多展示 10 行；实际排版超过 10 行时显示明确的展开符号，点击后展示全文，再次点击恢复折叠。该规则只作用于用户消息，不裁剪 Host 保存的 `turn.prompt`，也不影响 Agent 回复。

## 现状调研

- 用户消息由 `ChatTurnViewModel.prompt` 原样投影，事实源仍是 Host turn。
- `TurnTranscriptItem` 当前直接渲染一个无行数限制的 `Text`，外层 `Pressable` 的长按被“撤回”占用。
- 消息列表已按 turn 虚拟化并 memo；折叠状态应留在单个 turn 行组件中，不能提升到全局 runtime 导致输入或流式更新触发整表重渲染。
- 仅按字符数判断是否超长不可靠；字体缩放、设备宽度、中英文换行均会改变真实行数，应使用原生文本布局行数判断。

## 设计

1. 在 Mobile chat feature 中抽出 `UserPromptMessage`（或等价窄组件）。
2. 折叠态给正文 `numberOfLines={10}`、`ellipsizeMode="tail"`；通过 `onTextLayout` 记录首次完整测量或采用不破坏布局的测量策略，仅当真实行数大于 10 时显示 chevron。
3. chevron 是独立的 44pt/48dp 可访问按钮，暴露 `accessibilityState.expanded`；展开后正文无行数上限，再次点击折叠。
4. 状态以 `turn.id` 为组件 key/生命周期边界；同一 turn 的流式 Agent 更新不得重置用户手动展开状态。
5. 与功能 3 协调：用户正文必须支持系统文本选择；撤回入口从正文长按迁移到消息操作区，避免抢占长按复制。

## 预计改动

- `repos/cloud-mobile/src/features/chat/ChatScreen.tsx`
- 可选纯 helper：`repos/cloud-mobile/src/features/chat/messagePresentation.ts`
- `repos/cloud-mobile/test/chatMessagePresentation.test.ts`
- 更新 `repos/cloud-mobile/test/chatRewindInteraction.test.ts`

## 测试与验收

- 纯函数/静态契约覆盖 10 行边界、11 行溢出、展开/折叠可访问语义、非用户消息不受影响。
- `npm run typecheck`、相关 Vitest、`npm run lint`。
- iOS 与 Android 至少各检查一次：窄屏、字体放大、长中文/英文/含换行文本；记录无可用模拟器时的未验证项。

## 子代理边界

只实现本功能及与复制/撤回入口兼容所需的最小结构，不改 Host 协议、消息正文或全局滚动策略。后续功能 2、3 将在此结构上顺序集成，避免并发编辑 `ChatScreen.tsx`。
