#!/usr/bin/env node
/**
 * The fork's own workflows, gated by a rule that lives next to them.
 *
 * WHY THIS FILE EXISTS IN THIS TREE. The parent repository scans these two files too, but it
 * deliberately answers with a `△` advisory for any root that is not its own:
 *
 *   `job(s) without "timeout-minutes" … — reported to that root's own gate, not enforced from here`
 *
 * Its reason is a write-scope fact: the subtree under `harness/` is edited by another lane, so a
 * red in the parent's CI would be an instruction that lane cannot follow. The hand-off assumes the
 * receiving gate EXISTS. It did not. Nothing in this tree — and nothing in the split repository
 * this subtree becomes on publish, which is the thing that actually holds the publishing
 * credentials and runs these jobs — ever asked these two files the question. So the advisory had
 * no address, and the fork shipped 12 jobs with no ceiling and 4 multi-statement run bodies whose
 * stop-on-failure behaviour was borrowed from whatever shell the runner image defaults to.
 *
 * That is the same hole `ci.yml` describes for `product-surface.mjs` ("the repository that actually
 * publishes had no copy of the guarantee"), and it is filled the same way `script/patched-deps.mjs`
 * was filled: the check lives inside the fork tree so the distributed repository can re-assert it.
 *
 * Five rules, each able to go red, each printing what it counted so that a scan matching nothing
 * cannot be read as a clean scan:
 *
 *   1. action refs   every `uses:` is `./local` or `owner/repo@<40-hex>`. A retagged `@v4` in the
 *                    tree that publishes is attacker code, not a versioning preference.
 *   2. ceilings      every job declares `timeout-minutes` as a positive integer. GitHub's default
 *                    is 360, so a hung macOS build holds the concurrency slot six hours before
 *                    anything says so.
 *   3. shell gates   every multi-statement `run:` body names `-e`, `-u` and `pipefail` itself.
 *                    Single-statement bodies are exempt: one command's exit status IS the step's
 *                    verdict, so a header there adds noise and no judgement. Bodies whose first
 *                    statement is `node`/`bun`/`python` are exempt: that body is one script in
 *                    another language.
 *   4. one npm pin   the npm version the publish lanes install is defined once at workflow level
 *                    and read from that definition. Three copies of a literal in one file can
 *                    disagree, and a step that only PRINTS `npm --version` cannot notice the drift
 *                    its own comment claims it notices.
 *   5. runner images every macOS label these files name is one GitHub still serves, and a matrix
 *                    entry's runner arch is its target's arch. WHY THIS IS A RULE AND NOT A COMMENT:
 *                    GitHub retired the macOS 14 images on 2026-11-02, and this tree kept pinning
 *                    `macos-14` in four places. The job was then CANCELLED two seconds in — no runner,
 *                    no steps, no log — so nothing was red, the run's conclusion was `cancelled`, and
 *                    `assert-ci-green` could never see a green CI. Two release numbers (v0.14.3,
 *                    v0.14.4) were tagged and could not be published, because a dispatched workflow
 *                    reads the YAML at the tag and a pushed tag is never moved. A retired image is
 *                    therefore not a capacity problem to wait out; it is a byte in this tree that has
 *                    to change. The served set and the retirement are recorded with their source in
 *                    `contracts/runner-images.json`, next to the other measured external facts.
 *
 * Exit codes: 0 clean, 1 a rule is violated, 2 the measurement could not be taken (no workflows
 * directory, none matched, or the parse found nothing to assert about). "Could not ask" is never
 * reported as "the answer was good".
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import process from "node:process"

const HERE = path.dirname(new URL(import.meta.url).pathname)
const args = process.argv.slice(2)
const root = (() => {
  const i = args.indexOf("--dir")
  return i >= 0 && args[i + 1] ? path.resolve(args[i + 1]) : path.resolve(HERE, "..")
})()
const asJson = args.includes("--json")
const wantList = args.includes("--list")

// Unknown flags are refused, not ignored. The parent repository's `scripts/check-workflows.mjs` has a
// `--self-test` mode; this fork's copy does not, and `node script/check-workflows.mjs --self-test`
// answered "4 workflow file(s) clean" with exit 0 while running zero cases. A flag that silently does
// nothing turns the person who typed it into the author of a false green — and the command they typed
// is the one they will put in a workflow. `--dir VALUE` consumes its argument, so only a standalone
// `--…` counts as a flag here.
const KNOWN_FLAGS = new Set(["--json", "--list"])
const unknown = args.filter((arg, i) => arg.startsWith("--") && !KNOWN_FLAGS.has(arg) && arg !== "--dir" && args[i - 1] !== "--dir")
if (unknown.length) {
  console.error(`check-workflows: unknown flag(s) ${unknown.join(", ")} — this tool has no such mode. It read ${root} and did exactly what --dir/--json/--list say; anything else it cannot do, it refuses rather than prints a pass for.`)
  process.exit(2)
}

const SHA_REF = /^[0-9a-f]{40}$/
const GATES = ["e", "u", "pipefail"]
// A body whose first real statement is one of these is a program in another language; `set` in
// front of it gates nothing, because there is only one command to gate.
const FOREIGN_HEAD = /^\s*(python3?|node|bun|deno)\b/
// The npm version a publish lane installs has exactly one definition in the file. The value may be
// quoted (`npm install -g "npm@$PIN"`), and a pattern that required it not to be would simply stop
// seeing the steps — the quiet death of a rule this repository has been caught shipping before.
const NPM_INSTALL = /npm install -g ["']?npm@(\S+)/

// Rule 5's input is a recorded external fact, so it is read from THIS tree (next to the script) and
// not from `--dir`: a fixture directory holds workflows, not GitHub's image catalogue. Reading it
// from the scanned root would make every `--dir` fixture exit 2 for a missing contract, and the
// "fix" for that would be to drop the rule.
const RUNNER_CONTRACT = path.resolve(HERE, "..", "contracts", "runner-images.json")
const runnerContract = (() => {
  let text
  try {
    text = readFileSync(RUNNER_CONTRACT, "utf8")
  } catch (error) {
    console.error(`check-workflows: cannot read ${RUNNER_CONTRACT} (${error.code ?? error.message}) — without the recorded set of served runner images this tool cannot tell a live label from a retired one, and it will not call that a pass`)
    process.exit(2)
  }
  let parsedContract
  try {
    parsedContract = JSON.parse(text)
  } catch (error) {
    console.error(`check-workflows: ${RUNNER_CONTRACT} is not JSON (${error.message}) — refusing to judge runner images against an unreadable contract`)
    process.exit(2)
  }
  const labels = parsedContract?.labels
  if (!labels || typeof labels !== "object" || Array.isArray(labels) || Object.keys(labels).length === 0) {
    console.error(`check-workflows: ${RUNNER_CONTRACT} records no "labels" object — an empty served set would make every macOS label a violation, which is a broken ruler rather than a finding`)
    process.exit(2)
  }
  const retired = Array.isArray(parsedContract?.retired) ? parsedContract.retired : []
  return { labels, retired, source: parsedContract?.sourceUrl ?? RUNNER_CONTRACT, observedAt: parsedContract?.observedAt ?? "unrecorded" }
})()

const problems = []
const workflowDir = path.join(root, ".github", "workflows")

function problem(file, line, text) {
  problems.push(`${file}:${line}: ${text}`)
}

if (!existsSync(workflowDir)) {
  console.error(`check-workflows: no .github/workflows under ${root} — refusing to call an absent scan a pass`)
  process.exit(2)
}
const workflowFiles = readdirSync(workflowDir)
  .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
  .sort()
// Composite actions are scanned too. `.github/actions/setup-bun/action.yml` is `uses:`-d by every
// job in both workflows, including the ones that hold `id-token: write` and the release `GPG_PRIVATE_KEY`,
// and it downloads bun from a URL it computes at runtime. Reading only `readdirSync(workflows)` meant
// the one file that runs inside every privileged job was never asked whether its own `uses:` are
// SHA-pinned or whether its multi-statement bodies declare a shell gate — a retagged nested action is
// code nobody reviewed, executed with these credentials, and no lane would have said so.
const actionsDir = path.join(root, ".github", "actions")
const actionFiles = []
const collectActions = (dir) => {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) collectActions(abs)
    else if (entry.isFile() && /^action\.ya?ml$/.test(entry.name)) actionFiles.push(abs)
  }
}
collectActions(actionsDir)
actionFiles.sort()
const files = [...workflowFiles.map((f) => path.join(workflowDir, f)), ...actionFiles]
if (!workflowFiles.length && !actionFiles.length) {
  console.error(`check-workflows: ${workflowDir} holds no workflow file and ${actionsDir} holds no action.yml — refusing to certify an empty set`)
  process.exit(2)
}

const indent = (line) => line.length - line.trimStart().length

/**
 * The three shell gates one `set` line can promise. `-euo pipefail` folds the short flags and the
 * long one into two tokens, and `-o pipefail` splits them; both are the same promise, and a parser
 * that only reads `-o` alone would call the folded form ungated.
 */
function setGateFlags(line) {
  const m = /^set\s+(.+)$/.exec(line.trim())
  if (!m) return null
  const tokens = m[1].split(/\s+/)
  const flags = new Set()
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token || token === "--") {
      continue
    }
    if (!token.startsWith("-")) {
      // A bare token here is the long flag that followed `-o` (or followed the cluster ending in
      // `o`). Counting it is what makes `pipefail` visible.
      flags.add(token)
      continue
    }
    for (const ch of token.slice(1)) flags.add(ch)
    if (token.endsWith("o")) flags.add(tokens[++i] ?? "")
  }
  // `o` is not a gate, it is the letter that introduces a long flag.
  flags.delete("o")
  return flags
}

function parse(filePath) {
  const label = path.relative(root, filePath)
  const lines = readFileSync(filePath, "utf8").split("\n")
  let section = null
  let job = null
  const jobs = []
  const envKeys = new Set()
  const npmInstalls = []
  let refs = 0
  const bodies = []
  const runners = []
  let runnerExpressions = 0

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const depth = indent(raw)

    if (depth === 0) {
      section = line.replace(/:.*$/, "")
      if (section !== "jobs") job = null
      continue
    }

    if (section === "env" && depth === 2) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*):/.exec(line)
      if (m) envKeys.add(m[1])
      continue
    }

    if (section === "jobs") {
      if (depth === 2) {
        const m = /^([A-Za-z0-9_-]+):$/.exec(line)
        if (m) {
          job = { name: m[1], line: i + 1, timeout: null }
          jobs.push(job)
          continue
        }
      }
      if (job && depth === 4) {
        const t = /^timeout-minutes:\s*(\S+)\s*(?:#.*)?$/.exec(line)
        if (t) job.timeout = t[1]
      }
    }

    // Rule 5 reads two shapes: a job's `runs-on:` and a matrix entry's `runner:`. The matrix is where
    // the publishing legs name their images — `runs-on: ${{ matrix.runner }}` is an expression, so a
    // scan that stopped at `runs-on:` would have counted the two build legs and the npm platform legs
    // as nothing at all and called that clean.
    const runsOn = /^-?\s*runs-on:\s*(.+?)\s*(?:#.*)?$/.exec(line)
    if (runsOn) {
      const value = runsOn[1].replace(/^["']|["']$/g, "")
      if (value.includes("${{")) runnerExpressions++
      else {
        for (const part of value.replace(/^\[|\]$/g, "").split(",")) {
          const name = part.trim().replace(/^["']|["']$/g, "")
          if (name) runners.push({ line: i + 1, label: name, target: null })
        }
      }
    }
    const runnerKey = /\brunner:\s*["']?([A-Za-z0-9._-]+)/.exec(line)
    if (runnerKey) {
      const target = /\btarget:\s*["']?([A-Za-z0-9._-]+)/.exec(line)
      runners.push({ line: i + 1, label: runnerKey[1], target: target ? target[1] : null })
    }

    // Steps are list items, so the line arrives as `- uses: owner/repo@sha`. A parser that read
    // only `uses:` counted zero action refs and — by this file's own rule about empty scans — had
    // to refuse the verdict. That refusal is the proof the guard works; this line is the fix.
    const uses = /^-?\s*uses:\s*(\S+)\s*(?:#.*)?$/.exec(line)
    if (uses) {
      refs++
      const ref = uses[1].replace(/^["']|["']$/g, "")
      if (ref.startsWith("./")) continue
      const at = ref.lastIndexOf("@")
      if (at < 0) {
        problem(label, i + 1, `action "${ref}" carries no ref at all, so it resolves to whatever its default branch says today`)
        continue
      }
      const sha = ref.slice(at + 1)
      if (!SHA_REF.test(sha)) {
        problem(label, i + 1, `action "${ref}" is pinned to a movable name, not a 40-hex commit SHA — a retagged "${sha}" is code nobody reviewed, running with these credentials`)
      }
      continue
    }

    const run = /^-?\s*run:\s*(.*)$/.exec(line)
    if (!run) continue
    const runLine = i + 1
    const marker = run[1].trim()
    if (!/^[|>][-+]?\d*$/.test(marker)) {
      // One-line body. Two statements chained onto one line still need a shell gate, and there is
      // nowhere to put one — that is reported, not excused.
      const head = marker.replace(/^["']|["']$/g, "")
      bodies.push({ line: runLine, job: job?.name ?? "?", statements: 1 })
      if (NPM_INSTALL.test(head)) npmInstalls.push({ line: runLine, text: head })
      if (/&&|\|\||;\s*\S/.test(head)) {
        problem(label, runLine, `a single-line run body chains statements ("${head.slice(0, 48)}…") and has no room to declare -e/-u/pipefail — use a block scalar that starts with "set -euo pipefail"`)
      }
      continue
    }

    const body = []
    let j = i + 1
    for (; j < lines.length; j++) {
      if (lines[j].trim() && indent(lines[j]) <= depth) break
      body.push({ text: lines[j], line: j + 1 })
    }
    i = j - 1

    const statements = body.filter((b) => b.text.trim() && !b.text.trim().startsWith("#"))
    for (const s of statements) if (NPM_INSTALL.test(s.text)) npmInstalls.push({ line: s.line, text: s.text.trim() })
    bodies.push({ line: runLine, job: job?.name ?? "?", statements: statements.length })

    if (statements.length <= 1) continue
    if (FOREIGN_HEAD.test(statements[0].text)) continue

    const flags = new Set()
    for (const s of statements) {
      const f = setGateFlags(s.text)
      if (f) for (const x of f) flags.add(x)
    }
    const missing = GATES.filter((g) => !flags.has(g))
    if (missing.length) {
      problem(
        label,
        runLine,
        `a ${statements.length}-statement run body in job "${job?.name ?? "?"}" never declares ${missing.map((m) => (m === "pipefail" ? "pipefail" : `-${m}`)).join("/")} — it stops on failure only for as long as the runner image's default shell happens to say so`,
      )
    }
  }

  const gated = bodies.filter((b) => b.statements > 1).length
  return { label, jobs, envKeys, npmInstalls, refs, bodies, gated, runners, runnerExpressions }
}

const parsed = files.map((abs) => parse(abs))

// Rule 4, over the whole file rather than line by line: one definition, and every install reads it.
for (const info of parsed) {
  if (!info.npmInstalls.length) continue
  for (const hit of info.npmInstalls) {
    // The value may arrive wrapped in the quote that closed the YAML argument
    // (`"npm@12.2.0"`), and a message quoting `12.2.0"` back is a message nobody can grep for.
    const value = (NPM_INSTALL.exec(hit.text)?.[1] ?? "").replace(/["']$/, "")
    if (!/\$\{\{\s*env\./.test(value) && !/^\$\{?[A-Za-z0-9_]*NPM[A-Za-z0-9_]*\}?/.test(value)) {
      problem(info.label, hit.line, `the npm version is a literal ("${value}") — it has to come from one workflow-level pin so the publish lanes cannot disagree about which npm ran`)
    }
  }
  const defined = [...info.envKeys].filter((k) => k.includes("NPM"))
  if (defined.length !== 1) {
    problem(
      info.label,
      1,
      `${info.npmInstalls.length} npm-upgrade step(s) here but ${defined.length} workflow-level NPM pin key(s) (${defined.join(", ") || "none"}) — the file needs exactly one definition for the three lanes to be checked against`,
    )
  }
}

for (const info of parsed) {
  for (const j of info.jobs) {
    if (j.timeout === null) {
      problem(info.label, j.line, `job "${j.name}" declares no "timeout-minutes" — GitHub's default is 360, so a hung runner holds the slot for six hours before anything reports it`)
      continue
    }
    if (!/^\d+$/.test(j.timeout) || Number(j.timeout) < 1) {
      problem(info.label, j.line, `job "${j.name}" sets "timeout-minutes: ${j.timeout}" — not a positive whole number of minutes, so GitHub either rejects the file or applies no ceiling at all`)
    }
  }
}

// Rule 5, over the labels the scan actually read. The served set is the recorded one, so an image
// NAME that is not a LABEL (`macos-15-arm64` is the image, `macos-15` is the label) is refused too:
// GitHub cancels it in exactly the same silent way, and "looks like the right OS" is not a runner.
const servedLabels = Object.keys(runnerContract.labels).join(", ")
for (const info of parsed) {
  for (const r of info.runners) {
    if (!/^macos-/i.test(r.label)) continue
    const label = r.label.toLowerCase()
    const arch = runnerContract.labels[label]
    if (!arch) {
      const gone = runnerContract.retired.find((e) => typeof e?.prefix === "string" && label.startsWith(e.prefix.toLowerCase()))
      if (gone) {
        problem(
          info.label,
          r.line,
          `runner image "${r.label}" is retired — GitHub removed the ${gone.image} images on ${gone.retiredOn} (${gone.announcement}). The job is CANCELLED before it gets a runner: no steps, no log, nothing red, and the run's conclusion is "cancelled", so assert-ci-green refuses every release of this tree and \`gh run rerun\` cannot help (a dispatched workflow reads the YAML at the tag, and a pushed tag is never moved). Pin a served label: ${servedLabels} — ${runnerContract.source} (${runnerContract.observedAt})`,
        )
      } else {
        problem(
          info.label,
          r.line,
          `runner image "${r.label}" is not a label GitHub publishes. The recorded served set is: ${servedLabels} (${runnerContract.source}, ${runnerContract.observedAt}). An image NAME is not a LABEL — "macos-15-arm64" names the image whose label is "macos-15", and pinning the name is cancelled just as silently as pinning a retired one`,
        )
      }
      continue
    }
    if (r.target) {
      const want = /-(arm64|x64)$/.exec(r.target)?.[1]
      if (want && want !== arch) {
        problem(
          info.label,
          r.line,
          `matrix entry builds "${r.target}" on "${r.label}", which is an ${arch} image — that leg would smoke-test bytes on the wrong architecture and ship them under "${r.target}"`,
        )
      }
    }
  }
}

const totals = parsed.reduce(
  (a, info) => ({
    files: a.files + 1,
    jobs: a.jobs + info.jobs.length,
    refs: a.refs + info.refs,
    bodies: a.bodies + info.bodies.length,
    multi: a.multi + info.gated,
    npm: a.npm + info.npmInstalls.length,
    macos: a.macos + info.runners.filter((r) => /^macos-/i.test(r.label)).length,
    runnerExprs: a.runnerExprs + info.runnerExpressions,
  }),
  { files: 0, jobs: 0, refs: 0, bodies: 0, multi: 0, npm: 0, macos: 0, runnerExprs: 0 },
)

// A parse that read nothing is not a pass. This is the failure this repository has been caught
// committing repeatedly: a pattern that matches no file, reporting an empty set as clean.
if (totals.jobs === 0 || totals.refs === 0 || totals.bodies === 0) {
  console.error(`check-workflows: read ${totals.files} workflow file(s) but parsed jobs=${totals.jobs} action refs=${totals.refs} run bodies=${totals.bodies} — nothing was asserted about, so no verdict is available`)
  process.exit(2)
}

if (wantList) {
  for (const info of parsed) console.log(`  ${info.label}: ${info.jobs.length} job(s), ${info.refs} action ref(s), ${info.bodies.length} run bod(ies) (${info.gated} multi-statement), ${info.npmInstalls.length} npm-upgrade step(s), ${info.runners.filter((r) => /^macos-/i.test(r.label)).length} macOS runner label(s) + ${info.runnerExpressions} runs-on expression(s)`)
}

if (asJson) {
  console.log(JSON.stringify({ root, totals, problems }, null, 2))
  process.exit(problems.length ? 1 : 0)
}

if (problems.length) {
  for (const p of problems) console.error(`  ✗ ${p}`)
  console.error(`check-workflows: ${problems.length} problem(s) across ${totals.files} workflow file(s) — ${totals.jobs} job(s), ${totals.refs} action ref(s), ${totals.bodies} run bod(ies) (${totals.multi} multi-statement), ${totals.npm} npm-upgrade step(s), ${totals.macos} macOS runner label(s)`)
  process.exit(1)
}
console.log(
  `check-workflows: ${totals.files} workflow file(s) clean — ${totals.jobs} job(s) every one with a ceiling, ${totals.refs} action ref(s) all SHA-pinned or local, ${totals.bodies} run bod(ies) (${totals.multi} multi-statement, each declaring -e/-u/pipefail), ${totals.npm} npm-upgrade step(s) reading one workflow-level pin, ${totals.macos} macOS runner label(s) all served and arch-matched (+${totals.runnerExprs} runs-on expression(s) whose literals come from the matrices counted here)`,
)
process.exit(0)
