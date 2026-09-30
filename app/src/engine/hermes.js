// Hermes Agent 目标：~/.hermes/config.yaml 原位编辑（只写服务提供方三件套）。
// 设计约定（2026-09-29 用户定规）：
// 1) hermes 是 chat/completions 兼容客户端，直连第三方 API（中转站 base_url +
//    api_key 直写 config）——绝不指向 cc-switch 本地路由（127.0.0.1:15721），
//    也不依赖 cc-switch 模型目录；一键配置流程中 cc-switch 阶段仅由 Codex
//    目标触发（oneclick.codexSelected）。
// 2) 只配置「服务提供方」（provider="custom" + base_url + api_key 三件套），
//    绝不写 default 模型——hermes GUI 添加服务方后「刷新模型」即可拉取全量
//    模型清单，模型由用户在 hermes 中自选；default 行原样保留（用户在 GUI
//    选过就留着，没选过就保持注释态）。实测：无 default 时 hermes 发空模型名
//    （HTTP 400 Model name not specified），所以端到端探针必须用 --model 显式
//    指定模型（cfg.defaultModel，即工具默认模型）。
// 3) providers 段（2026-09-29 用户定规）：中转站支持的全部模型全量声明进顶层
//    providers 段（entry 名由 base_url hostname 推导，hermes 按归一化 base_url
//    匹配 entry）；其中 models.dev 注册表缓存（$HERMES_HOME/models_dev_cache.json）
//    已收录的模型写空映射（不覆盖上下文，交由 hermes 真实元数据解析），名单外的
//    新模型（如 gpt-6.1-sol）一律 context_length: 272000 兜底——解决「中转站新增
//    模型后 hermes 缺少显式声明」的问题。名单缓存缺失或损坏时按「全部未知」处理
//    （全部 272k），与用户规则一致。cfg.models 未提供时整段跳过（绝不写空 entry）；
//    default 模型仍然绝不写入。
// 4) model_aliases 直连表（2026-09-29 真机实测根因）：hermes -z --model 不带
//    --provider 时 oneshot.py 先查 model_aliases 生成的 DIRECT_ALIASES，查不到才
//    走 detect_provider_for_model 按名猜测——gpt-* 模型会被猜到 openai-api，报
//    "agent init failed: No usable credentials found for provider 'openai-api'"。
//    把中转站全部模型写进 model_aliases（provider: custom + base_url）后直连中转
//    站；TUI /model 切模型则由 providers entry 的 models dict 兜住（model_switch
//    step d.5 _configured_provider_matches 精确匹配声明模型，优先于按名猜测）。
// 关键约束：config.yaml 是 hermes 的完整主配置（500+ 行注释 + 用户自定义段），
// 绝不能整文件重写——只做行级原位替换，注释与其他段一字不动。
// 鉴权说明：key 直接写入 model.api_key（hermes 官方注释支持的用法）；
// 不用 env_key 类机制，GUI/网关/CLI 三种启动方式都从 config.yaml 读到。
// 配置目录（HERMES_HOME，2026-09 真实机器确认）：Windows 官方安装器会写
// 用户级持久变量 HERMES_HOME（指向 AppData\Local\hermes），hermes CLI 读配置
// 的优先级是 $HERMES_HOME/config.yaml > ~/.hermes/config.yaml——因此配置必须
// 写入 HERMES_HOME 指向的目录才生效；~/.hermes 仅为未设该变量时的缺省兜底。
// 行尾规范化（2026-09 真实机器确认）：读取用 split(/\r?\n/) 兼容 CRLF；
// 写入 atomicWrite 统一 join('\n') 把 CRLF 规范化为 LF——与 hermes 官方
// hermes_cli/config.py atomic_config_write（PyYAML 默认 LF 输出）行为一致。
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const backupEngine = require('./backup')

// hermesHome 解析配置目录：HERMES_HOME 环境变量（trim 后非空则用之，
// Windows 官方安装器写入的用户级持久变量，CLI 读取优先级最高）；
// 未设置/空白时兜底 ~/.hermes。
function hermesHome(home) {
  const env = String(process.env.HERMES_HOME || '').trim()
  if (env) return env
  return path.join(home, '.hermes')
}

function configPath(home) {
  return path.join(hermesHome(home), 'config.yaml')
}

// resolveCli 定位 hermes 可执行。
// darwin/linux：~/.local/bin/hermes（官方安装器布局）→
// ~/.hermes/hermes-agent/.hermes/bin/hermes（仓库布局）→ sh -c command -v。
// win32（Windows 上 X_OK 不可靠、sh 通常不在 PATH，且 POSIX 路径无法直接
// spawn）：AppData venv Scripts（git 安装实测布局）→ .local/bin → 仓库布局
// （existsSync 判断）→ where.exe（取输出首个非空行的 win32 路径）。
// opts 可注入（项目 DI 风格）：platform / spawn，默认取 process.platform /
// spawnSync，调用方 resolveCli(home) 语义不变。
function resolveCli(home, opts = {}) {
  const platform = opts.platform || process.platform
  const spawn = opts.spawn || spawnSync
  if (platform === 'win32') {
    const candidates = [
      path.join(home, 'AppData', 'Local', 'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe'),
      path.join(home, '.local', 'bin', 'hermes.exe'),
      path.join(home, '.hermes', 'hermes-agent', '.hermes', 'bin', 'hermes.exe'),
    ]
    for (const c of candidates) {
      if (fs.existsSync(c)) return c
    }
    const r = spawn('where', ['hermes'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
    const first = String((r && r.stdout) || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0)
    return first || ''
  }
  const candidates = [
    path.join(home, '.local', 'bin', 'hermes'),
    path.join(home, '.hermes', 'hermes-agent', '.hermes', 'bin', 'hermes'),
  ]
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK)
      return c
    } catch {}
  }
  const r = spawn('sh', ['-c', 'command -v hermes'], { encoding: 'utf8', timeout: 5000 })
  const p = (r.stdout || '').trim()
  return p || ''
}

// normalizeBase 与中转站其他写入点同规则：去尾斜杠，拼 /v1。
function normalizeBase(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '') + '/v1'
}

// yamlQuote 输出 YAML 双引号字符串（反斜杠与双引号转义）。
function yamlQuote(v) {
  return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

// ── providers 段：中转站模型全量声明 + 名单外模型 272k 兜底（2026-09-29 用户定规）──
// 背景：中转站新增模型（如 gpt-6.1-sol）不在 hermes 的 models.dev 注册表缓存里，
// 缺少显式声明。定规：把中转站支持的全部模型显式声明进顶层 providers 段，名单内
// 已知模型不覆盖上下文（交由 hermes 真实元数据解析），名单外模型一律 272k。

// 名单外模型的上下文兜底值（用户指定 272k）。
const UNKNOWN_MODEL_CONTEXT_LENGTH = 272000

// modelsDevKnown 读取 $HERMES_HOME/models_dev_cache.json（hermes 官方 models.dev
// 注册表缓存，结构 { providerId: { ..., models: { modelId: {...} } } }），返回小写
// 模型 id 集合；读取/解析失败返回 null（调用方按「全部未知」兜底 272k——名单不可
// 用即视为不在名单，与用户规则一致）。
function modelsDevKnown(home) {
  let raw
  try {
    raw = fs.readFileSync(path.join(hermesHome(home), 'models_dev_cache.json'), 'utf8')
  } catch {
    return null
  }
  try {
    const root = JSON.parse(raw)
    // 根必须是无数组对象：字符串/数字/数组等「合法 JSON 但非注册表形态」→ null
    // （JSON.stringify 会把非对象输入序列化为带引号字符串，Object.values 会逐字符
    // 迭代出空 Set 而非 null——实测踩过，必须显式校验）。
    if (!root || typeof root !== 'object' || Array.isArray(root)) return null
    const known = new Set()
    for (const prov of Object.values(root)) {
      const models = prov && typeof prov === 'object' ? prov.models : null
      if (!models || typeof models !== 'object') continue
      for (const id of Object.keys(models)) {
        const k = String(id).trim().toLowerCase()
        if (k) known.add(k)
      }
    }
    return known
  } catch {
    return null
  }
}

// providerEntryName 由 base_url 推导 providers entry 键名：hostname 小写化、非
// [a-z0-9] 折叠为连字符（https://ai.heigh.vip/v1 → ai-heigh-vip）。hermes 按
// 归一化 base_url 匹配 entry（hermes_cli/config.py），键名仅作标识。
function providerEntryName(baseUrl) {
  let host = ''
  try {
    host = new URL(String(baseUrl || '')).hostname
  } catch {}
  const name = host.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return name || 'custom-relay'
}

// modelIds 归一 cfg.models：兼容字符串数组与 [{id}] 对象数组（oneclick 两种形态），
// 去空去重保序。
function modelIds(models) {
  const out = []
  const seen = new Set()
  for (const m of Array.isArray(models) ? models : []) {
    const id = String(typeof m === 'object' && m !== null ? m.id : m || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

// providerEntryPlan 生成 providers entry 目标结构 { name, baseUrl, apiKey,
// models: [{ id, ctx }] }：ctx=null 表示名单内已知模型（写空映射 {}，不覆盖上下文）；
// ctx=272000 表示名单外/名单不可用。knownSet 为 null（缓存缺失/损坏）时全部按未知兜底。
function providerEntryPlan(cfg, knownSet) {
  const known = knownSet instanceof Set ? knownSet : null
  return {
    name: providerEntryName(cfg.baseUrl),
    baseUrl: normalizeBase(cfg.baseUrl),
    apiKey: String(cfg.apiKey || ''),
    models: modelIds(cfg.models).map((id) => ({
      id,
      ctx: known && known.has(id.toLowerCase()) ? null : UNKNOWN_MODEL_CONTEXT_LENGTH,
    })),
  }
}

// yamlPlainKey 模型 id / entry 名作 YAML 键：常规字符裸写（可读），其余双引号
// （hermes 用 PyYAML 解析，两种写法等价）。
function yamlPlainKey(id) {
  return /^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/.test(id) ? id : yamlQuote(id)
}

// renderEntryBlock 输出 entry 块行（不含顶层 providers: 行，缩进 2 起）：
//   ai-heigh-vip:
//     base_url: "..."
//     api_key: "..."
//     models:
//       MiniMax-M3: {}
//       gpt-6.1-sol:
//         context_length: 272000
function renderEntryBlock(entry) {
  const out = [
    '  ' + yamlPlainKey(entry.name) + ':',
    '    base_url: ' + yamlQuote(entry.baseUrl),
    '    api_key: ' + yamlQuote(entry.apiKey),
  ]
  if (entry.models.length > 0) {
    out.push('    models:')
    for (const m of entry.models) {
      if (m.ctx == null) {
        out.push('      ' + yamlPlainKey(m.id) + ': {}')
      } else {
        out.push('      ' + yamlPlainKey(m.id) + ':')
        out.push('        context_length: ' + m.ctx)
      }
    }
  }
  return out
}

// applyProviderEntry 把 entry 原位写入行数组（幂等，绝不动其他顶层段）：
// A) `providers: {}` → 原位展开为块级；B) 块级 → 同名 entry 原位重写（compact 空
// 映射 entry 也支持）、异名 entry 插入段首；C) 无 providers: → 文件末尾追加
// （YAML 顶层键顺序无关）。无法行级安全改写的形态（如带内容的 flow 映射）→ 不动
// 文件返回 skipped（fail-open：model 段三件套已另行配置，不受影响）。
// 注意只匹配顶格 providers:——model_catalog 等段内缩进的 providers: 不算。
function applyProviderEntry(lines, entry) {
  const out = lines.slice()
  const block = renderEntryBlock(entry)
  const topIdx = out.findIndex((l) => l.startsWith('providers:'))
  if (topIdx === -1) {
    return { lines: out.concat(['providers:'], block), action: 'appended' }
  }
  const rest = out[topIdx].slice('providers:'.length).trim()
  if (rest !== '' && rest !== '{}') {
    return { lines: out, action: 'skipped', note: 'providers 段为特殊形态（' + rest.slice(0, 24) + '），跳过模型声明（model 段已另行配置）' }
  }
  if (rest === '{}') {
    out.splice(topIdx, 1, 'providers:', ...block)
    return { lines: out, action: 'expanded' }
  }
  // 块级：段范围 [topIdx+1, sectEnd)（顶格非空行止），找同名 entry 子块
  let sectEnd = out.length
  for (let i = topIdx + 1; i < out.length; i++) {
    const l = out[i]
    if (l.trim() === '' || l.startsWith('#')) continue
    if (!l.startsWith(' ')) {
      sectEnd = i
      break
    }
  }
  let cs = -1
  let firstChild = -1
  for (let i = topIdx + 1; i < sectEnd; i++) {
    const l = out[i]
    if (l.trim() === '' || l.startsWith('#') || l.startsWith('   ')) continue
    const m = l.match(/^ {2}(.+?)\s*:\s*(\{\s*\})?\s*$/)
    if (!m) continue
    if (firstChild === -1) firstChild = i
    if (m[1].replace(/^"|"$/g, '').trim() === entry.name) {
      cs = i
      break
    }
  }
  if (cs === -1) {
    out.splice(firstChild === -1 ? topIdx + 1 : firstChild, 0, ...block)
    return { lines: out, action: 'inserted' }
  }
  // 子块终点：下一个恰 2 空格缩进的 entry 名行 / 段结束（空行与注释不作为边界）
  let ce = sectEnd
  for (let i = cs + 1; i < sectEnd; i++) {
    const l = out[i]
    if (l.trim() === '' || l.startsWith('#') || l.startsWith('   ')) continue
    ce = i
    break
  }
  out.splice(cs, ce - cs, ...block)
  return { lines: out, action: 'replaced' }
}

// parseProviderEntry 只读解析顶层 providers 段中名为 name 的 entry（verify 用）。
// 返回 { baseUrl, apiKey, models: { id: number|null } }；entry 不存在返回 null。
// models 值：number=显式 context_length；null=已声明无覆盖（{} 空映射）。
// 匹配顺序：8 空格 context_length → 4 空格 entry 键 → 6 空格模型键（缩进前缀
// 互为包含，必须先长后短；6 空格键首字符禁空白防止吞掉 8 空格行）。
function parseProviderEntry(lines, name) {
  const topIdx = lines.findIndex((l) => l === 'providers:' || /^providers:\s*\{\s*\}\s*$/.test(l))
  if (topIdx === -1) return null
  let cs = -1
  for (let i = topIdx + 1; i < lines.length; i++) {
    const l = lines[i]
    if (l.trim() === '' || l.startsWith('#') || l.startsWith('   ')) continue
    if (!l.startsWith(' ')) break // 顶格键 → providers 段结束
    const m = l.match(/^ {2}(.+?)\s*:\s*(\{\s*\})?\s*$/)
    if (m && m[1].replace(/^"|"$/g, '').trim() === name) {
      cs = i
      break
    }
  }
  if (cs === -1) return null
  const res = { baseUrl: '', apiKey: '', models: {} }
  // inModels：进入 models 子映射后保持 true——用 cur==='models' 做门卫是错的
  // （解析完第一个模型行 cur 就变成模型 id，后续模型行全被漏掉，实测踩过）。
  let inModels = false
  let cur = null
  for (let i = cs + 1; i < lines.length; i++) {
    const l = lines[i]
    if (l.trim() === '' || l.trimStart().startsWith('#')) continue
    if (!l.startsWith('   ')) break // 下一个 entry 名行 / 顶格键 → entry 结束
    let m = l.match(/^ {8}context_length\s*:\s*(\d+)\s*$/)
    if (m && cur) {
      res.models[cur] = parseInt(m[1], 10)
      continue
    }
    m = l.match(/^ {4}([A-Za-z_]+)\s*:\s*(.*)$/)
    if (m) {
      const v = (m[2] || '').replace(/^"(.*)"$/, '$1').trim()
      if (m[1] === 'base_url') res.baseUrl = v
      else if (m[1] === 'api_key') res.apiKey = v
      inModels = m[1] === 'models'
      continue
    }
    m = l.match(/^ {6}([^\s].+?)\s*:\s*(\{\s*\})?\s*$/)
    if (m && inModels) {
      cur = m[1].replace(/^"|"$/g, '').trim()
      res.models[cur] = m[2] ? null : undefined
    }
  }
  return res
}

// applyModelAliases 把中转站全部模型写进顶层 model_aliases 直连表（oneshot
// `--model X` 的官方路由旁路：oneshot.py 先查 model_aliases 生成的 DIRECT_ALIASES
// 再走按名猜测——没有该表时 gpt-* 模型被猜到 openai-api，报 "No usable
// credentials found for provider 'openai-api'"，2026-09-29 真机实测）。
// 每模型一行 flow 映射（键=模型 id，provider: custom + base_url 直连中转站）；
// 只覆写与中转站模型同名的键（含用户手写的块级形态，整块替换），其余 alias
// 原样保留；无该段则末尾追加；`model_aliases: {}` 原位展开；特殊形态跳过。
function applyModelAliases(lines, entry) {
  const aliasLine = (id) =>
    '  ' + yamlPlainKey(id) + ': {model: ' + yamlQuote(id) + ', provider: custom, base_url: ' + yamlQuote(entry.baseUrl) + '}'
  const want = new Map(entry.models.map((m) => [m.id, aliasLine(m.id)]))
  const out = lines.slice()
  const topKey = 'model_aliases:'
  const topIdx = out.findIndex((l) => l.startsWith(topKey))
  if (topIdx === -1) {
    return { lines: out.concat([topKey], [...want.values()]), action: 'appended', count: want.size }
  }
  const rest = out[topIdx].slice(topKey.length).trim()
  if (rest !== '' && rest !== '{}') {
    return { lines: out, action: 'skipped', note: 'model_aliases 段为特殊形态（' + rest.slice(0, 24) + '），跳过直连表写入' }
  }
  if (rest === '{}') {
    out.splice(topIdx, 1, topKey, ...want.values())
    return { lines: out, action: 'expanded', count: want.size }
  }
  // 块级：逐键 upsert（同名键整块替换为单行 flow；其余键原样保留）
  const ops = [] // [startIdx, replaceCount, replacementLine]，自底向上应用
  const replacedKeys = new Set()
  let firstChild = -1
  let i = topIdx + 1
  while (i < out.length) {
    const l = out[i]
    if (l.trim() === '' || l.startsWith('#')) {
      i++
      continue
    }
    if (!l.startsWith(' ')) break // 顶格键 → 段结束
    if (!l.startsWith('  ') || l.startsWith('   ')) {
      i++ // 异常缩进/键块子行，跳过
      continue
    }
    // `(\{.*\})?` 必须容忍带内容的 flow 映射值（我们写入的 alias 行就是
    // `键: {model: ..., provider: ...}`——只认 `\{\s*\}` 会导致重跑时认不出
    // 自己写的行、整表重复插入，幂等破坏，实测踩过）。
    const m = l.match(/^ {2}(.+?)\s*:\s*(\{.*\})?\s*(#.*)?$/)
    if (firstChild === -1) firstChild = i
    if (m) {
      const key = m[1].replace(/^"|"$/g, '').trim()
      if (want.has(key)) {
        // 键块范围：flow 单行或块级子行（缩进 ≥3），止于下一个 2 空格键 / 顶格行
        let j = i + 1
        while (j < out.length) {
          const lj = out[j]
          if (lj.trim() === '' || lj.startsWith('   ')) {
            j++
            continue
          }
          break
        }
        ops.push([i, j - i, want.get(key)])
        replacedKeys.add(key)
        i = j
        continue
      }
    }
    i++
  }
  for (let k = ops.length - 1; k >= 0; k--) {
    const [start, count, line] = ops[k]
    out.splice(start, count, line)
  }
  const missing = [...want.keys()].filter((k) => !replacedKeys.has(k))
  if (missing.length > 0) {
    const at = firstChild === -1 ? topIdx + 1 : firstChild
    out.splice(at, 0, ...missing.map((k) => want.get(k)))
  }
  return { lines: out, action: replacedKeys.size > 0 ? 'updated' : 'inserted', count: want.size }
}

// 编辑计划：model 段内需生效的三字段目标值（服务提供方三件套）。
// 故意不含 default——模型由用户在 hermes GUI 刷新模型后自选，工具绝不代选。
function editPlan(cfg) {
  return {
    provider: '"custom"',
    base_url: yamlQuote(normalizeBase(cfg.baseUrl)),
    api_key: yamlQuote(cfg.apiKey || ''),
  }
}

// loadModelSection 解析 config.yaml 中第一个顶格 model: 段的行号范围 [start, end)。
// 返回 null 表示找不到 model: 顶层键（config 结构异常，拒绝盲写）。
function loadModelSection(lines) {
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === 'model:') {
      start = i
      break
    }
  }
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]
    if (l.trim() === '' || l.startsWith(' ') || l.startsWith('\t') || l.startsWith('#')) continue
    end = i // 下一个顶格键 → 段结束
    break
  }
  return { start, end }
}

// applyEdits 对行数组原位应用 model 段三字段（服务提供方）。返回 { lines, changed: [...], missing: [...] }。
// 只动段内「未注释的目标键行」；default 行绝不触碰（用户在 hermes GUI 自选模型，
// 选过就保留）；api_key 若无未注释行则插到 provider 行之后。
function applyEdits(lines, plan) {
  const sec = loadModelSection(lines)
  if (!sec) throw new Error('config.yaml 中未找到顶层 model: 段（结构异常，拒绝盲写）')
  const out = lines.slice()
  const changed = []
  const wanted = ['provider', 'base_url', 'api_key']
  let providerLine = -1
  for (let i = sec.start + 1; i < sec.end; i++) {
    const m = out[i].match(/^(\s*)(#?\s*)([A-Za-z_]+)(\s*:)/)
    if (!m) continue
    const key = m[3]
    if (!wanted.includes(key)) continue
    if (m[2].includes('#')) continue // 注释行不作为替换目标
    if (out[i].includes(key + ':') && !out[i].trimStart().startsWith('#')) {
      if (key === 'api_key') {
        changed.push('api_key')
        out[i] = m[1] + 'api_key: ' + plan.api_key
        continue
      }
      changed.push(key)
      out[i] = m[1] + key + ': ' + plan[key]
      if (key === 'provider') providerLine = i
    }
  }
  // api_key 无未注释行 → 插到 provider 行后（provider 行自身也可能刚替换过）
  if (!changed.includes('api_key')) {
    if (providerLine === -1) {
      // 段内无未注释 provider 行（异常但可救）：插到段首
      out.splice(sec.start + 1, 0, '  api_key: ' + plan.api_key)
    } else {
      out.splice(providerLine + 1, 0, '  api_key: ' + plan.api_key)
    }
    changed.push('api_key')
  }
  const missing = wanted.filter((k) => !changed.includes(k))
  return { lines: out, changed, missing }
}

// parseModelFields 只读解析 model 段生效字段（detect/verify 共用）。
function parseModelFields(lines) {
  const sec = loadModelSection(lines)
  if (!sec) return null
  const fields = {}
  for (let i = sec.start + 1; i < sec.end; i++) {
    const m = lines[i].match(/^\s+([A-Za-z_]+)\s*:\s*(.*)$/)
    if (!m || lines[i].trimStart().startsWith('#')) continue
    if (['default', 'provider', 'base_url', 'api_key'].includes(m[1])) {
      fields[m[1]] = (m[2] || '').replace(/^"(.*)"$/, '$1').trim()
    }
  }
  return fields
}

function readLines(p) {
  // split(/\r?\n/) 统一消化 CRLF（真机证实：用户旧工具备份的 config.yaml 是
  // CRLF 行尾，按 '\n' 切会残留 \r，使 loadModelSection 的 'model:' 精确匹配失败）。
  return fs.readFileSync(p, 'utf8').split(/\r?\n/)
}

function atomicWrite(p, lines) {
  const tmp = p + '.tmp-tiancai'
  fs.writeFileSync(tmp, lines.join('\n'))
  fs.renameSync(tmp, p)
}

function detect(home) {
  const p = configPath(home)
  const cli = resolveCli(home)
  const result = { installed: false, configured: false, detail: '', paths: [p] }
  if (!fs.existsSync(p)) {
    result.detail = '未检测到 ' + p + '（未安装 Hermes 或尚未初始化）'
    return result
  }
  result.installed = true
  if (!cli) {
    result.detail = '检测到 config.yaml，但未找到 hermes 命令（配置仍可写入，端到端测试将跳过）'
    return result
  }
  let fields
  try {
    fields = parseModelFields(readLines(p))
  } catch (e) {
    result.detail = 'config.yaml 存在但无法解析（' + e.message + '），写入前会自动备份'
    return result
  }
  if (fields && fields.provider === 'custom') {
    result.configured = true
    result.detail = '已配置 custom 中转（' + (fields.base_url || '?') + '）；模型在 Hermes 中「刷新模型」后自选' + (fields.default ? '，当前选中 ' + fields.default : '')
  } else {
    result.detail = '已安装 Hermes（当前 provider: ' + ((fields && fields.provider) || '?') + '，配置后将直连中转站）'
  }
  return result
}

function plan(home, cfg) {
  const p = configPath(home)
  const planMap = editPlan(cfg)
  let old = {}
  try {
    old = parseModelFields(readLines(p)) || {}
  } catch {
    old = {}
  }
  const items = ['provider', 'base_url', 'api_key'].map((k) => {
    const ov = k === 'api_key' && old[k] ? old[k].slice(0, 6) + '***' : old[k] || '（未设置）'
    const nv = k === 'api_key' ? (cfg.apiKey || '').slice(0, 6) + '***' : planMap[k].replace(/^"|"$/g, '')
    return { key: k, from: ov, to: nv }
  })
  const summary = '原位更新 model 段（仅服务提供方，不动 default 模型）：' + items.map((i) => i.key + ' ' + i.from + ' → ' + i.to).join('；')
  const result = [{ file: p, summary, diff: items }]
  // providers + model_aliases 计划（cfg.models 未提供则整段跳过）
  const ids = modelIds(cfg.models)
  if (ids.length > 0) {
    const entry = providerEntryPlan(cfg, modelsDevKnown(home))
    const unknownCount = entry.models.filter((m) => m.ctx != null).length
    const diff = entry.models.slice(0, 20).map((m) => ({
      key: m.id,
      from: '（未声明）',
      to: m.ctx == null ? '已声明（上下文交由 hermes 解析）' : 'context_length: 272000',
    }))
    if (entry.models.length > 20) diff.push({ key: '…', from: '', to: '其余 ' + (entry.models.length - 20) + ' 个同理' })
    result.push({
      file: p,
      summary: '写入 providers.' + entry.name + '：全量声明 ' + entry.models.length + ' 个中转站模型；名单外模型 context_length 默认 272k（' + unknownCount + ' 个）',
      diff,
    })
    result.push({
      file: p,
      summary: '写入 model_aliases 直连表：' + entry.models.length + ' 个模型 provider=custom 直连中转站（hermes -z --model 不再按名误判 openai-api）',
      diff: [{ key: 'model_aliases', from: '（无直连表）', to: entry.models.length + ' 个模型 → ' + entry.baseUrl }],
    })
  }
  return result
}

function backup(home) {
  const p = configPath(home)
  const { dir } = backupEngine.snapshot(home, 'hermes', [p])
  return { dir, files: [p] }
}

// restartGatewayIfRunning 改配置后让常驻 gateway（消息桥）加载新配置。
// 只在 gateway 确实在运行（gateway.pid 存在）时才重启；失败不阻塞配置主流程
// （gateway 非必装组件）。绝不能对未运行的 gateway 盲调 restart——既有副作用
// 又可能挂住（2026-09-29 单测 4 分钟超时的教训）。
function restartGatewayIfRunning(home, cli) {
  const pidFile = path.join(hermesHome(home), 'gateway.pid')
  if (!fs.existsSync(pidFile)) return '（gateway 未在运行，跳过重启）'
  if (!cli) return '（未找到 hermes 命令，跳过 gateway 重启）'
  try {
    const r = spawnSync(cli, ['gateway', 'restart'], { encoding: 'utf8', timeout: 45000, stdio: 'ignore' })
    return r.status === 0 ? 'gateway 已重启加载新配置' : 'gateway 重启未成功（非致命，status=' + r.status + '）'
  } catch {
    return 'gateway 重启超时/异常（非致命，已忽略）'
  }
}

function configure(home, cfg) {
  const p = configPath(home)
  if (!fs.existsSync(p)) throw new Error('未找到 ' + p + '，请先安装并初始化 Hermes（运行一次 hermes chat）')
  const lines = readLines(p)
  const before = lines.join('\n')
  const { lines: out, changed, missing } = applyEdits(lines, editPlan(cfg))
  if (missing.length === 3) throw new Error('model 段无可编辑字段（config 结构异常）')
  let finalLines = out
  const items = [{ file: p, summary: 'model 段已更新（' + changed.join('/') + '）' }]
  // providers entry + model_aliases 直连表：中转站模型全量声明与直连路由
  // （cfg.models 未提供时整段跳过——与「绝不写空 entry」约定一致）
  const ids = modelIds(cfg.models)
  if (ids.length > 0) {
    const entry = providerEntryPlan(cfg, modelsDevKnown(home))
    const prov = applyProviderEntry(finalLines, entry)
    finalLines = prov.lines
    const unknownCount = entry.models.filter((m) => m.ctx != null).length
    if (prov.action === 'skipped') {
      items.push({ file: p, summary: 'providers 模型声明未写入：' + prov.note })
    } else {
      const actText = { expanded: '展开写入', replaced: '原位更新', inserted: '插入', appended: '在文件末尾追加' }[prov.action] || prov.action
      items.push({
        file: p,
        summary: 'providers.' + entry.name + ' 已' + actText + '：全量声明 ' + entry.models.length + ' 个中转站模型，其中 ' + unknownCount + ' 个名单外模型按 272k 声明上下文（已知模型不覆盖，交由 hermes 元数据解析）',
      })
    }
    const al = applyModelAliases(finalLines, entry)
    finalLines = al.lines
    if (al.action === 'skipped') {
      items.push({ file: p, summary: 'model_aliases 直连表未写入：' + al.note })
    } else {
      items.push({
        file: p,
        summary: 'model_aliases 直连表已写入 ' + al.count + ' 个模型（hermes -z --model 直连中转站，修复 gpt-* 被按名误判 openai-api 报 No usable credentials 的问题）',
      })
    }
  }
  const after = finalLines.join('\n')
  if (before !== after) atomicWrite(p, finalLines)
  const gw = restartGatewayIfRunning(home, resolveCli(home))
  items[0].summary += '；' + gw
  return items
}

// verify 两层：①读回断言三字段（服务提供方）与计划一致；②端到端 hermes -z "hi"
// --provider custom --model <默认模型> 真实调用——config 不写 default（实测无
// default 时 hermes 发空模型名 HTTP 400），探针必须显式指定模型（cfg.defaultModel，
// 即工具默认模型，必在中转站模型列表内）。且必须显式 --provider custom：hermes
// 0.19.1 oneshot（hermes_cli/oneshot.py）对 --model 不带 --provider 时会从模型名
// 自动探测 provider（detect_provider_for_model），绕开 config.yaml 的 provider:
// custom → 中转站独有模型探测不到归属（真机实测报 "No LLM provider configured"）；
// 带 --provider custom 才走 config 三件套直连中转站。runProbe 可注入（测试桩 /
// 无 CLI 环境跳过）。
function verify(home, cfg, opts = {}) {
  const p = configPath(home)
  let fields
  try {
    fields = parseModelFields(readLines(p))
  } catch (e) {
    return { ok: false, message: 'config.yaml 无法解析：' + e.message }
  }
  if (!fields) return { ok: false, message: 'config.yaml 中未找到 model: 段' }
  const want = editPlan(cfg)
  for (const k of ['provider', 'base_url']) {
    if (fields[k] !== want[k].replace(/^"|"$/g, '')) {
      return { ok: false, message: k + ' 不一致：期望 ' + want[k] + '，实际 ' + (fields[k] || '（空）') }
    }
  }
  if (!fields.api_key) return { ok: false, message: 'api_key 未写入' }
  // providers entry + model_aliases 直连表读回断言（cfg.models 非空时）——
  // 「新增模型看不见 / --model 路由误判 openai-api」的直接回归防线。
  const ids = modelIds(cfg.models)
  if (ids.length > 0) {
    const entry = providerEntryPlan(cfg, null) // 仅用 name/baseUrl/模型 id 列表
    const all = readLines(p)
    const pe = parseProviderEntry(all, entry.name)
    if (!pe) return { ok: false, message: 'providers.' + entry.name + ' 未写入（中转站模型声明缺失）' }
    if (pe.baseUrl !== entry.baseUrl) {
      return { ok: false, message: 'providers.' + entry.name + '.base_url 不一致：期望 ' + entry.baseUrl + '，实际 ' + (pe.baseUrl || '（空）') }
    }
    const missingIds = ids.filter((id) => !Object.prototype.hasOwnProperty.call(pe.models, id))
    if (missingIds.length > 0) {
      return { ok: false, message: 'providers 模型声明缺失 ' + missingIds.length + ' 个（' + missingIds.slice(0, 3).join(', ') + (missingIds.length > 3 ? ' …' : '') + '）' }
    }
    const topAliases = all.findIndex((l) => l.startsWith('model_aliases:'))
    if (topAliases === -1) return { ok: false, message: 'model_aliases 直连表未写入（hermes -z --model 会按名误判 provider）' }
    const missingAlias = ids.filter((id) => {
      const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp('^ {2}("' + esc + '"|' + esc + ')\\s*:\\s*\\{.*provider:\\s*custom')
      return !all.some((l) => re.test(l))
    })
    if (missingAlias.length > 0) {
      return { ok: false, message: 'model_aliases 缺失 ' + missingAlias.length + ' 个（' + missingAlias.slice(0, 3).join(', ') + '）' }
    }
  }
  if (opts.runProbe) {
    const pr = opts.runProbe(home, cfg)
    if (!pr.ok) return pr
    return { ok: true, message: '校验通过（配置一致 + 端到端调用成功：' + pr.detail + '）' }
  }
  const cli = resolveCli(home)
  if (!cli) return { ok: true, message: '校验通过（配置一致；未找到 hermes 命令，跳过端到端调用）' }
  const probeModel = String(cfg.defaultModel || '').trim() || 'glm-5.3-flash'
  let r
  try {
    // 必须带 --provider custom：oneshot 的 --model 自动探测规则会绕开 config 的
    // custom 提供方（中转站独有模型探测不到归属 → "No LLM provider configured"）
    r = spawnSync(cli, ['-z', 'hi', '--provider', 'custom', '--model', probeModel], { encoding: 'utf8', timeout: 90000, cwd: home })
  } catch {
    return { ok: false, message: '端到端调用超时（90s），请检查中转站连通性' }
  }
  const outAll = ((r.stdout || '') + '\n' + (r.stderr || '')).trim()
  if (/agent failed|not connected|Missing environment|malformed|Model name not specified/i.test(outAll)) {
    return { ok: false, message: '端到端调用失败：' + outAll.split('\n').slice(-2).join(' ').slice(0, 300) }
  }
  if (!outAll) return { ok: false, message: '端到端调用无输出（exit=' + r.status + '）' }
  return { ok: true, message: '校验通过（配置一致 + hermes 实际调用成功（--model ' + probeModel + '），exit=' + r.status + '）' }
}

function rollback(receipt) {
  backupEngine.restore(receipt.dir)
}

module.exports = {
  UNKNOWN_MODEL_CONTEXT_LENGTH,
  configPath,
  hermesHome,
  resolveCli,
  normalizeBase,
  loadModelSection,
  applyEdits,
  parseModelFields,
  modelsDevKnown,
  providerEntryName,
  modelIds,
  providerEntryPlan,
  applyProviderEntry,
  parseProviderEntry,
  applyModelAliases,
  editPlan,
  detect,
  plan,
  backup,
  configure,
  verify,
  rollback,
  restartGatewayIfRunning,
}
