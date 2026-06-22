# Claude Code 程序化集成调研：`claude -p`（headless）vs Agent SDK

> 目的：为"本地 daemon + 自定义 Web/App UI + 多端"平台选择结构化集成方案。
> 关联文档：`cui-research.md`（CUI 手搓 `-p`）、`ccgui-research.md`（ccgui 手搓 `-p`）。
> 信息来源：Anthropic / Claude Code 官方文档（见文末 Sources），截至 2026-06。

---

## 0. 先厘清立场（重要）

- `claude -p`（print / headless 模式）**没有被弃用**，官方仍推荐用于 CI、pre-commit hook、脚本、自动化。
- 老的 **"Claude Code SDK" 已改名为 "Claude Agent SDK"**：包名 `@anthropic-ai/claude-agent-sdk`（TS）、`claude-agent-sdk`（Python）。
- 对于**"自己写程序做产品集成"**，官方推荐 **Agent SDK**，而不是手搓原始 CLI 流（CUI / ccgui 走的就是被替代的那条路）。
- **两者都是"结构化事件流"，都不是 PTY。** Agent SDK **底层就是 spawn 并托管一个 `claude` CLI 子进程**——它不是另一个引擎，而是对 headless 能力的官方封装。

一句话：**`-p` 是底层原语，Agent SDK 是它的官方托管层。** 选型不是"二选一引擎"，而是"自己管 vs SDK 帮你管"。

---

## Part A — `claude -p`（Headless 模式）方案

### A.1 是什么 / 调用形态
非交互地跑一轮，输出可解析的流，进程结束。典型形态（回合制）：

```bash
# 单轮、纯文本输出
claude -p "总结这个仓库的架构"

# 单轮、流式 JSON 事件（NDJSON）
claude -p "..." --output-format stream-json --verbose --include-partial-messages

# 多模态/多行/受控输入：消息走 stdin
echo '<stream-json 消息对象>' | claude -p --input-format stream-json \
  --output-format stream-json --verbose
```

### A.2 关键 flags

| flag | 作用 |
|---|---|
| `-p` / `--print` | 非交互打印模式（headless 入口） |
| `--output-format` | `text` / `json` / `stream-json`（NDJSON 事件流） |
| `--input-format` | `text` / `stream-json`（stdin 推消息对象，支持多模态/多行/流中交互） |
| `--include-partial-messages` | 流式增量文本块（打字机效果） |
| `--verbose` | 输出更多事件（init、工具、结果等） |
| `--bare` | **跳过** hooks / skills / plugins / MCP / auto memory / CLAUDE.md 的发现加载；官方推荐用于脚本 & SDK 风格调用，启动更轻更可预测 |
| `--resume <id>` / `--continue` | 恢复指定会话 / 恢复最近会话 |
| `--session-id <uuid>` | 给新会话钉一个稳定 UUID 身份（防并发塌缩） |
| `--fork-session` | 配合 `--resume`，从父会话分叉出新会话 |
| `--permission-mode` | `default` / `plan` / `acceptEdits` 等 |
| `--allowedTools` / `--disallowedTools` | 工具白/黑名单 |
| `--dangerously-skip-permissions` | 跳过所有权限检查（危险） |
| `--permission-prompt-tool <mcp_tool>` | **headless 下处理权限审批的关键**：指定一个 MCP 工具来回答"是否允许此工具调用" |
| `--replay-user-messages` | 回放用户消息（流式输入时对齐时间线） |

### A.3 输入 / 输出形态
- **输出**：`stream-json` = 一行一条 JSON 事件（NDJSON）：`system/init`（带 session_id 等元数据）、assistant 消息/增量、工具调用、工具结果、`result`（终态）等。需要你**自己解析并渲染**成 UI。
- **输入**：`--input-format stream-json` 时，把消息对象写进 stdin，可用于多模态、超长文本、以及**流中向 Claude 回写**（如审批回答）。
  - ⚠️ 注意：官方文档**没有完整公开** stdin 这个 stream-json 的精确 schema —— 这正是手搓方案的脆弱点（CUI/ccgui 都是逆向 + 经验拼出来的）。

### A.4 权限处理（headless 的难点）
没有交互 UI，所以工具审批要靠：
- `--permission-prompt-tool` 指向一个 MCP 工具，Claude 要用工具时回调它拿"allow/deny"；或
- `--allowedTools` 预先放行；或 `--dangerously-skip-permissions` 全放（危险）。
这块是手搓 `-p` 最容易出错的地方（CUI/ccgui 都自建了 MCP 权限回流）。

### A.5 优点 / 缺点
- ✅ 零依赖运行时（直接调用 CLI 二进制）；语言无关（任何能起子进程的语言都行，Rust/Go/…）。
- ✅ 适合脚本、CI、轻量探针。`--bare` 让行为更可预测。
- ❌ 会话管理（resume/fork/session-id）、权限回流、流解析、断流处理**全得自己实现**且要跟版本演进。
- ❌ stdin 输入 schema 未完全公开 → 升级易踩坑。
- ❌ 每轮起进程的回合制；非 PTY，拿不到交互式 REPL/部分本地 slash。

### A.6 适用
CI / 脚本 / 一次性任务 / 非 JS 后端只想要"调一下"的轻量场景。

---

## Part B — Claude Agent SDK 方案

### B.1 是什么
官方的程序化集成库（原 Claude Code SDK 改名而来）。提供 TypeScript / Python 两套。把 Claude Code 的 agent loop、工具、上下文、会话、权限都封装成库 API。

### B.2 架构（关键认知）
- SDK **spawn 并监管一个 `claude` CLI 子进程**——底层能力和 `-p` 是同一套。
- **TS SDK 自带一个原生 Claude Code 二进制**（作为 optional dependency，自 v0.2.113 起从打包 JS 改为原生二进制）→ **不需要单独安装 Claude Code CLI**。
  - 运行 TS SDK 本身需要 **Node.js 18+**。
  - 若包管理器跳过了 optional deps，可用 `pathToClaudeCodeExecutable` 指向外部 `claude` 二进制。
- 含义：**SDK 把"自定义 UI 用的结构化事件流"以受支持、随版本维护的方式给你**，省掉手搓 `-p` 的解析/会话/权限活儿。

### B.3 两种调用模式
- **单轮 `query()`**：一问一答，最简单（等价于一次 `claude -p`）。
- **流式 / 有状态会话**：
  - TS：`query()` 传入 `AsyncIterable` 作为流式输入；返回的 `Query` 暴露 `streamInput()`、`interrupt()`、`setPermissionMode()`。
  - Python：`ClaudeSDKClient`（有状态、多轮的对应物）。
  - 官方推荐**流式模式**用于多轮上下文、排队消息、中断、工具集成。

TS 流式示例（示意）：
```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

const q = query({
  prompt: inputStream,            // AsyncIterable<用户消息>
  options: {
    permissionMode: "default",
    allowedTools: ["Read", "Edit", "Bash"],
    canUseTool: async (tool, input) => {  // 工具审批回调
      const ok = await askMyUI(tool, input);
      return ok
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: "user denied" };
    },
    hooks: { /* PreToolUse / PostToolUse / PermissionRequest */ },
    mcpServers: { /* ... */ },
    systemPrompt: { preset: "claude_code", append: "额外指令" },
    settingSources: ["project"],  // 是否加载 CLAUDE.md / output styles
  },
});

for await (const msg of q) {
  // msg 是结构化 SDKMessage → 渲染成你自己的 Web/App UI
}
```

### B.4 消息类型与会话
- 事件是 **`SDKMessage` 联合类型**：
  - `SDKSystemMessage`（init）携带 `session_id`、`cwd`、`tools`、`mcp_servers`、`model`、`permissionMode` 等元数据。
  - `ResultMessage.session_id` 就是**之后用来 resume 的会话 id**。
- 会话操作：`continue`（接最近）/ `resume`（按 id）/ `fork`（复制历史开新会话）。
- ⚠️ **会话文件是机器本地的**：跨主机 resume 需要你自己镜像 transcript —— 对"本地 daemon 是事实源、多端接入"的架构正好契合（会话留在本机 daemon，远端不直接 resume）。

### B.5 权限 / hooks / 自定义工具 / MCP
- **权限**：`permissionMode` + `allowedTools`/`disallowedTools` + **`canUseTool` 回调**。回调返回 `{behavior:"allow", updatedInput}` 或 `{behavior:"deny", message}`，还能用于澄清式追问。**这比手搓 `--permission-prompt-tool` 干净得多。**
- **hooks**：`PreToolUse` / `PostToolUse` / `PermissionRequest`，支持按工具名 / MCP 名匹配，做 allow/deny/改写。
- **自定义工具**：进程内 `tool()` / `createSdkMcpServer()`，命名 `mcp__server__tool`。
- **MCP**：`mcpServers` 配置外部工具，支持多种 transport/auth。
- **系统提示**：`systemPrompt` 支持 `claude_code` preset + `append`；`settingSources` 控制是否加载 `CLAUDE.md` / output styles。

### B.6 优点 / 缺点
- ✅ 会话 / 权限 / 流式 / 中断 / 分支**官方托管**，随版本维护，少踩坑。
- ✅ `canUseTool`、hooks、custom tools、MCP 等是**一等公民 API**。
- ✅ 结构化 `SDKMessage` → 直接喂你的自定义 UI。
- ✅ TS 自带二进制，部署不必单独装 CLI。
- ❌ 仅 TS / Python（Rust/Go 后端要么走子进程桥接，要么回退 `-p`）。
- ❌ TS 需 Node 18+ 运行时。
- ❌ 仍非 PTY → 交互式本地 slash（local-jsx 选单类）仍拿不到。

### B.7 适用
产品级集成 / 多轮有状态会话 / 需要权限回流与工具控制 / 想自定义 UI —— **即你的平台主场景**。

---

## Part C — 对比与选型

### C.1 总对比表

| 维度 | `claude -p`（headless） | Claude Agent SDK |
|---|---|---|
| 定位 | 底层原语 | `-p` 的官方托管封装 |
| 底层 | 直接起 CLI 子进程 | **同样 spawn CLI 子进程**（TS 自带二进制） |
| 语言 | 任意（起子进程即可） | TS / Python |
| 运行时 | 仅需 CLI 二进制 | TS 需 Node 18+ |
| 数据形态 | 结构化 NDJSON（自己解析） | 结构化 `SDKMessage`（类型化） |
| 是否 PTY | 否 | 否 |
| 会话 resume/fork | 自己拼 flag | 一等 API（continue/resume/fork） |
| session_id 获取 | 解析 `system/init` | `SystemMessage` / `ResultMessage.session_id` |
| 权限审批 | `--permission-prompt-tool` / 手搓 MCP 回流 | **`canUseTool` 回调** + hooks |
| 流中交互 / 中断 | 手写 stdin（schema 未公开） | `streamInput()` / `interrupt()` |
| hooks / custom tools / MCP | 靠配置 + 自建 | 一等 API |
| 维护成本 | 高（跟版本逆向） | 低（官方维护） |
| 本地 slash 完整度 | 无（回合制） | 无（回合制） |
| 官方推荐用于 | CI / 脚本 / 自动化 | **产品集成 / 生产 agent** |

### C.2 共同点 & 关键差异
- **共同点**：都是结构化事件流、都是回合制（非 PTY）、底层都是同一个 CLI/harness。所以"自定义 UI 走结构化流"的结论对两者都成立。
- **关键差异**：**谁来管会话、权限、流式、断流、版本演进。** SDK 帮你管；`-p` 你自己管。CUI/ccgui 选了自己管（彼时 SDK 较弱/未成熟），代价是大量自建代码 + 跟版本踩坑。

### C.3 对你平台的推荐

**结构化主轨 = Agent SDK；`-p`/`--bare` 作辅助；PTY 作可选兜底。**

1. **主轨（自定义 Web/App UI）→ Agent SDK（TS）**
   - 会话/权限/流式/中断由 SDK 托管，`SDKMessage` 直接喂你的前端渲染。
   - `canUseTool` 把权限审批接到你自己的 UI（按钮/弹窗），比手搓 `--permission-prompt-tool` 干净。
   - 但这要求承载结构化轨的进程是 **Node 18+**。你的 daemon 当前若是 Rust（参考 ccgui），有两条路：
     - (a) daemon 内嵌/旁挂一个 **Node 侧 SDK worker**，Rust 通过本地 IPC 调它；
     - (b) daemon 直接用 Rust 起 `claude -p`（即 `-p` 方案），放弃 SDK 托管。
   - **取舍**：要 SDK 的红利就接受 Node 运行时；要纯 Rust 单体就回退 `-p` 自己管。这是你要拍的板。

2. **辅助轨 → `claude -p --bare`**
   - 用于轻量、一次性、非会话的任务（生成标题、提交信息、健康探针等），启动轻、可预测。

3. **可选兜底 → PTY + xterm.js**
   - 只为极少数交互式本地 slash 留一个"原始终端"逃生舱，不做主界面。

4. **会话本地化约束（务必设计进去）**
   - 会话文件在创建它的机器本地；**让本机 daemon 成为会话事实源**，远端客户端通过 daemon 间接 resume，而不是自己跨主机 resume。与你的 Model A 完全吻合。

### C.4 一句话决策
- **你想要的"自定义 UI + 多端 + 本地 daemon"→ 首选 Agent SDK 作结构化主轨**（接受 Node worker），`-p --bare` 打辅助，PTY 仅兜底。
- 若坚持 **纯 Rust 单体 daemon、不引入 Node** → 退回 `-p` 自己管（像 ccgui），但要预算好会话/权限/解析的自建与维护成本。

---

## Sources
- [Run Claude Code programmatically (Headless)](https://code.claude.com/docs/en/headless)
- [CLI reference](https://code.claude.com/docs/en/cli-usage)
- [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- [Agent SDK — TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)
- [Agent SDK — Python reference](https://code.claude.com/docs/en/agent-sdk/python)
- [Agent SDK — Streaming Input vs Single Mode](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- [Agent SDK — Work with sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
- [Agent SDK — Configure permissions](https://code.claude.com/docs/en/agent-sdk/permissions)
- [Agent SDK — Handle approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input)
- [Agent SDK — Hooks](https://code.claude.com/docs/en/agent-sdk/hooks)
- [Agent SDK — MCP](https://code.claude.com/docs/en/agent-sdk/mcp) / [Custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools)
- [Agent SDK — Modifying system prompts](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts)
- [Agent SDK — Agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)
- [Agent SDK — Hosting](https://code.claude.com/docs/en/agent-sdk/hosting) / [Quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart)
- [Migrate to Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/migration-guide)
- [TypeScript SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)
- [Best practices for Claude Code](https://www.anthropic.com/engineering/claude-code-best-practices)
- [Building agents with the Claude Agent SDK](https://claude.com/blog/building-agents-with-the-claude-agent-sdk)
