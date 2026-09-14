# iOS 加号菜单切换权限设置失效

## 状态与范围

2026-09-11，已实现并由主代理完成自动化与 iOS 原生验收；独立 Luna Max 测试子代理因账户用量限制连续两次无法启动，缺口如实保留。
目标：加号 → 权限设置稳定显示，取消/选择后会话可滑动；重复点击、关闭、重新打开不残留遮罩。
仅修改 Mobile 弹窗生命周期及必要测试，不改 Host 权限策略、Markdown、版本或连接存储。
分支 main；工作树已有版本、Markdown、设置/帮助、runtimeStore、harness 等改动，必须保留。

## 事实证据

- `ChatScreen.openPermissionPicker` 关闭 command sheet 后以 `BOTTOM_SHEET_DISMISS_MS + 16` 定时开启 ConfigChoiceSheet；时间不代表 UIKit 完成 dismiss。代码已证实，原生复现待验证。
- `BottomSheetFrame` 以另一计时器直接卸载 Modal，没有将 native dismiss 作为交接信号。iOS 底层 `Modal.js` 支持 `onDismiss`，由 native dismissal 事件触发。
- 两个 modal 的竞争属于 Mobile presentation owner，可能造成不可见 modal 拦截触摸，与用户报告一致；不能靠增加等待时间修复。
- `chatPopoverMotion.test.ts` 当前包含旧的样式断言（commandPopoverContainer/forceSolid），应先运行并记录基线，勿误归因于本次修改。

## 实施方案与所有权

开发者独占 `src/features/chat/ChatScreen.tsx`、必要的同域纯交接 helper、`src/ui/motion/BottomSheetMotion.tsx`、相关测试及本计划实现段。
优先以 native dismissal 回调交接权限面板，确保 Modal 本身保留到收到回调；Android 不依赖 iOS-only 回调，沿平台实际关闭语义明确处理。若共享 Modal 切换内容更简单，可提交证据并采用，但保留两层 backdrop/panel 与关闭语义。
取消 pending transition、快速重开、卸载必须使过期 dismiss 回调无效；重复点击不得打开多个弹窗。不得以增加 sleep/延时作为互斥保证。
检查 approval/input 相邻交接是否使用同类定时器；共享 lifecycle 改动应验证相关路径，避免无边界重构。
先写确定性失败回归，再实现；保留既有 Reanimated 动效、Reduce Motion、Host 下发权限及 canonical 配置。
测试员只读产品代码，可写相关测试与本计划验收段；架构师独占 harness/AGENTS。

## 验收

1. 加号 → 权限设置显示 Host 的选项；取消后消息列表可拖动，再次打开正常。
2. 选择权限提交既有配置路径；空列表/失败仍可关闭，不锁死页面。
3. 重复点击、关闭时重开、关闭完成前离开页面没有残留/延迟弹出；Reduce Motion 语义一致。
4. 确定性测试证明未收到关闭完成前不呈现下一 native modal，过期事件不复活面板；共享 frame 的正常关闭及其他调用方不回归。
5. Mobile 针对性测试、typecheck、lint；受影响 native 平台运行检查。iOS 先 health 复用 Host，在 mobile 执行 npm run ios，使用签名开发应用。尽力实际触摸复现和回归，记录截图/日志与工具缺口。不得宣称截图证明拖动通过。

## 实现记录

2026-09-11（开发者）：

- 实际修改 `repos/cloud-mobile/src/ui/motion/BottomSheetMotion.tsx`：`BottomSheetFrame` 不再用 `setTimeout` 猜测 Modal 已关闭。关闭时先卸载 panel/scrim，沿用既有 Reanimated `FadeOut`/`SlideOutDown` 250ms 退出；退出完成回调才将受控 `Modal` 的 `visible` 置为 `false`。iOS 依赖 RN 0.81 `Modal` 的 native `onDismiss`，Android 依赖受控 `visible=false` 提交后的平台语义；两者都通过可选 `onDismiss` 回调交接。native dismissal 完成前重新请求 show 会留在同一 Modal owner 内排队，不开启下一代 native presentation；过期退出回调、未完成关闭后的重开及组件卸载均被忽略，Reduce Motion 继续使用既有淡出路径，并保留 `latestChildren` 作为关闭帧内容。
- 追加修改同一文件：打开时先由 Modal 挂载独立 scrim，panel 仅在 scrim 的 Reanimated `FadeIn` UI-thread completion callback 经 `scheduleOnRN` 通知后挂载；因此 iOS Modal attach 首帧不会先绘出 panel 的最终布局。panel 不再使用 `enterDelayMs`，既有 300ms `SlideInDown`/Reduce Motion 淡入仍在 UI thread 执行；退出仍以 panel completion 与 native `onDismiss` 交接，不以新增计时器遮掩时序。
- 实际修改 `repos/cloud-mobile/src/features/chat/ChatScreen.tsx`：加号菜单的权限设置只设置 pending 标记，等 `ComposerCommandPopover` 的 native dismissal 回调后打开 `ConfigChoiceSheet`；取消、命令选择、重新打开和卸载都会清除 pending。approval/input 相邻 sheet 同样移除 `BOTTOM_SHEET_DISMISS_MS` 定时交接，保留当前 sheet kind 到 `BottomSheetFrame.onDismiss` 后再挂载下一种，避免两个 native Modal 重叠。
- 实际修改 `repos/cloud-mobile/test/chatPopoverMotion.test.ts` 与 `repos/cloud-mobile/test/sheetCoordinator.test.ts`：保留并更新旧 motion contract，新增 scrim completion 后才挂载 panel、无猜测 timer、退出完成、iOS/Android dismissal handoff、权限与 approval/input 交接的静态回归约束，以及 native dismissal gap 的 coordinator 断言。基线在实现前 `npx vitest run test/chatPopoverMotion.test.ts` 为 7/7；当前针对性测试为 `chatPopoverMotion.test.ts` 9/9 与 `sheetCoordinator.test.ts` 2/2（合计 11/11）。
- 偏差：最初草稿曾在 panel exit 开始时直接设 `Modal visible=false`，经架构审查改为“退出完成 → native dismiss”顺序，以保留现有动效；未引入新的 API/README 变更。共享 `BottomSheetFrame` 的 Home 调用方保留原有行为，仅获得相同的退出生命周期。
- 验证（自动化）：在 `repos/cloud-mobile` 执行 `npx vitest run test/chatPopoverMotion.test.ts test/sheetCoordinator.test.ts`，11/11 通过；`npm run typecheck` 通过；针对 `ChatScreen.tsx` 与 `BottomSheetMotion.tsx` 的 ESLint 通过。`git diff --check` 仅报告其他代理已有的 `repos/cloud-mobile/patches/react-native-enriched-markdown+0.5.0.patch` 尾随空白，未修改该文件。
- 验证（原生/模拟器）：待主代理在已运行的签名 iPhone 17 Pro XCTest runner 上执行重复加号→权限→取消/重选及关闭后拖动检查；开发者未启动、停止或管理模拟器/Host。
- harness 建议交由架构师收敛：补充事实“共享 `BottomSheetFrame` 的 Modal handoff owner 是 native dismissal；不得以退出时长替代关闭完成信号；Android 使用受控 `visible=false` 的实际关闭语义”，并保留本计划中的 RN 0.81 `Modal.js` 证据来源。

## 独立验证记录

2026-09-11：按 harness 两次派发独立 `cloud-tester`（Luna Max），两次均在初始化时返回 `You've hit your usage limit. Try again later.`，没有产生独立测试结论。主代理没有把下列结果表述为子代理验收。

- 自动化：主代理在 `repos/cloud-mobile` 重跑针对性测试，2 文件 11 项通过；`npm run typecheck`、`npm run lint` 通过；`npm test` 全量 46 文件 207 项通过。
- 原生功能：复用 `http://127.0.0.1:8787` 的现有 Host，以 `npm run ios` 构建签名 iPhone 17 Pro Simulator 应用，Xcode build 0 errors / 0 warnings。临时 XCTest runner 在真实历史会话连续三轮执行“加号 → 权限设置 → 关闭”，断言面板每次出现/消失、加号恢复可点击，并在结束后拖动 transcript、断言消息位置变化超过 40pt；结果 1/1 通过，证据为 `/tmp/cloud-permission-ui.qqE0Y4/entry-fixed.xcresult` 和 `entry-fixed.log`。修复后时间窗口没有 UIKit `already presenting` 日志。
- 原生动画：修复前 30fps 逐帧图 `/tmp/cloud-permission-ui.qqE0Y4/baseline-entry-frames.png` 显示权限 panel 在终点完整绘制约 100ms、消失后再上升；修复后 `/tmp/cloud-permission-ui.qqE0Y4/fixed-entry-frames.png` 显示 panel 从屏外到终点单调上升，无提前终态帧。录屏分别为 `entry-baseline-ready.mp4`、`entry-fixed.mp4`。
- 配置清理：用于 smoke 的会话权限在验证后恢复为原先的“自动接受编辑”；未调用真实模型或发送消息。
- 尚未验证：真机、Android 真实动画与 Reduce Motion 系统开关下的逐帧表现。共享实现的自动化与类型/lint 已覆盖，iOS 是本次报告问题与验收平台。

## 架构收敛

主代理审查通过并已将 bottom sheet owner、scrim/panel 入场顺序、native dismissal 交接与 motion cycle 约束收敛到根 `harness.md`。根 `AGENTS.md` 已有“backdrop 独立淡入、panel 随后进入”与平台实测规则，无需重复新增规范。产品修复满足用户报告路径；独立子代理门禁仍标记为未获得证据，不影响上述主代理自动化和 iOS 原生实测事实。
