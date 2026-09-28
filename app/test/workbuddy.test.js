// workbuddy.js 单测：合并语义、条目 schema、写入/校验/回滚闭环。
'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const wb = require('../src/engine/workbuddy')

function cfg(models) {
  return {
    baseUrl: 'https://relay.example',
    apiKey: 'sk-test',
    defaultModel: 'glm-5.3-flash',
    models,
  }
}

test('outCap 按模型映射输出上限', () => {
  const cases = {
    'deepseek-v4-pro': 393216,
    'glm-5.3-flash': 131072,
    'gemini-3.6-flash': 65536,
    'gpt-5.6-sol': 128000,
    'some-new-model': 131072,
    'qwen3.7-text-embedding': 8192,
  }
  for (const [id, want] of Object.entries(cases)) {
    assert.strictEqual(wb.outCap(id), want, id)
  }
})

test('merge 保留外部条目、清除白名单历史与已下线条目、覆盖同 ID', () => {
  const existing = [
    { id: 'foreign-manual', url: 'https://other.example/v1/chat/completions' },
    { id: 'text-embedding-x', url: 'https://relay.example/v1/chat/completions' },
    { id: 'glm-5.3-flash', url: 'https://relay.example/v1/chat/completions', apiKey: 'sk-old' },
    { id: 'retired-model', url: 'https://relay.example/v1/chat/completions', apiKey: 'sk-old' }, // 本网关已下线
  ]
  const { list, summary } = wb.merge(existing, cfg([{ id: 'glm-5.3-flash', ok: true }, { id: 'deepseek-v4-pro', ok: true }]))
  assert.strictEqual(list.length, 3, 'foreign 保留 + 2 托管')
  const ids = new Set(list.map((e) => e.id))
  assert.ok(ids.has('foreign-manual'), '外部手工条目应保留')
  assert.ok(!ids.has('text-embedding-x'), '白名单历史条目应清除')
  assert.ok(!ids.has('retired-model'), '本网关已下线条目应清除（对齐旧脚本 is_ours 重建语义）')
  assert.ok(
    summary.includes('更新 1') && summary.includes('新增 2') && summary.includes('清除白名单历史 1') && summary.includes('清理已下线 1'),
    summary
  )
})

test('makeEntry schema 与官方引擎读取字段对齐', () => {
  const e = wb.makeEntry('glm-5.3-flash', cfg())
  assert.strictEqual(e.maxInputTokens, 300000)
  assert.strictEqual(e.maxOutputTokens, 131072)
  assert.strictEqual(e.url, 'https://relay.example/v1/chat/completions')
  assert.strictEqual(e.reasoning.defaultEffort, 'xhigh')
  assert.strictEqual(e.reasoning.canDisableThinking, false)
  assert.strictEqual(e.reasoning.supportedEfforts.length, 6)
  assert.strictEqual(e.supportsImages, true)
})

test('写入 → 校验 → 回滚闭环', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-wb-'))
  const t = { home }
  const c = cfg([{ id: 'glm-5.3-flash', ok: true, ttftMs: 42 }, { id: 'deepseek-v4-pro', ok: true }])

  wb.configure(home, c) // 首次写入（文件不存在 → 创建，AC-04）
  const vr = wb.verify(home, c)
  assert.strictEqual(vr.ok, true, vr.message)

  // 模拟外部改写：文件只剩 foreign 条目
  const p = wb.modelsPath(home)
  fs.writeFileSync(p, JSON.stringify([{ id: 'foreign-manual' }]))

  const rec = wb.backup(home) // 捕获当前状态
  wb.configure(home, c) // 合并写入：foreign 保留 + 2 托管
  const mid = JSON.parse(fs.readFileSync(p, 'utf8'))
  assert.ok(mid.some((e) => e.id === 'foreign-manual'), '合并应保留外部条目')
  assert.ok(mid.some((e) => e.id === 'deepseek-v4-pro'))

  wb.rollback(rec) // 回滚 → 精确还原写前状态
  const after = JSON.parse(fs.readFileSync(p, 'utf8'))
  assert.strictEqual(after.length, 1)
  assert.strictEqual(after[0].id, 'foreign-manual')
})
