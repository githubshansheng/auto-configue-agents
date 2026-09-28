// WorkBuddy 模型自动更新单测：网关反推、幂等同步、plist/计划任务生成。
'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const au = require('../src/engine/workbuddyautoupdate')
const wb = require('../src/engine/workbuddy')

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-au-'))
}

function seedModelsJSON(home) {
  fs.mkdirSync(path.join(home, '.workbuddy'), { recursive: true })
  wb.atomicWrite(
    wb.modelsPath(home),
    JSON.stringify(
      [
        { id: 'old-1', name: 'old-1', url: 'https://ai.heigh.vip/v1/chat/completions', apiKey: 'sk-relay-1', maxInputTokens: 300000 },
        { id: 'foreign-manual', name: '手工条目', url: 'https://other.example/v1/chat/completions', apiKey: 'sk-other' },
      ],
      null,
      2
    ) + '\n'
  )
}

function fakeFetch(ids) {
  return async () => ids
}

test('detectGateway：从 models.json 反推 base+apiKey；无条目返回 null', () => {
  const home = tmpHome()
  assert.strictEqual(au.detectGateway(home), null)
  seedModelsJSON(home)
  const gw = au.detectGateway(home)
  assert.ok(gw)
  assert.strictEqual(gw.base, 'https://ai.heigh.vip')
  assert.strictEqual(gw.apiKey, 'sk-relay-1')
})

test('autoupdateOnce：拉取+过滤+合并幂等；白名单与手工条目处理正确', async () => {
  const home = tmpHome()
  seedModelsJSON(home)
  au.rememberGateway(home, 'https://ai.heigh.vip') // 主流程写入后总会记忆（多网关并存防误判）
  const ids = ['gpt-5.6-test', 'glm-5.3', 'text-embedding-x', 'new-model']

  const r1 = await au.autoupdateOnce(home, { fetchImpl: fakeFetch(ids) })
  assert.ok(r1.ok, '第一次同步应成功: ' + JSON.stringify(r1))

  const list = wb.loadEntries(wb.modelsPath(home))
  const byID = new Map(list.map((m) => [m.id, m]))
  // 新模型写入且字段与主流程一致
  const nm = byID.get('new-model')
  assert.ok(nm, '新模型应写入')
  assert.strictEqual(nm.url, 'https://ai.heigh.vip/v1/chat/completions')
  assert.strictEqual(nm.apiKey, 'sk-relay-1')
  assert.strictEqual(nm.maxInputTokens, 300000)
  assert.strictEqual(nm.reasoning.defaultEffort, 'xhigh', '思考默认 xhigh（2026-09-26 统一）')
  assert.strictEqual(nm.maxOutputTokens, 131072, '未知模型兜底 131072')
  // embedding 被白名单剔除
  assert.ok(!byID.has('text-embedding-x'), 'embedding 不应写入')
  // 同网关旧条目 old-1 不在最新列表 → 视为已下线清除（对齐旧脚本 is_ours 重建语义）；
  // 异网关手工条目原样保留
  assert.ok(!byID.has('old-1'), '同网关已下线条目应清除')
  assert.ok(byID.has('foreign-manual'), '异网关手工条目应保留')

  // 幂等：再跑一次不增不减
  const r2 = await au.autoupdateOnce(home, { fetchImpl: fakeFetch(ids) })
  assert.ok(r2.ok)
  const list2 = wb.loadEntries(wb.modelsPath(home))
  assert.strictEqual(list2.length, list.length, '幂等：条目数不变')
  const perms = fs.statSync(wb.modelsPath(home)).mode & 0o777
  assert.strictEqual(perms, 0o600, '包含 Key 的文件应 chmod 600')
})

test('detectGateway：记忆优先于多数派（多网关并存不误判）', () => {
  const home = tmpHome()
  fs.mkdirSync(path.join(home, '.workbuddy'), { recursive: true })
  wb.atomicWrite(
    wb.modelsPath(home),
    JSON.stringify([
      { id: 'foreign-1', url: 'https://other.example/v1/chat/completions', apiKey: 'sk-other' },
      { id: 'main-1', url: 'https://ai.heigh.vip/v1/chat/completions', apiKey: 'sk-main' },
    ]) + '\n'
  )
  // 并列（1:1）时无记忆 → 多数派回退取首个插入组；有记忆 → 精确命中主网关
  au.rememberGateway(home, 'https://ai.heigh.vip')
  const gw = au.detectGateway(home)
  assert.strictEqual(gw.base, 'https://ai.heigh.vip')
  assert.strictEqual(gw.apiKey, 'sk-main')
})

test('autoupdateOnce：无网关条目与拉取失败给出可读原因', async () => {
  const home = tmpHome()
  const r1 = await au.autoupdateOnce(home, { fetchImpl: fakeFetch(['m1']) })
  assert.strictEqual(r1.reason, 'no-gateway')

  seedModelsJSON(home)
  const r2 = await au.autoupdateOnce(home, {
    fetchImpl: async () => {
      throw new Error('HTTP 401')
    },
  })
  assert.strictEqual(r2.reason, 'fetch-failed')
  assert.ok(/401/.test(r2.summary))
})

test('buildAutoupdatePlist：WatchPaths + 自身调用 + 日志路径', () => {
  const xml = au.buildAutoupdatePlist({
    exePath: '/Applications/TriConfig.app/Contents/MacOS/TriConfig',
    logFile: '/Users/u/.workbuddy/logs/autoupdate-models.log',
    watchFile: '/Users/u/.workbuddy/last-launch.json',
    label: au.LABEL,
  })
  assert.ok(xml.includes('<string>--autoupdate-workbuddy</string>'), '应带 headless 参数')
  assert.ok(xml.includes('/Users/u/.workbuddy/last-launch.json'), '应监听 WorkBuddy 启动标记')
  assert.ok(xml.includes('<key>WatchPaths</key>'))
  assert.ok(xml.includes('autoupdate-models.log'))
  assert.ok(xml.includes('<false/>'), 'RunAtLoad=false')
})

test('install（darwin 桩）：plist 落盘 + launchctl load + 额外参数拼接', () => {
  if (process.platform !== 'darwin') return
  const home = tmpHome()
  const calls = []
  const msg = au.install(home, {
    exePath: '/Applications/TriConfig.app/Contents/MacOS/TriConfig',
    args: ['--autoupdate-workbuddy'],
    run: (f, a) => calls.push([f, a]),
  })
  assert.ok(/LaunchAgent/.test(msg))
  const plist = au.plistPathOf(home)
  const xml = fs.readFileSync(plist, 'utf8')
  assert.ok(xml.includes('/Applications/TriConfig.app/Contents/MacOS/TriConfig'))
  assert.ok(xml.includes('--autoupdate-workbuddy'))
  assert.ok(calls.some((c) => c[0] === '/bin/launchctl' && c[1][0] === 'load'))
})

test('buildWinSchtasksArgs：计划任务参数与转义', () => {
  const args = au.buildWinSchtasksArgs(['C:\\Program Files\\TriConfig\\TriConfig.exe', '--autoupdate-workbuddy'])
  const i = args.indexOf('/tr')
  assert.strictEqual(args[0], 'create')
  assert.ok(args[i + 1].startsWith('"C:\\Program Files\\TriConfig\\TriConfig.exe"'), '含空格路径应加引号: ' + args[i + 1])
  assert.ok(args[i + 1].includes('--autoupdate-workbuddy'))
  assert.strictEqual(args[args.indexOf('/sc') + 1], 'onlogon')
})

test('status（darwin）：未安装与已安装状态', () => {
  if (process.platform !== 'darwin') return
  const home = tmpHome()
  assert.strictEqual(au.status(home).installed, false)
  fs.mkdirSync(path.dirname(au.plistPathOf(home)), { recursive: true })
  fs.writeFileSync(au.plistPathOf(home), '<plist/>')
  assert.strictEqual(au.status(home).installed, true)
})
