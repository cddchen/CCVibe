# Cloud 移动端 App Icon 替换

## 状态

已完成。

## 目标、范围与非目标

- 目标：把用户确认的 Cloud 图标候选接入移动端项目，使 iOS 与 Android 安装包使用同一品牌图标，并为后续 Expo prebuild 保留稳定的项目内主图入口。
- 范围：`repos/cloud-mobile/assets/branding/`、Expo `app.json` 图标声明、iOS `AppIcon.appiconset`、Android `mipmap-*` launcher/round launcher 资源，以及本计划的实施/验收记录。
- 非目标：不修改 splash screen、应用内连接页的云图形、产品版本、bundle id/package、签名或发布流程；不提交、推送或发布。

## 基线与事实证据

- 当前分支为 `main`，工作树已有版本升级、Markdown、Host 与 Mobile 功能等未提交改动；它们均视为用户工作并保持不动。
- 已确认主图：`repos/cloud-mobile/assets/branding/cloud-app-icon-candidate-v2.png`，1024×1024、PNG RGB、无 alpha；用户已确认视觉效果。
- iOS owner：`ios/Cloud/Images.xcassets/AppIcon.appiconset/Contents.json` 只引用 `App-Icon-1024x1024@1x.png`。
- Android owner：`AndroidManifest.xml` 引用 `@mipmap/ic_launcher` 与 `@mipmap/ic_launcher_round`；当前资源位于 mdpi/hdpi/xhdpi/xxhdpi/xxxhdpi，尺寸分别为 48/72/96/144/192。
- Expo owner：当前 `app.json` 未声明 `expo.icon`。原生工程已纳入维护，故只改配置不能替换当前原生产物，只改原生资源又会在未来 prebuild 时漂移；两者需要同步。
- 当前 Android launcher 文件扩展名为 `.webp`，内容却是 PNG；本次生成真实 lossless WebP，保持既有资源名与 manifest 引用。

## 实施方案与文件所有权

### cloud-developer

- 将确认过的候选整理为稳定主图 `repos/cloud-mobile/assets/branding/cloud-app-icon.png`；不改变已确认的视觉内容。
- 在 `repos/cloud-mobile/app.json` 的 Expo 根配置声明 `"icon": "./assets/branding/cloud-app-icon.png"`，只做局部编辑并保留现有版本与插件改动。
- 用主图替换 iOS 1024 App Icon；确保最终 PNG 为 1024×1024 且无 alpha。
- 从主图生成 Android 五档 `ic_launcher.webp` 与 `ic_launcher_round.webp`，使用真实 lossless WebP 和既有尺寸；不修改 manifest，不新增不完整的 adaptive icon 分层。
- 只维护本计划的“实现记录”段，不修改验证/收敛段；不得触碰其他文件或回退他人改动。

### cloud-tester

- 在开发者稳定交接后只读核对产品资源与配置；可只维护本计划的“独立验收记录”段，不修改产品实现。
- 核对实际图片格式、像素尺寸、alpha、配置引用和 Git diff；运行 Mobile typecheck、lint 及足以证明双端原生资源可被打包的 iOS/Android 构建或等价原生验证。
- 若平台环境无法执行，记录精确限制；不得用 JS bundle 冒充原生安装验证。

## 验收条件

1. 项目内存在稳定 1024×1024、不透明 PNG 主图，`app.json` 的 `expo.icon` 精确指向它。
2. iOS AppIcon 文件与主图像素内容一致，1024×1024、无 alpha，`Contents.json` 引用不变且有效。
3. Android 普通与 round launcher 在五档密度下均为有效 WebP，尺寸分别为 48、72、96、144、192，来源视觉与确认主图一致。
4. splash screen 与应用内图标未被本任务改动；现有无关工作树差异未被覆盖。
5. Mobile typecheck、lint 通过；iOS 与 Android 原生构建/资源打包至少各有一条成功证据。若无法做模拟器/真机安装观察，必须明确列为尚未验证。
6. `git diff --check` 通过，最终 diff 只新增/修改本任务资源、`app.json` 单行声明与本计划。

## 实现记录

2026-09-09，`main` 分支。保留工作树中既有的版本升级、Markdown、Host 与 Mobile 功能改动，仅修改本任务拥有的资源、Expo 配置和本段记录。

- 将已确认的 `cloud-app-icon-candidate-v2.png` 重命名为稳定主图 `repos/cloud-mobile/assets/branding/cloud-app-icon.png`；保留原始生成文件目录不变，主图仍为 1024×1024 RGB PNG、无 alpha，视觉内容未改动。
- 在 `repos/cloud-mobile/app.json` 的 Expo 根对象新增 `"icon": "./assets/branding/cloud-app-icon.png"`，保留现有版本、原生标识与插件配置。
- 将主图复制到 `repos/cloud-mobile/ios/Cloud/Images.xcassets/AppIcon.appiconset/App-Icon-1024x1024@1x.png`；未修改 `Contents.json`，其既有引用继续有效。
- 使用 `/opt/homebrew/bin/cwebp -lossless -noalpha -resize` 从主图生成 Android `mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher.webp` 与对应 `ic_launcher_round.webp`，尺寸为 48/72/96/144/192；未修改 manifest、splash 或新增 adaptive icon。
- 实现偏差：无。`candidate-v2` 项目副本按计划整理为稳定主图，Android 普通与 round 资源使用同一主图和同一尺寸转换结果。
- 针对性核验：`sips -g format -g pixelWidth -g pixelHeight -g hasAlpha` 确认主图与 iOS 图均为 1024×1024、PNG、无 alpha；`node -e` JSON 解析及 `npx expo config --type public --json` 确认 `expo.icon` 精确指向主图；`cmp -s` 确认 iOS 与主图字节一致；`webpinfo` 确认 10 个 Android 资源为有效 lossless WebP、Alpha=0、尺寸覆盖 48/72/96/144/192；`cmp -s` 确认每档普通/round 资源一致；在 `repos/cloud-mobile` 执行 `npm run typecheck`、`npm run lint` 均通过；`git diff --check` 通过。
- harness/API/README：无需更新。该变化仅是移动端品牌资源路径与原生图标内容，不改变 Cloud 的 SDK、Host、协议、运行时或协作边界；本计划已有来源与 owner 记录。
- 尚未验证：独立测试员的 iOS/Android 原生构建、模拟器/真机安装观察以及独立门禁复测仍待完成；本记录不将静态资源核验视为原生安装验收。

## 独立验收记录

2026-09-09（Asia/Shanghai），`main`，macOS 26.6.2 arm64。验收早期曾发现共享工作树将 `app.json`/`package.json` 从 `0.11.0`/11 写到 `0.12.0`/12，故早期原生证据先作废；架构师随后确认工作树稳定并提供当前版本补验结果。以下保留首次失败作为历史，当前结论以 0.12.0/build 12 的补验为准。

### 自动化与静态资源（已验证）

- 主图存在于 `repos/cloud-mobile/assets/branding/cloud-app-icon.png`。`sips -g format -g pixelWidth -g pixelHeight -g hasAlpha` 与 `file` 均确认 PNG、1024×1024、RGB、无 alpha；当前 `app.json` 的 `expo.icon` 精确为 `./assets/branding/cloud-app-icon.png`。独立运行 `npx expo config --type public --json`（目录 `repos/cloud-mobile`，退出码 0）并解析确认同一路径；输出同时反映当时工作树的 `0.12.0`/build 12。
- iOS `Contents.json` 仍仅引用 `App-Icon-1024x1024@1x.png`，文件存在且由 `sips` 确认为 1024×1024 RGB PNG、无 alpha。主图与 iOS 文件 SHA-256 均为 `b364a9df04fb23eb3385c19789b65e523b512f36c07008968706af2478650c41`，证明像素/字节内容一致。
- Android 资源在 `mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}` 的普通与 round 文件均可由 `webpinfo` 解码；尺寸分别为 48、72、96、144、192，均为 `Format: Lossless (2)`、`Alpha: 0`、`No error detected`。使用本机 `cwebp 1.6.0` 从主图按上述五档独立重生成期望 WebP，再以 `cmp` 对每档普通资源和 round 资源逐一比对，全部通过；证据目录：`/tmp/cloud-icon-validation.0BLVOF/`。
- `AndroidManifest.xml` 的 `@mipmap/ic_launcher` / `@mipmap/ic_launcher_round` 引用未改且目标文件有效；splash 资源与 `styles.xml` 无本任务 diff。`git diff --check` 通过。
- 在 `repos/cloud-mobile` 执行 `npm run typecheck`、`npm run lint`，两者退出码均为 0（Mobile `package.json` 脚本，未调用真实模型或网络服务）。

### 原生平台（当前 iOS/Android 均有成功证据）

- iOS 首次按默认双架构构建时因磁盘空间不足在 universal binary 阶段失败（历史环境问题）；清理本轮专用 `/tmp` derived data 后，针对当前 0.12.0/build 12 以 Xcode 26.6（build 17F113）、iPhone Simulator SDK 26.5、iPhone 17 Pro destination、Release、`ONLY_ACTIVE_ARCH=YES ARCHS=arm64 CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO` 重跑 `xcodebuild -workspace ios/Cloud.xcworkspace -scheme Cloud -configuration Release -sdk iphonesimulator ... build`，退出码 0、`BUILD SUCCEEDED`。当前日志：`/tmp/cloud-ios-icon-build-single.59rUrY/xcodebuild-current.log`；产物：`/tmp/cloud-ios-icon-build-single.59rUrY/DerivedData/Build/Products/Release-iphonesimulator/Cloud.app`。
- 对当前 `.app/Assets.car` 执行 `xcrun assetutil --info` 并解析通过：存在 `AssetType: Icon Image`、`Name: AppIcon`、`Idiom: phone`、1024×1024、`RenditionName: App-Icon-1024x1024@1x.png`、`Opaque: true`；当前 `.app/Info.plist` 同时确认 `CFBundleShortVersionString=0.12.0`、`CFBundleVersion=12`、`CFBundleIconName=AppIcon`。此外已在 iPhone 17 Pro Simulator（iOS 26.5，UDID `7F29E8D5-5BE2-4DEA-BB7A-23A11F4004CA`）卸载旧 app、重启模拟器、安装当前 `.app`，桌面截图 `/tmp/cloud-ios-icon-home-0.12.0-refreshed.png` 可见 Cloud 新蓝底白云图标，构图清晰、圆角裁切正常。
- Android 首次正确工作目录执行时因未发现 SDK 而退出 1（历史环境问题，日志：`/tmp/cloud-android-icon-build-correct.AX5FrA/gradle.log`）；补齐临时环境 `JAVA_HOME=/opt/homebrew/Cellar/openjdk@17/17.0.20.1/libexec/openjdk.jdk/Contents/Home` 与 SDK `/opt/homebrew/share/android-commandlinetools` 后，在 `repos/cloud-mobile/android` 执行 `./gradlew :app:processReleaseResources --no-daemon --console=plain`，退出码 0，`BUILD SUCCESSFUL in 9s`。资源打包产物：`repos/cloud-mobile/android/app/build/intermediates/linked_resources_binary_format/release/processReleaseResources/linked-resources-binary-format-release.ap_`；独立 `unzip -l` 确认其中含 mdpi/hdpi/xhdpi/xxhdpi/xxxhdpi 普通与 round 共 10 个 launcher WebP 及 `resources.arsc`。

### 尚未验证、风险与结论

- 历史上的 Android SDK 缺失、iOS 磁盘不足和版本写入竞态均已通过稳定工作树后的补验解除；不再存在本任务范围内的已知实现缺陷。JS bundle 不作为原生证据。
- 尚未验证项：未做 Android 真机/模拟器桌面视觉观察；验收要求的 Android 原生资源打包已由 Gradle `.ap_` 产物证明，iOS 已有 Simulator 安装/桌面截图证据。
- 结论：当前 0.12.0/build 12 工作树下，主图、Expo 引用、iOS/Android 资源内容、iOS `Assets.car` 编译、Android Gradle 资源打包、iOS Simulator 安装桌面观察、Mobile typecheck/lint 与 `git diff --check` 均有证据；建议通过并交架构师最终收敛，未将计划状态字段擅自改写。

## 收敛记录

2026-09-09，架构师复核开发交接、独立测试与补验证据后收敛为已完成：

- 用户确认的主图已成为项目稳定资源，Expo 配置、iOS AppIcon 与 Android 五档 launcher/round launcher 均指向或派生自同一视觉源。
- 当前 `0.12.0` / build 12 工作树下，Mobile typecheck、lint、iOS Release Simulator 原生构建、Android Release 资源处理、iOS 模拟器安装与桌面视觉检查均通过；Android 桌面真机/模拟器观察未做，但不阻塞本计划约定的资源打包验收。
- `app.json` 在本任务中的所有权仅为新增 `expo.icon`；版本与 Markdown plugin 等同文件差异属于其他工作流并已完整保留。现有启动页、应用内图标、产品版本与签名发布流程均未由本任务修改。
- App Icon 路径与内容属于移动端构建资源事实，不改变 Cloud 的 SDK、Host、协议、运行时或 agent 协作边界，因此无需更新根 `harness.md`、`AGENTS.md`、API 文档或 README。
- 未执行 git add、commit、push 或发布。
