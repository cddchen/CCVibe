# M03 session 测试用例

| ID | 类型 | 用例 | 预期 |
|---|---|---|---|
| SE1 | 单元 | 多 subscriber 收到相同 `session/event` | 广播一致 |
| SE2 | 单元 | detach 后不再收事件 | 0 条 |
| SE3 | 单元 | `session/status` 通知 | method 正确 |
| SE4 | 集成 | create + sendMessage（需 API key） | sessionId + 流式事件 |

实现：`src/session/runner.test.ts`。