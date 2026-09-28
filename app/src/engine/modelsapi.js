// 中转站模型列表拉取、白名单过滤与并发测速（从 Go 引擎 1:1 移植）。
'use strict'

const WHITELIST_RE = /embedding|image|whisper|tts|dall-e|moderation|rerank|^codex-auto-review$|^gpt-5\.4-mini$/i

// normalizeBase 归一化中转地址：去空白、去尾部斜杠、去多余的 /v1 与 /chat/completions。
function normalizeBase(base) {
  let b = String(base || '').trim()
  b = b.replace(/\/+$/, '')
  b = b.replace(/\/chat\/completions$/i, '')
  b = b.replace(/\/v1$/i, '')
  b = b.replace(/\/+$/, '')
  return b
}

function whitelistMatch(id) {
  return WHITELIST_RE.test(id)
}

// filterNonChat 按白名单剔除非对话模型。返回 [kept, skipped]。
function filterNonChat(ids) {
  const kept = []
  const skipped = []
  for (const id of ids || []) {
    if (whitelistMatch(id)) skipped.push(id)
    else kept.push(id)
  }
  return [kept, skipped]
}

function friendlyHTTPError(status, body) {
  if (status === 401 || status === 403) return new Error('API Key 无效或无权限（HTTP ' + status + '），请检查密钥')
  if (status === 404) return new Error('接口路径不存在（HTTP 404），请确认中转地址是否正确')
  if (status === 429) return new Error('中转站限流（HTTP 429），请稍后重试')
  if (status >= 500) return new Error('中转站服务异常（HTTP ' + status + '）')
  const tail = String(body || '').trim().slice(0, 120)
  return new Error('请求失败（HTTP ' + status + '）' + tail)
}

// fetchModels 拉取 /v1/models，兼容 {"data":[...]} 与裸数组两种返回。返回去重排序的 id 列表。
async function fetchModels(base, apiKey, signal) {
  const res = await fetch(normalizeBase(base) + '/v1/models', {
    headers: { Authorization: 'Bearer ' + apiKey },
    signal,
  })
  const text = await res.text()
  if (!res.ok) throw friendlyHTTPError(res.status, text)
  let probe
  try {
    probe = JSON.parse(text)
  } catch {
    throw new Error('模型列表返回的不是合法 JSON')
  }
  const items = Array.isArray(probe) ? probe : probe && Array.isArray(probe.data) ? probe.data : []
  const seen = new Set()
  const ids = []
  for (const it of items) {
    const id = typeof it === 'string' ? it : it && typeof it.id === 'string' ? it.id : ''
    if (id && !seen.has(id)) {
      seen.add(id)
      ids.push(id)
    }
  }
  ids.sort()
  return ids
}

// probeTTFT 流式请求取首字延迟毫秒。夹紧下限 1ms：本机回环可能测出 0，0 保留给「未测到」。
async function probeTTFT(base, apiKey, id, perTimeoutMs, signal) {
  const ctl = new AbortController()
  const onAbort = () => ctl.abort(signal && signal.reason)
  if (signal) signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => ctl.abort(new Error('timeout')), perTimeoutMs)
  const start = Date.now()
  try {
    const res = await fetch(normalizeBase(base) + '/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: id, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: true }),
      signal: ctl.signal,
    })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      throw friendlyHTTPError(res.status, t)
    }
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (line.startsWith('data:')) return Math.max(1, Date.now() - start)
      }
    }
    throw new Error('未收到任何流式响应')
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

// speedTest 并发静默测速。结果按模型 ID 排序保证稳定；单模型失败不影响其他。
async function speedTest(base, apiKey, ids, { concurrency = 4, perTimeoutMs = 10000, signal } = {}) {
  const out = []
  let next = 0
  async function worker() {
    while (next < ids.length) {
      if (signal && signal.aborted) return
      const id = ids[next++]
      const m = { id, ttftMs: 0, ok: false }
      try {
        m.ttftMs = await probeTTFT(base, apiKey, id, perTimeoutMs, signal)
        m.ok = true
      } catch (e) {
        if (signal && signal.aborted) return
      }
      out.push(m)
    }
  }
  const n = Math.max(1, Math.min(concurrency, ids.length))
  await Promise.all(Array.from({ length: n }, worker))
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return out
}

// pickFastest 选出测速最快且成功的模型；并列时取字典序更小者（结果稳定）。
function pickFastest(ms) {
  let best = null
  for (const m of ms || []) {
    if (!m.ok || !m.ttftMs) continue
    if (!best || m.ttftMs < best.ttftMs || (m.ttftMs === best.ttftMs && m.id < best.id)) best = m
  }
  return best
}

module.exports = { normalizeBase, whitelistMatch, filterNonChat, fetchModels, speedTest, pickFastest, friendlyHTTPError }
