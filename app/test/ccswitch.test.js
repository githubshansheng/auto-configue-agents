// cc-switch 集成单测：provider TOML 生成、SQLite 自适应写入、settings.json 同步、自启注册。
'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const cc = require('../src/engine/ccswitch')

test('buildProviderToml：与旧工具 takeover 语义对齐', () => {
  const toml = cc.buildProviderToml('https://ai.heigh.vip/', 'gpt-5.6-test')
  for (const want of [
    'model_reasoning_effort = "xhigh"',
    'model = "gpt-5.6-test"',
    'review_model = "gpt-5.6-test"',
    'model_context_window = 272000',
    'base_url = "https://ai.heigh.vip/v1"',
    'wire_api = "responses"',
    'env_key = "CODEX_CUSTOM_API_KEY"',
    'requires_openai_auth = false',
  ]) {
    assert.ok(toml.includes(want), '缺少 ' + want + '\n' + toml)
  }
})

test('insertRowAdaptive：自增 PK 跳过 / DEFAULT 省略 / NOT NULL 补零值', () => {
  const Database = require('node:sqlite').DatabaseSync
  const db = new Database(':memory:')
  db.exec('CREATE TABLE t1 (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, n INTEGER DEFAULT 5, note TEXT)')
  cc.insertRowAdaptive(db, 't1', { name: 'x' })
  const row = db.prepare('SELECT * FROM t1').get()
  assert.strictEqual(row.id, 1, '自增 PK 应自动分配')
  assert.strictEqual(row.n, 5, 'DEFAULT 列应省略并落默认值')
  assert.strictEqual(row.note, null, '可空列应为 NULL')
  db.close()
})

test('configureProvider：全新库写入 providers + proxy_config + settings.json 同步', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-cc-'))
  const Database = require('node:sqlite').DatabaseSync
  fs.mkdirSync(cc.ccDir(home), { recursive: true }) // better-sqlite3 不自动建目录
  // 模拟 cc-switch 首启建库后的最小 schema（列名与真实 cc-switch v3 对齐）
  const db = new Database(cc.ccDBPath(home))
  db.exec(`
    CREATE TABLE providers (
      id TEXT PRIMARY KEY, app_type TEXT NOT NULL, name TEXT NOT NULL,
      settings_config TEXT, website_url TEXT, notes TEXT, meta TEXT,
      is_current INTEGER DEFAULT 0, in_failover_queue INTEGER DEFAULT 0,
      cost_multiplier TEXT DEFAULT '1.0', sort_index INTEGER, created_at INTEGER
    );
    CREATE TABLE proxy_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT, app_type TEXT UNIQUE, proxy_enabled INTEGER DEFAULT 0,
      listen_address TEXT, listen_port INTEGER, enable_logging INTEGER DEFAULT 0, enabled INTEGER DEFAULT 0
    );
    CREATE TABLE provider_endpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id TEXT NOT NULL,
      app_type TEXT, url TEXT NOT NULL, added_at INTEGER
    );
  `)
  db.close()

  const result = cc.configureProvider({
    home,
    relay: 'https://ai.heigh.vip',
    apiKey: 'sk-test-key',
    defaultModel: 'gpt-5.6-test',
    models: ['gpt-5.6-test', 'glm-5.3'],
  })
  assert.ok(result.providerId, '应返回 providerId')
  assert.strictEqual(result.models, 2)
  assert.ok(/新建/.test(result.note), '全新库应新建: ' + result.note)
  assert.ok(/已同步/.test(result.settingsNote), 'settings.json 缺失时应创建并同步: ' + result.settingsNote)
  const stFresh = JSON.parse(fs.readFileSync(cc.ccSettingsPath(home), 'utf8'))
  assert.strictEqual(stFresh.currentProviderCodex, result.providerId, 'settings.json 应创建并指向新供应商（否则 cc-switch 首启导入会抢占启用状态）')

  // 落库内容断言
  const db2 = new Database(cc.ccDBPath(home))
  const p = db2.prepare("SELECT * FROM providers WHERE app_type='codex' AND name=?").get(cc.PROVIDER_NAME)
  assert.ok(p, '应存在 tiancaiConfig 供应商行')
  assert.strictEqual(p.is_current, 1, '应为当前供应商')
  const cfg = JSON.parse(p.settings_config)
  assert.strictEqual(cfg.auth.OPENAI_API_KEY, 'sk-test-key')
  assert.strictEqual(cfg.auth.auth_mode, 'apikey')
  assert.ok(cfg.config.includes('base_url = "https://ai.heigh.vip/v1"'), 'provider TOML 应指向中转站')
  assert.strictEqual(cfg.modelCatalog.models.length, 2, '模型目录应 2 条（含 reasoningLevels 六档）')
  assert.deepStrictEqual(cfg.modelCatalog.models[0].reasoningLevels, cc.REASONING_LEVELS)
  for (const m of cfg.modelCatalog.models) {
    assert.strictEqual(m.defaultReasoningLevel, cc.DEFAULT_REASONING, '每模型应显式声明默认思考量 xhigh')
  }
  const meta = JSON.parse(p.meta)
  assert.strictEqual(meta.apiFormat, 'openai_chat', '本地路由协议转换必需 apiFormat')
  const endpoints = db2.prepare('SELECT url FROM provider_endpoints WHERE provider_id=?').all(p.id)
  assert.strictEqual(endpoints.length, 1)
  assert.strictEqual(endpoints[0].url, 'https://ai.heigh.vip/v1')
  const pc = db2.prepare("SELECT * FROM proxy_config WHERE app_type='codex'").get()
  assert.strictEqual(pc.enabled, 1)
  assert.strictEqual(pc.listen_port, cc.CC_PORT)
  db2.close()

  // 幂等重跑：原地更新，不重复建行
  const again = cc.configureProvider({ home, relay: 'https://ai.heigh.vip', apiKey: 'sk-new', defaultModel: 'glm-5.3', models: ['glm-5.3'] })
  assert.ok(/原地更新/.test(again.note), '重跑应原地更新: ' + again.note)
  const db3 = new Database(cc.ccDBPath(home))
  const n = db3.prepare("SELECT COUNT(*) AS n FROM providers WHERE app_type='codex' AND name=?").get(cc.PROVIDER_NAME).n
  assert.strictEqual(n, 1, '不应重复建供应商行')
  const p2 = db3.prepare("SELECT settings_config FROM providers WHERE id=?").get(again.providerId)
  assert.ok(JSON.parse(p2.settings_config).auth.OPENAI_API_KEY === 'sk-new', 'Key 应原地更新')
  db3.close()
})

test('configureProvider：settings.json 存在时同步 currentProviderCodex', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-ccs-'))
  const Database = require('node:sqlite').DatabaseSync
  fs.mkdirSync(cc.ccDir(home), { recursive: true })
  const db = new Database(cc.ccDBPath(home))
  db.exec(`
    CREATE TABLE providers (id TEXT PRIMARY KEY, app_type TEXT NOT NULL, name TEXT NOT NULL, settings_config TEXT,
      website_url TEXT, notes TEXT, meta TEXT, is_current INTEGER DEFAULT 0, in_failover_queue INTEGER DEFAULT 0,
      cost_multiplier TEXT DEFAULT '1.0', created_at INTEGER);
    CREATE TABLE proxy_config (id INTEGER PRIMARY KEY AUTOINCREMENT, app_type TEXT UNIQUE, proxy_enabled INTEGER DEFAULT 0,
      listen_address TEXT, listen_port INTEGER, enable_logging INTEGER DEFAULT 0, enabled INTEGER DEFAULT 0);
    CREATE TABLE provider_endpoints (id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id TEXT NOT NULL, app_type TEXT, url TEXT NOT NULL, added_at INTEGER);
  `)
  db.close()
  fs.mkdirSync(cc.ccDir(home), { recursive: true })
  fs.writeFileSync(cc.ccSettingsPath(home), JSON.stringify({ someOther: 1, currentProviderCodex: 'old-id' }))

  const result = cc.configureProvider({ home, relay: 'https://r.example', apiKey: 'sk-k', defaultModel: 'm1', models: ['m1'] })
  const settings = JSON.parse(fs.readFileSync(cc.ccSettingsPath(home), 'utf8'))
  assert.strictEqual(settings.currentProviderCodex, result.providerId, 'settings.json 应同步新 providerId')
  assert.strictEqual(settings.someOther, 1, 'settings.json 其他字段应保留')
})

test('setAutostart：darwin 分支写 plist 并 launchctl load（命令注入桩）', () => {
  if (process.platform !== 'darwin') return
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-as-'))
  const calls = []
  const msg = cc.setAutostart(home, { exePath: '/Applications/CC Switch.app', enabled: true, run: (f, a) => calls.push([f, a]) })
  assert.ok(/LaunchAgent/.test(msg))
  const plist = path.join(home, 'Library', 'LaunchAgents', 'cc-switch.plist')
  assert.ok(fs.existsSync(plist), 'plist 应写入')
  const xml = fs.readFileSync(plist, 'utf8')
  assert.ok(xml.includes('/Applications/CC Switch.app'))
  assert.ok(xml.includes('RunAtLoad'))
  assert.ok(calls.some((c) => c[0] === 'launchctl' && c[1][0] === 'load'), '应 launchctl load')

  const calls2 = []
  cc.setAutostart(home, { enabled: false, run: (f, a) => calls2.push([f, a]) })
  assert.ok(!fs.existsSync(plist), '禁用后 plist 应删除')
})

test('detectCC：无安装时给出自动安装提示', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-det-'))
  // 注入空扫描目录：与机器真实安装状态（/Applications 可能有 cc-switch）隔离
  const det = cc.detectCC(home, { scanDirs: [path.join(home, 'Applications')] })
  assert.strictEqual(det.installed, false)
  assert.ok(/自动下载安装/.test(det.detail), '提示应含自动安装: ' + det.detail)
})

test('configureProvider：旧版「TriConfig 中转」行原地更新并改名（更名迁移）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-legacy-'))
  const Database = require('node:sqlite').DatabaseSync
  fs.mkdirSync(cc.ccDir(home), { recursive: true })
  const db = new Database(cc.ccDBPath(home))
  db.exec(`
    CREATE TABLE providers (id TEXT PRIMARY KEY, app_type TEXT NOT NULL, name TEXT NOT NULL, settings_config TEXT,
      website_url TEXT, notes TEXT, meta TEXT, is_current INTEGER DEFAULT 0, in_failover_queue INTEGER DEFAULT 0,
      cost_multiplier TEXT DEFAULT '1.0', created_at INTEGER);
    CREATE TABLE proxy_config (id INTEGER PRIMARY KEY AUTOINCREMENT, app_type TEXT UNIQUE, proxy_enabled INTEGER DEFAULT 0,
      listen_address TEXT, listen_port INTEGER, enable_logging INTEGER DEFAULT 0, enabled INTEGER DEFAULT 0);
    CREATE TABLE provider_endpoints (id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id TEXT NOT NULL, app_type TEXT, url TEXT NOT NULL, added_at INTEGER);
  `)
  const legacyId = 'legacy-row-id'
  db.prepare("INSERT INTO providers (id, app_type, name, settings_config, is_current) VALUES (?, 'codex', 'TriConfig 中转', ?, 1)")
    .run(legacyId, JSON.stringify({ auth: { OPENAI_API_KEY: 'sk-old', auth_mode: 'apikey' }, config: '' }))
  db.close()

  const result = cc.configureProvider({ home, relay: 'https://r.example', apiKey: 'sk-new', defaultModel: 'm1', models: ['m1'] })
  assert.strictEqual(result.providerId, legacyId, '应复用旧版供应商行（原地更新）')
  assert.ok(/原地更新/.test(result.note), '应判定为原地更新: ' + result.note)
  const db2 = new Database(cc.ccDBPath(home))
  const renamed = db2.prepare('SELECT name, is_current FROM providers WHERE id=?').get(legacyId)
  assert.strictEqual(renamed.name, cc.PROVIDER_NAME, '行名应更新为新品牌')
  assert.strictEqual(renamed.is_current, 1, '应保持启用状态')
  const n = db2.prepare("SELECT COUNT(*) AS n FROM providers WHERE app_type='codex'").get().n
  assert.strictEqual(n, 1, '不应新建重复行')
  db2.close()
})

test('schemaReady：两表齐全才判定就绪（防半初始化库）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-schema-'))
  const Database = require('node:sqlite').DatabaseSync
  fs.mkdirSync(cc.ccDir(home), { recursive: true })
  const dbPath = cc.ccDBPath(home)
  const db = new Database(dbPath)
  db.exec('CREATE TABLE providers (id TEXT PRIMARY KEY)')
  db.close()
  assert.strictEqual(cc.schemaReady(dbPath), false, '缺 proxy_config 应判定未就绪')
  const db2 = new Database(dbPath)
  db2.exec('CREATE TABLE proxy_config (id INTEGER PRIMARY KEY)')
  db2.close()
  assert.strictEqual(cc.schemaReady(dbPath), true, '两表齐全应判定就绪')
})

test('launchAndEnsureCurrent：一致即返回 / 首启导入改写后停止-校正-重启 / 无法校正抛错', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-lc-'))
  // 场景 1：启动后 settings.json 即指向 pid，直接成功
  {
    const launches = []
    cc.writeCurrentProvider(home, 'pid-1')
    const msg = await cc.launchAndEnsureCurrent('/exe/cc-switch', {
      home, pid: 'pid-1',
      launchFn: (p) => launches.push(p),
      stopFn: () => { throw new Error('不应停止进程') },
      verifyFn: () => 'pid-1',
      sleepFn: async () => {},
      probes: 2,
    })
    assert.strictEqual(launches.length, 1, '应恰好启动一次')
    assert.ok(/已指向新增配置/.test(msg), 'msg: ' + msg)
  }
  // 场景 2：首启导入把 current 改写为 default → 停止进程 → 改回 → 重启后一致
  {
    const launches = []
    let stops = 0
    let current = 'default'
    cc.writeCurrentProvider(home, 'pid-2')
    const msg = await cc.launchAndEnsureCurrent('/exe/cc-switch', {
      home, pid: 'pid-2',
      launchFn: () => launches.push(1),
      stopFn: () => { stops++; current = 'pid-2' },
      verifyFn: () => current,
      sleepFn: async () => {},
      probes: 1, attempts: 2,
    })
    assert.strictEqual(stops, 1, '应触发一次停止-校正流程')
    assert.strictEqual(cc.readCurrentProvider(home), 'pid-2', 'settings.json 应被校正回新供应商')
    assert.strictEqual(launches.length, 2, '校正后应重启')
    assert.ok(/校正/.test(msg), 'msg: ' + msg)
  }
  // 场景 3：始终无法校正 → 抛错并带当前值
  {
    await assert.rejects(
      cc.launchAndEnsureCurrent('/exe/cc-switch', {
        home, pid: 'pid-3',
        launchFn: () => {}, stopFn: () => {}, verifyFn: () => 'default',
        sleepFn: async () => {}, probes: 1, attempts: 1,
      }),
      /未能指向新增配置/
    )
  }
})

test('stopCC：优雅退出成功则不强杀', async () => {
  let alive = true
  const calls = []
  await cc.stopCC({
    isRunning: () => alive,
    zz: async () => { alive = false }, // 第一次轮询即退出
    graceful: () => calls.push('graceful'),
    force: () => calls.push('force'),
  })
  assert.deepStrictEqual(calls, ['graceful'], '进程已退不应强杀')
})

test('stopCC：优雅失败后强杀兜底', async () => {
  let alive = true
  const calls = []
  await cc.stopCC({
    isRunning: () => alive,
    zz: async () => {},
    graceful: () => { calls.push('graceful') },
    force: () => { calls.push('force'); alive = false },
  })
  assert.deepStrictEqual(calls, ['graceful', 'force'], '应先优雅后强杀')
})

test('stopCC：杀不死必须抛错（绝不带活进程写库）', async () => {
  await assert.rejects(
    cc.stopCC({
      isRunning: () => true,
      zz: async () => {},
      graceful: () => {},
      force: () => {},
    }),
    /无法结束/
  )
})

test('stopCC：未运行时跳过优雅退出（防 osascript 把未运行 app 拉起再退出）', async () => {
  const calls = []
  await cc.stopCC({
    isRunning: () => false,
    zz: async () => {},
    graceful: () => calls.push('graceful'),
    force: () => calls.push('force'),
  })
  assert.deepStrictEqual(calls, [], '未运行时不应触发任何停止动作')
})

test('macQuitAppNames：exePath 反推 bundle 真名优先，通用变体去重', () => {
  // release 真名带空格+大写（/Applications/CC Switch.app）——旧实现 quit app "cc-switch" 会 -1728
  const fromRelease = cc.macQuitAppNames('/Applications/CC Switch.app/Contents/MacOS/cc-switch')
  assert.strictEqual(fromRelease[0], 'CC Switch', '真名应排首位')
  for (const n of ['cc-switch', 'CC-Switch', 'CCSwitch']) {
    assert.ok(fromRelease.includes(n), '应包含变体 ' + n)
  }
  assert.strictEqual(new Set(fromRelease).size, fromRelease.length, '不应重复')

  const legacy = cc.macQuitAppNames('/opt/cc-switch.app/Contents/MacOS/cc-switch')
  assert.strictEqual(legacy[0], 'cc-switch', '旧名安装反推 cc-switch')
  assert.strictEqual(legacy.length, 4, '与变体去重后仍 4 个')

  assert.deepStrictEqual(
    cc.macQuitAppNames(''),
    ['CC Switch', 'cc-switch', 'CC-Switch', 'CCSwitch'],
    '无 exePath 时用通用变体'
  )
})

test('mac 进程检测模式：命中 CC Switch.app 真名变体，不误伤无关进程', { skip: process.platform !== 'darwin' }, () => {
  const { spawnSync } = require('node:child_process')
  // 用系统 grep 直接验证模式语法（不依赖本机是否装/跑 cc-switch）
  const hit = (line) =>
    spawnSync('/usr/bin/grep', ['-iE', cc.MAC_PS_PATTERN], { input: line + '\n', encoding: 'utf8' }).status === 0
  // release 真名（带空格大写）——旧模式 grep -F 'cc-switch.app/Contents/MacOS' 检测失明的元凶
  assert.ok(hit('/Applications/CC Switch.app/Contents/MacOS/cc-switch'), '真名 bundle 应命中')
  assert.ok(hit('/Applications/cc-switch.app/Contents/MacOS/cc-switch'), '旧小写名应命中')
  assert.ok(hit('/Users/x/Applications/CC-Switch.app/Contents/MacOS/main'), '连字符名+异二进制名应命中')
  assert.ok(hit('/Applications/CCSwitch.app/Contents/MacOS/anything'), '无分隔名应命中')
  // 误伤排除
  assert.ok(!hit('/Applications/Other.app/Contents/MacOS/other'), '无关 app 不应命中')
  assert.ok(!hit('/usr/bin/open -a /Applications/CC Switch.app'), 'open 启动器不应命中（否则误杀 launch 链路）')
  assert.ok(!hit('/usr/local/bin/node /x/cc-switch-helper.js'), '普通命令行含 cc-switch 字样不应命中')
})

test('mac ccPids/ccRunning：新模式在本机进程表上可执行', { skip: process.platform !== 'darwin' }, () => {
  // 只验证命令链路可跑通且返回数组（不断言具体数量：本机 cc-switch 是否在跑属环境状态）
  const pids = cc.ccPids()
  assert.ok(Array.isArray(pids), '应返回 pid 数组')
  for (const p of pids) assert.ok(Number.isInteger(p) && p > 0, 'pid 应为正整数: ' + p)
  assert.strictEqual(typeof cc.ccRunning(), 'boolean')
})
