# 功能 5：首页最近会话 SDK 刷新

## 目标

首页“最近会话”标题右侧增加刷新图标。用户点击后，运行 `cc-agent-host` 的机器立即通过 Claude Agent SDK 重新读取最新 session catalog，并把权威结果同步到 Mobile；按钮有进行中、失败和可访问状态。

## 现状调研

- Host 已有 `refreshCatalog()`：默认会重新调用 SDK `listSessions()`，必要时用短生命周期 Query 获取模型目录，并通过 catalog actions 替换 workspaces/models/sessions。
- 该函数目前只在 Host 启动流程等服务端入口调用，JSON-RPC `METHODS` 没有客户端可调用的 refresh 方法。
- Mobile `ConnectionSupervisor` 只有 initialize/subscribe/create/resolve/configure 等 RPC；首页也没有 refresh action。简单重新 selector 或重新订阅只会读 Host 当前内存，不满足“调用 SDK 获取当时最新的”。
- root catalog 是 Host 权威资源；刷新结果必须继续通过 snapshot/action reducer 进入 Mobile，不能在 HomeScreen 维护第二份 sessions state。

## 设计

1. 新增严格 RPC `catalog/refresh`，参数仅含 canonical root `channel`。协议 handler 要求当前 client、root 已订阅，并按 `configure` capability 授权，以限制可触发 SDK/文件 I/O 的调用者。
2. composition 注入窄 `catalogRefresher` port，实际绑定现有 `refreshCatalog()`；protocol 层不导入 Claude SDK。
3. 成功响应返回刷新后的 root `StateSnapshot`（含 `fromSeq`），同时现有 catalog actions 正常广播给其他客户端。调用客户端把响应 snapshot 交给 SyncStore，保证 `await` 返回时本地已获得这次刷新切点。
4. Mobile `hostWire` 增加严格 result parser；`ConnectionSupervisor.refreshCatalog()` 发 RPC 并应用 snapshot；`CloudRuntime.actions.refreshSessions()` 负责 connected guard 和错误归一化。
5. HomeScreen 在“最近会话”标题右侧显示 refresh icon；点击期间 spinner/disabled，完成后列表由 root catalog selector自然更新，失败给现有或专用轻量错误提示。不得清空 last-known-good sessions。
6. 并发点击在 Mobile UI 层禁用；Host 侧建议用单飞/串行保护，避免同一进程并行多次 SDK catalog probe。

## 预计改动

- Host：`protocol/schemas.ts`、`protocol/protocolServerHandler.ts`、`claude/createClaudeAgentHost.ts` 及 tests/docs
- Mobile：`protocol/hostWire.ts`、`sync/connectionSupervisor.ts`、`features/runtime/runtimeStore.ts`、`features/home/HomeScreen.tsx` 及 tests/docs
- 更新 `docs/daemon/03-json-rpc-api-reference.md` 与架构/API 文档

## 测试与验收

- Host schema 拒绝未知字段/非 root channel；ACL、未初始化、未订阅和 provider 缺失路径有确定错误。
- composition 测试证明每次 RPC 都重新调用 SDK `listSessions()`，不是返回旧缓存；同时避免并发重复 probe。
- Mobile parser/supervisor/runtime 测试证明响应 snapshot 被应用、失败保留旧 sessions、未连接不发请求。
- Home UI 契约验证标题右侧按钮、loading/disabled、accessibility label。
- 两包 typecheck/相关测试；协议变更扩大到全量 test、Host build、Mobile lint 与双平台 bundle。

## 子代理边界

端到端实现本 RPC 和首页入口，不改聊天消息组件；保持 SDK import 仅在 Claude adapter，协议只依赖窄 port 与 SDK-free catalog state。
