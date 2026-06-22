# M05 history 测试用例

| ID | 类型 | 用例 | 预期 |
|---|---|---|---|
| H1 | 单元 | parentUuid 链重建 | 顺序 a→b→c |
| H2 | 单元 | 无 uuid 回退原列表 | 不变 |
| H3 | 集成 | listSessions 跳过 agent-*.jsonl | 无 agent 项 |

实现：`src/history/reader.test.ts`。