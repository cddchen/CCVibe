# Claude Agent SDK 接入参考（汇总）

> 把官方 Agent SDK 接入文档汇总成一份速查/落地参考。
> 关联：`cc-integration-p-vs-agent-sdk.md`（`-p` vs SDK 选型）、`ccgui-research.md`、`cui-research.md`。
> 来源：Claude Code / Claude API 官方文档，截至 2026-06（见文末 Sources）。

---

## 1. 概览

- **它是什么**：把 Claude Code 的 agent loop（推理 → 调工具 → 观察 → 再推理）、上下文管理、会话、权限、MCP 等封装成库的官方 SDK。
- **改名**：原 "Claude Code SDK" → **"Claude Agent SDK"**。
  - TS 包：`@anthropic-ai/claude-agent-sdk`（旧 `@anthropic-ai/claude-code`）
  - Python 包：`claude-agent-sdk`（旧 `claude-code-sdk`），导入名 `claude_agent_sdk`
  - 选项类型：`ClaudeCodeOptions` → `ClaudeAgentOptions`（Python）
- **本质**：SDK **spawn 并监管一个 `claude` CLI 子进程**，给你结构化事件流。**不是 PTY**，是回合制/流式的结构化集成。

---

## 2. 安装与运行时

### TypeScript
```bash
npm i @anthropic-ai/claude-agent-sdk
```
- 需 **Node.js 18+**。
- **自带原生 Claude Code 二进制**（optional dependency，自 v0.2.113 从打包 JS 改为原生二进制）→ **无需单独安装 Claude Code CLI**。
- 若包管理器跳过 optional deps：用 `pathToClaudeCodeExecutable` 指向外部 `claude` 二进制。

### Python
```bash
pip install claude-agent-sdk
```
- 需 **Python 3.10+**。
- 同样在底层驱动 `claude` 子进程。

---

## 3. 认证

通过环境变量，凭据优先级（高 → 低）：
1. **云厂商凭据**（Bedrock / Vertex）
2. `ANTHROPIC_AUTH_TOKEN`
3. `ANTHROPIC_API_KEY`

| 方式 | 关键变量 |
|---|---|
| Anthropic 直连 | `ANTHROPIC_API_KEY`（或 `ANTHROPIC_AUTH_TOKEN`） |
| Amazon Bedrock | `CLAUDE_CODE_USE_BEDROCK=1` + AWS 凭据链/Bedrock API key |
| Google Vertex AI | `CLAUDE_CODE_USE_VERTEX=1` + GCP 项目/计费 + Google Cloud 凭据 |

`SystemMessage(init)` 里的 `apiKeySource` 会告诉你当前用的是哪种来源。

---

## 4. 两种调用模式

| 模式 | TS | Python | 适用 |
|---|---|---|---|
| **单轮 query** | `query({ prompt: "string" })` | `query(prompt="...")` | 一问一答、无状态、脚本 |
| **流式/有状态** | `query({ prompt: asyncIterable })` → `Query` | `ClaudeSDKClient` | 多轮上下文、排队消息、中断、权限回流、工具集成（**官方推荐做产品就用这个**） |

---

## 5. 代码示例

### 5.1 TypeScript — 单轮
```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const msg of query({ prompt: "总结这个仓库" })) {
  if (msg.type === "result") console.log(msg.result);
}
```

### 5.2 TypeScript — 流式 + 权限回调 + 工具控制
```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

const q = query({
  prompt: userMessageStream,            // AsyncIterable<用户消息>
  options: {
    model: "claude-opus-4-7",
    permissionMode: "default",          // default | plan | acceptEdits | bypassPermissions
    allowedTools: ["Read", "Edit", "Bash"],
    disallowedTools: [],
    maxTurns: 50,
    cwd: "/path/to/workspace",
    includePartialMessages: true,       // 打字机式增量
    settingSources: ["project"],        // 是否加载 CLAUDE.md / settings（省略=不加载）
    systemPrompt: { preset: "claude_code", append: "额外项目规则" },
    canUseTool: async (toolName, input) => {        // 工具审批 → 接你自己的 UI
      const ok = await askMyUI(toolName, input);
      return ok
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: "user denied" };
    },
    hooks: { /* PreToolUse / PostToolUse / PermissionRequest ... */ },
    mcpServers: { /* ... */ },
    agents: { /* 子代理定义，见 §11 */ },
  },
});

for await (const msg of q) {
  // msg: SDKMessage（结构化）→ 渲染成你自己的 Web/App UI
}

// 运行时控制：
await q.streamInput(nextUserMessage);   // 追加输入
await q.setPermissionMode("plan");      // 动态切权限模式
await q.interrupt();                    // 中断当前回合
```

### 5.3 Python — 有状态 ClaudeSDKClient
```python
from claude_agent_sdk import ClaudeSDKClient, ClaudeAgentOptions

async with ClaudeSDKClient(options=ClaudeAgentOptions(
    allowed_tools=["Read", "Edit", "Bash"],
    permission_mode="default",
)) as client:
    await client.query("帮我重构这个模块")
    async for msg in client.receive_response():
        ...                  # 处理结构化消息
    await client.interrupt() # 中断
```
权限拒绝可用 `PermissionResultDeny(interrupt=True)` 直接中断。

---

## 6. Options 参考（常用）

| 选项 (TS) | 说明 |
|---|---|
| `model` / `fallbackModel` | 主模型 / 失败回退模型 |
| `maxTurns` | 单次运行最大回合数 |
| `maxThinkingTokens` | 思考预算 |
| `permissionMode` | `default` / `plan` / `acceptEdits` / `bypassPermissions` |
| `allowedTools` / `disallowedTools` | 工具白/黑名单（MCP 工具名形如 `mcp__server__tool`） |
| `canUseTool` | 工具审批回调（见 §8） |
| `hooks` | 生命周期钩子（见 §9） |
| `mcpServers` | 外部/进程内 MCP（见 §10、§11） |
| `agents` | 程序化子代理定义（见 §12） |
| `systemPrompt` | `{ preset: "claude_code", append }` 或自定义（见 §13） |
| `settingSources` | 加载哪些文件系统设置（`project`/`user`/`local`）；**省略=不加载任何**；程序化选项（如 `agents`）会覆盖文件系统设置 |
| `cwd` | 工作目录 |
| `env` | 子进程环境变量 |
| `includePartialMessages` | 增量文本块 |
| `abortController`（TS）| 取消运行 |
| `pathToClaudeCodeExecutable`（TS）| 指定外部 `claude` 二进制 |
| `plugins` | 插件 |

> 注意 `settingSources` 默认行为：**不传则不加载 CLAUDE.md / settings**，要显式声明才会读项目配置。

---

## 7. 消息类型（`SDKMessage` 联合）

`SDKMessage` 是判别联合（discriminated union），核心成员：

| 类型 | subtype | 关键字段 |
|---|---|---|
| `SDKSystemMessage` | `init` | `session_id`、`cwd`、`model`、`tools`、`mcp_servers`、`permissionMode`、`slash_commands`、`agents`、`skills`、`plugins`、`output_style`、`apiKeySource`、`claude_code_version` |
| `SDKAssistantMessage` | — | `uuid`、`session_id`、`message`(`BetaMessage`)、`parent_tool_use_id`、可选 `error`（assistant 级用量在 `message` 内） |
| `SDKResultMessage` | `success` / `error_max_turns` / `error_during_execution` / `error_max_budget_usd` / `error_max_structured_output_retries` | `uuid`、`session_id`、`duration_ms`、`duration_api_ms`、`is_error`、`num_turns`、`stop_reason`、`total_cost_usd`、`usage`、`modelUsage`、`permission_denials`；`success` 额外有 `result` / `structured_output`，错误态有 `errors` |

还有流式/状态/hook/task 等事件类型。

**关键用法**：
- **会话 id**：从 `SDKSystemMessage(init).session_id` 或 `SDKResultMessage.session_id` 拿，用于之后 resume。
- **用量/成本**：`SDKResultMessage.usage`（`input_tokens`/`output_tokens`/cache 计数）、`total_cost_usd`（整段成本）、`modelUsage.costUSD`（按模型拆分）。

---

## 8. 权限

三层叠加：
1. `permissionMode`：`default`（每个工具都问）/ `plan`（只规划不执行）/ `acceptEdits`（自动接受编辑）/ `bypassPermissions`（全放，危险）。
2. `allowedTools` / `disallowedTools`：预置白/黑名单（可自动放行 MCP 工具）。
3. **`canUseTool` 回调**：运行时逐次审批，返回：
   - `{ behavior: "allow", updatedInput }`（可改写入参）
   - `{ behavior: "deny", message }`（可附理由；Python 可 `interrupt=True` 直接中断）
   - 也可用于**澄清式追问**。

> 这比手搓 `-p` 的 `--permission-prompt-tool` MCP 回流干净得多——直接把审批接到你自己的 UI 按钮/弹窗。

---

## 9. Hooks

在 agent 生命周期插入控制逻辑：
- 事件：`PreToolUse`、`PostToolUse`、`PermissionRequest`（等）。
- 支持按**工具名 / MCP 名** matcher 匹配。
- 用途：allow / deny / 改写工具输入，审计、注入上下文等。

与 `canUseTool` 的关系：`canUseTool` 专注"这次能不能用"，hooks 更通用（前后置、可改写、可观测）。

---

## 10. MCP（外部工具）

- `mcpServers` 配置外部 MCP server，支持多种 transport / auth。
- MCP 工具命名约定：`mcp__<server>__<tool>`，在 `allowedTools` 里按此名放行。

---

## 11. 自定义工具（进程内）

不必起外部进程，直接在代码里定义工具：
- TS：`tool(...)` 定义单个工具，`createSdkMcpServer(...)` 打包成进程内 MCP，挂到 `mcpServers`。
- 命名同样走 `mcp__server__tool`，受 `allowedTools` / 权限体系约束。

---

## 12. Subagents（子代理）

- 通过 **`agents` 选项**程序化定义（官方推荐方式），每个是一个 **`AgentDefinition`**。
- Claude 用每个子代理的 `description` 决定何时委派。
- 子代理是**隔离的工作单元，可并行**。
- 程序化 `agents` 会**覆盖**文件系统里的同名设置。

---

## 13. 系统提示与设置来源

- `systemPrompt`：
  - `{ preset: "claude_code" }`：用 Claude Code 的默认系统提示。
  - `{ preset: "claude_code", append: "..." }`：在默认之上追加。
  - 或完全自定义字符串。
- `settingSources`：控制是否/加载哪些文件系统设置（`CLAUDE.md`、output styles、settings）。**省略=都不加载**；要读项目配置必须显式声明。

---

## 14. 运行时控制（流式 `Query` / Client）

- `streamInput(msg)`：会话中途追加用户输入。
- `interrupt()`：中断当前回合（Python 同名）。
- `setPermissionMode(mode)`：动态切权限模式。
- TS 还可用 `abortController` 取消整段运行。

---

## 15. 部署 / Hosting 要点

- SDK = "spawn + 监管 `claude` 子进程"的架构；承载它的服务进程需对应运行时（TS→Node18+ / Python→3.10+）。
- 多会话并发：每个会话一个 SDK 运行（或一个 `ClaudeSDKClient`）；注意工作目录隔离（不同会话用不同 `cwd` / git worktree）。
- 凭据通过 env 注入子进程（`env` 选项）。

---

## 16. 对你平台（本地 daemon + 自定义 UI + 多端）的接入要点

1. **结构化主轨用 Agent SDK**：`SDKMessage` 直接喂自定义 Web/App UI；`includePartialMessages` 做流式。
2. **权限接 UI**：`canUseTool` 回调 → 你的审批弹窗，返回 allow/deny（可改写入参）。
3. **会话事实源在本机 daemon**：
   - 用 `SystemMessage/ResultMessage.session_id` 记录会话；resume/fork 用 SDK 会话 API。
   - ⚠️ **会话文件机器本地** → 远端客户端经 daemon 间接 resume，别跨主机直接 resume。契合 Model A。
4. **运行时取舍**：要 SDK 红利 = 在 daemon 旁挂一个 **Node(18+) SDK worker**（Rust daemon 经本地 IPC 调它）；若坚持纯 Rust = 退回 `-p` 自管（见对比文档）。
5. **并发隔离**：每会话独立 `cwd` / worktree，避免并行回合互相踩。
6. **轻任务可混用** `claude -p --bare`（标题/提交信息/探针），不必都走 SDK。

---

## Sources
- [Agent SDK — Overview](https://code.claude.com/docs/en/agent-sdk/overview)
- [Agent SDK — TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)
- [Agent SDK — Python reference](https://code.claude.com/docs/en/agent-sdk/python)
- [Agent SDK — Quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart) / [Hosting](https://code.claude.com/docs/en/agent-sdk/hosting)
- [Agent SDK — Streaming vs Single Mode](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- [Agent SDK — Work with sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
- [Agent SDK — Configure permissions](https://code.claude.com/docs/en/agent-sdk/permissions) / [Handle approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input)
- [Agent SDK — Hooks](https://code.claude.com/docs/en/agent-sdk/hooks)
- [Agent SDK — MCP](https://code.claude.com/docs/en/agent-sdk/mcp) / [Custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools)
- [Agent SDK — Subagents](https://code.claude.com/docs/en/agent-sdk/subagents)
- [Agent SDK — Modifying system prompts](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts)
- [Agent SDK — Agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)
- [Agent SDK — Migration guide](https://code.claude.com/docs/en/agent-sdk/migration-guide)
- [Authentication](https://code.claude.com/docs/en/authentication) / [Amazon Bedrock](https://code.claude.com/docs/en/amazon-bedrock) / [Google Vertex AI](https://code.claude.com/docs/en/google-vertex-ai)
- [TS repo](https://github.com/anthropics/claude-agent-sdk-typescript) / [Python repo](https://github.com/anthropics/claude-agent-sdk-python) / [PyPI](https://pypi.org/project/claude-agent-sdk/)
- [Building agents with the Claude Agent SDK (blog)](https://claude.com/blog/building-agents-with-the-claude-agent-sdk)
