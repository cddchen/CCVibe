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
