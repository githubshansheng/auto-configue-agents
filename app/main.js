// tiancaiConfig Electron 主进程：启动回环服务 + BrowserWindow 加载 React 前端。
// 单实例：二次双击唤起已有窗口。--smoke 模式仅启动服务即退出（无头自测用）。
'use strict'

const path = require('node:path')
const { app, BrowserWindow, Menu, shell } = require('electron')
const { startServer } = require('./src/server')

const SMOKE = process.argv.includes('--smoke')
const HEADLESS_AUTOUPDATE = process.argv.includes('--autoupdate-workbuddy')
const HEADLESS_AUTOUPDATE_CODEX = process.argv.includes('--autoupdate-codex')
let win = null

if (HEADLESS_AUTOUPDATE || HEADLESS_AUTOUPDATE_CODEX) {
  // 模型自动更新 headless 模式（LaunchAgent/计划任务触发，workbuddy 与 codex 各一个 agent）：
  // 不抢单实例锁（GUI 开着时也要能跑）、不建窗口、不显示 Dock，跑完即退。
  const runOnce =
    HEADLESS_AUTOUPDATE_CODEX && !HEADLESS_AUTOUPDATE
      ? require('./src/engine/codexautoupdate').autoupdateCodexOnce
      : require('./src/engine/workbuddyautoupdate').autoupdateOnce
  runOnce(app.getPath('home'))
    .then((r) => {
      console.log('AUTOUPDATE ' + JSON.stringify(r))
      app.exit(0)
    })
    .catch((e) => {
      console.error('AUTOUPDATE-FAIL ' + (e && e.stack ? e.stack : e))
      app.exit(1)
    })
} else {
  runGUI()
}

function runGUI() {
  const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(async () => {
    const home = app.getPath('home')
    const distDir = path.join(__dirname, 'renderer')
    // 启动防护：前端产物缺失（未执行 web 构建）时给出明确提示，而非静默白屏。
    const fs = require('node:fs')
    if (!fs.existsSync(path.join(distDir, 'index.html'))) {
      const msg =
        '前端资源缺失：' + distDir + ' 下没有 index.html。\n' +
        '请先在 web/ 目录执行 npm install && npm run build 构建前端，再重新打包。'
      if (SMOKE) {
        // 无头自测模式：不弹窗，直接报错退出（退出码 1 便于脚本判定）
        console.error('SMOKE-FAIL ' + msg)
        app.exit(1)
        return
      }
      const { dialog } = require('electron')
      dialog.showErrorBox('tiancaiConfig 启动失败', msg)
      app.quit()
      return
    }
    let started
    try {
      started = await startServer({ distDir, home })
    } catch (e) {
      // 服务起不来属于致命错误：弹窗告知而非静默闪退
      const { dialog } = require('electron')
      dialog.showErrorBox('tiancaiConfig 启动失败', String(e.message || e))
      app.quit()
      return
    }
    const url = 'http://127.0.0.1:' + started.port + '/?t=' + started.token

    if (SMOKE) {
      console.log('SMOKE ' + JSON.stringify({ port: started.port, token: started.token }))
      setTimeout(() => app.quit(), 500)
      return
    }

    Menu.setApplicationMenu(null)
    win = new BrowserWindow({
      width: 960,
      height: 680,
      minWidth: 860,
      minHeight: 600,
      title: '天才驿站(ai.heigh.vip)',
      autoHideMenuBar: true,
      backgroundColor: '#F8FAFC',
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    // 外链一律转系统浏览器：sandbox 渲染进程无 node，新窗口/导航请求在主进程拦截。
    // 官网跳转（页头 ai.heigh.vip 链接）依赖此处理器，否则会在 Electron 窗口内导航。
    const isLocalService = (u) => u.startsWith('http://127.0.0.1:')
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (!isLocalService(url)) shell.openExternal(url)
      return { action: 'deny' }
    })
    win.webContents.on('will-navigate', (e, url) => {
      if (!isLocalService(url)) {
        e.preventDefault()
        shell.openExternal(url)
      }
    })
    win.loadURL(url)
    win.on('closed', () => {
      win = null
    })
    app.on('window-all-closed', () => app.quit())
  })
}
}