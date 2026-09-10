# Enriched Markdown 排版与列表内代码块修复

## 状态

已完成（2026-09-09，第四轮）。用户复核确认 fenced code block 纵向高度仍过大；架构师在 iPhone 16 Pro / iOS 18.4 Release Simulator 的同一真实历史 session 重新复现并验证修复。上一轮 marker/缩进修复继续保留，本轮由 Luna Max 开发者只收敛 code block 的纵向密度，独立 Luna Max 测试已通过。

## 目标

在保留已完成 assistant 消息的原生跨样式拖动选区与任意片段复制能力的前提下：

- 恢复接近迁移前的正文、列表与代码排版密度；
- 修复 iOS 列表项内 fenced code block 背景提前包住上一行、项目符号渗入代码块、行高异常的问题；
- 让单反引号 inline code 与正文使用一致的字号和基线，不再出现小字配高背景的视觉错位；
- 继续保留 CommonMark、仅完成态 assistant 使用原生 Markdown、流式路径和整段复制按钮；
- **继续关闭公式支持**：`latexMath: false`、Expo `enableMath: false`、iOS/Android 原生开关均不得回退。

## 范围与非目标

范围：`repos/cloud-mobile` 的 Enriched Markdown 依赖版本、assistant Markdown 样式映射、契约测试、iOS Pods 锁定结果和本计划记录。

非目标：不修改 Host/transcript；不预处理或重写模型返回的 Markdown；不切换到 GitHub flavor；不为此任务开启数学公式；不修改流式消息；不新增自研 `UITextView`/Markdown parser；不直接提交 `node_modules` 或 `Pods` 源文件。若稳定版与 RN 0.81 不兼容，允许通过 `patch-package` 维护可复现的第三方包级最小补丁。

## 当前分支与已有改动

- 分支：`main`。
- 工作树已有多项用户/其他任务改动，包含 `ChatScreen.tsx`、Mobile package/lock、Podfile/Podfile.lock、app.json、Android 配置以及 Host 文件；实现必须只做本计划所需的增量，禁止回退、覆盖或格式化无关差异。
- 问题截图：`/Users/cdd/Downloads/IMG_ACB7B5D02B2D-1.jpeg`。
- 截图对应真实 Markdown 已从本机 Claude transcript 核对：异常内容是列表项中缩进的 fenced `json` / `text` code block，而不是一段普通 inline code。

## 事实证据

| 事实 | owner | 证据入口 | 置信度 | 动作 |
| --- | --- | --- | --- | --- |
| 完成态 assistant 由一个 selectable CommonMark 原生文本视图渲染 | Mobile | `ChatScreen.tsx` 的 `MarkdownAnswer`；`test/enrichedMarkdownContract.test.ts` | 高 | 保留，不回退选择/复制能力 |
| 历史精确版本 `0.4.1` 会在 iOS 列表项结束时把 list paragraph style 覆盖到内部 code block | 第三方 iOS renderer | 安装包 `ios/renderer/ListItemRenderer.m`；上游提交 `98208183a2ceb0090c825aa6843c9fc9ffd70cdd` / PR #174 | 高 | 已升级并保留回归 fixture |
| 稳定版 `0.5.0` 支持 RN `0.81`–`0.84` 且包含 PR #174，但对列表边界 code range 的单点检查仍不完整；完整官方根因修复在不兼容的 1.0.x | 第三方 package/release | npm `react-native-enriched-markdown@0.5.0`；上游 `b60d2e4` / PR #478；真实模拟器 | 高 | 精确固定 `0.5.0`，用可复现 package patch 回移所需范围/缩进逻辑 |
| 当前 inline code 强制 `Menlo/monospace 14`，正文为 16/25；库默认可继承父 block 字号并使用系统等宽字体 | Mobile style + 第三方 renderer | `ChatScreen.tsx` 的 `code`；安装包 `normalizeMarkdownStyle.ts`、iOS `CodeRenderer.m` | 高 | 删除 inline code 的显式 `fontFamily`/`fontSize`，保留颜色、背景和边框 |
| 数学公式不是本次选择/排版目标，且会扩大 iosMath/AndroidMath 原生依赖与验证面 | Mobile/native config | `assistantMarkdownMd4cFlags`、`app.json`、`ios/Podfile`、`android/gradle.properties` | 高 | 所有关闭开关继续显式存在 |

## 方案与取舍

采用精确 `0.5.0` 配合上游 `b60d2e4` 的最小 `patch-package` 回移，而不是升级到 RN 0.81 未声明支持的 1.0.x 或在业务层重写 Markdown：

1. 将 `react-native-enriched-markdown` 从精确 `0.4.1` 升到精确 `0.5.0`，同步 npm lock 和 CocoaPods lock。
2. 保持 `flavor="commonmark"` 和一个原生文本视图，避免 GitHub flavor 把 fenced code block 拆成独立 block view 后失去跨块选区。
3. inline code 只覆盖主题色、背景色和边框色；字号与字体交给库按父 block 继承并选择系统等宽字体，使 16pt 正文、列表与 inline code 基线一致。
4. 正文、列表维持既有 16/25 排版合同；`patches/react-native-enriched-markdown+0.5.0.patch` 回移上游 list/code-block `skipRanges` 修复，阻止 list 的 25pt paragraph style 覆盖 code block 的 13/20 样式。
5. 不隐藏代码背景、不把长 inline code 改写为 fenced block，也不在客户端改写 Markdown 语义；补丁只改第三方 iOS renderer 的样式覆盖范围。

备选但不采用：升级 1.0.2。它虽包含 `b60d2e4`，但官方兼容表未声明 RN 0.81，且本项目 iOS Expo 配置阶段实际出现 `EnrichedMarkdownTextNativeComponent` 模块解析失败；承担该版本的 Expo 配置迁移与兼容风险不符合当前最小范围。

## 实施顺序与文件边界

### `cloud-developer`（gpt-5.6-luna / max）

允许修改：

- `repos/cloud-mobile/package.json`
- `repos/cloud-mobile/package-lock.json`
- `repos/cloud-mobile/ios/Podfile.lock`
- `repos/cloud-mobile/patches/react-native-enriched-markdown+0.5.0.patch`
- `repos/cloud-mobile/ios/Podfile`、`repos/cloud-mobile/android/gradle.properties`（仅公式关闭注释版本号）
- `repos/cloud-mobile/src/features/chat/ChatScreen.tsx`
- `repos/cloud-mobile/test/enrichedMarkdownContract.test.ts`
- 本计划的“实现记录”与状态

实施：

1. 先扩充/修改契约测试，使当前 `0.4.1` 和强制 inline `Menlo 14` 的基线失败；fixture 必须覆盖“列表项 + fenced json/text code block”与 inline code。
2. 精确升级依赖到 `0.5.0`，用仓库允许的安装方式更新 lock；运行 `pod install` 更新 `Podfile.lock`，不得开启数学公式依赖。
3. 调整 inline code style，保留主题颜色但移除显式字体族和 14pt 字号；不要改 code block 的 13/20 样式、正文/列表 16/25 样式或 assistant 渲染分支。
4. 运行针对性测试、typecheck、lint、双平台 bundle、iOS Simulator 原生构建；Android 无 Java 时记录环境缺口，不伪称已原生验证。
5. 将实际改动、偏差、命令结果和未验证项追加到本计划；不得修改 harness/AGENTS。

### `cloud-tester`（gpt-5.6-luna / max）

开发交接后串行开始。默认只修改本计划“验证记录”；若发现缺失的行为测试，可仅修改 `repos/cloud-mobile/test/enrichedMarkdownContract.test.ts`，不得改产品实现。

独立核对：依赖稳定版确含上游修复、公式仍关闭、CommonMark/完成态/流式/整段复制合同未漂移、inline code 未再强制小号字体，以及 iOS 列表内 fenced block 的真实显示。

## 验收条目

- iOS：截图同类 Markdown 中，每个列表项只出现自己的一个 marker；fenced code block 背景不覆盖前一行或相邻列表项，代码内容不再逐行出现 marker。
- iOS：正文/列表保持 16pt、25pt leading；代码块保持 13pt、20pt leading；inline code 与父级正文/列表继承同字号，背景高度和 baseline 不再明显突出或下沉。
- iOS：仍可从一个段落拖动选区跨越粗体、链接、列表和代码样式并复制任意片段；整段复制按钮仍复制 raw Markdown。
- Android：JS bundle 与类型合同通过；具备 Java/SDK 时原生构建通过，并确认无样式回归。
- `react-native-enriched-markdown` 为精确稳定版本，不使用 caret/tilde/nightly/git URL。
- 公式支持保持关闭：`md4cFlags.latexMath === false`、Expo plugin `enableMath === false`、iOS/Android 原生开关仍为 false；不得新增 `katex`、iosMath 或 AndroidMath 依赖。
- Mobile `typecheck`、相关测试、全量 `test`、`lint`、`bundle:ios`、`bundle:android` 通过；iOS Simulator 原生 build 通过。
- `git diff --check` 通过；保留工作树中所有无关既有改动。

## 实现记录

### cloud-developer（2026-09-09）

- 先扩充 `test/enrichedMarkdownContract.test.ts`：加入列表项内 `json` / `text` fenced code 与 inline code fixture，并把依赖版本和 inline code 字体继承作为失败契约；在实现前确认基线为 2 项失败（仍为 `0.4.1`、仍强制 `Menlo/monospace 14`）。
- `repos/cloud-mobile/package.json` 与 `package-lock.json` 精确升级 `react-native-enriched-markdown` 到 `0.5.0`；lock 保持 npm registry tarball，未引入 `katex`（其仅作为可选 peer 出现在包元数据中）。
- `ios/Podfile.lock` 经 `pod install --no-repo-update` 更新为 `ReactNativeEnrichedMarkdown (0.5.0)`；未修改 Podfile、Android 配置或其他越界文件。0.5.0 上游 `ListItemRenderer` 已对 `CodeBlockAttributeName` 做保护，避免列表 paragraph style 覆盖嵌套 fenced code block。
- `ChatScreen.tsx` 删除 inline code 的显式 `fontFamily` 与 `fontSize: 14`，保留主题颜色；由库的 native inheritance sentinel 使用父 paragraph/list 字号和平台系统等宽字体。完成态仍使用 selectable CommonMark 单文本视图，流式路径、整段 raw Markdown 复制和 `latexMath: false` 未变；本次未开启公式支持。
- 计划外既有差异均保留；未修改 `harness.md`、`AGENTS.md`、Host、`app.json` 或第三方源文件。按架构师补充要求，仅将 `Podfile`/`gradle.properties` 中公式关闭注释的依赖版本从 `0.4.1` 校正为 `0.5.0`，开关值未变。

## 验证记录

### 开发者自测（2026-09-09）

自动化已验证：

- `repos/cloud-mobile`: `npx vitest run test/enrichedMarkdownContract.test.ts`，先失败后通过；最终 7 tests passed。
- `repos/cloud-mobile`: `npm run typecheck` 通过。
- `repos/cloud-mobile`: `npm run lint` 通过。
- `repos/cloud-mobile`: `npm test` 通过，44 个文件 / 191 个测试。
- `repos/cloud-mobile`: `npm run bundle:ios` 与 `npm run bundle:android` 均通过。
- `repos/cloud-mobile/ios`: `pod install --no-repo-update` 通过并锁定 0.5.0；`git diff --check` 通过。
- 公式关闭核对通过：JS `md4cFlags.latexMath === false`；现有 Expo/iOS/Android 开关仍为 false；`package-lock.json` 未安装 `katex`，没有 iosMath/AndroidMath pod/dependency。

模拟器/真机已验证：

- iOS Simulator 原生 Release build 通过：`xcodebuild -workspace Cloud.xcworkspace -scheme Cloud -configuration Release -sdk iphonesimulator -derivedDataPath /tmp/ccvibe-cloud-sim-build CODE_SIGNING_ALLOWED=NO build`，结果 `** BUILD SUCCEEDED **`。本轮尚未在模拟器中执行真实 transcript 的拖动选区或截图对比。

尚未验证：

- Android 原生 Gradle build：`./gradlew :app:assembleDebug` 因系统无 Java Runtime 退出，未进入编译。
- 独立 `cloud-tester` 验收，以及 iOS 真机/模拟器上列表内 fenced code、inline code baseline 和跨样式复制的视觉/交互证据。

### cloud-tester 独立验收（2026-09-09，gpt-5.6-luna / max）

结论：**需返工/补证据**。当前自动化与 iOS Release Simulator 编译证据通过；但本机模拟器无法读取已保存 Host Token，未能安全进入历史 session 展示真实 nested fenced Markdown，因此不能把视觉排版、拖动选区或任意片段复制标记为已验收。此结论是证据缺口，不判定当前产品实现已经失败。

自动化已验证（执行目录均为 `/Users/cdd/Documents/ClaudeCodeRemote/CCVibe/repos/cloud-mobile`，日期为 2026-09-09，Xcode 26.6 / iOS 26.5 SDK）：

- `npm exec vitest -- run test/enrichedMarkdownContract.test.ts`：7/7 通过；`npm test`：44 个文件 / 191 个测试通过。日志：`/tmp/ccvibe-markdown-targeted-20260909.log`、`/tmp/ccvibe-markdown-fulltest-20260909.log`。
- `npm run typecheck`、`npm run lint`：通过。日志：`/tmp/ccvibe-markdown-typecheck-20260909.log`、`/tmp/ccvibe-markdown-lint-20260909.log`。
- `npm run bundle:ios`、`npm run bundle:android`：通过；bundle 只作为 JS 导出证据，不替代原生运行验证。日志：`/tmp/ccvibe-markdown-bundle-ios-20260909.log`、`/tmp/ccvibe-markdown-bundle-android-20260909.log`。
- `npx expo config --json` 实际解析 `react-native-enriched-markdown` plugin 的 `enableMath` 为 `false`；`node_modules/katex` 不存在；iOS Pods 无 iosMath、Android 配置无 AndroidMath 依赖。日志：`/tmp/ccvibe-markdown-expo-config-20260909.log`。
- `git diff --check`：通过，日志：`/tmp/ccvibe-markdown-diffcheck-20260909.log`。

源码/合同独立核对：安装包 `repos/cloud-mobile/node_modules/react-native-enriched-markdown/package.json` 为 `0.5.0`，README 声明支持 RN `0.81`；iOS `ListItemRenderer.m:110-118` 与 `:176-182` 通过 `CodeBlockAttributeName` 跳过 fenced code block 样式覆盖；`ChatScreen.tsx:615-617` 仅 completed assistant 走 Markdown，`:750-758` 保持 CommonMark、单 `EnrichedMarkdownText`、selectable、流式分支和整段 raw copy，`:721` 明确 `latexMath:false`。

模拟器/真机已验证：

- iOS 26.5 Simulator Release 原生构建通过：`xcodebuild -workspace Cloud.xcworkspace -scheme Cloud -configuration Release -sdk iphonesimulator -derivedDataPath /tmp/ccvibe-cloud-sim-build-20260909 CODE_SIGNING_ALLOWED=NO build`，证据日志 `/tmp/ccvibe-markdown-ios-release-build-20260909.log`，产物 `/tmp/ccvibe-cloud-sim-build-20260909/Build/Products/Release-iphonesimulator/Cloud.app`。已安装并启动 iPhone 17 Pro；界面显示 `连接配置读取失败，请稍后重试`，未进入聊天。

尚未验证/环境缺口：

- iOS Simulator 中真实列表项 + `json`/`text` fenced code、inline code 的行高/背景/marker 视觉，以及跨粗体、链接、代码样式拖动选择和复制：未验证，不能以静态契约或原生编译替代；截图证据仅为启动/连接失败画面 `/tmp/ccvibe-cloud-ios26-launch-20260909.png`。
- Android 原生 Gradle：`android/gradlew :app:assembleDebug --no-daemon` 因系统无 Java Runtime 退出（`Unable to locate a Java Runtime`），日志 `/tmp/ccvibe-markdown-android-debug-build-20260909.log`；未进入编译。
- 发现文档漂移但未修改产品文件：`ios/Podfile:1-2` 与 `android/gradle.properties:40-41` 的公式关闭注释仍写 `react-native-enriched-markdown@0.4.1`，实际锁定/安装版本为 `0.5.0`。开关值本身已核对为关闭。

## 收敛记录

已收敛到根 `harness.md` 的“完成态 assistant Markdown”事实入口，记录 exact dependency、完成态/流式边界、公式关闭和 iOS package patch owner。该任务没有改变 Cloud owner/协议边界，因此无需修改根 `AGENTS.md`；现有 `AGENTS.md` 差异属于其他任务并保持不动。

## 后续视觉验收返工记录（2026-09-09）

架构师在已连接真实 Host/session 的 iPhone 16 Pro / iOS 18.4 模拟器发现：`0.5.0` 已修复列表 paragraph style 覆盖 fenced block 的一部分问题，但当结构为有序列表 `2.` → 无序子项 `-` → 缩进 fenced `json`/`text` 时，代码块首尾仍可出现 list marker，背景后还会产生空 bullet。该证据说明当前 `ListItemRenderer.m` 的“按当前 `ListDepthAttribute` segment 起点单点检查 `CodeBlockAttributeName`”不足以保护边界换行。

上游源码核对：稳定 `0.5.0` / `0.7.4` 仍使用该单点检查；上游提交 `b60d2e4`（`fix: better list children rendering logic (#478)`，进入 `1.0.0` 之后）改为先收集整个 `CodeBlockAttributeName` 和 nested-list ranges，再只对剩余 gap 应用 list paragraph/marker 属性。这是与当前截图现象直接对应的官方根因修复。已验证稳定 `1.0.2` 在本项目 RN `0.81.5` 的兼容/构建风险后，选择以 package-level patch 回移该最小根因修复，不在业务层预处理 Markdown。

## 返工决策与实现记录（cloud-developer，2026-09-09）

- 已先验证稳定 `1.0.2`：虽然包含上游 `b60d2e4` 的 `skipRanges`，但官方 compatibility table 未声明支持本项目 RN `0.81.5`；iOS 原生配置阶段还出现 `lib/module/EnrichedMarkdownTextNativeComponent` 模块解析失败。因此不承担 1.0.x 的 RN 兼容与 Expo 配置迁移风险，回到精确 `0.5.0`。
- 采用上游同一 `skipRanges` 根因修复的最小 package patch：`patches/react-native-enriched-markdown+0.5.0.patch` 仅改第三方 iOS `ListItemRenderer.m`，收集完整 fenced code 与 nested-list attributed ranges，按排序后的范围只给剩余 gap 应用 list paragraph style；没有业务层 Markdown 预处理、自研 renderer 或改动 Android renderer。
- `package.json` 增加精确 `patch-package@8.0.1` 与 `postinstall: patch-package`，`package-lock.json` 已锁定；已通过 `patch-package --reverse` 后执行 `npm run postinstall` 验证补丁可重新应用。补丁文件由安装包 `0.5.0` 生成，不能脱离版本漂移使用。
- `test/enrichedMarkdownContract.test.ts` 增加有序列表 → 无序子列表 → `json`/`text` fenced block 前后边界 fixture，以及补丁存在性/`skipRanges`/postinstall 契约；测试明确保留 completed-only selectable CommonMark、流式/整段复制路径与 `latexMath: false`。
- 公式支持继续关闭：`katex` 为可选 peer 但未安装，JS/Expo/iOS/Android 开关保持 false；未开启代码高亮或其它 1.0.x 新能力。

## 返工验证记录（cloud-developer，2026-09-09）

自动化已验证：

- `npx vitest run test/enrichedMarkdownContract.test.ts`：8/8 通过；新增契约覆盖 `patch-package` postinstall、补丁存在性、`skipRanges`/`CodeBlockAttributeName`/`ListDepthAttribute` 完整范围保护，以及有序列表 → 无序子列表 → `json`/`text` fenced block 的首尾换行边界。
- `npm test`：44 个文件 / 192 个测试通过。
- `npm run typecheck`、`npm run lint`：通过。
- `npm run bundle:ios`、`npm run bundle:android`：通过；两者只证明 JS 导出，不替代原生安装包或真机验证。
- `pod install --no-repo-update`：通过，`ios/Podfile.lock` 仍锁定 `ReactNativeEnrichedMarkdown (0.5.0)`。
- 补丁可复现性：`npx patch-package --reverse` 后 `npm run postinstall` 成功重新应用 `react-native-enriched-markdown@0.5.0`；`node_modules/katex` 不存在，公式开关仍为 false。
- `git diff --check`：通过。同步修正 `ios/Podfile` 与 `android/gradle.properties` 中仍标为 `0.4.1` 的公式关闭注释为 `0.5.0`，只改注释，不改开关。

模拟器/真机已验证：

- iOS Release Simulator 原生 build 通过：
  `xcodebuild -workspace Cloud.xcworkspace -scheme Cloud -configuration Release -sdk iphonesimulator -derivedDataPath /tmp/ccvibe-cloud-sim-build-patched CODE_SIGNING_ALLOWED=NO build`，结果 `** BUILD SUCCEEDED **`；补丁中的 Objective-C renderer 已参与编译。

尚未验证：

- Android 原生 Gradle：`./gradlew :app:assembleDebug --no-daemon` 因系统无 Java Runtime（`Unable to locate a Java Runtime`）退出，未进入编译。
- iOS 真机/模拟器中真实 Host transcript 的 nested fenced Markdown 视觉、拖动选区和任意片段复制；本次按父代理要求不做视觉验收，不将原生 build 视为产品视觉验收。

### cloud-tester 第二轮独立验收（2026-09-09，gpt-5.6-luna / max）

结果：**PASS（实现合同、自动化门禁与 iOS 原生编译）**；不等同于完整平台/视觉发布验收。第二轮未发现需要返工的产品实现问题，剩余缺口见下文。

自动化与依赖合同已验证（执行目录为 `/Users/cdd/Documents/ClaudeCodeRemote/CCVibe/repos/cloud-mobile`）：

- 精确版本通过核对：`package.json`、`package-lock.json`、已安装包和 `ios/Podfile.lock` 均为 `react-native-enriched-markdown@0.5.0`；无 caret/tilde/git URL。`patch-package` 精确锁定 `8.0.1`，`postinstall` 为 `patch-package`；`npm run postinstall` 重新应用 `react-native-enriched-markdown@0.5.0` 成功，日志：`/tmp/ccvibe-markdown-round2-postinstall-20260909.log`。
- `patches/react-native-enriched-markdown+0.5.0.patch` 只改 package 内的 iOS `ListItemRenderer.m`，以排序后的完整 `CodeBlockAttributeName` 与嵌套 `ListDepthAttribute` ranges 保护 code block/nested list，只对剩余 gap 应用 list paragraph style。该 hunk 与上游 `b60d2e4f90d20ebe3b5bfa351c494e89ce96398d` 的相关 `skipRanges` 逻辑一致，未把上游无关的 marker/indent 重构回移，也没有依赖当前 `node_modules` 的假修。
- 从 registry 重新 `npm pack react-native-enriched-markdown@0.5.0` 后，在干净 tarball 上执行 patch dry-run、apply 和 reverse dry-run 均通过；复现日志：`/tmp/ccvibe-markdown-round2-patch-repro-20260909.log`。当前安装源码的 hunk 与干净 apply 结果一致（仅文件末尾换行差异）。
- `npx vitest run test/enrichedMarkdownContract.test.ts`：8/8 通过；`npm test`：44 个文件 / 192 个测试通过；`npm run typecheck`、`npm run lint` 均通过。日志：`/tmp/ccvibe-markdown-round2-targeted-20260909.log`、`/tmp/ccvibe-markdown-round2-fulltest-20260909.log`、`/tmp/ccvibe-markdown-round2-typecheck-20260909.log`、`/tmp/ccvibe-markdown-round2-lint-20260909.log`。
- `npm run bundle:ios`、`npm run bundle:android` 均通过；这只证明 JS/Hermes 导出，不替代原生构建。日志：`/tmp/ccvibe-markdown-round2-bundle-ios-20260909.log`、`/tmp/ccvibe-markdown-round2-bundle-android-20260909.log`。
- `git diff --check` 通过，日志：`/tmp/ccvibe-markdown-round2-diffcheck-20260909.log`；未回退或覆盖工作树中的其他改动。

行为与公式开关独立核对：

- `ChatScreen.tsx` 仍仅在 `turn.status === 'complete'` 使用一个 selectable `flavor="commonmark"` `EnrichedMarkdownText`；streaming 仍走原有 selectable `Text`，整段 raw Markdown copy action 和链接处理保持不变。inline `code` 样式未再声明 `fontFamily`/`fontSize`，原生 `CodeRenderer.m` 在未给显式字号时继承 block 字号。
- 公式明确保持关闭：`assistantMarkdownMd4cFlags.latexMath === false`、Expo plugin `enableMath === false`、`ENV['ENRICHED_MARKDOWN_ENABLE_MATH'] = '0'`、`enrichedMarkdown.enableMath=false`。package lock 中没有 `node_modules/katex`，Pod/Gradle 依赖中没有 iosMath/AndroidMath；上游包内的可选 peer/代码引用不代表安装或启用。

模拟器/真机与原生构建：

- iOS 26.5 Simulator Release 原生构建独立重跑通过：`xcodebuild -workspace ios/Cloud.xcworkspace -scheme Cloud -configuration Release -sdk iphonesimulator -destination 'platform=iOS Simulator,id=7F29E8D5-5BE2-4DEA-BB7A-23A11F4004CA' -derivedDataPath /tmp/ccvibe-cloud-sim-build-round2-20260909 CODE_SIGNING_ALLOWED=NO build`，日志：`/tmp/ccvibe-markdown-round2-ios-release-build-20260909.log`，结果 `** BUILD SUCCEEDED **`；日志可见 `ReactNativeEnrichedMarkdown` Objective-C target 编译，产物为 `/tmp/ccvibe-cloud-sim-build-round2-20260909/Build/Products/Release-iphonesimulator/Cloud.app`。
- Android 原生 Gradle 未验证：`android/gradlew :app:assembleDebug --no-daemon` 在启动阶段因本机无 Java Runtime 退出（`Unable to locate a Java Runtime`），日志：`/tmp/ccvibe-markdown-round2-android-native-20260909.log`。
- 真实 Host transcript 的 nested fenced `json`/`text` 视觉、代码块前后 marker/背景、行高以及跨粗体/链接/代码样式拖动选区和任意片段复制仍未验证。当前本机无法安全取得已保存 Host token；此前模拟器只能到连接失败页（证据：`/tmp/ccvibe-cloud-ios26-launch-20260909.png`），不能用静态测试或原生 build 冒充视觉/交互证据。

## 第三轮视觉根因修复记录（cloud-developer，2026-09-09）

主代理在真实历史 session 的第二次视觉复核中补充了两个具体现象：nested fenced code block 结束后仍有一个空 bullet，且背景从 assistant 全宽起始而不是 nested list content column。按 iOS renderer 的实际路径定位并做最小修复：

- `ChatScreen.tsx` 的 `codeBlock` 显式设置 `marginTop: 0`、`marginBottom: 0`。0.5.0 默认 `marginBottom: 16` 会让 `CodeBlockRenderer.applyBlockSpacingAfter` 生成脱离 `CodeBlockAttributeName` 的外部 spacer；外层 `ListItemRenderer` 随后给该 spacer 添加 list metadata，iOS marker drawer 因而绘制边界空 bullet。
- `patches/react-native-enriched-markdown+0.5.0.patch` 仍只作用于第三方 iOS renderer，并扩展为三个文件：`LastElementUtils.h` 新增 `CodeBlockIndentAttributeName`；`ListItemRenderer.m` 在已收集的完整 code ranges 上记录/保留更深的 `totalIndent`，只把差值加到 code paragraph 的 `firstLineHeadIndent`/`headIndent`，并写入 indent attribute；`CodeBlockBackground.m` 读取该 attribute，将背景 `origin.x` 增加 nested indent、宽度缩为可用 content-column 宽度。未改业务 Markdown 解析、未自研 renderer、未打开公式或高亮。
- 回归契约新增 code-block margin 0、indent attribute、max/deeper-indent 保护和背景宽度缩进断言；完成态 selectable CommonMark、流式/整段复制路径保持不变。

## 第三轮验证记录（cloud-developer，2026-09-09）

自动化/原生已验证：

- `npx vitest run test/enrichedMarkdownContract.test.ts`：9/9 通过。
- `npx patch-package --reverse` 后执行 `npm run postinstall`：补丁可逆、可重新应用；重新应用后 `CodeBlockIndent`、背景可用宽度和常量均存在。
- `npm run typecheck`、`npm run lint`：通过。
- `pod install --no-repo-update`：通过，`ios/Podfile.lock` 仍锁定 `ReactNativeEnrichedMarkdown (0.5.0)`。
- `xcodebuild -workspace Cloud.xcworkspace -scheme Cloud -configuration Release -sdk iphonesimulator -derivedDataPath /tmp/ccvibe-cloud-sim-build-indent CODE_SIGNING_ALLOWED=NO build`：通过，结果 `** BUILD SUCCEEDED **`；本次 patch 中的三个 Objective-C 文件均参与编译。
- `git diff --check`：通过。

本轮按主代理要求未重复运行全量测试和双平台 bundle。公式仍在 JS/Expo/iOS/Android 全链路关闭，且没有安装 `katex`。尚未验证：主代理重新安装 patched app 后的真实 nested Markdown 视觉（尤其背景列对齐、边界空 bullet）、拖动选区/任意片段复制，以及 Android 原生 Gradle（本机无 Java）；上述原生编译证据不等同于视觉验收。计划状态继续保持“待验收”，不把本轮实现标为最终验收通过。

## 架构师最终视觉验收（2026-09-09）

主代理将包含第三轮 patch 的 Release Simulator app 安装到 iPhone 16 Pro / iOS 18.4，并连接本机临时 Host 打开截图对应的真实历史 session，而非使用静态 fixture 冒充视觉证据。

- nested fenced `json` / `text` code block 的背景从 nested list 内容列开始，未覆盖 marker 列；代码块内部不再出现列表 marker，代码块结束边界也未再出现空 bullet。
- inline code 与 16/25 正文、列表基线协调，不再由显式 14pt Menlo 形成“小字配高背景”的独立高行框；代码块仍保持 13/20 的紧凑排版。
- 在同一完成态 assistant 富文本视图中双击任意单词后出现原生选择柄与 `Copy` / `Copy as Markdown` / `Look Up` 菜单；此前跨正文、粗体、链接和代码样式的拖动扩选能力未因本轮仅涉及 renderer 样式的 patch 改变。整段“复制助手回复”按钮仍单独存在。
- 最新带签名的 Release Simulator 原生增量构建通过，日志 `/tmp/ccvibe-markdown-ios-indent-signed-build-20260909.log`，结果 `** BUILD SUCCEEDED **`；最终 nested block 截图为 `/tmp/ccvibe-markdown-final-nested.png`。

该轮仅完成 iOS Simulator 的真实会话视觉/交互验收，不等同于 iOS 真机或 Android 原生验收。Android 原生 Gradle 仍因本机无 Java Runtime 未进入编译。

### cloud-tester 最终独立测试（2026-09-09，gpt-5.6-luna / max）

结论：**PASS（当前目标实现与可执行门禁）**。当前没有发现需要返工的实现问题；Android 原生构建仍为环境阻塞，iOS nested Markdown 的本轮直接操作未重复，但主代理已在 iPhone 16 Pro / iOS 18.4 Release Simulator 用真实历史 nested fixture 实测并报告：背景从 nested 内容列开始、代码块内部及边界无空 bullet、inline code 与正文基线/行高协调。

独立核对与自动化证据（执行目录 `/Users/cdd/Documents/ClaudeCodeRemote/CCVibe/repos/cloud-mobile`，日期 2026-09-09）：

- 精确 pin 通过：`package.json`、`package-lock.json` 和已安装包均为 `react-native-enriched-markdown@0.5.0`；`patch-package@8.0.1` 精确锁定，`postinstall` 为 `patch-package`。从 registry `npm pack react-native-enriched-markdown@0.5.0` 的干净 tarball 建立临时 `node_modules` 后，当前 `patches/react-native-enriched-markdown+0.5.0.patch` 三文件 patch 的 dry-run、apply、reverse dry-run 全部通过；日志：`/tmp/ccvibe-markdown-final-patch-repro-20260909.log`。对当前安装再执行 `npm run postinstall` 也成功，日志：`/tmp/ccvibe-markdown-final-postinstall-20260909.log`。
- patch 内容独立复核：`ListItemRenderer.m` 保留完整 code/nested-list `skipRanges`，并通过 `CodeBlockIndentAttributeName`、`MAX(previousIndent, totalIndent)` 和仅增加缺失 indent 保护嵌套列；`CodeBlockBackground.m` 按 indent 调整背景 origin/available width；`LastElementUtils.h` 暴露该属性。patch 只落在这三个第三方 iOS 文件，没有 node_modules-only 假修或业务 Markdown 预处理；clean apply 与当前安装源码仅有末尾换行差异。
- `npx vitest run test/enrichedMarkdownContract.test.ts`：9/9 通过；`npm test`：44 个文件 / 193 个测试通过；`npm run typecheck`、`npm run lint` 均通过。日志：`/tmp/ccvibe-markdown-final-targeted-20260909.log`、`/tmp/ccvibe-markdown-final-fulltest-20260909.log`、`/tmp/ccvibe-markdown-final-typecheck-20260909.log`、`/tmp/ccvibe-markdown-final-lint-20260909.log`。
- `npm run bundle:ios`、`npm run bundle:android` 均通过（分别 1748 / 1736 modules）；bundle 只代表 JS/Hermes 导出。日志：`/tmp/ccvibe-markdown-final-bundle-ios-20260909.log`、`/tmp/ccvibe-markdown-final-bundle-android-20260909.log`。
- `git diff --check` 通过，日志：`/tmp/ccvibe-markdown-final-diffcheck-20260909.log`。

行为、配置与原生证据：

- `ChatScreen.tsx` 仍仅在 `turn.status === 'complete'` 使用一个 selectable CommonMark `EnrichedMarkdownText`；streaming 保持 selectable plain `Text`，整段 raw Markdown copy action 与链接处理未漂移。inline `code` 未再强制 `fontFamily`/`fontSize`；`codeBlock` 明确 `marginTop: 0`、`marginBottom: 0`。
- 公式全链路仍关闭：`assistantMarkdownMd4cFlags.latexMath=false`、实际 `npx expo config --json` 的 plugin `enableMath=false`、Podfile `ENV['ENRICHED_MARKDOWN_ENABLE_MATH']='0'`、Android `enrichedMarkdown.enableMath=false`。`package-lock` 没有 `node_modules/katex`，Pods/Gradle 没有 iosMath/AndroidMath 安装依赖；包内可选 peer 和条件编译源码引用不代表启用。
- Podfile/Podfile.lock 当前仍指向本地 `react-native-enriched-markdown`，包版本由 `node_modules/package.json` 与 npm lock 精确锁定为 0.5.0；iOS Release Simulator 原生构建以当前 patch 独立重跑通过：`xcodebuild -workspace ios/Cloud.xcworkspace -scheme Cloud -configuration Release -sdk iphonesimulator -destination 'platform=iOS Simulator,id=7F29E8D5-5BE2-4DEA-BB7A-23A11F4004CA' -derivedDataPath /tmp/ccvibe-cloud-sim-build-final-20260909 CODE_SIGNING_ALLOWED=NO build`，日志：`/tmp/ccvibe-markdown-final-ios-release-build-20260909.log`，结果 `** BUILD SUCCEEDED **`；日志明确编译了当前 `ListItemRenderer.m`、`CodeBlockBackground.m`。

尚未验证/剩余风险：

- Android `./gradlew :app:assembleDebug --no-daemon` 在启动前因本机无 Java Runtime 退出（`Unable to locate a Java Runtime`），日志：`/tmp/ccvibe-markdown-final-android-native-20260909.log`；未声称 Android 原生 build 通过。
- 本轮未重新连接真实 Host/session 来独立拖动跨粗体、链接、列表、代码的选区并检查复制内容；上述视觉结论仅采用主代理在真实 iPhone 16 Pro / iOS 18.4 Release Simulator 的 nested fixture 实测证据，不能扩展为 Android 视觉或 Android 交互结论。

## 第四轮：代码块纵向密度返工计划（2026-09-09）

### 用户反馈与当前复现

- 用户再次以 `/Users/cdd/Downloads/IMG_ACB7B5D02B2D-1.jpeg` 指出 fenced code block 高度过大；该文件时间为 2026-09-09 00:38，是上一轮修复前证据，但问题不能仅按旧截图推断已消失。
- 架构师重新启动当前已安装的最新 Release Simulator app，连接本机 Host 并打开同一真实历史 session。当前 patch 已消除 code block 内/边界 marker，并保持背景在 nested content column；但首个单行 JSON 因窄列自动换成 4 个 visual lines，再叠加 `codeBlock.padding: 12` 生成的上下各 12pt spacer，当前块仍明显偏高。复现截图：`/tmp/ccvibe-markdown-height-baseline.png`。
- 当前 iOS `CodeBlockRenderer.m` 明确将同一个 `padding` 同时用于水平 indent 和上下 spacer；高度公式近似为 `visualLineCount × lineHeight + 2 × padding`。当前样式为 `13pt / 20pt / padding 12`，4 行内容的理论内部高度约 104pt。
- 上游 PR #372 / commit `0f8f09b584e3ce91e8328690b367f89dc914ae36` 仅解决 `padding: 0` 时仍无条件插入 newline spacer 的缺陷；直接把 padding 设为 0 还会同时移除水平 inset，不符合本次保留可读代码容器的目标，因此本轮不扩大第三方 patch。

### 实施边界与方案

`cloud-developer`（gpt-5.6-luna / max）只允许修改：

- `repos/cloud-mobile/src/features/chat/ChatScreen.tsx`
- `repos/cloud-mobile/test/enrichedMarkdownContract.test.ts`
- 本计划的第四轮实现/开发自测记录

实现要求：

1. 先把契约测试改成新的紧凑排版合同并证明当前基线失败：code block 保持 `fontSize: 13`，将 `lineHeight` 从 20 收敛到 18、`padding` 从 12 收敛到 4；`marginTop` / `marginBottom` 继续为 0。
2. 只调整 `MarkdownAnswer` 的 `codeBlock` style，不改 Markdown 文本、列表 indent、第三方 patch、完成态/流式分支、选择/复制或链接行为。
3. 不启用公式支持，不新增依赖；`latexMath`、Expo、Podfile、Android 原生开关继续为 false。
4. 运行 targeted contract、typecheck、lint；由架构师完成最新 iOS Release Simulator build/install 和同一历史 session 前后视觉对比后，再交 `cloud-tester` 串行终验。

### 第四轮验收

- 同一首个 JSON code block 仍为相同 4 个 visual lines 时，理论内部高度由约 104pt 降到约 80pt（约 23%）；上下只保留 4pt inset，不再呈现空白行感。
- 多行 `text` code block 的每行 leading 为 18pt，仍足以容纳 13pt Menlo；背景、边框、水平 padding 和可读性保留。
- nested marker/背景列修复不得回归；任意片段选择和系统 Copy 菜单仍可用。
- 公式支持保持关闭；流式消息、整段 raw Markdown 复制、CommonMark 单原生视图合同不变。
- Mobile targeted test、全量 test、typecheck、lint、双平台 bundle 和 iOS Release Simulator 原生构建通过；Android 原生构建能力按当前环境事实单独报告。

## 第四轮实现记录（cloud-developer，2026-09-09）

- 先在 `test/enrichedMarkdownContract.test.ts` 收紧 code block 合同：继续要求 `fontSize: 13`、`marginTop: 0`、`marginBottom: 0`，新增 `lineHeight: 18` 与 `padding: 4`。未改 nested indent/marker patch、完成态/流式分支、CommonMark/selectable、链接或复制合同。
- 基线证明：实现修改前执行 `npx vitest run test/enrichedMarkdownContract.test.ts`，9 项中 8 项通过、1 项失败；失败断言明确指出当前源码仍为 `lineHeight: 20`，同时旧 `padding: 12` 也不满足新合同。
- `ChatScreen.tsx` 仅将 `MarkdownAnswer` 的 `codeBlock` style 从 `lineHeight: 20` / `padding: 12` 调整为 `lineHeight: 18` / `padding: 4`；保留 `fontSize: 13`、系统等宽字体、背景/边框、`marginTop`/`marginBottom: 0`。公式开关继续不变且未新增依赖。

## 第四轮开发自测记录（cloud-developer，2026-09-09）

自动化已验证：

- `npx vitest run test/enrichedMarkdownContract.test.ts`：9/9 通过。
- `npm run typecheck`：通过。
- `npm run lint`：通过。
- `git diff --check`：通过。

按本轮任务边界未运行全量 test、双平台 bundle、`pod install` 或 iOS/Android 原生 build；这些门禁留给后续终验。未修改现有 `react-native-enriched-markdown` patch、依赖、Host、harness 或 AGENTS。尚未由本开发回合验证真实历史 session 的 iOS 视觉高度，需主代理使用同一 nested fixture 对比首个 JSON block 的纵向收缩、背景/marker 不回归，再交独立测试员终验。

## 第四轮独立测试（cloud-tester，2026-09-09，gpt-5.6-luna / max）

结论：**PASS（第四轮代码块高度收敛与自动化门禁）**。当前 `MarkdownAnswer` 的 `codeBlock` 已为 `fontSize: 13`、`lineHeight: 18`、`padding: 4`、`marginTop: 0`、`marginBottom: 0`；未发现 patch 扩张、公式配置漂移或完成态/流式/复制合同回归。Android 原生仍受本机缺少 Java 阻塞。

自动化已验证（目录 `/Users/cdd/Documents/ClaudeCodeRemote/CCVibe/repos/cloud-mobile`，日期 2026-09-09）：

- `npx vitest run test/enrichedMarkdownContract.test.ts`：9/9 通过；`npm test`：44 个文件 / 193 个测试通过。日志：`/tmp/ccvibe-markdown-round4-targeted-20260909.log`、`/tmp/ccvibe-markdown-round4-fulltest-20260909.log`。
- `npm run typecheck`、`npm run lint`：通过。日志：`/tmp/ccvibe-markdown-round4-typecheck-20260909.log`、`/tmp/ccvibe-markdown-round4-lint-20260909.log`。
- `npm run bundle:ios`、`npm run bundle:android`：均通过，分别导出 1748 / 1736 modules；bundle 仅是 JS/Hermes 导出证据。日志：`/tmp/ccvibe-markdown-round4-bundle-ios-20260909.log`、`/tmp/ccvibe-markdown-round4-bundle-android-20260909.log`。
- `git diff --check`：通过，日志：`/tmp/ccvibe-markdown-round4-diffcheck-20260909.log`。

依赖、patch、配置与行为核对：

- `package.json`、`package-lock.json`、已安装包均精确为 `react-native-enriched-markdown@0.5.0`；`patch-package@8.0.1` 与 `postinstall: patch-package` 保持不变。当前 patch 在全新 registry `0.5.0` tarball 上 dry-run/apply/reverse dry-run 通过，当前安装执行 `npm run postinstall` 通过：`/tmp/ccvibe-markdown-round4-patch-repro-20260909.log`、`/tmp/ccvibe-markdown-round4-postinstall-20260909.log`。
- `react-native-enriched-markdown+0.5.0.patch` 仍仅包含 `ListItemRenderer.m`、`CodeBlockBackground.m`、`LastElementUtils.h` 三个既有 iOS 文件；第四轮没有修改或扩张原生 patch。当前 patch 仍保留完整 `skipRanges`、`CodeBlockIndentAttributeName`、nested indent max 保护和背景 content-column width 修复。
- `ChatScreen.tsx` 仍仅在 `turn.status === 'complete'` 使用单一 selectable CommonMark `EnrichedMarkdownText`；streaming 仍是 selectable plain `Text`，整段 raw Markdown copy/link 行为未漂移；inline code 继续省略显式 `fontFamily`/`fontSize` 以继承父级 metrics。
- 公式全链路核对通过：`assistantMarkdownMd4cFlags.latexMath=false`；`npx expo config --json` 实际得到 plugin `enableMath=false`（日志：`/tmp/ccvibe-markdown-round4-expo-config-20260909.json`）；Podfile 为 `ENV['ENRICHED_MARKDOWN_ENABLE_MATH'] = '0'`；Android 为 `enrichedMarkdown.enableMath=false`。lock 中无 `node_modules/katex`，Pods/Gradle 未安装 iosMath/AndroidMath；包内可选 peer/条件编译源码引用不代表启用。
- 当前 `ios/Podfile.lock` 仍指向本地 `react-native-enriched-markdown`，与精确 0.5.0 npm lock/安装包一致；未运行 `pod install`，因为本轮仅变更 JS style 且现有 Pod lock 未发生版本/配置变更。

模拟器/原生与未验证项：

- 本轮遵照磁盘限制未新建 DerivedData、未重跑 iOS 原生 build；主代理已安装当前第四轮实现到 iPhone 16 Pro / iOS 18.4 Release Simulator，在同一真实历史 session 观察同类 fenced code：4 个 visual lines 的块高度符合内容行高 + 8pt（`18 × 4 + 8`），而非旧 `20 × 4 + 24`；背景和 nested 缩进正常。该为主代理真实模拟器证据，不把它写成测试员本轮直接操作。
- Android `java -version` 与 `./android/gradlew :app:assembleDebug --no-daemon` 均在编译前失败：`Unable to locate a Java Runtime`；日志：`/tmp/ccvibe-markdown-round4-android-native-20260909.log`。因此 Android 原生编译、真机视觉和交互仍未验证。
- 本轮没有重新连接 Host 做跨样式拖选；此前 iOS Simulator 的真实会话选择/复制证据仍有效，第四轮只改 code block style 数值，不能替代 Android 或 iOS 真机验收。

## 第四轮架构师收敛（2026-09-09）

- 根因收敛为第三方 renderer 的单一 `padding` 同时控制水平缩进与上下 spacer：旧值 `padding: 12` 使每个 fenced block 固定增加 24pt 纵向空白；在窄列自动折成 4 个 visual lines 时，旧合同约为 `20 × 4 + 24 = 104pt`。本轮保持 13pt Menlo 与水平容器可读性，将合同收敛为 `lineHeight: 18`、`padding: 4`，同一内容约为 `18 × 4 + 8 = 80pt`。
- 当前第四轮实现已重新执行带签名的 iOS Release Simulator 原生构建并安装到 iPhone 16 Pro / iOS 18.4；日志 `/tmp/ccvibe-markdown-height-build-20260909.log`，结果 `** BUILD SUCCEEDED **`。真实历史会话中的 fenced code 显示为正文行高加上下各 4pt，不再有旧版上下各 12pt 的空白行感；既有 nested content-column 背景和 marker 修复未回归。
- 上游 PR #372 / commit `0f8f09b584e3ce91e8328690b367f89dc914ae36` 只修复 `padding: 0` 仍插入 newline spacer 的情况。本轮使用正值 `padding: 4` 保留水平 inset，因此不扩大现有 iOS package patch。
- 独立测试结果为 PASS；无需改动 `harness.md`：其中稳定合同已表述为精确固定 0.5.0、单一 selectable CommonMark、inline code 继承 metrics、公式关闭和 nested fenced code patch，未固化易变的具体视觉数值。Android 原生构建仍因本机没有 Java Runtime 未进入编译；双平台 JS/Hermes bundle 已通过。
