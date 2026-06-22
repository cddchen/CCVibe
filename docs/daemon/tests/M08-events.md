# M08 events 测试用例

| ID | 类型 | 用例 | 预期 |
|---|---|---|---|
| E1 | 单元 | SessionRunner.notify 多连接 | 各 1 条 |
| E2 | 单元 | 坏连接 send 不拖垮其他订阅者 | try/catch 丢弃 |

实现：合并在 `src/session/runner.test.ts`（`session/event`、`session/status`）。