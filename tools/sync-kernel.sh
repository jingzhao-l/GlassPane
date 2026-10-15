#!/usr/bin/env bash
# sync-kernel.sh — mirror kernel/ from its canonical home into this repository,
# in one supported shape:
#
#   --target=repo  $root/kernel                the build-local mirror mcp-shell
#                                              consumes via file:../kernel (P0 §5.4)
#   --target=fork  RETIRED 2026-10-08. The opencode fork no longer vendors the kernel:
#                                              it resolves the `iterate-kernel` npm
#                                              dependency, whose provenance lives in
#                                              harness/glasspane-harness/contracts/kernel-pin.json
#                                              and is checked by script/kernel-pin.mjs.
#                                              The flag now refuses; see the paragraph
#                                              below on the unreachable fork-leg code.
#
# Since 2026-09-22 (P0 §5.4) the single edit entry point for @iterate/kernel is
# the iterate-skill monorepo (jingzhao-l/iterate-skill, top-level kernel/).
# GlassPane keeps a build-local mirror so mcp-shell's file:../kernel, the C35
# fixtures and both CI lanes keep working unchanged.
#
# THE FORK LEG IS RETIRED (2026-10-08); only --target=repo is live below.
# The fork used to vendor the kernel because the recorded release policy was "not published
# separately" (P6 S13, P4 S33.2) and a relative ../../kernel import would break the first time
# the fork was subtree-split into its own repository. That policy was reversed on the iterate
# side: the kernel is `iterate-kernel` on npm, the fork resolves it as a dependency, and
# `--target=fork` now refuses. The fork-side code paths kept below are therefore UNREACHABLE —
# they are not a supported mode, and they go away in the batch that retires this script's last
# consumer (mcp-shell still reads the repo mirror via file:../kernel). Do not "fix" them.
# ecosystem's recorded decision is that kernel is *not* published separately
# (P6 §13: a `file:` dependency leaks out of the published manifest, so
# mcp-shell inlines it; P4 §33.2: registry publishing follows the iterate
# monorepo's own release policy). "npm 依赖进入 fork" in 综述 §5.7/§5.8 R32 is a
# statement about dependency *direction and accounting*, not an instruction to
# publish. So the fork gets the bytes, pinned by hash, and the day the monorepo
# does publish it, the binding module switches to a semver range — one line.
# A relative `../../kernel` import would break the first time the fork is
# subtree-split into its own repository, which is exactly how this fork ships.
#
# DIRECTION NOTE (updated 2026-09-25): the mirror had drifted *ahead* of
# canonical. Between 2026-09-22 and 09-24 the evidence schema was frozen
# (draft -> v0.1) and the read-side legacy-compat path (A-13:
# `parseEvidencePackRead`, `LEGACY_EVIDENCE_SCHEMA_VERSION`) was written on the
# mirror side only, so a plain mirror run would have DELETED
# fixtures/evidence-pack.ok-04-legacy-draft.json and reverted src/parse.ts +
# src/index.ts — breaking the import in mcp-shell/src/tools.ts and the
# version-line gate. That content has since been backflowed (iterate-skill
# d893045), so canonical is the source of truth again. The guards below stay:
# drift is a property of the process, not of one moment in time, and a sync that
# quietly deletes a fixture also deletes the assertion that fixture carries.
#
# Usage:
#   KERNEL_SRC=/path/to/iterate-skill tools/sync-kernel.sh [--dry-run]
#   # only if you genuinely intend to drop mirror-only files:
#   ... tools/sync-kernel.sh --allow-deletions
# Then review `git diff` and commit as:
#   sync(kernel): <repo|fork> @<short-sha printed below>
set -euo pipefail

SRC="${KERNEL_SRC:?set KERNEL_SRC to an iterate-skill checkout that contains kernel/}"
root="$(cd "$(dirname "$0")/.." && pwd)"

dry_run=0
allow_deletions=0
target=repo
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    --allow-deletions) allow_deletions=1 ;;
    --target=repo) target=repo ;;
    --target=fork)
      # The fork no longer vendors the kernel: it resolves the `iterate-kernel`
      # dependency through its own lockfile. Provenance there is recorded and checked
      # by harness/glasspane-harness/script/kernel-pin.mjs (--record / --check), and
      # behaviour parity by script/kernel-conformance.mjs. Copying bytes into
      # packages/opencode/vendor/kernel would recreate the third copy of the contract
      # that this retirement was meant to remove — so this leg refuses instead of
      # half-working. `--target=repo` (the mcp-shell mirror) is unaffected.
      echo "error: --target=fork is retired. The fork consumes iterate-kernel as a dependency;" >&2
      echo "       bump the dependency line in packages/opencode/package.json, run \`bun install\`," >&2
      echo "       then: node harness/glasspane-harness/script/kernel-pin.mjs --record" >&2
      echo "        and: bun harness/glasspane-harness/script/kernel-conformance.mjs --impl <canonical kernel checkout>" >&2
      exit 2 ;;
    --target=*) echo "error: unknown --target value '${arg#--target=}' (supported: repo)" >&2; exit 2 ;;
    *) echo "error: unknown argument '$arg' (supported: --target=repo, --dry-run, --allow-deletions)" >&2; exit 2 ;;
  esac
done

RSYNC_EXCLUDES=(--exclude node_modules --exclude dist --exclude .npm-cache)

# The mirror owns its manifest; canonical owns the code, the schemas, the fixtures
# and the tests.
#
# WHY THIS IS AN EXCLUSION AND NOT A MERGE: `kernel/package.json` is not a copy of
# canonical's. It is the workspace entry mcp-shell resolves through
# `"@iterate/kernel": "file:../kernel"` — name `@iterate/kernel`, `private: true`, the
# version stamped by `scripts/set-version.mjs` onto the GlassPane line, zod pinned to
# one exact version for a reproducible install, and an exports map that publishes only
# the root entry. Canonical's carries `iterate-kernel`, `private: false`, its own
# `0.1.x`, a `>=3.25.76 <5` range and fifteen subpath exports. Measured 2026-10-15: the
# copy that shipped here overwrote all of it, and the very next step — root
# `npm run build` — died on `No workspaces found: --workspace=@iterate/kernel`. Guard 3
# rolled the sync back, so the visible symptom was not a corrupted mirror but a
# documented procedure that could never complete. A manifest copy is therefore not a
# no-op, and a merge that "keeps the interesting fields" is worse: it would silently
# decide, every run, which half of the identity survives.
#
# `package-lock.json` goes the same way for the same reason: it is the record of the
# mirror's own pinned resolution, and it is one of `check-version.mjs`'s lock sites.
MANIFEST_OWNED=()
if [ "$target" = "repo" ]; then
  MANIFEST_OWNED=(--exclude package.json --exclude package-lock.json)
fi

# The fork target vendors a subset: the TypeScript source, the schema truth
# files and the fixtures. It deliberately does NOT copy `test/` (those tests
# import the built `dist/`, which the fork does not produce) or `package.json`
# / `tsconfig.json` (the fork's own toolchain config governs the vendored code).
if [ "$target" = "fork" ]; then
  DST="$root/harness/glasspane-harness/packages/opencode/vendor/kernel"
  VENDOR_SUBDIRS=(src schemas fixtures)
else
  DST="$root/kernel"
  VENDOR_SUBDIRS=()
fi

[ -d "$SRC/kernel" ] || { echo "error: $SRC/kernel does not exist" >&2; exit 1; }
[ -f "$SRC/kernel/package.json" ] || { echo "error: $SRC/kernel is not the kernel package" >&2; exit 1; }
# Sync from a committed, clean state — but say so when that check cannot be made,
# rather than letting `git` print a fatal and the script carry on as if it passed.
if git -C "$SRC" rev-parse --git-dir >/dev/null 2>&1; then
  if git -C "$SRC" status --porcelain -- kernel | grep .; then
    echo "error: $SRC/kernel has uncommitted changes — sync from a committed state" >&2
    exit 1
  fi
else
  echo "warning: $SRC is not a git checkout, so the 'committed and clean' precondition could not be checked" >&2
fi

# The set of "what would be deleted" is computed against the same shape that
# will be written, so the guard cannot disagree with the operation.
# `dry` must keep `-a` (recursive): dropping it makes rsync refuse --delete, the
# pipeline's exit status becomes awk's, and guard 1 would silently see "no
# deletions" forever — which is precisely the failure this guard exists to catch.
enumerate() { # $1 = dry | real
  local flags="-a"
  [ "$1" = "dry" ] && flags="-an"
  if [ "$target" = "fork" ]; then
    for sub in "${VENDOR_SUBDIRS[@]}"; do
      rsync $flags --delete --itemize-changes "${RSYNC_EXCLUDES[@]}" "$SRC/kernel/$sub/" "$DST/$sub/"
    done
  else
    rsync $flags --delete --itemize-changes "${RSYNC_EXCLUDES[@]}" ${MANIFEST_OWNED[@]+"${MANIFEST_OWNED[@]}"} "$SRC/kernel/" "$DST/"
  fi
}

# Guard 1 — deletions. The mirror may hold content canonical has never received
# back. Anything rsync would remove is reported and refused, because a sync that
# silently deletes a fixture also deletes the assertion that fixture carries.
# The enumeration's own health is asserted: an rsync that died must not be read
# as "nothing to delete".
# 模板要自己带尾部的 X：`mktemp -t NAME` 在 BSD(macOS) 上是"用 NAME 当前缀"，而 GNU coreutils
# 把 `-t` 当已废弃、直接把参数当模板并要求末尾至少两个 X，于是同一行在 Linux runner 上
# 是 `mktemp: too few X's in template 'sync-kernel-enumerate'`，退 1。
# 这条不是推测：新增的 tools-sync-kernel 测试在 CI 上第一次跑就撞到了它（本地 macOS 恒过）。
err_file="$(mktemp "${TMPDIR:-/var/tmp}/sync-kernel-enumerate.XXXXXX")"
if ! plan="$(enumerate dry 2>"$err_file")"; then
  echo "error: guard 1 could not enumerate the sync plan; refusing to treat that as 'nothing to delete'." >&2
  sed 's/^/  rsync: /' "$err_file" >&2
  rm -f "$err_file"
  exit 1
fi
rm -f "$err_file"
deletions="$(printf '%s\n' "$plan" | awk '/^\*deleting/ {print $2}')"
if [ -n "$deletions" ]; then
  echo "error: this sync would DELETE mirror-only files in $DST:" >&2
  echo "$deletions" | sed 's/^/  - /' >&2
  if [ "$allow_deletions" -ne 1 ]; then
    echo "  The mirror is ahead of canonical for those paths. Refusing." >&2
    echo "  Remedy (pick one, in this order of preference):" >&2
    echo "    1. Backflow first: copy those files, plus the src/ and test/ diff, from" >&2
    echo "       $DST into $SRC/kernel; run the kernel gate there; commit;" >&2
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
# The path goes in as an argument, never inside the evaluated string: interpolating it meant
# a KERNEL_SRC containing a single quote — an ordinary directory name like /Users/o'brien —
# broke the JS literal and the sync died on a SyntaxError instead of reading a version.
src_version="$(node -e 'console.log(require(process.argv[1]).version)' "$SRC/kernel/package.json")"
root_version="$(node -e 'console.log(require(process.argv[1]).version)' "$root/package.json")"
for symbol in parseEvidencePack parseEvidencePackRead parseDecisionLogEntry parseRecipeConfig; do
  grep -q "\b$symbol\b" "$SRC/kernel/src/index.ts" || {
    echo "error: canonical kernel does not export '$symbol', which $root/kernel/src/index.ts exports today." >&2
    echo "  Consumers that would break: mcp-shell/src/tools.ts (imports parseEvidencePackRead via" >&2
    echo "  @iterate/kernel), plus the C35 roundtrip suites on both sides." >&2
    echo "  Remedy: backflow that export into $SRC/kernel and run the kernel gate there, then re-sync." >&2
    exit 1
  }
done
# The fork's consumers import the chain API too; a missing symbol there breaks
# the fork build rather than the shell's.
for symbol in appendDecisionLogEntry verifyDecisionLogText decisionLogEntryHash canonicalJson; do
  grep -q "\b$symbol\b" "$SRC/kernel/src/index.ts" || {
    echo "error: canonical kernel does not export '$symbol', which the opencode fork's binding imports." >&2
    echo "  Consumers that would break: harness/glasspane-harness/packages/opencode/src/tool/glasspane/kernel.ts" >&2
    echo "  Remedy: land that export in $SRC/kernel (canonical) and run its gate there, then re-sync --target=fork." >&2
    exit 1
  }
done
if [ "$target" = "repo" ] && [ -f "$DST/package.json" ]; then
  # Guard 2b — the dependency face, which is exactly what excluding the manifest makes
  # invisible. The mirror keeps its own `package.json`, so a package canonical newly
  # depends on would land in `src/` as an import nothing installs: the build would fail
  # later, in a consumer's face, with a message about a module instead of about this
  # sync. Refusing here names the package and the file to edit.
  # Names are compared, not ranges: the mirror pins `zod` to one exact version on purpose
  # (reproducible install is this line's recorded decision) while canonical carries a
  # range, and reading that difference as a missing dependency would block every sync.
  missing_deps="$(node -e '
    const fs = require("fs");
    const read = (i) => JSON.parse(fs.readFileSync(process.argv[i], "utf8"));
    const src = read(1);
    const dst = read(2);
    const have = new Set([...Object.keys(dst.dependencies || {}), ...Object.keys(dst.devDependencies || {})]);
    const need = [...new Set([...Object.keys(src.dependencies || {}), ...Object.keys(src.devDependencies || {})])];
    const missing = need.filter((n) => !have.has(n));
    if (missing.length) console.log(missing.join(" "));
  ' "$SRC/kernel/package.json" "$DST/package.json")" || {
    echo "error: the dependency comparison could not run; a manifest that does not parse is not a sync" >&2
    exit 1
  }
  if [ -n "$missing_deps" ]; then
    echo "error: canonical kernel declares package(s) this mirror's manifest does not: $missing_deps" >&2
    echo "  This sync deliberately does not copy $DST/package.json — the mirror owns its" >&2
    echo "  workspace identity (@iterate/kernel, private, the GlassPane version line, the" >&2
    echo "  pinned zod range) — so a new dependency would never install and a consumer" >&2
    echo "  would fail on an unresolved import far from here." >&2
    echo "  Remedy: add $missing_deps to $DST/package.json (dependencies or devDependencies," >&2
    echo "  matching how mcp-shell consumes it), run \`npm ci\` in $root, then re-run this sync." >&2
    exit 1
  fi
fi

if [ "$target" = "repo" ]; then
  [ "$src_version" = "$root_version" ] || echo "note: version re-stamp pending — canonical says $src_version, GlassPane line is $root_version (mirror wins locally; set-version owns it)"
else
  echo "note: the fork vendor keeps canonical's version ($src_version) in its provenance manifest; it is not on the GlassPane version line"
fi

if [ "$dry_run" -eq 1 ]; then
  echo "dry run OK: no guard tripped for $SRC/kernel → $DST (source @ $(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo no-git-ref))"
  echo "changes that would be applied:"
  enumerate dry | grep -v '^\*deleting' | sed 's/^/  /' || true
  if [ "$target" = "repo" ]; then
    echo "  (plus: node scripts/set-version.mjs $root_version re-stamps kernel/package.json after the copy)"
  else
    echo "  (plus: harness/contracts/kernel-vendor.json regenerated with per-file sha256 of the vendored subset)"
  fi
  exit 0
fi

# Rollback, because guard 3 must be able to undo exactly what this run did — and
# undo it *without* being more destructive than the thing it prevents. The first
# version of this used `git checkout` + `git clean -fdq` on the destination, which
# on a first-time sync (nothing tracked yet) DELETED the mirror outright: a guard
# that eats the tree it was called to protect is worse than no guard. So the run
# takes a snapshot first and restores from that; `git clean` never runs on paths
# this script created.
backup_dir="$(mktemp -d "${TMPDIR:-/var/tmp}/sync-kernel-backup-XXXXXX")"
# `if` rather than `[ … ] && …`: a bare test that fails returns 1, and under
# `set -e` that kills the script on the very first sync (no destination yet).
if [ -e "$DST" ]; then rsync -a "$DST/" "$backup_dir/dst/"; fi
if [ -f "$root/harness/contracts/kernel-vendor.json" ]; then
  cp "$root/harness/contracts/kernel-vendor.json" "$backup_dir/manifest.json"
fi

rollback() {
  if [ -e "$backup_dir/dst" ]; then
    rsync -a --delete "$backup_dir/dst/" "$DST/"
  else
    rm -rf "$DST"
  fi
  if [ "$target" = "fork" ]; then
    if [ -f "$backup_dir/manifest.json" ]; then
      cp "$backup_dir/manifest.json" "$root/harness/contracts/kernel-vendor.json"
    else
      rm -f "$root/harness/contracts/kernel-vendor.json"
    fi
  fi
  echo "  restored from $backup_dir (no git clean involved)" >&2
}
trap 'rc=$?; [ "$rc" -ne 0 ] && [ "${rolled_back:-0}" = 0 ] && rm -rf "$backup_dir"; exit $rc' EXIT

enumerate real >/dev/null
# Ensure the vendored subset has no leftovers from a previous shape (e.g. a
# package.json the fork used to carry) — with --target=fork the mirror is only
# the subdirs listed above.
if [ "$target" = "fork" ]; then
  for stray in package.json package-lock.json tsconfig.json test; do
    if [ -e "$DST/$stray" ]; then
      echo "error: unexpected '$stray' inside the fork vendor ($DST) — remove it deliberately, not by syncing around it" >&2
      exit 1
    fi
  done
fi

if [ "$target" = "repo" ]; then
  # Two manifest fields are NOT identity — they describe the contract corpus, and the
  # kernel's own packaging gate (`test/packaging.test.mjs`, which the mirror runs because
  # the mirror runs canonical's tests) asserts them:
  #   · `exports` — every src module must be reachable as a subpath, so a new module in
  #     canonical must be importable here too, and
  #   · `files` — the fixture corpus "is the cross-language contract" and must ship.
  # They are copied from canonical rather than kept by the mirror, because hand-copying
  # them is what the mirror silently failed to do on 2026-10-15: canonical gained six
  # modules and the mirror's manifest kept a `.`-only exports map, so the sync could
  # never pass its own gates. Everything else in the manifest stays the mirror's —
  # `name` (the workspace handle mcp-shell resolves), `private`, the version line, the
  # exact-pinned zod range, the scripts, and the absence of `publishConfig`.
  node -e '
    const fs = require("fs");
    const [srcFile, dstFile] = process.argv.slice(1);
    const src = JSON.parse(fs.readFileSync(srcFile, "utf8"));
    const dst = JSON.parse(fs.readFileSync(dstFile, "utf8"));
    const before = JSON.stringify({ exports: dst.exports, files: dst.files });
    dst.exports = src.exports;
    dst.files = src.files;
    fs.writeFileSync(dstFile, `${JSON.stringify(dst, null, 2)}\n`);
    const after = JSON.stringify({ exports: dst.exports, files: dst.files });
    const subs = Object.keys(src.exports ?? {}).filter((k) => k !== ".").length;
    console.log(`manifest: exports (${subs} subpaths) and files copied from canonical; name/private/version/pinned deps kept by the mirror`);
    if (before !== after) console.log("manifest: exports/files changed in this run — review the diff, the kernel packaging gate asserts both");
  ' "$SRC/kernel/package.json" "$DST/package.json" || {
    echo "error: the manifest contract fields could not be copied; rolling the mirror back." >&2
    rolled_back=1; rollback
    exit 1
  }
  # Re-stamp the mirror's version site, since the mirror's manifest is on the GlassPane line.
  node "$root/scripts/set-version.mjs" "$root_version" >/dev/null || {
    echo "error: set-version re-stamp failed; rolling the mirror back to its pre-sync bytes." >&2
    rolled_back=1; rollback
    exit 1
  }
else
  node "$root/harness/glasspane-harness/script/kernel-vendor.mjs" --record "$SRC" "$src_version" || {
    echo "error: the provenance manifest could not be written; rolling the vendor back." >&2
    rolled_back=1; rollback
    exit 1
  }
fi

# Guard 3 — the sync must leave the repository green, or it never happened.
# Verification is part of the operation: a green-looking file copy that breaks
# the build is a rollback, not a success.
if [ "$target" = "repo" ]; then
  gates=(
    "node scripts/check-version.mjs"
    "npm run build --silent"
    "npm test --silent --workspace @iterate/kernel"
    "npm test --silent --workspace glasspane-mcp"
  )
  gate_cwd=("$root" "$root" "$root" "$root")
else
  fork="$root/harness/glasspane-harness"
  # `bun` is the fork's pinned toolchain (packageManager says bun@1.3.14), but it is
  # not always on PATH for a non-login shell. An absent tool is NOT a failed gate:
  # treating "command not found" as red once rolled back a perfectly good sync and
  # then deleted the mirror. So resolve it, and if it is missing, say so and stop
  # before the gates — after the checks that do not need it have run.
  BUN="${BUN:-$(command -v bun || true)}"
  if [ -z "$BUN" ] && [ -x "$HOME/.bun/bin/bun" ]; then BUN="$HOME/.bun/bin/bun"; fi
  # `--target=fork` refuses above, so this leg is unreachable and kept only as the
  # record of what the fork used to run. It still has to be *correct* if revived:
  # these strings go through `eval`, so an unquoted $root word-splits on any checkout
  # path with a space (macOS volume names do) — the gate would then run a different
  # command than the one printed, or fail for a reason that has nothing to do with
  # the sync.
  gates=(
    "node \"$root/harness/glasspane-harness/script/kernel-vendor.mjs\" --check"
    "node \"$root/harness/tools/fork-diff.mjs\" --check"
    "node \"$root/harness/tools/tool-surface.mjs\" --check"
  )
  gate_cwd=("$root" "$root" "$root")
  if [ -n "$BUN" ]; then
    gates+=("'$BUN' test --timeout 30000 test/tool/glasspane-kernel.test.ts" "'$BUN' run typecheck")
    gate_cwd+=("$fork/packages/opencode" "$fork/packages/opencode")
  else
    echo "warning: bun not found (set BUN=/path/to/bun); the fork's test + typecheck gates did NOT run" >&2
  fi
fi
for i in "${!gates[@]}"; do
  if ! ( cd "${gate_cwd[$i]}" && eval "${gates[$i]}" >/dev/null ); then
    echo "error: post-sync gate RED — ${gates[$i]} (in ${gate_cwd[$i]})" >&2
    echo "  Rolling back: $DST returns to its pre-sync bytes." >&2
    rolled_back=1; rollback
    echo "  Reconcile by hand once the cause is fixed: git -C $root diff -- $DST" >&2
    exit 1
  fi
done

sha="$(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo "no-git-ref")"
echo "mirrored $SRC/kernel -> $DST (source @ $sha, target=$target); post-sync gates green:"
for g in "${gates[@]}"; do echo "  ok  $g"; done
if [ "$target" = "fork" ] && [ -z "${BUN:-}" ]; then
  echo "  WARNING: 2 gates never ran (bun absent — set BUN=/path/to/bun). This sync is NOT fully verified."
fi
rm -rf "$backup_dir"
echo "next: git add -A '$DST' harness/contracts && git commit -m 'sync(kernel): $target@$sha'"
