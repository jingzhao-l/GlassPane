import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * Fixed point: upstream's dev-only release mutators cannot be mis-run as a publish.
 *
 * Three files in this fork reached the outside world without passing a gate:
 *   · `script/release` dispatched `publish.yml` — a workflow that is not in this tree, so the
 *     command either died or dispatched whatever the remote's `publish.yml` holds (after an upstream
 *     sync: upstream's own publisher), skipping `version-check` and `assert-ci-green`;
 *   · `script/beta.ts:354` ran `git push origin beta --force --no-verify`, past the hooks;
 *   · `script/version.ts:18,23` ran `gh release create`, once with no `--repo` at all.
 * `harness/tools/product-surface.mjs` rule `no-foreign-publish` only opens the per-package
 * `script/publish.ts` files, so it could never see these three. They are refusals now; this file is
 * the reader that keeps them refusals, and it is a test rather than a ruler because the ruler is
 * another lane's file (the rule text to add there is recorded in this lane's report).
 *
 * The cases RUN the real files, which is only safe because of the stub on PATH: `git` and `gh` here
 * log the call and fail. They never answer with success, so a script that grew a live outward verb
 * back would not reach a remote — and the assertion that the log stayed empty is the one that says
 * the refusal happens *before* any command, not instead of one.
 */
const FORK = path.join(import.meta.dir, "../../../..")
const MUTATORS = ["script/release", "script/beta.ts", "script/version.ts"] as const

const scratch = mkdtempSync(path.join(tmpdir(), "gp-dev-mutators-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function stubBin() {
  const bin = path.join(scratch, "bin")
  mkdirSync(bin, { recursive: true })
  for (const tool of ["git", "gh"]) {
    writeFileSync(
      path.join(bin, tool),
      [
        "#!/bin/sh",
        `printf '%s %s\\n' "${tool}" "$*" >> "${scratch}/calls.log"`,
        `echo "stub ${tool}: refusing (a dev-only mutator must not reach a remote from a test)" >&2`,
        "exit 127",
        "",
      ].join("\n"),
    )
    chmodSync(path.join(bin, tool), 0o755)
  }
  return bin
}

async function run(rel: string) {
  const bin = stubBin()
  const target = path.join(FORK, rel)
  const child = Bun.spawn([rel === "script/release" ? "/bin/bash" : process.execPath, target], {
    cwd: FORK,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  })
  const [rc, stdout, stderr] = await Promise.all([
    child.exited,
    Bun.readableStreamToText(child.stdout),
    Bun.readableStreamToText(child.stderr),
  ])
  return { rc, out: `${stdout}${stderr}`, calls: existsSync(path.join(scratch, "calls.log")) ? readFileSync(path.join(scratch, "calls.log"), "utf8") : "" }
}

/** Comment-free code, the way `product-surface.mjs` reads a file: prose about a removed body must not satisfy a rule about the body. */
function stripComments(text: string) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "").replace(/^\s*#.*$/gm, "")
}

describe("upstream's dev-only release mutators are dead ends", () => {
  test("all three files are still in the tree, so this scan is measuring something", () => {
    for (const rel of MUTATORS) expect(existsSync(path.join(FORK, rel)), `${rel} is gone — a removed file is not a dead end, it is an unmeasured one`).toBe(true)
  })

  test("each one refuses with exit 2", async () => {
    for (const rel of MUTATORS) {
      const read = await run(rel)
      expect(read.rc, `${rel} answered ${read.rc}, not the 2 a refusal owes: ${read.out}`).toBe(2)
      expect(read.out).toContain("on purpose")
    }
  })

  test("and the refusal happens before any git or gh call is made", async () => {
    for (const rel of MUTATORS) {
      const read = await run(rel)
      expect(read.calls, `${rel} reached out before refusing:\n${read.calls}`).toBe("")
    }
  })

  test("no shell command survives in their code: no dispatch, no release create, no push", () => {
    for (const rel of MUTATORS) {
      const text = stripComments(readFileSync(path.join(FORK, rel), "utf8"))
      // bun's shell template (`$\`…\``) is the only way these .ts files could have run anything, and
      // in bash the first token of a line is the only way it can. Text inside an `echo` remedy is
      // prose about the removed body, which is exactly what product-surface's stripper exists to ignore.
      const spawned = text.match(/\$\s*`[^`]*\b(gh|git|npm)\b[^`]*`/g) ?? []
      const invoked = rel.endsWith(".ts") ? [] : text.split("\n").filter((line) => /^\s*(gh|git|npm)\b/.test(line))
      expect([...spawned, ...invoked], `${rel} still spawns something:\n${[...spawned, ...invoked].join("\n")}`).toEqual([])
    }
  })

  test("each still names the lane a reader should use instead", () => {
    for (const rel of MUTATORS) {
      const text = readFileSync(path.join(FORK, rel), "utf8")
      expect(text).toContain("Remedy")
      expect(text).toMatch(/release\.yml|docs\/release\.md/)
    }
  })
})
