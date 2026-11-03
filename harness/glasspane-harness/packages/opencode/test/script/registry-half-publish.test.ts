import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * Fixed points for the pre-flight that asks the registry about the WHOLE package set before any
 * leg of an npm publish becomes irreversible.
 *
 * The incident is measured, not hypothetical. Run 41219619435 (2026-10-31T16:38:25Z) published
 * `glasspane-harness-darwin-x64@0.13.0` with provenance, its `npm darwin-arm64` leg was cancelled,
 * and the wrapper leg never started. Nothing that runs BEFORE the next dispatch could see that:
 * `gh release view v0.13.0` answered not-found and `npm view glasspane-harness@0.13.0` answered 404
 * while the x64 package was live. The three packages publish from three jobs, so a cancel or a
 * single-leg failure leaves a version part-published, and the next dispatch of the same number
 * walks into it blind — two legs get E409, one publishes, and the wrapper ships naming bytes no
 * run built.
 *
 * This is not a text-matching test. The step's own bash body is cut out of the real workflow and
 * RUN against a fake `npm` on PATH, because a refusal nobody can make happen is not a gate. The
 * fake answers per package, which is the only way to stage a partial set: no registry state is
 * touched, and none could be from here.
 */
const REAL_ROOT = path.join(import.meta.dir, "../../../..")
const MARKER = "      - name: The registry must not already hold this version as a partial set"
const VERSION = "9.9.9"

const root = mkdtempSync(path.join(tmpdir(), "half-publish-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** The step body, dedented exactly as the lane runs it. */
async function stepBody(): Promise<string> {
  const text = await Bun.file(path.join(REAL_ROOT, ".github/workflows/release.yml")).text()
  const start = text.indexOf(MARKER)
  expect(start).toBeGreaterThan(-1)
  const from = text.indexOf("        run: |\n", start)
  expect(from).toBeGreaterThan(start)
  // The step is the last one in `publish-gate`, so its body ends at the next job header; taking the
  // first `\n      - ` after it would hand bash the following job's steps.
  const end = text.indexOf("\n  publish-platform:", from)
  expect(end).toBeGreaterThan(from)
  const lines = text.slice(from + "        run: |\n".length, end).split("\n")
  return `${lines.map((l) => (l.startsWith("          ") ? l.slice(10) : l)).join("\n")}\n`
}

const product = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: "glasspane-harness",
    version: VERSION,
    registry: "https://registry.npmjs.org",
    platformTargets: [
      { os: "darwin", arch: "arm64" },
      { os: "darwin", arch: "x64" },
    ],
    ...over,
  })

/**
 * @param answers per package name: a version string the registry really knows, `null` for its own
 *   E404 "not published", `"outage"` for a transport failure (non-zero, no E404 in the message),
 *   `"silent"` for exit 0 that names no version, and `"stale"` for a version other than the one
 *   asked about. A package missing from the map means the step never asked about it.
 */
async function ask(answers: Record<string, string | null>, name: string, raw = product()) {
  const dir = path.join(root, name)
  mkdirSync(path.join(dir, "bin"), { recursive: true })
  writeFileSync(path.join(dir, "product.json"), raw)
  writeFileSync(path.join(dir, "step.sh"), await stepBody())
  const lines = [
    "#!/bin/sh",
    // A second way to ask the registry would silently dodge this fixture, so only `view` passes.
    'if [ "$1" != view ]; then echo "the fake npm was asked to do $*, not view" >&2; exit 9; fi',
    'spec="$2"',
    'pkg="${spec%@*}"',
    'ver="${spec##*@}"',
    'if [ -z "$ver" ]; then echo "the step asked about $spec, which names no version" >&2; exit 9; fi',
  ]
  for (const [pkg, answer] of Object.entries(answers)) {
    lines.push(`if [ "$pkg" = ${JSON.stringify(pkg)} ]; then`)
    if (answer === null) {
      lines.push('  echo "npm error code E404" >&2', '  echo "npm error 404 Not Found - GET https://registry.npmjs.org" >&2', "  exit 1")
    } else if (answer === "outage") {
      lines.push('  echo "npm error code EAI_AGAIN registry.npmjs.org" >&2', "  exit 1")
    } else if (answer === "silent") {
      lines.push("  exit 0")
    } else {
      lines.push(`  echo ${JSON.stringify(answer)}`, "  exit 0")
    }
    lines.push("fi")
  }
  lines.push('echo "the fake npm had no answer for $pkg" >&2', "exit 8")
  writeFileSync(path.join(dir, "bin", "npm"), `${lines.join("\n")}\n`)
  chmodSync(path.join(dir, "bin", "npm"), 0o755)
  const got = spawnSync("bash", [path.join(dir, "step.sh")], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${path.join(dir, "bin")}:${process.env.PATH ?? ""}` },
  })
  return { code: got.status, text: `${got.stdout ?? ""}${got.stderr ?? ""}` }
}

const WRAPPER = "glasspane-harness"
const ARM = "glasspane-harness-darwin-arm64"
const X64 = "glasspane-harness-darwin-x64"
const all = (v: string | null) => ({ [WRAPPER]: v, [ARM]: v, [X64]: v })

describe("what the half-publish pre-flight lets through", () => {
  test("a version the registry knows nothing about is a clean publish", async () => {
    const got = await ask(all(null), "clean")
    expect(got.code).toBe(0)
    expect(got.text).toContain("a clean publish")
    expect(got.text).toContain(`${WRAPPER}@${VERSION}`)
  })

  test("the whole set already live passes, because the duplicate branch downstream absorbs it", async () => {
    // The E409 presence re-check in `publish-platform` is what makes re-dispatching a fully published
    // version safe. This gate must not also stop it, or the only honest repair for a complete version
    // becomes a needless new number.
    const got = await ask(all(VERSION), "complete")
    expect(got.code).toBe(0)
    expect(got.text).toContain("registry set at")
    expect(got.text).toContain("is complete")
  })
})

describe("what the half-publish pre-flight refuses", () => {
  test("the exact 0.13.0 shape: x64 live, arm64 and the wrapper absent", async () => {
    const got = await ask({ [X64]: VERSION, [ARM]: null, [WRAPPER]: null }, "partial-0-13-0")
    expect(got.code).toBe(1)
    expect(got.text).toContain("this version is half-published on the registry")
    expect(got.text).toContain(`present:${X64}@${VERSION}`)
    expect(got.text).toContain(`absent:${WRAPPER}@${VERSION} ${ARM}@${VERSION}`)
    expect(got.text).toContain("take a new number")
  })

  test("a missing leg among two published ones is refused just as loudly", async () => {
    const got = await ask({ [X64]: null, [ARM]: VERSION, [WRAPPER]: VERSION }, "partial-wrapper")
    expect(got.code).toBe(1)
    expect(got.text).toContain(`present:${WRAPPER}@${VERSION} ${ARM}@${VERSION}`)
    expect(got.text).toContain(`absent:${X64}@${VERSION}`)
  })

  test("a registry that could not be asked is never read as absent, and never licenses a publish", async () => {
    // The whole point of the three-way split. `2>/dev/null || true`, the form an earlier step in this
    // file uses, would fold this outage into an absence — and absence is the answer that says
    // "go ahead and publish".
    const got = await ask({ [X64]: "outage", [ARM]: null, [WRAPPER]: null }, "outage")
    expect(got.code).toBe(1)
    expect(got.text).toContain("could not be asked")
    expect(got.text).toContain("EAI_AGAIN")
    expect(got.text).not.toContain("a clean publish")
    expect(got.text).not.toContain("half-published")
  })

  test("an outage on one leg does not turn the other two into a verdict about this version", async () => {
    // Half the set answered 404 and the other half never answered: the partial-set branch must not be
    // taken on an unmeasured input, or the remedy printed is the wrong one.
    const got = await ask({ [X64]: VERSION, [ARM]: "outage", [WRAPPER]: null }, "outage-plus-partial")
    expect(got.code).toBe(1)
    expect(got.text).toContain("could not be asked")
    expect(got.text).not.toContain("half-published")
  })

  test("an exit-0 read that names no version is trouble, not presence and not absence", async () => {
    const got = await ask({ [X64]: "silent", [ARM]: null, [WRAPPER]: null }, "silent")
    expect(got.code).toBe(1)
    expect(got.text).toContain("npm exited 0 and named no version")
  })

  test("a replica answering a different version is trouble, never counted as holding this one", async () => {
    const got = await ask({ [X64]: "0.0.1", [ARM]: null, [WRAPPER]: null }, "stale")
    expect(got.code).toBe(1)
    expect(got.text).toContain("named 0.0.1 for a question about")
  })

  test("a package set that ends up empty is a broken read, not a release with no npm legs", async () => {
    // A blank `name` still occupies a line of node's output, so the raw string is non-empty while the
    // set is empty and every branch below would report "clean". `asked === 0` is the guard that holds.
    const got = await ask({}, "empty-set", product({ name: "", platformTargets: [] }))
    expect(got.code).toBe(1)
    expect(got.text).toContain("named no package to ask the registry about")
    expect(got.text).not.toContain("a clean publish")
  })

  test("a product.json that names no version is refused before any question reaches the registry", async () => {
    const got = await ask(all(null), "no-version", product({ version: "" }))
    expect(got.code).toBe(1)
    expect(got.text).toContain("does not name a version")
    expect(got.text).not.toContain("a clean publish")
  })
})

describe("the pre-flight is wired where it can actually stop the lane", () => {
  test("it sits in publish-gate, the job both irreversible legs depend on", async () => {
    const text = await Bun.file(path.join(REAL_ROOT, ".github/workflows/release.yml")).text()
    const gate = text.indexOf("\n  publish-gate:")
    const platform = text.indexOf("\n  publish-platform:")
    expect(gate).toBeGreaterThan(-1)
    expect(platform).toBeGreaterThan(gate)
    const at = text.indexOf(MARKER)
    expect(at).toBeGreaterThan(gate)
    expect(at).toBeLessThan(platform)
    // Both legs gate on it: `needs: publish-gate` alone is not enough, because an explicit `if:`
    // expression runs even when a dependency failed. `success() &&` is what makes the edge bite.
    const after = text.slice(platform)
    expect(after).toContain("needs: publish-gate")
    expect(after.match(/if: success\(\) && github.event_name == 'workflow_dispatch' && inputs.publish_npm == true && inputs.confirm == true/g)?.length).toBeGreaterThanOrEqual(2)
  })

  test("it asks the registry with stderr kept, because an outage and an absence are different answers", async () => {
    const body = await stepBody()
    expect(body).toContain('2>"$err"')
    expect(body).toContain("code E404|404 Not Found")
    expect(body).not.toMatch(/npm view[^\n]*2>\/dev\/null/)
    // No best-effort anywhere in the judgement: a `|| true` here reads an outage as "not published".
    expect(body).not.toContain("|| true")
  })

  test("it reads product.json once, so the version and the set cannot disagree inside one step", async () => {
    const body = await stepBody()
    // Three `node` calls were three process starts and three parses of one file for one question;
    // on this machine node starts in ~0.7s, which is the difference between this battery fitting its
    // budget and not.
    expect(body.match(/\bnode -/g)?.length).toBe(1)
    expect(body).toContain('require("./product.json")')
    // A missing `version` field makes node print the literal "undefined", which is a string that
    // would otherwise sail through an `-z` test and be asked about as if it were a release.
    expect(body).toContain('""|undefined)')
  })

  test("the classification is the one the lane already uses, not a second truth", async () => {
    // packages/opencode/script/registry-readiness.ts `npmAnswer` is the module the publish legs use;
    // the same E404 predicate has to decide "absent" here or the two could disagree about one answer.
    const module = await Bun.file(path.join(REAL_ROOT, "packages/opencode/script/registry-readiness.ts")).text()
    const body = await stepBody()
    const predicate = /code E404\|404 Not Found/
    expect(module).toMatch(predicate)
    expect(body).toMatch(predicate)
  })
})
