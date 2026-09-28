#!/bin/bash
# tiancaiConfig 完整构建链：前端 → 测试 → Electron 打包（mac zip + win portable exe）
# 用法: bash scripts/build-electron.sh   (需 PATH 中有 node/npm；Electron 镜像已内置)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="${NODE:-node}"
NPM="${NPM:-npm}"
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"

echo "=== [1/4] 前端构建 (React + Vite) ==="
(cd "$ROOT/web" && "$NPM" run build)
rm -rf "$ROOT/app/renderer"
cp -R "$ROOT/web/dist" "$ROOT/app/renderer"

echo "=== [2/4] 引擎测试 (node --test) ==="
(cd "$ROOT/app" && "$NODE" --test)

echo "=== [3/4] 冒烟自测（无头，不创建窗口） ==="
(cd "$ROOT/app" && "$NODE" -e "
const { startServer } = require('$ROOT/app/src/server')
;(async () => {
  const { port, token, server } = await startServer({ distDir: '$ROOT/app/renderer', home: '/tmp' })
  const h = await fetch('http://127.0.0.1:' + port + '/api/health?t=' + token)
  if (h.status !== 200) throw new Error('health ' + h.status)
  console.log('smoke ok')
  server.close()
  process.exit(0)
})()")

echo "=== [4/4] Electron 打包 (mac zip + win portable) ==="
(cd "$ROOT/app" && npx electron-builder --mac --win)

echo "=== 产物 ==="
ls -lh "$ROOT/dist-electron"
