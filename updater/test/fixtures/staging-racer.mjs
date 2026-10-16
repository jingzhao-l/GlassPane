/**
 * A second process that stages one archive into a directory another process is staging into at the same
 * moment — the shape of the panel's Install button and the daily job both fetching the same release.
 *
 * `lib/staging.js`'s `writeArchive` is synchronous, so a single process can never interleave its own write
 * and rename; the race the fix is about is only reachable across processes. This child makes that
 * interleaving *arranged* rather than *hoped for*: it writes its temp, announces that it did, and only
 * renames once the parent says its own rename is done. Every step is a file on disk, so nothing here
 * depends on how fast the machine happens to be.
 *
 * usage: node staging-racer.mjs <stagingRoot> <archivePath> <token> <markerDir> <wait-for-name|->
 * Writes `<markerDir>/<token>-wrote`, then `<token>-renamed`, then `<token>-verdict.json`.
 */
import fs from 'node:fs'
import path from 'node:path'

import { writeArchive } from '../../lib/staging.js'

const [stagingRoot, archivePath, token, markerDir, waitForName] = process.argv.slice(2)
const byteLength = Number(process.env.GP_RACE_BYTES ?? 3000)
// A payload that is this process's own, so a half-written archive from two interleaved writers cannot pass
// as a whole one: `R` in this child, `P` in the parent, the same length.
const payload = Buffer.from('R'.repeat(byteLength))

const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function waitFor(name, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (fs.existsSync(path.join(markerDir, name))) return true
    nap(10)
  }
  return false
}

function verdict(body) {
  fs.writeFileSync(path.join(markerDir, `${token}-verdict.json`), JSON.stringify(body) + '\n')
}

try {
  writeArchive(archivePath, payload, {
    stagingRoot,
    token,
    beforeRename: () => {
      fs.writeFileSync(path.join(markerDir, `${token}-wrote`), 'wrote\n')
      if (waitForName && waitForName !== '-') {
        if (!waitFor(waitForName)) throw new Error(`waited 30000ms for ${JSON.stringify(waitForName)}; the parent never renamed`)
      }
    },
  })
  fs.writeFileSync(path.join(markerDir, `${token}-renamed`), 'renamed\n')
  verdict({ ok: true, token, bytes: fs.statSync(archivePath).size })
} catch (error) {
  // The failure is recorded, not just exited on: the parent has to be able to read *which* syscall lost.
  fs.writeFileSync(path.join(markerDir, `${token}-renamed`), 'failed\n')
  verdict({ ok: false, token, reason: `${error?.code ?? ''} ${error?.message ?? String(error)}`.trim() })
  process.exitCode = 1
}
