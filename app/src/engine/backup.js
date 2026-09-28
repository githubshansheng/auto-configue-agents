// 写前快照、一键回滚与轮转清理（从 Go 引擎 1:1 移植；每目标保留最近 5 份）。
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { dataDir } = require('./appdirs')

const KEEP = 5
const MANIFEST = '_paths.txt'

function baseDir(home, target) {
  return path.join(dataDir(home), 'backups', target)
}

function pad(n) {
  return String(n).padStart(2, '0')
}

function timestamp(d) {
  return (
    d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' +
    pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds())
  )
}

// snapshot 把 files 中存在的文件复制到 ~/.tiancaiConfig/backups/<target>/<时间戳>/，
// 并写入来源清单（回滚时用于定位原路径与「原本不存在→删除」语义）。
// 同秒多次快照时目录名追加序号，避免互相覆盖。
function snapshot(home, target, files) {
  const root = baseDir(home, target)
  const ts = timestamp(new Date())
  let dir = path.join(root, ts)
  for (let i = 1; fs.existsSync(dir); i++) dir = path.join(root, ts + '-' + i)
  fs.mkdirSync(dir, { recursive: true })
  const backed = []
  let manifest = ''
  for (const f of files || []) {
    manifest += f + '\n'
    try {
      const data = fs.readFileSync(f)
      fs.writeFileSync(path.join(dir, path.basename(f)), data)
      backed.push(f)
    } catch (e) {
      if (e.code !== 'ENOENT') throw new Error('读取 ' + f + ' 失败：' + e.message)
      // 原本不存在：仅记入清单，回滚时删除
    }
  }
  fs.writeFileSync(path.join(dir, MANIFEST), manifest)
  rotate(home, target)
  return { dir, backed }
}

// restore 按来源清单还原；清单中「原本不存在」的文件将被删除。
function restore(dir) {
  const manifest = fs.readFileSync(path.join(dir, MANIFEST), 'utf8')
  const restored = []
  for (const orig of manifest.split('\n').map((s) => s.trim()).filter(Boolean)) {
    const bak = path.join(dir, path.basename(orig))
    let data
    try {
      data = fs.readFileSync(bak)
    } catch (e) {
      if (e.code === 'ENOENT') {
        try {
          fs.unlinkSync(orig)
          restored.push(orig + '（已删除）')
        } catch {}
        continue
      }
      throw new Error('读取备份 ' + bak + ' 失败：' + e.message)
    }
    fs.writeFileSync(orig, data)
    restored.push(orig)
  }
  return restored
}

function listDirs(home, target) {
  const root = baseDir(home, target)
  let entries
  try {
    entries = fs.readdirSync(root)
  } catch {
    return []
  }
  return entries
    .sort()
    .map((n) => path.join(root, n))
    .filter((d) => {
      try {
        return fs.statSync(d).isDirectory()
      } catch {
        return false
      }
    })
}

// rotate 只保留最近 KEEP 份备份。
function rotate(home, target) {
  const dirs = listDirs(home, target)
  const excess = dirs.length - KEEP
  for (let i = 0; i < excess; i++) fs.rmSync(dirs[i], { recursive: true, force: true })
}

function latestDir(home, target) {
  const dirs = listDirs(home, target)
  if (!dirs.length) throw new Error('没有可用的备份')
  return dirs[dirs.length - 1]
}

// rollbackLatest 还原指定目标最近一次备份，返回影响的文件列表。
function rollbackLatest(home, target) {
  return restore(latestDir(home, target))
}

module.exports = { snapshot, restore, rotate, latestDir, rollbackLatest, KEEP }
