# 首页工作区排序偏好计划

状态：已实现。selector、storage、runtime 与 UI 契约测试通过，排序偏好按 Host 持久化并和 composer 偏好交叉验证。

## 产品语义

- 在刷新按钮左侧增加一个排序按钮。
- 两种模式：
  - `default`：保持当前工作区名称升序的默认排序。
  - `recent_workspace`：按每个工作区内最近一条未归档会话的 `updatedAt` 降序；时间相同时按工作区名称和 ID 确定性排序。
- 工作区内的会话仍按更新时间降序，不改变现有行为。
- 选择按 Host 保存到本机非敏感偏好中；重启 App 或重新连接同一 Host 后恢复。

## 实施

1. 先为纯 selector 增加两种模式、归档过滤、相同时间 tie-break 的失败测试。
2. 定义稳定的排序偏好 union，并让 Home selector 显式接收该偏好，避免组件临时重排 catalog。
3. 扩展 Host 本地偏好 schema/规范化/序列化；旧 version 1 数据缺少字段时兼容为 `default`。
4. Runtime 暴露切换动作并在状态提交后持久化；存储失败要保留可观察的错误路径，不能静默伪装保存成功。
5. Home 标题栏将排序按钮放在刷新按钮左侧，图标/无障碍标签表达当前排序模式和切换目标。

## 验证

- home selector、storage、runtime 和 Home 静态交互测试。
- Mobile typecheck、test、lint；受影响平台做首页视觉检查，确认 44/48 最小触控目标和按钮顺序。
- 完成前 `git diff --check`。

## 代理边界

以已经合入的 composer 偏好字段为基础扩展排序字段。不要修改权限、模型、思考强度的恢复语义，也不要改连接设置页。
