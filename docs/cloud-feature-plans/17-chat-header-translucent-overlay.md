# 会话 Header 液态玻璃悬浮层

## 状态

已验收（2026-09-10，自动化/原生门禁通过；长会话视觉仍需人工补验）。任务 2 已按任务 1 交接后独立实施；测试员已串行核对当前工作树。

## 目标、范围与非目标

让会话页标题区域成为覆盖在消息列表上方的固定 chrome：iOS 26 使用现有 Liquid Glass 时能看到/折射其下滚动的消息，旧 iOS 使用系统 blur，Reduce Transparency 使用同尺寸实体表面；Android 保持 Material 3 顶栏语义。首条消息、状态 banner、返回/更多按钮、safe area 和滚动指示器不能因覆盖布局被遮挡。

非目标：不新增玻璃依赖，不修改 `GlassSurface` 能力判断，不给 Android 伪造 Apple blur，不改变会话状态/协议/消息数据，不增加新的滚动动画，不顺手重构整个 `ChatScreen`。

## 当前分支与已有改动

- 分支：`main`，工作树包含大量 staged 用户变更；本任务只追加自己的增量，不 reset、重排、stage 或覆盖其他任务。
- `ChatScreen.tsx` 当前已经使用 `GlassSurface`，但“使用组件”不等于“后方存在可采样内容”。
- 首页参考为 `HomeScreen.tsx` 的 `home-compact-header`；该参考仅用于布局/材质层级，不复制首页标题动效。

## 根因与事实证据

| 事实 | owner | 文件/符号 | 置信度 | 动作 |
| --- | --- | --- | --- | --- |
| 当前 Chat Header 位于普通 flex 流中且在 `FlatList` 前，列表 viewport 从 Header 下方开始；玻璃背后只有纯背景 | Mobile Chat layout | `ChatScreen.tsx` 当前 return tree | 高 | transcript 全屏铺底，Header 改为后渲染的 absolute overlay |
| 首页 compact Header 有半透明效果的关键是 full-screen list + absolute/zIndex overlay + absoluteFill material | Mobile Home layout | `HomeScreen.tsx` 的 `home-compact-header` | 高 | 复用同一层级模式，不仅复制 blur 参数 |
| BlurView 对动态列表内容的 backdrop 更新还依赖挂载/绘制顺序 | iOS material integration | 现有 Expo blur 使用约束 + 首页实现 | 中高 | JSX 先渲染 transcript，后渲染 top chrome，同时保留 zIndex |
| `GlassSurface` 已集中处理 Liquid Glass、旧 iOS blur、Reduce Transparency/测试实体降级和 Android Material | shared UI | `src/ui/glass/GlassSurface.tsx`、capability tests | 高 | 不新造材质、不改平台判定 |
| 状态/错误 banner 当前也在 transcript 前的普通流中；Header 单独 absolute 后会遮挡或继续缩短 viewport | Mobile Chat layout | `ChatScreen.tsx` header 后的 banner branches | 高 | 将 header + banners 组成 absolute top-chrome stack，测量总高并作为列表内容 inset |

## 方案与文件边界

### cloud-developer（gpt-5.6-luna / max）

允许修改：

- `repos/cloud-mobile/src/features/chat/ChatScreen.tsx`
- 新建或修改一个聚焦 Header 布局的 `repos/cloud-mobile/test/*.test.ts`
- 本计划的实现记录、状态和开发自测记录

禁止修改：`GlassSurface`/`GlassPanel` 能力实现、Home 页面、Host、协议、Markdown package patch 与任务 1 计划。

实施要求：

1. 先写失败的布局合同，证明当前 Header 仍占普通流、列表没有 top content inset。
2. 在同一 flex 父容器中先渲染 `ChatTranscript`，再渲染 absolute top-chrome。Header 按首页拆为 absoluteFill `GlassSurface` 材质层、正常交互内容层和底部 hairline；不能只给现有节点加透明背景。
3. top chrome 使用 `top/left/right: 0` 和明确覆盖顺序；header 内容层用 `paddingTop: insets.top`，44pt 返回/更多按钮和现有标题截断保持。
4. status/subscribe/chat error banners 纳入 top-chrome stack 或等价的可证明方案；用 `onLayout` 测量 Header + 可见 banners 总高，把该值传给 `ChatTranscript` 的 `contentContainerStyle.paddingTop`。禁止给 FlatList 本体加 `marginTop` 或外部 spacer，因为那会让 viewport 仍停在 Header 下方。
5. iOS 显式避免系统再次自动叠加 top inset，并同步 scroll indicator top inset；初始测量前用 safe-area + Header 内容高度的稳定 fallback，动态字体/错误 banner 出现消失后重新收敛。
6. Android 继续由 `GlassSurface` 走 Material 3 surface/elevation/shape；布局可覆盖消息，但材质保持实体，不添加 blur hack。

### cloud-tester（gpt-5.6-luna / max）

开发交接后独立、串行验收。默认只修改本计划验证记录；若缺失合同，可只改本任务测试，不得改产品实现。检查 JSX 绘制顺序、absolute overlay、动态 top inset、safe area、滚动指示器、材质降级与性能，并完成真实 iOS Simulator 视觉 smoke。

## 验收条件

- 长会话首次打开时首条内容完整出现在 top chrome 下方，不被 Header/banners 遮挡。
- 上滑后消息真实进入固定 Header 背后；iOS 26 Liquid Glass 能看到/折射下方内容，Header 不随列表滚动，返回/更多按钮始终可用。
- Header 在 JSX 中晚于 transcript 渲染，并以 absolute overlay 覆盖；列表 viewport 全屏，顶部避让来自 `contentContainerStyle.paddingTop`，不是 FlatList margin/spacer。
- status、subscribe error、chat operation error 任意出现/消失时，top inset 与 stack 高度同步，无重叠、跳到不可读位置或首条遮挡。
- 刘海/状态栏、旋转、Dynamic Type 基本路径和 scroll indicator top inset 正确；交互目标继续至少 44pt。
- iOS 26 能力可用时走 Liquid Glass；旧 iOS 走 `systemThinMaterial` blur；Reduce Transparency、测试或模块失败时同几何转实体；Android 为 Material 3，未引入 Apple blur。
- `npm run typecheck`、`npm run lint`、相关静态合同、`npm test`、双平台 bundle 通过；iOS 原生 build/install 通过。Android 原生能力按环境单独披露。
- 真实 iOS Simulator 按 harness：复用已有 `127.0.0.1:8787` Host，在 `repos/cloud-mobile` 执行 `npm run ios`；保留截图或明确可复核的观察记录。未签名产物不算连接 smoke。
- `git diff --check` 通过，无关用户变更保持原样。

## 实现记录

### cloud-developer（2026-09-10）

- 先新增失败合同 `repos/cloud-mobile/test/chatHeaderOverlayContract.test.ts`，锁定 transcript 先渲染、top chrome 后渲染、absolute overlay、动态 top inset、iOS 自动 inset 关闭和 scroll indicator inset。
- 修改 `repos/cloud-mobile/src/features/chat/ChatScreen.tsx`：消息列表先铺满父容器；Header、连接状态 banner、subscribe error 与 chat operation error 组成后渲染的 `chat-top-chrome` absolute overlay。沿用 `GlassSurface` 的 Liquid Glass/旧 iOS blur/实体降级及 Android Material 3 路径，材质层使用 absolute-fill，交互内容与 hairline 独立分层。
- 通过 top chrome `onLayout` 测量可见堆叠高度，以 safe-area + 52pt header fallback 初始化，并把测量值作为 `ChatTranscript` `contentContainerStyle.paddingTop`；FlatList 使用 `contentInsetAdjustmentBehavior="never"` 和相同 top scroll indicator inset。notice toast 跟随测量后的 chrome 底部，避免覆盖 banner。
- 偏差/限制：本次没有修改 `GlassSurface`、Home、Host、协议、Markdown patch 或任务 16；动态字体/旋转和 banner 变化仍需独立测试员在模拟器复核。
- 开发自测（`repos/cloud-mobile`）：`npx vitest run test/chatHeaderOverlayContract.test.ts` 通过（3 tests）；`npm run typecheck` 通过；`npm run lint` 通过；`git diff --check -- src/features/chat/ChatScreen.tsx test/chatHeaderOverlayContract.test.ts` 通过。
- 原生 smoke：执行 `curl -fsS http://127.0.0.1:8787/health` 返回 `{"status":"ok","protocolVersions":["1.0.0"]}`，复用现有 Host；随后执行 `npm run ios`，iPhone 17 Pro（iOS 26.5）原生 build/install/open 成功并启动 Metro。当前未声称长会话视觉验收，交由独立 cloud-tester。

## 验证记录

### cloud-tester（2026-09-10，Luna Max，独立验收）

执行目录：`/Users/cdd/Documents/ClaudeCodeRemote/CCVibe/repos/cloud-mobile`；当前分支：`main`；工作树基线包含用户已有 staged 变更及任务 1 的并行增量，测试员未回退、stage 或覆盖其他文件。

自动化与静态合同：

- `npx vitest run test/chatHeaderOverlayContract.test.ts`：通过，3 tests。
- `npm run typecheck`：通过，退出码 0。
- `npm run lint`：通过，退出码 0。
- `npm test`：通过，45 test files / 199 tests。
- `npm run bundle:ios`：通过，iOS Hermes bundle 导出到 `dist`。
- `npm run bundle:android`：通过，Android Hermes bundle 导出到 `dist`。
- `git diff --check -- src/features/chat/ChatScreen.tsx test/chatHeaderOverlayContract.test.ts docs/cloud-feature-plans/17-chat-header-translucent-overlay.md`：通过。全工作树 `git diff --check` 仍报告任务 1 `react-native-enriched-markdown+0.5.0.patch` 中 patch-package 统一 diff 的空上下文行尾空格；该告警不属于任务 2 文件，未修改任务 1 patch。

代码审核结论：`ChatTranscript` 在 JSX 中先于 `chat-top-chrome` 渲染；列表自身没有 `marginTop`/外部 spacer，顶部避让来自 `contentContainerStyle.paddingTop`；`contentInsetAdjustmentBehavior="never"` 和 `scrollIndicatorInsets` 同步使用测量 inset。top chrome 使用 `top/left/right: 0`、独立 absolute-fill `GlassSurface` 材质层、内容层和 hairline，`onLayout` 测量 Header 与可见 status/subscribe/chat-operation banners 的总高度，并以 `insets.top + 52` 作为首帧 fallback；返回和更多按钮继续为 44pt。`GlassSurface`、Home 和平台能力判定未被改动，因此 iOS 26/旧 iOS/Reduce Transparency/测试实体降级及 Android Material 3 路径仍由既有实现负责。未发现需要返工的代码合同问题。

Host/native smoke：

- `curl -fsS http://127.0.0.1:8787/health`：通过，返回 `{"status":"ok","protocolVersions":["1.0.0"]}`；复用现有 Host PID 8150，未重启或停止。
- 开发者交接中已在本目录执行正常 `npm run ios`；测试员独立确认该命令对应的 `expo run:ios` 进程仍在运行（PID 99203），booted `iPhone 17 Pro`（iOS 26.5）已安装并启动 `com.ccvibe.cloud`，未使用 `CODE_SIGNING_ALLOWED=NO`。独立截图证据：`/tmp/ccvibe-chat-header-test/current.png`；这证明原生开发应用可启动，但不替代下述会话页视觉验收。

尚未覆盖的实机/模拟器视觉路径：

- 当前模拟器停留在首页；用现有长会话 deep link 触发了系统“在 Cloud 中打开？”确认框，但当前环境没有可用的 Simulator UI 自动化/辅助功能权限，无法可靠点击“打开”进入会话页。因此未伪称已验证消息进入 Header 背后、Liquid Glass 折射、首条消息不遮挡、滚动后 Header 固定以及返回/更多按钮可用。
- status/subscribe/chat-operation banner 的动态出现/消失、旋转、Dynamic Type、长消息滚动均未完成视觉操作验证；源码合同和自动化已覆盖静态布局关系，需后续人工在可交互模拟器或真机补验。

## 架构师收敛

2026-09-10：独立验收未发现需要返工的代码合同问题。本任务复用了既有 `GlassSurface` 平台材质与降级边界，没有形成新的跨任务 owner 或全局规则，因此不修改根 `harness.md`；absolute overlay、动态 top inset 和视觉人工补验等任务细节留在本计划。
