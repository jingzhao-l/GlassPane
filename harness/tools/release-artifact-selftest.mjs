#!/usr/bin/env node
/**
 * Fixed-point test for `release-artifact.mjs` — the gate that asks whether the published
 * repository's `main` and the released tag are byte-for-byte trunk's `harness/glasspane-harness`.
 *
 * What it has to prove is not "the tool runs against GitHub" but that **each named rule goes red
 * for its own reason, and only for that reason**. That distinction is the whole content of this
 * file: on 2026-10-16 trunk and the published repository disagreed in BOTH directions at once
 * (the split was missing 74 lines trunk had, and trunk had lost one line the split still held),
 * and a single combined "the trees differ" check would report that state identically to either
 * one alone. So the battery asserts rule-by-rule colour, including the two cases where one rule
 * is green while the other is red.
 *
 * The fixtures are production-shaped: real `git init` repositories, real commits, **annotated**
 * tags (the split repo's tags are annotated, so `refs/tags/v…` names a tag object the tool has to
 * peel to reach a tree — a lightweight-tag fixture would pass without proving that), and the
 * remote reached over `file://` through the same `product.json -> repoUrl` field production reads.
 * Both sides get byte-identical `product.json`, or every case would differ for the wrong reason.
 * Nothing is mocked.
 *
 * Controls, because a test that cannot fail is not evidence:
 *   1. a neutered copy of the tool (its tree comparisons replaced by `true`) must report
 *      agreement on a KNOWN-divergent fixture — if it still went red, the reds below would be
 *      caused by something other than the comparison and would prove nothing about it;
 *   2. an unreachable remote and a dirty subtree must exit 2, never 0: "cannot measure" and
 *      "passed" are different claims and must not be purchasable with the same exit code;
 *   3. `--record` must be refused — a golden here would let a stale artifact be recorded as
 *      expected, which is the面-A escape hatch pointed at the one number that may not be baselined.
 *
 * Exit codes: 0 every battery answered as named, 1 a battery answered otherwise, 2 the fixtures
 * could not be built at all (no `git`), which is a machine without a measurement, not a pass.
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const TOOL = path.join(here, "release-artifact.mjs")
const SUBTREE = path.join("harness", "glasspane-harness")
const failures = []
const ok = (label) => console.log(`ok    ${label}`)
const bad = (label) => {
  failures.push(label)
  console.log(`FAIL  ${label}`)
}

const tryGit = (args) => {
  try {
    return execFileSync("git", args, { encoding: "utf8" })
  } catch {
    return null
  }
}
if (tryGit(["--version"]) === null) {
  console.error("release-artifact selftest: NOT self-tested — `git` is not runnable here, so no fixture repository could be built. Exiting 2: this file proves nothing without real commits to compare.")
  process.exit(2)
}

const identity = ["-c", "user.name=selftest", "-c", "user.email=selftest@example.invalid"]
const g = (dir, ...args) => {
  const out = tryGit(["-C", dir, ...identity, ...args])
  if (out === null) throw new Error(`fixture build failed: git -C ${dir} ${args.join(" ")}`)
  return out.trim()
}
const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}

// Read-only git for the purity battery: it must never write, so it takes no identity and no
// mutation arguments.
const g2 = (dir, ...args) => {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" })
  } catch {
    return ""
  }
}
const scratchCount = () => {
  try {
    return readdirSync(tmpdir()).filter((d) => d.startsWith("release-artifact-")).length
  } catch {
    return 0
  }
}

const runTool = (args, env = {}) => {
  try {
    return { rc: 0, text: execFileSync(process.execPath, [TOOL, ...args], { encoding: "utf8", env: { ...process.env, ...env } }) }
  } catch (e) {
    return { rc: e.status ?? 1, text: `${e.stdout ?? ""}${e.stderr ?? ""}` }
  }
}

// A fixture is a trunk repository whose `harness/glasspane-harness` holds `trunkFiles`, and a
// published repository whose ROOT holds `splitFiles` — which is literally what
// `git subtree split --prefix=harness/glasspane-harness` produces — tagged at `tag`, optionally
// with `aheadFiles` committed after the tag so main moves past the released tree.
const scratch = path.join(tmpdir(), `release-artifact-selftest-${process.pid}`)
rmSync(scratch, { recursive: true, force: true })
mkdirSync(scratch, { recursive: true })

const fixture = (name, { trunkFiles, splitFiles, version = "0.1.0", tag = "v0.1.0", aheadFiles = null, urlOverride = null }) => {
  const splitDir = path.join(scratch, `${name}-split`)
  const trunkDir = path.join(scratch, `${name}-trunk`)
  mkdirSync(splitDir, { recursive: true })
  mkdirSync(trunkDir, { recursive: true })
  g(splitDir, "init", "-q", "-b", "main")
  g(trunkDir, "init", "-q", "-b", "main")
  const url = urlOverride ?? pathToFileURL(splitDir).href
  // The manifest the tool reads is inside the subtree, so it is part of the compared bytes: both
  // sides get the same rendered JSON, and only the case that means to differ differs.
  const manifest = (files) => `${JSON.stringify({ ...JSON.parse(files["product.json"]), version, repoUrl: url }, null, 2)}\n`

  for (const [rel, text] of Object.entries(splitFiles)) write(path.join(splitDir, rel), rel === "product.json" ? manifest(splitFiles) : text)
  g(splitDir, "add", "-A")
  g(splitDir, "commit", "-q", "-m", "published initial")
  if (tag) g(splitDir, "tag", "-a", tag, "-m", `release ${tag}`)
  if (aheadFiles) {
    for (const [rel, text] of Object.entries(aheadFiles)) write(path.join(splitDir, rel), text)
    g(splitDir, "add", "-A")
    g(splitDir, "commit", "-q", "-m", "published moved past the tag")
  }

  for (const [rel, text] of Object.entries(trunkFiles)) write(path.join(trunkDir, SUBTREE, rel), rel === "product.json" ? manifest(trunkFiles) : text)
  g(trunkDir, "add", "-A")
  g(trunkDir, "commit", "-q", "-m", "trunk initial")
  return { splitDir, trunkDir, url }
}

const expect = (label, repoDir, { rc, mustInclude = [], mustNotInclude = [] }) => {
  const before = failures.length
  const got = runTool(["--check", "--repo", repoDir])
  if (got.rc !== rc) bad(`${label}: exited ${got.rc}, expected ${rc}\n${got.text}`)
  for (const needle of mustInclude) if (!got.text.includes(needle)) bad(`${label}: exited ${got.rc} but never named "${needle}" — a red that does not name its rule is not a control\n${got.text}`)
  for (const needle of mustNotInclude) if (got.text.includes(needle)) bad(`${label}: also reported "${needle}", so the two rules are not answering independently\n${got.text}`)
  if (failures.length === before) ok(`${label}: exit ${got.rc}, named as expected`)
  return got
}

const base = { "product.json": `{"name":"fixture-harness","version":"0.1.0","repoUrl":"https://example.invalid/none"}\n`, "SYNCLOG.md": "line one\nline two\n" }

// A. the state a round ends in when it releases what it committed: everything equal.
expect("A equal trees agree", fixture("equal", { trunkFiles: base, splitFiles: base }).trunkDir, {
  rc: 0,
  mustInclude: ["split-main: split refs/heads/main", "artifact: v0.1.0", "0 problem(s)"],
})

// B. trunk received bytes the published repository never got — the 74-line closeout shape.
expect("B trunk ahead", fixture("trunk-ahead", { trunkFiles: { ...base, "NEW.md": "trunk only\n" }, splitFiles: base }).trunkDir, {
  rc: 1,
  mustInclude: ["✗ split-main", "✗ artifact", "trunk-only, i.e. absent from the published bytes: 1", "NEW.md"],
})

// C. the published repository holds a line trunk lost — the `draft=false` shape. The file exists
// on both sides, so no path changed sides: the only thing that can make this visible is the
// line-level direction, and it has to be named as a re-split risk.
expect(
  "C published ahead of trunk",
  fixture("split-ahead", { trunkFiles: base, splitFiles: { ...base, "SYNCLOG.md": "line one\nline two\nline three trunk never got\n" } }).trunkDir,
  {
    rc: 1,
    mustInclude: ["✗ split-main", "✗ artifact", "⚠ RE-SPLIT RISK", "SYNCLOG.md (+1 remote-only line(s) / -0 trunk-only line(s))"],
  },
)

// C2. the same direction, but as a whole file the published repository has and trunk lacks.
expect(
  "C2 published-only file",
  fixture("split-file", { trunkFiles: base, splitFiles: { ...base, "EXTRA.md": "never landed in trunk\n" } }).trunkDir,
  { rc: 1, mustInclude: ["published-only, i.e. a whole file trunk does not have: 1", "EXTRA.md", "⚠ RE-SPLIT RISK"] },
)

// D. nothing has ever been tagged at the declared version: split-main is GREEN, artifact is red.
// A combined "does anything differ" check would call this identical to B and hide the diagnosis.
expect("D declared version never released", fixture("no-tag", { trunkFiles: base, splitFiles: base, tag: null }).trunkDir, {
  rc: 1,
  mustInclude: ["✗ artifact", "no tag v0.1.0", "✓ split-main"],
  mustNotInclude: ["✗ split-main"],
})

// E. the tag exists but main moved past it, on a path that is NOT the ledger: split-main green,
// artifact red, and the ledger allowance must not soften that red.
expect(
  "E tag behind main on a non-ledger path",
  fixture("tag-stale", { trunkFiles: { ...base, "LATER.md": "committed after the tag\n" }, splitFiles: base, aheadFiles: { "LATER.md": "committed after the tag\n" } }).trunkDir,
  { rc: 1, mustInclude: ["✗ artifact", "LATER.md", "✓ split-main"], mustNotInclude: ["✗ split-main", "△"] },
)

// J. the state a round legitimately ends in: the 搬运 branch is current, and the tag lags trunk
// only by the release's own record. That is exit 0 WITH a named `△` line — never exit 0 quietly,
// and never a golden somebody can --record over.
expect(
  "J artifact lags trunk by its own ledger only",
  fixture("ledger-lag", {
    trunkFiles: { ...base, "SYNCLOG.md": "line one\nline two\nline three written after the tag\n" },
    splitFiles: base,
    aheadFiles: { "SYNCLOG.md": "line one\nline two\nline three written after the tag\n" },
  }).trunkDir,
  { rc: 0, mustInclude: ["1 tolerated lag(s)", "△ artifact", "✓ split-main", "0 problem(s)"], mustNotInclude: ["✗ artifact"] },
)

// J2. a difference whose bytes cannot be read is NOT a difference of zero lines. `git diff
// --no-index --numstat` answers `-` for a binary pair, and `linesOf` folds any non-numeric to 0,
// so the ledger allowance used to classify an unreadable shared file as "the artifact lags trunk by
// 0 line(s)" and exit 0. This fixture differs on both sides by a binary file that is neither of the
// two ledger paths, which is also the ordinary shape of a released asset landing in the tree.
{
  const binary = { ...base, "assets/icon.png": "PNG\x00\x01\x02\xff\xfe trunk bytes\n" }
  const other = { ...base, "assets/icon.png": "PNG\x00\x03\x04\xff other bytes here\n" }
  expect("J2 an unreadable line delta refuses instead of scoring zero", fixture("binary-delta", { trunkFiles: binary, splitFiles: other }).trunkDir, {
    rc: 2,
    mustInclude: ["could not be materialized"],
    mustNotInclude: ["0 problem(s)", "△ artifact"],
  })
}

// K. the measurement must not leave anything behind in the repository it measures. This is not
// decoration: fetching the published repository into the measured object store with `--depth 1`
// appends the fetched tip to `.git/shallow`, and a shallow marker truncates history traversal —
// which silently falsifies `git merge-base --is-ancestor`, the exact check a subtree push uses to
// prove it is not overwriting anything. Measured 2026-10-16: nine such markers in the parent repo,
// each with all of its parents present locally, one of them making an already-published 搬运 tip
// look un-landed so its branch was kept "for safety".
{
  const f = fixture("purity", { trunkFiles: base, splitFiles: base })
  const before = scratchCount()
  const got = runTool(["--check", "--repo", f.trunkDir])
  if (got.rc !== 0) bad(`K: the equal fixture should agree, got exit ${got.rc} — the purity claims below would be vacuous, since a tool that crashed also leaves nothing behind\n${got.text}`)
  else {
    const shallow = path.join(f.trunkDir, ".git", "shallow")
    const strayRefs = g2(f.trunkDir, "for-each-ref", "--format=%(refname)", "refs/artifact")
    if (existsSync(shallow)) bad("K: the run wrote .git/shallow into the measured repository — a depth-limited fetch grafted history there, and every ancestry answer taken from this repository afterwards is suspect")
    else ok("K live: no .git/shallow left in the measured repository")
    if (strayRefs.trim() !== "") bad(`K: the run left refs in the measured repository:\n${strayRefs}`)
    else ok("K live: no refs written into the measured repository")
    const after = scratchCount()
    if (after > before) bad(`K: the scratch store was not cleaned up (${before} → ${after} release-artifact-* directories under tmpdir)`)
    else ok("K live: the scratch object store it needed was removed")
  }
}

// F. an unreachable remote is "cannot measure", never a pass.
expect("F unreachable remote refuses", fixture("dead-url", { trunkFiles: base, splitFiles: base, urlOverride: pathToFileURL(path.join(scratch, "no-such-repo")).href }).trunkDir, {
  rc: 2,
  mustInclude: ["CANNOT MEASURE", "git ls-remote"],
})

// G. a dirty subtree is not a state anybody released: refuse instead of comparing.
{
  const f = fixture("dirty", { trunkFiles: base, splitFiles: base })
  write(path.join(f.trunkDir, SUBTREE, "SYNCLOG.md"), "line one\nuncommitted edit\n")
  expect("G dirty subtree refuses", f.trunkDir, { rc: 2, mustInclude: ["CANNOT MEASURE", "uncommitted changes"] })
}

// H. control: with both tree comparisons turned into `true`, a KNOWN-divergent fixture must look
// fine. If it still went red, none of the batteries above are proving the comparison.
{
  const source = readFileSync(TOOL, "utf8")
  const neutered = source.replace("if (mainTree === trunkTree) agreements.push", "if (true) agreements.push").replace("if (tagTree === trunkTree) agreements.push", "if (true) agreements.push")
  if (neutered === source) bad("control could not be built: the tree comparisons in release-artifact.mjs no longer look like the lines this battery neuters")
  else {
    const copy = path.join(scratch, "release-artifact-neutered.mjs")
    writeFileSync(copy, neutered)
    const divergent = fixture("neuter", { trunkFiles: { ...base, "NEW.md": "trunk only\n" }, splitFiles: base })
    let rc = 0
    try {
      execFileSync(process.execPath, [copy, "--check", "--repo", divergent.trunkDir], { encoding: "utf8" })
    } catch (e) {
      rc = e.status ?? 1
    }
    if (rc === 0) ok("control live: the neutered copy calls the divergent fixture an agreement, so the real reds come from the comparison")
    else bad(`the neutered copy went red (exit ${rc}) on a divergent fixture — its red is not the tree comparison, so the batteries above prove nothing about the anchor`)
  }
}

// I. `--record` is not a mode, and refusing it is exit 2 rather than a silent acceptance.
{
  const dir = fixture("record", { trunkFiles: base, splitFiles: base }).trunkDir
  const got = runTool(["--record", "--repo", dir])
  if (got.rc === 2 && got.text.includes("--record is not a mode")) ok("--record is refused with exit 2: a stale artifact cannot be baselined over")
  else bad(`--record answered exit ${got.rc} (expected 2 with a named refusal): ${got.text}`)
}

// J. A remote that goes silent must still be answered with exit 2, in bounded time. Measured twice
// on 2026-10-23 from one machine: the two-ref `--depth 1` fetch of the published repository hung with
// no bytes moving for over ten minutes, which on CI is not a red but a runner timeout — the one
// failure mode that leaves no verdict at all. The stub below accepts the connection and never
// answers, which is that shape reproduced locally; the guard is shrunk through the tool's own env
// seam so the case costs seconds instead of the shipped 300 s.
{
  const stalledSockets = []
  const stalled = createServer((socket) => {
    socket.on("error", () => {})
    // Deliberately no response, ever: the client is left waiting on a live connection.
    stalledSockets.push(socket)
  })
  await new Promise((resolve) => stalled.listen(0, "127.0.0.1", resolve))
  const stallPort = stalled.address().port
  const dir = fixture("stalled-remote", {
    trunkFiles: base,
    splitFiles: base,
    urlOverride: `http://127.0.0.1:${stallPort}/none.git`,
  }).trunkDir
  const started = Date.now()
  const got = runTool(["--check", "--repo", dir], { GP_ARTIFACT_NET_TIMEOUT_MS: "2000", GP_ARTIFACT_NET_LOW_SPEED_TIME: "1000" })
  const elapsed = Date.now() - started
  if (got.rc !== 2) bad(`J stalled remote: exited ${got.rc}, expected 2 — silence must not buy a green\n${got.text}`)
  else if (!got.text.includes("could not be reached")) bad(`J stalled remote: exit 2 but did not name the reason\n${got.text}`)
  else if (elapsed > 60_000) bad(`J stalled remote: the guard took ${Math.round(elapsed / 1000)} s — a stall that outwaits its own timeout is still a hang`)
  else ok(`J stalled remote: exit 2, named, in ${(elapsed / 1000).toFixed(1)} s`)
  for (const socket of stalledSockets) socket.destroy()
  await new Promise((resolve) => stalled.close(resolve))

  // The same refusal with no bytes ever flowing: a port nobody listens on must reach the same
  // answer, so case J's pass cannot be an artefact of the timeout alone.
  const dead = createServer(() => {})
  await new Promise((resolve) => dead.listen(0, "127.0.0.1", resolve))
  const deadPort = dead.address().port
  await new Promise((resolve) => dead.close(resolve))
  const refused = fixture("refused-remote", {
    trunkFiles: base,
    splitFiles: base,
    urlOverride: `http://127.0.0.1:${deadPort}/none.git`,
  }).trunkDir
  const refusedRun = runTool(["--check", "--repo", refused], { GP_ARTIFACT_NET_TIMEOUT_MS: "5000" })
  if (refusedRun.rc === 2 && refusedRun.text.includes("could not be reached")) ok("J refused remote: exit 2 for the same named reason, without waiting on a timer")
  else bad(`J refused remote: exited ${refusedRun.rc}\n${refusedRun.text}`)

  // And the guard must not be a hair trigger: a sub-second override is refused rather than honoured,
  // so nobody can turn this gate into a coin flip by setting an unusable number.
  const hair = fixture("hair-trigger", { trunkFiles: base, splitFiles: base }).trunkDir
  const hairRun = runTool(["--check", "--repo", hair], { GP_ARTIFACT_NET_TIMEOUT_MS: "1" })
  if (hairRun.rc === 0) ok("J a 1 ms override is ignored: the equal-tree case still passes on the shipped default")
  else bad(`J the floor did not hold: an unusably small override changed the answer (exit ${hairRun.rc})\n${hairRun.text}`)
}

rmSync(scratch, { recursive: true, force: true })
if (failures.length) {
  console.log(`release-artifact selftest: ${failures.length} check(s) failed`)
  process.exit(1)
}
console.log("release-artifact selftest: each rule goes red for its own reason, and a remote that will not answer never buys a green")
