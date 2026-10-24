/**
 * Whether a just-published version is readable from the registry yet, as a pure, drivable
 * function.
 *
 * WHY IT IS OUT OF `script/verify-published.ts`: that script runs its checks the moment it is
 * imported, so nothing can import it to ask a question about one of its steps — and the step
 * this file holds is the one that burned a release lane. Measured 2026-10-20: the publish job
 * was accepted at 00:38:43Z, `install the published bytes and run them` started 96 seconds
 * later, and npm answered `ETARGET notarget No matching version found for
 * glasspane-harness@0.9.1`. The artifact was fine (the same version reads today with the
 * tarball shasum matching what CI printed); the lane had simply asked a lagging read replica a
 * question about a write that had not propagated. The registry's own notice says it: "Your
 * package is being processed and may take a few minutes to become available" — measured on this
 * project at 12–20 minutes for earlier releases.
 *
 * So the gate cannot be "the previous job succeeded"; it has to be "this registry can read the
 * version I am about to install". And because that is a WAIT, it has to be able to end without
 * ever seeing the version — which is NOT a failed release. Three outcomes, and the difference
 * between the last two is the whole point:
 *
 *  - `ready` — the registry served exactly this version. Installing now measures the artifact.
 *  - `not-observed` — the budget ran out. Nothing was learned about the artifact. This maps to
 *    this lane's exit 2, never to a red "broken release".
 *  - a probe that REJECTED is not an answer either: transport trouble (a proxy re-signing TLS,
 *    a 403, an HTTP 200 that carries HTML) is kept apart from "the registry does not know this
 *    version yet", exactly as `scripts/install.sh` keeps "no manifest" apart from "could not
 *    read the manifest". A rejected probe never becomes `ready`, and the last transport error is
 *    carried out so the log can name the reason it stopped waiting.
 *
 * The clock and the sleeper are injected. A wait that can only be exercised by waiting 20 real
 * minutes is a wait nobody has seen terminate, and the budget is the part that matters.
 */

export const REGISTRY_READINESS_POLL_MS = 20_000
/** 20 minutes: the longest read-replica lag measured for this project, rounded up. */
export const REGISTRY_READINESS_BUDGET_MS = 20 * 60_000

export interface ReadinessInput {
  readonly pkg: string
  readonly version: string
  readonly registry: string
  /**
   * One look. Resolves to the version string the registry reports when it knows this exact
   * version, resolves to `undefined` when the registry answers "not yet" (an npm `ETARGET`/404
   * for `pkg@version`), and REJECTS when the look itself failed.
   */
  readonly probe: () => Promise<string | undefined>
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
  readonly budgetMs?: number
  readonly pollMs?: number
  /** Where to write the running account. Injected so a test can assert the log, not just the result. */
  readonly note?: (line: string) => void
}

export type Readiness =
  | { readonly ok: true; readonly seen: string; readonly attempts: number; readonly waitedMs: number }
  | {
      readonly ok: false
      readonly reason: "not-observed"
      readonly attempts: number
      readonly waitedMs: number
      readonly budgetMs: number
      readonly lastTransportError?: string
    }

/**
 * Poll until the registry can read `pkg@version`, or the budget is spent.
 *
 * Two properties the tests pin, because both are easy to break silently: the deadline is
 * re-checked before every sleep (so a budget smaller than one poll interval still gets exactly
 * one look and cannot spin forever), and a version that is readable but DIFFERENT is not a
 * miss — it is the registry telling us about some other artifact, which must not be installed as
 * if it were ours.
 */
export async function waitForRegistryVersion(input: ReadinessInput): Promise<Readiness> {
  const budgetMs = input.budgetMs ?? REGISTRY_READINESS_BUDGET_MS
  const pollMs = input.pollMs ?? REGISTRY_READINESS_POLL_MS
  const note = input.note ?? (() => {})
  const started = input.now()
  let attempts = 0
  let lastTransportError: string | undefined

  for (;;) {
    attempts += 1
    let seen: string | undefined
    try {
      seen = await input.probe()
      lastTransportError = undefined
    } catch (error) {
      // A failed look is not a "not yet": keep waiting, but remember why so a stop that comes
      // later can name the trouble instead of implying the publish never happened.
      lastTransportError = error instanceof Error ? error.message : String(error)
      note(`attempt ${attempts}: registry not readable (${lastTransportError})`)
    }
    if (typeof seen === "string" && seen.trim() !== "") {
      const waitedMs = input.now() - started
      if (attempts > 1) note(`attempt ${attempts}: readable after ${waitedMs} ms of waiting`)
      return { ok: true, seen: seen.trim(), attempts, waitedMs }
    }
    if (seen === undefined && lastTransportError === undefined) {
      note(`attempt ${attempts}: ${input.pkg}@${input.version} not in ${input.registry} yet`)
    }
    const elapsed = input.now() - started
    if (elapsed >= budgetMs) {
      return {
        ok: false,
        reason: "not-observed",
        attempts,
        waitedMs: elapsed,
        budgetMs,
        ...(lastTransportError === undefined ? {} : { lastTransportError }),
      }
    }
    await input.sleep(Math.min(pollMs, budgetMs - elapsed))
  }
}

/**
 * What "this registry can serve the version" has to mean before an install is attempted.
 *
 * Measured 2026-10-24 on v0.10.4: the wrapper's METADATA answered `0.10.4` after 21 s, this file's
 * wait reported it ready, and the install still died on
 * `404 … /glasspane-harness-darwin-arm64/-/glasspane-harness-darwin-arm64-0.10.4.tgz`. npm writes
 * metadata and tarball through different paths and the CDN copy of the tarball lagged by about
 * fifteen minutes (the same URL answered 200 before the job's third attempt). A wait that reads only
 * the metadata announces "installable" about an object it never looked at — which is the exact
 * failure this file was extracted to prevent, one layer down.
 *
 * So one look is three questions, in order: does the metadata know this version, does it name a
 * tarball, and is that tarball served. Any "not yet" becomes `undefined` so the wait keeps waiting;
 * anything that is not the registry's own 404 REJECTS, because a proxy or a 5xx is not an answer
 * about the artifact — `not-observed` and "broken release" must stay two different sentences.
 */
export interface ServedProbeInput {
  readonly pkg: string
  readonly version: string
  /** The version string the metadata reports for `pkg@version`; `undefined` when it does not know it yet. */
  readonly readVersion: () => Promise<string | undefined>
  /** The tarball URL that metadata points at; `undefined` when there is no metadata to read it from. */
  readonly readTarballUrl: () => Promise<string | undefined>
  /** Fetch status of that URL. 200/206 = served, 404 = not yet, anything else = not an answer. */
  readonly fetchStatus: (url: string) => Promise<number>
}

export function servedProbe(input: ServedProbeInput): () => Promise<string | undefined> {
  return async () => {
    const seen = await input.readVersion()
    if (seen === undefined) return undefined
    // A metadata answer that is not the version asked for is surfaced, not swallowed: the caller
    // compares it (`readiness.seen === version`) and a stale replica replying with an older version
    // must not be laundered into "ready".
    if (seen !== input.version) return seen
    const url = await input.readTarballUrl()
    if (url === undefined || url.trim() === "") return undefined
    const status = await input.fetchStatus(url)
    if (status === 404) return undefined
    if (status === 200 || status === 206) return seen
    throw new Error(`fetching ${input.pkg}@${input.version}'s tarball answered HTTP ${status} (${url})`)
  }
}
