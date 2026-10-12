#!/usr/bin/env node
/**
 * Fixed-point test for `ref-batch.mjs` — the reader that replaced one `git show` subprocess
 * per probe in surface B.
 *
 * What it has to prove is not "the batch reader runs" but "the batch reader answers the same
 * questions with the same bytes as the subprocess-per-question it replaced", because every
 * number in `contracts/tool-surface.json` is derived from those bytes. So the oracle is the
 * old path itself: `git show HEAD:<path>`, run per sampled path, compared byte for byte.
 *
 * The inputs are production-shaped: the sampled paths come out of `contracts/fork-diff.json`,
 * the same list the ruler walks, and the repository is the real pinned reference clone.
 *
 * Controls, because a test that cannot fail is not evidence:
 *   1. a byte-flipped expectation must compare unequal — otherwise the comparison is
 *      decorative and the whole file proves nothing;
 *   2. a neutered copy of the parser (its object-framing advance moved by one byte) must go
 *      red. If the tampered copy still agrees, the sample is too small to be a control.
 *
 * With no reference clone the reader cannot be exercised at all. It then says so on the
 * record and exits 0 — a lane without upstream bytes has not passed anything, and the line
 * below is the only honest output it can produce.
 *
 * Run: `node harness/tools/ref-batch-selftest.mjs` (from anywhere; it locates the repo root).
 */
import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { readRefBlobs } from "./ref-batch.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, "..", "..")
const failures = []
const ok = (label) => console.log(`ok    ${label}`)
const bad = (label) => {
  failures.push(label)
  console.log(`FAIL  ${label}`)
}

const pin = JSON.parse(readFileSync(path.join(repoRoot, "harness", "upstream.json"), "utf8"))
const refRel = pin?.fork?.referenceClone ?? ".external/opencode"
const refDir = path.join(repoRoot, refRel)
if (!existsSync(path.join(refDir, ".git"))) {
  console.log(`NOT self-tested: no reference clone at ${refRel} — the batch reader was not exercised against real upstream bytes on this machine`)
  process.exit(0)
}

const fd = JSON.parse(readFileSync(path.join(repoRoot, "harness", "contracts", "fork-diff.json"), "utf8"))
const stride = (list, n) => list.filter((_, i) => i % n === 0)
// Both buckets and every extension the golden carries, not one hand-picked file type: the
// reader is asked about `.sh` and `.json` and binary-named paths too, and an object stream
// desynchronises on exactly the shapes a `.ts`-only sample never shows. `edited` and
// `deleted` exist at the pin in different ways (edited: kept and changed by us; deleted:
// upstream-only, and the probe that walks them is what made the old cost quadratic), so the
// sample takes a deterministic stride from each rather than letting one bucket fill the list.
const sampled = [...stride(fd.edited ?? [], 11).slice(0, 12), ...stride(fd.deleted ?? [], 77).slice(0, 12)]
const missing = ["packages/opencode/src/tool/glasspane/does-not-exist-upstream.ts", "harness/tools/no-such-file.ts"]
const specs = [...sampled, ...missing]

const blobs = readRefBlobs(refDir, specs)
console.log(`reference clone ${refRel} at ${execFileSync("git", ["-C", refDir, "describe", "--tags"], { encoding: "utf8" }).trim()}`)
console.log(`sampled ${sampled.length} paths from the fork-diff golden (${new Set(sampled.map((r) => path.extname(r))).size} extensions), plus ${missing.length} paths upstream does not have`)

if (blobs.size !== new Set(specs).size) bad(`the reader answered ${blobs.size} of ${new Set(specs).size} probes — every question must have an answer`)

let compared = 0
let present = 0
for (const rel of sampled) {
  let expected
  try {
    expected = execFileSync("git", ["-C", refDir, "show", `HEAD:${rel}`], { encoding: "buffer", maxBuffer: 512 * 1024 * 1024 })
  } catch {
    expected = null
  }
  const got = blobs.get(rel)
  if (expected === null) {
    // A path the golden lists but the pin does not carry: `null`, never an empty buffer, so
    // the caller reads absence as absence instead of as a zero-line upstream file.
    if (got === null || got === undefined) continue
    bad(`'${rel}' is absent at the pin but the reader returned ${got.length} bytes`)
    continue
  }
  present += 1
  if (got === null || got === undefined) {
    bad(`'${rel}' exists at the pin but the reader returned ${got === undefined ? "nothing at all" : "null"}`)
    continue
  }
  if (Buffer.compare(got, expected) !== 0) {
    bad(`'${rel}' bytes differ: batch ${got.length} vs git show ${expected.length}`)
    continue
  }
  compared += 1
  if (compared === 1) {
    const flipped = Buffer.from(expected)
    flipped[0] ^= 0x01
    if (Buffer.compare(flipped, got) === 0) bad("control spent: a one-byte-flipped expectation still compared equal, so the comparison proves nothing")
    else ok("control live: flipping one expected byte makes the comparison fail")
  }
}
if (present === 0) bad("no sampled path existed at the pin — the byte-equality check compared nothing")
else if (compared === present) ok(`${compared}/${present} sampled blobs byte-identical to \`git show HEAD:<path>\``)
else bad(`${present - compared}/${present} sampled blobs did not match \`git show\``)

for (const rel of missing) {
  if (blobs.get(rel) === null) ok(`'${rel}' reads as absent (null), not as an empty file`)
  else bad(`'${rel}' should be null, got ${blobs.get(rel) === undefined ? "no answer" : `${blobs.get(rel).length} bytes`}`)
}

// Control 2: the shipped parser, with its object-framing advance moved by one byte, must not
// still produce these answers. Run the neutered copy from a session-unique directory so the
// repository under test is never touched.
const scratch = path.join(tmpdir(), `ref-batch-selftest-${process.pid}`)
mkdirSync(scratch, { recursive: true })
try {
  const source = readFileSync(path.join(here, "ref-batch.mjs"), "utf8")
  const neutered = source.replace("offset = lineEnd + 1 + size + 1", "offset = lineEnd + 1 + size")
  if (neutered === source) bad("control could not be built: the framing advance is no longer the line this test neuters")
  else {
    const copy = path.join(scratch, "ref-batch-neutered.mjs")
    writeFileSync(copy, neutered)
    const mod = await import(pathToFileURL(copy).href)
    let red = false
    try {
      const moved = mod.readRefBlobs(refDir, sampled.slice(0, 6))
      red = sampled.slice(0, 6).some((rel) => {
        const expected = (() => {
          try {
            return execFileSync("git", ["-C", refDir, "show", `HEAD:${rel}`], { encoding: "buffer", maxBuffer: 512 * 1024 * 1024 })
          } catch {
            return null
          }
        })()
        const got = moved.get(rel)
        return expected !== null && (got === null || got === undefined || Buffer.compare(got, expected) !== 0)
      })
    } catch {
      red = true // a parser that throws on a shifted frame is red for the same reason
    }
    if (red) ok("control live: the neutered parser (frame advance off by one) disagrees with `git show`")
    else bad("the neutered parser still reproduced the same bytes — this sample cannot detect a framing error")
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

if (failures.length) {
  console.log(`ref-batch selftest: ${failures.length} check(s) failed`)
  process.exit(1)
}
console.log("ref-batch selftest: the batch reader answers with the bytes `git show` answers with")
