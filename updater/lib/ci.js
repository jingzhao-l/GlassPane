/**
 * Spec §1 gate 7: the commit the release was cut from has to have a **green CI
 * run on `main`**. This is the same credential the project already demands of a
 * release ("CI green" is what the publish gate uses), applied on the consumer
 * side so a hand-rolled release off an unverified commit cannot be installed.
 *
 * Absent runs ⇒ `ci-unverified` (nothing proves it).
 * Runs exist, none with `conclusion: "success"` ⇒ `ci-not-green`.
 * "Not found" is never read as "fine": the query failing, the payload missing
 * `workflow_runs`, and an empty list all refuse.
 */
import { CODES } from './codes.js'
import { UpdaterError } from './fsutil.js'

/** The query GitHub is asked with. `branch=main` keeps a green PR run from standing in. */
export function ciRunsUrl({ base, headSha, workflow = null }) {
  const url = new URL(`${base}/actions/runs`)
  url.searchParams.set('head_sha', String(headSha))
  url.searchParams.set('branch', 'main')
  if (workflow?.id) url.searchParams.set('workflow_id', String(workflow.id))
  url.searchParams.set('per_page', '50')
  return url.href
}

/**
 * The workflow §1.7 actually means. `.github/workflows/ci.yml` is `name: CI`, and
 * it is the suite this project treats as its release credential; a green
 * `Deploy docs` run on the same sha proves nothing about the bytes a release
 * ships. `id` is the number from the workflow file (GitHub's `workflow_runs`
 * filter accepts it as `workflow_id`); `name` is what the payload carries, and
 * is what the *answer* is matched on, because a payload can omit `name` while it
 * cannot invent a run that does not exist.
 */
export const CI_WORKFLOW = Object.freeze({ name: 'CI', id: null })

/**
 * Which commit a release traces back to, and *where that came from*.
 *
 * `target_commitish` is mutable bookkeeping: GitHub stores whatever the release
 * was pointed at (`main`, a branch name, or a sha somebody later moved), and this
 * project's own release job has to pin it explicitly for that reason. The
 * release payload's `commit_id`, when the API gives one, is the commit the tag
 * object points at, so it is read first and `target_commitish` only fills in when
 * it is absent. The verdict names which was used, because "green on main" means
 * different things about the two.
 */
export function ciCommitSha(release) {
  // Presence, not truthiness: a payload that carries `commit_id: null` or `""`
  // *looked* at the commit and failed to name it, which is a different fact from
  // an API that never offered the field. Falling back in that case would quietly
  // downgrade the credential to the mutable one, so a present-but-unusable value
  // refuses. Reverse mutation: `?? ''` + the empty-string test below passes only
  // while an unusable `commit_id` still refuses.
  const presented = release !== null && typeof release === 'object' && 'commit_id' in release
  const commitId = String(release?.commit_id ?? '').trim()
  if (presented && (commitId === '' || commitId === 'null' || commitId === 'undefined')) {
    throw new UpdaterError(
      CODES.ciUnverified,
      `release ${release?.tag_name ?? '?'} carries a commit_id that names nothing (${JSON.stringify(release?.commit_id)}): the fallback is the mutable \`target_commitish\`, and this gate does not quietly step down to it`,
    )
  }
  if (presented && commitId !== '') {
    if (!/^[0-9a-f]{40}$/.test(commitId)) {
      throw new UpdaterError(
        CODES.ciUnverified,
        `release ${release?.tag_name ?? '?'} names commit_id ${JSON.stringify(commitId)}, which is not a full commit sha: nothing can be traced back to a build, so this release is not installed`,
      )
    }
    return { sha: commitId, source: 'commit_id' }
  }
  return { sha: commitShaOf(release), source: 'target_commitish' }
}

/** `target_commitish` may be a branch name or a sha; only a sha can be checked. */
export function commitShaOf(release) {
  const value = String(release?.target_commitish ?? '').trim()
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new UpdaterError(
      CODES.ciUnverified,
      `release ${release?.tag_name ?? '?'} names target_commitish ${JSON.stringify(value)}, which is not a full commit sha: nothing can be traced back to a build, so this release is not installed`,
    )
  }
  return value
}

/** Pure verdict over a GitHub `actions/runs` payload. */
export function judgeCiRuns(payload, { version, workflow = null } = {}) {
  const runs = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : null
  if (!runs) {
    throw new UpdaterError(
      CODES.ciUnverified,
      `the CI query for ${version ?? 'this release'} returned a payload without a workflow_runs list, so its build status is unknown and the update is refused`,
    )
  }
  if (runs.length === 0) {
    throw new UpdaterError(
      CODES.ciUnverified,
      `no CI run on main was found for the commit this release was cut from, so nothing proves it was built green: refusing to install ${version ?? 'it'}`,
    )
  }
  // §1.7 asks for *the CI workflow*, not for "any green thing on that sha": a
  // docs-only workflow going green is not this repository's release credential.
  const named = workflow?.name || workflow?.id
    ? runs.filter((run) => (workflow.name ? run?.name === workflow.name : String(run?.workflow_id ?? '') === String(workflow.id)))
    : runs
  if (named.length === 0) {
    throw new UpdaterError(
      CODES.ciUnverified,
      `none of the ${runs.length} run(s) on main for this commit is the ${workflow.name ?? 'named'} workflow (runs seen: ${runs.map((run) => run?.name ?? '?').join(', ')}): the workflow this release credential depends on never ran, so ${version ?? 'it'} is not installed`,
    )
  }
  const green = named.filter((run) => run?.conclusion === 'success')
  if (green.length === 0) {
    const seen = named.map((run) => `${run?.name ?? '?'}=${run?.status ?? '?'}/${run?.conclusion ?? 'none'}`).join(', ')
    throw new UpdaterError(
      CODES.ciNotGreen,
      `the CI runs for this release's commit are not green (${seen}): refusing to install ${version ?? 'it'}`,
    )
  }
  return {
    ok: true,
    run: { id: green[0].id ?? null, name: green[0].name ?? null, url: green[0].html_url ?? null },
    considered: runs.length,
    matched: named.length,
  }
}

/** Fetch + judge. `fetchJson` is the same transport the release query uses. */
export async function verifyCiGreen({ release, base, fetchJson, workflow = CI_WORKFLOW }) {
  const { sha, source } = ciCommitSha(release)
  const version = release?.tag_name ?? sha.slice(0, 7)
  const url = ciRunsUrl({ base, headSha: sha, workflow })
  let payload
  try {
    payload = await fetchJson(url)
  } catch (error) {
    throw new UpdaterError(
      CODES.ciUnverified,
      `the CI query ${url} could not be read (${error.message}): build status unknown, so ${version} is not installed`,
    )
  }
  return {
    ...judgeCiRuns(payload, { version, workflow }),
    headSha: sha,
    shaSource: source,
    workflow: workflow?.name ?? workflow?.id ?? null,
  }
}
