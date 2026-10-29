import { afterAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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

describe("the OIDC probe cannot reach a consumer-facing dist tag", () => {
  // `verify-trusted-publisher` stages a probe version because staging the real one would be refused
  // as already-published. It then CANNOT clean up: rejecting a stage needs interactive auth, which
  // OIDC deliberately does not carry, so the job prints `npm stage <verb> <id>` for a human. That
  // makes the probe's safety a property of its own manifest, not of the step after it — and
  // `publish.ts` writes `publishConfig.tag = "latest"` for any released version, which is exactly
  // the field npm reads when a human approves the stage. One mistyped approve would repoint
  // `latest` at a probe build, and every `npm install -g glasspane-harness` since then resolves it.
  const releaseYml = () => Bun.file(path.join(REAL_ROOT, ".github/workflows/release.yml")).text()

  test("the probe rewrite moves the dist tag, not only the version", async () => {
    const text = await releaseYml()
    const probe = text.slice(text.indexOf("-oidc-probe."))
    expect(probe).toContain('tag: "oidc-probe"')
    expect(probe.slice(0, 600)).toContain("publishConfig")
  })

  test("and the rewrite still names the probe version it is staging", async () => {
    // Without this half, the assertion above could be satisfied by an unrelated `publishConfig`
    // edit somewhere else in the file. Both statements have to be in the SAME rewrite block.
    const text = await releaseYml()
    const start = text.indexOf("-oidc-probe.")
    const block = text.slice(start, start + 700)
    expect(block).toContain("-oidc-probe.")
    expect(block).toContain('tag: "oidc-probe"')
  })

  test("the job that prints the human remedy also prints what the probe is tagged to", async () => {
    const text = await releaseYml()
    expect(text).toContain("npm stage reject")
    expect(text).toContain("probe dist-tag")
  })
})

describe("the scan covers composite actions, not only workflows", () => {
  // `.github/actions/*/action.yml` is `uses:`-d by every job in both workflows, including the ones
  // holding `id-token: write` and the release signing key. Reading only `readdirSync(workflows)` left
  // that file unasked about its own nested `uses:` and its shell gates — and on the day this rule was
  // added it found three un-gated multi-statement bodies in the two real actions immediately, which
  // is what an unscanned file looks like.
  const ACTION = `name: setup-x
description: x
runs:
  using: composite
  steps:
    - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
    - name: two statements, gated
      shell: bash
      run: |
        set -euo pipefail
        echo a
        echo b
`

  function withActionTree(action: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), "gp-workflow-actions-"))
    mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true })
    mkdirSync(path.join(dir, ".github", "actions", "setup-x"), { recursive: true })
    writeFileSync(path.join(dir, ".github", "workflows", "a.yml"), CLEAN)
    writeFileSync(path.join(dir, ".github", "actions", "setup-x", "action.yml"), action)
    return dir
  }

  test("an unpinned action inside a composite action is named", () => {
    const dir = withActionTree(ACTION.replace("actions/checkout@11d5960a326750d5838078e36cf38b85af677262", "actions/checkout@v4"))
    dirs.push(dir)
    const read = run(dir)
    expect(read.code).toBe(1)
    expect(read.out).toContain("setup-x/action.yml")
    expect(read.out).toContain("40-hex commit SHA")
  })

  test("and an un-gated multi-statement body there is named too", () => {
    const dir = withActionTree(ACTION.replace("        set -euo pipefail\n", ""))
    dirs.push(dir)
    const read = run(dir)
    expect(read.code).toBe(1)
    expect(read.out).toContain("setup-x/action.yml")
    expect(read.out).toContain("never declares -e/-u/pipefail")
  })

  test("the clean action contributes refs and bodies, so a scan that skipped it would show", () => {
    const dir = withActionTree(ACTION)
    dirs.push(dir)
    const read = run(dir)
    expect(read.code).toBe(0)
    // CLEAN alone measures 2 refs / 2 bodies in 1 file; the composite adds 1 ref and 1 body, so the
    // three numbers below are what proves the action was opened at all. Without it: 1 file, 2 refs,
    // 2 bodies — and "no problem reported" would mean nothing.
    expect(read.totals?.files).toBe(2)
    expect(read.totals?.refs).toBe(3)
    expect(read.totals?.bodies).toBe(3)
  })

  test("the real tree is read through both roots", () => {
    const stdout = execFileSync("node", [GATE, "--json"], { cwd: REAL_ROOT, encoding: "utf8" })
    const read = JSON.parse(stdout) as { totals: Record<string, number> }
    // 2 workflows + 2 composite actions, and the action refs are now part of the pinned count.
    expect(read.totals.files).toBeGreaterThanOrEqual(4)
    expect(read.totals.refs).toBeGreaterThanOrEqual(23)
  })
})

describe("a flag this tool has no mode for is refused, not ignored", () => {
  // The gate is pointed at the REAL tree here, not a fixture: the failure this rule exists for is
  // "the command printed the clean line", and that line only exists when there is a tree to call clean.
  const at = (flags: string[]) => {
    try {
      return { code: 0, stdout: execFileSync("node", [GATE, ...flags], { cwd: REAL_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "" }
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string }
      return { code: e.status ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }
    }
  }

  test("--self-test exits 2 instead of printing the clean line", () => {
    const res = at(["--self-test"])
    expect(res.code).toBe(2)
    expect(res.stderr).toContain("unknown flag")
    expect(`${res.stdout}${res.stderr}`).not.toContain("clean")
  })

  test("while the real modes still work on the real tree", () => {
    expect(at(["--json"]).code).toBe(0)
    expect(at([]).code).toBe(0)
    expect(at(["--list"]).code).toBe(0)
  })

  test("--dir still consumes its argument and is not called a stray flag", () => {
    const res = at(["--dir", REAL_ROOT])
    expect(res.code).toBe(0)
  })
})

describe("the two halves of the signing contract name the same key", () => {
  // `scripts/install.sh` embeds an armored public key AND a `GLASSPANE_HARNESS_SIGNING_FPR` constant,
  // and refuses a `VALIDSIG` from any other fingerprint. `release.yml`'s signing job imports whatever
  // `GPG_PRIVATE_KEY` the `release` environment holds and never compared it to either. So a key
  // rotation that updates the secret and not the script produces signed releases the installer refuses
  // — and the check had to read the constant out of the script rather than duplicate it, because a
  // second copy in the workflow is a second thing that can silently go stale.
  test("the signing job compares the imported key against the installer's constant", async () => {
    const release = await Bun.file(path.join(REAL_ROOT, ".github/workflows/release.yml")).text()
    const installer = await Bun.file(path.join(REAL_ROOT, "scripts/install.sh")).text()
    expect(installer).toContain("GLASSPANE_HARNESS_SIGNING_FPR=")
    expect(release).toContain("GLASSPANE_HARNESS_SIGNING_FPR")
    expect(release).toContain("scripts/install.sh")
    // A missing constant is a refusal, not a skipped comparison.
    expect(release).toContain("could not read GLASSPANE_HARNESS_SIGNING_FPR")
  })

  test("and a mismatch exits 1 instead of signing anyway", async () => {
    const release = await Bun.file(path.join(REAL_ROOT, ".github/workflows/release.yml")).text()
    const anchor = release.indexOf("signing key fingerprint matches")
    expect(anchor).toBeGreaterThan(0)
    // The import, the comparison and the refusal all sit between the key import and the sign loop.
    const signLoop = release.indexOf("--detach-sign --armor")
    expect(signLoop).toBeGreaterThan(anchor)
    expect(release.slice(anchor - 3000, anchor)).toContain("--batch --yes --import")
  })
})

describe("upstream's dev-only mutators stay unwired in this fork", () => {
  // `script/beta.ts` (`git push origin beta --force --no-verify`) and `script/version.ts`
  // (`gh release create` with no `--repo`) are upstream's own release tooling, byte-identical to the
  // pin. They are not this product's release path and this fork does not have a `beta` branch, so the
  // only honest posture is "nothing in our lanes calls them" — asserted, because a file that is inert
  // today is one `package.json` script away from being reachable, and `--no-verify` in a force-push is
  // precisely the thing this repository's hooks exist to catch.
  test("no workflow, manifest script or publish lane references them", async () => {
    // Read from the tree rather than asserted from memory: if either file is ever edited, it stops
    // being "inert upstream tooling" and becomes ours to gate.
    const sources: Record<string, string> = {
      "ci.yml": await Bun.file(path.join(REAL_ROOT, ".github/workflows/ci.yml")).text(),
      "release.yml": await Bun.file(path.join(REAL_ROOT, ".github/workflows/release.yml")).text(),
      "root package.json": await Bun.file(path.join(REAL_ROOT, "package.json")).text(),
      "opencode package.json": await Bun.file(path.join(REAL_ROOT, "packages/opencode/package.json")).text(),
      "opencode publish.ts": await Bun.file(path.join(REAL_ROOT, "packages/opencode/script/publish.ts")).text(),
    }
    for (const [name, text] of Object.entries(sources)) {
      if (text.includes("script/beta.ts") || text.includes("script/version.ts")) {
        throw new Error(`${name} references an upstream dev-only mutator (script/beta.ts force-pushes --no-verify; script/version.ts runs gh release create with no --repo) — that file is not this product's release path`)
      }
    }
  })

  test("and both files are present and byte-identical to the pin", () => {
    for (const rel of ["script/beta.ts", "script/version.ts"]) {
      expect(existsSync(path.join(REAL_ROOT, rel))).toBe(true)
    }
    const listed = execFileSync("git", ["-C", path.join(REAL_ROOT, "../.."), "diff", "--name-only", "HEAD", "--", `harness/glasspane-harness/${"script/beta.ts"}`, `harness/glasspane-harness/script/version.ts`], { encoding: "utf8" })
    expect(listed.trim()).toBe("")
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
