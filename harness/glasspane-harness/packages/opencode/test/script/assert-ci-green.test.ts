import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * Fixed points for `script/assert-ci-green.mjs` — the gate that refuses to release a commit whose own
 * CI is not green.
 *
 * The gate is driven as a subprocess against a fake `gh` that answers like the Actions API, because
 * the judgement lives in TWO places: which runs the query lets through, and what the judge makes of
 * them. Testing only the judge would have kept the v0.13.0 outage green in the test suite: the query
 * carried `&event=push`, so a `workflow_dispatch` run that had verified the commit was invisible, and
 * a stale cancelled push run answered the release. The fake records the argv it was called with, so
 * the query itself is a pinned assertion instead of a comment.
 *
 * Every payload below uses the field set the API really returned for `bb3c2f22` (v0.13.0) on
 * 2026-11-03, captured with
 * `gh api "repos/jingzhao-l/glasspane-harness/actions/workflows/ci.yml/runs?head_sha=<sha>&per_page=100"`.
 */

const SHA = "bb3c2f22e251ecc2eb29451e2558a1fcdf9352dd"
const REPO = "jingzhao-l/glasspane-harness"
const GATE = path.join(import.meta.dir, "../../../../script/assert-ci-green.mjs")
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

/** Answer with `runs`, and leave the argv the gate used in `<name>-argv.txt` so the query can be read back. */
function ask(runs: readonly object[], name: string) {
  const argvFile = path.join(root, `${name}-argv.txt`)
  writeFileSync(path.join(root, `${name}-payload.json`), JSON.stringify({ workflow_runs: runs, total_count: runs.length }))
  const gh = path.join(fakeBin, `gh-${name}`)
  writeFileSync(
    gh,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > ${JSON.stringify(argvFile)}`,
      `exec cat ${JSON.stringify(path.join(root, `${name}-payload.json`))}`,
      "",
    ].join("\n"),
  )
  chmodSync(gh, 0o755)
  // `ghBin` is not a seam the script exposes, so the fake is put on PATH under its real name: the same
  // lookup the runner performs.
  writeFileSync(path.join(fakeBin, "gh"), `#!/bin/sh\nexec ${JSON.stringify(gh)} "$@"\n`)
  chmodSync(path.join(fakeBin, "gh"), 0o755)
  const got = spawnSync("node", [GATE, "--sha", SHA, "--repository", REPO, "--workflow", "ci.yml", "--budget", "2000", "--poll", "1"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, GH_TOKEN: "test-token-not-a-secret" },
  })
  return { code: got.status, text: `${got.stdout ?? ""}${got.stderr ?? ""}`, argv: readFileSync(argvFile, "utf8") }
}

describe("assert-ci-green: the query it asks", () => {
  test("asks about the commit and narrows by no event", () => {
    const got = ask([run({ id: 130, run_number: 130, event: "workflow_dispatch", created_at: "2026-11-01T07:20:02Z" })], "query")
    const argv = got.argv
    expect(argv).toContain("head_sha=" + SHA)
    expect(argv).not.toMatch(/[?&]event=/)
    expect(argv).toContain("per_page=100")
    expect(argv).toContain("repos/jingzhao-l/glasspane-harness/actions/workflows/ci.yml/runs")
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

  test("a cancelled latest names the rerun of THAT run as the remedy", () => {
    const got = ask(
      [
        run({ id: 41218725050, run_number: 125, created_at: "2026-10-30T10:00:00Z" }),
        run({ id: 41219999999, run_number: 128, conclusion: "cancelled", created_at: "2026-10-31T16:27:25Z" }),
      ],
      "cancelled",
    )
    expect(got.code).toBe(1)
    expect(got.text).toContain("cancelled, not failed")
    expect(got.text).toContain("gh run rerun 41219999999")
    expect(got.text).toContain(`--repo ${REPO}`)
  })

  test("no run recorded for this sha is refused: never ran is not passed", () => {
    const got = ask([], "none")
    expect(got.code).toBe(1)
    expect(got.text).toContain("has no run recorded for commit " + SHA)
  })

  test("a gh that cannot be asked is a refusal, not a pass", () => {
    const name = "broken"
    const gh = path.join(fakeBin, "gh")
    writeFileSync(gh, "#!/bin/sh\necho 'HTTP 401 Bad credentials' >&2\nexit 1\n")
    chmodSync(gh, 0o755)
    const got = spawnSync("node", [GATE, "--sha", SHA, "--repository", REPO, "--workflow", "ci.yml", "--budget", "2000", "--poll", "1"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, GH_TOKEN: "test-token-not-a-secret" },
    })
    expect(got.status).toBe(1)
    expect(`${got.stdout}${got.stderr}`).toContain("A job that cannot ask must not answer")
  })

  test("an unfinished latest waits, and the spent budget refuses as UNVERIFIED", () => {
    const name = "pending"
    writeFileSync(path.join(root, `${name}-payload.json`), JSON.stringify({ workflow_runs: [run({ id: 20, run_number: 20, status: "in_progress", conclusion: null })] }))
    const gh = path.join(fakeBin, "gh")
    writeFileSync(gh, `#!/bin/sh\nexec cat ${JSON.stringify(path.join(root, `${name}-payload.json`))}\n`)
    chmodSync(gh, 0o755)
    const got = spawnSync("node", [GATE, "--sha", SHA, "--repository", REPO, "--workflow", "ci.yml", "--budget", "5", "--poll", "1"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, GH_TOKEN: "test-token-not-a-secret" },
    })
    expect(got.status).toBe(1)
    expect(`${got.stdout}${got.stderr}`).toContain("refusing the release as UNVERIFIED")
  })

  test("a time argument that is not a positive integer is rejected before any waiting", () => {
    const got = spawnSync("node", [GATE, "--sha", SHA, "--repository", REPO, "--workflow", "ci.yml", "--budget", "20m"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, GH_TOKEN: "test-token-not-a-secret" },
    })
    expect(got.status).toBe(1)
    expect(`${got.stdout}${got.stderr}`).toContain("positive integer milliseconds")
  })

  test("no token is a refusal, not a skip", () => {
    const got = spawnSync("node", [GATE, "--sha", SHA, "--repository", REPO, "--workflow", "ci.yml"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, GH_TOKEN: "", GITHUB_TOKEN: "" },
    })
    expect(got.status).toBe(1)
    expect(`${got.stdout}${got.stderr}`).toContain("This is a refusal, not a skip")
  })
})
