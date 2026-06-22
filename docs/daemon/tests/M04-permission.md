# M04 permission 测试用例

| ID | 类型 | 用例 | 预期 |
|---|---|---|---|
| P1 | 单元 | respond allow | Promise resolve allow |
| P2 | 单元 | respond deny | deny |
| P3 | 单元 | denyAllForSession | 全部 deny |
| P4 | 单元 | 超时 | deny + timed out |

实现：`src/permission/registry.test.ts`。