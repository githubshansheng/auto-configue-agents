// hermes 目标测试：config.yaml 原位编辑的正确性与安全性。
// 核心风险点是整文件重写毁掉用户配置——用带注释的 fixture 严格断言「只动该动的行」。
'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const hermes = require('../src/engine/hermes')
const registry = require('../src/engine/registry')

// 模拟真实 config.yaml：带大量注释 + 生效 model 段 + 后续其他段
const FIXTURE = `# Hermes Configuration
# =============================================================================
# Model Configuration
# =============================================================================
model:
  # Default model to use (can be overridden with --model flag)
  # Both "default" and "model" work as the key name here.
  default: "anthropic/claude-opus-4.6"

  # Inference provider selection:
  #   "auto"         - Auto-detect from credentials (default)
  #   "custom"       - Any other OpenAI-compatible endpoint. Set base_url below.
  # Can also be overridden for a single invocation with the --provider flag.
  provider: "auto"

  # API configuration (falls back to OPENROUTER_API_KEY env var)
  # api_key: "your-key-here"  # Uncomment to set here instead of .env
  base_url: "https://openrouter.ai/api/v1"

  # Stream API responses from the provider (default: true).
  # streaming: true

# =============================================================================
# Agent Configuration
# =============================================================================
agent:
  name: "my-agent"
  workspace: "/tmp/ws"

gateway:
  platform: "telegram"
`

function mkHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tiancai-hermes-'))
  fs.mkdirSync(path.join(home, '.hermes'), { recursive: true })
  return home
}

function writeFixture(home) {
  fs.writeFileSync(hermes.configPath(home), FIXTURE)
}

const CFG = { baseUrl: 'https://ai.heigh.vip', apiKey: 'sk-test-abc123', defaultModel: 'glm-5.3-flash' }

test('applyEdits：三字段生效 + default 行绝不触碰 + 注释与其他段零改动', () => {
  const home = mkHome()
  writeFixture(home)
  hermes.configure(home, CFG)
  const out = fs.readFileSync(hermes.configPath(home), 'utf8')
  // 生效字段（服务提供方三件套）
  assert.ok(out.includes('  provider: "custom"'), out)
  assert.ok(out.includes('  base_url: "https://ai.heigh.vip/v1"'), out)
  assert.ok(/^  api_key: "sk-test-abc123"$/m.test(out), out)
  // default 行原样保留（工具绝不代选模型，用户在 hermes GUI 刷新模型后自选）
  assert.ok(out.includes('  default: "anthropic/claude-opus-4.6"'), 'default 行必须原样保留')
  // 注释行保留（api_key 原注释行被激活，其余注释原样）
  assert.ok(out.includes('#   "auto"         - Auto-detect from credentials (default)'), 'provider 注释保留')
  assert.ok(out.includes('# streaming: true'), '段尾注释保留')
  assert.ok(out.includes('# API configuration (falls back to OPENROUTER_API_KEY env var)'), 'api_key 上方注释保留')
  // 其他段零改动
  assert.ok(out.includes('agent:\n  name: "my-agent"\n  workspace: "/tmp/ws"'), 'agent 段原样')
  assert.ok(out.includes('gateway:\n  platform: "telegram"'), 'gateway 段原样')
  // 旧 base_url 清除
  assert.ok(!out.includes('openrouter.ai'), '旧 base_url 清除')
  assert.ok(!out.includes('glm-5.3-flash'), '工具绝不写入 default 模型')
})

test('幂等：重跑一次产物逐字节一致', () => {
  const home = mkHome()
  writeFixture(home)
  hermes.configure(home, CFG)
  const a = fs.readFileSync(hermes.configPath(home), 'utf8')
  hermes.configure(home, CFG)
  const b = fs.readFileSync(hermes.configPath(home), 'utf8')
  assert.strictEqual(b, a)
})

test('已配置 api_key 的 config：直接替换不重复插入', () => {
  const home = mkHome()
  writeFixture(home)
  hermes.configure(home, CFG)
  hermes.configure(home, { ...CFG, apiKey: 'sk-new-key-456' })
  const out = fs.readFileSync(hermes.configPath(home), 'utf8')
  assert.ok(out.includes('api_key: "sk-new-key-456"'))
  assert.strictEqual((out.match(/api_key: "sk-new-key-456"/g) || []).length, 1, '不重复插入')
  assert.ok(!out.includes('sk-test-abc123'), '旧 key 清除')
})

test('default 行为注释态（用户从未选过模型）时：三字段写入，注释不动', () => {
  const home = mkHome()
  // fixture 中 default 是未注释生效行；改成注释态模拟「用户从未在 hermes 选过模型」
  fs.writeFileSync(hermes.configPath(home), FIXTURE.replace('  default: "anthropic/claude-opus-4.6"', '  # default: "anthropic/claude-opus-4.6"'))
  hermes.configure(home, CFG)
  const out = fs.readFileSync(hermes.configPath(home), 'utf8')
  assert.ok(out.includes('  provider: "custom"'), out)
  assert.ok(out.includes('  base_url: "https://ai.heigh.vip/v1"'), out)
  // 注释态 default 保持注释，绝不被激活或改写
  assert.ok(out.includes('  # default: "anthropic/claude-opus-4.6"'), '注释态 default 保持注释')
  assert.ok(!/^  default:/m.test(out), '不得产生未注释 default 行')
})

test('verify：读回断言通过 + 探针桩成功', () => {
  const home = mkHome()
  writeFixture(home)
  hermes.configure(home, CFG)
  const r = hermes.verify(home, CFG, { runProbe: () => ({ ok: true, detail: 'HTTP 200' }) })
  assert.ok(r.ok, r.message)
  assert.ok(r.message.includes('端到端'))
})

test('verify：无 CLI 时用注入探针校验（--model 显式指定的设计约定）', () => {
  const home = mkHome()
  writeFixture(home)
  hermes.configure(home, CFG)
  // runProbe 桩模拟真实探针行为：config 无 default，探针必须用 --model 显式指定
  let probeArg = ''
  const r = hermes.verify(home, CFG, {
    runProbe: (h, c) => {
      probeArg = c.defaultModel || ''
      return { ok: !!probeArg, detail: '--model ' + probeArg }
    },
  })
  assert.ok(r.ok, r.message)
  assert.strictEqual(probeArg, 'glm-5.3-flash', '探针用 cfg.defaultModel 显式指定模型')
})

test('verify：字段被外部改动 → fail', () => {
  const home = mkHome()
  writeFixture(home)
  hermes.configure(home, CFG)
  const p = hermes.configPath(home)
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('provider: "custom"', 'provider: "auto"'))
  const r = hermes.verify(home, CFG, { runProbe: () => ({ ok: true, detail: 'x' }) })
  assert.ok(!r.ok)
  assert.ok(r.message.includes('provider'), r.message)
})

test('verify：探针桩失败 → fail 且携带原因', () => {
  const home = mkHome()
  writeFixture(home)
  hermes.configure(home, CFG)
  const r = hermes.verify(home, CFG, { runProbe: () => ({ ok: false, message: '端到端调用失败：boom' }) })
  assert.ok(!r.ok)
  assert.ok(r.message.includes('boom'))
})

test('detect：未安装 / 已配置 custom / 未配置三态', () => {
  const none = hermes.detect(mkHome())
  assert.strictEqual(none.installed, false)
  const home = mkHome()
  writeFixture(home)
  const fresh = hermes.detect(home)
  assert.strictEqual(fresh.installed, true)
  assert.strictEqual(fresh.configured, false)
  hermes.configure(home, CFG)
  const done = hermes.detect(home)
  assert.strictEqual(done.configured, true)
  assert.ok(done.detail.includes('ai.heigh.vip'))
})

test('config 无顶层 model: 段 → configure 拒绝盲写', () => {
  const home = mkHome()
  fs.writeFileSync(hermes.configPath(home), 'agent:\n  name: "x"\n')
  assert.throws(() => hermes.configure(home, CFG), /model: 段|结构异常/)
})

test('设计约定：hermes 直连第三方 api，绝不指向 cc-switch 本地路由', () => {
  const home = mkHome()
  writeFixture(home)
  hermes.configure(home, CFG)
  const out = fs.readFileSync(hermes.configPath(home), 'utf8')
  assert.ok(!out.includes('127.0.0.1:15721'), '不得引用 cc-switch 本地路由端口')
  assert.ok(out.includes('base_url: "https://ai.heigh.vip/v1"'), '必须直连中转站')
  assert.strictEqual(hermes.normalizeBase('https://x.example'), 'https://x.example/v1', 'normalizeBase 恒拼 /v1（chat/completions 端点）')
})

test('registry 集成：hermes 目标可发现且 detect 返回 id', () => {
  const t = registry.byID('hermes')
  assert.ok(t, 'byID 应命中 hermes')
  assert.strictEqual(t.displayName, 'Hermes')
  const dr = t.detect(mkHome())
  assert.strictEqual(dr.id, 'hermes')
  assert.strictEqual(dr.displayName, 'Hermes')
  // plan/backup/configure/verify/rollback 接口齐全
  for (const k of ['plan', 'backup', 'configure', 'verify', 'rollback']) {
    assert.strictEqual(typeof t[k], 'function', k + ' 应为函数')
  }
  assert.strictEqual(t.autoupdate, undefined, '未适配自动更新，不应有 autoupdate 字段')
})

test('plan：diff 报告三字段旧值→新值（不含 default），api_key 脱敏', () => {
  const home = mkHome()
  writeFixture(home)
  const items = hermes.plan(home, CFG)
  assert.strictEqual(items.length, 1)
  const s = items[0].summary
  assert.ok(s.includes('provider'), s)
  assert.ok(s.includes('base_url'), s)
  assert.ok(s.includes('sk-tes***'), 'key 脱敏：' + s)
  assert.ok(!s.includes('sk-test-abc123'), '完整 key 不出现在 diff：' + s)
  // diff 结构里绝不含 default 字段（文案中说明「不动 default」允许出现）
  const diffKeys = items[0].diff.map((d) => d.key)
  assert.ok(!diffKeys.includes('default'), 'diff 绝不涉及 default 字段：' + diffKeys.join(','))
  assert.deepStrictEqual(diffKeys.sort(), ['api_key', 'base_url', 'provider'])
})

test('设计约定：hermes 只配置服务提供方，模型全量交给 hermes 刷新获取', () => {
  const home = mkHome()
  writeFixture(home)
  hermes.configure(home, CFG)
  const out = fs.readFileSync(hermes.configPath(home), 'utf8')
  assert.ok(out.includes('base_url: "https://ai.heigh.vip/v1"'), '必须直连中转站')
  assert.strictEqual(hermes.normalizeBase('https://x.example'), 'https://x.example/v1', 'normalizeBase 恒拼 /v1（chat/completions 端点）')
  // editPlan 只含三件套，绝不含 default
  const planKeys = Object.keys(hermes.editPlan(CFG))
  assert.deepStrictEqual(planKeys.sort(), ['api_key', 'base_url', 'provider'], 'editPlan 仅三字段')
})

test('restartGatewayIfRunning：无 gateway.pid / 无 cli 均跳过', () => {
  const home = mkHome()
  assert.ok(hermes.restartGatewayIfRunning(home, '').includes('跳过'))
  assert.ok(hermes.restartGatewayIfRunning(home, '/bin/true').includes('gateway 未在运行'))
  // gateway.pid 存在但无 cli → 仍跳过（不产生副作用）
  fs.writeFileSync(path.join(home, '.hermes', 'gateway.pid'), '123\n')
  assert.ok(hermes.restartGatewayIfRunning(home, '').includes('跳过'))
})
