#!/usr/bin/env node
/*
 * zod-bundle-selftest — proves the bundle-attribution gate can go red, that each red names its own
 * reason, and that it does not cry at the thing that is progress.
 *
 *   node harness/tools/zod-bundle-selftest.mjs
 *
 * WHY. The gate's subject is a number nobody looked at until 2026-10-24: the release bundle carries
 * three zod copies and two of them sit below the version that fixes the advisory. A gate over that
 * fact is only a control if a new copy reddens it, if a contradictory account reddens it, and if a
 * copy LEAVING the bundle does not. The third one is the case that decides whether this gate survives
 * its first week: a check that blocks improvement gets turned off.
 *
 * Everything runs through the tool's own seams (`--reading`, `--contract`) against fixtures under a
 * 0700 temp directory, so the tree's real contract is never rewritten and the only real-graph run is
 * the one that also proves the probe works.
 */
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const TOOL = path.join(here, "zod-bundle.mjs")
const REAL_CONTRACT = path.join(here, "..", "contracts", "zod-bundle.json")
const root = mkdtempSync(path.join(tmpdir(), "gp-zod-bundle-selftest-"))
chmodSync(root, 0o700)

let failures = 0
const check = (label, ok, detail = "") => {
  if (ok) {
    console.log(`ok    ${label}`)
    return
  }
  console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`)
  failures += 1
}

const contract = JSON.parse(readFileSync(REAL_CONTRACT, "utf8"))
const fixtureContract = (copies, extra = {}) => {
  const file = path.join(root, `contract-${fixtureContract.n++}.json`)
  writeFileSync(file, JSON.stringify({ advisory: { id: "GHSA-mrhx-c7xc-m3w5", fixedIn: "4.6.6" }, copies, ...extra }, null, 2))
  return file
}
fixtureContract.n = 0
const fixtureReading = (obj) => {
  const file = path.join(root, `reading-${fixtureReading.n++}.json`)
  writeFileSync(file, typeof obj === "string" ? obj : JSON.stringify(obj))
  return file
}
fixtureReading.n = 0

const runTool = (args, env) => {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8", env: env ?? process.env, timeout: 300_000 })
  return { rc: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }
}
const run = (reading, contractFile) => runTool(["--reading", reading, "--contract", contractFile])

try {
  // 1 the honest tree: the real probe over the real graph, against the real contract.
  {
    const r = runTool([])
    check("the shipped gate answers about the real bundle", r.rc === 0 || r.rc === 1, `rc=${r.rc} ${r.out.slice(0, 400)}`)
    check("and states how many bundled copies sit below the fixed version", /advisory GHSA-mrhx-c7xc-m3w5: fixed in 4\.6\.6; \d+ bundled copy/.test(r.out), r.out.slice(0, 400))
    check("naming the three copies it counted", (r.out.match(/zod@\d+\.\d+\.\d+ \(\d+\)/g) ?? []).length >= 3, r.out.slice(0, 400))
  }

  // 2 a copy nobody attributed is red, and is named.
  {
    const c = fixtureContract([{ copy: "zod@4.6.7", modules: 107, vulnerable: false, why: "ours" }])
    const reading = fixtureReading({ copies: { "zod@4.6.7": 107, "zod@5.0.1": 3 }, entrypoints: ["./src/index.ts"], dropped: [], external: [] })
    const r = run(reading, c)
    check("a new zod copy in the bundle is red", r.rc === 1, `rc=${r.rc} ${r.out.slice(0, 300)}`)
    check("naming the copy and the missing attribution", r.out.includes("zod@5.0.1") && r.out.includes("not attributed"), r.out.slice(0, 300))
  }

  // 3 the account and the arithmetic must agree.
  {
    const c = fixtureContract([{ copy: "zod@3.25.76", modules: 10, vulnerable: false, why: "claims it is fine" }])
    const reading = fixtureReading({ copies: { "zod@3.25.76": 10 }, entrypoints: [], dropped: [], external: [] })
    const r = run(reading, c)
    check("a vulnerable copy recorded as safe is red", r.rc === 1, `rc=${r.rc} ${r.out.slice(0, 300)}`)
    check("and says the record disagrees with the comparison", r.out.includes("the account and the arithmetic disagree"), r.out.slice(0, 300))
  }

  // 4 progress is not an offence.
  {
    const c = fixtureContract([{ copy: "zod@4.6.7", modules: 107, vulnerable: false, why: "ours" }, { copy: "zod@3.25.76", modules: 10, vulnerable: true, why: "left the graph" }])
    const reading = fixtureReading({ copies: { "zod@4.6.7": 107 }, entrypoints: [], dropped: [], external: [] })
    const r = run(reading, c)
    check("a copy that LEAVES the bundle is not red", r.rc === 0, `rc=${r.rc} ${r.out.slice(0, 300)}`)
    check("and it is reported as the fix landing", r.out.includes("the fix landing"), r.out.slice(0, 300))
  }

  // 5 a version the tool cannot order is refused rather than waved through.
  {
    const c = fixtureContract([])
    const reading = fixtureReading({ copies: { "zod@next": 4 }, entrypoints: [], dropped: [], external: [] })
    const r = run(reading, c)
    check("an unorderable version is red, not a pass", r.rc === 1, `rc=${r.rc} ${r.out.slice(0, 300)}`)
    check("naming that it cannot rank the copy", r.out.includes("cannot rank"), r.out.slice(0, 300))
  }

  // 6-9 the four ways it cannot measure.
  {
    const reading = fixtureReading({ copies: { "zod@4.6.7": 1 }, entrypoints: [], dropped: [], external: [] })
    const missing = path.join(root, "no-such-contract.json")
    let r = runTool(["--reading", reading, "--contract", missing])
    check("no contract exits 2", r.rc === 2, `rc=${r.rc} ${r.out.slice(0, 300)}`)
    check("and says so", r.out.includes("not in the tree"), r.out.slice(0, 300))

    r = run(reading, fixtureContract([], { advisory: { id: "X", fixedIn: null } }))
    check("a contract without a fixed version exits 2", r.rc === 2, `rc=${r.rc} ${r.out.slice(0, 300)}`)
    check("naming `advisory.fixedIn` as the missing piece", r.out.includes("advisory.fixedIn"), r.out.slice(0, 300))

    r = runTool(["--reading", fixtureReading("this is not json at all"), "--contract", fixtureContract([])])
    check("an unreadable reading exits 2", r.rc === 2, `rc=${r.rc} ${r.out.slice(0, 300)}`)

    r = runTool(["--reading", path.join(root, "nope.json"), "--contract", fixtureContract([])])
    check("--reading naming no file exits 2 rather than passing", r.rc === 2, `rc=${r.rc} ${r.out.slice(0, 300)}`)

    r = runTool(["--reading", fixtureReading({ copies: {}, entrypoints: [], dropped: [], external: [] }), "--contract", fixtureContract([])])
    check("an empty set of copies is 'nothing was measured', not 'nothing vulnerable'", r.rc === 2, `rc=${r.rc} ${r.out.slice(0, 300)}`)
  }

  // 10 with no bun on PATH, the real-probe path refuses — it must not read as a clean bundle.
  {
    const env = { ...process.env, PATH: "/nonexistent-selftest" }
    const r = runTool([], env)
    check("no bun on PATH exits 2", r.rc === 2, `rc=${r.rc} ${r.out.slice(0, 300)}`)
    check("and names bun and where to run it", r.out.includes("bun") && r.out.includes("harness-rulers"), r.out.slice(0, 300))
  }

  // 11 the module counts moving is the graph, not the set — so it must not redden, and must be said.
  {
    const c = fixtureContract([{ copy: "zod@4.6.7", modules: 107, vulnerable: false, why: "ours" }])
    const reading = fixtureReading({ copies: { "zod@4.6.7": 111 }, entrypoints: [], dropped: [], external: [] })
    const r = run(reading, c)
    check("a copy growing modules is not red", r.rc === 0, `rc=${r.rc} ${r.out.slice(0, 300)}`)
    check("but the drift is stated", /recorded 107 module file\(s\), now 111/.test(r.out), r.out.slice(0, 300))
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(failures === 0 ? "zod-bundle-selftest: every case verified red, and red for the named reason" : `zod-bundle-selftest: ${failures} assertion(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
