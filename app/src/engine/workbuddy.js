// WorkBuddy 桌面端目标：~/.workbuddy/models.json 批量写入。
// 条目 schema 与官方引擎读取字段严格对齐（沿用旧配置脚本实战验证的字段名）。
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const backupEngine = require('./backup')
const { whitelistMatch } = require('./modelsapi')

function modelsPath(home) {
  return path.join(home, '.workbuddy', 'models.json')
}

// 官方输出上限映射（与旧脚本同源；未知模型兜底 131072）。
const OUTPUT_CAPS = {
  'deepseek-v4-pro': 393216,
  'deepseek-v4.1-flash': 393216,
  'gemini-3.6-flash': 65536,
  'gemini-3.7-flash': 65536,
  'glm-5.3': 131072,
  'glm-5.3-flash': 131072,
  'grok-4.6': 131072,
  'grok-4.7': 131072,
  'minimax-m3': 131072,
}

function outCap(mid) {
  if (OUTPUT_CAPS[mid] != null) return OUTPUT_CAPS[mid]
  const l = String(mid).toLowerCase()
  if (l.includes('embedding') || l.includes('image')) return 8192
  if (l.startsWith('gpt-') || l.includes('codex')) return 128000
  if (l.includes('deepseek')) return 393216
  if (l.includes('gemini')) return 65536
  return 131072
}

const ALL_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

function makeEntry(mid, cfg) {
  return {
    id: mid,
    name: mid,
    url: cfg.baseUrl + '/v1/chat/completions',
    apiKey: cfg.apiKey,
    maxInputTokens: 300000,
    maxOutputTokens: outCap(mid),
    supportsToolCall: true,
    supportsImages: true,
    supportsReasoning: true,
    reasoning_effort: 'xhigh',
    reasoning: {
      supportedEfforts: ALL_EFFORTS.slice(),
      defaultEffort: 'xhigh',
      effort: 'xhigh',
      canDisableThinking: false,
    },
  }
}

// loadEntries 读取 models.json（兼容裸数组与 {"models":[...]} 两种结构，统一为数组）。
function loadEntries(p) {
  let raw
  try {
    raw = fs.readFileSync(p, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
  raw = raw.trim()
  if (!raw) return []
  let probe
  try {
    probe = JSON.parse(raw)
  } catch (e) {
    throw new Error('models.json 不是合法 JSON：' + e.message)
  }
  if (Array.isArray(probe)) return probe
  if (probe && typeof probe === 'object' && Array.isArray(probe.models)) return probe.models
  throw new Error('无法识别的 models.json 结构: ' + typeof probe)
}

// merge 合并（与旧脚本 is_ours 重建语义对齐）：
//   - 白名单历史条目清除；本网关但不在最新列表的条目视为已下线一并清除；
//   - 同 ID 覆盖更新；异网关手工条目原样保留。
function merge(existing, cfg) {
  const managed = new Set((cfg.models || []).map((m) => m.id))
  const keep = []
  let purged = 0
  let stale = 0
  let replaced = 0
  for (const e of existing || []) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      keep.push(e)
      continue
    }
    const id = typeof e.id === 'string' ? e.id : ''
    if (whitelistMatch(id)) {
      purged++
    } else if (managed.has(id)) {
      replaced++ // 将被新条目覆盖
    } else if (managedByOldRelay(e, cfg)) {
      stale++ // 本网关条目但网关已下线
    } else {
      keep.push(e)
    }
  }
  let added = 0
  for (const m of cfg.models || []) {
    keep.push(makeEntry(m.id, cfg))
    added++
  }
  const summary =
    '新增 ' + added + '、更新 ' + replaced + '、清除白名单历史 ' + purged + '、清理已下线 ' + stale + '，合并后共 ' + keep.length + ' 条'
  return { list: keep, summary }
}

function managedByOldRelay(m, cfg) {
  const u = typeof m.url === 'string' ? m.url : ''
  return u !== '' && u.startsWith(cfg.baseUrl)
}

function diffEntries(existing, cfg) {
  const out = []
  const oldIDs = new Set()
  for (const e of existing || []) {
    if (e && typeof e === 'object' && typeof e.id === 'string') oldIDs.add(e.id)
  }
  const newIDs = new Set((cfg.models || []).map((m) => m.id))
  for (const m of cfg.models || []) {
    if (!oldIDs.has(m.id)) out.push('+ ' + m.id)
  }
  for (const e of existing || []) {
    if (e && typeof e === 'object') {
      const id = typeof e.id === 'string' ? e.id : ''
      if (id && !newIDs.has(id) && (whitelistMatch(id) || managedByOldRelay(e, cfg))) {
        out.push('- ' + id)
      }
    }
  }
  if (out.length > 40) {
    out.length = 40
    out.push('...（更多省略）')
  }
  return out
}

function atomicWrite(p, content) {
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, p)
}

function detect(home) {
  const p = modelsPath(home)
  const result = { installed: false, configured: false, detail: '未检测到 models.json，首次写入将自动创建', paths: [p] }
  let entries
  try {
    entries = loadEntries(p)
  } catch (e) {
    result.installed = true
    result.detail = '存在 models.json 但无法解析（' + e.message + '），写入前会自动备份'
    return result
  }
  if (entries.length > 0) {
    result.installed = true
    result.configured = true
    result.detail = '已检测到 models.json（' + entries.length + ' 个模型条目）'
  }
  return result
}

function plan(home, cfg) {
  const p = modelsPath(home)
  let existing = []
  try {
    existing = loadEntries(p)
  } catch {
    existing = []
  }
  const { summary } = merge(existing, cfg)
  let s = summary
  if (!fs.existsSync(p)) s = '创建 ' + p + '；' + summary
  return [{ file: p, summary: s, diff: diffEntries(existing, cfg) }]
}

function backup(home) {
  const p = modelsPath(home)
  const { dir } = backupEngine.snapshot(home, 'workbuddy', [p])
  return { dir, files: [p] }
}

function configure(home, cfg) {
  const p = modelsPath(home)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const existing = loadEntries(p)
  const { list } = merge(existing, cfg)
  atomicWrite(p, JSON.stringify(list, null, 2) + '\n')
  return [{ file: p, summary: 'models.json 已写入' }]
}

function verify(home, cfg) {
  const entries = loadEntries(modelsPath(home))
  let count = 0
  let found = false
  for (const e of entries) {
    if (e && typeof e === 'object') {
      count++
      if (e.id === cfg.defaultModel) found = true
    }
  }
  if (!found) return { ok: false, message: 'models.json 中未找到默认模型 ' + cfg.defaultModel }
  return { ok: true, message: '校验通过（共 ' + count + ' 条，默认模型 ' + cfg.defaultModel + '）' }
}

function rollback(receipt) {
  backupEngine.restore(receipt.dir)
}

module.exports = { modelsPath, outCap, makeEntry, loadEntries, merge, detect, plan, backup, configure, verify, rollback, diffEntries, atomicWrite }
