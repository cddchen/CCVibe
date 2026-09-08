# SDK status 瞬时状态修复计划

## 问题与结论

当前安装的 Claude Agent SDK（`0.3.220`）把 `system/status` 定义为实时运行状态：`status` 仅可能是 `requesting`、`compacting` 或 `null`。现有 Host 把每个 status envelope 投影为普通 `system_message`，因此客户端会把本应瞬时的状态永久保留在每轮消息后面。

## 设计

1. Host `ActiveTurn` 增加可选 `activity`，只公开 `requesting_model | compacting_context`。
2. 增加 `chat/turnActivityChanged` action，将 `requesting`、`compacting`、`null` 映射为设置、切换、清除 activity。
3. 普通 status 不生成 response part，也不进入 replay；压缩成功继续由 `compact_boundary` 表达。
4. 压缩失败保留为 `compact_error` 系统错误，内容脱敏并限制为 4000 字符。
5. Mobile 在当前轮显示“正在请求 Claude”或“正在压缩上下文”；没有 activity 时显示“正在思考”，终态轮次不保留 activity。

## 验证

- Host：mapper、reducer、协议相关测试，typecheck、全量 test、build。
- Mobile：wire、reducer、selector、UI 契约测试，typecheck、全量 test、lint、iOS/Android bundle。
- 最后运行 `git diff --check` 并审查改动。
