// Codex CLI / Codex Desktop 共享配置（~/.codex）的探测、计划、写入与校验。
// 从 Go 引擎 1:1 移植；两者共用同一套配置文件，故本模块被两个目标复用。
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { buildTOML, hasProviderBlock, lineDiff } = require('./toml')
const backup = require('./backup')

function pathsFor(home) {
  const dir = path.join(home, '.codex')
  return { dir, toml: path.join(dir, 'config.toml'), auth: path.join(dir, 'auth.json') }
}

function readIfExists(p) {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

// desktopCandidates 各平台桌面版候选安装路径。
function desktopCandidates(home) {
  if (process.platform === 'darwin') {
    return [
      '/Applications/Codex.app',
      '/Applications/ChatGPT.app',
      path.join(home, 'Applications', 'Codex.app'),
      path.join(home, 'Applications', 'ChatGPT.app'),
    ]
  }
  if (process.platform === 'win32') {
    const ld = process.env.LOCALAPPDATA || ''
    return [
      path.join(ld, 'Programs', 'Codex'),
      path.join(ld, 'Programs', 'ChatGPT'),
      path.join(ld, 'OpenAI', 'Codex'),
      path.join(ld, 'OpenAI', 'ChatGPT'),
      path.join(home, 'Applications', 'Codex-GPT56-Patched'),
    ]
  }
  return [path.join(home, '.local', 'opt', 'codex-gpt56-patched')]
}

function desktopAppPath(home) {
  for (const p of desktopCandidates(home)) {
    try {
      if (fs.statSync(p).isDirectory()) return p
    } catch {}
  }
  return ''
}

// detect 生成探测结果。desktop=true 时附带桌面版安装详情。
function detect(home, desktop) {
  const { toml, auth } = pathsFor(home)
  const tomlExists = readIfExists(toml) !== null
  const authExists = readIfExists(auth) !== null
  const installed = tomlExists || authExists
  const existing = readIfExists(toml) || ''
  const configured = hasProviderBlock(existing)

  let detail
  if (desktop) {
    const app = desktopAppPath(home)
    detail = app
      ? '已检测到桌面版：' + app
      : '未检测到桌面版安装目录；Codex Desktop 与 CLI 共用 ~/.codex 配置，写入依然有效'
  } else {
    detail = installed ? '已检测到 Codex 配置目录 ~/.codex' : '未检测到 ~/.codex，首次写入将自动创建'
  }
  if (configured) detail += '；已包含本工具写入的供应商配置'
  return { installed, configured, detail, paths: [toml, auth] }
}

// mergeAuthJSON 保留 auth.json 其他字段，仅更新 OPENAI_API_KEY 与 auth_mode。
function mergeAuthJSON(existing, key) {
  let m = {}
  if (existing && existing.trim()) {
    try {
      m = JSON.parse(existing)
    } catch {
      m = {}
    }
  }
  m.OPENAI_API_KEY = key
  m.auth_mode = 'apikey'
  return JSON.stringify(m, null, 2)
}

function atomicWrite(p, content) {
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, p)
}

// plan 生成写入计划（不落盘）。
function plan(home, cfg) {
  const { toml, auth } = pathsFor(home)
  const out = []
  const existing = readIfExists(toml)
  const existed = existing !== null
  const newTOML = buildTOML(existing || '', cfg.baseUrl, cfg.defaultModel)
  let sum = '写入供应商 tiancaiconfig（base_url=' + cfg.baseUrl + '/v1），默认模型 ' + cfg.defaultModel
  if (!existed) sum = '创建 ' + toml + '；' + sum
  out.push({ file: toml, summary: sum, diff: lineDiff(existing || '', newTOML, 40) })

  const existingAuth = readIfExists(auth)
  const authExisted = existingAuth !== null
  const newAuth = mergeAuthJSON(existingAuth, cfg.apiKey)
  let sumAuth = '写入 OPENAI_API_KEY（sk-**** 脱敏显示）与 auth_mode=apikey'
  if (!authExisted) sumAuth = '创建 ' + auth + '；' + sumAuth
  out.push({ file: auth, summary: sumAuth, diff: lineDiff(existingAuth || '', newAuth, 20) })
  return out
}

// configure 执行写入（调用方需先备份）。opts.persistEnv 可注入测试桩。
function configure(home, cfg, opts = {}) {
  const { dir, toml, auth } = pathsFor(home)
  fs.mkdirSync(dir, { recursive: true })
  const changes = []
  const existing = readIfExists(toml) || ''
  atomicWrite(toml, buildTOML(existing, cfg.baseUrl, cfg.defaultModel))
  changes.push({ file: toml, summary: 'config.toml 已写入' })

  const existingAuth = readIfExists(auth) || ''
  atomicWrite(auth, mergeAuthJSON(existingAuth, cfg.apiKey))
  changes.push({ file: auth, summary: 'auth.json 已写入' })

  if (opts.persistEnv) {
    try {
      const msg = opts.persistEnv(cfg.apiKey)
      changes.push({ file: '环境变量 TIANCAICONFIG_API_KEY', summary: msg })
    } catch (e) {
      changes.push({ file: '环境变量 TIANCAICONFIG_API_KEY', summary: '设置失败：' + e.message + '（配置文件仍已写入，如启动报缺 env 可手动设置）' })
    }
  }
  return changes
}

// verify 写后校验：TOML 含供应商块、base_url 一致、auth.json 含 Key。
function verify(home, cfg) {
  const { toml, auth } = pathsFor(home)
  const existing = readIfExists(toml)
  if (existing === null || !hasProviderBlock(existing)) {
    return { ok: false, message: 'config.toml 未包含供应商配置' }
  }
  if (!existing.includes('base_url = "' + cfg.baseUrl + '/v1"')) {
    return { ok: false, message: 'config.toml 中 base_url 与预期不一致' }
  }
  const authText = readIfExists(auth)
  if (authText === null) return { ok: false, message: 'auth.json 不存在' }
  let m
  try {
    m = JSON.parse(authText)
  } catch {
    return { ok: false, message: 'auth.json 不是合法 JSON' }
  }
  if (m.OPENAI_API_KEY !== cfg.apiKey) {
    return { ok: false, message: 'auth.json 中密钥与输入不一致' }
  }
  return { ok: true, message: 'config.toml + auth.json 校验通过（默认模型 ' + cfg.defaultModel + '）' }
}

// rollback 依据备份凭证还原。
function rollback(receipt) {
  backup.restore(receipt.dir)
}

// persistEnvDefault 环境变量持久化（darwin: launchctl + zshenv；win32: 用户级 reg）。
function persistEnvDefault(key) {
  if (process.platform === 'darwin') {
    const { execFileSync } = require('node:child_process')
    try {
      execFileSync('launchctl', ['setenv', 'TIANCAICONFIG_API_KEY', key])
    } catch {}
    const zshenv = path.join(os.homedir(), '.zshenv')
    const line = 'export TIANCAICONFIG_API_KEY=' + JSON.stringify(key)
    let existing = ''
    try {
      existing = fs.readFileSync(zshenv, 'utf8')
    } catch {}
    if (existing.split('\n').includes(line)) {
      return '环境变量已存在于 ~/.zshenv（当前会话已通过 launchctl 设置）'
    }
    if (existing && !existing.endsWith('\n')) existing += '\n'
    // 清理更名前的旧标记块（# added by TriConfig / TRICONFIG_API_KEY），避免残留双份导出
    const cleaned = existing
      .split('\n')
      .filter((l) => !l.includes('# added by TriConfig') && !/^export TRICONFIG_API_KEY=/.test(l.trim()))
      .join('\n')
    fs.writeFileSync(zshenv, cleaned + '# added by tiancaiConfig\n' + line + '\n')
    return '已写入 ~/.zshenv 并设置当前图形会话（重启终端与桌面版后生效）'
  }
  if (process.platform === 'win32') {
    const { execFileSync } = require('node:child_process')
    if ((process.env.TIANCAICONFIG_API_KEY || '').trim() === key.trim()) {
      return '用户级环境变量已是最新（新进程生效）'
    }
    execFileSync('reg', ['add', 'HKCU\\Environment', '/v', 'TIANCAICONFIG_API_KEY', '/t', 'REG_SZ', '/d', key, '/f'])
    return '已写入用户级环境变量（新进程生效）'
  }
  throw new Error('当前平台暂不支持自动持久化环境变量，请手动设置 TIANCAICONFIG_API_KEY')
}

module.exports = { pathsFor, detect, plan, configure, verify, rollback, mergeAuthJSON, persistEnvDefault, desktopAppPath }
