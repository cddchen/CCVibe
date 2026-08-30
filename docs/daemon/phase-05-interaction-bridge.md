# Phase 5：多客户端交互桥实施计划

> 状态：已完成（2026-08-27）  
> 目标包：`repos/cc-agent-host`  
> 前置：Phase 0–4.5 已完成；基线为 `npm run typecheck && npm test && npm run build`（282 tests）

## 1. 目标与不变量

将 Claude SDK 的 `canUseTool` 和 `AskUserQuestion` 交互转换为 Host 拥有、可订阅、一次结算的领域状态。SDK 只保留在 `src/claude/`；协议层不暴露 SDK raw union。

```text
SDK callback -> interaction registry -> versioned ChatAction -> HostStateManager
                                           ^                    |
client decision -- JSON-RPC command -------+--------------------+
                                           one SDK waiter resolve
```

- 一个 pending request 只对应一个 SDK waiter；任意合格客户端均可回答，first-valid-decision-wins。
- `AbortSignal`、超时、runtime close/dispose 都必须结算 waiter，且永不把已取消请求复活。
- reducer 是纯函数：所有 ID、时间、展示文本与决议均从 action 输入取得。
- `AskUserQuestion` 是结构化 input，不伪装成工具权限；Phase 5 只实现 SDK `canUseTool` 和工具型 `AskUserQuestion` 的 bridge，不实现 MCP elicitation。
- 已决请求的重试必须返回 canonical `already_resolved`，不重复调用 SDK，也不重复消费 serverSeq。
- client disconnect 不自动 deny；client capability/owner 选择留给 client-tools 子切片，disconnect grace 由显式 clock 驱动。

## 2. 稳定领域契约

在 `src/domain` 中新增 `InputRequestId` branded ID、`PendingInputRequest` 与以下 action（命名可微调，但语义不可变）：

```ts
chat/inputRequested { turnId, inputId, questions, timestamp }
chat/inputResolved { turnId, inputId, answers, timestamp }
chat/approvalRequested {
  turnId, approvalId, toolCallId?, toolName, input, title?, description?,
  suggestions?, requestedAt/timestamp
}
chat/approvalResolved { turnId, approvalId, decision, timestamp }
```

`PendingApproval` 必须保留 UI 安全的 SDK callback context；SDK raw input 可用 `Readonly<Record<string, unknown>>` 的透明值，但不可被 reducer 解释或执行。`PendingInputRequest.questions/answers` 采用已验证的 JSON-safe domain 形状，不允许 `unknown` 泄漏到 public action。

请求和 resolve 的 action 只改变 state，不决定 callback。`input_needed` 当且仅当当前 active turn 有 pending approval 或 input；最后一个 pending 解决后回到 `in_progress`。

## 3. Orchestration 契约

`src/interaction/pendingInteractionRegistry.ts` 是唯一含 Promise resolver、Abort listener 和 timer 的 shell。建议窄接口：

```ts
requestApproval(input): Promise<PermissionResult>
resolveApproval(input): ResolveResult
requestInput(input): Promise<InputAnswers | undefined>
resolveInput(input): ResolveResult
cancelChat(chatUri, reason): void
dispose(): void
```

它不直接修改 `ChatState`；通过注入的 `dispatch(chat, action)` 先提交 request/resolution action，再 resolve SDK waiter。request ID/clock/timeout 均从依赖注入；确保一次 request/response 的时间戳稳定。SDK callback `null` 不可用于本 bridge：callback 必须返回 official `PermissionResult`，避免永久停驻。

SDK adapter 使用 `CanUseTool`、`PermissionResult`、`Parameters<CanUseTool>` 和官方 `AskUserQuestionInput` 类型派生参数；不得复制 SDK union。`ExitPlanMode` 仍作为 SDK permission gate 处理，并且只能在一个明确的 follow-up phase 中修改 permission mode。

## 4. Protocol 与 actor

新增 schema/handler command：`chat/resolveApproval`、`chat/resolveInput`。它们必须携带 `commandId` 与 `clientSeq`，复用 `CommandDeduper`；handler 不保存 pending request。非法/不匹配 chat/已决请求转化为稳定 rejections。协议 action 仍通过现有 snapshot/replay 传播。

client tool owner registry 仅提供 capability 选择和可观测状态：一个 call 只能 dispatch 给一个 eligible owner；owner 断开前不改变已派发 call。实际反向工具执行若 SDK MCP bridge 尚未具备，必须明示为 deferred，不可伪造成功。

## 5. 子代理文件所有权

1. **domain-interaction**：`src/domain/{ids,chat,actions,chatReducer}.ts` 与相应 `test/domain/*`；只处理纯 state 与类型。
2. **interaction-registry**：新增 `src/interaction/*` 与 `test/interaction/*`；实现 pending registry、first-writer 和 cancellation，禁止修改 domain 文件。
3. **sdk-protocol-integration**：`src/claude/*`、`src/protocol/*`、`src/chat/*`、composition 与相应测试；在 domain/registry 契约落地后集成官方 SDK callback、JSON-RPC command 与 host。

合并顺序为 1 -> 2 -> 3。每位子代理只能提交自己所有权内的文件；若发现契约缺项，报告而非跨区编辑。

## 6. 验收矩阵

- reducer 对 approval/input action 的乱序、重复、多个 pending、terminal cleanup 和相同 action 序列逐字段收敛。
- 两客户端相反 approval 决定并发到达，恰一个 `PermissionResult` 与恰一个 resolution action；另一方获 `already_resolved`。
- abort、timeout、runtime disposal 恰好结束 waiter；随后 resolve 是无副作用 rejection。
- `AskUserQuestion` 的多问题答案经过 JSON-safe schema 验证；不允许把 answer 当作 permission。
- injected official-type fake `CanUseTool` 的 allow/deny/suggestions/decisionClassification 均完整传递；默认行为 fail-closed deny。
- protocol reconnect/snapshot 可见 pending 状态；command retry 不重复 resolver。
- `npm run typecheck`、`npm test`、`npm run build` 通过；不启动真实 subprocess/网络。

## 7. 后续范围

Phase 6 才加入 SQLite overlay/receipt/audit 持久化；Phase 7 才将 principal ACL、approve capability、限流和 workspace isolation 作为生产安全 gate。MCP elicitation、长时 URL auth、跨 Host waiter 恢复也不属于 Phase 5。

## 8. 完成记录

已交付 Host-owned pending interaction registry、确定性的 approval/input domain action 与 reducer、官方 SDK `CanUseTool`/`PermissionResult` 类型边界，以及 `chat/resolveApproval` / `chat/resolveInput` JSON-RPC 控制面。审批采用 first-valid-writer-wins，SDK abort、超时、chat cancel 和 host dispose 会结算 waiter；已结算请求稳定返回 `already_resolved`。所有交互状态通过既有 action/snapshot/replay 链路同步。

主代理最终验收：

```text
npm run typecheck  PASS
npm test           PASS — 32 files, 298 tests
npm run build      PASS
npm audit --omit=dev PASS — 0 vulnerabilities
```
