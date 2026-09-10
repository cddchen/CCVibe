# Host 列表直连、编辑入口与 Token 展示计划

状态：已实现。Host 行直连、独立编辑入口、scoped token 明文编辑与读取错误路径均已有回归覆盖。

## 产品语义

- 点击已保存 Host 行，立即调用该 Host 的切换/连接动作；成功后回首页，失败时留在列表并显示错误。
- 行右侧不再显示导航箭头，改为独立编辑按钮；点击编辑按钮不触发行连接。
- 编辑按钮直接进入已有编辑表单，不再先进入只读详情页。
- 编辑已有 Host 时从 SecureStore 读取该 Host 的 token 并以明文输入框展示；列表仍不展示 token，新建 Host 的输入可继续使用安全输入样式。
- 删除 Host 的能力迁移到编辑页，避免移除详情页后丢失。

## 安全与职责

- token 只通过 Runtime 的窄读取动作从现有 Host-scoped SecureStore 进入当前编辑表单内存；不得写入 AsyncStorage、日志、错误、测试快照或网络 URL。
- 读取失败显示明确错误，不能把空字符串当作成功读取。
- 连接仍复用 `switchConnection()`，保持旧连接 fencing、凭据校验和 selected Host 的权威流程。

## 实施

1. 先更新连接页设计/交互测试，覆盖行直连、独立编辑按钮、无详情中转、token 明文编辑、删除入口保留。
2. Runtime actions 增加 scoped token 读取接口，并复用已有私有 `readHostToken()`；返回窄结果，不暴露整套 secret store。
3. 将 Host 行拆成主 Pressable 与尾部 sibling 编辑 Pressable，避免嵌套事件传播。
4. 打开编辑页时加载 host 与 token，显示 loading/错误状态；编辑 token 使用 `secureTextEntry={false}`。
5. 删除不再使用的 detail view 和误导性的“Token 始终隐藏”文案。

## 验证

- connection screen design、multi-host runtime、secure token storage 的针对性测试。
- Mobile typecheck、test、lint；iOS/Android 至少完成静态与模拟器/可用平台的视觉检查。
- 完成前 `git diff --check`。

## 代理边界

以 composer 与排序偏好变更之后的 Runtime 为基线实现。不要修改首页选择或聊天复制。
