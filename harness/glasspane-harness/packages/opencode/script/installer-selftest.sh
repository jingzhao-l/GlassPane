#!/usr/bin/env bash
# installer-selftest.sh — the release-asset fallback path, exercised offline.
#
#   bash packages/opencode/script/installer-selftest.sh
#
# WHY THIS EXISTS. `scripts/install.sh` has one channel that does not go through npm: it
# downloads `<product>-<os>-<arch>.zip` from the GitHub release, checks it against
# SHA256SUMS.txt and its `.asc`, and unpacks it. That path carried two shipped defects
# (it refused Intel Macs, and it claimed "sha256 + GPG verified" even when it had
# verified nothing), and nothing in the repository noticed — because nothing ran it.
# `product-surface.mjs --check` runs `install.sh --dry-run`, which stops before every
# line at issue here.
#
# Every network tool is a stub on PATH that answers from a fixture directory, so the
# assertions are about this installer's real behaviour: same argv, same `set -euo
# pipefail`, same awk checksum matching, same unzip, same summary line. Nothing is
# mocked inside the script under test.
#
# Exit 0 = every check held. Exit 1 = a named check failed.
set -uo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
FORK_ROOT="$(cd "$SELF_DIR/../../.." && pwd)"
INSTALL_SH="$FORK_ROOT/scripts/install.sh"
[ -f "$INSTALL_SH" ] || { echo "FAIL  no installer at $INSTALL_SH"; exit 1; }

SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
STUB="$SCRATCH/stub"
FIX="$SCRATCH/fixture"
mkdir -p "$STUB" "$FIX"

FAILURES=0
pass() { echo "PASS  $*"; }
fail() {
  echo "FAIL  $*"
  FAILURES=$((FAILURES + 1))
}
# check <label> <haystack-file> <needle>: a named string must be present. Grep is only
# the observation; the label says which behaviour was supposed to produce it.
assert_has() {
  local label="$1" file="$2" needle="$3"
  if grep -qF -- "$needle" "$file"; then pass "$label"; else fail "$label — did not see: $needle"; fi
}
assert_not_has() {
  local label="$1" file="$2" needle="$3"
  if grep -qF -- "$needle" "$file"; then fail "$label — it did say: $needle"; else pass "$label"; fi
}
assert_code() {
  local label="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then pass "$label (exit $got)"; else fail "$label — exit $got, wanted $want"; fi
}

# ---------------------------------------------------------------- the published asset
# A zip holding an executable named exactly the product's binary, because that is what
# `script/build.ts` puts in the release.
ASSET_DIR="$SCRATCH/asset"
mkdir -p "$ASSET_DIR"
# The real published binary prints the bare version string on stdout and nothing else —
# measured against the published 0.7.0 (`--version` → "0.7.0", exit 0). A fixture that
# prints "glasspane-harness 9.9.9" would test a shape the product does not have, and the
# installer's version assertion would then be judging a fiction.
printf '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "9.9.9"; exit 0; fi\nexit 0\n' > "$ASSET_DIR/glasspane-harness"
chmod 755 "$ASSET_DIR/glasspane-harness"
(cd "$ASSET_DIR" && zip -q -r "$FIX/glasspane-harness-darwin-arm64.zip" glasspane-harness) || { echo "FAIL  could not build the fixture zip"; exit 1; }
# `<hash>  ./<name>` — the form the release pipeline writes. Built with printf, not by
# squeezing shasum's own output through sed: the first attempt replaced one of the two
# separator spaces and left awk reading `./` as the filename, which made every
# "verified" assertion below fail for the wrong reason.
FIXTURE_HASH="$(cd "$FIX" && shasum -a 256 glasspane-harness-darwin-arm64.zip | awk '{print $1}')"
printf '%s  ./%s\n' "$FIXTURE_HASH" "glasspane-harness-darwin-arm64.zip" > "$FIX/SHA256SUMS.txt"
printf 'not a real signature\n' > "$FIX/glasspane-harness-darwin-arm64.zip.asc"

# ---------------------------------------------------------------- stubs
# curl answers from $FIX by basename, and it answers *the way the real endpoint does for
# the argv it was given*: a `/releases/download/` URL without `-L` is a 302 with a redirect
# page (measured against the published v0.7.1 asset — 302 without `-L`, 200 with it), and
# `-f` is what turns a bad status into exit 22. A stub that answered every argv with 200
# endorsed a missing `-L` and an `-f` that swallowed a blocked fetch, which is how the two
# defects fixed here stayed invisible while every assertion in this file stayed green.
cat > "$STUB/curl" <<'STUBCURL'
#!/usr/bin/env bash
out=""
url=""
fmt=""
flags=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) fmt="$2"; shift 2 ;;
    --location) flags="$flags-L" ; shift ;;
    --fail|--fail-with-body) flags="$flags-f"; shift ;;
    --progress-bar) shift ;;
    -*) flags="$flags$1"; shift ;;
    *) url="$1"; shift ;;
  esac
done
[ -n "$url" ] || exit 2
follow=0; case "$flags" in *L*) follow=1 ;; esac
failmode=0; case "$flags" in *f*) failmode=1 ;; esac
base="$(basename "$url")"
answer() {
  # $1 = status code, $2 = fixture file to hand back ("" for none).
  local code="$1" src="$2"
  if [ "$code" = "200" ] && [ -n "$src" ]; then
    [ -n "$out" ] && cp "$src" "$out"
    [ "$fmt" = "%{http_code}" ] && printf '200'
    if [ -z "$out" ]; then cat "$src" 2>/dev/null; fi
    exit 0
  fi
  [ "$fmt" = "%{http_code}" ] && printf '%s' "$code"
  if [ "$failmode" = "1" ]; then exit 22; fi
  exit 0
}
# A scenario can demand that the *signature* fetch fail with a status that is not 404,
# which is the case `curl -f` used to erase. Same for the manifest: "no SHA256SUMS.txt was
# published" and "we could not read the one that was" are different facts, and the
# installer now has to keep them apart.
case "$base" in
  *.asc)
    if [ -n "${STUB_CURL_HTTP:-}" ]; then answer "$STUB_CURL_HTTP" ""; fi
    ;;
  SHA256SUMS.txt)
    if [ -n "${STUB_SUMS_HTTP:-}" ]; then answer "$STUB_SUMS_HTTP" ""; fi
    ;;
  *.zip)
    # The asset lane has its own scenario: a transport that dies mid-stream. On the maintainer
    # machine that is a TLS-intercepting proxy breaking the HTTP/2 stream after a few hundred
    # KB of a ~47 MB asset — curl's exit 92, not an HTTP status at all, which is why the
    # installer's message has to carry the code rather than a status.
    if [ -n "${STUB_CURL_ASSET_FAIL:-}" ]; then
      printf 'curl: (%s) HTTP/2 stream 1 was not closed cleanly: PROTOCOL_ERROR (err %s)\n' \
        "$STUB_CURL_ASSET_FAIL" "$STUB_CURL_ASSET_FAIL" >&2
      exit "$STUB_CURL_ASSET_FAIL"
    fi
    ;;
esac
# GitHub answers a release download for a published file with a redirect. Asking without
# `-L` is not the same request, so it is not the same answer.
if [ "$follow" = "0" ] && printf '%s' "$url" | grep -q "/releases/download/"; then
  if [ -n "$out" ]; then printf 'Found. Redirecting.\n' > "$out"; fi
  [ "$fmt" = "%{http_code}" ] && printf '302'
  if [ "$failmode" = "1" ]; then exit 22; fi
  exit 0
fi
if [ -f "$FIX_DIR/$base" ]; then answer 200 "$FIX_DIR/$base"; fi
if [ "${STUB_CURL_HTTP:-}" = "500" ] && [ "$fmt" = "%{http_code}" ]; then
  printf '500'
  exit 0
fi
answer 404 ""
STUBCURL
chmod +x "$STUB/curl"

# uname: -s stays real (this is a macOS-only product and the guard is the point);
# -m is whatever the scenario claims the machine is.
cat > "$STUB/uname" <<'STUBUNAME'
#!/usr/bin/env bash
case "${1:-}" in
  -m) echo "$STUB_UNAME_M" ;;
  *) /usr/bin/uname "$@" ;;
esac
STUBUNAME
chmod +x "$STUB/uname"

# npm: present but failing, which is the state the fallback exists for.
printf '#!/bin/sh\necho "stub npm: refusing (simulated EACCES)" >&2\nexit 1\n' > "$STUB/npm"
chmod +x "$STUB/npm"

# gpg: two scripted outcomes, good signature and bad, so both branches of the verify
# function are reachable without a keyring.
cat > "$STUB/gpg" <<'STUBGPG'
#!/usr/bin/env bash
# Real gpg answers `--status-fd 2` with a VALIDSIG line whose third field is the full
# 40-hex fingerprint of the key that made the signature. The installer now requires that
# fingerprint to equal the one it ships, so the stub has to carry it: a fixture that only
# prints GOODSIG would let "signed by some key" and "signed by THIS key" look identical,
# which is the exact confusion the check exists to remove.
if [ "$STUB_GPG_RESULT" = "importfail" ] || { [ "$STUB_GPG_RESULT" = "good" ] && [ "${STUB_GPG_IMPORT_FAILS:-}" = "1" ]; }; then
  if [ "${1:-}" = "--import" ] || printf '%s' "$*" | grep -q -- "--import"; then
    echo "gpg: keyblock resize failed" >&2
    exit 1
  fi
fi
if [ "${1:-}" = "--import" ] || printf '%s' "$*" | grep -q -- "--import"; then exit 0; fi
# Argv discipline. This stub used to print GOODSIG for *any* --verify, which endorsed three
# wrong states as "signature verified": verifying the checksum manifest instead of the asset,
# verifying with no data file passed at all, and verifying a file this release never served.
# Real gpg answers only for the (signature, file) pair it is handed, so the stub now refuses
# anything that is not `--verify <asset>.asc <asset>` with both files present and the asset
# actually in the fixture directory. Drop `-f "$file"` from install.sh's call and the verified
# lane goes red here instead of staying green.
case "$*" in
  *--verify*)
    sig="${@: -2:1}"
    data="${@: -1}"
    base="$(basename "$data")"
    if [ ! -f "$sig" ] || [ ! -f "$data" ]; then
      echo "stub gpg: --verify needs an existing (signature, file) pair, got '$sig' '$data'" >&2
      echo "[GNUPG:] ERRSIG 0929EA31DF4F7429F63FC53189D88B1D043A1298 1 22 01 1791862019 1 0929EA31DF4F7429F63FC53189D88B1D043A1298" >&2
      exit 1
    fi
    case "$sig" in
      "$data".asc) ;;
      *)
        echo "stub gpg: signature '$sig' does not pair with the file '$data'" >&2
        echo "[GNUPG:] ERRSIG 0929EA31DF4F7429F63FC53189D88B1D043A1298 1 22 01 1791862019 1 0929EA31DF4F7429F63FC53189D88B1D043A1298" >&2
        exit 1 ;;
    esac
    if [ ! -f "$FIX_DIR/$base" ]; then
      echo "stub gpg: '$base' is not an asset this release carries" >&2
      echo "[GNUPG:] NO_PUBKEY 0929EA31DF4F7429F63FC53189D88B1D043A1298" >&2
      exit 1
    fi
    ;;
esac
if [ "$STUB_GPG_RESULT" = "good" ]; then
  echo "gpg: Signature made Thu 01 Jan 2026 00:00:00 UTC" >&2
  echo "[GNUPG:] GOODSIG 0929EA31DF4F7429F63FC53189D88B1D043A1298 jingzhao-l (sign-github)" >&2
  echo "[GNUPG:] VALIDSIG 0929EA31DF4F7429F63FC53189D88B1D043A1298 2026-01-01 2026-01-01 0 3 0 1 22 0929EA31DF4F7429F63FC53189D88B1D043A1298" >&2
  echo "[GNUPG:] Good signature" >&2
  exit 0
fi
if [ "$STUB_GPG_RESULT" = "otherkey" ]; then
  # A well-formed signature made by a DIFFERENT key. This is the shape that `grep -q
  # GOODSIG` alone cannot tell from a genuine one, and the case a replaced
  # GPG_PRIVATE_KEY in the release environment produces.
  echo "gpg: Signature made Thu 01 Jan 2026 00:00:00 UTC" >&2
  echo "[GNUPG:] GOODSIG DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF someone-else <other@mail.invalid>" >&2
  echo "[GNUPG:] VALIDSIG DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF 2026-01-01 2026-01-01 0 3 0 1 22 DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF" >&2
  exit 0
fi
echo "[GNUPG:] BADSIG ABCDEF0123456789 jingzhao-l (sign-github)" >&2
echo "gpg: BAD signature" >&2
exit 1
STUBGPG
chmod +x "$STUB/gpg"

export FIX_DIR="$FIX"
run_install() {
  # $1 = log file, rest = argv for install.sh.
  # RUN_PATH overrides the search path: "gpg is not installed" can only be tested by
  # hiding every gpg on the machine, and this box has one outside the stub directory.
  local log="$1"; shift
  (
    export PATH="${RUN_PATH:-$STUB:$PATH}"
    export STUB_UNAME_M="${SCENARIO_UNAME_M:-arm64}"
    export STUB_GPG_RESULT="${SCENARIO_GPG:-good}"
    export STUB_CURL_HTTP="${SCENARIO_CURL_HTTP:-}"
    export STUB_SUMS_HTTP="${SCENARIO_SUMS_HTTP:-}"
    export STUB_CURL_ASSET_FAIL="${SCENARIO_CURL_ASSET_FAIL:-}"
    export STUB_GPG_IMPORT_FAILS="${SCENARIO_GPG_IMPORT_FAILS:-}"
    export GLASSPANE_HARNESS_ALLOW_UNVERIFIED="${SCENARIO_ALLOW_UNVERIFIED:-}"
    export TMPDIR="${SCENARIO_TMPDIR:-/tmp}"
    mkdir -p "$TMPDIR"
    export GLASSPANE_HARNESS_HOME="$SCRATCH/root-$(basename "$log")"
    export GLASSPANE_HARNESS_RELEASES="https://stub.invalid/releases/download"
    bash "$INSTALL_SH" "$@"
  ) >"$log" 2>&1
}

# ---------------------------------------------------------------- 1: argv forms
# The documented `--version 0.1.0` used to end in "Unknown argument: 0.1.0".
run_install "$SCRATCH/argv-space.log" --dry-run --version 9.9.9
assert_code "install.sh --version <value> parses" "$?" "0"
assert_not_has "install.sh --version <value> does not reject the version as an argument" "$SCRATCH/argv-space.log" "Unknown argument"
assert_has "install.sh --version <value> carries it into the plan" "$SCRATCH/argv-space.log" "glasspane-harness@9.9.9"

run_install "$SCRATCH/argv-eq.log" --dry-run --version=9.9.9
assert_code "install.sh --version=<value> parses" "$?" "0"

# `--help` through `curl | bash`, where $0 is `bash` and printing the header with sed
# against "$0" cannot work.
bash -c "cat '$INSTALL_SH' | bash -s -- --help" >"$SCRATCH/help-piped.log" 2>&1
assert_code "install.sh --help works piped to bash" "$?" "0"
assert_has "install.sh --help prints usage" "$SCRATCH/help-piped.log" "glasspane-harness installer"

# ---------------------------------------------------------------- 2: architecture map
SCENARIO_UNAME_M=x86_64 run_install "$SCRATCH/intel.log" --dry-run --version 9.9.9
assert_code "an Intel Mac (uname -m x86_64) is accepted" "$?" "0"
assert_has "x86_64 maps to the shipped darwin-x64 asset" "$SCRATCH/intel.log" "glasspane-harness-darwin-x64.zip"
assert_not_has "an x64 machine is not refused" "$SCRATCH/intel.log" "Unsupported macOS architecture"

SCENARIO_UNAME_M=arm64 run_install "$SCRATCH/arm.log" --dry-run --version 9.9.9
assert_has "arm64 maps to darwin-arm64" "$SCRATCH/arm.log" "glasspane-harness-darwin-arm64.zip"

SCENARIO_UNAME_M=ppc64 run_install "$SCRATCH/ppc.log" --dry-run --version 9.9.9
assert_code "an architecture with no build is refused" "$?" "1"
assert_has "the refusal names what the product ships" "$SCRATCH/ppc.log" "Unsupported macOS architecture"
SCENARIO_UNAME_M=""

# ---------------------------------------------------------------- 3: verified path
# npm fails, so the fallback runs for real against the stub release.
SCENARIO_GPG=good
rm -f "$FIX/glasspane-harness-darwin-x64.zip"
run_install "$SCRATCH/verify-ok.log" --version 9.9.9
assert_code "the fallback installs when the checksum matches" "$?" "0"
assert_has "sha256 is verified against SHA256SUMS.txt" "$SCRATCH/verify-ok.log" "sha256 verified"
assert_has "the summary reports sha256 as verified" "$SCRATCH/verify-ok.log" "sha256: verified (SHA256SUMS.txt)"
assert_has "the summary reports GPG as verified" "$SCRATCH/verify-ok.log" "GPG: verified (signing key"
assert_has "and names the fingerprint it accepted" "$SCRATCH/verify-ok.log" "0929EA31DF4F7429F63FC53189D88B1D043A1298"
assert_has "the installed command is verified at the path this channel wrote" "$SCRATCH/verify-ok.log" "glasspane-harness --version -> 9.9.9"

# ---------------------------------------------------------------- 4: a mismatch refuses
cp "$FIX/glasspane-harness-darwin-arm64.zip" "$SCRATCH/keep.zip"
printf 'appended byte\n' >> "$FIX/glasspane-harness-darwin-arm64.zip"
run_install "$SCRATCH/verify-bad.log" --version 9.9.9
assert_code "a checksum mismatch refuses to install" "$?" "1"
assert_has "the refusal names the mismatch" "$SCRATCH/verify-bad.log" "checksum mismatch"
mv "$SCRATCH/keep.zip" "$FIX/glasspane-harness-darwin-arm64.zip"

# ---------------------------------------------------------------- 5: no manifest at all
# The claim must degrade with the evidence, not with the intent — and a release the lane
# cannot vouch for is not a release it installs. Missing SHA256SUMS.txt used to warn and
# continue; the release lane publishes a manifest for every target and fails the run if one
# is absent, so 404 means the release in front of us is incomplete. Default is now refusal,
# with an explicit opt-out that says in the state string who chose it.
mv "$FIX/SHA256SUMS.txt" "$SCRATCH/SHA256SUMS.txt.hold"
run_install "$SCRATCH/no-sums.log" --version 9.9.9
assert_code "a release with no checksum manifest is refused" "$?" "1"
assert_not_has "with no SHA256SUMS.txt it does not claim sha256 verified" "$SCRATCH/no-sums.log" "sha256: verified"
assert_has "it says the manifest is not published" "$SCRATCH/no-sums.log" "no SHA256SUMS.txt is published for v9.9.9"
assert_has "and it names the opt-out instead of inventing one" "$SCRATCH/no-sums.log" "GLASSPANE_HARNESS_ALLOW_UNVERIFIED=1"
assert_not_has "nothing is installed on that path" "$SCRATCH/no-sums.log" "[OK]    installed via"
SCENARIO_ALLOW_UNVERIFIED=1 run_install "$SCRATCH/no-sums-optout.log" --version 9.9.9
assert_code "GLASSPANE_HARNESS_ALLOW_UNVERIFIED=1 does install" "$?" "0"
assert_has "and the state names the override as the reason" "$SCRATCH/no-sums-optout.log" "sha256: skipped by GLASSPANE_HARNESS_ALLOW_UNVERIFIED=1"
assert_has "and it still says the bytes were not fully verified" "$SCRATCH/no-sums-optout.log" "not fully verified"
assert_not_has "the opt-out does not claim a checksum verification it did not do" "$SCRATCH/no-sums-optout.log" "sha256: verified"
mv "$SCRATCH/SHA256SUMS.txt.hold" "$FIX/SHA256SUMS.txt"

# ---------------------------------------------------------------- 6: a failed signature
# Under `set -e` the old `out="$(gpg --verify …)"` killed the script here, so the warning,
# the state and the temp-dir cleanup below it were all unreachable — and once that was
# fixed, the branch it reached *warned and installed anyway*. A signature that does not
# verify is the tampering signal, and the one remaining check (SHA256SUMS.txt) is fetched
# from the same origin as the asset it lists, so continuing left the user vouched for only
# by the thing being attacked. This is now fatal.
SCENARIO_GPG=bad
run_install "$SCRATCH/gpg-bad.log" --version 9.9.9
assert_code "a bad signature refuses the install" "$?" "1"
assert_has "a bad signature is named as a signature that did not verify" "$SCRATCH/gpg-bad.log" "signature did not verify"
assert_has "and the refusal says the checksum cannot vouch alone" "$SCRATCH/gpg-bad.log" "checksum alone cannot tell"
assert_not_has "it does not claim the install succeeded" "$SCRATCH/gpg-bad.log" "[OK]    installed via"
SCENARIO_GPG=good

# ---------------------------------------------------------------- 7: no gpg binary
# The stub gpg is removed *and* the search path is narrowed to /bin:/usr/bin so a real
# gpg installed elsewhere on this machine cannot answer for it.
mv "$STUB/gpg" "$SCRATCH/gpg.hold"
RUN_PATH="$STUB:/usr/bin:/bin:/usr/sbin:/sbin" run_install "$SCRATCH/no-gpg.log" --version 9.9.9
RUN_PATH=""
assert_code "the install completes with gpg absent" "$?" "0"
assert_has "and says provenance was skipped for that reason" "$SCRATCH/no-gpg.log" "GPG: skipped (gpg not on PATH)"
assert_not_has "no-gpg does not claim GPG verified" "$SCRATCH/no-gpg.log" "GPG: verified"
mv "$SCRATCH/gpg.hold" "$STUB/gpg"

# ---------------------------------------------------------------- 8: nothing was published
# The shape a half-built release actually has: no manifest, no signature sidecar. This is the
# case that used to install anyway behind two warnings — the release lane publishes both for
# every target, so their absence describes a broken release, not a policy the installer gets
# to waive on its own.
mv "$FIX/SHA256SUMS.txt" "$SCRATCH/s.hold"
mv "$FIX/glasspane-harness-darwin-arm64.zip.asc" "$SCRATCH/a.hold"
run_install "$SCRATCH/unverified.log" --version 9.9.9
assert_code "an unsigned, unmanifested release is refused" "$?" "1"
assert_not_has "it never prints the unconditional verified claim" "$SCRATCH/unverified.log" "sha256 + GPG verified"
assert_has "it says which of the two is missing" "$SCRATCH/unverified.log" "no SHA256SUMS.txt is published"
assert_not_has "nothing is installed on that path" "$SCRATCH/unverified.log" "[OK]    installed via"
SCENARIO_ALLOW_UNVERIFIED=1 run_install "$SCRATCH/unverified-optout.log" --version 9.9.9
assert_code "the override installs, and says so" "$?" "0"
assert_has "it prints both skipped states, each naming the override" "$SCRATCH/unverified-optout.log" "skipped by GLASSPANE_HARNESS_ALLOW_UNVERIFIED=1"
assert_not_has "and the override never prints the unconditional verified claim" "$SCRATCH/unverified-optout.log" "sha256 + GPG verified"
mv "$SCRATCH/s.hold" "$FIX/SHA256SUMS.txt"
mv "$SCRATCH/a.hold" "$FIX/glasspane-harness-darwin-arm64.zip.asc"

# ---------------------------------------------------------------- 9..13: the guards added on top
# Rebuild the fixture asset with a given `--version` behaviour and keep SHA256SUMS.txt
# honest about it, so the checksum gate stays satisfied and only the thing under test moves.
swap_asset() {
  rm -rf "$SCRATCH/swap" && mkdir -p "$SCRATCH/swap"
  printf '%s\n' "$1" > "$SCRATCH/swap/glasspane-harness"
  chmod 755 "$SCRATCH/swap/glasspane-harness"
  rm -f "$FIX/glasspane-harness-darwin-arm64.zip"
  (cd "$SCRATCH/swap" && zip -q -r "$FIX/glasspane-harness-darwin-arm64.zip" glasspane-harness)
  h="$(cd "$FIX" && shasum -a 256 glasspane-harness-darwin-arm64.zip | awk '{print $1}')"
  printf '%s  ./%s\n' "$h" "glasspane-harness-darwin-arm64.zip" > "$FIX/SHA256SUMS.txt"
}
restore_asset() {
  rm -f "$FIX/glasspane-harness-darwin-arm64.zip"
  (cd "$ASSET_DIR" && zip -q -r "$FIX/glasspane-harness-darwin-arm64.zip" glasspane-harness)
  # Recompute, do not reuse FIXTURE_HASH: zip stamps mtimes into the archive, so re-zipping
  # the same file yields different bytes and the old hash would fail the checksum gate for
  # a reason that has nothing to do with the behaviour under test.
  h="$(cd "$FIX" && shasum -a 256 glasspane-harness-darwin-arm64.zip | awk '{print $1}')"
  printf '%s  ./%s\n' "$h" "glasspane-harness-darwin-arm64.zip" > "$FIX/SHA256SUMS.txt"
}

# 9 — a well-formed signature from the wrong key.
SCENARIO_GPG=otherkey
run_install "$SCRATCH/gpg-otherkey.log" --version 9.9.9
assert_code "a good signature from a different fingerprint is refused" "$?" "1"
assert_has "it names both fingerprints it compared" "$SCRATCH/gpg-otherkey.log" "expected fingerprint 0929EA31DF4F7429F63FC53189D88B1D043A1298"
assert_has "and shows what actually signed the bytes" "$SCRATCH/gpg-otherkey.log" "DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF"
assert_not_has "the wrong key never prints an installed verdict" "$SCRATCH/gpg-otherkey.log" "[OK]    installed via"
SCENARIO_GPG=good

# 10 — the .asc fetch fails for a reason that is not "it isn't there".
SCENARIO_CURL_HTTP=500 run_install "$SCRATCH/gpg-fetch500.log" --version 9.9.9
assert_code "a blocked or rewritten signature fetch refuses the install" "$?" "1"
assert_has "it says the signature could not be fetched" "$SCRATCH/gpg-fetch500.log" "could not be fetched (HTTP 500)"
assert_not_has "and it never dresses a transport failure up as an unsigned release" "$SCRATCH/gpg-fetch500.log" "no .asc published"
SCENARIO_CURL_HTTP=""

# 11 — gpg cannot import the embedded key: loud refusal, and the throwaway keyring is
# not left on disk (the old bare pipeline died under `set -e` with no message and the
# temp dir still there, because the cleanup below it was unreachable).
KEYRING_PARENT="$SCRATCH/tmpdir-import"
mkdir -p "$KEYRING_PARENT"
SCENARIO_GPG=importfail SCENARIO_TMPDIR="$KEYRING_PARENT" run_install "$SCRATCH/gpg-import.log" --version 9.9.9
assert_code "a failed key import refuses the install" "$?" "1"
assert_has "and says so in its own words, not gpg's stderr alone" "$SCRATCH/gpg-import.log" "could not import"
leftovers="$(find "$KEYRING_PARENT" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
if [ "$leftovers" = "0" ]; then pass "no throwaway GNUPGHOME left behind"; else fail "the keyring leaked: $leftovers dir(s) under $KEYRING_PARENT"; fi
SCENARIO_GPG=good

# 12 — the placeholder binary. This is the false success that made the rest of the file
# untrustworthy: the shipped stub prints an apology to stderr and exits 1, and the verdict
# line read `... --version 2>&1 | head -1` under `|| true`, so the apology became the
# payload of an [OK] line and the installer exited 0.
swap_asset 'if [ "$1" = "--version" ]; then echo "Error: glasspane-harness'"'"'s postinstall script was not run." >&2; exit 1; fi; exit 0'
run_install "$SCRATCH/stub-binary.log" --version 9.9.9
stub_rc=$?
assert_code "a command that does not run fails the install" "$stub_rc" "1"
assert_not_has "the placeholder is never announced as a success" "$SCRATCH/stub-binary.log" "[OK]    glasspane-harness --version"
assert_has "it says the installed command does not run" "$SCRATCH/stub-binary.log" "does not run"
assert_has "and the remedy names the npm flag that caused it" "$SCRATCH/stub-binary.log" "--allow-scripts=glasspane-harness"
restore_asset

# 13 — a version that is not the one asked for.
swap_asset 'if [ "$1" = "--version" ]; then echo "9.9.8"; exit 0; fi; exit 0'
run_install "$SCRATCH/version-mismatch.log" --version 9.9.9
assert_code "a pinned install that got a different version is refused" "$?" "1"
assert_has "and it says which two numbers disagree" "$SCRATCH/version-mismatch.log" "reports 9.9.8, but this installer asked for 9.9.9"
restore_asset
run_install "$SCRATCH/restored.log" --version 9.9.9
assert_code "the fixture swap is reversible — the same run is green again" "$?" "0"

# ---------------------------------------------------------------- 14: the manifest fetch is blocked
# The mirror image of 10, on the other lane. `curl -fsSL` erased the status, so any failure —
# a re-signed TLS chain, a 403, a rewritten response — printed "no SHA256SUMS.txt published
# for v9.9.9" and installed anyway. That sentence is a claim about the *release*, and it was
# being used to describe this machine's network. Now the two states are separate: 404 skips
# with the policy wording (test 5), anything else refuses the install.
SCENARIO_SUMS_HTTP=500 run_install "$SCRATCH/sums-blocked.log" --version 9.9.9
assert_code "a blocked or rewritten manifest fetch refuses the install" "$?" "1"
assert_has "it says the manifest could not be fetched, with the status" "$SCRATCH/sums-blocked.log" "could not be fetched (HTTP 500)"
assert_not_has "and it never dresses a transport failure up as an unpublished manifest" "$SCRATCH/sums-blocked.log" "no SHA256SUMS.txt published"
assert_not_has "nothing is installed on that path" "$SCRATCH/sums-blocked.log" "[OK]    installed via"
SCENARIO_SUMS_HTTP=""

# ---------------------------------------------------------------- 15: a true 404 refuses too
# Not a repeat of 5: there the file was absent from the fixture dir, here the endpoint answers
# 404 for a manifest that exists on disk. Both mean "this release carries no manifest", and both
# must reach the same refusal — while test 14 keeps the *other* fact (a blocked fetch) separately
# worded, so the installer is not simply "everything is fatal now".
printf 'gone\n' > "$SCRATCH/sums.hold"
mv "$FIX/SHA256SUMS.txt" "$SCRATCH/sums.real"
SCENARIO_SUMS_HTTP=404 run_install "$SCRATCH/sums-404.log" --version 9.9.9
assert_code "a manifest the endpoint reports as unpublished is refused" "$?" "1"
assert_has "and names it as unpublished" "$SCRATCH/sums-404.log" "no SHA256SUMS.txt is published for v9.9.9"
assert_not_has "it does not claim a checksum verification it did not do" "$SCRATCH/sums-404.log" "sha256: verified"
SCENARIO_SUMS_HTTP=404 SCENARIO_ALLOW_UNVERIFIED=1 run_install "$SCRATCH/sums-404-optout.log" --version 9.9.9
assert_code "and the same 404 installs under the documented override" "$?" "0"
mv "$SCRATCH/sums.real" "$FIX/SHA256SUMS.txt"

# ---------------------------------------------------------------- 16: redirect discipline
# Every lane that reads a release asset has to follow the redirect GitHub answers there —
# the asset, its manifest and its signature. The stub answers 302 for any `/releases/download/`
# request that did not ask for `-L`, so this run is green only while all three fetches follow
# redirects; drop `-L` from the signature fetch and test 3 plus this one both go red, which is
# the shape the shipped installer had (it refused its own correctly signed releases).
grep -q -- "--location" "$INSTALL_SH" && pass "install.sh fetches the asset following redirects" || fail "install.sh no longer follows redirects for the asset"
grep -q 'curl -sSL -o "$sums"' "$INSTALL_SH" && pass "install.sh fetches the manifest following redirects" || fail "install.sh no longer follows redirects for SHA256SUMS.txt"
grep -q 'curl -sSL -o "$asc"' "$INSTALL_SH" && pass "install.sh fetches the signature following redirects" || fail "install.sh no longer follows redirects for the .asc"

# ---------------------------------------------------------------- 17: a truncated asset download
# The maintainer machine's TLS-intercepting proxy breaks big HTTP/2 streams mid-transfer
# (`server: WattToolkit`, curl exit 92 after a few hundred KB of a ~47 MB asset). Measured against
# the published v0.7.6 asset, the single-attempt installer printed `download failed: <url>` — true,
# and useless: no retry, no cause, no next action for an agent to take. This scenario drives the
# same shape through the stub: a transport error with a *code*, no HTTP status involved.
SCENARIO_CURL_ASSET_FAIL=92 run_install "$SCRATCH/asset-truncated.log" --version 9.9.9
assert_code "a mid-stream download failure refuses the install" "$?" "1"
assert_has "the message carries curl's own exit code, not a made-up one" "$SCRATCH/asset-truncated.log" "download failed (curl exit 92)"
assert_has "and quotes what curl actually said" "$SCRATCH/asset-truncated.log" "PROTOCOL_ERROR"
assert_has "it names the HTTP/1.1 way around an intercepting proxy" "$SCRATCH/asset-truncated.log" "--http1.1"
assert_has "it names the checksum manifest to verify a hand-fetched asset against" "$SCRATCH/asset-truncated.log" "SHA256SUMS.txt"
assert_has "and it offers the other channel instead of dead-ending" "$SCRATCH/asset-truncated.log" "npm install -g"
assert_not_has "nothing is installed on that path" "$SCRATCH/asset-truncated.log" "[OK]    installed via"
SCENARIO_CURL_ASSET_FAIL=""
grep -q -- "--retry-all-errors" "$INSTALL_SH" && pass "install.sh retries a transient download" || fail "install.sh no longer retries the asset fetch"
grep -q -- "--continue-at" "$INSTALL_SH" && pass "install.sh resumes instead of restarting a partial download" || fail "install.sh no longer resumes with --continue-at"
run_install "$SCRATCH/after-truncated.log" --version 9.9.9
assert_code "the same run is green again once the transport stops failing" "$?" "0"

# ---------------------------------------------------------------- 18: HTTP 200 that is not a manifest
# A mirror, a captive portal, or a re-signed TLS chain can answer the manifest URL with 200 and
# an HTML body. That is not "the release carries no manifest": the bytes simply are not a
# manifest, and the old code read the parse failure as a coverage gap and installed the asset
# with no integrity check at all. The distinction is the whole point of the lane.
cp "$FIX/SHA256SUMS.txt" "$SCRATCH/sums.real"
printf '<!DOCTYPE html><html><head><title>Sign in</title></head><body>log in first</body></html>\n' > "$FIX/SHA256SUMS.txt"
run_install "$SCRATCH/sums-html.log" --version 9.9.9
assert_code "a 200 that is not a checksum manifest refuses the install" "$?" "1"
assert_has "and says the manifest could not be parsed" "$SCRATCH/sums-html.log" "is not a checksum manifest"
assert_not_has "it never calls a rewritten response a missing file" "$SCRATCH/sums-html.log" "no SHA256SUMS.txt published"
assert_not_has "and nothing is installed on that path" "$SCRATCH/sums-html.log" "[OK]    installed via"

# ---------------------------------------------------------------- 19: a real manifest that omits this asset
# The mirror image: well-formed bytes, one valid `<64 hex>  ./other.zip` line, and our asset not
# in it. The release lane now refuses to publish a manifest whose asset set is not exactly the
# product's target matrix, so an omission here means the bytes in front of us are not the bytes
# that release carries — that is a refusal, not a skip.
printf '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  ./glasspane-harness-other-asset.zip\n' > "$FIX/SHA256SUMS.txt"
run_install "$SCRATCH/sums-unlisted.log" --version 9.9.9
assert_code "a parsed manifest that does not list the asset refuses the install" "$?" "1"
assert_has "and names the asset it could not find" "$SCRATCH/sums-unlisted.log" "does not list glasspane-harness-darwin-arm64.zip"
assert_not_has "it does not dress the refusal up as a skipped check" "$SCRATCH/sums-unlisted.log" "sha256: skipped"
assert_not_has "and nothing is installed" "$SCRATCH/sums-unlisted.log" "[OK]    installed via"
cp "$SCRATCH/sums.real" "$FIX/SHA256SUMS.txt"
run_install "$SCRATCH/after-unlisted.log" --version 9.9.9
assert_code "the same run is green again once the real manifest is back" "$?" "0"

echo ""
if [ "$FAILURES" -gt 0 ]; then
  echo "installer-selftest: $FAILURES check(s) failed"
  exit 1
fi
echo "installer-selftest: all checks held"
exit 0
