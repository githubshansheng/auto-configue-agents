// cc-switch 本体集成：探测 → 安装 → 配置写入（SQLite）→ 开机自启 → 启动。
// 语义 1:1 移植自 ccswitch-codex-setup（实战验证过的写库链路）：
//   · providers.settings_config = {auth:{OPENAI_API_KEY,auth_mode}, config:<TOML>, modelCatalog}
//   · providers.meta.apiFormat='openai_chat'（本地路由协议转换必需）
//   · settings.json.currentProviderCodex 必须同步（UI 判定「当前供应商」的真正来源）
//   · proxy_config 总开关 proxy_enabled 从 claude 行读取语义 → 全表镜像写
//   · ~/.codex/config.toml 接管 base_url=http://127.0.0.1:15721 + wire_api=responses
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn, spawnSync } = require('node:child_process')

const { enableAutostart, disableAutostart, autostartEnabled } = require('./autostart')

const CC_REPO = 'farion1231/cc-switch'
const PINNED_VERSION = '3.20.3'
const CC_PORT = 15721
const PROVIDER_NAME = 'tiancaiConfig 中转'
// 更名前的供应商名：老版本写入的行原地更新改名，避免残留两条重复配置
const LEGACY_PROVIDER_NAMES = ['TriConfig 中转']
const REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
// 默认思考量：全工具统一 xhigh（2026-09-26 用户需求）。cc-switch 投影目录的
// 档位回退链为「模型显式声明 defaultReasoningLevel > 模板默认 > canonical 序最高档」，
// catalog 每模型显式声明即必赢；provider TOML 与 Codex config.toml 同步写 xhigh。
const DEFAULT_REASONING = 'xhigh'
const DEFAULT_CONTEXT_WINDOW = 272000 // OpenAI 家族官方基线，兜底 cc-switch 投影目录的 128K 默认
const EXE_CACHE = 'codex-setup-last-exe.txt'

// ---------- 路径与探测 ----------

function ccDir(home) {
  return path.join(home || os.homedir(), '.cc-switch')
}
function ccDBPath(home) {
  return path.join(ccDir(home), 'cc-switch.db')
}
function ccSettingsPath(home) {
  return path.join(ccDir(home), 'settings.json')
}
function exeCachePath(home) {
  return path.join(ccDir(home), EXE_CACHE)
}

function fileExists(p) {
  if (!p) return false
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}
function dirExists(p) {
  if (!p) return false
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

// macAppBundle 由二进制路径反推 .app bundle 路径。
function macAppBundle(exePath) {
  const i = exePath.indexOf('.app/')
  return i >= 0 ? exePath.slice(0, i + '.app'.length) : exePath
}

// locateExe 多路定位 cc-switch 可执行文件（沿用旧工具探测优先级，Windows 全盘扫描省略）。
// opts.scanDirs 可注入 mac 扫描目录（测试隔离机器真实安装状态）。
function locateExe(home, opts = {}) {
  // 1) 旧工具留下的缓存（上次运行记录）
  const cached = fileExists(exeCachePath(home))
    ? fs.readFileSync(exeCachePath(home), 'utf8').trim()
    : ''
  if (cached && fileExists(cached)) return cached

  if (process.platform === 'win32') {
    const roots = []
    const local = process.env.LOCALAPPDATA || ''
    const pf = process.env['ProgramFiles'] || ''
    const pf86 = process.env['ProgramFiles(x86)'] || ''
    for (const base of [local, process.env.APPDATA || '', pf, pf86]) {
      if (!base) continue
      for (const name of ['cc-switch', 'CC Switch', 'CCSwitch', 'CC-Switch']) {
        roots.push(path.join(base, 'Programs', name, 'cc-switch.exe'))
        roots.push(path.join(base, name, 'cc-switch.exe'))
      }
    }
    for (const p of roots) if (fileExists(p)) return p
    return ''
  }
  if (process.platform === 'darwin') {
    const scanDirs = opts.scanDirs || ['/Applications', path.join(home || os.homedir(), 'Applications')]
    for (const base of scanDirs) {
      for (const name of ['cc-switch.app', 'CC Switch.app', 'CC-Switch.app']) {
        const exe = path.join(base, name, 'Contents', 'MacOS', 'cc-switch')
        if (fileExists(exe)) return exe
        const bundle = path.join(base, name)
        if (dirExists(bundle)) {
          // bundle 内二进制名不一定是 cc-switch：取 MacOS 目录下第一个可执行文件
          const macDir = path.join(bundle, 'Contents', 'MacOS')
          try {
            for (const f of fs.readdirSync(macDir)) {
              const p = path.join(macDir, f)
              try {
                fs.accessSync(p, fs.constants.X_OK)
                return p
              } catch {}
            }
          } catch {}
        }
      }
    }
  }
  return ''
}

// detectCC 探测结果：dataInstalled = ~/.cc-switch/cc-switch.db 存在。
function detectCC(home, opts = {}) {
  const dbInstalled = fileExists(ccDBPath(home))
  const exePath = locateExe(home, opts)
  let detail
  if (dbInstalled && exePath) detail = '已安装 cc-switch（' + exePath + '）'
  else if (dbInstalled) detail = '检测到 cc-switch 数据，但未定位到可执行文件，将自动补装'
  else detail = '未安装 cc-switch，将自动下载安装（约 13MB）'
  return { installed: dbInstalled || !!exePath, dbInstalled, exePath, detail }
}

// ---------- 版本与下载 ----------

async function fetchLatestVersion() {
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 8000)
    const res = await fetch('https://api.github.com/repos/' + CC_REPO + '/releases/latest', {
      headers: { 'User-Agent': 'tiancaiConfig', Accept: 'application/vnd.github+json' },
      signal: ctl.signal,
    })
    clearTimeout(timer)
    if (res.ok) {
      const j = await res.json()
      const v = String(j.tag_name || '').replace(/^v/, '')
      if (/^\d+\.\d+\.\d+$/.test(v)) return v
    }
  } catch {}
  return PINNED_VERSION
}

// ghCandidates 国内镜像优先（沿用旧工具线路：ghproxy 系存活探测略，逐条尝试即可）。
function ghCandidates(ghURL) {
  return [
    'https://ghproxy.net/' + ghURL,
    'https://gh-proxy.com/' + ghURL,
    'https://ghfast.top/' + ghURL,
    ghURL,
  ]
}

// downloadWithMirrors 逐线路下载；onProgress(已下载MB) 每 2MB 汇报一次。
async function downloadWithMirrors(ghURL, dst, onProgress) {
  let lastErr
  for (const url of ghCandidates(ghURL)) {
    try {
      const res = await fetch(url, { redirect: 'follow' })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const total = Number(res.headers.get('content-length') || 0)
      let done = 0
      let nextReport = 0
      const out = fs.createWriteStream(dst)
      const reader = res.body.getReader()
      for (;;) {
        const { done: d, value } = await reader.read()
        if (d) break
        done += value.length
        out.write(Buffer.from(value))
        if (onProgress && total && done - nextReport > 2 * 1024 * 1024) {
          nextReport = done
          onProgress(done, total)
        }
      }
      await new Promise((resolve, reject) => {
        out.on('error', reject)
        out.end(resolve)
      })
      if (total && done < total * 0.9) throw new Error('下载不完整（' + done + '/' + total + '）')
      return url
    } catch (e) {
      lastErr = e
      try {
        fs.unlinkSync(dst)
      } catch {}
    }
  }
  throw new Error('所有下载线路均失败：' + (lastErr && lastErr.message))
}

// ---------- 安装 ----------

// unzipViaSystem 用系统自带解压（win: PowerShell Expand-Archive；mac: ditto，保留 .app 权限结构）。
function unzipViaSystem(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true })
  if (process.platform === 'win32') {
    const r = spawnSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      'Expand-Archive', '-LiteralPath', zipPath, '-DestinationPath', destDir, '-Force',
    ], { stdio: 'ignore', timeout: 180000 })
    if (r.status !== 0) throw new Error('解压失败（PowerShell Expand-Archive 退出码 ' + r.status + '）')
    return
  }
  const r = spawnSync('/usr/bin/ditto', ['-x', '-k', zipPath, destDir], { stdio: 'ignore', timeout: 180000 })
  if (r.status !== 0) throw new Error('解压失败（ditto 退出码 ' + r.status + '）')
}

function findExeUnderDir(dir, depth) {
  if (depth < 0 || !dirExists(dir)) return ''
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return ''
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isFile() && e.name.toLowerCase() === 'cc-switch.exe') return p
    if (e.isDirectory() && e.name.endsWith('.app')) {
      const macDir = path.join(p, 'Contents', 'MacOS')
      try {
        for (const f of fs.readdirSync(macDir)) {
          const exe = path.join(macDir, f)
          try {
            fs.accessSync(exe, fs.constants.X_OK)
            return exe
          } catch {}
        }
      } catch {}
    }
  }
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.')) {
      const found = findExeUnderDir(path.join(dir, e.name), depth - 1)
      if (found) return found
    }
  }
  return ''
}

// installCC 下载并安装 cc-switch；返回 exePath。
async function installCC({ home, onStage } = {}) {
  const ver = await fetchLatestVersion()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tiancai-cc-'))
  try {
    let ghURL
    let scanDir
    if (process.platform === 'win32') {
      ghURL = 'https://github.com/' + CC_REPO + '/releases/download/v' + ver + '/CC-Switch-v' + ver + '-Windows-Portable.zip'
      scanDir = path.join(process.env.LOCALAPPDATA || path.join(home || os.homedir(), 'AppData', 'Local'), 'Programs', 'cc-switch')
    } else if (process.platform === 'darwin') {
      ghURL = 'https://github.com/' + CC_REPO + '/releases/download/v' + ver + '/CC-Switch-v' + ver + '-macOS.zip'
      scanDir = '/Applications'
    } else {
      throw new Error('当前平台不支持自动安装 cc-switch，请手动安装后重试')
    }
    const zipPath = path.join(tmp, 'cc-switch.zip')
    if (onStage) onStage('正在下载 cc-switch v' + ver + '（约 13MB）…')
    const via = await downloadWithMirrors(ghURL, zipPath, (done, total) => {
      if (onStage) onStage('正在下载 cc-switch v' + ver + '：' + Math.round((done / total) * 100) + '%')
    })
    if (onStage) onStage('下载完成，正在解压安装…')
    unzipViaSystem(zipPath, process.platform === 'win32' ? scanDir : tmp)
    let exePath
    if (process.platform === 'win32') {
      exePath = findExeUnderDir(scanDir, 3)
    } else {
      // mac：tmp 里找 .app，移动到 /Applications（跨卷时退级 ~/Applications）
      const appBundle = findAppBundleUnderDir(tmp)
      if (!appBundle) throw new Error('安装包内未找到 .app')
      const name = path.basename(appBundle)
      let dest = path.join('/Applications', name)
      try {
        fs.renameSync(appBundle, dest)
      } catch {
        dest = path.join(home || os.homedir(), 'Applications', name)
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.renameSync(appBundle, dest)
      }
      exePath = path.join(dest, 'Contents', 'MacOS', 'cc-switch')
      if (!fileExists(exePath)) exePath = findExeUnderDir(dest, 2)
    }
    if (!exePath) throw new Error('安装后未找到 cc-switch 可执行文件')
    try {
      fs.mkdirSync(ccDir(home), { recursive: true })
      fs.writeFileSync(exeCachePath(home), exePath)
    } catch {}
    return { exePath, version: ver, via }
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {}
  }
}

function findAppBundleUnderDir(dir) {
  if (!dirExists(dir)) return ''
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && e.name.endsWith('.app')) return path.join(dir, e.name)
    }
  } catch {}
  return ''
}

// ---------- 停止与启动 ----------

// mac 进程匹配模式：app 名变体（CC Switch / cc-switch / CCSwitch…，大小写无关）
// 或 bundle 内二进制名（…/MacOS/cc-switch）。
// 背景：GitHub release 装出来的 bundle 真名是 "CC Switch.app"（带空格+大写），
// 旧模式 grep -F 'cc-switch.app/Contents/MacOS' 因此全程检测失明 → stopCC 假通过
// → open -a 撞活进程只触发 Single Instance Callback → mac 上永远无法自动重启（2026-09-26）。
const MAC_PS_PATTERN =
  'cc[-_ ]?switch.*\\.app/Contents/MacOS|\\.app/Contents/MacOS/cc[-_ ]?switch'

// macQuitAppNames osascript quit 的应用名候选：exePath 反推的 bundle 真名优先。
// 真名带空格时 quit app "cc-switch" 会报 -1728（不能获得 application）。
function macQuitAppNames(exePath) {
  const names = []
  if (exePath) {
    const base = path.basename(macAppBundle(exePath))
    if (base && base.endsWith('.app')) names.push(base.slice(0, -'.app'.length))
  }
  for (const n of ['CC Switch', 'cc-switch', 'CC-Switch', 'CCSwitch']) {
    if (!names.includes(n)) names.push(n)
  }
  return names
}

// ccPids 列出 cc-switch 进程 pid（win: tasklist CSV 解析；mac: 大小写无关多变体模式）。
function ccPids() {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq cc-switch.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 10000 })
      return (r.stdout || '')
        .split('\n')
        .map((l) => (l.match(/^"cc-switch\.exe","(\d+)"/i) || [])[1])
        .filter(Boolean)
        .map(Number)
    }
    if (process.platform === 'darwin') {
      const r = spawnSync(
        '/bin/sh',
        ['-c', "ps -axo pid=,command= | grep -iE '" + MAC_PS_PATTERN + "' | grep -v grep | awk '{print $1}'"],
        { encoding: 'utf8', timeout: 10000 }
      )
      return (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean).map(Number)
    }
  } catch {}
  return []
}

// ccRunning 检测 cc-switch 进程是否在跑。
function ccRunning() {
  return ccPids().length > 0
}

// 优雅退出（win: taskkill WM_CLOSE；mac: 按真名 osascript quit + 残留 pid SIGTERM 兜底）
function gracefulQuit(exePath) {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/IM', 'cc-switch.exe'], { stdio: 'ignore', timeout: 10000 })
      return
    }
    if (process.platform === 'darwin') {
      for (const name of macQuitAppNames(exePath)) {
        try {
          spawnSync('/usr/bin/osascript', ['-e', 'quit app "' + name + '"'], { stdio: 'ignore', timeout: 5000 })
        } catch {}
      }
      // 名字失配兜底：对已检出 pid 发 SIGTERM（cc-switch 退出不回写内存态，直写数据保持）
      for (const pid of ccPids()) {
        try { process.kill(pid, 'SIGTERM') } catch {}
      }
    }
  } catch {}
}

// 兜底强杀（mac 按检测模式逐 pid kill -9；win taskkill /F /T）
function forceKill() {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/IM', 'cc-switch.exe', '/F', '/T'], { stdio: 'ignore', timeout: 10000 })
      return
    }
    if (process.platform === 'darwin') {
      for (const pid of ccPids()) {
        try { process.kill(pid, 'SIGKILL') } catch {}
      }
    }
  } catch {}
}

// stopCC 停止 cc-switch：优雅退出 → 轮询确认 → 强杀 → 再确认 → 杀不死抛错。
// 对齐原版 stop_cc（写库前必须死透：活进程持有 SQLite 锁且内存态会无视外部直写，
// 2026-09-26 事故即活进程屏蔽直写导致 UI 无新增配置）。graceful/forceKill/isRunning/zz 可注入测试。
// exePath 用于 mac 侧反推应用真名（如 "CC Switch"）；未运行时跳过优雅退出，
// 避免 osascript quit 对未运行 app「先拉起再退出」的副作用。
async function stopCC({ exePath, isRunning = ccRunning, zz = sleep, graceful = gracefulQuit, force = forceKill } = {}) {
  if (isRunning()) graceful(exePath)
  let deadline = Date.now() + 3000
  while (Date.now() < deadline && isRunning()) await zz(50)
  if (isRunning()) {
    force()
    deadline = Date.now() + 3000
    while (Date.now() < deadline && isRunning()) await zz(50)
  }
  if (isRunning()) {
    throw new Error('cc-switch 进程无法结束（写库期间它会导致配置不可见），请手动退出 cc-switch 后重试')
  }
}

// launchCC 后台启动 cc-switch（detached：tiancaiConfig 退出不影响其本地路由）。
function launchCC(exePath) {
  if (process.platform === 'darwin') {
    const child = spawn('/usr/bin/open', ['-a', macAppBundle(exePath)], { detached: true, stdio: 'ignore' })
    child.unref()
    return
  }
  const child = spawn(exePath, [], { detached: true, stdio: 'ignore', cwd: path.dirname(exePath) })
  child.unref()
}

// ---------- provider TOML（cc-switch 数据库内 config 字段） ----------

function buildProviderToml(relay, defaultModel) {
  const r = String(relay || '').replace(/\/+$/, '')
  return (
    'model_reasoning_effort = "' + DEFAULT_REASONING + '"\n' +
    'model = "' + defaultModel + '"\n' +
    'model_provider = "custom"\n' +
    'review_model = "' + defaultModel + '"\n' +
    'model_context_window = ' + DEFAULT_CONTEXT_WINDOW + '\n' +
    '\n' +
    'sandbox_mode = "workspace-write"\n' +
    'approval_policy = "never"\n' +
    '\n' +
    '[model_providers.custom]\n' +
    'name = "custom"\n' +
    'base_url = "' + r + '/v1"\n' +
    'wire_api = "responses"\n' +
    'env_key = "CODEX_CUSTOM_API_KEY"\n' +
    'requires_openai_auth = false\n' +
    'supports_websockets = false\n'
  )
}

// ---------- SQLite 写入（node:sqlite 内置模块，零原生依赖；自适应列，兼容 cc-switch 升级加列） ----------

function openDB(dbPath) {
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA busy_timeout = 10000')
  return db
}

function tableColumns(db, table) {
  const rows = db.prepare('PRAGMA table_info(' + table + ')').all()
  return rows.map((r) => ({
    name: r.name,
    type: String(r.type || '').toUpperCase(),
    notNull: !!r.notnull,
    hasDefault: r.dflt_value !== null && r.dflt_value !== undefined,
    pk: !!r.pk,
  }))
}

function zeroFor(sqlType) {
  const t = String(sqlType || '').toUpperCase()
  if (t.includes('INT')) return 0
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB') || t.includes('NUM')) return 0.0
  if (t.includes('BLOB')) return Buffer.alloc(0)
  return ''
}

// insertRowAdaptive 自适应 INSERT：自增 PK 不写；有 DEFAULT/可空列省略；NOT NULL 无默认补零值。
function insertRowAdaptive(db, table, values) {
  const cols = tableColumns(db, table)
  const names = []
  const phs = []
  const args = []
  for (const c of cols) {
    const given = Object.prototype.hasOwnProperty.call(values, c.name)
    if (!given) {
      if (c.pk && c.type.includes('INT')) continue
      if (c.hasDefault || !c.notNull) continue
      values[c.name] = zeroFor(c.type) // 补零值后按显式写入处理
    }
    names.push('"' + c.name.replace(/"/g, '""') + '"')
    phs.push('?')
    args.push(values[c.name])
  }
  if (!names.length) throw new Error('表 ' + table + ' 没有可写入的列')
  db.prepare('INSERT INTO "' + table + '" (' + names.join(',') + ') VALUES (' + phs.join(',') + ')').run(...args)
}

function newUUID() {
  return crypto.randomUUID()
}

// ensureEndpoint 保证 provider_endpoints 里有 relay/v1 记录。
function ensureEndpoint(db, pid, relay, nowMs) {
  const url = String(relay).replace(/\/+$/, '') + '/v1'
  const n = db.prepare('SELECT COUNT(*) AS n FROM provider_endpoints WHERE provider_id=? AND url=?').get(pid, url).n
  if (n > 0) return
  insertRowAdaptive(db, 'provider_endpoints', { provider_id: pid, app_type: 'codex', url, added_at: nowMs })
}

// configureProvider 把供应商 + 本地路由开关一次性写入 cc-switch 数据库与 settings.json。
function configureProvider({ home, relay, apiKey, defaultModel, models }) {
  const dbPath = ccDBPath(home)
  fs.mkdirSync(ccDir(home), { recursive: true })
  const db = openDB(dbPath)

  const nowMs = Date.now()
  const catalog = {
    models: (models || []).map((m) => ({ model: m, reasoningLevels: REASONING_LEVELS, defaultReasoningLevel: DEFAULT_REASONING })),
  }

  let result
  db.exec('BEGIN IMMEDIATE')
  try {
    // 表结构自检
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
    for (const t of ['providers', 'proxy_config']) {
      if (!tables.includes(t)) throw new Error('cc-switch 数据库缺少 ' + t + ' 表（版本过旧或损坏），请在 cc-switch 中完成一次初始化后重试')
    }

    const namePlaceholders = [PROVIDER_NAME, ...LEGACY_PROVIDER_NAMES].map(() => '?').join(',')
    const rows = db
      .prepare("SELECT id, settings_config, name FROM providers WHERE app_type='codex' AND name IN (" + namePlaceholders + ') ORDER BY is_current DESC, created_at ASC')
      .all(...[PROVIDER_NAME, ...LEGACY_PROVIDER_NAMES])

    let pid
    let note
    if (rows.length > 0) {
      pid = rows[0].id
      note = '已存在同名供应商，原地更新'
      let cfg = {}
      try {
        cfg = rows[0].settings_config ? JSON.parse(rows[0].settings_config) : {}
      } catch {
        cfg = {}
      }
      const auth = cfg.auth && typeof cfg.auth === 'object' ? cfg.auth : {}
      auth.OPENAI_API_KEY = apiKey
      if (!auth.auth_mode) auth.auth_mode = 'apikey'
      cfg.auth = auth
      const cs = typeof cfg.config === 'string' ? cfg.config : ''
      cfg.config = cs.includes('[model_providers.custom]') ? buildProviderToml(relay, defaultModel) : buildProviderToml(relay, defaultModel)
      cfg.modelCatalog = catalog
      // meta：补 apiFormat（本地路由协议转换必需），其余保留
      let meta = {}
      try {
        const m = db.prepare('SELECT meta FROM providers WHERE id=?').get(pid)
        meta = m && m.meta ? JSON.parse(m.meta) : {}
      } catch {}
      if (!('commonConfigEnabled' in meta)) meta.commonConfigEnabled = false
      if (!('endpointAutoSelect' in meta)) meta.endpointAutoSelect = true
      meta.apiFormat = 'openai_chat'
      db.prepare('UPDATE providers SET settings_config=?, meta=?, is_current=1, name=? WHERE id=?').run(
        JSON.stringify(cfg), JSON.stringify(meta), PROVIDER_NAME, pid
      )
    } else {
      pid = newUUID()
      note = '新建供应商并设为当前'
      const cfg = {
        auth: { OPENAI_API_KEY: apiKey, auth_mode: 'apikey' },
        config: buildProviderToml(relay, defaultModel),
        modelCatalog: catalog,
      }
      const meta = { commonConfigEnabled: false, endpointAutoSelect: true, apiFormat: 'openai_chat' }
      insertRowAdaptive(db, 'providers', {
        id: pid,
        app_type: 'codex',
        name: PROVIDER_NAME,
        settings_config: JSON.stringify(cfg),
        website_url: String(relay).replace(/\/+$/, ''),
        notes: PROVIDER_NAME,
        meta: JSON.stringify(meta),
        is_current: 1,
        in_failover_queue: 0,
        cost_multiplier: '1.0',
      })
    }

    db.prepare("UPDATE providers SET is_current=0 WHERE app_type='codex' AND id<>?").run(pid)
    ensureEndpoint(db, pid, relay, nowMs)

    // 路由服务总开关：全表镜像写（proxy_enabled 从 claude 行读取的 v3.20.x 语义）
    db.prepare("UPDATE proxy_config SET proxy_enabled=1, listen_address='127.0.0.1', listen_port=?").run(CC_PORT)
    db.prepare("UPDATE proxy_config SET enabled=1 WHERE app_type='codex'").run()
    const nCodex = db.prepare("SELECT COUNT(*) AS n FROM proxy_config WHERE app_type='codex'").get().n
    if (!nCodex) {
      insertRowAdaptive(db, 'proxy_config', {
        app_type: 'codex', proxy_enabled: 1, listen_address: '127.0.0.1', listen_port: CC_PORT, enable_logging: 1, enabled: 1,
      })
    }
    const nClaude = db.prepare("SELECT COUNT(*) AS n FROM proxy_config WHERE app_type='claude'").get().n
    if (!nClaude) {
      insertRowAdaptive(db, 'proxy_config', {
        app_type: 'claude', proxy_enabled: 1, listen_address: '127.0.0.1', listen_port: CC_PORT, enable_logging: 1,
      })
    }

    // settings.json 同步（UI「当前供应商」的真正来源）。文件不存在时必须创建：
    // 否则 cc-switch 首次完整启动会「导入 live config 为 default provider」并自建
    // settings.json 把 currentProviderCodex 设为其默认项，新增配置就不会是启用状态。
    let settingsNote
    try {
      writeCurrentProvider(home, pid)
      settingsNote = 'settings.json currentProviderCodex 已同步'
    } catch (e) {
      settingsNote = 'settings.json 更新失败：' + e.message
    }
    result = { providerId: pid, note, settingsNote, models: (models || []).length }
    db.exec('COMMIT')
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch {}
    throw e
  } finally {
    db.close()
  }
  return result
}

// ---------- 自启 ----------

function setAutostart(home, { exePath, enabled, run }) {
  const opts = { valueName: 'cc-switch', exePath, args: [], home, run }
  if (enabled) return enableAutostart(opts)
  return disableAutostart(opts)
}

// ---------- settings.json 当前供应商（UI 判定「启用中」的真正来源） ----------

// readCurrentProvider 读取 settings.json 的 currentProviderCodex（文件缺失/损坏返回 ''）。
function readCurrentProvider(home) {
  try {
    const m = JSON.parse(fs.readFileSync(ccSettingsPath(home), 'utf8'))
    return typeof m.currentProviderCodex === 'string' ? m.currentProviderCodex : ''
  } catch {
    return ''
  }
}

// writeCurrentProvider 把 currentProviderCodex 写入 settings.json（保留其余字段；
// 文件缺失时创建最小配置——cc-switch 对缺失字段按默认值处理，首启自动补全）。
function writeCurrentProvider(home, pid) {
  const sp = ccSettingsPath(home)
  let m = {}
  try {
    m = JSON.parse(fs.readFileSync(sp, 'utf8'))
    if (!m || typeof m !== 'object' || Array.isArray(m)) m = {}
  } catch {
    m = {}
  }
  m.currentProviderCodex = pid
  fs.mkdirSync(path.dirname(sp), { recursive: true })
  const tmp = sp + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n')
  fs.renameSync(tmp, sp)
}

// ---------- 就绪保障 ----------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// schemaReady 探测 providers + proxy_config 两表是否就绪。
// 只等数据库文件出现会撞上「文件已建、迁移/建表未完成」的半初始化库
// （原版工具 step3 等表结构的语义，1:1 保留）。
function schemaReady(dbPath) {
  let db
  try {
    const { DatabaseSync } = require('node:sqlite')
    db = new DatabaseSync(dbPath)
    db.exec('PRAGMA busy_timeout = 300')
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('providers','proxy_config')").all()
    return rows.length >= 2
  } catch {
    return false
  } finally {
    try {
      if (db) db.close()
    } catch {}
  }
}

// ensureReady 保证 cc-switch 就绪可写库，返回 { exePath, installed, initialized }：
//   1) 定位可执行文件，缺则自动下载安装（沿用旧工具 install.go 链路）
//   2) 数据库不存在或表结构不完整 → 先启动 cc-switch 等待完整初始化
//      （providers/proxy_config 两表 + settings.json 生成，沿用原版 step2/step3 语义），再停止进程让出写锁
//   3) 数据库完整 → 停止进程（busy_timeout 兜底并发写）
async function ensureReady({ home, onStage } = {}) {
  const det = detectCC(home)
  let exePath = det.exePath
  const installed = !exePath
  if (!exePath) {
    if (onStage) onStage(det.dbInstalled ? '正在补装 cc-switch…' : '正在下载安装 cc-switch…')
    const inst = await installCC({ home, onStage })
    exePath = inst.exePath
  }
  const fullyReady = () => fileExists(ccDBPath(home)) && schemaReady(ccDBPath(home))
  const waitReady = async (deadlineMs, onTick) => {
    const deadline = Date.now() + deadlineMs
    while (Date.now() < deadline) {
      await sleep(500)
      if (onTick) onTick()
      if (fullyReady()) return true
    }
    return fullyReady()
  }
  let initialized = false
  if (!fullyReady()) {
    if (onStage) onStage('首次初始化 cc-switch（自动生成数据库与配置）…')
    try {
      launchCC(exePath)
    } catch {}
    // 等数据库两表就绪（最长 40s，对齐原版 step3），再给 settings.json 一点生成时间
    const okDB = await waitReady(40000)
    if (!fileExists(ccSettingsPath(home))) {
      const deadline = Date.now() + 15000
      while (Date.now() < deadline && !fileExists(ccSettingsPath(home))) await sleep(500)
    }
    await stopCC({ exePath })
    await sleep(800)
    if (!okDB) {
      throw new Error('cc-switch 未能完成初始化（数据库表结构不完整），请手动打开 cc-switch 一次后重试')
    }
    initialized = true
  } else {
    await stopCC({ exePath })
    await sleep(500)
  }
  return { exePath, installed, initialized }
}

// launchAndEnsureCurrent 启动 cc-switch 并确保 UI「当前供应商」指向本次写入的配置。
// 背景：cc-switch 首次完整启动会「导入 live config 为 default provider」，可能把
// settings.json 的 currentProviderCodex 改写成它的默认项 → 写库时同步的值被覆盖。
// 策略：启动 → 轮询校验 → 不一致则停止进程、改回、再启动（有限次）。
// launchFn/stopFn/verifyFn/sleepFn 可注入测试桩。
async function launchAndEnsureCurrent(exePath, { home, pid, launchFn, stopFn, verifyFn, sleepFn, probes = 10, probeMs = 600, attempts = 2 } = {}) {
  if (!exePath) throw new Error('缺少 cc-switch 可执行文件路径')
  if (!pid) throw new Error('缺少供应商 ID，无法校正当前供应商')
  const launch = launchFn || launchCC
  const stop = stopFn || (() => stopCC({ exePath }))
  const zz = sleepFn || sleep
  const verify = verifyFn || (() => readCurrentProvider(home))
  let last = ''
  const poll = async () => {
    for (let w = 0; w < probes; w++) {
      await zz(probeMs)
      last = verify()
      if (last === pid) return true
    }
    return false
  }
  for (let i = 0; i < attempts; i++) {
    launch(exePath)
    if (await poll()) return i === 0 ? '当前供应商已指向新增配置' : '当前供应商已校正为新增配置'
    // 首启导入等场景改写了当前供应商 → 停止进程改回后重启
    await stop()
    await zz(800)
    writeCurrentProvider(home, pid)
  }
  launch(exePath)
  if (await poll()) return '当前供应商已校正为新增配置'
  throw new Error('cc-switch 启动后当前供应商未能指向新增配置（currentProviderCodex=' + (last || '(空)') + '），请打开 cc-switch 手动切换')
}

module.exports = {
  CC_PORT, CC_REPO, PINNED_VERSION, PROVIDER_NAME, LEGACY_PROVIDER_NAMES, REASONING_LEVELS, DEFAULT_REASONING, DEFAULT_CONTEXT_WINDOW,
  ccDir, ccDBPath, ccSettingsPath, detectCC, locateExe, fetchLatestVersion, installCC,
  MAC_PS_PATTERN, macQuitAppNames, ccPids, ccRunning, stopCC, launchCC,
  buildProviderToml, configureProvider, setAutostart, autostartEnabled,
  insertRowAdaptive, tableColumns, ensureReady, schemaReady,
  readCurrentProvider, writeCurrentProvider, launchAndEnsureCurrent,
}
