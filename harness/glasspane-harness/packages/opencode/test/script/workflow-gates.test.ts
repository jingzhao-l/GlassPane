import { afterAll, describe, expect, test } from "bun:test"
import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
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
    // Counted from the tree instead of remembered from a past run. The old form was
    // `files >= 4` with the comment "2 workflows + 2 composite actions", and it went red the day an
    // unreferenced action was deleted — a rule about scan coverage reddening for a reason that had
    // nothing to do with coverage. Equality against what the directory actually holds still reddens if
    // the gate stops opening either root, and it says so in the numbers rather than in a stale total.
    const workflows = readdirSync(path.join(REAL_ROOT, ".github/workflows")).filter((name) => /\.(ya?ml)$/.test(name)).length
    const actionsRoot = path.join(REAL_ROOT, ".github/actions")
    const actions = existsSync(actionsRoot)
      ? readdirSync(actionsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length
      : 0
    expect(actions).toBeGreaterThan(0)
    expect(read.totals.files).toBe(workflows + actions)
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

  test("and both files are still in the tree, unedited by this lane", () => {
    // The first version of this assertion ran `git diff HEAD -- harness/glasspane-harness/script/…`
    // to prove the files are upstream's own bytes. That is a parent-repo path: this test file also
    // runs inside the published subtree (`REAL_ROOT` = the fork root, no `harness/` above it), where
    // the same command dies with "not a git repository". Content-vs-pin is already measured in the
    // parent by `fork-diff`, which is the right place for it; what this lane can assert in BOTH
    // layouts is that the inert files are present and untouched by anything here.
    for (const rel of ["script/beta.ts", "script/version.ts"]) {
      expect(existsSync(path.join(REAL_ROOT, rel))).toBe(true)
    }
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

/**
 * The two release-gate repairs of the 2026-11 lane, and the three findings the parent
 * `scripts/check-workflows.mjs` handed this file. Same posture as every case above: these are
 * fixed points on the workflow text, because the object each rule judges is a byte set the lane
 * either names or does not — "the verified archive is the published archive" and "the release goes
 * public only behind a verify round trip" are properties of THIS file's step ordering, and a test
 * that reads the real file is the only place they can be held after a sync.
 */
describe("the platform lane publishes the archive its pack gate read", () => {
  // The defect this replaces: the validate step ran `publish.ts --dry-run`, which packs with
  // `bun pm pack` (script/publish.ts:96) and validates THAT tarball, and the publish step then ran
  // `npm pack --silent` — overwriting the same `${pkg}-${ver}.tgz` with a different packer's
  // bytes — and published the replacement. Exec-bit / manifest / os-cpu then judged a file that no
  // longer existed at publish time.
  async function platformJob(): Promise<string> {
    const text = await Bun.file(path.join(REAL_ROOT, ".github/workflows/release.yml")).text()
    const start = text.indexOf("  publish-platform:")
    const end = text.indexOf("\n  publish-wrapper:", start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    return text.slice(start, end)
  }

  test("no npm pack sits between the pack gate and npm publish", async () => {
    const job = await platformJob()
    // The needle these assertions read, grepped before any mutation: the publish line names
    // "$tarball", and the only surviving `npm pack` in the job is the duplicate-version branch's
    // integrity REPORT (`npm pack --json`), which publishes nothing. Line shape, not substring:
    // the file's own prose names the dead command, and a gate that reddens on a comment gets
    // its prose deleted — the trade the parent check-workflows refuses in its pipefail rule.
    expect(job).toContain('npm publish "$tarball"')
    expect(job).not.toMatch(/^\s*npm pack\b/m)
    expect(job).toContain("publishing the validated archive itself")
  })

  test("the validate step anchors every archive it judged and the publish step refuses an unanchored or changed byte", async () => {
    const job = await platformJob()
    const gate = job.indexOf("publish.ts --dry-run")
    const anchor = job.indexOf(': > "$RUNNER_TEMP/validated-tarballs.sha256"')
    const publish = job.indexOf('npm publish "$tarball"')
    expect(gate).toBeGreaterThan(-1)
    expect(anchor).toBeGreaterThan(gate)
    expect(publish).toBeGreaterThan(anchor)
    // Both refusals are named: no record (an archive no gate read) and hash drift (bytes that
    // changed after the gate) each stop the lane with its own message.
    expect(job).toContain("carries no record in the validate step's anchor file")
    expect(job).toContain("changed between the pack gate and this publish")
  })

  test("the staged fallback stages the named archive, never the directory", async () => {
    // A stage is pre-publish bytes awaiting the owner's 2FA approval; approving a directory
    // re-pack would publish a third packer's output no gate in this file ever read.
    const job = await platformJob()
    expect(job).toContain('npm stage publish "$tarball"')
    expect(job).not.toContain("npm stage publish . ")
  })
})

describe("the release goes public only behind an installer-shaped verification", () => {
  // Before this repair, the strongest evidence between `checksums` and `gh release edit
  // --draft=false` was `[ -s x.asc ]` — "a file landed", never a `gpg --verify` round trip — and
  // `installer-selftest.sh` scripts gpg/curl as stubs, so no real verifier had ever been asked
  // about the bytes a public release serves.
  async function publishReleaseJob(): Promise<string> {
    const text = await Bun.file(path.join(REAL_ROOT, ".github/workflows/release.yml")).text()
    const start = text.indexOf("  publish-release:")
    const end = text.indexOf("\n  publish-gate:", start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    return text.slice(start, end)
  }

  test("the step that flips public visibility runs in the environment the rest of the chain does", async () => {
    // Every other irreversible step (`checksums`, `publish-platform`, `publish-wrapper`,
    // `verify-published`) is deployed through the `release` environment, so any protection rule an
    // owner attaches there bites them. `publish-release` — the one step whose entire effect is making
    // bytes publicly reachable — was not, which is exactly the asymmetry that turns a protection rule
    // into a decoration. Measured 2026-11-03: `gh api repos/.../environments/release` answers
    // `protection_rules: []`, so this buys no behaviour today; it buys the rule a tomorrow can add.
    const job = await publishReleaseJob()
    expect(job).toContain("environment: release")
    // And it is not decoration in the other direction either: the environment line sits on the job,
    // not inside a step that could be deleted with the step.
    const header = job.slice(0, job.indexOf("steps:"))
    expect(header).toMatch(/^ {4}environment: release$/m)
  })

  test("the job's own key material never lands in the directory it scans for orphan sidecars", async () => {
    // v0.14.0 died here, and died correctly: the flip step wrote `signer.asc` next to the downloaded
    // assets, then its own two-directional check ("every `*.asc` must name a served file") read the key
    // it had just imported as evidence the release served a file called `signer`. The gate did its job;
    // the job shot itself, and the release stayed a draft. Key material now lives in a `mktemp -d` of
    // its own, and the scan set is untouched — this test pins both halves.
    const text = await Bun.file(path.join(REAL_ROOT, ".github/workflows/release.yml")).text()
    expect(text.match(/> "\$keys\/signer\.asc"/g)?.length).toBe(2)
    expect(text).not.toMatch(/> signer\.asc$/)
    expect(text.match(/import < "\$keys\/signer\.asc"/g)?.length).toBe(2)
    // The orphan scan itself must stay two-directional — a fix that quiets the scan is worse than the bug.
    const job = await publishReleaseJob()
    expect(job).toContain('for f in ./*.asc; do')
    expect(job).toContain("carries signature sidecars for files it does not serve")
  })

  test("a per-file gpg --verify round trip precedes the draft→public flip", async () => {
    const job = await publishReleaseJob()
    const verify = job.indexOf("gpg --batch --quiet --status-fd 2 --verify")
    const flip = job.indexOf("--draft=false")
    expect(verify).toBeGreaterThan(-1)
    expect(flip).toBeGreaterThan(verify)
    // The anchor is READ from scripts/install.sh, so the job must have the checkout before it.
    expect(job.indexOf("uses: actions/checkout")).toBeLessThan(verify)
    expect(job).toContain("$GITHUB_WORKSPACE/scripts/install.sh")
  })

  test("the judgement is the installer's own three conditions against the installer's named key", async () => {
    const job = await publishReleaseJob()
    expect(job).toContain("GOODSIG")
    expect(job).toContain("VALIDSIG")
    expect(job).toContain("GLASSPANE_HARNESS_SIGNING_FPR")
    expect(job).toContain("-----BEGIN PGP PUBLIC KEY BLOCK-----")
    expect(job).toContain("embedded block carries the named fingerprint")
  })

  test("nothing is best-effort: sidecar gaps both ways and a verify escape each refuse", async () => {
    const job = await publishReleaseJob()
    expect(job).toContain("would go public with assets that carry no signature sidecar")
    expect(job).toContain("signature sidecars for files it does not serve")
    // The manifest is re-checked against the served bytes before its signature is trusted.
    expect(job).toContain("sha256sum --strict --check SHA256SUMS.txt")
    // The exact shape the task forbids: a `|| true` riding the verify call would turn a bad
    // signature into a green step and a public release.
    expect(job).not.toMatch(/gpg [^\n]*--verify[^\n]*\|\| true/)
  })
})

describe("the three findings the parent gate handed this file are closed here", () => {
  test("one queue per ref, and no in-flight publish is ever cancelled", async () => {
    const text = await Bun.file(path.join(REAL_ROOT, ".github/workflows/release.yml")).text()
    const top = text.slice(0, text.indexOf("jobs:"))
    expect(top).toContain("concurrency:")
    expect(top).toContain("group: release-${{ github.ref_name }}")
    expect(top).toContain("cancel-in-progress: false")
    // `true` on an irreversible lane is the half-release with the sign flipped.
    expect(top).not.toContain("cancel-in-progress: true")
  })

  test("the tag-peel consumers read from a here-string, so their first-match exit cannot cost the step 141", async () => {
    const text = await Bun.file(path.join(REAL_ROOT, ".github/workflows/release.yml")).text()
    // Piping `git ls-remote` output into `awk … exit` dies of EPIPE once the bytes pass the pipe
    // buffer; under pipefail the gate's status becomes 141 and the step aborts mid-judgement.
    expect(text).not.toContain(`printf '%s\\n' "$LS" | awk`)
    expect(text.match(/\$2==r\{print \$1; exit\}' <<<"\$LS"/g)?.length).toBe(2)
  })

  test("the manifests block declares its own shell gate before node runs", async () => {
    const text = await Bun.file(path.join(REAL_ROOT, ".github/workflows/release.yml")).text()
    const start = text.indexOf("The tag and BOTH version manifests must name the same version")
    const body = text.slice(start, text.indexOf("node -e '", start))
    expect(start).toBeGreaterThan(-1)
    expect(body).toContain("set -euo pipefail")
  })
})

describe("the tree anchor is a measured judgement, not an inline equality", () => {
  test("the step delegates to script/tree-anchor.mjs instead of comparing two hashes", async () => {
    const text = await Bun.file(path.join(REAL_ROOT, ".github/workflows/release.yml")).text()
    const start = text.indexOf("      - name: The released tree must equal trunk's fork subtree")
    expect(start).toBeGreaterThan(-1)
    const body = text.slice(start, text.indexOf("\n      - ", start + 10))
    expect(body).toContain("node script/tree-anchor.mjs")
    // The shape that made a stalled release unfinishable: byte equality between the tag's tree and
    // trunk's subtree, which every ledger commit after the tag breaks by construction.
    expect(body).not.toContain('[ "$trunk" = "$own" ]')
  })
})

/**
 * The identity half of the tag. Everything else in this lane anchors CONTENT (version equals the tag,
 * the tree equals trunk, CI went green for that commit); nothing asked who raised the ref, while the
 * file's own prose claims a published tag is never moved.
 *
 * Verified against real bytes on 2026-11-03, not only against the text below: the same body was cut out
 * of this file and run against three tags in a live repository — a lightweight one (`objecttype=commit`)
 * refused, an annotated unsigned one refused for carrying no armored block, and one signed with the
 * pinned key accepted. That last case also proves the comparison reads the PRIMARY fingerprint: the
 * `VALIDSIG` status line's first field is what `scripts/install.sh` pins.
 */
describe("a tag this lane cannot attribute is not this product's tag", () => {
  async function tagIdentityBody(): Promise<string> {
    const text = await Bun.file(path.join(REAL_ROOT, ".github/workflows/release.yml")).text()
    const start = text.indexOf("      - name: The tag itself must be a signed tag made by the key the installer names")
    expect(start).toBeGreaterThan(-1)
    // This is the last step of its job, so the slice has to stop at the next job header too — otherwise
    // it swallows `create-release` and every count below measures somebody else's bytes.
    const ends = [text.indexOf("\n      - name: ", start + 10), text.indexOf("\n  create-release:", start)].filter((i) => i > start)
    return text.slice(start, Math.min(...ends))
  }

  test("the key and the fingerprint are read from the installer, never hardcoded here", async () => {
    const body = await tagIdentityBody()
    expect(body).toContain('sed -n \'s/^GLASSPANE_HARNESS_SIGNING_FPR="\\(.*\\)"/\\1/p\'')
    expect(body).toContain("/-----BEGIN PGP PUBLIC KEY BLOCK-----/")
    // A fingerprint typed into the workflow is a second truth that outlives the rotation.
    expect(body).not.toMatch(/[0-9A-F]{40}/)
  })

  test("lightweight, unsigned and unverifiable each stop the lane, and only the pinned key passes", async () => {
    const body = await tagIdentityBody()
    expect(body).toContain('[ "$OBJECT_TYPE" != "tag" ]')
    expect(body).toContain("[ ! -s tag.sig ]")
    expect(body).toContain("GOODSIG")
    expect(body).toContain("VALIDSIG")
    // Each refusal is an exit, not a warning: a gate whose "refuse" branch falls through is a log line.
    for (const refusal of ["is not an annotated tag", "no armored signature block", "does not call the signature", "not by the fingerprint scripts/install.sh pins"]) {
      const at = body.indexOf(refusal)
      expect(at).toBeGreaterThan(-1)
      expect(body.slice(at, at + 700)).toContain("exit 1")
    }
  })

  test("the judgement has no escape hatch", async () => {
    const body = await tagIdentityBody()
    // `|| true` is legitimate on the STATUS capture (gpg exits non-zero on a bad signature and the
    // status lines are what is being read) — nowhere else.
    expect(body.match(/\|\| true/g)?.length).toBe(1)
    expect(body).not.toMatch(/grep .* \|\| echo/)
    expect(body).not.toContain("continue")
  })
})

/**
 * The gate that the v0.13.0 half-shipping walked straight through.
 *
 * `publish-gate` proved the dispatched ref was the tag; nothing proved the tag had a release. Both
 * publishing chains were internally consistent, and the inconsistency lived BETWEEN them — npm got
 * `glasspane-harness-darwin-x64@0.13.0` while `gh release view v0.13.0` answered "release not found".
 *
 * So this is not a text-matching test: the step's own bash body is cut out of the real workflow and
 * RUN, with a fake `gh` on PATH answering the Releases API. A refusal that cannot be made to happen is
 * not a gate, whatever the file says.
 */
describe("the npm leg refuses a version whose release is not there", () => {
  const root = mkdtempSync(path.join(tmpdir(), "publish-gate-"))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  async function stepBody(): Promise<string> {
    const text = await Bun.file(path.join(REAL_ROOT, ".github/workflows/release.yml")).text()
    const marker = "      - name: The tag must already have a public release with every asset it names"
    const start = text.indexOf(marker)
    expect(start).toBeGreaterThan(-1)
    const from = text.indexOf("        run: |\n", start)
    expect(from).toBeGreaterThan(start)
    // This step is the LAST one in its job, so the body ends either at the next `- name:` step or at
    // the next job header — whichever comes first. Taking only the first pattern runs the slice past
    // the end of the job and hands bash the next job's steps.
    const ends = [text.indexOf("\n      - ", from), text.indexOf("\n  publish-platform:", from)].filter((i) => i > from)
    const end = Math.min(...ends)
    expect(end).toBeGreaterThan(from)
    const lines = text.slice(from + "        run: |\n".length, end).split("\n")
    return `${lines.map((l) => (l.startsWith("          ") ? l.slice(10) : l)).join("\n")}\n`
  }

  /**
   * @param answers what the fake `gh` does per API path; `null` means "the call fails" (an outage, not
   * a missing release), and a missing key means the endpoint was never answered.
   */
  async function ask(answers: Record<string, string | null>, name: string) {
    const dir = path.join(root, name)
    mkdirSync(path.join(dir, "bin"), { recursive: true })
    writeFileSync(
      path.join(dir, "product.json"),
      JSON.stringify({ name: "glasspane-harness", version: "9.9.9", platformTargets: [{ os: "darwin", arch: "arm64" }, { os: "darwin", arch: "x64" }] }),
    )
    const script = await stepBody()
    writeFileSync(path.join(dir, "step.sh"), script)
    const lines = ["#!/bin/sh", 'path="$2"']
    for (const [api, answer] of Object.entries(answers)) lines.push(`if [ "$path" = ${JSON.stringify(api)} ]; then`, answer === null ? "  exit 1" : `  printf '%s' ${JSON.stringify(answer)}`, "  exit 0", "fi")
    lines.push("echo \"the fake gh was asked about an endpoint it has no answer for: $path\" >&2", "exit 4")
    writeFileSync(path.join(dir, "bin", "gh"), `${lines.join("\n")}\n`)
    chmodSync(path.join(dir, "bin", "gh"), 0o755)
    const got = spawnSync("bash", [path.join(dir, "step.sh")], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PATH: `${path.join(dir, "bin")}:${process.env.PATH ?? ""}`, GH_TOKEN: "test-token", GITHUB_REPOSITORY: "o/r" },
    })
    return { code: got.status, text: `${got.stdout ?? ""}${got.stderr ?? ""}` }
  }

  const RELEASE = "repos/o/r/releases/tags/v9.9.9"
  const complete = JSON.stringify({
    draft: false,
    assets: [
      { name: "glasspane-harness-darwin-arm64.zip" },
      { name: "glasspane-harness-darwin-arm64.zip.asc" },
      { name: "glasspane-harness-darwin-x64.zip" },
      { name: "glasspane-harness-darwin-x64.zip.asc" },
      { name: "SHA256SUMS.txt" },
      { name: "SHA256SUMS.txt.asc" },
    ],
  })

  test("a public release carrying the whole matrix lets the lane through", async () => {
    const got = await ask({ "repos/o/r": "42", [RELEASE]: complete }, "ok")
    expect(got.code).toBe(0)
    expect(got.text).toContain("cross-chain anchor held")
  })

  test("no release behind the tag is a refusal, which is what v0.13.0 needed", async () => {
    const got = await ask({ "repos/o/r": "42", [RELEASE]: null }, "absent")
    expect(got.code).toBe(1)
    expect(got.text).toContain("has no GitHub Release")
    expect(got.text).toContain("gh run rerun")
  })

  test("a draft release is a refusal: the assets exist but nobody can fetch them", async () => {
    const got = await ask({ "repos/o/r": "42", [RELEASE]: JSON.stringify({ draft: true, assets: [] }) }, "draft")
    expect(got.code).toBe(1)
    expect(got.text).toContain("still a draft")
  })

  test("a public release missing one leg of the matrix is refused by name", async () => {
    const partial = JSON.stringify({
      draft: false,
      assets: [
        { name: "glasspane-harness-darwin-arm64.zip" },
        { name: "glasspane-harness-darwin-arm64.zip.asc" },
        { name: "SHA256SUMS.txt" },
        { name: "SHA256SUMS.txt.asc" },
      ],
    })
    const got = await ask({ "repos/o/r": "42", [RELEASE]: partial }, "partial")
    expect(got.code).toBe(1)
    expect(got.text).toContain("Missing:glasspane-harness-darwin-x64.zip glasspane-harness-darwin-x64.zip.asc")
  })

  test("an unreachable API is refused as unknowable, never read as a missing release", async () => {
    const got = await ask({ "repos/o/r": null }, "outage")
    expect(got.code).toBe(1)
    expect(got.text).toContain("could not be reached")
    expect(got.text).not.toContain("has no GitHub Release")
  })
})
