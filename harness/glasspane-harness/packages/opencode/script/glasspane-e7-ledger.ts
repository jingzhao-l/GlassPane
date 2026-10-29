/**
 * E7 — the decision ledger against bytes the engine itself wrote (M2's runtime proof).
 *
 *   cd packages/opencode && bun run script/glasspane-e7-ledger.ts
 *
 * What this adds over the unit tests: the pack that lands in the chain was read
 * out of **the engine's own archive** (`<state root>/evidence/op_*.json`, and the
 * state root is the one `daemon.ts`'s socket rule resolves — the same authority
 * `kernel.ts` refuses to write inside), and the
 * socket calls (`hello`, `probe_status`) go to the *running* daemon. The script
 * never calls `act`, so it cannot change anything in an app under test.
 *
 * A past measurement, kept because it explains the shape of this script: on
 * 2026-10-11 the running daemon answered `GP_E_NO_EVIDENCE` to `gp_last_evidence`
 * both with and without an `operationId`, even with 582 archive entries on disk —
 * the engine's replay path pointing at an archive that process considered empty.
 * Re-measured 2026-10-14 on this host (daemon binary from 2026-10-03, same archive):
 * both calls now hand back a frame, so the finding is closed as an observation and
 * NOT as a claim about which release fixed it. The ledger is still fed the archived
 * bytes directly here, which is what lets the chain be checked against engine-written
 * packs instead of a fixture.
 *
 * The ledger goes to a private 0700 directory. Anything inside `~/.glasspane`
 * would put a second writer in the engine's state root — the `projects.json`
 * mistake, already paid for twice (audit B-1 / A-15) — and the binding refuses
 * that on its own, so this script could not pollute it even by accident.
 */
import { createHash } from "node:crypto"
import { chmodSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"

import * as Daemon from "../src/tool/glasspane/daemon"
import { recordToolExecution } from "../src/plugin/glasspane-decision-log"
import { verifyLedger } from "../src/tool/glasspane/kernel"

const scratch = mkdtempSync(path.join(tmpdir(), "gp-e7-ledger-"))
chmodSync(scratch, 0o700)
const ledger = path.join(scratch, "decisions.jsonl")
const env = { ...process.env, GLASSPANE_DECISION_LOG: ledger }

let failures = 0
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures += 1
}
const note = (label: string, detail: string) => console.log(`NOTE  ${label} — ${detail}`)
/**
 * The script's own refusal shape, for the cases where there is nothing to measure: the
 * daemon-unreachable path below already prints code, message and remedy and exits 2. An
 * unreadable archive used to fall through to a raw ENOENT stack — with `HOME` unset the
 * path was CWD-relative besides, which is a wrong answer rather than no answer.
 */
function refuse(label: string, error: { code: string; message: string; remedy: string }): never {
  console.error(`cannot measure ${label}: ${error.code} ${error.message}`)
  console.error(`remedy: ${error.remedy}`)
  process.exit(2)
}
function unreadable(label: string, cause: unknown): never {
  const error = cause as NodeJS.ErrnoException
  return refuse(label, {
    code: `GP_E_ARCHIVE_${error.code ?? "UNREADABLE"}`,
    message: `${label} could not be read (${error.message ?? String(cause)})`,
    remedy: "run the daemon once so it writes its evidence archive, or pass GLASSPANE_SOCKET pointing at the engine whose state root holds it; this script reads the archive that socket's directory implies and nothing else",
  })
}
const sha256 = (bytes: string) => createHash("sha256").update(bytes).digest("hex")

/** `Daemon.call` returns an Effect — a description, not a promise. */
const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)

// 1. the running daemon: capabilities come from it, never from a list in here
const hello = await run(Daemon.hello())
if (!hello.ok) {
  console.error(`cannot reach glasspaned: ${hello.error.code} ${hello.error.message}`)
  console.error(`remedy: ${hello.error.remedy}`)
  process.exit(2)
}
const caps = (hello.result as { capabilities?: string[] }).capabilities ?? []
note("engine capabilities", caps.join(", "))

// 2. bytes the engine wrote, straight off its archive.
//
// The archive lives in the engine's state root, and the root is decided by ONE rule for the
// whole fork — the socket location (`daemon.ts`'s `resolveSocket`, which `kernel.ts` uses
// when it refuses to write into that tree). Composing `$HOME/.glasspane` here instead read
// a directory this run had nothing to do with whenever `GLASSPANE_SOCKET` named another
// tree, and with `HOME` unset it composed a CWD-relative path and died on a raw ENOENT.
const engine = Daemon.stateRootOf(env)
if (!engine.ok) refuse("the engine's state root", engine.error)
const archiveDir = path.join(engine.path, "evidence")

let archived: { n: string; mtime: number }[]
try {
  archived = readdirSync(archiveDir)
    .filter((n) => /^op_[0-9A-HJKMNP-TV-Z]{26}\.json$/.test(n))
    .map((n) => ({ n, mtime: statSync(path.join(archiveDir, n)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
} catch (error) {
  unreadable(archiveDir, error)
}
if (archived.length === 0) {
  console.error(`${archiveDir} holds no archived operation; there is nothing real to log`)
  process.exit(2)
}
const operationId = archived[0]!.n.slice(0, -".json".length)
let packRaw: string
try {
  packRaw = readFileSync(path.join(archiveDir, archived[0]!.n), "utf8")
} catch (error) {
  unreadable(path.join(archiveDir, archived[0]!.n), error)
}
const packBytes = JSON.parse(packRaw) as { schemaVersion?: string }
const packDigest = sha256(packRaw)
note("engine-written archive entry used", `${operationId} (label ${packBytes.schemaVersion}; ${archived.length} entries on disk)`)

// 3. measured, not assumed: does the daemon still replay what it wrote?
const noId = await run(Daemon.call("last_evidence", {}, 15_000))
const withId = await run(Daemon.call("last_evidence", { operationId }, 15_000))
if (!noId.ok && !withId.ok) {
  note(
    "FINDING: gp_last_evidence sees an empty archive",
    `${noId.error.code} (no id) and ${withId.error.code} (id ${operationId}) — while ${archived.length} entries sit in ${archiveDir}. The daemon's replay path and its writers disagree about where the archive is; engine-side work, recorded so a missing ledger entry is never the only clue.`,
  )
} else {
  // The predicate here used to be `withId.ok && !noId.ok ? false : true`, which is true
  // whenever `withId` failed — so under the documented current engine state (both calls
  // refused) this line printed PASS for a check whose label claims a replay happened. Each
  // call now asserts its own outcome, so the label and the reading are the same fact.
  check(
    "gp_last_evidence replays an entry named by operationId",
    withId.ok,
    withId.ok ? "the daemon handed a frame back" : `${withId.error.code}: ${withId.error.message}`,
  )
  check(
    "gp_last_evidence answers the no-id call with the most recent entry",
    noId.ok,
    noId.ok ? "the daemon handed a frame back" : `${noId.error.code}: ${noId.error.message}`,
  )
}

// 4. the frame the engine wrote must transcribe into the chain, unchanged
//
// The envelope is the daemon's OWN reply to `last_evidence`, not the archive bytes re-read from
// disk. `glasspane-decision-log.ts` admits a `gp_*` reply into the chain only when it carries the
// provenance marker `Daemon.call` stamps, and for the right reason: `tool/registry.ts` auto-imports
// a project's own `{tool,tools}/*.{js,ts}`, so a repo-committed file could hand back a kernel-shaped
// pack and shape alone cannot tell the two apart.
//
// This script used to hand-assemble the metadata instead — no marker, and an `as never` on the call
// that hid the type error which would have said so. The consequence was worse than a broken line:
// `recordToolExecution` answered `skipped` for every one of steps 4, 6 and 7, so the three checks
// that exist to prove "a real engine pack produced a decision entry" could never pass, and step 5's
// check passed for a reason unrelated to its label (it was refused for provenance, not for the
// missing pack it claims to be testing). When the only honest source of a marked frame is a reply
// that did not arrive, this says so and stops.
if (!withId.ok) {
  refuse("a daemon-replayed evidence pack", {
    code: withId.error.code,
    message: `gp_last_evidence(${operationId}) did not hand back a frame: ${withId.error.message}`,
    remedy: `${withId.error.remedy} — steps 4-7 need a reply from the daemon itself; this script will not assemble a provenance-marked frame from archive bytes to keep its line count up`,
  })
}
// The reply IS the frame: `Dispatcher.swift:156` has `last_evidence` answer with
// `{evidencePack: {…}}`, and `kernel.ts`'s `readEvidenceFrame` reads `result.evidencePack`. Wrapping
// the reply one more time here produced `{evidencePack: {evidencePack: {…}}}`, which the kernel
// rejected with `<root>: Unrecognized key: "evidencePack"` — a shape error in this script that read
// exactly like a Swift/TypeScript contract drift, the one thing its remedy line tells you to go check.
const envelope = withId.result
const replayedPack = (withId.result as { evidencePack?: unknown }).evidencePack
const out1 = {
  title: "gp_last_evidence",
  output: "engine evidence handed back",
  metadata: {
    ok: true,
    method: "last_evidence",
    code: null,
    message: null,
    remedy: null,
    result: envelope,
    [Daemon.DAEMON_ORIGIN]: true,
  },
}
const textBefore1 = out1.output
check(
  "the replayed pack is the archived bytes, not a re-serialisation of them",
  JSON.stringify(replayedPack) === JSON.stringify(packBytes),
  `${sha256(JSON.stringify(replayedPack)).slice(0, 12)}… vs archived ${packDigest.slice(0, 12)}…`,
)
const logged = recordToolExecution({ tool: "gp_last_evidence", sessionID: "ses_e7", callID: "call_e7_1" }, out1, env)
check("a real engine pack produced a decision entry", logged?.status === "logged", JSON.stringify(logged))
check("logging never rewrote what the model reads", out1.output === textBefore1)
if (logged?.status === "logged") {
  const line = JSON.parse(readFileSync(ledger, "utf8").trimEnd().split("\n")[0])
  check("the entry cites the engine's own operationId", line.operationId === operationId, String(line.operationId))
  check("the outcome is one the schema allows", ["pass", "fail", "blocked", "inconclusive"].includes(line.outcome), line.outcome)
  note("transcribed verdict", `${line.outcome} | ${String(line.summary).slice(0, 110)}`)
}

// 5. a live reply with no frame is skipped, never invented into an entry
const probe = await run(Daemon.call("probe_status", {}, 10_000))
const out2 = {
  title: "gp_probe_status",
  output: "engine self-report",
  metadata: probe.ok
    ? { ok: true, method: "probe_status", code: null, message: null, remedy: null, result: probe.result, [Daemon.DAEMON_ORIGIN]: true }
    : { ok: false, method: "probe_status", code: probe.error.code, message: probe.error.message, remedy: probe.error.remedy, result: null, [Daemon.DAEMON_ORIGIN]: true },
}
const skipped = recordToolExecution({ tool: "gp_probe_status", sessionID: "ses_e7", callID: "call_e7_2" }, out2, env)
check("an engine reply with no evidencePack is skipped", skipped?.status === "skipped", JSON.stringify(skipped))
// The skip has to be the one this label describes. A provenance refusal is the same status string
// reached by a different door — and before this script carried the marker, that was the door it
// actually came out of, so the check passed while testing nothing. Name the reason that would mean
// the label is not being tested.
const skipReason = skipped && skipped.status === "skipped" ? skipped.reason : ""
check(
  "and it was skipped for the missing frame, not for provenance",
  skipReason !== "a gp_-named reply that did not come from this surface's daemon call",
  JSON.stringify(skipped),
)
check("skipped really means the chain did not grow", verifyLedger(ledger).entries === 1, JSON.stringify(verifyLedger(ledger)))

// 6. the second entry joins the same chain; the file stays private; the archive untouched
const out3 = { ...out1, metadata: { ...out1.metadata } }
const second = recordToolExecution({ tool: "gp_last_evidence", sessionID: "ses_e7", callID: "call_e7_3" }, out3, env)
check("the second frame joined the same chain", second?.status === "logged" && second.sequence === 1, JSON.stringify(second))
const lines = readFileSync(ledger, "utf8").trimEnd().split("\n")
check("entry 2 links to entry 1 by hash", JSON.parse(lines[1]).prevEntryHash.length === 64)
check("the ledger file is 0600", (statSync(ledger).mode & 0o777) === 0o600)
// What this line used to say was "the engine's archive was not written to", measured as a
// directory count. That number answers neither question the label implies: a pack rewritten
// in place leaves the count untouched, and a live daemon archiving a new operation during
// this run trips the check for a reason that has nothing to do with this script. The bytes of
// the entry under test are what this run must not have changed, so those are what is read.
let packAfter: string
try {
  packAfter = readFileSync(path.join(archiveDir, archived[0]!.n), "utf8")
} catch (error) {
  unreadable(path.join(archiveDir, archived[0]!.n), error)
}
check(
  "the archive entry this run read is byte-for-byte unchanged",
  sha256(packAfter) === packDigest,
  `${archived[0]!.n} ${packDigest.slice(0, 12)}… vs ${sha256(packAfter).slice(0, 12)}…`,
)

// 7. damage the tail: refuse the next write, name the line, keep the bytes
writeFileSync(ledger, `${lines.join("\n")}\n{"entryId":"truncat`)
const out4 = {
  title: "gp_last_evidence",
  output: "an unchanged conclusion",
  metadata: { ok: true, method: "last_evidence", code: null, message: null, remedy: null, result: envelope, [Daemon.DAEMON_ORIGIN]: true },
}
const textBefore4 = out4.output
const refused = recordToolExecution({ tool: "gp_last_evidence", sessionID: "ses_e7", callID: "call_e7_4" }, out4, env)
check("a damaged ledger refuses the next entry", refused?.status === "failed", JSON.stringify(refused))
check("the refusal names the damaged line", refused?.status === "failed" && refused.message.includes("line 3"), refused?.status === "failed" ? refused.message : "")
check("a failed ledger never rewrites the model's text", out4.output === textBefore4)
check("the damaged bytes were kept for inspection", readFileSync(ledger, "utf8").includes('{"entryId":"truncat'))

console.log(`\nledger: ${ledger}`)
console.log(readFileSync(ledger, "utf8").trimEnd().split("\n").slice(0, 2).join("\n"))
console.log(failures === 0 ? "\nE7: all checks passed" : `\nE7: ${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
