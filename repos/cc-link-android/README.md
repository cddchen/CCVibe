# CCLink Android

CCLink Android 是 `cc-agent-daemon` 的移动客户端，使用 Kotlin、Jetpack Compose、OkHttp WebSocket 和 JSON-RPC 2.0 实现。

## 已实现功能

- 主机、端口、TLS、Token 登录与校验。
- Android Keystore 加密保存 Token，启动时自动连接。
- WebSocket 断线指数退避重连。
- 按工作目录分组、排序、折叠和下拉刷新会话列表。
- 添加和信任 daemon 主机上的工作目录。
- 新建、加载、挂接和恢复 Claude 会话。
- Markdown/GFM、表格、代码、thinking、工具调用和工具结果展示。
- 流式回复、耗时、token、发送和停止状态。
- Opus、Sonnet、Haiku、思考强度和权限模式切换。
- 普通工具权限与 `AskUserQuestion` 回答。
- 前后台切换和 App 重启后的自动连接与会话恢复。
- 浅色、深色和跟随系统主题。

## 构建环境

- JDK 17
- Android SDK 34
- Gradle 8.7
- Android Gradle Plugin 8.4.2

## 构建

```bash
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
export ANDROID_HOME="$HOME/Library/Android/sdk"
./gradlew :app:testDebugUnitTest :app:assembleDebug
```

APK 输出：

```text
app/build/outputs/apk/debug/app-debug.apk
```

## 局域网联调

daemon 需要监听局域网地址并设置 Token：

```bash
cd ../cc-agent-daemon
npm run dev:lan
```

Android 登录时填写 daemon 主机的局域网 IP 或可访问域名。手机上的 `127.0.0.1` 指向手机自身，不能用于连接 Mac。

## 安全说明

- Token 通过 Android Keystore AES/GCM 加密后保存。
- `ws://` 仅用于可信局域网联调；远程网络应使用 `wss://`。
- App 不会自动允许工具权限。
- 主动断开、返回列表或进入后台不会主动停止 daemon 中运行的会话。
