#!/usr/bin/env bash
# Reverse control for the `harness contract` lane's upstream probe.
#
# The lane used to decide by `grep -q "drift"` over output captured with `|| true`, so
# the probe's exit-2 "cannot measure" path — no reference checkout, unreadable golden,
# thrown error — reported the lane as green. This script extracts the REAL step body out
# of .github/workflows/harness-contract.yml and runs it against a stubbed probe that
# answers each of the three exit codes the tool can produce. It does not test a copy of
# the shell logic; it tests the file CI runs, so editing the workflow re-arms the check.
#
# Usage: sh harness/tools/probe-lane-selftest.sh
# A different workflow body can be pointed at with PROBE_LANE_WORKFLOW=<path> — that is
# how this script's own negative control runs: the pre-fix body is replayed from a
# scratch file, so the lane-under-test never has to be damaged in the tree.
# Exit:  0 all expectations held, 1 a case did not behave, 2 the step could not be read.
set -u
cd "$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)" || exit 2
WORKFLOW="${PROBE_LANE_WORKFLOW:-.github/workflows/harness-contract.yml}"
STEP_NAME="Probe a newer upstream release (drift = freeze the upgrade)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

[ -f "$WORKFLOW" ] || { echo "MISSING $WORKFLOW"; exit 2; }

# Pull the `run: |` block that belongs to the probe step: from the line after `run: |`
# until the next step (`- name:`) or job (`^  [a-z]`) at its own indentation.
node -e '
const fs = require("fs")
const [file, stepName] = process.argv.slice(1)
const lines = fs.readFileSync(file, "utf8").split("\n")
const start = lines.findIndex((l) => l.includes("name: " + stepName))
if (start < 0) { console.error("step not found"); process.exit(2) }
const run = lines.findIndex((l, i) => i > start && /^        run: \|$/.test(l))
if (run < 0) { console.error("run block not found"); process.exit(2) }
const out = []
for (let i = run + 1; i < lines.length; i++) {
  const l = lines[i]
  if (/^      - /.test(l) || /^  [a-zA-Z]/.test(l) || /^conclusion:/.test(l)) break
  out.push(l.replace(/^        /, ""))
}
if (out.length === 0) { console.error("empty run block"); process.exit(2) }
process.stdout.write(out.join("\n") + "\n")
' "$WORKFLOW" "$STEP_NAME" > "$TMP/step.sh" || { echo "READ FAILED — the step could not be extracted, so nothing was tested"; exit 2; }

if [ ! -s "$TMP/step.sh" ]; then echo "EMPTY STEP BODY — nothing was tested"; exit 2; fi
echo "extracted $(grep -c . "$TMP/step.sh") content lines from $WORKFLOW"

# Stub `node`: answer the probe with the forced code, pass everything else through.
# The pass-through uses the absolute path of the real binary on purpose — resolving
# `node` through PATH would re-enter this stub.
REAL_NODE="$(command -v node)"
[ -n "$REAL_NODE" ] || { echo "no node on PATH — the extraction step could not run"; exit 2; }
mkdir -p "$TMP/bin"
cat > "$TMP/bin/node" <<EOF
#!/usr/bin/env bash
for a in "\$@"; do
  case "\$a" in
    *hook-liveness.mjs)
      echo "stubbed hook-liveness --probe (forced exit \${PROBE_RC})"
      exit "\${PROBE_RC}"
      ;;
  esac
done
exec "$REAL_NODE" "\$@"
EOF
chmod 755 "$TMP/bin/node"

fail=0
run_case() {
  want_rc="$1" want_out="$2" probe_rc="$3"
  : > "$TMP/summary.md"
  got="$(
    PATH="$TMP/bin:$PATH" PROBE_RC="$probe_rc" GITHUB_STEP_SUMMARY="$TMP/summary.md" \
      HARNESS_UPSTREAM_CHECKOUT="$TMP/does-not-exist" PROBED_TAG="v9.9.9" \
      bash "$TMP/step.sh" 2>&1
  )"
  got_rc=$?
  if [ "$got_rc" != "$want_rc" ]; then
    echo "  ✗ exit $probe_rc → step exit $got_rc, expected $want_rc"
    fail=1
  else
    echo "  ✓ exit $probe_rc → step exit $got_rc"
  fi
  if ! printf '%s' "$got" | grep -q "$want_out"; then
    echo "    ✗ the step did not say it: $want_out"
    fail=1
  fi
}

echo "cases:"
# 0 = measured and clean. 1 = the tool's own drift verdict. 2 = "cannot measure".
run_case 0 "probe clean" 0
run_case 1 "上游换了插件地板" 1
# This is the case the old lane could not fail: a probe that never ran.
run_case 1 "上游探查没有跑成（这不等于没有漂移）" 2
# And the summary must not be able to read as a clearance.
: > "$TMP/summary.md"
PATH="$TMP/bin:$PATH" PROBE_RC=2 GITHUB_STEP_SUMMARY="$TMP/summary.md" \
  HARNESS_UPSTREAM_CHECKOUT="$TMP/does-not-exist" PROBED_TAG="v9.9.9" \
  bash "$TMP/step.sh" >/dev/null 2>&1
if grep -q "未观测" "$TMP/summary.md"; then
  echo "  ✓ the step summary records 未观测 for the unmeasured case"
else
  echo "  ✗ the step summary does not record 未观测 for the unmeasured case"
  fail=1
fi

if [ "$fail" != 0 ]; then
  echo "probe-lane selftest: RED — the lane cannot tell drift from 'not measured'"
  exit 1
fi
echo "probe-lane selftest: the probe lane's three outcomes are distinguishable, and 未观测 is red"
