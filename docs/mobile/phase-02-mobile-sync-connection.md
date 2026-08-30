# Phase 2：移动端安全连接与多客户端同步

> 状态：已完成（2026-08-29，Bearer header、SecureStore、重连与同步测试通过）  
> 依赖：Phase 0、Phase 1

## 目标

实现唯一 WebSocket/JSON-RPC client、连接 supervisor 和 app state store，正确处理初始化、重连、fencing 与后台恢复。

## 实施内容

- `Authorization: Bearer` upgrade；禁止 query token。
- SecureStore 保存 token；地址/端口/TLS 和非敏感偏好单独存储。
- request ID、pending RPC、timeout、close 清理和 backoff + jitter。
- 首连 `initialize(agent-root://)`，进入 chat 时 subscribe；离开页面不停止服务端 turn。
- 保存 `hostEpoch`、last seen seq、subscriptions；重连调用 `reconnect` 并分支处理 replay/snapshot。
- `client/replaced` 进入明确的重新连接/被替换 UI，不并行维持两个 socket。
- 将 transport event 解析后作为 typed commands 送入纯 store；组件不得直接订阅 socket。

## 测试优先清单

1. Bearer header 存在且 URL 无 token。
2. RPC 成功/错误/timeout/close 都结算 pending promise。
3. backoff 可由 fake timer 决定，后台停止重试，前台恢复。
4. replay 与 snapshot 路径收敛；旧 seq、重复 action 不回退状态。
5. client replacement 与 host epoch 改变有可观察状态。
6. token 读写只经过 SecureStore port，日志 redactor 覆盖嵌套值。

## 退出条件

- fake Host 集成测试覆盖完整连接生命周期。
- 断网恢复后首页和活动会话不闪空、不丢 canonical state。
- 多客户端同时观察同一 chat 时状态一致。
