# Phase 0：移动端基础工程与 Contract 内核

> 状态：已完成（2026-08-29，移动端 22 个测试文件中的基础合同测试通过）  
> 写入范围：`repos/cloud-mobile/**`，必要时新增只含协议类型的 workspace package

## 目标

建立可同时运行 iOS/Android 的 Expo React Native 工程，并先完成不依赖 React 的协议与状态内核。

## 实施内容

- Expo + TypeScript strict + Expo Router；路由文件保持薄壳。
- 安装 `expo-secure-store`、`expo-glass-effect`、`expo-blur`、Zod、测试工具和 Material 适用依赖。
- 定义 `ConnectionConfig`、`ConnectionState`、`RootCatalogState`、`ChatState`、`ActionEnvelope` 的客户端只读视图。
- 实现严格 JSON-RPC envelope codec、resource URI codec、地址规范化和 protocol error 映射。
- 实现纯 `catalogReducer`、`chatReducer`/复用共享 reducer、会话分组排序 selector、glass capability resolver。
- 建立可注入 `now()`、`createId()`、platform capability 的边界，不在 reducer 调用环境状态。

## 测试优先清单

1. 无效/未知 JSON-RPC 字段被拒绝。
2. `serverSeq` 空洞合法，旧/重复 action no-op。
3. snapshot 替换与 replay 追加得到同一 canonical state。
4. 会话按 workspace 分组并稳定排序，相等输入保持引用稳定。
5. iOS 26 glass -> old iOS blur -> reduce transparency solid；Android -> material。
6. token 永不出现在 normalized URL 和序列化日志中。

## 退出条件

- `npm run typecheck`、`npm test`、`npm run lint` 全绿。
- Expo Router 能解析 home/chat/connection 三条路由。
- iOS 与 Android bundler 至少完成一次无错误 bundle。
- production 代码无 `any`；网络 `unknown` 在 domain 边界前已解析。

## 停止条件

若需要复制 Host 大型领域 union 才能继续，停止客户端实现并先建立共享 contract owner，不接受双份手写协议。
