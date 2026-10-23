#!/usr/bin/env bash
# verify-published 的固定点测试。
#
# 这条发布闸判断"已发布的那份二进制真的在供内嵌 web"。它有两半：页面对不对（产品的责任），
# 以及我们有没有机会看到页面（机器的责任）。把两半并成一个 FAIL 的版本在 2026-10-11 把一次
# 好发布报成了坏发布，因为机器忙到 15 秒内起不来。所以这里用三个假前缀把三条分支各跑一遍：
#
#   good    真页面（doctype + /assets/ 引用）      → ok
#   error   一个 text/html 的错误页，没有打包产物    → FAIL，并且点名"real serving failure"
#   silent  永远不打印 listening on                → NOT OBSERVED，且退出码不得为 0
#
# error 那条就是反向控制：判据若退化成套一句 `/<html/i`（历史上正是这个形状），这个假发布物
# 会蒙混过关，本测试当场变红。
#
# 用法：sh harness/tools/verify-published-selftest.sh    （在仓库根或任何地方跑都行）
# 退出码：0 三条分支各给出自己的答案；1 某条分支答错了；2 跑不了（bun/node 不在 PATH 或闸脚本
# 不在树里）——"测不了"以前也是 0，那与"通过"共用一个退出码，正是本仓反复要抓的形状。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# VP_GATE overrides which gate is under test, so the mutation battery can point this at a
# neutered *copy* of it. The shipped file is never edited to prove a test works.
GATE="${VP_GATE:-$ROOT/harness/glasspane-harness/packages/opencode/script/verify-published.ts}"
PRODUCT="$ROOT/harness/glasspane-harness/product.json"
fails=0
say() { printf '%-8s %s\n' "$1" "$2"; }

# 缺工具不等于闸红，也不等于闸过了：这两行以前 `say SKIP` 之后 `exit 0`，于是"这台机器上什么都没
# 测"和"发布闸的三条分支都验过了"共用一个退出码。本仓的分码语义是 0 通过 / 1 判决不成立 / 2 测不了
# （verify-published.ts 的 NOT OBSERVED、hook-liveness 缺参照检出都是 2），这里照办：不能跑就是 2，
# 并且把没跑的东西点名说出来。CI 的 harness-rulers job 在上面刚装过钉死的 bun、也给过 setup-node，
# 所以在那里退 2 就是缺陷，不是豁免。
command -v bun >/dev/null 2>&1 || { say FAIL "bun is not on PATH — the release gate was NOT exercised (exit 2: cannot measure is not a pass)"; exit 2; }
# The gate reads product.json through node, and the fake command the gate is pointed at is a
# node script. A missing node used to surface three lines later as `NAME: unbound variable`,
# which reads like a broken test rather than the environment it is.
command -v node >/dev/null 2>&1 || { say FAIL "node is not on PATH — the release gate was NOT exercised (exit 2: cannot measure is not a pass)"; exit 2; }
[ -f "$GATE" ] || { say FAIL "gate script not found at $GATE"; exit 2; }

eval "$(node -e '
const p = require(process.argv[1])
const q = (v) => JSON.stringify(v)
console.log(`NAME=${q(p.name)}`)
console.log(`BINARY=${q(p.binary)}`)
console.log(`BINS=${q((p.bins && p.bins.length ? p.bins : [p.binary]).join(" "))}`)
console.log(`VERSION=${q(p.version)}`)
console.log(`OS_FIELD=${q(q(p.platform.os))}`)
console.log(`CPU_FIELD=${q(q(p.platform.arch))}`)
' "$PRODUCT")"

# The artifact-patch check's demand list is asked of the gate that owns the criterion, never
# retyped here: a second copy of the rule in the test would keep passing after the rule changed.
# An empty list stops this file, because a fake binary that carries nothing would satisfy a check
# that has nothing to check.
PATCH_GATE="$ROOT/harness/glasspane-harness/script/patched-deps.mjs"
ITEMS_JSON="$(node "$PATCH_GATE" --items --package @modelcontextprotocol/sdk 2>/dev/null)"
if [ -z "$ITEMS_JSON" ] || [ "$ITEMS_JSON" = "[]" ]; then
  say FAIL "the patch's artifact-checkable items came back empty — the release gate was NOT exercised (exit 2: nothing to demand is not a pass)"
  exit 2
fi
ITEMS="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).join("\n"))' "$ITEMS_JSON")"

SHIM_DIR="$(mktemp -d "${TMPDIR:-/tmp}/gp-vp-shim-XXXXXX")"
cat > "$SHIM_DIR/fake-binary.js" <<'SHIM'
// A stand-in for the installed product command: same argv, same "listening on" line, same
// content-type. Only the page it serves is decided by GP_FAKE_PAGE.
const fs = require("fs")
const http = require("http")
const path = require("path")
const version = process.env.GP_FAKE_VERSION
const argv = process.argv.slice(2)
if (argv.includes("--version")) {
  console.log(version)
  process.exit(0)
}
if (!argv.includes("serve")) {
  console.error("fake binary: expected `serve --port <n>`")
  process.exit(64)
}
const port = Number(argv[argv.indexOf("--port") + 1])
const mode = process.env.GP_FAKE_PAGE || "good"
const good =
  "<!doctype html>\n<html lang=\"en\"><head><script src=\"/assets/index.js\"></script>" +
  "<link href=\"/assets/style.css\" rel=\"stylesheet\"></head><body>glasspane-harness</body></html>\n"
const error = "<html><body><h1>Internal Server Error</h1></body></html>\n"
if (mode === "silent") {
  // Never says it is listening, never answers: the machine-shaped failure.
  setTimeout(() => process.exit(0), 60000)
} else {
  http
    .createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      res.end(mode === "good" ? good : error)
    })
    .listen(port, "127.0.0.1", () => {
      console.log(`glasspane-harness server listening on http://127.0.0.1:${port}`)
    })
}
void path
void fs
SHIM

make_prefix() {
  # $1 = page mode; $2 = "yes" (default) to build a *patched* fake binary, "no" for one whose bytes
  # lack everything the declared patch must show. Prints the prefix path, or nothing on failure.
  local p mode markers
  mode="$1"
  markers="${2:-yes}"
  p="$(mktemp -d "${TMPDIR:-/tmp}/gp-vp-prefix-$mode-XXXXXX")" || return 1
  mkdir -p "$p/bin" "$p/lib/node_modules/$NAME" || return 1
  printf '{"name":"%s","version":"%s","os":%s,"cpu":%s}\n' \
    "$NAME" "$VERSION" "$OS_FIELD" "$CPU_FIELD" > "$p/lib/node_modules/$NAME/package.json" || return 1
  for b in $BINS; do
    printf '#!/bin/sh\nGP_FAKE_VERSION="%s" exec node "$GP_FAKE_SHIM" "$@"\n' "$VERSION" > "$p/bin/$b" || return 1
    if [ "$markers" = "yes" ]; then
      # The published payload is a compiled binary whose bytes carry these strings; the stand-in
      # carries them as a trailing comment so the check reads real bytes that really contain them.
      printf '# patched-payload: %s\n' "$(printf '%s' "$ITEMS" | tr '\n' ' ')" >> "$p/bin/$b" || return 1
    fi
    chmod +x "$p/bin/$b" || return 1
  done
  echo "$p"
}

run_case() {
  # $1 = page mode, $2 = expected label, $3 = expected rc ("" = must not be 0, "0" = must be 0,
  # "no-web-fail" = the web label must not appear as FAIL), $4 = version to ask for,
  # $5 = "no" to install a binary that does NOT carry the patch's bytes
  local mode want_label want_rc ask_version out rc pfx matched markers
  mode="$1"
  want_label="$2"
  want_rc="${3-}"
  ask_version="${4:-$VERSION}"
  markers="${5:-yes}"
  # An empty expectation is not a passing expectation: `grep -qF ""` matches every line, and
  # that is how this file once reported three green checks while `$mode` was never assigned
  # and every case ran the same fake. Refuse the shape instead of being satisfied by it.
  if [ -z "$want_label" ]; then
    say FAIL "$mode: the test asked for no line — refusing to call that a pass"
    fails=$((fails + 1))
    return
  fi
  pfx="$(make_prefix "$mode" "$markers")"
  if [ -z "$pfx" ]; then
    say FAIL "$mode: could not build the fake prefix"
    fails=$((fails + 1))
    return
  fi
  out="$(GP_FAKE_SHIM="$SHIM_DIR/fake-binary.js" GP_FAKE_PAGE="$mode" GLASSPANE_VERIFY_LISTENING_POLLS=12 \
    bun "$GATE" "$ask_version" --prefix "$pfx" 2>&1)"
  rc=$?
  rm -rf "$pfx"
  printf '%s\n' "$out" > "/var/tmp/gp-vp-selftest-$mode-${ask_version//./_}.log"
  # Shell substring match, not `grep`: the gate's own lines contain em dashes, and a grep
  # that decides piped UTF-8 is "binary data" silently stops matching — which in a test that
  # prints `ok`/`FAIL` reads as the gate having changed its wording.
  local matched=0
  case "$out" in *"$want_label"*) matched=1 ;; esac
  if [ "$matched" -eq 1 ]; then
    say ok "$mode@$ask_version: the gate printed $(printf '%s\n' "$out" | awk -v pat="$want_label" 'index($0,pat){print; exit}' | cut -c1-96)"
  else
    say FAIL "$mode@$ask_version: expected a line matching '$want_label' (full output in /var/tmp/gp-vp-selftest-$mode-${ask_version//./_}.log)"
    fails=$((fails + 1))
  fi
  case "$want_rc" in
  no-web-fail)
    # The healthy branch is about the WEB verdict, not about the registry. Asking for
    # `product.json`'s version means the registry checks can legitimately fail on a version
    # that has not been published yet — and this file went red for exactly that reason the
    # first time the version line moved past the published one. So the assertion is scoped to
    # the branch under test: a fake prefix that serves the real page must not be read as a
    # serving failure, whatever the install-side checks say.
    case "$out" in
    *"FAIL  the installed binary serves the embedded web app"*)
      say FAIL "$mode@$ask_version: a complete page was judged a serving failure"
      fails=$((fails + 1))
      ;;
    *)
      say ok "$mode@$ask_version: web branch healthy (rc $rc; any failure in it is an install/registry check this fake does not control)"
      ;;
    esac
    ;;
  *)
    if [ -n "$want_rc" ]; then
      if [ "$rc" -eq "$want_rc" ]; then
        say ok "$mode@$ask_version: exit $rc as expected"
      else
        say FAIL "$mode@$ask_version: exit $rc, expected $want_rc"
        fails=$((fails + 1))
      fi
    elif [ "$rc" -eq 0 ]; then
      say FAIL "$mode@$ask_version: exit 0 — a release the gate could not observe must never look like a pass"
      fails=$((fails + 1))
    else
      say ok "$mode@$ask_version: exit $rc (non-zero, so an unobserved claim cannot be read as a pass)"
    fi
    ;;
  esac
}

# The FAIL branch, named: a page that is HTML but is not the embedded app. A predicate that
# had degenerated to `/<html/i` — the shape this check used to have — would pass this fake.
run_case error "FAIL  the installed binary serves the embedded web app" 1
# The unobservable branch: the server never says it is listening. Must not exit 0.
run_case silent "NOT OBSERVED  the installed binary serves the embedded web app" ""
# The healthy branch, so the two above cannot be green-by-construction: this fake prefix
# serves the real page, so the web verdict must be `ok` and must not be a serving failure.
run_case good "ok    the installed binary serves the embedded web app" no-web-fail
# The version that was asked for is the version that is checked. The fake prefix carries
# product.json's version, so asking for a different one has to surface in the manifest gate's
# own words — a parser that dropped the positional argument would print the asked-for number
# and quietly verify another one.
run_case good "the version asked for was 9.9.9" "" "9.9.9"

# The artifact-patch branch, both ways round. `good` above already installs a payload that carries
# the patch's bytes, so asking for the ok line here proves the check runs and passes on real bytes;
# the second case builds the same prefix with a payload that does NOT carry them and requires the
# failure to be named. Without the pair, a check that always prints `ok` (the shape this release
# lane had before) would look exactly as green here as one that measures.
run_case good "ok    the published bytes carry the fork's MCP SDK patch" no-web-fail
run_case good "FAIL  the published bytes carry the fork's MCP SDK patch" 1 "$VERSION" no

rm -rf "$SHIM_DIR"
if [ "$fails" -gt 0 ]; then
  echo "verify-published selftest: $fails check(s) failed"
  exit 1
fi
echo "verify-published selftest: the release gate gives three different answers to three different situations"
