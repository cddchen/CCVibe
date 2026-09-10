# 首页会话默认配置记忆计划

状态：已实现。模型、权限与思考强度支持按 Host 恢复；过期值由当前 Host catalog 规范化，“默认”会清除旧的 effort。

## 产品语义

首页输入框下方的权限模式、模型选择和思考强度，用户选择一次后应按 Host 记忆：

- 模型沿用现有 `lastModelId`，补足恢复和失效值兜底的回归覆盖。
- 新增 `lastPermissionMode` 与 `lastEffort` 本地非敏感偏好。
- Host catalog 仍是能力与默认值的权威。已保存值若不再被当前 catalog/model 支持，回退到 Host 默认或未指定，不把过期值发送给 Host。
- 用户明确选择“默认”思考强度时，需要删除旧的已保存强度，而不是因 `undefined` 被 patch 忽略而继续恢复旧值。

## 实施

1. 先补 storage 与 runtime 回归测试：保存/重启恢复、按 Host 隔离、清除默认值、过期 model/permission/effort 降级。
2. 扩展 `ConnectionPreferences`、Zod schema、规范化和所有序列化路径；字段保持可选，使现有 version 1 数据向后兼容。
3. 初始化、切换 Host 和 catalog 更新时，把偏好投影为当前 catalog 支持的 canonical selection。
4. `setModel`、`setPermissionMode`、`setEffort` 在更新内存后持久化完整当前选择；必要时清理因模型切换而失效的 effort。
5. 创建会话只发送 canonical selection，不由客户端维护第二份模型/权限能力表。

## 验证

- storage、multi-host runtime、home selector/runtime flow 的针对性测试。
- Mobile typecheck、相关测试、lint；随后由主任务统一跑全量 test 和双平台 bundle。
- 完成前 `git diff --check`。

## 代理边界

仅处理首页 composer 三项默认配置的记忆与规范化。不要添加排序按钮，不要改连接页或聊天复制。
