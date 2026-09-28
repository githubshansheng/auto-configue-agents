// 目标注册表：Codex CLI / Codex Desktop / WorkBuddy 三目标插件（顺序即 GUI 展示顺序）。
'use strict'

const codexconfig = require('./codexconfig')
const backup = require('./backup')
const workbuddy = require('./workbuddy')

function makeCodexTarget(id, displayName, desktop) {
  return {
    id,
    displayName,
    // 模型自动更新能力（已适配）：Codex CLI/Desktop 共用 ~/.codex 触发器（kind=codex，注册时去重）
    autoupdate: { kind: 'codex', label: '检测到 Codex 启动/会话时自动同步中转站最新模型列表' },
    detect(home) {
      const dr = codexconfig.detect(home, desktop)
      dr.id = id
      dr.displayName = displayName
      return dr
    },
    plan(home, cfg) {
      return codexconfig.plan(home, cfg)
    },
    backup(home) {
      const { toml, auth } = codexconfig.pathsFor(home)
      const { dir } = backup.snapshot(home, id, [toml, auth])
      return { dir, files: [toml, auth] }
    },
    configure(home, cfg, opts) {
      return codexconfig.configure(home, cfg, opts)
    },
    verify(home, cfg) {
      return codexconfig.verify(home, cfg)
    },
    rollback(receipt) {
      return codexconfig.rollback(receipt)
    },
  }
}

const workbuddyTarget = {
  id: 'workbuddy',
  displayName: 'WorkBuddy',
  // 模型自动更新能力（已适配）：GUI 按此字段渲染开关并默认勾选
  autoupdate: { kind: 'workbuddy', label: '检测到 WorkBuddy 启动时自动同步中转站最新模型列表' },
  detect(home) {
    const dr = workbuddy.detect(home)
    dr.id = 'workbuddy'
    dr.displayName = 'WorkBuddy'
    return dr
  },
  plan(home, cfg) {
    return workbuddy.plan(home, cfg)
  },
  backup(home) {
    return workbuddy.backup(home)
  },
  configure(home, cfg) {
    return workbuddy.configure(home, cfg)
  },
  verify(home, cfg) {
    return workbuddy.verify(home, cfg)
  },
  rollback(receipt) {
    return workbuddy.rollback(receipt)
  },
}

function all() {
  return [makeCodexTarget('codexcli', 'Codex CLI', false), makeCodexTarget('codexdesktop', 'Codex Desktop', true), workbuddyTarget]
}

function byID(id) {
  return all().find((t) => t.id === id) || null
}

module.exports = { all, byID }
