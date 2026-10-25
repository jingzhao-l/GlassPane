#!/usr/bin/env node
/*
 * kernel-pin-selftest — proves the provenance gate can go red, and that each red tells the
 * truth about which side disagreed.
 *
 *   node harness/tools/kernel-pin-selftest.mjs
 *
 * Why this exists and is not just a `--check` run: kernel-pin's failure path used to print one
 * generic remedy for four different diagnoses, and that sentence named `--record` in the exact
 * state where recording destroys the golden (lock + manifest agreeing on 0.1.7 while
 * node_modules still held 0.1.5). An operator following it would have rewritten 26 hashes from
 * the wrong artifact and turned the gate green on bytes no release ever shipped. So every case
 * here asserts the *named* problem and the *named* advice, not merely exit 1 — a collapse back
 * to one-size-fits-all text fails these assertions by name.
 *
 * Nothing in the real tree is touched: each case builds a throwaway product root under a 0700
 * temp directory and runs the real script against it. The fixture refuses rather than answers —
 * an assertion whose expected string is empty is a FAIL, because `grep ""` matches anything.
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const PACKAGE = "iterate-kernel"
const REAL_SCRIPT = path.resolve(import.meta.dirname, "../glasspane-harness/script/kernel-pin.mjs")
const INTEG = "sha512-AAAA=="
const root = mkdtempSync(path.join(tmpdir(), "gp-kernel-pin-selftest-"))
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

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex")

/** What a correct golden says for this tree — computed from the bytes on disk, not typed in. */
function corpusFor(pkg) {
  return ["fixtures/a.ok-01.json", "fixtures/b.ok-01.json", "schemas/a.schema.json", "schemas/b.schema.json"].map((file) => ({
    file,
    sha256: sha256(path.join(pkg, file)),
  }))
}

/**
 * Build one throwaway product root. Every field is written from `want` independently, so a case
 * can make exactly one side disagree while the others stay consistent.
 */
function build(name, want) {
  const dir = path.join(root, name)
  const pkg = path.join(dir, "node_modules", PACKAGE)
  mkdirSync(path.join(pkg, "fixtures"), { recursive: true })
  mkdirSync(path.join(pkg, "schemas"), { recursive: true })
  mkdirSync(path.join(dir, "script"), { recursive: true })
  mkdirSync(path.join(dir, "contracts"), { recursive: true })
  writeFileSync(path.join(dir, "product.json"), `${JSON.stringify({ name: "glasspane-harness", version: "0.0.0" }, null, 2)}\n`)
  cpSync(REAL_SCRIPT, path.join(dir, "script", "kernel-pin.mjs"))
  writeFileSync(path.join(pkg, "package.json"), `${JSON.stringify({ name: PACKAGE, version: want.installedVersion }, null, 2)}\n`)
  writeFileSync(path.join(pkg, "fixtures", "a.ok-01.json"), '{"fixture":"a"}\n')
  writeFileSync(path.join(pkg, "fixtures", "b.ok-01.json"), '{"fixture":"b"}\n')
  writeFileSync(path.join(pkg, "schemas", "a.schema.json"), '{"schema":"a"}\n')
  writeFileSync(path.join(pkg, "schemas", "b.schema.json"), want.schemaBytes ?? '{"schema":"b"}\n')
  writeFileSync(
    path.join(dir, "bun.lock"),
    lockText(dir, want.lockVersion ?? want.pinVersion, want.lockSpecifier ?? "", want.lockIntegrity),
  )
  // A second install at the package level: `installedDirs()` reads the package copy first, and the
  // gate refuses outright when the two disagree — which copy the product loads is not knowable from
  // here, so a pin recorded over the wrong one would be provenance fiction. Neither half of that
  // refusal had ever been driven with real bytes until 2026-10-25.
  if (want.packageLevelVersion) {
    const atPackage = path.join(dir, "packages", "opencode", "node_modules", PACKAGE)
    mkdirSync(path.join(atPackage, "fixtures"), { recursive: true })
    mkdirSync(path.join(atPackage, "schemas"), { recursive: true })
    writeFileSync(path.join(atPackage, "package.json"), `${JSON.stringify({ name: PACKAGE, version: want.packageLevelVersion }, null, 2)}\n`)
    writeFileSync(path.join(atPackage, "fixtures", "a.ok-01.json"), '{"fixture":"a"}\n')
    writeFileSync(path.join(atPackage, "fixtures", "b.ok-01.json"), want.packageCorpusB ?? '{"fixture":"b"}\n')
    writeFileSync(path.join(atPackage, "schemas", "a.schema.json"), '{"schema":"a"}\n')
    writeFileSync(path.join(atPackage, "schemas", "b.schema.json"), want.schemaBytes ?? '{"schema":"b"}\n')
  }
  if (want.golden !== false) {
    writeFileSync(
      path.join(dir, "contracts", "kernel-pin.json"),
      `${JSON.stringify(
        {
          package: PACKAGE,
          version: want.pinVersion,
          resolution: {
            from: "registry",
            lockKey: want.pinLockKey ?? `${PACKAGE}@${want.pinVersion}`,
            specifier: "",
            integrity: want.pinIntegrity ?? want.lockIntegrity,
          },
          canonical: { repo: "jingzhao-l/iterate-skill", path: "kernel", branch: "main" },
          recordedAt: "2026-01-01",
          corpus: corpusFor(pkg),
        },
        null,
        2,
      )}\n`,
    )
  }
  return dir
}

function lockText(dir, version, specifier, integrity) {
  void dir
  return `{\n  "lockVersion": 1,\n  "packages": {\n    "${PACKAGE}": ["${PACKAGE}@${version}", ${JSON.stringify(specifier)}, {"dependencies": {"zod": ">=3.25.76 <5"}}, "${integrity}"],\n    "unrelated": ["unrelated@1.0.0", "", {}, "sha512-ZZZ=="]\n  }\n}\n`
}

function run(dir, ...args) {
  const r = spawnSync(process.execPath, [path.join(dir, "script", "kernel-pin.mjs"), ...args], { encoding: "utf8" })
  return { rc: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }
}

/**
 * `--probe` spawns `npm` off PATH, so a probe case has to control PATH rather than the script.
 * `npmStub` is the answer the fake registry gives; `null` means put no npm on PATH at all.
 */
function runProbe(dir, name, answer) {
  const bin = path.join(root, `${name}-bin`)
  mkdirSync(bin, { recursive: true })
  if (answer !== null) {
    writeFileSync(path.join(bin, "npm"), `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(answer)}\n`)
    chmodSync(path.join(bin, "npm"), 0o755)
  } else {
    rmSync(path.join(bin, "npm"), { force: true })
  }
  const r = spawnSync(process.execPath, [path.join(dir, "script", "kernel-pin.mjs"), "--probe"], {
    encoding: "utf8",
    // With no stub the point of the case is that npm cannot be found, so PATH has to be only the
    // empty bin directory — inheriting the real PATH leaves the real npm in reach and the probe
    // answers (measured: it reported `DRIFTED — publishes 0.1.10`, exit 0, for want of a PATH).
    env: { ...process.env, PATH: answer === null ? bin : `${bin}:${process.env.PATH}` },
  })
  return { rc: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }
}

// 1 — a healthy tree: install, lock and golden all describe the same artifact.
{
  const dir = build("healthy", { installedVersion: "0.1.7", pinVersion: "0.1.7", lockIntegrity: INTEG })
  const r = run(dir, "--check")
  check("healthy tree passes --check", r.rc === 0, `rc=${r.rc} ${r.out.slice(0, 200)}`)
  check("and reports how many contract files it hashed", r.out.includes("4 pinned contract file(s)"), r.out.trim().slice(0, 120))
  const rec = run(dir, "--record")
  check("--record is allowed on a healthy tree", rec.rc === 0, `rc=${rec.rc} ${rec.out.slice(0, 200)}`)
  const before = readFileSync(path.join(dir, "contracts", "kernel-pin.json"), "utf8")
  run(dir, "--record")
  check("--record is idempotent", readFileSync(path.join(dir, "contracts", "kernel-pin.json"), "utf8") === before, "")
}

// 2 — the state measured on 2026-10-14: lock and golden both say 0.1.7, node_modules holds 0.1.5.
{
  const dir = build("stale-install", { installedVersion: "0.1.5", pinVersion: "0.1.7", lockIntegrity: INTEG })
  const r = run(dir, "--check")
  check("a stale install goes red", r.rc === 1, `rc=${r.rc}`)
  check("and names the version gap", r.out.includes("installed 0.1.5 but the manifest pins 0.1.7"), r.out.slice(0, 200))
  check("and tells the operator NOT to re-record", r.out.includes("Do NOT run --record from a stale install"), r.out.slice(0, 400))
  check("and gives the one command that actually works", r.out.includes("Run `bun install` in"), r.out.slice(0, 400))
  const rec = run(dir, "--record")
  check("--record refuses over a stale install", rec.rc === 1 && rec.out.includes("--record refused"), `rc=${rec.rc} ${rec.out.slice(0, 200)}`)
  check("and the refusal names the side it distrusts", rec.out.includes("bun.lock resolves"), rec.out.slice(0, 200))
  check("and the golden was left alone", readFileSync(path.join(dir, "contracts", "kernel-pin.json"), "utf8").includes('"version": "0.1.7"'), "")
}

// 3 — same version, same integrity, different corpus bytes: a republished artifact. The golden
// is written from the original bytes first, then the installed file is changed underneath it.
{
  const dir = build("corpus-moved", { installedVersion: "0.1.7", pinVersion: "0.1.7", lockIntegrity: INTEG })
  writeFileSync(path.join(dir, "node_modules", PACKAGE, "schemas", "b.schema.json"), '{"schema":"b","republished":true}\n')
  const r = run(dir, "--check")
  check("a corpus that moved at a pinned version goes red", r.rc === 1, `rc=${r.rc}`)
  check("and names the file", r.out.includes("schemas/b.schema.json sha256"), r.out.slice(0, 200))
  check("and forbids blessing the swap", r.out.includes("Do NOT re-record"), r.out.slice(0, 500))
  check("and states the invariant at stake", r.out.includes("must not move"), r.out.slice(0, 500))
}

// 4 — the lock moved under the golden (dependency line bumped without re-recording).
{
  const dir = build("lock-moved", { installedVersion: "0.1.6", pinVersion: "0.1.7", lockVersion: "0.1.6", lockIntegrity: INTEG })
  const r = run(dir, "--check")
  check("a lock that disagrees with the golden goes red", r.rc === 1, `rc=${r.rc}`)
  check("and says the two sides disagree", r.out.includes("the lock and the manifest disagree"), r.out.slice(0, 500))
  check("and offers the bump path", r.out.includes("bump the dependency line"), r.out.slice(0, 500))
  check("and does not mislabel this as a stale install", !r.out.includes("Do NOT run --record from a stale install"), r.out.slice(0, 500))
}

// 5 — a hand-edited golden is internally inconsistent before the tree is even consulted.
{
  const dir = build("hand-edited", { installedVersion: "0.1.7", pinVersion: "0.1.7", pinLockKey: `${PACKAGE}@0.1.4`, lockIntegrity: INTEG })
  const r = run(dir, "--check")
  check("a hand-edited golden goes red", r.rc === 1, `rc=${r.rc}`)
  check("and names the inconsistency", r.out.includes("internally inconsistent"), r.out.slice(0, 300))
}

// 6 — no golden is not a pass.
{
  const dir = build("no-golden", { installedVersion: "0.1.7", pinVersion: "0.1.7", lockIntegrity: INTEG, golden: false })
  const r = run(dir, "--check")
  check("a missing golden goes red and names --record", r.rc === 1 && r.out.includes("no contracts/kernel-pin.json"), `rc=${r.rc} ${r.out.slice(0, 200)}`)
}

// 7 — a `file:`/`link:` resolution is not the registry, whatever the golden claims.
{
  const dir = build("linked", { installedVersion: "0.1.7", pinVersion: "0.1.7", lockIntegrity: INTEG })
  writeFileSync(path.join(dir, "bun.lock"), lockText(dir, "0.1.7", "../kernel", INTEG))
  const r = run(dir, "--check")
  check("a non-registry resolution goes red", r.rc === 1 && r.out.includes("not the registry"), `rc=${r.rc} ${r.out.slice(0, 200)}`)
}

// 8 — two installs that disagree: the gate refuses instead of picking a winner. Nothing drove this
// branch before 2026-10-25, so `installedDirs()`'s ordering and this refusal were both claims on paper.
{
  const dir = build("two-copies-disagree", { installedVersion: "0.1.5", pinVersion: "0.1.5", lockIntegrity: INTEG, packageLevelVersion: "0.1.7" })
  const r = run(dir, "--check")
  check("two disagreeing installs exit 2, not whichever order happens to suit", r.rc === 2, `rc=${r.rc} ${r.out.slice(0, 300)}`)
  check("and name both paths", r.out.includes("two different iterate-kernel installs") && r.out.includes(path.join("packages", "opencode", "node_modules")), r.out.slice(0, 400))
  check("and tell the operator what resolves it", r.out.includes("until they agree"), r.out.slice(0, 400))
}

// 9 — two installs that agree are fine, and the copy that gets hashed is the package-level one the
// product resolves first. Proven by making only that copy's bytes differ: a root-only reading would
// stay green here, which is exactly the false clearance the refusal in case 8 exists to prevent.
{
  const dir = build("two-copies-agree", { installedVersion: "0.1.7", pinVersion: "0.1.7", lockIntegrity: INTEG, packageLevelVersion: "0.1.7" })
  check("agreeing installs pass", run(dir, "--check").rc === 0, run(dir, "--check").out.slice(0, 300))
  writeFileSync(path.join(dir, "packages", "opencode", "node_modules", PACKAGE, "fixtures", "b.ok-01.json"), '{"fixture":"B-DIFFERENT"}\n')
  const r = run(dir, "--check")
  check("and the package-level corpus is the one being measured", r.rc === 1 && r.out.includes("fixtures/b.ok-01.json"), r.out.slice(0, 400))
}

// 10-12 — `--probe`'s exit code IS its consumer's verdict (the weekly kernel-drift job reads nothing
// else). The 2026-10-16 fix that made "cannot ask" an exit 2 had no case driving it: the only probe
// battery in the tree, probe-lane-selftest.sh, stubs hook-liveness.
{
  const dir = build("probe-same", { installedVersion: "0.1.7", pinVersion: "0.1.7", lockIntegrity: INTEG })
  const same = runProbe(dir, "probe-same", "0.1.7")
  check("a probe the registry answers is exit 0", same.rc === 0, `rc=${same.rc} ${same.out.slice(0, 300)}`)
  check("and says the pin is the published latest", same.out.includes("is the published latest"), same.out.slice(0, 300))

  const drift = runProbe(dir, "probe-drift", "0.2.0")
  check("a newer published kernel is a finding, not a CI red (exit 0)", drift.rc === 0, `rc=${drift.rc} ${drift.out.slice(0, 300)}`)
  check("and names both versions", drift.out.includes("DRIFTED") && drift.out.includes("publishes 0.2.0") && drift.out.includes("we pin 0.1.7"), drift.out.slice(0, 400))

  const silent = runProbe(dir, "probe-silent", "")
  check("a registry that answers nothing exits 2", silent.rc === 2, `rc=${silent.rc} ${silent.out.slice(0, 300)}`)
  check("and says drift cannot be judged", silent.out.includes("answered nothing"), silent.out.slice(0, 300))

  const missing = runProbe(dir, "probe-missing", null)
  check("no npm on PATH exits 2 rather than reading as green", missing.rc === 2, `rc=${missing.rc} ${missing.out.slice(0, 300)}`)
  check("and states that the question was NOT answered", missing.out.includes("the drift question was NOT answered"), missing.out.slice(0, 400))
}

console.log(failures === 0 ? "kernel-pin-selftest: every case verified red, and red for the named reason" : `kernel-pin-selftest: ${failures} assertion(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
