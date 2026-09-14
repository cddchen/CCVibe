# 设置页顶部使用 App Icon

## 状态

已完成并通过独立验收。

## 目标、范围与非目标

把设置/Host 管理页顶部当前黑底 `cloud-outline` 标记替换为产品真实 App Icon，保持当前 70×70 布局、标题、副标题、返回行为、safe area 和双平台可读性。

非目标：不修改 App Icon 主资源本身，不改 launcher/AppIcon 构建配置，不改变设置页 Host 状态机、导航协议或帮助页，不重新设计整张页面。

## 当前分支与事实证据

- 2026-09-10 调研时分支为 `main`，工作树干净。
- 稳定品牌源为 `repos/cloud-mobile/assets/branding/cloud-app-icon.png`，已由计划 15 验证为 1024×1024 RGB PNG、无 alpha；`app.json` 与双端原生图标均以它为源。
- 设置页顶部 `ConnectionScreen.tsx` 的 `heroMark` 当前绘制黑色 70×70 圆角容器和 Material `cloud-outline`，并未使用产品图标。
- 该改动属于 Mobile connection/settings UI，不需要 Host、runtime 或 storage 变化。

## 方案与文件边界

### cloud-developer（gpt-5.6-luna / max）

允许修改：

- `repos/cloud-mobile/src/features/connection/ConnectionScreen.tsx`
- `repos/cloud-mobile/test/connectionScreenDesign.test.ts` 或一个聚焦设置品牌图标的测试文件
- 本计划的实现记录与开发自测记录

只读使用：`repos/cloud-mobile/assets/branding/cloud-app-icon.png`。

禁止修改：图像二进制、`app.json`、iOS/Android launcher 资源、帮助路由/页面、Host、Markdown patch、任务 18/20 计划。

实施要求：

1. 先补失败的 source/layout contract：顶部品牌图使用稳定 asset，旧 `cloud-outline` 不再作为 hero 图标。
2. 使用 React Native 原生 `Image`（或项目已有等价轻量组件）直接引用稳定 asset；保持当前视觉尺寸、圆角裁切、阴影和布局，不引入新依赖。
3. 图像为品牌装饰，避免产生重复、嘈杂的无障碍朗读；Cloud 标题仍提供文本身份。

### cloud-tester（gpt-5.6-luna / max）

开发交接后独立验收，默认只修改本计划验证记录；核对 asset 引用、尺寸/裁切、无障碍、深浅色与原生资源未被改写。

## 验收条件

- 设置页 list/edit/new 三种状态顶部均显示与系统桌面一致的 Cloud App Icon，不再显示黑底线框云标记。
- 图标保持 70×70、现有圆角/阴影与标题间距，不拉伸、不变形、不受深色模式染色。
- 返回按钮、Cloud 标题、副标题和 Host 管理行为无回退。
- 聚焦测试、`npm run typecheck`、`npm run lint` 通过；双平台 bundle 通过。至少完成 iOS Simulator 或 Android 目标页截图；另一平台若没有运行环境需明确披露。
- `git diff --check` 通过；asset、launcher 资源、`app.json` 与无关文件无本任务 diff。

## 实现记录

2026-09-10，cloud-developer 实施：

- 在 `repos/cloud-mobile/src/features/connection/ConnectionScreen.tsx` 使用现有稳定资源 `assets/branding/cloud-app-icon.png`，通过 React Native 原生 `Image` 替换设置/Host 管理页 hero 区域的 Material `cloud-outline`；保留 `heroMark` 现有 70×70、22pt 圆角、阴影/elevation、标题/副标题、返回和 safe-area 布局。
- 图片使用 Metro 要求的字面量 `require`，并设置 `resizeMode="cover"`、70×70 和 22pt 圆角；圆角裁切放在图片自身，外层不再使用 `overflow: hidden`，避免 iOS 裁掉外层 shadow。图片设置 `accessibilityElementsHidden` 与 Android `importantForAccessibility="no-hide-descendants"`，由相邻 Cloud 文本承担屏幕身份。
- 在 `repos/cloud-mobile/test/connectionScreenDesign.test.ts` 先加入失败的 source/layout contract，随后验证稳定 asset、无旧 `cloud-outline`、装饰性无障碍、70×70 尺寸、外层阴影不被裁切和图片圆角。
- 实现偏差：无；未修改品牌 PNG、`app.json`、iOS/Android launcher 资源、帮助页或 Host。未更新根 `harness.md`/`AGENTS.md`：该改动只改变设置页的移动端展示，不改变架构 owner、协议或运行时事实。

### 开发者自测（2026-09-10，Asia/Shanghai）

- `repos/cloud-mobile`: `npx vitest run test/connectionScreenDesign.test.ts` 通过，11 tests；首次在实现前按计划失败，完成后恢复通过。
- `repos/cloud-mobile`: `npm run typecheck`、`npm run lint` 通过。
- `repos/cloud-mobile`: `npm run bundle:ios`、`npm run bundle:android` 通过；两端导出资产均包含 `assets/branding/cloud-app-icon.png`。
- 真实 iOS Simulator：复用已健康的本机 Host（`curl -fsS http://127.0.0.1:8787/health` 返回 `status: ok`），按项目命令 `npm run ios` 在 iPhone 17 Pro / iOS 26.5 上成功编译、安装并打开；通过 `com.ccvibe.cloud://connection` 打开设置页，截图证据为 `/tmp/cloud-settings-icon-connection.png`，可见蓝底白云 Cloud App Icon、70×70 圆角裁切与现有阴影，列表页正常。
- 尚未做 Android 真机/模拟器视觉检查；独立 cloud-tester 仍需核对双平台资源未改写、深色模式/可访问性和最终门禁。

## 验证记录

2026-09-10（Asia/Shanghai），独立 cloud-tester，`main`，macOS 26.6.2 arm64。验收基线为开发者交接后的当前稳定 diff；期间未发现任务 2 文件被其他代理继续写入，保留任务 1 Markdown patch、任务 18 计划和任务 20 计划的已有改动。

### 自动化与静态资源（已验证）

- 在 `repos/cloud-mobile` 执行 `npx vitest run test/connectionScreenDesign.test.ts`，11 tests 全部通过。
- 在 `repos/cloud-mobile` 执行 `npm run typecheck`、`npm run lint`，均退出码 0。
- 执行 `npm run bundle:ios` 与 `npm run bundle:android`，均成功导出；两端 Metro 输出都包含 `assets/branding/cloud-app-icon.png`。
- `ConnectionScreen.tsx` 独立核对确认：使用字面量 `require('../../../assets/branding/cloud-app-icon.png')`；顶部 `Image` 使用 `resizeMode="cover"`、70×70、22pt 圆角；`accessibilityElementsHidden` 与 Android `importantForAccessibility="no-hide-descendants"` 将装饰图从无障碍树隐藏；外层 `heroMark` 保留阴影且没有 `overflow: hidden`，不会裁掉阴影；旧 `cloud-outline` 不再作为 hero 图标。该 header 位于 list/edit/new 条件分支之前，因此三种状态共用同一 App Icon。
- `sips`/`file` 确认稳定主图为 1024×1024 RGB PNG、无 alpha；iOS AppIcon 同样为 1024×1024 RGB PNG、无 alpha，且两者 SHA-256 均为 `b364a9df04fb23eb3385c19789b65e523b512f36c07008968706af2478650c41`。`app.json` 的 `expo.icon` 仍精确指向 `./assets/branding/cloud-app-icon.png`。
- `git diff --name-status -- app.json assets/branding ios/Cloud/Images.xcassets/AppIcon.appiconset android/app/src/main/AndroidManifest.xml android/app/src/main/res` 无输出，证明任务 2 没有改写品牌源、`app.json`、iOS AppIcon、Android launcher 或 manifest。10 个 Android launcher/round launcher 资源均可由 `webpinfo` 解码，格式为 lossless WebP、Alpha=0、无错误；其既有内容来自计划 15，本任务未修改。
- 任务 2 文件范围的 `git diff --check` 通过。全仓库 `git diff --check` 仍报告任务 1 的 `react-native-enriched-markdown+0.5.0.patch` 中已有空白行 trailing-whitespace；该告警不属于任务 2 文件，未修改该 patch。

### iOS Simulator（已验证）

- 先执行 `curl -fsS http://127.0.0.1:8787/health`，复用现有 Host，返回 `{"status":"ok","protocolVersions":["1.0.0"]}`，未重启或停止用户 Host。
- 在 `/Users/cdd/Documents/ClaudeCodeRemote/CCVibe/repos/cloud-mobile` 按项目要求执行 `npm run ios`。Xcode 26.6 构建成功，0 error、0 warning；应用安装并打开于 iPhone 17 Pro / iOS 26.5（UDID `7F29E8D5-5BE2-4DEA-BB7A-23A11F4004CA`）。
- 使用 `xcrun simctl openurl ... com.ccvibe.cloud://connection` 打开设置页并截图：`/tmp/cloud-settings-icon-connection-test.png`。人工检查确认设置页显示蓝底白云 Cloud App Icon，圆角裁切与阴影正常，Cloud 标题、副标题、返回按钮及 Host 列表保持可见；没有旧黑底线框 `cloud-outline`。该截图验证了 list 状态；edit/new 的共用 header 由源代码契约覆盖。

### 尚未验证与结论

- 未独立运行 Android 原生构建、Android 模拟器/真机设置页截图，也未在 iOS/Android 上单独切换深色模式或执行 VoiceOver/TalkBack；因此 Android 平台视觉、深色模式和实际无障碍朗读仍列为未验证。计划 15 已有 Android 资源打包证据，但不冒充本次独立视觉证据。
- 未发现需要返工的产品问题。任务 2 满足当前计划的代码、资源、自动化门禁及至少一个目标平台截图条件，建议架构师收敛为通过；全仓库 diff-check 的历史 Markdown patch 空白行由任务 1 owner 另行处理。

## 架构师收敛

2026-09-10：接受实现与独立验收结论。应用内品牌图复用既有稳定 asset，不改变架构 owner，因此无需更新根 harness/AGENTS；Android 视觉、深色模式与实际无障碍朗读仍按验证记录保留为后续平台 smoke，不影响本任务当前验收条件。
