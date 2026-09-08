# 功能 3：消息文本选择与原文复制实施计划

## 目标

用户和 Agent 的可见文本支持长按系统选择/复制；每条用户消息与每条 Agent 最终回复下方增加小型复制图标，一次复制该消息的原始文本，并给出无打扰成功/失败反馈。

## 现状调研

- 工具、思考和 system 详情中的若干 `Text` 已设置 `selectable`，用户 prompt、流式回复和 Markdown 最终回复尚未形成一致能力。
- 用户 prompt 的外层长按当前触发撤回，与系统文本选择冲突；必须把撤回改到独立消息操作按钮，不能牺牲现有 rewind 能力。
- `react-native-markdown-display` 的默认 `textgroup` rule 生成普通 `Text`，需要通过规则覆盖使文本节点可选择；复制整条 Agent 原文则直接使用 selector 保留的 Markdown source。
- 当前没有 clipboard 依赖；Expo 54 的 bundled native module 指定 `expo-clipboard ~8.0.8`，应通过 `npx expo install expo-clipboard` 添加兼容版本并更新 lockfile。

## 设计

1. 新增最窄 clipboard adapter/helper，调用 `Clipboard.setStringAsync(rawText)`；UI 不自行重组 Markdown、tool JSON 或 provider payload。
2. 用户消息操作区包含复制和撤回图标；Agent 最终回复下方包含复制图标。图标满足 44pt/48dp 命中区、可访问 label，并采用次要色与低视觉权重。
3. 用户 prompt、流式 reply、失败文本、process 详情使用 `selectable`；Markdown 通过自定义 render rule 让文本分组可选择，同时保留链接与 Markdown 样式。
4. “Agent 单条消息原文”定义为该 turn 的最终 answer Markdown part 原文；若没有最终 answer，不伪造文本。多 answer part 按屏幕当前 final-answer 选择逻辑复制对应 source。
5. 成功反馈使用现有 notice/toast 通道，失败显示简洁错误，不泄漏原文。

## 预计改动

- `repos/cloud-mobile/package.json`
- `repos/cloud-mobile/package-lock.json`
- `repos/cloud-mobile/src/features/chat/ChatScreen.tsx`
- 可选 `repos/cloud-mobile/src/features/chat/messageClipboard.ts`
- `repos/cloud-mobile/test/chatCopyInteraction.test.ts`
- `repos/cloud-mobile/test/chatRewindInteraction.test.ts`

## 测试与验收

- clipboard port 单测验证复制的是未经改写的 prompt/Markdown source。
- 静态/组件契约验证用户消息与 Agent 最终回复各有复制入口，Markdown text rule 与普通 Text 均支持选择，撤回不再占用正文长按。
- `npm run typecheck`、相关与全量 Vitest、`npm run lint`、双平台 bundle；原生依赖变更再做 iOS/Android 构建或明确未验证。

## 子代理边界

在功能 1、2 后顺序实施，复用已经形成的消息/过程块组件；不把 clipboard 内容写入 runtime state、日志或 Host。
