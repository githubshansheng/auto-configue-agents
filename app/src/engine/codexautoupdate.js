// Codex（CLI / Desktop 共用 ~/.codex）模型自动更新：
// 触发方式：
//   - macOS：LaunchAgent WatchPaths 监听 ~/.codex/sessions 与 ~/.codex/history.jsonl
//     （Codex CLI / Desktop 每次启动会话都会写入其一 → 触发一次同步）
//   - Windows：计划任务（用户登录触发；Windows 无文件监听等价物）
// 执行体：tiancaiConfig 自身 headless（--autoupdate-codex），零 python3/curl 依赖。
// 同步行为：
//   - gpt-only（直连）：重拉模型列表；默认模型仍可用则保持不变，消失则切到首个 GPT 系；
//     config.toml 无变化时跳过写入（幂等）。
//   - all-models（cc-switch 本地路由）：刷新 cc-switch 供应商模型目录（先停进程再写再拉起）；
//     模型集合无变化时跳过，避免反复重启 cc-switch 打断在途请求。
// 网关来源：主流程写入时记忆于 ~/.tiancaiConfig/gateways.json 的 codex 键（与 workbuddy 记忆同文件合并）；
//          无记忆时回退：config.toml base_url（直连模式）+ auth.json OPENAI_API_KEY。
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { fetchModels, filterNonChat } = require('./modelsapi')
const { buildTOML } = require('./toml')
const codexconfig = require('./codexconfig')
const ccswitch = require('./ccswitch')
const { dataDir } = require('./appdirs')

const LABEL = 'com.tiancaiconfig.codex-models-autoupdate'
// 更名前的标签：注册新标签时顺带清理，避免双代理并存
const LEGACY_LABELS = ['com.triconfig.codex-models-autoupdate']
const TASK_NAME = 'tiancaiConfig Codex ModelUpdate'
const LEGACY_TASK_NAMES = ['TriConfig Codex ModelUpdate']
const LOG_PART = path.join('logs', 'autoupdate-codex.log')
const WATCH_PARTS = [path.join('.codex', 'sessions'), path.join('.codex', 'history.jsonl')]
const GPT_RE = /^gpt/i

function readIfExists(p) {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

function logfileOf(home) {
  return path.join(dataDir(home), LOG_PART)
}
function watchPathsOf(home) {
  const h = home || os.homedir()
  return WATCH_PARTS.map((p) => path.join(h, p))
}
function plistPathOf(home) {
  return path.join(home || os.homedir(), 'Library', 'LaunchAgents', LABEL + '.plist')
}
function gatewayStatePath(home) {
  return path.join(dataDir(home), 'gateways.json')
}

function atomicWrite(p, content) {
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, p)
}

function readGatewayState(home) {
  try {
    return JSON.parse(fs.readFileSync(gatewayStatePath(home), 'utf8')) || {}
  } catch {
    return {}
  }
}

function writeGatewayState(home, state) {
  const p = gatewayStatePath(home)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  atomicWrite(p, JSON.stringify(state, null, 2) + '\n')
}

// rememberGateway 主流程写入 Codex 成功后记录主网关（base 不带 /v1；mode = gpt-only | all-models）。
// 与 workbuddy 记忆同文件合并写入，互不覆盖。
function rememberGateway(home, info) {
  const m = readGatewayState(home)
  m.codex = { base: info.base, apiKey: info.apiKey, mode: info.mode || 'all-models' }
  writeGatewayState(home, m)
}

function rememberLastModelsSig(home, sig) {
  const m = readGatewayState(home)
  if (!m.codex) m.codex = {}
  m.codex.lastModelsSig = sig
  writeGatewayState(home, m)
}

// resolveTarget 反推同步目标：记忆优先（无需 config.toml 存在）；回退 config.toml（直连 base_url）+ auth.json Key。
// 返回 { base, apiKey, mode, curModel } 或 null。
function resolveTarget(home) {
  const { toml, auth } = codexconfig.pathsFor(home)
  const tomlText = readIfExists(toml)
  const mm = tomlText ? tomlText.match(/^model\s*=\s*"([^"]*)"/m) : null
  const curModel = mm ? mm[1] : ''
  const bm = tomlText ? tomlText.match(/base_url\s*=\s*"([^"]*)"/m) : null
  const baseUrlRaw = bm ? bm[1] : ''
  let key = ''
  try {
    key = JSON.parse(readIfExists(auth) || '').OPENAI_API_KEY || ''
  } catch {}
  const mem = readGatewayState(home).codex
  if (mem && mem.base && mem.apiKey) {
    return { base: mem.base, apiKey: mem.apiKey, mode: mem.mode || 'all-models', curModel }
  }
  const isCCRoute = baseUrlRaw.includes(':' + ccswitch.CC_PORT)
  if (!baseUrlRaw || isCCRoute || !key) return null
  return { base: baseUrlRaw.replace(/\/v1\/?$/, ''), apiKey: key, mode: 'gpt-only', curModel }
}

// autoupdateCodexOnce 执行一次静默同步（headless 与测试共用）。opts.fetchImpl/ccswitchApi 可注入桩。
async function autoupdateCodexOnce(home, opts = {}) {
  const doFetch = opts.fetchImpl || fetchModels
  const cc = opts.ccswitchApi || ccswitch
  const tgt = resolveTarget(home)
  if (!tgt) return { ok: false, reason: 'no-gateway', summary: '暂无 Codex 网关信息（无记忆且无法从配置反推），跳过同步' }
  let allIDs
  try {
    allIDs = await doFetch(tgt.base, tgt.apiKey, opts.signal)
  } catch (e) {
    return { ok: false, reason: 'fetch-failed', summary: '拉取模型列表失败：' + e.message }
  }
  const [kept] = filterNonChat(allIDs)
  let pool = kept
  if (tgt.mode === 'gpt-only') pool = kept.filter((id) => GPT_RE.test(id))
  if (!pool.length) return { ok: false, reason: 'empty', summary: '网关未返回可用模型' }
  const def = tgt.curModel && pool.includes(tgt.curModel) ? tgt.curModel : pool[0]

  if (tgt.mode === 'all-models') {
    const sig = pool.join('\n')
    const mem = readGatewayState(home).codex
    if (mem && mem.lastModelsSig === sig) {
      return { ok: true, summary: '模型清单无变化（' + pool.length + ' 个），跳过刷新' }
    }
    try {
      const det = cc.detectCC(home)
      if (!det || !det.installed) {
        return { ok: false, reason: 'no-ccswitch', summary: 'cc-switch 未安装，跳过模型目录刷新' }
      }
      const ready = await cc.ensureReady({ home: home || os.homedir() })
      cc.configureProvider({ home: home || os.homedir(), relay: tgt.base, apiKey: tgt.apiKey, defaultModel: def, models: pool })
      if (ready && ready.exePath) {
        try {
          cc.launchCC(ready.exePath)
        } catch {}
      }
    } catch (e) {
      return { ok: false, reason: 'ccswitch-failed', summary: 'cc-switch 模型目录刷新失败：' + e.message }
    }
    rememberLastModelsSig(home, sig)
    return { ok: true, summary: 'cc-switch 模型目录已刷新（' + pool.length + ' 个，默认 ' + def + '）' }
  }

  // gpt-only：config.toml 幂等重写（base 或默认模型变化才落盘）
  const { toml } = codexconfig.pathsFor(home)
  const cur = readIfExists(toml)
  const next = buildTOML(cur || '', tgt.base, def)
  if (next === cur) return { ok: true, summary: '模型清单无变化，跳过写入' }
  fs.mkdirSync(path.dirname(toml), { recursive: true })
  atomicWrite(toml, next)
  return { ok: true, summary: '默认模型 ' + def + '（可用 ' + pool.length + ' 个，来自 ' + tgt.base + '）' }
}

// ---------- 注册 / 卸载 / 状态 ----------

function buildAutoupdatePlist({ exePath, logFile, watchPaths, label, extraArgs = [] }) {
  const argItems = [exePath, ...extraArgs]
    .map((s) => '    <string>' + s + '</string>')
    .join('\n')
  const watchItems = watchPaths
    .map((s) => '    <string>' + s + '</string>')
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${argItems}
  </array>
  <key>WatchPaths</key>
  <array>
${watchItems}
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

// install 注册 Codex 自动更新。exePath/args = tiancaiConfig 自身启动参数（末位应为 --autoupdate-codex）。
function install(home, { exePath, args = ['--autoupdate-codex'], run } = {}) {
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
    const xml = buildAutoupdatePlist({
      exePath: argv[0],
      logFile: logfileOf(home),
      watchPaths: watchPathsOf(home),
      label: LABEL,
      extraArgs: argv.slice(1),
    })
    const tmp = plist + '.tmp'
    fs.writeFileSync(tmp, xml)
    fs.renameSync(tmp, plist)
    _run('/bin/launchctl', ['load', '-w', plist])
    return '已注册自动更新：Codex 每次启动/会话时自动同步最新模型（LaunchAgent ' + LABEL + '，日志 ' + logfileOf(home) + '）'
  }
  if (process.platform === 'win32') {
    _run('schtasks', buildWinSchtasksArgs(argv))
    return '已注册自动更新：用户登录时自动同步最新 Codex 模型（计划任务 ' + TASK_NAME + '）'
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
    return '已卸载 Codex 自动更新（LaunchAgent）'
  }
  if (process.platform === 'win32') {
    try {
      _run('schtasks', ['delete', '/tn', TASK_NAME, '/f'])
    } catch {}
    return '已卸载 Codex 自动更新（计划任务）'
  }
  throw new Error('当前平台暂不支持自动更新卸载')
}

function status(home) {
  if (process.platform === 'darwin') {
    const p = plistPathOf(home)
    const installed = fs.existsSync(p)
    return { installed, detail: installed ? '已安装（' + p + '，监听 ' + watchPathsOf(home).join('、') + '）' : '未安装' }
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
  LABEL, TASK_NAME, LEGACY_LABELS, LEGACY_TASK_NAMES,
  rememberGateway, resolveTarget, autoupdateCodexOnce,
  buildAutoupdatePlist, buildWinSchtasksArgs,
  plistPathOf, watchPathsOf, logfileOf, gatewayStatePath,
  install, uninstall, status,
}
