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
printf '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "glasspane-harness 9.9.9"; exit 0; fi\nexit 0\n' > "$ASSET_DIR/glasspane-harness"
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
# curl answers from $FIX by basename; anything unmapped fails like a 404 (exit 22), which
# is how "the release did not publish that file" reaches the installer.
cat > "$STUB/curl" <<'STUBCURL'
#!/usr/bin/env bash
out=""
url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    --progress-bar|-fsSL|-fL|-sS|-L|-f|--fail) shift ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
[ -n "$url" ] || exit 2
base="$(basename "$url")"
[ -n "$out" ] || { cat "$FIX_DIR/$base" 2>/dev/null && exit 0 || exit 22; }
if [ -f "$FIX_DIR/$base" ]; then cp "$FIX_DIR/$base" "$out"; exit 0; fi
exit 22
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
if [ "${1:-}" = "--import" ] || printf '%s' "$*" | grep -q -- "--import"; then exit 0; fi
if [ "$STUB_GPG_RESULT" = "good" ]; then
  echo "gpg: Signature made Thu 01 Jan 2026 00:00:00 UTC" >&2
  echo "[GNUPG:] GOODSIG ABCDEF0123456789 jingzhao-l (sign-github)" >&2
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
assert_has "the summary reports GPG as verified" "$SCRATCH/verify-ok.log" "GPG: verified (signing key)"

# ---------------------------------------------------------------- 4: a mismatch refuses
cp "$FIX/glasspane-harness-darwin-arm64.zip" "$SCRATCH/keep.zip"
printf 'appended byte\n' >> "$FIX/glasspane-harness-darwin-arm64.zip"
run_install "$SCRATCH/verify-bad.log" --version 9.9.9
assert_code "a checksum mismatch refuses to install" "$?" "1"
assert_has "the refusal names the mismatch" "$SCRATCH/verify-bad.log" "checksum mismatch"
mv "$SCRATCH/keep.zip" "$FIX/glasspane-harness-darwin-arm64.zip"

# ---------------------------------------------------------------- 5: no manifest at all
# The claim must degrade with the evidence, not with the intent.
mv "$FIX/SHA256SUMS.txt" "$SCRATCH/SHA256SUMS.txt.hold"
run_install "$SCRATCH/no-sums.log" --version 9.9.9
assert_code "the installer still completes when the release carries no manifest" "$?" "0"
assert_not_has "with no SHA256SUMS.txt it does not claim sha256 verified" "$SCRATCH/no-sums.log" "sha256: verified"
assert_has "it says the checksum was skipped and why" "$SCRATCH/no-sums.log" "sha256: skipped (no SHA256SUMS.txt published for v9.9.9)"
assert_has "and it warns that the bytes were not fully verified" "$SCRATCH/no-sums.log" "not fully verified"
mv "$SCRATCH/SHA256SUMS.txt.hold" "$FIX/SHA256SUMS.txt"

# ---------------------------------------------------------------- 6: a failed signature
# Under `set -e` the old `out="$(gpg --verify …)"` killed the script here, so the warning,
# the state and the temp-dir cleanup below it were all unreachable.
SCENARIO_GPG=bad
run_install "$SCRATCH/gpg-bad.log" --version 9.9.9
assert_code "a bad signature does not abort the installer" "$?" "0"
assert_has "a bad signature is reported as FAILED, not as verified" "$SCRATCH/gpg-bad.log" "GPG: FAILED (signature did not verify)"
assert_has "the checksum result is still stated" "$SCRATCH/gpg-bad.log" "sha256: verified (SHA256SUMS.txt)"
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
mv "$FIX/SHA256SUMS.txt" "$SCRATCH/s.hold"
mv "$FIX/glasspane-harness-darwin-arm64.zip.asc" "$SCRATCH/a.hold"
run_install "$SCRATCH/unverified.log" --version 9.9.9
assert_code "the installer still installs an unsigned, unmanifested release" "$?" "0"
assert_not_has "it never prints the unconditional verified claim" "$SCRATCH/unverified.log" "sha256 + GPG verified"
assert_has "it prints both skipped states" "$SCRATCH/unverified.log" "sha256: skipped"
mv "$SCRATCH/s.hold" "$FIX/SHA256SUMS.txt"
mv "$SCRATCH/a.hold" "$FIX/glasspane-harness-darwin-arm64.zip.asc"

echo ""
if [ "$FAILURES" -gt 0 ]; then
  echo "installer-selftest: $FAILURES check(s) failed"
  exit 1
fi
echo "installer-selftest: all checks held"
exit 0
