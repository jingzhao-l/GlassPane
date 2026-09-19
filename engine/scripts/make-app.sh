#!/bin/bash
# GlassPane.app 最小打包脚本（零第三方依赖，仅用 macOS 自带工具）。
#
# 输入：engine/.build/release/glasspane-settings（swift build -c release 产物）
# 输出：engine/.build/release/GlassPane.app
#       Contents/MacOS/glasspane-settings   （可执行，Info.plist + 签名自查）
#       Contents/Info.plist
#       Contents/Resources/GlassPane.icns   （基础图形图标：深底 + 顶部亮条 + 中央窗格）
#
# 用法：
#   engine/scripts/make-app.sh                # 默认打包 .build/release/glasspane-settings
#   engine/scripts/make-app.sh <settings-bin> # 指定产物路径
#
# 图标为 sips + iconutil 生成的"基础图"而非品牌图——设计上如实标注（P4 v4.0 §34.5）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENGINE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEFAULT_BIN="$ENGINE_DIR/.build/release/glasspane-settings"
BIN="${1:-$DEFAULT_BIN}"

if [ ! -x "$BIN" ]; then
  echo "make-app: 设置面板产物不存在（$BIN），先运行 swift build -c release" >&2
  exit 1
fi

APP_DIR="$ENGINE_DIR/.build/release/GlassPane.app"
CONTENTS="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS/MacOS"
RES_DIR="$CONTENTS/Resources"

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR" "$RES_DIR"

# 1) 可执行文件
cp "$BIN" "$MACOS_DIR/glasspane-settings"
chmod 755 "$MACOS_DIR/glasspane-settings"

# 2) Info.plist（不含图标键；图标生成成功后再补 CFBundleIconFile）
cat > "$CONTENTS/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>GlassPane</string>
  <key>CFBundleDisplayName</key>
  <string>GlassPane</string>
  <key>CFBundleExecutable</key>
  <string>glasspane-settings</string>
  <key>CFBundleIdentifier</key>
  <string>com.glasspane.settings</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
</dict>
</plist>
PLIST

# 3) 基础图标：python3（std 库 zlib/struct，无第三方依赖）直接产出 1024 PNG，
#    sips 缩放到 iconset 各尺寸，iconutil 压成 .icns。
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
PYTHON_BIN="${GLASSPANE_PYTHON:-}"
if [ -z "$PYTHON_BIN" ]; then
  for candidate in python3 python /usr/bin/python3 /opt/miniconda3/bin/python3; do
    if command -v "$candidate" >/dev/null 2>&1 || [ -x "$candidate" ]; then
      PYTHON_BIN="$candidate"
      break
    fi
  done
fi

ICON_OK=0
if [ -n "$PYTHON_BIN" ]; then
  if "$PYTHON_BIN" - "$TMP_DIR/master.png" <<'PY'
import struct
import sys
import zlib

out = sys.argv[1]
size = 1024
BG = (29, 29, 31, 255)        # 深底色
TOP_BAR = (240, 90, 70, 255)  # 顶部亮条（品牌强调色，避开 green/cyan/blue-purple）
PANE = (206, 208, 212, 255)   # 中央窗格浅色
PANE_LEFT = (240, 127, 110, 255)


def chunk(tag, data):
    body = tag + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def make_png(path, w, h, pixel_at):
    rows = bytearray()
    for y in range(h):
        rows.append(0)  # filter: None
        for x in range(w):
            rows += bytes(pixel_at(x, y))
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)  # 8-bit RGBA
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(rows), 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as fh:
        fh.write(png)


def pixel_at(x, y, s=size):
    # 圆角方形掩码：四角 180px 圆角外为底色。
    r = 180
    corners_cut = False
    cx = s - 1 - x
    cy = s - 1 - y
    for (qx, qy) in ((x, y), (cx, y), (x, cy), (cx, cy)):
        if qx < r and qy < r and (r - qx) ** 2 + (r - qy) ** 2 > r * r:
            corners_cut = True
            break
    if corners_cut:
        return BG
    px = x / s
    py = y / s
    if py < 0.0625:  # 顶部 64px 亮条
        return TOP_BAR
    if 0.18 < px < 0.82 and 0.28 < py < 0.86:
        if px < 0.39:
            return PANE_LEFT  # 左窗格（暖浅色）
        return PANE
    return BG


make_png(out, size, size, pixel_at)
print("icon-png-written")
PY
  then
    ICON_OK=1
  fi
fi

if [ "$ICON_OK" = "1" ]; then
  ICONSET="$TMP_DIR/GlassPane.iconset"
  mkdir -p "$ICONSET"
  for spec in "icon_16x16.png:16" "icon_16x16@2x.png:32" "icon_32x32.png:32" \
              "icon_32x32@2x.png:64" "icon_128x128.png:128" "icon_128x128@2x.png:256" \
              "icon_256x256.png:256" "icon_256x256@2x.png:512" "icon_512x512.png:512" \
              "icon_512x512@2x.png:1024"; do
    name="${spec%%:*}"
    px="${spec##*:}"
    sips -z "$px" "$px" "$TMP_DIR/master.png" --out "$ICONSET/$name" >/dev/null
  done
  if iconutil -c icns "$ICONSET" -o "$RES_DIR/GlassPane.icns" >/dev/null 2>&1; then
    /usr/libexec/PlistBuddy -c 'Add :CFBundleIconFile string GlassPane' "$CONTENTS/Info.plist" >/dev/null
    echo "make-app: 图标已生成（基础图，非品牌图）"
  else
    echo "make-app: iconutil 失败，跳过图标（.app 无图标，诚实降级）" >&2
  fi
else
  echo "make-app: 未找到 python3，跳过图标生成（.app 无图标，诚实降级）" >&2
fi

echo "make-app: GlassPane.app 就绪 → $APP_DIR"