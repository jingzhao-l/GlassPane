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
 * EVERY EVENT COUNTS, because the question is about the commit and not about who pressed the button.
 * This query used to carry `&event=push`, and on 2026-10-31 that filter cost a release: the push run
 * for `bb3c2f22` (v0.13.0) was cancelled by an unavailable macOS runner, a `workflow_dispatch` run of
 * the same ci.yml on the same sha went green on 11-01, and the gate still answered "ci.yml is
 * cancelled on commit bb3c2f22" — it could not see the run that had just verified the tree. The
 * documented remedy then dispatches another CI run, which is invisible to the same filter, so the
 * lane could not be unblocked by following its own instructions.
 *
 * A CANCELLED RUN'S REASON IS READ, NOT ASSUMED. "Cancelled" is not "the runner was busy": when GitHub
 * retired the macOS 14 images on 2026-11-02 the jobs pinned to that label were cancelled at queue time
 * with zero steps, and `gh run rerun` could never help because a dispatched workflow reads the YAML at
 * the dispatched ref and a pushed tag is never moved. Two version numbers were lost while this file
 * printed "nothing about the tree is wrong … re-run THAT run". So a cancelled latest now costs two more
 * API questions (the run's jobs, then each cancelled job's check-run annotations) and the remedy is
 * chosen from what they answer. An unread reason is reported as unread, never as transient.
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
 * @param {{workflow: string, sha: string, repository?: string, cancellation?: object|null}} asked what was asked, carried into the refusal text
 * @returns {{ok: boolean, pending?: boolean, reason: string, run?: object}}
 */
export function judgeCiGreen(payload, { workflow, sha, repository = '', cancellation = null }) {
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
      .map((r) => `#${r.run_number ?? '?'} ${r.conclusion ?? 'unknown'} (${r.event ?? 'unknown event'}) ${r.html_url ?? ''}`)
      .join('; ')
    const remedy = latest?.conclusion === 'cancelled'
      ? cancelledRemedy(latest, cancellation, repository)
      : 'Fix the red run before shipping. '
    return {
      ok: false,
      run: latest,
      reason: `${workflow} is ${latest.conclusion ?? 'unknown'} on commit ${sha}: ${failed || `#${latest.run_number} ${latest.html_url ?? ''}`}. `
        + `${remedy}Loosening this step is how an unverified tree gets a signed release.`,
    }
  }
  return { ok: true, run: latest, reason: `${workflow} #${latest.run_number ?? '?'} (${latest.event ?? 'unknown event'}) is success on commit ${sha} (${latest.id})` }
}

/**
 * A cancelled run is not a failing one — but "cancelled" alone does not say WHY, and the remedy is
 * entirely different per reason. This used to assert "nothing about the tree is wrong, the runner
 * never got a slot" and prescribe `gh run rerun <id>` unconditionally. On 2026-11-07 that sentence
 * was false and that command was a dead end: GitHub retired every macOS 14 image on 2026-11-02, so
 * the four jobs pinned to `macos-14` were cancelled at queue time with zero steps and an empty
 * `runner_name`, and re-running them re-read the SAME YAML (a dispatched workflow runs the file at
 * the dispatched ref, and a pushed tag is never moved). Two version numbers were lost to it
 * (v0.14.3, v0.14.4) while the gate kept printing an instruction that could not be followed.
 *
 * So the reason is READ, from the two endpoints that actually carry it, and the remedy is chosen by
 * what was read. An unread reason is never reported as a transient one.
 */
function cancelledRemedy(latest, cancellation, repository) {
  const runId = latest?.id ?? null
  const repoFlag = repository ? ` --repo ${repository}` : ''
  const rerun = runId ? `\`gh run rerun ${runId}${repoFlag}\`` : 're-run that run'
  const readIt = runId
    ? `\`gh api ${jobsApiPath({ repository: repository || '<owner/repo>', runId })}\` and, per cancelled job, \`gh api ${annotationsApiPath({ repository: repository || '<owner/repo>', jobId: '<job id>' })}\``
    : 'the run\'s jobs and their check-run annotations'
  if (!cancellation) {
    return `It was cancelled, not failed, and no cancellation evidence was read, so the reason is UNKNOWN. `
      + `Read ${readIt} before choosing a remedy. `
  }
  if (cancellation.error) {
    return `It was cancelled, not failed, and the reason could not be read: ${cancellation.error} `
      + 'An unread reason is not evidence that the cancel was transient, so no rerun is prescribed here. '
      + 'This job needs `actions: read` AND `checks: read` (the annotations endpoint is a check-run). ';
  }
  const quoted = cancellation.annotations.map((a) => `job "${a.jobName}" (${a.jobId}) ${a.level}: "${a.message}"`)
  // Only the two wordings GitHub was actually observed to produce for an image that no longer exists.
  // Anything else is quoted verbatim and left unclassified rather than matched by an invented pattern.
  const image = cancellation.annotations.find((a) => IMAGE_CANCEL.test(`${a.title} ${a.message}`))
  if (image) {
    return `It was cancelled because the runner image is gone, not because of this tree: ${quoted[0]}. `
      + `${rerun} CANNOT help — the job is cancelled before it gets a runner (zero steps, empty runner_name), `
      + 'and a dispatched workflow reads the YAML at the dispatched ref while a pushed tag is never moved. '
      + 'Change `runs-on:`/`runner:` to a label GitHub still serves (the served set and the retirement are '
      + 'recorded in contracts/runner-images.json, which script/check-workflows.mjs rule 5 enforces), let '
      + 'ci.yml go green on THAT commit, then take a NEW version number — that is letting this number '
      + 'go, not loosening the gate. '
  }
  if (cancellation.errors.length) {
    return `It was cancelled, not failed, and the reason was only partly read: ${cancellation.errors.join('; ')}. `
      + `${quoted.length ? `What was read: ${quoted.join('; ')}. ` : ''}`
      + 'An unread reason is not evidence that the cancel was transient, so no rerun is prescribed here. '
      + 'This job needs `actions: read` AND `checks: read`. '
  }
  if (quoted.length) {
    return `It was cancelled, not failed, and GitHub recorded why: ${quoted.slice(0, 3).join('; ')}`
      + `${quoted.length > 3 ? ` (+${quoted.length - 3} more)` : ''}. Read those before re-running: `
      + `${rerun} repeats whatever they describe. `
  }
  const neverRan = cancellation.jobs.filter((j) => j.steps === 0)
  if (cancellation.jobs.length && neverRan.length === cancellation.jobs.length) {
    return `It was cancelled, not failed, and GitHub recorded no annotation for it — but `
      + `${neverRan.map((j) => `job "${j.name}" (${j.id}) asked for [${j.labels.join(', ')}], got runner_name "${j.runnerName}" and ran ${j.steps} steps`).join('; ')}. `
      + `A job that never got a runner is the shape of a label GitHub no longer serves: check those labels `
      + `against contracts/runner-images.json before ${rerun}, because re-running re-reads the same YAML. `
  }
  if (!cancellation.jobs.length) {
    return `It was cancelled, not failed, and no job in run ${runId ?? '?'} is itself cancelled, so the reason `
      + `is not in the jobs payload. Read ${readIt} before choosing a remedy. `
  }
  const ran = cancellation.jobs.map((j) => `"${j.name}" ran ${j.steps} step(s)`).join('; ')
  return `It was cancelled, not failed, after the runner had started (${ran}), and GitHub recorded no `
    + `annotation against it — that is the transient shape, so re-run THAT run: ${rerun}, then re-trigger this release. `
}

/**
 * The two annotation wordings measured for a macOS 14 job that never got a runner:
 *   - "The configuration 'macos-14-arm64-us-default' is not supported"
 *     (this repository, run 42357845872 / job 128359753896, 2026-11-07, after the retirement);
 *   - "This job failed because of a scheduled macOS 14 runner image brownout"
 *     (the parent repository's ci.yml, during the brownout windows before it).
 * Both name the image rather than the code, which is what makes "rerun cannot help" a fact.
 */
const IMAGE_CANCEL = /is not supported|runner image brownout/i

export function jobsApiPath({ repository, runId }) {
  return `repos/${repository}/actions/runs/${runId}/jobs?per_page=100`
}

export function annotationsApiPath({ repository, jobId }) {
  return `repos/${repository}/check-runs/${jobId}/annotations`
}

/**
 * Why the latest run was cancelled, read from the API instead of assumed. Every failure to read is
 * carried back as an error rather than dropped: a gate that cannot ask must not answer "transient".
 */
export function fetchCancellation({ repository, runId, ghBin = 'gh' }) {
  const ask = (apiPath) => {
    const got = spawnSync(ghBin, ['api', apiPath], { encoding: 'utf8' })
    if (got.error) return { error: `could not run ${ghBin} (${got.error.message}) asking ${apiPath}` }
    if (got.status !== 0) {
      return { error: `${ghBin} api answered ${got.status} asking ${apiPath}: ${String(got.stderr ?? '').trim().slice(0, 200) || '(no stderr)'}` }
    }
    try {
      return { payload: JSON.parse(got.stdout) }
    } catch (error) {
      return { error: `${apiPath} is not JSON (${error.message}): ${String(got.stdout).slice(0, 120)}` }
    }
  }
  const jobsPath = jobsApiPath({ repository, runId })
  const jobsAsked = ask(jobsPath)
  if (jobsAsked.error) return { error: jobsAsked.error }
  if (!Array.isArray(jobsAsked.payload?.jobs)) {
    return { error: `${jobsPath} carries no "jobs" array, so no job in the run could be examined` }
  }
  const jobs = jobsAsked.payload.jobs
    .filter((j) => String(j.conclusion ?? '') === 'cancelled')
    .map((j) => ({
      id: j.id,
      name: String(j.name ?? '?'),
      labels: Array.isArray(j.labels) ? j.labels.map(String) : [],
      runnerName: String(j.runner_name ?? ''),
      steps: Array.isArray(j.steps) ? j.steps.length : 0,
    }))
  const annotations = []
  const errors = []
  for (const job of jobs) {
    const apiPath = annotationsApiPath({ repository, jobId: job.id })
    const asked = ask(apiPath)
    if (asked.error) {
      errors.push(asked.error)
      continue
    }
    if (!Array.isArray(asked.payload)) {
      errors.push(`${apiPath} is not an array of annotations`)
      continue
    }
    for (const a of asked.payload) {
      annotations.push({
        jobId: job.id,
        jobName: job.name,
        level: String(a.annotation_level ?? ''),
        title: String(a.title ?? ''),
        message: String(a.message ?? ''),
      })
    }
  }
  return { runId, jobs, annotations, errors }
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

/**
 * Which runs this gate is allowed to SEE is part of the judgement, not a detail of the transport, so
 * the query is exported and pinned by a test: it used to carry `&event=push`, which hid the
 * `workflow_dispatch` run that had verified v0.13.0's tree while a stale cancelled push run answered
 * "ci.yml is cancelled". Ask about the commit, and let every event of that commit answer.
 */
export function runsApiPath({ repository, workflow, sha }) {
  return `repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/runs?head_sha=${sha}&per_page=100`
}

function fetchRuns({ repository, workflow, sha, ghBin }) {
  const path = runsApiPath({ repository, workflow, sha })
  const got = spawnSync(ghBin, ['api', path], { encoding: 'utf8' })
  if (got.error) return { error: `could not run ${ghBin} (${got.error.message}) — the CI-green question was never answered` }
  if (got.status !== 0) {
    return {
      error: `${ghBin} api answered ${got.status}: ${String(got.stderr ?? '').trim().slice(0, 300) || '(no stderr)'}`
        + ` — asked ${path}. A job that cannot ask must not answer "green": check the step's `
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
        + '`GH_TOKEN: ${{ github.token }}` and the job `actions: read` plus `checks: read` (a cancelled '
        + "run's reason lives in its jobs' check-run annotations).",
    }
  }
  if (!sha) return { code: 1, text: 'no commit to ask about: neither --sha nor GITHUB_SHA is set. No object, no pass.' }
  if (!repository) return { code: 1, text: 'no GITHUB_REPOSITORY (and no --repository), so the Actions API cannot be addressed.' }

  const started = Date.now()
  let last = null
  for (;;) {
    const fetched = fetchRuns({ repository, workflow, sha, ghBin })
    if (fetched.error) return { code: 1, text: fetched.error }
    last = judgeCiGreen(fetched.payload, { workflow, sha, repository })
    // A cancelled run's remedy depends entirely on WHY it was cancelled, so the reason is read before
    // the refusal is printed. Re-judging with the evidence keeps "which run is latest" decided in one
    // place instead of sorting the payload a second time out here.
    if (!last.ok && !last.pending && last.run?.conclusion === 'cancelled' && last.run?.id) {
      last = judgeCiGreen(fetched.payload, {
        workflow,
        sha,
        repository,
        cancellation: fetchCancellation({ repository, runId: last.run.id, ghBin }),
      })
    }
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
