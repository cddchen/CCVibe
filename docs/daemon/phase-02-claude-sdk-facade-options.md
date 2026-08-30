# Phase 2：Claude SDK Facade 与 Harness Options 实施计划

> 状态：已完成（2026-08-24）  
> 目标包：`repos/cc-agent-host`  
> 前置：Phase 0/1 已完成  
> SDK 基线：`@anthropic-ai/claude-agent-sdk` **0.3.220 exact**

## 1. 目标

建立 Claude Agent SDK 的唯一依赖边界和集中 harness 配置入口。Phase 2 不启动长期运行的 chat actor/Query，不接真实凭据网络请求；它完成：

```text
CCVibe orchestration types
  -> ClaudeAgentSdkService (lazy SDK module facade)
  -> official SDK exports/types

Resolved session configuration
  -> buildClaudeOptions() pure projection
  -> official Options
```

后续业务层不得直接 import SDK raw types；SDK 类型只存在于 `src/claude/` 与针对该边界的测试。

## 2. 精确依赖基线

生产依赖使用 exact version：

```json
{
  "@anthropic-ai/claude-agent-sdk": "0.3.220",
  "@anthropic-ai/sdk": "0.120.0",
  "@modelcontextprotocol/sdk": "1.30.0",
  "zod": "4.4.3"
}
```

原因：

- 0.3.220 是本机 VS Code 参考实现已安装、可审查 `sdk.d.ts` 的版本。
- Agent SDK peer 要求 `@anthropic-ai/sdk >=0.93.0`、MCP `^1.29.0`、Zod `^4.0.0`。
- 当前 CCVibe 的 Zod 3 必须升级到 Zod 4 并保持协议测试全绿。
- 不使用 caret pin，避免部署拉取未经兼容测试的新 Agent SDK/CLI binary。

## 3. SDK 类型不变量

- `type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk')`。
- facade 方法参数通过 `Parameters<SdkModule['method']>` 推导。
- facade 返回值通过 `ReturnType` / `Awaited<ReturnType<...>>` 推导。
- `Query`、`WarmQuery`、`Options`、`SDKMessage`、`SDKUserMessage`、`PermissionResult`、session APIs 等直接 `import type`。
- 不定义手写缩减 `Query` 或 open `SDKMessage { type: string }`。
- fake Query 使用 `Pick<Query, ...>` 或方法签名推导。
- compile-contract 必须在 SDK export 漂移时让 `tsc` 失败。
- `Query` 没有 `setEffort()`；热更新 effort 必须调用 `applyFlagSettings({ effortLevel })`。

## 4. 文件级任务

## 4.1 `src/claude/sdkBindings.ts`

定义从真实 SDK export 推导的 binding slice：

```ts
type ClaudeSdkModule = typeof import('@anthropic-ai/claude-agent-sdk');

type ClaudeSdkBindingName =
  | 'query'
  | 'startup'
  | 'listSessions'
  | 'getSessionInfo'
  | 'getSessionMessages'
  | 'listSubagents'
  | 'getSubagentMessages'
  | 'forkSession'
  | 'deleteSession'
  | 'createSdkMcpServer'
  | 'tool';

type ClaudeSdkBindings = Pick<ClaudeSdkModule, ClaudeSdkBindingName>;
```

如果为了 fake 需要 interface，签名也必须由 `ClaudeSdkModule[K]` 映射得到，不能复制参数。

加入 eager compile assertion：binding keys 都存在且 assignable。

## 4.2 `src/claude/claudeAgentSdkService.ts`

```ts
interface ClaudeAgentSdkServiceOptions {
  loadSdk?: () => Promise<ClaudeSdkBindings>;
  onLoadError?: (error: unknown) => void;
}

class ClaudeAgentSdkService {
  query(...): Promise<Query>;
  startup(...): Promise<WarmQuery>;
  listSessions(...): ...;
  ...
}
```

规则：

- 默认 loader 使用 dynamic `import('@anthropic-ai/claude-agent-sdk')`。
- 缓存成功 resolve 的 module，不永久缓存 rejected promise；失败后下一次可重试。
- 并发首次调用必须共享一个 in-flight import，避免重复加载。
- import 失败 `onLoadError` 每次失败最多调用一次；reporter 异常不得替代原始错误。
- facade 的 `query` 异步仅因为 lazy import；官方 `query()` 本身同步返回 `Query`。
- session 数组对外可作为 readonly，但不修改 SDK 返回值。
- service 不读取 env、不下载 SDK、不实现业务 retry。
- `createSdkMcpServer`/`tool` 可统一返回 Promise，以隐藏 lazy import。

测试：lazy、single-flight、失败重试、reporter isolation、所有 passthrough 参数/返回 identity。

## 4.3 `src/claude/options.ts`

定义 resolved pure-data input，禁止在 builder 内读 `process.env`、cwd、随机数或磁盘：

```ts
interface ClaudeSessionStart {
  kind: 'new';
  sessionId: string;
}

interface ClaudeSessionResume {
  kind: 'resume';
  sessionId: string;
  resumeSessionAt?: string;
}

interface BuildClaudeOptionsInput {
  cwd: string;
  additionalDirectories?: readonly string[];
  abortController: AbortController;
  session: ClaudeSessionStart | ClaudeSessionResume;
  model?: string;
  effort?: EffortLevel;
  permissionMode: PermissionMode;
  canUseTool: CanUseTool;
  onElicitation?: OnElicitation;
  mcpServers?: Readonly<Record<string, McpServerConfig>>;
  plugins?: readonly SdkPluginConfig[];
  hooks?: Options['hooks'];
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  agent?: string;
  env?: Readonly<Record<string, string | undefined>>;
  settings?: Settings;
  stderr?: NonNullable<Options['stderr']>;
}
```

`buildClaudeOptions(input): Options` 必须：

- 验证 cwd/additional directories 是绝对路径、去重、不包含 cwd。
- 输出数组/record defensive copies，避免调用方后续 mutation。
- `systemPrompt: { type: 'preset', preset: 'claude_code' }`。
- `settingSources: ['user','project','local']` 显式固定。
- `includePartialMessages: true`。
- `forwardSubagentText: true`。
- `enableFileCheckpointing: true`。
- `allowDangerouslySkipPermissions: true`，实际 mode 仍由 `permissionMode` 控制。
- 默认禁用 `WebSearch`；调用方额外 `disallowedTools` 与默认集合去重合并。
- new 分支只设置 `sessionId`；resume 分支只设置 `resume`，可带 `resumeSessionAt`。
- 空数组/空 record 尽量省略，保留 SDK 默认。
- 返回值使用 `satisfies Options`，不以 `as Options` 掩盖漂移。
- builder 不创建 permission promise，不实现 SDK policy。

## 4.4 `src/claude/runtimeConfig.ts`

提供类型安全 runtime setter helpers：

```ts
async function applyClaudeRuntimeConfig(
  query: Pick<Query, 'setModel' | 'setPermissionMode' | 'applyFlagSettings'>,
  config: { model?: string; permissionMode: PermissionMode; effort?: EffortLevel },
): Promise<void>
```

固定顺序：

```text
setModel -> setPermissionMode -> applyFlagSettings
```

- effort 存在：`{ effortLevel: effort }`。
- effort 清除：`{ effortLevel: null }`。
- 不调用不存在的 `setEffort`。
- 提供逐项 helper 便于 Phase 3 pipeline rebind 后重放当前 runtime config。
- 失败立即停止并原样抛出；状态补偿由 Phase 3 actor/pipeline 决定。

## 4.5 `src/claude/types.ts`

仅导出 CCVibe 需要公开的稳定 facade input/result types。不要从 root `src/index.ts` 重新导出 `SDKMessage` 或整个 SDK namespace。

Root public API 可导出：

- `ClaudeAgentSdkService`
- `buildClaudeOptions`
- runtime config helpers
- builder/facade 的 CCVibe input types

不导出：

- `ClaudeSdkBindings` 内部 fake boundary
- raw `SDKMessage`
- SDK schema/internal module

## 5. 测试矩阵

### 5.1 Dependency/type contract

- package exact Agent SDK pin，无 caret。
- peer graph `npm ls` 无 invalid peer。
- compile assertion 覆盖每个 binding。
- fake method signatures 来自官方 types。

### 5.2 Service

- 首次两个并发调用只执行一次 loader。
- 成功后所有调用复用 resolved module。
- 第一次 loader reject，第二次可成功。
- onLoadError 抛错不替代 import error。
- `query` 返回原 Query identity。
- startup/session/fork/delete/MCP/tool 参数原样 passthrough。

### 5.3 Options

- new/resume 两个互斥分支。
- `resumeSessionAt` 只允许 resume。
- load-bearing options 直接断言。
- model/effort/permission/callback identity。
- additional directories 去重/绝对路径/defensive copy。
- MCP/plugins/hooks/settings/env defensive copy，函数 identity 保留。
- 默认 `WebSearch` 禁用并去重。
- 输入 mutation 不改变已构建 options。
- builder 相同输入（除 callback/object identity）产生 deep-equal projection。

### 5.4 Runtime config

- 固定调用顺序。
- effort set/clear 走 `applyFlagSettings`。
- model undefined 正确传给 `setModel(undefined)`。
- 前一步失败时后续不执行。
- 类型测试证明没有 `setEffort` 依赖。

## 6. 子代理拆分

1. **Dependencies + SDK facade**：升级 Zod 4、精确 SDK/peers、bindings/service/tests。
2. **Options + runtime config**：builder、setter helpers、tests/exports。

每批不启动真实 Query，不访问网络 API，不读取 Claude credentials。

## 7. 验收

```bash
npm run typecheck
npm test
npm run build
npm audit
npm ls @anthropic-ai/claude-agent-sdk @anthropic-ai/sdk @modelcontextprotocol/sdk zod
```

要求：

- 全部退出码 0；
- Phase 0/1 的 172 项测试继续通过；
- SDK dependency 和 peers 为 exact/valid；
- 测试不启动 Claude subprocess；
- 业务/协议层没有 SDK raw import；
- 不修改 legacy 删除文件。

## 8. 完成记录

最终实现包括：

- exact Agent SDK `0.3.220` 与 peer-compatible Anthropic/MCP/Zod 依赖树；
- 由 `typeof import()` / `Pick` / `Parameters` / `ReturnType` 推导的 SDK binding slice；
- lazy、single-flight、失败可重试的 `ClaudeAgentSdkService`；
- 保留 schema 泛型关系的 MCP `tool<Schema>()` facade；
- deterministic `buildClaudeOptions()`，集中 Claude Code preset、setting sources、streaming、checkpoint、permission、session new/resume 和 customization 配置；
- 官方 `Query` setter 约束的 model/permission/effort runtime helpers；
- effort set/clear 使用 `applyFlagSettings({ effortLevel })`，无 `setEffort` 假接口。

主代理于 2026-08-24 独立执行：

```text
npm run typecheck  PASS
npm test           PASS — 20 files, 198 tests
npm run build      PASS
npm audit          PASS — 0 vulnerabilities
npm ls SDK peers   PASS — exact, deduplicated, valid
```

本阶段测试没有启动 Claude subprocess、访问模型网络或读取用户凭据。Phase 3 将使用这些边界实现 provisional/materialization 与长生命周期 Query pipeline。
