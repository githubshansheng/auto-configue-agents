import { useEffect, useState, useRef } from 'react'
import {
  Terminal, AppWindow, Bot, KeyRound, Link2, Gauge, FileDiff, Save,
  CircleCheck, CircleAlert, TriangleAlert, LoaderCircle, Eye, EyeOff,
  ChevronDown, ChevronUp, RotateCcw, Zap, Check, Layers, RefreshCw, Cpu,
  ListChecks,
} from 'lucide-react'

const TOKEN = new URLSearchParams(window.location.search).get('t') || ''
// 与服务端约定：头名发送时任意大小写均可（Node 入站统一小写），
// 但必须与服务端查询键 x-tiancaiconfig-token 同名 —— 全小写、单一出处。
const TOKEN_HEADER = 'x-tiancaiconfig-token'

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: TOKEN, ...(opts.headers || {}) },
  })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return res.json()
}

const STAGES = [
  { key: 'validate', label: '校验输入' },
  { key: 'fetch', label: '连接中转站并拉取模型' },
  { key: 'filter', label: '过滤非对话模型' },
  { key: 'speedtest', label: '模型测速' },
  { key: 'ccswitch', label: '配置 cc-switch 本地路由' },
  { key: 'plan', label: '生成写入计划' },
  { key: 'backup', label: '备份现有配置' },
  { key: 'write', label: '写入配置' },
  { key: 'autoupdate', label: '注册模型自动更新' },
  { key: 'verify', label: '验证结果' },
]

const TARGET_ICONS = { codexcli: Terminal, codexdesktop: AppWindow, workbuddy: Bot }
const TARGET_NAMES = { codexcli: 'Codex CLI', codexdesktop: 'Codex Desktop', workbuddy: 'WorkBuddy' }

function StageIcon({ status }) {
  if (status === 'ok') return <CircleCheck size={16} style={{ color: 'var(--success)' }} />
  if (status === 'warn') return <TriangleAlert size={16} style={{ color: 'var(--warn)' }} />
  if (status === 'fail') return <CircleAlert size={16} style={{ color: 'var(--danger)' }} />
  if (status === 'running') return <LoaderCircle size={16} className="animate-spin" style={{ color: 'var(--accent)' }} />
  return <span className="inline-block w-[16px] h-[16px] rounded-full border-2" style={{ borderColor: 'var(--border)' }} />
}

function speedBadge(ms) {
  if (ms < 300) return { text: '快 ' + ms + 'ms', color: 'var(--success)' }
  if (ms < 1000) return { text: '中 ' + ms + 'ms', color: 'var(--warn)' }
  return { text: '慢 ' + ms + 'ms', color: 'var(--danger)' }
}

function speedTag(ms) {
  if (ms < 300) return 'success'
  if (ms < 1000) return 'warn'
  return 'danger'
}
const TAG_COLORS = { success: 'var(--success)', warn: 'var(--warn)', danger: 'var(--danger)' }

// 运行日志面板（终端风）：事件 → 日志行的着色与文案
const LOG_COLORS = { ok: '#7ee787', err: '#ff7b72', warn: '#e3b341', info: '#c9d1d9', dim: '#8b949e' }
const STAGE_LABELS = Object.fromEntries(STAGES.map((s) => [s.key, s.label]))
const fmtClock = () => new Date().toTimeString().slice(0, 8)

export default function App() {
  const [targets, setTargets] = useState([])
  const [baseUrl, setBaseUrl] = useState('https://ai.heigh.vip')
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [running, setRunning] = useState(false)
  const [stages, setStages] = useState({})
  const [models, setModels] = useState([])
  const [changes, setChanges] = useState([])
  const [results, setResults] = useState([])
  const [finalMsg, setFinalMsg] = useState(null)
  const [error, setError] = useState('')
  const [showDetail, setShowDetail] = useState(false)
  const [sel, setSel] = useState({})
  // Codex 模型范围：all-models = cc-switch 本地路由（默认推荐）；gpt-only = 直连改配置文件
  const [codexMode, setCodexMode] = useState('all-models')
  const [proxyAutostart, setProxyAutostart] = useState(true)
  // 默认模型：下拉选择勾选范围内的模型；留空 = 未设置（服务端兜底 glm-5.3-flash）
  const [defaultModel, setDefaultModel] = useState('')
  const [modelFallback, setModelFallback] = useState('glm-5.3-flash')
  // 模型清单（填写 Key 后自动拉取）：siteModels = 站点可对话模型 id；
  // checkedIds = 勾选范围（拉取成功默认全选，取消勾选的模型不写入）；mStatus 三态。
  const [siteModels, setSiteModels] = useState([])
  const [checkedIds, setCheckedIds] = useState(() => new Set())
  const [mStatus, setMStatus] = useState('idle') // idle | loading | ok | fail
  const [mError, setMError] = useState('')
  const modelsAbortRef = useRef(null)
  const lastFetchRef = useRef('')
  // 模型自动更新（按目标注册）：已适配目标缺省即勾选（!== false），用户可逐项取消
  const [autoUpdate, setAutoUpdate] = useState({})
  // 运行日志窗口（查看详情右侧）：实时追加、自动滚底、上限 500 行
  const [showLog, setShowLog] = useState(false)
  const [logs, setLogs] = useState([])
  const logBoxRef = useRef(null)
  const pushLog = (kind, text) => setLogs((ls) => [...ls.slice(-499), { t: fmtClock(), kind, text }])
  useEffect(() => {
    const el = logBoxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs, showLog])

  // 目标检测三态：loading（首查在途）/ error（失败可重试）/ ready（成功，可能为空列表）
  const [targetsLoading, setTargetsLoading] = useState(true)
  const [targetsError, setTargetsError] = useState('')
  const refreshTargets = () => {
    setTargetsError('')
    api('/api/targets')
      .then((d) => setTargets(d.targets || []))
      .catch((e) => setTargetsError(e && e.message ? e.message : '网络错误'))
      .finally(() => setTargetsLoading(false))
  }
  useEffect(() => { refreshTargets() }, [])

  // 挂载时回填持久化的默认模型设置
  useEffect(() => {
    api('/api/settings')
      .then((d) => {
        setDefaultModel(d.defaultModel || '')
        if (d.defaultModelFallback) setModelFallback(d.defaultModelFallback)
      })
      .catch(() => {})
  }, [])

  const saveDefaultModel = (v) => {
    api('/api/settings', { method: 'POST', body: JSON.stringify({ defaultModel: v }) }).catch(() => {})
  }

  const runningRef = useRef(false)
  useEffect(() => { runningRef.current = running }, [running])

  // 拉取站点模型清单（服务端过滤非对话模型）；成功后默认全选。
  // 已持久化的默认模型不在新清单中时重置为未设置。
  const fetchSiteModels = (key, url) => {
    if (!key || !url) return
    if (modelsAbortRef.current) modelsAbortRef.current.abort()
    const ctl = new AbortController()
    modelsAbortRef.current = ctl
    lastFetchRef.current = key + '@' + url
    setMStatus('loading'); setMError('')
    api('/api/models', { method: 'POST', body: JSON.stringify({ baseUrl: url, apiKey: key }), signal: ctl.signal })
      .then((d) => {
        if (!d.ok) throw new Error(d.message || '拉取失败')
        const ids = d.models || []
        setSiteModels(ids)
        setCheckedIds(new Set(ids))
        setMStatus('ok')
        pushLog('info', '已拉取模型清单：' + ids.length + ' 个（默认全选，可取消勾选）')
        setDefaultModel((dm) => {
          if (dm && !ids.includes(dm)) {
            saveDefaultModel('')
            return ''
          }
          return dm
        })
      })
      .catch((e) => {
        if (e && e.name === 'AbortError') return
        setSiteModels([]); setCheckedIds(new Set())
        setMStatus('fail')
        setMError(e && e.message ? e.message : '网络错误')
      })
  }

  // 填写/修改 API Key 或中转地址后 700ms 防抖自动拉取；清空 Key 即清空清单
  useEffect(() => {
    const key = apiKey.trim()
    const url = baseUrl.trim()
    if (!key) {
      setMStatus('idle'); setMError(''); setSiteModels([]); setCheckedIds(new Set())
      lastFetchRef.current = ''
      return
    }
    if (runningRef.current || !url) return
    if (lastFetchRef.current === key + '@' + url) return
    const timer = setTimeout(() => fetchSiteModels(key, url), 700)
    return () => clearTimeout(timer)
  }, [apiKey, baseUrl])

  // 卸载时中断在途拉取
  useEffect(() => () => { if (modelsAbortRef.current) modelsAbortRef.current.abort() }, [])

  const toggleModel = (id) => {
    const has = checkedIds.has(id)
    setCheckedIds((s) => {
      const n = new Set(s)
      if (has) n.delete(id)
      else n.add(id)
      return n
    })
    // 取消勾选的模型若是当前默认模型 → 默认模型重置为未设置
    if (has && defaultModel === id) {
      setDefaultModel('')
      saveDefaultModel('')
    }
  }

  // 首次检测到目标后：默认勾选所有已安装项（用户可自由增删）
  useEffect(() => {
    if (targets.length === 0) return
    setSel((s) => {
      const next = { ...s }
      for (const t of targets) if (!(t.id in next)) next[t.id] = t.installed
      return next
    })
  }, [targets])

  const selectedIds = targets.filter((t) => sel[t.id]).map((t) => t.id)
  const hasCodex = selectedIds.includes('codexcli') || selectedIds.includes('codexdesktop')
  // 已选目标中「已适配模型自动更新」的清单（未来新工具适配后自动出现在此处）
  const auSelected = targets.filter((t) => sel[t.id] && t.autoupdateSupported)
  // 默认模型下拉选项 = 勾选范围内的模型（未勾选的模型不会写入，不能作为默认）
  const dmOptions = siteModels.filter((id) => checkedIds.has(id))
  const dmValue = dmOptions.includes(defaultModel) ? defaultModel : ''

  const handleEvent = (ev) => {
    if (ev.type === 'stage') {
      setStages((s) => ({ ...s, [ev.name]: { status: ev.status, detail: ev.detail || '' } }))
      const label = STAGE_LABELS[ev.name] || ev.name
      const suffix = ev.detail ? ' — ' + ev.detail : ''
      if (ev.status === 'ok') pushLog('ok', '✓ ' + label + suffix)
      else if (ev.status === 'fail') pushLog('err', '✗ ' + label + suffix)
      else if (ev.status === 'warn') pushLog('warn', '▲ ' + label + suffix)
      else pushLog('info', '▶ ' + label + suffix)
    } else if (ev.type === 'models') {
      setModels(ev.models || [])
      const ms = ev.models || []
      pushLog('info', '模型测速完成：' + ms.filter((m) => m.ok).length + '/' + ms.length + ' 成功')
    } else if (ev.type === 'diff') {
      setChanges(ev.changes || [])
      pushLog('info', '写入计划：' + (ev.changes || []).length + ' 个文件待写入')
    } else if (ev.type === 'done') {
      setResults(ev.results || []); setFinalMsg({ ok: ev.ok, message: ev.message }); refreshTargets()
      for (const r of ev.results || []) {
        pushLog(r.ok ? 'ok' : 'err', (r.ok ? '✓ ' : '✗ ') + (TARGET_NAMES[r.target] || r.target) + '：' + r.message)
      }
      pushLog(ev.ok ? 'ok' : 'err', ev.message)
    } else if (ev.type === 'error') {
      setError(ev.message)
      pushLog('err', ev.message)
    }
  }

  const runOneClick = async () => {
    setRunning(true); setStages({}); setModels([]); setChanges([]); setResults([]); setFinalMsg(null); setError(''); setLogs([])
    pushLog('info', '开始一键配置：' + (selectedIds.map((id) => TARGET_NAMES[id] || id).join('、') || '无目标'))
    try {
      const res = await fetch('/api/oneclick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: TOKEN },
        body: JSON.stringify({ baseUrl, apiKey, targets: selectedIds, codexMode, proxyAutostart, autoUpdate, defaultModel, checkedModels: [...checkedIds], workbuddyAutoUpdate: autoUpdate.workbuddy !== false }),
      })
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status)
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let idx
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          for (const line of raw.split('\n')) {
            if (line.startsWith('data: ')) {
              try { handleEvent(JSON.parse(line.slice(6))) } catch { /* 忽略坏帧 */ }
            }
          }
        }
      }
    } catch (e) {
      setError('请求失败：' + e.message)
      pushLog('err', '请求失败：' + e.message)
    } finally {
      setRunning(false)
    }
  }

  const rollback = async () => {
    setError('')
    pushLog('dim', '执行回滚…')
    try {
      const d = await api('/api/rollback', { method: 'POST', body: JSON.stringify({ target: 'all' }) })
      setFinalMsg({ ok: d.ok, message: d.message })
      pushLog(d.ok ? 'ok' : 'err', '回滚：' + d.message)
      refreshTargets()
    } catch (e) {
      setError('回滚失败：' + e.message)
      pushLog('err', '回滚失败：' + e.message)
    }
  }

  const canRun = !running && apiKey.trim() && baseUrl.trim() && selectedIds.length > 0

  return (
    <div className="min-h-full flex flex-col items-center" style={{ background: 'var(--bg)' }}>
      <div className="w-full" style={{ maxWidth: 860, padding: '24px 20px 40px' }}>
        {/* 标题 */}
        <div className="flex items-baseline gap-3 mb-5">
          <h1 className="text-[20px] font-semibold" style={{ color: 'var(--fg)' }}>天才驿站(ai.heigh.vip)</h1>
          <span className="text-[13px]" style={{ color: 'var(--muted)' }}>AI 工具第三方 API 一键配置器</span>
          <a href="https://ai.heigh.vip" target="_blank" rel="noreferrer" title="打开官网 https://ai.heigh.vip"
            onClick={(e) => { e.preventDefault(); window.open('https://ai.heigh.vip', '_blank') }}
            className="text-[13px] cursor-pointer hover:underline underline-offset-2"
            style={{ color: 'var(--accent)' }}>
            ai.heigh.vip
          </a>
        </div>

        {/* 目标多选卡片：勾选哪些就写入哪些 */}
        <div className="mb-1 text-[13px] flex items-center gap-1.5" style={{ color: 'var(--fg-2)' }}>
          选择要配置的目标工具（可多选）
          <span className="text-[12px]" style={{ color: 'var(--meta)' }}>
            已选 {selectedIds.length}/{targets.filter((t) => t.installed).length}
          </span>
        </div>
        {targets.length === 0 ? (
          targetsError ? (
            <div className="text-[13px] px-4 py-3 rounded-[8px] mb-4 flex items-center justify-between gap-3"
              style={{ background: 'var(--surface)', border: '1px solid var(--danger)' }}>
              <span style={{ color: 'var(--danger)' }}>目标检测失败：{targetsError}</span>
              <button type="button" onClick={refreshTargets}
                className="text-[12px] px-2.5 py-1 rounded-[6px] shrink-0 cursor-pointer"
                style={{ border: '1px solid var(--danger)', color: 'var(--danger)', background: 'var(--surface)' }}>
                重试
              </button>
            </div>
          ) : targetsLoading ? (
            <div className="text-[13px] px-4 py-3 rounded-[8px] mb-4" style={{ background: 'var(--surface)', color: 'var(--muted)' }}>
              正在检测已安装的目标工具…
            </div>
          ) : (
            <div className="text-[13px] px-4 py-3 rounded-[8px] mb-4 flex items-center justify-between gap-3"
              style={{ background: 'var(--surface)', color: 'var(--muted)' }}>
              <span>未检测到已安装的目标工具（安装 Codex CLI / Codex Desktop / WorkBuddy 后重新检测）</span>
              <button type="button" onClick={refreshTargets}
                className="text-[12px] px-2.5 py-1 rounded-[6px] shrink-0 cursor-pointer"
                style={{ border: '1px solid var(--border)', color: 'var(--fg-2)', background: 'var(--surface)' }}>
                重新检测
              </button>
            </div>
          )
        ) : (
          <div className="grid grid-cols-3 gap-2 mb-4">
            {targets.map((t) => {
              const Icon = TARGET_ICONS[t.id] || Terminal
              const checked = !!sel[t.id]
              const dot = t.configured ? 'var(--success)' : t.installed ? 'var(--meta)' : 'var(--border)'
              return (
                <button key={t.id} type="button" disabled={!t.installed}
                  onClick={() => setSel((s) => ({ ...s, [t.id]: !s[t.id] }))}
                  className="relative text-left rounded-[12px] px-3 py-2.5 border transition-colors disabled:opacity-55 disabled:cursor-not-allowed"
                  style={{
                    background: checked ? 'var(--accent-soft)' : 'var(--surface)',
                    borderColor: checked ? 'var(--accent)' : 'var(--border)',
                  }}
                  title={t.detail}>
                  {/* 右上角勾选圈 */}
                  <span className="absolute top-2.5 right-2.5 w-[18px] h-[18px] rounded-full flex items-center justify-center border"
                    style={{
                      borderColor: checked ? 'var(--accent)' : 'var(--border)',
                      background: checked ? 'var(--accent)' : 'var(--surface)',
                    }}>
                    {checked && <Check size={12} color="#fff" strokeWidth={3} />}
                  </span>
                  <div className="flex items-center gap-2 pr-6">
                    <Icon size={20} style={{ color: checked ? 'var(--accent)' : 'var(--fg-2)' }} />
                    <span className="text-[14px] font-medium" style={{ color: 'var(--fg)' }}>{t.displayName}</span>
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: dot }}
                      title={t.configured ? '已配置' : t.installed ? '已安装未配置' : '未安装'} />
                  </div>
                  <div className="text-[12px] mt-1 leading-4 pr-2" style={{ color: 'var(--muted)' }}>
                    {t.installed ? t.detail : '未检测到，暂不可选'}
                  </div>
                </button>
              )
            })}
          </div>
        )}

        {/* 主表单 */}
        <div className="rounded-[12px] p-5" style={{ background: 'var(--surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-raised)' }}>
          <label className="flex items-center gap-2 text-[13px] mb-2" style={{ color: 'var(--fg-2)' }}>
            <Link2 size={16} /> 中转地址
          </label>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} spellCheck={false}
            placeholder="https://your-relay.example.com（末尾多余 /v1 会自动纠偏）"
            className="mono w-full h-10 px-3 rounded-[6px] outline-none text-[14px]"
            style={{ background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--fg)' }} />

          <label className="flex items-center gap-2 text-[13px] mt-4 mb-2" style={{ color: 'var(--fg-2)' }}>
            <KeyRound size={16} /> API Key
          </label>
          <div className="relative">
            <input type={showKey ? 'text' : 'password'} value={apiKey} onChange={(e) => setApiKey(e.target.value)} spellCheck={false}
              placeholder="sk-..."
              className="mono w-full h-10 pl-3 pr-10 rounded-[6px] outline-none text-[14px]"
              style={{ background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--fg)' }} />
            <button onClick={() => setShowKey((v) => !v)} type="button"
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-[6px]"
              style={{ color: 'var(--muted)' }} title={showKey ? '隐藏' : '显示'}>
              {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>

          {/* 模型范围：填写 Key 后自动拉取站点模型清单，默认全选；取消勾选的模型不写入 */}
          <div className="mt-5">
            <div className="flex items-center justify-between mb-2">
              <label className="flex items-center gap-2 text-[13px]" style={{ color: 'var(--fg-2)' }}>
                <ListChecks size={16} /> 模型范围
                {mStatus === 'ok' && (
                  <span className="text-[12px]" style={{ color: 'var(--meta)' }}>
                    已检测 {siteModels.length} 个 · 勾选 {checkedIds.size} 个
                  </span>
                )}
              </label>
              {mStatus === 'ok' && siteModels.length > 0 && (
                <div className="flex items-center gap-3 text-[12px]">
                  <button type="button" onClick={() => setCheckedIds(new Set(siteModels))}
                    className="cursor-pointer" style={{ color: 'var(--accent)' }}>全选</button>
                  <button type="button" onClick={() => setCheckedIds(new Set())}
                    className="cursor-pointer" style={{ color: 'var(--muted)' }}>全不选</button>
                  <button type="button" onClick={() => fetchSiteModels(apiKey.trim(), baseUrl.trim())} disabled={running}
                    className="flex items-center gap-1 cursor-pointer disabled:opacity-50" style={{ color: 'var(--muted)' }}>
                    <RefreshCw size={12} /> 重新拉取
                  </button>
                </div>
              )}
            </div>
            {mStatus === 'idle' && (
              <div className="text-[12px] px-3 py-2.5 rounded-[8px]" style={{ background: 'var(--surface-warm)', color: 'var(--meta)' }}>
                填写 API Key 后自动拉取站点模型清单
              </div>
            )}
            {mStatus === 'loading' && (
              <div className="text-[12px] px-3 py-2.5 rounded-[8px] flex items-center gap-2" style={{ background: 'var(--surface-warm)', color: 'var(--muted)' }}>
                <LoaderCircle size={14} className="animate-spin" /> 正在拉取模型清单…
              </div>
            )}
            {mStatus === 'fail' && (
              <div className="text-[12px] px-3 py-2.5 rounded-[8px] flex items-center justify-between gap-3" style={{ background: 'var(--surface-warm)', border: '1px solid var(--danger)' }}>
                <span style={{ color: 'var(--danger)' }}>拉取失败：{mError}</span>
                <button type="button" onClick={() => fetchSiteModels(apiKey.trim(), baseUrl.trim())}
                  className="text-[12px] px-2.5 py-1 rounded-[6px] shrink-0 cursor-pointer"
                  style={{ border: '1px solid var(--danger)', color: 'var(--danger)', background: 'var(--surface)' }}>
                  重试
                </button>
              </div>
            )}
            {mStatus === 'ok' && (
              siteModels.length === 0 ? (
                <div className="text-[12px] px-3 py-2.5 rounded-[8px]" style={{ background: 'var(--surface-warm)', color: 'var(--meta)' }}>
                  站点未返回可对话模型
                </div>
              ) : (
                <div className="rounded-[8px] p-2 overflow-y-auto" style={{ background: 'var(--bg)', border: '1px solid var(--border)', maxHeight: 176 }}>
                  <div className="grid grid-cols-2 gap-x-4">
                    {siteModels.map((id) => (
                      <label key={id} className="flex items-center gap-2 py-1 cursor-pointer min-w-0">
                        <input type="checkbox" checked={checkedIds.has(id)} onChange={() => toggleModel(id)} className="shrink-0" />
                        <span className="mono text-[12px] truncate" style={{ color: 'var(--fg-2)' }} title={id}>{id}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )
            )}
            <div className="text-[12px] mt-1.5" style={{ color: 'var(--meta)' }}>
              勾选的模型才会写入工具；全部取消勾选时使用站点全部可对话模型。
            </div>
          </div>

          {/* 默认模型（下拉选择勾选范围内的模型；未设置时服务端兜底 glm-5.3-flash） */}
          <label className="flex items-center gap-2 text-[13px] mt-4 mb-2" style={{ color: 'var(--fg-2)' }}>
            <Cpu size={16} /> 默认模型
          </label>
          <select value={dmValue} spellCheck={false}
            onChange={(e) => { setDefaultModel(e.target.value); saveDefaultModel(e.target.value) }}
            disabled={dmOptions.length === 0}
            className="mono w-full h-10 px-3 rounded-[6px] outline-none text-[14px] disabled:opacity-60"
            style={{ background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--fg)' }}>
            <option value="">
              {dmOptions.length ? '未设置（默认 ' + modelFallback + '，不在勾选范围时回退测速最快）' : '拉取模型清单后可选择'}
            </option>
            {dmOptions.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
          <div className="text-[12px] mt-1.5" style={{ color: 'var(--meta)' }}>
            将设为所选工具的默认模型；可选项为勾选范围内的模型，未设置时使用 {modelFallback}（不在列表则回退测速最快模型）。
          </div>

          {/* Codex 模型范围（勾选任一 Codex 目标时显示） */}
          {hasCodex && (
            <div className="mt-5">
              <label className="flex items-center gap-2 text-[13px] mb-2" style={{ color: 'var(--fg-2)' }}>
                <Layers size={16} /> Codex 模型范围
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setCodexMode('gpt-only')}
                  className="text-left rounded-[8px] px-3 py-2.5 border transition-colors"
                  style={{
                    background: codexMode === 'gpt-only' ? 'var(--accent-soft)' : 'var(--bg)',
                    borderColor: codexMode === 'gpt-only' ? 'var(--accent)' : 'var(--border)',
                  }}>
                  <div className="text-[13px] font-medium" style={{ color: 'var(--fg)' }}>
                    仅 GPT 系模型
                  </div>
                  <div className="text-[12px] mt-0.5 leading-4" style={{ color: 'var(--muted)' }}>
                    直连中转站，仅修改 Codex 配置文件，无需额外组件
                  </div>
                </button>
                <button type="button" onClick={() => setCodexMode('all-models')}
                  className="text-left rounded-[8px] px-3 py-2.5 border transition-colors"
                  style={{
                    background: codexMode === 'all-models' ? 'var(--accent-soft)' : 'var(--bg)',
                    borderColor: codexMode === 'all-models' ? 'var(--accent)' : 'var(--border)',
                  }}>
                  <div className="text-[13px] font-medium" style={{ color: 'var(--fg)' }}>全部模型<span className="ml-1.5 text-[11px] font-normal" style={{ color: 'var(--accent)' }}>推荐</span></div>
                  <div className="text-[12px] mt-0.5 leading-4" style={{ color: 'var(--muted)' }}>
                    经 cc-switch 本地路由（自动安装并配置 cc-switch，解除模型名限制）
                  </div>
                </button>
              </div>
              {codexMode === 'all-models' && (
                <label className="flex items-center gap-2 text-[13px] mt-2 cursor-pointer" style={{ color: 'var(--fg-2)' }}>
                  <input type="checkbox" checked={proxyAutostart} onChange={(e) => setProxyAutostart(e.target.checked)} />
                  cc-switch 开机自启（推荐勾选，保证本地路由随时可用）
                </label>
              )}
            </div>
          )}

          {/* 模型自动更新（凡已适配该能力的已选目标均默认勾选） */}
          {auSelected.map((t) => (
            <label key={t.id} className="flex items-center gap-2 text-[13px] mt-4 cursor-pointer" style={{ color: 'var(--fg-2)' }}>
              <input type="checkbox" checked={autoUpdate[t.id] !== false} onChange={(e) => setAutoUpdate((m) => ({ ...m, [t.id]: e.target.checked }))} />
              <RefreshCw size={14} />
              {t.displayName} 模型自动更新（{t.autoupdateLabel}）
            </label>
          ))}

          {/* 详情 / 运行日志（日志窗口在查看详情右侧，实时输出可跟踪错误） */}
          <div className="flex items-center gap-4 mt-4">
            <button onClick={() => setShowDetail((v) => !v)} type="button"
              className="flex items-center gap-1.5 text-[13px]" style={{ color: 'var(--muted)' }}>
              {showDetail ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              查看详情（进度 / 模型测速 / 写入计划）
            </button>
            <button onClick={() => setShowLog((v) => !v)} type="button"
              className="flex items-center gap-1.5 text-[13px] transition-colors" style={{ color: showLog ? 'var(--accent)' : 'var(--muted)' }}>
              <Terminal size={14} />
              运行日志
              {running && <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: 'var(--success)' }} />}
            </button>
          </div>
          {(showDetail || showLog) && (
            <div className={'mt-3 ' + (showDetail && showLog ? 'grid grid-cols-2 gap-3 items-start' : '')}>
              {showDetail && (
                <div className="min-w-0">
                  {/* 流水线阶段 */}
                  <div className="rounded-[8px] p-3" style={{ background: 'var(--surface-warm)' }}>
                    {STAGES.map((s) => {
                      const st = stages[s.key]
                      return (
                        <div key={s.key} className="flex items-start gap-2 py-1 text-[13px]">
                          <span className="mt-[1px]"><StageIcon status={st && st.status} /></span>
                          <span style={{ color: 'var(--fg-2)' }}>{s.label}</span>
                          {st && st.detail && <span style={{ color: st.status === 'fail' ? 'var(--danger)' : 'var(--meta)' }}>{st.detail}</span>}
                        </div>
                      )
                    })}
                  </div>
                  {/* 模型测速 */}
                  {models.length > 0 && (
                    <div className="mt-3 rounded-[8px] p-3" style={{ background: 'var(--surface-warm)' }}>
                      <div className="flex items-center gap-2 text-[13px] mb-2" style={{ color: 'var(--fg-2)' }}>
                        <Gauge size={16} /> 模型测速
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {models.map((m) => (
                          <span key={m.id} className="mono text-[12px] px-2 py-1 rounded-[6px] flex items-center gap-1.5"
                            style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: m.ok ? TAG_COLORS[speedTag(m.ttftMs)] : 'var(--meta)' }}>
                            {m.id}
                            {m.ok ? <b className="font-medium">{speedBadge(m.ttftMs).text}</b> : <b className="font-medium">失败</b>}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {/* 写入计划 Diff */}
                  {changes.length > 0 && (
                    <div className="mt-3 rounded-[8px] p-3" style={{ background: 'var(--surface-warm)' }}>
                      <div className="flex items-center gap-2 text-[13px] mb-2" style={{ color: 'var(--fg-2)' }}>
                        <FileDiff size={16} /> 写入计划
                      </div>
                      {changes.map((c) => (
                        <div key={c.file} className="mb-2">
                          <div className="mono text-[12px]" style={{ color: 'var(--fg)' }}>{c.file}</div>
                          <div className="text-[12px]" style={{ color: 'var(--meta)' }}>{c.summary}</div>
                          <pre className="mono text-[12px] leading-5 mt-1 rounded-[6px] p-2 overflow-auto" style={{ background: 'var(--surface)', maxHeight: 180 }}>
                            {c.diff.map((l, i) => (
                              <div key={i} style={{ color: l.startsWith('+') ? 'var(--success)' : l.startsWith('-') ? 'var(--danger)' : 'var(--muted)' }}>{l}</div>
                            ))}
                          </pre>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {showLog && (
                <div ref={logBoxRef} className="mono min-w-0 rounded-[8px] p-3 overflow-y-auto"
                  style={{
                    background: '#0d1117', border: '1px solid #30363d',
                    maxHeight: showDetail ? 460 : 260, fontSize: 12, lineHeight: '19px',
                  }}>
                  {logs.length === 0 ? (
                    <div style={{ color: LOG_COLORS.dim }}>等待事件…点击「一键配置」后此处实时输出执行日志（含错误详情）</div>
                  ) : (
                    logs.map((l, i) => (
                      <div key={i} className="whitespace-pre-wrap break-all">
                        <span style={{ color: LOG_COLORS.dim }}>[{l.t}]</span>{' '}
                        <span style={{ color: LOG_COLORS[l.kind] || LOG_COLORS.info }}>{l.text}</span>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          )}

          {/* 错误与结果 */}
          {error && (
            <div className="mt-4 rounded-[8px] px-3 py-2.5 text-[13px] flex items-start gap-2"
              style={{ background: 'var(--surface-warm)', border: '1px solid var(--danger)', color: 'var(--danger)' }}>
              <CircleAlert size={16} className="mt-[1px]" />
              <span>{error}</span>
            </div>
          )}
          {results.length > 0 && (
            <div className="mt-4 rounded-[8px] px-3 py-2.5 text-[13px]" style={{ background: 'var(--surface-warm)' }}>
              {results.map((r) => (
                <div key={r.target} className="flex items-center gap-2 py-0.5" style={{ color: r.ok ? 'var(--success)' : 'var(--danger)' }}>
                  {r.ok ? <CircleCheck size={16} /> : <CircleAlert size={16} />}
                  <span style={{ color: 'var(--fg-2)' }}>{TARGET_NAMES[r.target] || r.target}</span>
                  <span>{r.message}</span>
                </div>
              ))}
            </div>
          )}

          {/* 底部操作栏 */}
          <div className="flex items-center justify-between mt-5 pt-4" style={{ borderTop: '1px solid var(--border-soft)' }}>
            <button onClick={rollback} disabled={running} type="button"
              className="flex items-center gap-1.5 h-10 px-4 rounded-[6px] text-[14px] border disabled:opacity-50"
              style={{ background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--fg-2)' }}>
              <RotateCcw size={16} /> 回滚
            </button>
            <button onClick={runOneClick} disabled={!canRun} type="button"
              className="flex items-center gap-2 h-10 px-6 rounded-[6px] text-[14px] font-medium text-white disabled:opacity-50 transition-colors"
              style={{ background: running ? 'var(--accent-active)' : 'var(--accent)' }}
              onMouseEnter={(e) => { if (!running) e.currentTarget.style.background = 'var(--accent-hover)' }}
              onMouseLeave={(e) => { if (!running) e.currentTarget.style.background = 'var(--accent)' }}>
              {running ? <LoaderCircle size={18} className="animate-spin" /> : <Zap size={18} />}
              {running ? '正在配置…' : '一键配置'}
            </button>
          </div>

          {finalMsg && (
            <div className="mt-4 rounded-[8px] px-3 py-2.5 text-[13px] flex items-start gap-2"
              style={{
                background: 'var(--surface-warm)',
                border: '1px solid ' + (finalMsg.ok ? 'var(--success)' : 'var(--danger)'),
                color: finalMsg.ok ? 'var(--success)' : 'var(--danger)',
              }}>
              {finalMsg.ok ? <CircleCheck size={16} className="mt-[1px]" /> : <CircleAlert size={16} className="mt-[1px]" />}
              <span>{finalMsg.message}</span>
            </div>
          )}
        </div>

        <div className="mt-4 text-[12px] leading-5" style={{ color: 'var(--meta)' }}>
          <div className="flex items-center gap-1.5">
            <Save size={14} />
            写入前自动备份至 ~/.tiancaiConfig/backups；Key 仅写入目标工具官方配置，本工具不做存储。
          </div>
          <div className="mt-1">Codex Desktop ASAR 补丁（解除模型白名单）规划中，后续版本将以「显式勾选 + 二次确认 + 独立副本」方式提供。</div>
        </div>
      </div>
    </div>
  )
}
