# Phase 4.5：Agent Host Composition 实施计划

> 状态：已完成（2026-08-25）  
> 目标：把 Phase 0–4 组件装配为可实例化、可 listen、可 shutdown 的单 Host 服务

## 1. 交付

新增 `createClaudeAgentHost(options)`，装配：

```text
ClaudeAgentSdkService
  + buildClaudeOptions
  + ClaudeQueryRuntime factory
  + ClaudeChatRegistry
  + ClaudeRuntimeActionBridge
  + ClaudeChatActor
  + ChatHostStateProvider
  + ProtocolServerHandler
  + Fastify/WSS server
```

返回 `ClaudeAgentHost`：

- `server: FastifyInstance`（factory 不自动 listen）。
- `createChat(input)`：生成/接收 opaque sdkSessionId，注册 Host ChatState + provisional backing。
- `loadHistory(chatUri)`：`getSessionMessages(backing.sdkSessionId,{dir:cwd,includeSystemMessages:true})` → replay hydration。
- `shutdown()`：Promise-idempotent，先停止 transport 接单，再 dispose handler、drain registry/runtime。
- readonly accessors：HostStateManager、registry、SDK service。

## 2. 配置

- 注入 `hostEpoch`、`nowServer`、`nowAction`。
- 注入/默认 `createSdkSessionId` 与 `createSdkUuid`；默认只在 orchestration shell 使用 `randomUUID()`。
- 注入 `canUseTool`；缺省安全 deny，不自动批准交互请求。
- 可注入 SDK service/runtime factory/server options 以离线测试。
- customization（MCP/plugins/hooks/settings/env/agent/allowed/disallowed/onElicitation/stderr）作为 resolved input 传入 options builder。
- runtime factory 使用 backing desired model/effort/permission 和 new/resume session。

## 3. 不变量

- create chat 时不启动 SDK。
- first protocol `chat/send` 经真实 `ClaudeChatActor` materialize Query。
- raw SDK 仍只在 Claude layer。
- factory/import 不自动 listen，不读取 credentials，不访问网络。
- history 只从 SDK session API 读取，不复制 transcript DB。
- 默认 deny 回调明确是临时安全策略，不声称已实现 Phase 5 approval。
- shutdown 不重复 dispose/close。

## 4. 测试

- factory 返回未监听 server；health/listen 可用。
- create chat 0 startup。
- WSS initialize/subscribe/send 使用 fake SDK WarmQuery/Query，产生 turnStarted + mapper actions/result completed。
- history 调用 exact sdkSessionId/dir/includeSystemMessages 并通过 turnsLoaded。
- default permission callback deny；injected callback identity进 Options。
- shutdown order/idempotence，无 leaked sockets/runtimes。
- create rollback/duplicate chat/sdk ID。

## 5. 验收

```bash
npm run typecheck
npm test
npm run build
npm audit
```

不运行真实模型网络；fake SDK 受 official types 约束。

## 6. 完成记录

已实现 `createClaudeAgentHost()`，装配 SDK facade/options/runtime、registry、mapper bridge、real actor、protocol handler 与 Fastify/WSS。支持 provisional create、真实 send 垂直链路、SDK history hydration、安全默认 deny 和 awaitable shutdown。

主代理独立验收：

```text
npm run typecheck  PASS
npm test           PASS — 31 files, 282 tests
npm run build      PASS
npm audit          PASS — 0 vulnerabilities
package export     PASS
```

测试只使用 official-type fake SDK；未启动 Claude subprocess 或访问模型网络。
