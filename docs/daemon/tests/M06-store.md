# M06 store 测试用例

| ID | 类型 | 用例 | 预期 |
|---|---|---|---|
| ST1 | 单元 | add/list workspace | 1 条 |
| ST2 | 单元 | remove workspace | 0 条 |
| ST3 | 单元 | upsert/delete session meta | 不抛错 |

实现：`src/store/db.test.ts`（`node:sqlite`）。