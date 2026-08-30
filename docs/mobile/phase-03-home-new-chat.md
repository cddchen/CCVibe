# Phase 3：首页与新会话流程

> 状态：已完成（2026-08-29，真实 catalog 首页与 create-subscribe-send 双平台 bundle 通过）  
> 视觉依据：移动端高保真设计稿；数据依据：root catalog state

## 目标

实现设计稿首页：大屏正上方 `Cloud`，中下方任务输入，首屏底部露出按项目分组的会话列表，并支持目录与模型选择后创建会话。

## 页面结构

- 顶部状态栏下居中 `Cloud`，右侧紧凑“新对话”命令。
- 工作目录 selector 与已连接 Host 状态；目录弹窗默认隐藏，用户点击后以平台菜单/sheet 展示。
- 大型 composer：任务输入、附件入口占位、模型选择、语音入口、发送。
- 首屏下方必须露出“会话”标题和至少一部分 canonical list；不能让 composer 吞掉整个 viewport。
- 会话按 workspace 分组；行展示标题、最近时间、运行/待授权/错误状态，点击进入 chat。

## 行为

- 目录和模型来自 Host，最近选择仅作为 preference，失效时回退 Host 默认值。
- 发送时先 create provisional chat，再 dispatch `chat/send`，随后导航到 chat。
- create 成功/send 失败时保留 canonical chat 并显示可重试状态，不本地删除。
- loading、空、断线、没有 workspace、没有 model、错误与 refresh 均有明确状态。

## 平台设计

- iOS：关键浮动 chrome 使用 `GlassPanel`；列表内容保持清晰实体背景。
- Android：Material 3 TopAppBar、surface/container、menu/modal bottom sheet、FAB/icon button；不使用 iOS capsule everywhere。
- 共享语义、布局信息架构和文案；平台材质与控件外观分支。

## 验收

- 393x852、常见 Android 手机与大字体下无重叠/截断。
- model selector、目录 selector、发送和会话行都有无障碍名称与最小点击目标。
- 数据全部来自 typed state；无硬编码会话/项目/模型。
- 截图与设计稿主信息架构一致，iOS/Android 各自符合平台规范。
