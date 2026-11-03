import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * Fixed points for `script/tree-anchor.mjs`, the step that refuses to release a tree trunk does not
 * vouch for.
 *
 * The script is driven as a subprocess against two REAL throwaway repositories rather than by feeding
 * the judge a invented array, because the whole judgement hangs on what git reports: the status letter
 * of each differing path and the direction of the line counts. A fixture that guesses those is how a
 * release gate keeps its job while answering about a world that does not exist.
 *
 * The tolerated direction is the one that actually happens. `SYNCLOG.md` is newest-first, so the next
 * session's record is inserted at the TOP — measured on v0.13.0, where trunk holds the tagged ledger
 * plus 49 lines added at line 237, and the byte-equality check the workflow used to run inline refused
 * it. That refusal made a published tag impossible to finish (`create-release`, `binaries`, `checksums`
 * only ever run on the tag push), which is the same thing as telling the operator to move a signed tag.
 */

const root = mkdtempSync(path.join(tmpdir(), "tree-anchor-"))
const GATE = path.join(import.meta.dir, "../../../../script/tree-anchor.mjs")

afterAll(() => rmSync(root, { recursive: true, force: true }))

let n = 0

function git(cwd: string, args: string[]) {
  const got = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  })
  if (got.status !== 0) throw new Error(`git ${args.join(" ")} in ${cwd} failed: ${got.stderr}`)
  return String(got.stdout ?? "")
}

/**
 * `trunk` is the parent repository, whose subtree under `harness/glasspane-harness` is what the split
 * repo carries; `release` is the split repository, whose root IS that subtree. The fixture keeps the
 * same shape with `subtree = "."` in the release repo and `subtree = "harness/glasspane-harness"` in
 * trunk, so the prefix handling is exercised too.
 */
function fixture(files: Record<string, string>) {
  const id = `f${++n}`
  const trunk = path.join(root, `${id}-trunk`)
  const release = path.join(root, `${id}-release`)
  mkdirSync(path.join(trunk, "harness", "glasspane-harness"), { recursive: true })
  mkdirSync(release, { recursive: true })
  for (const [file, text] of Object.entries(files)) {
    for (const base of [path.join(trunk, "harness", "glasspane-harness"), release]) {
      mkdirSync(path.join(base, path.dirname(file)), { recursive: true })
      writeFileSync(path.join(base, file), text)
    }
  }
  git(trunk, ["init", "-q", ".", "-b", "main"])
  git(trunk, ["add", "-A"])
  git(trunk, ["commit", "-q", "-m", "trunk base"])
  git(release, ["init", "-q", ".", "-b", "main"])
  git(release, ["add", "-A"])
  git(release, ["commit", "-q", "-m", "the tagged tree"])
  return { trunk, release, writeTrunk(file: string, text: string) { writeFileSync(path.join(trunk, "harness", "glasspane-harness", file), text) }, commitTrunk() { git(trunk, ["add", "-A"]); git(trunk, ["commit", "-q", "-m", "trunk moves on"]) } }
}

function ask(release: string, trunk: string, extra: Record<string, string> = {}) {
  const got = spawnSync("node", [GATE], {
    cwd: release,
    encoding: "utf8",
    env: {
      ...process.env,
      TRUNK_URL: trunk,
      TRUNK_REF: "main",
      TRUNK_PREFIX: "harness/glasspane-harness",
      ...extra,
    },
  })
  return { code: got.status, text: `${got.stdout ?? ""}${got.stderr ?? ""}` }
}

const BASE = { "SYNCLOG.md": "## newest\nold line\n", "CHANGELOG.md": "## [Unreleased]\n\n## 1.0.0\nfixed\n", "product.json": '{"version":"1.0.0"}\n', "src/a.ts": "export const a = 1\n" }

describe("tree-anchor: the trees that may be released", () => {
  test("a tagged tree identical to trunk's subtree passes without an exception", () => {
    const f = fixture(BASE)
    const got = ask(f.release, f.trunk)
    expect(got.code).toBe(0)
    expect(got.text).toContain("anchor OK")
    expect(got.text).not.toContain("△")
  })

  test("trunk holding the tagged ledger plus lines added at the TOP is tolerated and counted", () => {
    const f = fixture(BASE)
    f.writeTrunk("SYNCLOG.md", "## newer session\nappended one\nappended two\n## newest\nold line\n")
    f.commitTrunk()
    const got = ask(f.release, f.trunk)
    expect(got.code).toBe(0)
    expect(got.text).toContain("△")
    expect(got.text).toContain("3 added line(s)")
    expect(got.text).toContain("nothing the tag carries that trunk lacks")
  })

  test("both ledger files lagging sums the lines it names", () => {
    const f = fixture(BASE)
    f.writeTrunk("SYNCLOG.md", "## newer\nx\n## newest\nold line\n")
    f.writeTrunk("CHANGELOG.md", "## 1.1.0\ny\n## [Unreleased]\n\n## 1.0.0\nfixed\n")
    f.commitTrunk()
    const got = ask(f.release, f.trunk)
    expect(got.code).toBe(0)
    expect(got.text).toContain("4 added line(s)")
  })
})

describe("tree-anchor: the trees that may not", () => {
  test("any non-ledger difference is refused by name", () => {
    const f = fixture(BASE)
    f.writeTrunk("src/a.ts", "export const a = 2\n")
    f.commitTrunk()
    const got = ask(f.release, f.trunk)
    expect(got.code).toBe(1)
    expect(got.text).toContain("1 non-ledger path(s) differ")
    expect(got.text).toContain("src/a.ts")
  })

  test("a dependency bump hidden behind a ledger-only claim is refused", () => {
    const f = fixture(BASE)
    f.writeTrunk("product.json", '{"version":"1.0.1"}\n')
    f.writeTrunk("SYNCLOG.md", "## newest\nold line\npatched a dependency\n")
    f.commitTrunk()
    const got = ask(f.release, f.trunk)
    expect(got.code).toBe(1)
    expect(got.text).toContain("product.json")
    expect(got.text).not.toContain("△")
  })

  test("a ledger the TAG reworded is refused: the exemption is measured, not named", () => {
    const f = fixture(BASE)
    // trunk's copy is the tagged copy minus a line the tag carried and plus one new line, so the
    // tagged tree holds ledger bytes trunk does not have.
    writeFileSync(path.join(f.release, "SYNCLOG.md"), "## newest\nold line\nthe tag says something trunk does not\n")
    git(f.release, ["add", "-A"])
    git(f.release, ["commit", "-q", "-m", "the tag carries text trunk lacks"])
    f.writeTrunk("SYNCLOG.md", "## newest\nold line\nand trunk added this\n")
    f.commitTrunk()
    const got = ask(f.release, f.trunk)
    expect(got.code).toBe(1)
    expect(got.text).toContain("not in the one tolerated direction")
  })

  test("a whole ledger file the tag lacks is refused, not read as appended lines", () => {
    const f = fixture(BASE)
    rmSync(path.join(f.release, "CHANGELOG.md"))
    git(f.release, ["add", "-A"])
    git(f.release, ["commit", "-q", "-m", "the tag dropped the changelog"])
    const got = ask(f.release, f.trunk)
    expect(got.code).toBe(1)
    expect(got.text).toContain("CHANGELOG.md")
  })

  test("a ledger file the tag ADDED is refused", () => {
    const f = fixture({ ...BASE })
    rmSync(path.join(f.trunk, "harness", "glasspane-harness", "SYNCLOG.md"))
    git(f.trunk, ["add", "-A"])
    git(f.trunk, ["commit", "-q", "-m", "trunk has no synclog at all"])
    const got = ask(f.release, f.trunk)
    expect(got.code).toBe(1)
    expect(got.text).toContain("SYNCLOG.md")
  })
})

describe("tree-anchor: refusing to answer is not answering", () => {
  test("no TRUNK_URL", () => {
    const f = fixture(BASE)
    const got = ask(f.release, f.trunk, { TRUNK_URL: "" })
    expect(got.code).toBe(1)
    expect(got.text).toContain("an unmeasured anchor is not a passing anchor")
  })

  test("a trunk that cannot be fetched", () => {
    const f = fixture(BASE)
    const got = ask(f.release, path.join(root, "there-is-no-repo-here"))
    expect(got.code).toBe(1)
    expect(got.text).toContain("could not fetch trunk")
  })

  test("a trunk ref that does not exist", () => {
    const f = fixture(BASE)
    const got = ask(f.release, f.trunk, { TRUNK_REF: "no-such-branch" })
    expect(got.code).toBe(1)
    expect(got.text).toContain("could not fetch trunk")
  })

  test("a trunk whose tree has no fork subtree", () => {
    const f = fixture(BASE)
    const got = ask(f.release, f.trunk, { TRUNK_PREFIX: "somewhere/else" })
    expect(got.code).toBe(1)
    expect(got.text).toContain("has no somewhere/else subtree")
  })
})
