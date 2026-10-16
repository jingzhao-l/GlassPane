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

export * as PublishShape from "./publish-shape"
