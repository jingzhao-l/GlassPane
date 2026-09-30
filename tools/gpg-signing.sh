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
#   gpg-signing.sh selftest              # prove the guards trip when they should
set -euo pipefail

KEYCHAIN_SERVICE="${GP_SIGNING_SERVICE:-gpg-signing}"
KEY_GRIP_HINT="89D88B1D043A1298"   # jingzhao-l (sign-github) <ET_lin@outlook.com>

# repo|local checkout|environment holding the secrets ("" = repo level).
# The third column is not cosmetic: a job declaring `environment: release`
# cannot read a repo-level secret, so a workflow that reads the wrong scope
# sees an empty string and — with a silent skip — ships unsigned.
TARGETS=(
  "GlassPane|/Volumes/Eng-Dev/GlassPane|release"
  "glasspane-harness|/Volumes/Eng-Dev/.worktrees/gp-fork|release"
  "iterate-skill|/Volumes/Eng-Dev/iterate-skill|"
  "iterate-harness|/Volumes/Eng-Dev/iterate-skill/harness/iterate-harness|"
  "iterate-plugin|/Volumes/Eng-Dev/iterate-plugin|"
)

say()  { printf '%s\n' "$*" >&2; }
ok()   { printf '  ok    %s\n' "$*"; }
bad()  { printf '  MISS  %s\n' "$*"; }
warn() { printf '  warn  %s\n' "$*"; }

need() { command -v "$1" >/dev/null 2>&1 || { say "error: $1 not found in PATH"; exit 127; }; }

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
  armored="$(gpg --batch --yes --pinentry-mode loopback --passphrase "$pass" \
                   --armor --export-secret-keys "$KEY_GRIP_HINT" 2>/tmp/.gpg-seed-err || true)"
  gpg_err="$(cat /tmp/.gpg-seed-err 2>/dev/null || true)"
  rm -f /tmp/.gpg-seed-err
  if [ -n "$armored" ] && printf '%s' "$armored" | grep -q 'BEGIN PGP PRIVATE KEY BLOCK'; then
    ok "key unlocked and exported"
  elif printf '%s' "$gpg_err" | grep -qE '损坏的密码|bad passphrase'; then
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
  kc_put() { local b; b="$(printf '%s' "$2" | base64 | tr -d '\n')"
             security add-generic-password -U -s "$KEYCHAIN_SERVICE" -a "$1" -w "$b" >/dev/null; }
  kc_get() { security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$1" -w 2>/dev/null \
               | base64 -d 2>/dev/null || true; }

  kc_put private-key "$armored"
  kc_put passphrase  "$pass"
  # Read back and compare: the only honest check is the bytes that come out.
  local stored
  stored="$(kc_get private-key)"
  if ! printf '%s' "$stored" | grep -q 'BEGIN PGP PRIVATE KEY BLOCK'; then
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
  local err
  err="$(gpg --batch --yes --pinentry-mode loopback --passphrase "$pass" \
              --armor --export-secret-keys "$KEY_GRIP_HINT" 2>&1 >/dev/null || true)"
  unset pass
  if [ -z "$err" ]; then
    ok "口令正确（gpg 没有报错，导出成功）"
    say "现在可以跑: $0 seed"
  elif printf '%s' "$err" | grep -qE '损坏的密码|bad passphrase'; then
    bad "口令不对 —— gpg 原话：损坏的密码"
  elif printf '%s' "$err" | grep -qE 'pinentry'; then
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
  if ! printf '%s' "$key" | grep -q 'BEGIN PGP PRIVATE KEY BLOCK'; then
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
  local repo dir env
  while IFS='|' read -r repo dir env; do
    printf '%s\n' "$repo"
    local names
    if [ -n "$env" ]; then
      names="$(gh api "repos/jingzhao-l/$repo/environments/$env/secrets" --jq '.secrets[].name' 2>/dev/null || true)"
    fi
    if [ -z "$names" ]; then
      names="$(gh api "repos/jingzhao-l/$repo/actions/secrets" --jq '.secrets[].name' 2>/dev/null || true)"
      if [ -n "$names" ] && [ -n "$env" ]; then
        warn "  secrets exist at repo level, but the workflow declares environment '$env'"
      fi
    fi
    for want in GPG_PRIVATE_KEY GPG_PASSPHRASE; do
      if printf '%s' "$names" | grep -qx "$want"; then ok "$want"; else bad "$want missing${env:+ (environment '$env')}"; fi
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
cmd_audit() {
  need gh
  printf '\n== silent-skip signing in release workflows ==\n'
  local repo dir env any=0 wf
  while IFS='|' read -r repo dir env; do
    for wf in release.yml publish.yml; do
      local body
      body="$(gh api "repos/jingzhao-l/$repo/contents/.github/workflows/$wf" --jq '.content' 2>/dev/null | base64 -d 2>/dev/null || true)"
      [ -n "$body" ] || continue
      # Strip comment lines first. A workflow that documents *why* it removed
      # the silent-skip still contains the string, and reporting that as a live
      # skip trains people to ignore this command — the same mistake a linter
      # makes when it greps its own explanation.
      local live
      live="$(printf '%s\n' "$body" | grep -vE '^[[:space:]]*#' || true)"
      if printf '%s' "$live" | grep -qE 'if: *\$\{\{ *secrets\.GPG_PRIVATE_KEY'; then
        printf '  %s/%s\n' "$repo" "$wf"
        printf '%s' "$live" | grep -nE 'if: *\$\{\{ *secrets\.GPG_PRIVATE_KEY' | sed 's/^/      /'
        any=1
      fi
    done
  done < <(targets_filtered)
  [ "$any" -eq 1 ] || ok "no silent-skip signing found"
  cat <<'NOTE'

  Each line above means: when the secret is missing, the whole signing step
  vanishes and the release still publishes. GlassPane's release.yml is the
  reference shape — it fails with a remedy instead. That difference is why its
  commits verify and the others' do not.
NOTE
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

  # The audit pattern must match a real silent-skip and NOT match the fixed
  # form. Built with printf rather than hand-escaped quoting: the YAML
  # expression is full of quotes and braces, and escaping it by hand is
  # itself a bug source (it broke this file once already).
  local skip fixed
  skip=$(printf '        if: ${{ secrets.GPG_PRIVATE_KEY != %s }}' "''")
  fixed='          if [ -z "${GPG_INPUT_KEY:-}" ]; then'
  if printf '%s' "$skip"   | grep -qE 'if: *\$\{\{ *secrets\.GPG_PRIVATE_KEY'; then ok "audit matches the silent-skip form"
  else bad "audit fails to match the silent-skip form"; fails=1; fi
  if printf '%s' "$fixed" | grep -qE 'if: *\$\{\{ *secrets\.GPG_PRIVATE_KEY'; then bad "audit false-positives on the fail-loud form"; fails=1
  else ok "audit does not flag the fail-loud form"; fi

  # A comment that merely quotes the old pattern must not count as a live skip.
  # This guard exists because it bit once: glasspane-harness's release.yml
  # explains *why* the silent-skip was removed, and the audit reported that
  # explanation as a violation.
  local commented
  commented=$(printf '      # the old\n      # if: ${{ secrets.GPG_PRIVATE_KEY != %s }}\n' "''")
  if printf '%s' "$commented" | grep -vE '^[[:space:]]*#' | grep -qE 'if: *\$\{\{ *secrets\.GPG_PRIVATE_KEY'; then
    bad "audit counts commented-out lines as violations"; fails=1
  else ok "audit ignores the pattern when it appears only in comments"; fi

  [ "$fails" -eq 0 ] && printf '\nselftest passed\n' || { printf '\nselftest FAILED\n'; exit 1; }
}

case "${1:-}" in
  seed)     shift; cmd_seed "$@" ;;
  install)  shift; cmd_install "$@" ;;
  verify-pass) shift; cmd_verify_pass "$@" ;;
  verify)   shift; cmd_verify "$@" ;;
  local)    shift; cmd_local "$@" ;;
  audit)    shift; cmd_audit "$@" ;;
  selftest) shift; cmd_selftest "$@" ;;
  *) sed -n '2,34p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
