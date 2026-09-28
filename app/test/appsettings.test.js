// 应用设置单测：默认模型读写 roundtrip、坏 JSON 容错、undefined 删键、缺省兜底 glm-5.3-flash。
'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const appsettings = require('../src/engine/appsettings')

test('appsettings：DEFAULT_MODEL 兜底为 glm-5.3-flash（2026-09-26 需求）', () => {
  assert.strictEqual(appsettings.DEFAULT_MODEL, 'glm-5.3-flash')
})

test('appsettings：写入后回读 + 原子落盘（无 .tmp 残留）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tiancai-set-'))
  appsettings.writeSettings(home, { defaultModel: 'glm-5.3-flash' })
  const sp = appsettings.settingsPath(home)
  assert.ok(fs.existsSync(sp), 'settings.json 应存在')
  assert.strictEqual(fs.existsSync(sp + '.tmp'), false, '不应残留 .tmp')
  assert.strictEqual(appsettings.readSettings(home).defaultModel, 'glm-5.3-flash')

  // 合并写入保留其他键；undefined 删除键
  appsettings.writeSettings(home, { other: 'v1' })
  appsettings.writeSettings(home, { defaultModel: undefined })
  const m = appsettings.readSettings(home)
  assert.strictEqual(m.other, 'v1', '其他键应保留')
  assert.ok(!('defaultModel' in m), 'undefined 应删除键')
})

test('appsettings：缺失/损坏文件按未设置处理，resolveDefaultModel 兜底', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tiancai-set2-'))
  assert.deepStrictEqual(appsettings.readSettings(home), {})
  assert.strictEqual(appsettings.resolveDefaultModel(home), 'glm-5.3-flash')

  fs.mkdirSync(path.join(home, '.tiancaiConfig'), { recursive: true })
  fs.writeFileSync(appsettings.settingsPath(home), '{ broken json')
  assert.deepStrictEqual(appsettings.readSettings(home), {}, '坏 JSON 应按空对象')
  assert.strictEqual(appsettings.resolveDefaultModel(home), 'glm-5.3-flash')

  // 空白值等同未设置；有效设置生效
  appsettings.writeSettings(home, { defaultModel: '  ' })
  assert.strictEqual(appsettings.resolveDefaultModel(home), 'glm-5.3-flash')
  appsettings.writeSettings(home, { defaultModel: ' z-slow ' })
  assert.strictEqual(appsettings.resolveDefaultModel(home), 'z-slow', '设置值应 trim')
})
