# cc-agent-mac 与 Apple 官方 Mac 风格差异（以「备忘录」为参照）

## 文档目的

- **参照应用**：macOS 系统自带 **备忘录（Notes）**——典型「侧栏列表 + 详情内容」原生 SwiftUI/AppKit 体验。
- **对比对象**：`repos/cc-agent-mac` 当前 UI 实现（`Sources/Design/*`、`Sources/Features/*`）。
- **用途**：指导样式对齐改造时的优先级、文件落点与验收标准；与 [prd.md](./prd.md) 中 Material/Liquid Glass 降级、与前期 Liquid Glass / macOS 14 材质调研结论一致。

**说明**：备忘录在 macOS 26 上会呈现 Liquid Glass 导航层；本仓库最低 **macOS 14**，差异与改造建议以 **14–15 系统范式（侧栏材质 + 实色内容区）** 为主，macOS 26+ 仅在「导航 chrome」层追加 `glassEffect` 条件分支，不改变下文分层原则。

---

## 参照：备忘录（Notes）的结构与风格要点

| 维度 | 备忘录典型做法 |
|------|----------------|
| **信息架构** | `NavigationSplitView`：左栏文件夹/笔记列表，右栏单条笔记正文；列宽可拖曳。 |
| **侧栏** | 系统 **Sidebar** 列表样式（圆角选中、材质背景、与壁纸 vibrancy）；行内 **标题 + 摘要/日期**；分组（文件夹）清晰。 |
| **工具栏** | 窗口 **Toolbar**（新建、删除、共享、格式等），图标按钮 + 菜单；**不在** 内容区底部堆一排表单控件。 |
| **搜索** | 侧栏顶部 **搜索框**（圆角、与列表一体），非登录页式分散字段。 |
| **内容区** | **窗口背景色**，排版为主（标题、正文层级）；**不对** 整页铺 HUD 模糊。 |
| **选中态** | 列表 **系统 selection**（蓝/灰高亮随系统主题），非自定义紫色半透明块。 |
| **空状态** | 未选笔记时 **引导文案 + 图标**（`ContentUnavailableView` 一类），非灰色占位一句。 |
| **弹窗** | 系统 **Sheet / Alert**；卡片为实色底 + 标准圆角，非自定义「玻璃卡」叠 blur。 |
| **强调色** | 跟随 **AccentColor / 系统 tint**；按钮主次用 `borderedProminent` / `bordered` / toolbar。 |
| **分隔** | `Divider`、`separatorColor`；内容区与工具栏/底栏边界清晰。 |

聊天型能力（流式消息、工具卡、权限）在备忘录中无直接对应，对齐时应保持：**导航与 chrome 学备忘录，消息区学 Mail/信息类「实底 + 清晰层级」**。

---

## 当前 cc-agent-mac 实现摘要

| 模块 | 关键文件 | 当前样式特征 |
|------|----------|----------------|
| 全局主题 | `Sources/Design/Theme.swift` | 硬编码紫色 accent；`windowBackgroundColor`；无间距/圆角/语义色 token。 |
| 「玻璃」 | `Sources/Design/GlassBackground.swift`、`VisualEffectView.swift` | `glassCard()`：`ultraThinMaterial` + `NSVisualEffectView(.hudWindow)` 叠层；macOS 26 分支仍未 `glassEffect`。 |
| 登录 | `Sources/Features/Login/LoginView.swift` | 全屏 `Theme.background` + 居中 `glassCard`；`.roundedBorder` 字段；主题 segmented 在表单内。 |
| 会话首页 | `Sources/Features/SessionList/SessionListView.swift` | `NavigationSplitView` + 默认 `List` + `DisclosureGroup`；顶栏 `HStack` 文字按钮/主题 Picker；**无** `.listStyle(.sidebar)`。 |
| 聊天 | `Sources/Features/Chat/ChatView.swift` | Split 侧栏为自建 `ScrollView` + `.thinMaterial` + 灰块分组；顶栏 `HStack`；底栏 `glassCard(0)` + `ModelEffortControls` 横排 Picker。 |
| 消息 | `Sources/Features/Chat/Views/MessageRow.swift` 等 | 气泡 `primary.opacity(0.05/0.15)`；工具卡 `opacity(0.04)`。 |
| 弹层 | `PermissionPromptView`、`TrustPromptView`、`AskUserQuestionView` | 内容 + `glassCard()`。 |

---

## 差异对照表（备忘录参照 → 现状 → 建议）

### 1. 窗口与导航骨架

| # | 备忘录参照 | cc-agent-mac 现状 | 差异严重度 | 改造建议 |
|---|------------|-------------------|------------|----------|
| N1 | 标准双栏 Split，侧栏常显或系统控制显隐 | 首页有 Split；聊天侧栏可收起且为自定义 VStack | 高 | 聊天页侧栏改为与首页一致的 **`List` + `.listStyle(.sidebar)`** + `navigationSplitViewColumnWidth`；显隐用 `columnVisibility` / 系统侧栏按钮，避免自建「全部会话」顶栏。 |
| N2 | 侧栏即导航，detail 只承载内容 | 聊天 detail 内再含 header/footer 整条工具带 | 中 | 将返回、侧栏切换、主题、自动跟随迁入 **`.toolbar`**；detail 主体仅为消息滚动区 + 底部输入 inset。 |
| N3 | 空 detail 有图标化空状态 | 首页 detail「选择或新建会话」纯文字 | 低 | 使用 `ContentUnavailableView("选择或新建会话", systemImage: "bubble.left.and.bubble.right")` 等。 |

### 2. 侧栏列表

| # | 备忘录参照 | cc-agent-mac 现状 | 差异严重度 | 改造建议 |
|---|------------|-------------------|------------|----------|
| N4 | `.listStyle(.sidebar)`，行高与系统一致 | 普通 `List` / `ScrollView` 手写行 | 高 | `SessionListView`、`ChatView` 侧栏统一 **sidebar list**；用 `Label` + SF Symbol（如 `folder`、`text.bubble`）。 |
| N5 | 行标题可读（笔记标题），副标题日期/摘要 | 会话行以 **sessionId 前 8 位 monospaced** 为主 | 高 | 产品化行模型：主标题用 cwd 名/首条用户消息摘要/自定义标题（daemon 若有）；副标题「条数 · 相对时间」；ID 放 accessibility 或次要 caption。 |
| N6 | 文件夹分组，展开行为系统一致 | `DisclosureGroup` 包工作区路径 | 中 | 可保留分组，但样式纳入 **Section header** + sidebar list，路径 **truncationMode(.middle)** 作副标题而非主标题。 |
| N7 | 侧栏背景为系统 sidebar 材质 | 聊天侧栏 `.thinMaterial` + `opacity(0.03)` 分组底 | 高 | **移除** 自定义 material 叠层；交给 `NavigationSplitView` 侧栏列默认背景。 |
| N8 | 选中会话系统高亮 | 聊天侧栏 `Theme.accent.opacity(0.12)` | 中 | 使用 `List(selection:)` + `tag`，与备忘录选中行一致。 |

### 3. 工具栏与控件

| # | 备忘录参照 | cc-agent-mac 现状 | 差异严重度 | 改造建议 |
|---|------------|-------------------|------------|----------|
| N9 | 操作在窗口 Toolbar（图标） | 刷新/断开/主题/返回等多为文字 `Button` 散落顶栏 | 高 | `.toolbar { ToolbarItemGroup(placement: .primaryAction) }`：刷新、断开、新建；主题收 **Settings 菜单** 或 `ToolbarItem(placement: .automatic)`。 |
| N10 | 格式/选项在 toolbar 或 menu，不占底栏 | `ModelEffortControls` 四个 `Picker` 横排底栏 | 高 | 模型/强度/权限 → **Menu** 或 toolbar **Picker**（`.pickerStyle(.menu)`）；底栏仅 **输入框 + 发送/停止**。 |
| N11 | 搜索在侧栏顶部 | 无全局搜索；仅「添加工作区路径」底栏 TextField | 中 | 侧栏 `.searchable` 过滤会话；工作区添加迁 toolbar 菜单或 sheet。 |
| N12 | 文本输入为内容区一部分 | `TextField` + `.roundedBorder` 在 `glassCard` 底栏 | 中 | `safeAreaInset(edge: .bottom)` + 顶部分隔线；输入区背景 `controlBackgroundColor` 或系统 inset 样式，**不用** `glassCard(cornerRadius: 0)`。 |

### 4. 内容区（聊天正文）

| # | 备忘录参照 | cc-agent-mac 现状 | 差异严重度 | 改造建议 |
|---|------------|-------------------|------------|----------|
| N13 | 内容区实色、排版层级清晰 | `Theme.background` 正确方向，但气泡/tool 用透明度灰 | 中 | 用户气泡：`controlBackground` / accent 浅填充；助手：**全宽排版** 或 `quaternarySystemFill`；避免 `primary.opacity(0.05)`。 |
| N14 | 无整页磨砂 | 登录/底栏/弹窗滥用 `glassCard` | 高 | 限制 `glassCard`：**仅** 必要时的小浮层（若保留）；登录改为实色卡片 + shadow；Sheet 用系统默认。 |
| N15 | 滚动内容不糊在工具栏下 | 消息区直达 header/footer | 低 | 为 toolbar/底栏 inset 留 padding；长列表保持 `LazyVStack`（已有）。 |

### 5. 视觉系统（颜色、字体、间距）

| # | 备忘录参照 | cc-agent-mac 现状 | 差异严重度 | 改造建议 |
|---|------------|-------------------|------------|----------|
| N16 | AccentColor 驱动 tint | `Theme.accent` RGB 硬编码 | 中 | Asset **AccentColor** 或保留品牌色但 Markdown/链接用 `.tint(.accentColor)`。 |
| N17 | SF Pro 标准字阶 | 混用 caption/body，无统一 scale | 低 | 在 `Theme` 或 `DesignTokens` 定义 `title2/headline/body/caption` 与 **8/12/16/20** 间距。 |
| N18 | `separatorColor` 分隔 | 部分 `Divider` 缺失，靠 opacity 分区 | 低 | 侧栏/内容/底栏之间统一 `Divider()`。 |

### 6. 材质与「玻璃」（与 PRD 一致）

| # | 备忘录参照（14–15） | cc-agent-mac 现状 | 差异严重度 | 改造建议 |
|---|---------------------|-------------------|------------|----------|
| N19 | 侧栏单层系统材质 | `GlassBackground` 双层 Material+Hud | 高 | 降级路径：**删除** hud 叠层；侧栏不手动铺 material。 |
| N20 | 内容不玻璃化 | 消息/列表内容无玻璃（符合） | — | 保持；勿为「好看」给气泡加 material。 |
| N21 | 26+ 导航 Liquid Glass | `#available(26)` 仍 Material | 中 | SDK 可用时 chrome 用 `glassEffect`；内容仍实色（与备忘录在 26 上行为一致）。 |

### 7. 弹窗与模态

| # | 备忘录参照 | cc-agent-mac 现状 | 差异严重度 | 改造建议 |
|---|------------|-------------------|------------|----------|
| N22 | Sheet 系统样式 | Permission/Ask `glassCard` | 中 | Sheet 内用标准 `Form`/`GroupBox` 布局；信任提示优先 `.alert` 或 sheet。 |
| N23 | 模态 dimming 适度 | 信任 overlay `black 0.3` | 低 | 可保留；中心卡片改实色 `controlBackground` + 圆角 12。 |

### 8. 登录页（备忘录无直接对应）

| # | 参照延伸（系统 App 登录/设置） | 现状 | 差异严重度 | 改造建议 |
|---|-------------------------------|------|------------|----------|
| N24 | 简洁表单 + 窗口居中，非「磨砂大卡」 | `glassCard` 包裹表单 | 中 | 单窗 `Form` 或分组列表样式；背景 `windowBackgroundColor`；主按钮 `borderedProminent`。 |
| N25 | 连接设置可进「设置」二次页 | 登录页堆 host/port/TLS/token/主题 | 低 | 首屏仅 token + 连接；高级设置 sheet（可选）。 |

---

## 按页面的改造优先级

| 优先级 | 页面/组件 | 对应差异项 | 预期效果 |
|--------|-----------|------------|----------|
| P0 | `SessionListView` | N4, N5, N6, N9, N11, N3 | 首页像「文件夹列表」式侧栏应用 |
| P0 | `ChatView` 侧栏 + toolbar | N1, N2, N7, N8, N9, N10, N12 | 聊天布局接近「备忘录 + 底栏输入」 |
| P1 | `Design/GlassBackground` + 调用点 | N14, N19, N21 | 去掉脏 blur，材质符合 HIG |
| P1 | `MessageRow` / `ToolUseCard` | N13 | 内容区可读、深色模式不脏 |
| P2 | `LoginView` | N24, N25 | 登录不再「异类卡片」 |
| P2 | `Theme` → tokens | N16, N17, N18 | 全局一致 |
| P3 | 弹窗视图 | N22, N23 | Sheet 原生感 |

---

## 建议新增/调整的代码落点（实施时）

| 落点 | 动作 |
|------|------|
| `Sources/Design/Theme.swift` | 扩展语义色、间距、圆角；accent 与 Asset 对齐。 |
| `Sources/Design/GlassBackground.swift` | 单层降级；26+ `glassEffect`；**禁止** 用于消息/整页底栏。 |
| `Sources/Features/SessionList/SessionListView.swift` | `.listStyle(.sidebar)`、toolbar、searchable、ContentUnavailableView。 |
| `Sources/Features/Chat/ChatView.swift` | 侧栏 List 化；header → toolbar；footer → safeAreaInset。 |
| `Sources/Features/Chat/Views/ModelEffortControls.swift` | 改为 Menu/Toolbar 呈现。 |
| `Sources/Features/Login/LoginView.swift` | 去掉 glassCard，Form 化。 |
| 各 `*PromptView` / `AskUserQuestionView` | 去掉 glassCard，Sheet 标准布局。 |

---

## 验收标准（对照备忘录体验）

1. **侧栏**：在 macOS 14 浅色/深色下，侧栏与系统备忘录类似（材质、选中、行高），无自定义灰块分组底。  
2. **工具栏**：主要操作在窗口 toolbar，底栏无 4 个并排宽 Picker。  
3. **内容区**：聊天背景与窗口一致，气泡/工具卡不使用整页 material。  
4. **空状态**：首页 detail、无消息时有标准空状态组件。  
5. **登录与 Sheet**：无 HUD 双层模糊；降低透明度系统设置下仍可读。  
6. **构建**：`macOS 14` deployment target 不变；macOS 26 SDK 可选开启 glass 分支编译通过。

---

## 相关文档

- [prd.md](./prd.md) — 产品范围与玻璃降级要求  
- [implementation-research.md](./implementation-research.md) — 工程与 UI 缺口  
- [adr.md](./adr.md) — 原生 SwiftUI 与 Material 决策  
- 会话内调研：Liquid Glass（macOS 26+）与 macOS 14–15 材质降级原则  

---

## 修订记录

| 日期 | 说明 |
|------|------|
| 2026-07-06 | 初版：以备忘录为参照的差异与改造清单 |