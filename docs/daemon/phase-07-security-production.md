# Phase 7：安全与生产加固

> 状态：执行中（2026-08-27）  
> 前置：Phase 0–6 已完成；目标包：`repos/cc-agent-host`

## 目标

让单 Host 服务可安全部署，而不把权限、租户或密钥语义混入 Claude SDK/session ID。

```text
authenticated connection -> principal/tenant policy -> resource ACL
                                                -> protocol command/approval gate
                                                -> audit/redacted observability
```

## 不变量

- `principalId`、`tenantId`、`clientId`、`connectionId` 与 `sdkSessionId` 是不同身份；SDK ID 绝不参与公网授权。
- 所有 authorization 决策均由纯函数 `(principal, action, resource, ACL) -> Allow | Deny` 得到。transport 只负责认证、调用和关闭连接。
- 初始化前先认证；token 不写日志、错误响应、URL query 或 action payload。认证失败一律返回相同安全错误，防止账户枚举。
- approval/input 要独立 `approve` capability，不能仅因 read/subscribe 即允许决议。
- 速率、frame、队列和 subscription 限制在 transport 边界 fail-closed；慢客户端不得积压无限内存。
- 结构化日志使用纯 redact 函数；prompt、SDK raw message、authorization header、cookie 与 bearer value 都不得出现。
- graceful shutdown：先停止 upgrade/accept，再通知/关闭 transport，等待或 interrupt active runtime、dispose interaction waiters、flush overlay、最后关闭 storage。未完成 turn 的恢复状态为 interrupted。

## 子切片

1. **security-policy**：`src/security/*`、`test/security/*`。Branded principal/tenant/capability、ACL reducer/authorization、token extraction/redaction 与 pure tests。
2. **transport-auth-limits**：`src/transport/*`、`test/transport/*`。认证门、rate/frame/subscription enforcement、HTTP/WSS error mapping；不实现业务 ACL。
3. **host-security-integration**：`src/claude/createClaudeAgentHost.ts`、`src/protocol/*` 与测试。把 authenticated context传入 handler、按 resource 操作执行 ACL、approval capability gate、shutdown order/audit。

## 验收

- 无 token/secret 的 log/redaction property tests。
- 同 tenant authorized、跨 tenant/not-capable denied；deny 不能触发 actor 或 consume serverSeq。
- 速率、oversize frame、慢客户端与 unauthenticated upgrade 有自动化测试。
- shutdown 可以幂等，停止新连接、等待资源释放，pending interaction 安全结束。
- `npm run typecheck && npm test && npm run build && npm audit --omit=dev` 全绿。

## 暂缓

OIDC issuer/JWKS 具体产品配置、mTLS、跨 Host lease/fencing（Phase 8）、容器/egress sandbox 运行时策略。Phase 7 提供可注入 bearer verifier 与严格 policy port，绝不假装已有某个身份供应商。

## 完成记录

已交付纯 identity/ACL reducer、跨 tenant deny 与独立 approve capability；可注入 bearer verifier 和不泄露凭据的 authentication context；递归 structured-log redaction；WSS/HTTP auth gate、credential query 拒绝、frame/rate/queue/subscription/slow-client limits。

Protocol handler 在 initialize/reconnect 过滤未授权资源，在 subscribe、dispatch、interrupt、approval 和 input resolve 前执行授权；拒绝统一为无 data 的 `AuthorizationDenied`，不会触发 actor、前进 `serverSeq` 或确认 `clientSeq`。

最终验收：

```text
npm run typecheck        PASS
npm test                 PASS — 40 files, 360 tests
npm run build            PASS
npm audit --omit=dev     PASS — 0 vulnerabilities
```
