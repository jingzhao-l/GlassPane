import { mkdtemp, realpath, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"

export async function tmpdir() {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "opencode-tui-test-")))
  return {
    path: directory,
    async [Symbol.asyncDispose]() {
      await rm(directory, { recursive: true, force: true })
    },
  }
}

/**
 * Poll `predicate` until it holds, yielding to the event loop between attempts.
 *
 * Exists because "render N frames and hope the fetch resolved" is a race: the
 * number of frames a test needs depends on how many microtasks the mock
 * transport happens to take, so the same test passes alone and fails in a
 * suite. Waiting on the observable fact removes the ordering dependency.
 *
 * Throws with `label` in the message so a timeout names what never happened,
 * rather than surfacing as a bare assertion failure several lines away.
 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
