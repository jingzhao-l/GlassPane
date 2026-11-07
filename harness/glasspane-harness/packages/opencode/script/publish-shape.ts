/**
 * The identity half of `script/publish.ts`'s tarball gate, as a pure function.
 *
 * WHY IT IS OUT OF publish.ts: that file acquires a publish lock, chdirs into its own
 * package and writes `dist/` the moment it is imported, so nothing can import it to ask a
 * question about it. A check nobody can drive with a fixture is a check nobody has seen
 * fail — which is how the name assertion in this file spent months comparing a manifest
 * with the string read out of that same manifest, and could only ever be green.
 */
export interface IdentityInput {
  /** The `name`/`version` pair as the tarball's own `package.json` states it. */
  readonly manifest: { name?: unknown; version?: unknown }
  /** The directory the packer put that manifest in (`dist/<dirName>`). */
  readonly dirName: string
  /** The version the product is publishing (`product.json`'s, not the manifest's). */
  readonly expectedVersion: string
  /** Every package name this product publishes: the wrapper plus product.json's target matrix. */
  readonly allowedNames: readonly string[]
}

export function validatePackageIdentity(input: IdentityInput): string[] {
  const problems: string[] = []
  const { manifest, dirName, expectedVersion, allowedNames } = input

  if (manifest.version !== expectedVersion) {
    problems.push(`package.json version ${JSON.stringify(manifest.version)} != product version ${expectedVersion}`)
  }
  // Two independent sources, neither of them the manifest: the directory the packer wrote it
  // into, and the target matrix the product declares. The check this replaces asked the
  // manifest to agree with a value taken from the manifest.
  if (manifest.name !== dirName) {
    problems.push(
      `package.json name ${JSON.stringify(manifest.name)} != the dist directory it was packed from ${JSON.stringify(dirName)}`,
    )
  }
  if (typeof manifest.name !== "string" || !allowedNames.includes(manifest.name)) {
    problems.push(
      `${JSON.stringify(manifest.name)} is not a package this product publishes — allowed names are [${allowedNames.join(", ")}]. Refusing to publish an undeclared name.`,
    )
  }
  return problems
}

/**
 * The exec-bit half of `script/publish.ts`'s tarball gate, as a pure function.
 *
 * WHY IT IS OUT OF publish.ts too: same reason as `validatePackageIdentity` — publish.ts takes a
 * publish lock, chdirs into its package and writes `dist/` the moment it is imported, so the check
 * has to live somewhere a fixture can drive it and see it fire.
 *
 * The mode check used to be written inline as `if (mode !== undefined && (mode & 0o111) === 0)`,
 * which asserts the exec bit ONLY when the `tar -tvzf` listing produced a parseable mode for the
 * member. When the listing came back empty or garbled — exactly the state the check exists to catch —
 * `mode` was `undefined`, the `!== undefined` short-circuit skipped the branch, and the run printed
 * "packs cleanly". A check that degrades to PASS when it cannot observe is the failure this
 * repository keeps being burned by, and the sibling `published()` / `verify-published.ts` already
 * answer it with a deliberate third verdict ("unaskable"). Here the unreadable mode is a NAMED
 * problem, not a skipped assertion.
 */
export interface ExecBitInput {
  /** Human label for the member, as the release lane should name it in a refusal. */
  readonly label: string
  /** The member path relative to the extraction root, exactly as `tar -tvzf` lists it. */
  readonly member: string
  /** The tarball the listing came from — named in the refusal so the reader can re-run the command. */
  readonly tarball: string
  /** The `tar -tvzf` output split into its non-empty lines. */
  readonly listing: readonly string[]
  /** Optional clause appended to the "not executable" problem, to preserve the caller's wording. */
  readonly reason?: string
}

/** A symbolic 9-bit permission string (`rwxr-xr-x`) → numeric mode, as both GNU and BSD tar print it. */
export function symbolicToMode(bits: string): number {
  let mode = 0
  for (const [index, flag] of ["r", "w", "x", "r", "w", "x", "r", "w", "x"].entries()) {
    if (bits[index] === flag) mode |= 1 << (8 - index)
  }
  return mode
}

export function validateExecBit(input: ExecBitInput): string[] {
  const { label, member, tarball, listing, reason } = input
  const line = listing.find((entry) => entry.endsWith(` ${member}`))
  if (!line) {
    return [`${label} is not named by \`tar -tvzf ${tarball}\` (the listing holds ${listing.length} line(s); none ends with member ${member}) — its exec bit cannot be read, so "the shipped file is executable" is unproven. Refusing to pass on a listing this check could not read.`]
  }
  const field = line.trim().split(/\s+/)[0]
  // A first column shorter than type + nine bits carries no permission string to parse.
  if (field.length < 10) {
    return [`${label} has no permission field in \`tar -tvzf ${tarball}\` (the first column is ${JSON.stringify(field)}, too short to carry nine mode bits) — the exec bit is unreadable, which is a failure, not a skipped assertion.`]
  }
  const mode = symbolicToMode(field.slice(1, 10))
  if ((mode & 0o111) === 0) {
    return [`${label} is not executable in the tarball (mode ${(mode & 0o777).toString(8)})${reason ? ` — ${reason}` : ""}`]
  }
  return []
}

export * as PublishShape from "./publish-shape"
