#!/usr/bin/env bash
# gpg-signing.sh — one place that knows how the iterate + GlassPane projects sign
# their release artifacts, so nobody has to ask again.
#
# >>> If you are an agent and someone asked you to sign, publish, or set up
# >>> releases for GlassPane, glasspane-harness, iterate-skill, iterate-harness
# >>> or iterate-plugin: run this script's `verify` first, and do not
# >>> re-derive the setup. Two things are deliberately non-automatable and
# >>> this file explains both, so you do not have to rediscover them.
#
# The problem this exists to solve
# ───────────────────────────────
# Five repos sign releases. Before this script each had its own workflow block,
# and three used `if: secrets.GPG_PRIVATE_KEY != ''` — a silent skip. A silent
# skip does not look like a failure: the release publishes, the assets ship
# unsigned, and the first person to notice is a user whose updater refuses the
# file. GlassPane's own v1.4.0 shipped exactly that way.
#
# Two things are genuinely not automatable, and this script says so rather than
# pretending:
#
#   1. The passphrase is not in the login keychain. `iterate_harness` holds four
#      model API keys; nothing there is a signing passphrase. What makes signing
#      work locally is gpg-agent's 86400s cache plus pinentry-mac.
#      `gpg --export-secret-keys` cannot use that cache — exporting needs an
#      unlock — so only a human at a terminal can export the key. Run `seed`
#      once, interactively; the key + passphrase then live in the keychain under
#      one service name and every later run is non-interactive.
#
#   2. GitHub secrets are write-only. Nothing can read back whether a secret is
#      correct, so `verify` proves the *plumbing* (key present, target env
#      exists, workflow reads the right secret) and then says plainly what is
#      still unproven. A green `verify` is not a promise that the next release
#      will sign.
#
# Usage
#   gpg-signing.sh seed                 # one-time: type the passphrase once
#   gpg-signing.sh verify-pass           # is the passphrase right? stores nothing
#   gpg-signing.sh install [repo...]    # push both secrets to the targets
#   gpg-signing.sh verify [repo...]     # report what is in place and what is not
#   gpg-signing.sh local [dir...]       # set commit/tag gpgsign in checkouts
#   gpg-signing.sh audit                 # find silent-skip signing in workflows
#   gpg-signing.sh secret-verdict <gh退出码> <要查的名字> <gh-stdout文件> <gh-stderr文件>
#                              # 把"一次 gh 读取的三种结局"分诊：present / absent / empty /
#                              # failed。verify 走的就是这一个函数；测试喂**假**的三样，不碰网络。
#   gpg-signing.sh selftest              # prove the guards trip when they should
set -euo pipefail

KEYCHAIN_SERVICE="${GP_SIGNING_SERVICE:-gpg-signing}"
KEY_GRIP_HINT="89D88B1D043A1298"   # jingzhao-l (sign-github) <ET_lin@outlook.com>

# 判据用的 ERE 存进**变量**，由 `[[ $x =~ $re ]]` 裸引用，而不是把模式写在 `=~` 右边加引号：
# macOS 的 /bin/bash 是 3.2.57，那里引号包住的片段被当成字面串、元字符失效，同一条判据在
# 3.2 与 4+ 上会得到两个答案（本机实测过这两种写法）。
SILENT_SKIP_RE='if: *\$\{\{ *secrets\.GPG_PRIVATE_KEY'
COMMENT_LINE_RE='^[[:space:]]*#'

# gh 那条读取**失败**时的退场码，与 1（判红/普通失败）、2（用法或未知 target）都分开：
# 「读不到」与「读到并且缺失」是两件事，压成同一个码就是压成同一句话（见 cmd_verify 的注）。
GH_FAIL_EXIT=3

# File-scope on purpose: `cmd_seed` arms an EXIT trap that removes it, and a
# function-local is already out of scope by the time that trap runs — the cleanup
# would then silently do nothing and every run would leave another file in TMPDIR.
gpg_err_file=""

# repo|local checkout|environment holding the secrets ("" = repo level).
# The third column is not cosmetic: a job declaring `environment: release`
# cannot read a repo-level secret, so a workflow that reads the wrong scope
# sees an empty string and — with a silent skip — ships unsigned.
#
# 本地那一列**不写死任何人的卷**。这个文件是随发布归档发出去的（归档就是 `git ls-files` 的
# 树），从前第五行躺着一台构建机的 `/Volumes/...`：装在别的机器上的 updater 下载到的那份归档里，
# 就带着发布者本人的目录布局。`scripts/make-release-archive.mjs` 对 `.iterate_decisions.md`
# 说的是同一条规矩（"a release archive should not be the delivery mechanism for whoever built
# it"），这里按同一条改：本 checkout 的位置由脚本自己的位置算出来（与
# tools/release-signing-gate.sh 的 REPO_ROOT 同一个算法），兄弟项目默认取它的父目录，
# 不在那个形状里的机器上用一个环境变量指对：GP_SIGNING_DEV_BASE=/path/to/siblings。
# 指错了也不会被当成事实——`verify` / `local` 读不到 git root 时本来就报
# "not in a git checkout: <dir>"，那是拒，不是安静地少配一个仓库。
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
GP_DEV_BASE="${GP_SIGNING_DEV_BASE:-$(dirname -- "$REPO_ROOT")}"
TARGETS=(
  "GlassPane|$REPO_ROOT|release"
  "glasspane-harness|$GP_DEV_BASE/.worktrees/gp-fork|release"
  "iterate-skill|$GP_DEV_BASE/iterate-skill|"
  "iterate-harness|$GP_DEV_BASE/iterate-skill/harness/iterate-harness|"
  "iterate-plugin|$GP_DEV_BASE/iterate-plugin|"
)

# 本 checkout 的那一行必须真的指着这份树：算错 REPO_ROOT 的话，`install`/`verify` 会去配
# 一个不存在的目录，而报出来的是一句 git 的话，没人怀疑到锚点上。selftest 有一条臂盯着它。
glasspane_checkout_dir() {  # = TARGETS 第一行的第二列（本脚本自己所在的那份 checkout）
  local row="${TARGETS[0]}" rest
  rest="${row#*|}"
  printf '%s\n' "${rest%|*}"
}

say()  { printf '%s\n' "$*" >&2; }
ok()   { printf '  ok    %s\n' "$*"; }
bad()  { printf '  MISS  %s\n' "$*"; }
warn() { printf '  warn  %s\n' "$*"; }

need() { command -v "$1" >/dev/null 2>&1 || { say "error: $1 not found in PATH"; exit 127; }; }

# 谓词，不是管道。这两条把本文件原先 11 处 `printf '%s' "$x" | grep -q …` 全部替掉：
# `set -euo pipefail` 之下，`grep -q` 首个命中就退场，printf 随后被 SIGPIPE 打死，整条管道
# 的状态就成了 141 —— 于是**同一个输入可以判绿也可以判红**，取决于谁先跑到。仓库里这个坑
# 被写下过三次（.github/workflows/ci.yml 的两处注释、scripts/make-release-archive.mjs 的
# verifyArchive 注释），本文件是第四处，也是最后一处。
# 模式里的 "$2" 加了引号＝字面匹配，与 grep -qF 同判据；多字节串（gpg 的中文原话）按字节比，
# 不依赖 bash 3.2 的正解释器。
has_text() {  # $1 = 文本，$2 = 要**含**的字面片段
  case $1 in *"$2"*) return 0 ;; *) return 1 ;; esac
}

has_line() {  # $1 = 以换行分隔的文本，$2 = 必须**整行相等**的一项（grep -qx 的同义）
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    [ "$line" = "$2" ] && return 0
  done <<< "$1"
  return 1
}

targets_filtered() {
  if [ $# -eq 0 ]; then printf '%s\n' "${TARGETS[@]}"; return; fi
  local want t found
  for want in "$@"; do
    found=""
    for t in "${TARGETS[@]}"; do
      [ "${t%%|*}" = "$want" ] && found="$t"
    done
    [ -n "$found" ] || { say "error: unknown target '$want'"; exit 2; }
    printf '%s\n' "$found"
  done
}

secret_scope() {  # $1 = env column
  [ -n "$1" ] && printf -- '--env\n%s\n' "$1" || true
}


# ── seed ─────────────────────────────────────────────────────────────────────
# The one interactive step. Exports the secret key (which needs an unlock the
# agent cache cannot provide) and stores it with the passphrase in the keychain.
cmd_seed() {
  need gpg; need security
  say "This asks for your signing-key passphrase ONCE. It cannot be recovered"
  say "from gpg-agent's cache — only you can supply it."
  printf 'passphrase (input hidden): '
  local pass
  stty -echo 2>/dev/null || true
  IFS= read -r pass
  stty echo 2>/dev/null || true
  printf '\n'
  [ -n "$pass" ] || { say "error: empty passphrase"; exit 2; }

  say "exporting the secret key…"
  # gpg distinguishes the failure modes in its own words; a previous version of
  # this script collapsed them all into "passphrase probably wrong", which is
  # how a correct passphrase ended up being reported as wrong. Capture stderr
  # and read what gpg actually said:
  #   损坏的密码 / bad passphrase  -> the passphrase is wrong
  #   缺少 pinentry               -> gpg never got one (a GUI prompt may have
  #                                  appeared and been dismissed) — NOT "wrong"
  local armored gpg_err
  # 口令走 `--passphrase-fd 0`（stdin），绝不走把口令写进 argv 的那种形式：argv 在同一台机器上
  # 是**任何本地账号**都能读的东西（`ps -eww -o args`）。这不是推测——release.yml 的签名步骤
  # 就是为这件事改的（那里实测"签名进行中 12 次采样全部读到"），loopback pinentry 本来就是
  # 为"从文件描述符喂进来"设计的。本地工具与 CI 必须同一口径，否则 CI 侧修好、本机侧继续漏。
  #
  # 错误文件用 mktemp **模板**（不带 -t）：`mktemp -t NAME` 在 BSD(macOS) 上是把 NAME 当前缀，
  # 而 GNU coreutils 把 -t 当已废弃、把参数当模板并要求尾部至少两个 X——同一行在两个平台上
  # 一边过一边报错。从前的写法是写死的 /tmp/.gpg-seed-err：路径人人可预测、先到先得，而里面
  # 装的正是 gpg 的原话。
  gpg_err_file="$(mktemp "${TMPDIR:-/var/tmp}/gpg-seed-err.XXXXXX")"
  # The guard is load-bearing, not stylistic: `gpg_err_file` is `local` to this
  # function, so when the EXIT trap fires it is out of scope again, and under
  # `set -u` a bare `rm -f "$gpg_err_file"` died with "gpg_err_file: unbound
  # variable" *after* a perfectly successful seed — the tool reported failure on
  # the path that worked. `rm -f ""` is no good either (BSD rm errors on an empty
  # operand), so the name is tested before it is used.
  trap 'if [ -n "${gpg_err_file:-}" ]; then rm -f "$gpg_err_file"; fi' EXIT
  armored="$(printf '%s\n' "$pass" | gpg --batch --yes --pinentry-mode loopback \
                   --passphrase-fd 0 --armor --export-secret-keys "$KEY_GRIP_HINT" \
                   2>"$gpg_err_file" || true)"
  gpg_err="$(cat "$gpg_err_file" 2>/dev/null || true)"
  # 判据全部走 `case`／`[[ =~ $re ]]`，不再 `printf … | grep -q`：本文件顶部是
  # `set -euo pipefail`，而 `grep -q` 命中第一条就退出，还在写的 printf 随后死于 SIGPIPE，
  # 于是这条管道的状态在 0 与 141 之间取决于**时序**而不是内容（本仓在 ci.yml 与
  # scripts/make-release-archive.mjs 的注释里写过三次同一个坑）。判决的文字一字不改。
  if [ -n "$armored" ] && has_text "$armored" 'BEGIN PGP PRIVATE KEY BLOCK'; then
    ok "key unlocked and exported"
  elif has_text "$gpg_err" '损坏的密码' || has_text "$gpg_err" 'bad passphrase'; then
    say "error: gpg rejected the passphrase (损坏的密码). It really is wrong."
    exit 1
  elif [ -z "$gpg_err" ]; then
    say "error: gpg produced neither a key nor a message. That is not a verdict"
    say "       on the passphrase. Try again, or run: $0 verify-pass"
    exit 1
  else
    say "error: the export failed for a reason other than a wrong passphrase."
    say "       gpg said:"; printf '%s\n' "$gpg_err" | sed 's/^/         /' >&2
    say "       Run '$0 verify-pass' to see this same message with your input"
    say "       echoed back, which is the only way to tell a wrong passphrase"
    say "       from a swallowed GUI prompt."
    exit 1
  fi
  # Store base64, not the armored text itself. `security -w` hex-encodes a
  # multi-line argument on this machine: the entry looks fine in the keychain UI
  # and `find-generic-password` hands back a hex blob, which `gpg --import`
  # rejects as "no valid OpenPGP data found" with no hint about the cause. That
  # is not hypothetical — it is how v0.6.1's first run failed. A single-line
  # value round-trips correctly (verified), so base64 is the transport.
  #
  # The base64 value then goes to `security`'s prompt on STDIN, never into argv.
  # `-w` with no argument makes the tool read two lines (value, then retype) from
  # its input, and it reads stdin when there is no tty. `-w "$value"` is the
  # insecure shape its own usage text warns about: argv is readable by any local
  # account (`ps -eww -o args`) for the whole lifetime of the command, which would
  # put the armored private key and the passphrase there. Same rule as the
  # `--passphrase-fd 0` note above, and the same rule `selftest` audits both
  # copies of this file against. The prompt can exit 0 on a mismatched pair, so
  # the honest verdict stays the read-back below.
  kc_put() { local b; b="$(printf '%s' "$2" | base64 | tr -d '\n')"
             printf '%s\n%s\n' "$b" "$b" \
               | security add-generic-password -U -s "$KEYCHAIN_SERVICE" -a "$1" -w >/dev/null; }
  kc_get() { security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$1" -w 2>/dev/null \
               | base64 -d 2>/dev/null || true; }

  kc_put private-key "$armored"
  kc_put passphrase  "$pass"
  # Read back and compare: the only honest check is the bytes that come out.
  local stored
  stored="$(kc_get private-key)"
  if ! has_text "$stored" 'BEGIN PGP PRIVATE KEY BLOCK'; then
    say "error: the keychain entry does not read back as an armored private key."
    say "       Nothing was installed. This machine's \`security\` may not"
    say "       round-trip even a base64 value; report it rather than pushing a"
    say "       secret that cannot be imported."
    exit 1
  fi
  unset pass armored
  ok "private key + passphrase stored (base64) under '$KEYCHAIN_SERVICE'"
  say "verified by read-back: the stored value really is an armored key"
  say "next: $0 install"
}

# ── verify-pass ──────────────────────────────────────────────────────────────
# Answers exactly one question: is the passphrase right? It does not touch the
# keychain and it does not store anything, so it is safe to run repeatedly while
# you try variants. The verdict comes from gpg's own wording, never from guessing.
cmd_verify_pass() {
  need gpg
  printf '口令（不回显，直接粘贴）: '
  local pass
  stty -echo 2>/dev/null || true
  IFS= read -r pass
  stty echo 2>/dev/null || true
  printf '\n'
  # --export-secret-keys is the operation that actually requires an unlock, so
  # it is the honest probe; listing keys would "succeed" without ever asking.
  # 口令同 cmd_seed：`--passphrase-fd 0` 从 stdin 喂，不进 argv（这条命令的 argv 在
  # 任何本地账号的 `ps -eww -o args` 里都读得到，而这里恰恰是用户反复试口令的地方）。
  local err
  err="$(printf '%s\n' "$pass" | gpg --batch --yes --pinentry-mode loopback \
              --passphrase-fd 0 --armor --export-secret-keys "$KEY_GRIP_HINT" 2>&1 >/dev/null || true)"
  unset pass
  if [ -z "$err" ]; then
    ok "口令正确（gpg 没有报错，导出成功）"
    say "现在可以跑: $0 seed"
  elif has_text "$err" '损坏的密码' || has_text "$err" 'bad passphrase'; then
    bad "口令不对 —— gpg 原话：损坏的密码"
  elif has_text "$err" 'pinentry'; then
    bad "gpg 没拿到口令就放弃了（缺少 pinentry）"
    say "这不等于「口令不对」：通常是有一个 GUI 授权框弹出来后被关掉了，"
    say "或者这次运行没有可用的 pinentry。先在本机手动签一次让 agent 缓存："
    say "  gpg --sign  # 弹窗输入一次，之后 24 小时内 agent 会记住"
  else
    bad "没能判定，gpg 原话如下："
    printf '%s\n' "$err" | sed 's/^/         /' >&2
  fi
}

# ── install ──────────────────────────────────────────────────────────────────
cmd_install() {
  need gh; need security
  local key pass
  # base64 channel; see the note in cmd_seed for why the raw value is not used.
  key="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a private-key -w 2>/dev/null | base64 -d 2>/dev/null || true)"
  pass="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a passphrase  -w 2>/dev/null | base64 -d 2>/dev/null || true)"
  if [ -z "$key" ] || [ -z "$pass" ]; then
    say "error: no keychain entry for '$KEYCHAIN_SERVICE' (private-key / passphrase)."
    say "run: $0 seed"
    exit 1
  fi
  # Refuse to push a value that is not a key. Installing a mangled secret is
  # worse than installing none: `gpg --import` fails at the far end of CI, in a
  # job that has already spent minutes building, and the log blames the key.
  if ! has_text "$key" 'BEGIN PGP PRIVATE KEY BLOCK'; then
    say "error: the stored private key is not an armored PGP key (a hex blob was"
    say "       seen in this exact spot). Refusing to install it. Re-run: $0 seed"
    exit 1
  fi
  local repo dir env
  while IFS='|' read -r repo dir env; do
    printf '%s\n' "$repo"
    if [ -n "$env" ]; then
      printf '%s' "$key"  | gh secret set GPG_PRIVATE_KEY  --env "$env" --repo "jingzhao-l/$repo" >/dev/null
      printf '%s' "$pass" | gh secret set GPG_PASSPHRASE --env "$env" --repo "jingzhao-l/$repo" >/dev/null
    else
      printf '%s' "$key"  | gh secret set GPG_PRIVATE_KEY  --repo "jingzhao-l/$repo" >/dev/null
      printf '%s' "$pass" | gh secret set GPG_PASSPHRASE --repo "jingzhao-l/$repo" >/dev/null
    fi
    ok "GPG_PRIVATE_KEY + GPG_PASSPHRASE set${env:+ (environment '$env')}"
  done < <(targets_filtered "$@")
  unset key pass
}

# ── verify ───────────────────────────────────────────────────────────────────
# GitHub will not say whether a secret's value is right, so this reports
# presence and shape, and states the limit instead of implying more.
#
# 一次「列 secret」的读取有**三种**结局，从前这里只分得出两种：两条 gh 都写成
# `… 2>/dev/null || true`，于是「gh 自己没跑起来」与「这个 scope 里真的没有它」被压成同一个
# 空字符串，再由下面那句 `bad "$want missing"` 一并宣布。没登录、token scope 不够、仓库改名、
# environment 没建、网络断 —— 全都读成「secret 不存在」，运维就照着这句话去重建一份**本来就
# 配对了的** secret，永远修不好。误归因本身就是缺陷（同一类的 named-causes 修法见
# updater/lib/apply.js 的 classifyFailure）。
#
# 现在四态分明：present / absent / empty（读成功了，列表里没它）/ failed（这次读取本身没
# 成功 —— 不是判据，把 gh 的原话交回读者，并以 GH_FAIL_EXIT=3 退场）。
read_scope_secrets() {  # $1=repo $2=environment（空＝仓库级）-> 置 GH_RC / GH_OUT / GH_ERR
  local rc=0 errf
  errf="$(mktemp "${TMPDIR:-/var/tmp}/gpg-verify-gh-err.XXXXXX")"
  if [ -n "$2" ]; then
    GH_OUT="$(gh api "repos/jingzhao-l/$1/environments/$2/secrets" --jq '.secrets[].name' 2>"$errf")" || rc="$?"
  else
    GH_OUT="$(gh api "repos/jingzhao-l/$1/actions/secrets" --jq '.secrets[].name' 2>"$errf")" || rc="$?"
  fi
  GH_ERR="$(cat "$errf" 2>/dev/null || true)"
  rm -f "$errf"
  GH_RC="$rc"
}

classify_secret_list() {  # $1=gh 退出码 $2=gh 的 stdout $3=要查的名字 -> 置 GH_VERDICT
  if [ "$1" -ne 0 ]; then GH_VERDICT="failed"; return 0; fi
  if [ -z "$2" ]; then GH_VERDICT="empty"; return 0; fi
  if has_line "$2" "$3"; then GH_VERDICT="present"; else GH_VERDICT="absent"; fi
}

# 两个可能分开说，这是本函数唯一的存在理由：**failed 永远不许说 missing**。
emit_secret_verdict() {  # $1=repo $2=env $3=want $4=verdict $5=gh 退出码 $6=gh 的 stderr
  case "$4" in
    present) ok "$3" ;;
    absent)
      bad "$3 missing${2:+ (environment '$2')} —— gh 以退出码 $5 读到了一份列表，里面没有它" ;;
    empty)
      bad "$3 missing${2:+ (environment '$2')} —— gh 以退出码 $5 成功读到**空**列表：这一层一个 secret 都没配" ;;
    failed)
      bad "$3 —— 无法判定。这**不是**「secret 不存在」：gh 这条命令自己以退出码 $5 失败了。"
      [ -n "$6" ] && printf '        gh 的原话：%s\n' "$6"
      say "       两种可能分开查：① gh 不能用（没登录 / token scope 不够 / 网络不通），"
      if [ -n "$2" ]; then
        say "       ② 要读的目标不存在（仓库改名，或 $1 没有 environment '$2'）。"
      else
        say "       ② 要读的目标不存在（$1 这个仓库名改了、没了，或当前账号读不到它）。"
      fi
      say "       两者都不等于 secret 缺失 —— 别照这一句重建一份本来就配对了的 secret。"
      say "       remedy（本机可跑，两条都是读、不是猜）：gh auth status；"
      say "       scope 不够就 gh auth refresh -s repo；确认环境层存在：gh api repos/jingzhao-l/$1/environments"
      ;;
    *) say "error: 内部错误：未知判决 '$4'"; exit 2 ;;
  esac
}

cmd_verify() {
  need gh; need gpg
  printf '\n== local key ==\n'
  if gpg --list-secret-keys "$KEY_GRIP_HINT" >/dev/null 2>&1; then
    ok "secret key present ($KEY_GRIP_HINT)"
  else
    bad "no secret key $KEY_GRIP_HINT in the local keyring"
  fi
  if security find-generic-password -s "$KEYCHAIN_SERVICE" -a private-key -w >/dev/null 2>&1; then
    ok "keychain entry '$KEYCHAIN_SERVICE' present"
  else
    warn "no keychain entry — run '$0 seed' before 'install'"
  fi

  printf '\n== per-repo ==\n'
  local repo dir env names read_rc gh_err declared_failed gh_failed_times=0
  while IFS='|' read -r repo dir env; do
    printf '%s\n' "$repo"
    names=""; gh_err=""; read_rc=0; declared_failed=""
    if [ -n "$env" ]; then
      read_scope_secrets "$repo" "$env"
      if [ "$GH_RC" -ne 0 ]; then
        declared_failed="environment '$env' 那一层读不到（gh 退出 $GH_RC）"
        read_rc="$GH_RC"; gh_err="$GH_ERR"
        gh_failed_times=$((gh_failed_times + 1))
        emit_secret_verdict "$repo" "$env" "$env 这一层的读取" failed "$GH_RC" "$GH_ERR"
      else
        names="$GH_OUT"
      fi
    fi
    if [ -z "$names" ]; then
      read_scope_secrets "$repo" ""
      if [ "$GH_RC" -ne 0 ]; then
        read_rc="$GH_RC"; gh_err="$GH_ERR"
        gh_failed_times=$((gh_failed_times + 1))
        [ -n "$declared_failed" ] || declared_failed="repo 级那一层读不到（gh 退出 $GH_RC）"
        emit_secret_verdict "$repo" "" "repo 级这一层的读取" failed "$GH_RC" "$GH_ERR"
      else
        names="$GH_OUT"; read_rc=0; gh_err=""
        if [ -n "$names" ] && [ -n "$env" ]; then
          warn "  secrets exist at repo level, but the workflow declares environment '$env'"
        fi
      fi
    fi
    for want in GPG_PRIVATE_KEY GPG_PASSPHRASE; do
      if [ -n "$declared_failed" ]; then
        # 工作流真正读的那一层没读回来 ⇒ 既不许说 missing，也不许说 ok。上面已经打过 gh 的
        # 原话和那两种可能，这里只把"这一格没被判过"钉在输出里，读者不用自己推断。
        warn "$want —— 判定跳过：$declared_failed。这一格既没判成存在也没判成缺失。"
        continue
      fi
      classify_secret_list "$read_rc" "$names" "$want"
      emit_secret_verdict "$repo" "$env" "$want" "$GH_VERDICT" "$read_rc" "$gh_err"
    done
    # A subproject inside a monorepo (iterate-harness lives in iterate-skill)
    # is not a checkout of its own; the config belongs to the enclosing repo.
    local root
    root="$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null || true)"
    if [ -n "$root" ]; then ok "git root $root"; else warn "not in a git checkout: $dir"; fi
  done < <(targets_filtered "$@")
  cat <<'NOTE'

  Unprovable from here: whether each secret's *value* is correct (GitHub secrets
  are write-only) and whether the passphrase matches the key. A clean run means
  the plumbing is right, not that the next release will sign.
NOTE
  if [ "$gh_failed_times" -ne 0 ]; then
    say "error: 上面有 $gh_failed_times 次 gh 读取失败 —— 那些 scope 的「存在 / 缺失」根本没有被判定过。"
    say "       退出码 $GH_FAIL_EXIT 就是为这一种情形留的：读不到不等于没有，也绝不等于绿。"
    say "       remedy: gh auth status（先让 gh 能用），必要时 gh auth refresh -s repo；再重跑 $0 verify。"
    exit "$GH_FAIL_EXIT"
  fi
}

# 给测试驱动的入口：把上面那套分诊暴露成一条**不碰网络**的命令（与 tools/release-signing-gate.sh
# 的 anchor_reader 同一形状：判据是函数，测试喂假输出，绿的绿在判据而不是绿在运气）。
cmd_secret_verdict() {
  [ $# -eq 6 ] || { say "error: secret-verdict 要六个参数：<gh退出码> <要查的名字> <stdout文件> <stderr文件> <repo> <environment（仓库级就传空串）>"; exit 2; }
  local rc="$1" want="$2" out="" gherr=""
  # 文件不存在**不算**"读到空"——那正是本轮修的误归因形状，所以这里按用法错误拒掉。
  if [ ! -f "$3" ] || [ ! -f "$4" ]; then
    say "error: secret-verdict 的 stdout/stderr 文件不存在（空结果必须来自一份真读回来的文件，缺文件不是「列表为空」）"
    exit 2
  fi
  case "$rc" in
    ''|*[!0-9]*) say "error: secret-verdict 的第一参数要是 gh 的退出码（整数），实为 '$rc'"; exit 2 ;;
  esac
  [ -n "$want" ] || { say "error: secret-verdict 要一个要查的 secret 名字"; exit 2; }
  out="$(cat "$3")"; gherr="$(cat "$4")"
  classify_secret_list "$rc" "$out" "$want"
  emit_secret_verdict "$5" "$6" "$want" "$GH_VERDICT" "$rc" "$gherr"
  [ "$GH_VERDICT" != "failed" ] || exit "$GH_FAIL_EXIT"
}

# ── local ────────────────────────────────────────────────────────────────────
cmd_local() {
  local gpg_bin=""
  if command -v gpg >/dev/null 2>&1; then
    gpg_bin="$(command -v gpg)"
  else
    for c in /opt/homebrew/bin/gpg /usr/local/bin/gpg /usr/bin/gpg; do
      [ -x "$c" ] && { gpg_bin="$c"; break; }
    done
    warn "gpg not on PATH; looked in the usual Homebrew locations"
  fi
  local -a dirs=()
  if [ $# -eq 0 ]; then
    local repo dir env
    while IFS='|' read -r repo dir env; do dirs+=("$dir"); done < <(targets_filtered)
  else
    dirs=("$@")
  fi
  local d
  for d in "${dirs[@]}"; do
    # `.git` is a directory in a normal clone and a *file* in a linked worktree,
    # so -d alone silently skips exactly the checkouts that need this most.
    # Resolve the enclosing repo: for a monorepo subproject this is the root,
    # and that is where git config has to be written. `.git` is a directory in
    # a clone and a file in a linked worktree, so never test it with -d alone.
    local root label
    root="$(git -C "$d" rev-parse --show-toplevel 2>/dev/null || true)"
    if [ -z "$root" ]; then warn "$d is not in a git checkout"; continue; fi
    label="$(basename "$d")"
    [ "$root" != "$d" ] && label="$(basename "$root") (for $label)"
    git -C "$root" config commit.gpgsign true
    git -C "$root" config tag.gpgsign true
    git -C "$root" config gpg.format openpgp
    git -C "$root" config user.signingkey "$KEY_GRIP_HINT"
    # gpg.program must be absolute. Homebrew's gpg is not on the default PATH,
    # and `git commit` then fails with the unhelpful "cannot run gpg: No such
    # file or directory" — which reads like a missing key, not a missing PATH.
    if [ -n "$gpg_bin" ]; then
      git -C "$root" config gpg.program "$gpg_bin"
    fi
    ok "$label: commit.gpgsign/tag.gpgsign=true signingkey=$KEY_GRIP_HINT${gpg_bin:+ gpg.program=$gpg_bin}"
  done
}

# ── audit ────────────────────────────────────────────────────────────────────
# The failure that started this: `if: secrets.GPG_PRIVATE_KEY != ''` turns an
# unsigned release into a release that looks successful.
#
# 这一支从前把 `gh api … 2>/dev/null | base64 -d … || true` 的空结果一律当"这份工作流没有
# 静默跳过"：gh 没登录 / token scope 不够 / 网络断了的时候，audit 照样打一句 `no silent-skip
# signing found` —— 那是**绿着的空集**，正是本仓最恨的那类谎（v1.4.0 的签名步被跳过硬发是
# 同一件事的另一面）。现在按"缺席"与"读不到"分三种判：HTTP 404 是被证明的缺席（GitHub 对
# 不存在的路径与未授权的账号都回 404，所以 404 是比"没输出"强得多的证据）；401/403 单独点名
# "没登录/scope 不够"；其余的非零退出只说"没读到"，并让 audit 以 $GH_FAIL_EXIT 退场。
read_workflow_body() {  # $1=repo $2=workflow 文件名 -> 置 GH_RC / GH_ERR / BODY_TEXT
  local rc=0 errf raw=""
  BODY_TEXT=""
  errf="$(mktemp "${TMPDIR:-/var/tmp}/gpg-audit-gh-err.XXXXXX")"
  raw="$(gh api "repos/jingzhao-l/$1/contents/.github/workflows/$2" --jq '.content' 2>"$errf")" || rc="$?"
  GH_ERR="$(tr '\n' ' ' <"$errf" 2>/dev/null || true)"
  rm -f "$errf"
  GH_RC="$rc"
  if [ "$rc" -eq 0 ] && [ -n "$raw" ]; then
    # 解不开就是**没读到**，不许等价于"这份工作流不存在/没有静默跳过"——从前那句
    # `… | base64 -d 2>/dev/null || true` 把这个形状也压成了空串。
    if ! BODY_TEXT="$(printf '%s' "$raw" | base64 -d 2>/dev/null)"; then
      GH_RC=90
      GH_ERR="${GH_ERR}gh 回的内容 base64 解不开（读到了字节却判成没有工作流，正是误归因的形状）"
    fi
  fi
}

# 同一条 classify，测试用 secret-verdict 的第三种模式喂它（见 cmd_secret_verdict）。
classify_workflow_read() {  # $1=gh 退出码 $2=gh 的 stderr -> 置 GH_VERDICT
  if [ "$1" -eq 0 ]; then GH_VERDICT="read"; return 0; fi
  # HTTP 状态在括号里，所以剥掉括号再按**词**比：`case` 里裸的 404 也会命中
  # "4044"、"40430" 这种形状，那是把别的错误报成"证明不存在"，正是本轮要消灭的误归因。
  # 全程 bash 自己的字符串展开，不留管道给 pipefail 做手脚（本文件的规矩见 has_text 的注）。
  local flat=" $2 "
  flat="${flat//[(]/ }"
  flat="${flat//)/ }"
  flat="${flat//[[]/ }"
  flat="${flat//]/ }"
  case "$flat" in
    *" 404 "*) GH_VERDICT="absent" ;;
    *" 401 "*|*" 403 "*) GH_VERDICT="unauthorized" ;;
    *) GH_VERDICT="failed" ;;
  esac
}

# 剥掉行首只有空白再跟 `#` 的那些行 —— audit 的判据只看活代码，selftest 测的必须是**同一个**
# 实现，否则测的是一条抄写的副本（从前就是两处各写一遍）。纯 bash，不留管道。
live_text() {  # $1 = 多行文本 -> 置 LIVE_TEXT
  local line out=""
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ $line =~ $COMMENT_LINE_RE ]]; then continue; fi
    out="$out$line"$'\n'
  done <<< "$1"
  LIVE_TEXT="${out%$'\n'}"
}

cmd_audit() {
  need gh
  printf '\n== silent-skip signing in release workflows ==\n'
  local repo dir env any=0 wf unreadable=0
  while IFS='|' read -r repo dir env; do
    for wf in release.yml publish.yml; do
      read_workflow_body "$repo" "$wf"
      classify_workflow_read "$GH_RC" "$GH_ERR"
      case "$GH_VERDICT" in
        absent)
          printf '  %s/%s：GitHub 回 404 —— 这份工作流**确实不存在**（这是证据，不是猜测）\n' "$repo" "$wf"
          continue ;;
        unauthorized)
          unreadable=$((unreadable + 1))
          printf '  %s/%s：读不到（gh 退出 %s，未授权）。这一格**没有**被检查过，"没发现静默跳过"这句话不包括它。\n' \
            "$repo" "$wf" "$GH_RC"
          printf '        gh 的原话：%s\n' "$GH_ERR"
          say '       remedy: gh auth status；scope 不够就 gh auth refresh -s repo；然后重跑 audit。'
          continue ;;
        read) : ;;
        *)
          unreadable=$((unreadable + 1))
          printf '  %s/%s：读不到（gh 退出 %s）。这一格**没有**被检查过，"没发现静默跳过"不包括它。\n' \
            "$repo" "$wf" "$GH_RC"
          printf '        gh 的原话：%s\n' "$GH_ERR"
          say '       remedy: 先让 gh 能用（gh auth status），再重跑 audit；读不到就说读不到，不判绿。'
          continue ;;
      esac
      [ -n "$BODY_TEXT" ] || continue
      # Strip comment lines first. A workflow that documents *why* it removed
      # the silent-skip still contains the string, and reporting that as a live
      # skip trains people to ignore this command — the same mistake a linter
      # makes when it greps its own explanation.
      local live
      live_text "$BODY_TEXT"
      live="$LIVE_TEXT"
      if [[ $live =~ $SILENT_SKIP_RE ]]; then
        printf '  %s/%s\n' "$repo" "$wf"
        printf '%s\n' "$live" | grep -nE "$SILENT_SKIP_RE" | sed 's/^/      /'
        any=1
      fi
    done
  done < <(targets_filtered)
  if [ "$any" -eq 0 ]; then
    if [ "$unreadable" -eq 0 ]; then
      ok "no silent-skip signing found"
    else
      bad "在 $unreadable 份工作流读不到的前提下，这句「没发现」是空的 —— 它们没有被检查过"
    fi
  fi
  cat <<'NOTE'

  Each line above means: when the secret is missing, the whole signing step
  vanishes and the release still publishes. GlassPane's release.yml is the
  reference shape — it fails with a remedy instead. That difference is why its
  commits verify and the others' do not.
NOTE
  if [ "$unreadable" -gt 0 ]; then
    say "error: audit 有 $unreadable 份工作流没能读到，退出码 $GH_FAIL_EXIT（读不到不等于没有，也不等于绿）。"
    exit "$GH_FAIL_EXIT"
  fi
}

# ── selftest ─────────────────────────────────────────────────────────────────
# A checker nobody has watched fail is a checker nobody can trust. These assert
# the guards actually trip.
cmd_selftest() {
  local fails=0 repo dir env
  printf '\n== selftest ==\n'
  while IFS='|' read -r repo dir env; do
    if [ -z "$repo" ] || [ -z "$dir" ]; then bad "malformed target row: '$repo|$dir|$env'"; fails=1; fi
  done < <(targets_filtered)
  [ "$fails" -eq 0 ] && ok "every target row parses as repo|dir|env"

  # the env column must be either empty (repo-level) or a bare name — a value
  # with a stray space would silently build a bogus --env argument
  while IFS='|' read -r repo dir env; do
    case "$env" in
      ""|release) ;;
      *) bad "$repo: unexpected environment '$env'"; fails=1 ;;
    esac
  done < <(targets_filtered)
  [ "$fails" -eq 0 ] && ok "environment column is repo-level or 'release'"

  # npm's `--dry-run` is not dry. On this npm version `npm publish --dry-run`
  # still PUTs the version, and the registry holds it as *staged* — so the
  # version can never be published afterwards ("Cannot publish over previously
  # staged version"), and `npm stage list` does not show it either. Never probe
  # a real version number with --dry-run; the project's own publish script has a
  # `--dry-run` that only packs, which is the safe way to check a tarball.
  if npm publish --help >/dev/null 2>&1; then
    ok "npm present; pack-only checks must use the publish script, not npm publish --dry-run"
  fi

  # An unknown repo must produce no target row, not a silent empty install.
  # Note: this cannot be written as `if ! targets_filtered ...` — that runs in a
  # subshell where the function's `exit 2` never reaches us, so the test would
  # pass for the wrong reason. Assert on the output instead.
  # `set -e` is on, and a command substitution that fails inside an assignment
  # aborts the script even with `|| true` appended to the substitution — so each
  # call is wrapped in its own subshell whose failure is the test's subject.
  local rows
  rows="$( ( targets_filtered definitely-not-a-repo 2>/dev/null ) || true )"
  if [ -z "$rows" ]; then ok "unknown target yields no target row"
  else bad "unknown target produced a row: $rows"; fails=1; fi
  rows="$( ( targets_filtered GlassPane 2>/dev/null ) || true )"
  case "$rows" in GlassPane\|*) ok "a known target resolves to its row" ;;
                *) bad "known target did not resolve (got '$rows')"; fails=1 ;; esac

  # 本文件的第一条交付行必须指着**这份** checkout：REPO_ROOT 是从脚本自己的位置算出来的
  # （与 tools/release-signing-gate.sh:67 同一个算法），谁把它抄回一台构建机的卷，这条就红。
  if [ "$(glasspane_checkout_dir)" = "$REPO_ROOT" ]; then
    ok "the GlassPane target resolves to this checkout's own root ($REPO_ROOT)"
  else
    bad "TARGETS 第一行的目录不等于 REPO_ROOT：实为 '$(glasspane_checkout_dir)' vs '$REPO_ROOT'"; fails=1
  fi

  # The audit pattern must match a real silent-skip and NOT match the fixed
  # form. Built with printf rather than hand-escaped quoting: the YAML
  # expression is full of quotes and braces, and escaping it by hand is
  # itself a bug source (it broke this file once already).
  #
  # 这三条从前是**抄写**的判据（在 selftest 里手打一遍 grep 的模式），所以 audit 的本体换成
  # 别的判据时它们照样绿。现在跑真的那一条：PATH 前置一枚只回罐头内容的 `gh` 桩（不碰网络），
  # 走 read_workflow_body → classify_workflow_read → live_text → $SILENT_SKIP_RE 这条**生产**
  # 路径，判据与 audit 同一个实现。
  local skip fixed commented stub_dir old_path body
  skip=$(printf '        if: ${{ secrets.GPG_PRIVATE_KEY != %s }}' "''")
  fixed='          if [ -z "${GPG_INPUT_KEY:-}" ]; then'
  commented=$(printf '      # the old\n      # if: ${{ secrets.GPG_PRIVATE_KEY != %s }}\n' "''")

  stub_dir="$(mktemp -d "${TMPDIR:-/var/tmp}/gpg-selftest-gh.XXXXXX")"
  cat > "$stub_dir/gh" <<'STUB'
#!/bin/sh
# tools/gpg-signing.sh selftest 的 gh 桩：只回答"这条 api 调用回什么"，三个变量都在调用方手里。
printf '%s' "${GP_STUB_OUT:-}"
if [ -n "${GP_STUB_ERR:-}" ]; then printf '%s\n' "$GP_STUB_ERR" >&2; fi
exit "${GP_STUB_RC:-0}"
STUB
  chmod 755 "$stub_dir/gh"
  old_path="$PATH"
  PATH="$stub_dir:$PATH"; export PATH
  # 桩**不实现** gh 的语义：端点是什么它都回同一份内容，所以这里只能测"读回来的三样东西如何
  # 被分诊"，测不到 GitHub 真的怎么答。那是这条臂本来的边界，说破它。
  GP_STUB_RC=0; export GP_STUB_RC
  GP_STUB_ERR=""; export GP_STUB_ERR

  GP_STUB_OUT="$(printf '%s' "$skip" | base64 | tr -d '\n')"; export GP_STUB_OUT
  read_workflow_body GlassPane release.yml
  classify_workflow_read "$GH_RC" "$GH_ERR"
  live_text "$BODY_TEXT"
  if [ "$GH_VERDICT" = read ] && [[ $LIVE_TEXT =~ $SILENT_SKIP_RE ]]; then
    ok "audit matches the silent-skip form"
  else
    bad "audit fails to match the silent-skip form (verdict=$GH_VERDICT)"; fails=1
  fi

  GP_STUB_OUT="$(printf '%s' "$fixed" | base64 | tr -d '\n')"; export GP_STUB_OUT
  read_workflow_body GlassPane release.yml
  classify_workflow_read "$GH_RC" "$GH_ERR"
  live_text "$BODY_TEXT"
  if [ "$GH_VERDICT" = read ] && [[ $LIVE_TEXT =~ $SILENT_SKIP_RE ]]; then
    bad "audit false-positives on the fail-loud form"; fails=1
  else
    ok "audit does not flag the fail-loud form"
  fi

  # A comment that merely quotes the old pattern must not count as a live skip.
  # This guard exists because it bit once: glasspane-harness's release.yml
  # explains *why* the silent-skip was removed, and the audit reported that
  # explanation as a violation.
  GP_STUB_OUT="$(printf '%s' "$commented" | base64 | tr -d '\n')"; export GP_STUB_OUT
  read_workflow_body GlassPane release.yml
  classify_workflow_read "$GH_RC" "$GH_ERR"
  live_text "$BODY_TEXT"
  if [ "$GH_VERDICT" = read ] && [[ $LIVE_TEXT =~ $SILENT_SKIP_RE ]]; then
    bad "audit counts commented-out lines as violations"; fails=1
  else
    ok "audit ignores the pattern when it appears only in comments"
  fi

  # 读不到的三种下场必须**分得开**（缺陷 3 的本体：从前全部并成一句"没发现"）。
  GP_STUB_OUT=""; export GP_STUB_OUT
  GP_STUB_ERR='gh: Not Found (HTTP 404)'; export GP_STUB_ERR
  GP_STUB_RC=1; export GP_STUB_RC
  classify_workflow_read 1 "$GP_STUB_ERR"
  if [ "$GH_VERDICT" = absent ]; then
    ok "404 判成「被证明的缺席」，不是「没读到」也不是静默跳过"
  else
    bad "404 被分诊成 '$GH_VERDICT'（应为 absent）"; fails=1
  fi
  # 404 的形状不许被更长的数字顺手命中："4044" 不是 HTTP 404。
  classify_workflow_read 1 'gh: weird (HTTP 4044)'
  if [ "$GH_VERDICT" = failed ]; then
    ok "HTTP 4044 没有被误判成 404（按词比，不按子串）"
  else
    bad "HTTP 4044 被分诊成 '$GH_VERDICT'（应为 failed）"; fails=1
  fi
  GP_STUB_ERR='gh: Bad credentials (HTTP 401)'; export GP_STUB_ERR
  classify_workflow_read 1 "$GP_STUB_ERR"
  if [ "$GH_VERDICT" = unauthorized ]; then
    ok "401 判成「没登录/scope 不够」，与「这份工作流不存在」两句话"
  else
    bad "401 被分诊成 '$GH_VERDICT'（应为 unauthorized）"; fails=1
  fi
  classify_workflow_read 1 'Get "https://api.github.com": dial tcp: no route to host'
  if [ "$GH_VERDICT" = failed ]; then
    ok "网络失败判成 failed（不是 absent，也不是 unauthorized）"
  else
    bad "网络失败被分诊成 '$GH_VERDICT'（应为 failed）"; fails=1
  fi

  # secret 那一侧的同一条规矩：**failed 永远不许说 missing**（缺陷 3 的另一半）。
  classify_secret_list 1 "GPG_PRIVATE_KEY" GPG_PRIVATE_KEY
  if [ "$GH_VERDICT" = failed ]; then
    ok "gh 失败 + 列表里有名字 = failed，不是 present"
  else
    bad "gh 失败被分诊成 '$GH_VERDICT'（应为 failed）"; fails=1
  fi
  classify_secret_list 0 "" GPG_PRIVATE_KEY
  if [ "$GH_VERDICT" = empty ]; then
    ok "gh 成功 + 空列表 = empty（这才是「缺失」那句的凭据）"
  else
    bad "空列表被分诊成 '$GH_VERDICT'（应为 empty）"; fails=1
  fi
  classify_secret_list 0 "$(printf 'OTHER_SECRET\nGPG_PRIVATE_KEY')" GPG_PRIVATE_KEY
  if [ "$GH_VERDICT" = present ]; then ok "整行命中判 present"; else bad "命中判成 '$GH_VERDICT'"; fails=1; fi
  classify_secret_list 0 "$(printf 'GPG_PRIVATE_KEY_X')" GPG_PRIVATE_KEY
  if [ "$GH_VERDICT" = absent ]; then
    ok "只含前缀的那一行判 absent（grep -qx 的同义，整行才算）"
  else
    bad "前缀命中被当成 present 了（verdict='$GH_VERDICT'）"; fails=1
  fi

  PATH="$old_path"; export PATH
  unset GP_STUB_OUT GP_STUB_ERR GP_STUB_RC
  rm -rf -- "$stub_dir"

  [ "$fails" -eq 0 ] && printf '\nselftest passed\n' || { printf '\nselftest FAILED\n'; exit 1; }
}

case "${1:-}" in
  seed)     shift; cmd_seed "$@" ;;
  install)  shift; cmd_install "$@" ;;
  verify-pass) shift; cmd_verify_pass "$@" ;;
  verify)   shift; cmd_verify "$@" ;;
  local)    shift; cmd_local "$@" ;;
  audit)    shift; cmd_audit "$@" ;;
  secret-verdict) shift; cmd_secret_verdict "$@" ;;
  selftest) shift; cmd_selftest "$@" ;;
  # usage 由文件自己算出来（与 tools/release-signing-gate.sh 的 usage() 同一招）：从前这里写死
  # `sed -n '2,34p'`，而 Usage 块在 36 行之后 —— 也就是说**没有任何一条路径会把用法打给读者**，
  # 新加的子命令同样永远不会出现在帮助里。行号是第二份抄本，抄本会过期，这里不再抄。
  *) awk '/^# Usage/{f=1} /^set -euo/{f=0} f' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
