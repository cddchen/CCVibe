# Cloud 移动端开发 Roadmap

> 状态：执行中  
> 客户端：`repos/cloud-mobile`  
> 服务端：`repos/cc-agent-host`  
> 产品范围：iOS 与 Android 共用 React Native 业务代码，平台材质遵循各自系统规范

## 1. 产品目标

Cloud 是 `cc-agent-host` 的远程移动控制端。Agent 与 Claude Agent SDK Query 始终运行在服务端；移动端只负责连接、浏览、发送、流式展示、停止、授权和结构化输入，不能成为会话或权限的第二权威来源。

首个可交付版本包含：

- 通过 `wss://` 和 Bearer token 连接一个 Cloud Host，并安全保存连接配置。
- 首页选择服务端工作目录和模型，创建新会话；首屏下方展示按项目分组的会话列表。
- 会话页显示用户消息、流式 Markdown、思考、工具调用、结果和运行状态。
- 在多个客户端同时连接时，按 `serverSeq` 应用服务端权威动作；重连时接受 replay 或 snapshot。
- 展示并处理工具权限与 `AskUserQuestion`；first-writer-wins，以服务端回执为准。
- iOS 26 使用系统 Liquid Glass；旧 iOS 降级为系统 Blur；开启“减少透明度”或能力不可用时使用实体表面。
- Android 使用 Material 3 颜色、层级、shape、motion 和 bottom sheet，不伪造 Apple Liquid Glass。

## 2. 权威证据与约束顺序

1. `@anthropic-ai/claude-agent-sdk` 自带类型与 `repos/cc-agent-host` 生产代码。
2. `repos/cc-agent-host/src/protocol/schemas.ts` 与领域 action/state 类型。
3. 自动化测试和真实 iOS/Android 运行结果。
4. `harness.md` 与 `docs/daemon/*`。
5. `移动端设计稿.pdf`、Cloud 高保真视觉稿和参考项目。

文档与实现冲突时，不在客户端猜测服务端语义；先修正协议 owner，再更新客户端 adapter。

## 3. 目标架构

```text
repos/cloud-mobile
  app/                         # Expo Router 薄路由
  src/
    domain/                    # 纯状态、selectors、grouping、reducers
    protocol/                  # JSON-RPC schemas/codecs，禁止 SDK raw type
    sync/                      # WebSocket、initialize/reconnect/subscription orchestration
    storage/                   # SecureStore/AsyncStorage adapters
    features/
      connection/              # Host 登录与恢复
      home/                    # 工作区、模型、会话目录、新建会话
      chat/                    # transcript、composer、tool/permission/input
    ui/
      glass/                   # iOS capability resolver 与 material primitives
      material/                # Android Material 3 primitives/tokens
      common/                  # 跨平台语义组件
```

服务端补齐：

```text
repos/cc-agent-host/src/catalog/     # root/session catalog state 与纯投影
repos/cc-agent-host/src/protocol/    # catalog RPC/schema/state provider 组合
repos/cc-agent-host/src/claude/      # SDK listSessions/model adapter
```

## 4. 跨层不变量

### 4.1 状态和同步

- Host 是工作区、会话、turn、工具和交互请求的唯一权威。
- 客户端仅保留连接配置、最近选择和服务端快照缓存；不得本地制造 canonical session。
- `serverSeq` 全局单调但频道过滤后允许空洞；客户端只要求 `next > current`，不要求 `+1`。
- epoch 相同且回放可用时应用 replay；否则 snapshot 原子替换相关资源。
- optimistic UI 只用于已明确可对账的命令，必须由 `commandId` 和 canonical receipt 收敛。
- App 后台或某客户端断开不停止服务端 active turn，也不自动拒绝 pending approval。

### 4.2 类型边界

- Claude SDK raw 类型只存在于 `cc-agent-host/src/claude`。
- Host adapter 使用 SDK 的 `Parameters<>`、`ReturnType<>`、`Awaited<>`、`satisfies`，不复制 SDK union。
- 网络输入在进入客户端 domain 前用 Zod 严格解析；领域层不接收 `any` 或未校验 `unknown`。
- 协议 contract 从 Host 导出为独立 workspace 包或生成 JSON Schema；移动端不手写第二份相似定义。

### 4.3 纯函数和副作用

必须是纯函数：URI/ID 校验、action reducer、snapshot/replay 决策、会话分组排序、模型选项投影、权限展示模型、连接地址规范化、material capability 决策。

允许持有状态的壳层仅包括：WebSocket client、reconnect supervisor、SecureStore adapter、Expo Router 和 React store。时间、随机 ID、平台能力都从边界注入。

### 4.4 安全

- token 只通过 `Authorization: Bearer` 发送，不进入 URL、日志、错误、action 或 analytics。
- `ws://` 只允许显式开发模式；产品配置默认要求 `wss://`。
- token 使用 `expo-secure-store`；非敏感偏好才使用 AsyncStorage。
- 权限按钮在 canonical resolve 返回前防重复提交；并发失败显示“已由其他客户端处理”。
- 任何未经 schema 校验的 tool input 都只以只读 JSON/文本展示，不能直接执行。

### 4.5 可访问性与性能

- 尊重字体缩放、Reduce Motion、Reduce Transparency、深色模式和最小 44pt/48dp 点击目标。
- 大会话使用虚拟列表，delta 只更新对应 part；输入框 keystroke 不触发整个 transcript 重渲染。
- blur/glass 只用于浮动 chrome 与关键控件，不覆盖长列表内容；Android 低版本不启用高成本实时 blur。
- 保持 last-known-good 内容，刷新和重连不得闪空。

## 5. 服务端协议缺口

当前协议只为 `agent-chat://` 返回状态，`agent-root://` 和 `agent-session://` 会被标记 missing。移动端首页还缺少以下 canonical 能力：

- 工作区目录列表与 Host 连接状态。
- 按工作区分组的会话摘要、标题、更新时间和运行状态。
- 模型目录与默认模型。
- 新建 provisional chat，并返回 `ChatUri`。
- archive/rename（首版 UI 可暂不暴露，但 schema 需避免未来破坏性重构）。

这些能力必须在 Phase 1 由 Host 补齐，移动端不得用固定 `CCVibe`、`cc-agent-host` 或模型数组冒充服务端数据。

## 6. Phase 路线

| Phase | 目标 | 主要退出条件 |
| --- | --- | --- |
| 0 | 移动端工程与共享 contract 内核 | iOS/Android 工程可启动；纯 reducer/codec/typecheck 全绿 |
| 1 | Host catalog 与会话创建协议 | root snapshot 返回工作区、会话、模型；create chat 有幂等测试 |
| 2 | 安全连接与多客户端同步 | initialize/reconnect/replay/snapshot/替换连接自动化测试通过 |
| 3 | 首页与新会话流程 | 目录、模型、输入、会话分组均接真实 state；视觉与交互验收通过 |
| 4 | 会话、工具和权限流程 | streaming/interrupt/approval/input 全链路通过，重连状态不丢 |
| 5 | 平台材质、可访问性与发布门 | iOS 26/旧 iOS/Android 三条视觉能力路径和端到端 smoke 通过 |

详细交付合同见同目录 `phase-00` 至 `phase-05` 文档。

## 7. 统一验证门

每个 production behavior 变更遵循 RED -> GREEN。最终必须提供：

- Host：`npm run typecheck && npm test && npm run build`。
- Mobile：`npm run typecheck && npm test && npm run lint`。
- Expo config 检查和 iOS/Android 原生构建至少各一次。
- 真机/模拟器场景：登录、首页、创建、发送、流式、停止、权限 allow/deny、结构化输入、后台恢复、断线重连、第二客户端抢先处理权限。
- iOS 26 原生 glass、旧 iOS blur/solid fallback、Android Material 3 的截图证据和可访问性检查。

## 8. 非目标

- 在移动端运行 Claude Agent SDK 或 shell。
- 复制 Claude transcript 作为客户端权威数据库。
- 首版实现多 Host 聚合、云账号系统、推送通知或离线发送。
- 用跨平台半透明卡片强行统一 iOS 与 Android 的视觉语言。
