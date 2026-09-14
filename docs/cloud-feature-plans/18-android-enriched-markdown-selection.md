# Android Markdown 任意选区与复制

## 状态

实现完成；自动化、可复现 patch 和 Android 原生构建通过，真实设备拖选/复制 smoke 待补。

## 目标、范围与非目标

恢复 Android 已完成 assistant Markdown 的原生长按选词、拖动选区与复制能力，并保留粗体、链接、inline/fenced code、GitHub 表格和现有整段复制按钮。iOS 行为及样式不回退。

非目标：不切回 `react-native-markdown-display`，不使用 WebView，不用 JS `onLongPress` 整段复制冒充原生任意选区，不升级 `react-native-enriched-markdown@0.5.0`，不扩大表格/独立 block view 跨段选区能力，不开启公式支持。

## 当前分支与基线

- 2026-09-10 调研时分支为 `main`，工作树干净。
- 完成态 assistant 使用精确固定的 `react-native-enriched-markdown@0.5.0`、`flavor="github"`、`selectable`；流式 assistant 仍使用 React Native `Text selectable`。
- 公式支持保持全链路关闭：`latexMath: false`、iOS Podfile flag 与 Android Gradle property 均不得改变。

## 根因与事实证据

| 事实 | owner | 证据 | 置信度 | 动作 |
| --- | --- | --- | --- | --- |
| JS 已传 `selectable`，Android manager 也调用 `setTextIsSelectable(true)` | Mobile renderer integration / Android native view | `ChatScreen.tsx`；安装包 `EnrichedMarkdownTextManager.kt`、`TextViewSetup.kt` | 高 | 不在 JS 再加一层长按 handler |
| 0.5.0 的 `LinkLongPressMovementMethod` 继承 `LinkMovementMethod`，并在 `ACTION_DOWN`、`ACTION_UP`、`ACTION_CANCEL` 主动 `Selection.removeSelection`；这与 Android `Editor` 的系统选区 owner 冲突，会清掉或破坏长按选区 | package Android native movement method | `node_modules/.../LinkLongPressMovementMethod.kt` | 高 | 把已合并上游修复最小回移到现有 package patch |
| 上游 PR #583 将 movement method 改为 `ArrowKeyMovementMethod`，禁止修改系统 Selection spans，并按触点显式派发 link tap；官方说明这是 `selectable` 长按根因修复 | upstream primary source | `software-mansion/enriched-markdown#580`、PR `#583`、当前 1.0.2 源码 | 高 | 以 0.5.0 API 为边界回移，不整包升级 |
| GitHub flavor 会把表格等 block 拆为多个原生 view；Android 系统选区不能跨 sibling view | upstream API reference + 0.5.0 `splitASTIntoSegments()` | 官方 `docs/API_REFERENCE.md`、安装包 `MarkdownSegment.kt` | 高 | 承诺普通连续文本 view 内任意选区；表格/独立 block 仍按原生 view 边界处理并保留整段复制 |

## 方案与文件边界

### cloud-developer（gpt-5.6-luna / max）

允许修改：

- `repos/cloud-mobile/patches/react-native-enriched-markdown+0.5.0.patch`
- `repos/cloud-mobile/test/enrichedMarkdownContract.test.ts`，必要时新增一个聚焦 Android selection 的测试文件
- 本计划的实现记录与开发自测记录

禁止修改：依赖版本、`ChatScreen.tsx` Markdown flavor/样式、iOS 既有 patch 语义、设置页、Host、协议、公式开关、任务 19/20 计划。

实施要求：

1. 先补失败合同，证明 0.5.0 patch 必须包含 Android `LinkLongPressMovementMethod.kt`，基类为 `ArrowKeyMovementMethod`，且新增代码不得调用 `Selection.removeSelection`。
2. 回移上游 PR #583 的最小机制：保存按下 link、按触点判断按下/抬起是否同一 link、保留 link long press/滑动取消/spoiler 行为；普通文本手势交回 `ArrowKeyMovementMethod` 与平台 `Editor`。
3. 重新生成或严谨扩展 patch 时必须保留当前 5 个 iOS patch 文件和所有 nested code / inline geometry hunks；用干净的 0.5.0 tarball 验证 patch 可应用。
4. 不把 `node_modules` 或 Android build 产物作为交付文件。

### cloud-tester（gpt-5.6-luna / max）

开发交接后独立、串行验收。默认只修改本计划验证记录；若合同缺失可补测试，不得改产品实现。核对上游修复语义、patch 可复现性、link/spoiler 保留及 Android 原生编译。

## 验收条件

- Android 普通完成态 Markdown 长按一个词会出现原生 selection handles/menu，拖动可跨普通/粗体/link/inline code 选择并复制实际片段；抬手后选区不被立即清除。
- 普通 link 点击与长按行为无回退；选择手势不触发 link 导航。
- GitHub table/独立 block 的原生 view 边界限制被诚实保留，不阻塞普通正文任意选区；整段 assistant 复制按钮仍可用。
- iOS Markdown、GitHub 表格、nested fenced code、inline code geometry 与公式关闭合同保持通过。
- `npm run postinstall`、聚焦测试、typecheck、lint、全量 test、双平台 bundle 通过；Android 原生至少完成 Gradle compile/build。若无 Android 设备/AVD，长按拖选必须列为尚未实测，不能由静态合同代替。
- `git diff --check` 与目标 diff 审核完成，无关变更保持原样。

## 实现记录

2026-09-10，cloud-developer 已完成最小 package patch，实际改动范围如下：

- `repos/cloud-mobile/patches/react-native-enriched-markdown+0.5.0.patch`：保留原有 5 个 iOS Markdown patch 文件，并新增唯一的 Android 源文件 hunk：`android/src/main/java/com/swmansion/enriched/markdown/utils/text/view/LinkLongPressMovementMethod.kt`。
- `repos/cloud-mobile/test/enrichedMarkdownContract.test.ts`：先加入 Android 选择合同，再实现 patch；合同锁定 `ArrowKeyMovementMethod` 基类、按下/抬起的同一 `LinkSpan` 判断、空白区域 hit-test，以及新增逻辑不得导入或调用 `Selection.removeSelection`。

关键行为：

- Android `LinkLongPressMovementMethod` 从 `LinkMovementMethod` 改为 `ArrowKeyMovementMethod`，把普通文本长按、拖动选区交回 `setTextIsSelectable(true)` 安装的系统 `Editor`。
- link tap/long-press 仍由 movement method 处理；仅在按下和抬起命中同一个 link 时调用 `LinkSpan.onClick`，移动超出 touch slop 时取消 link 长按；spoiler tap 与连续 spoiler 展开逻辑保留。
- 删除所有主动清理 Selection spans 的路径，避免与 Android 原生选区 owner 竞争；表格/sibling block 的跨 view 选区边界、整段复制按钮、iOS patch、GitHub flavor 和公式关闭均未改变。
- 未升级 `react-native-enriched-markdown@0.5.0`，未修改 `ChatScreen.tsx`、设置页、Host 或公式配置。

偏差与注意：

- 计划要求的“可复现 patch”已通过从全新 0.5.0 npm tarball 应用；最终 patch 只有 6 个 source diff header（5 个 iOS + 1 个 Android Kotlin），没有 `android/build`、`.cxx`、intermediates、dex/class/bin 等生成物。
- 计划所引用的上游 PR #583 机制以当前 1.0.2 npm 源码对照回移；未整包升级，因 0.5.0 API/表格行为仍需保持。
- 当前只维护本计划开发段；根 `harness.md` 与共享 `AGENTS.md` 不在开发者写入范围，待独立测试员和架构师根据平台证据收敛。

## 验证记录

开发者自测（2026-09-10，`/Users/cdd/Documents/ClaudeCodeRemote/CCVibe/repos/cloud-mobile`）：

- 通过：`npx vitest run test/enrichedMarkdownContract.test.ts`，13 tests passed。
- 通过：`npm run postinstall`，`patch-package` 从 0.5.0 安装包应用 6 文件 patch 成功。
- 通过：独立 clean 0.5.0 tarball + `patch-package --patch-dir` 复现应用；patch parser 解析 6 个文件成功。
- 通过：`npm run typecheck`。
- 通过：`npm run lint`。
- 通过：`npm test`，45 files / 201 tests passed。
- 通过：`npm run bundle:ios`、`npm run bundle:android`。这些只证明 JS/Hermes 导出，不等同 Android 原生编译。
- 未通过/未执行：`./gradlew :app:compileDebugKotlin --no-daemon --stacktrace` 无法启动，当前机器没有 Java Runtime（终端返回 `Unable to locate a Java Runtime`）；因此没有声称 Android Gradle 原生编译通过。
- 部分：`git diff --check` 报告 package patch 内嵌 unified diff 的空格上下文行；这些空格是 inner hunk 的合法上下文，直接删除会破坏 patch hunk，且原有 iOS patch 也采用同一格式。Android patch 本身没有生成物或额外路径。计划要求的“无关变更保持原样”已通过目标 diff/header 审核核对。
- 尚未验证：Android 真机/模拟器的长按出选区、拖动跨粗体/link/inline code、复制内容、link tap/long-press 与 spoiler tap；也未验证表格 sibling view 的边界行为。需在有 JDK 且可运行 Android 设备/AVD 的独立 tester 环境验收。

## 独立验收记录

2026-09-10（Asia/Shanghai），`main`，macOS 26.6.2 arm64。验收开始时确认开发交接后的 package patch（10:54）与合同测试（10:34）在本轮没有再次写入；共享工作树另有设置页/帮助任务文件，均未修改。

### 自动化、源码与可复现性（已验证）

- 静态 diff 审核确认 `react-native-enriched-markdown+0.5.0.patch` 只有 6 个 `diff --git` 源文件：既有 5 个 iOS 文件，以及唯一的 Android `LinkLongPressMovementMethod.kt`；没有 Android build、`.cxx`、intermediates、class、jar 或其他生成物路径。
- `npm run postinstall`（目录 `repos/cloud-mobile`）通过，`patch-package 8.0.1` 应用 `react-native-enriched-markdown@0.5.0` 成功；`npx vitest run test/enrichedMarkdownContract.test.ts` 通过，13 tests passed。
- 使用全新 `react-native-enriched-markdown@0.5.0` npm tarball 和临时 project/package-lock，在临时目录执行 `patch-package --patch-dir patches` 成功应用 6 文件 patch。应用后的 Android Kotlin 文件与 `react-native-enriched-markdown@1.0.2` tarball 中同路径文件字节一致，证明回移的 PR #583 最终语义没有漂移。
- 从 GitHub PR #583（已于 2026-07-27 合并）的最终 diff 独立核对：基类为 `ArrowKeyMovementMethod`；按下/抬起保存并比较同一 `LinkSpan`；普通文本交回平台 `Editor`；没有新增 `Selection.removeSelection` / `LinkMovementMethod`。应用文件仍保留 `onLongClick`、spoiler 连续展开、touch-slop 取消和空白 hit-test。
- `npm run lint` 通过；`npm test` 通过，46 files / 204 tests；`npm run bundle:ios` 与 `npm run bundle:android` 均通过。bundle 仅是 JS/Hermes 证据，不作为 Android 原生交互证据。
- 使用计划指定临时环境 `JAVA_HOME=/opt/homebrew/Cellar/openjdk@17/17.0.20.1/libexec/openjdk.jdk/Contents/Home`、`ANDROID_SDK_ROOT=/opt/homebrew/share/android-commandlinetools`，在 `repos/cloud-mobile/android` 执行 `./gradlew :react-native-enriched-markdown:compileDebugKotlin --rerun-tasks --no-daemon --console=plain`，退出码 0；随后执行 `./gradlew :app:assembleDebug --no-daemon --console=plain`，退出码 0，`BUILD SUCCESSFUL`。日志证据：`/tmp/cloud-android-markdown-compile.XXXXXX.log`（包 Kotlin 编译）；Gradle 终端记录（app assemble）。仅出现依赖已有 deprecated warnings。
- 公式关闭和 iOS 既有合同保持不变：`test/enrichedMarkdownContract.test.ts` 13 项通过，`ChatScreen.tsx` 仍为 `flavor="github"`、`latexMath: false`，iOS Podfile 与 Android `enrichedMarkdown.enableMath=false` 未改。

### 阻断、平台交互与 diff（尚未完全通过）

- `npm run typecheck` 首次运行时曾被共享工作树任务 20 的 `src/features/connection/ConnectionScreen.tsx:311` 阻断：当时 Expo Router 生成类型尚未包含新增 `/help` 路由；该文件属于设置/帮助任务，非任务 18，未修改或用临时断言绕过。iOS/Android bundle 生成包含 `/help` 的 `.expo/types/router.d.ts` 后，独立重跑 `npm run typecheck` 通过；任务 18 文件在补跑期间未写入。
- `git diff --check` 仅报告新增 package patch 内嵌 unified diff 的标准空格上下文行（Android hunk 行 276、289、303、307、311、317、326、335、358、368、383、387、390、429）；排除该嵌套 patch 文件后通过。去除这些空格会破坏 patch 格式，故未改写 package patch 以隐藏告警。
- 当前 `/opt/homebrew/share/android-commandlinetools/platform-tools/adb devices -l` 无设备，SDK 未安装 emulator binary，`emulator -list-avds` 无法执行；没有 Android 真机/模拟器。因此尚未验证真实长按出选区、拖动跨普通/粗体/link/inline code、复制结果、link tap/long-press 不导航、spoiler tap，以及表格 sibling view 边界。不能用静态合同或 Gradle 成功替代这些交互证据。
- 未发现任务 18 产品返工项；自动化、干净 tarball patch、Android Kotlin/Debug APK 原生编译均通过。Android 交互仍因无设备/AVD 未验证，交回架构师决定是否在真实设备补验后最终收敛；测试员不将静态合同或 Gradle 成功描述为真实长按复制通过。

## 架构师收敛

2026-09-10：接受 package owner 与原生编译结论，不把它表述为 Android 真机交互已通过。根 `harness.md` 已补充 Android movement method/系统 Selection 的持久 owner，以及真实设备 smoke 缺口；公式关闭和 GitHub 分段边界保持不变。待具备 Android 真机或 AVD 后，按本计划验收条件补测长按、跨样式拖选、复制、link/spoiler 与表格边界，再将状态收敛为完全完成。
