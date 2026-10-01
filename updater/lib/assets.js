/**
 * Spec §1 gate 3: a release carries the tarball **and** its checksum file, or
 * there is nothing to verify against. A release without `SHA256SUMS-<ver>.txt`
 * is treated as identical to one whose checksums do not match: refused.
 *
 * Names come straight out of `.github/workflows/release.yml`:
 *   `GlassPane-<ver>.tar.gz` and `SHA256SUMS-<ver>.txt`.
 */
import { CODES } from './codes.js'
import { UpdaterError } from './fsutil.js'
import { assertAssetUrl } from './source.js'

export const TARBALL_NAME = (version) => `GlassPane-${version}.tar.gz`
export const SUMS_NAME = (version) => `SHA256SUMS-${version}.txt`

/**
 * Gate 8's third asset: the **detached signature of the checksum file**.
 *
 * The name is not a guess — it is what `.github/workflows/release.yml` produces.
 * Its signing step loops
 *
 *     for f in "GlassPane-${VERSION}.tar.gz" "SHA256SUMS-${VERSION}.txt"; do
 *       gpg … --detach-sign --armor "$f"
 *     done
 *
 * and `gpg --detach-sign --armor FILE` with no `--output` writes `FILE.asc`, so
 * the asset this updater has to find is `SHA256SUMS-<ver>.txt.asc` — the sums
 * name with `.asc` appended, *not* a name this package invents. `test/
 * signature.test.mjs` re-derives it from the workflow text, so renaming the
 * artifact on either side reddens the pairing.
 *
 * Which of the two `.asc` files this gate reads: `SHA256SUMS-<ver>.txt.asc`,
 * because gate 4/5 trust exactly one row of that checksum file, and a signature
 * over it is what makes that row the publisher's own statement rather than the
 * first thing a downloader agreed with. A release that ships *only* the
 * tarball's signature therefore still lands as `unsigned-release` for this gate
 * (see `findSignatureAsset`), which is a deliberate asymmetry and is noted in
 * `updater/README.md` as the place the naming can drift.
 */
export const SIGNATURE_SUFFIX = '.asc'
export const SIGNATURE_NAME = (version) => `${SUMS_NAME(version)}${SIGNATURE_SUFFIX}`

/**
 * Gate 3's *optional* third asset. Unlike `requireAssetPair`, a missing
 * signature is not `assets-missing`: the release is well-formed and simply
 * predates the signing job (`v1.3.1` looks exactly like this). "Nothing to
 * verify" is a different claim from "the checksum file is missing", and it is
 * `signature.js`'s `unsigned-release` outcome to make — so this returns `null`
 * and lets the policy module say which of the two it was.
 *
 * What it does refuse, like gate 3: two assets with the same name (which one is
 * the signature?) and a URL off the pinned host (the bytes we would verify are
 * not the release's).
 */
export function findSignatureAsset(release, { version, base }) {
  const name = SIGNATURE_NAME(version)
  const hits = assetIndex(release).filter((asset) => asset.name === name)
  if (hits.length === 0) return null
  if (hits.length > 1) {
    throw new UpdaterError(
      CODES.assetsMissing,
      `release ${version} publishes ${hits.length} copies of ${name}; refusing to pick which one is the signature`,
    )
  }
  if (!hits[0].url) {
    throw new UpdaterError(CODES.assetsMissing, `release asset ${name} carries no download URL`)
  }
  return { name, url: assertAssetUrl(hits[0].url, { base }) }
}

/**
 * Normalise a GitHub release payload's asset list to `{ name, url, bytes }`.
 *
 * `bytes` is `assets[].size`, which the API really carries (measured on v1.5.1: 25,126,902 for the tarball,
 * 89 for the checksum file — the same numbers the CDN answers in `content-length`). It is kept because it is
 * the release's own statement of how long each file is, and a body that arrives shorter or longer than that
 * statement is not the file the release described, whatever its checksum then happens to match.
 */
export function assetIndex(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : []
  return assets
    .filter((a) => typeof a?.name === 'string')
    .map((a) => ({
      name: a.name,
      url: a.browser_download_url ?? a.url ?? null,
      bytes: Number.isSafeInteger(a?.size) && a.size >= 0 ? a.size : null,
    }))
}

/**
 * Both assets, present exactly once each, on an acceptable host.
 * Missing, duplicated, or unnamed-host ⇒ `assets-missing` / `asset-host-unpinned`.
 */
export function requireAssetPair(release, { version, base }) {
  const index = assetIndex(release)
  const wanted = [TARBALL_NAME(version), SUMS_NAME(version)]
  const found = {}
  for (const name of wanted) {
    const hits = index.filter((asset) => asset.name === name)
    if (hits.length === 0) {
      throw new UpdaterError(
        CODES.assetsMissing,
        `release ${version} has no ${name} (assets seen: ${index.map((a) => a.name).join(', ') || 'none'}). `
          + 'An archive with no checksum file is the same as a wrong checksum, so this release was not staged',
      )
    }
    if (hits.length > 1) {
      throw new UpdaterError(
        CODES.assetsMissing,
        `release ${version} publishes ${hits.length} copies of ${name}; refusing to pick one`,
      )
    }
    if (!hits[0].url) {
      throw new UpdaterError(CODES.assetsMissing, `release asset ${name} carries no download URL`)
    }
    found[name] = assertAssetUrl(hits[0].url, { base })
  }
  return {
    tarballName: wanted[0],
    sumsName: wanted[1],
    tarballUrl: found[wanted[0]],
    sumsUrl: found[wanted[1]],
    // The release's own claim about how long each file is (`null` when the payload says nothing). `check.js`
    // holds the bytes against it before it spends a hash on them.
    tarballBytes: index.find((asset) => asset.name === wanted[0])?.bytes ?? null,
    sumsBytes: index.find((asset) => asset.name === wanted[1])?.bytes ?? null,
  }
}
