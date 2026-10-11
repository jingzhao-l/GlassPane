#!/bin/sh
# GlassPane 一键安装入口（P4 §35）：
#   curl -fsSL https://raw.githubusercontent.com/jingzhao-l/GlassPane/main/install.sh | sh
# 职责边界：本脚本只做四件事——源码定位（环境变量/cwd/已有 clone/自动 clone）、
# 发布 ref 决策（钉 tag，不追分支）、Node 硬预检（installer 本身要求 Node >= 18）、
# 委托 installer/cli.js 走完整安装流程（swift/npm 预检、构建、launchd、GUI 授权
# 引导均在 installer 内）。
# 零 bashism（POSIX sh，/bin/sh 直跑）；GLASSPANE_INSTALL_DRY_RUN=1 时只报告
# 决策不执行（供 CI 语法/分支测试）。
set -eu

# 发布线锚点（版本真源=根 package.json，由 scripts/set-version.mjs 统一改写，
# 勿手改）：一键安装 clone 的是这个 **tag**，不是移动的 main——同一天两个人跑
# 同一条命令必须拿到同一份源码。入口脚本本身仍从 main 取，因为它是唯一需要
# "最新"的东西：钉的是哪个 tag 就写在这行里。
GLASSPANE_RELEASE="v1.12.0"

REPO_URL="${GLASSPANE_REPO_URL:-https://github.com/jingzhao-l/GlassPane.git}"
CLONE_DIR="${GLASSPANE_INSTALL_DIR:-$HOME/glasspane}"
DRY_RUN="${GLASSPANE_INSTALL_DRY_RUN:-0}"
# GLASSPANE_REF 的口径与 installer/cli.js 的 resolvePinRef **同源**（finding 10）：
# 未设置与显式置空都钉发布 tag；要追主干必须写 GLASSPANE_REF=main。
# 旧写法在这里把空值读成 main，而 installer 把同一个空值读成上面那个 tag——同一条
# `GLASSPANE_REF=` 在两条一键入口上会拿到两份源码，而 install-sh.test.mjs 的用例标题
# 还写着"与 installer 常量同源"。
REF="${GLASSPANE_REF-${GLASSPANE_RELEASE}}"
[ -n "$REF" ] || REF="$GLASSPANE_RELEASE"

say() { printf '%s\n' "$*"; }
fail() { printf '错误: %s\n' "$*" >&2; exit 1; }

# --- 0) 覆盖位的形状闸（finding 3）--------------------------------------------
# GLASSPANE_REPO_URL / GLASSPANE_REF 是文档里写明的覆盖口子，值直接进 `git clone` 的
# argv。两类值是命令执行入口：
#   - 不带 scheme 的 `ext::sh -c …`（git 的 ext 传输在 clone 那一刻起一个 shell）；
#   - 以 `-` 开头的值（被 git 当成选项，如 --upload-pack=…）。
# 因此只认白名单前缀 https:// / ssh:// / file://（与 installer/cli.js 的
# ALLOWED_GIT_URL_PREFIXES 同一份），并用 `--` 把选项与位置参数隔开。scp 式
# git@host:path 与 `ext::` 落在同一个"看不出会做什么"的形状里，故拒绝——请写
# ssh://git@host/path。
assert_no_option_smuggling() { # $1=值 $2=名字
  [ -n "$1" ] || fail "$2 为空"
  case "$1" in
    -*) fail "$2 不能以 '-' 开头（会被 git 当成命令行选项而不是值）：$1" ;;
  esac
  case "$1" in
    *[[:space:]]*) fail "$2 含空白字符（git 的 ext:: 传输正是靠它起 shell）：$1" ;;
  esac
}

assert_repo_url() {
  assert_no_option_smuggling "$1" "GLASSPANE_REPO_URL"
  case "$1" in
    https://*|ssh://*|file://*) return 0 ;;
    *) fail "GLASSPANE_REPO_URL 必须以 https://、ssh:// 或 file:// 开头，实为「$1」。不带 scheme 的值会被 git 当成传输扩展名（ext::… 直接执行后面的命令），一律拒绝；本地/镜像 clone 写 file:///<绝对路径>，scp 式 git@host:path 写 ssh://git@host/path。" ;;
  esac
}

assert_ref() {
  assert_no_option_smuggling "$1" "GLASSPANE_REF"
}

looks_like_repo() {
  [ -f "$1/engine/Package.swift" ] && [ -f "$1/mcp-shell/package.json" ]
}

describe_ref() {
  # 已有 clone 的实身份：优先 tag，退化到短 sha。取不到就如实说取不到。
  git -C "$1" describe --tags --always 2>/dev/null || say "（无法判定该目录的版本）"
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
  say "使用既有 clone: $REPO（该目录实际版本: $(describe_ref "$REPO")）"
  say "  提示：既有 clone 不会被自动切到 $REF；要装发布版请清理该目录或指定 GLASSPANE_INSTALL_DIR。"
fi

if [ -z "$REPO" ]; then
  # 走到这里就一定要 clone（连 dry-run 也是要说清"将要 clone 什么"），所以两个覆盖位
  # 先过形状闸，再谈执行；dry-run 同样校验，CI 才能在零副作用下读到这条拒绝。
  assert_repo_url "$REPO_URL"
  assert_ref "$REF"
  if [ "$DRY_RUN" = "1" ]; then
    # dry-run 也要把 REPO 定下来：否则后面委托行打印成 "/installer/cli.js"，
    # CI 的分支测试就读不出真实将要执行的路径。
    REPO="$CLONE_DIR"
    say "[dry-run] 未定位到仓库，将执行: git clone --branch $REF --depth 1 -- $REPO_URL $CLONE_DIR"
  else
    command -v git >/dev/null 2>&1 || fail "未找到 git（安装 Xcode Command Line Tools: xcode-select --install）"
    if [ -e "$CLONE_DIR" ]; then
      fail "目标目录已存在且不是 GlassPane 仓库: $CLONE_DIR（用 GLASSPANE_REPO 指定仓库或清理后重试）"
    fi
    say "未定位到本地仓库，clone 源码到 $CLONE_DIR（ref: $REF）……"
    # `--` 隔开选项与位置参数：REF/URL 已经过 assert_*，但这道分隔是把"下一个值不是选项"
    # 这件事也写给读代码的人。
    git clone --branch "$REF" --depth 1 -- "$REPO_URL" "$CLONE_DIR" \
      || fail "clone 失败：ref '$REF' 不存在或网络不可达。可用 GLASSPANE_REF=main 追主干，或 GLASSPANE_REF=<tag> 指定发布版。"
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

# --- 3) 委托 installer（参数原样透传，如 --no-gui / --no-app） -----------------
# 非 TTY 时补 --no-prompt：installer 里的确认门（finding 12：bootout 已加载的 launchd
# 作业、覆盖已存在的 .app、结束在跑的实例）现在是**活代码**——交互终端会问一句，
# --no-prompt 显式放行，非交互又没给这个 flag 则跳过这些破坏性动作。`curl | sh` 与
# CI 走的就是这里补上的那一支，行为与改造前一致。
SILENT=""
[ -t 0 ] || SILENT="--no-prompt"
if [ "$DRY_RUN" = "1" ]; then
  say "[dry-run] 将执行: node $REPO/installer/cli.js $SILENT $*"
  exit 0
fi
export GLASSPANE_REPO="$REPO"
exec node "$REPO/installer/cli.js" $SILENT "$@"
