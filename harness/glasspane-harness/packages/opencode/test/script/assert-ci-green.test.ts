import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { annotationsApiPath, jobsApiPath, judgeCiGreen, runsApiPath } from "../../../../script/assert-ci-green.mjs"

/**
 * Fixed points for `script/assert-ci-green.mjs` — the gate that refuses to release a commit whose own
 * CI is not green.
 *
 * The gate is driven as a subprocess against a fake `gh` that answers like the Actions API, because
 * the judgement lives in THREE places: which runs the query lets through, what the judge makes of
 * them, and — for a cancelled run — which reason it reads before prescribing a remedy. Testing only
 * the judge would have kept the v0.13.0 outage green in the test suite: the query carried
 * `&event=push`, so a `workflow_dispatch` run that had verified the commit was invisible, and a stale
 * cancelled push run answered the release.
 *
 * THE FAKE IS A ROUTER, NOT AN ECHO. It used to `exec cat <one payload>` for every argv, which meant
 * the jobs and annotations endpoints were answered with the runs payload — a stub that answers
 * anything vouches for a capability the production code does not have. Each route below matches one
 * endpoint shape and anything unrouted exits 1, so "the gate asked a question nobody answers" is a
 * measurable state instead of a silent pass. Every argv is appended to `<name>-argv.txt`, so the
 * queries themselves are pinned assertions rather than comments.
 *
 * THE CANCELLED-RUN FIXTURES ARE REAL CAPTURES, not invented shapes. `fixtures/runner-cancel/` holds
 * the bytes the API returned for `0633825b` (the v0.14.4 tag) on 2026-11-07, taken with:
 *   gh api "repos/jingzhao-l/glasspane-harness/actions/workflows/ci.yml/runs?head_sha=<sha>&per_page=100"
 *   gh api "repos/jingzhao-l/glasspane-harness/actions/runs/42357845872/jobs?per_page=100"
 *   gh api "repos/jingzhao-l/glasspane-harness/check-runs/128359753896/annotations"
 * That is the outage this file's cancelled branch was written for: GitHub retired the macOS 14 images
 * on 2026-11-02, the job pinned to `macos-14` was cancelled at queue time with zero steps and an empty
 * `runner_name`, and the old remedy ("nothing about the tree is wrong — re-run THAT run") was an
 * instruction that could not be followed, because a dispatched workflow reads the YAML at the
 * dispatched ref and a pushed tag is never moved. Two version numbers were lost to it.
 */

const SHA = "bb3c2f22e251ecc2eb29451e2558a1fcdf9352dd"
const REPO = "jingzhao-l/glasspane-harness"
const GATE = path.join(import.meta.dir, "../../../../script/assert-ci-green.mjs")
const CAPTURED = path.join(import.meta.dir, "fixtures/runner-cancel")
const root = mkdtempSync(path.join(tmpdir(), "assert-ci-green-"))
const fakeBin = path.join(root, "bin")
mkdirSync(fakeBin, { recursive: true })

afterAll(() => rmSync(root, { recursive: true, force: true }))

type RunFields = Partial<{
  id: number
  run_number: number
  event: string
  status: string
  conclusion: string | null
  created_at: string
}>

function run(fields: RunFields = {}) {
  return {
    id: fields.id ?? 1,
    name: "CI",
    run_number: fields.run_number ?? 1,
    event: fields.event ?? "push",
    status: fields.status ?? "completed",
    conclusion: fields.conclusion === undefined ? "success" : fields.conclusion,
    workflow_id: 1,
    created_at: fields.created_at ?? "2026-11-01T00:00:00Z",
    head_sha: SHA,
    html_url: `https://github.com/${REPO}/actions/runs/${String(fields.id ?? 1)}`,
  }
}

const sh = (value: string) => JSON.stringify(value)

type Route = { match: string; file?: string; status?: number; stderr?: string }

/**
 * Install a `gh` on PATH that routes by endpoint shape. `match` is a shell `case` glob, so the fake
 * does not recompute the production path formula — the exact paths are pinned separately against the
 * exported `*ApiPath` functions, which is where the query is part of the judgement.
 */
function fakeGh(name: string, routes: readonly Route[]) {
  const argvFile = path.join(root, `${name}-argv.txt`)
  writeFileSync(argvFile, "")
  const lines = ["#!/bin/sh", `printf '%s\\n' "$*" >> ${sh(argvFile)}`, 'case "$2" in']
  for (const route of routes) {
    const action = route.file
      ? `exec cat ${sh(route.file)}`
      : `printf '%s\\n' ${sh(route.stderr ?? "fake gh: this endpoint is refused")} >&2; exit ${route.status ?? 1}`
    lines.push(`  ${route.match}) ${action} ;;`)
  }
  lines.push(`  *) printf 'fake gh: no route for %s\\n' "$2" >&2; exit 1 ;;`, "esac", "")
  const gh = path.join(fakeBin, "gh")
  writeFileSync(gh, lines.join("\n"))
  chmodSync(gh, 0o755)
  return argvFile
}

function drive(extraArgs: readonly string[] = [], env: Record<string, string> = {}) {
  // The gate's `arg()` takes the FIRST occurrence of a flag, so an override has to PRECEDE the
  // defaults. Appending it silently kept the default: the "--budget 20m" case then ran a real 2000ms
  // budget instead of being rejected, and the "--budget 5" case passed by waiting 2000ms — a green
  // that measured something other than what it claimed.
  const got = spawnSync("node", [GATE, ...extraArgs, "--sha", SHA, "--repository", REPO, "--workflow", "ci.yml", "--budget", "2000", "--poll", "1"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, GH_TOKEN: "test-token-not-a-secret", ...env },
  })
  return { code: got.status, text: `${got.stdout ?? ""}${got.stderr ?? ""}` }
}

/** Answer the runs query with `runs`, plus whatever evidence routes the caller supplies. */
function ask(runs: readonly object[], name: string, evidence: readonly Route[] = []) {
  const payloadFile = path.join(root, `${name}-runs.json`)
  writeFileSync(payloadFile, JSON.stringify({ workflow_runs: runs, total_count: runs.length }))
  const argvFile = fakeGh(name, [{ match: "*/actions/workflows/*/runs*", file: payloadFile }, ...evidence])
  const got = drive()
  return { ...got, argv: readFileSync(argvFile, "utf8") }
}

const captured = (file: string) => JSON.parse(readFileSync(path.join(CAPTURED, file), "utf8")) as Record<string, unknown>

/** The two routes that carry the real v0.14.4 cancellation evidence. */
const REAL_EVIDENCE: Route[] = [
  { match: "*/actions/runs/*/jobs*", file: path.join(CAPTURED, "jobs.json") },
  { match: "*/check-runs/128359753896/annotations", file: path.join(CAPTURED, "annotations.json") },
]

const REAL_RUNS = () => (captured("runs.json").workflow_runs as object[])

/**
 * The real captured jobs payload with its one green job marked cancelled: a job that HAD a runner and
 * ran steps before the cancel. Only `conclusion` is changed, so the shape (16 steps, a real
 * `runner_name`, real timestamps) is the API's own. This is the transient case the rerun remedy is for.
 */
function cancelledAfterSteps() {
  const jobs = captured("jobs.json").jobs as Record<string, unknown>[]
  const ran = jobs.find((j) => j.conclusion === "success")
  return { total_count: 1, jobs: [{ ...ran, conclusion: "cancelled" }] }
}

function evidenceFile(name: string, payload: unknown) {
  const file = path.join(root, `${name}.json`)
  writeFileSync(file, JSON.stringify(payload))
  return file
}

describe("assert-ci-green: the queries it asks", () => {
  test("asks about the commit and narrows by no event", () => {
    const got = ask([run({ id: 130, run_number: 130, event: "workflow_dispatch", created_at: "2026-11-01T07:20:02Z" })], "query")
    expect(got.argv).toContain("head_sha=" + SHA)
    expect(got.argv).not.toMatch(/[?&]event=/)
    expect(got.argv).toContain("per_page=100")
    expect(got.argv).toContain("repos/jingzhao-l/glasspane-harness/actions/workflows/ci.yml/runs")
  })

  test("the runs path is the exported one, so the query cannot drift from its own pin", () => {
    expect(runsApiPath({ repository: REPO, workflow: "ci.yml", sha: SHA })).toBe(
      `repos/${REPO}/actions/workflows/ci.yml/runs?head_sha=${SHA}&per_page=100`,
    )
  })

  test("a cancelled latest costs the two extra questions that carry the reason", () => {
    const got = ask([run({ id: 42357845872, run_number: 139, conclusion: "cancelled" })], "asked-why", REAL_EVIDENCE)
    expect(got.argv).toContain(jobsApiPath({ repository: REPO, runId: 42357845872 }))
    expect(got.argv).toContain(annotationsApiPath({ repository: REPO, jobId: 128359753896 }))
    expect(jobsApiPath({ repository: REPO, runId: 42357845872 })).toBe(`repos/${REPO}/actions/runs/42357845872/jobs?per_page=100`)
    expect(annotationsApiPath({ repository: REPO, jobId: 128359753896 })).toBe(`repos/${REPO}/check-runs/128359753896/annotations`)
  })

  test("a green latest is not asked about its jobs: no cancel, no reason to read", () => {
    const got = ask([run({ id: 130, run_number: 130 })], "green-no-evidence")
    expect(got.code).toBe(0)
    expect(got.argv).not.toContain("/jobs")
    expect(got.argv).not.toContain("/annotations")
  })

  test("only the CANCELLED jobs are asked for annotations, not the green ones", () => {
    const got = ask([run({ id: 42357845872, run_number: 139, conclusion: "cancelled" })], "one-job-asked", REAL_EVIDENCE)
    // the captured run has one green job (128359753654) and one cancelled job (128359753896)
    expect(got.argv).toContain("check-runs/128359753896/annotations")
    expect(got.argv).not.toContain("check-runs/128359753654/annotations")
  })
})

describe("assert-ci-green: the answer it gives", () => {
  test("a cancelled push run followed by a green dispatch run on the same sha releases", () => {
    const got = ask(
      [
        run({ id: 41218725050, run_number: 125, event: "push", conclusion: "cancelled", created_at: "2026-10-31T16:14:36Z" }),
        run({ id: 41219350206, run_number: 126, event: "workflow_dispatch", conclusion: "cancelled", created_at: "2026-10-31T16:22:09Z" }),
        run({ id: 41284361291, run_number: 130, event: "workflow_dispatch", created_at: "2026-11-01T07:20:02Z" }),
      ],
      "outage",
    )
    expect(got.code).toBe(0)
    // names what vouched, so "green" is never an unattributed claim
    expect(got.text).toContain("#130 (workflow_dispatch) is success")
  })

  test("greenest is not latest: a later failure on the same sha is refused", () => {
    const got = ask(
      [
        run({ id: 10, run_number: 10, created_at: "2026-11-01T07:00:00Z" }),
        run({ id: 11, run_number: 11, conclusion: "failure", created_at: "2026-11-01T09:00:00Z" }),
      ],
      "later-failure",
    )
    expect(got.code).toBe(1)
    expect(got.text).toContain("is failure on commit " + SHA)
    expect(got.text).toContain("Fix the red run before shipping")
  })

  test("ordering the same runs the other way round does not change the verdict", () => {
    const late = run({ id: 900, run_number: 9, event: "workflow_dispatch", created_at: "2026-11-02T00:00:00Z" })
    const early = run({ id: 901, run_number: 8, conclusion: "failure", created_at: "2026-11-01T00:00:00Z" })
    for (const [name, runs] of [["order-a", [late, early]], ["order-b", [early, late]]] as const) {
      const got = ask(runs, name)
      expect(got.code).toBe(0)
      expect(got.text).toContain("#9 ")
    }
  })

  test("no run recorded for this sha is refused: never ran is not passed", () => {
    const got = ask([], "none")
    expect(got.code).toBe(1)
    expect(got.text).toContain("has no run recorded for commit " + SHA)
  })

  test("a gh that cannot be asked is a refusal, not a pass", () => {
    fakeGh("broken", [{ match: "*", status: 1, stderr: "HTTP 401 Bad credentials" }])
    const got = drive()
    expect(got.code).toBe(1)
    expect(got.text).toContain("A job that cannot ask must not answer")
  })

  test("an unfinished latest waits, and the spent budget refuses as UNVERIFIED", () => {
    const payloadFile = evidenceFile("pending", { workflow_runs: [run({ id: 20, run_number: 20, status: "in_progress", conclusion: null })] })
    fakeGh("pending", [{ match: "*/actions/workflows/*/runs*", file: payloadFile }])
    const got = drive(["--budget", "5"])
    expect(got.code).toBe(1)
    expect(got.text).toContain("refusing the release as UNVERIFIED")
  })

  test("a time argument that is not a positive integer is rejected before any waiting", () => {
    const got = drive(["--budget", "20m"])
    expect(got.code).toBe(1)
    expect(got.text).toContain("positive integer milliseconds")
  })

  test("no token is a refusal, not a skip", () => {
    const got = drive([], { GH_TOKEN: "", GITHUB_TOKEN: "" })
    expect(got.code).toBe(1)
    expect(got.text).toContain("This is a refusal, not a skip")
  })
})

describe("assert-ci-green: why a cancelled run was cancelled", () => {
  test("the real v0.14.4 capture: a retired image is named, and rerun is refused as a remedy", () => {
    const payloadFile = evidenceFile("real-runs", { workflow_runs: REAL_RUNS(), total_count: 2 })
    const argvFile = fakeGh("real", [{ match: "*/actions/workflows/*/runs*", file: payloadFile }, ...REAL_EVIDENCE])
    // the capture is about a different sha than the one this suite drives, so ask about its own
    const got = spawnSync("node", [GATE, "--sha", "0633825b8dd12927a3df3aeadb4ceef82df5ebcf", "--repository", REPO, "--workflow", "ci.yml", "--budget", "2000", "--poll", "1"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, GH_TOKEN: "test-token-not-a-secret" },
    })
    const text = `${got.stdout ?? ""}${got.stderr ?? ""}`
    expect(got.status).toBe(1)
    expect(text).toContain("the runner image is gone, not because of this tree")
    // the annotation is quoted verbatim, so the refusal is attributable to GitHub and not to a guess
    expect(text).toContain("The configuration 'macos-14-arm64-us-default' is not supported")
    expect(text).toContain("install.sh fallback channel (offline, stubbed)")
    expect(text).toContain("CANNOT help")
    expect(text).toContain("contracts/runner-images.json")
    expect(text).toContain("take a NEW version number")
    expect(text).not.toContain("then re-trigger this release")
    expect(readFileSync(argvFile, "utf8")).toContain("check-runs/128359753896/annotations")
  })

  test("the brownout wording the parent lane captured is the same judgement", () => {
    const jobs = captured("jobs.json")
    // The captured annotations payload is a bare JSON array, so the object-typed `captured` helper has to
    // be routed through `unknown` before it is read as a list — a direct cast to Record[] is refused.
    const annotations = [{ ...(captured("annotations.json") as unknown as Record<string, unknown>[])[0], message: "This job failed because of a scheduled macOS 14 runner image brownout" }]
    const got = ask([run({ id: 42357845872, run_number: 139, conclusion: "cancelled" })], "brownout", [
      { match: "*/actions/runs/*/jobs*", file: evidenceFile("brownout-jobs", jobs) },
      { match: "*/check-runs/128359753896/annotations", file: evidenceFile("brownout-ann", annotations) },
    ])
    expect(got.code).toBe(1)
    expect(got.text).toContain("the runner image is gone")
    expect(got.text).toContain("scheduled macOS 14 runner image brownout")
    expect(got.text).toContain("CANNOT help")
  })

  test("a cancel AFTER the runner started, with no annotation, is the transient shape and names the rerun", () => {
    const got = ask([run({ id: 42357845872, run_number: 139, conclusion: "cancelled" })], "transient", [
      { match: "*/actions/runs/*/jobs*", file: evidenceFile("transient-jobs", cancelledAfterSteps()) },
      { match: "*/check-runs/*/annotations", file: evidenceFile("transient-ann", []) },
    ])
    expect(got.code).toBe(1)
    expect(got.text).toContain("cancelled, not failed, after the runner had started")
    expect(got.text).toContain("ran 16 step(s)")
    expect(got.text).toContain("gh run rerun 42357845872")
    expect(got.text).toContain(`--repo ${REPO}`)
    expect(got.text).toContain("then re-trigger this release")
    expect(got.text).not.toContain("CANNOT help")
  })

  test("no annotation but zero steps and no runner: the labels are named, not called transient", () => {
    const got = ask([run({ id: 42357845872, run_number: 139, conclusion: "cancelled" })], "never-ran", [
      { match: "*/actions/runs/*/jobs*", file: path.join(CAPTURED, "jobs.json") },
      { match: "*/check-runs/*/annotations", file: evidenceFile("never-ran-ann", []) },
    ])
    expect(got.code).toBe(1)
    expect(got.text).toContain("GitHub recorded no annotation for it")
    expect(got.text).toContain("asked for [macos-14]")
    expect(got.text).toContain("ran 0 steps")
    expect(got.text).toContain("contracts/runner-images.json")
    expect(got.text).not.toContain("that is the transient shape")
  })

  test("an annotation that does not name the image is quoted and left unclassified", () => {
    // Negative control: the wording is deliberately NOT one of the two measured image wordings, so
    // this pins that the classifier does not swallow every cancel into "the image is gone".
    const got = ask([run({ id: 42357845872, run_number: 139, conclusion: "cancelled" })], "unclassified", [
      { match: "*/actions/runs/*/jobs*", file: path.join(CAPTURED, "jobs.json") },
      { match: "*/check-runs/128359753896/annotations", file: evidenceFile("unclassified-ann", [{ annotation_level: "warning", title: "", message: "a wording this gate has never measured" }]) },
    ])
    expect(got.code).toBe(1)
    expect(got.text).toContain("GitHub recorded why")
    expect(got.text).toContain("a wording this gate has never measured")
    expect(got.text).toContain("Read those before re-running")
    expect(got.text).not.toContain("the runner image is gone")
  })

  test("the jobs endpoint refusing is an unread reason, and no rerun is prescribed", () => {
    const got = ask([run({ id: 42357845872, run_number: 139, conclusion: "cancelled" })], "jobs-403", [
      { match: "*/actions/runs/*/jobs*", status: 1, stderr: "HTTP 403 Forbidden" },
    ])
    expect(got.code).toBe(1)
    expect(got.text).toContain("the reason could not be read")
    expect(got.text).toContain("HTTP 403 Forbidden")
    expect(got.text).toContain("An unread reason is not evidence that the cancel was transient")
    expect(got.text).toContain("checks: read")
    expect(got.text).not.toContain("gh run rerun")
    expect(got.text).not.toContain("nothing about the tree is wrong")
  })

  test("annotations refusing while jobs answered is a PARTIAL read, reported as partial", () => {
    const got = ask([run({ id: 42357845872, run_number: 139, conclusion: "cancelled" })], "ann-403", [
      { match: "*/actions/runs/*/jobs*", file: path.join(CAPTURED, "jobs.json") },
      { match: "*/check-runs/*/annotations", status: 1, stderr: "HTTP 403 Forbidden" },
    ])
    expect(got.code).toBe(1)
    expect(got.text).toContain("only partly read")
    expect(got.text).toContain("check-runs/128359753896/annotations")
    expect(got.text).toContain("checks: read")
    expect(got.text).not.toContain("gh run rerun")
  })

  test("a jobs payload with no jobs array is not read as 'no cancelled job'", () => {
    const got = ask([run({ id: 42357845872, run_number: 139, conclusion: "cancelled" })], "jobs-shape", [
      { match: "*/actions/runs/*/jobs*", file: evidenceFile("jobs-shape", { total_count: 0 }) },
    ])
    expect(got.code).toBe(1)
    expect(got.text).toContain('carries no "jobs" array')
    expect(got.text).not.toContain("gh run rerun")
  })

  test("a run cancelled with no cancelled job in it does not invent a reason", () => {
    const got = ask([run({ id: 42357845872, run_number: 139, conclusion: "cancelled" })], "no-cancelled-job", [
      { match: "*/actions/runs/*/jobs*", file: evidenceFile("no-cancelled-job", { total_count: 1, jobs: [{ ...cancelledAfterSteps().jobs[0], conclusion: "success" }] }) },
    ])
    expect(got.code).toBe(1)
    expect(got.text).toContain("no job in run 42357845872 is itself cancelled")
    expect(got.text).not.toContain("gh run rerun")
  })

  test("the judge asked without evidence says UNKNOWN instead of the old unconditional claim", () => {
    const verdict = judgeCiGreen({ workflow_runs: [run({ id: 77, run_number: 77, conclusion: "cancelled" })] }, { workflow: "ci.yml", sha: SHA, repository: REPO })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain("no cancellation evidence was read")
    expect(verdict.reason).toContain("UNKNOWN")
    expect(verdict.reason).not.toContain("nothing about the tree is wrong")
    expect(verdict.reason).not.toContain("gh run rerun")
  })

  test("an unrouted endpoint is refused by the fake, so a silent echo cannot vouch for the gate", () => {
    const payloadFile = evidenceFile("unrouted", { workflow_runs: [run({ id: 78, run_number: 78, conclusion: "cancelled" })] })
    const argvFile = fakeGh("unrouted", [{ match: "*/actions/workflows/*/runs*", file: payloadFile }])
    const got = drive()
    expect(got.code).toBe(1)
    expect(got.text).toContain("the reason could not be read")
    expect(got.text).toContain("no route for")
    expect(readFileSync(argvFile, "utf8")).toContain("/jobs?per_page=100")
  })
})