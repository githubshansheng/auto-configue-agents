// 与原版脚本的对比回归测试（mac 环境验证核心）：
// 1) WorkBuddy models.json：同一输入分别经「原版合并逻辑（python3 内联，提取自
//    workbuddy-model/workbuddy_autoupdate_models.sh 的 PYEOF 核心段）」与「TriConfig 引擎」，
//    断言产出条目 schema 字段级一致（id/name/url/apiKey/上下文/输出上限/思考六档/能力开关）。
// 2) Codex config.toml：TriConfig buildTOML 覆盖原版 ccswitch-codex-setup takeoverCodexConfig
//    的全部硬保证（15721/v1、wire_api=responses、model/review_model、思考档位、上下文窗口、env_key）。
//    注：仅 gpt-only 直连链路保留 env_key=TIANCAICONFIG_API_KEY；cc-switch 链路不写 env_key
//    （投影后 requires_openai_auth=true 走 auth.json 鉴权，写 env_key 会让 GUI 必报 Missing env）。
// 3) cc-switch 数据库：TriConfig configureProvider 覆盖原版 db.go 的全部关键字段。
'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const au = require('../src/engine/workbuddyautoupdate')
const wb = require('../src/engine/workbuddy')
const { buildTOML } = require('../src/engine/toml')
const cc = require('../src/engine/ccswitch')

const RELAY = 'https://ai.heigh.vip'
const KEY = 'sk-compare-test'
const MODELS = ['glm-5.3', 'gpt-5.6-sol', 'deepseek-v4-pro', 'gemini-3.6-flash', 'grok-4.7', 'text-embedding-x', 'codex-auto-review']

// 原版合并逻辑（1:1 提取自旧脚本 PYEOF 段；保留 OUTPUT_CAPS/能力判定/重建语义原貌）
const LEGACY_PY = `
import json, os, re, sys
path, fetch, base, apikey = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
wl_expl = {'codex-auto-review', 'gpt-5.4-mini'}
wl_re = r'(embedding|image|whisper|tts|dall-e|moderation|rerank)|^(codex-auto-review|gpt-5\\.4-mini)$'
full_url = base + '/v1/chat/completions'
def is_whitelisted(mid):
    if mid in wl_expl: return True
    return bool(re.search(wl_re, mid.lower()))
remote_all = sorted(m['id'] for m in json.load(open(fetch))['data'])
skipped = [m for m in remote_all if is_whitelisted(m)]
remote = [m for m in remote_all if not is_whitelisted(m)]
existing = []
if os.path.exists(path):
    raw = open(path, encoding='utf-8').read().strip()
    if raw:
        p = json.loads(raw)
        existing = p if isinstance(p, list) else p.get('models', [])
def is_ours(m):
    if not isinstance(m, dict): return False
    u = str(m.get('url', ''))
    return ('heigh.vip' in u) or (str(m.get('id','')) in remote)
kept = [m for m in existing if isinstance(m, dict) and not is_ours(m)]
ALL_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"]
def caps(mid):
    e = {"supportsToolCall": True, "supportsImages": True, "supportsReasoning": True}
    if 'embedding' in mid or mid.startswith('gpt-image'):
        e["supportsToolCall"] = False
        e["supportsReasoning"] = False
    return e
UNIFORM_INPUT = 300000
OUTPUT_CAPS = {
    'deepseek-v4-pro': 393216, 'deepseek-v4.1-flash': 393216,
    'gemini-3.6-flash': 65536, 'gemini-3.7-flash': 65536,
    'glm-5.3': 131072, 'glm-5.3-flash': 131072,
    'grok-4.6': 131072, 'grok-4.7': 131072, 'minimax-m3': 131072,
    'gpt-image-2': 8192, 'qwen3.7-text-embedding': 8192,
}
def out_cap(mid):
    if mid in OUTPUT_CAPS: return OUTPUT_CAPS[mid]
    l = mid.lower()
    if 'embedding' in l or 'image' in l: return 8192
    if l.startswith('gpt-') or 'codex' in l: return 128000
    if 'deepseek' in l: return 393216
    if 'gemini' in l: return 65536
    if 'glm' in l: return 131072
    if 'grok' in l: return 131072
    if 'minimax' in l: return 131072
    return 131072
new_entries = []
for mid in remote:
    entry = {'id': mid, 'name': mid, 'url': full_url, 'apiKey': apikey,
             'maxInputTokens': UNIFORM_INPUT, 'maxOutputTokens': out_cap(mid)}
    entry.update(caps(mid))
    if entry['supportsReasoning']:
        entry['reasoning_effort'] = 'xhigh'
        entry['reasoning'] = {'supportedEfforts': ALL_EFFORTS, 'defaultEffort': 'xhigh',
                              'effort': 'xhigh', 'canDisableThinking': False}
    new_entries.append(entry)
merged = kept + new_entries
tmp = path + '.py.tmp'
with open(tmp, 'w', encoding='utf-8') as f:
    json.dump(merged, f, ensure_ascii=False, indent=2)
os.replace(tmp, path)
print('OK added=%d total=%d skipped=%d' % (len(new_entries), len(merged), len(skipped)))
`

function seedForeignAndRetired(home) {
  fs.mkdirSync(path.join(home, '.workbuddy'), { recursive: true })
  wb.atomicWrite(
    wb.modelsPath(home),
    JSON.stringify([
      { id: 'foreign-manual', name: '手工条目', url: 'https://other.example/v1/chat/completions', apiKey: 'sk-other', maxInputTokens: 100000 },
      { id: 'retired-gateway-model', name: 'retired-gateway-model', url: RELAY + '/v1/chat/completions', apiKey: KEY, maxInputTokens: 300000 },
    ]) + '\n'
  )
}

// python 探测：优先 managed Python；/usr/bin/python3 可能被 Xcode license 拦截。
// 注：原版脚本硬依赖 python3+curl，在这类机器上直接失败；TriConfig 引擎纯 Node 零依赖。
const PY_CANDIDATES = [
  '/Users/luolang/.workbuddy/binaries/python/versions/3.13.12/bin/python3',
  '/usr/bin/python3',
]
function workingPython() {
  for (const p of PY_CANDIDATES) {
    try {
      execFileSync(p, ['-c', 'print(1)'], { stdio: 'ignore' })
      return p
    } catch {}
  }
  return ''
}
const PY = workingPython()

test('对比 WorkBuddy：TriConfig 引擎 vs 原版 python 合并逻辑（同输入同输出）', { skip: !PY && '无可用的 python3' }, async (t) => {
  const fetchPath = path.join(os.tmpdir(), 'triconfig-cmp-fetch-' + Date.now() + '.json')
  fs.writeFileSync(fetchPath, JSON.stringify({ data: MODELS.map((id) => ({ id })) }))
  t.after(() => fs.unlinkSync(fetchPath))

  // A：原版逻辑
  const homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-cmp-legacy-'))
  seedForeignAndRetired(homeA)
  const outA = execFileSync(PY, ['-c', LEGACY_PY, wb.modelsPath(homeA), fetchPath, RELAY, KEY], { encoding: 'utf8' })
  assert.ok(outA.startsWith('OK'), '原版逻辑应成功: ' + outA)

  // B：TriConfig 引擎（autoupdateOnce 与主流程共用 merge/makeEntry；主流程写入后总会记忆网关）
  const homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-cmp-tri-'))
  seedForeignAndRetired(homeB)
  au.rememberGateway(homeB, RELAY)
  const rB = await au.autoupdateOnce(homeB, { fetchImpl: async () => MODELS })
  assert.ok(rB.ok, 'TriConfig 引擎应成功: ' + JSON.stringify(rB))

  const listA = JSON.parse(fs.readFileSync(wb.modelsPath(homeA), 'utf8'))
  const listB = JSON.parse(fs.readFileSync(wb.modelsPath(homeB), 'utf8'))
  const byIDA = new Map(listA.map((m) => [m.id, m]))
  const byIDB = new Map(listB.map((m) => [m.id, m]))

  // 条目集合一致（白名单剔除 + 同网关下线清除 + 异网关保留 语义两边等价）
  assert.deepStrictEqual([...byIDA.keys()].sort(), [...byIDB.keys()].sort(), '两边条目集合应一致')
  assert.ok(byIDA.has('foreign-manual') && byIDB.has('foreign-manual'), '异网关手工条目两边都保留')
  assert.ok(!byIDA.has('retired-gateway-model') && !byIDB.has('retired-gateway-model'), '同网关已下线条目两边都清除')
  assert.ok(!byIDA.has('text-embedding-x') && !byIDB.has('text-embedding-x'), '白名单模型两边都剔除')
  assert.ok(!byIDA.has('codex-auto-review') && !byIDB.has('codex-auto-review'), '显式白名单两边都剔除')

  // 托管条目 schema 字段级一致（逐字段断言，报告差异字段名）
  const SCHEMA_FIELDS = ['name', 'url', 'apiKey', 'maxInputTokens', 'maxOutputTokens', 'supportsToolCall', 'supportsImages', 'supportsReasoning', 'reasoning_effort']
  for (const id of ['glm-5.3', 'gpt-5.6-sol', 'deepseek-v4-pro', 'gemini-3.6-flash', 'grok-4.7']) {
    const a = byIDA.get(id)
    const b = byIDB.get(id)
    assert.ok(a && b, id + ' 两边都应存在')
    const diffs = []
    for (const f of SCHEMA_FIELDS) {
      if (JSON.stringify(a[f]) !== JSON.stringify(b[f])) diffs.push(f + ': legacy=' + JSON.stringify(a[f]) + ' tri=' + JSON.stringify(b[f]))
    }
    for (const f of ['supportedEfforts', 'defaultEffort', 'effort', 'canDisableThinking']) {
      if (JSON.stringify(a.reasoning[f]) !== JSON.stringify(b.reasoning[f])) diffs.push('reasoning.' + f)
    }
    assert.strictEqual(diffs.length, 0, id + ' 字段差异：\n' + diffs.join('\n'))
    // 语义锚点抽查
    assert.strictEqual(b.maxInputTokens, 300000)
    assert.strictEqual(b.reasoning.defaultEffort, 'xhigh')
    assert.strictEqual(b.reasoning.supportedEfforts.length, 6)
  }
})

test('对比 Codex：TriConfig buildTOML 覆盖原版 takeoverCodexConfig 全部硬保证', () => {
  // all-models 模式：base 指向 cc-switch 本地路由（原版 proxy 格式 http://host:port/v1）
  const toml = buildTOML('', 'http://127.0.0.1:15721', 'gpt-5.6-sol')
  const checks = {
    'base_url 指向本地路由（原版 rewriteSection 语义）': 'base_url = "http://127.0.0.1:15721/v1"',
    'wire_api=responses（原版强制）': 'wire_api = "responses"',
    'model=默认模型（原版 setTopString）': 'model = "gpt-5.6-sol"',
    'review_model=默认模型': 'review_model = "gpt-5.6-sol"',
    '思考档位统一 xhigh（2026-09-26 用户要求）': 'model_reasoning_effort = "xhigh"',
    '上下文窗口（原版 ensureModelContextWindow）': 'model_context_window = 272000',
    'env_key（原版写入语义）': 'env_key = "TIANCAICONFIG_API_KEY"',
    'requires_openai_auth=false': 'requires_openai_auth = false',
  }
  const missing = Object.entries(checks).filter(([, v]) => !toml.includes(v))
  assert.strictEqual(missing.length, 0, '缺少硬保证：' + missing.map(([k]) => k).join('；'))
})

test('对比 cc-switch 数据库：TriConfig configureProvider 覆盖原版 db.go 全部关键字段', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-cmp-db-'))
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

  cc.configureProvider({ home, relay: RELAY, apiKey: KEY, defaultModel: 'gpt-5.6-sol', models: ['gpt-5.6-sol', 'glm-5.3'] })

  const db2 = new Database(cc.ccDBPath(home))
  const p = db2.prepare("SELECT * FROM providers WHERE name=? AND app_type='codex'").get(cc.PROVIDER_NAME)
  assert.ok(p, '供应商行存在')
  const cfg = JSON.parse(p.settings_config)
  // 原版 settings_config 三键：auth（OPENAI_API_KEY+auth_mode）/ config（TOML）/ modelCatalog
  assert.ok(cfg.auth.OPENAI_API_KEY === KEY && cfg.auth.auth_mode === 'apikey', 'auth 两键齐全')
  assert.ok(cfg.config.includes('wire_api = "responses"') && cfg.config.includes('base_url = "' + RELAY + '/v1"'), 'provider TOML 语义齐全')
  assert.ok(cfg.modelCatalog.models.every((m) => m.reasoningLevels.length === 6), 'modelCatalog 六档思考')
  // 原版 meta.apiFormat='openai_chat'（本地路由协议转换必需）
  assert.strictEqual(JSON.parse(p.meta).apiFormat, 'openai_chat')
  assert.strictEqual(p.is_current, 1, 'is_current 置位（原版语义）')
  // 原版 proxy_config：codex 行 enabled + 全局 proxy_enabled/listen 15721
  const pcx = db2.prepare("SELECT * FROM proxy_config WHERE app_type='codex'").get()
  assert.strictEqual(pcx.enabled, 1)
  assert.strictEqual(pcx.listen_port, 15721)
  // 原版 provider_endpoints：relay/v1 记录
  const ep = db2.prepare('SELECT url FROM provider_endpoints WHERE provider_id=?').all(p.id)
  assert.ok(ep.some((e) => e.url === RELAY + '/v1'), 'endpoints 应含 relay/v1')
  db2.close()
})
