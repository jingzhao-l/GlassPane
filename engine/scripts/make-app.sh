#!/bin/sh
# GlassPane .app 打包脚本（零第三方依赖，仅用 macOS 自带工具）。
#
# 解释器（先于下面每条结论）：这份脚本有**两个**调用方，各用不同的 shell 起跑——
#   installer/cli.js  → run('/bin/bash', [makeAppScript, …])
#   updater/lib/apply.js（每日更新的暂存构建）→ run('/bin/sh', [makeAppScript])
# 所以 shebang 与 preamble 必须按 POSIX sh 写：macOS 的 /bin/sh 就是 bash，
# `set -euo pipefail` 在这台机器上侥幸可用；/bin/sh 是 dash 的 runner 上它在
# preamble 那一行就 "set: Illegal option -o pipefail" 死掉，暂存构建永久报
# staged-build-failed，每日更新从此再也过不去。本脚本没有任何管道（全文的 `|`
# 只出现在两处逻辑或），pipefail 从来买不到东西——去掉它是零代价的。
# 闸：engine/probe/Tests/GlassPaneProbeTests 里的打包脚本形状闸扫的是剥掉整行注释
# 后的 shell 行，所以这段注释里写下的那些字面量不会把闸红在自己的说明上。
#
# 产出两个 bundle（P1 v1.2 §11.1 权限主体修正）：
#   GlassPane.app         ← glasspane-settings（设置面板，com.glasspane.settings）
#   GlassPane Daemon.app  ← glasspaned（引擎守护进程，com.glasspane.daemon）
#
# 为什么要 bundle + 重签（这三条都是真机实测结论，不是推测）：
#  1. TCC 席位按「进程身份」记账。裸二进制（`Info.plist=not bound`）在系统设置
#     权限列表里只显示文件名、无图标，且「+」选择器看不到隐藏目录里的文件——
#     用户既找不到条目也无法手动添加。bundle 身份才会显示 CFBundleDisplayName
#     并带图标。
#  2. 只 `cp` 产物不重签的 .app 是**坏签名**（`codesign --verify` 报
#     "code has no resources but signature indicates they must be present"），
#     这样的 bundle 不成立 TCC 客户端 → 点授权后系统设置里什么都不出现。
#     故本脚本组装完必须 `codesign` 整包（绑定 Info.plist）。
#  3. designated requirement 缺省是 `cdhash H"..."`，重新编译即失效（授权被静默
#     撤销）。这里显式写成不含 cdhash 的 `identifier` 形式，使授权跨构建稳定。
#
# 用法：
#   engine/scripts/make-app.sh                       # 默认打包 .build/release 下两个产物
#   engine/scripts/make-app.sh <settings-bin>        # 兼容旧的位置参数用法
#   engine/scripts/make-app.sh --settings-bin P --daemon-bin P --out DIR
#   engine/scripts/make-app.sh --skip-daemon         # 只打设置面板
#
# 图标为 sips + iconutil 生成的"基础图"而非品牌图——设计上如实标注（P4 v4.0 §34.5）。
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENGINE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$ENGINE_DIR/.build/release"

# 产品的最低系统版本——**唯一声明处**，两个 bundle 的最低版本键都从这一个变量渲染。
# 取 14.0 的理由（不是审美，是宣称对账）：README.md「Requirements」表、README.zh-CN.md
# 前置条件表、CONTRIBUTING.md §1、installer/README.md 都写着 macOS 14+，而像素通道在
# 14 上走 `SCScreenshotManager`、在 13 上退到 `SCStream` 路径 B——CHANGELOG 里那条
# 2026-10 的记录自己写着「macOS 13 上的真值仍属待真机复跑」。键写低一档的后果是：
# Ventura 上 LaunchServices 照样起 daemon，那条没测过的路径 B 就跑在生产机上，而每一项
# "measured on 14+" 的宣称都在**没有拒绝**的情况下落空。地板要说的就是文档说的那一档。
# 这里也是唯一一处需要改的地方（旧形状是同一处字面量写着比文档低一档的值，于是两个
# bundle 一起错；现在值进了变量，往后说地板只有这一行可说）。
# 注：`engine/Package.swift` 的 `.macOS(.v13)` 是**编译**部署目标（链接面），不是产品
# 地板；把它一起抬到 v14 会改动整个 GlassPaneEngine 的 availability 判定，且必须一次
# `swift build` 才验得了——本轮不动它，理由记在交付说明里。
MACOS_MIN_VERSION="14.0"

SETTINGS_BIN="$BUILD_DIR/glasspane-settings"
DAEMON_BIN="$BUILD_DIR/glasspaned"
OUT_DIR="$BUILD_DIR"
SKIP_DAEMON=0
SKIP_SETTINGS=0

while [ $# -gt 0 ]; do
  case "$1" in
    --settings-bin) SETTINGS_BIN="${2:?make-app: --settings-bin 需要路径}"; shift 2 ;;
    --daemon-bin) DAEMON_BIN="${2:?make-app: --daemon-bin 需要路径}"; shift 2 ;;
    --out) OUT_DIR="${2:?make-app: --out 需要目录}"; shift 2 ;;
    --skip-daemon) SKIP_DAEMON=1; shift ;;
    --skip-settings) SKIP_SETTINGS=1; shift ;;
    --help|-h)
      # 帮助 = 文件头那段注释，打到第一个非注释行为止。旧写法钉死一个行号区间，
      # 注释一加长就把帮助截掉半截、再往下糊几行代码进来。
      awk 'NR>1 { if (/^#/) print; else exit }' "$0"
      exit 0 ;;
    -*)
      echo "make-app: 未知选项 $1" >&2; exit 64 ;;
    *)
      # 旧用法：第一个位置参数 = 设置面板产物
      SETTINGS_BIN="$1"; shift ;;
  esac
done

mkdir -p "$OUT_DIR"

# ---------------------------------------------------------------- 图标生成
# 一次生成、两个 bundle 共用（图标同时决定系统设置权限列表里的条目外观）。
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

ICNS_PATH="$TMP_DIR/GlassPane.icns"
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
    if iconutil -c icns "$ICONSET" -o "$ICNS_PATH" >/dev/null 2>&1; then
      ICON_OK=1
    else
      echo "make-app: iconutil 失败，跳过图标（.app 无图标，诚实降级）" >&2
    fi
  else
    echo "make-app: 图标生成失败，跳过图标（.app 无图标，诚实降级）" >&2
  fi
else
  echo "make-app: 未找到 python3，跳过图标生成（.app 无图标，诚实降级）" >&2
fi

# ---------------------------------------------------------------- bundle 组装
# $1 bundle 目录  $2 可读名  $3 bundle id  $4 可执行文件名  $5 产物路径  $6 LSUIElement(0/1)
make_bundle() {
  local app_dir="$1" display_name="$2" bundle_id="$3" exe_name="$4" bin="$5" agent="$6"
  local contents="$app_dir/Contents"
  local macos_dir="$contents/MacOS"
  local res_dir="$contents/Resources"

  if [ ! -x "$bin" ]; then
    echo "make-app: 产物不存在或不可执行（${bin}），先 swift build -c release" >&2
    return 1
  fi

  rm -rf "$app_dir"
  mkdir -p "$macos_dir" "$res_dir"
  cp "$bin" "$macos_dir/$exe_name"
  chmod 755 "$macos_dir/$exe_name"

  cat > "$contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>$display_name</string>
  <key>CFBundleDisplayName</key>
  <string>$display_name</string>
  <key>CFBundleExecutable</key>
  <string>$exe_name</string>
  <key>CFBundleIdentifier</key>
  <string>$bundle_id</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.20.2</string>
  <key>CFBundleVersion</key>
  <string>1.20.2</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>LSMinimumSystemVersion</key>
  <string>$MACOS_MIN_VERSION</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
$( [ "$agent" = "1" ] && printf '  <key>LSUIElement</key>\n  <true/>\n' )</dict>
</plist>
PLIST

  if [ "$ICON_OK" = "1" ]; then
    cp "$ICNS_PATH" "$res_dir/GlassPane.icns"
    /usr/libexec/PlistBuddy -c 'Add :CFBundleIconFile string GlassPane' "$contents/Info.plist" >/dev/null
  fi

  # 整包签名：绑定 Info.plist（不签则 bundle 签名无效 → 不成立 TCC 客户端）。
  # DR 不含 cdhash：重新编译/重签后既有授权仍然匹配（§11.1 结论 3）。
  codesign --force --sign - \
    --identifier "$bundle_id" \
    -r="designated => identifier \"$bundle_id\"" \
    "$app_dir" >/dev/null

  # 签名自查：失败即报错退出——坏签名的 bundle 会让用户白跑一趟系统设置。
  if ! codesign --verify --strict --verbose=1 "$app_dir" >/dev/null 2>&1; then
    echo "make-app: $app_dir 签名自查未通过（codesign --verify --strict）" >&2
    codesign --verify --strict --verbose=3 "$app_dir" >&2 || true
    return 1
  fi
  echo "make-app: $app_dir 就绪（id=$bundle_id, DR=identifier \"$bundle_id\", 签名自查通过）"
}

if [ "$SKIP_SETTINGS" = "0" ]; then
  make_bundle "$OUT_DIR/GlassPane.app" "GlassPane" "com.glasspane.settings" \
    "glasspane-settings" "$SETTINGS_BIN" 0
fi
if [ "$SKIP_DAEMON" = "0" ]; then
  make_bundle "$OUT_DIR/GlassPane Daemon.app" "GlassPane Daemon" "com.glasspane.daemon" \
    "glasspaned" "$DAEMON_BIN" 1
fi

if [ "$ICON_OK" != "1" ]; then
  echo "make-app: 提醒——本次产物无图标，系统设置权限列表里的条目将显示通用图标" >&2
fi
echo "make-app: 输出目录 $OUT_DIR"
