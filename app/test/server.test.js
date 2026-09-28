// server.js 冒烟：回环令牌校验、targets、SPA 回退。
'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { startServer } = require('../src/server')

async function get(url) {
  const res = await fetch(url)
  return { status: res.status, text: await res.text() }
}

test('服务令牌校验 + targets + SPA 回退', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-srv-'))
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-dist-'))
  fs.writeFileSync(path.join(dist, 'index.html'), '<html>TRICONFIG_MARKER</html>')

  const { port, token, server } = await startServer({ distDir: dist, home })
  t.after(() => server.close())
  const base = 'http://127.0.0.1:' + port

  // 无令牌 → 401
  const noTok = await get(base + '/api/health')
  assert.strictEqual(noTok.status, 401)

  // 带令牌 → OK
  const ok = await get(base + '/api/health?t=' + token)
  assert.strictEqual(ok.status, 200)
  assert.ok(ok.text.includes('tiancaiConfig'))

  // targets 返回三目标
  const targets = await get(base + '/api/targets?t=' + token)
  assert.strictEqual(targets.status, 200)
  const parsed = JSON.parse(targets.text)
  assert.deepStrictEqual(parsed.targets.map((x) => x.id), ['codexcli', 'codexdesktop', 'workbuddy'])

  // 未知路径回退 index.html
  const spa = await get(base + '/whatever?t=' + token)
  assert.ok(spa.text.includes('TRICONFIG_MARKER'))

  // 非 API 路径不需要令牌（静态资源）
  const idx = await get(base + '/')
  assert.ok(idx.text.includes('TRICONFIG_MARKER'))
})

// 回归测试（2026-09-25 事故）：更名后前端发送 X-Triconfig-Token、服务端查
// x-tiancaiConfig-token（驼峰）——Node 入站头名一律小写，驼峰键永远 undefined，
// 全部 API 401 且前端静默吞错，GUI 卡死在「正在检测…」。测试与冒烟此前只走 ?t= 查询参数，未覆盖头路径。
test('令牌校验：请求头路径（发送端大小写不敏感，服务端必须全小写键）', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-srv2-'))
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-dist2-'))
  fs.writeFileSync(path.join(dist, 'index.html'), '<html>x</html>')
  const { port, token, server } = await startServer({ distDir: dist, home })
  t.after(() => server.close())
  const base = 'http://127.0.0.1:' + port

  // 正确令牌 + 混合大小写头发送（Node 转小写后应命中）→ 200，且不带查询参数
  const ok = await fetch(base + '/api/targets', { headers: { 'X-Tiancaiconfig-Token': token } })
  assert.strictEqual(ok.status, 200, '头路径鉴权应通过（HTTP 头名大小写不敏感）')

  // 错误令牌 → 401
  const bad = await fetch(base + '/api/targets', { headers: { 'x-tiancaiconfig-token': 'wrong' } })
  assert.strictEqual(bad.status, 401)

  // 完全无令牌（无头无参）→ 401
  const none = await fetch(base + '/api/targets')
  assert.strictEqual(none.status, 401)
})

test('settings API：默认模型读写 roundtrip，持久化至 ~/.tiancaiConfig/settings.json', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-srv3-'))
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-dist3-'))
  fs.writeFileSync(path.join(dist, 'index.html'), '<html>x</html>')
  const { port, token, server } = await startServer({ distDir: dist, home })
  t.after(() => server.close())
  const base = 'http://127.0.0.1:' + port
  const hdr = { 'Content-Type': 'application/json', 'x-tiancaiconfig-token': token }

  // 初始：未设置 → 空串 + 兜底常量
  const init = await (await fetch(base + '/api/settings', { headers: { 'x-tiancaiconfig-token': token } })).json()
  assert.strictEqual(init.defaultModel, '')
  assert.strictEqual(init.defaultModelFallback, 'glm-5.3-flash')

  // 写入 → 回读；文件真实落盘
  const post = await fetch(base + '/api/settings', { method: 'POST', headers: hdr, body: JSON.stringify({ defaultModel: 'z-slow' }) })
  assert.strictEqual(post.status, 200)
  const after = await (await fetch(base + '/api/settings', { headers: { 'x-tiancaiconfig-token': token } })).json()
  assert.strictEqual(after.defaultModel, 'z-slow')
  const onDisk = JSON.parse(fs.readFileSync(require('node:path').join(home, '.tiancaiConfig', 'settings.json'), 'utf8'))
  assert.strictEqual(onDisk.defaultModel, 'z-slow')

  // 空串 = 清除（回到未设置状态）
  await fetch(base + '/api/settings', { method: 'POST', headers: hdr, body: JSON.stringify({ defaultModel: '' }) })
  const cleared = await (await fetch(base + '/api/settings', { headers: { 'x-tiancaiconfig-token': token } })).json()
  assert.strictEqual(cleared.defaultModel, '')

  // 无令牌 → 401
  const noTok = await fetch(base + '/api/settings')
  assert.strictEqual(noTok.status, 401)
})

// 模型清单预拉取（2026-09-26 需求：填写 Key 后前端自动调用，勾选范围数据源）
test('模型清单预拉取 API：过滤非对话模型 + 坏 Key 友好错误 + 鉴权', async (t) => {
  // 假中转站
  const upstream = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      if (req.headers.authorization !== 'Bearer sk-ok') {
        res.writeHead(401)
        res.end('{"error":"bad key"}')
        return
      }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ data: [{ id: 'm-b' }, { id: 'text-embedding-x' }, { id: 'm-a' }] }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
  t.after(() => upstream.close())
  const relayUrl = 'http://127.0.0.1:' + upstream.address().port

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-srv4-'))
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-dist4-'))
  fs.writeFileSync(path.join(dist, 'index.html'), '<html>x</html>')
  const { port, token, server } = await startServer({ distDir: dist, home })
  t.after(() => server.close())
  const base = 'http://127.0.0.1:' + port
  const hdr = { 'Content-Type': 'application/json', 'x-tiancaiconfig-token': token }

  // 成功：非对话模型被剔除，id 去重排序
  const ok = await fetch(base + '/api/models', { method: 'POST', headers: hdr, body: JSON.stringify({ baseUrl: relayUrl, apiKey: 'sk-ok' }) })
  assert.strictEqual(ok.status, 200)
  const d = await ok.json()
  assert.strictEqual(d.ok, true)
  assert.deepStrictEqual(d.models, ['m-a', 'm-b'])
  assert.strictEqual(d.total, 3)
  assert.strictEqual(d.skipped, 1)

  // 坏 Key：HTTP 200 + ok:false + 友好 message（前端直接展示，不抛状态码）
  const bad = await fetch(base + '/api/models', { method: 'POST', headers: hdr, body: JSON.stringify({ baseUrl: relayUrl, apiKey: 'sk-bad' }) })
  assert.strictEqual(bad.status, 200)
  const bd = await bad.json()
  assert.strictEqual(bd.ok, false)
  assert.ok(bd.message.includes('API Key'), '应含友好提示: ' + bd.message)

  // GET → 405；无令牌 → 401
  const get405 = await fetch(base + '/api/models?t=' + token)
  assert.strictEqual(get405.status, 405)
  const noTok = await fetch(base + '/api/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  assert.strictEqual(noTok.status, 401)
})
