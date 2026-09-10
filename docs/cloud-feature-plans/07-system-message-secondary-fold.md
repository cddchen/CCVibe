# 功能 7：Claude SDK system 消息接入与次级折叠展示

## 目标

将当前安装版本 Claude Agent SDK 中 `type: 'system'` 的消息统一接入 Cloud：Host 负责脱敏、限长和领域投影，Mobile 将其作为低于助手正文的次级消息展示，并默认使用与工具调用一致的可展开/收起块。展开后的长详情最多占五行高度，内容在块内滚动。

## 当前事实

- `@anthropic-ai/claude-agent-sdk 0.3.220` 的 `SDKMessage` 中，`type: 'system'` 是带 `subtype` 的判别联合；当前源码通过 `Extract<SDKMessage, { type: 'system' }>` 和 `satisfies Record<subtype, title>` 跟随已安装 SDK 类型，不需要手写第二份 SDK union。
- Host 已有 live 与 replay 两条 `system_message` 投影路径，历史加载也已传入 `includeSystemMessages: true`；`init` 仅作为 runtime/catalog 控制面信号，不归属到 turn，也不生成可展示 part。
- 公网协议只传 `event/title/content/level`，不会传 `session_id`、SDK UUID 或原始 SDK payload。
- Mobile selector 已把 `system_message` 映射为默认 `collapsed: true` 的 process part，header 与 tool part 共用交互结构，但 system 详情展开后目前没有五行高度约束。
- 同一后台任务的高频 `task_started/task_progress/task_updated/task_notification` 已按 Host 内部 task identity 归并为同一个 system part；该关联键不会进入公网协议。

## 实施设计

1. 继续以当前 SDK `.d.ts` 为唯一 subtype 事实源，保留 `SYSTEM_TITLES` 的编译期穷尽校验；未知的历史 subtype 使用安全的通用标题，不让旧会话因 SDK 演进而无法回放。
2. 可展示的 live system 消息经 Claude adapter 归一化为 `system_message`；历史 system 消息走同一 projector。内容先结构化裁剪与敏感字段脱敏，再进入 domain reducer。
3. `init` 与 `status` 是控制面例外：`init` 只更新 Host runtime/catalog 元数据，live/replay 均不生成 part；`requesting/compacting/null` 通过 `TurnActivity` 与 `chat/turnActivityChanged` 表达 active turn 的瞬时状态，不生成历史 system part；只有压缩失败保留为脱敏的 error system part。
4. Mobile 保持 system part 默认折叠，使用比正文更弱的标题、图标、状态与正文颜色；错误级别仅对图标和详情使用 error 色，不伪装成普通助手回复。
5. system 详情复用工具结果/思考内容的有界容器：点击 header 展开，最大五行高度，内部纵向滚动，再次点击收起；文本保持可选择。
6. 不接入 `auth_status`、`rate_limit_event`、`conversation_reset` 等非 `type: 'system'` 消息。它们有独立语义，若产品需要应分别设计状态、导航或提示协议，不能冒充 system transcript part。

## 预计改动

- Host adapter/replay 与测试：
  - `repos/cc-agent-host/src/claude/systemMessageProjection.ts`
  - `repos/cc-agent-host/src/claude/liveMapper.ts`
  - `repos/cc-agent-host/src/claude/replayMapper.ts`
  - `repos/cc-agent-host/test/claude/liveMapper.test.ts`
  - `repos/cc-agent-host/test/claude/replayMapper.test.ts`
- Mobile selector/UI 与测试：
  - `repos/cloud-mobile/src/features/chat/chatSelectors.ts`
  - `repos/cloud-mobile/src/features/chat/ChatScreen.tsx`
  - `repos/cloud-mobile/test/chatSelectors.test.ts`
  - `repos/cloud-mobile/test/chatProcessDisclosure.test.ts`

## 验收标准

- `compact_boundary`、`local_command_output`、hook/task/notification/error 等可展示 SDK system subtype 均能通过同一 live 投影进入 `system_message`；普通 `init` 不进入 transcript。
- replay 使用 `includeSystemMessages: true`，可展示消息在重新进入会话后仍以相同领域结构显示，同时过滤普通 `init` 与瞬时 `status`。
- SDK `session_id`、UUID、task ID 和敏感凭据不出现在公网 part 中。
- Mobile system part 默认折叠，视觉层级低于正文；点击展开后详情高度最多五行且内部可滚动，再点收起。
- 后台任务进度继续同块原位更新，不退化为多块刷屏。
- Host 通过 typecheck、相关 mapper/reducer 测试与 build；Mobile 通过 typecheck、相关 selector/UI 测试、lint 和双平台 bundle；无可用模拟器时明确披露未做真机视觉验收。

## 非目标

- 不改变 slash command 的 SDK 执行机制；`/compact`、`/init` 是否可执行由命令能力与发送路径单独治理。
- 不把 Host 上的原始 SDK message union 暴露给 Mobile。
- 不新增 transcript 数据库或由客户端解释 SDK 私有字段。
