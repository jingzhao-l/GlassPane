import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

import { servedProbe, waitForRegistryVersion } from "../../script/registry-readiness"

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

/**
 * The wait's *caller* is half of the fix, and it is the half a green log used to hide.
 *
 * 0.10.0's release lane passed the readiness gate on the first look, so the run printed
 * `ok npm install of the published package` and nothing naming the registry observation — a
 * reader could not tell "waited and it became readable" from "never asked". These legs read the
 * gate script and pin that the success branch reports itself, under the same label the
 * cannot-observe branch uses, with what it waited on and a comparison against the version this
 * tag names. Source-text pins are deliberate: the wait is driven by real npm and a real registry
 * replica, which no test here can stage, so what IS checkable is that the call exists and is not
 * commented out.
 */
describe("the release lane says what it observed", () => {
  const script = readFileSync(new URL("../../script/verify-published.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n")

  test("both branches of the observation carry the same label", () => {
    // The labels are the contract: a green line and a "could not observe" line have to name the same
    // subject, or a reader cannot tell which of the two the lane failed to say. The refuse path goes
    // through `notServed(label, detail)`, which is what hands the label to `cannotObserve` — so the
    // chain is pinned, not just the pair of strings.
    for (const label of [
      '"the registry can read this published version"',
      '"the registry serves every platform package this install will pull"',
    ]) {
      // Match across the call's line break but not on column: the label reaching both branches is
      // the claim; how far right the editor put it is not.
      expect(new RegExp(`check\\(\\s*${label}`).test(script)).toBe(true)
      expect(new RegExp(`notServed\\(\\s*${label}`).test(script)).toBe(true)
    }
    expect(script).toContain("cannotObserve(label, detail)")
  })

  test("the install waits on every package the wrapper declares, read back from the registry", () => {
    // v0.10.4's lane died here: the wrapper's metadata was readable and the platform tarball was not.
    // The list comes from the PUBLISHED wrapper's own optionalDependencies, not re-derived from
    // product.json, because what must be served is what the installer was told to fetch.
    expect(script).toContain("npm view ${product.name}@${version} optionalDependencies --json")
    expect(script).toContain('servedProbe({')
    expect(script).toContain('readTarballUrl: () => viewField(pkg, ver, "dist.tarball")')
    // A declaration this gate cannot read is refused, not treated as "nothing to wait for".
    expect(script).toContain("if (pulls.length === 0)")
    // And the budget is shared across the set: one lagging CDN must not stretch the lane past a
    // runner timeout, which is the failure that leaves no verdict at all.
    expect(script).toContain("REGISTRY_READINESS_BUDGET_MS - (Date.now() - deadline)")
  })

  test("the success line reports how many looks and how long, not a bare ok", () => {
    const line = script.split("\n").find((l) => l.includes("answered after") && l.includes("readiness.attempts"))
    expect(line).toBeDefined()
    expect(line ?? "").toContain("readiness.waitedMs")
  })

  test("a registry answering with a different version is a failure, not a pass", () => {
    // The equality is the check's predicate, so a lane can never print `ok` while the registry
    // serves some other release — the shape of wrong this file has been amended for twice.
    expect(script).toContain("readiness.seen === version")
  })
})

/**
 * The probe the wait runs, driven with a fake registry and a fake CDN.
 *
 * These cases are the v0.10.4 incident: metadata and tarball are different objects on npm, and the
 * tarball lagged the metadata by roughly fifteen minutes. A readiness gate that reads only metadata
 * announces "installable" about bytes it never looked at. Everything here is driven — clock, sleeper,
 * fetch status — because a wait that can only be exercised by spending real minutes is a wait nobody
 * has seen terminate.
 */
describe("servedProbe: metadata is not the artifact", () => {
  const url = `https://registry.npmjs.org/${pkg}/-/${pkg}-${version}.tgz`
  const forbidden = async () => {
    throw new Error("must not be asked")
  }

  test("a registry that does not know the version yet answers 'not yet' without touching the CDN", async () => {
    let fetched = 0
    const look = await servedProbe({
      pkg,
      version,
      readVersion: async () => undefined,
      readTarballUrl: forbidden,
      fetchStatus: async () => {
        fetched += 1
        return 200
      },
    })()
    expect(look).toBeUndefined()
    expect(fetched).toBe(0)
  })

  test("metadata ready while the tarball still 404 is 'not yet', not a broken release", async () => {
    const look = await servedProbe({
      pkg,
      version,
      readVersion: async () => version,
      readTarballUrl: async () => url,
      fetchStatus: async () => 404,
    })()
    expect(look).toBeUndefined()
  })

  test("a served tarball answers with the version this tag names", async () => {
    for (const status of [200, 206]) {
      const look = await servedProbe({
        pkg,
        version,
        readVersion: async () => version,
        readTarballUrl: async () => url,
        fetchStatus: async () => status,
      })()
      expect(look).toBe(version)
    }
  })

  test("a 5xx is not an answer: it rejects, so the wait keeps it apart from 'not yet'", async () => {
    await expect(
      servedProbe({
        pkg,
        version,
        readVersion: async () => version,
        readTarballUrl: async () => url,
        fetchStatus: async () => 503,
      })(),
    ).rejects.toThrow(/HTTP 503/)
  })

  test("a stale replica answering an older version is surfaced, not laundered", async () => {
    // The caller's `seen === version` comparison is what turns this red, and it has to stay visible
    // rather than being smoothed into "ready".
    const look = await servedProbe({
      pkg,
      version,
      readVersion: async () => "0.9.0",
      readTarballUrl: forbidden,
      fetchStatus: async () => 200,
    })()
    expect(look).toBe("0.9.0")
  })

  test("the wait waits for the TARBALL, not the metadata — the exact v0.10.4 shape", async () => {
    let clock = 1_000
    const slept: number[] = []
    let looks = 0
    const readiness = await waitForRegistryVersion({
      pkg,
      version,
      registry,
      probe: servedProbe({
        pkg,
        version,
        readVersion: async () => version, // metadata answers on the first look
        readTarballUrl: async () => url,
        fetchStatus: async () => (++looks < 4 ? 404 : 200), // the CDN serves it on the fourth
      }),
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms)
        clock += ms
      },
      budgetMs: 60_000,
      pollMs: 10_000,
    })
    expect(readiness.ok).toBe(true)
    if (readiness.ok) expect(readiness.attempts).toBe(4)
    expect(slept.length).toBe(3)
  })

  test("a tarball that is never served stops as not-observed, naming how many looks it made", async () => {
    let clock = 1_000
    const notes: string[] = []
    const readiness = await waitForRegistryVersion({
      pkg,
      version,
      registry,
      probe: servedProbe({
        pkg,
        version,
        readVersion: async () => version,
        readTarballUrl: async () => url,
        fetchStatus: async () => 404,
      }),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
      budgetMs: 30_000,
      pollMs: 10_000,
      note: (line) => notes.push(line),
    })
    expect(readiness.ok).toBe(false)
    if (!readiness.ok) expect(readiness.reason).toBe("not-observed")
    expect(notes.some((line) => line.includes("not in") && line.includes("yet"))).toBe(true)
  })
})
