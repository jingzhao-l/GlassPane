/**
 * §6 row "CI 凭据".
 *
 * REVERSE MUTATION: treat "no CI run found" as fine (`if (!runs?.length) return
 * { ok: true }`) — `a commit with no CI run at all is unverified, not green`
 * goes red. Second mutation: drop the `conclusion === 'success'` filter —
 * `runs that exist but are not green` goes red.
 *
 * Driven against a real `node:http` server: the assertion that the query names
 * `head_sha` *and* `branch=main` can only be made against bytes a server saw.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CI_WORKFLOW, ciCommitSha, ciRunsUrl, commitShaOf, judgeCiRuns, verifyCiGreen } from '../lib/ci.js'
import { CODES } from '../lib/codes.js'
import { UpdaterError } from '../lib/fsutil.js'
import { PINNED_PATH, jsonResponse, startServer } from './helpers.mjs'
import { makeFetcher } from '../lib/source.js'

const SHA = 'f'.repeat(40)

test('the CI query names the commit and the main branch', () => {
  const url = new URL(ciRunsUrl({ base: 'https://api.github.com/repos/jingzhao-l/GlassPane', headSha: SHA }))
  assert.equal(url.pathname, PINNED_PATH + '/actions/runs')
  assert.equal(url.searchParams.get('head_sha'), SHA)
  assert.equal(url.searchParams.get('branch'), 'main')
})

test('a green run on main for that commit passes', () => {
  const verdict = judgeCiRuns({ workflow_runs: [{ id: 1, name: 'CI', conclusion: 'success', html_url: 'https://x/1' }] }, { version: '1.4.0' })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.run.name, 'CI')
})

test('a commit with no CI run at all is unverified, not green', () => {
  const error = capture(() => judgeCiRuns({ workflow_runs: [] }, { version: '1.4.0' }))
  assert.equal(error.code, CODES.ciUnverified)
  assert.match(error.message, /no CI run on main/i)
})

test('a payload without a workflow_runs list proves nothing', () => {
  assert.equal(capture(() => judgeCiRuns({}, { version: '1.4.0' })).code, CODES.ciUnverified)
  assert.equal(capture(() => judgeCiRuns({ workflow_runs: 'missing' }, { version: '1.4.0' })).code, CODES.ciUnverified)
  assert.equal(capture(() => judgeCiRuns(null, { version: '1.4.0' })).code, CODES.ciUnverified)
})

test('runs that exist but are not green refuse with the reasons listed', () => {
  const error = capture(() =>
    judgeCiRuns(
      {
        workflow_runs: [
          { name: 'CI', status: 'completed', conclusion: 'failure' },
          { name: 'engine (Swift)', status: 'completed', conclusion: 'cancelled' },
          { name: 'docs', status: 'in_progress', conclusion: null },
        ],
      },
      { version: '1.4.0' },
    ))
  assert.equal(error.code, CODES.ciNotGreen)
  assert.match(error.message, /CI=completed\/failure/)
  assert.match(error.message, /docs=in_progress\/none/)
})

test('target_commitish has to be a full commit sha', () => {
  assert.equal(commitShaOf({ target_commitish: SHA, tag_name: 'v1.4.0' }), SHA)
  for (const value of ['main', '', null, SHA.slice(0, 7), 'HEAD', SHA.toUpperCase()]) {
    assert.equal(capture(() => commitShaOf({ target_commitish: value, tag_name: 'v1.4.0' })).code, CODES.ciUnverified, `refuse ${JSON.stringify(value)}`)
  }
})

// REVERSE MUTATION (lib/ci.js): drop the workflow filter in `judgeCiRuns` (accept
// any green run) — `a green run from another workflow is not this credential`
// goes red. Second mutation: read `target_commitish` and ignore `commit_id` (the
// previous behaviour) — `the release's own commit_id wins over the mutable
// target_commitish` goes red, and so does the sentence the verdict records.
test('a green run from another workflow is not this credential', () => {
  const payload = {
    workflow_runs: [
      // `status` is part of every real `workflow_runs` payload; the verdict prints
      // it next to the conclusion, so a fixture that omits it measures nothing
      // about what an operator will actually read in the refusal.
      { id: 1, name: 'Deploy docs', status: 'completed', conclusion: 'success', workflow_id: 99 },
      { id: 2, name: 'CI', status: 'completed', conclusion: 'failure', workflow_id: 7 },
    ],
  }
  // The same payload with no workflow named still passes: `judgeCiRuns` is a pure
  // verdict, and it is `verifyCiGreen` that supplies the pinned workflow.
  assert.equal(judgeCiRuns(payload, { version: '1.4.0' }).ok, true)
  const error = capture(() => judgeCiRuns(payload, { version: '1.4.0', workflow: { name: 'CI' } }))
  assert.equal(error.code, CODES.ciNotGreen, 'CI ran and lost: that is "not green", not "nothing ran"')
  assert.match(error.message, /CI=completed\/failure/)
  assert.doesNotMatch(error.message, /Deploy docs/, 'the docs workflow is not part of the question being answered')
  const none = capture(() => judgeCiRuns(
    { workflow_runs: [{ id: 1, name: 'Deploy docs', conclusion: 'success', workflow_id: 99 }] },
    { version: '1.4.0', workflow: { name: 'CI' } },
  ))
  assert.equal(none.code, CODES.ciUnverified)
  assert.match(none.message, /Deploy docs/, 'the refusal names what it did see')
  // A workflow id works as well as a name, for a mirror that renames runs:
  // run 2 is `CI`, and its conclusion is a failure.
  assert.equal(capture(() => judgeCiRuns(payload, { version: '1.4.0', workflow: { id: 7 } })).code, CODES.ciNotGreen)
  assert.equal(judgeCiRuns(payload, { version: '1.4.0', workflow: { id: 99 } }).run.name, 'Deploy docs')
})

test('verifyCiGreen asks GitHub for the pinned workflow only, and records which sha it used', async () => {
  const fetchJson = makeFetcher()
  const green = await startServer({
    [PINNED_PATH + '/actions/runs']: jsonResponse({
      workflow_runs: [
        { id: 1, name: 'Deploy docs', conclusion: 'success', workflow_id: 99 },
        { id: 2, name: 'CI', conclusion: 'success', workflow_id: 7 },
      ],
    }),
  })
  try {
    const base = green.origin + PINNED_PATH
    const verdict = await verifyCiGreen({ release: { target_commitish: SHA, tag_name: 'v1.4.0' }, base, fetchJson })
    assert.equal(verdict.ok, true)
    assert.equal(verdict.run.name, 'CI', 'the answer names the workflow that carried the credential')
    assert.equal(verdict.shaSource, 'target_commitish')
    assert.equal(verdict.workflow, 'CI')
    assert.equal(green.requests[0].query.head_sha, SHA)
  } finally {
    await green.close()
  }
  const docsOnly = await startServer({
    [PINNED_PATH + '/actions/runs']: jsonResponse({ workflow_runs: [{ id: 1, name: 'Deploy docs', conclusion: 'success' }] }),
  })
  try {
    const error = await captureAsync(() => verifyCiGreen({ release: { target_commitish: SHA, tag_name: 'v1.4.0' }, base: docsOnly.origin + PINNED_PATH, fetchJson }))
    assert.equal(error.code, CODES.ciUnverified)
  } finally {
    await docsOnly.close()
  }
})

test("the release's own commit_id wins over the mutable target_commitish", () => {
  const commitId = 'a'.repeat(40)
  const fromCommit = ciCommitSha({ commit_id: commitId, target_commitish: 'main', tag_name: 'v1.4.0' })
  assert.deepEqual(fromCommit, { sha: commitId, source: 'commit_id' })
  const fallback = ciCommitSha({ target_commitish: SHA, tag_name: 'v1.4.0' })
  assert.deepEqual(fallback, { sha: SHA, source: 'target_commitish' })
  assert.equal(ciCommitSha({ commit_id: ` ${commitId} `, target_commitish: 'main' }).sha, commitId, 'whitespace is not part of a sha')
  for (const bad of ['main', 'deadbeef', commitId.toUpperCase(), null, '']) {
    assert.equal(capture(() => ciCommitSha({ commit_id: bad, target_commitish: SHA, tag_name: 'v1.4.0' })).code, CODES.ciUnverified, `commit_id ${JSON.stringify(bad)} must not be trusted as a sha`)
  }
  // The fallback keeps its own rule: a branch name in `target_commitish` proves nothing.
  assert.equal(capture(() => ciCommitSha({ target_commitish: 'main', tag_name: 'v1.4.0' })).code, CODES.ciUnverified)
})

test('verifyCiGreen over a real server: 200, 500 and an empty list are three different answers', async () => {
  const fetchJson = makeFetcher()
  const green = await startServer({
    [PINNED_PATH + '/actions/runs']: jsonResponse({ workflow_runs: [{ id: 7, name: 'CI', conclusion: 'success' }] }),
  })
  const empty = await startServer({
    [PINNED_PATH + '/actions/runs']: jsonResponse({ workflow_runs: [] }),
  })
  const broken = await startServer({
    [PINNED_PATH + '/actions/runs']: jsonResponse({ message: 'boom' }, 500),
  })
  try {
    const base = green.origin + PINNED_PATH
    const verdict = await verifyCiGreen({ release: { target_commitish: SHA, tag_name: 'v1.4.0' }, base, fetchJson })
    assert.equal(verdict.ok, true)
    assert.equal(green.requests[0].query.head_sha, SHA)
    assert.equal(green.requests[0].query.branch, 'main')

    const missing = await captureAsync(() => verifyCiGreen({ release: { target_commitish: SHA }, base: empty.origin + PINNED_PATH, fetchJson }))
    assert.equal(missing.code, CODES.ciUnverified)

    const unavailable = await captureAsync(() => verifyCiGreen({ release: { target_commitish: SHA }, base: broken.origin + PINNED_PATH, fetchJson }))
    assert.equal(unavailable.code, CODES.ciUnverified, 'a CI query that cannot be read is "unknown", never "verified"')
  } finally {
    await green.close()
    await empty.close()
    await broken.close()
  }
})

function capture(fn) {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof UpdaterError, 'expected an UpdaterError, got ' + error)
    return error
  }
  throw new assert.AssertionError({ message: 'the call was expected to refuse, and it did not' })
}

async function captureAsync(fn) {
  try {
    await fn()
  } catch (error) {
    assert.ok(error instanceof UpdaterError, 'expected an UpdaterError, got ' + error)
    return error
  }
  throw new assert.AssertionError({ message: 'the call was expected to refuse, and it did not' })
}
