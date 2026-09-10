# iOS 复制崩溃与助手复制按钮对齐计划

状态：已实现。`ExpoClipboard 8.0.8` 已进入 Pod 锁，复制/布局回归测试、lint 与 iOS bundle 通过；本机缺少 iOS 16.4 runtime，完整 iOS 18.4 App 构建仍被仓库既有 React/Expo Fabric 链接符号问题阻塞。

## 现状与根因假设

- JavaScript 已使用 Expo SDK 54 对应的 `expo-clipboard ~8.0.8`，`setStringAsync()` 在该版本支持 iOS 15.1 及以上，iOS 16.4 不需要单独实现剪贴板桥。
- 当前 `ios/Podfile.lock` 与 `ios/Pods/Manifest.lock` 都没有 `ExpoClipboard`。两份锁文件彼此一致但同时过期，因此现有构建脚本的 lock/manifest 比较无法发现“新增 npm 原生模块但尚未执行 pod install”的情况。
- 复制逻辑在点击时动态导入模块，原生依赖缺失会在首次点击时暴露，符合“只有点复制才出错”的现象。
- 助手消息的复制按钮没有明确的 `alignSelf: 'flex-start'`，对齐依赖父容器默认布局，无法保证和消息正文左边缘一致。

## 实施

1. 先补回归契约：iOS Pod 锁必须包含 `ExpoClipboard`，复制按钮必须显式左对齐。
2. 运行仓库支持的 CocoaPods 安装流程，更新 iOS 原生依赖和锁文件；继续使用官方 `expo-clipboard`，不新增自定义 `UIPasteboard` bridge。
3. 给助手复制动作设置明确的左对齐约束；用户消息的右对齐行为保持不变。
4. 验证空文本不写剪贴板、写入失败仍由现有 toast 错误路径处理。

## 验证

- Mobile：相关复制/静态契约测试、typecheck、lint。
- iOS：至少完成原生依赖安装和模拟器原生构建；当前机器没有 iOS 16.4 runtime 时，用现有最近 runtime 做点击 smoke，并明确披露 16.4 尚未真机/模拟器复验。
- 完成前检查 `git diff --check`，只提交本问题相关文件。

## 代理边界

仅修改复制实现/布局、iOS Pod 依赖及对应测试。不要改首页偏好、排序或连接设置。
