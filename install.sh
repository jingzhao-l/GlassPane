#!/bin/sh
# GlassPane 一键安装入口（P4 §35）：
#   curl -fsSL https://raw.githubusercontent.com/jingzhao-l/GlassPane/main/install.sh | sh
# 职责边界：本脚本只做 5 件事，一条一行写在下面（行首 `# 职责N：`）。
# **这个数与下面的行数由 installer/test/install-sh.test.mjs 逐条核对**：加一条职责而不改
# 那句数（或改了数却没列出对应条目）就是红。头里的数与脚本实际做的事对不上，是本仓写过
# 好几次的那类"注释不在任何闸里"（v1.18.0 加了 macOS 平台闸，头里仍旧写着"四件事"，
# 而没有任何一道闸读过头——第五件事就这么躲过了所有检查）。
# 职责1：Node 硬预检（installer 本身要求 Node >= 18）。
# 职责2：平台闸——只 macOS，排在它要挡的那笔 clone 之前（v1.18.0 加的就是这一条）。
# 职责3：源码定位（环境变量/cwd/已有 clone/自动 clone）。已有 clone 会被**前进**到钉住的那个 tag——
#        树干净才切（fetch + checkout --detach），脏就拒绝并点名挡路的文件；"照用一个旧版本的树"
#        与"提示一句就别想动它"都不是这一条的答案（2026-10-26 修的就是这两下）。
# 职责4：发布 ref 决策 + 两个覆盖位的形状闸（钉 tag，不追分支；GLASSPANE_REPO_URL 与
#        GLASSPANE_REF 先进形状闸再进 git 的 argv）。
# 职责5：委托 installer/cli.js 走完整安装流程（swift/npm 预检、构建、launchd、GUI 授权
#        引导均在 installer 内）。
# 另有一道不算职责的前置闸门：HOME 闸（下面的 0a）——它不是"做一件事"，而是保证后面每一条
# 拼出来的路径都有家可归；dry-run 也不豁免它。
# **顺序要紧**：Node 预检排在 clone 之前，否则跑不动 installer
# 的机器要先付一次深 1 clone 才知道装不了（2026-10-15 修）；平台闸同样排在 clone 之前，
# 因为它要挡的正是那笔 clone。
# 零 bashism（POSIX sh，/bin/sh 直跑）；GLASSPANE_INSTALL_DRY_RUN=1 时只报告
# 决策不执行（供 CI 语法/分支测试）——纯检查（Node 预检、两个覆盖位的形状闸）在
# dry-run 里照跑，因为它们报的就是"这条命令会走到哪一步"。
# 形状闸的位置是这句承诺的一部分：它在**源码定位之前**（下面的 --- 2)，所以"定位到本地
# 仓库、这一趟不 clone"的那一条也照样被问；从前它只住在"要 clone"那一支里，于是同一条
# `GLASSPANE_REF='+bad'` 在 clone 那一趟被拒、在本地那一趟回 0（两条一键入口对同一个覆盖
# 位给两个答案）。钉它的用例：installer/test/qoder-20261024-installer-lane.test.mjs。
set -eu

# 发布线锚点（版本真源=根 package.json，由 scripts/set-version.mjs 统一改写，
# 勿手改）：一键安装 clone 的是这个 **tag**，不是移动的 main——同一天两个人跑
# 同一条命令必须拿到同一份源码。入口脚本本身仍从 main 取，因为它是唯一需要
# "最新"的东西：钉的是哪个 tag 就写在这行里。
GLASSPANE_RELEASE="v1.23.0"

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

# 既有 clone 能不能被这一趟使用，由这个函数回答。判据与 installer/cli.js 的 existingCloneDecision
# 同源（同一份"什么算脏"、同三种动作：用 / 前进 / 拒），两处过程由 install-sh.test.mjs 拿同一把
# 假 git 各跑一遍钉住——在这里发明第二种说法，就是下一次"两条一键入口对同一件事给相反答案"的起点
# （本轮被修掉的正是这一类：一条只打印提示、另一条直接 clone 失败）。
# 这几种 git 动作：status / rev-parse 是读，fetch 只往 .git 里加对象（带不带 --depth 1 由
# git 自己答的"是不是浅仓"决定——对一棵完整 clone 加 --depth 1 会落下 .git/shallow，那不是
# "只加对象"而是给人家的历史加边界），checkout --detach 只在树**干净**时执行。
# 没有 -f、没有 stash、没有 clean：安装脚本不该有能把别人的未提交工作抹掉的那一格。
advance_existing_clone() { # $1=目录 $2=要装的 ref。回 0 = 这棵树可以用；非 0 = 本轮别用它，且没动过它
  _dir="$1"
  _ref="$2"
  _dirty=$(git -C "$_dir" status --porcelain 2>/dev/null || echo "__读不出__")
  if [ "$_dirty" = "__读不出__" ]; then
    say "  ${_dir} 读不出 git 状态（那目录不是仓库，或 git 答不了）：判不出来的事不当成「干净」，不动它。"
    say "  下一步：GLASSPANE_INSTALL_DIR=<空目录> 重跑本脚本，换一处全新的 clone。"
    return 1
  fi
  if [ -n "$_dirty" ]; then
    _n=$(printf '%s\n' "$_dirty" | grep -c '' || true)
    say "  ${_dir} 有 ${_n} 处未提交改动，安装器不切走它（切走就把别人的工作当成构建源码）："
    printf '%s\n' "$_dirty" | sed -n '1,10p' | sed 's/^/      /'
    if [ "$_n" -gt 10 ]; then
      say "      …另有 $(( _n - 10 )) 处"
    fi
    say "  下一步（两条都做得动，且不销毁任何东西）："
    # 路径必须加引号：HOME 里带空格时（/Users/John Smith）这一句照抄进去是**两个词**，
    # 于是 clone 落在 /Users/John 而 Smith/glasspane-… 变成一条没人请求的命令 —— 静默落错位置
    # 比拒掉更难发现。建议的目录也从被拒的这棵树推，不写死 ~。
    say "    a) 换一处干净的家：GLASSPANE_INSTALL_DIR=\"${_dir}-$(printf '%s' "$_ref" | tr -c 'A-Za-z0-9._+-' '_')\" 重跑一键安装"
    say "    b) 自己收着这些改动：在 ${_dir} 里提交或转移到别处，再重跑本命令——这些文件去哪由你决定，不由安装器决定。"
    return 1
  fi
  _head=$(git -C "$_dir" rev-parse --verify HEAD 2>/dev/null) || {
    say "  ${_dir} 读不出 HEAD：判不出来就不动它。"
    return 1
  }
  _tag=$(git -C "$_dir" rev-parse --verify "${_ref}^{commit}" 2>/dev/null || true)
  if [ -z "$_tag" ]; then
    # `--depth` 只在 git 自己答"这是浅仓"时才加。从前无条件加，而这行 say 写的是"只往 .git 里加
    # 对象"——那句话对完整 clone 不成立：`fetch --depth 1` 会落下 `.git/shallow`，给一份本来完整的
    # 历史加上人为边界（要抹掉得 `git fetch --unshallow`，而那不是这一趟该替人做的决定）。
    _depth=""
    if [ "$(git -C "$_dir" rev-parse --is-shallow-repository 2>/dev/null || echo unknown)" = "true" ]; then
      _depth="--depth 1"
    fi
    # 远端名不写死 origin：`git clone --origin up` 建的树、把 origin 改指镜像的树，走的都是同一条
    # 拒绝，而那句拒绝让读者去跑 `git ls-remote --tags origin <ref>`——同一条用错名字的命令，照抄
    # 只会再失败一次。判据只读事实：有 origin 用它；只有一个远端就用它；其余（零个或多个而无
    # origin）是"答不出该从哪取"，不猜。
    _remote=$(git -C "$_dir" remote 2>/dev/null | sed -n '/^origin$/p' | sed -n '1p')
    if [ -z "$_remote" ]; then
      _rn=$(git -C "$_dir" remote 2>/dev/null | grep -c '' || true)
      if [ "${_rn:-0}" = "1" ]; then
        _remote=$(git -C "$_dir" remote 2>/dev/null | sed -n '1p')
      fi
    fi
    if [ -z "$_remote" ]; then
      say "  ${_dir} 里没有 ${_ref} 这个引用，而这一趟连「该从哪个远端取」都答不出："
      say "    git remote 里既没有 origin，也不是只剩一个远端（读到的远端：$(git -C "$_dir" remote 2>/dev/null | tr '\n' ' ')）。"
      say "    不猜一个名字去 fetch。${_dir} 原地不动，没有 fetch、没有切分支、没有构建任何东西。"
      say "    下一步：把要用的那个远端改名成 origin，或 GLASSPANE_INSTALL_DIR=<空目录> 换一处全新的 clone。"
      return 1
    fi
    say "  ${_dir} 里没有 ${_ref} 这个引用（旧 clone 的 tag 表停在更早一版、浅 clone，以及**按 tag 建的 clone 里根本没有 refs/heads/** 都会这样）："
    say "    先 fetch 它——git -C ${_dir} fetch --tags ${_depth:+$_depth }${_remote} ${_ref}，只补对象、不动工作树。"
    if ! git -C "$_dir" fetch --tags $_depth "$_remote" "$_ref" >/dev/null 2>&1; then
      say "    git fetch 非零退出：确认网络与该引用存在（git ls-remote ${_remote} ${_ref}），"
      say "    或 GLASSPANE_INSTALL_DIR=<空目录> 换一处全新的 clone。本轮没有 clone、没有切分支。"
      return 1
    fi
    # fetch 退 0 不等于"本地多了一个叫 ${_ref} 的 ref"。按 tag 建的 clone 里 `fetch origin main`
    # 只写 FETCH_HEAD（本机实测：fetch 前后 `rev-parse --verify 'main^{commit}'` 都回
    # `fatal: Needed a single revision`，而 `checkout --detach main` 回
    # `fatal: git checkout: --detach does not take a path argument 'main'`）。旧代码在这里直接
    # 判"读不出就不动它"，把一条通了的网络说成网络问题，而文档第 64 行写明的
    # 「要追主干必须写 GLASSPANE_REF=main」在这两条一键入口上就是**永久死路**。
    # FETCH_HEAD 就是这一趟自己刚取回来的那个东西的落点，用它；不由别处默认打开，否则上一趟
    # 别人 fetch 的残留会被读成"这一版就在它指的地方"。
    _tag=$(git -C "$_dir" rev-parse --verify "${_ref}^{commit}" 2>/dev/null \
      || git -C "$_dir" rev-parse --verify 'FETCH_HEAD^{commit}' 2>/dev/null || true)
    if [ -z "$_tag" ]; then
      # 这一支是构造性护栏，不是对某条生产路径的归因：本机实测 git 对远端不存在的引用答退出 128，
      # 所以上面那次 fetch 失败早被前一条 say 拦下了。留着它只为一句——`checkout --detach` 的实参
      # 只许是读到的 commit，空串不行（旧写法在这里也只说"不动它"，同样的形状，不额外发明原因）。
      say "    fetch 之后仍读不出 ${_ref} 指向的 commit（${_ref}^{commit} 与 FETCH_HEAD 都答不出）：不动它。"
      say "    ${_dir} 原地不动，没有切分支、没有构建任何东西。"
      say "    下一步：git clone --branch ${_ref} ${REPO_URL} 建一棵带分支的树，或 GLASSPANE_INSTALL_DIR=<空目录> 换一处全新的 clone。"
      return 1
    fi
  fi
  if [ "$_head" = "$_tag" ]; then
    say "  该目录已经在 ${_ref}（$(printf '%.7s' "$_head")），直接用它构建。"
    return 0
  fi
  say "  该目录干净而在 $(printf '%.7s' "$_head")，要装的是 ${_ref}（$(printf '%.7s' "$_tag")）：前进它。"
  # 切的是那个 commit 的 sha，不是名字：名字在按 tag 建的 clone 里不是一个 ref，git 会拒
  # `--detach <path>`；sha 才是这一句本来的意思。
  if ! git -C "$_dir" checkout --detach "$_tag" >/dev/null 2>&1; then
    say "    git checkout --detach ${_tag} 失败：${_dir} 仍在 $(printf '%.7s' "$_head")，本轮没有构建任何东西。"
    return 1
  fi
  # 切完再读一次：判据要落在切换之后的事实上，不是落在命令的退出码上。
  _now=$(git -C "$_dir" rev-parse --verify HEAD 2>/dev/null || true)
  _still=$(git -C "$_dir" status --porcelain 2>/dev/null || echo "__读不出__")
  if [ "$_now" != "$_tag" ] || [ -n "$_still" ]; then
    say "    切完之后判据不再成立（HEAD=${_now:-读不出}，仍有改动）：本轮不拿它构建。"
    return 1
  fi
  say "  已前进到 ${_ref}（$(printf '%.7s' "$_now")），用它构建。"
  return 0
}

# --- 1) 平台与 Node 硬预检（installer 是 Node ESM，缺它无从委托；其余依赖交给 installer） ---
# **排在任何 clone 之前**。从前这一段写在 clone 后面，于是"这台机器压根跑不动 installer"
# 这种情形要先付一次 5600 个文件的深 1 clone（慢、占盘、还可能被网络打断），然后才在
# 委托前一句"Node.js 需要 >= 18"退场——留下一个用不上的 ~/glasspane。两条判据都是
# 纯检查（读命令是否存在、读一个主版本号），在任何安装写入之前，把它们换个先后不改变
# 任何落盘行为，只省下那次注定白费的 clone。
# dry-run 同样跑：CI 用 dry-run 读的就是"这条命令会怎么走"，Node 不够格时它该读到的是
# 这一步就拒，而不是读到一条永远执行不了的 clone 计划。
# （macOS 这一条不在这里：它要挡的是那笔 clone，所以住在 clone 分支的开头，见下面的 --- 2。）
command -v node >/dev/null 2>&1 || fail "未找到 Node.js（需 >= 18，https://nodejs.org 或 brew install node）：本轮没有 clone、没有写入任何东西。"
NODE_MAJOR=$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)
[ "$NODE_MAJOR" -ge 18 ] 2>/dev/null || fail "Node.js 需要 >= 18，当前主版本为 ${NODE_MAJOR}：先换够格的 Node（brew install node 或用 nvm 切一个）再重跑，本轮没有 clone、没有写入任何东西。"
say "Node.js $NODE_MAJOR 预检通过"

# --- 2) 两个覆盖位先过形状闸，再谈源码定位 ------------------------------------
# 头里那句"纯检查（Node 预检、两个覆盖位的形状闸）在 dry-run 里照跑，因为它们报的就是
# '这条命令会走到哪一步'"要成立，这两道闸就不能只住在"要 clone"那一支里。
# 2026-10-24 复核（finding C8）：它们从前就在那里，于是定位到本地仓库的那一趟
# （GLASSPANE_REPO 指定的、当前目录这棵 checkout、既有 clone）一步都不过闸——实测
# `GLASSPANE_REF='+bad' GLASSPANE_INSTALL_DRY_RUN=1 sh install.sh` 回 0，`+bad` 只出现在
# 提示行里；`GLASSPANE_REPO_URL='ext::sh -c touch'` 同样回 0。那两个值确实进不了这一趟的
# `git clone`（这一趟不 clone），但它们进了**委托给 installer 的那条命令的环境**，而
# installer 的 `--bootstrap` 那一支会拿同一对值去 clone 别的树：形状闸的产出是一份
# "这两个值是可执行的"的许可，而它本该在**决定要不要给这份许可之前**问完。
# 提到分支之前也顺手把头里的承诺兑现成一条能被用例钉住的顺序：闸在定位之前，
# 因此对"这一趟会不会走到 clone"这个结论是**先于**它说话的。
assert_repo_url "$REPO_URL"
assert_ref "$REF"

# --- 2c) 透传参数里的两个源码定位旗标（2026-10-27 finding C6）-----------------
# `--repo <dir>` 与 `--no-bootstrap` 写在 installer/cli.js 的 usageText 里（离线/免 clone 的两个
# 控制口子）。从前这里只读 GLASSPANE_REPO / $PWD / 既有 clone 三个位置，把这两个旗标**原样透传**
# 给委托的那一步——于是 `curl … | sh -s -- --repo ~/src/GlassPane` 仍旧先付一次 depth-1 网络 clone
# （正是那个旗标要省掉的那笔副作用）；而 ~/glasspane 已存在又不是仓库时，脚本在**委托之前**就
# 退出 1（下面那句"目标目录已存在"），文档里那条旗标在 primary 入口上根本没轮到 installer 去读。
# 一个只在其中一条入口上生效的旗标，等于给读者留了一条看着能用的死路。
_explicit_repo=""
_no_bootstrap=0
_want_repo_arg=0
for _arg in "$@"; do
  if [ "$_want_repo_arg" = "1" ]; then
    _explicit_repo="$_arg"
    _want_repo_arg=0
    continue
  fi
  case "$_arg" in
    --repo) _want_repo_arg=1 ;;
    --no-bootstrap) _no_bootstrap=1 ;;
  esac
done

# --- 3) 源码定位：--repo → GLASSPANE_REPO → 当前目录 → 既有 clone → 自动 clone --
REPO=""
if [ -n "$_explicit_repo" ] && looks_like_repo "$_explicit_repo"; then
  REPO="$_explicit_repo"
  say "使用 --repo 指定的仓库: $REPO"
elif [ -n "${GLASSPANE_REPO:-}" ] && looks_like_repo "$GLASSPANE_REPO"; then
  REPO="$GLASSPANE_REPO"
  say "使用 GLASSPANE_REPO 指定的仓库: $REPO"
elif looks_like_repo "$PWD"; then
  REPO="$PWD"
  say "在当前目录定位到仓库: $REPO"
elif looks_like_repo "$CLONE_DIR"; then
  REPO="$CLONE_DIR"
  say "使用既有 clone: ${REPO}（该目录实际版本: $(describe_ref "$REPO")）"
  # 从前这一支只打印一句"既有 clone 不会被自动切到 ${REF}"，然后**照用那棵树**去委托 installer——
  # 2026-10-26 这台机器上那是 v1.5.0 的 clone，于是"一键安装"交出去的是三年前的产物，而另一条一键
  # 入口（npx）对同一个目录跑 `git clone`，被 git 以 "already exists and is not an empty directory"
  # 拒掉。现在这里问三件事：那棵树脏不脏、HEAD 是不是钉住的那个 tag、需不需要切。
  # 判据与 installer/cli.js 的 existingCloneDecision 同源（同一份"什么算脏"、同一组动作名）；
  # 两处的**过程**由 install-sh.test.mjs 用同一把假 git 各跑一遍来钉，不在这里发明第二种说法。
  if [ "$DRY_RUN" = "1" ]; then
    say "[dry-run] 将检查 ${CLONE_DIR} 能否前进到 ${REF}（干净就 fetch + checkout --detach，脏就拒绝并点名挡路的文件）"
  else
    advance_existing_clone "$CLONE_DIR" "$REF" || fail "既有 clone 没有被前进：上面就是原因，本轮没有构建、没有覆盖 ~/Applications。"
    REPO="$CLONE_DIR"
  fi
fi

if [ -z "$REPO" ]; then
  # `--no-bootstrap` 承诺的就是"这一趟不 clone"，所以它必须在这一步就说话，不能等到委托
  # 那一行才由 installer 拒绝——那时脚本已经付过一次网络 clone 了（见上面 2c 那段）。
  if [ "$_no_bootstrap" = "1" ]; then
    say "--no-bootstrap：本脚本不 clone。四个定位位都没命中："
    say "  GLASSPANE_REPO=${GLASSPANE_REPO:-（未设置）}"
    say "  --repo=${_explicit_repo:-（未给）}（给了但这个目录不像 GlassPane 仓库时也会走到这里）"
    say "  当前目录=$PWD"
    say "  既有 clone=$CLONE_DIR"
    say "下一步：用 --repo <目录> 或 GLASSPANE_REPO=<目录> 指一棵含 engine/Package.swift 与"
    say "  mcp-shell/package.json 的树，或去掉 --no-bootstrap 让它 clone 一份（ref: ${REF}）。"
    if [ "$DRY_RUN" = "1" ]; then
      say "[dry-run] 结论：这一趟在源码定位这一步就停，不会有 clone、不会有委托。"
      exit 1
    fi
    exit 1
  fi
# 定位不到源码 ⇒ 这一步一定要 clone，而 clone 就是那笔白花的花费所在，所以平台闸正好卡在这里
  # （不是卡在入口）：README 两份都写着"macOS 14+"，而 Linux/BSD 上从前要付完整那次 5600 文件的
  # clone，然后在 installer 里被一句"未找到 open"间接地发现装不了。已经有源码的那一趟不在此列——
  # 它不付 clone，交给 installer 自己去说平台。
  # dry-run 仍然把计划打出来（CI 的 install-gate 那一格就跑在非 macOS 上，它读的是"这条命令会走到
  # 哪一步"），只是先把"真跑会停在平台闸"说明白，不留一句没说出口的假设。
  if [ "$(uname -s)" != "Darwin" ]; then
    if [ "$DRY_RUN" = "1" ]; then
      say '[dry-run] 平台闸会在 clone 之前停（uname -s 不是 Darwin）：真跑这一条不会 clone、不会写入任何东西。下面两行是 macOS 上会发生的部分。'
    else
      fail "本安装器只支持 macOS（uname -s = $(uname -s)）：Swift/XCTest、launchd 与 TCC 席位都在 macOS 这一侧，本轮没有 clone、没有写入任何东西。要在别的系统上用 GlassPane，等它把引擎搬到那一侧再说，现在这一步没有可绕的旗标。"
    fi
  fi
  # 走到这里就一定要 clone（连 dry-run 也是要说清"将要 clone 什么"）。两个覆盖位的
  # 形状闸**已经在上面的 --- 2) 跑过**（dry-run 也跑），这里不再重复：同一份判据在
  # 一个脚本里跑两遍，就是给下一次改一处漏一处留的口子。
  if [ "$DRY_RUN" = "1" ]; then
    # dry-run 也要把 REPO 定下来：否则后面委托行打印成 "/installer/cli.js"，
    # CI 的分支测试就读不出真实将要执行的路径。
    REPO="$CLONE_DIR"
    say "[dry-run] 未定位到仓库，将执行: git clone --branch $REF --depth 1 -- $REPO_URL $CLONE_DIR"
  else
    command -v git >/dev/null 2>&1 || fail "未找到 git（安装 Xcode Command Line Tools: xcode-select --install）"
    if [ -e "$CLONE_DIR" ]; then
      fail "目标目录已存在且不是 GlassPane 仓库: ${CLONE_DIR}（用 GLASSPANE_REPO 指定仓库或清理后重试）"
    fi
    say "未定位到本地仓库，clone 源码到 ${CLONE_DIR}（ref: ${REF}）……"
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

# --- 4) 委托 installer（参数原样透传，如 --no-gui / --no-app） -----------------
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
# 平台闸的第二道：上面那一支只管"要 clone 的那一趟"，而源码已经在手边时（GLASSPANE_REPO 指的仓库、
# 当前目录、既有 clone）这一趟从不经过它，注释里那句"交给 installer 自己去说平台"从来没成立过——
# installer/cli.js 里没有任何平台判据（grep `process.platform` 命中 0）。实测形状：在一个 GlassPane
#  checkout 里把 `uname` 桩成 Linux 跑真装，本脚本会一路走到 `exec node cli.js`，随后 npm ci、tsc、
# swift build 与 launchd 注册全部真的发生（本轮就被这件事咬过一次：测试从仓库根跑，HOME 是真家目录）。
# 所以这里在委托之前问一次：不是 Darwin 就停，且不写任何东西。dry-run 已经在上面 exit 了，
# CI 的 install-gate 那一格读到的计划行不受影响。
if [ "$(uname -s)" != "Darwin" ]; then
  fail "本安装器只支持 macOS（uname -s = $(uname -s)）：Swift/XCTest、launchd 与 TCC 席位都在 macOS 这一侧。源码已经在手边（${REPO}）这一趟不付 clone，但它同样不会 delegate 给 installer —— 没有 npm ci、没有 swift build、没有注册 launchd 作业。现在这一步没有可绕的旗标。"
fi
export GLASSPANE_REPO="$REPO"
exec node "$REPO/installer/cli.js" "$@"
