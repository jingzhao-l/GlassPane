#!/usr/bin/env node
/*
 * assert-ci-green.mjs — refuse to release a commit whose own CI is not green.
 *
 * WHY THIS EXISTS IN THIS REPOSITORY. `version-check` is the only gate in the lane that builds,
 * checksums and GPG-signs a release, and before this file it asked exactly one question: does the
 * pushed tag equal `product.json`'s `version`? That is a statement about this checkout's internal
 * consistency — a `main` HEAD that has never been tested satisfies it just as well. The tree-anchor
 * step below it proves the tag's tree IS trunk's fork subtree, which is again a statement about
 * bytes, not about whether anybody ran them. So nothing between "a tag was pushed" and "the signing
 * key signed it" asked the only question that matters about a build: did CI pass for this commit?
 *
 * The parent repository measured the consequence rather than imagining it. Its `SYNCLOG` records
 * v1.16.1: both release channels completed — non-draft release, assets present, signatures attached,
 * registry serving 1.16.1 — while CI for that very commit was RED (`root workspace gate`, a `write
 * EPIPE`). The documented order (push -> wait for green -> tag -> publish) was enforced by nobody.
 * This is the same lane, in the repository that actually publishes this product.
 *
 * THREE OUTCOMES ARE REPORTED SEPARATELY BECAUSE THE REMEDY DIFFERS:
 *   - greenest answer is not the latest answer: a red run for this sha names the run id, the
 *     conclusion and the URL, and says fix the code before shipping;
 *   - not finished yet: wait, and when the budget runs out refuse as UNVERIFIED (not as passed) —
 *     a tag pushed seconds after the commit lands on `main` hits this branch every day, so waiting
 *     is the design, not a fallback;
 *   - no CI run recorded for this sha at all: refuse. "Never ran" is not "passed"; this is the shape
 *     of a tag pointing at a commit that was never pushed, and letting it through signs a release
 *     built from untested bytes.
 *
 * THE JUDGEMENT TAKES THE LATEST RUN BY `created_at` (not by run id: monotone ids are a GitHub
 * implementation detail, the timestamp is the field the API documents as meaningful). Re-running a
 * commit is routine, so an old red must not pin this version forever — but "latest" has to really
 * mean latest.
 *
 * DELIBERATELY NOT DONE: no `--force`, no skip when `GH_TOKEN` is absent, no reading "no record" as
 * success. Releasing anyway means editing this file, which is where the trace is left.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/**
 * @param {{workflow_runs?: object[]}} payload GitHub `…/actions/workflows/<file>/runs` response body
 * @param {{workflow: string, sha: string}} asked what was asked, carried into the refusal text
 * @returns {{ok: boolean, pending?: boolean, reason: string, run?: object}}
 */
export function judgeCiGreen(payload, { workflow, sha }) {
  const runs = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : []
  if (runs.length === 0) {
    return {
      ok: false,
      reason: `${workflow} has no run recorded for commit ${sha} — "never ran" is not "ran green". `
        + 'The correct shape of a release object is: push the commit to the branch that carries this '
        + `workflow, let ${workflow} go green, then tag THAT commit.`,
    }
  }
  const sorted = [...runs].sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
  const latest = sorted[0]
  if (String(latest?.status ?? '') !== 'completed') {
    return {
      ok: false,
      pending: true,
      run: latest,
      reason: `${workflow} #${latest?.run_number ?? '?'} (${latest?.id}) is not finished on ${sha} `
        + `(status=${latest?.status ?? 'unknown'}); waiting for it.`,
    }
  }
  if (String(latest?.conclusion ?? '') !== 'success') {
    const failed = sorted
      .filter((r) => r.status === 'completed' && r.conclusion !== 'success')
      .map((r) => `#${r.run_number ?? '?'} ${r.conclusion ?? 'unknown'} ${r.html_url ?? ''}`)
      .join('; ')
    return {
      ok: false,
      run: latest,
      reason: `${workflow} is ${latest.conclusion ?? 'unknown'} on commit ${sha}: ${failed || `#${latest.run_number} ${latest.html_url ?? ''}`}. `
        + 'Fix the red run before shipping; loosening this step is how an unverified tree gets a signed release.',
    }
  }
  return { ok: true, run: latest, reason: `${workflow} #${latest.run_number ?? '?'} is success on commit ${sha} (${latest.id})` }
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}

/**
 * `--budget` / `--poll` must be genuine positive integer milliseconds. The reason is not tidiness:
 * `Number('20m')` is NaN, `elapsed >= NaN` is always false (the budget can never be reached) and
 * `Atomics.wait(…, NaN)` never returns — measured in the parent lane on 2026-10-16, where a probe
 * with that argument hung for two minutes and had to be killed. A mistyped time argument turns a
 * release job into an infinite wait that prints nothing. Reject the arguments before loosening any.
 */
function positiveInt(raw) {
  const n = Number(raw)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null
}

function fetchRuns({ repository, workflow, sha, ghBin }) {
  const apiPath = `repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/runs`
  const got = spawnSync(ghBin, ['api', `${apiPath}?head_sha=${sha}&event=push&per_page=100`], { encoding: 'utf8' })
  if (got.error) return { error: `could not run ${ghBin} (${got.error.message}) — the CI-green question was never answered` }
  if (got.status !== 0) {
    return {
      error: `${ghBin} api answered ${got.status}: ${String(got.stderr ?? '').trim().slice(0, 300) || '(no stderr)'}`
        + ` — asked ${apiPath}?head_sha=${sha}. A job that cannot ask must not answer "green": check the step's `
        + '`GH_TOKEN` and that this job declares `actions: read`.',
    }
  }
  try {
    return { payload: JSON.parse(got.stdout) }
  } catch (error) {
    return { error: `the ${workflow} runs response is not JSON (${error.message}): ${String(got.stdout).slice(0, 160)}` }
  }
}

export function main({ env = process.env, ghBin = 'gh', sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } = {}) {
  const sha = arg('sha', env.GITHUB_SHA ?? '') || ''
  const workflow = arg('workflow', 'ci.yml')
  const repository = arg('repository', env.GITHUB_REPOSITORY ?? '')
  const budgetRaw = arg('budget', '1800000')
  const pollRaw = arg('poll', '30000')
  const budgetMs = positiveInt(budgetRaw)
  const pollMs = positiveInt(pollRaw)
  if (budgetMs === null || pollMs === null) {
    return {
      code: 1,
      text: `--budget/--poll take positive integer milliseconds, got --budget=${budgetRaw} --poll=${pollRaw}. `
        + 'Any other number is not "unlimited", it is "never wakes up": the budget comparison becomes false '
        + 'and the sleep on that value never returns.',
    }
  }
  // The token is not optional, and its absence is not a skip. A step that "cannot ask" must never be
  // readable as a step that passed: the whole control is the answer to one API question.
  if (!env.GH_TOKEN && !env.GITHUB_TOKEN) {
    return {
      code: 1,
      text: 'no GH_TOKEN/GITHUB_TOKEN in this environment, so the Actions runs API cannot be asked whether CI '
        + `is green for ${sha || 'the tagged commit'}. This is a refusal, not a skip: give the step `
        + '`GH_TOKEN: ${{ github.token }}` and the job `actions: read`.',
    }
  }
  if (!sha) return { code: 1, text: 'no commit to ask about: neither --sha nor GITHUB_SHA is set. No object, no pass.' }
  if (!repository) return { code: 1, text: 'no GITHUB_REPOSITORY (and no --repository), so the Actions API cannot be addressed.' }

  const started = Date.now()
  let last = null
  for (;;) {
    const fetched = fetchRuns({ repository, workflow, sha, ghBin })
    if (fetched.error) return { code: 1, text: fetched.error }
    last = judgeCiGreen(fetched.payload, { workflow, sha })
    if (last.ok || !last.pending) return { code: last.ok ? 0 : 1, text: last.reason }
    if (Date.now() - started >= budgetMs) {
      return {
        code: 1,
        text: `${last.reason} the ${Math.round(budgetMs / 60000)}-minute budget is spent and it is still not done — `
          + 'refusing the release as UNVERIFIED. A longer wait is a deliberate edit to `--budget <ms>` here, '
          + 'which leaves a trace; it is not a flag on the command line.',
      }
    }
    process.stderr.write(`${last.reason} waiting ${Math.round(pollMs / 1000)}s more…\n`)
    sleep(pollMs)
  }
}

// Nothing runs on import, so `bun test` / `node --test` can require `judgeCiGreen` without the top-level
// self-run exiting the test process. BOTH sides of the entry comparison need realpath: node loads the
// ESM entry by its REAL path, so invoked through a symlink `process.argv[1]` is the link while
// `import.meta.url` is the target — comparing the unresolved strings is never equal, `main()` does not
// run, and the process exits 0 printing nothing. For a release gate that shape is "the lane skipped CI
// and said yes". realpathSync throws for a missing path; throwing means "not the direct entry", it does
// not crash the module.
function invokedAsEntrypoint() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedAsEntrypoint()) {
  const result = main()
  process.stdout.write(`${result.text}\n`)
  process.exit(result.code)
}
