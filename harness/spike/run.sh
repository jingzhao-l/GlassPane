#!/usr/bin/env bash
# run.sh — execute the harness spike probes that need no model, no credentials
# and no spend (E1 load / E2 tool ids / E6 tool body -> glasspaned).
#
# Exit codes: 0 everything ran and passed; 1 a probe failed; 3 DEPENDENCIES
# MISSING — nothing ran. 3 is deliberately non-zero: "we did not measure" must
# never look like "we measured and it was fine".
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"          # the repository root, derived — never hard-coded
GOLDEN="$REPO/harness/contracts/hook-liveness.json"
export GLASSPANE_REPO="$REPO"              # plugin.ts resolves the declared-hook list through this
# Where the pinned opencode install lives; the plugin's imports resolve against
# ITS node_modules, so the run directory has to sit inside it (Bun/node walk up
# from the module's own path — a symlinked node_modules elsewhere is not enough).
OC_BIN="${OC_BIN:-/Volumes/Eng-Dev/.upstream/spike/node_modules/opencode-darwin-arm64/bin/opencode}"
OC_ROOT="$(cd "$(dirname "$OC_BIN")/../../.." 2>/dev/null && pwd || echo "")"
WORK="${HARNESS_SPIKE_WORK:-${OC_ROOT:-${TMPDIR:-/tmp}/gp-harness-spike}/.spike-run}"
BUN_BIN="${BUN_BIN:-$(command -v bun || echo /tmp/bun-tools/node_modules/.bin/bun)}"
ISO="${OPENCODE_TEST_HOME:-/tmp/oc-spike/home}"
PORT="${HARNESS_SPIKE_PORT:-4199}"
MOCK_PORT="${HARNESS_SPIKE_MOCK_PORT:-4310}"

missing=()
[ -x "$OC_BIN" ] || missing+=("opencode binary ($OC_BIN) — npm i opencode-ai@$(node -p "require('/Volumes/Eng-Dev/GlassPane/harness/upstream.json').tag.replace(/^v/,'')" 2>/dev/null || echo '<pin>')")
[ -x "$BUN_BIN" ] || missing+=("bun ($BUN_BIN) — npm i --prefix /tmp/bun-tools bun@1.3.14")
if [ ${#missing[@]} -gt 0 ]; then
  echo "SKIPPED: dependencies missing, nothing was measured."
  printf '  - %s\n' "${missing[@]}"
  exit 3
fi

rm -rf "$WORK"; mkdir -p "$WORK" "$ISO"
cp "$HERE/plugin.ts" "$HERE/mock-model.mjs" "$HERE/e6-tool-exec.ts" "$WORK/"
if [ ! -d "$WORK/node_modules" ] && [ ! -e "$OC_ROOT/node_modules" ]; then
  echo "SKIPPED: $OC_ROOT has no node_modules — the pinned opencode is not installed there."; exit 3
fi
# plugin.ts / e6 reference their own directory; point them at the run dir.
sed -i.bak "s#/Volumes/Eng-Dev/.upstream/spike#$WORK#g" "$WORK"/*.ts && rm -f "$WORK"/*.bak

export OPENCODE_TEST_HOME="$ISO" XDG_CONFIG_HOME="$ISO/.config" XDG_DATA_HOME="$ISO/.local/share" \
       XDG_STATE_HOME="$ISO/.local/state" npm_config_cache=/tmp/npm-cache \
       GLASSPANE_SOCKET="${GLASSPANE_SOCKET:-$HOME/.glasspane/engine.sock}"

fails=0
say() { printf '%-46s %s\n' "$1" "$2"; }

echo "### E6 — plugin tool body under Bun (the runtime opencode plugins actually use)"
( cd "$WORK" && "$BUN_BIN" e6-tool-exec.ts > e6.log 2>&1 ); e6rc=$?
tail -6 "$WORK/e6.log" | sed 's/^/    /'
if [ $e6rc -ne 0 ]; then say "E6 execute" "FAIL (exit $e6rc)"; fails=$((fails+1));
elif grep -q "REMEDY VISIBLE TO THE MODEL (.*): yes" "$WORK/e6.log"; then say "E6 execute + remedy-in-output" "PASS";
else say "E6 execute" "FAIL — the model only reads output; remedy must be in it"; fails=$((fails+1)); fi

echo
echo "### E1/E2 — does the engine load the plugin, and does it keep the raw tool id"
cat > "$WORK/opencode.json" <<JSON
{ "\$schema": "https://opencode.ai/config.json", "plugin": ["./plugin.ts"] }
JSON
rm -f "$WORK/hooks-fired.jsonl"
( cd "$WORK" && exec "$OC_BIN" serve --port "$PORT" ) > "$WORK/serve.log" 2>&1 &
SRV=$!
up=""
for _ in $(seq 1 60); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/global/health" >/dev/null 2>&1; then up=1; break; fi
  sleep 1
done
if [ -z "$up" ]; then
  say "serve boot" "FAIL — never became healthy (see $WORK/serve.log)"; fails=$((fails+1))
else
  say "serve boot" "PASS"
  # Instance-scoped routes need ?directory=; without it they hang, so a probe
  # that omits it does not prove anything about the registry.
  ids="$(curl -fsS --max-time 30 -H "x-opencode-directory: $WORK" "http://127.0.0.1:$PORT/experimental/tool/ids?directory=$WORK" 2>/dev/null || true)"
  if printf '%s' "$ids" | grep -q '"gp_probe_status"'; then say "E2 gp_probe_status registered, raw id" "PASS"
  else say "E2 gp_probe_status registered" "FAIL — got: $(printf '%s' "$ids" | head -c 160)"; fails=$((fails+1)); fi
  if [ -f "$WORK/hooks-fired.jsonl" ]; then
    say "E1 plugin loaded (config hook reached)" "PASS"
    node -e '
      const fs=require("fs");
      const rows=fs.readFileSync("'"$WORK"'/hooks-fired.jsonl","utf8").trim().split("\n").filter(Boolean).map(l=>JSON.parse(l));
      const acc=[...new Set(rows.filter(r=>r.kind==="accessed").map(r=>r.hook))].sort();
      const golden=JSON.parse(fs.readFileSync("'"$GOLDEN"'","utf8"));
      const dead=golden.hooks.filter(h=>h.kind==="dead").map(h=>h.name);
      const hitDead=dead.filter(n=>acc.includes(n));
      console.log("    hooks reached: "+JSON.stringify(acc));
      console.log("    statically-dead hooks observed firing: "+JSON.stringify(hitDead)+(hitDead.length?"  <-- CONTRADICTION with the golden":""));
      process.exit(hitDead.length?1:0);
    ' || { say "dead-hook cross-check" "FAIL"; fails=$((fails+1)); }
  else
    say "E1 plugin loaded" "FAIL — no hooks-fired.jsonl; the plugin never ran"
    fails=$((fails+1))
    grep -iE "plugin|error|warn" "$WORK/serve.log" | tail -8 | sed 's/^/      serve.log: /'
  fi
fi
kill "$SRV" 2>/dev/null; sleep 1; kill -9 "$SRV" 2>/dev/null

if [ "${1:-}" = "--demo" ]; then
  echo
  echo "### E5 — upstream's own offline mode: render a permission request, then ask who got called"
  pkill -f "opencode-darwin-arm64/bin/opencode" 2>/dev/null || true
  rm -f "$WORK/hooks-fired.jsonl" "$WORK/demo.log"
  # `--mini` picks the project from the CWD, so it has to run inside $WORK where
  # opencode.json registers the plugin — otherwise the probe measures nothing.
  ( cd "$WORK" && script -q "$WORK/demo.log" "$OC_BIN" --mini --demo --prompt "/permission" ) < /dev/null > /dev/null 2>&1 &
  DP=$!
  # Wait for the artifact of the thing we are measuring, not for a wall clock:
  # boot takes 15-30 s and the card only appears after the demo prompt lands.
  card=""
  for _ in $(seq 1 90); do
    if grep -qaE "Permission required|Allow once" "$WORK/demo.log" 2>/dev/null; then card=1; break; fi
    kill -0 "$DP" 2>/dev/null || break
    sleep 1
  done
  pkill -f "opencode-darwin-arm64/bin/opencode" 2>/dev/null || true; kill "$DP" 2>/dev/null
  sleep 1
  strip() { sed -E 's/\x1b\[[0-9;?]*[a-zA-Z]//g; s/\r/\n/g' "$WORK/demo.log" | grep -v '^[[:space:]]*$'; }
  if [ -n "$card" ]; then
    strip | grep -aE "Permission required|→ Edit|Allow once|Reject" | head -2 | cut -c1-200 | sed 's/^/      card: /'
  else
    echo "      (no permission card appeared)"
  fi
  # The verdict needs BOTH halves: something to measure, and the measurement.
  if [ ! -f "$WORK/hooks-fired.jsonl" ]; then
    say "E5" "FAIL — plugin never loaded under --mini; this run measured nothing"; fails=$((fails+1))
  elif [ -z "$card" ]; then
    say "E5" "INCONCLUSIVE — no permission request was rendered, so dispatch cannot be judged"; fails=$((fails+1))
  elif grep -q '"hook":"permission.ask"' "$WORK/hooks-fired.jsonl"; then
    say "E5" "FAIL — permission.ask WAS dispatched; the golden calls it dead"
    fails=$((fails+1))
  else
    say "E5 permission rendered; permission.ask never dispatched" "PASS (see README for the demo-mode boundary)"
  fi
fi

echo
[ $fails -eq 0 ] && { echo "all executed probes passed"; exit 0; }
echo "$fails probe(s) failed"
exit 1
