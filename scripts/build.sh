#!/bin/bash
# tiancaiConfig 双平台构建：macOS 通用 .app（ad-hoc 签名）+ Windows 单文件 exe
# 用法: bash scripts/build.sh   (需 PATH 中有 go 与 npm)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GO="${GO:-go}"
DIST="$ROOT/dist"
rm -rf "$DIST"
mkdir -p "$DIST"

# ---------- 1. 前端（React + Vite → go:embed） ----------
if [ -d "$ROOT/web" ]; then
  (cd "$ROOT/web" && npm run build)
  rm -rf "$ROOT/internal/server/webdist"
  cp -R "$ROOT/web/dist" "$ROOT/internal/server/webdist"
fi

LDFLAGS="-s -w -buildid="

# ---------- 2. macOS：arm64 + amd64 → 通用二进制 ----------
CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 "$GO" build -trimpath -ldflags "$LDFLAGS" -o "$DIST/tiancaiConfig-darwin-arm64" ./cmd/app
CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 "$GO" build -trimpath -ldflags "$LDFLAGS" -o "$DIST/tiancaiConfig-darwin-amd64" ./cmd/app

APP="$DIST/tiancaiConfig.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
lipo -create "$DIST/tiancaiConfig-darwin-arm64" "$DIST/tiancaiConfig-darwin-amd64" -output "$APP/Contents/MacOS/tiancaiConfig-bin"
chmod +x "$APP/Contents/MacOS/tiancaiConfig-bin"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>tiancaiConfig</string>
    <key>CFBundleDisplayName</key><string>tiancaiConfig</string>
    <key>CFBundleIdentifier</key><string>com.tiancaiconfig.app</string>
    <key>CFBundleVersion</key><string>0.1.0</string>
    <key>CFBundleShortVersionString</key><string>0.1.0</string>
    <key>CFBundleExecutable</key><string>tiancaiConfig-bin</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>LSMinimumSystemVersion</key><string>12.0</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
</dict>
</plist>
PLIST

# ad-hoc 本地签名（Apple Silicon 修改二进制后必须重签，否则内核直接 kill）
codesign --force --deep --sign - "$APP"
xattr -cr "$APP" 2>/dev/null || true

(cd "$DIST" && zip -qry tiancaiConfig-macOS.zip tiancaiConfig.app)
rm -f "$DIST/tiancaiConfig-darwin-arm64" "$DIST/tiancaiConfig-darwin-amd64"

# ---------- 3. Windows：单文件 exe（WebView2 内核窗口） ----------
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 "$GO" build -trimpath -ldflags "$LDFLAGS" -o "$DIST/tiancaiConfig.exe" ./cmd/app

echo "=== 构建产物 ==="
ls -lh "$DIST"
