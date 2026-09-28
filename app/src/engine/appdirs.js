// tiancaiConfig 数据目录（~/.tiancaiConfig）：网关记忆 / 备份 / 自动更新日志。
// 更名自 ~/.triconfig：首次访问时把旧目录整体搬入新目录（幂等，rename 原子）。
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const DIR_NAME = '.tiancaiConfig'
const LEGACY_DIR_NAME = '.triconfig'

function dataDir(home) {
  const h = home || os.homedir()
  const dir = path.join(h, DIR_NAME)
  const legacy = path.join(h, LEGACY_DIR_NAME)
  try {
    if (fs.existsSync(legacy) && !fs.existsSync(dir)) {
      fs.renameSync(legacy, dir)
    }
  } catch {}
  return dir
}

module.exports = { DIR_NAME, LEGACY_DIR_NAME, dataDir }
