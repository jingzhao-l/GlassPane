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
# 拼出来的路径都有家可归；dry-run 也不豁免它。usage 闸（下面的 2d）同理：它不做任何事，只是
# 在动手之前把这一页交出来（2026-10-29 之前本脚本压根不认 --help/-h，见下面那一节的注释）。
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
GLASSPANE_RELEASE="v1.27.0"

# 输出函数先定义：下面第 (0) 条 HOME 闸要用 fail 说话，而它必须排在任何 $HOME 展开之前。
say() { printf '%s\n' "$*"; }
fail() { printf '错误: %s\n' "$*" >&2; exit 1; }

# usage 闸（下面的 2d）要打印的那一页，因此必须排在它被调用之前——shell 的函数是"定义在前才存在"。
# 内容只到"这一层脚本认什么"为止：installer 那一层的旗标交给它自己的 --help。把那份旗标清单抄进
# 这里，就是下一处"两份抄本没人对照"（本轮修的那几条里已经有三条是这个形状）。
usage() {
  say 'GlassPane 一键安装入口（install.sh）——只说明这一层做什么，其余交给 installer。'
  say ''
  say '用法：'
  say '  脚本头里那一行 curl -fsSL … | sh 就是本文件的安装写法（那一行的地址与 installer/cli.js 的'
  say '  INSTALL_SH_URL 常量由用例逐字对照；这里不再抄一遍，多一处地址就多一处没人对照的抄本）。'
  say '  sh install.sh [选项]                     # 一键命令里要带旗标就写：| sh -s -- <选项>'
  say ''
  say '这一层认的三个旗标（其余原样透传给 installer/cli.js，它的 --help 里有完整清单）：'
  say '  --repo <目录>    用这棵树当源码（两条判据：目录要存在，且目录里要同时有'
  say '                   engine/Package.swift 与 mcp-shell/package.json）；给了而不合判据就当场停下，'
  say '                   不 clone、也不委托——GLASSPANE_REPO 指同一件事，也走同一道闸。'
  say '  --no-bootstrap   定位不到源码时不 clone，直接停下并打印四个定位位。'
  say '  -h, --help       这一页。退出码 0，且不 clone、不委托——任何平台都一样（与 installer/cli.js'
  say '                   对 --help 的豁免同一句话：CI 读的就是这一页，不是这台机器装不装得了）。'
  say ''
  say '环境变量：'
  say '  GLASSPANE_REPO_URL      clone 的地址，只认 https:// / ssh:// / file://（默认 GitHub 上的本仓）'
  say '  GLASSPANE_REF           钉的版本（默认 '"${GLASSPANE_RELEASE}"'；要追主干必须显式写 main）'
  say '  GLASSPANE_INSTALL_DIR   clone 的落点（默认 '"${HOME:-当前登录家目录}"'/glasspane）'
  say '  GLASSPANE_REPO          指一棵已经在手的仓库树（与 --repo 同一件事，也过同一道判据闸：'
  say '                          给了而不合判据就当场停下，不再悄悄落到下一个定位位）'
  say '  GLASSPANE_INSTALL_DRY_RUN=1  只报告决策：不 clone、不委托'
  say ''
  say '这一层做的五件事（Node 预检 / 平台闸 / 源码定位 / 覆盖位的形状闸与透传 / 委托 installer）'
  say '写在脚本头里；构建、launchd 注册与权限引导都在 installer 里：'
  say '  node <仓库>/installer/cli.js --help'
  say ''
  say '退出码：0 = 这一页已打印（--help），或委托之后 installer 自己回的那个 0；'
  say '        1 = 这一层就停下（HOME/形状闸/源码定位/两个定位位的判据闸/平台闸），或 installer 回 1；'
  say '        2 = 命令行参数错误——这一层自己就能判的那两类（--repo 没接到取值、接到的是一面旗标，'
  say '            以 - 开头时单双横线都算）由这一层直接回 2，其余（未知参数）由 installer 判了透传回来。'
  say '        用法错与 --help 同时出现时：上面那两类**先赢**（仍旧 2，argv 在 --repo 那一枚上没'
  say '        写完），未知参数那一类**让位**给 --help（两条入口都打帮助页并退 0）——同一份规则'
  say "        写在 installer/cli.js 的入口与 2c' 那一节的注释里，两条一键入口对同一串 argv 同答。"
}

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
  printf '%s\n' '补救：在自己的登录 shell 里重跑（那里 HOME 本来就有值）；' >&2
  printf '%s\n' '  手工指定落点也可以：GLASSPANE_INSTALL_DIR=<目录> 管这一键安装把仓库放哪，' >&2
  printf '%s\n' '  --state-dir <目录> 管 daemon/updater 的状态放哪。手动 export HOME 只搬得动本脚本——' >&2
  printf '%s\n' '  daemon 与更新器读的是口令档案里的家目录，不看 ${HOME}，所以那样装完两侧会指着两个根。' >&2
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

# 显式定位位（--repo / GLASSPANE_REPO）交进来的目录不合判据时，这一层怎么说。
# **两句判据都要点名**（目录存在 + 两个 marker 都在），且拒在任何动作之前：本函数不 clone、
# 不委托、不写一个字节，说完就 exit 1。行式与 installer/cli.js 的 `locatedRootRefusal` 逐句同源
# （2026-10-31 P0；同一串输入两条一键入口必须给同一个码、同一句话，由
# installer/test/daily-20261030-entry-parity.test.mjs 按值对照——在那之前"两条入口同答"只是
# 两句注释互相指认）。改这里那一行也要去改那一头。
refuse_located_root() { # $1=旗标/变量名 $2=目录
  _rr_label=$1
  _rr_dir=$2
  say "${_rr_label} 给了这个目录，而它不合判据：${_rr_dir}"
  say '  判据（两条都要在，与 looks_like_repo 同一份）：目录要存在；目录里要同时有 engine/Package.swift 与 mcp-shell/package.json。'
  if [ ! -d "$_rr_dir" ]; then
    say '  现在缺的是：目录不存在'
  else
    _rr_missing=''
    for _rr_marker in engine/Package.swift mcp-shell/package.json; do
      [ -f "${_rr_dir}/${_rr_marker}" ] || _rr_missing="${_rr_missing:+${_rr_missing}、}${_rr_marker}"
    done
    say "  现在缺的是：${_rr_missing} 不在"
  fi
  say '  这一枚原样透传给 installer/cli.js 时它优先级最高：刚 clone 的那一棵会被无视，'
  say '  npm install 会以这个被拒的目录为 cwd 真的跑起来——所以这里停下，不 clone、不委托。'
  say '本轮没有 clone、没有写入任何东西。'
  say "下一步：${_rr_label} 指一棵真的仓库（上面两条判据都在），或去掉 ${_rr_label} 让它 clone 一份（ref: ${REF}）。"
  exit 1
}

# 印出去的那一行要能**整行照抄执行**（2026-10-31 P2）：dry-run 的两行计划从前是裸插值
# （`git clone … $CLONE_DIR`、`node $REPO/installer/cli.js $*`），于是
# `GLASSPANE_INSTALL_DIR="/Users/John Smith/glasspane"` 打印出来的那条命令照抄去跑会变成
# 两个参数——落点被路径里的空格重排，而真跑那一支用的是引号包住的 "$CLONE_DIR"。
# 表与 installer/cli.js 的 `quoteShellArg`（= `updater/lib/shell-quote.js` =
# `mcp-shell/src/errors.ts`，产品里的同一份表）逐字符对齐：只由 shell 动不了手脚的字符组成的
# 词原样印，其余（空格、引号、glob、`$`、空串、以 `-` 开头）单引号包住，内部的单引号换成 '\''。
sh_quote() { # $1=任意值；stdout 上是一个可照抄的 shell 词
  _sq_in=$1
  _sq_q="'"
  _sq_bare=1
  # 分类必须**按字节**判（2026-10-31，CI 的 macOS lane 抓到）：`case` 里的 `[!A-Za-z…]` 受
  # locale 影响，macOS runner 的 en_US.UTF-8 下 `é`（UTF-8 两字节）被当成落在字母类里，于是
  # 这里印裸的 `é`，而 `installer/cli.js` 的 quoteShellArg 印 `'é'`——同一串 argv 在两条一键
  # 入口上有两种引号形状（Linux 上反倒一致，所以这一族只在交付平台上现形）。LC_ALL=C 让字符类
  # 按字节走，与 JS 那张表逐值同判；`installer/test/install-sh.test.mjs` 的表对照钉这件事。
  if ! printf '%s' "$_sq_in" | LC_ALL=C command grep -q "[^A-Za-z0-9@%+=:,./_-]"; then
    _sq_bare=1
  else
    _sq_bare=0
  fi
  case $_sq_in in
    '') _sq_bare=0 ;;
    -*) _sq_bare=0 ;;
  esac
  if [ "$_sq_bare" = "1" ]; then
    printf '%s' "$_sq_in"
    return 0
  fi
  _sq_out=''
  _sq_rest=$_sq_in
  while :; do
    case $_sq_rest in
      *"$_sq_q"*) ;;
      *) _sq_out="${_sq_out}${_sq_rest}"
         break ;;
    esac
    # 关引号 → 一个反斜杠引起来的单引号 → 再开引号（POSIX 里唯一稳的写法）。
    _sq_out="${_sq_out}${_sq_rest%%"$_sq_q"*}${_sq_q}\\${_sq_q}${_sq_q}"
    _sq_rest=${_sq_rest#*"$_sq_q"}
  done
  printf "'%s'" "$_sq_out"
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
  # 第一件事不是"这棵树脏不脏"，而是"要动的是不是这一棵"（2026-10-29 S7-1，installer 那一侧同修）。
  # `git -C <目录>` 落到的是**离它最近的那棵树**：`<外层repo>/vendored` 这样的子目录过得了
  # looks_like_repo（它自己就有那两个 marker），而随后 status / checkout 读与写的都是外层那一棵。
  # 两侧都要化成物理路径再比：git 打的 --show-toplevel 是物理路径，而 $_dir 可能带着
  # /var→/private/var 这一类软链进来（本机实测），直接比字符串会把一棵正当的 clone 判成别处。
  _top=$(git -C "$_dir" rev-parse --show-toplevel 2>/dev/null || true)
  _here=$(cd "$_dir" 2>/dev/null && pwd -P || true)
  if [ -z "$_top" ] || [ -z "$_here" ] || [ "$_top" != "$_here" ]; then
    say "  ${_dir} 自己不是一棵 git 仓库的根：git -C \"${_dir}\" rev-parse --show-toplevel 答的是 ${_top:-（没答话）}。"
    say "  本轮要是动手，动的就是 ${_top:-那一问没有答案} 那一棵，而不是你指的 ${_dir}——那是别人的仓库：不在它上面 fetch、不切它的分支、不碰它的工作树。"
    say "  下一步（两条都做得动，且不销毁任何东西）：a) GLASSPANE_INSTALL_DIR=<不属于任何仓库的目录> 重跑一键安装；"
    say "    b) 要装的那一棵在别处，就用 --repo <目录> 或 GLASSPANE_REPO=<目录> 指过去——指的目录自己必须就是仓库根。"
    return 1
  fi
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
    # 这一句是**打印给读者照抄**的，所以路径必须带引号（2026-10-29 S7-4）：HOME 或
    # GLASSPANE_INSTALL_DIR 里带空格时（/Users/John Smith），裸的 ${_dir} 照抄进 shell 就断成两个词，
    # git 收到的是 `git -C /Users/John Smith fetch …`——那条命令要么失败要么在别处生效，而这一行
    # 的本意是"照着跑就对了"。同一个函数上面 40 行的 GLASSPANE_INSTALL_DIR=\"…\" 已经是带引号的
    # 那一形；判据对、句子漏一处，就是这道闸（install-sh 那条静态闸）现在扫的东西。
    # $_depth 保持不带引号：它要在打印出来的那一行里就是两个词（--depth 1），加引号反而合成一个
    # git 不认的参数。
    say "    先 fetch 它——git -C \"${_dir}\" fetch --tags ${_depth:+$_depth }\"${_remote}\" \"${_ref}\"，只补对象、不动工作树。"
    if ! git -C "$_dir" fetch --tags $_depth "$_remote" "$_ref" >/dev/null 2>&1; then
      say "    git fetch 非零退出：确认网络与该引用存在（git ls-remote \"${_remote}\" \"${_ref}\"），"
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
_wants_help=0
_want_repo_arg=0
_repo_value_missing=0
for _arg in "$@"; do
  if [ "$_want_repo_arg" = "1" ]; then
    _explicit_repo="$_arg"
    _want_repo_arg=0
    continue
  fi
  case "$_arg" in
    --repo) _want_repo_arg=1 ;;
    --no-bootstrap) _no_bootstrap=1 ;;
    # --help 排在这里而不是另起一轮扫描：`--repo --help` 在 installer/cli.js 里是"值被 --repo 吃掉"
    # （parseArgs 的 case '--repo' 直接吞下一枚），这里跟着同一个形状走。跟着**吞**，不跟着**答**：
    # cli.js 对吞下去的那一枚还有一条判据——以 `-` 开头就不是目录，退 2 并打 usage
    # （"--repo 需要一个目录参数"）。这一层从前只把它当坏目录拒回 1，于是同一串 argv 在两条一键
    # 入口上是两个退出码、两句话；下面 2e 把这一支对齐到同一答案。
    --help|-h) _wants_help=1 ;;
  esac
done
# `--repo` 是最后一枚 ⇒ 它压根没接到取值。这一条从前在两条入口上是两个答案（实测 install.sh 回
# 0/继续 clone，cli.js 回 2），所以这里把它记成一个**旗标自己的**用法错，交给 2c' 那一节说话。
[ "$_want_repo_arg" = "1" ] && _repo_value_missing=1

# --- 2c'）--repo 自己的两类用法错：取值缺 / 取值是旗标形状 ------------------------
# **两入口对同一串 argv 的规则（2026-10-31 P1，同一份写在 installer/cli.js 入口的 if (isMain) 上面）**：
#   1. `--repo` 没接到取值，或接到的那一枚以 `-` 开头（**单横线与双横线都算**）：这是"这一层自己
#      就说不通"的用法错，**先于 --help**——两条入口都退 2、都说同一句"参数错误：--repo 需要一个
#      目录参数（……）"、随后各自打 usage。带 --help 也照样退 2：argv 在 --repo 那一枚上没写完。
#   2. "未知参数"不在这一层判：本层只有 --repo / --no-bootstrap / --help 三面旗，抄一份 installer
#      的旗标清单进来就是下一处"两份抄本没人对照"（本文件 usage 里写明这一点）。所以这一档由
#      installer 判，而 installer 在 --help 出现时先给帮助页：`--help --no-such-flag` 两条入口
#      都退 0，`--no-such-flag` 单给时两条都退 2（installer 判的）。
#   3. 单独的 --help / -h 仍旧退 0（CI 的 install-gate 与两份 README 钉的就是那个 0）。
# 从前这里的形状闸只否 `--*`，于是 `--repo -x` 被当成一个目录收下、走进 2e 的"不合判据"回 1，
# 而 cli.js 的 parseArgs 把 `-x` 当目录继续跑（同文件的 unsafeArgvValue 对 clone 目标却否 `-`
# 前缀——一处两套口径，实测三条 argv 三个码：--help --repo 0/2、--help --no-such-flag 0/2、
# --repo -x 1/继续跑）。现在两边都按 `-` 判。
# 位置排在 usage 闸**之前**，这不是随手放的：实测 `--repo --no-prompt --help` 时，把它放在 2d 之后
# 会让这一层回 0（帮助短路在前、旗标形状判定在后）而 cli.js 回 2——又造出一格新的两入口分叉，
# 正是这条修复要消灭的形状。它与 HOME 闸、两个覆盖位的形状闸同一族："这一趟根本没法谈"，
# 带不带 --help 都该听见。判据也排在 looks_like_repo **之前**："-x" 同样"不像一棵仓库"，
# 两条都跑就会先撞上那一句。
if [ "$_repo_value_missing" = "1" ]; then
  say "参数错误：--repo 需要一个目录参数（后面没有取值）"
  say "本轮没有 clone、没有写入任何东西。"
  usage
  exit 2
fi
case "$_explicit_repo" in
  -*)
    say "参数错误：--repo 需要一个目录参数（收到的是旗标：${_explicit_repo}）"
    say "本轮没有 clone、没有写入任何东西。"
    usage
    exit 2
    ;;
esac

# --- 2d) usage 闸（2026-10-29 S7-3：这一层从前压根不认 --help/-h）---------------
# 从前 --help 走的是"什么都不认识 → 原样透传"那一条：非 macOS 上脚本先被平台闸拒回 1，而
# `node installer/cli.js --help` 明明白白回 0（cli.js 把 options.help 从平台闸豁免，CI 的
# install-gate 那一格读的就是那一页 usage）——同一种问法在两条一键入口上两个退出码。
# macOS 上更贵：`--help` 一路走到源码定位，先付一次 depth-1 的网络 clone，然后才由 installer
# 把那一页打出来。
# 位置是这句承诺的一部分：HOME 闸与两个覆盖位的形状闸**在前**（它们拒的是"这一趟根本没法谈"，
# 带不带 --help 都该听见），clone 与委托在后。非 macOS 同样豁免——这一条打印的不是安装动作，
# 平台闸挡的从来不是它。
if [ "$_wants_help" = "1" ]; then
  usage
  exit 0
fi

# --- 2e) 透传前先把 --repo 自己问一遍（2026-10-29 S7-2）-------------------------
# `--repo <坏目录>` 从前只在上面的定位级联里"没命中"，然后脚本照常去 clone，最后
# `exec node "$REPO/installer/cli.js" "$@"` 把那一枚原样透传过去——而 cli.js 里 --repo 的优先级
# 最高（explicitRoot 在 GLASSPANE_REPO 与自动查找之前），于是刚 clone 完的那一棵被无视，npm install
# 真的以那个**已经被 looks_like_repo 拒过**的目录为 cwd 跑起来。
# 两种修法里选了"当场拒绝"：把旗标从透传参数里剔掉也能通，但那要让脚本学会重写 argv，而读者
# 看到的仍旧是"我给了 --repo，它没理我"。停下来说清"这一枚旗标为什么不行"才是做得动的那一步，
# 形状也与 --no-bootstrap 那一支同句（say + exit 1，dry-run 不豁免）。
# 排在定位级联**之前**也带着另一条理由：`$PWD` 恰好是一棵真仓库时，级联会命中 cwd 那一支而
# 让 REPO 非空——坏旗标就再也没被问过，照样原样透传。给了就要么合判据、要么当场拒，不给兜底的机会。
# 旗标形状的取值（`--repo --help`、`--repo -x`）与取值缺（`--repo` 收尾）已经在 2c' 里按用法错退回
# 2，跑到这里的都是真路径。
if [ -n "$_explicit_repo" ] && ! looks_like_repo "$_explicit_repo"; then
  refuse_located_root '--repo' "$_explicit_repo"
fi

# --- 2f）GLASSPANE_REPO 给了就要么合判据、要么当场拒（2026-10-31 P0，与 2e 同一族）---
# 从前这一层对它是另一种姿势：`looks_like_repo` 不中就**悄悄往下一个定位位走**（$PWD → 既有 clone
# → clone），一句话不说。而 cli.js 那一头把同一个环境变量当 rootDir（envRoot 在 explicitRoot 之后、
# 自动查找之前），2026-10-31 之前只测 `fs.existsSync`——于是 `GLASSPANE_REPO=<一个存在的非仓库目录>`
# 在两条一键入口上是两个答案：这一层换个目录继续装，那一头真的把 npm install 的 cwd 设成那个目录。
# 修法与 --repo 同一条：给了就要么合判据、要么在第一字节之前拒。那句"悄悄落到下一个定位位"
# 不是兜底，是把读者递过去的定位位当没看见——与 2e 当年拒绝 --repo 的理由一字不差。
# 排在这里（定位级联之前、usage 闸之后）：它不是"argv 写错了"那一类（那是 2 ），是"这一枚指的地方
# 不能用"那一类（与 2e 同为 1）。委托给 installer 的那一步会在最后 `export GLASSPANE_REPO="$REPO"`
# 覆盖成已验过的树，所以这两道闸对**委托的那一趟**是纯前置，不改变它的任何行为。
if [ -n "${GLASSPANE_REPO:-}" ] && ! looks_like_repo "$GLASSPANE_REPO"; then
  refuse_located_root 'GLASSPANE_REPO' "$GLASSPANE_REPO"
fi

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
    # 三个值都过 sh_quote（2026-10-31 P2）：这一行是给 CI 与操作者**照抄**用的，裸插值在
    # `GLASSPANE_INSTALL_DIR="/Users/John Smith/glasspane"` 这种落点上印出来是一条跑不通的命令
    # （落点被空格重排成两个参数），而真跑那一支用的是引号包住的 "$CLONE_DIR"。惰性字符组成的
    # 值仍原样印（表与 installer/cli.js 的 quoteShellArg 同一份），默认那一行的形状不变。
    say "[dry-run] 未定位到仓库，将执行: git clone --branch $(sh_quote "$REF") --depth 1 -- $(sh_quote "$REPO_URL") $(sh_quote "$CLONE_DIR")"
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
  # 委托行同样逐枚加引号（2026-10-31 P2）：从前这里是 `$REPO/…$*`——`$*` 把透传参数按空格
  # 重排成一句话，落点或参数里带空格时印出来的那一行照抄就跑不动，而真跑那一支是
  # `exec node "$REPO/installer/cli.js" "$@"`（argv 一枚一枚传）。现在印的就是那份 argv。
  _dry_run_argv=''
  for _dq_arg in "$@"; do
    _dry_run_argv="${_dry_run_argv} $(sh_quote "$_dq_arg")"
  done
  say "[dry-run] 将执行: node $(sh_quote "$REPO/installer/cli.js")${_dry_run_argv}"
  exit 0
fi
# 平台闸有两道，两道都在，各有各的职责。（这一段从前写的是"installer/cli.js 里没有任何平台判据
# （grep `process.platform` 命中 0）"——那句现在是被实测否证的：`grep -n process.platform installer/cli.js`
# 命中 3 行（文档、`export function platformRefusal(platform = process.platform)` 的定义、main 里的注释），
# 而 main 在 parseArgs 之后、install 之前真的调用 platformRefusal() 并据此置 exit 1。行号会漂，
# 所以这里只给复测命令，不给坐标。
# 真实的两闸形状是这一句：install.sh 在委托之前拒，cli.js 也拒，且 cli.js 那一拒才是桩不掉的那一道。
# 这一道的职责是"源码已经在手边时也要停，且一个字节都不写"——上面那一支只管"要 clone 的那一趟"，
# GLASSPANE_REPO 指的仓库、当前目录、既有 clone 这三条路都不经过它。那一道的职责是"把 PATH 换掉也
# 绕不过去"：`uname` 是 PATH 上一个可以被换掉的程序，`process.platform` 是 node 向主机问来的。
# 历史事实照旧记着（2026-10-22 实测）：那时本脚本还没有这一道，在一个 GlassPane checkout 里把
# `uname` 桩成 Linux 跑真装，会一路走到 `exec node cli.js`，随后 npm ci、tsc、swift build 与 launchd
# 注册全部真的发生，HOME 是开发者自己的。两道都不删：删这一道就回到"不写任何东西之前先跑了一半"，
# 删那一道就回到"桩一个 uname 就通了"。dry-run 已经在上面 exit 了，CI 的 install-gate 那一格
# 读到的计划行不受影响。
if [ "$(uname -s)" != "Darwin" ]; then
  fail "本安装器只支持 macOS（uname -s = $(uname -s)）：Swift/XCTest、launchd 与 TCC 席位都在 macOS 这一侧。源码已经在手边（${REPO}）这一趟不付 clone，但它同样不会 delegate 给 installer —— 没有 npm ci、没有 swift build、没有注册 launchd 作业。现在这一步没有可绕的旗标。"
fi
export GLASSPANE_REPO="$REPO"
exec node "$REPO/installer/cli.js" "$@"
