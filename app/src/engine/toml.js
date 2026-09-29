// Codex config.toml 行级合并（从 Go 引擎 1:1 移植）。
// 规则：顶层键替换或前置插入；旧 [model_providers.tiancaiconfig] 块整体移除后重写
// （更名前的 triconfig 块一并清理）；用户自定义段落原样保留。
'use strict'

const PROVIDER = 'tiancaiconfig'
// 更名前的 provider 块名：buildTOML 时一并移除，避免旧块残留
const LEGACY_PROVIDERS = ['triconfig']
const ENV_KEY = 'TIANCAICONFIG_API_KEY'
const LEGACY_ENV_KEYS = ['TRICONFIG_API_KEY']

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function splitLines(s) {
  if (!s) return []
  const lines = String(s).replace(/\r\n/g, '\n').split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function setTopKey(lines, key, value) {
  const re = new RegExp('^\\s*' + escapeRe(key) + '\\s*=')
  const out = []
  let replaced = false
  for (const l of lines) {
    if (re.test(l)) {
      if (!replaced) {
        out.push(key + ' = ' + value) // 首个匹配：原位替换
        replaced = true
      }
      // 后续同名重复键直接丢弃（TOML 重复顶层键语义未定义，后键静默覆盖前键，
      // 历史上出现过 medium/max 并存导致默认思考量失控，必须收口为唯一一行）
      continue
    }
    out.push(l)
  }
  if (replaced) return out
  let insert = 0
  while (insert < out.length) {
    const t = out[insert].trim()
    if (t === '' || t.startsWith('#')) insert++
    else break
  }
  out.splice(insert, 0, key + ' = ' + value)
  return out
}

function stripProviderBlock(lines, name) {
  const header = '[model_providers.' + name + ']'
  const out = []
  let inBlock = false
  for (const l of lines) {
    const t = l.trim()
    if (t === header) {
      inBlock = true
      continue
    }
    if (inBlock) {
      if (t.startsWith('[')) inBlock = false
      else continue
    }
    out.push(l)
  }
  return out
}

// buildTOML 基于旧内容生成新 config.toml。写入语义沿用旧工具实战验证链：
// wire_api=responses + env_key + requires_openai_auth=false；并收口两条硬保证：
// 默认思考量（model_reasoning_effort=xhigh，2026-09-26 用户要求全工具统一）
// 与上下文窗口（model_context_window=272000，OpenAI 家族官方基线）。
// base 需已归一化（不含 /v1）；all-models 模式传 http://127.0.0.1:15721。
function buildTOML(existing, base, model) {
  let lines = splitLines(existing)
  for (const name of [PROVIDER, ...LEGACY_PROVIDERS]) lines = stripProviderBlock(lines, name)
  lines = setTopKey(lines, 'model_provider', '"' + PROVIDER + '"')
  lines = setTopKey(lines, 'model', '"' + model + '"')
  lines = setTopKey(lines, 'review_model', '"' + model + '"')
  lines = setTopKey(lines, 'model_reasoning_effort', '"xhigh"')
  lines = setTopKey(lines, 'model_context_window', '272000')

  let out = lines.join('\n')
  if (lines.length && lines[lines.length - 1].trim() !== '') out += '\n'
  out += '\n'
  out += '[model_providers.' + PROVIDER + ']\n'
  out += 'name = "' + PROVIDER + '"\n'
  out += 'base_url = "' + base + '/v1"\n'
  out += 'wire_api = "responses"\n'
  out += 'env_key = "' + ENV_KEY + '"\n'
  out += 'requires_openai_auth = false\n'
  return out
}

function hasProviderBlock(existing) {
  return String(existing || '').includes('[model_providers.' + PROVIDER + ']')
}

function freqMap(ls) {
  const m = new Map()
  for (const l of ls) m.set(l, (m.get(l) || 0) + 1)
  return m
}

// lineDiff 生成简易 diff 预览（-旧行 +新行，超限截断）。
function lineDiff(oldText, newText, cap = 40) {
  const oldFreq = freqMap(splitLines(oldText))
  const newFreq = freqMap(splitLines(newText))
  const out = []
  for (const l of splitLines(oldText)) {
    if ((oldFreq.get(l) || 0) > (newFreq.get(l) || 0)) {
      out.push('- ' + l)
      oldFreq.delete(l)
    }
  }
  for (const l of splitLines(newText)) {
    if ((newFreq.get(l) || 0) > (oldFreq.get(l) || 0)) {
      out.push('+ ' + l)
      newFreq.delete(l)
    }
  }
  if (out.length > cap) {
    const more = out.length - cap
    out.length = cap
    out.push('...（另有 ' + more + ' 行变更省略）')
  }
  return out
}

module.exports = { PROVIDER, LEGACY_PROVIDERS, ENV_KEY, LEGACY_ENV_KEYS, splitLines, setTopKey, stripProviderBlock, buildTOML, hasProviderBlock, lineDiff }
