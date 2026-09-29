// toml.js 单测：TOML 合并保留用户段落、替换供应商块、顶层键唯一。
'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { buildTOML, hasProviderBlock, lineDiff, setTopKey } = require('../src/engine/toml')

const USER_TOML = `# 用户注释
custom_flag = true

[profiles.work]
x = 1

[model_providers.triconfig]
name = "triconfig"
base_url = "https://old.example/v1"
wire_api = "responses"
`

test('buildTOML 全新配置', () => {
  const out = buildTOML('', 'https://new.example', 'a-fast')
  for (const want of [
    'model_provider = "tiancaiconfig"',
    'model = "a-fast"',
    'review_model = "a-fast"',
    'model_reasoning_effort = "xhigh"',
    'model_context_window = 272000',
    'base_url = "https://new.example/v1"',
    'wire_api = "responses"',
    'env_key = "TIANCAICONFIG_API_KEY"',
    'requires_openai_auth = false',
  ]) {
    assert.ok(out.includes(want), '缺少 ' + want + '\n' + out)
  }
})

test('buildTOML 保留用户段落并替换旧供应商块', () => {
  const out = buildTOML(USER_TOML, 'https://new.example', 'a-fast')
  assert.ok(out.includes('custom_flag = true'), '用户顶层键丢失')
  assert.ok(out.includes('[profiles.work]') && out.includes('x = 1'), '用户自定义段落丢失')
  assert.ok(out.includes('# 用户注释'), '用户注释丢失')
  assert.ok(!out.includes('old.example'), '旧供应商块未替换')
  assert.strictEqual((out.match(/\[model_providers\.tiancaiconfig\]/g) || []).length, 1, '新供应商块应恰好 1 个')
  assert.strictEqual((out.match(/\[model_providers\.triconfig\]/g) || []).length, 0, '更名前的 triconfig 旧块应被清理')
  const n = (out.match(/^model = /gm) || []).length
  assert.strictEqual(n, 1, 'model 顶层键应恰好 1 个（按行首匹配）')
})

test('hasProviderBlock', () => {
  assert.strictEqual(hasProviderBlock(USER_TOML), false, '更名前的 triconfig 块不应再被识别')
  assert.strictEqual(hasProviderBlock('[model_providers.tiancaiconfig]\nx = 1\n'), true)
  assert.strictEqual(hasProviderBlock('[profiles.x]\ny=2\n'), false)
})

test('lineDiff 增删行', () => {
  const d = lineDiff('a = 1\nb = 2\n', 'a = 1\nc = 3\n', 40)
  const joined = d.join('\n')
  assert.ok(joined.includes('- b = 2'))
  assert.ok(joined.includes('+ c = 3'))
})

test('setTopKey 重复键收口为唯一一行（默认思考量失控防御）', () => {
  // 历史现场：medium 在前、max 在后，TOML 后键静默覆盖前键，UI 显示失控
  const dirty = 'model_reasoning_effort = "medium"\nmodel = "glm-5.3-flash"\n\n[model_providers.x]\nname = "x"\n\nmodel_reasoning_effort="max"\n'
  const out = setTopKey(dirty.split('\n'), 'model_reasoning_effort', '"xhigh"').join('\n')
  const n = (out.match(/^model_reasoning_effort\s*=/gm) || []).length
  assert.strictEqual(n, 1, '重复键应只保留 1 个，实际 ' + n + ' 个\n' + out)
  assert.ok(out.includes('model_reasoning_effort = "xhigh"'), '应写入 xhigh\n' + out)
  assert.ok(!out.includes('"max"') || out.indexOf('model_reasoning_effort="max"') === -1, '旧 max 键应被删除')
  assert.ok(out.includes('model = "glm-5.3-flash"'), '无关行不受影响')
})

test('setTopKey 无该键时前置插入', () => {
  const out = setTopKey(['# 注释', '', 'a = 1'].join('\n').split('\n'), 'flag', 'true').join('\n')
  const lines = out.split('\n')
  assert.strictEqual(lines[2], 'flag = true', '应插在注释与空行之后、首个实体行之前\n' + out)
})
