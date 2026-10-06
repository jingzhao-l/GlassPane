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
import { existsSync, readFileSync, readdirSync } from "node:fs"
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
  let stepDir = "" // step-level working-directory, applied to that step's scripts

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
        continue
      }
      inRun = false
    }

    if (top) {
      section = line.split(":")[0]
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

  return { jobs: [...seen.keys()], problems }
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
// comes back. The mutations run against a synthetic target in a temp dir, so they
// never touch the tree.
if (process.argv.includes("--self-test")) {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")

  const BASE = `name: CI
on:
  push:
    branches: [main]
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
      id: "secrets context in a step's if:",
      apply: (t) => t, // the BASE already carries it
      expect: /secrets context/,
    },
    {
      id: "unquoted value containing ': ' (the harness-contract defect)",
      apply: (t) => t.replace("name: build the thing", "name: canonical kernel: moved? anchor still reachable?"),
      expect: /unquoted value/,
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
    })
    const hit = problems.some((p) => c.expect.test(p))
    if (hit) {
      console.log(`  ok self-test: ${c.id} is caught`)
    } else {
      console.error(`  ✗ self-test: ${c.id} was NOT caught (${problems.length} problem(s) reported)`)
      failed++
    }
  }
  rmSync(dir, { recursive: true, force: true })

  if (failed > 0) {
    console.error(`check-workflows --self-test: ${failed} case(s) did not go red.`)
    process.exit(1)
  }
  console.log(`check-workflows --self-test: ${cases.length} case(s) each verified to fail`)
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
