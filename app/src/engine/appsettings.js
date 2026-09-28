// 应用设置（~/.tiancaiConfig/settings.json）：默认模型等用户偏好。
// 设置缺失/损坏一律按未设置处理（readSettings 返回空对象），由调用方兜底。
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { dataDir } = require('./appdirs')

// 用户未设置默认模型时的兜底值（2026-09-26 需求：默认 glm-5.3-flash）
const DEFAULT_MODEL = 'glm-5.3-flash'

function settingsPath(home) {
  return path.join(dataDir(home), 'settings.json')
}

function readSettings(home) {
  try {
    const m = JSON.parse(fs.readFileSync(settingsPath(home), 'utf8'))
    return m && typeof m === 'object' && !Array.isArray(m) ? m : {}
  } catch {
    return {}
  }
}

// writeSettings 合并写入（patch 中 undefined 表示删除该键）；tmp+rename 原子落盘
function writeSettings(home, patch) {
  const sp = settingsPath(home)
  const m = readSettings(home)
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined) delete m[k]
    else m[k] = v
  }
  fs.mkdirSync(path.dirname(sp), { recursive: true })
  const tmp = sp + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n')
  fs.renameSync(tmp, sp)
  return m
}

// resolveDefaultModel 生效中的默认模型：用户设置（trim）优先，未设置 → DEFAULT_MODEL
function resolveDefaultModel(home) {
  const v = String(readSettings(home).defaultModel || '').trim()
  return v || DEFAULT_MODEL
}

module.exports = { DEFAULT_MODEL, settingsPath, readSettings, writeSettings, resolveDefaultModel }
