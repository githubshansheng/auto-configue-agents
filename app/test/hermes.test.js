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

// 真机可能带有用户级持久变量 HERMES_HOME（Windows 官方安装器写入）——本套件
// 所有用例必须与真实环境隔离：先记录真机值（仅供真机回归用例显式使用），
// 随即在套件内删除，让所有默认用例走 ~/.hermes 兜底（临时目录），结束时恢复。
const REAL_HERMES_HOME = process.env.HERMES_HOME
delete process.env.HERMES_HOME
test.after(() => {
  if (REAL_HERMES_HOME === undefined) delete process.env.HERMES_HOME
  else process.env.HERMES_HOME = REAL_HERMES_HOME
})

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

// —— resolveCli win32 分支（Windows 上 X_OK 不可靠、sh 不在 PATH，走 where.exe） ——

test('resolveCli：win32 候选均不存在时走 where.exe，取首个非空行', () => {
  const home = mkHome()
  let spawnCalls = 0
  const cli = hermes.resolveCli(home, {
    platform: 'win32',
    spawn: (cmd, args, o) => {
      spawnCalls++
      assert.strictEqual(cmd, 'where')
      assert.deepStrictEqual(args, ['hermes'])
      assert.strictEqual(o.windowsHide, true)
      return { stdout: 'C:\\Users\\x\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts\\hermes.exe\nother.exe\n', status: 0 }
    },
  })
  assert.strictEqual(cli, 'C:\\Users\\x\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts\\hermes.exe')
  assert.strictEqual(spawnCalls, 1)
})

test('resolveCli：win32 候选存在（AppData venv Scripts 布局）直接返回，不调 where', () => {
  const home = mkHome()
  const venvCli = path.join(home, 'AppData', 'Local', 'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe')
  fs.mkdirSync(path.dirname(venvCli), { recursive: true })
  fs.writeFileSync(venvCli, '')
  let spawnCalls = 0
  const cli = hermes.resolveCli(home, {
    platform: 'win32',
    spawn: () => {
      spawnCalls++
      return { stdout: '', status: 0 }
    },
  })
  assert.strictEqual(cli, venvCli, '命中 AppData venv Scripts 候选（真实机器实测布局）')
  assert.strictEqual(spawnCalls, 0, '候选存在时绝不调 spawn')
})

test('resolveCli：win32 where 失败（status=1）返回空串', () => {
  const home = mkHome()
  const cli = hermes.resolveCli(home, {
    platform: 'win32',
    spawn: () => ({ stdout: '', status: 1 }),
  })
  assert.strictEqual(cli, '')
})

test('resolveCli：darwin 回归——候选命中 ~/.local/bin/hermes 且不调 spawn', () => {
  const home = mkHome()
  const posixCli = path.join(home, '.local', 'bin', 'hermes')
  fs.mkdirSync(path.dirname(posixCli), { recursive: true })
  fs.writeFileSync(posixCli, '#!/bin/sh\n')
  let spawnCalls = 0
  const cli = hermes.resolveCli(home, {
    platform: 'darwin',
    spawn: () => {
      spawnCalls++
      return { stdout: '', status: 0 }
    },
  })
  assert.strictEqual(cli, posixCli)
  assert.strictEqual(spawnCalls, 0, 'darwin 候选命中时绝不调 spawn')
})

// —— hermesHome / configPath：HERMES_HOME 环境变量感知（Windows 官方安装器
// 会写用户级 HERMES_HOME，CLI 读 $HERMES_HOME/config.yaml 优先于 ~/.hermes） ——

// 保存-恢复 process.env.HERMES_HOME 的隔离执行器（try/finally 保证用例间无泄漏）
function withHermesHomeEnv(value, fn) {
  const saved = process.env.HERMES_HOME
  try {
    if (value === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = value
    return fn()
  } finally {
    if (saved === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = saved
  }
}

test('hermesHome/configPath：设 HERMES_HOME → 用其目录而非 ~/.hermes', () => {
  withHermesHomeEnv(os.tmpdir(), () => {
    const home = mkHome()
    assert.strictEqual(hermes.hermesHome(home), os.tmpdir())
    assert.strictEqual(hermes.configPath(home), path.join(os.tmpdir(), 'config.yaml'))
  })
})

test('hermesHome/configPath：未设置 HERMES_HOME → 兜底 ~/.hermes', () => {
  withHermesHomeEnv(undefined, () => {
    const home = mkHome()
    assert.strictEqual(hermes.hermesHome(home), path.join(home, '.hermes'))
    assert.strictEqual(hermes.configPath(home), path.join(home, '.hermes', 'config.yaml'))
  })
})

test('hermesHome/configPath：空串/纯空白 HERMES_HOME 视为未设置（走兜底）', () => {
  const home = mkHome()
  withHermesHomeEnv('', () => {
    assert.strictEqual(hermes.hermesHome(home), path.join(home, '.hermes'))
  })
  withHermesHomeEnv('   \t ', () => {
    assert.strictEqual(hermes.hermesHome(home), path.join(home, '.hermes'))
    assert.strictEqual(hermes.configPath(home), path.join(home, '.hermes', 'config.yaml'))
  })
})

test('hermesHome 真机回归：真机 HERMES_HOME（Windows 安装器写入）优先于 ~/.hermes', (t) => {
  if (!REAL_HERMES_HOME || !String(REAL_HERMES_HOME).trim()) {
    t.skip('本机未设置 HERMES_HOME，跳过真机回归')
    return
  }
  // 显式注入真机值（套件顶部已删除环境变量作隔离），断言真实机器 P0 缺陷的回归防线
  withHermesHomeEnv(String(REAL_HERMES_HOME).trim(), () => {
    const home = mkHome()
    assert.strictEqual(hermes.hermesHome(home), String(REAL_HERMES_HOME).trim())
    assert.strictEqual(hermes.configPath(home), path.join(String(REAL_HERMES_HOME).trim(), 'config.yaml'))
  })
})

test('HERMES_HOME 环境隔离：withHermesHomeEnv 用例后恢复原值', () => {
  const saved = process.env.HERMES_HOME
  withHermesHomeEnv('X:\\fake\\hermes', () => {})
  assert.strictEqual(process.env.HERMES_HOME, saved, '用例结束后必须恢复 HERMES_HOME')
})

// —— 行尾兼容（真机证实：用户旧工具备份的 config.yaml 是 CRLF，'\n' 切分残留
//    \r 会让 loadModelSection 的 'model:' 精确匹配失败 → 拒绝盲写） ——

// 纯 CRLF fixture：与 FIXTURE 同结构（provider/base_url 未注释、api_key 注释态、default 存在）
const CRLF_FIXTURE = FIXTURE.replace(/\n/g, '\r\n')

test('CRLF config：applyEdits/parseModelFields 正常，configure 后三件套生效且 default 原样', () => {
  const home = mkHome()
  fs.writeFileSync(hermes.configPath(home), CRLF_FIXTURE)
  // 解析层：CRLF 不再导致 'model:' 匹配失败
  const fields = hermes.parseModelFields(fs.readFileSync(hermes.configPath(home), 'utf8').split(/\r?\n/))
  assert.strictEqual(fields.provider, 'auto')
  // 写入层：configure 不再抛「未找到顶层 model: 段」
  hermes.configure(home, CFG)
  const out = fs.readFileSync(hermes.configPath(home), 'utf8')
  assert.ok(out.includes('  provider: "custom"'), out)
  assert.ok(out.includes('  base_url: "https://ai.heigh.vip/v1"'), out)
  assert.ok(/^  api_key: "sk-test-abc123"$/m.test(out), out)
  assert.ok(out.includes('  default: "anthropic/claude-opus-4.6"'), 'default 行原样保留')
})

test('CRLF 写入规范化：configure 后文件统一为 LF（与 hermes 官方 PyYAML 输出一致）', () => {
  const home = mkHome()
  fs.writeFileSync(hermes.configPath(home), CRLF_FIXTURE)
  hermes.configure(home, CFG)
  const out = fs.readFileSync(hermes.configPath(home), 'utf8')
  assert.ok(!out.includes('\r'), '写入产物必须无 \\r（CRLF 已规范化为 LF）')
})

test('混合行尾（部分 \\n 部分 \\r\\n）也能解析与配置', () => {
  const home = mkHome()
  // 手工构造：model: 行前是 LF，段内行是 CRLF，段后 agent: 行又是 LF
  const mixed = [
    '# Hermes Configuration',
    'model:',
    '  default: "anthropic/claude-opus-4.6"',
    '  provider: "auto"',
    '  # api_key: "your-key-here"',
    '  base_url: "https://openrouter.ai/api/v1"',
    'agent:',
    '  name: "my-agent"',
  ]
  const content = [
    mixed.slice(0, 2).join('\n'), // LF 部分
    mixed.slice(2, 6).join('\r\n'), // CRLF 部分
    mixed.slice(6).join('\n'), // LF 部分
  ].join('\n')
  fs.writeFileSync(hermes.configPath(home), content)
  hermes.configure(home, CFG)
  const out = fs.readFileSync(hermes.configPath(home), 'utf8')
  assert.ok(out.includes('  provider: "custom"'), out)
  assert.ok(out.includes('  base_url: "https://ai.heigh.vip/v1"'), out)
  assert.ok(/^  api_key: "sk-test-abc123"$/m.test(out), out)
  assert.ok(out.includes('  name: "my-agent"'), '后续段原样')
})
