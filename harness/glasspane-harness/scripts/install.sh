#!/usr/bin/env bash
# glasspane-harness one-click installer
#
#   curl -fsSL https://raw.githubusercontent.com/jingzhao-l/glasspane-harness/v0.9.0/scripts/install.sh | bash
#   bash scripts/install.sh                 # install (npm first, GitHub release asset as fallback)
#   bash scripts/install.sh --dry-run       # print the plan, touch nothing
#   bash scripts/install.sh --version 0.1.0 # pin a version
#
# The one-liner above is the documented *moving* entry point (it is product.json's `install.curl`, and
# only its owner may change it). Everything this script prints back to the user is different in kind:
# once a version is in hand — given or resolved — the installer URL names that tag, because this script
# is the thing that verifies the binary and a remedy on a mutable branch hands the verifier to whoever
# can push that branch.
#
# Mirrors the iterate-ecosystem installer shape (banner, OS detection, dependency
# check, install, verify, next steps) and reads its identity from product.json at
# the repo root; harness/tools/product-surface.mjs keeps the URLs here in step with
# that file, so renaming the product cannot leave a stale download URL behind.
set -euo pipefail

PRODUCT="glasspane-harness"
VERSION=""
REPO="jingzhao-l/glasspane-harness"
DRY_RUN=0
HELP=0
INSTALL_ROOT="${GLASSPANE_HARNESS_HOME:-$HOME/.glasspane-harness}"
# Allow a fork/mirror to be installed from by pinning the source explicitly.
NPM_PACKAGE="${GLASSPANE_HARNESS_NPM:-$PRODUCT}"
# The npm lane names its registry, same rule as the wrapper's postinstall
# (packages/opencode/script/postinstall.mjs pins --registry for the platform package it
# downloads AND executes): npm otherwise resolves the registry from npm_config_registry,
# the environment, ~/.npmrc or a project .npmrc, so an ambient mirror decides which bytes
# get installed. The literal is kept in step with product.json's `registry` by
# harness/tools/product-surface.mjs (rule installer-registry).
NPM_REGISTRY="${GLASSPANE_HARNESS_REGISTRY:-https://registry.npmjs.org}"
RELEASE_BASE="${GLASSPANE_HARNESS_RELEASES:-https://github.com/$REPO/releases/download}"
# Where this script is published, kept in step with product.json's `install.curl` by
# harness/tools/product-surface.mjs. It is a variable rather than prose because the refusals
# below print it as the command the user is told to run: a remedy that does not install is not
# a remedy, and the version this run was asked for is data the refusal already holds.
#
# The ref is DERIVED, never hardcoded to a moving branch. `main` is only the pre-version default:
# as soon as a concrete version is in hand — given by `--version`, or resolved from the releases
# API — the printed URL points at `vX.Y.Z`. The reason is that this script is the thing that
# verifies the binary, so whoever can push to `main` of this repository controls the verifier the
# user is told to re-run; the parent repository's release lane states the same rule for its own
# installers ("pin to the ref being released, never to `main`"). One honest exception stays: with
# no version resolved at all (the npm lane, no `--version`), there is no tag to name yet, and the
# URL then printed is labelled as the moving default rather than silently presented as reproducible.
INSTALLER_BASE="https://raw.githubusercontent.com/$REPO"
INSTALLER_REF="main"
INSTALLER_URL="$INSTALLER_BASE/$INSTALLER_REF/scripts/install.sh"
pin_installer_url() {
  # $1 = the concrete version this run resolved (without the leading `v`), empty when nothing is known.
  if [ -n "${1:-}" ]; then
    INSTALLER_REF="v$1"
  else
    INSTALLER_REF="main"
  fi
  INSTALLER_URL="$INSTALLER_BASE/$INSTALLER_REF/scripts/install.sh"
}
# "No SHA256SUMS.txt / no .asc was published for this release" used to be a warning the
# installer talked itself past and then installed anyway. That tolerance is not ours to
# grant: the release lane publishes both files for every target and fails the run if either
# is missing, so a 404 on a release asset means the release in front of us is incomplete —
# a half-built `binaries` matrix, a tag cut from a different tree, or somebody's asset
# deleted after the fact. Installing unverified bytes because the manifest was absent is the
# failure this channel was written to prevent, so the default is now refusal, and the
# override says who chose it.
ALLOW_UNVERIFIED="${GLASSPANE_HARNESS_ALLOW_UNVERIFIED:-}"

# ------------------------------------------------------------------ colors
if [ -t 1 ]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; BLUE=''; CYAN=''; BOLD=''; RESET=''
fi
info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*" >&2; }
step()    { echo -e "\n${BOLD}${BLUE}==>${RESET}${BOLD} $*${RESET}"; }

# ------------------------------------------------------------------ arguments
# `for arg in "$@"` with a `shift` inside it cannot consume a value argument: the loop
# iterates the list captured when it started, so `--version 0.1.0` set VERSION, then
# fell around to the next iteration and died on "Unknown argument: 0.1.0" — the form the
# header of this file documents. Positional consumption needs a while/$# loop.
# `--help` used to print itself with `sed -n '2,10p' "$0"`, which cannot work through
# `curl ... | bash`, where $0 is `bash` and not this script.
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --version)
      shift
      [ $# -gt 0 ] && [ -n "${1:-}" ] || { error "--version needs a value"; exit 1; }
      VERSION="$1"
      ;;
    --version=*) VERSION="${1#--version=}" ;;
    # Answered after the loop, not inside it: `--help --version X.Y.Z` has to print the URL of the
    # version the same command line asked for, and a loop that reads argv left to right cannot know a
    # `--version` that comes after `--help`.
    --help|-h) HELP=1 ;;
    *) error "Unknown argument: $1 (try --help)"; exit 1 ;;
  esac
  shift
done

# From here on every URL this script prints for itself is named after the version in hand.
pin_installer_url "$VERSION"

if [ "$HELP" = "1" ]; then
  cat <<USAGE
glasspane-harness installer

  bash scripts/install.sh                  install (npm first, GitHub release asset as fallback)
  bash scripts/install.sh --dry-run        print the plan, touch nothing
  bash scripts/install.sh --version 0.1.0  pin a version (also --version=0.1.0)

Environment:
  GLASSPANE_HARNESS_HOME      fallback install root (default \$HOME/.glasspane-harness)
  GLASSPANE_HARNESS_NPM       npm package to install (default glasspane-harness)
  GLASSPANE_HARNESS_REGISTRY  npm registry for the install lane (default https://registry.npmjs.org)
  GLASSPANE_HARNESS_RELEASES  base URL for release assets (default this repo's releases)
  GLASSPANE_HARNESS_ALLOW_UNVERIFIED
                             set to 1 to install even when the release publishes no
                             SHA256SUMS.txt or no .asc, or when gpg is not on PATH
                             (default: refuse)
                             On the curl one-liner the override has to be set for the shell
                             that reads the script, not for curl:
                               curl -fsSL $INSTALLER_URL | GLASSPANE_HARNESS_ALLOW_UNVERIFIED=1 bash
USAGE
  exit 0
fi

# ------------------------------------------------------------------ banner
echo ""
echo -e "${BOLD}${CYAN}┌───────────────────────────────────────────────────────────┐${RESET}"
echo -e "${BOLD}${CYAN}│  GlassPane Harness                                          │${RESET}"
echo -e "${BOLD}${CYAN}│  evidence-honest GUI verification for macOS apps           │${RESET}"
echo -e "${BOLD}${CYAN}│  an opencode fork — https://github.com/anomalyco/opencode  │${RESET}"
echo -e "${BOLD}${CYAN}└───────────────────────────────────────────────────────────┘${RESET}"
echo ""
info "GlassPane Harness — evidence-honest GUI verification for macOS apps"
[ -n "$VERSION" ] && info "requested version: $VERSION"

# ------------------------------------------------------------------ platform
step "Detecting platform"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
MACHINE="$(uname -m)"
# `uname -m` and npm's architecture vocabulary are not the same string: an Intel Mac
# reports `x86_64` while the release asset and product.json both say `x64`. There was no
# mapping here, so the fallback path — the one channel that exists when npm is absent —
# refused the very architecture this product ships for, on the same line that promised
# "this product ships darwin-arm64 and darwin-x64".
case "$MACHINE" in
  arm64 | aarch64) ARCH="arm64" ;;
  x86_64 | amd64) ARCH="x64" ;;
  *)
    error "Unsupported macOS architecture: $MACHINE (this product ships darwin-arm64 and darwin-x64)"
    exit 1
    ;;
esac
case "$OS" in
  darwin)
    PLATFORM="darwin-$ARCH"
    ;;
  *)
    # macOS-only is a product decision (the engine, the permission model and the
    # evidence pipeline are macOS), not a missing port: there is no Linux or
    # Windows build and there will not be one. Say exactly that instead of
    # "unsupported OS".
    error "glasspane-harness is macOS-only (the GlassPane engine and its evidence pipeline exist only on macOS)."
    error "This machine reports $OS — there is no build for it, by decision, not by omission."
    exit 1
    ;;
esac
info "platform: $PLATFORM"

# ------------------------------------------------------------------ plan
step "Install plan"
NPM_SPEC="$NPM_PACKAGE${VERSION:+@$VERSION}"
if [ "$VERSION" = "" ]; then
  info "1) npm:  $NPM_SPEC        (registry: $NPM_REGISTRY; preferred: platform selection and updates are npm's job)"
  # "latest" is an API pointer, not an install target: it is resolved to one concrete tag before
  # anything is downloaded, and every fetch after that — asset, SHA256SUMS.txt, .asc — addresses that
  # tag. Without this the checksum manifest would be read from whatever the moving pointer named at
  # the moment each file happened to be fetched.
  info "2) release asset fallback: the releases API is asked for one concrete tag, which is printed before any download; the asset, its SHA256SUMS.txt and its .asc are then read from that tag only"
else
  info "1) npm:  $NPM_SPEC        (registry: $NPM_REGISTRY; preferred: platform selection and updates are npm's job)"
  info "2) release asset fallback: $RELEASE_BASE/v$VERSION/$PRODUCT-$PLATFORM.zip (checks sha256 against SHA256SUMS.txt, GPG against the asset's .asc)"
  info "   installer to re-run if this refuses: $INSTALLER_URL (tagged at v$VERSION, not a moving branch)"
fi
info "   install root (fallback path only): $INSTALL_ROOT/bin"
if [ "$DRY_RUN" = "1" ]; then
  success "dry run — nothing was installed. Re-run without --dry-run to install."
  exit 0
fi

# ------------------------------------------------------------------ install (npm first)
step "Installing via npm"
if command -v npm >/dev/null 2>&1; then
  # npm >= 11 gates lifecycle scripts and prints an `allow-scripts` warning for
  # packages it has not seen before. Measured on the first real install of this
  # product: the warning appeared and the install still worked — but a global
  # prefix the user cannot write to fails the install outright (EACCES), so the
  # retry below covers both real failure modes instead of assuming either.
  # The success line carries its verification state, same shape as the release-asset line
  # below: this channel ran NO sha256/GPG check itself — npm's tarball hash against the
  # pinned registry's metadata is the only integrity evidence here, and the verify step
  # further down proves the command runs, not where the bytes came from. Saying
  # "installed via npm" alone manufactured confidence this installer did not earn.
  if npm install -g --registry "$NPM_REGISTRY" "$NPM_SPEC"; then
    INSTALLED_VIA="npm ($NPM_SPEC from $NPM_REGISTRY; sha256/GPG: not checked on this channel)"
  elif npm install -g --registry "$NPM_REGISTRY" --allow-scripts="$NPM_PACKAGE" "$NPM_SPEC" 2>/dev/null; then
    INSTALLED_VIA="npm ($NPM_SPEC from $NPM_REGISTRY, scripts allowed; sha256/GPG: not checked on this channel)"
  else
    warn "npm install failed (global prefix not writable? try: npm install -g --prefix \"\$HOME/.local\" $NPM_SPEC)"
    INSTALLED_VIA=""
  fi
else
  warn "npm not found on PATH — using the GitHub release asset instead"
  INSTALLED_VIA=""
fi

# ------------------------------------------------------------------ GPG verify (release asset provenance)
# Release signing key (GPG). GPG verifies SOURCE identity: the release pipeline
# publishes a detached signature next to every asset as `<asset>.asc`, and verifying
# it proves the tarball came from this key, not just that its SHA-256 is intact
# (content integrity is still the checksum's job).
#
# The policy splits by what each state actually says, and the split is the point:
#   - no `.asc` published at all  -> a POLICY GAP, and the 0.6.4 decision was "warn and
#     continue". That tolerance now needs the override to be named: an unsigned release is not
#     evidence of tampering, but the release lane signs every asset and fails the run if a
#     signature is missing, so its absence describes an incomplete or replaced release.
#   - no `gpg` on the machine -> a REFUSAL, not a skip. Stock macOS ships no GnuPG, so the
#     skip was the default state on every fresh machine, and the only check left standing was
#     SHA256SUMS.txt — fetched from the same origin as the asset it lists. A missing tool is
#     installable (`brew install gnupg`); a missing signature is not, so this is the same
#     class as the missing-manifest refusal below, and `GLASSPANE_HARNESS_ALLOW_UNVERIFIED=1`
#     is the only way through it.
#   - `.asc` there but it does not verify, or it verifies under a DIFFERENT key
#     fingerprint  -> a TAMPERING SIGNAL. Refuse. The only other check in this path is
#     SHA256SUMS.txt, fetched from the same origin as the asset it lists, so both
#     vouchings come from one source; a signature that fails to verify is the single
#     piece of evidence that cannot be produced by that same source.
#   - `.asc` could not be fetched for a reason that is not "it isn't there" (TLS
#     interception, 403, a rewritten response) -> NOT the same as unsigned. Refuse.
#     Collapsing that into "no .asc published" would let a blocked signature fetch buy
#     an unverified install with a reassuring word for it.
#
# The fingerprint is data here, not prose: a comment naming a key has never verified
# anything, and `GOODSIG` alone is satisfied by whichever key made the signature.
GLASSPANE_HARNESS_SIGNING_FPR="0929EA31DF4F7429F63FC53189D88B1D043A1298"
GLASSPANE_HARNESS_SIGNING_PUBLIC_KEY="$(cat <<'PGPKEY'
-----BEGIN PGP PUBLIC KEY BLOCK-----

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
YVXa4IEQs7aBxKO+n+T2AvUYiKQ=
=DYXk
-----END PGP PUBLIC KEY BLOCK-----
PGPKEY
)"

GPG_STATE="not-run"
SHA_STATE="not-run"

remedy_unverified() {
  # Print the ONE command that carries the override to the shell that actually reads this
  # script.
  #
  # Until 2026-10-16 every refusal here printed
  #   GLASSPANE_HARNESS_ALLOW_UNVERIFIED=1 curl -fsSL <install.sh> | bash
  # A leading assignment applies to `curl` alone, so the piped `bash` never had the variable in
  # its environment: a user who followed the printed advice verbatim was refused again, by the
  # same line, with the same advice. The assignment has to sit on the far side of the pipe, and
  # the version this run was asked for has to travel with it — `bash -s --` is how a piped
  # script takes arguments. `installer-selftest.sh` runs the printed line back through the
  # stubbed release, so this shape cannot silently rot again.
  error "refusing to install. If you accept that risk for this run, re-run with the override on"
  error "the shell that reads the script (a VAR=1 before curl does NOT reach a piped bash):"
  # The command itself carries no `[ERROR]` prefix: a remedy an agent is meant to run has to be
  # copy-pasteable as it is printed. It goes to the same stream as the refusal above it, so the
  # two cannot be separated by a redirect.
  echo "  curl -fsSL $INSTALLER_URL | GLASSPANE_HARNESS_ALLOW_UNVERIFIED=1 bash -s -- --version $VERSION" >&2
}

verify_asset_gpg() {
  # Verify the release-asset fallback's archive against its `$ASSET.asc` sidecar.
  # Uses a throwaway GNUPGHOME holding only the signing key, then discards it —
  # the user's real keyring and its trust model are never touched.
  #
  # All three inputs arrive as arguments. This used to read the globals `$ASSET`
  # and `$URL` instead, which meant the function silently depended on the caller's
  # variable naming: called with a URL that was not in `$URL`, it died on
  # `URL: unbound variable` under `set -u` rather than verifying anything.
  local file="$1" name="$2" url="$3"
  local asc="$TMP/$name.asc" gnupg out rc=0 http fpr
  info "verifying release asset GPG signature"
  if ! command -v gpg >/dev/null 2>&1; then
    # This used to warn, set GPG_STATE="skipped (gpg not on PATH)" and `return 0` — which
    # switched the provenance control off on precisely the machines that need it, because stock
    # macOS ships no GnuPG. What survives that skip is SHA256SUMS.txt, fetched from the same
    # origin as the asset it lists, i.e. one source vouching for itself (see the policy note
    # above the key). A missing tool is installable, so the refusal names the install and the
    # override, same shape as the missing-manifest refusal below.
    if [ "$ALLOW_UNVERIFIED" = "1" ]; then
      GPG_STATE="skipped by GLASSPANE_HARNESS_ALLOW_UNVERIFIED=1 (gpg is not installed)"
      warn "gpg is not on PATH — skipping release asset GPG provenance because GLASSPANE_HARNESS_ALLOW_UNVERIFIED=1"
      return 0
    fi
    GPG_STATE="FAILED (gpg is not installed)"
    error "gpg is not on PATH — this release asset's provenance cannot be established at all"
    error "integrity alone does not say who produced these bytes: the only other check here is SHA256SUMS.txt, fetched from the same origin as the asset it lists."
    error "install the tool and re-run: brew install gnupg"
    remedy_unverified
    exit 1
  fi
  # The status code is read from curl, not inferred from a non-zero exit: `-f` folds
  # "not published", "blocked by the network", and "answered with something else" into
  # one failure, and only the first of those is a policy gap we agree to tolerate.
  # `|| true` rather than `|| echo 000`: curl prints the code it got *and* fails, so the
  # fallback would append to it and produce a status like `404000` — a made-up value fed
  # into the comparison that is supposed to be about the real one.
  # `-L` is load-bearing, not decoration. GitHub's `/releases/download/` URLs answer 302
  # and hand the bytes from `objects.githubusercontent.com` (measured against the published
  # v0.7.1 asset: 302 without `-L`, 200 with it). Without it the status read below is 302,
  # which is neither 404 nor 200 — so a correctly signed release from this very repository
  # was refused as "the provenance check could not be run" on every machine that has gpg
  # installed. The asset and the manifest both followed redirects; only the signature did
  # not, which made the fallback channel unusable exactly where its one job (provenance)
  # could be done.
  http="$(curl -sSL -o "$asc" -w '%{http_code}' "$url.asc" 2>/dev/null || true)"
  [ -n "$http" ] || http="000"
  if [ "$http" = "404" ]; then
    if [ "$ALLOW_UNVERIFIED" = "1" ]; then
      GPG_STATE="skipped by GLASSPANE_HARNESS_ALLOW_UNVERIFIED=1 (no .asc published for this asset)"
      warn "no GPG signature sidecar ($name.asc) published for this release — installing anyway because GLASSPANE_HARNESS_ALLOW_UNVERIFIED=1"
      return 0
    fi
    GPG_STATE="FAILED (no .asc published for this asset)"
    error "no GPG signature sidecar ($name.asc) is published for this release"
    error "this product's release lane signs every asset and fails the run if a signature is missing, so an unsigned release is an incomplete or replaced one."
    remedy_unverified
    exit 1
  fi
  if [ "$http" != "200" ] || [ ! -s "$asc" ]; then
    GPG_STATE="FAILED (could not fetch the signature: HTTP $http)"
    error "the signature for $name could not be fetched (HTTP $http) — this is not the same as it being unpublished"
    error "refusing to install bytes whose provenance check could not be run. Re-run, or fetch $url.asc yourself and verify it."
    exit 1
  fi
  gnupg="$(mktemp -d)"
  chmod 700 "$gnupg"
  # `set -e` + a bare pipeline here meant an import failure ended the whole installer
  # with nothing but gpg's raw stderr on screen, and the throwaway keyring created above
  # stayed on disk: the `rm -rf "$gnupg"` further down was already unreachable. Every
  # exit path from here on removes it.
  if ! printf '%s' "$GLASSPANE_HARNESS_SIGNING_PUBLIC_KEY" | GNUPGHOME="$gnupg" gpg --batch --quiet --import >/dev/null 2>&1; then
    rm -rf "$gnupg"
    GPG_STATE="FAILED (could not import the embedded signing key)"
    error "gpg could not import this product's embedded signing key — provenance cannot be established"
    error "refusing to install. Check that gpg works: gpg --version"
    exit 1
  fi
  # `out="$(gpg --verify …)"` under `set -e` ended the whole script the moment a
  # signature failed to verify: the `rc=$?` below it, the warning it was meant to print,
  # and the `rm -rf "$gnupg"` after it were all unreachable. What the user saw was gpg's
  # own stderr and a half-deleted temp dir. An assignment that must not abort the run
  # takes the branch in the `if`, not in the exit status of the substitution.
  if out="$(GNUPGHOME="$gnupg" gpg --batch --quiet --status-fd 2 --verify "$asc" "$file" 2>&1)"; then
    rc=0
  else
    rc=1
  fi
  rm -rf "$gnupg"
  # A good signature from a key that is not THE key is exactly the case `GOODSIG` cannot
  # see: the armored block above decides which key is trusted, so verify that the one
  # that made this signature is the one whose fingerprint this file names.
  fpr="$(printf '%s\n' "$out" | awk '/^\[GNUPG:\] VALIDSIG /{print toupper($3); exit}')"
  if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q GOODSIG \
    && [ "$fpr" = "$GLASSPANE_HARNESS_SIGNING_FPR" ]; then
    GPG_STATE="verified (signing key $fpr)"
    success "GPG provenance verified: release asset signature is from the signing key"
  elif [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q GOODSIG; then
    GPG_STATE="FAILED (good signature from an unexpected key: ${fpr:-no VALIDSIG line})"
    error "the signature verifies, but not under this product's signing key"
    error "  expected fingerprint $GLASSPANE_HARNESS_SIGNING_FPR"
    error "  actual fingerprint   ${fpr:-unknown}"
    error "refusing to install: a replaced key plus a replaced asset is precisely what a signature is for."
    exit 1
  else
    GPG_STATE="FAILED (signature did not verify)"
    error "release asset GPG signature did not verify: $(printf '%s\n' "$out" | head -1)"
    error "refusing to install tampering-suspect bytes. The checksum alone cannot tell a swapped asset from a faithful one."
    exit 1
  fi
  return 0
}

verify_asset() {
  # Integrity: the release publishes one `SHA256SUMS.txt` covering every asset, so
  # the download is checked against a manifest the pipeline itself produced. This is
  # the check that catches a truncated or corrupted transfer; the GPG check below is
  # the one that establishes who produced the file. Neither substitutes for the other.
  local file="$1" name="$2" sums want got http
  sums="$TMP/SHA256SUMS.txt"
  # Same discipline as the signature lane above, and the same reason: `curl -f` folds "not
  # published", "the fetch was blocked or rewritten" and "it answered with something else"
  # into one exit code, and only the first is a policy gap we agree to tolerate. This used to
  # treat *any* failure as "the release carries no manifest", warn, and install — so on a host
  # whose TLS is re-signed by a local root (this product's maintainer machine is one), a
  # blocked manifest fetch bought an entirely unverified install a specific, false explanation.
  http="$(curl -sSL -o "$sums" -w '%{http_code}' "$RELEASE_BASE/v$VERSION/SHA256SUMS.txt" 2>/dev/null || true)"
  [ -n "$http" ] || http="000"
  if [ "$http" = "404" ]; then
    if [ "$ALLOW_UNVERIFIED" = "1" ]; then
      SHA_STATE="skipped by GLASSPANE_HARNESS_ALLOW_UNVERIFIED=1 (no SHA256SUMS.txt published for v$VERSION)"
      warn "no SHA256SUMS.txt published for v$VERSION — installing anyway because GLASSPANE_HARNESS_ALLOW_UNVERIFIED=1"
      return 0
    fi
    SHA_STATE="FAILED (no SHA256SUMS.txt published for v$VERSION)"
    error "no SHA256SUMS.txt is published for v$VERSION"
    error "the release lane writes one manifest covering every target and refuses to sign an incomplete set, so a release without a manifest is not a release this installer can vouch for."
    remedy_unverified
    exit 1
  fi
  if [ "$http" != "200" ] || [ ! -s "$sums" ]; then
    SHA_STATE="FAILED (could not fetch SHA256SUMS.txt: HTTP $http)"
    error "the checksum manifest for v$VERSION could not be fetched (HTTP $http) — this is not the same as it being unpublished"
    error "refusing to install bytes that no manifest vouches for. Re-run, or fetch $RELEASE_BASE/v$VERSION/SHA256SUMS.txt yourself and compare it to the download."
    exit 1
  fi
  # A manifest only means something if it parses as one. Before this, an HTTP 200 carrying HTML
  # (a captive portal, a login page from a re-signed TLS chain, a mirror that answers everything)
  # fell straight into the "not listed" branch below: awk matched no line, the installer called
  # that a coverage gap, warned, and installed the binary with *no* integrity check. The parse
  # failure was being reported as a policy gap — the one condition this lane agrees to tolerate,
  # so the tolerance was being granted by somebody else's response.
  lines="$(grep -c '[^[:space:]]' "$sums" 2>/dev/null || true)"
  shaped="$(grep -cE '^[0-9a-f]{64}[[:space:]]' "$sums" 2>/dev/null || true)"
  [ -n "$lines" ] || lines=0
  [ -n "$shaped" ] || shaped=0
  if [ "$lines" -gt 0 ] && [ "$shaped" -ne "$lines" ]; then
    SHA_STATE="FAILED (SHA256SUMS.txt is not a checksum manifest)"
    error "SHA256SUMS.txt for v$VERSION is not a checksum manifest: $((lines - shaped)) of $lines line(s) do not match '<64 hex>  <path>' — the endpoint answered HTTP 200 with something else"
    error "refusing to install bytes whose manifest we cannot parse. Fetch it yourself and compare: $RELEASE_BASE/v$VERSION/SHA256SUMS.txt"
    exit 1
  fi
  # The manifest lists bare filenames (`./name`), so match on the name, not the path.
  want="$(awk -v n="$name" '{ sub(/^\.\//, "", $2); if ($2 == n) print $1 }' "$sums" | head -1)"
  if [ -z "$want" ]; then
    # Fatal, not a skip: the release lane now refuses to publish a manifest whose asset set is
    # not exactly the product's target matrix, so a parsed manifest that omits this asset means
    # the bytes in front of us are not the bytes that release carries.
    SHA_STATE="FAILED ($name is not listed in SHA256SUMS.txt)"
    error "SHA256SUMS.txt for v$VERSION was fetched and parses, but does not list $name"
    error "refusing to install an asset the release's own manifest does not vouch for. Check the --version you asked for, or compare $RELEASE_BASE/v$VERSION/SHA256SUMS.txt against the download yourself."
    exit 1
  fi
  if command -v shasum >/dev/null 2>&1; then
    got="$(shasum -a 256 "$file" | awk '{print $1}')"
  else
    got="$(sha256sum "$file" | awk '{print $1}')"
  fi
  if [ "$want" != "$got" ]; then
    # A checksum mismatch is not a warning: the bytes are not the bytes that were
    # published, so continuing would install something no manifest vouches for.
    SHA_STATE="FAILED (checksum mismatch)"
    error "checksum mismatch for $name"
    error "  expected $want"
    error "  actual   $got"
    error "refusing to install. Re-run, or fetch the asset manually and compare against SHA256SUMS.txt."
    exit 1
  fi
  SHA_STATE="verified (SHA256SUMS.txt)"
  success "sha256 verified against SHA256SUMS.txt"
}

# ------------------------------------------------------------------ install (release asset fallback)
if [ -z "$INSTALLED_VIA" ]; then
  step "Installing from the GitHub release asset"
  command -v curl >/dev/null 2>&1 || { error "neither npm nor curl is available; install Node.js/npm or curl and retry"; exit 1; }
  # Resolve "latest" through the releases API so the asset URL is one download, not a dance — and make
  # the answer name exactly one tag. `releases/latest` is a moving pointer; asking it is only useful if
  # every fetch after the answer is bound to the tag it gave back (asset, SHA256SUMS.txt and `.asc`),
  # so a release published mid-run cannot move the manifest under a checksum read for a different tag.
  if [ -z "$VERSION" ]; then
    API_JSON="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest")" || { error "could not query the latest release of $REPO"; exit 1; }
    TAG_NAME="$(printf '%s' "$API_JSON" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
    VERSION="${TAG_NAME#v}"
    [ -n "$VERSION" ] || { error "could not read a tag_name from the releases API — refusing to install bytes against an unnamed release"; exit 1; }
    # A tag that does not look like a version means the endpoint handed back a branch or somebody else's
    # mutable ref. Resolving it is the one step that removes the moving target, so it is checked here
    # rather than trusted downstream: the same shape test the verify step applies to the installed
    # binary's own output.
    case "$VERSION" in
      [0-9]*.[0-9]*) ;;
      *)
        error "the releases API named \"$TAG_NAME\", which is not a vX.Y.Z release tag"
        error "refusing to bind the checksum manifest to a moving ref. Ask for a version explicitly: --version X.Y.Z"
        exit 1
        ;;
    esac
    pin_installer_url "$VERSION"
    info "resolved release tag: v$VERSION"
    info "this run is bound to it: the asset, SHA256SUMS.txt and .asc are all read from $RELEASE_BASE/v$VERSION/, never from a moving latest"
  fi
  # The asset name is what `script/build.ts` uploads: `<product>-<os>-<arch>` with
  # no version in it (the tag already scopes the URL) and `.zip` for every non-Linux
  # target. Both details used to be wrong here — the installer asked for
  # `<product>-<platform>-<version>.tar.gz`, which has never existed on any release,
  # so this whole fallback path returned 404 and then claimed "download failed".
  # The tag carries the version; the filename does not.
  ASSET="$PRODUCT-$PLATFORM.zip"
  URL="$RELEASE_BASE/v$VERSION/$ASSET"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  info "downloading $URL"
  # Retried, and resumed rather than restarted. Measured on this product's own maintainer
  # machine: the local TLS-intercepting proxy (its header answers `server: WattToolkit`) breaks
  # the ~47 MB asset stream mid-transfer, and curl leaves with exit 92
  # (`HTTP/2 stream 1 was not closed cleanly: PROTOCOL_ERROR`) after 473 KB. A first-byte
  # failure and a mid-stream truncation are the same class — the bytes are not all there — and
  # the old single attempt turned them into `download failed: <url>` with nothing to do about it.
  # `-C -` matters as much as `--retry`: resuming keeps a flaky 47 MB download from having to
  # start over on every attempt.
  curl_args="--fail --location --retry 5 --retry-all-errors --retry-delay 2 --continue-at -"
  # `if ! curl …; then rc=$?` reads the *negated* status — 0 — so the code this message exists
  # to report would be wrong on every failure. Capture first, judge after, same shape as the
  # gpg call above.
  dlc=0
  curl $curl_args --progress-bar -o "$TMP/$ASSET" "$URL" 2>"$TMP/download.err" || dlc=$?
  if [ "$dlc" -ne 0 ]; then
    err="$(tr '\r' '\n' < "$TMP/download.err" | grep -v '^[[:space:]]*[#=-]*[[:space:]]*[0-9.]*%*$' | grep -v '^[[:space:]]*$' | head -1)"
    error "download failed (curl exit $dlc): $URL"
    [ -n "$err" ] && error "  curl said: $err"
    error "  Remedy: retry the same command (a truncated stream is usually transient), or fetch it over"
    error "    HTTP/1.1 — a TLS-intercepting proxy on this network may break HTTP/2 asset streams:"
    error "    curl --http1.1 -fL -o /tmp/$ASSET $URL"
    error "  Then verify it yourself before installing: compare against $RELEASE_BASE/v$VERSION/SHA256SUMS.txt"
    error "  Or take the npm channel instead: npm install -g $NPM_PACKAGE@$VERSION"
    exit 1
  fi

  verify_asset "$TMP/$ASSET" "$ASSET"
  verify_asset_gpg "$TMP/$ASSET" "$ASSET" "$URL"

  mkdir -p "$INSTALL_ROOT/bin"
  unzip -oq "$TMP/$ASSET" -d "$INSTALL_ROOT/bin" || { error "could not unpack $ASSET"; exit 1; }
  chmod +x "$INSTALL_ROOT/bin/$PRODUCT" 2>/dev/null || true
  if [ ! -x "$INSTALL_ROOT/bin/$PRODUCT" ]; then
    error "$ASSET did not contain an executable named $PRODUCT — refusing to claim an install"
    exit 1
  fi
  # The claim is built from what actually happened, not from what the script intends.
  # This line used to read "sha256 + GPG verified" unconditionally, while four separate
  # states above it (no SHA256SUMS.txt, the asset not listed, no gpg, no .asc) each
  # continued the install after a bare warning. A user who ended up with an
  # entirely-unverified binary still read a green `[OK] installed via … verified`, which
  # is the one thing this installer must never do: manufacture confidence it did not earn.
  # (A 2026-10-14 edit to the npm channel above briefly rewrote this line back to a literal
  # "sha256: verified; GPG: verified" while `$SHA_STATE`/`$GPG_STATE` still carried the real
  # states; `installer-selftest.sh` went red on 10 named checks for exactly that reason.)
  INSTALLED_VIA="release asset ($ASSET; sha256: $SHA_STATE; GPG: $GPG_STATE)"
  case "$SHA_STATE/$GPG_STATE" in
    verified*/*verified*) ;;
    *) warn "the installed bytes were not fully verified — see the two states in the line above" ;;
  esac
  case ":$PATH:" in
    *":$INSTALL_ROOT/bin:"*) ;;
    *) warn "$INSTALL_ROOT/bin is not on your PATH — add it:"; echo "     export PATH=\"$INSTALL_ROOT/bin:\$PATH\"" ;;
  esac
fi

# ------------------------------------------------------------------ verify
step "Verifying"
# This block used to be a green light with nothing behind it. It resolved
# `command -v $PRODUCT` — i.e. whichever copy happened to be first on PATH, which on a
# machine with an older install is not the bytes this run just installed — then ran
# `"$BIN" --version 2>&1 | head -1` under `|| true`. The pipeline's status is `head`'s,
# and even that was discarded, so the placeholder binary that npm leaves when it blocks a
# lifecycle script (it prints an apology to stderr and exits 1) rendered as:
#     [OK]    glasspane-harness --version -> Error: … postinstall script was not run.
# and the installer exited 0. The status now comes from the command itself, and the
# artifact checked is the one this channel wrote.
BIN=""
case "$INSTALLED_VIA" in
  npm*)
    NPMPREFIX="$(npm prefix -g 2>/dev/null || true)"
    [ -n "$NPMPREFIX" ] && BIN="$NPMPREFIX/bin/$PRODUCT"
    ;;
esac
[ -n "$BIN" ] || BIN="$INSTALL_ROOT/bin/$PRODUCT"
if [ ! -x "$BIN" ]; then
  error "$PRODUCT is not where this install put it ($BIN) — installed via ${INSTALLED_VIA:-nothing}"
  error "  Remedy: re-run the channel directly and read its own output; do not trust a command found elsewhere on PATH."
  exit 1
fi
# The exit status is taken in the `if`, exactly as the gpg call above does it. Both the
# `|| true` and the `| head -1` in the old line threw that status away — and the nested
# `$( (cmd) )` form that "fixes" it is not parseable by the bash 3.2 macOS still ships.
if VERSION_OUT="$("$BIN" --version 2>&1)"; then VERSION_RC=0; else VERSION_RC=$?; fi
# First line only. `${VAR%%$'\n'*}` is the clever form and bash 3.2 (the bash macOS still
# ships) cannot parse `$'\n'` inside a double-quoted expansion — it leaves the quote open
# to end of file. The pipeline's status is not being read here: VERSION_RC above is the
# exit code of the command itself, which is the thing that used to be lost.
VERSION_FIRST="$(printf '%s\n' "$VERSION_OUT" | head -1)"
if [ "$VERSION_RC" -ne 0 ]; then
  error "$PRODUCT --version exited $VERSION_RC — the command that was installed does not run"
  printf '%s\n' "$VERSION_OUT" | sed 's/^/    /' >&2
  error "  If that is the placeholder ('postinstall script was not run'), npm gated the lifecycle script. Remedy:"
  error "    npm install -g --allow-scripts=$PRODUCT ${NPM_SPEC:-$PRODUCT}"
  # Not `bash $0`: through `curl … | bash` $0 is the word `bash`, so the printed remedy was
  # `bash bash` — the same class of broken advice the refusals above used to print.
  # The URL is the one pinned to the version this run resolved, so the verifier the user is sent to is
  # the bytes under that tag rather than whatever `main` points at today. With no version resolved at
  # all (the npm lane, no `--version`), there is no tag to name — so a template is printed instead of
  # quietly offering the moving branch as if it were reproducible.
  if [ -n "$VERSION" ]; then
    error "  Or install the release asset instead (installer tagged at v$VERSION): curl -fsSL $INSTALLER_URL | bash"
  else
    error "  Or install a tagged release yourself: curl -fsSL $INSTALLER_BASE/vX.Y.Z/scripts/install.sh | bash -s -- --version X.Y.Z"
    error "    (this run resolved no tag, so the branch default \"$INSTALLER_REF\" is not offered as a reproducible command)"
  fi
  exit 1
fi
case "$VERSION_FIRST" in
  [0-9]*.[0-9]*) ;;
  *)
    error "$PRODUCT --version printed something that is not a version: '$VERSION_FIRST'"
    exit 1
    ;;
esac
if [ -n "$VERSION" ] && [ "$VERSION_FIRST" != "$VERSION" ]; then
  error "installed command reports $VERSION_FIRST, but this installer asked for $VERSION"
  exit 1
fi
success "installed via $INSTALLED_VIA"
success "$PRODUCT --version -> $VERSION_FIRST"

# ------------------------------------------------------------------ next steps (the part a generic installer cannot know)
step "Next steps"
cat <<EOF
1. The gp_* tool surface talks to the GlassPane engine, so the engine has to be
   running: install GlassPane first (https://github.com/jingzhao-l/GlassPane) and
   grant Accessibility. Without it every gp_* call answers GP_E_ENGINE_UNREACHABLE
   with a remedy — that is the engine's word, not this installer's.
2. Start the terminal UI:          $PRODUCT
   One-shot with a message:        $PRODUCT run "your task"
   Headless server for clients:    $PRODUCT serve --port 4096
3. Verify the engine from inside a session: ask the agent for gp_probe_status —
   it reports the engine version, advertised capabilities and permission state.
   From the shell: $PRODUCT --help
EOF
echo ""
success "done. Docs: https://github.com/$REPO#readme"

