// modelsapi.js 单测：地址归一化、白名单过滤、假中转站测速选优、错误人话化。
'use strict'

const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const { normalizeBase, filterNonChat, fetchModels, speedTest, pickFastest } = require('../src/engine/modelsapi')

test('normalizeBase 纠偏', () => {
  const cases = {
    '  https://api.example.com ': 'https://api.example.com',
    'https://api.example.com/': 'https://api.example.com',
    'https://api.example.com/v1': 'https://api.example.com',
    'https://api.example.com/v1/': 'https://api.example.com',
    'https://api.example.com/v1/chat/completions': 'https://api.example.com',
    'http://127.0.0.1:9000/v1': 'http://127.0.0.1:9000',
  }
  for (const [inp, want] of Object.entries(cases)) {
    assert.strictEqual(normalizeBase(inp), want, inp)
  }
})

test('filterNonChat 白名单', () => {
  const [kept, skipped] = filterNonChat([
    'glm-5.3-flash', 'text-embedding-3', 'gpt-image-2', 'tts-1',
    'codex-auto-review', 'gpt-5.4-mini', 'deepseek-v4-pro',
  ])
  assert.deepStrictEqual(kept.sort(), ['deepseek-v4-pro', 'glm-5.3-flash'])
  assert.strictEqual(skipped.length, 5)
})

// mockRelay：OpenAI 兼容假中转站。「最快者胜出」用相对延迟做结构性断言，不钉绝对毫秒。
function mockRelay(t, delays) {
  const srv = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      if (req.headers.authorization !== 'Bearer sk-test') {
        res.writeHead(401)
        res.end('{"error":"bad key"}')
        return
      }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ data: [{ id: 'z-slow' }, { id: 'a-fast' }, { id: 'text-embedding-x' }] }))
      return
    }
    if (req.url === '/v1/chat/completions') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        let id = ''
        try {
          id = JSON.parse(body).model
        } catch {}
        const d = delays[id] || 0
        setTimeout(() => {
          res.write('data: {"delta":"hi"}\n\n')
          res.end('data: [DONE]\n\n')
        }, d)
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, url: 'http://127.0.0.1:' + srv.address().port })))
}

test('fetchModels + speedTest 选出最快者', async (t) => {
  const { srv, url } = await mockRelay(t, { 'a-fast': 30, 'z-slow': 250 })
  t.after(() => srv.close())

  const ids = await fetchModels(url, 'sk-test')
  assert.strictEqual(ids.length, 3)
  const [kept] = filterNonChat(ids)
  assert.strictEqual(kept.length, 2)

  const ms = await speedTest(url, 'sk-test', kept, { concurrency: 2, perTimeoutMs: 5000 })
  const best = pickFastest(ms)
  assert.ok(best, '应有最快者')
  assert.strictEqual(best.id, 'a-fast')
  for (const m of ms) {
    if (m.ok) assert.ok(m.ttftMs >= 1, 'TTFT 应夹紧 >=1')
  }
})

test('坏 Key 返回 401 人话错误', async (t) => {
  const { srv, url } = await mockRelay(t, {})
  t.after(() => srv.close())
  await assert.rejects(() => fetchModels(url, 'sk-wrong'), (e) => /401/.test(e.message))
})

test('404 返回路径提示', async (t) => {
  const srv = http.createServer((req, res) => {
    res.writeHead(404)
    res.end()
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  t.after(() => srv.close())
  const url = 'http://127.0.0.1:' + srv.address().port
  await assert.rejects(() => fetchModels(url, 'sk-test'), (e) => /404/.test(e.message))
})
