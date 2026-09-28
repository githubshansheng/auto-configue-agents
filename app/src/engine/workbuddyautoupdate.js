// WorkBuddy 模型自动更新（能力移植自 workbuddy-model/workbuddy_autoupdate_models.sh，
// 并做了两处体验增强）：
//   1. Key 无需单独缓存文件：从现有 models.json 的本网关条目反推 base+apiKey
//      （旧脚本要求 ~/.workbuddy/.heigh-vip-apikey 缓存，忘填则静默失效）
//   2. 执行体零依赖：LaunchAgent/计划任务直接调 tiancaiConfig 自身（--autoupdate-workbuddy
//      headless 模式），不依赖 python3/curl
// 触发方式沿用旧脚本：
//   - macOS：LaunchAgent WatchPaths 监听 ~/.workbuddy/last-launch.json
//     （WorkBuddy 每次启动都会触碰该文件 → 触发一次同步）
//   - Windows：计划任务（用户登录触发；Windows 无文件监听等价物）
// 幂等：按 id 去重覆盖；保留非本网关手工条目；白名单与主流程同源。
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const { fetchModels, filterNonChat } = require('./modelsapi')
const workbuddy = require('./workbuddy')
const { dataDir } = require('./appdirs')

const LABEL = 'com.tiancaiconfig.workbuddy-models-autoupdate'
// 更名前的标签：注册新标签时顺带清理，避免双代理并存
const LEGACY_LABELS = ['com.triconfig.workbuddy-models-autoupdate']
const TASK_NAME = 'tiancaiConfig WorkBuddy ModelUpdate'
const LEGACY_TASK_NAMES = ['TriConfig WorkBuddy ModelUpdate']
const LOGFILE_PART = path.join('.workbuddy', 'logs', 'autoupdate-models.log')
const WATCH_PART = path.join('.workbuddy', 'last-launch.json')
const URL_SUFFIX = '/v1/chat/completions'

function logfileOf(home) {
  return path.join(home || os.homedir(), LOGFILE_PART)
}
function watchFileOf(home) {
  return path.join(home || os.homedir(), WATCH_PART)
}
function plistPathOf(home) {
  return path.join(home || os.homedir(), 'Library', 'LaunchAgents', LABEL + '.plist')
}
function gatewayStatePath(home) {
  return path.join(dataDir(home), 'gateways.json')
}

// rememberGateway 主流程写入 WorkBuddy 成功后记录本网关 base（自动更新时优先读取，
// 避免多个网关条目并存时误判主网关——旧脚本靠硬编码 base 免疫此问题，tiancaiConfig 用记忆机制等效替代）。
function rememberGateway(home, base) {
  const p = gatewayStatePath(home)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  let m = {}
  try {
    m = JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {}
  m.workbuddy = base
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n')
  fs.renameSync(tmp, p)
}

// detectGateway 从 models.json 反推本网关的 base+apiKey。
// 优先级：① gateways.json 记忆（主流程写入时记录，最可靠）；
//        ② 回退：按网关分组取条目数最多的组（旧脚本写入场景几乎总是单一网关，多数派即正确）。
function detectGateway(home) {
  let entries
  try {
    entries = workbuddy.loadEntries(workbuddy.modelsPath(home))
  } catch {
    return null
  }
  const groups = new Map() // base -> { apiKey, count }
  for (const e of entries || []) {
    if (!e || typeof e !== 'object') continue
    const u = typeof e.url === 'string' ? e.url : ''
    const k = typeof e.apiKey === 'string' ? e.apiKey : ''
    if (!u.endsWith(URL_SUFFIX) || !k) continue
    const base = u.slice(0, -URL_SUFFIX.length)
    if (!groups.has(base)) groups.set(base, { apiKey: k, count: 0 })
    groups.get(base).count++
  }
  if (!groups.size) return null
  let remembered = ''
  try {
    remembered = JSON.parse(fs.readFileSync(gatewayStatePath(home), 'utf8')).workbuddy || ''
  } catch {}
  if (remembered && groups.has(remembered)) {
    return { base: remembered, apiKey: groups.get(remembered).apiKey }
  }
  let best = null
  for (const [base, g] of groups) {
    if (!best || g.count > best.g.count) best = { base, g }
  }
  return { base: best.base, apiKey: best.g.apiKey }
}

// autoupdateOnce 执行一次静默同步（headless 模式与测试共用）。
// opts.fetchImpl 可注入桩；返回 { ok, summary, reason? }。
async function autoupdateOnce(home, opts = {}) {
  const doFetch = opts.fetchImpl || fetchModels
  const gw = detectGateway(home)
  if (!gw) return { ok: false, reason: 'no-gateway', summary: 'models.json 中暂无本网关条目，跳过同步' }
  let allIDs
  try {
    allIDs = await doFetch(gw.base, gw.apiKey, opts.signal)
  } catch (e) {
    return { ok: false, reason: 'fetch-failed', summary: '拉取模型列表失败：' + e.message }
  }
  const [kept] = filterNonChat(allIDs)
  if (!kept.length) return { ok: false, reason: 'empty', summary: '网关未返回可对话模型' }
  const p = workbuddy.modelsPath(home)
  let list
  try {
    list = workbuddy.loadEntries(p)
  } catch {
    return { ok: false, reason: 'unreadable', summary: 'models.json 无法解析，为安全起见不自动覆盖' }
  }
  const cfg = { baseUrl: gw.base, apiKey: gw.apiKey, models: kept.map((id) => ({ id })) }
  const { list: merged, summary } = workbuddy.merge(list, cfg)
  workbuddy.atomicWrite(p, JSON.stringify(merged, null, 2) + '\n')
  if (process.platform === 'darwin' || process.platform === 'win32') {
    try {
      fs.chmodSync(p, 0o600) // 与旧脚本同源：包含 Key 的文件收紧权限
    } catch {}
  }
  return { ok: true, summary: summary + '（来自 ' + gw.base + '）' }
}

// ---------- 注册 / 卸载 / 状态 ----------

function buildAutoupdatePlist({ exePath, logFile, watchFile, label }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${exePath}</string>
    <string>--autoupdate-workbuddy</string>
  </array>
  <key>WatchPaths</key>
  <array>
    <string>${watchFile}</string>
  </array>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${logFile}</string>
  <key>StandardErrorPath</key>
  <string>${logFile}</string>
</dict>
</plist>
`
}

function buildWinSchtasksArgs(argv) {
  // /tr 值格式："exePath" --autoupdate-workbuddy（含空格路径自动加引号）
  const cmd = argv.map((a, i) => (i === 0 || / /.test(a) ? '"' + a + '"' : a)).join(' ')
  return ['create', '/tn', TASK_NAME, '/tr', cmd, '/sc', 'onlogon', '/f']
}

function defaultRun(file, args) {
  const { execFileSync } = require('node:child_process')
  execFileSync(file, args, { stdio: 'ignore' })
}

// removeLegacyRegistration 清理更名前遗留的 LaunchAgent / 计划任务（尽力而为，失败忽略）。
function removeLegacyRegistration(home, _run) {
  if (process.platform === 'darwin') {
    for (const old of LEGACY_LABELS) {
      const p = path.join(home || os.homedir(), 'Library', 'LaunchAgents', old + '.plist')
      try {
        _run('/bin/launchctl', ['unload', '-w', p])
      } catch {}
      try {
        fs.unlinkSync(p)
      } catch {}
    }
  }
  if (process.platform === 'win32') {
    for (const old of LEGACY_TASK_NAMES) {
      try {
        _run('schtasks', ['delete', '/tn', old, '/f'])
      } catch {}
    }
  }
}

// install 注册自动更新。exePath/args = tiancaiConfig 自身启动参数
// （打包态 [exe, --autoupdate-workbuddy]；dev 态 [electron, appDir, --autoupdate-workbuddy]）。
function install(home, { exePath, args = ['--autoupdate-workbuddy'], run } = {}) {
  const _run = run || defaultRun
  if (!exePath) throw new Error('缺少 tiancaiConfig 可执行文件路径，无法注册自动更新')
  removeLegacyRegistration(home, _run)
  const argv = [exePath, ...(args || [])]
  if (process.platform === 'darwin') {
    const plist = plistPathOf(home)
    fs.mkdirSync(path.dirname(plist), { recursive: true })
    try {
      _run('/bin/launchctl', ['unload', '-w', plist])
    } catch {}
    const extraItems = argv
      .slice(1)
      .map((s) => '    <string>' + s + '</string>')
      .join('\n')
    const xml = buildAutoupdatePlist({ exePath: argv[0], logFile: logfileOf(home), watchFile: watchFileOf(home), label: LABEL }).replace(
      '  </array>\n  <key>WatchPaths</key>',
      extraItems + '\n  </array>\n  <key>WatchPaths</key>'
    )
    const tmp = plist + '.tmp'
    fs.writeFileSync(tmp, xml)
    fs.renameSync(tmp, plist)
    _run('/bin/launchctl', ['load', '-w', plist])
    return '已注册自动更新：WorkBuddy 每次启动时自动同步最新模型（LaunchAgent ' + LABEL + '，日志 ' + logfileOf(home) + '）'
  }
  if (process.platform === 'win32') {
    _run('schtasks', buildWinSchtasksArgs(argv))
    return '已注册自动更新：用户登录时自动同步最新模型（计划任务 ' + TASK_NAME + '）'
  }
  throw new Error('当前平台暂不支持自动更新注册')
}

function uninstall(home, { run } = {}) {
  const _run = run || defaultRun
  if (process.platform === 'darwin') {
    const plist = plistPathOf(home)
    try {
      _run('/bin/launchctl', ['unload', '-w', plist])
    } catch {}
    try {
      fs.unlinkSync(plist)
    } catch {}
    return '已卸载自动更新（LaunchAgent）'
  }
  if (process.platform === 'win32') {
    try {
      _run('schtasks', ['delete', '/tn', TASK_NAME, '/f'])
    } catch {}
    return '已卸载自动更新（计划任务）'
  }
  throw new Error('当前平台暂不支持自动更新卸载')
}

function status(home) {
  if (process.platform === 'darwin') {
    const p = plistPathOf(home)
    const installed = fs.existsSync(p)
    return { installed, detail: installed ? '已安装（' + p + '，监听 ' + watchFileOf(home) + '）' : '未安装' }
  }
  if (process.platform === 'win32') {
    try {
      defaultRun('schtasks', ['query', '/tn', TASK_NAME])
      return { installed: true, detail: '已安装（计划任务 ' + TASK_NAME + '）' }
    } catch {
      return { installed: false, detail: '未安装' }
    }
  }
  return { installed: false, detail: '当前平台不支持' }
}

module.exports = {
  LABEL, TASK_NAME, LEGACY_LABELS, LEGACY_TASK_NAMES, URL_SUFFIX,
  detectGateway, rememberGateway, autoupdateOnce,
  buildAutoupdatePlist, buildWinSchtasksArgs,
  plistPathOf, watchFileOf, logfileOf, gatewayStatePath,
  install, uninstall, status,
}
