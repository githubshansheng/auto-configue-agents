// 一键配置流水线（从 Go 引擎 1:1 移植 + 双模式扩展）：
// validate → fetch → filter → speedtest → [ccswitch] → plan → backup → write → [autoupdate] → verify → [launch]
// Codex 模型范围（codexMode）：
//   all-models = 经 cc-switch 本地路由（自动安装/配置/自启 cc-switch 本体，解除模型名限制；默认推荐）
//   gpt-only  = 直连中转站，Codex 仅配置 GPT 系模型（改配置文件方案）
// 模型自动更新按目标能力注册（registry 中 autoupdate 字段）：已适配目标默认勾选，未来新工具适配后自动纳入。
// 任一目标写入失败时，已写目标自动全量回滚。
'use strict'

const path = require('node:path')

const { normalizeBase, fetchModels, filterNonChat, speedTest, pickFastest } = require('./modelsapi')
const { all } = require('./registry')
const { persistEnvDefault } = require('./codexconfig')
const { DEFAULT_MODEL } = require('./appsettings')
const ccswitch = require('./ccswitch')
const workbuddyautoupdate = require('./workbuddyautoupdate')
const codexautoupdate = require('./codexautoupdate')

const MAX_PROBE = 12
const PROBE_CONC = 4
const PROBE_TIMEOUT_MS = 10000
const GPT_ONLY_RE = /^gpt/i
const CC_PROXY_BASE = 'http://127.0.0.1:' + ccswitch.CC_PORT

// resolveTargets 解析目标清单：显式指定的 ID 一律尊重（AC-04 自动创建）；
// 未指定时默认取全部已安装目标。两条路径都执行 detect（与 GUI 状态共用）。
function resolveTargets(home, want) {
  const out = []
  for (const t of all()) {
    const dr = t.detect(home)
    if (want && want.length > 0) {
      if (!want.includes(t.id)) continue
    } else if (!dr.installed) {
      continue
    }
    out.push(t)
  }
  return out
}

// selfLaunch 计算自动更新的自启动参数（flag = --autoupdate-workbuddy | --autoupdate-codex）：
// 打包态（默认加载 app.asar）→ [exe, flag]；
// dev 态（process.defaultApp）→ [electron, app目录, flag]。
function selfLaunch(flag) {
  const exe = process.execPath
  if (process.defaultApp) {
    return { exePath: exe, args: [path.join(__dirname, '..', '..'), flag] }
  }
  return { exePath: exe, args: [flag] }
}

async function run({ home, request, emit, signal, persistEnv, ccswitchApi, autoupdateApi, codexAuApi } = {}) {
  const pe = persistEnv === undefined ? persistEnvDefault : persistEnv
  // cc-switch / 自动更新链路可注入测试桩；生产用真实实现
  const cc = ccswitchApi || ccswitch
  const au = autoupdateApi || workbuddyautoupdate
  const auCodex = codexAuApi || codexautoupdate
  const codexMode = request.codexMode === 'gpt-only' ? 'gpt-only' : 'all-models'
  const proxyAutostart = request.proxyAutostart !== false
  // 模型自动更新开关（按目标）：request.autoUpdate = { [targetId]: bool }；
  // 已适配目标缺省即勾选（true）；旧字段 workbuddyAutoUpdate 继续兼容。
  const auWanted = (id) => {
    if (request.autoUpdate && request.autoUpdate[id] !== undefined) return !!request.autoUpdate[id]
    if (id === 'workbuddy') return request.workbuddyAutoUpdate !== false
    return true
  }

  const stage = (name, status, detail) => emit({ type: 'stage', name, status, detail: detail || '' })
  const fail = (name, msg) => {
    stage(name, 'fail', msg)
    emit({ type: 'error', message: msg })
    emit({ type: 'done', ok: false, message: msg })
  }
  const aborted = () => signal && signal.aborted

  // 1. 校验输入
  stage('validate', 'running', '')
  const base = normalizeBase(request.baseUrl)
  if (!String(request.apiKey || '').trim()) {
    fail('validate', 'API Key 不能为空')
    return
  }
  if (!/^https?:\/\//.test(base)) {
    fail('validate', '中转地址需以 http(s):// 开头')
    return
  }
  const targets = resolveTargets(home, request.targets)
  if (!targets.length) {
    fail('validate', '未选择任何可写入的目标工具')
    return
  }
  const codexSelected = targets.some((t) => t.id === 'codexcli' || t.id === 'codexdesktop')
  const wbSelected = targets.some((t) => t.id === 'workbuddy')
  stage('validate', 'ok', '目标：' + targets.map((t) => t.id).join('、') + '；Codex 模式：' + (codexMode === 'gpt-only' ? '仅 GPT 模型（直连）' : '全部模型（cc-switch 本地路由）'))

  // 2. 连接中转站并拉取模型（兼连通性测试）
  stage('fetch', 'running', '')
  let allIDs
  try {
    allIDs = await fetchModels(base, request.apiKey, signal)
  } catch (e) {
    fail('fetch', e.message)
    return
  }
  if (aborted()) return
  stage('fetch', 'ok', '连接成功，共 ' + allIDs.length + ' 个模型')

  // 3. 过滤非对话模型（WorkBuddy 用全量对话模型；Codex 按 codexMode 再过滤）
  //    其后再叠加用户勾选范围（request.checkedModels：前端模型清单勾选结果）：
  //    有交集才收窄模型池；空交集（如站点模型已变化）→ 保持全量并 warn 提示。
  stage('filter', 'running', '')
  const [keptRaw, skippedAll] = filterNonChat(allIDs)
  if (!keptRaw.length) {
    fail('filter', '中转站未返回可对话模型，请确认地址指向 OpenAI 兼容网关')
    return
  }
  let keptAll = keptRaw
  let filterDetail = '保留 ' + keptRaw.length + ' 个，剔除 ' + skippedAll.length + ' 个非对话模型'
  const scope = Array.isArray(request.checkedModels) ? request.checkedModels.map(String).filter(Boolean) : null
  let scopeMissed = false
  if (scope && scope.length > 0) {
    const inSet = new Set(scope)
    const scoped = keptRaw.filter((id) => inSet.has(id))
    if (scoped.length) {
      keptAll = scoped
      filterDetail += '；按勾选范围保留 ' + scoped.length + ' 个'
    } else {
      scopeMissed = true
      filterDetail += '；勾选范围与站点模型无交集，已回退全量'
    }
  }
  let codexKept = keptAll
  if (codexSelected && codexMode === 'gpt-only') {
    codexKept = keptAll.filter((id) => GPT_ONLY_RE.test(id))
    if (!codexKept.length) {
      fail('filter', '未发现 GPT 系模型（gpt-*）：当前中转站不提供 GPT 模型，请改用「全部模型」模式')
      return
    }
    filterDetail += '；Codex 采用 GPT 模式（' + codexKept.length + ' 个 GPT 模型）'
  }
  stage('filter', scopeMissed ? 'warn' : 'ok', filterDetail)

  // 4. 模型测速（一次测速供两种配置共用；默认模型按各自模型池选取）
  stage('speedtest', 'running', '')
  const testIDs = keptAll.slice(0, MAX_PROBE)
  const ms = await speedTest(base, request.apiKey, testIDs, {
    concurrency: PROBE_CONC,
    perTimeoutMs: PROBE_TIMEOUT_MS,
    signal,
  })
  if (aborted()) return
  emit({ type: 'models', models: ms })

  // 默认模型：用户设置的默认模型（未设置 → DEFAULT_MODEL）在模型池中则优先采用；
  // 不在池中时回退为测速最快（或列表首个），stage 提 warn 说明回退原因。
  const want = String(request.defaultModel || '').trim() || DEFAULT_MODEL
  const fastestOf = (pool) => {
    const best = pickFastest(pool)
    return best ? { id: best.id, note: best.ttftMs + 'ms' } : { id: pool[0].id, note: '测速均失败，取列表首个' }
  }
  const ttftOf = (id) => {
    const m = ms.find((x) => x.id === id)
    return m && m.ok ? m.ttftMs + 'ms' : ''
  }
  const pickWithDefault = (pool, probePool) => {
    if (pool.includes(want)) return { id: want, note: ttftOf(want) || '测速样本外', fallback: false }
    return { ...fastestOf(probePool), fallback: true }
  }
  const wbPick = pickWithDefault(keptAll, ms)
  let codexPick = wbPick
  if (codexSelected && codexMode === 'gpt-only') {
    codexPick = pickWithDefault(codexKept, ms.filter((m) => GPT_ONLY_RE.test(m.id)))
  }
  const pickDesc = (p, label) =>
    label + '默认 ' + p.id + '（' + p.note + (p.fallback ? '；' + want + ' 不在模型列表，已回退' : '·默认模型') + '）'
  const speedDetail =
    pickDesc(wbPick, 'WorkBuddy') +
    (codexSelected && codexPick.id !== wbPick.id ? '；' + pickDesc(codexPick, 'Codex') : '')
  const allFailed = !ms.some((m) => m.ok)
  const defaultMissed = wbPick.fallback || codexPick.fallback
  stage('speedtest', allFailed || defaultMissed ? 'warn' : 'ok', speedDetail + (allFailed ? '（写入仍会进行，请检查网络）' : ''))

  const cfgWB = { baseUrl: base, apiKey: request.apiKey, defaultModel: wbPick.id, models: ms }
  let cfgCodex = { baseUrl: base, apiKey: request.apiKey, defaultModel: codexPick.id, models: ms }

  // 4.5 cc-switch 本地路由（all-models 且勾选了 Codex 目标时）
  let ccExe = ''
  let ccPid = ''
  let didCC = false
  if (codexSelected && codexMode === 'all-models') {
    stage('ccswitch', 'running', '')
    try {
      const ready = await cc.ensureReady({
        home,
        onStage: (msg) => emit({ type: 'stage', name: 'ccswitch', status: 'running', detail: msg }),
      })
      ccExe = ready.exePath
      const cp = cc.configureProvider({
        home,
        relay: base,
        apiKey: request.apiKey,
        defaultModel: cfgCodex.defaultModel,
        models: keptAll,
      })
      ccPid = cp.providerId
      let autoMsg = ''
      if (proxyAutostart && ccExe) autoMsg = cc.setAutostart(home, { exePath: ccExe, enabled: true })
      didCC = true
      cfgCodex = { baseUrl: CC_PROXY_BASE, apiKey: request.apiKey, defaultModel: codexPick.id, models: ms }
      stage(
        'ccswitch',
        'ok',
        'cc-switch 就绪（' + cp.note + '，模型目录 ' + cp.models + ' 条；' + cp.settingsNote + (ready.initialized ? '；已完成首启初始化' : '') + (ready.upgraded ? '；已自动升级 v' + ready.from + ' → v' + ready.to : '') + (autoMsg ? '；' + autoMsg : '') + '）'
      )
    } catch (e) {
      fail('ccswitch', 'cc-switch 配置失败：' + e.message)
      return
    }
  }

  // 5. 生成写入计划（干跑，不落盘；Codex 与 WorkBuddy 使用各自的 baseUrl/默认模型）
  stage('plan', 'running', '')
  const cfgOf = (t) => (t.id === 'workbuddy' ? cfgWB : cfgCodex)
  const allChanges = []
  for (const t of targets) {
    try {
      allChanges.push(...t.plan(home, cfgOf(t)))
    } catch (e) {
      fail('plan', t.displayName + ' 生成计划失败：' + e.message)
      return
    }
  }
  emit({ type: 'diff', changes: allChanges })
  stage('plan', 'ok', '共 ' + allChanges.length + ' 个文件待写入')

  // 6. 备份
  stage('backup', 'running', '')
  const receipts = new Map()
  let firstDir = ''
  for (const t of targets) {
    try {
      const r = t.backup(home)
      receipts.set(t.id, r)
      if (!firstDir) firstDir = r.dir
    } catch (e) {
      fail('backup', t.displayName + ' 备份失败：' + e.message)
      return
    }
  }
  stage('backup', 'ok', '已备份 ' + receipts.size + ' 个目标（' + firstDir + '）')

  // 7. 写入（任一失败 → 已写目标全量回滚）
  stage('write', 'running', '')
  const written = []
  for (const t of targets) {
    try {
      t.configure(home, cfgOf(t), { persistEnv: pe })
      written.push(t)
    } catch (e) {
      for (const w of written) {
        const r = receipts.get(w.id)
        if (r) {
          try {
            w.rollback(r)
          } catch {}
        }
      }
      fail('write', t.displayName + ' 写入失败：' + e.message + '；已写目标已自动回滚')
      return
    }
  }
  stage('write', 'ok', '已写入 ' + written.length + ' 个目标')

  // 7.2 记住主网关（自动更新时据此判定主网关，避免多网关并存误判）：
  //     WorkBuddy 记 base；Codex 记 base+Key+模式（真实中转地址，而非 cc-switch 本地路由）。
  if (wbSelected) {
    try {
      au.rememberGateway(home, cfgWB.baseUrl)
    } catch {}
  }
  if (codexSelected) {
    try {
      auCodex.rememberGateway(home, { base, apiKey: request.apiKey, mode: codexMode })
    } catch {}
    // Codex 模型目录收口：cc-switch 投影模板默认 medium 且缺 max 档，与产品要求
    // （默认 xhigh、全模型可选到 max）不符；文件存在即幂等修正，失败不阻断管线。
    try {
      cc.syncCodexModelCatalog(home)
    } catch {}
  }

  // 7.5 模型自动更新注册（按目标能力，缺省勾选）：
  //     codexcli/codexdesktop 共用 ~/.codex 触发器 → kind 去重后只注册一次。
  const auKinds = new Set()
  for (const t of targets) {
    if (t.autoupdate && auWanted(t.id)) auKinds.add(t.autoupdate.kind)
  }
  if (auKinds.size > 0) {
    stage('autoupdate', 'running', '')
    try {
      const msgs = []
      if (auKinds.has('workbuddy')) {
        const { exePath, args } = selfLaunch('--autoupdate-workbuddy')
        msgs.push(au.install(home, { exePath, args, target: 'workbuddy' }))
      }
      if (auKinds.has('codex')) {
        const { exePath, args } = selfLaunch('--autoupdate-codex')
        msgs.push(auCodex.install(home, { exePath, args }))
      }
      stage('autoupdate', 'ok', msgs.join('；'))
    } catch (e) {
      stage('autoupdate', 'warn', '自动更新注册失败：' + e.message + '（模型清单已写入成功）')
    }
  }

  // 8. 验证
  stage('verify', 'running', '')
  const results = []
  let allOK = true
  for (const t of targets) {
    const vr = t.verify(home, cfgOf(t))
    results.push({ target: t.id, ok: vr.ok, message: vr.message })
    if (!vr.ok) allOK = false
  }
  if (allOK) stage('verify', 'ok', '全部目标校验通过')
  else stage('verify', 'warn', '部分目标校验未通过，详见结果')

  // 8.5 启动 cc-switch 本地路由（写库完成后拉起；detached，tiancaiConfig 退出不影响）。
  //     launchAndEnsureCurrent 会校验 settings.json 当前供应商：cc-switch 首启
  //     「导入 live config 为 default」等场景改写时自动校正（停止→改回→重启）。
  if (didCC && ccExe) {
    try {
      const ensureMsg = await cc.launchAndEnsureCurrent(ccExe, { home, pid: ccPid })
      stage('ccswitch', 'ok', 'cc-switch 本地路由已启动（127.0.0.1:' + ccswitch.CC_PORT + '）；' + ensureMsg)
    } catch (e) {
      stage('ccswitch', 'warn', 'cc-switch 启动异常：' + e.message + '（配置已写入，可手动打开 cc-switch 检查当前供应商）')
    }
  }

  emit({
    type: 'done',
    ok: allOK,
    message: allOK ? '配置完成，重启对应工具后生效' : '配置完成但存在校验警告，请查看详情',
    results,
  })
}

module.exports = { run, resolveTargets, MAX_PROBE, PROBE_CONC, PROBE_TIMEOUT_MS, CC_PROXY_BASE, GPT_ONLY_RE }
