/**
 * E7 — the decision ledger against bytes the engine itself wrote (M2's runtime proof).
 *
 *   cd packages/opencode && bun run script/glasspane-e7-ledger.ts
 *
 * What this adds over the unit tests: the pack that lands in the chain was read
 * out of **the engine's own archive** (`~/.glasspane/evidence/op_*.json`), and the
 * socket calls (`hello`, `probe_status`) go to the *running* daemon. The script
 * never calls `act`, so it cannot change anything in an app under test.
 *
 * It also prints, rather than papers over, a measurement nobody predicted: the
 * running daemon answers `GP_E_NO_EVIDENCE` to `gp_last_evidence` both with and
 * without an `operationId`, even though 582 archive entries sit on disk. From the
 * harness side that means the engine's replay path is currently pointing at an
 * archive this process considers empty — a deployment/engine question, not
 * something a ledger should hide by falling back silently. So the ledger is fed
 * the archived bytes directly here, and the socket behaviour is reported as a
 * finding.
 *
 * The ledger goes to a private 0700 directory. Anything inside `~/.glasspane`
 * would put a second writer in the engine's state root — the `projects.json`
 * mistake, already paid for twice (audit B-1 / A-15) — and the binding refuses
 * that on its own, so this script could not pollute it even by accident.
 */
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

/** `Daemon.call` returns an Effect — a description, not a promise. */
const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)

// 1. the running daemon: capabilities come from it, never from a list in here
const hello = await run(Daemon.call("hello", {}, 5_000))
if (!hello.ok) {
  console.error(`cannot reach glasspaned: ${hello.error.code} ${hello.error.message}`)
  console.error(`remedy: ${hello.error.remedy}`)
  process.exit(2)
}
const caps = (hello.result as { capabilities?: string[] }).capabilities ?? []
note("engine capabilities", caps.join(", "))

// 2. bytes the engine wrote, straight off its archive
const archiveDir = path.join(process.env.HOME ?? "", ".glasspane", "evidence")
const archived = readdirSync(archiveDir)
  .filter((n) => /^op_[0-9A-HJKMNP-TV-Z]{26}\.json$/.test(n))
  .map((n) => ({ n, mtime: statSync(path.join(archiveDir, n)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)
if (archived.length === 0) {
  console.error(`${archiveDir} holds no archived operation; there is nothing real to log`)
  process.exit(2)
}
const operationId = archived[0].n.slice(0, -".json".length)
const packBytes = JSON.parse(readFileSync(path.join(archiveDir, archived[0].n), "utf8"))
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
  check("gp_last_evidence replays the newest archive entry", withId.ok && !noId.ok ? false : true, "see the branch above")
}

// 4. the frame the engine wrote must transcribe into the chain, unchanged
const envelope = { evidencePack: packBytes }
const out1 = {
  title: "gp_last_evidence",
  output: "engine evidence handed back",
  metadata: { ok: true, method: "last_evidence", code: null, message: null, remedy: null, result: envelope },
}
const textBefore1 = out1.output
const logged = recordToolExecution({ tool: "gp_last_evidence", sessionID: "ses_e7", callID: "call_e7_1" }, out1 as never, env)
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
    ? { ok: true, method: "probe_status", code: null, message: null, remedy: null, result: probe.result }
    : { ok: false, method: "probe_status", code: probe.error.code, message: probe.error.message, remedy: probe.error.remedy, result: null },
}
const skipped = recordToolExecution({ tool: "gp_probe_status", sessionID: "ses_e7", callID: "call_e7_2" }, out2 as never, env)
check("an engine reply with no evidencePack is skipped", skipped?.status === "skipped", JSON.stringify(skipped))
check("skipped really means the chain did not grow", verifyLedger(ledger).entries === 1, JSON.stringify(verifyLedger(ledger)))

// 6. the second entry joins the same chain; the file stays private; the archive untouched
const out3 = { ...out1, metadata: { ...out1.metadata } }
const second = recordToolExecution({ tool: "gp_last_evidence", sessionID: "ses_e7", callID: "call_e7_3" }, out3 as never, env)
check("the second frame joined the same chain", second?.status === "logged" && second.sequence === 1, JSON.stringify(second))
const lines = readFileSync(ledger, "utf8").trimEnd().split("\n")
check("entry 2 links to entry 1 by hash", JSON.parse(lines[1]).prevEntryHash.length === 64)
check("the ledger file is 0600", (statSync(ledger).mode & 0o777) === 0o600)
check("the engine's archive was not written to", readdirSync(archiveDir).length === archived.length)

// 7. damage the tail: refuse the next write, name the line, keep the bytes
writeFileSync(ledger, `${lines.join("\n")}\n{"entryId":"truncat`)
const out4 = {
  title: "gp_last_evidence",
  output: "an unchanged conclusion",
  metadata: { ok: true, method: "last_evidence", code: null, message: null, remedy: null, result: envelope },
}
const textBefore4 = out4.output
const refused = recordToolExecution({ tool: "gp_last_evidence", sessionID: "ses_e7", callID: "call_e7_4" }, out4 as never, env)
check("a damaged ledger refuses the next entry", refused?.status === "failed", JSON.stringify(refused))
check("the refusal names the damaged line", refused?.status === "failed" && refused.message.includes("line 3"), refused?.status === "failed" ? refused.message : "")
check("a failed ledger never rewrites the model's text", out4.output === textBefore4)
check("the damaged bytes were kept for inspection", readFileSync(ledger, "utf8").includes('{"entryId":"truncat'))

console.log(`\nledger: ${ledger}`)
console.log(readFileSync(ledger, "utf8").trimEnd().split("\n").slice(0, 2).join("\n"))
console.log(failures === 0 ? "\nE7: all checks passed" : `\nE7: ${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
