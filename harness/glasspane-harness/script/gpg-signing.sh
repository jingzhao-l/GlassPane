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
#   gpg-signing.sh install [repo...]    # push both secrets to the targets
#   gpg-signing.sh verify [repo...]     # report what is in place and what is not
#   gpg-signing.sh local [dir...]       # set commit/tag gpgsign in checkouts
#   gpg-signing.sh audit                 # find silent-skip signing; refuses to certify a
#                                        # target it could not read (exit 1 on partial read)
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

# The keychain transport, file-scope because `seed` writes it and `install` reads it.
# Value goes in as base64 (one line — a multi-line value comes back hex-encoded, see the
# note in cmd_seed) and through `security`'s prompt, never through argv.
kc_put() {  # $1 = account, $2 = value
  local b64
  b64="$(printf '%s' "$2" | base64 | tr -d '\n')"
  printf '%s\n%s\n' "$b64" "$b64" \
    | security add-generic-password -U -s "$KEYCHAIN_SERVICE" -a "$1" -w >/dev/null
}
kc_get() {  # $1 = account; empty when the entry is absent or undecodable
  security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$1" -w 2>/dev/null \
    | base64 -d 2>/dev/null || true
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
  local armored
  # The passphrase goes to gpg on FILE DESCRIPTOR 0, not in argv: argv is readable by any
  # local account for the whole lifetime of the command, and loopback pinentry exists
  # precisely to be fed from a descriptor. (Same rule as the main repo's
  # tools/gpg-signing.sh and this repo's own release.yml signing step.)
  armored="$(printf '%s\n' "$pass" | gpg --batch --yes --pinentry-mode loopback --passphrase-fd 0 \
                   --armor --export-secret-keys "$KEY_GRIP_HINT" 2>/dev/null || true)"
  # A failed unlock can still exit 0, so the only honest test is a non-empty
  # export that actually contains a private-key block.
  if [ -z "$armored" ] || ! printf '%s' "$armored" | grep -q 'BEGIN PGP PRIVATE KEY BLOCK'; then
    say "error: the export produced no private key block — passphrase probably wrong"
    exit 1
  fi
  # The exported block stays passphrase-encrypted, but the transport matters for two
  # separate reasons, so both are stated.
  #
  # (1) ARGV. `security add-generic-password -w "$value"` puts the value in the process
  # arguments, and argv on this box is readable by any local account (`ps -eww -o args`)
  # for the whole lifetime of the command. The tool's own usage text says so — "Use of the
  # -p or -w options is insecure. Specify -w as the last option to be prompted" — and the
  # prompt reads its two lines from stdin when there is no tty (measured here 2026-10-14:
  # piping "value\nvalue\n" stored the value and exited 0; a mismatched pair still exits 0,
  # which is why the promise below is the read-back and not the rc).
  #
  # (2) MULTI-LINE VALUES ARE CORRUPT. An armored key block is not one line, and
  # `security` hex-encodes a multi-line value: the entry looks fine in the keychain UI and
  # `find-generic-password` hands back `2d2d2d2d2d424547...`, which `gpg --import` rejects
  # as "no valid OpenPGP data found". Re-measured here on 2026-10-14 (store an armored
  # block, read it back, get hex). This is the same failure the main repo's
  # tools/gpg-signing.sh records for v0.6.1, and it is the reason that file's transport is
  # base64: a single-line value round-trips correctly. These two scripts share ONE keychain
  # service and one pair of account names, so they must share one format — a reader that
  # decoded what the other wrote would push garbage as the release secret.
  # (File-scope kc_put/kc_get below, because `install` reads the same entries back.)
  kc_put private-key "$armored"
  kc_put passphrase  "$pass"
  # A write that silently stored nothing exits 0, so the verdict is what comes back out.
  if ! printf '%s' "$(kc_get private-key)" | grep -q 'BEGIN PGP PRIVATE KEY BLOCK'; then
    say "error: the private-key entry did not read back as an armored key block"
    say "       (a hex blob or an empty value in this spot is the v0.6.1 shape)."
    exit 1
  fi
  if [ "$(kc_get passphrase)" != "$pass" ]; then
    say "error: the passphrase entry did not read back — keychain refused the write"
    exit 1
  fi
  unset pass armored
  ok "private key + passphrase stored (base64) in keychain as service '$KEYCHAIN_SERVICE'"
  say "verified by read-back: both entries come out as the bytes that went in"
  say "next: $0 install"
}

# ── install ──────────────────────────────────────────────────────────────────
cmd_install() {
  need gh; need security
  local key pass
  # Same base64 channel cmd_seed wrote (the raw form came back hex-encoded — see there).
  key="$(kc_get private-key)"
  pass="$(kc_get passphrase)"
  if [ -z "$key" ] || [ -z "$pass" ]; then
    say "error: no keychain entry for '$KEYCHAIN_SERVICE' (private-key / passphrase)."
    say "run: $0 seed"
    exit 1
  fi
  # Refuse to push a value that is not a key: installing a mangled secret is worse than
  # installing none, because `gpg --import` fails at the far end of CI — in a job that has
  # already spent minutes building — and the log blames the key.
  if ! printf '%s' "$key" | grep -q 'BEGIN PGP PRIVATE KEY BLOCK'; then
    say "error: the stored private key is not an armored PGP key (a hex blob or a"
    say "       pre-base64 entry was read back here). Refusing to install it."
    say "       Re-run: $0 seed"
    exit 1
  fi
  local repo dir env
  while IFS='|' read -r repo dir env; do
    printf '%s\n' "$repo"
    local -a scope=()
    [ -n "$env" ] && scope=(--env "$env")
    printf '%s' "$key"  | gh secret set GPG_PRIVATE_KEY  "${scope[@]}" --repo "jingzhao-l/$repo" >/dev/null
    printf '%s' "$pass" | gh secret set GPG_PASSPHRASE "${scope[@]}" --repo "jingzhao-l/$repo" >/dev/null
    ok "GPG_PRIVATE_KEY + GPG_PASSPHRASE set${env:+ (environment '$env')}"
  done < <(targets_filtered "$@")
  unset key pass
}

# ── verify ───────────────────────────────────────────────────────────────────
# GitHub will not say whether a secret's value is right, so this reports
# presence and shape, and states the limit instead of implying more.
#
# Read a repo's secret-name list in the scope the publish jobs actually see. The exit
# status separates "the list is empty" from "the list could not be read" — the old
# `gh api … 2>/dev/null || true` erased that difference, so an environment whose list
# was unreadable fell through to the repo-scope listing and printed ok for secrets a
# job on that environment cannot read at all. That is the same silent-green shape the
# whole script exists to kill.
secret_names() {  # $1 = repo, $2 = environment ("" = repo scope)
  if [ -n "$2" ]; then
    gh api "repos/jingzhao-l/$1/environments/$2/secrets" --jq '.secrets[].name' 2>/dev/null
  else
    gh api "repos/jingzhao-l/$1/actions/secrets" --jq '.secrets[].name' 2>/dev/null
  fi
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
  local repo dir env
  while IFS='|' read -r repo dir env; do
    printf '%s\n' "$repo"
    local names="" scope="" unreadable=0
    if [ -n "$env" ]; then
      scope="environment '$env'"
      if names="$(secret_names "$repo" "$env")"; then :; else unreadable=1; names=""; fi
    else
      scope="repo scope"
      if names="$(secret_names "$repo" "")"; then :; else unreadable=1; names=""; fi
    fi
    if [ "$unreadable" -eq 1 ]; then
      # A distinct, non-green verdict: unreadable is not absent, and it is certainly not ok.
      bad "secret list unreadable ($scope) — gh failed; presence cannot be confirmed"
      for want in GPG_PRIVATE_KEY GPG_PASSPHRASE; do bad "$want UNVERIFIABLE ($scope unreadable)"; done
    elif [ -n "$env" ] && [ -z "$names" ]; then
      local repo_names=""
      repo_names="$(secret_names "$repo" "")" || repo_names=""
      [ -n "$repo_names" ] && warn "  secrets exist at repo level, but the workflow declares environment '$env'"
      for want in GPG_PRIVATE_KEY GPG_PASSPHRASE; do bad "$want missing from environment '$env'"; done
    else
      for want in GPG_PRIVATE_KEY GPG_PASSPHRASE; do
        if printf '%s' "$names" | grep -qx "$want"; then ok "$want ($scope)"; else bad "$want missing ($scope)"; fi
      done
    fi
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
#
# An audit that read nothing must not report clean health. With `gh api … 2>/dev/null |
# base64 -d 2>/dev/null || true` and `[ -n "$body" ] || continue`, an unauthenticated or expired
# `gh`, a renamed repository, or a workflow that moved out of .github/workflows made EVERY body
# empty, every target `continue`-d past, and the command printed
#
#   ok no silent-skip signing found
#
# — the exact shape it exists to detect, certified as absent. `secret_names` (see `verify`)
# already keeps "the list is empty" apart from "the list could not be read"; the audit now keeps
# the same three answers apart per (repo, workflow): READ, ABSENT (the endpoint answered 404 for
# a repository it did resolve), UNVERIFIABLE (we could not ask, or cannot tell whether the file
# moved with the repo). The ok line requires every target to have been answered, and the command
# exits non-zero when it has not — or when a live silent-skip was found, because a reported
# finding that exits 0 is the same silent-green shape one level up.
workflow_answer() {  # $1 = repo, $2 = workflow file; prints the decoded body for the READ answer
  local repo="$1" wf="$2" raw err rc body
  err="$(mktemp)"
  # The status comes from `gh`, not from the pipeline: piping straight into `base64 -d` makes
  # the exit code base64's, which is 0 for an empty stream — that is what erased the difference
  # between "no answer" and "an empty answer".
  if raw="$(gh api "repos/jingzhao-l/$repo/contents/.github/workflows/$wf" --jq '.content' 2>"$err")"; then
    rc=0
  else
    rc=$?
  fi
  if [ "$rc" -ne 0 ]; then
    # 404 alone is ambiguous: GitHub answers 404 for a missing file AND for a repository that
    # is renamed, private-to-this-token, or gone. Resolve the repository before calling an
    # absent file "absent"; anything else is UNVERIFIABLE.
    if grep -q 'HTTP 404' "$err" && gh api "repos/jingzhao-l/$repo" --jq '.full_name' >/dev/null 2>&1; then
      rm -f "$err"
      return 1
    fi
    rm -f "$err"
    return 2
  fi
  body="$(printf '%s' "$raw" | base64 -d 2>/dev/null || true)"
  rm -f "$err"
  # An answered call that carried no content is not a workflow we audited.
  [ -n "$body" ] || return 2
  printf '%s\n' "$body"
  return 0
}

cmd_audit() {
  need gh
  printf '\n== silent-skip signing in release workflows ==\n'
  local repo dir env any=0 unreadable=0 wf body rc live
  while IFS='|' read -r repo dir env; do
    for wf in release.yml publish.yml; do
      if body="$(workflow_answer "$repo" "$wf")"; then rc=0; else rc=$?; fi
      case "$rc" in
        0) : ;;
        1)
          printf '  absent %s/%s — the endpoint answered 404 for a repository it did resolve\n' "$repo" "$wf"
          continue
          ;;
        *)
          printf '  UNVERIFIABLE %s/%s — gh could not read it (auth, transport, or the path moved)\n' "$repo" "$wf"
          unreadable=$((unreadable + 1))
          continue
          ;;
      esac
      # Strip comment lines first. A workflow that documents *why* it removed
      # the silent-skip still contains the string, and reporting that as a live
      # skip trains people to ignore this command — the same mistake a linter
      # makes when it greps its own explanation.
      live="$(printf '%s\n' "$body" | grep -vE '^[[:space:]]*#' || true)"
      if printf '%s' "$live" | grep -qE 'if: *\$\{\{ *secrets\.GPG_PRIVATE_KEY'; then
        printf '  %s/%s\n' "$repo" "$wf"
        printf '%s' "$live" | grep -nE 'if: *\$\{\{ *secrets\.GPG_PRIVATE_KEY' | sed 's/^/      /'
        any=1
      fi
    done
  done < <(targets_filtered)
  if [ "$unreadable" -gt 0 ]; then
    say "audit: $unreadable target(s) could not be read — silent-skip signing is NOT excluded for them"
    say "fix the credential (gh auth status) or the target list, then re-run. This is not a pass."
    exit 1
  fi
  if [ "$any" -eq 1 ]; then
    say "audit: a live silent-skip signing step was found above — the release ships unsigned when the secret is missing"
    exit 1
  fi
  ok "no silent-skip signing found (every target was read or answered as absent)"
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

  # secret_names must keep "the environment list could not be read" and "it is empty"
  # apart — verify's non-green UNVERIFIABLE verdict depends on that distinction, and the
  # original defect was `2>/dev/null || true` erasing it. Stub gh answers by scope.
  local stubdir stub_rc
  stubdir="$(mktemp -d)"
  printf '#!/bin/sh\ncase "$*" in *environments*) exit 1 ;; esac\nprintf "GPG_PRIVATE_KEY\\nGPG_PASSPHRASE\\n"\nexit 0\n' > "$stubdir/gh"
  chmod +x "$stubdir/gh"
  if ( PATH="$stubdir:$PATH" secret_names GlassPane release >/dev/null 2>&1 ); then
    bad "unreadable environment scope was swallowed into success"; fails=1
  else ok "secret_names reports an unreadable environment as failure (verify prints a non-green verdict for it)"; fi
  if ( PATH="$stubdir:$PATH" secret_names GlassPane "" 2>/dev/null | grep -qx GPG_PRIVATE_KEY ); then
    ok "secret_names still reads a repo scope that answers"
  else bad "secret_names cannot read a healthy repo scope"; fails=1; fi
  printf '#!/bin/sh\nexit 0\n' > "$stubdir/gh"
  if ( PATH="$stubdir:$PATH" secret_names GlassPane release >/dev/null 2>&1 ); then
    ok "an environment with an empty-but-readable list stays distinguishable from an unreadable one"
  else bad "empty list was read as failure"; fails=1; fi
  rm -rf "$stubdir"

  # cmd_audit must keep three answers apart: READ, ABSENT, UNVERIFIABLE. The defect this pins is
  # `gh api … 2>/dev/null | base64 -d 2>/dev/null || true` followed by `[ -n "$body" ] ||
  # continue`: with expired credentials, a renamed repo, or a moved workflow every body came back
  # empty, every target was skipped, and the audit printed `ok no silent-skip signing found` —
  # certifying the absence of the exact shape it exists to detect. Stub `gh` answers by endpoint,
  # so each scenario drives the real read accounting.
  local adir alog arc audit_status
  adir="$(mktemp -d)"; alog="$(mktemp)"; arc="$(mktemp)"
  run_audit() {  # $1 = directory holding the stub gh; output lands in $alog, status in $arc
    # The inner `( … )` is what absorbs cmd_audit's own `exit 1` — run bare in the subshell
    # below, that `exit` also skips the line that records the status, and the scenario then
    # reads as "the selftest died" instead of "the audit refused".
    ( set +e
      ( PATH="$1:$PATH" cmd_audit >"$alog" 2>&1 )
      printf '%s\n' "$?" > "$arc" )
    audit_status="$(cat "$arc")"
    return 0
  }
  printf 'name: release\njobs:\n  sign:\n    run: |\n      if [ -z "${GPG_INPUT_KEY:-}" ]; then echo no key; exit 1; fi\n' > "$adir/clean.yml"
  printf "name: release\njobs:\n  sign:\n    if: \${{ secrets.GPG_PRIVATE_KEY != '' }}\n    run: echo signing\n" > "$adir/skip.yml"

  cat > "$adir/gh" <<'STUBAUDITAUTH'
#!/bin/sh
# Expired or absent credential: every endpoint answers with a status that is not 404.
printf 'gh: Bad credentials (HTTP 401)\n' >&2
exit 1
STUBAUDITAUTH
  chmod +x "$adir/gh"
  run_audit "$adir"
  if [ "$audit_status" != "0" ]; then
    ok "audit exits non-zero when no workflow body could be read (exit $audit_status)"
  else bad "audit exited 0 on an unreadable GitHub API — a clean bill of health it did not earn"; fails=1; fi
  if grep -q 'UNVERIFIABLE' "$alog"; then ok "audit names the targets it could not read (UNVERIFIABLE)";
  else bad "audit printed no UNVERIFIABLE line for unreadable targets"; fails=1; fi
  if grep -q 'no silent-skip signing found' "$alog"; then
    bad "audit printed the ok line after reading nothing"; fails=1
  else ok "audit withholds the ok line unless every target was answered"; fi

  cat > "$adir/gh" <<'STUBAUDITREPO'
#!/bin/sh
# A renamed or inaccessible repository: 404 for the workflow AND for the repo itself, so 404
# cannot be read as "this file is just not here".
printf 'gh: Not Found (HTTP 404)\n' >&2
exit 1
STUBAUDITREPO
  run_audit "$adir"
  if [ "$audit_status" != "0" ] && grep -q 'UNVERIFIABLE' "$alog"; then
    ok "a 404 on an unresolvable repository is UNVERIFIABLE, not absent"
  else bad "an unresolvable repository was certified as a clean read (exit $audit_status)"; fails=1; fi

  cat > "$adir/gh" <<'STUBAUDITBODY'
#!/bin/sh
# The contents endpoint serves whatever $GP_AUDIT_BODY names; the repository probe resolves.
case "$*" in
  *contents/*) base64 < "$GP_AUDIT_BODY" ;;
  repos/jingzhao-l/*) printf 'jingzhao-l/stub-repo\n' ;;
esac
exit 0
STUBAUDITBODY
  export GP_AUDIT_BODY="$adir/clean.yml"
  run_audit "$adir"
  if [ "$audit_status" = "0" ] && grep -q 'no silent-skip signing found' "$alog"; then
    ok "a fully read target set with nothing to report does print the ok line"
  else bad "a clean read was not certified as clean (exit $audit_status)"; fails=1; fi
  export GP_AUDIT_BODY="$adir/skip.yml"
  run_audit "$adir"
  if [ "$audit_status" != "0" ] && grep -q 'no silent-skip signing found' "$alog"; then
    bad "audit found a silent skip and still exited 0 — a red finding with a green exit code"; fails=1
  elif [ "$audit_status" != "0" ]; then ok "a live silent-skip is reported AND exits non-zero"
  else bad "a live silent-skip did not fail the audit (exit $audit_status)"; fails=1; fi
  unset GP_AUDIT_BODY

  cat > "$adir/gh" <<'STUBAUDITABSENT'
#!/bin/sh
# The real shape of `publish.yml`: 404 for the file, 200 for the repository. That is an answer,
# not a missing read — treating it as UNVERIFIABLE would make the audit permanently red and teach
# everyone to ignore it.
case "$*" in
  *contents/*) printf 'gh: Not Found (HTTP 404)\n' >&2; exit 1 ;;
  repos/jingzhao-l/*) printf 'jingzhao-l/stub-repo\n' ;;
esac
exit 0
STUBAUDITABSENT
  run_audit "$adir"
  if grep -q 'absent' "$alog" && ! grep -q 'UNVERIFIABLE' "$alog"; then
    ok "a workflow the reachable repository does not carry is reported as absent"
  else bad "an answered-404 workflow was not reported as absent"; fails=1; fi
  if [ "$audit_status" != "0" ]; then
    bad "a repository that answered every question still failed the audit (exit $audit_status)"; fails=1
  else ok "every target answered (read or absent) is what the ok line is allowed to mean"; fi
  rm -rf "$adir" && rm -f "$alog" "$arc"

  # No secret may reach argv. Two shapes broadcast it: a keychain value handed to
  # `security`, and a passphrase handed to gpg. Both were here until 2026-10-14.
  #
  # This runs by PATH over BOTH copies of the tool, not only over the file that happens
  # to be executing. The two copies share one keychain service and one pair of account
  # names, so a transport fix that lands in one of them is not a fix — and a selftest
  # that can only see `${BASH_SOURCE[0]:-$0}` can never keep the other copy honest, which
  # is exactly how the parent's `tools/gpg-signing.sh` kept its `-w "$value"` shape after
  # this file was corrected. Comments are excluded the way cmd_audit excludes them from
  # other people's workflows, so a file that documents the anti-pattern is not flagged
  # for documenting it.
  local src parent_src
  src="${BASH_SOURCE[0]:-$0}"
  # Resolved relative to this script's own location, never hard-coded to one machine:
  # <root>/harness/glasspane-harness/script -> ../../.. -> <root>, and the parent copy is
  # <root>/tools/gpg-signing.sh. In the split repo that path does not exist, and the
  # audit says so out loud instead of going green.
  parent_src="$(cd "$(dirname "$src")/../../.." >/dev/null 2>&1 && printf '%s/tools/gpg-signing.sh' "$(pwd)")" || parent_src=""
  audit_argv_channel() {  # $1 = label, $2 = path of a gpg-signing.sh copy to audit
    local label="$1" f="$2" live
    if [ -z "$f" ] || [ ! -f "$f" ]; then
      warn "SKIP  $label: nothing at '${f:-<unresolved>}' — that copy is NOT audited, this is not a pass"
      return 0
    fi
    live="$(grep -vE '^[[:space:]]*#' "$f" 2>/dev/null || true)"
    if [ -z "$live" ]; then
      bad "$label: could not read $f — the argv audit did not run"; fails=1; return 0
    fi
    if printf '%s\n' "$live" | grep -qE 'add-generic-password[^|]*[[:space:]]-w[[:space:]]+"'; then
      bad "$label: a keychain value is back in argv ($f — security takes it through the prompt)"; fails=1
    else ok "$label: no keychain value in argv"; fi
    if printf '%s\n' "$live" | grep -qE -- '--passphrase[[:space:]]+"'; then
      bad "$label: the signing passphrase is back in gpg argv ($f)"; fails=1
    else ok "$label: no passphrase in gpg argv"; fi
    # The two negatives above go green when the code disappears, so the positive halves
    # are asserted too: each secret must have a named non-argv channel still in place.
    if printf '%s\n' "$live" | grep -qE -- '--passphrase-fd 0'; then
      ok "$label: gpg still reads the passphrase from fd 0"
    else bad "$label: --passphrase-fd 0 is gone — the passphrase has no channel"; fails=1; fi
    if printf '%s\n' "$live" | grep -qE 'add-generic-password[^|]*[[:space:]]-w[[:space:]]*(>|$)'; then
      ok "$label: security still writes through the value-less -w prompt"
    else bad "$label: the value-less -w prompt form is gone"; fails=1; fi
    return 0
  }
  audit_argv_channel "harness copy" "$src"
  audit_argv_channel "parent tools/ copy" "$parent_src"

  # The textual halves above only prove the shape is right; they would also go green if
  # kc_put were deleted. This half is behavioural: kc_put must move the value on STDIN and
  # kc_get must hand back exactly what went in. A shell function named `security` shadows
  # the real tool for these lines, so the argv it receives is recorded rather than guessed
  # at — a regression to the argv form shows up as the sentinel sitting in the recorded
  # argv, and a put without base64 shows up as a value that no longer reads back.
  # It exercises THIS file's kc_put/kc_get; the parent copy is covered by the by-path
  # textual audit above, which is why that audit runs over both paths.
  local sec_log sec_store sent got_back
  sec_log="$(mktemp)"; sec_store="$(mktemp)"
  sent="Sec-Roundtrip-Probe-7c"
  security() {
    local first
    case "$1" in
      # The real prompt consumes two lines (value, retype) and stores one — mirrored.
      add-generic-password) printf 'ARGV %s\n' "$*" >> "$sec_log"; IFS= read -r first; printf '%s' "$first" > "$sec_store" ;;
      find-generic-password) cat "$sec_store" 2>/dev/null ;;
    esac
    return 0
  }
  kc_put private-key "$(printf '%s\n%s\n%s' '-----BEGIN PGP PRIVATE KEY BLOCK-----' "$sent" '-----END PGP PRIVATE KEY BLOCK-----')"
  got_back="$(kc_get private-key)"
  unset -f security
  if [ -s "$sec_log" ] && grep -q "$sent" "$sec_log"; then
    bad "the key material reached \`security\` argv"; fails=1
  else ok "kc_put moves the value on stdin, not in argv"; fi
  if printf '%s' "$got_back" | grep -q "$sent"; then
    ok "base64 transport round-trips (write side encodes, read side decodes)"
  else bad "the stored value did not read back as what went in: '$got_back'"; fails=1; fi
  rm -f "$sec_log" "$sec_store"

  [ "$fails" -eq 0 ] && printf '\nselftest passed\n' || { printf '\nselftest FAILED\n'; exit 1; }
}

case "${1:-}" in
  seed)     shift; cmd_seed "$@" ;;
  install)  shift; cmd_install "$@" ;;
  verify)   shift; cmd_verify "$@" ;;
  local)    shift; cmd_local "$@" ;;
  audit)    shift; cmd_audit "$@" ;;
  selftest) shift; cmd_selftest "$@" ;;
  *) sed -n '2,34p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
