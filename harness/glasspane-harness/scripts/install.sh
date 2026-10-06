#!/usr/bin/env bash
# glasspane-harness one-click installer
#
#   curl -fsSL https://raw.githubusercontent.com/jingzhao-l/glasspane-harness/main/scripts/install.sh | bash
#   bash scripts/install.sh                 # install (npm first, GitHub release asset as fallback)
#   bash scripts/install.sh --dry-run       # print the plan, touch nothing
#   bash scripts/install.sh --version 0.1.0 # pin a version
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
INSTALL_ROOT="${GLASSPANE_HARNESS_HOME:-$HOME/.glasspane-harness}"
# Allow a fork/mirror to be installed from by pinning the source explicitly.
NPM_PACKAGE="${GLASSPANE_HARNESS_NPM:-$PRODUCT}"
RELEASE_BASE="${GLASSPANE_HARNESS_RELEASES:-https://github.com/$REPO/releases/download}"

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
    --help|-h)
      cat <<USAGE
glasspane-harness installer

  bash scripts/install.sh                  install (npm first, GitHub release asset as fallback)
  bash scripts/install.sh --dry-run        print the plan, touch nothing
  bash scripts/install.sh --version 0.1.0  pin a version (also --version=0.1.0)

Environment:
  GLASSPANE_HARNESS_HOME      fallback install root (default \$HOME/.glasspane-harness)
  GLASSPANE_HARNESS_NPM       npm package to install (default glasspane-harness)
  GLASSPANE_HARNESS_RELEASES  base URL for release assets (default this repo's releases)
USAGE
      exit 0
      ;;
    *) error "Unknown argument: $1 (try --help)"; exit 1 ;;
  esac
  shift
done

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
  info "1) npm:  $NPM_SPEC        (preferred: platform selection and updates are npm's job)"
  info "2) release asset fallback: $RELEASE_BASE (latest release resolved at install time)"
else
  info "1) npm:  $NPM_SPEC        (preferred: platform selection and updates are npm's job)"
  info "2) release asset fallback: $RELEASE_BASE/v$VERSION/$PRODUCT-$PLATFORM.zip (checks sha256 against SHA256SUMS.txt, GPG against the asset's .asc)"
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
  if npm install -g "$NPM_SPEC"; then
    INSTALLED_VIA="npm ($NPM_SPEC)"
  elif npm install -g --allow-scripts="$NPM_PACKAGE" "$NPM_SPEC" 2>/dev/null; then
    INSTALLED_VIA="npm ($NPM_SPEC, scripts allowed)"
  else
    warn "npm install failed (global prefix not writable? try: npm install -g --prefix \"\$HOME/.local\" $NPM_SPEC)"
    INSTALLED_VIA=""
  fi
else
  warn "npm not found on PATH — using the GitHub release asset instead"
  INSTALLED_VIA=""
fi

# ------------------------------------------------------------------ GPG verify (release asset provenance)
# Release signing key (GPG, key 0929EA31DF4F7429F63FC53189D88B1D043A1298, uid
# "jingzhao-l (sign-github) <ET_lin@outlook.com>"). GPG verifies SOURCE identity: the
# release pipeline publishes a detached signature next to every asset as `<asset>.asc`,
# and verifying it proves the tarball came from this key, not just that its SHA-256 is
# intact (content integrity is still the checksum's job). Best-effort by design: a
# missing signature (unsigned release) or a failed check only warns and continues — the
# download remains checksum-verified either way.
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
  local asc="$TMP/$name.asc" gnupg out rc=0
  info "verifying release asset GPG signature"
  if ! command -v gpg >/dev/null 2>&1; then
    GPG_STATE="skipped (gpg not on PATH)"
    warn "gpg not found on PATH — skipping release asset GPG provenance (integrity is still checksum-only)"
    return 0
  fi
  if ! curl -fsSL -o "$asc" "$url.asc" 2>/dev/null; then
    GPG_STATE="skipped (no .asc published for this asset)"
    warn "no GPG signature sidecar ($name.asc) published for this release — skipping (unsigned is a policy gap, not tampering)"
    return 0
  fi
  gnupg="$(mktemp -d)"
  chmod 700 "$gnupg"
  printf '%s' "$GLASSPANE_HARNESS_SIGNING_PUBLIC_KEY" | GNUPGHOME="$gnupg" gpg --batch --quiet --import
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
  if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q GOODSIG; then
    GPG_STATE="verified (signing key)"
    success "GPG provenance verified: release asset signature is from the signing key"
  else
    GPG_STATE="FAILED (signature did not verify)"
    warn "release asset GPG signature did not verify ($(printf '%s\n' "$out" | head -1)) — continuing, checksum-only"
  fi
  return 0
}

verify_asset() {
  # Integrity: the release publishes one `SHA256SUMS.txt` covering every asset, so
  # the download is checked against a manifest the pipeline itself produced. This is
  # the check that catches a truncated or corrupted transfer; the GPG check below is
  # the one that establishes who produced the file. Neither substitutes for the other.
  local file="$1" name="$2" sums want got
  sums="$TMP/SHA256SUMS.txt"
  if ! curl -fsSL -o "$sums" "$RELEASE_BASE/v$VERSION/SHA256SUMS.txt" 2>/dev/null; then
    SHA_STATE="skipped (no SHA256SUMS.txt published for v$VERSION)"
    warn "no SHA256SUMS.txt published for v$VERSION — skipping integrity check (provenance gap, not tampering)"
    return 0
  fi
  # The manifest lists bare filenames (`./name`), so match on the name, not the path.
  want="$(awk -v n="$name" '{ sub(/^\.\//, "", $2); if ($2 == n) print $1 }' "$sums" | head -1)"
  if [ -z "$want" ]; then
    SHA_STATE="skipped ($name is not listed in SHA256SUMS.txt)"
    warn "$name is not listed in SHA256SUMS.txt — skipping integrity check (coverage gap, not tampering)"
    return 0
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
  # Resolve "latest" through the releases API so the asset URL is one download, not a dance.
  if [ -z "$VERSION" ]; then
    API_JSON="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest")" || { error "could not query the latest release of $REPO"; exit 1; }
    VERSION="$(printf '%s' "$API_JSON" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' | head -1)"
    [ -n "$VERSION" ] || { error "could not read a version from the releases API"; exit 1; }
    info "latest release: v$VERSION"
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
  curl -fL --progress-bar -o "$TMP/$ASSET" "$URL" || { error "download failed: $URL"; exit 1; }

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
BIN="$(command -v "$PRODUCT" || echo "$INSTALL_ROOT/bin/$PRODUCT")"
if [ ! -x "$BIN" ]; then
  error "$PRODUCT is not on PATH after install — installed via $INSTALLED_VIA but no executable was found"
  exit 1
fi
VERSION_OUT="$("$BIN" --version 2>&1 | head -1)" || true
success "installed via $INSTALLED_VIA"
success "$PRODUCT --version -> ${VERSION_OUT:-<no version output>}"

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

