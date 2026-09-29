// Hermes Agent 目标：~/.hermes/config.yaml 原位编辑（model: 段四字段）。
// 设计约定（2026-09-29 用户定规）：hermes 是 chat/completions 兼容客户端，
// 直连第三方 API（中转站 base_url + api_key 直写 config）——绝不指向
// cc-switch 本地路由（127.0.0.1:15721），也不依赖 cc-switch 模型目录；
// 一键配置流程中 cc-switch 阶段仅由 Codex 目标触发（oneclick.codexSelected）。
// 直连中转站（OpenAI 兼容）：provider="custom" + base_url + api_key + default 模型。
// 关键约束：config.yaml 是 hermes 的完整主配置（500+ 行注释 + 用户自定义段），
// 绝不能整文件重写——只做行级原位替换，注释与其他段一字不动。
// 鉴权说明：key 直接写入 model.api_key（hermes 官方注释支持的用法）；
// 不用 env_key 类机制，GUI/网关/CLI 三种启动方式都从 config.yaml 读到。
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const backupEngine = require('./backup')

function configPath(home) {
  return path.join(home, '.hermes', 'config.yaml')
}

// resolveCli 定位 hermes 可执行：~/.local/bin/hermes（官方安装器布局）→
// ~/.hermes/hermes-agent/.hermes/bin/hermes（仓库布局）→ PATH。
function resolveCli(home) {
  const candidates = [
    path.join(home, '.local', 'bin', 'hermes'),
    path.join(home, '.hermes', 'hermes-agent', '.hermes', 'bin', 'hermes'),
  ]
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK)
      return c
    } catch {}
  }
  const r = spawnSync('sh', ['-c', 'command -v hermes'], { encoding: 'utf8', timeout: 5000 })
  const p = (r.stdout || '').trim()
  return p || ''
}

// normalizeBase 与中转站其他写入点同规则：去尾斜杠，拼 /v1。
function normalizeBase(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '') + '/v1'
}

// yamlQuote 输出 YAML 双引号字符串（反斜杠与双引号转义）。
function yamlQuote(v) {
  return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

// 编辑计划：model 段内需生效的四字段目标值。
function editPlan(cfg) {
  return {
    default: yamlQuote(cfg.defaultModel || ''),
    provider: '"custom"',
    base_url: yamlQuote(normalizeBase(cfg.baseUrl)),
    api_key: yamlQuote(cfg.apiKey || ''),
  }
}

// loadModelSection 解析 config.yaml 中第一个顶格 model: 段的行号范围 [start, end)。
// 返回 null 表示找不到 model: 顶层键（config 结构异常，拒绝盲写）。
function loadModelSection(lines) {
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === 'model:') {
      start = i
      break
    }
  }
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]
    if (l.trim() === '' || l.startsWith(' ') || l.startsWith('\t') || l.startsWith('#')) continue
    end = i // 下一个顶格键 → 段结束
    break
  }
  return { start, end }
}

// applyEdits 对行数组原位应用 model 段四字段。返回 { lines, changed: [...], missing: [...] }。
// 只动段内「未注释的目标键行」；api_key 若无未注释行则插到 provider 行之后。
function applyEdits(lines, plan) {
  const sec = loadModelSection(lines)
  if (!sec) throw new Error('config.yaml 中未找到顶层 model: 段（结构异常，拒绝盲写）')
  const out = lines.slice()
  const changed = []
  const wanted = ['default', 'provider', 'base_url', 'api_key']
  let providerLine = -1
  for (let i = sec.start + 1; i < sec.end; i++) {
    const m = out[i].match(/^(\s*)(#?\s*)([A-Za-z_]+)(\s*:)/)
    if (!m) continue
    const key = m[3]
    if (!wanted.includes(key)) continue
    if (m[2].includes('#')) continue // 注释行不作为替换目标
    if (out[i].includes(key + ':') && !out[i].trimStart().startsWith('#')) {
      if (key === 'api_key') {
        changed.push('api_key')
        out[i] = m[1] + 'api_key: ' + plan.api_key
        continue
      }
      changed.push(key)
      out[i] = m[1] + key + ': ' + plan[key]
      if (key === 'provider') providerLine = i
    }
  }
  // api_key 无未注释行 → 插到 provider 行后（provider 行自身也可能刚替换过）
  if (!changed.includes('api_key')) {
    if (providerLine === -1) {
      // 段内无未注释 provider 行（异常但可救）：插到段首 default 之后或段首
      let at = sec.start + 1
      if (changed.includes('default')) at = out.findIndex((l, i) => i > sec.start && l.match(/^\s+default:/)) + 1
      out.splice(at, 0, '  api_key: ' + plan.api_key)
    } else {
      out.splice(providerLine + 1, 0, '  api_key: ' + plan.api_key)
    }
    changed.push('api_key')
  }
  const missing = wanted.filter((k) => !changed.includes(k))
  return { lines: out, changed, missing }
}

// parseModelFields 只读解析 model 段生效字段（detect/verify 共用）。
function parseModelFields(lines) {
  const sec = loadModelSection(lines)
  if (!sec) return null
  const fields = {}
  for (let i = sec.start + 1; i < sec.end; i++) {
    const m = lines[i].match(/^\s+([A-Za-z_]+)\s*:\s*(.*)$/)
    if (!m || lines[i].trimStart().startsWith('#')) continue
    if (['default', 'provider', 'base_url', 'api_key'].includes(m[1])) {
      fields[m[1]] = (m[2] || '').replace(/^"(.*)"$/, '$1').trim()
    }
  }
  return fields
}

function readLines(p) {
  return fs.readFileSync(p, 'utf8').split('\n')
}

function atomicWrite(p, lines) {
  const tmp = p + '.tmp-tiancai'
  fs.writeFileSync(tmp, lines.join('\n'))
  fs.renameSync(tmp, p)
}

function detect(home) {
  const p = configPath(home)
  const cli = resolveCli(home)
  const result = { installed: false, configured: false, detail: '', paths: [p] }
  if (!fs.existsSync(p)) {
    result.detail = '未检测到 ~/.hermes/config.yaml（未安装 Hermes 或尚未初始化）'
    return result
  }
  result.installed = true
  if (!cli) {
    result.detail = '检测到 config.yaml，但未找到 hermes 命令（配置仍可写入，端到端测试将跳过）'
    return result
  }
  let fields
  try {
    fields = parseModelFields(readLines(p))
  } catch (e) {
    result.detail = 'config.yaml 存在但无法解析（' + e.message + '），写入前会自动备份'
    return result
  }
  if (fields && fields.provider === 'custom') {
    result.configured = true
    result.detail = '已配置 custom 中转（' + (fields.base_url || '?') + '，默认模型 ' + (fields.default || '?') + '）'
  } else {
    result.detail = '已安装 Hermes（当前 provider: ' + ((fields && fields.provider) || '?') + '，配置后将直连中转站）'
  }
  return result
}

function plan(home, cfg) {
  const p = configPath(home)
  const planMap = editPlan(cfg)
  let old = {}
  try {
    old = parseModelFields(readLines(p)) || {}
  } catch {
    old = {}
  }
  const items = ['default', 'provider', 'base_url', 'api_key'].map((k) => {
    const ov = k === 'api_key' && old[k] ? old[k].slice(0, 6) + '***' : old[k] || '（未设置）'
    const nv = k === 'api_key' ? (cfg.apiKey || '').slice(0, 6) + '***' : planMap[k].replace(/^"|"$/g, '')
    return { key: k, from: ov, to: nv }
  })
  const summary = '原位更新 model 段：' + items.map((i) => i.key + ' ' + i.from + ' → ' + i.to).join('；')
  return [{ file: p, summary, diff: items }]
}

function backup(home) {
  const p = configPath(home)
  const { dir } = backupEngine.snapshot(home, 'hermes', [p])
  return { dir, files: [p] }
}

// restartGatewayIfRunning 改配置后让常驻 gateway（消息桥）加载新配置。
// 只在 gateway 确实在运行（gateway.pid 存在）时才重启；失败不阻塞配置主流程
// （gateway 非必装组件）。绝不能对未运行的 gateway 盲调 restart——既有副作用
// 又可能挂住（2026-09-29 单测 4 分钟超时的教训）。
function restartGatewayIfRunning(home, cli) {
  const pidFile = path.join(home, '.hermes', 'gateway.pid')
  if (!fs.existsSync(pidFile)) return '（gateway 未在运行，跳过重启）'
  if (!cli) return '（未找到 hermes 命令，跳过 gateway 重启）'
  try {
    const r = spawnSync(cli, ['gateway', 'restart'], { encoding: 'utf8', timeout: 45000, stdio: 'ignore' })
    return r.status === 0 ? 'gateway 已重启加载新配置' : 'gateway 重启未成功（非致命，status=' + r.status + '）'
  } catch {
    return 'gateway 重启超时/异常（非致命，已忽略）'
  }
}

function configure(home, cfg) {
  const p = configPath(home)
  if (!fs.existsSync(p)) throw new Error('未找到 ' + p + '，请先安装并初始化 Hermes（运行一次 hermes chat）')
  const lines = readLines(p)
  const before = lines.join('\n')
  const { lines: out, changed, missing } = applyEdits(lines, editPlan(cfg))
  if (missing.length === 4) throw new Error('model 段无可编辑字段（config 结构异常）')
  const after = out.join('\n')
  if (before !== after) atomicWrite(p, out)
  const gw = restartGatewayIfRunning(home, resolveCli(home))
  return [
    {
      file: p,
      summary: 'model 段已更新（' + changed.join('/') + '）；' + gw,
    },
  ]
}

// verify 两层：①读回断言四字段与计划一致；②端到端 hermes -z "hi" 真实调用。
// runProbe 可注入（测试桩 / 未来无 CLI 环境跳过）。
function verify(home, cfg, opts = {}) {
  const p = configPath(home)
  let fields
  try {
    fields = parseModelFields(readLines(p))
  } catch (e) {
    return { ok: false, message: 'config.yaml 无法解析：' + e.message }
  }
  if (!fields) return { ok: false, message: 'config.yaml 中未找到 model: 段' }
  const want = editPlan(cfg)
  for (const k of ['default', 'provider', 'base_url']) {
    if (fields[k] !== want[k].replace(/^"|"$/g, '')) {
      return { ok: false, message: k + ' 不一致：期望 ' + want[k] + '，实际 ' + (fields[k] || '（空）') }
    }
  }
  if (!fields.api_key) return { ok: false, message: 'api_key 未写入' }
  if (opts.runProbe) {
    const pr = opts.runProbe(home, cfg)
    if (!pr.ok) return pr
    return { ok: true, message: '校验通过（配置一致 + 端到端调用成功：' + pr.detail + '）' }
  }
  const cli = resolveCli(home)
  if (!cli) return { ok: true, message: '校验通过（配置一致；未找到 hermes 命令，跳过端到端调用）' }
  let r
  try {
    r = spawnSync(cli, ['-z', 'hi'], { encoding: 'utf8', timeout: 90000, cwd: home })
  } catch {
    return { ok: false, message: '端到端调用超时（90s），请检查中转站连通性' }
  }
  const outAll = ((r.stdout || '') + '\n' + (r.stderr || '')).trim()
  if (/agent failed|not connected|Missing environment/i.test(outAll)) {
    return { ok: false, message: '端到端调用失败：' + outAll.split('\n').slice(-2).join(' ').slice(0, 300) }
  }
  if (!outAll) return { ok: false, message: '端到端调用无输出（exit=' + r.status + '）' }
  return { ok: true, message: '校验通过（配置一致 + hermes 实际调用成功，exit=' + r.status + '）' }
}

function rollback(receipt) {
  backupEngine.restore(receipt.dir)
}

module.exports = {
  configPath,
  resolveCli,
  normalizeBase,
  loadModelSection,
  applyEdits,
  parseModelFields,
  editPlan,
  detect,
  plan,
  backup,
  configure,
  verify,
  rollback,
  restartGatewayIfRunning,
}
