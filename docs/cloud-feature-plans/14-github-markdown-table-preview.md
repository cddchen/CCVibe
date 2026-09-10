# GitHub Markdown 表格渲染预览

## 状态

待用户视觉复核（2026-09-09）。GitHub flavor 切换、合同测试、Mobile 全量门禁与 iOS Release Simulator 原生编译均已完成；模拟器因现有 Host Token/连接配置存储失败未能进入真实历史会话，表格视觉与选择限制等待用户在可连接环境查看。

## 目标、范围与非目标

- 仅把 `repos/cloud-mobile/src/features/chat/ChatScreen.tsx` 中已完成 assistant 的 `EnrichedMarkdownText` 从 `flavor="commonmark"` 改为 `flavor="github"`。
- 更新 `repos/cloud-mobile/test/enrichedMarkdownContract.test.ts`，将完成态渲染合同改为 GitHub flavor，并增加当前故障 Markdown 的合法 GFM 表格 fixture，防止再次退回不支持表格结构的 CommonMark 路径。
- 保留流式 assistant 的原生 `Text`、整段 raw Markdown 复制按钮、链接处理、现有 typography、依赖版本和 iOS package patch。
- **公式支持继续关闭**：`latexMath: false` 及 Expo/iOS/Android 原生开关均不得修改。
- 非目标：不调整表格字号、列宽、颜色或高度；不修改 Host/transcript；不预处理 Markdown；不声称 GitHub 容器支持跨表格边界连续拖选。

## 事实与取舍

- 当前 Markdown 原文是合法 GFM pipe table；`react-native-enriched-markdown@0.5.0` 的 CommonMark 单 `UITextView` 路径会解析 table AST，却没有 Table renderer，导致单元格文本扁平拼接并与后续标题共享段落。
- 库的公开类型明确将 `github` 定义为支持 tables/GFM extensions 的 container renderer。因此切换 flavor 是最小、可逆的观察方案。
- GitHub renderer 遇到表格会拆成前置文本、`TableContainerView`、后置文本；表格单元格当前是不可选的独立 `UITextView`。预期收益是正确表格结构，预期退化是无法从表格前跨到表格后连续选择。
- 当前分支为 `main`，工作树包含多个既有任务改动；开发与测试只能增加本计划范围内的差异，不得回退、覆盖或格式化无关文件。

## 角色与文件边界

### cloud-developer（gpt-5.6-luna / max）

允许修改：

- `repos/cloud-mobile/src/features/chat/ChatScreen.tsx`
- `repos/cloud-mobile/test/enrichedMarkdownContract.test.ts`
- 本计划的实现记录

要求：先修改合同并证明当前 CommonMark 基线失败，再做单行 flavor 切换；保留 `selectable` prop，但测试名称/断言不得继续声称是单一 selectable CommonMark 视图。运行 targeted test、typecheck、lint、`git diff --check`。

### cloud-tester（gpt-5.6-luna / max）

开发完成后串行验收。默认仅追加本计划验证记录；不得修改产品实现。核对变更边界、公式关闭、流式/复制合同和表格 fixture，并运行 targeted test、全量 Mobile test、typecheck、lint、双平台 bundle。原生/视觉证据单独披露。

## 验收条件

- 完成态 assistant 明确使用 `flavor="github"`，不再包含 `flavor="commonmark"`。
- 合法 GFM table fixture 保留表头分隔行、行列和后续 `##` 标题边界。
- `selectable`、`markdown={content}`、`md4cFlags={assistantMarkdownMd4cFlags}`、链接处理和整段复制保持。
- 流式消息仍走原生 selectable `Text`。
- 公式支持全链路保持关闭且不新增依赖。
- targeted、全量 test、typecheck、lint、iOS/Android bundle 通过；iOS 实际表格显示和选择限制需模拟器/真机截图验证，bundle 不替代原生验证。

## 实现记录

### cloud-developer（2026-09-09）

- 先修改 `repos/cloud-mobile/test/enrichedMarkdownContract.test.ts`：完成态合同改为要求 `flavor="github"` 并拒绝 `flavor="commonmark"`；加入与 `/Users/cdd/Downloads/error_display.md` 同构的三列表格 fixture，保留表头分隔行、五个数据行以及后续 `## 你作为用户会感觉到的缺口` 标题边界。测试名称改为通用 Markdown 合同，没有声称 GitHub renderer 是单一可连续选择视图。
- 在实现前运行 `repos/cloud-mobile` 的 `npx vitest run test/enrichedMarkdownContract.test.ts`：基线 10 项中 9 项通过、1 项失败；唯一失败为源码尚未包含 `flavor="github"`，证明当前 CommonMark 路径不满足新合同。
- 仅修改 `repos/cloud-mobile/src/features/chat/ChatScreen.tsx` 完成态 `EnrichedMarkdownText` 的一行 flavor 切换：`commonmark` → `github`。保留 `selectable`、`markdown={content}`、`md4cFlags={assistantMarkdownMd4cFlags}`、链接回调、整段 raw copy、现有 typography、流式原生 `Text`、依赖和 package patch；`latexMath: false` 及 Expo/iOS/Android 公式关闭配置未改动。
- 本次无方案偏差；未修改 Host、transcript、Markdown 预处理、表格样式/尺寸、依赖或原生开关，也未宣称表格前后可连续拖选。
- 自动化自测：targeted contract `10/10` 通过；`npm run typecheck` 通过；`npm run lint` 通过；`git diff --check` 通过。
- 模拟器/真机尚未在本开发阶段执行；GitHub 表格实际视觉、表格单元格选择限制及跨表格边界选择交由独立 `cloud-tester` 按计划验收。
- harness 建议事实（由架构师收敛）：完成态 assistant 当前使用 GitHub flavor，GFM 表格走 container renderer，不能据此承诺跨表格连续选择；来源为 `ChatScreen.tsx`、`enrichedMarkdownContract.test.ts`、本计划事实段及安装包公开 flavor 类型/renderer 行为。本开发者未修改共享 `harness.md`/`AGENTS.md`。

## 验证记录

### cloud-tester 独立验收（2026-09-09，gpt-5.6-luna / max）

结论：**需补证据，不建议当前收敛为通过**。完成态 renderer、合同和自动化门禁均通过；但计划要求的真实 iOS GFM 表格视觉与表格选择边界仍没有可用 Host/session 证据，Android 原生编译也受环境限制。验收期间 `ChatScreen.tsx` 与合同测试的 mtime 保持交接值（分别为 `20:34:14 +0800`、`20:34:48 +0800`），未发现同文件写入；本记录是本测试员拥有的唯一追加区段。

执行环境与范围：仓库 `/Users/cdd/Documents/ClaudeCodeRemote/CCVibe`，Mobile 命令目录 `/Users/cdd/Documents/ClaudeCodeRemote/CCVibe/repos/cloud-mobile`，分支 `main`；Node `v26.8.1`、npm `11.19.0`、Xcode `26.6`、iOS `26.5` SDK。工作树已有改动全部保留，未执行 `git add`、commit、push、PR 或发布。

自动化已验证：

- `npm exec vitest -- run test/enrichedMarkdownContract.test.ts`：`10/10` 通过；证据 `/tmp/ccvibe-gfm-targeted-20260909.log`。
- `npm test`：`44` 个文件、`194` 个测试通过；证据 `/tmp/ccvibe-gfm-fulltest-20260909.log`。
- `npm run typecheck`、`npm run lint`：均通过；证据 `/tmp/ccvibe-gfm-typecheck-20260909.log`、`/tmp/ccvibe-gfm-lint-20260909.log`。
- `npm run bundle:ios`、`npm run bundle:android`：均通过；证据 `/tmp/ccvibe-gfm-bundle-ios-20260909.log`、`/tmp/ccvibe-gfm-bundle-android-20260909.log`。两者只证明 JS/Hermes 导出，不证明原生安装或表格显示。
- `git diff --check`：通过；证据 `/tmp/ccvibe-gfm-diffcheck-20260909.log`。

实现合同独立核对：

- `ChatScreen.tsx` 完成态明确为 `flavor="github"`，源码不再含 `flavor="commonmark"`；`selectable`、`markdown={content}`、`md4cFlags={assistantMarkdownMd4cFlags}`、链接回调、整段 raw copy 均保留。`turn.status !== 'complete'` 仍走原生 selectable `Text` 流式路径。
- `githubTableMarkdownFixture` 保留三列表头、`|---|---|---|` 分隔行、五个数据行、空行和后续 `## 你作为用户会感觉到的缺口` 边界；测试未声称单一 CommonMark 视图或跨表格连续选择。
- 依赖仍精确为 `react-native-enriched-markdown@0.5.0`，未新增 `katex`；`node_modules/katex` 及 lockfile 安装条目不存在。JS `latexMath: false`、Expo `enableMath: false`、iOS `ENRICHED_MARKDOWN_ENABLE_MATH='0'`、Android `enrichedMarkdown.enableMath=false` 均核对为关闭；Pod/Gradle 未发现实际 iosMath/AndroidMath 依赖（配置注释中的名称不代表安装依赖）。
- 已安装包的当前 `.d.ts` 将 `flavor` 定义为 `'commonmark' | 'github'`，并将 `github` 描述为支持 tables 的 container renderer；这与实现 owner 和计划事实一致。

真机/模拟器已验证：

- iOS Simulator 原生 Release 编译通过：
  `xcodebuild -workspace ios/Cloud.xcworkspace -scheme Cloud -configuration Release -sdk iphonesimulator -derivedDataPath /tmp/ccvibe-cloud-sim-build-gfm-20260909 CODE_SIGNING_ALLOWED=NO build`，日志 `/tmp/ccvibe-gfm-ios-release-build-20260909.log`，末尾为 `** BUILD SUCCEEDED **`，产物为 `/tmp/ccvibe-cloud-sim-build-gfm-20260909/Build/Products/Release-iphonesimulator/Cloud.app`。
- 使用独立 iPhone 17 Pro Simulator（iOS 26.5）安装并启动产物成功；启动截图 `/tmp/ccvibe-gfm-ios-launch-20260909.png` 显示 Cloud Host 列表。当前没有可安全使用的 Host/session，未进入聊天，因此**未验证** GFM 表格实际排版、表格单元格选择限制、表格前后跨边界选择或 native copy/link 手势。

尚未验证/环境缺口：

- Android 原生 `./gradlew :app:assembleDebug --no-daemon` 未进入编译，系统报 `Unable to locate a Java Runtime`；日志 `/tmp/ccvibe-gfm-android-debug-build-20260909.log`。Android bundle 通过不能替代此证据。
- iOS Simulator/真机的真实 GFM 表格截图、表格内选择及跨表格边界选择仍需架构师提供已连接 Host/session 后复验；本次不调用真实模型、不构造伪 transcript，也不把 Home 启动画面推断为聊天通过。

文档漂移回报（不修改共享文档）：根 `harness.md` Cloud 事实索引当前仍称完成态 assistant 为 selectable CommonMark 单文本视图；当前 `ChatScreen.tsx` 已使用 GitHub container renderer。该描述应由架构师在本计划证据收敛后更新，且保留“不可承诺跨表格连续选择”的限制。

## 架构师收敛（2026-09-09）

- 已把根 `harness.md` 的完成态 Markdown 事实更新为 GitHub container renderer，并明确表格单元格不可选、不能承诺跨表格连续选区；`AGENTS.md` 的 owner/平台规则没有变化，无需新增稳定规则。
- 主代理另以当前源码在 iPhone 16 Pro / iOS 18.4 Release Simulator 重新构建成功，结果 `** BUILD SUCCEEDED **`，产物为 `/tmp/ccvibe-cloud-sim-build-github-20260909/Build/Products/Release-iphonesimulator/Cloud.app`。安装/启动成功，但该模拟器的 SecureStore/连接配置读写失败，无法进入表格所在历史 session；不把 Host 列表画面计作视觉通过。
- 实现范围已经完成并可供用户构建查看；计划保留“待用户视觉复核”，不把尚无截图证据的 GFM table 排版标记为已验收。
