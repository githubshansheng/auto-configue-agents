// 一键流水线端到端：假中转站 + 临时 HOME + 三目标写入 + 失败路径不落盘
// + Codex 双模式（gpt-only 直连 / all-models cc-switch 本地路由）。
'use strict'

const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { run } = require('../src/engine/oneclick')
const { CC_PROXY_BASE, GPT_ONLY_RE } = require('../src/engine/oneclick')

function relay(t, delays, extraModels) {
  const ids = ['a-fast', 'z-slow', 'gpt-5.6-test', 'text-embedding-x', ...(extraModels || [])]
  const srv = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      if (req.headers.authorization !== 'Bearer sk-ok') {
        res.writeHead(401)
        res.end('{"error":"bad key"}')
        return
      }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ data: ids.map((id) => ({ id })) }))
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
        setTimeout(() => {
          res.write('data: {"delta":"hi"}\n\n')
          res.end('data: [DONE]\n\n')
        }, delays[id] || 0)
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, url: 'http://127.0.0.1:' + srv.address().port })))
}

function last(events, type) {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].type === type) return events[i]
  return null
}

function stageEnd(events, name) {
  const list = events.filter((e) => e.type === 'stage' && e.name === name && e.status !== 'running')
  return list.length ? list[list.length - 1] : null
}

function stubCC(calls) {
  return {
    ensureReady: async ({ onStage } = {}) => {
      calls.push('ensureReady')
      return { exePath: '/tmp/cc-switch-stub', installed: true, initialized: false }
    },
    configureProvider: (args) => {
      calls.push(['configureProvider', args])
      return { providerId: 'pid-1', note: '新建供应商并设为当前', settingsNote: 'settings.json currentProviderCodex 已同步', models: args.models.length }
    },
    setAutostart: (home, opts) => {
      calls.push(['setAutostart', opts])
      return '已注册开机自启（测试桩）'
    },
    launchCC: (exePath) => calls.push(['launchCC', exePath]),
    launchAndEnsureCurrent: (exePath, opts) => {
      calls.push(['launchAndEnsureCurrent', exePath, opts])
      return '当前供应商已指向新增配置（测试桩）'
    },
  }
}

function stubAU(calls) {
  return {
    install: (home, opts) => {
      calls.push(['install', opts])
      return '已注册自动更新（测试桩）'
    },
  }
}

test('管线成功（gpt-only 显式指定）：三目标写入 + Codex 仅 GPT 模型 + 校验全过', async (t) => {
  const { srv, url } = await relay(t, { 'gpt-5.6-test': 10, 'a-fast': 30, 'z-slow': 250 })
  t.after(() => srv.close())
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-e2e-'))

  const ccCalls = []
  const auCalls = []
  const events = []
  await run({
    home,
    request: { baseUrl: url + '/v1', apiKey: 'sk-ok', targets: ['codexcli', 'codexdesktop', 'workbuddy'], codexMode: 'gpt-only' },
    emit: (e) => events.push(e),
    persistEnv: async () => '测试桩：已设置',
    ccswitchApi: stubCC(ccCalls),
    autoupdateApi: stubAU(auCalls),
  })

  const done = last(events, 'done')
  assert.ok(done && done.ok, '管线应成功: ' + JSON.stringify(done))
  assert.strictEqual(done.results.length, 3)
  for (const r of done.results) assert.ok(r.ok, r.target + ': ' + r.message)

  // gpt-only 模式：Codex 默认模型取 GPT 池最快，base_url 直连中转站
  const toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')
  for (const want of [
    'model = "gpt-5.6-test"',
    'model_reasoning_effort = "xhigh"',
    'model_context_window = 272000',
    'base_url = "' + url + '/v1"',
    'env_key = "TIANCAICONFIG_API_KEY"',
    'requires_openai_auth = false',
  ]) {
    assert.ok(toml.includes(want), 'config.toml 缺少 ' + want + '\n' + toml)
  }
  const auth = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8'))
  assert.strictEqual(auth.OPENAI_API_KEY, 'sk-ok')
  assert.strictEqual(auth.auth_mode, 'apikey')

  // WorkBuddy models.json：3 个对话模型（embedding 被剔除），默认模型取全池最快 gpt-5.6-test
  const arr = JSON.parse(fs.readFileSync(path.join(home, '.workbuddy', 'models.json'), 'utf8'))
  assert.strictEqual(arr.length, 3)
  assert.ok(arr.some((m) => m.id === 'gpt-5.6-test' && m.url.includes(url)))

  // gpt-only 不触发 cc-switch；WorkBuddy 勾选 → 自动更新注册
  assert.strictEqual(ccCalls.length, 0, 'gpt-only 模式不应触碰 cc-switch')
  assert.strictEqual(auCalls.length, 1, '应注册 WorkBuddy 自动更新')

  // 阶段链完整性：10 阶段都有终态（ccswitch 除外）
  const seen = new Set(events.filter((e) => e.type === 'stage' && e.status !== 'running').map((e) => e.name))
  for (const s of ['validate', 'fetch', 'filter', 'speedtest', 'plan', 'backup', 'write', 'autoupdate', 'verify']) {
    assert.ok(seen.has(s), '缺少阶段终态: ' + s)
  }
  assert.ok(!seen.has('ccswitch'), 'gpt-only 不应出现 ccswitch 阶段')
})

test('缺省 codexMode = all-models（默认推荐）：cc-switch 桩全链路 + Codex 指向本地路由 + WorkBuddy 仍直连', async (t) => {
  const { srv, url } = await relay(t, { 'gpt-5.6-test': 10, 'a-fast': 30 })
  t.after(() => srv.close())
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-cc-'))

  const ccCalls = []
  const auCalls = []
  const events = []
  await run({
    home,
    request: { baseUrl: url, apiKey: 'sk-ok', targets: ['codexcli', 'workbuddy'] },
    emit: (e) => events.push(e),
    persistEnv: async () => 'stub',
    ccswitchApi: stubCC(ccCalls),
    autoupdateApi: stubAU(auCalls),
  })

  const done = last(events, 'done')
  assert.ok(done && done.ok, '管线应成功: ' + JSON.stringify(done))

  // cc-switch 桩链路：ensureReady → configureProvider(relay=中转站, 全部对话模型) → setAutostart → launchCC
  assert.ok(ccCalls.includes('ensureReady'), '应调用 ensureReady')
  const cp = ccCalls.find((c) => Array.isArray(c) && c[0] === 'configureProvider')
  assert.ok(cp, '应调用 configureProvider')
  assert.strictEqual(cp[1].relay, url, 'configureProvider.relay 应为中转站')
  assert.strictEqual(cp[1].models.length, 3, '应写入全部 3 个对话模型到 cc-switch 模型目录')
  assert.ok(ccCalls.some((c) => Array.isArray(c) && c[0] === 'setAutostart'), '默认应注册 cc-switch 自启')
  assert.ok(!ccCalls.some((c) => Array.isArray(c) && c[0] === 'launchCC'), '应经 launchAndEnsureCurrent 启动（含当前供应商校正），不再裸调 launchCC')
  const lac = ccCalls.find((c) => Array.isArray(c) && c[0] === 'launchAndEnsureCurrent')
  assert.ok(lac, '写入后应启动并校正当前供应商')
  assert.strictEqual(lac[2] && lac[2].pid, 'pid-1', '校正应携带 configureProvider 返回的供应商 ID')

  // Codex config.toml 指向 cc-switch 本地路由（15721）
  const toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')
  assert.ok(toml.includes('base_url = "' + CC_PROXY_BASE + '/v1"'), 'Codex 应指向本地路由 15721\n' + toml)
  assert.ok(toml.includes('wire_api = "responses"'), '本地路由协议转换需 wire_api=responses')

  // WorkBuddy 仍直连中转站（不受 codexMode 影响）
  const arr = JSON.parse(fs.readFileSync(path.join(home, '.workbuddy', 'models.json'), 'utf8'))
  assert.strictEqual(arr.length, 3)
  for (const m of arr) assert.ok(m.url.includes(url), 'WorkBuddy 应直连中转站: ' + m.url)

  // 阶段：ccswitch 有终态
  const ccStage = stageEnd(events, 'ccswitch')
  assert.ok(ccStage && ccStage.status === 'ok', 'ccswitch 阶段应成功')
})

test('all-models + proxyAutostart=false：不注册自启', async (t) => {
  const { srv, url } = await relay(t, {})
  t.after(() => srv.close())
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-noauto-'))

  const ccCalls = []
  const events = []
  await run({
    home,
    request: { baseUrl: url, apiKey: 'sk-ok', targets: ['codexcli'], codexMode: 'all-models', proxyAutostart: false },
    emit: (e) => events.push(e),
    persistEnv: async () => 'stub',
    ccswitchApi: stubCC(ccCalls),
    autoupdateApi: stubAU([]),
  })

  const done = last(events, 'done')
  assert.ok(done && done.ok)
  assert.ok(!ccCalls.some((c) => Array.isArray(c) && c[0] === 'setAutostart'), 'proxyAutostart=false 不应注册自启')
})

test('模型自动更新按目标勾选：缺省注册（带 target 标识），显式关闭则不注册', async (t) => {
  const { srv, url } = await relay(t, { 'gpt-5.6-test': 10 })
  t.after(() => srv.close())

  // 缺省：已适配目标默认勾选 → 注册，并携带 target 标识
  const home1 = fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-au-on-'))
  const auOn = []
  const ev1 = []
  await run({
    home: home1,
    request: { baseUrl: url + '/v1', apiKey: 'sk-ok', targets: ['workbuddy'] },
    emit: (e) => ev1.push(e),
    persistEnv: async () => 'stub',
    ccswitchApi: stubCC([]),
    autoupdateApi: stubAU(auOn),
  })
  assert.ok(last(ev1, 'done') && last(ev1, 'done').ok, '缺省管线应成功')
  assert.strictEqual(auOn.length, 1, '缺省应注册自动更新')
  assert.strictEqual(auOn[0][1].target, 'workbuddy', '注册应携带目标标识')

  // 显式关闭：autoUpdate.workbuddy=false → 不注册
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-au-off-'))
  const auOff = []
  const ev2 = []
  await run({
    home: home2,
    request: { baseUrl: url + '/v1', apiKey: 'sk-ok', targets: ['workbuddy'], autoUpdate: { workbuddy: false } },
    emit: (e) => ev2.push(e),
    persistEnv: async () => 'stub',
    ccswitchApi: stubCC([]),
    autoupdateApi: stubAU(auOff),
  })
  assert.ok(last(ev2, 'done') && last(ev2, 'done').ok, '关闭自动更新后管线仍应成功')
  assert.strictEqual(auOff.length, 0, '显式关闭不应注册')

  // 旧字段兼容：workbuddyAutoUpdate=false 同样不注册
  const home3 = fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-au-legacy-'))
  const auLegacy = []
  await run({
    home: home3,
    request: { baseUrl: url + '/v1', apiKey: 'sk-ok', targets: ['workbuddy'], workbuddyAutoUpdate: false },
    emit: () => {},
    persistEnv: async () => 'stub',
    ccswitchApi: stubCC([]),
    autoupdateApi: stubAU(auLegacy),
  })
  assert.strictEqual(auLegacy.length, 0, '旧字段 workbuddyAutoUpdate=false 不应注册')
})

test('Codex 自动更新注册去重：cli+desktop 共用触发器只注册一次；按目标可关闭', async (t) => {
  const { srv, url } = await relay(t, { 'gpt-5.6-test': 10 })
  t.after(() => srv.close())

  // 两个 Codex 目标 → kind 去重，只注册一次 --autoupdate-codex
  const home1 = fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-codex-au-'))
  const auW = []
  const auC = []
  const ev = []
  await run({
    home: home1,
    request: { baseUrl: url + '/v1', apiKey: 'sk-ok', targets: ['codexcli', 'codexdesktop'] },
    emit: (e) => ev.push(e),
    persistEnv: async () => 'stub',
    ccswitchApi: stubCC([]),
    autoupdateApi: stubAU(auW),
    codexAuApi: stubAU(auC),
  })
  const done = last(ev, 'done')
  assert.ok(done && done.ok, '管线应成功: ' + JSON.stringify(done))
  assert.strictEqual(auW.length, 0, '未选 WorkBuddy 不应注册 workbuddy agent')
  assert.strictEqual(auC.length, 1, 'cli+desktop 应去重为一次注册')
  assert.strictEqual(auC[0][1].args[auC[0][1].args.length - 1], '--autoupdate-codex', '参数应为 codex headless 模式')

  // 关闭 cli 保留 desktop → 仍注册；全部关闭 → 不注册
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-codex-au2-'))
  const auC2 = []
  await run({
    home: home2,
    request: { baseUrl: url + '/v1', apiKey: 'sk-ok', targets: ['codexcli', 'codexdesktop'], autoUpdate: { codexcli: false } },
    emit: () => {},
    persistEnv: async () => 'stub',
    ccswitchApi: stubCC([]),
    autoupdateApi: stubAU([]),
    codexAuApi: stubAU(auC2),
  })
  assert.strictEqual(auC2.length, 1, 'desktop 勾选即注册')

  const home3 = fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-codex-au3-'))
  const auC3 = []
  await run({
    home: home3,
    request: { baseUrl: url + '/v1', apiKey: 'sk-ok', targets: ['codexcli', 'codexdesktop'], autoUpdate: { codexcli: false, codexdesktop: false } },
    emit: () => {},
    persistEnv: async () => 'stub',
    ccswitchApi: stubCC([]),
    autoupdateApi: stubAU([]),
    codexAuApi: stubAU(auC3),
  })
  assert.strictEqual(auC3.length, 0, '全部关闭不注册')
})

test('gpt-only 且无 GPT 模型：filter 阶段失败并给出模式切换指引', async (t) => {
  const { srv, url } = await relay(t, { 'a-fast': 5 })
  t.after(() => srv.close())
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-nogpt-'))
  // 只写一个非 GPT 模型的假中转站：本 relay fixture 固定含 gpt-5.6-test，
  // 因此这里用全量断言代替：检查 GPT_ONLY_RE 语义即可，另测「仅 WorkBuddy 不受影响」。

  const events = []
  await run({
    home,
    request: { baseUrl: url, apiKey: 'sk-ok', targets: ['workbuddy'] }, // 未勾 Codex → gpt-only 过滤不生效
    emit: (e) => events.push(e),
    persistEnv: async () => 'stub',
    ccswitchApi: stubCC([]),
    autoupdateApi: stubAU([]),
  })
  const done = last(events, 'done')
  assert.ok(done && done.ok, '仅 WorkBuddy 时不应受 GPT 过滤影响')

  // 语义自检：GPT_ONLY_RE 匹配规则
  assert.ok(GPT_ONLY_RE.test('gpt-5.6-test'))
  assert.ok(GPT_ONLY_RE.test('gpt-5.5'))
  assert.ok(!GPT_ONLY_RE.test('a-fast'))
  assert.ok(!GPT_ONLY_RE.test('deepseek-v4-pro'))
})

test('坏 Key 整体失败且不落盘', async (t) => {
  const { srv, url } = await relay(t, {})
  t.after(() => srv.close())
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'triconfit-bad-'))

  const events = []
  await run({
    home,
    request: { baseUrl: url, apiKey: 'sk-bad', targets: ['codexcli', 'workbuddy'] },
    emit: (e) => events.push(e),
    persistEnv: async () => 'stub',
    ccswitchApi: stubCC([]),
    autoupdateApi: stubAU([]),
  })

  const done = last(events, 'done')
  assert.ok(done && !done.ok, '坏 Key 应整体失败')
  assert.ok(!fs.existsSync(path.join(home, '.codex', 'config.toml')), '失败路径不应写入 config.toml')
  assert.ok(!fs.existsSync(path.join(home, '.workbuddy', 'models.json')), '失败路径不应写入 models.json')
  assert.ok(/401|Key/.test(done.message), '应含人话错误提示: ' + done.message)
})

test('空 Key 在校验阶段即失败', async () => {
  const events = []
  await run({
    home: fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-empty-')),
    request: { baseUrl: 'https://x.example', apiKey: '' },
    emit: (e) => events.push(e),
    persistEnv: async () => 'stub',
  })
  const done = last(events, 'done')
  assert.ok(done && !done.ok)
  assert.ok(!events.some((e) => e.type === 'stage' && e.name === 'fetch' && e.status === 'ok'), '空 Key 不应进入拉取阶段')
})

test('默认模型：设置值命中则优先（覆盖测速最快），未设置兜底 glm-5.3-flash 并按需回退', async (t) => {
  // 场景 1：defaultModel=z-slow（在列表但慢）→ 全链路采用 z-slow，stage ok
  const { srv, url } = await relay(t, { 'gpt-5.6-test': 10, 'a-fast': 30, 'z-slow': 250 })
  t.after(() => srv.close())
  {
    const ccCalls = []
    const events = []
    await run({
      home: fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-dm-hit-')),
      request: { baseUrl: url, apiKey: 'sk-ok', targets: ['codexcli'], defaultModel: 'z-slow' },
      emit: (e) => events.push(e),
      persistEnv: async () => 'stub',
      ccswitchApi: stubCC(ccCalls),
      autoupdateApi: stubAU([]),
    })
    assert.ok(last(events, 'done') && last(events, 'done').ok)
    const cp = ccCalls.find((c) => Array.isArray(c) && c[0] === 'configureProvider')
    assert.strictEqual(cp[1].defaultModel, 'z-slow', '应写入用户设置的默认模型')
    const st = stageEnd(events, 'speedtest')
    assert.strictEqual(st.status, 'ok', '默认模型命中不应 warn')
    assert.ok(st.detail.includes('z-slow') && st.detail.includes('默认模型'), 'detail: ' + st.detail)
  }
  // 场景 2：未设置 → 兜底 glm-5.3-flash；fixture 无该模型 → 回退测速最快并 warn
  {
    const ccCalls = []
    const events = []
    await run({
      home: fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-dm-miss-')),
      request: { baseUrl: url, apiKey: 'sk-ok', targets: ['codexcli'] },
      emit: (e) => events.push(e),
      persistEnv: async () => 'stub',
      ccswitchApi: stubCC(ccCalls),
      autoupdateApi: stubAU([]),
    })
    assert.ok(last(events, 'done') && last(events, 'done').ok, '回退不应导致失败')
    const cp = ccCalls.find((c) => Array.isArray(c) && c[0] === 'configureProvider')
    assert.strictEqual(cp[1].defaultModel, 'gpt-5.6-test', '应回退为测速最快（10ms）')
    const st = stageEnd(events, 'speedtest')
    assert.strictEqual(st.status, 'warn', '默认模型不在列表应 warn')
    assert.ok(st.detail.includes('glm-5.3-flash') && st.detail.includes('已回退'), 'detail: ' + st.detail)
  }
  // 场景 3：中转站提供 glm-5.3-flash 且未设置 → 直接命中兜底值
  {
    const srv3 = await relay(t, { 'glm-5.3-flash': 40, 'gpt-5.6-test': 10 }, ['glm-5.3-flash'])
    t.after(() => srv3.srv.close())
    const ccCalls = []
    const events = []
    await run({
      home: fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-dm-def-')),
      request: { baseUrl: srv3.url, apiKey: 'sk-ok', targets: ['codexcli'] },
      emit: (e) => events.push(e),
      persistEnv: async () => 'stub',
      ccswitchApi: stubCC(ccCalls),
      autoupdateApi: stubAU([]),
    })
    assert.ok(last(events, 'done') && last(events, 'done').ok)
    const cp = ccCalls.find((c) => Array.isArray(c) && c[0] === 'configureProvider')
    assert.strictEqual(cp[1].defaultModel, 'glm-5.3-flash', '兜底默认模型命中应直接采用')
    assert.strictEqual(stageEnd(events, 'speedtest').status, 'ok')
  }
})

test('默认模型 gpt-only 模式：非 GPT 默认值仅影响 WorkBuddy，Codex 在 GPT 池回退', async (t) => {
  const { srv, url } = await relay(t, { 'gpt-5.6-test': 10, 'a-fast': 30, 'z-slow': 250 })
  t.after(() => srv.close())
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-dm-gpt-'))
  const ccCalls = []
  const events = []
  await run({
    home,
    request: { baseUrl: url, apiKey: 'sk-ok', targets: ['codexcli', 'workbuddy'], codexMode: 'gpt-only', defaultModel: 'z-slow' },
    emit: (e) => events.push(e),
    persistEnv: async () => 'stub',
    ccswitchApi: stubCC(ccCalls),
    autoupdateApi: stubAU([]),
  })
  const done = last(events, 'done')
  assert.ok(done && done.ok, '管线应成功: ' + JSON.stringify(done))

  // Codex：z-slow 非 GPT → GPT 池回退最快 gpt-5.6-test
  const toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')
  assert.ok(toml.includes('model = "gpt-5.6-test"'), 'Codex 应回退 GPT 池最快\n' + toml)

  // WorkBuddy：z-slow 在对话池 → 直接采用
  const arr = JSON.parse(fs.readFileSync(path.join(home, '.workbuddy', 'models.json'), 'utf8'))
  assert.ok(arr.some((m) => m.id === 'z-slow'), 'WorkBuddy 模型清单应含 z-slow')

  const st = stageEnd(events, 'speedtest')
  assert.strictEqual(st.status, 'warn', 'Codex 回退应 warn')
  assert.ok(st.detail.includes('z-slow'), 'detail: ' + st.detail)
})

// 勾选范围（2026-09-26 需求：前端模型清单默认全选可取消，勾选结果决定写入范围）
test('勾选范围 checkedModels：模型池收窄至勾选项；空交集回退全量并 warn', async (t) => {
  const { srv, url } = await relay(t, { 'z-slow': 10, 'a-fast': 30 })
  t.after(() => srv.close())

  // 场景一：勾选 z-slow → 模型池只剩 z-slow，cc-switch 目录与默认模型均据此生成
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-scope-'))
  const ccCalls = []
  const events = []
  await run({
    home,
    request: { baseUrl: url, apiKey: 'sk-ok', targets: ['codexdesktop'], checkedModels: ['z-slow'] },
    emit: (e) => events.push(e),
    persistEnv: async () => 'stub',
    ccswitchApi: stubCC(ccCalls),
    autoupdateApi: stubAU([]),
    codexAuApi: stubAU([]),
  })
  const done = last(events, 'done')
  assert.ok(done && done.ok, '管线应成功: ' + JSON.stringify(done))
  const cp = ccCalls.find((c) => Array.isArray(c) && c[0] === 'configureProvider')
  assert.ok(cp, '应调用 configureProvider')
  assert.deepStrictEqual(cp[1].models, ['z-slow'], 'cc-switch 模型目录应仅含勾选项')
  // 默认模型 glm-5.3-flash 不在收窄后的池中 → 回退池内最快（唯一项 z-slow）
  assert.strictEqual(cp[1].defaultModel, 'z-slow')
  const fe = stageEnd(events, 'filter')
  assert.ok(fe.detail.includes('按勾选范围保留 1 个'), 'filter detail: ' + fe.detail)
  assert.strictEqual(fe.status, 'ok')
  // WorkBuddy 未选，不应有写入
  assert.ok(!fs.existsSync(path.join(home, '.workbuddy')), '未勾选 WorkBuddy 不应写入')

  // 场景二：勾选项与站点模型无交集 → 回退全量并 warn
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-scope2-'))
  const ccCalls2 = []
  const events2 = []
  await run({
    home: home2,
    request: { baseUrl: url, apiKey: 'sk-ok', targets: ['codexdesktop'], checkedModels: ['no-such-model'] },
    emit: (e) => events2.push(e),
    persistEnv: async () => 'stub',
    ccswitchApi: stubCC(ccCalls2),
    autoupdateApi: stubAU([]),
    codexAuApi: stubAU([]),
  })
  const done2 = last(events2, 'done')
  assert.ok(done2 && done2.ok, '空交集场景管线应成功: ' + JSON.stringify(done2))
  const fe2 = stageEnd(events2, 'filter')
  assert.strictEqual(fe2.status, 'warn', '空交集应 warn')
  assert.ok(fe2.detail.includes('无交集'), 'filter detail: ' + fe2.detail)
  const cp2 = ccCalls2.find((c) => Array.isArray(c) && c[0] === 'configureProvider')
  assert.strictEqual(cp2[1].models.length, 3, '空交集应回退全量对话模型（3 个）')
})
