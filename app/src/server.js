// 本地回环 HTTP 服务：REST + SSE + 内嵌前端静态资源。
// 安全模型（沿用）：仅绑定 127.0.0.1 + 启动令牌（/api/* 必须）+ Origin 回环校验。
// 本文件不依赖 Electron，可在纯 Node 下运行（冒烟自测用）。
'use strict'

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const { run } = require('./engine/oneclick')
const { all } = require('./engine/registry')
const { rollbackLatest } = require('./engine/backup')
const appsettings = require('./engine/appsettings')
const { fetchModels, filterNonChat } = require('./engine/modelsapi')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
}

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || /^127\.0\.0\.1:\d+$/.test(host) || /^localhost:\d+$/.test(host)
}

function createHandler({ distDir, home }) {
  return async function handler(req, res) {
    try {
      // Origin 校验：非空 Origin 必须是回环
      const origin = req.headers.origin
      if (origin) {
        let u = null
        try {
          u = new URL(origin)
        } catch {}
        if (!u || !isLoopbackHost(u.host)) {
          res.writeHead(403)
          res.end('forbidden origin')
          return
        }
      }
      const u = new URL(req.url, 'http://127.0.0.1')
      if (u.pathname.startsWith('/api/')) {
        const urlTok = u.searchParams.get('t') || ''
        // Node 把入站头名统一转小写，这里必须用全小写键查（大小写混写永远 undefined）
        const tok = req.headers['x-tiancaiconfig-token'] || urlTok
        if (tok !== this.token) {
          res.writeHead(401)
          res.end('unauthorized')
          return
        }
        if (u.pathname === '/api/health') {
          json(res, { ok: true, name: 'tiancaiConfig' })
          return
        }
        if (u.pathname === '/api/targets') {
          json(res, {
            targets: all().map((t) => ({
              ...t.detect(home),
              autoupdateSupported: !!t.autoupdate,
              autoupdateLabel: t.autoupdate ? t.autoupdate.label : '',
            })),
          })
          return
        }
        if (u.pathname === '/api/ccswitch/status') {
          const ccswitch = require('./engine/ccswitch')
          const det = ccswitch.detectCC(home)
          det.autostart = ccswitch.autostartEnabled({ valueName: 'cc-switch', home })
          json(res, det)
          return
        }
        if (u.pathname === '/api/workbuddy-autoupdate/status') {
          const au = require('./engine/workbuddyautoupdate')
          json(res, au.status(home))
          return
        }
        if (u.pathname === '/api/settings') {
          if (req.method === 'GET') {
            const s = appsettings.readSettings(home)
            json(res, { defaultModel: String(s.defaultModel || ''), defaultModelFallback: appsettings.DEFAULT_MODEL })
            return
          }
          if (req.method === 'POST') {
            let body = ''
            for await (const chunk of req) {
              body += chunk
              if (body.length > 65536) break
            }
            let dm = ''
            try {
              dm = String((JSON.parse(body) || {}).defaultModel || '')
            } catch {}
            dm = dm.trim()
            appsettings.writeSettings(home, { defaultModel: dm })
            json(res, { ok: true, defaultModel: dm })
            return
          }
          res.writeHead(405)
          res.end('method not allowed')
          return
        }
        // 模型清单预拉取（前端填写 Key 后自动调用）：返回过滤非对话模型后的 id 列表。
        // 拉取失败不抛 HTTP 错误码，统一 200 + ok:false 携带友好 message（前端直接展示）。
        if (u.pathname === '/api/models') {
          if (req.method !== 'POST') {
            res.writeHead(405)
            res.end('method not allowed')
            return
          }
          let body = ''
          for await (const chunk of req) {
            body += chunk
            if (body.length > 65536) break
          }
          let q = {}
          try {
            q = JSON.parse(body) || {}
          } catch {}
          try {
            const ids = await fetchModels(q.baseUrl, q.apiKey)
            const [kept, skipped] = filterNonChat(ids)
            json(res, { ok: true, models: kept, total: ids.length, skipped: skipped.length })
          } catch (e) {
            json(res, { ok: false, message: e.message })
          }
          return
        }
        if (u.pathname === '/api/oneclick') {
          if (req.method !== 'POST') {
            res.writeHead(405)
            res.end('method not allowed')
            return
          }
          let body = ''
          for await (const chunk of req) {
            body += chunk
            if (body.length > 1 << 20) break
          }
          let request = {}
          try {
            request = body ? JSON.parse(body) : {}
          } catch {}
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
          })
          const ctl = new AbortController()
          req.on('close', () => ctl.abort())
          // 默认模型合并：前端显式传值优先；未传（老前端/CLI）时读取持久化设置（oneclick 内部再兜底 DEFAULT_MODEL）
          if (request.defaultModel === undefined || request.defaultModel === null) {
            request.defaultModel = String(appsettings.readSettings(home).defaultModel || '')
          }
          const send = (ev) => {
            if (res.destroyed) return
            res.write('data: ' + JSON.stringify(ev) + '\n\n')
          }
          try {
            await run({ home, request, emit: send, signal: ctl.signal })
          } catch (e) {
            send({ type: 'error', message: '管线异常：' + e.message })
            send({ type: 'done', ok: false, message: '管线异常：' + e.message })
          }
          res.end()
          return
        }
        if (u.pathname === '/api/rollback') {
          if (req.method !== 'POST') {
            res.writeHead(405)
            res.end('method not allowed')
            return
          }
          let body = ''
          for await (const chunk of req) {
            body += chunk
            if (body.length > 65536) break
          }
          let target = 'all'
          try {
            target = (JSON.parse(body).target) || 'all'
          } catch {}
          const results = []
          let okAll = true
          for (const t of all()) {
            if (target !== 'all' && target !== t.id) continue
            let ok = true
            let message = '没有可用备份，跳过'
            try {
              const restored = rollbackLatest(home, t.id)
              message = restored.length ? '已还原：' + restored.join('、') : message
            } catch (e) {
              ok = false
              okAll = false
              message = e.message
            }
            results.push({ target: t.id, ok, message })
          }
          json(res, { ok: okAll, message: okAll ? '回滚完成，重启对应工具后生效' : '回滚部分失败，请查看详情', results })
          return
        }
        res.writeHead(404)
        res.end('not found')
        return
      }

      // 静态资源 + SPA 回退
      const distAbs = path.resolve(distDir)
      let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '')
      if (!rel) rel = 'index.html'
      let file = path.resolve(distAbs, rel)
      if (!file.startsWith(distAbs)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(distAbs, 'index.html') // SPA 回退
      }
      const ext = path.extname(file).toLowerCase()
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
      fs.createReadStream(file).pipe(res)
    } catch (e) {
      try {
        res.writeHead(500)
        res.end('internal error: ' + e.message)
      } catch {}
    }
  }
}

// startServer 启动回环服务；返回 { port, token, server }。
async function startServer({ distDir, home }) {
  const token = crypto.randomBytes(18).toString('hex')
  const handler = createHandler({ distDir, home })
  const bound = handler.bind({ token })
  const server = http.createServer((req, res) => bound(req, res).catch(() => {}))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return { port, token, server }
}

function json(res, v) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(v))
}

module.exports = { startServer, createHandler }
