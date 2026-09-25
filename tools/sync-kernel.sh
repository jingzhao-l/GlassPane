#!/usr/bin/env bash
# sync-kernel.sh — mirror kernel/ from its canonical home into GlassPane.
#
# Since 2026-09-22 (P0 §5.4) the single edit entry point for @iterate/kernel is
# the iterate-skill monorepo (jingzhao-l/iterate-skill, top-level kernel/).
# GlassPane keeps a build-local mirror so mcp-shell's file:../kernel, the C35
# fixtures and both CI lanes keep working unchanged.
#
# DIRECTION WARNING (2026-09-24, verified by dry run): as of today the mirror is
# AHEAD of canonical. GlassPane/kernel is @iterate/kernel 1.1.1 with the frozen
# evidence schema, the read-side legacy compat path (`parseEvidencePackRead`,
# audit item A-13) and 9 fixtures; iterate-skill/kernel is still 0.1.0-draft.1
# with 5 fixtures and no read-compat path at all. A plain mirror run therefore
# *downgrades* GlassPane: it deletes fixtures/evidence-pack.ok-04-legacy-draft.json
# and ok-05-pixelbounds-null.json, reverts src/parse.ts + src/index.ts, breaks
# mcp-shell/src/tools.ts (which imports parseEvidencePackRead), and fails the
# version-line gate. The guards below exist so that happens as a refusal, not as
# a commit. First step is always a --dry-run.
#
# Usage:
#   KERNEL_SRC=/path/to/iterate-skill tools/sync-kernel.sh --dry-run
#   KERNEL_SRC=/path/to/iterate-skill tools/sync-kernel.sh
#   # only if you genuinely intend to drop mirror-only files:
#   KERNEL_SRC=/path/to/iterate-skill tools/sync-kernel.sh --allow-deletions
# Then review `git diff kernel/` and commit as:
#   sync(kernel): iterate-skill@<short-sha printed below>
set -euo pipefail

SRC="${KERNEL_SRC:?set KERNEL_SRC to an iterate-skill checkout that contains kernel/}"
root="$(cd "$(dirname "$0")/.." && pwd)"

dry_run=0
allow_deletions=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    --allow-deletions) allow_deletions=1 ;;
    *) echo "error: unknown argument '$arg' (supported: --dry-run, --allow-deletions)" >&2; exit 2 ;;
  esac
done

RSYNC_EXCLUDES=(--exclude node_modules --exclude dist --exclude .npm-cache)

[ -d "$SRC/kernel" ] || { echo "error: $SRC/kernel does not exist" >&2; exit 1; }
[ -f "$SRC/kernel/package.json" ] || { echo "error: $SRC/kernel is not the kernel package" >&2; exit 1; }
git -C "$SRC" status --porcelain -- kernel | grep . && {
  echo "error: $SRC/kernel has uncommitted changes — sync from a committed state" >&2; exit 1;
} || true

# Guard 1 — deletions. The mirror may hold content canonical has never received
# back. Anything rsync would remove is reported and refused, because a sync that
# silently deletes a fixture also deletes the assertion that fixture carries.
deletions="$(rsync -an --delete --itemize-changes "${RSYNC_EXCLUDES[@]}" "$SRC/kernel/" "$root/kernel/" \
  | awk '/^\*deleting/ {print $2}')"
if [ -n "$deletions" ]; then
  echo "error: this sync would DELETE mirror-only files in kernel/:" >&2
  echo "$deletions" | sed 's/^/  - /' >&2
  if [ "$allow_deletions" -ne 1 ]; then
    echo "  The mirror is ahead of canonical for those paths. Refusing." >&2
    echo "  Remedy (pick one, in this order of preference):" >&2
    echo "    1. Backflow first: copy those files, plus the src/ and test/ diff, from" >&2
    echo "       $root/kernel into $SRC/kernel; run the kernel gate there; commit;" >&2
    echo "       then re-run this script." >&2
    echo "    2. If the deletion is truly intended (you have verified that no consumer" >&2
    echo "       imports what it removes), re-run with --allow-deletions." >&2
    exit 1
  fi
  echo "warning: --allow-deletions given; proceeding with the deletions listed above" >&2
fi

# Guard 2 — version line. scripts/check-version.mjs fails the build when
# kernel/package.json disagrees with the root, so a source carrying an old
# version can never produce a green mirror.
src_version="$(node -p "require('$SRC/kernel/package.json').version")"
root_version="$(node -p "require('$root/package.json').version")"
if [ "$src_version" != "$root_version" ]; then
  echo "error: version line mismatch — canonical kernel is $src_version, GlassPane root is $root_version." >&2
  echo "  A mirror run would break 'node scripts/check-version.mjs' (15 pinned sites)." >&2
  echo "  Remedy: bump canonical to $root_version (iterate-skill's own version-line step) or backflow, then re-run." >&2
  exit 1
fi

if [ "$dry_run" -eq 1 ]; then
  echo "dry run OK: no guard tripped for $SRC/kernel (source @ $(git -C "$SRC" rev-parse --short HEAD))"
  echo "changes that would be applied:"
  rsync -an --delete --itemize-changes "${RSYNC_EXCLUDES[@]}" "$SRC/kernel/" "$root/kernel/" | grep -v '^\*deleting' | sed 's/^/  /' || true
  exit 0
fi

rsync -a --delete "${RSYNC_EXCLUDES[@]}" "$SRC/kernel/" "$root/kernel/"

# Guard 3 — the sync must leave the repository green, or it never happened.
# Verification is part of the operation: a green-looking file copy that breaks
# the build is a rollback, not a success.
if ! ( cd "$root" && node scripts/check-version.mjs >/dev/null && npm run build --silent >/dev/null \
       && npm test --silent --workspace @iterate/kernel >/dev/null \
       && npm test --silent --workspace glasspane-mcp >/dev/null ); then
  echo "error: post-sync gate is RED — rolling kernel/ back to HEAD ($root/kernel left as it was)" >&2
  git -C "$root" checkout -- kernel
  git -C "$root" clean -fdq kernel
  echo "  Rollback done. Re-run 'npm test' in $root to confirm the tree is green again," >&2
  echo "  then reconcile the diff by hand: git -C $root diff HEAD -- kernel" >&2
  exit 1
fi

sha="$(git -C "$SRC" rev-parse --short HEAD)"
echo "mirrored $SRC/kernel -> $root/kernel (source @ $sha); post-sync version line + kernel + mcp-shell gates green"
echo "next: git add -A kernel && git commit -m 'sync(kernel): iterate-skill@$sha'"
