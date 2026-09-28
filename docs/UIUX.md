# UIUX 设计文档 - tiancaiConfig 三合一 AI 工具配置器 v1.0

> 产出：颜好看（UI/UX 设计师）· Phase 1 设计调研 · 2026-09-24
> 状态：待用户确认

---

## 1. 对标品牌（4 个）

| 对标 | 借鉴 | 警示 |
|------|------|------|
| cc-switch（最直接） | 「顶部目标切换 + 卡片列表 + 单表单」心智模型；预设自动填充；健康检查 | 我们的连通性测试+测速必须比它做得更好 |
| Linear | 交互纪律：单强调色克制、密度节奏统一（表单行 40px）、13px 内文字体、4px 间距基准、空状态单句文案、平面化、乐观 UI | 「Linear 皮」（深色+光晕）已被抄烂，只取纪律不抄视觉 |
| Raycast | 文本优先、窗口即工具、固定尺寸快速开关 | — |
| Postman/Insomnia | Postman=反例警示（新手 overwhelming）；Insomnia=正例（轻量聚焦） | 凭证字段 mono 字体 + 遮蔽切换是共同模式 |

**趋势锚点**：动效是反馈不是装饰（150ms 收敛）；文本优先回归；乐观 UI + 行级状态；层级靠色调递进不靠阴影；凭证安全感 = mono 字体 + 遮蔽切换 + 写入前 diff 预览。

## 2. 设计方向定调

- 产品寄存器：**Product**（工具型桌面应用，标杆是「赢得熟悉感」）
- 三轴刻度：DESIGN_VARIANCE=4 ｜ MOTION_INTENSITY=4 ｜ VISUAL_DENSITY=5
- 平台：Windows + macOS 同一套 Web 前端，浅色主题为主
- 窗口：固定 920×640 逻辑像素，系统原生标题栏，无自定义花活

## 3. 配色方案

- 主色/强调色：**#2563EB 纯色蓝**（传达「配置写入安全可信」；纯色零渐变，P0-2 合规）
- 背景：#F8FAFC 页面 / #FFFFFF 卡片
- 前景：#1E293B 主文本 / #64748B 次文本
- 边框：#E2E8F0
- 语义色：success #16A34A / warn #D97706 / danger #DC2626 / info #0284C7
- 配比纪律：中性色 85%+ / 强调色 ≤10%（每屏 ≤2 处：主 CTA + 选中态）/ 语义色 0-5%

## 4. 字体方案（中文场景 · 桌面原生感）

- UI 字体：系统字体栈（不加载网络字体，桌面秒开是底线）
  `"PingFang SC", "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif`
- 等宽字体（工艺灵魂）：API Key、中转地址、模型 ID、文件路径、JSON diff 全部 mono
  `"JetBrains Mono", "Cascadia Code", "SF Mono", Consolas, monospace`
- 字重：400 正文 / 510 小标题按钮 / 590 大标题；正文 14px、辅助 13px、标签 12px
- 字距：中文正文 0；标题 -0.01em；大写英文标签 ≥0.06em
- 表单行高统一 40px（对齐 Linear 密度纪律）

## 5. 布局骨架（3 方案对比，选 A）

### 方案 A：顶部目标切换栏 + 单页聚焦表单 ★ 选定

```
┌──────────────────────────────────────────────┐
│  [Codex CLI] [Codex Desktop] [WorkBuddy]     │ ← 顶部目标 Tab（含状态点）
├──────────────────────────────────────────────┤
│  中转地址 [mono，带默认占位]                    │
│  API Key  [mono + 遮蔽切换]                    │
│  ▸ 查看详情（模型列表/测速徽章/Diff 预览，默认折叠）│
│  ▸ 高级选项（模型勾选 / ASAR 补丁，默认折叠）    │
├──────────────────────────────────────────────┤
│  [回滚]         [一键配置]（主 CTA，强调色）     │
└──────────────────────────────────────────────┘
```

- 主 CTA =「一键配置」：唯一必填项为中转地址与 API Key，其余全自动（用户修订 2026-09-24：C 端一键配置）
- 优点：匹配「清晰简单」强诉求；cc-switch 用户零学习；熟手可展开「查看详情」逐步操作；高级选项渐进披露
- 总监裁决 1：吸收方案 B 的分区编号与状态徽章（分区完成打勾、当前分区高亮），**不用强制步骤门**——PM 的「5 步向导」实现为单页内逻辑流：填连接→拉模型→勾选→预览→写入

### 方案 B：左侧列表 + 分步 Stepper（否决）

短任务用向导「显得慢」，熟手被强制点 4 次下一步；旧工具 12 步引导正是被重写的原因。

### 方案 C：三栏 Dashboard（否决）

920px 窗口塞三栏过度拥挤，对「一次配置一个目标」主任务流是过度设计。

## 6. 状态反馈模式

1. **测速**：按钮 spinner + 模型列表行级骨架屏（逐行渐现）；结果徽章 <300ms 绿「快」/ <1s 黄「中」/ >1s 橙「慢」/ 超时红「失败-重试」
2. **写入流（信任三段式）**：写入前 JSON diff 预览（改动行高亮）→ 写入中进度条 + 目标文件路径 → 成功 toast（含 mono 路径 + 「打开文件位置」）
3. **失败分类**：Key 无效（401）/ 网络超时 / 文件被占用（提示关闭 Codex 重试）/ 权限不足——每类给具体文案 + 重试按钮，不暴露技术堆栈
4. **目标状态点**：目标 Tab 常驻状态点（绿=已配置并验证 / 黄=已配置未验证 / 灰=未配置）
5. **5 态覆盖**：向导每分区都有 Loading / Empty / Error / Populated / Edge 设计

## 7. 图标系统（P0 锁定）

- **锁定 Lucide**（lucide-react v1.45.0，与架构师 ADR-006 一致）
- 理由：MIT 兼容 ISC、2px 统一描边、shadcn/ui 默认库、React 官方包、tree-shakable
- 尺寸：16px 行内（label 旁、状态徽章内）/ 20px 按钮内 / 24px 独立（目标卡片、空状态）
- 核心映射：Terminal（Codex CLI）/ AppWindow（Codex Desktop）/ Bot（WorkBuddy）/ KeyRound（Key 输入）/ Link2（中转地址）/ Gauge（测速）/ Download（拉取）/ FileDiff（Diff 预览）/ Save（写入）/ CircleCheck（验证通过）/ RefreshCw（重试）/ Eye/EyeOff（遮蔽）/ Copy / TriangleAlert / FolderOpen / ChevronDown（折叠高级选项）/ Settings

## 8. Design Token v0.1（浅色主题）

```css
:root {
  /* Identity */
  --bg: #F8FAFC;  --surface: #FFFFFF;  --fg: #1E293B;  --muted: #64748B;
  --accent: #2563EB;  --border: #E2E8F0;
  --font-ui: "PingFang SC", "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", "Cascadia Code", "SF Mono", Consolas, monospace;
  /* B-slot */
  --surface-warm: #F1F5F9;  --fg-2: #475569;  --meta: #94A3B8;  --border-soft: #F1F5F9;
  /* Semantic */
  --accent-on: #FFFFFF;  --accent-hover: #1D4ED8;  --accent-active: #1E40AF;
  --success: #16A34A;  --warn: #D97706;  --danger: #DC2626;  --info: #0284C7;
  --focus-ring: 0 0 0 3px rgba(37, 99, 235, 0.3);
  /* Structure */
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
  --space-5: 20px; --space-6: 24px; --space-8: 32px; --space-10: 40px;
  --radius-sm: 6px; --radius-md: 8px; --radius-lg: 12px;
  --shadow-flat: none;
  --shadow-ring: 0 0 0 1px var(--border);
  --shadow-raised: 0 1px 2px rgba(15,23,42,.04), 0 4px 12px rgba(15,23,42,.06);
  --motion-fast: 150ms; --motion-base: 200ms;
  --ease-standard: cubic-bezier(0.2, 0, 0, 1);
  --text-xs: 12px; --text-sm: 13px; --text-base: 14px; --text-lg: 16px;
  --text-xl: 20px; --text-2xl: 24px;
}
```

Tailwind v4 通过 @theme 映射以上变量（与架构师 ADR-006 对齐，回应设计师 advisory）。

## 9. P0 合规自检

- ✅ P0-1 无 emoji：全部 Lucide SVG，16/20/24px 场景已定义
- ✅ P0-2 无紫粉渐变：#2563EB 纯色，全案零渐变
- ✅ P0-3 无空洞占位：文案基于真实功能（空状态「选择上方目标应用，开始配置」）
- ✅ 硬编码色为零：17 个语义色全部 Token 化
- ✅ 非 Hero 套路：首屏即目标选择+表单真实内容
- ✅ 中文适配：系统字体栈原生渲染 + 全中文 UI 文案

## 10. 变更记录

| 日期 | 变更 | 原因 |
|------|------|------|
| 2026-09-24 | v1.0 初稿 | Phase 1 设计调研产出，含总监裁决 1（单页三分区胜出） |
