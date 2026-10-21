#!/usr/bin/env bash
# release-signing-gate.sh — the one step in the release lane that asks *which key made the
# .asc files*, instead of which key happened to be sitting in the machine.
#
# THE DEFECT THIS CLOSES (read out of .github/workflows/release.yml at 4547835)
# ─────────────────────────────────────────────────────────────────────────────
# The signing job imports whatever `secrets.GPG_PRIVATE_KEY` currently holds, signs the
# archive and the checksums with it, and then asserts exactly one thing about the result:
# that the two `.asc` files are non-empty (`[ -s "${f}.asc" ]`). Non-empty proves a
# signature *exists*. It says nothing about *whose* it is. Rotate, rename or re-import the
# secret — or let it quietly hold a second key — and the Release publishes GREEN with a
# valid signature made by the wrong key, while `updater/lib/signature.js` refuses that
# release on every installed machine: `classifySignature` answers `invalid` unless the
# imported ring carries the pinned primary **and** `VALIDSIG` names it, and `lib/check.js`
# keeps `signature-invalid` outside `AUTHORSHIP_CONSENT_CODES`, so `--consent
# unsigned-release` cannot wave it through either. Auto-update is then dead for that
# version, and nothing in the publish chain ever said so. This file says so, before
# `gh release create` runs.
#
# WHAT GREEN MEANS HERE
#   Every payload named on the command line carries a detached signature that gpg verifies
#   over *those exact bytes*, and the fingerprint gpg reports for the key that made it
#   equals the fingerprint this product ships as its verification anchor.
#
# WHY THE ANCHOR IS IMPORTED, NEVER COPIED
#   `PINNED_PRIMARY_FINGERPRINT` exists to be the single place that answer lives, and this
#   repository has already been bitten twice by "two files that must agree with nothing
#   checking it" (that file's own header lists them: two status roots, two job labels, two
#   version readings). So this gate `import()`s `updater/lib/signature.js` and calls *its*
#   `normalizePinnedFingerprint` to read the anchor and *its* `validSigFingerprint` to read
#   the signer. A workflow that carried the literal would not be a gate — it would be a
#   second anchor, free to drift the moment somebody rotates the key.
#
# WHY `gpg --verify --status-fd` AND NOT `gpg --list-packets`
#   `--list-packets` decodes the signature packet without needing any key: it prints the
#   issuer as a 16-hex key id (a truncation of the fingerprint) and gives no verdict on the
#   bytes at all. That is the right tool for forensics on a release nobody can authenticate;
#   it is the wrong tool for a publish gate, because "parseable" is not "verifies over these
#   bytes" and a truncated identifier is not what gate 8 compares. `--verify --status-fd 1`
#   answers both questions in one run, and its `[GNUPG:] VALIDSIG <fpr>` first field is
#   *literally the string* `validSigFingerprint()` reads on every installed machine — so the
#   publish lane and the runtime cannot disagree about who signed. Measured on this machine
#   (gpg 2.5.24, primary-key signature): `GOODSIG 0C42B2CB07E122F9 …` (key id) next to
#   `VALIDSIG 293AE8BE2A7CBFD250134C470C42B2CB07E122F9 …` (40-hex primary); only the latter
#   is comparable to the pin.
#
# Usage
#   release-signing-gate.sh check [--gnupg-home DIR] -- PAYLOAD [PAYLOAD...]
#       The gate. The pin is imported from updater/lib/signature.js — never passed in — and
#       every PAYLOAD's .asc must have been made by that key over those exact bytes.
#   release-signing-gate.sh selftest
#       Proves the gate can go red, in the workflow's own shell path: a throwaway no-passphrase
#       key in a throwaway 0700 /tmp keyring signs a fixture, then four arms run against it.
#       Arm 1 pins the throwaway key itself -> must exit 0. Arm 2 pins the *shipped* anchor while
#       the throwaway signed -> must exit non-zero AND name both fingerprints. Arm 3 is arm 2 in
#       the production form (no --pinned; the gate imports the anchor) -> must exit non-zero.
#       Arm 4 flips a byte in the payload under an untouched .asc -> must exit non-zero.
#       --pinned exists only for the fixture arms and is refused unless the caller exports
#       GLASSPANE_GATE_ALLOW_TEST_PIN=1, so the production call cannot carry a second anchor.
#
# Exit codes: 0 = the pinned key signed every asset; 1 = the gate refuses this artifact set
# (and the release carrying it); 2 = the gate could not be asked at all (no gpg, no node, the
# anchor unreadable). 2 is red in CI too: a control that cannot run is not a control, and this
# repository has already had one release lane quietly stop existing that way (v1.4.0, unsigned).
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
SIGNATURE_MODULE="${GLASSPANE_GATE_SIGNATURE_MODULE:-$REPO_ROOT/updater/lib/signature.js}"

note() { printf '%s\n' "$*"; }
err()  { printf '::error::%s\n' "$*"; }

# The self-test's throwaway keyring, when one is open. File-scope, the way
# tools/gpg-signing.sh keeps its error file: the EXIT trap has to still see the name.
selftest_home=""
cleanup_selftest() {
  if [ -n "${selftest_home:-}" ] && [ -d "$selftest_home" ]; then
    rm -rf -- "$selftest_home"
  fi
}

usage() {
  awk '/^# Usage/{f=1} /^set -euo/{f=0} f' "$0" | sed 's/^# \{0,1\}//'
}

need_tools() {  # $1 = who is asking (check / selftest)
  local missing=""
  command -v gpg  >/dev/null 2>&1 || missing="$missing gpg"
  command -v node >/dev/null 2>&1 || missing="$missing node"
  if [ -z "$missing" ]; then return 0; fi
  err "$1 无法工作：PATH 里找不到${missing}。"
  note "NOT self-tested: ${missing} is missing ($1 was never able to run)"
  note "remedy: 这条 lane 的 runner 必须同时有 gnupg 与 node（ubuntu-latest 两者都带）。读不到就是镜像或 PATH 变了。"
  note "工具不在的时候判据一律红：测不了不是过，绿着发一份没人验过的东西就是 v1.4.0。"
  exit 2
}

# The updater's own two readers, reached through one import, so this repository keeps exactly
# one implementation of "what counts as a fingerprint" and "which key made this signature".
# The mode is a positional argument: an env assignment has to prefix the node command itself
# to reach node's environment, and doing it inside one function keeps every call site honest.
anchor_reader() {  # $1 = pin | normalize | validsig (the latter two read stdin)
  GP_GATE_SIGNATURE_MODULE="$SIGNATURE_MODULE" GP_GATE_MODE="$1" LC_ALL=C node --input-type=module -e '
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
const mod = await import(pathToFileURL(process.env.GP_GATE_SIGNATURE_MODULE).href)
const mode = process.env.GP_GATE_MODE
if (mode === "pin") {
  process.stdout.write(String(mod.normalizePinnedFingerprint(mod.PINNED_PRIMARY_FINGERPRINT) ?? ""))
} else if (mode === "normalize") {
  process.stdout.write(String(mod.normalizePinnedFingerprint(readFileSync(0, "utf8")) ?? ""))
} else if (mode === "validsig") {
  process.stdout.write(String(mod.validSigFingerprint(readFileSync(0, "utf8")) ?? ""))
} else {
  process.exitCode = 2
}
'
}

pinned_from_anchor() {  # sets PINNED_FPR to the 40-hex fingerprint the shipped updater pins
  # Runs as a statement, never inside `$( )`: a remedy printed inside a command substitution
  # is captured into the variable instead of reaching the log, and the operator reads an exit
  # code with nothing to act on. So the answer goes out through PINNED_FPR and the words go
  # straight to the step's stdout.
  local raw="" rc=0
  if [ ! -f "$SIGNATURE_MODULE" ]; then
    err "签名身份闸读不到锚：${SIGNATURE_MODULE} 不存在。"
    note "remedy: 锚住在 updater/lib/signature.js 的 PINNED_PRIMARY_FINGERPRINT。那个文件挪了位置就把路径经 GLASSPANE_GATE_SIGNATURE_MODULE 指对，"
    note "或者把上面这一处指过去。两种修法都不许把指纹抄一份进 .github/workflows/release.yml —— 第二份锚就是这道闸要防的漂移本身。"
    return 2
  fi
  raw="$(anchor_reader pin 2>&1)" || rc="$?"
  # 空 = normalizePinnedFingerprint 自己说「这不是一枚 40 位 hex 指纹」。形状的规矩只在产品里
  # 写一次：这里不再抄一条正则，否则「工作流以为的指纹」与「updater 认的指纹」就是两份判据了。
  if [ "$rc" -ne 0 ] || [ -z "$raw" ]; then
    err "签名身份闸读不到锚：import updater/lib/signature.js 再走它自己的 normalizePinnedFingerprint 这一步失败了（exit ${rc}）。它原话：${raw:-（没有任何输出）}"
    note "remedy: 判据是 PINNED_PRIMARY_FINGERPRINT 与 normalizePinnedFingerprint 两个导出都还在。缺任何一个都先把 signature.js 补回来 —— "
    note "这道闸故意不自己正则解析那行文本，因为抄一份出来就会出现「工作流里的锚与产品里的锚不一致」这种没人检查的账。"
    return 2
  fi
  PINNED_FPR="$raw"
}

signer_of() {  # $1 = payload, $2 = gnupg home (empty string = the caller's default ring)
  # Sets VERIFY_RC (gpg's exit code), VERIFY_FPR (VALIDSIG's fingerprint, or empty),
  # VERIFY_DETAIL (gpg's last two lines of its own words).
  local payload="$1" home="$2"
  local -a cmd=(gpg)
  if [ -n "$home" ]; then cmd+=(--homedir "$home"); fi
  local errf="" status="" rc=0 fpr="" frc=0
  errf="$(mktemp "${TMPDIR:-/tmp}/gp-gate-gpg-err.XXXXXX")"
  # LC_ALL=C 与 signature.js 的 defaultRunGpg 同一口径：gpg 的散文跟着 locale 走（这台机器上它写
  # 「正在检查信任度数据库」），而 `[GNUPG:]` 状态行永远是英文。判据只读状态行，散文只进诊断。
  status="$(LC_ALL=C "${cmd[@]}" --batch --no-tty --status-fd 1 \
                --verify "${payload}.asc" "$payload" 2>"$errf")" || rc="$?"
  VERIFY_RC="$rc"
  VERIFY_DETAIL="$(tail -n 2 "$errf" | tr '\n' ' ')"
  rm -f "$errf"
  fpr="$(printf '%s\n' "$status" | anchor_reader validsig)" || frc="$?"
  if [ "$frc" -ne 0 ]; then
    err "签名身份闸读不出签名者：把 gpg 的状态行交给 updater 自己的 validSigFingerprint 解析时退出 ${frc}。"
    note "remedy: signature.js 必须继续导出 validSigFingerprint —— 判据就是它，工作流里不写第二份状态行解析。"
    exit 2
  fi
  VERIFY_FPR="$fpr"
}

keyring_primary_fpr() {  # $1 = gnupg home -> primary fingerprint of the first key in that ring
  gpg --homedir "$1" --batch --with-colons --list-keys 2>/dev/null \
    | awk -F: '$1=="fpr"{print $10; exit}'
}

remedy_block() {  # the executable remedy, printed once per red verdict
  cat <<'REMEDY'
  remedy（按情形取一条；三条都不动判据）：
    1) secret 被改名、被重新导入、或内容换成了另一把 key —— 把被钉的那把灌回去：
       tools/gpg-signing.sh seed（一次性交互导出）后 tools/gpg-signing.sh install GlassPane，
       它写的就是 gh secret set GPG_PRIVATE_KEY / GPG_PASSPHRASE --env release。修好重跑这一版。
    2) 有意轮换签名 key —— 先改锚，再发版：同时改 updater/lib/signature.js 的
       PINNED_PRIMARY_FINGERPRINT 与 installer/cli.js 的 GLASSPANE_SIGNING_PUBLIC_KEY
       （updater/test/review-2026-10-09.test.mjs 会拿 gpg 把两者重新对齐，对不上就是红）。
       注意装了旧锚的机器不认新 key：轮换要先把带新锚的版本推到人工更新那一步。
    3) 上面那种 exit 2（闸读不到锚、没有 gpg、没有 node）—— 修工具与路径，别把判据改成放行。
       这道闸判不了就是不发版；v1.4.0「签名步被跳过、货照样发」就是这条链子的反面教材。
REMEDY
}

cmd_check() {
  local pinned="" home="" pin_source=""
  local -a payloads=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --pinned)
        # 生产路径不许点名 key：那样这个文件里就又躺着一份锚。只有自测（造一次性 key 的那几条臂）
        # 需要它，而它必须显式开这个环境变量，否则误写进 release.yml 得到的是红，不是绿。
        if [ -z "${GLASSPANE_GATE_ALLOW_TEST_PIN:-}" ]; then
          err "--pinned 被拒：生产调用必须让闸自己去 import updater/lib/signature.js 读锚。"
          note "把指纹写进调用点＝第二份锚，正是这道闸要防的漂移。自测里用 GLASSPANE_GATE_ALLOW_TEST_PIN=1 显式开它。"
          exit 2
        fi
        if [ $# -lt 2 ]; then err "--pinned 后面要跟一枚指纹"; exit 2; fi
        pinned="$2"; shift 2 ;;
      --gnupg-home)
        if [ $# -lt 2 ]; then err "--gnupg-home 后面要跟一个目录"; exit 2; fi
        home="$2"; shift 2 ;;
      --)
        shift
        while [ $# -gt 0 ]; do payloads+=("$1"); shift; done ;;
      *)
        err "check 不认识这个参数：$1"
        usage
        exit 2 ;;
    esac
  done
  need_tools check
  if [ "${#payloads[@]}" -eq 0 ]; then
    err "check 一个产物都没收到 —— 「签对了」不能是空集给的绿。用法：check [--gnupg-home DIR] -- PAYLOAD [PAYLOAD...]"
    exit 2
  fi

  local norm="" nrc=0
  if [ -n "$pinned" ]; then
    pin_source="--pinned（自测夹具显式指定，需 GLASSPANE_GATE_ALLOW_TEST_PIN=1）"
    norm="$(printf '%s\n' "$pinned" | anchor_reader normalize)" || nrc="$?"
    if [ "$nrc" -ne 0 ] || [ -z "$norm" ]; then
      err "传进来的 --pinned「${pinned}」不是 updater 认得的指纹（normalizePinnedFingerprint 回空或报错）。"
      note "闸不接受一个「看起来像」的锚：非 40 位 hex 的 pin 等于没有 pin，而没有 pin 的闸不是闸（signature.js 里同一条判断写的是 no anchor is not a gate）。"
      exit 1
    fi
    pinned="$norm"
  else
    pinned_from_anchor || exit $?
    pinned="$PINNED_FPR"
    pin_source="${SIGNATURE_MODULE}（PINNED_PRIMARY_FINGERPRINT，经 import + normalizePinnedFingerprint 读出）"
  fi
  note "pin-source: ${pin_source}"
  note "pinned-fingerprint: ${pinned}"

  local bad=0 payload
  for payload in "${payloads[@]}"; do
    if [ ! -s "$payload" ]; then
      err "${payload} 缺失或为空：没有字节可验，签名身份闸不能对一份不存在的产物出绿。"
      bad=$((bad + 1))
      continue
    fi
    if [ ! -s "${payload}.asc" ]; then
      err "${payload}.asc 缺失或为空：这道闸问的是「哪把 key 签的」，一份不存在的签名连被问的资格都没有。"
      bad=$((bad + 1))
      continue
    fi
    signer_of "$payload" "$home"
    if [ "$VERIFY_RC" -ne 0 ]; then
      err "${payload}.asc 对不上 ${payload} 这份字节（gpg --verify exit ${VERIFY_RC}${VERIFY_DETAIL:+：${VERIFY_DETAIL}}）。签名先要有效，才谈得上是谁签的。"
      bad=$((bad + 1))
      continue
    fi
    if [ -z "$VERIFY_FPR" ]; then
      err "${payload}.asc 被 gpg 判为有效，却没有说出是哪把 key 签的（状态里没有 VALIDSIG，或它第一个字段不是一枚指纹）。读不到签名者＝不能放行。"
      bad=$((bad + 1))
      continue
    fi
    if [ "$VERIFY_FPR" != "$pinned" ]; then
      err "${payload}.asc 是由 ${VERIFY_FPR} 签的，而这个产品钉死的锚是 ${pinned}（读自 ${pin_source}）。签名有效、key 不对 —— updater 第 8 道校验在每台装好的机器上都会把这一版判成 signature-invalid，而它落在 AUTHORSHIP_CONSENT_CODES 之外，--consent unsigned-release 也救不回来：自动更新对这个版本就是死的。这一版不发。"
      bad=$((bad + 1))
      continue
    fi
    note "  ok    ${payload}.asc 签名者 ${VERIFY_FPR} == 被钉的 ${pinned}"
  done

  if [ "$bad" -gt 0 ]; then
    err "签名身份闸判红：${bad} 件产物没通过（pinned=${pinned}）。gh release create 不会执行。"
    remedy_block
    exit 1
  fi
  note "GATE VERDICT GREEN: ${#payloads[@]} 件产物都由被钉的 key（${pinned}）签出，签名逐件对得上字节。"
}

cmd_selftest() {
  need_tools selftest
  if [ ! -f "$SIGNATURE_MODULE" ]; then
    note "NOT self-tested: ${SIGNATURE_MODULE} 不存在，臂 2 与臂 3 没有 shipped 锚可比"
    exit 2
  fi
  local home=""
  home="$(mktemp -d "${TMPDIR:-/tmp}/gp-gate-selftest.XXXXXX")"
  chmod 700 "$home"
  selftest_home="$home"
  trap cleanup_selftest EXIT

  # 一次性 key：无口令（%no-protection）、无子 key —— 签名走主 key，与真实发布 key 同一形状
  # （signature.js 对已发布 v1.9.0 那份 .asc 的实测注记：主 key 自签）。它只活在这个 0700 的临时
  # ring 里：脚本对它不做任何 --export-secret-keys，日志里出现的每一行都是公钥侧的指纹。
  printf '%s\n' \
    '%echo generating the throwaway fixture key' \
    '%no-protection' \
    'Key-Type: RSA' \
    'Key-Length: 2048' \
    'Name-Real: GlassPane release-signing-gate selftest (throwaway)' \
    'Name-Email: gate-selftest@example.invalid' \
    'Expire-Date: 0' > "$home/keyparams"
  local gen_err=""
  if ! gen_err="$(gpg --homedir "$home" --batch --quiet --gen-key "$home/keyparams" 2>&1 >/dev/null)"; then
    note "NOT self-tested: gpg --batch --gen-key 造不出一次性 key，四条臂都没有对象。gpg 原话：${gen_err:-（无输出）}"
    exit 2
  fi
  local fixture=""
  fixture="$(keyring_primary_fpr "$home")"
  if [ -z "$fixture" ]; then
    note "NOT self-tested: 临时 ring 造出来了却读不到主指纹（--with-colons --list-keys 回空）"
    exit 2
  fi
  local shipped=""
  pinned_from_anchor || exit $?
  shipped="$PINNED_FPR"
  if [ "$shipped" = "$fixture" ]; then
    note "NOT self-tested: 一次性 key 与 shipped 锚同值，「不同的 key」那一臂没有对象"
    exit 2
  fi
  note "throwaway fixture key: ${fixture}"
  note "shipped pinned anchor:  ${shipped}"

  printf 'GlassPane release-signing-gate selftest payload\n' > "$home/fixture.txt"
  if ! gpg --homedir "$home" --batch --yes --pinentry-mode loopback --local-user "$fixture" \
        --detach-sign --armor --output "$home/fixture.txt.asc" "$home/fixture.txt" >/dev/null 2>&1; then
    note "NOT self-tested: 一次性 key 签不出夹具，四条臂都没有对象"
    exit 2
  fi

  local fails=0 rc=0 out="" miss=""
  # 臂 1 —— pin 就是签名的那把 key：必须 exit 0。它红说明闸把自家的发布也判死了，发布链会常红。
  rc=0
  out="$(GLASSPANE_GATE_ALLOW_TEST_PIN=1 bash "$0" check --pinned "$fixture" --gnupg-home "$home" \
            -- "$home/fixture.txt" 2>&1)" || rc="$?"
  printf '%s\n' "$out"
  if [ "$rc" -ne 0 ]; then
    err "selftest 臂 1（key 与 pin 相同）以 exit ${rc} 判红：闸连自家签名都不认，每一次发版都会被它自己拦下。"
    fails=$((fails + 1))
  else
    note "SELFTEST ARM1 pinned-key-matches exit=0 as it must"
  fi

  # 臂 2 —— 由一次性 key 签、拿 shipped 锚去 pin：必须非 0，而且必须把两枚指纹都点名。
  # 这一臂就是缺陷本体：签名有效、key 不对，旧链子在这里判绿。
  rc=0
  out="$(GLASSPANE_GATE_ALLOW_TEST_PIN=1 bash "$0" check --pinned "$shipped" --gnupg-home "$home" \
            -- "$home/fixture.txt" 2>&1)" || rc="$?"
  printf '%s\n' "$out"
  miss=""
  case "$out" in *"$shipped"*) ;; *) miss="$miss shipped-anchor";; esac
  case "$out" in *"$fixture"*) ;; *) miss="$miss signer-fingerprint";; esac
  if [ "$rc" -eq 0 ]; then
    err "selftest 臂 2（另一把 key 签的）判绿了：这道闸存在的理由就是这一支必须红 —— 它绿着发布，每台机器的自动更新对这个版本就是死的。"
    fails=$((fails + 1))
  elif [ -n "$miss" ]; then
    err "selftest 臂 2 以 exit ${rc} 判红了，却没有点名${miss}：红必须能被诊断，否则下一次真红的时候没人知道是哪两枚指纹不对。"
    fails=$((fails + 1))
  else
    note "SELFTEST ARM2 wrong-key-signed exit=${rc} non-zero, both fingerprints named"
  fi

  # 臂 3 —— 生产调用形态（不传 --pinned，闸自己去 import 锚）：也必须非 0，且点名 shipped 锚与
  # 「pin 是从 signature.js import 的」那一句。release.yml 里用的就是这一支。
  rc=0
  out="$(bash "$0" check --gnupg-home "$home" -- "$home/fixture.txt" 2>&1)" || rc="$?"
  printf '%s\n' "$out"
  if [ "$rc" -eq 0 ]; then
    err "selftest 臂 3（生产调用）判绿了：签名步照样会发版而闸没合上。"
    fails=$((fails + 1))
  else
    miss=""
    case "$out" in *"pin-source: ${SIGNATURE_MODULE}"*) ;; *) miss="$miss pin-source-line";; esac
    case "$out" in *"$shipped"*) ;; *) miss="$miss shipped-anchor";; esac
    if [ -n "$miss" ]; then
      err "selftest 臂 3 以 exit ${rc} 判红，但输出里没有${miss} —— 判红的理由必须能被对上号，否则这条闸只能逼人重读脚本。"
      fails=$((fails + 1))
    else
      note "SELFTEST ARM3 production-invocation exit=${rc} non-zero, pin imported from signature.js"
    fi
  fi

  # 臂 4 —— 字节在签完之后被改、.asc 原样：必须非 0。它钉住"闸量的是这份字节的签名"，
  # 而不是"目录里躺着一份能解析的签名"。
  cp "$home/fixture.txt" "$home/tampered.txt"
  cp "$home/fixture.txt.asc" "$home/tampered.txt.asc"
  printf 'tampered after signing\n' >> "$home/tampered.txt"
  rc=0
  out="$(GLASSPANE_GATE_ALLOW_TEST_PIN=1 bash "$0" check --pinned "$fixture" --gnupg-home "$home" \
            -- "$home/tampered.txt" 2>&1)" || rc="$?"
  printf '%s\n' "$out"
  if [ "$rc" -eq 0 ]; then
    err "selftest 臂 4（签完之后字节被改）判绿了：闸只在量文件名字，没有验这份字节。"
    fails=$((fails + 1))
  else
    note "SELFTEST ARM4 tampered-payload exit=${rc} non-zero, signature does not cover these bytes"
  fi

  if [ "$fails" -ne 0 ]; then
    err "release-signing-gate selftest FAILED：${fails} 条臂没有按它点名的理由回答。修闸，别放宽期望值 —— 这道闸唯一的用途就是在发版前挡住「签名有效但 key 不对」。"
    exit 1
  fi
  note "GATE SELFTEST COMPLETE: 4 arms exercised — 1 绿（自家 key）/ 3 红（别的 key 签的、生产调用、字节被改），每条红都点名它点名的那一枚指纹。"
}

case "${1:-}" in
  check)    shift; cmd_check "$@" ;;
  selftest) shift; cmd_selftest "$@" ;;
  *)        usage; exit 2 ;;
esac
