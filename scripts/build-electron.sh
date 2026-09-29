#!/bin/bash
# tiancaiConfig 完整构建链：前端 → 测试 → Electron 打包（mac zip + win portable exe）
# 用法: bash scripts/build-electron.sh   (需 PATH 中有 node/npm；Electron 镜像已内置)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="${NODE:-node}"
NPM="${NPM:-npm}"
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"

echo "=== [1/4] 前端构建 (React + Vite，产物直出 app/renderer) ==="
(cd "$ROOT/web" && "$NPM" run build)

echo "=== [2/4] 引擎测试 (node --test) ==="
(cd "$ROOT/app" && "$NODE" --test)

echo "=== [3/4] 冒烟自测（无头，不创建窗口） ==="
# 注意：node -e 内必须用相对路径（cd app 后 ./src/server）。Git Bash 的 $ROOT 是
# /l/... POSIX 形式，Windows 原生 node 无法解析，绝对路径内插会 MODULE_NOT_FOUND。
(cd "$ROOT/app" && "$NODE" -e "
const { startServer } = require('./src/server')
;(async () => {
  const { port, token, server } = await startServer({ distDir: './renderer', home: require('os').tmpdir() })
  const h = await fetch('http://127.0.0.1:' + port + '/api/health?t=' + token)
  if (h.status !== 200) throw new Error('health ' + h.status)
  console.log('smoke ok')
  server.close()
  process.exit(0)
})()")

echo "=== [4/4] Electron 打包（平台感知：macOS 出 zip 双架构 / Windows 出 portable exe） ==="
case "$(uname -s)" in
  Darwin*) (cd "$ROOT/app" && npx electron-builder --mac) ;;
  *)       (cd "$ROOT/app" && npx electron-builder --win) ;;
esac

echo "=== 产物 ==="
ls -lh "$ROOT/dist-electron"
