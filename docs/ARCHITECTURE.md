# 架构文档 - tiancaiConfig 三合一 AI 工具配置器 v1.0

> 产出：高见远（首席架构师）· Phase 1 联网查证（版本基线 2026-09-23）· 2026-09-24
> 状态：待用户确认

---

## 1. 技术选型总表（逐层锁定）

| 层 | 选型 | 锁定版本 | 锁定原因 |
|----|------|----------|----------|
| 语言运行时 | Go | 1.26.x（最低 1.25） | 当前稳定线，内建交叉编译 |
| GUI | Go 本地 HTTP/SSE + 平台窗口降级链 | 自研薄层（复用旧项目已验证模式） | 唯一满足「单 runner 全交叉编译 + 单文件免安装」 |
| 前端框架 | React + Vite | React 19.3.0；Vite 7.x（实施日以 npm 实际解析版本锁定 package-lock） | 最新稳定，工具型 UI 足够 |
| 图标库（P0 锁定） | lucide-react | v1.45.0（2026-09-12），ISC 许可 | 1500+ SVG、tree-shakable、全项目唯一图标来源，禁 emoji |
| CSS | Tailwind CSS | v4.x（实施日锁定实际版本，@theme 映射设计 Token） | 稳定线，CSS-first 与设计师 Token 结构对齐 |
| 本地存储 | JSON 文件（标准库 encoding/json） | — | 数据量仅 KB 级；SQLite 属过度设计 |
| Key 存储 | zalando/go-keyring | 最新稳定 | Windows→Credential Manager/DPAPI；macOS→/usr/bin/security CLI；零 cgo |
| ASAR 引擎 | 自研 Go 等长补丁器 | 按 @electron/asar v4.3.0 格式规范 + 单测对拍 | 格式简单（JSON header + 平铺文件区） |
| plist 处理 | howett.net/plist 或 PlistBuddy 调用 | 实施日锁定 | 纯 Go 优先 |

## 2. GUI 方案选型矩阵（选 B，否决 A/C/D）

| 维度 | A: Wails v2.11 | **B: Go+HTTP/SSE+窗口策略（选定）** | C: Tauri 2.11 | D: Fyne v2.7.3 |
|------|----------------|-----------------------------------|---------------|----------------|
| 单文件免安装 | 是（8-12MB） | 是（10-15MB，前端 go:embed） | 是 | 是（20-30MB） |
| 交叉编译 Win→macOS | **否**（官方明确不支持，v3 仍 alpha） | **是**（CGO_ENABLED=0 一条命令出 win/amd64 + darwin/amd64 + darwin/arm64） | 否（需 mac runner） | 否（OpenGL cgo） |
| macOS 原生窗口 | WKWebView（最好） | 无原生窗口；Edge/Chrome --app 无边框窗口（接近原生）或默认浏览器 | WKWebView | 自绘观感一般 |
| 前后端通信 | 框架绑定 | REST + SSE（127.0.0.1 随机端口+回环校验，旧项目已验证） | IPC Channels | 进程内 |
| ASAR/文件操作生态 | Go 强项 | Go 强项 | Rust 重写成本高 | Go 强项 |

**macOS WKWebView cgo 专项评估**：cgo 绑定换取的仅是「无需浏览器」的原生窗口，--app 模式独立窗口视觉差异极小、实现零成本。体验差距 < 构建链复杂度，纯窗口策略胜出。

### 窗口降级链（锁定）

- **Windows**：WebView2（go-webview2 loader，Win10/11 自带 runtime）→ Edge App Mode（`msedge --app=URL --user-data-dir` 隔离）→ 默认浏览器
- **macOS**：直接执行 Edge bundle 内二进制 `--app=URL`（比 `open --args` 可靠——open 的 --args 在浏览器已运行时被忽略，已查证）→ Chrome --app → open URL 默认浏览器
- **安全**：仅绑定 127.0.0.1 + 随机端口 + 启动 token 回环校验 + Origin/CSRF 校验

## 3. 架构分层与目录约束

```
cmd/app/main.go              # 入口只装配，零业务
internal/server/             # HTTP+SSE、回环安全中间件
internal/configurators/      # registry.go + contract.go
  ├── codexcli/              # config.toml + auth.json 写入（cc-switch 路由可选）
  ├── codexdesktop/          # 配置写入 + 可选 ASAR 补丁编排
  └── workbuddy/             # models.json 批量写入
internal/patcher/            # ASAR 引擎（独立于目标，未来 Claude Desktop 直接受益）
internal/storage/            # JSON 原子写、keyring、备份管理
internal/registry/           # 模型元数据库
internal/platform/           # 窗口策略、路径解析（build tags 分平台）
web/                         # React 19 + Vite 7 + Tailwind v4 + lucide-react
```

约束：单文件 ≤300 行；按资源分包；入口只装配。

## 4. 目标插件接口（Configurator 契约）

```go
type Target interface {
    ID() string
    DisplayName() string
    Detect(ctx) (DetectResult, error)    // 已装？版本？配置路径？可写？
    Backup(ctx) (BackupReceipt, error)   // 时间戳备份，返回回滚凭证
    Plan(ctx, Config) ([]Change, error)  // 干跑：GUI 预览将写入的文件与 diff
    Configure(ctx, Config) error         // 执行写入
    Verify(ctx) (VerifyResult, error)    // 写后校验（文件+格式+可选连通性）
    Rollback(ctx, BackupReceipt) error
}
```

新增目标成本：实现 1 个包（6 方法）+ 注册 1 行，零引擎改动。Claude Code 等未来目标边际成本约 1-2 人日。

## 5. ASAR 补丁引擎要点（可行性：确认可行）

**格式**（@electron/asar v4.3.0 规范）：`[8B Pickle 头（UInt32 header_size）][header JSON][file1][file2]...`；header 内每文件 `{offset:"uint64字符串"(相对数据区), size, integrity:{SHA256, blockSize:4MB, blocks[]}}`；绝对偏移 = 8 + header_size + offset。

**全链路**：Detect（定位 ChatGPT.exe / Codex.app + 读 fuse sentinel `dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX` 判定 integrity fuse）→ 复制整个 .app/.exe 到备份目录（副本操作）→ 解析 header 定位 bundle → 长度预算检查 → 等长写入 → 可选原位更新 blocks hash（hex 定长，不改变 header 长度→全部偏移不变，已验证自洽）→ macOS：更新 Info.plist hash + `codesign --force --deep --sign -` 重签 → Verify → Rollback。

## 6. 模型 Registry 与 Key 存储

- **Registry**：go:embed 内嵌 JSON（含 schema_version + updated_at）+ 启动后台静默检查远端（HTTPS、固定域名、超时 3s、失败静默用内嵌版）+ 缓存 `~/.<tool>/registry-cache.json` + GUI 手动刷新。Provider/模型增补无需发版。
- **Key 存储**：OS keyring 优先（go-keyring，零 cgo）；回退 AES-256-GCM 文件（密钥存 keyring）；keyring 不可用则明文文件 + GUI 红色警告。注意：写入目标应用（Codex auth.json、WorkBuddy models.json）必须明文——应用格式要求，工具端加密只保护自家 Key 池，纵深防御。

## 7. 不可行警告（进 Spec 硬约束）

1. **不可行**：任何 cgo GUI 路线（Wails/Tauri/Fyne）无法从单一 runner 全交叉编译三目标；Wails v3 仍 alpha 不可用于生产
2. **边界**：Windows 上启用 ASAR integrity fuse 的 Electron 应用（electron≥30 校验 PE 资源 hash）——等长替换后需更新 PE 资源，复杂高危 → **v1 不做自动 patch，检测到 fuse 开启即警告并只走配置写入**
3. **边界**：macOS fuse 开启时 hash 存于 Info.plist ElectronAsarIntegrity → 可自动修复（更新 plist + ad-hoc 重签）
4. **坑**：Apple Silicon 修改 Electron 二进制后必须 ad-hoc 重签，否则内核直接 kill 进程
5. **坑**：等长替换前提是新 JS 字节长度 ≤ 原 bundle size（不足补注释），超长必须先做长度预算检查、报错而非硬写

## 8. ADR 索引（MADR 格式，正式版存 docs/decisions/）

| ADR | 决策 | 要点 |
|-----|------|------|
| ADR-001 | Go 1.26 + 本地 HTTP/SSE + 窗口降级链 | 否决 Wails/Tauri/Fyne；唯一满足单 runner 全交叉编译 |
| ADR-002 | JSON 文件存储 + 原子写 + schema_version | 否决 SQLite（KB 级数据不需要） |
| ADR-003 | go-keyring（DPAPI/Keychain）+ AES-GCM 回退 + 明文降级显式警告 | Key 纵深防御 |
| ADR-004 | ASAR 等长替换 + fuse 检测 + macOS plist 修复重签；Windows fuse 开启 v1 不支持 | 高危场景显式排除 |
| ADR-005 | 模型 registry go:embed 内嵌 + 远端缓存 + 手动刷新 | 上游出新模型不必发版 |
| ADR-006 | React 19.3.0 + Vite 7.x + Tailwind v4.x + lucide-react v1.45.0 | 图标库锁定 Lucide，全项目唯一 SVG 来源，禁 emoji（P0 落地） |
| ADR-007 | **Electron 打包**（2026-09-24 用户决策） | 主进程 Node 承载引擎（1:1 移植 Go 逻辑），BrowserWindow 承载 React 前端；Windows portable exe + macOS .app zip 免安装交付；取代 ADR-001 的窗口宿主层，HTTP/SSE 通信与安全模型沿用 |
| ADR-008 | **cc-switch 本体集成 + 双模式 + 自动更新**（2026-09-24 用户决策） | 不自造代理，直接帮用户安装并配置 cc-switch（安装链路/SQLite 写库/15721 接管 1:1 移植自 ccswitch-codex-setup 实战语义）；Codex 模型范围双模式（gpt-only 直连 / all-models 经 cc-switch）；WorkBuddy 自动更新（LaunchAgent WatchPaths / 计划任务，headless 自执行，网关记忆防多网关误判）；SQLite 用 node:sqlite 内置模块（零原生重构建，Electron 44 = Node 24.21 稳定支持） |

## 9. 一键配置编排（C 端核心流，用户修订 2026-09-24；双模式扩展 2026-09-24 第二轮）

`POST /api/oneclick` → SSE 事件流，十阶段管线：

```
validate → fetch(=连通性测试 + /v1/models 拉取) → filter(白名单过滤)
→ speedtest(并发测速选优) → [ccswitch(all-models 模式)] → plan(生成写入 diff)
→ backup → write(全目标原子写) → [autoupdate] → verify → [launch cc-switch]
```

- **Codex 模型范围（codexMode，仅作用于 Codex 目标）**：
  - `gpt-only`：直连中转站改配置文件；Codex 模型池仅保留 gpt-* 系
  - `all-models`（默认推荐）：自动安装/配置 **cc-switch 本体**（SQLite 写 providers+modelCatalog+proxy_config、settings.json 同步、开机自启可选默认开），Codex config.toml 指向 `http://127.0.0.1:15721/v1`，模型池全量（写入完成后自动拉起 cc-switch）
- **WorkBuddy 永远直连中转站**；「模型自动更新」按目标能力注册（registry `autoupdate` 字段声明，凡已适配目标 GUI 默认勾选；当前适配=WorkBuddy + Codex，未来新工具适配后自动纳入）：
  - _WorkBuddy_：macOS LaunchAgent WatchPaths 监听 `~/.workbuddy/last-launch.json`（WorkBuddy 每次启动触发） / Windows 计划任务（登录触发），headless `--autoupdate-workbuddy`，Key 从 models.json 本网关条目反推
  - _Codex（CLI/Desktop 共用 ~/.codex，注册去重为单 agent）_：macOS WatchPaths 监听 `~/.codex/sessions` + `~/.codex/history.jsonl`（每次启动会话写入） / Windows 计划任务（登录触发），headless `--autoupdate-codex`；gpt-only 幂等重写 config.toml（默认模型消失才切换），all-models 刷新 cc-switch 模型目录（集合无变化跳过，避免反复重启）；网关记忆于 `~/.tiancaiConfig/gateways.json`（主流程写入时记录 base+Key+模式）
- 自动选型策略：测速最快者为默认模型（Codex 在 gpt-only 模式下从 GPT 池内选取），其余通过过滤的模型全量写入能力字段
- 任一目标写入失败 → 已写目标自动全量回滚（写前备份）
- 全程仅两个必填输入：API Key + 中转地址；模型勾选、Diff 预览、ASAR 补丁默认折叠为「查看详情 / 高级选项」
- Codex 写入语义沿用旧工具实战验证链：provider 块 `env_key` + `requires_openai_auth = false`，密钥同时写 `auth.json`（OPENAI_API_KEY + auth_mode=apikey），环境变量持久化（Windows 用户级 / macOS zshenv + launchctl setenv）；并收口旧工具 takeover 的两条硬保证：`model_reasoning_effort = "max"`、`model_context_window = 272000`
- cc-switch 数据库写入（node:sqlite 内置模块，零原生依赖）：providers.settings_config 三键（auth/config TOML/modelCatalog 六档思考）、meta.apiFormat='openai_chat'、proxy_config 全表镜像写、provider_endpoints、settings.json.currentProviderCodex 同步；与原版 db.go 语义字段级对齐（对比回归测试 test/compare-legacy.test.js）

## 10. 双击直接运行（交付形态 —— ADR-007：Electron 打包）

> 用户修订（2026-09-24）：打包改为 **Electron**，多端免安装运行。本节取代 v1.0 的窗口降级链交付形态；ADR-001 的「本地 HTTP/SSE + 回环令牌」通信与安全模型继续沿用，仅窗口宿主从 WebView2/Edge 换为 Electron BrowserWindow。

| 平台 | 形态 | 双击行为 | 内核 |
|------|------|----------|------|
| Windows | tiancaiConfig portable exe（electron-builder portable 目标，单文件免安装） | 双击直接运行，弹出独立窗口 | Electron（内置 Chromium，不依赖系统 WebView2） |
| macOS | tiancaiConfig.app zip（解压即用） | 解压 → 双击 .app 直接运行 | Electron（arm64） |

- 引擎重写：Go 引擎的管线/配置写入/备份逻辑 1:1 移植为 Electron 主进程 Node.js 模块（app/src/engine/），API 契约（/api/*、SSE 事件结构）与前端零改动，React 前端直接复用
- 单实例：Electron requestSingleInstanceLock，二次双击唤起已有窗口
- 渲染进程 sandbox + contextIsolation；服务仅绑定 127.0.0.1 + 启动令牌 + Origin 回环校验（沿用）
- ASAR 补丁仍为 P1 可选高级功能，不进入双击默认流
- 代价声明：Electron 体积约 100MB+（Go 单文件约 12MB），换取跨系统 WebView 一致性与免 WebView2 依赖

## 11. 变更记录

| 日期 | 变更 | 原因 |
|------|------|------|
| 2026-09-24 | v1.0 初稿 | Phase 1 技术调研产出，含总监裁决 1/2 落地 |
| 2026-09-24 | ADR-008：cc-switch 本体集成 + Codex 双模式 + WorkBuddy 自动更新 | 用户需求：ccswitch-codex-setup 与 workbuddy-model 全部能力集成零遗漏，mac 对比测试达标；SQLite 从 better-sqlite3 迁移 node:sqlite（Electron 44 内置 Node 24，零原生重构建） |
