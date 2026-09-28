// Codex 模型自动更新单测：网关记忆/反推、gpt-only 幂等同步、all-models cc-switch 目录刷新、注册产物。
'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const au = require('../src/engine/codexautoupdate')
const codexconfig = require('../src/engine/codexconfig')

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-codexau-'))
}

function fakeFetch(ids) {
  return async () => ids
}

function seedDirect(home, model) {
  codexconfig.configure(home, { baseUrl: 'https://relay.example', apiKey: 'sk-k', defaultModel: model || 'gpt-a' })
}

test('rememberGateway：与 workbuddy 记忆同文件合并，互不覆盖', () => {
  const home = tmpHome()
  au.rememberGateway(home, { base: 'https://a.example', apiKey: 'sk-a', mode: 'gpt-only' })
  // 模拟 workbuddy 侧随后写入同一状态文件
  const p = au.gatewayStatePath(home)
  const m = JSON.parse(fs.readFileSync(p, 'utf8'))
  m.workbuddy = 'https://wb.example'
  fs.writeFileSync(p, JSON.stringify(m))
  au.rememberGateway(home, { base: 'https://b.example', apiKey: 'sk-b', mode: 'all-models' })
  const m2 = JSON.parse(fs.readFileSync(p, 'utf8'))
  assert.strictEqual(m2.workbuddy, 'https://wb.example', 'workbuddy 记忆应保留')
  assert.strictEqual(m2.codex.base, 'https://b.example')
  assert.strictEqual(m2.codex.mode, 'all-models')
})

test('resolveTarget：记忆优先；无记忆回退 config.toml+auth.json（直连）；CC 路由无记忆返回 null', () => {
  const home = tmpHome()
  assert.strictEqual(au.resolveTarget(home), null, '无配置 → null')

  seedDirect(home, 'gpt-a')
  const t1 = au.resolveTarget(home)
  assert.strictEqual(t1.base, 'https://relay.example')
  assert.strictEqual(t1.apiKey, 'sk-k')
  assert.strictEqual(t1.mode, 'gpt-only')
  assert.strictEqual(t1.curModel, 'gpt-a')

  au.rememberGateway(home, { base: 'https://mem.example', apiKey: 'sk-mem', mode: 'all-models' })
  const t2 = au.resolveTarget(home)
  assert.strictEqual(t2.base, 'https://mem.example', '记忆优先于配置反推')
  assert.strictEqual(t2.mode, 'all-models')

  // CC 本地路由且无记忆 → 无法拿到真实网关
  const home2 = tmpHome()
  codexconfig.configure(home2, { baseUrl: 'http://127.0.0.1:15721', apiKey: 'sk-k', defaultModel: 'glm-5.3' })
  assert.strictEqual(au.resolveTarget(home2), null)
})

test('autoupdateCodexOnce（gpt-only）：默认模型仍可用则保持且幂等跳过；消失则自动切换', async () => {
  const home = tmpHome()
  seedDirect(home, 'gpt-a')

  // 默认模型仍在列表 → config.toml 无变化，跳过写入
  const r1 = await au.autoupdateCodexOnce(home, { fetchImpl: fakeFetch(['gpt-a', 'gpt-b', 'other-chat', 'text-embedding-x']) })
  assert.ok(r1.ok, JSON.stringify(r1))
  assert.ok(/无变化/.test(r1.summary), '应幂等跳过: ' + r1.summary)
  const toml1 = fs.readFileSync(codexconfig.pathsFor(home).toml, 'utf8')
  assert.ok(toml1.includes('model = "gpt-a"'))

  // 默认模型下线 → 切到列表首个 GPT 系；embedding 被剔除
  const r2 = await au.autoupdateCodexOnce(home, { fetchImpl: fakeFetch(['gpt-b', 'other-chat', 'text-embedding-x']) })
  assert.ok(r2.ok, JSON.stringify(r2))
  assert.ok(/gpt-b/.test(r2.summary), '应切换默认模型: ' + r2.summary)
  const toml2 = fs.readFileSync(codexconfig.pathsFor(home).toml, 'utf8')
  assert.ok(toml2.includes('model = "gpt-b"'), 'config.toml 应更新默认模型')
})

function stubCC(calls, installed = true) {
  return {
    detectCC: () => ({ installed }),
    ensureReady: async () => {
      calls.push('ensureReady')
      return { exePath: '/tmp/cc-switch-stub', installed: true, initialized: false }
    },
    configureProvider: (args) => {
      calls.push(['configureProvider', args])
      return { providerId: 'pid-1', note: 'ok', settingsNote: 'ok', models: args.models.length }
    },
    launchCC: (exePath) => calls.push(['launchCC', exePath]),
  }
}

test('autoupdateCodexOnce（all-models）：刷新 cc-switch 目录；集合无变化跳过；未安装跳过', async () => {
  const home = tmpHome()
  au.rememberGateway(home, { base: 'https://relay.example', apiKey: 'sk-k', mode: 'all-models' })
  seedDirect(home, 'glm-5.3')
  codexconfig.configure(home, { baseUrl: 'http://127.0.0.1:15721', apiKey: 'sk-k', defaultModel: 'glm-5.3' })

  const calls = []
  const cc = stubCC(calls)
  const r1 = await au.autoupdateCodexOnce(home, { fetchImpl: fakeFetch(['glm-5.3', 'kimi-x', 'text-embedding-x']), ccswitchApi: cc })
  assert.ok(r1.ok, JSON.stringify(r1))
  const cp = calls.find((c) => Array.isArray(c) && c[0] === 'configureProvider')
  assert.ok(cp, '应调用 configureProvider')
  assert.strictEqual(cp[1].relay, 'https://relay.example', '应写入真实中转地址（非本地路由）')
  assert.strictEqual(cp[1].defaultModel, 'glm-5.3', '默认模型仍可用则保持')
  assert.strictEqual(cp[1].models.length, 2, 'embedding 应被剔除')
  assert.ok(calls.some((c) => c === 'ensureReady'), '应先 ensureReady（停进程兜底）')
  assert.ok(calls.some((c) => Array.isArray(c) && c[0] === 'launchCC'), '写完应拉起 cc-switch')

  // 集合无变化 → 跳过（不再调用 configureProvider）
  const calls2 = []
  const r2 = await au.autoupdateCodexOnce(home, { fetchImpl: fakeFetch(['glm-5.3', 'kimi-x']), ccswitchApi: stubCC(calls2) })
  assert.ok(r2.ok)
  assert.ok(/跳过/.test(r2.summary))
  assert.strictEqual(calls2.filter((c) => Array.isArray(c) && c[0] === 'configureProvider').length, 0, '无变化不应重写')

  // cc-switch 未安装 → 可读原因跳过
  const home3 = tmpHome()
  au.rememberGateway(home3, { base: 'https://relay.example', apiKey: 'sk-k', mode: 'all-models' })
  const r3 = await au.autoupdateCodexOnce(home3, { fetchImpl: fakeFetch(['glm-5.3']), ccswitchApi: stubCC([], false) })
  assert.strictEqual(r3.reason, 'no-ccswitch')
})

test('buildAutoupdatePlist：--autoupdate-codex + 双 WatchPaths + 日志路径', () => {
  const xml = au.buildAutoupdatePlist({
    exePath: '/Applications/TriConfig.app/Contents/MacOS/TriConfig',
    logFile: '/Users/u/.triconfig/logs/autoupdate-codex.log',
    watchPaths: ['/Users/u/.codex/sessions', '/Users/u/.codex/history.jsonl'],
    label: au.LABEL,
    extraArgs: ['--autoupdate-codex'],
  })
  assert.ok(xml.includes('<string>--autoupdate-codex</string>'))
  assert.ok(xml.includes('/Users/u/.codex/sessions'))
  assert.ok(xml.includes('/Users/u/.codex/history.jsonl'))
  assert.ok(xml.includes(au.LABEL))
  assert.ok(xml.includes('autoupdate-codex.log'))
})

test('install（darwin 桩）：plist 落盘 + launchctl load', () => {
  if (process.platform !== 'darwin') return
  const home = tmpHome()
  const calls = []
  const msg = au.install(home, {
    exePath: '/Applications/TriConfig.app/Contents/MacOS/TriConfig',
    args: ['--autoupdate-codex'],
    run: (f, a) => calls.push([f, a]),
  })
  assert.ok(/Codex/.test(msg))
  const xml = fs.readFileSync(au.plistPathOf(home), 'utf8')
  assert.ok(xml.includes('--autoupdate-codex'))
  assert.ok(xml.includes('.codex/sessions'))
  assert.ok(calls.some((c) => c[0] === '/bin/launchctl' && c[1][0] === 'load'))
})

test('buildWinSchtasksArgs：Codex 计划任务参数', () => {
  const args = au.buildWinSchtasksArgs(['C:\\Tools\\TriConfig.exe', '--autoupdate-codex'])
  assert.strictEqual(args[0], 'create')
  assert.ok(args[args.indexOf('/tn') + 1].includes('Codex'))
  assert.ok(args[args.indexOf('/tr') + 1].includes('--autoupdate-codex'))
  assert.strictEqual(args[args.indexOf('/sc') + 1], 'onlogon')
})
