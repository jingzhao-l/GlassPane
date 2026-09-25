#!/usr/bin/env bash
# sync-kernel.sh — mirror kernel/ from its canonical home into GlassPane.
#
# Since 2026-09-22 (P0 §5.4) the single edit entry point for @iterate/kernel is
# the iterate-skill monorepo (jingzhao-l/iterate-skill, top-level kernel/).
# GlassPane keeps a build-local mirror so mcp-shell's file:../kernel, the C35
# fixtures and both CI lanes keep working unchanged.
#
# DIRECTION NOTE (updated 2026-09-25): the mirror had drifted *ahead* of
# canonical. Between 2026-09-22 and 2026-09-24 the evidence schema was frozen
# (draft -> v0.1) and the read-side legacy-compat path (A-13:
# `parseEvidencePackRead`, `LEGACY_EVIDENCE_SCHEMA_VERSION`) was written on the
# mirror side only, so a plain mirror run would have DELETED
# fixtures/evidence-pack.ok-04-legacy-draft.json and reverted src/parse.ts +
# src/index.ts — breaking the import in mcp-shell/src/tools.ts and the version-line
# gate. That content has since been backflowed (iterate-skill d893045), so
# canonical is the source of truth again. The guards below stay: drift is a
# property of the process, not of one moment in time, and a sync that quietly
# deletes a fixture also deletes the assertion that fixture carries.
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

# Guard 2 — the consumer contract, not the version number.
#
# Version equality is the wrong assertion: canonical keeps the kernel's own
# release rhythm (iterate-skill decides that number), while GlassPane stamps
# every package on one line via scripts/set-version.mjs. Refusing a sync because
# `0.1.0-draft.1 != 1.1.1` blocks legitimate work and protects nothing. What
# actually breaks the build is a missing export a consumer imports — so that is
# what gets checked, and the version is re-stamped after the copy.
src_version="$(node -p "require('$SRC/kernel/package.json').version")"
root_version="$(node -p "require('$root/package.json').version")"
for symbol in parseEvidencePack parseEvidencePackRead parseDecisionLogEntry parseRecipeConfig; do
  grep -q "\b$symbol\b" "$SRC/kernel/src/index.ts" || {
    echo "error: canonical kernel does not export '$symbol', which $root/kernel/src/index.ts exports today." >&2
    echo "  Consumers that would break: mcp-shell/src/tools.ts (imports parseEvidencePackRead via" >&2
    echo "  @iterate/kernel), plus the C35 roundtrip suites on both sides." >&2
    echo "  Remedy: backflow that export into $SRC/kernel and run the kernel gate there, then re-sync." >&2
    exit 1
  }
done
[ "$src_version" = "$root_version" ] || echo "note: version re-stamp pending — canonical says $src_version, GlassPane line is $root_version (mirror wins locally; set-version owns it)"

if [ "$dry_run" -eq 1 ]; then
  echo "dry run OK: no guard tripped for $SRC/kernel (source @ $(git -C "$SRC" rev-parse --short HEAD))"
  echo "changes that would be applied:"
  rsync -an --delete --itemize-changes "${RSYNC_EXCLUDES[@]}" "$SRC/kernel/" "$root/kernel/" | grep -v '^\*deleting' | sed 's/^/  /' || true
  echo "  (plus: node scripts/set-version.mjs $root_version re-stamps kernel/package.json after the copy)"
  exit 0
fi

rsync -a --delete "${RSYNC_EXCLUDES[@]}" "$SRC/kernel/" "$root/kernel/"
# Re-stamp the mirror's own version sites, since the copy carried canonical's number.
node "$root/scripts/set-version.mjs" "$root_version" >/dev/null || {
  echo "error: set-version re-stamp failed; rolling kernel/ back to HEAD." >&2
  git -C "$root" checkout -- kernel
  git -C "$root" clean -fdq kernel
  exit 1
}

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
