# Enriched Markdown inline code 自适应几何修复

## 状态

已验收（2026-09-10，cloud-tester 第二轮独立复验）。自动化与 iOS 原生门禁通过；专用 Markdown 视觉/拖选 fixture 未覆盖，已明确记录，不把启动证据当作视觉通过。与会话 Header 任务串行修改共享的 Mobile 工作树，不并发写 `ChatScreen.tsx` 或共享计划文档。

## 目标、范围与非目标

在保留当前 `react-native-enriched-markdown@0.5.0`、GitHub flavor、GFM table、完成态任意片段选择/复制和既有 nested fenced code patch 的前提下：

- inline code（单反引号）背景高度按 code 字体真实 metrics 自适应，并在父段落行框中垂直对齐，不再比文字上方多出一块；
- 短 inline code 只包住反引号范围内的字形，长 inline code 换行时每一 visual line 只覆盖该行属于 code span 的范围，不覆盖 suffix 或行外文本；
- 单行与多行 fenced code block 继续按内容行数和既有 padding 自适应，不写死组件高度，不回退此前 nested list/marker/background-column 修复；
- 排版观感尽量对齐 staged 中接入新组件前的 `react-native-markdown-display` 效果，但不恢复旧组件、不放弃跨样式选择。

非目标：不改 Host/transcript，不预处理 Markdown，不退回 CommonMark，不升级第三方大版本，不开启公式，不改变 GFM table 的既有选择限制，不因 iOS 证据擅自扩张 Android 原生 patch。

## 当前分支与已有改动

- 分支：`main`。
- staged 已包含 Markdown renderer、表格、图标、Host、Home、连接页等多项用户/既有任务变更；这些均视为用户工作。实现只能追加本计划所需的 working-tree 差异，不得 reset、覆盖、重排或重新 stage。
- staged 前基线由 `git show HEAD:repos/cloud-mobile/src/features/chat/ChatScreen.tsx` 核对；当前实现和已有 package patch 均为本任务必须保留的输入，不是可重做区域。

## 事实证据

| 事实 | owner | 文件/符号 | 置信度 | 动作 |
| --- | --- | --- | --- | --- |
| staged 前的 inline code 使用 RN nested `Text` 背景；当前 0.5.0 在 iOS layout manager 中自行绘制背景，二者不是同一几何模型 | Mobile + 第三方 iOS renderer | HEAD `ChatScreen.tsx` 的 `code_inline`；安装包 `ios/utils/CodeBackground.m` | 高 | 以旧视觉为目标，但修复当前原生 owner |
| iOS 0.5.0 在省略 `code.fontSize` 时读取 `blockStyle.fontSize`，而生产 block setter 只缓存 `UIFont`，该字段可保持 0 | 第三方 iOS renderer | `ios/renderer/CodeRenderer.m`；`ios/renderer/RenderContext.m` 的 `setBlockStyle:font:` | 高 | fallback 改为已解析 `blockFont.pointSize`，恢复真实父字号继承 |
| inline code 背景当前使用 TextKit `boundingRect`/整行 `usedRect`；16/25 正文下 glyph range 可得到 25pt 行框，而字体真实 line height 约 18.84pt | 第三方 iOS renderer | `ios/utils/CodeBackground.m`；本机同构 TextKit 测量 | 高 | 背景垂直几何取 code font metrics，并居中/对齐到所在 line fragment |
| 跨行首段主动延伸到 `usedRect` 右边，中间段直接使用整行 `usedRect`，会把背景画到 code span 之外 | 第三方 iOS renderer | `CodeBackground.m` 的 line-fragment 枚举 | 高 | 每个 fragment 都以 `NSIntersectionRange` 的精确 glyph 横向范围为准 |
| GitHub flavor 0.5.0 只将 table（及启用时 math）拆成容器，普通段落、inline/fenced code 仍走同一 attributed renderer | 第三方 container renderer | `ios/EnrichedMarkdown.mm::splitASTIntoSegments` | 高 | 保留 GitHub flavor；切 flavor 不能修复本问题 |
| 0.5.0、1.0.2 与当前上游仍含同构背景算法，没有可直接升级复用的已发布修复 | 第三方发布源码 | npm tarball / 上游源码核对 | 中高 | 在现有精确版本的 package patch 做最小回移式修复 |

## 方案与文件边界

### cloud-developer（gpt-5.6-luna / max）

允许修改：

- `repos/cloud-mobile/patches/react-native-enriched-markdown+0.5.0.patch`
- `repos/cloud-mobile/test/enrichedMarkdownContract.test.ts`
- 本计划的实现记录、状态和开发自测记录
- `repos/cloud-mobile/node_modules/react-native-enriched-markdown/ios/renderer/CodeRenderer.m` 与 `ios/utils/CodeBackground.m` 仅可作为生成/验证 `patch-package` 的临时安装树，不得纳入 git 交付

禁止修改：Host、依赖版本/lock、公式开关、`ChatScreen.tsx` 的 flavor/样式/完成态分支、现有 patch 中 `ListItemRenderer.m` / `CodeBlockBackground.m` / `LastElementUtils.h` 的语义，以及 Header 任务文件。

实施顺序：

1. 先扩充合同测试并证明当前 patch 缺少 `CodeRenderer.m`/`CodeBackground.m` 几何修复；fixture 至少覆盖短 code、行首/中/尾、带 suffix 的窄宽跨行 code、中文/emoji/粗体邻接、heading/list/blockquote，以及单行/多行 fenced block。
2. 在安装树用 `apply_patch` 做最小 iOS 修改，再用 `patch-package` 可复现地更新现有 patch。字号 fallback 必须来自实际 `blockFont.pointSize`；背景不得写死高度，必须从当前 code font metrics 和每行 code glyph 交集计算。
3. wrapped span 的每个 fragment 都只绘制 span 在该行的 glyph 范围；不得再以整行 `usedRect` 作为横向背景，也不得覆盖 code 后的普通文本。
4. 保留 package patch 现有 nested list/code block hunks；验证补丁可在干净 0.5.0 tarball 上应用，`npm run postinstall` 通过。
5. 运行 targeted、typecheck、lint；完成 iOS 原生构建和真实会话 fixture 前不得把视觉验收写为通过。

### cloud-tester（gpt-5.6-luna / max）

开发交接后独立、串行验收。默认只修改本计划验证记录；若缺失行为合同，可仅修改 `test/enrichedMarkdownContract.test.ts`，不得改产品或 package patch。核对 patch 可复现、旧 hunks 未漂移、GitHub table/selectable/raw copy/streaming/公式关闭均保留，并在 iOS Simulator 使用真实 Host 验证几何与选择。

## 验收条件

- `前文 `短代码` 后文` 中 code 字号与父级 16pt 一致，背景围绕 code 字形且上下视觉平衡，不填满 25pt 整行，也不覆盖前后文本。
- 行首、行中、行尾和窄宽跨 2/3 行 inline code 均按每行真实 span 范围绘制；最后一行 suffix 明确位于背景外。
- 中文、emoji、粗体邻接，以及 heading/list/blockquote 内 inline code 继承各自父级字号，不出现 0pt fallback 或统一写死字号。
- 单行 fenced block 不被额外撑成多行，多行 fenced block 高度随 visual line 数量增长；现有 `13/18 + 4pt padding`、nested marker 和背景内容列行为不回归。
- 完成态仍为 selectable GitHub renderer；GFM table、链接、整段 raw Markdown copy、流式 plain `Text` 保留。
- 公式支持继续全链路关闭：JS `latexMath=false`、Expo `enableMath=false`、iOS/Android 原生开关不变，无新增 math 依赖。
- `npx vitest run test/enrichedMarkdownContract.test.ts`、`npm run typecheck`、`npm run lint`、全量 `npm test`、双平台 bundle、iOS 原生 build 通过；Android 原生能力按环境单独披露。
- 真实 iOS Simulator：先复用 `http://127.0.0.1:8787/health` 已有 Host，再从 `repos/cloud-mobile` 执行 `npm run ios`；验证上述 fixture、拖选跨普通/粗体/link/code 并复制。不得用 `CODE_SIGNING_ALLOWED=NO` 产物替代 SecureStore/会话 smoke。
- `git diff --check` 通过，所有无关 staged/working 变更保持原样。

## 实现记录

- 2026-09-10：在 `repos/cloud-mobile/test/enrichedMarkdownContract.test.ts` 先补失败合同，加入短 inline code、行首/中/尾、窄宽跨行 suffix、中文/emoji/粗体邻接、heading/list/blockquote，以及单行/多行 fenced code fixture；新增合同检查 iOS patch 使用真实 font metrics 和逐行 glyph 交集，并保留 GitHub/selectable/表格/公式关闭/nested code 约束。
- 2026-09-10：在 `react-native-enriched-markdown@0.5.0` 安装树以 `apply_patch` 修正 `CodeRenderer.m` 的字号 fallback：未配置 code fontSize 时使用已解析 `blockFont.pointSize`，不再读取可能为 0 的 `blockStyle.fontSize`。`CodeBackground.m` 删除父级 `referenceHeight` 与整行 `usedRect` 几何；每个 visual line 用 `NSIntersectionRange` + `boundingRectForGlyphRange:` 取精确 code glyph 横向范围，并用 `locationForGlyphAtIndex:` 的 baseline 与 `UIFont` ascender/descender 计算背景高度。现有 `ListItemRenderer.m`、`CodeBlockBackground.m`、`LastElementUtils.h` nested fenced code/content-column hunks 保留。
- 2026-09-10：用 `npx patch-package react-native-enriched-markdown --include '^(ios/renderer/(ListItemRenderer|CodeRenderer)\\.m|ios/utils/(CodeBlockBackground|CodeBackground)\\.m|ios/utils/LastElementUtils\\.h)$'` 重新生成 `repos/cloud-mobile/patches/react-native-enriched-markdown+0.5.0.patch`，避免把本机 Android 构建产物带入 patch；未修改依赖版本、公式开关、`ChatScreen.tsx` 或 Header。
- 2026-09-10 返工：独立验收发现 `CodeBackground.m` 在 `drawCodeBackgroundForRange:` 中错误引用未定义的 `textStorage`。先在合同中加入合法访问约束，再改为 `[layoutManager.textStorage attribute:NSFontAttributeName ...]`，重新生成 patch；未改变字号、baseline 或逐行 glyph 几何方案。

## 验证记录

- 自动化已运行（2026-09-10，`repos/cloud-mobile`）：
  - `npx vitest run test/enrichedMarkdownContract.test.ts`：通过，12 tests。
  - `npm run typecheck`：通过。
  - `npm run lint`：通过。
  - `npm run postinstall`：通过，`react-native-enriched-markdown@0.5.0 ✔`。
  - 从干净 `react-native-enriched-markdown@0.5.0` npm tarball 用 `patch -p1 --batch --forward` 应用当前 patch：通过；CodeRenderer/CodeBackground 修复与原有 nested list/code-block hunks 均可见。
- `git diff --check`：非 patch 的合同/计划文件无新增问题；patch 文件仍报告 patch-format 空白上下文行（该文件的 staged 基线同样存在此类报告），因此不能记录为全量通过，需测试员/架构师决定是否按 patch 文件惯例豁免。
- 开发者交接时尚未验证：全量 `npm test`、双平台 bundle、iOS 原生构建、Android 原生构建，以及真实 iOS Simulator + 本机 Host 的视觉/拖选/复制 smoke；以下独立验收记录覆盖其中的自动化和原生编译门禁，并保留未覆盖项。

- 2026-09-10，cloud-tester 独立验收（`/Users/cdd/Documents/ClaudeCodeRemote/CCVibe/repos/cloud-mobile`）：`npx vitest run test/enrichedMarkdownContract.test.ts` 通过（12/12）；`npm test` 通过（44 files / 196 tests）；`npm run typecheck`、`npm run lint`、`npm run bundle:ios`、`npm run bundle:android`、`npm run postinstall` 均通过；从全新 `react-native-enriched-markdown@0.5.0` tarball 应用 patch 也通过，5 个 iOS patch 文件均成功应用。
- 2026-09-10，cloud-tester 真实 iOS 原生构建：先确认 `curl -fsS http://127.0.0.1:8787/health` 返回 `{"status":"ok","protocolVersions":["1.0.0"]}`，复用现有 Host PID 8150；在 `repos/cloud-mobile` 执行 `npm run ios`，Xcode 26.6 开始编译并实际进入 `react-native-enriched-markdown` 的 `CodeRenderer.m` / `CodeBackground.m`，但在 `CodeBackground.m:85:54`、`:85:66` 失败：`textStorage` 为未定义 receiver（`unknown receiver 'textStorage'; did you mean 'NSTextStorage'?`、无 `attribute:atIndex:effectiveRange:` 类方法）。这是产品 patch 的 P1 阻断，owner 为 cloud-developer，需修复后重跑原生构建；禁止以 bundle 或静态合同替代。
- 2026-09-10，cloud-developer 返工自动化：修复后 `npx vitest run test/enrichedMarkdownContract.test.ts` 通过（12/12）、`npm run typecheck` 通过、`npm run lint` 通过、`npm run postinstall` 通过（patch applied）。
- 2026-09-10，cloud-developer 返工原生 smoke：先运行 `curl -fsS http://127.0.0.1:8787/health`，返回 `{"status":"ok","protocolVersions":["1.0.0"]}`；`lsof` 确认并复用 PID 8150，未重启/停止 Host。随后在 `repos/cloud-mobile` 执行正常 `npm run ios`，Xcode 26.6 成功编译 `CodeRenderer.m`、`CodeBackground.m`，最终 `Build Succeeded`，`0 error(s), and 0 warning(s)`，安装并启动 iPhone 17 Pro Simulator；首页显示“Host 已连接”。
- 第一轮交接时未构造专用 Markdown inline/fenced fixture，因此 inline code 背景、跨行 suffix、拖选/复制仍未完成真实视觉验收，交由第二轮独立 cloud-tester 复验。
- 2026-09-10，cloud-tester：因 iOS 原生编译失败，未执行/不能判通过真实 Simulator Host 会话、inline/fenced code 视觉、拖选复制和 Android 原生构建；Host health 仅证明复用的 PID 8150 存活，不是 UI 验收证据。Android 原生未验证（当前环境尚未执行 `npm run android`）。
- 2026-09-10，cloud-tester 补充环境证据：`git diff --check` 仍报告 patch 文件的 7 个 trailing-whitespace 行；staged 基线也已有同类 patch-format 空白行，未擅自改写 package patch。Android 环境中 `adb` 与 `emulator` 命令均不可用、无可启动 AVD，因此 Android 原生构建属于环境未覆盖，不推断通过。
- 2026-09-10，cloud-tester 第二轮独立复验（`repos/cloud-mobile`）：开发者将 `CodeBackground.m` 的未定义 `textStorage` 修为 `[layoutManager.textStorage ...]`；`npx vitest run test/enrichedMarkdownContract.test.ts` 12/12 通过，`npm run postinstall` 成功应用 patch；从全新 `react-native-enriched-markdown@0.5.0` tarball 用 `patch -p1 --batch --forward` 成功应用 5 个文件，且干净树包含合法 `layoutManager.textStorage`、`blockFont.pointSize`、逐行 glyph 与 nested indent 修复。公式关闭、GitHub/selectable、原有 nested list/code-block hunks 由合同测试和当前 patch 文件核对仍保留。
- 2026-09-10，cloud-tester 第二轮真实 iOS 原生/连接 smoke：先 `curl -fsS http://127.0.0.1:8787/health` 返回 `{"status":"ok","protocolVersions":["1.0.0"]}`，`lsof` 确认复用 Host PID 8150，未重启/停止；随后在 `repos/cloud-mobile` 执行正常 `npm run ios`（无 `CODE_SIGNING_ALLOWED=NO`），Xcode 26.6 实际编译 `CodeRenderer.m`、`CodeBackground.m`，`Build Succeeded`、0 error/0 warning，安装并启动 iPhone 17 Pro Simulator。只读截图 `/tmp/ccvibe-markdown-round2.png` 显示首页“Host 已连接”，证明签名原生应用可连接本机 Host。
- 2026-09-10，cloud-tester 第二轮视觉覆盖边界：当前已启动会话没有可注入本计划短 inline、跨行 inline、单/多行 fenced code fixture 的操作入口，未执行拖动选区/复制任意片段，也未判定背景边界或代码块高度视觉通过；这些是未覆盖项而非编译失败。Android 原生仍未验证（环境无 `adb`/`emulator`/AVD）。`git diff --check` 仍只报告 package patch 的 7 个 trailing-whitespace 行，且 staged 基线已有同类 patch-format 空白，未擅自重写产品 patch。

## 架构师收敛

2026-09-10：独立验收确认 `react-native-enriched-markdown@0.5.0` 的 iOS inline code 字号继承和背景几何需要由 package patch 持有；已把该持久 owner 收敛到根 `harness.md`，并继续保留公式全链路关闭约束。具体 TextKit 算法与视觉人工复核项留在本计划，不提升为全局规则。
