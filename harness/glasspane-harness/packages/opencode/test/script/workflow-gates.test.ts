import { afterAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * Fixed points for `script/check-workflows.mjs` — the gate the fork's own workflows answer to.
 *
 * WHY THIS GATE EXISTS AT ALL, in one line: the parent repository scans these files but downgrades
 * every finding to a `△` advisory "reported to that root's own gate, not enforced from here", and
 * that root's own gate was nobody. The advisory had no address, so 12 jobs shipped with no ceiling
 * and 4 multi-statement run bodies shipped with whatever stop-on-failure behaviour the runner
 * image's default shell happened to provide.
 *
 * The fixtures are built in a throwaway directory and fed to the tool through its own `--dir` seam
 * rather than by editing the real `.github/workflows` — the tree is the product's, and a test that
 * mutates it can leave a broken release lane behind if it dies halfway. Every case below is the
 * tool reading a file, so the assertions are about the tool's judgement and not about its ability
 * to parse its own test setup.
 *
 * The clean fixture is written in the SAME shape as the real lanes (`set -euo pipefail`, a folded
 * form, a one-statement body, a local `uses:`) because a fixture that flatters the parser is how a
 * decorative ruler keeps its job.
 */
const GATE = path.join(import.meta.dir, "../../../../script/check-workflows.mjs")
const REAL_ROOT = path.join(import.meta.dir, "../../../..")

type Reading = { code: number; totals: Record<string, number> | null; out: string }

function run(dir: string): Reading {
  // Two passes over the same fixture: `--json` for the counts a floor can be asserted against, and
  // the plain report for the wording an assertion can quote. The JSON form escapes every `"` inside
  // a problem line, which makes a `toContain('job "verify" …')` assertion fail for a reason that has
  // nothing to do with the rule — and a test that reds on its own formatting teaches the next person
  // to weaken the rule instead of the test.
  const json = invoke(dir, ["--json"])
  const plain = invoke(dir, [])
  let totals: Record<string, number> | null = null
  try {
    totals = JSON.parse(json.stdout).totals ?? null
  } catch {
    // A non-JSON answer is reported through `out` in the assertion that asked for it.
  }
  return { code: plain.code, totals, out: `${plain.stdout}${plain.stderr}` }
}

function invoke(dir: string, flags: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", [GATE, "--dir", dir, ...flags], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    return { code: 0, stdout, stderr: "" }
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string }
    return { code: typeof e.status === "number" ? e.status : -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }
  }
}

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "gp-workflow-gates-"))
  mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true })
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, ".github", "workflows", name), text)
  return dir
}

const CLEAN = `name: clean
on: { push: { branches: [main] } }
permissions: { contents: read }
env:
  NPM_PUBLISH_VERSION: 12.2.0
jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
      - uses: ./.github/actions/setup-bun
      - run: bun install --frozen-lockfile
      - name: folded gates
        run: |
          set -euo pipefail
          npm install -g "npm@$NPM_PUBLISH_VERSION"
          echo "npm here: $(npm --version)"
`

const dirs: string[] = []
const withFixture = (files: Record<string, string>, use: (dir: string) => void) => {
  const dir = fixture(files)
  dirs.push(dir)
  try {
    use(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("the workflow gate measures the fork's real lanes", () => {
  test("node is present, or this lane cannot answer at all", () => {
    try {
      execFileSync("node", ["--version"], { encoding: "utf8" })
    } catch {
      throw new Error("node is not on PATH — check-workflows.mjs is run by node in ci.yml, so this lane cannot claim anything")
    }
  })

  test("the real .github/workflows is clean, and the scan is not empty", () => {
    let stdout = ""
    let code = 0
    try {
      stdout = execFileSync("node", [GATE, "--json"], { cwd: REAL_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string }
      code = e.status ?? -1
      stdout = e.stdout ?? ""
      throw new Error(`check-workflows --check on the real tree exited ${code}: ${(e.stderr ?? "").slice(0, 2000)}`)
    }
    expect(code).toBe(0)
    const read = JSON.parse(stdout) as { totals: Record<string, number>; problems: string[] }
    expect(read.problems).toEqual([])
    // Floors, not exact counts: a legitimate new job must not redden this test, while a scan that
    // quietly stopped reading files must. 12 jobs / 18 refs / 36 bodies is what the two real
    // workflows measure on the commit this test was written (ci.yml 2 + release.yml 10).
    expect(read.totals.jobs).toBeGreaterThanOrEqual(12)
    expect(read.totals.refs).toBeGreaterThanOrEqual(18)
    expect(read.totals.bodies).toBeGreaterThanOrEqual(36)
    expect(read.totals.multi).toBeGreaterThanOrEqual(23)
  })
})

describe("rule 1 — an action ref must be a commit SHA", () => {
  test("a retagged action is named", () => {
    withFixture({ "a.yml": CLEAN.replace("actions/checkout@11d5960a326750d5838078e36cf38b85af677262", "actions/checkout@v4") }, (dir) => {
      const read = run(dir)
      expect(read.code).toBe(1)
      expect(read.out).toContain("actions/checkout@v4")
      expect(read.out).toContain("40-hex commit SHA")
    })
  })

  test("an action with no ref at all is named, not skipped", () => {
    withFixture({ "a.yml": CLEAN.replace("actions/checkout@11d5960a326750d5838078e36cf38b85af677262", "actions/checkout") }, (dir) => {
      const read = run(dir)
      expect(read.code).toBe(1)
      expect(read.out).toContain("carries no ref")
    })
  })

  test("a local composite action is legal, and still counted as a ref", () => {
    // The count is the half that keeps the exemption honest: if `uses:` lines were not being read
    // at all, "no problem reported" would mean the same thing here as it does for a broken ruler.
    withFixture({ "a.yml": CLEAN }, (dir) => {
      const read = run(dir)
      expect(read.code).toBe(0)
      expect(read.totals?.refs).toBe(2)
    })
  })
})

describe("rule 2 — every job carries a ceiling", () => {
  test("a job with no timeout-minutes is named", () => {
    withFixture({ "a.yml": CLEAN.replace("    timeout-minutes: 30\n", "") }, (dir) => {
      const read = run(dir)
      expect(read.code).toBe(1)
      expect(read.out).toContain('job "verify" declares no "timeout-minutes"')
    })
  })

  test("a ceiling of zero is not a ceiling", () => {
    withFixture({ "a.yml": CLEAN.replace("timeout-minutes: 30", "timeout-minutes: 0") }, (dir) => {
      const read = run(dir)
      expect(read.code).toBe(1)
      expect(read.out).toContain("not a positive whole number")
    })
  })

  test("and the clean fixture stays green, so this rule is not just noise", () => {
    withFixture({ "a.yml": CLEAN }, (dir) => expect(run(dir).code).toBe(0))
  })
})

describe("rule 3 — a multi-statement run body declares its own gates", () => {
  test("dropping the header is named, with the job and the statement count", () => {
    withFixture({ "a.yml": CLEAN.replace("          set -euo pipefail\n", "") }, (dir) => {
      const read = run(dir)
      expect(read.code).toBe(1)
      expect(read.out).toContain('run body in job "verify" never declares -e/-u/pipefail')
      expect(read.out).toContain("2-statement")
    })
  })

  test("a body that declares only two of the three is still named, by the one it lacks", () => {
    withFixture({ "a.yml": CLEAN.replace("set -euo pipefail", "set -eu") }, (dir) => {
      const read = run(dir)
      expect(read.code).toBe(1)
      expect(read.out).toContain("never declares pipefail")
      expect(read.out).not.toContain("never declares -e/-u/pipefail")
    })
  })

  test("`set -e` then `-o pipefail` on separate lines is the same promise", () => {
    withFixture({ "a.yml": CLEAN.replace("set -euo pipefail", "set -eu\n          set -o pipefail") }, (dir) => expect(run(dir).code).toBe(0))
  })

  test("a single-statement body needs no header, because its exit status IS the verdict", () => {
    // The anti-overreaction case. Without it the rule would demand headers on `run: bun install` and
    // the next person would widen the rule until it caught nothing.
    withFixture({ "a.yml": CLEAN.replace('      - name: folded gates\n        run: |\n          set -euo pipefail\n          npm install -g "npm@$NPM_PUBLISH_VERSION"\n          echo "npm here: $(npm --version)"\n', "      - run: echo done\n") }, (dir) => expect(run(dir).code).toBe(0))
  })

  test("a body whose first statement is node or bun is one script in another language", () => {
    withFixture({ "a.yml": CLEAN.replace('      - name: folded gates\n        run: |\n          set -euo pipefail\n          npm install -g "npm@$NPM_PUBLISH_VERSION"\n          echo "npm here: $(npm --version)"\n', '      - run: |\n          node scripts/x.mjs\n          echo "after"\n') }, (dir) => expect(run(dir).code).toBe(0))
  })

  test("two statements chained on one line are reported, not excused", () => {
    withFixture({ "a.yml": CLEAN.replace('      - run: bun install --frozen-lockfile\n', '      - run: bun install --frozen-lockfile && bun run build\n') }, (dir) => {
      const read = run(dir)
      expect(read.code).toBe(1)
      expect(read.out).toContain("has no room to declare")
    })
  })
})

describe("rule 4 — the npm pin has exactly one definition", () => {
  test("a literal version is named", () => {
    withFixture({ "a.yml": CLEAN.replace('npm install -g "npm@$NPM_PUBLISH_VERSION"', 'npm install -g "npm@12.2.0"') }, (dir) => {
      const read = run(dir)
      expect(read.code).toBe(1)
      expect(read.out).toContain('the npm version is a literal ("12.2.0")')
    })
  })

  test("two candidate pins in one file is a refusal, because 'agree' needs one thing to agree with", () => {
    withFixture({ "a.yml": CLEAN.replace("env:\n  NPM_PUBLISH_VERSION: 12.2.0\n", "env:\n  NPM_PUBLISH_VERSION: 12.2.0\n  NPM_OTHER: 11.0.0\n") }, (dir) => {
      const read = run(dir)
      expect(read.code).toBe(1)
      expect(read.out).toContain("2 workflow-level NPM pin key(s)")
    })
  })

  test("a file with no npm step is not this rule's business", () => {
    withFixture({ "a.yml": CLEAN.replace('      - name: folded gates\n        run: |\n          set -euo pipefail\n          npm install -g "npm@$NPM_PUBLISH_VERSION"\n          echo "npm here: $(npm --version)"\n', '      - run: |\n          set -euo pipefail\n          bun test\n          echo ok\n') }, (dir) => expect(run(dir).code).toBe(0))
  })
})

describe("the gate refuses to certify a scan that measured nothing", () => {
  test("no .github/workflows directory is exit 2, never a green run", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gp-workflow-empty-"))
    dirs.push(dir)
    const read = run(dir)
    expect(read.code).toBe(2)
    expect(read.out).toContain("refusing to call an absent scan a pass")
  })

  test("an empty workflows directory is exit 2", () => {
    withFixture({}, (dir) => {
      const read = run(dir)
      expect(read.code).toBe(2)
      expect(read.out).toContain("no workflow file")
    })
  })

  test("a workflow the parser reads no jobs from is exit 2, not a pass", () => {
    // The failure mode this whole file exists to prevent: a pattern that matches nothing, reporting
    // an empty set as clean. Here the file parses as YAML-shaped text and simply has no jobs.
    withFixture({ "a.yml": "name: nothing\non:\n  push:\n" }, (dir) => {
      const read = run(dir)
      expect(read.code).toBe(2)
      expect(read.out).toContain("nothing was asserted about")
    })
  })

  test("a workflow with jobs but no action refs is exit 2 as well", () => {
    withFixture({ "a.yml": "name: no actions\njobs:\n  x:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n      - run: |\n          set -euo pipefail\n          echo a\n          echo b\n" }, (dir) => expect(run(dir).code).toBe(2))
  })
})
