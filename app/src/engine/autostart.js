// 开机自启管理（当前服务对象：cc-switch 本体）：
// - Windows：HKCU\...\Run 注册表项（不需要管理员权限；值名即任务管理器-启动应用条目名）
// - macOS：~/Library/LaunchAgents/<label>.plist（RunAtLoad）+ launchctl load/unload
// 系统调用通过 opts.run 注入（默认 execFileSync），命令/ plist 生成为纯函数便于测试。
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'

function buildWinRegAddArgs({ valueName, exePath, args }) {
  const data = '"' + exePath + '"' + (args && args.length ? ' ' + args.join(' ') : '')
  return ['add', RUN_KEY, '/v', valueName, '/t', 'REG_SZ', '/d', data, '/f']
}

function buildWinRegDeleteArgs(valueName) {
  return ['delete', RUN_KEY, '/v', valueName, '/f']
}

function buildMacPlist({ label, exePath, args }) {
  const items = [exePath, ...(args || [])].map((s) => '    <string>' + s + '</string>').join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${items}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`
}

function macPlistPath(home, label) {
  return path.join(home || os.homedir(), 'Library', 'LaunchAgents', label + '.plist')
}

function defaultRun(file, args) {
  const { execFileSync } = require('node:child_process')
  execFileSync(file, args, { stdio: 'ignore' })
}

// enableAutostart 幂等启用：注册表 /f 覆盖、plist 原子重写 + launchctl 重载。
function enableAutostart({ valueName, label, exePath, args = [], home, run } = {}) {
  const _run = run || defaultRun
  const macLabel = label || valueName
  if (process.platform === 'win32') {
    _run('reg', buildWinRegAddArgs({ valueName, exePath, args }))
    return '已注册开机自启（注册表 HKCU Run，随用户登录启动）'
  }
  if (process.platform === 'darwin') {
    const p = macPlistPath(home, macLabel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    try {
      _run('launchctl', ['unload', '-w', p])
    } catch {}
    const tmp = p + '.tmp'
    fs.writeFileSync(tmp, buildMacPlist({ label: macLabel, exePath, args }))
    fs.renameSync(tmp, p)
    _run('launchctl', ['load', '-w', p])
    return '已注册开机自启（LaunchAgent ' + macLabel + '）'
  }
  throw new Error('当前平台暂不支持开机自启')
}

// disableAutostart 幂等禁用：条目不存在视为成功。
function disableAutostart({ valueName, label, home, run } = {}) {
  const _run = run || defaultRun
  const macLabel = label || valueName
  if (process.platform === 'win32') {
    try {
      _run('reg', buildWinRegDeleteArgs(valueName))
    } catch {}
    return '已取消开机自启'
  }
  if (process.platform === 'darwin') {
    const p = macPlistPath(home, macLabel)
    try {
      _run('launchctl', ['unload', '-w', p])
    } catch {}
    try {
      fs.unlinkSync(p)
    } catch {}
    return '已取消开机自启'
  }
  throw new Error('当前平台暂不支持开机自启')
}

// autostartEnabled 查询当前启用状态。
function autostartEnabled({ valueName, label, home, run } = {}) {
  const _run = run || defaultRun
  const macLabel = label || valueName
  try {
    if (process.platform === 'win32') {
      _run('reg', ['query', RUN_KEY, '/v', valueName])
      return true
    }
    if (process.platform === 'darwin') {
      return fs.existsSync(macPlistPath(home, macLabel))
    }
  } catch {}
  return false
}

module.exports = { buildWinRegAddArgs, buildWinRegDeleteArgs, buildMacPlist, macPlistPath, enableAutostart, disableAutostart, autostartEnabled, RUN_KEY }
