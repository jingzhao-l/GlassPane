#!/usr/bin/env bash
# sync-kernel.sh — RETIRED 2026-10-18. Both targets refuse; nothing copies.
#
# WHY IT EXISTED. Until 2026-09-22 the kernel's edit entry point was this repository; when
# canonical moved to iterate-skill, GlassPane kept a build-local mirror of the *code* under
# `kernel/` so that `mcp-shell`'s `"@iterate/kernel": "file:../kernel"`, the C35 fixtures and
# both CI lanes could keep working unchanged. That mirror was copied by this script, file by
# file, with guards.
#
# WHY IT IS GONE. `mcp-shell` now consumes the published `iterate-kernel` (Step 0b), so the
# last consumer of the mirrored code is gone — and the mirror was never provenanced. The pin
# (`harness/glasspane-harness/contracts/kernel-pin.json`) records the version, the lock
# integrity and the *corpus* bytes; nothing recorded `kernel/src`. Measured consequence: on
# 2026-10-18 the mirror tracked 0.1.7 while npm served 0.1.8, and the same class of lag had
# already made the engine leg blind once (the corpus, not the code, that time). A copy that
# nobody can name the version of is a second source of truth with a worse failure mode than
# the one it was meant to avoid.
#
# WHAT REPLACED EACH JOB THIS SCRIPT DID
#   · refresh the contract corpus   -> node scripts/check-kernel-corpus.mjs --record
#        (it copies from the INSTALLED pinned package and refuses bytes that disagree with the
#         pin; check mode also compares the shell's declared version with the pin)
#   · refresh the fork's dependency -> bump `iterate-kernel` in packages/opencode/package.json,
#        `bun install`, then node harness/glasspane-harness/script/kernel-pin.mjs --record
#   · prove behaviour still agrees  -> bun harness/glasspane-harness/script/kernel-conformance.mjs
#        (drives the pinned fixtures through the installed package and compares the golden/oracle)
#   · consumer-contract guards      -> the same symbols this script used to grep for are asserted
#        by imports that must typecheck: mcp-shell (src/tools.ts) and the fork (kernel.ts).
#        A missing export now fails a build, which is louder than a grep.
#
# THE LESSONS THIS SCRIPT TAUGHT, KEPT BECAUSE THEY ARE NOT ABOUT THIS SCRIPT
#   1. A sync that silently deletes a mirror-only file deletes the assertion that file carried.
#      (Guard 1; measured 2026-09-22 when the mirror had run AHEAD of canonical.)
#   2. Copying a manifest is not a no-op: `kernel/package.json` was this repository's workspace
#      entry (name `@iterate/kernel`, `private: true`, the GlassPane version line, an exact-pinned
#      zod) while canonical's was the published package. The copy that overwrote it made
#      `npm run build --workspace @iterate/kernel` die on the next step — a documented procedure
#      that could never complete (measured 2026-10-15, guard 3 rolled it back).
#   3. Verification is part of the operation: a file copy that leaves the tree red never
#      happened, so the post-sync gates were part of the command, and rollback restored from an
#      own snapshot rather than `git checkout`/`git clean` — the first version of which deleted
#      the mirror outright on a first-time sync.
#   4. The rollback was INCOMPLETE: the snapshot covered `$DST` only, so lockfiles npm rewrote
#      during the gates (`package-lock.json`, `mcp-shell/package-lock.json`) stayed moved after
#      a "rolled back" run. Recorded here because the class — a undo that restores one path and
#      not the others the operation touched — outlives this script.
#
# Usage: the script takes no working mode. Run it to see the refusal.
set -euo pipefail

target=repo
for arg in "$@"; do
  case "$arg" in
    --target=*) target="${arg#--target=}" ;;
    *) ;;
  esac
done

echo "error: sync-kernel.sh is retired — this repository no longer mirrors the kernel's source." >&2
echo "       (asked for --target=$target)" >&2
echo "  The kernel is the published \`iterate-kernel\`: mcp-shell bundles it, the fork resolves it" >&2
echo "  as a dependency, and \`kernel/\` here holds only the pinned corpus (fixtures/ + schemas/)." >&2
echo "  Remedy, depending on which job you are doing:" >&2
echo "    corpus   node scripts/check-kernel-corpus.mjs --record" >&2
echo "    fork pin node harness/glasspane-harness/script/kernel-pin.mjs --record" >&2
echo "    behaviour bun harness/glasspane-harness/script/kernel-conformance.mjs" >&2
exit 2
