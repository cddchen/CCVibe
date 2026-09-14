# 统一应用弹窗材质

状态：已实现并通过独立自动化验收，平台扩展场景待验收。2026-09-11 开始，2026-09-12 收敛；main，dirty 基线同 plan22，保留全部用户已有修改。

## 目标与证据

架构师补充：在加载最新 Metro 代码后，CUA 实测首页模型 picker 高度正常、加号玻璃透出消息，证据见独立验收截图；明确点击加号菜单权限入口后权限弹窗成功展示，取消后可继续点击。桌面 drag/scroll 未形成可靠列表位移证据，不能将改动前 XCTest 滚动基线算作改动后通过。深色/Reduce Transparency、Android/真机保留待验收。根 harness 已补材质 owner，AGENTS 已有平台规范无需更新。未提交代码。

应用自定义弹窗统一以选择模型弹窗为视觉基准，尤其加号命令菜单。iOS 支持时 Liquid Glass，旧 iOS blur、Reduce Transparency 实体降级，Android Material 3。

已核实 ChatScreen.ConfigChoiceSheet 使用 GlassPanel blurIntensity=82 / regular / elevation5 / extraLarge；ComposerCommandPopover 使用 forceSolid 强制实体，并使用 surfaceContainerLowest。HomeScreen picker 使用 GlassSurface 的同类玻璃参数。GlassPanel 是浮层阴影/材质 wrapper，BottomSheetFrame 是上一任务已修复的原生 Modal 生命周期 owner。置信度高。

## 实施与文件边界

开发者 Luna max 先做只读盘点全局自定义 Modal/sheet/portal；系统原生 Alert 不强行重写。计划22交接 ChatScreen 后才开始写入，父代理明确通知。负责 ChatScreen 的弹窗函数和样式、HomeScreen 的 picker、ui/glass 下窄共享 sheet surface（若确有必要）、相应视觉契约测试与本计划。不改 runtime、导航加载区、Markdown、版本、harness/AGENTS。不要为统一样式改变 BottomSheetFrame 关闭/入场生命周期。

消除加号 forceSolid 特例，复用模型选择的材质、圆角、间距、抓手/标题视觉规则，保留内容差异与有界高度、safe area、命令异步加载不塌陷。检查实体背景是否遮盖材质。优先共享小组件/参数避免多处漂移，不引入依赖。

## 验收

typecheck/lint/针对视觉与 sheet lifecycle 回归测试；iOS 签名 npm run ios 实际对比模型、加号、权限、首页 picker 截图，验证重复开关、加号转权限、关闭后滚动、深色与 Reduce Transparency。Android 保留 Material 并检查目标平台可用环境。主代理协调模拟器操作，复用已运行 Host，不调用模型。

交接后独立 Luna max 测试员核对 diff、自动化和平台证据并追加本计划。架构师收敛 harness；缺门禁不得写已完成。

## 开发者调研补充（2026-09-11）

- 只读盘点确认当前移动端自定义 Modal 入口只有 `BottomSheetFrame` 的两个调用 owner：`src/features/chat/ChatScreen.tsx` 的 `ComposerCommandPopover`、`ConfigChoiceSheet`、`ApprovalSheet`、`InputSheet`，以及 `src/features/home/HomeScreen.tsx` 的 `HomeChoiceSheet`。`Alert.alert` 只出现在 Chat/Connection 的系统原生告警路径，不纳入本任务材质统一。
- `ConfigChoiceSheet`、`ApprovalSheet`、`InputSheet` 已使用模型选择基准：`GlassPanel`、`blurIntensity={82}`、`glassEffectStyle="regular"`、Material elevation 5 / extraLarge。`ComposerCommandPopover` 原先通过 `forceSolid`、`solidColor` 和 `surfaceContainerLowest` 强制实体；`HomeChoiceSheet` 原先直接使用同参数的 `GlassSurface`。
- `GlassPanel` 外层默认样式包含 `flexShrink: 1` 与 `minHeight: 0`，内部 `GlassSurface` 继续承接 `pickerSheet` 的 `flexShrink: 1`、`maxHeight: '100%'`、`minHeight: 0` 和 `overflow: 'hidden'`。`BottomSheetFrame` 的 `pickerMotion.maxHeight='72%'` 未改变，因此首页 picker 仍有界且不会因 wrapper 替换塌陷；未增加 `containerStyle` 或修改共享生命周期。
- 主代理在 iOS 模拟器基线观察到加号命令菜单当前为纯白实体；另记录现有命令列表来自两个来源的 `/verify` 项共用 React key 的 warning。该 warning 与材质根因无关，本任务不扩大修复范围。

## 实现记录（开发者，2026-09-11）

- `repos/cloud-mobile/src/features/home/HomeScreen.tsx`：`HomeChoiceSheet` 从直接渲染 `GlassSurface` 改为共享 `GlassPanel`，采用模型选择基准的 `blurIntensity={82}`、iOS `regular`、Material elevation 5、extraLarge shape；workspace resolver、Host 选项、滚动内容、safe-area 及事件路径未改变。确认 `GlassPanel` 外层默认 `flexShrink: 1`/`minHeight: 0`，内部 `pickerSheet` 仍保留 `flexShrink: 1`、`maxHeight: '100%'`、`minHeight: 0`，外层 `pickerMotion.maxHeight='72%'` 不变，因此无需增加 `containerStyle`，不会把首页 picker 变成无界或塌陷布局。
- `repos/cloud-mobile/src/features/chat/ChatScreen.tsx`：仅在 `ComposerCommandPopover` 材质区段移除 `forceSolid`、`solidColor` 与 `surfaceContainerLowest` 特例，改为与 `ConfigChoiceSheet`/模型选择相同的 `GlassPanel` 玻璃参数；命令列表有界高度、safe-area bottom padding、异步加载 viewport 与 `BottomSheetFrame` 生命周期均保持不变。该文件同时保留任务 21/22 已有的交接与加载区改动，未重写共享文件。
- `repos/cloud-mobile/test/chatPopoverMotion.test.ts`：更新加号菜单视觉合同，锁定不再强制实体且使用 82/regular/elevation5/extraLarge；已有 scrim/panel/native dismissal 合同保留。
- 新增 `repos/cloud-mobile/test/homeGlassSheetDesign.test.ts`：锁定首页 picker 使用共享 `GlassPanel` 及 `GlassPanel` 外层 shrink contract，同时覆盖 72% 高度上限。未引入依赖，未修改 `BottomSheetMotion`、runtime、导航、Markdown、版本或 harness/AGENTS。

实现偏差：无。主代理观察到的 `/verify` duplicate React key warning 属于现有命令数据/列表 key 问题，与本次材质统一无直接因果，未扩大任务范围。

## 开发者验证记录（2026-09-11，Asia/Shanghai）

自动化已验证（执行目录 `/Users/cdd/Documents/ClaudeCodeRemote/CCVibe/repos/cloud-mobile`）：

- `npx vitest run test/homeGlassSheetDesign.test.ts test/chatPopoverMotion.test.ts test/sheetCoordinator.test.ts test/homeSessionRefresh.test.ts`：4 files / 14 tests 通过。
- `npm run lint`：通过。
- `npm test`：48 files / 212 tests 中 47 files / 210 tests 通过；2 个失败均来自任务 22 新增的 `test/chatSubscription.test.ts`，期望 `{ status: 'error', code: 'CLOSED' }`，当前实际为 `{ status: 'error', code: 'UNKNOWN' }`，与本次玻璃弹窗区段无关。
- `npm run typecheck`：未通过同一任务 22 基线错误：`test/chatSubscription.test.ts:34` fixture 缺少 `pendingApprovals`，TypeScript 报 `TS2741`；未修改该加载/测试路径。
- 目标文件 `git diff --check`：通过。全仓 `git diff --check` 仍报告任务 18 已有 `react-native-enriched-markdown+0.5.0.patch` 内嵌 unified diff 的 trailing whitespace，未触碰该文件。

真机/模拟器已验证：本开发者未操作模拟器；由主代理在交接后复测模型选择、加号菜单和首页 picker。尚未验证：本次改动对应的 iOS/Android 真实材质截图、深色模式、Reduce Transparency 和 Android 平台视觉。

交接给主代理：请在独立测试员可用时核对 `HomeChoiceSheet` wrapper 替换后的实际高度/滚动、加号菜单由纯白实体变为玻璃层、iOS 旧版本/Reduce Transparency 降级及 Android Material 3；并在平台复测后追加独立验收记录。根 `harness.md`/`AGENTS.md` 无需本开发者修改，待架构师依据最终平台证据收敛。

## 独立测试员验收记录（2026-09-11，Asia/Shanghai）

验收基线：`main`，仓库根目录 `/Users/cdd/Documents/ClaudeCodeRemote/CCVibe`；验收前后保留工作树全部已有修改。开发者已交接玻璃区段；验收期间 ChatScreen 曾有任务 22 的加载/投影区写入（mtime 从 22:41 更新至 22:51），因此先区分了该 diff，再在最新版本上重跑受影响测试。最近一次聚焦测试前后 `ChatScreen.tsx` 与 `HomeScreen.tsx` mtime 均未变化，未观察到同文件并发写入。

自动化已验证（执行目录 `/Users/cdd/Documents/ClaudeCodeRemote/CCVibe/repos/cloud-mobile`）：

- `npx vitest run test/homeGlassSheetDesign.test.ts test/chatPopoverMotion.test.ts test/sheetCoordinator.test.ts`：13/13 通过（22:48 首次、22:53 在最新 ChatScreen diff 上复跑）；日志 `/tmp/cloud-plan23-focused-rerun.log`。
- `npm test`：48 files / 214 tests 通过；日志 `/tmp/cloud-plan23-mobile-test.log`。
- `npm run typecheck`：通过；日志 `/tmp/cloud-plan23-typecheck.log`。
- `npm run lint`：通过；日志 `/tmp/cloud-plan23-lint.log`。
- 目标实现文件 `git diff --check`：通过；日志 `/tmp/cloud-plan23-diff-check.log`。全仓其他任务仍有既有 patch 尾随空白，不归因于本任务。

独立代码核对结论：`HomeChoiceSheet` 使用与模型选择相同的 `GlassPanel` 82/regular/elevation5/extraLarge；`pickerMotion.maxHeight='72%'`、内层 `flexShrink`/`minHeight`/`maxHeight='100%'`、`overflow='hidden'` 和 28pt 顶部圆角均保留，`GlassPanel` 外层提供 shrink/min-height contract。`ComposerCommandPopover` 已移除 `forceSolid`、`solidColor` 和 `surfaceContainerLowest`，并使用相同玻璃参数；命令列表仍有界且保留 safe-area padding。未改 `BottomSheetFrame` 生命周期；其新增 dismissal handoff 属于 plan21/任务 22 共享工作树，已由相邻 `sheetCoordinator`/motion 契约覆盖但不作为本任务实现变更归因。

真机/模拟器证据（主代理执行，本测试员只读核对）：主代理在签名 iOS Simulator/Metro 上提供并刷新代码后取得 `/tmp/cloud-permission-ui.qqE0Y4/task23-home-model-after.png` 与 `/tmp/cloud-permission-ui.qqE0Y4/task23-command-after.png`。我通过 `view_image` 核对到：首页模型 picker 展示 4 个选项且面板有界至屏幕底部，顶部圆角/抓手完整；加号面板下方会话内容可透出并保持列表 viewport，证明这两张截图支持“首页 picker 有界高度/圆角”和“加号不再强制纯白实体”的 iOS 视觉事实。截图只覆盖静态正常态，不能证明滚动、重复开关、加号转权限、关闭后拖动、深色或 Reduce Transparency。

尚未验证：本测试员未操作模拟器；主代理尚未在本记录中提供 iOS 加号转权限/关闭后滚动、深色/Reduce Transparency 或 Android Material 3 真实运行证据；真机也未验证。因此本计划不能仅凭本记录标记“已完成”。

结论：23 号范围未发现自动化阻断或需返工项；待主代理补齐平台证据后交架构师收敛。任务 22 的中间态变更及任何平台缺口不应误归因于本次玻璃统一。
