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
const wfDir = path.join(repoRoot, ".github", "workflows")

if (!existsSync(wfDir)) {
  console.error(`check-workflows: ${path.relative(repoRoot, wfDir)} does not exist — nothing was verified`)
  process.exit(2)
}
const files = readdirSync(wfDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml")).sort()
if (!files.length) {
  console.error("check-workflows: no workflow files found — refusing to report success over an empty set")
  process.exit(2)
}

/**
 * Walk a workflow file line by line. We only need two structural facts, and we
 * get them from indentation rather than a YAML parser so that duplicate keys
 * (which a parser collapses) stay visible.
 */
function inspect(file) {
  const lines = readFileSync(path.join(wfDir, file), "utf8").split("\n")
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

  // 2. repo scripts referenced by run: steps must exist (resolved against the
  //    step's own working-directory, which is how Actions runs them)
  for (const ref of runRefs) {
    for (const script of referencedScripts(ref.text)) {
      if (script.includes("${") || script.includes("$(")) continue // composed at runtime, not checkable here
      const rel = path.posix.join(ref.dir, script)
      if (!existsSync(path.join(repoRoot, rel))) {
        problems.push(`line ${ref.line}${ref.dir ? ` (working-directory: ${ref.dir})` : ""}: step runs "${script}" but ${rel} is not in the repository`)
      }
    }
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

let bad = 0
for (const file of files.sort()) {
  const { jobs, problems } = inspect(file)
  if (!jobs.length) {
    console.error(`check-workflows: ${file} declares no jobs at all — nothing verified`)
    bad++
    continue
  }
  for (const p of problems) {
    console.error(`  ✗ ${file}: ${p}`)
    bad++
  }
  if (!problems.length) console.log(`  ok ${file}: ${jobs.length} job(s), every referenced repo script exists`)
}

if (bad > 0) {
  console.error(`check-workflows: ${bad} problem(s) in ${files.length} workflow file(s).`)
  process.exit(1)
}
console.log(`check-workflows: ${files.length} workflow file(s) clean`)
