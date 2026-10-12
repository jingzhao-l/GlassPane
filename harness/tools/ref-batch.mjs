/**
 * Read many blobs out of the upstream reference clone in one `git` subprocess.
 *
 * Surface B asks the same question about thousands of upstream files: what were the bytes
 * at `HEAD:<path>` when the pin was cut. Each question used to cost its own
 * `git show` subprocess, because the pure-rename probe walks *every* upstream file that
 * shares an extension with one of ours and re-reads it for each candidate. Measured on the
 * 2026-10-12 tree: 4,045 probes over 682 distinct blobs, ~1.3 s per subprocess at the load
 * average this machine was running (185), so a single `tool-surface --check` took 90 minutes
 * and printed nothing until the very end. A gate that cannot be told apart from a hang gets
 * killed by whoever is waiting for it, so the cost comes out of the plumbing — the
 * judgement and the numbers stay exactly as they were.
 *
 * `cat-file --batch` answers every probe in the order asked, with two subprocesses.
 *
 * Self-tested by `harness/tools/ref-batch-selftest.mjs`, which byte-compares this against
 * the `git show` it replaced and carries the reverse controls.
 */
import { spawnSync } from "node:child_process"

const MAX_BUFFER = 1024 * 1024 * 1024

const specOf = (rel) => `HEAD:${rel}`

function run(refDir, args, input, encoding) {
  // `spawnSync` has no "buffer" encoding: leaving `encoding` unset is what returns a Buffer.
  const result = spawnSync("git", ["-C", refDir, ...args], {
    input,
    maxBuffer: MAX_BUFFER,
    ...(encoding === undefined ? {} : { encoding }),
  })
  if (result.error) throw new Error(`git ${args[0]} could not be started: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} in ${refDir} exited ${result.status}: ${String(result.stderr ?? "").trim().slice(0, 200)}`)
  }
  return result.stdout
}

/**
 * `specs` are repository-relative paths. Returns a Map from each spec to its bytes at the
 * reference clone's HEAD, or to `null` for a path the pin does not carry — the absence is a
 * value, because "upstream has no such file" and "upstream has an empty file" must not read
 * the same way downstream.
 *
 * Throws if the clone cannot be read or answers in a shape that cannot be parsed; a
 * half-parsed object stream would silently mis-attribute authorship, which is the one thing
 * this measurement may not do.
 */
export function readRefBlobs(refDir, specs) {
  const unique = [...new Set(specs)]
  const out = new Map()
  if (!unique.length) return out

  // `--batch` takes one raw object spec per line and echoes the spec back on a miss, so a
  // path containing a newline would desynchronise the whole response. Refuse rather than
  // mis-parse: no fork path looks like that, and if one ever did it must be named.
  const offending = unique.find((s) => /[\n\r\0]/.test(s))
  if (offending !== undefined) throw new Error(`cannot batch-read a path containing a control character: ${JSON.stringify(offending.slice(0, 60))}`)

  const input = `${unique.map(specOf).join("\n")}\n`
  const checked = run(refDir, ["cat-file", "--batch-check"], input, "utf8").split("\n")
  // A trailing empty element is the final newline; anything else means the clone answered a
  // different number of questions than were asked.
  if (checked.length !== unique.length + 1 || checked[checked.length - 1] !== "") {
    throw new Error(`reference clone answered ${checked.length - 1} probes for ${unique.length} paths — it moved during the measurement`)
  }
  const present = []
  unique.forEach((spec, i) => {
    const parts = checked[i].split(" ")
    // `<oid> blob <size>` when it exists, `<spec> missing` when it does not.
    if (parts.length === 3 && parts[1] === "blob" && /^\d+$/.test(parts[2])) present.push(spec)
    else out.set(spec, null)
  })
  if (!present.length) return out

  const body = run(refDir, ["cat-file", "--batch"], `${present.map(specOf).join("\n")}\n`)
  let offset = 0
  for (const spec of present) {
    const lineEnd = body.indexOf(0x0a, offset)
    if (lineEnd < 0) throw new Error(`batch output ended before an answer for '${spec}'`)
    const header = body.subarray(offset, lineEnd)
    const parts = header.toString("utf8").split(" ")
    if (parts.length !== 3 || parts[1] !== "blob" || !/^\d+$/.test(parts[2])) {
      throw new Error(`unexpected batch header for '${spec}': ${JSON.stringify(header.toString("utf8").slice(0, 120))}`)
    }
    const size = Number(parts[2])
    const bytes = body.subarray(lineEnd + 1, lineEnd + 1 + size)
    if (bytes.length !== size) throw new Error(`truncated content for '${spec}': header said ${size} bytes, stream held ${bytes.length}`)
    out.set(spec, Buffer.from(bytes))
    // Objects are framed as `<header>\n<content>\n`; the terminator belongs to the framing.
    offset = lineEnd + 1 + size + 1
  }
  return out
}
