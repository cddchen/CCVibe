# 功能 2：工具结果与思考内容五行滚动实施计划

## 目标

Agent 回复中的工具调用块和思考块默认折叠。点击块头展开后，正文视窗最多显示 5 行，超出部分在块内部滚动；再次点击块头恢复折叠。

## 现状调研

- `ProcessPart` 已按 `part.id` 保存展开状态，工具、思考和 system block 都能通过头部点击展开/折叠。
- 当前展开内容直接使用无高度上限的 `Text`，长工具输出或思考会撑高整个 transcript，破坏外层列表滚动体验。
- 工具块可能同时有 input、result/error；需求限定的主要对象是调用结果。输入可以保留可读展示，但 result/error 与 reasoning 必须进入五行高的内部滚动视窗。
- React Native 嵌套滚动需要 `ScrollView` 的明确最大高度，并在 Android 启用 `nestedScrollEnabled`；不能依赖 `numberOfLines={5}`，因为那会截断而不是允许滚动全文。

## 设计

1. 抽出 `BoundedProcessContent`，以正文 `lineHeight * 5` 作为最大可视高度，使用垂直 `ScrollView` 承载完整、可选择文本。
2. reasoning 内容使用 5 行视窗；tool 的 output 或 error 使用 5 行视窗。工具 input 维持独立展示并设置合理上限，避免与结果共同把卡片无限撑高。
3. 内容不足 5 行时自然收缩；超过时仅内部滚动，外层 FlatList 仍可滚动。
4. 块头保留 `accessibilityState.expanded`，点击同一目标切换状态；展开选择不因同 part 内容更新而重置。
5. system 消息不是本需求对象，除非复用 helper 不改变其现有次消息语义。

## 预计改动

- `repos/cloud-mobile/src/features/chat/ChatScreen.tsx`
- 可选纯 helper：`repos/cloud-mobile/src/features/chat/messagePresentation.ts`
- `repos/cloud-mobile/test/chatProcessDisclosure.test.ts`
- `repos/cloud-mobile/test/chatPerformanceContract.test.ts`

## 测试与验收

- 验证 reasoning/tool 默认折叠、点击展开/回折叠、五行高度上限、`nestedScrollEnabled` 和全文仍在视图树中。
- 覆盖 tool success/error、短内容、长内容和流式 reasoning 更新。
- `npm run typecheck`、相关 Vitest、`npm run lint`；iOS/Android 视觉检查嵌套滚动手势。

## 子代理边界

在功能 1 完成后顺序实施；不改变 Host tool lifecycle、消息协议或 selector 的原文内容。
