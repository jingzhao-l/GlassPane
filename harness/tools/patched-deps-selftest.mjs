#!/usr/bin/env node
/*
 * patched-deps-selftest — proves the patch-integrity gate can go red, and that each red names the
 * side that disagreed.
 *
 *   node harness/tools/patched-deps-selftest.mjs
 *
 * Why the battery is shaped like this: the accident the gate exists for (2026-10-23, MCP SDK
 * 1.31.0 -> 1.32.0) is invisible to every other control in the tree — typecheck reads our own
 * surface, the suites drive fake transports, and the bundle was built before the drop. A gate that
 * only ever gets run on a healthy tree is that same invisibility with a green checkmark on it, so
 * each case here makes exactly one thing disagree and asserts the sentence the gate must tell about
 * it. A case that expects only "exit 1" would still pass if the gate collapsed to one generic
 * message, which is the failure kernel-pin's selftest was written to catch.
 *
 * Two cases hold the gate back against over-reach, because a gate that cries at every multi-version
 * package gets deleted rather than tuned: an uninstalled declaration is a `△`, and extra versions
 * beside a covered one are a `△`. Both assert exit 0 *and* the note, so turning either into a red
 * fails here by name.
 *
 * Nothing in the real tree is touched. Each case builds a throwaway product root under a 0700 temp
 * directory, and the fixture patches come from a real `git diff` between two generated trees — not
 * from a hand-typed patch that would agree with whatever this file's parser expects.
 */
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const REAL_SCRIPT = path.resolve(import.meta.dirname, "../glasspane-harness/script/patched-deps.mjs")
const root = mkdtempSync(path.join(tmpdir(), "gp-patched-deps-selftest-"))
chmodSync(root, 0o700)

let failures = 0
const check = (label, ok, detail = "") => {
  if (!label) {
    console.log("FAIL  an assertion arrived with no label — a blank expectation matches anything")
    failures += 1
    return
  }
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${!ok && detail ? ` — ${detail}` : ""}`)
  if (!ok) failures += 1
}

/** A real git-format patch for `files: {rel: content}` -> `{rel: patched}`. */
function makePatch(name, before, after) {
  const dir = path.join(root, `patch-src-${name}`)
  mkdirSync(dir, { recursive: true })
  const git = (...args) => spawnSync("git", ["-c", "core.hooksPath=off", ...args], { cwd: dir, encoding: "utf8" })
  const init = git("init", "-q", ".")
  if (init.status !== 0) return null
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base")
  for (const [rel, content] of Object.entries(before)) {
    const file = path.join(dir, rel)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  git("add", "-A")
  for (const [rel, content] of Object.entries(after)) {
    writeFileSync(path.join(dir, rel), content)
  }
  git("add", "-A")
  const diff = git("diff", "--cached")
  if (diff.status !== 0) return null
  return diff.stdout
}

/**
 * One throwaway product root. `want.patched` decides whether the installed file carries the patch's
 * added lines, `want.lock` whether the lock's patchedDependencies still names the key, `want.installed`
 * the version sitting in node_modules — so a case can move exactly one of the three.
 */
function build(name, want = {}) {
  const installed = want.installed ?? "1.0.0"
  const keyVersion = want.keyVersion ?? "1.0.0"
  const inGraph = want.inGraph ?? true
  const patched = want.patched ?? true
  const lockKey = want.lockKey ?? `example@${keyVersion}`
  const targetFile = "dist/index.js"
  const pristine = `const a = 1\nif (dead) {\n  throw new Error("no")\n}\nexport { a }\n`
  const withPatch = `const a = 1\nif (alive) {\n  mark("recovered")\n}\nexport { a }\n`
  const patchText = makePatch(name, { [targetFile]: pristine }, { [targetFile]: withPatch })
  if (patchText === null) return null

  const dir = path.join(root, name)
  mkdirSync(dir, { recursive: true })
  const pkgDir = path.join(dir, "node_modules", ".bun", `example@${installed}`, "node_modules", "example")
  writeFileSync(path.join(dir, "product.json"), `${JSON.stringify({ name: "glasspane-harness", version: "0.0.0" }, null, 2)}\n`)
  mkdirSync(path.join(dir, "script"), { recursive: true })
  mkdirSync(path.join(dir, "patches"), { recursive: true })
  spawnSync("cp", [REAL_SCRIPT, path.join(dir, "script", "patched-deps.mjs")])
  writeFileSync(path.join(dir, "patches", `example@${keyVersion}.patch`), patchText)
  if (inGraph) {
    mkdirSync(path.join(pkgDir, "dist"), { recursive: true })
    writeFileSync(path.join(pkgDir, "package.json"), `${JSON.stringify({ name: "example", version: installed }, null, 2)}\n`)
    writeFileSync(path.join(pkgDir, targetFile), patched ? withPatch : pristine)
  }
  // A second, healthy declaration. Case 7 needs one: with a single stale declaration the gate has
  // located nothing at all, and "nothing located" is its own exit-2 answer — see case 10.
  const declarations = { [`example@${keyVersion}`]: `patches/example@${keyVersion}.patch` }
  const lockEntries = [want.lockKey === false ? null : `    ${JSON.stringify(lockKey)}: ${JSON.stringify(`patches/example@${keyVersion}.patch`)},`]
  if (want.withOther) {
    const otherPatch = makePatch(`other-${name}`, { "dist/index.js": pristine }, { "dist/index.js": withPatch })
    const otherDir = path.join(dir, "node_modules", ".bun", "other@1.0.0", "node_modules", "other")
    mkdirSync(path.join(otherDir, "dist"), { recursive: true })
    writeFileSync(path.join(otherDir, "package.json"), `${JSON.stringify({ name: "other", version: "1.0.0" }, null, 2)}\n`)
    writeFileSync(path.join(otherDir, "dist", "index.js"), withPatch)
    writeFileSync(path.join(dir, "patches", "other@1.0.0.patch"), otherPatch)
    declarations["other@1.0.0"] = "patches/other@1.0.0.patch"
    lockEntries.push(`    ${JSON.stringify("other@1.0.0")}: ${JSON.stringify("patches/other@1.0.0.patch")},`)
  }
  const lockLines = [`  "patchedDependencies": {`, ...lockEntries.filter(Boolean), "  },"]
  writeFileSync(path.join(dir, "bun.lock"), `{\n  "lockfileVersion": 1,\n${lockLines.join("\n")}\n}\n`)
  writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: "fork-root", patchedDependencies: declarations }, null, 2)}\n`,
  )
  return { dir, pkgDir, pristine, withPatch, patchPath: path.join(dir, "patches", `example@${keyVersion}.patch`) }
}

function run(built, ...args) {
  if (!built) return { rc: null, out: "fixture construction failed: git unavailable" }
  const r = spawnSync(process.execPath, [path.join(built.dir, "script", "patched-deps.mjs"), ...args], { encoding: "utf8" })
  return { rc: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }
}

// 1 — the healthy shape: key, lock and installed bytes all describe the same patched artifact.
{
  const b = build("healthy")
  const r = run(b, "--check")
  check("a tree whose install carries its patch passes --check", r.rc === 0, `rc=${r.rc} ${r.out.slice(0, 300)}`)
  check("and says it measured one patch rather than asserting nothing", r.out.includes("1/1 declared patch(es) checked against installed bytes"), r.out.trim().slice(0, 200))
}

// 2 — the measured accident: the dependency line moved to 1.32.0, the patch key stayed on 1.31.0,
// and bun dropped the entry from the lock without a word.
{
  const b = build("version-drift", { installed: "2.0.0", keyVersion: "1.0.0", lockKey: false, patched: false })
  const r = run(b, "--check")
  check("a patch whose key no longer matches any installed copy goes red", r.rc === 1, `rc=${r.rc} ${r.out.slice(0, 300)}`)
  check("and names both versions", r.out.includes("patch declares 1.0.0") && r.out.includes("the install carries only 2.0.0"), r.out.slice(0, 400))
  check("and states the consequence, not just the difference", r.out.includes("nothing loads these bytes"), r.out.slice(0, 400))
  check("and does not misattribute it to the lock", !r.out.includes("absent from bun.lock"), r.out.slice(0, 400))
}

// 3 — the drop's own signature: same version, key vanished from the lock. Versions alone cannot tell
// this apart from a healthy tree, so the lock is read as a third witness.
{
  const b = build("lock-dropped", { lockKey: false })
  const r = run(b, "--check")
  check("a key missing from bun.lock's patchedDependencies goes red", r.rc === 1, `rc=${r.rc} ${r.out.slice(0, 300)}`)
  check("and says the install was never told to apply it", r.out.includes("absent from bun.lock's patchedDependencies"), r.out.slice(0, 400))
  check("and names the patch it lost", r.out.includes("example@1.0.0"), r.out.slice(0, 300))
}

// 4 — the sharpest case: package.json and bun.lock both claim the patch and the version matches, yet
// the installed bytes do not carry it. Only reading the artifact finds this.
{
  const b = build("unapplied", { patched: false })
  const r = run(b, "--check")
  check("an installed copy that does not carry the patch's lines goes red", r.rc === 1, `rc=${r.rc} ${r.out.slice(0, 300)}`)
  check("and reports how many lines are missing out of how many", /2\/\d+ line\(s\) the patch adds are not in/.test(r.out), r.out.slice(0, 400))
  check("and quotes a line the patch adds", r.out.includes("alive"), r.out.slice(0, 400))
  check("and says plainly that the patch did not reach the bytes", r.out.includes("the patch did not reach the installed bytes"), r.out.slice(0, 400))
}

// 5 — an absent target file is not shrugged at: an unapplied patch commonly looks like the file the
// patch edits simply not being there.
{
  const b = build("missing-target")
  rmSync(path.join(b.pkgDir, "dist", "index.js"))
  const r = run(b, "--check")
  check("a patch target missing from the install goes red", r.rc === 1, `rc=${r.rc} ${r.out.slice(0, 300)}`)
  check("and names the file and the directory", r.out.includes("dist/index.js targeted by the patch is absent"), r.out.slice(0, 400))
}

// 6 — a declared patch file that is not in the tree.
{
  const b = build("patch-absent")
  rmSync(b.patchPath)
  const r = run(b, "--check")
  check("a declared patch file missing from the tree goes red", r.rc === 1 && r.out.includes("declared but not in the tree"), `rc=${r.rc} ${r.out.slice(0, 300)}`)
  check("and is not swallowed by the nothing-was-measured answer", !r.out.includes("nothing was measured"), r.out.slice(0, 300))
}

// 7 — over-reach guard: the package is not in this graph at all. Upstream's leftover declaration is a
// finding, not this round's verdict, and the gate must say which it is.
{
  const b = build("not-installed", { inGraph: false, withOther: true })
  const r = run(b, "--check")
  check("an uninstalled declaration is a note, not a red", r.rc === 0, `rc=${r.rc} ${r.out.slice(0, 300)}`)
  check("and is called stale in the note", r.out.includes("not in this install graph — stale declaration"), r.out.slice(0, 300))
  check("and is kept out of the count of patches actually read", r.out.includes("1/2 declared patch(es)"), r.out.slice(0, 300))
}

// 8 — over-reach guard for the shape the first draft of this gate got wrong: a package installed at
// the patched version *and* at extra versions. The extra copies are upstream's graph, not a lost patch.
{
  const b = build("multi-version", {})
  const extra = path.join(b.dir, "node_modules", ".bun", "example@9.9.9", "node_modules", "example")
  mkdirSync(path.join(extra, "dist"), { recursive: true })
  writeFileSync(path.join(extra, "package.json"), `${JSON.stringify({ name: "example", version: "9.9.9" }, null, 2)}\n`)
  writeFileSync(path.join(extra, "dist", "index.js"), b.pristine)
  const r = run(b, "--check")
  check("extra uncovered versions beside a covered one stay green", r.rc === 0, `rc=${r.rc} ${r.out.slice(0, 400)}`)
  check("and are reported as a finding", r.out.includes("also installed at 9.9.9 with no patch key covering them"), r.out.slice(0, 400))
  check("and still count as measured", r.out.includes("1/1 declared patch(es)"), r.out.slice(0, 300))
}

// 9 — "cannot measure" is its own exit, and it must not be reachable as a pass.
{
  const b = build("no-node-modules", { inGraph: false })
  rmSync(path.join(b.dir, "node_modules"), { recursive: true, force: true })
  const r = run(b, "--check")
  check("an uninstalled tree exits 2, not 0", r.rc === 2, `rc=${r.rc} ${r.out.slice(0, 300)}`)
  check("and tells the operator to install", r.out.includes("run `bun install` before measuring"), r.out.slice(0, 300))
}

// 10 — node_modules exists but holds none of the declared patches: a half-done install is not a
// clean one, and "no failures" here would be a claim about bytes nobody read.
{
  const b = build("empty-store")
  rmSync(path.join(b.dir, "node_modules", ".bun", "example@1.0.0"), { recursive: true, force: true })
  mkdirSync(path.join(b.dir, "node_modules", "unrelated"), { recursive: true })
  writeFileSync(path.join(b.dir, "node_modules", "unrelated", "package.json"), '{"name":"unrelated","version":"1.0.0"}\n')
  const r = run(b, "--check")
  check("a tree where nothing could be located exits 2", r.rc === 2, `rc=${r.rc} ${r.out.slice(0, 300)}`)
  check("and says nothing was measured", r.out.includes("nothing was measured"), r.out.slice(0, 300))
}

// 11 — the gate's own text is part of the contract: the remedy has to name the action, and an
// unknown mode must refuse rather than fall through to a measurement.
{
  const b = build("bad-mode")
  const r = run(b, "--verify")
  check("an unknown mode exits 2 and names what it expected", r.rc === 2 && r.out.includes("expected --check"), `rc=${r.rc} ${r.out.slice(0, 300)}`)
}

console.log(
  failures === 0
    ? "patched-deps-selftest: every case verified red, and red for the named reason"
    : `patched-deps-selftest: ${failures} assertion(s) FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
