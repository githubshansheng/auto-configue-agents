#!/usr/bin/env bash
# tiancaiConfig macOS 一键构建脚本（仅能在 macOS 上运行，Windows 无法交叉构建 mac 包）。
# 用法：在 macOS 终端从仓库根目录执行  bash scripts/build-mac.sh
# 产物：dist-electron/tiancaiConfig-0.1.0-arm64.zip（Apple Silicon）+ -x64.zip（Intel Mac）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# 国内镜像加速 Electron 运行时下载（如已配置代理可注释）
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"

echo "==> [1/3] 构建前端（产物直出 app/renderer）"
cd "$ROOT/web"
npm install
npm run build

echo "==> [2/3] 安装主进程依赖（Electron 44 + electron-builder）"
cd "$ROOT/app"
npm install

echo "==> [3/3] 打包 macOS zip（arm64 + x64 双架构）"
npx electron-builder --mac

echo
echo "构建完成，产物位于 $ROOT/dist-electron/*.zip"
echo
echo "—— 分发注意（Gatekeeper，首次打开）——"
echo "本包未做 Apple 签名（identity: null）。接收方解压 zip 后首次打开若提示"
echo "「无法验证开发者」，任选其一："
echo "  1) 右键 App → 打开 → 再点打开（仅需一次）"
echo "  2) 终端执行：xattr -cr /Applications/tiancaiConfig.app（或拖到哪就填哪）"
echo "—— 环境自包含性 ——"
echo "包内已含 Electron 运行时（Chromium + Node 24），无需用户安装 Node/浏览器/WebView；"
echo "SQLite 使用 Electron 内置 node:sqlite，零原生依赖。"
