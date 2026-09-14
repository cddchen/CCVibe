# 设置页帮助入口与 Host 运行指南

## 状态

实现完成并通过独立自动化及 iOS 原生构建/视觉验收；实际手势与 Android 平台 smoke 待补。

## 目标、范围与非目标

在设置页增加“帮助”入口，进入独立帮助页，清晰列出 Host 安装/启动、查看连接信息、Cloud 填写地址和 Token 的步骤；说明不开放公网端口时可用 Tailscale/WireGuard 组网，并在 Cloud 中填写 `http://<组网 IP>:<端口>`。

非目标：不在 App 内启动 Host，不自动扫描服务器，不集成 Tailscale/WireGuard SDK，不处理 VPN 配置，不把 token 放进 URL，不改变现有地址规范化或安全策略。

## 当前分支与事实证据

| 事实 | owner | 证据 | 动作 |
| --- | --- | --- | --- |
| 设置页当前只有 `/connection` route，`app/` 路由是薄装配 | Mobile routing/UI | `app/_layout.tsx`、`app/connection.tsx`、`ConnectionScreen.tsx` | 新增薄 `/help` route 和独立 `HelpScreen` |
| npm 包名、Node 要求和 CLI 当前事实为 `@cddchen/cloud`、Node 22+；`start` 默认后台运行，缺省 token 时生成并打印，`--global` 绑定 `0.0.0.0`，默认端口 8787 | Host CLI/operator docs | Host `package.json`、`src/cli/cloud.ts`、Host README | 帮助文案从真实 CLI 合同提炼 |
| Cloud 接受 `http://`/`ws://` 开发地址，并规范化为 WebSocket `/ws`；token 单独经 Authorization header | Mobile protocol | `connectionAddress.ts` 及测试 | 示例使用 `http://xxx:yyy`，不拼 token/path query |
| 明文 HTTP/WS 仅适用于受信局域网或加密组网；公网部署应由 TLS 反向代理提供 HTTPS/WSS 和高熵 token | security owner | 根 AGENTS、Host README | 帮助页同时写明组网与公网安全边界 |

## 方案与文件边界

### cloud-developer（gpt-5.6-luna / max）

允许修改：

- `repos/cloud-mobile/src/features/connection/ConnectionScreen.tsx`
- 新建 `repos/cloud-mobile/src/features/help/HelpScreen.tsx`
- 新建 `repos/cloud-mobile/app/help.tsx`
- `repos/cloud-mobile/app/_layout.tsx`
- `repos/cloud-mobile/test/connectionScreenDesign.test.ts`，并新建或修改一个聚焦帮助页/路由的测试文件
- 本计划的实现记录与开发自测记录

禁止修改：Host CLI/README、runtime/storage/protocol 地址逻辑、图标 asset/launcher、Markdown patch、任务 18/19 计划。

实施要求：

1. 先补失败合同，覆盖设置页帮助按钮、`router.push('/help')`、薄 route、Stack 注册、native back、safe-area、可滚动内容与关键无敏感信息文案。
2. 帮助入口只在设置列表主状态展示，作为清晰的独立 action/card row，触控目标 iOS 至少 44pt、Android 至少 48dp；编辑/新增 Host 的既有返回状态机保持。
3. 帮助页使用项目主题、`SafeAreaView`、`ScrollView` 和 native `router.back()`；终端命令和 URL 示例可被系统选择复制，不引入 Markdown/WebView/新依赖。
4. 文案至少包含：
   - 服务端电脑安装 Node.js 22+，完成 Claude Code/Claude Agent SDK 所需本机登录与配置；手机端不运行 Agent、不直接读取配置，Host/SDK 使用服务端电脑上的 Claude Code 配置（包括可用 MCP/skills）；
   - 运行 `npx @cddchen/cloud@latest start --global`，说明默认后台、默认端口 8787、终端会打印地址和生成的 token；也可用 `--token=<自定义 Token>`，但页面不得出现真实 token；
   - 可用 `npx @cddchen/cloud@latest status` 查看、`... stop` 停止；
   - 同一受信局域网直接用启动输出地址；不开放公网端口时，在服务端电脑与手机安装并加入同一 Tailscale/WireGuard 网络，Cloud Host 填 `http://xxx:yyy` 形式的地址（例如 `http://100.64.0.2:8787`，按实际组网 IP/端口替换），Token 单独填写；
   - 不要把 token 拼进 URL。直接公网暴露时必须用 TLS 反向代理并填写 `https://<域名>`/`wss://<域名>`，使用高熵 token。
5. 文案不得承诺自动发现、mDNS、relay、E2E 或 App 内 VPN 能力。

### cloud-tester（gpt-5.6-luna / max）

开发交接后独立验收，默认只修改本计划验证记录。逐条对照 Host CLI 源码/README 与 mobile address schema，检查导航、可访问性、布局和安全措辞。

## 验收条件

- 设置列表可见“帮助”按钮；点击进入独立帮助页，系统返回手势/按钮回到设置页，不通过 push 旧页伪造返回。
- 小屏与字体缩放下页面可滚动，内容不截断；命令/地址示例可任选复制，深浅色可读，触控目标符合平台下限。
- Host 步骤、命令、默认端口、地址和 token 说明与当前源码一致；`http://<组网 IP>:<端口>` 能由现有 Cloud 表单接受并规范化。
- Tailscale/WireGuard 被表述为双方已安装配置的加密组网方案，不暗示 Cloud 自动配置；明文局域网/组网与公网 TLS 边界明确，URL 中没有真实/示例 token query。
- 聚焦测试、typecheck、lint、全量 test、双平台 bundle 通过；iOS Simulator 至少验证入口、帮助页、返回和滚动并留截图。Android 原生/视觉按可用环境单独披露。
- `git diff --check` 通过，无关变更保持原样。

## 实现记录

2026-09-10，cloud-developer 实施：

- 在 `repos/cloud-mobile/src/features/connection/ConnectionScreen.tsx` 的设置列表新增独立“连接帮助” action/card row，触控区域保持至少 44pt；仅列表状态展示，编辑/新增 Host 状态不插入帮助入口。导航使用项目一致的绝对 `router.push('/help')`，由 Expo Router typed-routes 约束并进入独立 native route 边界。
- 新增 `repos/cloud-mobile/app/help.tsx` 薄 route、新增 `repos/cloud-mobile/src/features/help/HelpScreen.tsx`。帮助页使用 `SafeAreaView`、原生 `ScrollView`、native `router.back()`，命令/URL 例子使用 React Native `Text selectable` 支持长按任选复制；Android 使用 `monospace`，iOS 使用 `Menlo`。
- 文案依据 Host 当前 CLI/README 与 mobile `connectionAddress.ts`：Node.js 22+、`npx @cddchen/cloud@latest start --global`、后台/8787/启动输出地址与 Token、`status`/`stop`、Tailscale/WireGuard 双端预先组网；同时明确 `http://xxx:yyy` 格式、合法示例 `http://100.64.0.2:8787`、Token 单独填写且不拼 URL。公网说明 TLS 反向代理和高熵 Token；没有承诺自动扫描、VPN 配置、relay 或 App 内启动 Host。步骤 1 明确手机端不运行 Agent/不直接读取配置，而 Host/SDK 使用服务端电脑上的 Claude Code 配置（包括可用 MCP/skills）。自定义 token 示例为可执行占位命令 `--token=replace-with-a-high-entropy-token`，不包含真实 secret。
- 更新 `repos/cloud-mobile/app/_layout.tsx` 注册 `help` Stack screen；保留任务 2 的 App Icon 变更以及所有其他用户改动。未修改 Host、runtime/storage/protocol、图标资源、Markdown patch 或计划 18/19。
- 新增 `repos/cloud-mobile/test/helpScreenDesign.test.ts`，先验证失败后实现，覆盖入口范围、route/Stack/back/safe-area/scroll、可选择复制、CLI 命令和安全/组网文案；任务 2 的 `connectionScreenDesign.test.ts` 在新增入口后仍通过。

实现偏差：无。尖括号/空格形式仅作说明，不放入可执行命令；帮助页同时提供可直接复制的 `http://xxx:yyy` 与 `http://100.64.0.2:8787`。

### 开发者自测（2026-09-10，Asia/Shanghai）

- `npx vitest run test/helpScreenDesign.test.ts test/connectionScreenDesign.test.ts`：14 tests 通过；实现前帮助合同按计划 3 tests 失败。
- `npm run typecheck`：通过。
- `npm run lint`：通过。
- `npm test`：46 files / 204 tests 通过。
- `npm run bundle:ios`：通过；`npm run bundle:android`：通过。
- 真实 iOS Simulator：先 `curl -fsS http://127.0.0.1:8787/health`，复用已有 Host，返回 `{"status":"ok","protocolVersions":["1.0.0"]}`；随后按 harness 在 `repos/cloud-mobile` 执行 `npm run ios`，Xcode 26.6 构建 0 error/0 warning，安装并打开 iPhone 17 Pro / iOS 26.5。通过 `com.ccvibe.cloud://connection` 截图 `/tmp/cloud-settings-help-entry.png` 验证设置列表的“连接帮助”入口；通过 `com.ccvibe.cloud://help` 截图 `/tmp/cloud-help-top.png` 验证帮助页 header、返回按钮、安全区、步骤内容、可复制代码块和小屏纵向布局。来源代码和静态合同覆盖 ScrollView 滚动及 native back；未用 UI 自动化拖动/点击，完整手势滚动/返回仍交独立验收记录。
- Android 原生构建、Android 模拟器/真机视觉和深色/字体缩放/VoiceOver/TalkBack 尚未由开发者验证；双平台 JS bundle 已验证。
- 本轮只启动了自己的 Metro/Simulator，交接前均已停止；用户已有 Host 未重启或停止。

## 验证记录

### 独立 cloud-tester 验收（2026-09-10，Asia/Shanghai）

验证基线：`main` 分支；验收开始前 `git status --short` 已确认任务 18/19/20 的并行改动，未回退或覆盖其他任务文件。复核 owner：Host CLI/README（`../cc-agent-host/src/cli/cloud.ts`、`../cc-agent-host/README.md`）、Mobile 地址规范化（`src/protocol/connectionAddress.ts`）、`ConnectionScreen`、`HelpScreen`、`app/help.tsx` 与 `app/_layout.tsx`。

自动化已验证（执行目录 `/Users/cdd/Documents/ClaudeCodeRemote/CCVibe/repos/cloud-mobile`）：

- `npx vitest run test/helpScreenDesign.test.ts test/connectionScreenDesign.test.ts`：14 tests 通过。
- `npx vitest run test/connectionAddress.test.ts test/connectionForm.test.ts`：7 tests 通过，覆盖开发态地址规范化与表单边界。
- `npm run typecheck`：通过。
- `npm run lint`：通过。
- `npm test`：46 files / 204 tests 通过。
- `npm run bundle:ios`、`npm run bundle:android`：均通过；仅作为 JS/Hermes bundle 证据，不替代原生安装包验证。
- 静态复核确认帮助入口只位于 `view === 'list'` 的 `HostList`，编辑/新增 Host 不展示；`/help` 是独立薄 route，使用 `SafeAreaView`、`ScrollView` 与 `router.back()`；帮助命令/URL 使用 `Text selectable`；帮助行 `minHeight: 64`、返回按钮使用项目 `minTouchTarget`。独立验收后重新生成的 `.expo/types/router.d.ts` 已包含绝对 `/help` route，代码现使用项目一致的 `router.push('/help')`，typecheck 与 native deep-link 均通过。
- 对照当前 Host 源码/README：Node `>=22.4.0`、`start` 后台默认行为、`--global`/`0.0.0.0`、默认端口 `8787`、`status`/`stop`、Token 通过 `Authorization` header、禁止 `?token`、公网 TLS/WSS 与高熵 Token 均与帮助页一致。`buildClaudeOptions()` 的 `settingSources: ['user','project','local']` 支持服务端 Claude Code 配置边界；帮助页没有承诺手机运行 SDK、自动扫描、VPN 自动配置或 relay。
- `http://100.64.0.2:8787` 属于可由现有 development 表单接受的合法示例；`http://xxx:yyy` 仅为用户可替换的格式占位，不应当作为可直接提交的 URL。

真实 iOS Simulator 已验证：

- 先执行 `curl -fsS http://127.0.0.1:8787/health`，返回 `{"status":"ok","protocolVersions":["1.0.0"]}`；复用现有 Host，未重启或停止。
- 在 `/Users/cdd/Documents/ClaudeCodeRemote/CCVibe/repos/cloud-mobile` 执行 `npm run ios`；Xcode 26.6 构建 `0 error(s), 0 warning(s)`，安装于 iPhone 17 Pro / iOS 26.5。
- `/tmp/cloud-settings-help-test-entry.png`：设置列表可见“连接帮助”卡片；`/tmp/cloud-help-test-top.png`：帮助页顶部安全区、native 返回按钮、步骤 1/2、可选择复制的命令块均可读；`/tmp/cloud-help-native-back-test.png` 保留了帮助页返回按钮尝试的截图。
- 本轮启动的 Metro 会话已 Ctrl-C 停止，启动的 iPhone 17 Pro Simulator 已 shutdown；随后再次检查 Host health 仍正常。

尚未验证/限制：

- 没有可用的 UI 自动化注入工具完成真实点击、系统返回手势和拖动滚动；因此入口点击、返回手势、滚动到底部和系统复制菜单不宣称已实测。来源静态契约与 deep-link 页面截图证明路由/布局已装载。
- Android 原生编译、模拟器/真机视觉、深色模式、动态字体、TalkBack/VoiceOver 未在本次独立验收中执行；双平台 bundle 已通过。
- 计划状态暂不由测试员改为“已完成”，交架构师在审阅上述限制并修正文案后收敛。

### 绝对路由收敛复验（2026-09-10，Asia/Shanghai）

- 开发者将设置入口统一为 `router.push('/help')`，同步更新帮助页合同测试与计划说明；独立复跑 `npx vitest run test/helpScreenDesign.test.ts test/connectionScreenDesign.test.ts`（14 tests 通过）和 `npm run typecheck`（通过）。未发现需返工问题；本次未重新启动模拟器。

## 架构师收敛

2026-09-10：接受实现与独立复验结论。绝对 `/help` typed route、列表态入口、Host CLI/地址/安全文案及可选择文本合同均已收敛；自动化、双平台 bundle 和 iOS 原生构建/页面视觉通过。没有 UI 注入工具和 Android 设备，因此不宣称入口真实点击、返回/滚动手势、系统复制菜单或 Android 视觉已实测，按验证记录保留为平台 smoke。帮助页只消费 Host 的现有操作合同，不改变 owner，根 harness/AGENTS 无需复制页面全文。
