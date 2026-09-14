# 会话立即进入与加载提示

状态：已实现并通过独立自动化验收，平台扩展场景待验收。2026-09-11 开始，2026-09-12 收敛；main，工作树包含版本、Markdown、设置页及 plan21 弹窗修复等用户已有改动，全部保留。

## 目标与事实

### 架构师最终补充（2026-09-12）

签名 `npm run ios -- --device …` 原生构建成功，复用已有 `http://127.0.0.1:8787` Host。最终空态修复后重新录制 `/tmp/cloud-permission-ui.qqE0Y4/task22-empty-fix.mp4`，逐 0.05 秒抽帧 `/tmp/cloud-permission-ui.qqE0Y4/task22-empty-detail.png`：26.5 秒开始原生进入，26.55–27.0 秒显示标题与上方同步条；27.05–27.2 秒保持同步空态；27.25 秒正文出现，没有再观察到“等待你的第一条消息”闪帧。这是普通本机连接开发模拟器证据，不能证明真实弱网或 release 性能。

自动化与其余平台缺口以文末独立验收记录为准；真实弱网、无动画/首次深链、Android 设备等仍待验证，因此不将完整计划标为已完成。持久事实已更新根 harness；现有 AGENTS 约束已覆盖职责与动效，无需追加规则。未提交代码。

- 点击历史会话立即呈现页面框架，在顶部展示真实的拉取/同步状态；弱网、失败可返回、可重试，已有正文不清空。
- 已核实：首页 HomeScreen.openChat 直接 router.push，没有等待网络；app/chat/[chatId].tsx 挂载即 subscribeChat；runtimeStore.subscribeChat 只有成功/失败，无请求中状态。ChatScreen 挂载即投影完整历史，需继续测量首帧重计算与原生 Markdown 渲染对导航的影响。置信度：以上源码高，性能瓶颈待实测。
- owner 是客户端导航、订阅展示与渲染调度；不改变 Host 协议或业务权威，不用固定延时掩盖竞态。

## 实施与所有权

开发者 Luna max，先核对 AGENTS/harness/类型/相邻重连路径。负责 app/chat/[chatId].tsx、src/features/chat/ChatScreen.tsx 的导航加载相关区段、同域新增 helper/hook、runtimeStore.ts、必要 selector/sync 文件及相应测试、本计划实现记录。不得修改弹窗函数/样式或 BottomSheetMotion；不得写 harness/AGENTS、版本、Markdown patch。

先添加 deferred 网络响应的行为回归：请求 pending 可见，成功消失，失败重试恢复，旧请求/路由切换不会污染新会话。调查并最小减少首次重投影/长历史挂载阻塞；采用实际原生导航完成信号或合理可取消调度，不能任意 sleep。路由无需等待请求。新提示条纳入已有 topChrome 测量，空历史不误判加载；保留 last-known-good。避免重复订阅及卸载后的陈旧状态。

## 验收

针对测试、typecheck、lint；若触及 sync/runtime 跑全量 test 与双平台 bundle。签名 npm run ios 复用已有 Host，正常/人为延迟响应时录屏确认导航先于数据、顶部提示、失败重试和返回、长历史；不得调用模型。平台证据由主代理协调，同一模拟器不并发操作。

开发交接稳定后独立 Luna max 测试员只读产品代码，验收并追加本计划。架构师最终收敛 harness。未验证项明确保留，不标完成。

## 开发者实施记录（2026-09-11，Luna max）

状态：待验收。保留本工作树已有版本、Markdown、设置页、弹窗/动效等改动；本次只追加会话入口加载、订阅生命周期、投影调度及回归测试。

### 实际变更

- `repos/cloud-mobile/src/features/runtime/runtimeStore.ts`：新增按 `chatUri` 的 `chatSubscriptions`（loading/ready/error）状态；`subscribeChat` 发布请求中状态、按 URI 合并并发请求、失败后保留可重试错误；通过连接生命周期 generation 和当前 route URI 隔离旧 Host/旧路由完成回调；断开、Host 切换、连接重连转场时清理 pending 状态，旧请求不能回写新连接。断开只将 sync 标为 idle 并保留 last-known-good resources，下一次 attach 再用 Host snapshot 替换，避免断线时正文闪空。
- `repos/cloud-mobile/app/chat/[chatId].tsx`：路由先直接挂载 `ChatScreen`，仅在 Host 真实进入 connected 后发起订阅，并在重连回到 connected 时再次触发；不等待网络请求阻塞 native navigation。
- `repos/cloud-mobile/src/features/chat/ChatScreen.tsx`：使用 per-chat 订阅状态在顶部显示可访问的“正在从 Host 同步会话”提示，失败沿用真实错误码与重试，已有 snapshot 不清空；首次及 URI 切换先保留真实 catalog 标题的轻量 loading projection，收到 route 的 native-stack `transitionEnd` 后再通过可取消的下一帧投影长历史，避免把整段 transcript 重算放进原生转场期间。未改弹窗行为/样式区段。
- `repos/cloud-mobile/src/features/chat/chatTranscript.ts`、`repos/cloud-mobile/test/chatTranscript.test.ts`：修复 deferred turns 仍为空但当前 turns 已有历史时短暂显示“等待你的第一条消息”的首正文闪烁；真实空会话、pending turn 和失败态继续使用各自状态。纯 helper 回归覆盖该竞争窗口。
- `repos/cloud-mobile/app/chat/[chatId].tsx`：在 layout effect 中监听已安装 `@react-navigation/native-stack` 的 typed `transitionEnd`（源码证据：`NativeStackView.native.tsx` 的 `onAppear`/`onDisappear` 发出该事件，包括无动画的 native appear 路径），并保持 route 级完成标记不随同一 screen 的 `chatId` 参数更新清零；仅用于通知 ChatScreen 可以开始 transcript projection。网络订阅仍可在 route 立即挂载后并行开始。
- `repos/cloud-mobile/src/features/runtime/CloudRuntimeProvider.tsx`：selector/frame-selector cache 同时核对 selector/equality identity，修复 route 改变但 runtime state identity 不变时仍返回旧 chat projection 的问题。
- `repos/cloud-mobile/test/chatSubscription.test.ts`：新增 deferred subscribe 的 pending→ready、并发去重、失败重试、旧 route 隔离、断开后 generation fencing，以及 reconnect fresh snapshot 清理旧 subscribe error 的回归。
- `repos/cloud-mobile/test/chatPerformanceContract.test.ts`：增加 selector cache、transitionEnd 后可取消首帧 projection、layout listener/route 级完成标记与 route 立即挂载契约检查。

### 偏差与事实建议

- 计划中的“加载提示”原有 `ChatViewModel.status === 'loading'` 只能覆盖 catalog 已知但 chat snapshot 尚未到达，不能表示实际 subscribe RPC pending；因此补充 Runtime per-chat 状态，而未扩展 Host 协议或客户端业务权威。
- 连接 supervisor 的订阅 API 无取消句柄；本实现以连接 generation、flight 去重和 stale route gate 防止旧 Promise 回写，网络请求本身仍由 supervisor/transport 负责收尾。
- React Native 当前 `disableInteractionManager` 默认值为 `true`（源码：`Libraries/Interaction/InteractionManager.js`），因此没有把 `InteractionManager.runAfterInteractions` 当作导航完成信号；当前完成事实来自已安装 native-stack 的 typed `transitionEnd` listener，事件后的首帧调度只用于让事件返回并可在 route 变化时取消。真实首帧/弱网/长历史录屏仍由主代理在签名模拟器执行。
- 建议 harness 后续记录：Chat route 立即挂载；chat subscription loading/error 由 Runtime per-chat projection 提供；连接 transition 清理旧 lifecycle；route-scoped selector 必须校验 selector identity。来源为本次实现源码、回归测试和以下命令结果。

### 自动化验证

- 已先运行失败回归（3 tests failed，缺失 `chatSubscriptions`，证明 pending contract 未实现），再完成最小实现。
- `npx vitest run test/chatSubscription.test.ts test/chatPerformanceContract.test.ts test/chatRuntime.test.ts test/runtimeFlow.test.ts`：通过（24 tests，含 reconnect/Host replacement generation fencing、fresh snapshot 清理旧 subscribe error 与 transitionEnd route contract）。
- `npx vitest run test/chatTranscript.test.ts test/chatPerformanceContract.test.ts test/chatSubscription.test.ts test/chatRuntime.test.ts test/runtimeFlow.test.ts`：通过（27 tests，另含 deferred transcript 首正文空态回归）。
- `npm run typecheck`：通过（最新实现）。
- `npm run lint`：通过（最新实现）。
- 尚未由开发者运行包级全量 `npm test`、双平台 bundle；尚未进行真机/模拟器验证，等待独立测试员与主代理交接验收。

## 独立测试员验收记录（2026-09-11，Asia/Shanghai）

交接后只读核对产品代码与当前工作树，未修改实现；开发者已在本记录前完成 `shouldShowDeferredTranscriptLoading` 最小修复并稳定交接。本节仅追加测试员证据，不改写上方开发者实施记录的历史快照。

### 源码与边界核对

- 已安装 `@react-navigation/native-stack@7.18.10` 的 `NativeStackView.native.tsx` 中，`onAppear`/`onDisappear` 分别发出 typed `transitionEnd`（`closing: false/true`）；路由在 `useLayoutEffect` 注册该事件，`navigation.isFocused()` 过滤非当前路由，`navigationReadyRef` 保留同一 native screen 的 `chatId` 参数更新完成标记。当前没有用 `InteractionManager` 冒充 native 动画完成。
- `runtimeStore` 与回归测试覆盖 pending/deferred、success、error/retry、并发去重、旧 route 隔离、断线 generation fencing、旧 Host/重连 fresh snapshot 清理旧 subscribe error；`CloudRuntimeProvider` 的 selector/frame-selector cache 校验 selector/equality identity；`requestAnimationFrame`/`cancelAnimationFrame` 仅作 transitionEnd 后可取消的投影调度。
- 无动画、首次深链且已 focus 时错过 `transitionEnd`、同 route 参数切换的真实原生运行路径尚未独立实测。源码对同屏参数更新保留完成标记，但没有额外的“未收到事件”兜底；因此不能仅凭 bundle 或源码宣称这些路径不会永久 loading。

### 自动化验证

命令目录：`/Users/cdd/Documents/ClaudeCodeRemote/CCVibe/repos/cloud-mobile`；环境：macOS 26.6.2 (25G83)、Node `v26.8.1`、npm `11.19.0`、Vitest `3.2.7`。

- 修复后窄回归：`npx vitest run test/chatTranscript.test.ts test/chatSubscription.test.ts test/chatPerformanceContract.test.ts test/chatRuntime.test.ts test/runtimeFlow.test.ts`，5 files / 27 tests 通过（23:53:27）。
- 修复后 `npm run typecheck` 通过；`npm run lint` 通过。
- 修复前 runtime 最小修复交接后已独立跑过包级 `npm test`：48 files / 218 tests 全部通过（23:38:59）；该全量数字未在最后的空态 helper 落盘后重复执行，窄回归覆盖受影响 helper 与 chat/render/runtime 路径。
- 空态 helper 落盘后补跑双平台 JS bundle：`npm run bundle:ios` 通过（1752 modules，`dist/_expo/static/js/ios/entry-f266eac345a7f152d5d810758ae9ab28.hbc`）；`npm run bundle:android` 通过（1740 modules，`dist/_expo/static/js/android/entry-a81bd3d0e39360cc999a047dd5fd8d5e.hbc`）。bundle 只证明 JS/Hermes 导出，不等于原生构建或设备通过。
- 相关文件 `git diff --check` 无新增 whitespace 错误；工作树其他既有 `react-native-enriched-markdown` patch 的 whitespace 问题未修改。

### 平台证据与未覆盖项

- 主代理提供的签名 iOS Simulator、普通网络点击录屏 `/tmp/cloud-permission-ui.qqE0Y4/task22-entry-final.mp4` 及帧图 `/tmp/cloud-permission-ui.qqE0Y4/task22-entry-detail.png`：24.5s 左右开始 native push，24.6–25.0s 先出现标题/同步条，约 25.2s 出现历史正文，支持“先 native 框架、后历史投影”的普通网络事实。帧图约 25.1s 曾短暂显示“等待你的第一条消息”；该现象与 deferred turns/新 idle status 竞态一致，已由本次 helper 修复针对性处理，但修复后尚未重新录屏。测试员未操作模拟器。
- 尚未验证：弱网/人为延迟 RPC、真实 subscribe error/retry、断线重连与旧 Host、无动画、首次深链、同 route 参数切换、Android 真实运行、物理真机，以及 iOS/Android 原生构建。当前不能把 bundle 或普通网络录屏表述为这些场景已通过。

结论：自动化与 bundle 门禁已通过，普通网络 iOS Simulator 录屏提供有限顺序证据；因上述原生/弱网覆盖缺口及修复后未重录，建议本计划仍保持待架构师最终收敛，不标记为“已完成”。
