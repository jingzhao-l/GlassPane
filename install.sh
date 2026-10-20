#!/bin/sh
# GlassPane 一键安装入口（P4 §35）：
#   curl -fsSL https://raw.githubusercontent.com/jingzhao-l/GlassPane/main/install.sh | sh
# 职责边界：本脚本只做四件事——Node 硬预检（installer 本身要求 Node >= 18）、
# 源码定位（环境变量/cwd/已有 clone/自动 clone）、发布 ref 决策（钉 tag，不追分支）、
# 委托 installer/cli.js 走完整安装流程（swift/npm 预检、构建、launchd、GUI 授权
# 引导均在 installer 内）。**顺序要紧**：Node 预检排在 clone 之前，否则跑不动 installer
# 的机器要先付一次深 1 clone 才知道装不了（2026-10-15 修）。
# 零 bashism（POSIX sh，/bin/sh 直跑）；GLASSPANE_INSTALL_DRY_RUN=1 时只报告
# 决策不执行（供 CI 语法/分支测试）——纯检查（Node 预检、两个覆盖位的形状闸）在
# dry-run 里照跑，因为它们报的就是"这条命令会走到哪一步"。
set -eu

# 发布线锚点（版本真源=根 package.json，由 scripts/set-version.mjs 统一改写，
# 勿手改）：一键安装 clone 的是这个 **tag**，不是移动的 main——同一天两个人跑
# 同一条命令必须拿到同一份源码。入口脚本本身仍从 main 取，因为它是唯一需要
# "最新"的东西：钉的是哪个 tag 就写在这行里。
GLASSPANE_RELEASE="v1.18.0"

# 输出函数先定义：下面第 (0) 条 HOME 闸要用 fail 说话，而它必须排在任何 $HOME 展开之前。
say() { printf '%s\n' "$*"; }
fail() { printf '错误: %s\n' "$*" >&2; exit 1; }

# --- 0a) HOME 闸（必须在 CLONE_DIR 展开之前）---------------------------------
# `set -u` 下 `${VAR:-$HOME/x}` 的**默认值也是展开的一部分**：HOME 没设置时 shell 在拼
# clone 目录那一刻就报 "HOME: unbound variable" 退出（实测 /bin/sh：`install.sh: line 19:
# HOME: unbound variable`，退出 1），一行解释都读不到。installer/cli.js 的 installGuard()
# 专门写了这一段补救话（finding 4），但 install.sh 从来走不到它——它死在委托之前。
# dry-run 不豁免：这一条拒的不是"副作用"，而是"接下来每一条路径都拼不出来"这件事本身，
# 所以它必须仍然是拒（CI 读到的是同一句话）。
# 文案与 installGuard 的 HOME 分支同口径（install-sh.test.mjs 按两条入口同句断言）。
if [ -z "${HOME:-}" ]; then
  printf '%s\n' '错误: HOME 未设置：安装产物、socket 与 ~/Library/LaunchAgents 的路径全部由它拼出来，' >&2
  printf '%s\n' '缺了它这些会落到**当前目录**的相对位置（./.glasspane、./Library/LaunchAgents/…），' >&2
  printf '%s\n' '而 launchd 直接拒收相对的 StandardOutPath——本轮没有写入任何东西。' >&2
  printf '%s\n' '补救：在自己的登录 shell 里重跑（必要时 export HOME=/Users/<你>）；' >&2
  printf '%s\n' '不要用 `sudo -u 某用户` / `env -u HOME` 这类形态起安装器。' >&2
  exit 1
fi

REPO_URL="${GLASSPANE_REPO_URL:-https://github.com/jingzhao-l/GlassPane.git}"
CLONE_DIR="${GLASSPANE_INSTALL_DIR:-$HOME/glasspane}"
DRY_RUN="${GLASSPANE_INSTALL_DRY_RUN:-0}"
# GLASSPANE_REF 的口径与 installer/cli.js 的 resolvePinRef **同源**（finding 10）：
# 未设置与显式置空都钉发布 tag；要追主干必须写 GLASSPANE_REF=main。
# 旧写法在这里把空值读成 main，而 installer 把同一个空值读成上面那个 tag——同一条
# `GLASSPANE_REF=` 在两条一键入口上会拿到两份源码，而 install-sh.test.mjs 的用例标题
# 还写着"与 installer 常量同源"。
# resolvePinRef 对值先 trim，所以 `GLASSPANE_REF='   '` 在它那里等价于"没设"＝钉发布 tag。
# 这一度是两条入口上两种结果：installer 安静地装发布版，这里把同一个值送进
# assert_ref_shape 的形状闸（空白是 ext:: 起 shell 的必要成分），报"含空白/控制字符"
# 退出 1。形状闸本身是对的，问题在口径：上面那句"与 resolvePinRef 同源"当时并不成立。
# 下面裁的是首尾空白，裁完为空才落回发布 tag；带内部空白的值照旧由形状闸拒。
# （installer/test/review-2026-10-09.test.mjs 的 finding10 要求那行赋值与这条例外回退相邻，
#  注释不许插在两者中间——所以这段话写在上头。那是用例的口径，本行不改它。）
REF="${GLASSPANE_REF-${GLASSPANE_RELEASE}}"
REF="${REF#"${REF%%[![:space:]]*}"}"
REF="${REF%"${REF##*[![:space:]]}"}"
[ -n "$REF" ] || REF="$GLASSPANE_RELEASE"

# --- 0b) 覆盖位的形状闸（finding 3）-------------------------------------------
# GLASSPANE_REPO_URL / GLASSPANE_REF 是文档里写明的覆盖口子，值直接进 `git clone` 的
# argv。两类值是命令执行入口：
#   - 不带 scheme 的 `ext::sh -c …`（git 的 ext 传输在 clone 那一刻起一个 shell）；
#   - 以 `-` 开头的值（被 git 当成选项，如 --upload-pack=…）。
# 因此只认白名单前缀 https:// / ssh:// / file://（与 installer/cli.js 的
# ALLOWED_GIT_URL_PREFIXES 同一份），并用 `--` 把选项与位置参数隔开。scp 式
# git@host:path 与 `ext::` 落在同一个"看不出会做什么"的形状里，故拒绝——请写
# ssh://git@host/path。
#
# **这一段的判据、判序与句子都和 installer/cli.js 逐字同源**（install-sh.test.mjs 的
# dry-run 矩阵按值比对两条入口的拒绝文本，要求逐字相等）。从前这里只守"以 - 开头"和
# "含空白"两条，而 cli.js 的 unsafeArgvValue 还拒以 "+" 开头、validateGitRef 还要求值
# 落在 `^[A-Za-z0-9][A-Za-z0-9._/@+-]*$` 里：实测 `GLASSPANE_REF=+bad`、`v1:2`、`~x`、
# `%n` 在这里一路放行、原样进了 `git clone --branch`，然后由 clone 失败那句"ref 不存在
# 或网络不可达"替它们背锅——那是误归因（真正的病因是形状），而 installer 自己的入口对
# 同一批值是拒的。上面那句"与 installer/cli.js 的 resolvePinRef 同源"当时也只对了一半。
# 唯一没能逐字对齐的一处：cli.js 用 JSON.stringify 打印含空白/控制字符的值（控制字符
# 会被转义成 \n 这种两字符形态），这里用双引号原样打印——**可打印**的值两侧完全相等
# （矩阵测的就是这些），带控制字符的值两条入口都拒，只是引号里的形状可能不同。
assert_ref_shape() { # $1=GLASSPANE_REF 的值。判序照 cli.js：空 → "-" → 空白/控制 → "+"
  case "$1" in
    '') fail_ref_gate "GLASSPANE_REF 为空" ;;
    -*) fail_ref_gate "GLASSPANE_REF 以 \"-\" 开头，会被 git 当成命令行选项而不是值：$1" ;;
  esac
  case "$1" in
    *[[:space:]]*|*[[:cntrl:]]*) fail_ref_gate "GLASSPANE_REF 含空白/控制字符：\"$1\"" ;;
  esac
  case "$1" in
    +*) fail_ref_gate "GLASSPANE_REF 以 \"+\" 开头（强推语义），这里不收：$1" ;;
  esac
}

# cli.js 的 validateGitRef 在形状拒绝后面必挂这半句，所以拒绝文本整体也要求与它相等。
fail_ref_gate() {
  fail "$1。ref 只能是 tag/分支名字面量（要追主干就写 main）"
}

assert_repo_url() {
  # 判序与 cli.js 的 validateGitRepoUrl 一致：空 → "-" 开头 → scheme 白名单 → 空白/控制字符。
  # 顺序要紧：`ext::sh -c …` 被挡下的理由是"不带 scheme 的值会被 git 当成 ext 传输去起
  # shell"，先撞上空白那条就把它报成"含空白/控制字符"，读者看不出真正被拒的是什么。
  [ -n "$1" ] || fail "GLASSPANE_REPO_URL 为空。只接受这些地址形式：https://、ssh://、file://"
  case "$1" in
    -*) fail "GLASSPANE_REPO_URL 以 \"-\" 开头，会被 git 当成命令行选项而不是值：$1" ;;
  esac
  # scheme 判据与 cli.js 的 validateGitRepoUrl 逐字同形：整值折成小写后比**前缀**
  # （`https://` / `ssh://` / `file://`）。从前这里先 `${1%%://*}` 裁出 scheme 段再比白名单，
  # 而那个裁法在值里没有 `://` 时返回整串——裸词 `https` / `ssh` / `file` 于是恰好命中白名单
  # 被放过，installer 那一侧却拒它们（比的是带分隔符的前缀）。同一个值两个答案，而放过的
  # 这一半是 `curl | sh` 把值原样送进 `git clone` argv 的那一半，失败还要被下面的归因
  # 说成"ref 不存在或网络不可达"。
  case "$(printf '%s' "$1" | tr 'A-Z' 'a-z')" in
    https://*|ssh://*|file://*) : ;;
    *) fail "GLASSPANE_REPO_URL 必须以 https://、ssh://、file:// 之一开头（实为「$1」）。不带 scheme 的值会被 git 当成传输扩展名（\`ext::…\` 会直接执行后面的命令），因此一律拒绝；本地/镜像 clone 请写 file:///<绝对路径>，scp 式 git@host:path 请写 ssh://git@host/path。" ;;
  esac
  case "$1" in
    *[[:space:]]*|*[[:cntrl:]]*) fail "GLASSPANE_REPO_URL 含空白/控制字符：\"$1\"" ;;
  esac
}

assert_ref() {
  assert_ref_shape "$1"
  # 字符集就是 cli.js 的 `^[A-Za-z0-9][A-Za-z0-9._/@+-]*$`：首字符必须字母/数字，其余只许
  # `A-Za-z0-9._/@+-`。`v1:2`（工作树语法）、`~x`/`%n`（revision 范围与占位符）、`^`、`*`
  # 这类值进 `git clone --branch` 只会换回一条 git 的 fatal，而那条 fatal 会被下面的归因
  # 说成"ref 不存在或网络不可达"——形状问题不该由网络背锅。
  case "$1" in
    [A-Za-z0-9]*) : ;;
    *) fail "GLASSPANE_REF 含不被接受的字符：\"$1\"" ;;
  esac
  case "$1" in
    *[!A-Za-z0-9._/@+-]*) fail "GLASSPANE_REF 含不被接受的字符：\"$1\"" ;;
  esac
}

# clone 失败的归因：**句子与 installer/cli.js 的 cloneFailureText 逐字同源**（finding 9）。
# 旧写法是 `|| fail "clone 失败：ref '$REF' 不存在或网络不可达…"`，把任何非零退出都算成
# 网络/tag 问题；git 的原话当时虽然淌在终端上，却和这句结论分属两行，读的人只会去重试
# 那条永远不通的路。$2 是 git 留下的 stderr 原话（可以为空）。
clone_failure_text() { # $1=ref $2=退出码 $3=目标目录 $4=git 的 stderr
  _head="git clone 失败（ref '$1'，目标 $3，退出码 ${2:-null}）。"
  if [ -n "$4" ]; then
    printf '%s\n%s\n%s\n' "$_head" "git 的原话：$4" \
      "（ref '$1' 不存在或网络不可达只是这份原话**可能**的成因之一，以原话为准。）"
  else
    printf '%s\n%s\n%s\n' "$_head" \
      'git 没有留下 stderr，无法进一步归因；按 ref 不存在 / 网络不可达 / 目标目录不可写三条依次排查。' \
      '可用 GLASSPANE_REF=main 追主干，或 GLASSPANE_REF=<tag> 指定发布版。'
  fi
}

looks_like_repo() {
  [ -f "$1/engine/Package.swift" ] && [ -f "$1/mcp-shell/package.json" ]
}

describe_ref() {
  # 已有 clone 的实身份：优先 tag，退化到短 sha。取不到就如实说取不到。
  git -C "$1" describe --tags --always 2>/dev/null || say "（无法判定该目录的版本）"
}

# --- 1) 平台与 Node 硬预检（installer 是 Node ESM，缺它无从委托；其余依赖交给 installer） ---
# **排在任何 clone 之前**。从前这一段写在 clone 后面，于是"这台机器压根跑不动 installer"
# 这种情形要先付一次 5600 个文件的深 1 clone（慢、占盘、还可能被网络打断），然后才在
# 委托前一句"Node.js 需要 >= 18"退场——留下一个用不上的 ~/glasspane。两条判据都是
# 纯检查（读命令是否存在、读一个主版本号），在任何安装写入之前，把它们换个先后不改变
# 任何落盘行为，只省下那次注定白费的 clone。
# dry-run 同样跑：CI 用 dry-run 读的就是"这条命令会怎么走"，Node 不够格时它该读到的是
# 这一步就拒，而不是读到一条永远执行不了的 clone 计划。
# macOS 这一条同一条规矩：README 两份都写着"macOS 14+"，而本脚本从前不检查——Linux
# 上跑这条一键命令要付完整那次 clone，然后在 installer 里被一句"未找到 open（本安装器
# 面向 macOS）"间接地发现装不了。那是同一个白花，只是换了个理由。
[ "$(uname -s)" = "Darwin" ] || fail "本安装器只支持 macOS（uname -s = $(uname -s)）：Swift/XCTest、launchd 与 TCC 席位都在 macOS 这一侧，本轮没有 clone、没有写入任何东西。要在别的系统上用 GlassPane，等它把引擎搬到那一侧再说，现在这一步没有可绕的旗标。"
command -v node >/dev/null 2>&1 || fail "未找到 Node.js（需 >= 18，https://nodejs.org 或 brew install node）：本轮没有 clone、没有写入任何东西。"
NODE_MAJOR=$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)
[ "$NODE_MAJOR" -ge 18 ] 2>/dev/null || fail "Node.js 需要 >= 18，当前主版本为 $NODE_MAJOR：先换够格的 Node（brew install node 或用 nvm 切一个）再重跑，本轮没有 clone、没有写入任何东西。"
say "Node.js $NODE_MAJOR 预检通过"

# --- 2) 源码定位：GLASSPANE_REPO → 当前目录 → 既有 clone → 自动 clone --------
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
    # stderr 先收进临时文件：git 的诊断与进度都写在 stderr，失败时要把它的**原话**贴进
    # 归因那句里（与 cli.js 的 cloneFailureText 同一口径），成功时再原样吐回终端，进度条
    # 不丢。收不落盘就照常 clone——那是"归因少了 git 原话"，不是"安装做不成"，不值得为它
    # 拒掉一次本来能成功的安装。
    clone_err=""
    clone_err=$(mktemp "${TMPDIR:-/tmp}/glasspane-clone-stderr.XXXXXX" 2>/dev/null || true)
    clone_status=0
    if [ -n "$clone_err" ]; then
      git clone --branch "$REF" --depth 1 -- "$REPO_URL" "$CLONE_DIR" 2>"$clone_err" || clone_status=$?
      clone_stderr=$(cat "$clone_err" 2>/dev/null || true)
      rm -f "$clone_err"
      if [ "$clone_status" -ne 0 ]; then
        fail "$(clone_failure_text "$REF" "$clone_status" "$CLONE_DIR" "$clone_stderr")"
      fi
      if [ -n "$clone_stderr" ]; then
        # 成功时把 git 的进度/警告原样吐回 stderr，不因为要收原话就把它们吞了。
        printf '%s\n' "$clone_stderr" >&2
      fi
    else
      git clone --branch "$REF" --depth 1 -- "$REPO_URL" "$CLONE_DIR" || clone_status=$?
      [ "$clone_status" -eq 0 ] || fail "$(clone_failure_text "$REF" "$clone_status" "$CLONE_DIR" '')"
    fi
    REPO="$CLONE_DIR"
  fi
fi

# --- 3) 委托 installer（参数原样透传，如 --no-gui / --no-app） -----------------
# 三道破坏性确认（覆盖已存在的 .app、bootout 已加载的 launchd 作业、结束在跑的 glasspaned）
# 在 installer 里是三档：交互终端问一句、给了 `--no-prompt` 才照做、非交互又没给这个 flag
# 就**跳过**并打印各自的补救命令（finding 11/12）。
#
# 从前这一节在非 TTY 时替调用方补上 `--no-prompt`，于是文档里那条 `curl … | sh` 一键命令
# ——它永远不是终端——成了唯一一档"不问就照做"的入口：覆盖、bootout、杀进程都在没有一句
# 说明的情况下发生，而同一份文档的 `npx glasspane-install`（TTY）是会问的。两条一键入口对
# 同一件事给出相反的同意，且差别看不见。现在本脚本不再代答：非交互就是 installer 的跳过档，
# 要放行必须自己写 `curl … | sh -s -- --no-prompt`。
HAS_NO_PROMPT=0
for passed in "$@"; do
  [ "$passed" = "--no-prompt" ] && HAS_NO_PROMPT=1
done
if [ -t 0 ]; then
  say 'stdin 是终端：installer 的三道破坏性确认（覆盖已有 .app、bootout launchd 作业、结束在跑的实例）会当面问一句。'
elif [ "$HAS_NO_PROMPT" = "1" ]; then
  say '你显式给了 --no-prompt：上面那三道门不问、直接执行。'
else
  say 'stdin 不是终端：那三道破坏性确认会被跳过，installer 会逐条打印可以照着跑的命令。'
  say '  要放行就在一键命令后面补上这个旗标：sh -s -- --no-prompt；本脚本不替你决定这件事。'
fi
if [ "$DRY_RUN" = "1" ]; then
  say "[dry-run] 将执行: node $REPO/installer/cli.js $*"
  exit 0
fi
export GLASSPANE_REPO="$REPO"
exec node "$REPO/installer/cli.js" "$@"
