# Phase 5：平台材质、可访问性与发布门

> 状态：执行中  
> 依赖：Phase 0-4 全部完成

## iOS 材质合同

- 仅 iOS 动态加载 `expo-glass-effect`。
- 同时检查编译/系统可用性与运行时 API 可用性后才渲染 `GlassView`。
- iOS 26：`GlassView` regular/clear，交互控件使用系统 interactive 行为。
- iOS 18-25 或模块不可用：`expo-blur` 的系统 thin material + 高光 rim + 轻 cast shadow。
- Reduce Transparency、测试环境或 blur 失败：实体 `surface`，保持相同 shape/layout，不出现透明度不可读问题。
- glass 只用于 header/composer/sheet/chrome，不给 transcript 每一行套玻璃。

## Android Material 合同

- Material 3 dynamic color（可用时）与 light/dark color scheme。
- 使用明确 surface elevation、shape、TopAppBar、IconButton、Menu、ModalBottomSheet 和 progress indicator。
- Android 12 以下不做持续实时 blur；任何装饰 blur 都不能影响滚动性能。
- back gesture、system bars、keyboard insets 和 predictive back 行为正确。

## 质量门

- AccessibilityInfo 的 Reduce Transparency/Reduce Motion 改变可在运行时生效。
- VoiceOver/TalkBack 顺序、焦点恢复、sheet trap、dynamic type、颜色对比通过。
- App background 时停止 reconnect timer 和装饰动画；foreground 恢复。
- iOS 26、旧 iOS、Android 各有 home/chat/permission 三组截图。
- 至少一次 iOS simulator build 和 Android debug build；记录工具链版本与未覆盖真机风险。
- Host 与 Mobile 全量 typecheck/test/build/lint 全绿，无 token/secret 进入日志或 artifact。

## 最终 smoke

1. 新安装连接 Host。
2. 选择目录和模型并发送首条任务。
3. 观察流式文本、思考和工具。
4. allow 一次权限、deny 一次权限、回答一次结构化问题。
5. 运行中切后台、断网、恢复网络，再打开第二客户端。
6. 第二客户端处理权限后第一客户端收敛为 resolved。
7. 停止 turn，继续发送下一轮。

全部通过后才能把 roadmap 标记完成。

## 2026-08-30 验收记录

已通过：

- Host `typecheck`、391 个测试和 production build。
- Mobile `typecheck`、ESLint、74 个测试、iOS/Android Hermes bundle。
- iOS 26.5 原生构建与 Liquid Glass 运行；iOS 18.4 原生构建与 blur fallback 运行。
- 真实 Host 的 Bearer WebSocket 握手、目录/模型/会话同步、创建会话、发送消息、思考块和 Claude Agent SDK 最终回复。
- Host 重启后，客户端在旧订阅失效时回退到全量 initialize。
- 失败 turn 在会话页显示用户提示与清理后的错误信息。
- 系统明暗主题切换，Reduce Transparency 的实体 surface fallback。

发布前仍需完成：

- 在安装 JDK、Android SDK 与 emulator 的环境执行 Android 原生 Gradle build 和 TalkBack/返回手势验收；当前机器只完成 Android bundle。
- 在可稳定触发真实工具交互的测试 Host 上完成 allow、deny、结构化输入和双客户端收敛 smoke。
- Expo SDK 54 依赖审计仍包含上游 Metro/Expo 漏洞；需要在兼容的 SDK 升级窗口处理，不能用破坏性 major 自动修复。
