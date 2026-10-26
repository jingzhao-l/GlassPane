/**
 * The verdict half of `script/verify-published.ts`'s platform-package gate, as a pure function.
 *
 * WHY IT IS OUT OF verify-published.ts: that script runs its checks the moment it is imported —
 * the same known property that made `registry-readiness.ts` and `publish-shape.ts` siblings — so
 * nothing can import it to ask a question about one of its steps. The step held here is the one
 * that was always true. Its verdict read
 * `pulls.length === served.length && served.every((line) => line.includes(`@${version}`))`, where
 * `served` is the array of FORMATTED LOG LINES (`${name}@${seen} in ${one.attempts} look(s), …`)
 * built next to it. Two independent failures, both real: a served version that merely STARTS with
 * the wanted one substring-matched its own log line — `0.11.14` contains `@0.11.1` — so the gate
 * declared a healthy release for an artifact whose optionalDependency can never resolve to the
 * bytes that were tagged, which is the v0.7.6 class the block's own comment names; and
 * `pulls.length === served.length` was structurally always true at that point, because the loop
 * either pushes a line or exits through `notServed`. The verdict has to compare the registry's
 * ACTUAL answers, not their rendering.
 *
 * What `want` is, and why there is no range logic here: it is the value the published wrapper's
 * `optionalDependencies` declares for the package, read back from the registry. `script/publish.ts`
 * builds those values as the plain version string (`declaredPlatforms` maps every entry of
 * product.json's `platformTargets` to `version` itself — no `^`, no `~`, no ranges), and
 * product.json's `publishPolicy` states the guarantee in words: every platform package is published
 * at the SAME version as the wrapper, and the wrapper's `optionalDependencies` are derived from the
 * target matrix, never hand-written. So this lane asserts exactly that guarantee and nothing more:
 * a declaration that is not the plain release version is a wrapper that does not match what the
 * release script produces, and an answer that is not the plain release version is bytes the tag
 * never named. Both are red, both are named. Inventing a semver-satisfies implementation would
 * assert LESS than the release script guarantees, and is not done.
 */
export interface PullResolution {
  /** The platform package's name, as the published wrapper declares it. */
  readonly name: string
  /** The version the wrapper's optionalDependencies told the installer to fetch. */
  readonly want: string
  /** The version string the registry actually answered with for that package. */
  readonly seen: string
}

/** Every way a set of resolved pulls fails to be "this registry serves exactly this release". */
export function pullExactnessProblems(release: string, resolved: readonly PullResolution[]): string[] {
  const problems: string[] = []
  for (const one of resolved) {
    if (one.want !== release) {
      problems.push(`${one.name}: the published wrapper declares ${JSON.stringify(one.want)}, but the release script pins every platform package to the plain version ${release}`)
    }
    if (one.seen !== release) {
      problems.push(`${one.name}: the registry answered ${JSON.stringify(one.seen)}, which is not the ${release} this release tagged`)
    }
  }
  return problems
}

export * as PullExactness from "./pull-exactness"
