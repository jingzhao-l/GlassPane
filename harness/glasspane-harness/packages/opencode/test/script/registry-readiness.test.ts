import { describe, expect, test } from "bun:test"

import { waitForRegistryVersion } from "../../script/registry-readiness"

/**
 * Fixed points for the registry-readiness wait in the publish lane.
 *
 * The accident these pin is measured, not imagined: 2026-10-20, the release lane's
 * `install the published bytes and run them` job started 96 seconds after the publish job was
 * accepted, and npm answered `ETARGET notarget No matching version found for
 * glasspane-harness@0.9.1`. The artifact was fine — that version installs today and its registry
 * `dist.shasum` matches what CI printed for it — but the lane read a lagging read replica as a
 * broken release. A wait is exactly the kind of check that cannot be shown working by a single
 * run, so every case here drives the clock and the sleeper rather than spending real minutes:
 * a budget nobody can fast-forward is a budget nobody has seen terminate.
 */
const pkg = "glasspane-harness"
const version = "0.9.1"
const registry = "https://registry.npmjs.org"

type Driver = {
  /** The registry's answers, one per look; the last one repeats if the loop outlives the list. */
  answers: Array<string | undefined | Error>
  budgetMs?: number
  pollMs?: number
}

/** A registry that answers in order, a clock that advances only when the loop sleeps, and a log. */
function drive(driver: Driver) {
  const notes: string[] = []
  const slept: number[] = []
  let clock = 1_000
  let look = 0
  const result = waitForRegistryVersion({
    pkg,
    version,
    registry,
    probe: async () => {
      const item = driver.answers[Math.min(look, driver.answers.length - 1)]
      look += 1
      if (item instanceof Error) throw item
      return item
    },
    now: () => clock,
    sleep: (ms) => {
      slept.push(ms)
      clock += ms
      return Promise.resolve()
    },
    ...(driver.budgetMs === undefined ? {} : { budgetMs: driver.budgetMs }),
    ...(driver.pollMs === undefined ? {} : { pollMs: driver.pollMs }),
    note: (line) => notes.push(line),
  })
  return { result, notes, slept }
}

describe("what the readiness wait accepts as an answer", () => {
  test("a version the registry can name is ready, and the wait is reported", async () => {
    const { result, notes } = drive({ answers: [version] })
    expect(await result).toEqual({ ok: true, seen: version, attempts: 1, waitedMs: 0 })
    // One look, nothing to say: a log that narrates a successful first attempt is noise that
    // buries the attempts that matter.
    expect(notes).toEqual([])
  })

  test("the lagging replica is waited out, and every look is accounted for", async () => {
    const { result, notes, slept } = drive({ answers: [undefined, undefined, version], pollMs: 7_000 })
    const ready = await result
    expect(ready.ok).toBe(true)
    if (ready.ok) {
      expect(ready.attempts).toBe(3)
      expect(ready.seen).toBe(version)
      expect(ready.waitedMs).toBe(14_000)
    }
    // Two "not yet" lines then the success line: the log must show the wait it did, because
    // "it installed first time" and "it took 14 seconds of waiting" are different facts about
    // the registry.
    expect(notes.filter((line) => line.includes("not in"))).toHaveLength(2)
    expect(slept).toEqual([7_000, 7_000])
  })

  test("an exit-0 read that names no version is NOT readiness", async () => {
    // The self-echo shape: npm can exit 0 with an empty stdout (a scoped query that resolves
    // nothing), and a wait that treats "I got an answer" as "the version is there" would let a
    // release be verified against a prefix that holds nothing.
    const { result } = drive({ answers: ["", "   ", ""], budgetMs: 40_000, pollMs: 10_000 })
    const stopped = await result
    expect(stopped.ok).toBe(false)
    if (!stopped.ok) expect(stopped.reason).toBe("not-observed")
  })
})

describe("what the readiness wait refuses to claim", () => {
  test("a version that never becomes readable stops with nothing concluded", async () => {
    const { result, slept } = drive({ answers: [undefined], budgetMs: 60_000, pollMs: 20_000 })
    const stopped = await result
    expect(stopped.ok).toBe(false)
    if (!stopped.ok) {
      expect(stopped).toEqual({
        ok: false,
        reason: "not-observed",
        attempts: 4,
        waitedMs: 60_000,
        budgetMs: 60_000,
      })
      // No lastTransportError: a registry that keeps answering "not there" is a different
      // situation from one we could not ask, and the two must stay distinguishable in the log.
      expect("lastTransportError" in stopped).toBe(false)
    }
    expect(slept.at(-1)).toBeLessThanOrEqual(20_000)
  })

  test("a registry we cannot ask is never readiness, and the trouble is carried out", async () => {
    const trouble = new Error("npm error code ETARGET notarget No matching version found")
    const { result, notes } = drive({ answers: [trouble], budgetMs: 25_000, pollMs: 10_000 })
    const stopped = await result
    expect(stopped.ok).toBe(false)
    if (!stopped.ok) {
      expect(stopped.reason).toBe("not-observed")
      expect(stopped.lastTransportError).toContain("ETARGET")
    }
    expect(notes.some((line) => line.includes("not readable"))).toBe(true)
  })

  test("transport trouble that clears does not stay in the verdict", async () => {
    const { result } = drive({ answers: [new Error("ECONNRESET"), version] })
    const ready = await result
    expect(ready.ok).toBe(true)
    if (ready.ok) expect(ready.attempts).toBe(2)
  })

  test("a budget shorter than one poll interval cannot spin", async () => {
    // The deadline is re-checked between the look and the sleep, and the sleep is clipped to what
    // is left — so a 1s budget with a 20s poll spends one clipped sleep and stops. It gets a
    // second look at the boundary rather than zero, which is the point: the wait must be able to
    // end without waiting, and must never loop on a budget it has already spent.
    const { result, slept } = drive({ answers: [undefined], budgetMs: 1_000, pollMs: 20_000 })
    const stopped = await result
    expect(stopped.ok).toBe(false)
    if (!stopped.ok) {
      expect(stopped.attempts).toBe(2)
      expect(stopped.waitedMs).toBe(1_000)
    }
    expect(slept).toEqual([1_000])
  })

  test("the last sleep is clipped to what is left of the budget", async () => {
    const { result, slept } = drive({ answers: [undefined, undefined, undefined], budgetMs: 25_000, pollMs: 10_000 })
    // Awaited before the array is read: this assertion used to run while the wait was still
    // pending, so it compared against a sleep log that had not been written yet — the shape of
    // "green because nothing ran" this file exists to avoid.
    const stopped = await result
    expect(stopped.ok).toBe(false)
    expect(slept).toEqual([10_000, 10_000, 5_000])
  })
})
