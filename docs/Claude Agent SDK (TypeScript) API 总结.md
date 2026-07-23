# # Agent SDK (TypeScript) API 总结

来源页面：`https://code.claude.com/docs/zh-CN/agent-sdk/typescript`  
包名：`@anthropic-ai/claude-agent-sdk`

---

## 安装

```bash
npm install @anthropic-ai/claude-agent-sdk
```

SDK 会按平台捆绑本地 Claude Code 二进制（如 `@anthropic-ai/claude-agent-sdk-darwin-arm64`）。若包管理器跳过可选依赖，需手动设置 `pathToClaudeCodeExecutable`。

### 编译为单文件可执行（bun）

使用 `bun build --compile` 时需 `extractFromBunfs()` 提取二进制（要求 SDK ≥ v0.3.144）：

```ts
import binPath from "@anthropic-ai/claude-agent-sdk-darwin-arm64/claude" with { type: "file" };
import { extractFromBunfs } from "@anthropic-ai/claude-agent-sdk/extract";
import { query } from "@anthropic-ai/claude-agent-sdk";

const cliPath = extractFromBunfs(binPath);
for await (const message of query({
  prompt: "Hello",
  options: { pathToClaudeCodeExecutable: cliPath },
})) {
  console.log(message);
}
```

---

## 核心函数

### 1. `query()`

与 Claude Code 交互的主入口，返回可异步迭代的消息流。

```ts
function query({
  prompt,
  options,
}: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}): Query;
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `prompt` | `string \| AsyncIterable<SDKUserMessage>` | 字符串或流式用户消息 |
| `options` | `Options` | 可选配置 |

**返回值**：`Query`（扩展 `AsyncGenerator<SDKMessage, void>`，并带控制方法）

**基本用法**：

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "列出当前目录文件",
  options: { maxTurns: 5 },
})) {
  console.log(message);
}
```

---

### 2. `startup()`

预热 CLI 子进程，先完成初始化，再延迟发送 prompt，减少首包延迟。

```ts
function startup(params?: {
  options?: Options;
  initializeTimeoutMs?: number;
}): Promise<WarmQuery>;
```

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `options` | `Options` | - | 与 `query()` 相同 |
| `initializeTimeoutMs` | `number` | `60000` | 初始化超时（ms） |

**返回值**：`Promise<WarmQuery>`

```ts
const warm = await startup({ options: { maxTurns: 3 } });
for await (const message of warm.query("What files are here?")) {
  console.log(message);
}
```

---

### 3. `tool()`

创建类型安全的 MCP 工具定义。

```ts
function tool<Schema extends AnyZodRawShape>(
  name: string,
  description: string,
  inputSchema: Schema,
  handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>,
  extras?: { annotations?: ToolAnnotations }
): SdkMcpToolDefinition<Schema>;
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `name` | `string` | 工具名 |
| `description` | `string` | 工具描述 |
| `inputSchema` | Zod Schema | 输入参数（支持 Zod 3/4） |
| `handler` | async 函数 | 工具实现 |
| `extras.annotations` | `ToolAnnotations` | MCP 行为提示（可选） |

**ToolAnnotations**（均为可选提示）：

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `title` | `string` | - | 人类可读标题 |
| `readOnlyHint` | `boolean` | `false` | 是否只读 |
| `destructiveHint` | `boolean` | `true` | 是否可能破坏性修改 |
| `idempotentHint` | `boolean` | `false` | 是否幂等 |
| `openWorldHint` | `boolean` | `true` | 是否与外部世界交互 |

```ts
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const searchTool = tool(
  "search",
  "Search the web",
  { query: z.string() },
  async ({ query }) => ({
    content: [{ type: "text", text: `Results for: ${query}` }],
  }),
  { annotations: { readOnlyHint: true, openWorldHint: true } }
);
```

---

### 4. `createSdkMcpServer()`

在同进程内创建 MCP Server 实例。

```ts
function createSdkMcpServer(options: {
  name: string;
  version?: string;
  tools?: Array<SdkMcpToolDefinition<any>>;
}): McpSdkServerConfigWithInstance;
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `name` | `string` | 服务器名 |
| `version` | `string` | 版本（可选） |
| `tools` | `SdkMcpToolDefinition[]` | 由 `tool()` 创建的工具列表 |

---

### 5. `listSessions()`

列出历史会话元数据。

```ts
function listSessions(options?: ListSessionsOptions): Promise<SDKSessionInfo[]>;
```

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `options.dir` | `string` | 全部项目 | 限定目录 |
| `options.limit` | `number` | - | 最大条数 |
| `options.includeWorktrees` | `boolean` | `true` | 是否包含 git worktree 会话 |

**SDKSessionInfo**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `sessionId` | `string` | UUID |
| `summary` | `string` | 标题/摘要 |
| `lastModified` | `number` | 最后修改时间（ms epoch） |
| `fileSize` | `number \| undefined` | 本地 JSONL 大小 |
| `customTitle` | `string \| undefined` | 自定义标题 |
| `firstPrompt` | `string \| undefined` | 首条有效用户提示 |
| `gitBranch` | `string \| undefined` | 结束时 git 分支 |
| `cwd` | `string \| undefined` | 工作目录 |
| `tag` | `string \| undefined` | 标签 |
| `createdAt` | `number \| undefined` | 创建时间 |

---

### 6. `getSessionMessages()`

读取某会话的用户/助手消息。

```ts
function getSessionMessages(
  sessionId: string,
  options?: GetSessionMessagesOptions
): Promise<SessionMessage[]>;
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `sessionId` | `string` | 必填 |
| `options.dir` | `string` | 项目目录 |
| `options.limit` | `number` | 最大消息数 |
| `options.offset` | `number` | 跳过条数 |

**SessionMessage**：`type`（`user`/`assistant`）、`uuid`、`session_id`、`message`、`parent_tool_use_id`、`parent_agent_id` 等。

---

### 7. `getSessionInfo()`

按 ID 读取单会话元数据。

```ts
function getSessionInfo(
  sessionId: string,
  options?: GetSessionInfoOptions
): Promise<SDKSessionInfo | undefined>;
```

---

### 8. `renameSession()`

重命名会话（重复调用安全，以最新为准）。

```ts
function renameSession(
  sessionId: string,
  title: string,
  options?: SessionMutationOptions
): Promise<void>;
```

| 参数 | 说明 |
|------|------|
| `sessionId` | 会话 UUID |
| `title` | 非空标题（trim 后） |
| `options.dir` | 项目目录（可选） |

---

### 9. `tagSession()`

打标签；传 `null` 清除。

```ts
function tagSession(
  sessionId: string,
  tag: string | null,
  options?: SessionMutationOptions
): Promise<void>;
```

---

### 10. `resolveSettings()`（Alpha）

用与 CLI 相同的合并逻辑解析某目录生效设置，无需启动 CLI。

```ts
function resolveSettings(
  options?: ResolveSettingsOptions
): Promise<ResolvedSettings>;
```

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `cwd` | `string` | `process.cwd()` | 解析基准目录 |
| `settingSources` | `SettingSource[]` | 全部 | 加载源；`[]` 跳过 user/project/local |
| `managedSettings` | `Settings` | - | 宿主提供的限制性策略层 |
| `serverManagedSettings` | `Settings` | - | 服务端托管设置 |

**ResolvedSettings**：`effective`、`provenance`、`sources`。

---

## `Options` 主要字段

`query()` / `startup()` 的配置对象（节选常用项）：

| 属性 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `abortController` | `AbortController` | 新建 | 取消控制 |
| `additionalDirectories` | `string[]` | `[]` | 额外可访问目录 |
| `agent` | `string` | - | 主线程代理名 |
| `agents` | `Record<string, AgentDefinition>` | - | 编程定义子代理 |
| `agentProgressSummaries` | `boolean` | `false` | 子代理进度摘要 |
| `allowDangerouslySkipPermissions` | `boolean` | `false` | 允许 bypass 权限 |
| `allowedTools` | `string[]` | `[]` | 自动批准工具 |
| `disallowedTools` | `string[]` | `[]` | 拒绝工具 |
| `betas` | `SdkBeta[]` | `[]` | 测试特性 |
| `canUseTool` | `CanUseTool` | - | 自定义权限回调 |
| `continue` | `boolean` | `false` | 继续最近对话 |
| `cwd` | `string` | `process.cwd()` | 工作目录 |
| `debug` / `debugFile` | `boolean` / `string` | - | 调试 |
| `effort` | `'low'\|'medium'\|'high'\|'xhigh'\|'max'` | 模型默认 | 努力程度 |
| `enableFileCheckpointing` | `boolean` | `false` | 文件回滚检查点 |
| `env` | `Record<string, string \| undefined>` | `process.env` | **替换**子进程环境（需自行 spread） |
| `executable` | `'bun'\|'deno'\|'node'` | 自动 | JS 运行时 |
| `fallbackModel` | `string` | - | 备用模型 |
| `forkSession` | `boolean` | `false` | resume 时分叉新会话 |
| `forwardSubagentText` | `boolean` | `false` | 转发子代理文本/思考 |
| `hooks` | `Partial<Record<HookEvent, HookCallbackMatcher[]>>` | `{}` | Hook 回调 |
| `includeHookEvents` | `boolean` | `false` | 流中包含 hook 生命周期事件 |
| `includePartialMessages` | `boolean` | `false` | 包含流式部分消息 |
| `maxBudgetUsd` | `number` | - | 成本上限（USD） |
| `maxThinkingTokens` | `number` | - | **已弃用**，改用 `thinking` |
| `maxTurns` | `number` | - | 最大代理轮次 |
| `mcpServers` | `Record<string, McpServerConfig>` | `{}` | MCP 服务器 |
| `model` | `string` | CLI 默认 | 模型别名或完整名 |
| `permissionMode` | `PermissionMode` | `'default'` | 权限模式 |
| `persistSession` | `boolean` | `true` | 是否落盘会话 |
| `planModeInstructions` | `string` | - | Plan 模式自定义说明 |
| `plugins` | `SdkPluginConfig[]` | `[]` | 本地 plugins |
| `promptSuggestions` | `boolean` | `false` | 轮次后提示建议 |
| `resume` | `string` | - | 恢复的 session ID |
| `resumeSessionAt` | `string` | - | 在某 message UUID 处恢复 |
| `sandbox` | `SandboxSettings` | - | 沙箱配置 |
| `sessionId` | `string` | 自动生成 | 指定会话 UUID |
| `sessionStore` | `SessionStore` | - | 外部会话存储 |
| `settings` | `string \| Settings` | - | 内联设置或文件路径 |
| `settingSources` | `SettingSource[]` | CLI 默认全部 | 文件系统设置源 |
| `skills` | `string[] \| 'all'` | - | 可用 skills |
| `systemPrompt` | `string \| preset 对象` | 最小提示 | 系统提示 |
| `thinking` | `ThinkingConfig` | 模型支持时 adaptive | 思考配置 |
| `tools` | `string[] \| preset` | - | 工具配置 |
| `toolAliases` | `Record<string, string>` | - | 内置工具 → MCP 工具映射 |
| `toolConfig` | `ToolConfig` | - | 内置工具行为 |
| `pathToClaudeCodeExecutable` | `string` | 自动解析 | CLI 路径 |
| `strictMcpConfig` | `boolean` | `false` | 仅用传入的 mcpServers |
| `stderr` | `(data: string) => void` | - | stderr 回调 |
| `title` | `string` | - | 会话显示标题 |
| `outputFormat` | `{ type: 'json_schema', schema }` | - | 结构化输出 |

### 常用环境变量（经 `env` 传入）

| 变量 | 说明 |
|------|------|
| `API_TIMEOUT_MS` | 单次 API 超时，默认 600000 |
| `CLAUDE_CODE_MAX_RETRIES` | 最大重试次数，默认 10 |
| `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS` | 后台子代理停滞超时 |
| `CLAUDE_ENABLE_STREAM_WATCHDOG` / `CLAUDE_STREAM_IDLE_TIMEOUT_MS` | 流空闲中止 |
| `CLAUDE_AGENT_SDK_CLIENT_APP` | User-Agent 中标识应用 |

```ts
options: {
  env: {
    ...process.env,
    API_TIMEOUT_MS: "120000",
    CLAUDE_CODE_MAX_RETRIES: "2",
  },
}
```

---

## `Query` 对象方法

```ts
interface Query extends AsyncGenerator<SDKMessage, void> {
  interrupt(): Promise<SDKControlInterruptResponse | undefined>;
  rewindFiles(userMessageId: string, options?: { dryRun?: boolean }): Promise<RewindFilesResult>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
  setMaxThinkingTokens(maxThinkingTokens: number | null): Promise<void>; // 已弃用
  applyFlagSettings(settings: Partial 可 null): Promise<void>;
  initializationResult(): Promise<SDKControlInitializeResponse>;
  reinitialize(): Promise<SDKControlInitializeResponse>;
  supportedCommands(): Promise<SlashCommand[]>;
  supportedModels(): Promise<ModelInfo[]>;
  supportedAgents(): Promise<AgentInfo[]>;
  mcpServerStatus(): Promise<McpServerStatus[]>;
  accountInfo(): Promise<AccountInfo>;
  reconnectMcpServer(serverName: string): Promise<void>;
  toggleMcpServer(serverName: string, enabled: boolean): Promise<void>;
  setMcpServers(servers: Record<string, McpServerConfig>): Promise<McpSetServersResult>;
  streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>;
  stopTask(taskId: string): Promise<void>;
  close(): void;
}
```

| 方法 | 说明 |
|------|------|
| `interrupt()` | 中断查询（流式输入模式）；新 CLI 返回 `still_queued` 收据 |
| `rewindFiles()` | 回滚到指定用户消息时的文件状态（需 `enableFileCheckpointing`） |
| `setPermissionMode` / `setModel` | 运行中改权限/模型（流式输入模式） |
| `applyFlagSettings()` | 运行时合并任意设置到 flag 层（`null` 清除键） |
| `initializationResult()` / `reinitialize()` | 初始化信息 / 断线后重发 initialize |
| `supportedCommands/Models/Agents` | 查询能力列表 |
| `mcpServerStatus` 等 | MCP 状态与动态管理 |
| `streamInput` | 多轮流式输入 |
| `stopTask` | 停止后台任务 |
| `close` | 强制结束并清理 |

### `WarmQuery`

```ts
interface WarmQuery extends AsyncDisposable {
  query(prompt: string | AsyncIterable<SDKUserMessage>): Query;
  close(): void;
}
```

每个 `WarmQuery` 的 `query()` 只能调用一次。

---

## 关键类型

### `AgentDefinition`

| 字段 | 必需 | 说明 |
|------|------|------|
| `description` | 是 | 何时使用该代理 |
| `prompt` | 是 | 系统提示 |
| `tools` / `disallowedTools` | 否 | 工具白/黑名单 |
| `model` | 否 | 模型覆盖或 `inherit` |
| `mcpServers` | 否 | `AgentMcpServerSpec[]` |
| `skills` | 否 | 预加载 skill 名 |
| `initialPrompt` | 否 | 作主代理时自动首轮 |
| `maxTurns` | 否 | 最大轮次 |
| `background` | 否 | 后台非阻塞 |
| `memory` | 否 | `user` / `project` / `local` |
| `effort` | 否 | 努力级别或数字 |
| `permissionMode` | 否 | 权限模式 |

### `SettingSource`

```ts
type SettingSource = "user" | "project" | "local";
```

- `user` → `~/.claude/settings.json`
- `project` → `.claude/settings.json`
- `local` → `.claude/settings.local.json`

**优先级（高→低，文件系统层）**：local > project > user。  
编程选项覆盖 user/project/local；托管策略高于编程选项。

`settingSources: []` 可禁用文件系统设置源。

### `PermissionMode`

```ts
type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk"
  | "auto";
```

### `CanUseTool` / `PermissionResult`

```ts
type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    suggestions?: PermissionUpdate[];
    blockedPath?: string;
    decisionReason?: string;
    toolUseID: string;
    agentID?: string;
    requestId: string;
  }
) => Promise<PermissionResult | null>;

type PermissionResult =
  | { behavior: "allow"; updatedInput?; updatedPermissions?; toolUseID? }
  | { behavior: "deny"; message: string; interrupt?; toolUseID? };
```

仅当权限流落到「需要提示」时调用。返回 `null` 仅用于应用已通过自有通道回传 `control_response` 的情况。

### MCP 服务器配置

```ts
type McpServerConfig =
  | McpStdioServerConfig   // { type?: "stdio", command, args?, env? }
  | McpSSEServerConfig     // { type: "sse", url, headers? }
  | McpHttpServerConfig    // { type: "http", url, headers? }
  | McpSdkServerConfigWithInstance; // { type: "sdk", name, instance }
```

### `SdkPluginConfig`

```ts
{ type: "local"; path: string; skipMcpDiscovery?: boolean }
```

### `ThinkingConfig`

```ts
type ThinkingConfig =
  | { type: "adaptive"; display?: "summarized" | "omitted" }
  | { type: "enabled"; budgetTokens?: number; display?: ... }
  | { type: "disabled" };
```

### `ToolConfig`

```ts
{ askUserQuestion?: { previewFormat?: "markdown" | "html" } }
```

---

## 消息类型（`SDKMessage` 联合）

| 类型 | `type` / 特征 | 用途 |
|------|----------------|------|
| `SDKAssistantMessage` | `assistant` | 助手完整回复（含 Anthropic `BetaMessage`） |
| `SDKUserMessage` | `user` | 用户输入；`shouldQuery: false` 可只记日志不触发轮次 |
| `SDKUserMessageReplay` | `user` + `isReplay: true` | 重放/注入用户消息 |
| `SDKResultMessage` | `result` | 最终结果：`success` 或多种 `error_*` |
| `SDKSystemMessage` | `system` / `init` | 初始化：tools、model、capabilities 等 |
| `SDKPartialAssistantMessage` | `stream_event` | 部分流事件（需 `includePartialMessages`） |
| `SDKCompactBoundaryMessage` | `compact_boundary` | 压缩边界 |
| `SDKInformationalMessage` | `informational` | 信息横幅 |
| `SDKPermissionDeniedMessage` | `permission_denied` | 自动拒绝工具 |
| `SDKPluginInstallMessage` | `plugin_install` | 插件安装进度 |
| `SDKTaskNotification/Started/Progress/Updated` | 任务相关 | 后台任务生命周期 |
| `SDKBackgroundTasksChangedMessage` | `background_tasks_changed` | 实时后台任务全集 |
| `SDKHookStarted/Progress/Response` | hook 生命周期 | 需 `includeHookEvents`（部分始终发送） |
| `SDKToolProgressMessage` | `tool_progress` | 工具执行进度 |
| `SDKThinkingTokensMessage` | `thinking_tokens` | 思考 token 估计 |
| `SDKPromptSuggestionMessage` | `prompt_suggestion` | 下一轮提示建议 |
| `SDKConversationResetMessage` | `conversation_reset` | 对话被重置 |
| `SDKRateLimitEvent` | `rate_limit_event` | 速率限制 |
| … | 其他 system 事件 | 状态、鉴权、本地命令输出等 |

**`SDKResultMessage`（成功）关键字段**：`result`、`duration_ms`、`num_turns`、`total_cost_usd`、`usage`、`modelUsage`、`permission_denials`、`structured_output?`、`terminal_reason?` 等。

---

## Hook 类型

### `HookEvent`

`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`PostToolBatch`、`Notification`、`UserPromptSubmit`、`SessionStart`、`SessionEnd`、`Stop`、`SubagentStart`、`SubagentStop`、`PreCompact`、`PermissionRequest`、`Setup`、`TeammateIdle`、`TaskCompleted`、`ConfigChange`、`WorktreeCreate`、`WorktreeRemove`、`MessageDisplay`

### 注册方式

```ts
hooks: {
  PreToolUse: [{
    matcher?: string,          // 可选匹配器
    hooks: [async (input, toolUseID, { signal }) => ({ ... })],
    timeout?: number,          // 秒
  }],
}
```

### `HookJSONOutput`（同步要点）

- 通用：`continue`、`suppressOutput`、`stopReason`、`decision`、`systemMessage`、`reason`
- `PreToolUse` 专有：`permissionDecision: "allow"|"deny"|"ask"|"defer"`、`updatedInput`、`additionalContext`
- `PermissionRequest`：返回 allow/deny 决策
- `PostToolUse`：`updatedToolOutput` 等
- 异步：`{ async: true, asyncTimeout? }`

所有 hook 输入继承 `BaseHookInput`（`session_id`、`transcript_path`、`cwd`、`prompt_id?` 等）。

---

## 内置工具：输入 / 输出（名称与用途）

| 工具 | 输入要点 | 输出要点 |
|------|----------|----------|
| **Agent**（旧名 Task） | `description`, `prompt`, `subagent_type?`, `model?`, `run_in_background?`, `mode?`, `isolation?` | `completed` / `async_launched` / `remote_launched` |
| **AskUserQuestion** | `questions[]`（含 options、multiSelect） | `answers`、可选 `response` |
| **Bash** | `command`, `timeout?`, `run_in_background?`, `dangerouslyDisableSandbox?` | `stdout`/`stderr`/`interrupted`/`backgroundTaskId?` |
| **Monitor** | `command` 或 `ws` 二选一, `description`, `persistent?` | `taskId`, `timeoutMs` |
| **TaskOutput** | `task_id`, `block`, `timeout` | 后台任务输出 |
| **Edit** | `file_path`, `old_string`, `new_string`, `replace_all?` | 结构化 diff |
| **Read** | `file_path`, `offset?`, `limit?`, `pages?` | text/image/notebook/pdf/parts |
| **Write** | `file_path`, `content` | create/update + patch |
| **Glob** | `pattern`, `path?` | `filenames`, `truncated` |
| **Grep** | `pattern`, 类 ripgrep 选项 | content/files/count 模式 |
| **TaskStop** | `task_id` | 确认消息 |
| **NotebookEdit** | `notebook_path`, `new_source`, `edit_mode?` | 编辑结果 |
| **WebFetch** | `url`, `prompt` | `result`, HTTP 元数据 |
| **WebSearch** | `query`, 域名过滤 | `results` |
| **Workflow** | `script`/`name`/`scriptPath`, `args?`, `resumeFromRunId?` | 立即 `async_launched` + `taskId`/`runId` |
| **TodoWrite** | `todos[]` | 旧/新 todo（**默认已禁用**，建议用 Task*） |
| **TaskCreate/Update/Get/List** | 任务 CRUD | 任务对象或列表 |
| **ExitPlanMode** | （`allowedPrompts` 已弃用） | `plan` 等 |
| **ListMcpResources** / **ReadMcpResource** | `server?` / `server`+`uri` | 资源列表/内容 |
| **EnterWorktree** | `name?` 或 `path?` | `worktreePath`, `worktreeBranch?` |

类型均从 `@anthropic-ai/claude-agent-sdk` 导出为 `ToolInputSchemas` / `ToolOutputSchemas` 联合。

---

## 权限更新类型

```ts
type PermissionUpdate =
  | { type: "addRules" | "replaceRules" | "removeRules"; rules; behavior; destination }
  | { type: "setMode"; mode: PermissionMode; destination }
  | { type: "addDirectories" | "removeDirectories"; directories; destination };

type PermissionBehavior = "allow" | "deny" | "ask";
type PermissionUpdateDestination =
  | "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg";
type PermissionRuleValue = { toolName: string; ruleContent?: string };
```

---

## 其他常用类型

| 类型 | 说明 |
|------|------|
| `SlashCommand` | `{ name, description, argumentHint, aliases? }` |
| `ModelInfo` | 模型 value、displayName、effort/fast/adaptive 支持等 |
| `AgentInfo` | 子代理 name/description/model |
| `McpServerStatus` | 连接状态、tools、error、config |
| `AccountInfo` | email/org/subscription 等 |
| `ModelUsage` | 每模型 token 与 `costUSD` 估计 |
| `Usage` / `NonNullableUsage` | 令牌与缓存用量 |
| `CallToolResult` | MCP 工具返回：`content`、`structuredContent?`、`isError?` |
| `SpawnedProcess` / `SpawnOptions` | 自定义 `spawnClaudeCodeProcess` |
| `RewindFilesResult` | `canRewind`, `filesChanged?` 等 |
| `McpSetServersResult` | `{ added, removed, errors }` |
| `AbortError` | 中止错误类 |
| `SdkBeta` | 如 `"context-1m-2025-08-07"`（已停用，1M 上下文改用新模型标准支持） |

---

## 沙箱配置

### `SandboxSettings`

| 属性 | 默认 | 说明 |
|------|------|------|
| `enabled` | `false` | 启用沙箱 |
| `failIfUnavailable` | `true` | 无法启动则失败 |
| `autoAllowBashIfSandboxed` | `true` | 沙箱内自动允许 bash |
| `excludedCommands` | `[]` | 始终出沙箱的命令 |
| `allowUnsandboxedCommands` | `true` | 允许模型请求出沙箱 |
| `network` | - | `SandboxNetworkConfig` |
| `filesystem` | - | 读写限制 |
| `ignoreViolations` | - | 忽略规则 |
| `enableWeakerNestedSandbox` | `false` | 弱嵌套沙箱 |
| `ripgrep` | - | 自定义 ripgrep |

### `SandboxNetworkConfig`

`allowedDomains` / `deniedDomains` / `allowLocalBinding` / `allowUnixSockets` / `allowAllUnixSockets` / 代理端口等。

### `SandboxFilesystemConfig`

`allowWrite` / `denyWrite` / `denyRead` 路径模式。

出沙箱命令会回落到 `canUseTool`；`bypassPermissions` + `allowUnsandboxedCommands` 组合风险极高，需谨慎。

---

## 快速参考：典型组合

```ts
import {
  query,
  tool,
  createSdkMcpServer,
  listSessions,
  startup,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// 自定义 MCP 工具
const myTool = tool("echo", "Echo input", { text: z.string() }, async ({ text }) => ({
  content: [{ type: "text", text }],
}));
const mcp = createSdkMcpServer({ name: "local", tools: [myTool] });

// 主查询
for await (const msg of query({
  prompt: "帮我审查代码",
  options: {
    cwd: "/path/to/project",
    maxTurns: 10,
    permissionMode: "acceptEdits",
    settingSources: ["project"],
    mcpServers: { local: mcp },
    systemPrompt: { type: "preset", preset: "claude_code" },
    thinking: { type: "adaptive" },
    sandbox: { enabled: true, autoAllowBashIfSandboxed: true },
  },
})) {
  if (msg.type === "result") console.log(msg);
}
```

---

以上覆盖了该文档页中的主要导出函数、配置、Query 方法、消息/Hook/工具/权限/沙箱类型及用法。若你需要，我可以再单独拆成「仅函数 API」「仅类型定义」或「可直接粘贴的 cheatsheet」版本。