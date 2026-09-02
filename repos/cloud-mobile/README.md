# Cloud Mobile

Cloud 的 Expo / React Native 客户端，用于连接 `cc-agent-host`，选择远程工作目录和模型，并在多个客户端之间同步会话、工具调用、权限请求与结构化输入。

## 本地运行

```bash
npm install
npm start
```

原生运行：

```bash
npm run ios
npm run android
```

连接页可填写 `https://host.example.com` 或完整的 `wss://host.example.com/ws`。没有显式路径时客户端自动使用 `/ws`。开发模式允许 `http://127.0.0.1:8787`；Bearer token 仅保存在系统 SecureStore。

## 质量检查

```bash
npm run typecheck
npm test
npm run lint
npm run bundle:ios
npm run bundle:android
```

iOS 26 使用系统 Liquid Glass；旧版 iOS 使用 blur/rim/shadow 降级，Reduce Transparency 使用实体 surface。Android 使用 Material 3 surface、elevation 和 shape，不启用持续实时 blur。

Android 原生构建还要求本机安装 JDK、Android SDK 和 emulator。仅通过 `bundle:android` 不等同于完成 Gradle 与设备验收。

## 原生应用打包

以下命令均从项目根目录执行：

```bash
cd /Users/cdd/Documents/ClaudeCodeRemote/CCVibe/repos/cloud-mobile
npm install
```

推荐使用项目内置命令，产物统一写入 `.build-artifacts`：

```bash
# 一次打包 iOS 真机 IPA 和 Android release APK
npm run build:mobile:release

# 只打 iOS 真机 IPA（需要先在 Xcode 登录并配置签名证书）
npm run build:ios:device

# 只打 Android release APK
npm run build:android:release
```

默认产物：

```text
.build-artifacts/Cloud-0.1.0-ios-device.ipa
.build-artifacts/Cloud-0.1.0-android-release.apk
```

脚本会自动读取 `package.json` 版本号和 Xcode 工程中的 Development Team。需要覆盖签名 Team 时，可执行 `IOS_DEVELOPMENT_TEAM=<Team ID> npm run build:ios:device`。

### Android APK

首次构建或本地尚无 `android` 目录时，先生成原生工程：

```bash
npx expo prebuild --platform android --no-install
```

配置 JDK 和 Android SDK，然后构建 Release APK：

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools

cd android
NODE_ENV=production ./gradlew assembleRelease --no-daemon \
  -Dorg.gradle.internal.http.connectionTimeout=20000 \
  -Dorg.gradle.internal.http.socketTimeout=30000 \
  --console=plain
cd ..
```

默认产物：

```text
android/app/build/outputs/apk/release/app-release.apk
```

复制为带版本号的交付文件：

```bash
mkdir -p build-artifacts
cp android/app/build/outputs/apk/release/app-release.apk \
  build-artifacts/Cloud-0.1.0-android-release.apk
```

当前原生模板的 `release` 构建使用测试签名，适合模拟器和测试机。提交 Google Play 前需要在 `android/app/build.gradle` 中配置正式 keystore；商店 AAB 使用 `./gradlew bundleRelease` 构建。

### iOS 模拟器包

下面的命令生成 Apple Silicon Mac 可运行的 Release 模拟器应用：

```bash
export NODE_BINARY=/opt/homebrew/opt/node/bin/node

NODE_ENV=production xcodebuild \
  -workspace ios/Cloud.xcworkspace \
  -scheme Cloud \
  -configuration Release \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath build-artifacts/ios-derived \
  CODE_SIGN_STYLE=Automatic \
  ARCHS=arm64 \
  ONLY_ACTIVE_ARCH=YES \
  build

ditto -c -k --sequesterRsrc --keepParent \
  build-artifacts/ios-derived/Build/Products/Release-iphonesimulator/Cloud.app \
  build-artifacts/Cloud-0.1.0-ios-simulator.app.zip
```

安装到当前已启动的模拟器：

```bash
xcrun simctl install booted \
  build-artifacts/ios-derived/Build/Products/Release-iphonesimulator/Cloud.app
xcrun simctl launch booted com.ccvibe.cloud
```

### iOS 真机 IPA

先在 Xcode 的 **Settings → Accounts** 登录 Apple 开发者账号，并确保 Team 已为 `com.ccvibe.cloud` 创建描述文件。本项目当前使用的 Team ID 为 `U4MJ79YZ4K`。

生成签名后的 Release Archive：

```bash
export NODE_BINARY=/opt/homebrew/opt/node/bin/node
export IOS_DEVELOPMENT_TEAM=U4MJ79YZ4K

NODE_ENV=production xcodebuild \
  -workspace ios/Cloud.xcworkspace \
  -scheme Cloud \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath build-artifacts/Cloud-0.1.0-device.xcarchive \
  DEVELOPMENT_TEAM="$IOS_DEVELOPMENT_TEAM" \
  CODE_SIGN_STYLE=Automatic \
  -allowProvisioningUpdates \
  archive
```

使用开发调试签名导出 IPA：

```bash
xcodebuild \
  -exportArchive \
  -archivePath build-artifacts/Cloud-0.1.0-device.xcarchive \
  -exportPath build-artifacts/ios-device \
  -exportOptionsPlist build-artifacts/ExportOptions-debugging.plist \
  -allowProvisioningUpdates

cp build-artifacts/ios-device/Cloud.ipa \
  build-artifacts/Cloud-0.1.0-ios-device.ipa
```

`build-artifacts/ExportOptions-debugging.plist` 的内容如下：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>destination</key>
    <string>export</string>
    <key>method</key>
    <string>debugging</string>
    <key>signingStyle</key>
    <string>automatic</string>
    <key>teamID</key>
    <string>U4MJ79YZ4K</string>
    <key>stripSwiftSymbols</key>
    <true/>
</dict>
</plist>
```

连接并信任 iPhone 后，可以直接安装 Archive 中已经签名的应用：

```bash
xcrun devicectl list devices
xcrun devicectl device install app \
  --device <设备ID> \
  build-artifacts/Cloud-0.1.0-device.xcarchive/Products/Applications/Cloud.app
```

开发调试 IPA 只能安装到描述文件中已登记的设备；TestFlight 或 App Store 包需要使用对应的分发证书与导出方式。
