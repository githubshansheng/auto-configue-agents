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
    'requires_openai_auth = false',
  ]) {
    assert.ok(toml.includes(want), '缺少 ' + want + '\n' + toml)
  }
  // env_key 绝不能再出现：定义了 env_key 时 Codex 硬性校验环境变量，
  // GUI（不读 shell rc）必报 Missing environment variable；鉴权统一走 auth.json
  assert.ok(!toml.includes('env_key'), 'cc-switch TOML 不应包含 env_key\n' + toml)
})

test('syncCodexModelCatalog：cc-switch 投影目录统一为默认 xhigh + 五档含 max', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tiancai-cat-'))
  try {
    const p = cc.codexCatalogPath(tmpHome)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify({
      models: [
        { slug: 'glm-5.3-flash', priority: 1005, default_reasoning_level: 'medium', supported_reasoning_levels: [
          { description: 'd-low', effort: 'low' },
          { description: 'd-medium', effort: 'medium' },
          { description: 'd-high', effort: 'high' },
          { description: 'd-xhigh', effort: 'xhigh' },
        ] },
        { slug: 'gpt-5.6-sol', priority: 1000, default_reasoning_level: 'high', supported_reasoning_levels: [] },
      ],
    }))
    const msg = cc.syncCodexModelCatalog(tmpHome)
    const cat = JSON.parse(fs.readFileSync(p, 'utf8'))
    for (const m of cat.models) {
      assert.strictEqual(m.default_reasoning_level, 'xhigh', m.slug + ' 默认思考量应为 xhigh')
      const efforts = m.supported_reasoning_levels.map((l) => l.effort)
      assert.deepStrictEqual(efforts, ['low', 'medium', 'high', 'xhigh', 'max'], m.slug + ' 档位应统一五档含 max')
      for (const l of m.supported_reasoning_levels) assert.ok(l.description, '档位描述不应为空')
    }
    assert.ok(msg.includes('2 个模型'), '消息应包含模型数：' + msg)
    // 幂等：再次执行不再变更
    const msg2 = cc.syncCodexModelCatalog(tmpHome)
    assert.ok(msg2.includes('已符合要求'), '二次执行应幂等：' + msg2)
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  }
})

test('syncCodexModelCatalog：文件不存在时跳过不创建', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tiancai-cat-'))
  try {
    const msg = cc.syncCodexModelCatalog(tmpHome)
    assert.ok(msg.includes('跳过'), '应提示跳过：' + msg)
    assert.strictEqual(fs.existsSync(cc.codexCatalogPath(tmpHome)), false, '不应创建新文件')
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true })
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
  // 注入空扫描目录：与机器真实安装状态（/Applications 可能有 cc-switch）隔离。
  // 注意：scanDirs 注入仅对 darwin 分支生效；win32 分支按 LOCALAPPDATA/APPDATA/
  // ProgramFiles 扫描真实环境，需同步改写环境变量到空目录才能隔离。
  const envKeys = ['LOCALAPPDATA', 'APPDATA', 'ProgramFiles', 'ProgramFiles(x86)']
  const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]))
  for (const k of envKeys) process.env[k] = path.join(home, 'env-empty')
  try {
    const det = cc.detectCC(home, { scanDirs: [path.join(home, 'Applications')] })
    assert.strictEqual(det.installed, false)
    assert.ok(/自动下载安装/.test(det.detail), '提示应含自动安装: ' + det.detail)
  } finally {
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
  }
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

test('parseVersion / versionAtLeast：语义化版本比较（逐段数值、缺段补零）', () => {
  assert.deepStrictEqual(cc.parseVersion('3.20.3'), [3, 20, 3])
  assert.deepStrictEqual(cc.parseVersion('v3.20.3'), [3, 20, 3])
  assert.deepStrictEqual(cc.parseVersion('3.21.0-beta.1'), [3, 21, 0], '预发布后缀截断忽略')
  assert.deepStrictEqual(cc.parseVersion('cc-switch 3.20.3 (abc123)'), [3, 20, 3], '应从混合文本提取')
  assert.deepStrictEqual(cc.parseVersion('3.20'), [3, 20])
  assert.strictEqual(cc.parseVersion(''), null)
  assert.strictEqual(cc.parseVersion('not-a-version'), null)

  assert.strictEqual(cc.versionAtLeast('3.20.3', '3.20.3'), true)
  assert.strictEqual(cc.versionAtLeast('3.20.3', '3.20.2'), true)
  assert.strictEqual(cc.versionAtLeast('3.20.3', '3.21.0'), false)
  assert.strictEqual(cc.versionAtLeast('3.20', '3.20.0'), true, '缺段按 0 补齐')
  assert.strictEqual(cc.versionAtLeast('3.20.1', '3.20'), true)
  assert.strictEqual(cc.versionAtLeast('v3.9.9', '3.10.0'), false, '逐段数值比较，不做字符串比较')
  assert.strictEqual(cc.versionAtLeast('', '3.20.3'), false)
  assert.strictEqual(cc.versionAtLeast('3.20.3', null), false)
})

test('installedCCVersion：读文件版本信息解析 x.y.z / 失败返回空（CLI 探测已证伪，Tauri GUI 不处理 --version/-V）', () => {
  // PowerShell VersionInfo 输出典型形态：版本号 + CRLF
  assert.strictEqual(
    cc.installedCCVersion('C:\\Program Files\\cc-switch\\cc-switch.exe', { run: () => '3.16.2.0\r\n' }),
    '3.16.2',
    '四段式 PE 版本截取前三段'
  )
  // 混合文本（标签行 + 版本行）仍可解析
  assert.strictEqual(
    cc.installedCCVersion('/exe/cc-switch', { run: () => 'ProductVersion\r\n3.16.2.0' }),
    '3.16.2'
  )
  assert.strictEqual(
    cc.installedCCVersion('/exe/cc-switch', { run: () => '3.21.0-beta.1+x' }),
    '3.21.0-beta.1',
    '预发布段原样返回（+ 构建段截断），比较交给 versionAtLeast'
  )
  // plutil -raw 输出（darwin 语义，同正则解析）
  assert.strictEqual(
    cc.installedCCVersion('/Applications/CC Switch.app/Contents/MacOS/cc-switch', { run: () => '3.20.3\n' }),
    '3.20.3'
  )
  // run 抛错（spawn error / 超时）→ ''
  assert.strictEqual(cc.installedCCVersion('/exe/cc-switch', { run: () => { throw new Error('boom') } }), '')
  // 输出为空 / 无版本段 → ''
  assert.strictEqual(cc.installedCCVersion('/exe/cc-switch', { run: () => '' }), '')
  assert.strictEqual(cc.installedCCVersion('/exe/cc-switch', { run: () => 'no version here' }), '')
  // 空 exePath 直接返回空（且不触发 run）
  let ran = false
  assert.strictEqual(cc.installedCCVersion('', { run: () => { ran = true; return '3.20.3' } }), '')
  assert.strictEqual(ran, false, '空 exePath 不应执行探测')
})

test('upgradeCC：落后版本 → 先停进程再覆盖安装 → 返回升级结果', async () => {
  const calls = []
  const r = await cc.upgradeCC({
    home: '/tmp/x',
    exePath: '/exe/cc-switch',
    versionOf: () => '3.19.0',
    fetchVersion: async () => '3.20.3',
    stop: async ({ exePath }) => calls.push('stop:' + exePath),
    install: async () => {
      calls.push('install')
      return { exePath: '/exe/new-cc-switch', version: '3.20.3', via: 'https://mirror/x' }
    },
  })
  assert.deepStrictEqual(calls, ['stop:/exe/cc-switch', 'install'], '覆盖安装前必须先停止旧进程（Windows 文件锁 + SQLite 写锁）')
  assert.strictEqual(r.checked, true)
  assert.strictEqual(r.upgraded, true)
  assert.strictEqual(r.exePath, '/exe/new-cc-switch')
  assert.strictEqual(r.from, '3.19.0')
  assert.strictEqual(r.to, '3.20.3')
  assert.ok(/v3\.19\.0 → v3\.20\.3/.test(r.note), 'note 应含版本跨度: ' + r.note)
})

test('upgradeCC：已是最新 / 回滚场景更高版本 / 探测失败 / 拉取失败 → 跳过且不停进程', async () => {
  const calls = []
  const stop = async () => calls.push('stop')
  const install = async () => calls.push('install')
  // 已是最新
  let r = await cc.upgradeCC({ home: '/x', exePath: '/exe', versionOf: () => '3.20.3', fetchVersion: async () => '3.20.3', stop, install })
  assert.strictEqual(r.upgraded, false)
  assert.ok(/已是最新/.test(r.note), 'note: ' + r.note)
  // 当前版本比 latest 更高（如 latest 回退到 pinned 兜底）：不降级
  r = await cc.upgradeCC({ home: '/x', exePath: '/exe', versionOf: () => '3.21.0', fetchVersion: async () => '3.20.3', stop, install })
  assert.strictEqual(r.upgraded, false)
  assert.ok(/已是最新/.test(r.note), '更高版本不应降级: ' + r.note)
  // 探测不到当前版本
  r = await cc.upgradeCC({ home: '/x', exePath: '/exe', versionOf: () => '', fetchVersion: async () => '3.20.3', stop, install })
  assert.strictEqual(r.upgraded, false)
  assert.ok(/跳过/.test(r.note), 'note: ' + r.note)
  // 最新版本号拉取失败
  r = await cc.upgradeCC({ home: '/x', exePath: '/exe', versionOf: () => '3.19.0', fetchVersion: async () => '', stop, install })
  assert.strictEqual(r.upgraded, false)
  assert.ok(/跳过/.test(r.note), 'note: ' + r.note)
  assert.deepStrictEqual(calls, [], '以上场景都不应停止进程或触发安装')
})

test('upgradeCC：停止失败中止升级 / 安装失败降级继续（均不抛错）', async () => {
  // 停止失败 → 升级中止，绝不覆盖安装
  let r = await cc.upgradeCC({
    home: '/x', exePath: '/exe',
    versionOf: () => '3.19.0', fetchVersion: async () => '3.20.3',
    stop: async () => { throw new Error('进程无法结束') },
    install: async () => { throw new Error('不应触发安装') },
  })
  assert.strictEqual(r.upgraded, false)
  assert.ok(/中止/.test(r.note) && /进程无法结束/.test(r.note), 'note: ' + r.note)
  // 安装失败 → 降级继续用旧版本
  r = await cc.upgradeCC({
    home: '/x', exePath: '/exe',
    versionOf: () => '3.19.0', fetchVersion: async () => '3.20.3',
    stop: async () => {},
    install: async () => { throw new Error('所有下载线路均失败') },
  })
  assert.strictEqual(r.upgraded, false)
  assert.strictEqual(r.current, '3.19.0')
  assert.ok(/升级失败/.test(r.note) && /所有下载线路均失败/.test(r.note), 'note: ' + r.note)
})

test('upgradeCC：缺 exePath 直接跳过 / onStage 播报升级开始', async () => {
  const r = await cc.upgradeCC({ home: '/x', versionOf: () => '3.19.0', fetchVersion: async () => '3.20.3' })
  assert.strictEqual(r.checked, false)
  assert.strictEqual(r.upgraded, false)

  const stages = []
  await cc.upgradeCC({
    home: '/x', exePath: '/exe',
    versionOf: () => '3.19.0', fetchVersion: async () => '3.20.3',
    stop: async () => {},
    install: async () => ({ exePath: '/n', version: '3.20.3', via: '' }),
    onStage: (m) => stages.push(m),
  })
  assert.ok(stages.some((s) => /v3\.19\.0 → v3\.20\.3/.test(s)), '应播报版本跨度: ' + JSON.stringify(stages))
})
