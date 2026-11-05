import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { checkFloors, compareVersions, minimumOf, run, type Declared, type Floor, type RunInput } from "../../script/dependency-floors"

/**
 * Fixed points for "a cited dependency floor must hold in every manifest that declares it".
 *
 * The reason this exists is not the two advisories themselves — those are raised in the manifests. It is
 * that this product is a fork pinned to upstream's `package.json` bytes, so the next sync replays an older
 * pin over ours and the downgrade arrives looking like a merge. The transport repo has already recorded a
 * security bump that the following split would have silently reverted; that is the accident this file pins.
 */

// import.meta.path is the file itself, so the fork root is five levels up: script → test → opencode →
// packages → glasspane-harness. Four levels lands in packages/ and the contract read then fails for a
// reason that has nothing to do with the rule under test.
const forkRoot = resolve(import.meta.path, "..", "..", "..", "..", "..")
const contractPath = join(forkRoot, "contracts", "dependency-floors.json")

const globFloor: Floor = {
  package: "glob",
  floor: "14.0.2",
  advisory: "GHSA-3g3m-2fjr-6pw4",
  vulnerable: ">= 9.0.0, <= 14.0.1",
  why: "a timed-out traversal keeps walking the filesystem",
}
const minimatchFloor: Floor = {
  package: "minimatch",
  floor: "11.0.1",
  advisory: "GHSA-g3hv-75wg-m249",
  vulnerable: "< 11.0.1",
  why: "one crafted pattern can exhaust the matching process",
}

function declared(manifest: string, name: string, spec: string): Declared {
  return { manifest, name, spec }
}

function manifestText(name: string, spec: string): { path: string; text: string } {
  return { path: `packages/${name}/package.json`, text: JSON.stringify({ name, dependencies: { glob: spec } }) }
}

function input(contract: unknown, manifests: readonly { path: string; text: string }[]): RunInput {
  return {
    contractText: typeof contract === "string" ? contract : JSON.stringify(contract),
    contractOrigin: "contracts/dependency-floors.json",
    manifestTexts: manifests,
  }
}

describe("the floor list against the tree that ships it", () => {
  test("the real contract and the real manifests agree, and both were actually read", () => {
    const contractText = readFileSync(contractPath, "utf8")
    // The SAME set the CLI reads: `packages/*/package.json` plus the workspace root. This
    // list used to mirror only the packages glob, which is how the guard stayed green while
    // `harness/glasspane-harness/package.json` — still upstream's manifest by name, so the
    // exact file a sync replays — carried `"glob": "13.0.5"`, inside the vulnerable range
    // this very contract cites. A test that reads a narrower set than the CLI is a test of
    // a program nobody ships.
    const manifestTexts = readdirSync(join(forkRoot, "packages"))
      .map((entry) => join(forkRoot, "packages", entry, "package.json"))
      .filter((path) => {
        try {
          readFileSync(path, "utf8")
          return true
        } catch {
          return false
        }
      })
      .map((path) => ({ path, text: readFileSync(path, "utf8") }))
    manifestTexts.push({ path: join(forkRoot, "package.json"), text: readFileSync(join(forkRoot, "package.json"), "utf8") })
    expect(manifestTexts.length).toBeGreaterThan(1)
    const result = run(input(contractText, manifestTexts))
    expect(result.exit).toBe(0)
    // The scan must be able to say which packages it looked at; "0 manifests" would also be exit-able as green
    // by a naive implementation, and that is the failure mode this whole file exists to refuse.
    expect(result.lines[0]).toContain(`${manifestTexts.length} manifest(s)`)
    // Every floor in the account has to cite a published advisory, or it is a preference wearing a
    // number's clothes — and "vulnerable" must stay a comparison against someone else's record.
    const contract = JSON.parse(readFileSync(contractPath, "utf8")) as {
      floors: { package: string; advisory: string; cve?: string; floor: string; vulnerable?: string; why?: string }[]
    }
    expect(contract.floors.length).toBeGreaterThanOrEqual(2)
    for (const floor of contract.floors) {
      expect(floor.advisory).toContain("GHSA-")
      expect(floor.cve ?? "").toContain("CVE-")
      expect(floor.floor).toMatch(/^\d+\.\d+\.\d+$/)
      expect((floor.why ?? "").length).toBeGreaterThan(20)
    }
    expect(contract.floors.map((entry) => entry.package).sort()).toEqual(["glob", "minimatch"])
  })

  test("a pin below a cited floor is named, with the advisory and the manifest that holds it", () => {
    const { problems, met } = checkFloors([globFloor], [declared("packages/opencode/package.json", "glob", "13.0.5")])
    expect(met).toEqual([])
    expect(problems.length).toBe(1)
    expect(problems[0]?.kind).toBe("below")
    expect(problems[0]?.advisory).toBe("GHSA-3g3m-2fjr-6pw4")
    expect(problems[0]?.manifest).toContain("packages/opencode/package.json")
    expect(problems[0]?.detail).toContain("13.0.5 is below 14.0.2")
    expect(problems[0]?.detail).toContain(">= 9.0.0, <= 14.0.1")
  })

  test("each manifest is judged on its own, so half a fix does not read as a fix", () => {
    const { problems, met } = checkFloors(
      [globFloor],
      [declared("packages/core/package.json", "glob", "14.0.2"), declared("packages/opencode/package.json", "glob", "13.0.5")],
    )
    expect(met.length).toBe(1)
    expect(problems.length).toBe(1)
    expect(problems[0]?.manifest).toContain("packages/opencode/package.json")
  })

  test("a dev-only declaration is in scope too — build-time code runs the same matcher", () => {
    const result = run(
      input({ floors: [globFloor] }, [
        { path: "packages/tui/package.json", text: JSON.stringify({ name: "tui", devDependencies: { glob: "10.0.0" } }) },
      ]),
    )
    expect(result.exit).toBe(1)
    expect(result.lines.join("\n")).toContain("packages/tui/package.json")
  })

  test("a floor whose package nobody declares is a note, not a pass and not a red", () => {
    const { problems, notes } = checkFloors([minimatchFloor], [declared("packages/core/package.json", "glob", "14.0.2")])
    expect(problems).toEqual([])
    expect(notes.length).toBe(1)
    expect(notes[0]).toContain("△")
    expect(notes[0]).toContain("no manifest declares it")
  })
})

describe("reading a version spec without guessing", () => {
  test("a bare pin and the three single-lower-bound forms carry a readable minimum", () => {
    for (const spec of ["14.0.2", "^14.0.2", "~14.0.2", ">=14.0.2"]) {
      const parsed = minimumOf(spec)
      expect(parsed.ok ? parsed.version : `failed: ${parsed.reason}`).toBe("14.0.2")
    }
  })

  test("a caret at the floor is satisfied; a caret one minor down is not", () => {
    expect(checkFloors([globFloor], [declared("m", "glob", "^14.0.2")]).problems).toEqual([])
    expect(checkFloors([globFloor], [declared("m", "glob", "^13.0.5")]).problems[0]?.kind).toBe("below")
  })

  test("an indirect spec is refused rather than passed", () => {
    for (const spec of ["catalog:", "workspace:*", "*", "latest"]) {
      const { problems } = checkFloors([globFloor], [declared("packages/core/package.json", "glob", spec)])
      expect(problems.length).toBe(1)
      expect(problems[0]?.kind).toBe("unreadable")
      expect(problems[0]?.detail).toContain(spec)
    }
  })

  test("an indirect floor declaration still makes the run red, because 'cannot compare' is not agreement", () => {
    const result = run(input({ floors: [globFloor] }, [manifestText("core", "catalog:")]))
    expect(result.exit).toBe(1)
    expect(result.lines.join("\n")).toContain("cannot be checked")
  })
})

describe("comparing versions numerically, not as text", () => {
  test("9.0.0 is below 14.0.2 — a string comparison would call it above", () => {
    expect(compareVersions("9.0.0", "14.0.2")).toBe(-1)
    expect("9.0.0" > "14.0.2").toBe(true)
    expect(checkFloors([globFloor], [declared("m", "glob", "9.0.0")]).problems[0]?.kind).toBe("below")
  })

  test("14.0.10 is above 14.0.2 — a string comparison would call it below and demand a pointless bump", () => {
    expect(compareVersions("14.0.10", "14.0.2")).toBe(1)
    expect("14.0.10" < "14.0.2").toBe(true)
    expect(checkFloors([globFloor], [declared("m", "glob", "14.0.10")]).problems).toEqual([])
  })

  test("a prerelease of the floor version is still below the release", () => {
    expect(compareVersions("14.0.2-beta.1", "14.0.2")).toBe(-1)
    expect(checkFloors([globFloor], [declared("m", "glob", "14.0.2-beta.1")]).problems[0]?.kind).toBe("below")
  })

  test("the floor itself and anything above it pass", () => {
    expect(checkFloors([globFloor, minimatchFloor], [declared("m", "glob", "14.0.2"), declared("m", "minimatch", "11.0.3")]).problems).toEqual([])
  })
})

describe("the four ways this check cannot observe, each of which refuses", () => {
  test("an empty floor list is not a clean bill of health", () => {
    const result = run(input({ floors: [] }, [manifestText("core", "14.0.2")]))
    expect(result.exit).toBe(2)
    expect(result.lines.join("\n")).toContain("declares 0 floors")
  })

  test("a floor with no advisory citation is rejected as an opinion", () => {
    const result = run(
      input({ floors: [{ package: "glob", floor: "14.0.2", why: "because" }] }, [manifestText("core", "14.0.2")]),
    )
    expect(result.exit).toBe(2)
    expect(result.lines.join("\n")).toContain("names no advisory id")
  })

  test("no manifests at all is reported as no coverage", () => {
    const result = run(input({ floors: [globFloor] }, []))
    expect(result.exit).toBe(2)
    expect(result.lines.join("\n")).toContain("nothing was looked at")
  })

  test("one unparseable manifest stops the run instead of being skipped", () => {
    const result = run(input({ floors: [globFloor] }, [manifestText("core", "14.0.2"), { path: "packages/app/package.json", text: "{ not json" }]))
    expect(result.exit).toBe(2)
    expect(result.lines.join("\n")).toContain("packages/app/package.json is not valid JSON")
  })

  /**
   * The workspace ROOT, driven through the real CLI rather than through `run()`.
   *
   * This is the shape that escaped the guard when it shipped: every package manifest was
   * raised above the floor, `bun.lock` resolved 14.0.2 for the product code, and the root
   * manifest — upstream's own file, with upstream's name on it — stayed at `"glob":
   * "13.0.5"`, inside the range the shipped contract names as vulnerable. `run()` cannot
   * catch that by itself because the CLI decides WHICH manifests it hands over, so the
   * fixed point has to drive the entry point that CI runs.
   */
  test("the CLI reads the workspace root, and a root below a floor is a refusal by name", () => {
    const script = join(forkRoot, "packages/opencode/script/dependency-floors.ts")
    const staged = mkdtempSync(join(tmpdir(), "gp-floors-root-"))
    mkdirSync(join(staged, "packages/core"), { recursive: true })
    writeFileSync(
      join(staged, "packages/core/package.json"),
      JSON.stringify({ name: "@opencode-ai/core", dependencies: { glob: "14.0.2", minimatch: "11.0.1" } }),
    )
    const rootBelow = join(staged, "root-below.json")
    writeFileSync(rootBelow, JSON.stringify({ name: "opencode", devDependencies: { glob: "13.0.5" } }))
    const rootAtFloor = join(staged, "root-at-floor.json")
    writeFileSync(rootAtFloor, JSON.stringify({ name: "opencode", devDependencies: { glob: "14.0.2" } }))
    const invoke = (root: string) =>
      spawnSync(process.execPath, [script, "--contract", contractPath, "--packages", join(staged, "packages"), "--root", root], { encoding: "utf8" })

    const refused = invoke(rootBelow)
    const refusedOutput = `${refused.stdout ?? ""}${refused.stderr ?? ""}`
    expect(refused.status).toBe(1)
    // Named: the file, the version, the floor and the advisory — not a count with no reader.
    expect(refusedOutput).toContain("root-below.json")
    expect(refusedOutput).toContain("13.0.5 is below 14.0.2")
    expect(refusedOutput).toContain("GHSA-3g3m-2fjr-6pw4")

    // The control: the same tree with the root at the floor passes, so the refusal above is
    // about the version and not about the file being the root.
    const clean = invoke(rootAtFloor)
    expect(`${clean.stdout ?? ""}${clean.stderr ?? ""}`).toContain("2 manifest(s)")
    expect(clean.status).toBe(0)

    // And a root nobody can read is "cannot observe", never a silent pass.
    const unreadable = invoke(join(staged, "no-such-manifest.json"))
    expect(unreadable.status).toBe(2)
    expect(`${unreadable.stdout ?? ""}${unreadable.stderr ?? ""}`).toContain("CANNOT OBSERVE")

    rmSync(staged, { recursive: true, force: true })
  })

  /**
   * The tree this guard ships inside has to satisfy the contract at the root too — the
   * assertion that would have caught the 13.0.5 before it was ever committed.
   */
  test("the fork's own workspace root is at or above every cited floor", () => {
    const rootManifest = join(forkRoot, "package.json")
    const rootJson = JSON.parse(readFileSync(rootManifest, "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    const contract = JSON.parse(readFileSync(contractPath, "utf8")) as { floors: Floor[] }
    const against = checkFloors(
      contract.floors,
      Object.entries({ ...(rootJson.dependencies ?? {}), ...(rootJson.devDependencies ?? {}) }).map(([name, spec]) =>
        declared(rootManifest, name, spec ?? ""),
      ),
    )
    expect(against.problems.map((problem) => `${problem.manifest} ${problem.name}: ${problem.detail}`)).toEqual([])
  })
})
