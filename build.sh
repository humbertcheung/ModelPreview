#!/bin/bash
# 构建脚本：编译主应用 + Quick Look 扩展，打包签名注册
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="$ROOT/ModelPreview/Sources"
VIEWER="$ROOT/ModelPreview/Viewer"
RES="$ROOT/ModelPreview/Resources"
BUILD="$ROOT/build"

APP="$BUILD/3D模型预览.app"
APPEX="$APP/Contents/PlugIns/QuickLookPreview.appex"
EXEC_NAME="ModelPreview"
APPEX_NAME="QuickLookExtension"

echo "==> 清理"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" \
         "$APPEX/Contents/MacOS" "$APPEX/Contents/Resources"

ZSTD_DIR="$SRC/Shared/zstd"
ZSTD_CFLAGS=(-I "$ZSTD_DIR" -I "$ZSTD_DIR/common" -I "$ZSTD_DIR/decompress" -DDEBUGLEVEL=0)
ZSTD_CFILES=()
for f in "$ZSTD_DIR/common/"*.c "$ZSTD_DIR/decompress/"*.c; do ZSTD_CFILES+=("$f"); done
CFLAGS=()
for f in "${ZSTD_CFLAGS[@]}"; do CFLAGS+=("-Xcc" "$f"); done

echo "==> 编译 Quick Look 扩展"
swiftc -O -swift-version 5 -module-name QuickLookExtension \
    -import-objc-header "$SRC/Shared/MDLBridge.h" \
    "${CFLAGS[@]}" \
    "${ZSTD_CFILES[@]}" \
    "$SRC/Shared/BlendPipeline.swift" \
    "$SRC/Shared/BlendThumbnail.swift" \
    "$SRC/Shared/GLTFSceneLoader.swift" \
    "$SRC/Shared/ViewerSchemeHandler.swift" \
    "$SRC/QuickLook/PreviewViewController.swift" \
    -o "$APPEX/Contents/MacOS/$APPEX_NAME" \
    -framework Cocoa -framework SceneKit -framework ModelIO -framework Quartz -framework AppKit \
    -Xlinker -e -Xlinker _NSExtensionMain 2>&1 | grep -v "^$" || true
[ -x "$APPEX/Contents/MacOS/$APPEX_NAME" ] || { echo "appex 编译失败"; exit 1; }

echo "==> 复制扩展资源"
ditto "$VIEWER" "$APPEX/Contents/Resources/Viewer"
cp "$RES/Info-Appex.plist" "$APPEX/Contents/Info.plist"

echo "==> 编译主应用"
swiftc -O -swift-version 5 -module-name ModelPreview \
    -import-objc-header "$SRC/Shared/MDLBridge.h" \
    "${CFLAGS[@]}" \
    "${ZSTD_CFILES[@]}" \
    "$SRC/Shared/BlendPipeline.swift" \
    "$SRC/Shared/BlendThumbnail.swift" \
    "$SRC/Shared/ViewerSchemeHandler.swift" \
    "$SRC/App/AppDelegate.swift" \
    "$SRC/App/main.swift" \
    -o "$APP/Contents/MacOS/$EXEC_NAME" \
    -framework Cocoa -framework WebKit 2>&1 | grep -v "^$" || true
[ -x "$APP/Contents/MacOS/$EXEC_NAME" ] || { echo "主应用编译失败"; exit 1; }

echo "==> 复制主应用资源"
ditto "$VIEWER" "$APP/Contents/Resources/Viewer"
cp "$RES/Info-App.plist" "$APP/Contents/Info.plist"
cp "$BUILD/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"

echo "==> 代码签名（ad-hoc，扩展带沙盒权限）"
codesign --force -s - --entitlements "$RES/Appex.entitlements" "$APPEX" 2>&1
codesign --force -s - "$APP" 2>&1

echo "==> 注册到 Launch Services"
LSREG="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
"$LSREG" -f "$APP" >/dev/null 2>&1 || "$LSREG" -R -f "$APP" >/dev/null 2>&1 || true

echo "==> 完成：$APP"
codesign -dv "$APP" 2>&1 | head -3 || true
