/**
 * Version floors for direct dependencies whose code this product executes.
 *
 * The account lives in `contracts/dependency-floors.json`, next to `kernel-pin.json`, for one reason:
 * this product is a fork pinned to upstream's manifest bytes. A sync replays upstream's `package.json`
 * over ours, so a dependency downgrade arrives looking like a merge rather than like a decision. The
 * transport repo already recorded that shape once (a security bump that lived only in the split repo,
 * which the next split would have quietly reverted); a floor list turns "did that fix survive the sync"
 * into a question a CI lane can answer.
 *
 * Three answers, not two. `below` is the ship-a-known-hole case. `unreadable` is the case where the
 * manifest names the package but this file cannot tell what minimum it means (`catalog:`, a range with
 * a lower bound below the floor, a dist-tag): that is not a pass, because "I could not ask" and "it is
 * fine" produce different actions. `cannot observe` (exit 2) is the case where the inputs themselves are
 * missing -- no contract, an empty floor list, no manifests on disk -- because an empty scan is exactly
 * what a green run with no coverage looks like.
 */

export type Floor = {
  readonly package: string
  readonly floor: string
  readonly advisory: string
  readonly cve?: string
  readonly vulnerable?: string
  readonly why: string
}

export type Declared = {
  readonly manifest: string
  readonly name: string
  readonly spec: string
}

export type Minimum = { readonly ok: true; readonly version: string } | { readonly ok: false; readonly reason: string }

export type Problem = {
  readonly kind: "below" | "unreadable"
  readonly package: string
  readonly manifest: string
  readonly spec: string
  readonly floor: string
  readonly advisory: string
  readonly detail: string
}

/**
 * The lowest version a spec can resolve to. Bare pins and the `^x.y.z` / `~x.y.z` / `>=x.y.z` forms carry
 * that minimum literally; everything else answers "cannot tell", because guessing here would mean the
 * guard passing on an assumption. `workspace:` and `catalog:` are the two shapes this repository actually
 * uses for indirection, and both hide the number behind another file.
 */
export function minimumOf(spec: string): Minimum {
  const value = spec.trim()
  if (value === "" || value === "*" || value === "latest") return { ok: false, reason: `spec '${spec}' names no version` }
  if (value.startsWith("workspace:") || value.startsWith("catalog:") || value.startsWith("file:") || value.startsWith("npm:"))
    return { ok: false, reason: `spec '${spec}' resolves through another file, so its minimum is not readable here` }
  const match = /^(?:\^|~|>=|v)?\s*(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value)
  if (!match) return { ok: false, reason: `spec '${spec}' is not a bare version or a single lower bound` }
  const prerelease = match[4] === undefined ? "" : `-${match[4]}`
  return { ok: true, version: `${match[1]}.${match[2]}.${match[3]}${prerelease}` }
}

/**
 * Numeric, segment by segment. A string comparison would call "9.0.0" greater than "14.0.2" and
 * "14.0.10" smaller than "14.0.2" -- both wrong, and the second one wrong in the direction that lets a
 * hole through while the guard prints green.
 */
export function compareVersions(a: string, b: string): number {
  const left = a.split("-")
  const right = b.split("-")
  const leftNumbers = left[0].split(".").map(Number)
  const rightNumbers = right[0].split(".").map(Number)
  for (let i = 0; i < 3; i++) {
    const l = leftNumbers[i] ?? 0
    const r = rightNumbers[i] ?? 0
    if (l !== r) return l < r ? -1 : 1
  }
  // Same numbers: a prerelease is before the release it precedes, and absent after it.
  if (left[1] === right[1]) return 0
  if (left[1] === undefined) return 1
  if (right[1] === undefined) return -1
  return left[1] < right[1] ? -1 : 1
}

export function checkFloors(floors: readonly Floor[], manifests: readonly Declared[]): {
  readonly problems: readonly Problem[]
  readonly notes: readonly string[]
  readonly met: readonly string[]
} {
  const problems: Problem[] = []
  const notes: string[] = []
  const met: string[] = []
  for (const floor of floors) {
    const declarers = manifests.filter((entry) => entry.name === floor.package)
    if (declarers.length === 0) {
      notes.push(`△ ${floor.package} floor ${floor.floor} (${floor.advisory}): no manifest declares it — nothing to check, and that is a note, not a pass`)
      continue
    }
    for (const declared of declarers) {
      const minimum = minimumOf(declared.spec)
      if (!minimum.ok) {
        problems.push({
          kind: "unreadable",
          package: floor.package,
          manifest: declared.manifest,
          spec: declared.spec,
          floor: floor.floor,
          advisory: floor.advisory,
          detail: minimum.reason,
        })
        continue
      }
      if (compareVersions(minimum.version, floor.floor) < 0) {
        problems.push({
          kind: "below",
          package: floor.package,
          manifest: declared.manifest,
          spec: declared.spec,
          floor: floor.floor,
          advisory: floor.advisory,
          detail: `${minimum.version} is below ${floor.floor}, the first version ${floor.advisory} marks fixed${floor.vulnerable ? ` (vulnerable range: ${floor.vulnerable})` : ""}`,
        })
        continue
      }
      met.push(`${floor.package}@${declared.spec} in ${declared.manifest}`)
    }
  }
  return { problems, notes, met }
}

export function describeProblems(problems: readonly Problem[], floors: readonly Floor[]): string[] {
  const cited = new Map(floors.map((floor) => [floor.package, floor]))
  return problems.map((problem) => {
    const floor = cited.get(problem.package)
    const head =
      problem.kind === "below"
        ? `✗ ${problem.package} ships below its floor in ${problem.manifest}: ${problem.spec} — ${problem.advisory}`
        : `✗ ${problem.package} cannot be checked in ${problem.manifest}: ${problem.spec} — floor ${problem.floor} (${problem.advisory})`
    const remedy =
      problem.kind === "below"
        ? `   why it matters: ${floor?.why ?? problem.detail}\n   remedy: raise the pin in ${problem.manifest} to ${problem.floor} (or above) and re-resolve the lock; if the pin is deliberately old, delete its entry from contracts/dependency-floors.json and say in the commit why a known advisory is being kept`
        : `   remedy: name a version this file can read (^x.y.z, ~x.y.z, >=x.y.z or a bare pin) so the floor can actually be compared`
    return `${head}\n   ${problem.detail}\n${remedy}`
  })
}

/**
 * Everything below is the seam the CLI uses. The test drives `checkFloors` with data and `run` with
 * fixture directories, so neither has to mutate the repository to prove the guard reacts.
 */

export type Contract = { readonly floors: readonly Floor[] }

export function parseContract(text: string, origin: string): Contract | { readonly refusal: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { refusal: `${origin} is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  const record = parsed as { floors?: unknown }
  if (!Array.isArray(record.floors)) return { refusal: `${origin} has no 'floors' array — an account that lists nothing cannot pass` }
  const floors: Floor[] = []
  for (const entry of record.floors as unknown[]) {
    const floor = entry as Partial<Floor>
    if (typeof floor.package !== "string" || typeof floor.floor !== "string" || typeof floor.why !== "string")
      return { refusal: `${origin} carries an entry without package/floor/why — a floor with no citation is an opinion` }
    if (typeof floor.advisory !== "string" || floor.advisory === "")
      return { refusal: `${origin}: floor for ${floor.package} names no advisory id — "vulnerable" must be a comparison against a published advisory, not a memory` }
    floors.push({
      package: floor.package,
      floor: floor.floor,
      advisory: floor.advisory,
      cve: floor.cve,
      vulnerable: floor.vulnerable,
      why: floor.why,
    })
  }
  if (floors.length === 0) return { refusal: `${origin} declares 0 floors — deleting the list is how this guard gets turned off quietly; if there is truly nothing to hold, delete the CI step too and say so` }
  return { floors }
}

export function parseManifest(text: string, origin: string): Declared[] | { readonly refusal: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { refusal: `${origin} is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  const record = parsed as { name?: unknown; dependencies?: unknown; devDependencies?: unknown }
  const declared: Declared[] = []
  for (const field of ["dependencies", "devDependencies"] as const) {
    const block = record[field]
    if (block === undefined) continue
    if (typeof block !== "object" || block === null) return { refusal: `${origin}.${field} is not an object` }
    for (const [name, spec] of Object.entries(block as Record<string, unknown>)) {
      if (typeof spec !== "string") return { refusal: `${origin} ${name} spec is not a string` }
      declared.push({ manifest: origin, name, spec })
    }
  }
  return declared
}

export type RunInput = {
  readonly contractText: string
  readonly contractOrigin: string
  readonly manifestTexts: readonly { readonly path: string; readonly text: string }[]
}

export type RunResult = { readonly exit: number; readonly lines: readonly string[] }

/**
 * The composition the CLI runs, with no filesystem access of its own: the caller hands over the bytes it
 * read, so a fixture directory and the real tree go through the identical path. A manifest that cannot be
 * parsed is a refusal rather than a skipped file — silently dropping the unreadable one is the "empty scan
 * that looks green" shape this file exists to prevent.
 */
export function run(input: RunInput): RunResult {
  const contract = parseContract(input.contractText, input.contractOrigin)
  if ("refusal" in contract) return { exit: 2, lines: [`CANNOT OBSERVE: ${contract.refusal}`, `remedy: keep ${input.contractOrigin} parseable, or delete this lane and name the reason`] }
  const declared: Declared[] = []
  for (const file of input.manifestTexts) {
    const manifest = parseManifest(file.text, file.path)
    if ("refusal" in manifest) return { exit: 2, lines: [`CANNOT OBSERVE: ${manifest.refusal}`] }
    declared.push(...manifest)
  }
  if (input.manifestTexts.length === 0)
    return { exit: 2, lines: [`CANNOT OBSERVE: no package manifests were handed to this check (0 of them), so nothing was looked at — that is not agreement`] }

  const { problems, notes, met } = checkFloors(contract.floors, declared)
  const lines = [
    `dependency-floors — ${contract.floors.length} floor(s) against ${input.manifestTexts.length} manifest(s) declaring ${declared.length} dependency/directive pair(s)`,
    ...describeProblems(problems, contract.floors),
    ...notes,
  ]
  if (problems.length > 0) {
    lines.push(`refusing: ${problems.filter((p) => p.kind === "below").length} manifest(s) ship below a cited floor, ${problems.filter((p) => p.kind === "unreadable").length} cannot be compared`)
    return { exit: 1, lines }
  }
  lines.push(`  ${met.length} declaration(s) meet their floor${notes.length ? `; ${notes.length} note(s)` : ""}`)
  return { exit: 0, lines }
}

if (import.meta.main) {
  const { readFileSync, readdirSync } = await import("node:fs")
  const { join, resolve, dirname } = await import("node:path")
  const here = dirname(import.meta.path)
  const productRoot = resolve(here, "..", "..", "..")
  const args = process.argv.slice(2)
  const flag = (name: string): string | undefined => {
    const index = args.indexOf(name)
    return index === -1 ? undefined : args[index + 1]
  }
  const contractPath = resolve(flag("--contract") ?? join(productRoot, "contracts", "dependency-floors.json"))
  const packagesDir = resolve(flag("--packages") ?? join(productRoot, "packages"))
  let contractText: string
  try {
    contractText = readFileSync(contractPath, "utf8")
  } catch (error) {
    console.log(`CANNOT OBSERVE: ${contractPath} could not be read (${error instanceof Error ? error.message : String(error)})`)
    process.exit(2)
  }
  let entries: string[]
  try {
    entries = readdirSync(packagesDir)
  } catch (error) {
    console.log(`CANNOT OBSERVE: ${packagesDir} could not be listed (${error instanceof Error ? error.message : String(error)})`)
    process.exit(2)
  }
  // A package directory without a package.json is skipped out loud: a workspace that disappears from the
  // scan would otherwise take its declarations with it and leave the floor looking satisfied.
  const manifestTexts: { path: string; text: string }[] = []
  const skipped: string[] = []
  for (const entry of entries) {
    const path = join(packagesDir, entry, "package.json")
    try {
      manifestTexts.push({ path, text: readFileSync(path, "utf8") })
    } catch {
      skipped.push(entry)
    }
  }
  const result = run({ contractText, contractOrigin: contractPath, manifestTexts })
  for (const line of result.lines) console.log(line)
  if (skipped.length > 0) console.log(`  ${skipped.length} directory/directories under packages/ carried no readable package.json: ${skipped.join(", ")}`)
  process.exit(result.exit)
}
