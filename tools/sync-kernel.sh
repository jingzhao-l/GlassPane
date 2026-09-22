#!/usr/bin/env bash
# sync-kernel.sh — mirror kernel/ from its canonical home into GlassPane.
#
# Since 2026-09-22 (P0 §5.4) the single edit entry point for @iterate/kernel is
# the iterate-skill monorepo (jingzhao-l/iterate-skill, top-level kernel/).
# GlassPane keeps a build-local mirror so mcp-shell's file:../kernel, the C35
# fixtures and both CI lanes keep working unchanged.
#
# Usage:
#   KERNEL_SRC=/path/to/iterate-skill tools/sync-kernel.sh
# Then review `git diff kernel/` and commit as:
#   sync(kernel): iterate-skill@<short-sha printed below>
set -euo pipefail

SRC="${KERNEL_SRC:?set KERNEL_SRC to an iterate-skill checkout that contains kernel/}"
root="$(cd "$(dirname "$0")/.." && pwd)"

[ -d "$SRC/kernel" ] || { echo "error: $SRC/kernel does not exist" >&2; exit 1; }
[ -f "$SRC/kernel/package.json" ] || { echo "error: $SRC/kernel is not the kernel package" >&2; exit 1; }
git -C "$SRC" status --porcelain -- kernel | grep . && {
  echo "error: $SRC/kernel has uncommitted changes — sync from a committed state" >&2; exit 1;
} || true

rsync -a --delete \
  --exclude node_modules --exclude dist --exclude .npm-cache \
  "$SRC/kernel/" "$root/kernel/"

sha="$(git -C "$SRC" rev-parse --short HEAD)"
echo "mirrored $SRC/kernel -> $root/kernel (source @ $sha)"
echo "next: git add -A kernel && git commit -m 'sync(kernel): iterate-skill@$sha'"
