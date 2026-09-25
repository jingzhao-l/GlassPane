import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import type { DecisionOutcome, EvidencePack } from "../../src/tool/glasspane/kernel"
import {
  entryHashOf,
  logDecision,
  outcomeOf,
  readEvidenceFrame,
  resolveLedger,
  summaryOf,
  verifyLedger,
} from "../../src/tool/glasspane/kernel"

/**
 * M3/M2 fixed-point tests for the fork's kernel binding
 * (`src/tool/glasspane/kernel.ts`) against the vendored kernel in
 * `packages/opencode/vendor/kernel`.
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

const VENDOR_FIXTURES = path.join(
  import.meta.dir,
  "..",
  "..",
  "vendor",
  "kernel",
  "fixtures",
)

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(VENDOR_FIXTURES, `evidence-pack.${name}.json`), "utf8"))
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

describe("the vendored kernel agrees with canonical about the five real fixtures", () => {
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
})

describe("the ledger location rule", () => {
  test("with no override it is under the harness data dir, never the CWD", () => {
    const resolved = resolveLedger({ HOME: "/home/tester" })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.ledger.source).toBe("default")
    expect(path.isAbsolute(resolved.ledger.path)).toBe(true)
    expect(resolved.ledger.path).toContain("glasspane-harness")
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
    expect(resolved.error.remedy).toContain("outside ~/.glasspane")
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
  test("zod in this package is major 4, i.e. the vendored kernel is not running its own pinned major", async () => {
    const zodPkg = await import("zod/package.json")
    const version = (zodPkg as { default?: { version?: string }; version?: string }).version
      ?? (zodPkg as { default?: { version?: string } }).default?.version
    expect(typeof version).toBe("string")
    expect(version!.split(".")[0]).toBe("4")
  })

  test("the vendor itself is pinned by provenance before any of the above is trusted", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(import.meta.dir, "..", "..", "..", "..", "..", "contracts", "kernel-vendor.json"), "utf8"),
    )
    expect(manifest.canonical.repo).toBe("jingzhao-l/iterate-skill")
    expect(manifest.files.length).toBeGreaterThan(20)
    for (const file of manifest.files) {
      const abs = path.join(import.meta.dir, "..", "..", "vendor", "kernel", file.file)
      expect(existsSync(abs), `vendored file missing: ${file.file}`).toBe(true)
      expect(sha256(readFileSync(abs))).toBe(file.sha256)
    }
  })
})
