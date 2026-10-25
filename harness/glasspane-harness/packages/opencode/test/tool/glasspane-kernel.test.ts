import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import type { DecisionOutcome, EvidencePack } from "../../src/tool/glasspane/kernel"
import { kernelContractFile, kernelFixture, kernelFixturesDir, kernelPackageDir } from "../lib/kernel-contract"

import { Global } from "@opencode-ai/core/global"
import { xdgData } from "xdg-basedir"
import { resolveSocket, stateRootOf } from "../../src/tool/glasspane/daemon"

import {
  decisionStamp,
  entryHashOf,
  logDecision,
  outcomeOf,
  readEvidenceFrame,
  readRunPlan,
  resolveLedger,
  summaryOf,
  verifyLedger,
} from "../../src/tool/glasspane/kernel"

/**
 * M3/M2 fixed-point tests for the fork's kernel binding
 * (`src/tool/glasspane/kernel.ts`) against the installed `iterate-kernel`
 * dependency, pinned by `contracts/kernel-pin.json`.
 *
 * Two things are being pinned here that nothing else in this repository can:
 *
 *  1. **Cross-language, cross-zod-major parity of the semantic contract.** The
 *     canonical kernel pins zod 3.25.76; the fork resolves zod 4.1.8. The same
 *     source has to produce the same verdicts in both, or "one kernel, two
 *     shells" is a slogan. The expected outcomes below are copied from
 *     `kernel/test/evidence-decision.test.mjs` in the canonical repository — a
 *     deliberate duplication, because a shared fixture would be read through the
 *     same code path it is meant to falsify.
 *  2. **The ledger is not the engine's.** The refusal to write inside
 *     `~/.glasspane` is the `projects.json` double-write (audit findings B-1 and
 *     A-15: one defect, two implementations, fixed twice) made impossible here.
 */



const KERNEL_FIXTURES = kernelFixturesDir(import.meta.dir)

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(KERNEL_FIXTURES, `evidence-pack.${name}.json`), "utf8"))
}

function frame(name: string): unknown {
  return { evidencePack: fixture(name) }
}

/** A pack the tests can hand to `logDecision`, with the failure case spelled out. */
function goodPack(name: string): EvidencePack {
  const read = readEvidenceFrame(frame(name))
  if (!read.ok) throw new Error(`${name} should read as an evidence pack: ${read.error.code} ${read.error.message}`)
  return read.pack
}

function privateDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "gp-fork-ledger-"))
  // mkdtemp is 0700; assert rather than assume, because the kernel refuses to
  // append where group or other could rewrite the file.
  expect(statSync(dir).mode & 0o022).toBe(0)
  return dir
}

const sha256 = (buffer: Buffer | string) => createHash("sha256").update(buffer).digest("hex")

describe("the installed kernel agrees with canonical about the five real fixtures", () => {
  // Same expectations as the canonical suite, one-by-one.
  const expectations: Record<string, DecisionOutcome> = {
    "ok-01": "pass",
    "ok-02": "inconclusive",
    "ok-03": "pass",
    "ok-04-legacy-draft": "pass",
    "ok-05-pixelbounds-null": "fail",
  }

  for (const [name, want] of Object.entries(expectations)) {
    test(`${name} → ${want}`, () => {
      const pack = goodPack(name)
      expect(outcomeOf(pack)).toBe(want)
      expect(summaryOf(pack).length).toBeGreaterThan(0)
    })
  }

  test("the pre-freeze label is reported as measured, not folded into a claim", () => {
    const read = readEvidenceFrame(frame("ok-04-legacy-draft"))
    if (!read.ok) throw new Error(`legacy fixture should read: ${read.error.code} ${read.error.message}`)
    expect(read.pack.schemaVersion).toBe("glasspane.evidence/0.1")
    expect(read.measuredSchemaVersion).toBe("glasspane.evidence/0.1-draft")
  })

  test("strictness survives the fork's zod major: an extra key is refused, not dropped", () => {
    const polluted = { evidencePack: { ...(fixture("ok-01") as object), invented: true } }
    const read = readEvidenceFrame(polluted)
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.error.code).toBe("KERNEL_E_SCHEMA")
    expect(read.error.remedy.length).toBeGreaterThan(0)
  })
})

describe("the frame reader refuses shapes it cannot verify, without throwing", () => {
  const cases: Array<[string, unknown]> = [
    ["a null reply", null],
    ["an array reply", []],
    ["a string reply", "evidence"],
    ["a reply with no evidencePack", { somethingElse: 1 }],
    ["an evidencePack that is not an object", { evidencePack: "x" }],
    ["an evidencePack that is null", { evidencePack: null }],
    ["a pack missing attribution", { evidencePack: { ...(fixture("ok-01") as object), attribution: undefined } }],
  ]

  for (const [label, input] of cases) {
    test(`${label} → a three-field rejection`, () => {
      const read = readEvidenceFrame(input)
      expect(read.ok).toBe(false)
      if (read.ok) return
      expect(typeof read.error.code).toBe("string")
      expect(typeof read.error.message).toBe("string")
      expect(typeof read.error.remedy).toBe("string")
      expect(read.error.remedy.length).toBeGreaterThan(10)
    })
  }

  test("the two refusals are different codes, because they are different facts", () => {
    // A reply that is not an object at all is a frame this contract cannot read —
    // including the `result: null` the transport probe in
    // test/tool/glasspane-surface.test.ts pins (a shape the engine does not emit:
    // `EngineCore.swift:1631-1644` throws instead of answering null). A reply that IS an
    // object and simply carries no `evidencePack` is the ordinary no-evidence case for
    // every method but `last_evidence` (`Dispatcher.swift:156`). Collapsing them would make
    // "the engine said nothing" and "the frame is unreadable" one bucket.
    for (const notAFrame of [null, [], "evidence", 7]) {
      const read = readEvidenceFrame(notAFrame)
      expect(read.ok).toBe(false)
      if (read.ok) return
      expect(read.error.code).toBe("GP_E_EVIDENCE_FRAME")
    }
    const noPack = readEvidenceFrame({ somethingElse: 1 })
    expect(noPack.ok).toBe(false)
    if (noPack.ok) return
    expect(noPack.error.code).toBe("GP_E_NO_EVIDENCE")
  })

  test("and the unreadable-frame remedy does not send the agent back to the failed call", () => {
    // The frame that lands in this branch is very often `gp_last_evidence`'s own reply, so
    // "call gp_last_evidence and pass its reply" was a loop: the instruction to recover
    // from the failure was the failure. What remains executable is reading the engine's
    // self-report and recording the absence.
    const read = readEvidenceFrame(null)
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.error.remedy).not.toContain("call gp_last_evidence")
    expect(read.error.remedy).toContain("gp_probe_status")
    expect(read.error.remedy.length).toBeGreaterThan(40)
  })
})

describe("the ledger location rule", () => {
  test("with no override it is under the harness data dir, never the CWD", () => {
    const resolved = resolveLedger({ HOME: "/home/tester" })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.ledger.source).toBe("default")
    expect(path.isAbsolute(resolved.ledger.path)).toBe(true)
    // The EXACT default, pinned by construction rather than by a substring:
    // `toContain("glasspane-harness")` was satisfied by the doubled directory
    // `<data>/glasspane-harness/glasspane-harness/decisions.jsonl` as well, because the
    // outer segment matched too. `Global.Path.data` already IS
    // `<xdgData>/glasspane-harness` (packages/core/src/global.ts joins the product name
    // onto xdgData), so the ledger sits directly under it — the single-segment form
    // docs/troubleshooting.md and docs/models-and-keys.md publish.
    expect(xdgData).toBeDefined()
    expect(resolved.ledger.path).toBe(path.join(xdgData!, "glasspane-harness", "decisions.jsonl"))
    expect(path.dirname(resolved.ledger.path)).toBe(Global.Path.data)
    expect(path.basename(resolved.ledger.path)).toBe("decisions.jsonl")
    expect(resolved.ledger.path.split(path.sep).filter((segment) => segment === "glasspane-harness")).toHaveLength(1)
    expect(resolved.ledger.path.startsWith(process.cwd())).toBe(false)
  })

  test("an absolute override wins and says where it came from", () => {
    const resolved = resolveLedger({ GLASSPANE_DECISION_LOG: "/var/tmp/elsewhere/decisions.jsonl", HOME: "/home/tester" })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.ledger).toEqual({ path: "/var/tmp/elsewhere/decisions.jsonl", source: "env" })
  })

  test("a relative override is refused with an actionable remedy", () => {
    const resolved = resolveLedger({ GLASSPANE_DECISION_LOG: "state/decisions.jsonl", HOME: "/home/tester" })
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.error.code).toBe("GP_E_DECISION_LOG_PATH")
    expect(resolved.error.remedy).toContain("absolute")
  })

  test("writing inside the engine's state root is refused — one writer per state file", () => {
    const home = privateDir()
    const state = path.join(home, ".glasspane")
    const resolved = resolveLedger({ HOME: home, GLASSPANE_DECISION_LOG: path.join(state, "decisions.jsonl") })
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.error.code).toBe("GP_E_DECISION_LOG_PATH")
    expect(resolved.error.remedy).toContain("outside")
    // The refusal names the tree it actually resolved — which here is a temp root, not the
    // default — and still says what the default is, so a reader with a custom socket recognizes
    // the directory being protected.
    expect(resolved.error.remedy).toContain(state)
    expect(resolved.error.remedy).toContain("~/.glasspane")
  })

  test("a symlink into the engine's state root is refused — the guard reads where the bytes land", () => {
    // THE ESCAPE `path.resolve` LEFT OPEN. `path.resolve` normalises `.` and `..` and never
    // follows a symlink, so a named path that is lexically OUTSIDE the root whose target is a
    // directory INSIDE it walked straight past the prefix test. Measured before the fix, with
    // `elsewhere/ledger-dir -> <root>/.glasspane/sub` already created: `resolveLedger` returned
    // `{ok: true, source: "env"}`, `logDecision` mkdir'd through the symlink, appended, and left
    // `.glasspane/sub/decisions.jsonl` in the tree the engine owns — the projects.json double
    // writer this file's header says is impossible, reopened through a path read as text.
    const home = privateDir()
    const state = path.join(home, ".glasspane")
    mkdirSync(path.join(state, "sub"), { recursive: true })
    mkdirSync(path.join(state, "plan"), { recursive: true })
    const outside = path.join(home, "elsewhere")
    mkdirSync(outside)
    symlinkSync(path.join(state, "sub"), path.join(outside, "ledger-dir"))
    symlinkSync(path.join(state, "plan"), path.join(outside, "plan-dir"))
    const env = { HOME: home, GLASSPANE_SOCKET: path.join(state, "engine.sock") }

    const ledger = resolveLedger({ ...env, GLASSPANE_DECISION_LOG: path.join(outside, "ledger-dir", "decisions.jsonl") })
    expect(ledger.ok).toBe(false)
    if (ledger.ok) return
    expect(ledger.error.code).toBe("GP_E_DECISION_LOG_PATH")
    // The refusal still names the setting the operator wrote, not a rewritten path.
    expect(ledger.error.message).toContain(path.join(outside, "ledger-dir", "decisions.jsonl"))

    // Same for the writer itself: it refuses before the mkdir, so the engine's tree gains nothing.
    const attempt = logDecision(goodPack("ok-01"), { env: { ...env, GLASSPANE_DECISION_LOG: path.join(outside, "ledger-dir", "decisions.jsonl") } })
    expect(attempt.ok).toBe(false)
    expect(existsSync(path.join(state, "sub", "decisions.jsonl"))).toBe(false)

    // And the run-plan branch, which shares the one guard, refuses rather than reading a plan
    // out of the engine's tree.
    writeFileSync(path.join(state, "plan", "run-plan.json"), JSON.stringify({ schemaVersion: "iterate.run-plan/0.1", dimensions: [{ id: "security" }] }))
    const plan = readRunPlan({ ...env, GLASSPANE_RUN_PLAN: path.join(outside, "plan-dir", "run-plan.json") })
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.error.code).toBe("GP_E_RUN_PLAN_PATH")

    // A path that really is outside the tree is still accepted — the guard is about the
    // destination, not about symlinks existing.
    const clean = resolveLedger({ ...env, GLASSPANE_DECISION_LOG: path.join(outside, "decisions.jsonl") })
    expect(clean.ok).toBe(true)
  })

  test("the state root follows GLASSPANE_SOCKET, not just HOME", () => {
    const home = privateDir()
    const socketDir = path.join(home, "somewhere", "engine-state")
    const resolved = resolveLedger({
      HOME: home,
      GLASSPANE_SOCKET: path.join(socketDir, "engine.sock"),
      GLASSPANE_DECISION_LOG: path.join(socketDir, "decisions.jsonl"),
    })
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.error.message).toContain(socketDir)
  })

  test("a relative GLASSPANE_SOCKET is refused by one rule, in both files", () => {
    // `path.resolve` would put the socket in the harness's own working directory, while
    // glasspaned binds the same string wherever IT was started (`StateRoot.engineSocketPath`
    // passes `--socket-path` through). Measured with the CWD in the way: the harness used to
    // treat its working directory as the engine's state root, refusing every ledger path
    // inside a tree the engine never wrote to while talking to a daemon living elsewhere.
    const env = { HOME: privateDir(), GLASSPANE_SOCKET: "engine.sock", GLASSPANE_DECISION_LOG: "/var/tmp/elsewhere/decisions.jsonl" }
    const resolved = resolveLedger(env)
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.error.code).toBe("GP_E_SOCKET_PATH")

    // The transport answers the same setting the same way — one resolution rule, not two
    // that can each pick their own answer.
    const located = resolveSocket(env)
    expect(located.ok).toBe(false)
    if (located.ok) return
    expect(located.error.code).toBe("GP_E_SOCKET_PATH")
    expect(located.error.remedy.length).toBeGreaterThan(10)

    // And the run plan, which shares the rule, refuses it too.
    const plan = readRunPlan({ ...env, GLASSPANE_RUN_PLAN: "/var/tmp/elsewhere/run-plan.json" })
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.error.code).toBe("GP_E_SOCKET_PATH")

    // What the product actually guarantees about the relative name: it names the setting and
    // the value it refused, so the reader can find the variable that produced this answer.
    // (The line here used to read `expect(path.resolve("engine.sock")).not.toBe("/nonexistent-root/engine.sock")`
    // — an assertion about Node's `path` module, which no change to this repository could make
    // fail.)
    expect(located.error.message).toContain("GLASSPANE_SOCKET='engine.sock'")
    expect(located.error.message).toContain("not absolute")
  })

  test("the default ledger location is guarded by the same rule, not only the override", () => {
    // The refusal used to sit on the `GLASSPANE_DECISION_LOG` branch alone, so the branch
    // that runs in production never consulted the state root at all. Point the engine's
    // socket at the harness's own data directory and the default ledger lands inside the
    // engine's tree — the projects.json double writer, with no check firing.
    const state = Global.Path.data
    const resolved = resolveLedger({ HOME: privateDir(), GLASSPANE_SOCKET: path.join(state, "engine.sock") })
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.error.code).toBe("GP_E_DECISION_LOG_PATH")
    expect(resolved.error.message).toContain(state)
    expect(resolved.error.message).toContain("glasspane-harness")

    // The ordinary production shape is untouched by the new guard.
    const normal = resolveLedger({ HOME: privateDir() })
    expect(normal.ok).toBe(true)
    if (!normal.ok) return
    expect(normal.ledger.source).toBe("default")
  })

  test("a run plan inside a socket-derived root is refused even when HOME says otherwise", () => {
    const home = privateDir()
    const socketDir = path.join(home, "elsewhere", "engine-state")
    mkdirSync(socketDir, { recursive: true })
    const file = path.join(socketDir, "run-plan.json")
    writeFileSync(file, JSON.stringify({ schemaVersion: "iterate.run-plan/0.1", dimensions: [{ id: "security" }] }))
    const read = readRunPlan({ HOME: home, GLASSPANE_SOCKET: path.join(socketDir, "engine.sock"), GLASSPANE_RUN_PLAN: file })
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.error.code).toBe("GP_E_RUN_PLAN_PATH")
    expect(read.error.message).toContain(socketDir)
  })

  test("the state root the ledger refuses is the root the transport reports", () => {
    // One rule, checked as a fixed point rather than as two implementations that happen
    // to agree today: whatever `resolveSocket` calls the engine's root is exactly the tree
    // `resolveLedger` refuses to write into, for the same environment.
    const home = privateDir()
    const socket = path.join(home, "custom", "engine.sock")
    const env = { HOME: home, GLASSPANE_SOCKET: socket }
    const located = resolveSocket(env)
    if (!located.ok) throw new Error(`an absolute socket must resolve: ${located.error.code}`)
    expect(located.stateRoot).toBe(path.join(home, "custom"))
    expect(stateRootOf(env)).toEqual({ ok: true, path: path.join(home, "custom") })

    const inside = resolveLedger({ ...env, GLASSPANE_DECISION_LOG: path.join(located.stateRoot, "decisions.jsonl") })
    expect(inside.ok).toBe(false)
    const outside = resolveLedger({ ...env, GLASSPANE_DECISION_LOG: path.join(home, "decisions.jsonl") })
    expect(outside.ok).toBe(true)
  })
})

describe("logging a decision, and the chain it joins", () => {
  test("two decisions link, the file is 0600, and verification reproduces the link", () => {
    const dir = privateDir()
    const env = { GLASSPANE_DECISION_LOG: path.join(dir, "decisions.jsonl"), HOME: dir }
    const first = logDecision(goodPack("ok-01"), { env })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.logged.entry.sequence).toBe(0)
    expect(first.logged.entry.prevEntryHash).toBe("")

    const second = logDecision(goodPack("ok-05-pixelbounds-null"), { env })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.logged.entry.sequence).toBe(1)
    expect(second.logged.entry.prevEntryHash).toBe(first.logged.hash)
    expect(second.logged.entry.outcome).toBe("fail")
    expect(second.logged.entry.operationId).toBeDefined()

    const ledger = env.GLASSPANE_DECISION_LOG as string
    expect(statSync(ledger).mode & 0o777).toBe(0o600)
    expect(verifyLedger(ledger)).toMatchObject({ ok: true, entries: 2 })
    // Recompute the link without the code that made it.
    const lines = readFileSync(ledger, "utf8").trimEnd().split("\n")
    expect(sha256(Buffer.from(lines[0], "utf8"))).toBe(JSON.parse(lines[1]).prevEntryHash)
  })

  test("a corrupt tail is refused and the bytes are left exactly as found", () => {
    const dir = privateDir()
    const ledger = path.join(dir, "decisions.jsonl")
    const env = { GLASSPANE_DECISION_LOG: ledger, HOME: dir }
        expect(logDecision(goodPack("ok-01"), { env }).ok).toBe(true)
    expect(logDecision(goodPack("ok-03"), { env }).ok).toBe(true)

    writeFileSync(ledger, readFileSync(ledger, "utf8") + "truncated line without a closing brace\n")
    const before = sha256(readFileSync(ledger))

    const refused = logDecision(goodPack("ok-01"), { env })
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.error.code).toBe("KERNEL_E_DECISION_LOG_CORRUPT")
    expect(refused.error.remedy.length).toBeGreaterThan(10)
    expect(sha256(readFileSync(ledger))).toBe(before)
    expect(verifyLedger(ledger).firstBrokenLine).toBe(3)
  })

  test("rewriting history in the middle of the chain is caught by verification", () => {
    const dir = privateDir()
    const ledger = path.join(dir, "decisions.jsonl")
    const env = { GLASSPANE_DECISION_LOG: ledger, HOME: dir }
        logDecision(goodPack("ok-01"), { env })
    logDecision(goodPack("ok-02"), { env })
    logDecision(goodPack("ok-05-pixelbounds-null"), { env })

    const lines = readFileSync(ledger, "utf8").trimEnd().split("\n")
    const edited = JSON.parse(lines[1])
    edited.outcome = "pass" // "the second run went fine after all"
    lines[1] = JSON.stringify(edited, Object.keys(edited).sort())
    writeFileSync(ledger, lines.join("\n") + "\n")

    const verified = verifyLedger(ledger)
    expect(verified.ok).toBe(false)
    expect(verified.firstBrokenLine).toBe(3)
    expect(logDecision(goodPack("ok-01"), { env }).ok).toBe(false)
    // and the entry that was rewritten no longer hashes to what its successor claims
    expect(entryHashOf(edited)).not.toBe(JSON.parse(lines[2]).prevEntryHash)
  })

  test("a directory that cannot be created is reported, not silently skipped", () => {
    const dir = privateDir()
    // /proc does not exist on macOS and cannot be created, so the harness's own
    // mkdir step must fail and say so — the kernel underneath refuses to create
    // state directories at all.
    const ledger = "/proc/glasspane-harness-cannot-create/decisions.jsonl"
    const attempt = logDecision(goodPack("ok-01"), { env: { GLASSPANE_DECISION_LOG: ledger, HOME: dir } })
    expect(attempt.ok).toBe(false)
    if (attempt.ok) return
    expect(attempt.error.code).toBe("GP_E_DECISION_LOG_LOCATION")
    expect(attempt.error.remedy).toContain("GLASSPANE_DECISION_LOG")
    expect(existsSync(ledger)).toBe(false)
    expect(existsSync(dir)).toBe(true)
  })
})

describe("the fork's dependency shape is measured, not assumed", () => {
  test("zod in this package is major 4, i.e. the kernel runs on the consumer major, not its own", async () => {
    const zodPkg = await import("zod/package.json")
    const version = (zodPkg as { default?: { version?: string }; version?: string }).version
      ?? (zodPkg as { default?: { version?: string } }).default?.version
    expect(typeof version).toBe("string")
    expect(version!.split(".")[0]).toBe("4")
  })

  test("the kernel we depend on is pinned by provenance before any of the above is trusted", () => {
    // `contracts/kernel-pin.json` records the version, the lockfile integrity and the
    // sha256 of every contract file the published package ships. A checkout that does
    // not carry contracts/ at all is not this product — say so instead of asserting
    // nothing; a checkout that carries it but not the dependency is a real defect.
    const manifestPath = kernelContractFile(import.meta.dir, "kernel-pin.json")
    expect(manifestPath, "no contracts/kernel-pin.json above this test — run script/kernel-pin.mjs --record").not.toBeNull()
    const manifest = JSON.parse(readFileSync(manifestPath!, "utf8"))
    expect(manifest.package).toBe("iterate-kernel")
    expect(manifest.canonical.repo).toBe("jingzhao-l/iterate-skill")
    expect(manifest.canonical.branch).toBe("main")
    expect(manifest.resolution.specifier).toBe("")
    expect(manifest.resolution.integrity).toMatch(/^sha512-/)

    const installedPkg = JSON.parse(
      readFileSync(path.join(kernelPackageDir(import.meta.dir), "package.json"), "utf8"),
    ) as { version: string }
    expect(installedPkg.version, "installed kernel != the pinned kernel").toBe(manifest.version)

    // The corpus is the contract for every consumer that cannot import TypeScript, so
    // the pin has to cover the bytes, not just the version label.
    expect(manifest.corpus.length).toBeGreaterThan(8)
    for (const entry of manifest.corpus) {
      const abs = path.join(kernelPackageDir(import.meta.dir), entry.file)
      expect(existsSync(abs), `${entry.file} is pinned but the package does not ship it`).toBe(true)
      expect(sha256(readFileSync(abs)), `${entry.file} bytes moved under the pin`).toBe(entry.sha256)
    }
  })
})

describe("the binding's import shape (a product requirement, not a style choice)", () => {
  test("it does not import the kernel barrel, whose schemas.ts cannot survive compilation", () => {
    // The kernel's index re-exports `schemas`, which reads `../schemas/*.json` off
    // disk at module init. Fine from a directory install; fatal in the single-file
    // binary (the product would not start — this exact failure was found by
    // script/build.ts's own smoke test). The published version is immutable, so the
    // fix has to live here: subpath imports only, pinned by this test so a future
    // "tidy-up" cannot quietly reintroduce a binary that cannot boot.
    const binding = readFileSync(path.join(import.meta.dirname, "..", "..", "src", "tool", "glasspane", "kernel.ts"), "utf8")
    expect(binding, "the barrel pulls schemas.ts and the single-file binary cannot start").not.toMatch(
      /from\s+"iterate-kernel"(?!\/)/,
    )
    expect(binding).toContain('from "iterate-kernel/parse"')
  })
})

describe("the run-plan channel (scenario 2, planned half)", () => {
  /** The plan the iterate side writes for a real session, read from the shipped corpus. */
  function planFile(dir: string, value: unknown): string {
    const file = path.join(dir, "run-plan.json")
    writeFileSync(file, JSON.stringify(value))
    return file
  }

  test("with no GLASSPANE_RUN_PLAN there is no plan, and that is not an error", () => {
    const read = readRunPlan({ HOME: "/home/tester" })
    expect(read.ok).toBe(true)
    if (!read.ok) return
    // Absent must stay absent: substituting a default plan would render "0/9 verified"
    // against a plan nobody ran, which reads as a measurement and is not one.
    expect(read.plan).toBeNull()
  })

  test("a declared plan is read, digested and its ids come out in the caller's order", () => {
    const dir = privateDir()
    const corpus = kernelFixture<{ input: unknown; expectedIds: string[]; expectedDigest: string }>(
      import.meta.dir,
      "run-plan.ok-01",
    )
    const file = planFile(dir, corpus.input)
    const read = readRunPlan({ HOME: "/home/tester", GLASSPANE_RUN_PLAN: file })
    expect(read.ok).toBe(true)
    if (!read.ok || read.plan === null) return
    expect(read.plan.ids).toEqual(corpus.expectedIds)
    // The digest is the kernel's own, computed over the same bytes the producer hashed:
    // this is the value a ledger line cites, so a mismatch breaks the audit link rather
    // than merely changing a sentence.
    expect(read.plan.digest).toBe(corpus.expectedDigest)
    expect(read.plan.path).toBe(file)
  })

  test("a relative plan path is refused, not resolved against wherever the agent stood", () => {
    const read = readRunPlan({ HOME: "/home/tester", GLASSPANE_RUN_PLAN: "state/run-plan.json" })
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.error.code).toBe("GP_E_RUN_PLAN_PATH")
    expect(read.error.remedy).toContain("absolute")
  })

  test("a plan inside the engine's state root is refused — the same one-writer rule as the ledger", () => {
    const home = privateDir()
    const state = path.join(home, ".glasspane")
    mkdirSync(state, { recursive: true })
    const file = planFile(state, { schemaVersion: "iterate.run-plan/0.1", dimensions: [{ id: "security" }] })
    const read = readRunPlan({ HOME: home, GLASSPANE_RUN_PLAN: file })
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.error.code).toBe("GP_E_RUN_PLAN_PATH")
    expect(read.error.message).toContain(".glasspane")
  })

  test("a declared plan that cannot be honoured is reported, not treated as absent", () => {
    const dir = privateDir()
    const missing = path.join(dir, "not-written.json")
    const unreadable = readRunPlan({ HOME: "/home/tester", GLASSPANE_RUN_PLAN: missing })
    expect(unreadable.ok).toBe(false)
    if (unreadable.ok) return
    expect(unreadable.error.code).toBe("GP_E_RUN_PLAN_READ")

    // Written raw, not through planFile: JSON.stringify of a string produces a *valid*
    // JSON document, and the assertion would then be exercising the schema branch while
    // claiming to exercise the syntax one.
    const junk = path.join(dir, "junk.json")
    writeFileSync(junk, "{ not json")
    const badJson = readRunPlan({ HOME: "/home/tester", GLASSPANE_RUN_PLAN: junk })
    expect(badJson.ok).toBe(false)
    if (badJson.ok) return
    expect(badJson.error.code).toBe("GP_E_RUN_PLAN_JSON")

    // A well-formed JSON document that is not a plan: refused by the kernel, and the
    // refusal names the field, because "your plan is unreadable" and "you have no plan"
    // must not collapse into the same line in a summary.
    writeFileSync(junk, JSON.stringify({ schemaVersion: "iterate.run-plan/0.1", dimensions: [] }))
    const empty = readRunPlan({ HOME: "/home/tester", GLASSPANE_RUN_PLAN: junk })
    expect(empty.ok).toBe(false)
    if (empty.ok) return
    expect(empty.error.code).toBe("GP_E_RUN_PLAN_SCHEMA")
    expect(empty.error.message).toContain("dimensions")
  })
})

describe("the project's own run plan (scenario 2, the producer that was missing)", () => {
  /** The file `run_plan.plan_path` writes for a project: `<project>/.iterate/run-plan.json`. */
  function projectWithPlan(dir: string, value: unknown): string {
    const iterate = path.join(dir, ".iterate")
    mkdirSync(iterate, { recursive: true, mode: 0o700 })
    writeFileSync(path.join(iterate, "run-plan.json"), JSON.stringify(value))
    return dir
  }

  const planDocument = { schemaVersion: "iterate.run-plan/0.1", dimensions: [{ id: "security" }, { id: "correctness" }] }

  test("a session opened on a configured project reads that project's plan", () => {
    const project = projectWithPlan(privateDir(), planDocument)
    const read = readRunPlan({ HOME: "/home/tester" }, project)
    expect(read.ok).toBe(true)
    if (!read.ok || read.plan === null) return
    expect(read.plan.source).toBe("project")
    expect(read.plan.ids).toEqual(["security", "correctness"])
    expect(read.plan.path).toBe(path.resolve(project, ".iterate", "run-plan.json"))
    // The digest is the same function over the same bytes as the hand-off path produces, so a
    // plan cited from a project file and one cited from GLASSPANE_RUN_PLAN are comparable.
    expect(read.plan.digest).toMatch(/^rp_[0-9a-f]{64}$/)
  })

  test("an explicit hand-off wins over the project file, and says it did", () => {
    const project = projectWithPlan(privateDir(), planDocument)
    const handedDir = privateDir()
    const other = path.join(handedDir, "run-plan.json")
    writeFileSync(other, JSON.stringify({ schemaVersion: "iterate.run-plan/0.1", dimensions: [{ id: "performance" }] }))
    const read = readRunPlan({ HOME: "/home/tester", GLASSPANE_RUN_PLAN: other }, project)
    expect(read.ok).toBe(true)
    if (!read.ok || read.plan === null) return
    expect(read.plan.source).toBe("env")
    expect(read.plan.ids).toEqual(["performance"])
  })

  test("a project with no plan file is unplanned, not a refusal", () => {
    const bare = privateDir()
    const read = readRunPlan({ HOME: "/home/tester" }, bare)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.plan).toBeNull()
  })

  test("no directory means no project read, and nothing is guessed", () => {
    for (const directory of [undefined, ""]) {
      const read = readRunPlan({ HOME: "/home/tester" }, directory)
      expect(read.ok).toBe(true)
      if (!read.ok) return
      expect(read.plan).toBeNull()
    }
  })

  test("a half-written project plan is refused, and the remedy does not blame a variable nobody set", () => {
    // This is the case a shared reader tends to lose: the operator handed nothing, the project
    // file is broken, and the remedy tells them to unset GLASSPANE_RUN_PLAN — which they never
    // set. The refusal has to point at the file instead.
    const junkProject = privateDir()
    mkdirSync(path.join(junkProject, ".iterate"), { recursive: true, mode: 0o700 })
    writeFileSync(path.join(junkProject, ".iterate", "run-plan.json"), "{ not json")
    const read = readRunPlan({ HOME: "/home/tester" }, junkProject)
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.error.code).toBe("GP_E_RUN_PLAN_JSON")
    expect(read.error.message).toContain(junkProject)
    expect(read.error.remedy).not.toContain("GLASSPANE_RUN_PLAN")

    writeFileSync(
      path.join(junkProject, ".iterate", "run-plan.json"),
      JSON.stringify({ schemaVersion: "iterate.run-plan/0.1", dimensions: [] }),
    )
    const schema = readRunPlan({ HOME: "/home/tester" }, junkProject)
    expect(schema.ok).toBe(false)
    if (schema.ok) return
    expect(schema.error.code).toBe("GP_E_RUN_PLAN_SCHEMA")
    expect(schema.error.remedy).not.toContain("GLASSPANE_RUN_PLAN")
  })

  test("a project plan that cannot be read is a named read failure, not silence", () => {
    // A directory where the file should be: `open` fails for the OS's own reason, and the
    // session must hear "declared but unreadable" rather than "no plan".
    const project = privateDir()
    mkdirSync(path.join(project, ".iterate", "run-plan.json"), { recursive: true, mode: 0o700 })
    const read = readRunPlan({ HOME: "/home/tester" }, project)
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.error.code).toBe("GP_E_RUN_PLAN_READ")
    expect(read.error.remedy).toContain("the project's own .iterate/run-plan.json")
  })

  test("a project living inside the engine's state root is not read as a plan", () => {
    // The one-writer rule is about the *engine's* tree, so a candidate path inside it is
    // treated as "nobody configured this harness a plan", never as a plan to honour.
    const home = privateDir()
    const state = path.join(home, ".glasspane")
    projectWithPlan(state, planDocument)
    const read = readRunPlan({ HOME: home }, state)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.plan).toBeNull()
  })
})

describe("the stamp the ledger records", () => {
  // The kernel's schema asks for exactly three millisecond digits; `toISOString` always
  // supplies them. The binding used to force those digits to `000`, which the schema
  // accepts while nothing else does: the entry then claimed a precision the code had
  // discarded, and two decisions taken inside one second got the same stamp — a chain
  // that cannot order its own lines. Pinned against a fixed Date so this is arithmetic,
  // not a race against the clock.
  const CREATED_AT = JSON.parse(readFileSync(path.join(kernelPackageDir(import.meta.dir), "schemas", "decision-log-entry.schema.json"), "utf8")).properties
    .createdAt.pattern as string

  test("keeps the milliseconds it was given", () => {
    expect(decisionStamp(new Date("2026-10-11T02:28:11.042Z"))).toBe("2026-10-11T02:28:11.042Z")
  })

  test("and what the live clock produces satisfies the kernel's own createdAt pattern", () => {
    // The three hand-written ISO strings this test used to loop over were a second copy of
    // the schema's regex — they passed no matter what `decisionStamp` did, because nothing in
    // the loop called it. `logDecision` feeds `new Date()` (kernel.ts), so the leg worth
    // pinning is the producer under the clock the product actually runs on: a producer that
    // went back to forcing `.000`, dropping the offset, or emitting a local-time string would
    // take both assertions below red.
    const live = decisionStamp(new Date())
    expect(live).toMatch(new RegExp(CREATED_AT))
    expect(new Date(live).toISOString()).toBe(live)
    expect(decisionStamp(new Date("2026-10-11T02:28:11.042Z"))).toMatch(new RegExp(CREATED_AT))
  })

  test("two calls in the same second are not forced to the same instant", () => {
    const a = decisionStamp(new Date(1_700_000_000_123))
    const b = decisionStamp(new Date(1_700_000_000_456))
    expect(a).not.toBe(b)
    expect(new Date(b).getTime() - new Date(a).getTime()).toBe(333)
  })
})

describe("a chain written by iterate-harness (Python) verifies here (scenario 3)", () => {
  // The bytes in `test/fixtures/glasspane-chain-python-written.jsonl` were appended by
  // `kernel_decision_log.append_decision_log_entry` in the iterate-harness checkout, over drafts
  // with fixed entryId/createdAt. The same three drafts run through the published kernel's
  // `appendDecisionLogEntry` produce byte-identical output (measured 2026-10-25, sha256
  // eaa9dc7dc9fabb076ca9a9cdecec10f94f50566351402cc6abb9d32f01c4dc06). That is the claim this
  // block keeps alive: the two products do not merely share a schema, they write and read one
  // chain. Until ④'s gate there was no reader on either side of the other's file, and "互通" was
  // a statement about formats.
  const fixture = path.join(import.meta.dir, "..", "fixtures", "glasspane-chain-python-written.jsonl")
  const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")

  test("the sample is still the bytes the Python writer produced", () => {
    expect(sha256(readFileSync(fixture, "utf8"))).toBe(
      "eaa9dc7dc9fabb076ca9a9cdecec10f94f50566351402cc6abb9d32f01c4dc06",
    )
  })

  test("verifyLedger accepts it, and the optional fields stayed absent rather than null", () => {
    const verified = verifyLedger(fixture)
    expect(verified.ok).toBe(true)
    expect(verified.entries).toBe(3)
    const lines = readFileSync(fixture, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
    expect(lines[2]).not.toContain('"operationId":null')
    expect(JSON.parse(lines[2]).outcome).toBe("blocked")
  })

  test("editing the first line breaks the hash the second line cites", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gp-xchain-"))
    const tampered = path.join(dir, "tampered.jsonl")
    const lines = readFileSync(fixture, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
    const edited = lines.map((line, index) => (index === 0 ? line.replace('"outcome":"pass"', '"outcome":"fail"') : line))
    writeFileSync(tampered, edited.join("\n") + "\n")
    const verified = verifyLedger(tampered)
    expect(verified.ok).toBe(false)
    expect(verified.firstBrokenLine).toBe(2)
  })

  test("recomputing a link from the other side's entry gives the hash that line carries", () => {
    // Not a fixture comparison: read the JSON, rebuild the entry object the kernel would hash,
    // and require it to equal the `prevEntryHash` stored on the following line.
    const lines = readFileSync(fixture, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
    const first = JSON.parse(lines[0])
    expect(entryHashOf(first)).toBe(JSON.parse(lines[1]).prevEntryHash)
  })
})
