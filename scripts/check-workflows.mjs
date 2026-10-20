#!/usr/bin/env node
/**
 * check-workflows.mjs —体检 .github/workflows：重名 job 与被引用的脚本是否存在。
 *
 * WHY (both failure modes happened in this repository on 2026-09-25):
 *  1. A cross-base transplant of ci.yml made `git merge` duplicate the whole
 *     `docs:` job block. A YAML mapping with a repeated key keeps the *last*
 *     one, so a naive parse still reports one job named `docs` and everything
 *     looks fine — the guard just quietly exists twice in the file. GitHub
 *     rejects duplicate keys at worst, accepts a silently-shadowed job at best.
 *     Either outcome means "the file no longer says what the checks do".
 *  2. The same transplant referenced `scripts/check-doc-links.mjs`, a file that
 *     existed on the other base but not on the branch — so the branch shipped a
 *     CI job that cannot run. A step that errors out on a missing file is at
 *     least loud; a job skipped because its script vanished is not.
 *
 * This tool has no dependencies on purpose: it is the thing that verifies the
 * verifier, so it must not be the thing that can fail to install.
 *
 * Exit codes: 0 clean, 1 a workflow is broken, 2 no workflows found (caliber
 * error — refusing to report success over an empty set).
 */
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
// Two workflow roots, because the product lives in a vendored subtree: our own CI,
// and the fork's (the split repo's own ci.yml/release.yml travel with the subtree).
// A missing second root is fine (it only exists on the harness line); a present
// one is scanned with the same rules.
const wfRoots = [path.join(repoRoot, ".github", "workflows"), path.join(repoRoot, "harness", "glasspane-harness", ".github", "workflows")]

const primary = wfRoots[0]
if (!existsSync(primary)) {
  console.error(`check-workflows: ${path.relative(repoRoot, primary)} does not exist — nothing was verified`)
  process.exit(2)
}
const targets = []
for (const dir of wfRoots) {
  if (!existsSync(dir)) continue
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml")).sort()) {
    // Script paths in a workflow are resolved against that workflow's *repo root*:
    // the primary root's root is this repository; the fork subtree's root is the
    // subtree itself (which becomes the repo root after the subtree split).
    const isPrimary = dir === wfRoots[0]
    targets.push({
      dir,
      file: f,
      root: isPrimary ? repoRoot : path.join(repoRoot, "harness", "glasspane-harness"),
      label: isPrimary ? f : path.relative(repoRoot, path.join(dir, f)),
      primary: isPrimary,
    })
  }
}
if (!targets.length) {
  console.error("check-workflows: no workflow files found — refusing to report success over an empty set")
  process.exit(2)
}

/**
 * Walk a workflow file line by line. We only need two structural facts, and we
 * get them from indentation rather than a YAML parser so that duplicate keys
 * (which a parser collapses) stay visible.
 */
// Matches `bun run <name>` / `npm run <name>` at the start of a line or after a
// chaining operator, capturing the bare script name and any file extension that
// would make it a path instead.
const RUN_SCRIPT = new RegExp(
  "(?:^|[;&|]\\s*)(?:bun|npm|pnpm|yarn)\\s+run\\s+([A-Za-z0-9:_-]+)(\\.[A-Za-z0-9]+)?(?:/|\\s|$)",
  "g",
)

function inspect(target) {
  const { dir, file } = target
  const base = path.join(dir, file)
  const text = readFileSync(base, "utf8")
  const lines = text.split("\n")
  const problems = []
  const jobKeys = []
  let section = null // top-level key we are inside of
  let inRun = false
  let runIndent = 0
  const runRefs = []
  // Whole `run:` bodies, assembled as the scanner goes. `runRefs` is per line on purpose —
  // the script-existence rule reports line numbers — but a shell body has to be judged as one
  // script, and comment/blank lines inside it are skipped by this loop, so re-joining those
  // fragments by line number later cannot work.
  const shells = []
  let shellBlock = null
  let stepDir = "" // step-level working-directory, applied to that step's scripts
  let hasTopPermissions = false // a top-level `permissions:` block; see the check at the end

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.replace(/\s+$/, "")
    if (!line || line.trimStart().startsWith("#")) continue

    const top = /^[A-Za-z0-9_-]+:/.test(line)
    const job = /^ {2}([A-Za-z0-9_.-]+):/.exec(line)
    const nested = /^ {4}([A-Za-z0-9_.-]+):/.exec(line)
    const stepStart = /^ {6}-\s/.test(raw) || /^ {4}-\s/.test(raw)

    if (stepStart) stepDir = "" // a new step resets the working directory

    if (inRun) {
      const bodyIndent = raw.search(/\S/)
      if (bodyIndent > runIndent) {
        runRefs.push({ text: raw.trim(), line: i + 1, dir: stepDir })
        if (shellBlock) shellBlock.lines.push(raw.trim())
        continue
      }
      inRun = false
      shellBlock = null
    }

    if (top) {
      section = line.split(":")[0]
      if (section === "permissions") hasTopPermissions = true
      continue
    }
    if (section === "jobs" && job && !nested) {
      jobKeys.push({ name: job[1], line: i + 1 })
      continue
    }
    const wd = /^\s*working-directory:\s*(\S+)\s*$/.exec(line)
    if (wd) {
      stepDir = wd[1].replace(/^["']|["']$/g, "")
      continue
    }
    const runMatch = /^(\s*)run:\s*(.*)$/.exec(line)
    if (runMatch) {
      const [, indent, inline] = runMatch
      runRefs.push({ text: inline, line: i + 1, dir: stepDir })
      if (/[|>]/.test(inline)) {
        inRun = true
        runIndent = indent.length
        shellBlock = { line: i + 1, lines: [] }
        shells.push(shellBlock)
      } else if (inline) {
        shells.push({ line: i + 1, lines: [inline] })
      }
    }
  }

  // 1. duplicate job keys inside the jobs: section
  const seen = new Map()
  for (const j of jobKeys) seen.set(j.name, [...(seen.get(j.name) ?? []), j.line])
  for (const [name, at] of seen) {
    if (at.length > 1) {
      problems.push(`job "${name}" is defined ${at.length} times (lines ${at.join(", ")}) — a YAML mapping keeps only the last, so one of these checks never runs`)
    }
  }

  // 1b. `secrets` in a step's `if:`. GitHub does not expose the secrets context
  //     to an `if` expression, and a workflow containing one does not compile:
  //     the whole file is rejected and *zero* jobs are dispatched, so the run
  //     shows up as an instant failure with no job to read. PyYAML accepts it and
  //     so did this file before this rule existed — the release lane was broken
  //     by exactly this line and nothing local could see it. Secrets belong in
  //     `env:`; the branch on them belongs in the shell, where a missing value
  //     can produce a real error message instead of no run at all.
  for (const match of text.matchAll(/^[ \t]*if:[ \t]*(.+)$/gm)) {
    if (!match[1].includes("secrets.")) continue
    const line = text.slice(0, match.index).split("\n").length
    problems.push(
      `line ${line}: an \`if:\` uses the secrets context (\`${match[1].trim()}\`) — GitHub does not expose it there, ` +
        `and the file will not compile: the workflow is rejected whole and no job is dispatched. ` +
        `Put the secret in \`env:\` and branch on it inside \`run:\`.`,
    )
  }

  // 1c. An unquoted scalar that contains `: ` (colon-space) or a trailing `?`.
  //     YAML reads `name: canonical kernel: moved? anchor still reachable?` as a
  //     mapping rather than a string and refuses the whole file. GitHub then
  //     rejects the workflow at parse time: **zero jobs are dispatched**, and the
  //     run is reported as "likely failed because of a workflow file issue" with
  //     no log to read. That is the same silent-total-failure shape as rule 1b,
  //     and this file was the verifier that did not catch it — the guard read
  //     names and scripts by regex and never asked whether the YAML *parses*.
  //     We cannot depend on a YAML parser here (see the header: this tool must
  //     stay dependency-free), so this asks the narrow question that bit us:
  //     does a `key: value` line carry a second `: ` or end in `?` outside quotes?
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (/^\s*#/.test(raw)) continue
    // Only `key: value` lines, and only where the key is a plain identifier —
    // that is where a value can be misread as a nested mapping.
    const m = raw.match(/^(\s*)-?\s*([A-Za-z_][A-Za-z0-9_-]*):[ \t]+(.*)$/)
    if (!m) continue
    const value = m[3]
    // Strip a quoted scalar: anything inside matching quotes is literal text.
    const quoted = value.match(/^(["'])(.*)\1$/)
    if (quoted) continue
    // A block scalar or an explicit anchor/tag introduces its own structure.
    if (/^[>|&*]/.test(value)) continue
    const hasColonSpace = /:\s/.test(value)
    const danglingQuestion = /[?:]\s*$/.test(value) || /\?(\s|$)/.test(value)
    if (hasColonSpace || danglingQuestion) {
      problems.push(
        `line ${i + 1}: \`${m[2]}:\` has an unquoted value containing \`: \` or \`?\` ` +
          `(\`${value.trim()}\`) — YAML reads that as a nested mapping, not a string, and rejects the file. ` +
          `The workflow is then dispatched as zero jobs and the run reports a workflow-file ` +
          `problem with no log. Quote the value.`,
      )
    }
  }

  // 2. repo scripts referenced by run: steps must exist (resolved against the
  //    step's own working-directory, which is how Actions runs them)
  for (const ref of runRefs) {
    for (const script of referencedScripts(ref.text)) {
      if (script.includes("${") || script.includes("$(")) continue // composed at runtime, not checkable here
      const rel = path.posix.join(ref.dir, script)
      if (!existsSync(path.join(target.root, rel))) {
        problems.push(`line ${ref.line}${ref.dir ? ` (working-directory: ${ref.dir})` : ""}: step runs "${script}" but ${rel} does not exist under ${path.relative(repoRoot, target.root) || "."}`)
      }
    }
  }

  // 2a. every `run:` body has to parse as shell. A workflow file can be valid YAML and
  //     still carry a step whose script is unbalanced — Actions then fails that step at run
  //     time, mid-release, after the expensive jobs in front of it already ran. Found the
  //     hard way on 2026-10-16: an edit to a publish step left one `fi` short, and the only
  //     thing between that and a shipped release was a human reading the YAML. The bodies come
  //     from the scanner above (`shells`), not from re-joining `runRefs` by line number: this
  //     loop skips blank and `#` lines, so a body containing comments has gaps by construction,
  //     and re-assembling on contiguity reported 232 "problems" across five fine workflows.
  //     A control that cries wolf is worse than none — the next real one drowns with the rest.
  shells.forEach((block, index) => {
    const script = block.lines.join("\n")
    if (!script.trim()) return
    if (/^\s*(python3|node|bun)\s/.test(block.lines[0] ?? "")) return // a one-liner in another language
    const tmp = path.join(tmpdir(), `wf-step-${process.pid}-${index}.sh`)
    writeFileSync(tmp, `${script}\n`)
    const parsed = spawnSync("bash", ["-n", tmp], { encoding: "utf8" })
    unlinkSync(tmp)
    if (parsed.status !== 0) {
      const detail = (parsed.stderr || parsed.stdout || "bash -n failed").trim().split("\n")[0].replaceAll(tmp, "<step>")
      problems.push(
        `line ${block.line}: this step's shell does not parse — ${detail}. ` +
          `YAML validity is not shell validity: this step would fail at run time, after the jobs before it already spent their minutes.`,
      )
    }
  })

  // 2b. `bun run <name>` / `npm run <name>` names a *package.json script*, not a
  //     file, so the rule above cannot see it: a step that ran `bun run build` from
  //     the workspace root passed this check while the root package.json has no
  //     `build` script at all. Found 2026-09-30: the npm platform job failed with
  //     `Script not found "build"` while the binaries job — same command, correct
  //     working-directory — was already fixed and passing.
  for (const ref of runRefs) {
    // Each ref is a single physical line (see where refs are collected), and
    // whole-line comments are already skipped there. Match within one line, and
    // only where the command begins — after start-of-line or a chaining
    // operator — so prose that merely contains "run <word>" is not a script.
    //
    // Built with RegExp rather than a literal: the pattern needs a literal `/`
    // to detect a path argument, which inside a `/.../ ` literal would terminate
    // the expression.
    //
    // A "g" flag on a module-level regex means `exec()` advances `lastIndex`
    // *across* calls, and this regex is one object shared by every line. Taking
    // a single exec per ref therefore checked the first reference in the file and
    // then skipped alternate lines outright: measured over
    // ["npm run build", "npm run bundle --workspace glasspane-mcp",
    //  "npm run test --if-present", "npm run build"] the four single-exec calls
    // returned ["build", null, "test", null]. So `npm run bundle` (ci.yml:86,
    // release.yml:92) was never looked at, and renaming that script kept this
    // guard green while the release build died. Reset before each line and take
    // **every** match, the way the sibling READ_LITERAL below already does.
    RUN_SCRIPT.lastIndex = 0
    let hit
    while ((hit = RUN_SCRIPT.exec(ref.text)) !== null) {
      // `bun run path/to/file.ts` addresses a file bun executes directly; only a
      // bare name is a package.json script, and the file-existence rule above
      // already covers the former. The path test must be inside the pattern:
      // once the name is captured, "script/publish.ts" is already "script",
      // which is a different — and real — script name.
      if (hit[2] || hit[0].includes("/")) continue
      const name = hit[1]
      if (name.includes("$")) continue
      // Which manifest really owns this script. Without a selector it is the
      // step's own package.json — the behaviour this rule has always had.
      const owner = scriptOwners({ root: target.root, dir: ref.dir, text: ref.text })
      if (owner.mode === "skip") continue
      if (owner.mode === "any") {
        // `npm run x --workspaces` is satisfied by any workspace that declares it;
        // an `--if-present` line is already handled above as "skip", which is the
        // only honest reading of a flag whose whole purpose is to tolerate absence.
        // Known limit: npm fails when a *subset* of workspaces lacks the script and
        // `--if-present` was not passed; this answers "nobody has it", not "who lacks it".
        if (owner.dirs.length && !owner.dirs.some((o) => hasScript(target.root, o.dir, name))) {
          problems.push(
            `line ${ref.line}: step runs \`run ${name}\` across workspaces but none of ` +
              `${owner.dirs.map((o) => o.dir).join(", ")} declares "${name}"`,
          )
        }
        continue
      }
      for (const o of owner.dirs) {
        const pkgPath = path.posix.join(o.dir, "package.json")
        if (!existsSync(path.join(target.root, pkgPath))) continue // no manifest: nothing to assert against
        if (hasScript(target.root, o.dir, name)) continue
        problems.push(
          `line ${ref.line}${o.label}: step runs \`run ${name}\` but ` +
            `${pkgPath || "package.json"} has no "${name}" script`,
        )
      }
    }
  }

  // 2c. A `run:` step that reads a relative path must be able to resolve it from
  //     where the step actually executes. Found 2026-09-30 twice in one day: the
  //     npm platform step did `cd packages/opencode` and then read a bare
  //     `product.json`, which lives at the *product root* — it died with ENOENT
  //     after a full platform build, the expensive way to learn a path is wrong.
  //     The failure is invisible here until CI pays for it twice.
  //
  //     Known limit: this resolves against the step's `working-directory` only.
  //     A `cd` *inside* the script is not tracked, so a step that does
  //     `cd packages/opencode` and then reads a bare `product.json` looks fine
  //     here (the file exists at the root) and still dies in CI. Fixing that
  //     means modelling shell control flow; until then the two forms are fixed
  //     by hand, and the literal `../../product.json` spelling — which this rule
  //     does verify — is the one to reach for.
  // Built with RegExp for the same reason as RUN_SCRIPT above: the pattern
  // contains quote characters that are awkward inside a literal, and exec()
  // returns a single match (or null) — iterating it as if it were an array
  // silently checks nothing.
  const READ_LITERAL = new RegExp("readFileSync\\(\\s*['\"`]\\s*([^'\"`]+?)\\s*['\"`]", "g")
  for (const ref of runRefs) {
    READ_LITERAL.lastIndex = 0
    let m
    while ((m = READ_LITERAL.exec(ref.text)) !== null) {
      const lit = m[1]
      // Skip anything computed at runtime; only literal relative paths are checkable.
      if (lit.includes("$") || lit.startsWith("process.argv")) continue
      if (path.isAbsolute(lit)) continue
      // Only path-shaped literals. `readFileSync('utf8')` and module specifiers
      // like `readFileSync('fs')` are not paths, and a rule that reports those
      // is a rule people learn to skip.
      if (!/[/\\]/.test(lit) && !/\.[A-Za-z0-9]+$/.test(lit)) continue
      const base = path.posix.join(ref.dir, lit)
      const fromStep = path.join(target.root, base)
      if (!existsSync(fromStep) && !existsSync(path.join(target.root, lit))) {
        problems.push(
          `line ${ref.line}: step reads "${lit}" but it does not exist ` +
            `relative to ${ref.dir ? `working-directory ${ref.dir}` : "the repo root"} ` +
            `(looked for ${path.relative(repoRoot, fromStep)})`,
        )
      }
    }
  }

  // 3. a job gated on `inputs.x` that nobody declared is a job that never runs.
  //    Found 2026-09-26: the verify-trusted-publisher job existed, its input did not
  //    (an insert missed the indentation), and the dispatch API rejected the run — a
  //    workflow that looks wired and is not.
  const declared = new Set(lines.map((l) => l.match(/^[ \t]{6}([A-Za-z0-9_]+):[ \t]*$/)?.[1]).filter(Boolean))
  const referenced = new Set([...(lines.join("\n").match(/inputs\.([A-Za-z0-9_]+)/g) ?? [])].map((m) => m.split(".")[1]))
  for (const name of referenced) {
    if (!declared.has(name)) problems.push(`uses inputs.${name} but never declares it under workflow_dispatch.inputs`)
  }

  // 3a2. `gh … --json <fields>` asks gh for a field it does not have. Measured on the
  //      v1.18.0 release: the readback asked for `latest`, gh answered
  //      `Unknown JSON field: "latest"` + the list it does have, and the step died **after**
  //      the release was created and its assets uploaded — a half-shipped version whose only
  //      symptom is a red lane. A field gh cannot answer is not a slow check, it is a check
  //      that never ran, so the question is settled here instead of in the release lane.
  for (const problem of ghJsonFieldProblems(text, base)) problems.push(problem)

  // A workflow without a top-level `permissions:` runs with whatever the repository hands
  // the default token — historically `contents: write`. Every job in it can then push a ref
  // or write a release, including the jobs that `npm ci` a lockfile nobody reviewed. The rule
  // is "declare the minimum", even when the minimum is only `contents: read`: silence here is
  // a decision made by the repository settings, not by this file's author.
  if (!hasTopPermissions) {
    problems.push(`${base}: no top-level "permissions:" block — this workflow inherits the repository's default token scope (often contents: write) instead of declaring the minimum it needs`)
  }

  // 3b. The same rule has a second half that the check above cannot see, because it lives
  //     *inside* a job: a job-level `permissions:` block REPLACES the workflow-level one, and
  //     every scope it does not name becomes `none` for that job. So a job that narrows
  //     `id-token` — the shape a provenance publish needs — and nothing else silently loses
  //     `contents: read`, and then `actions/checkout` in that job has no readable repository
  //     and `git ls-remote` has no credentials. `release.yml`'s `npm-publish` job was written
  //     exactly that way and passed every publish so far, because a PUBLIC repository lets the
  //     fetch fall back to anonymous; that fallback is not this file's promise, and the day it
  //     stops the irreversible channel dies at step one with nothing local able to see it.
  //     Indentation-based, like the rest of this walker: a job is a 2-space key under `jobs:`,
  //     its own `permissions:` block is a 4-space key, and its scopes are 6-space keys.
  //     Rule 3c (the pin rule) rides the same walk and is enforced for EVERY root this tool scans,
  //     the fork subtree under `harness/` included. That is a policy change, not a bug fix: the
  //     call used to pass `enforcePins: target.primary === true`, on the theory that the subtree's
  //     publish channel belongs to the harness release line and the finding could only be
  //     "reported to that line, not fixed from here". The exemption bought nothing and cost the
  //     only thing the rule has — the split repo IS this product's release lane (a `git subtree
  //     split` publishes it verbatim, and its tag is what triggers the release), and its
  //     `release.yml` declared `environment: release` / `id-token: write` while still running
  //     `actions/checkout@v4`: the exact attack the parent's own release.yml documents ("a retagged
  //     `@v4` would run attacker code there, sign an attacker archive with the real key"). Both
  //     roots are pinned now, so the rule has nothing left to look away from.
  problems.push(...jobPolicyProblems(lines))

  return { jobs: [...seen.keys()], problems }
}

/**
 * For every job that both declares its own `permissions:` block and reads the repository
 * (through `actions/checkout`, or by presenting the default token to `git`/`gh`), require the
 * block to name `contents`. Returns problem lines; a job with no `permissions:` block is not
 * this rule's business — it correctly inherits the workflow-level minimum.
 *
 * The same walk also serves the second rule: a job that declares an `environment:` is the job
 * that can read secrets, so every action it runs must be addressed by commit SHA. A retagged
 * `@v4` inside such a job is arbitrary code with the signing key in its `env:` — and the
 * product's own trust chain cannot detect the consequence, because the updater's 8th gate
 * checks the fingerprint on the signature, which a stolen key satisfies. Jobs with no
 * environment are out of scope for that rule on purpose: the pin is cheap exactly where the
 * payload is irreversible, and widening it to the read-only CI lanes is a separate change.
 * Local `uses: ./path` actions are exempt by construction: their bytes are the commit already
 * checked out, so there is no mutable upstream ref to retag.
 *
 * It used to take an `enforcePins` switch so the fork subtree could be skipped; the switch and the
 * exemption are both gone, and every root `inspect()` reaches is enforced. Keeping a knob with no
 * caller that turns a control off is how a control quietly stops existing.
 */
/**
 * The fields `gh release view --json` can actually answer, as printed by gh itself on
 * 2026-10-20 (`Unknown JSON field: "latest"` followed by the list). Not invented, and the
 * three `--self-test` cases below are what keep this list honest: a field outside it
 * reddens the gate, a field set inside it must stay silent.
 */
const GH_RELEASE_VIEW_FIELDS = new Set([
  'apiUrl', 'assets', 'author', 'body', 'createdAt', 'databaseId', 'id', 'isDraft',
  'isImmutable', 'isPrerelease', 'name', 'publishedAt', 'tagName', 'tarballUrl',
  'targetCommitish', 'uploadUrl', 'url', 'zipballUrl',
])

/**
 * Every `gh release view … --json a,b,c` in a workflow: are all the named fields real?
 * Only `release view` is checked today because that is the one this repository asks;
 * an unknown command's fields are left alone rather than guessed at.
 *
 * Comment lines are skipped — a `#` line inside a `run:` block never executes, and a
 * scanner that reports prose as a defect gets silenced by deleting the prose instead of
 * fixing the command. This repository's release.yml *documents* the `latest` mistake on
 * such a line; the gate must stay blind to that and red for the command.
 */
function ghJsonFieldProblems(text, base, known = GH_RELEASE_VIEW_FIELDS) {
  const problems = []
  const pattern = /gh\s+release\s+view[^\n]*?--json\s+([A-Za-z0-9,_]+)/g
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(line)) !== null) {
      for (const field of match[1].split(',').filter(Boolean)) {
        if (!known.has(field)) {
          problems.push(`${base}: "gh release view --json" asks for "${field}", which gh does not answer — the step dies on `
            + `Unknown JSON field instead of verifying anything. Fields gh listed on 2026-10-20 are the ones this gate knows.`)
        }
      }
    }
  }
  return problems
}

function jobPolicyProblems(lines) {
  const out = []
  let inJobs = false
  let current = null
  const jobs = new Map()

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.replace(/\s+$/, "")
    if (!line || line.trimStart().startsWith("#")) continue
    if (/^[A-Za-z0-9_-]+:/.test(line)) {
      inJobs = line.split(":")[0] === "jobs"
      current = null
      continue
    }
    if (!inJobs) continue
    const jobMatch = /^ {2}([A-Za-z0-9_.-]+):/.exec(line)
    if (jobMatch) {
      current = { name: jobMatch[1], line: i + 1, scopes: null, readsRepo: false, environment: null, unpinned: [], unresolvable: [] }
      jobs.set(current.name, current)
      continue
    }
    if (!current) continue
    const env = /^ {4}environment:\s*(\S+)/.exec(line)
    if (env) {
      current.environment = env[1].replace(/^["']|["']$/g, "")
      continue
    }
    if (/^ {4}permissions:\s*$/.test(line)) {
      const scopes = new Set()
      for (let j = i + 1; j < lines.length; j++) {
        const scope = /^ {6}([A-Za-z0-9_-]+):/.exec(lines[j].replace(/\s+$/, ""))
        if (scope) scopes.add(scope[1].toLowerCase())
        else if (!/^\s*$/.test(lines[j]) && lines[j].search(/\S/) <= 4) break
      }
      current.scopes = scopes
      continue
    }
    if (/uses:\s*actions\/checkout\b/.test(line) || /\bgithub\.token\b/.test(line) || /git ls-remote/.test(line)) {
      current.readsRepo = true
    }
    const used = /^\s*(?:-\s*)?uses:\s*(\S+)/.exec(line)
    // A `uses: ./some/local/action` ref is not addressable by a SHA and does not need to be: the
    // action's bytes come from the commit this run already checked out, so a retagged upstream
    // release — the attack this rule exists for — has nothing to reach. Enforcing the 40-hex shape
    // here would demand a syntax GitHub does not accept for local actions and make the fork's
    // release lane unfixable rather than safe.
    if (used && current.environment && !/^\.{1,2}\//.test(used[1]) && !/@[0-9a-f]{40}/.test(used[1])) {
      current.unpinned.push({ ref: used[1], line: i + 1 })
    }
    // Shape, not provenance. A `uses:` value GitHub cannot resolve makes the whole workflow
    // file fail at registration: the run is created, gets zero jobs, and dies in under a second
    // with no log at all — measured on 2026-10-15 when a release lane pinned an action as a bare
    // 40-hex SHA with no `owner/repo` in front of it. The pin rule above cannot see that, because
    // a bare SHA *is* 40 hex. Only two shapes are addressable: a path inside the repository, or
    // `owner/repo@ref` (optionally with a host for container actions).
    if (used && !/^\.{1,2}\//.test(used[1]) && !/^(?:[\w.-]+\/)?[\w.-]+\/[\w.-]+@[\w.-]+$/.test(used[1])) {
      current.unresolvable.push({ ref: used[1], line: i + 1 })
    }
  }

  for (const job of jobs.values()) {
    if (job.unresolvable?.length) {
      out.push(
        `job "${job.name}" (line ${job.line}) runs ${job.unresolvable.map((u) => `"${u.ref}" at line ${u.line}`).join(", ")} — ` +
          `a "uses:" value must be "./some/local/action" or "owner/repo@ref" (a 40-hex SHA is a ref, not an address). ` +
          `GitHub rejects the whole file otherwise: the run appears, gets no jobs, and fails in ~0s with no log.`,
      )
    }
    if (job.scopes && job.readsRepo && !job.scopes.has("contents")) {
      out.push(
        `job "${job.name}" (line ${job.line}) declares its own "permissions:" block without "contents", while it checks out the repository — ` +
          `a job-level block replaces the workflow-level one and unlisted scopes become none, so this job has no readable repository. ` +
          `Add "contents: read" (or write) to the block at line ${job.line}.`,
      )
    }
    if (job.environment && job.unpinned.length) {
      out.push(
        `job "${job.name}" declares "environment: ${job.environment}" (so it can read that environment's secrets) but runs ${job.unpinned
          .map((u) => `${u.ref} at line ${u.line}`)
          .join(", ")} by mutable tag — pin every "uses:" in this job to a 40-hex commit SHA.`,
      )
    }
  }
  return out
}

/**
 * Pull out `node foo.mjs` / `bash foo.sh` / `sh foo.sh` / `python3 foo.py`
 * style paths from a single command line. Anything not repo-relative (bare
 * flags, external binaries, URLs) is ignored — this checks our own files, not
 * the whole shell language.
 */
function referencedScripts(cmd) {
  const out = []
  const re = /(?:^|[\s;|&(])(?:node|npx|bash|sh|zsh|python3?)\s+(["']?)(\.?\/?[\w./-]+\.(?:mjs|cjs|js|ts|sh|py))\1/g
  let m
  while ((m = re.exec(cmd))) {
    const p = m[2].replace(/^\.\//, "")
    if (p.startsWith("/")) continue // absolute: environment, not repository
    if (/^https?:/.test(p)) continue
    out.push(p)
  }
  return out
}

/** True when `<root>/<dir>/package.json` parses and declares `name` as a script. */
function hasScript(root, dir, name) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, dir, "package.json"), "utf8"))
    return Boolean(pkg?.scripts?.[name])
  } catch {
    return false
  }
}

/**
 * Which package.json file(s) own `npm run <name>` on this command line.
 *
 * Without a selector the answer is the step's own directory, which is what this
 * rule asserted before `--workspace` support existed. It stopped being the whole
 * answer the moment scanning reached every match on a line: release.yml:92 is
 * `npm run bundle --workspace glasspane-mcp`, executed from the repository root,
 * and the root has no `bundle` script — npm runs it in the workspace the selector
 * names. Checking that line against the root manifest reports a defect CI runs
 * green, which is how a guard gets un-fixed; resolving the selector is what makes
 * the newly-visible reference checkable at all.
 *
 * Returns `{ mode, dirs }`:
 *   `skip`   — nothing provable here, say nothing (npm tolerates the absence, or
 *              the selector cannot be resolved — this rule never guesses).
 *   `own`    — assert against `dirs[0]`, the step's own package.json.
 *   `named`  — assert against each selected workspace.
 *   `any`    — `--workspaces` plural: at least one workspace must declare it.
 */
function scriptOwners({ root, dir, text }) {
  // `--if-present` is npm's own "do not fail when the script is missing"; a guard
  // that fails it is asserting a defect that cannot happen.
  if (/(?:^|\s)--if-present(?:\s|$)/.test(text)) return { mode: "skip", dirs: [] }

  const ownLabel = dir ? ` (working-directory: ${dir})` : " (workspace root)"
  const specs = [...text.matchAll(/(?:^|\s)(?:--workspace|--ws|-w)(?:\s+|=)(["']?)([^\s"']+)\1/g)].map((m) => m[2])
  if (specs.length > 0) {
    const dirs = []
    for (const spec of specs) {
      const resolved = resolveWorkspace({ root, spec })
      if (resolved === null) return { mode: "skip", dirs: [] } // unresolvable selector: not this rule's call
      dirs.push({ dir: resolved, label: ` (workspace ${spec} → ${resolved})` })
    }
    return { mode: "named", dirs }
  }
  if (/(?:^|\s)--workspaces(?:\s|$)/.test(text)) {
    return { mode: "any", dirs: workspaceDirs(root).map((d) => ({ dir: d, label: ` (workspace ${d})` })) }
  }
  return { mode: "own", dirs: [{ dir, label: ownLabel }] }
}

/**
 * The workspace directories the root manifest declares. npm's own glob support is
 * one `*` segment here (`packages/*`), so that is all this expands — against the
 * real directory listing rather than a glob engine this tool must not grow.
 */
function workspaceDirs(root) {
  let pkg
  try {
    pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
  } catch {
    return []
  }
  const declared = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces?.packages ?? [])
  const dirs = []
  for (const pattern of declared) {
    if (typeof pattern !== "string" || pattern.includes("$")) continue
    if (!pattern.includes("*")) {
      dirs.push(pattern)
      continue
    }
    const [head, rest] = pattern.split("*")
    const parent = path.join(root, head)
    if (!existsSync(parent)) continue
    for (const name of readdirSync(parent)) {
      if (name.startsWith(".")) continue
      const candidate = [head.replace(/\/+$/, ""), name, (rest ?? "").replace(/^\/+/, "")].filter(Boolean).join("/")
      if (existsSync(path.join(root, candidate, "package.json"))) dirs.push(candidate)
    }
  }
  return [...new Set(dirs)]
}

/**
 * Map an npm `--workspace` selector to a directory: by package `name` first (the
 * spelling our own workflow uses), then by path. Null means "not found", which
 * the caller turns into no assertion — a wrong selector breaks in CI with npm's
 * own message, and inventing a second message here is not this guard's job.
 */
function resolveWorkspace({ root, spec }) {
  const bare = spec.replace(/^\.\//, "")
  const dirs = workspaceDirs(root)
  if (dirs.includes(bare) || existsSync(path.join(root, bare, "package.json"))) return bare
  for (const d of dirs) {
    try {
      if (JSON.parse(readFileSync(path.join(root, d, "package.json"), "utf8")).name === spec) return d
    } catch {
      // a workspace whose manifest will not parse is not a match
    }
  }
  return null
}

// ---------------------------------------------------------------- self-test
//
// `--self-test` exists because CI runs it, and it used to do *nothing*: the script
// ignored its argv entirely, so `node scripts/check-workflows.mjs --self-test`
// performed the ordinary check and exited 0. An unrecognised flag behaved the same
// way. That is the worst shape for a guard — a step that looks like it proves the
// verifier works, and proves nothing.
//
// A rule nobody has seen go red is not a rule. So each case below feeds a mutated
// copy of a real workflow through `inspect()` and asserts the specific problem
// comes back. One case asserts the opposite half — that a shape the rule must not
// touch stays silent — because a rule that fires on legal syntax gets switched off,
// and that is how a control dies. The mutations run against a synthetic target in a
// temp dir, so they never touch the tree.
if (process.argv.includes("--self-test")) {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")

  const BASE = `name: CI
on:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  build:
    name: build the thing
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: run the real script
        run: node scripts/check-version.mjs
      - name: gated on a secret
        if: \${{ secrets.NPM_TOKEN != '' }}
        run: node scripts/check-version.mjs
`

  const cases = [
    {
      id: "duplicate job key",
      apply: (t) =>
        t.replace(
          /\n  build:\n/,
          "\n  build:\n    name: build the thing\n    runs-on: ubuntu-latest\n    steps: []\n  build:\n",
        ),
      expect: /defined 2 times/,
    },
    {
      id: "no top-level permissions block",
      // BASE 带着 `permissions: contents: read`；这里把它整块抹掉，规则必须因此变红。
      // 没有这一条的话，"缺 permissions" 是一道只能靠人记得的规矩——而 ci.yml 正是忘了的那份。
      apply: (t) => t.replace("permissions:\n  contents: read\n", ""),
      expect: /no top-level "permissions:" block/,
    },
    {
      id: "job-level permissions block that silently drops contents",
      // The defect `release.yml`'s npm-publish job actually shipped with: a job-level block
      // REPLACES the workflow-level one, so naming only `id-token` leaves `contents: none` in a
      // job whose first step checks the repository out. The top-level rule above cannot see it
      // — the file still has its `permissions:` block — so without this case the class is only
      // catchable by remembering it, which is exactly how it survived every publish so far.
      apply: (t) =>
        t.replace(
          "  build:\n    name: build the thing\n    runs-on: ubuntu-latest\n",
          "  build:\n    name: build the thing\n    runs-on: ubuntu-latest\n    permissions:\n      id-token: write\n",
        ),
      expect: /without "contents"/,
    },
    {
      id: "environment job running a mutable action tag",
      // `environment:` is what makes the job interesting: it is the job that can read the
      // signing key. Turn on an environment in BASE (whose steps run `actions/checkout@v4`)
      // and the pin rule must fire on that ref.
      apply: (t) =>
        t.replace(
          "  build:\n    name: build the thing\n    runs-on: ubuntu-latest\n",
          "  build:\n    name: build the thing\n    runs-on: ubuntu-latest\n    environment: release\n",
        ),
      expect: /pin every "uses:"/,
    },
    {
      id: "a repo-local action in an environment job is not an unpinned ref",
      // The other half of the same rule, and the half that decides whether the fork's release
      // lane can be pinned at all: its jobs run `./.github/actions/setup-bun`, a composite action
      // whose bytes are the commit this run already checked out. There is no upstream tag to
      // retag there, and GitHub rejects `./path@<sha>` — so a pin rule that fired on it would
      // demand a syntax that cannot exist. Same environment, SHA-pinned checkout, local action:
      // the rule must stay silent.
      apply: (t) =>
        t
          .replace(
            "  build:\n    name: build the thing\n    runs-on: ubuntu-latest\n",
            "  build:\n    name: build the thing\n    runs-on: ubuntu-latest\n    environment: release\n",
          )
          .replace(
            "- uses: actions/checkout@v4",
            "- uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4\n      - uses: ./.github/actions/setup-bun",
          ),
      absent: /pin every "uses:"/,
    },
    {
      id: "secrets context in a step's if:",
      apply: (t) => t, // the BASE already carries it
      expect: /secrets context/,
    },
    {
      id: "uses: pinned to a bare SHA with no owner/repo (the 0-second red release run)",
      // The shape GitHub itself rejects. Written the way the defect actually shipped: a
      // 40-hex SHA standing alone where `actions/upload-artifact@<sha>` belongs — a pin the
      // pin rule is happy with, and a workflow file GitHub cannot register at all.
      apply: (t) => t.replace("- uses: actions/checkout@v4", "- uses: cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2"),
      expect: /must be "\.\/some\/local\/action" or "owner\/repo@ref"/,
    },
    {
      id: "unquoted value containing ': ' (the harness-contract defect)",
      apply: (t) => t.replace("name: build the thing", "name: canonical kernel: moved? anchor still reachable?"),
      expect: /unquoted value/,
    },
    {
      id: "a `run:` body whose shell does not parse (the missing `fi`)",
      // YAML stays valid here — that is the point. The defect only surfaces when the step
      // executes, which in a release lane is minutes and one half-published version later.
      apply: (t) => t.replace("        run: node scripts/check-version.mjs\n", "        run: |\n          if [ -n \"x\" ]; then\n            echo yes\n"),
      expect: /this step's shell does not parse/,
    },
    {
      id: "referenced script that does not exist",
      apply: (t) => t.replace("scripts/check-version.mjs", "scripts/does-not-exist.mjs"),
      expect: /does not exist|not found/,
    },
    {
      id: "undeclared workflow_dispatch input",
      apply: (t) =>
        t
          .replace("on:\n  push:\n    branches: [main]", "on:\n  workflow_dispatch:\n    inputs:\n      probe_tag:\n        required: false")
          .replace("name: build the thing", "name: probe ${{ inputs.undeclared }}"),
      expect: /never declares it/,
    },
    {
      // THE lastIndex REGRESSION CASE. This is the one rule-2b mutation the
      // original harness could not see: with a single `exec()` per line on a
      // shared "g" flag, the first `npm run` in the file consumed the match state
      // and every alternate `npm run` line went unchecked — so a second command in
      // the same step, naming a script that does not exist, produced **no problem
      // at all**. Delete the `RUN_SCRIPT.lastIndex = 0` reset (or go back to one
      // exec per ref) and this case is the one that goes red.
      id: "a second `npm run` line in the same step (the shared-lastIndex defect)",
      apply: (t) =>
        t.replace(
          "      - name: gated on a secret",
          "      - name: two commands in one step\n" +
            "        run: |\n" +
            "          npm run build\n" +
            "          npm run bundle-that-does-not-exist\n" +
            "      - name: gated on a secret",
        ),
      expect: /no "bundle-that-does-not-exist" script/,
    },
    {
      id: "`gh release view --json` asking for a field gh does not have",
      // What actually cost the v1.18.0 release lane its readback: `latest` is not a
      // `gh release view` field, gh exits with `Unknown JSON field`, and the step dies
      // *after* the release and its assets already exist. Verify-it-yourself is worth
      // nothing if the verifier was never able to run.
      apply: (t) =>
        t.replace(
          "      - name: gated on a secret",
          "      - name: read the release back\n" +
            '        run: gh release view "$TAG" --json tagName,isDraft,latest,assets --jq .isDraft\n' +
            "      - name: gated on a secret",
        ),
      expect: /which gh does not answer/,
    },
    {
      id: "`gh release view --json` with only fields gh really answers",
      // The same step with the corrected field list must be silent, or this rule is just
      // a permanent red that someone switches off.
      apply: (t) =>
        t.replace(
          "      - name: gated on a secret",
          "      - name: read the release back\n" +
            '        run: gh release view "$TAG" --json tagName,isDraft,assets,targetCommitish --jq .isDraft\n' +
            "      - name: gated on a secret",
        ),
      absent: /which gh does not answer/,
    },
    {
      id: "a bad field that only appears in a comment",
      // release.yml documents this exact mistake on a `#` line. Prose that cannot execute
      // must not redden the gate — a scanner that reports comments gets its comments
      // deleted rather than its commands fixed, and the command then goes unverified.
      apply: (t) =>
        t.replace(
          "      - name: run the real script",
          "      - name: the mistake, in prose\n" +
            "        # gh release view \"$TAG\" --json tagName,latest used to live here\n" +
            "        run: node scripts/check-version.mjs\n" +
            "      - name: run the real script",
        ),
      absent: /which gh does not answer/,
    },
  ]

  const dir = mkdtempSync(path.join(tmpdir(), "check-workflows-selftest-"))
  mkdirSync(path.join(dir, "scripts"), { recursive: true })
  mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true })
  writeFileSync(path.join(dir, "scripts", "check-version.mjs"), "// present\n")
  // Rule 2b asserts a `run <name>` against the package.json of the step's own
  // directory, so without a manifest here it has nothing to say and the
  // lastIndex case below would pass for the wrong reason. `build` exists so the
  // first line of that step is a clean reference; only the second is the defect.
  writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: "selftest", version: "0.0.0", scripts: { build: "true" } }, null, 2)}\n`)

  let failed = 0
  for (const c of cases) {
    const text = typeof c.apply === "function" ? c.apply(BASE) : BASE
    const file = path.join(dir, ".github", "workflows", "ci.yml")
    writeFileSync(file, text)
    const { problems } = inspect({
      dir: path.join(dir, ".github", "workflows"),
      file: "ci.yml",
      root: dir,
      label: "self-test",
      primary: true,
    })
    const hit = c.absent ? !problems.some((p) => c.absent.test(p)) : problems.some((p) => c.expect.test(p))
    if (hit) {
      // `updater/test/scripts-check-workflows.test.mjs` counts the `ok self-test:` lines against
      // the number in the summary, so a counter-case still has to print as one line here — it just
      // says what it proved instead of claiming a catch.
      console.log(`  ok self-test: ${c.id} ${c.absent ? "stays silent, as it must" : "is caught"}`)
    } else {
      console.error(
        c.absent
          ? `  ✗ self-test: ${c.id} was NOT silent — the rule fires where it has no object`
          : `  ✗ self-test: ${c.id} was NOT caught (${problems.length} problem(s) reported)`,
      )
      failed++
    }
  }
  rmSync(dir, { recursive: true, force: true })

  if (failed > 0) {
    console.error(`check-workflows --self-test: ${failed} case(s) did not behave as declared.`)
    process.exit(1)
  }
  // The wording of this line is a contract: `updater/test/scripts-check-workflows.test.mjs` parses
  // `N case(s) each verified to fail` out of it and asserts N equals the number of
  // `ok self-test:` lines actually printed, so a case quietly dropped from the table cannot be
  // counted. The counter-case (the one that proves a legal shape stays silent) is a case verified
  // to answer as declared too, and the clause after the dash says which halves it has.
  const caught = cases.filter((c) => !c.absent).length
  const silent = cases.length - caught
  console.log(
    `check-workflows --self-test: ${cases.length} case(s) each verified to fail — ${caught} mutation(s) that had to be caught, ${silent} legal shape(s) that had to stay silent`,
  )
  process.exit(0)
}

const unknown = process.argv.slice(2).filter((a) => a !== "--self-test")
if (unknown.length) {
  console.error(`check-workflows: unknown argument(s) ${unknown.join(", ")} — the only flag is --self-test`)
  process.exit(2)
}

let bad = 0
for (const target of targets) {
  const { jobs, problems } = inspect(target)
  if (!jobs.length) {
    console.error(`check-workflows: ${target.label} declares no jobs at all — nothing verified`)
    bad++
    continue
  }
  for (const p of problems) {
    console.error(`  ✗ ${target.label}: ${p}`)
    bad++
  }
  if (!problems.length) console.log(`  ok ${target.label}: ${jobs.length} job(s), every referenced script exists`)
}

if (bad > 0) {
  console.error(`check-workflows: ${bad} problem(s) in ${targets.length} workflow file(s).`)
  process.exit(1)
}
console.log(`check-workflows: ${targets.length} workflow file(s) clean`)
