# Phase 4：会话、工具、权限与结构化输入

> 状态：已完成（2026-08-29，25 个移动端测试文件、70 项测试及双平台 bundle 通过）  
> 依赖：Phase 2、Phase 3

## 目标

实现完整会话页并接入 Host chat state/action：连续对话、流式响应、工具、停止、审批和 `AskUserQuestion`。

## 页面结构

- 顶栏：返回、Cloud、会话标题、workspace/host/连接状态、更多菜单。
- transcript：用户 bubble、Agent Markdown、可折叠思考、工具卡、错误与终态指标。
- pending approval：平台 bottom sheet，展示 tool、host、规范化 input；允许/拒绝有清晰危险等级。
- structured input：问题 header、2-3 选项和自动附加的自由输入；多选按 Host schema。
- composer：附件、模型、权限模式、输入、发送/停止；活动 turn 时状态来自 canonical chat state。

## 状态规则

- delta 只 patch 对应 `turnId/partId/toolCallId`，完成事件不重复追加 partial text。
- thinking 默认折叠且尊重服务端可见性；工具 input/output 使用安全、可复制的只读视图。
- approval/input resolve 提交后按钮进入 pending，canonical resolved 或 already-resolved 后关闭。
- 第二客户端抢先处理时显示非错误提示，并采用服务端最终 state。
- disconnect 保留 transcript/composer draft；未确认发送不能伪装成功。
- stop 直接走控制命令，不排在 send 后等待。

## 测试优先清单

1. live delta + terminal 与 snapshot transcript 语义一致。
2. tool lifecycle 由 waiting -> running -> success/failure/denied。
3. approval allow/deny/already-resolved/timeout/abort。
4. AskUserQuestion 单选、多选、取消和自由输入。
5. reconnect 中 active turn、pending approval、draft 和滚动锚点保持正确。
6. 大 transcript 只重渲染变化行，输入不重渲染整个列表。

## 退出条件

- fake Host E2E 覆盖 send/stream/tool/approval/input/interrupt/reconnect。
- 两个客户端竞态只产生一个 canonical decision。
- 大字体、VoiceOver/TalkBack 和键盘避让通过人工检查。
