// backup.js 单测：快照/回滚闭环、新建文件回滚即删除、轮转保留 5 份。
'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const backup = require('../src/engine/backup')

test('snapshot → restore 往返', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-bk-'))
  const orig = path.join(home, 'some', 'file.json')
  fs.mkdirSync(path.dirname(orig), { recursive: true })
  fs.writeFileSync(orig, '{"v":1}')

  const { dir, backed } = backup.snapshot(home, 'testtarget', [orig])
  assert.strictEqual(backed.length, 1)

  fs.writeFileSync(orig, '{"v":2}')
  const restored = backup.restore(dir)
  assert.strictEqual(restored.length, 1)
  assert.strictEqual(fs.readFileSync(orig, 'utf8'), '{"v":1}')
})

test('回滚删除原本不存在的文件', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-bk-'))
  const orig = path.join(home, 'a', 'new.json')
  backup.snapshot(home, 'testtarget', [orig]) // 快照时不存在
  fs.mkdirSync(path.dirname(orig), { recursive: true })
  fs.writeFileSync(orig, 'new')
  const restored = backup.rollbackLatest(home, 'testtarget')
  assert.ok(!fs.existsSync(orig), '原本不存在的文件应被删除')
  assert.ok(restored[0].includes('已删除'))
})

test('rotate 保留最近 5 份（同秒快照目录名防碰撞）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'triconfig-rt-'))
  const f = path.join(home, 'f.txt')
  fs.writeFileSync(f, 'x')
  for (let i = 0; i < 7; i++) backup.snapshot(home, 'testtarget', [f])
  const dirs = fs
    .readdirSync(path.join(home, '.tiancaiConfig', 'backups', 'testtarget'))
    .sort()
  assert.strictEqual(dirs.length, 5)
  assert.ok(backup.latestDir(home, 'testtarget'))
})
