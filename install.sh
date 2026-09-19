#!/bin/sh
# GlassPane 一键安装入口（P4 §35）：
#   curl -fsSL https://raw.githubusercontent.com/jingzhao-l/GlassPane/main/install.sh | sh
# 职责边界：本脚本只做三件事——源码定位（环境变量/cwd/已有 clone/自动 clone）、
# Node 硬预检（installer 本身要求 Node >= 18）、委托 installer/cli.js 走完整
# 安装流程（swift/npm 预检、构建、launchd、GUI 授权引导均在 installer 内）。
# 零 bashism（POSIX sh，/bin/sh 直跑）；GLASSPANE_INSTALL_DRY_RUN=1 时只报告
# 决策不执行（供 CI 语法/分支测试）。
set -eu

REPO_URL="${GLASSPANE_REPO_URL:-https://github.com/jingzhao-l/GlassPane.git}"
CLONE_DIR="${GLASSPANE_INSTALL_DIR:-$HOME/glasspane}"
DRY_RUN="${GLASSPANE_INSTALL_DRY_RUN:-0}"

say() { printf '%s\n' "$*"; }
fail() { printf '错误: %s\n' "$*" >&2; exit 1; }

looks_like_repo() {
  [ -f "$1/engine/Package.swift" ] && [ -f "$1/mcp-shell/package.json" ]
}

# --- 1) 源码定位：GLASSPANE_REPO → 当前目录 → 既有 clone → 自动 clone --------
REPO=""
if [ -n "${GLASSPANE_REPO:-}" ] && looks_like_repo "$GLASSPANE_REPO"; then
  REPO="$GLASSPANE_REPO"
  say "使用 GLASSPANE_REPO 指定的仓库: $REPO"
elif looks_like_repo "$PWD"; then
  REPO="$PWD"
  say "在当前目录定位到仓库: $REPO"
elif looks_like_repo "$CLONE_DIR"; then
  REPO="$CLONE_DIR"
  say "使用既有 clone: $REPO"
fi

if [ -z "$REPO" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    say "[dry-run] 未定位到仓库，将执行: git clone $REPO_URL $CLONE_DIR"
  else
    command -v git >/dev/null 2>&1 || fail "未找到 git（安装 Xcode Command Line Tools: xcode-select --install）"
    if [ -e "$CLONE_DIR" ]; then
      fail "目标目录已存在且不是 GlassPane 仓库: $CLONE_DIR（用 GLASSPANE_REPO 指定仓库或清理后重试）"
    fi
    say "未定位到本地仓库，clone 源码到 $CLONE_DIR ……"
    git clone "$REPO_URL" "$CLONE_DIR"
    REPO="$CLONE_DIR"
  fi
fi

# --- 2) Node 硬预检（installer 是 Node ESM，缺它无从委托；其余依赖交给 installer） ---
if [ "$DRY_RUN" != "1" ]; then
  command -v node >/dev/null 2>&1 || fail "未找到 Node.js（需 >= 18，https://nodejs.org 或 brew install node）"
  NODE_MAJOR=$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)
  [ "$NODE_MAJOR" -ge 18 ] 2>/dev/null || fail "Node.js 需要 >= 18，当前主版本为 $NODE_MAJOR"
  say "Node.js $NODE_MAJOR 预检通过"
fi

# --- 3) 委托 installer（参数原样透传，如 --no-prompt / --no-gui） -------------
SILENT=""
[ -t 0 ] || SILENT="--no-prompt"
if [ "$DRY_RUN" = "1" ]; then
  say "[dry-run] 将执行: node $REPO/installer/cli.js $SILENT $*"
  exit 0
fi
exec node "$REPO/installer/cli.js" $SILENT "$@"
