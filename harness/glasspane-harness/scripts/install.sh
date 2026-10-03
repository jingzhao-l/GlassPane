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
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --version) shift; VERSION="${1:-}"; [ -n "$VERSION" ] || { error "--version needs a value"; exit 1; } ;;
    --version=*) VERSION="${arg#--version=}" ;;
    --help|-h)
      sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) error "Unknown argument: $arg (try --help)"; exit 1 ;;
  esac
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
ARCH="$(uname -m)"
case "$OS" in
  darwin)
    PLATFORM="darwin-$ARCH"
    case "$ARCH" in
      arm64 | x64) ;;
      *) error "Unsupported macOS architecture: $ARCH (this product ships darwin-arm64 and darwin-x64)"; exit 1 ;;
    esac
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
  info "2) release asset fallback: $RELEASE_BASE/v$VERSION/$PRODUCT-$PLATFORM-$VERSION.tar.gz"
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
  ASSET="$PRODUCT-$PLATFORM-$VERSION.tar.gz"
  URL="$RELEASE_BASE/v$VERSION/$ASSET"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  info "downloading $URL"
  curl -fL --progress-bar -o "$TMP/$ASSET" "$URL" || { error "download failed: $URL"; exit 1; }
  mkdir -p "$INSTALL_ROOT/bin"
  tar -xzf "$TMP/$ASSET" -C "$INSTALL_ROOT/bin"
  chmod +x "$INSTALL_ROOT/bin/$PRODUCT" 2>/dev/null || true
  INSTALLED_VIA="release asset ($ASSET)"
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

