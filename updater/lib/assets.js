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

/** Normalise a GitHub release payload's asset list to `{ name, url }`. */
export function assetIndex(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : []
  return assets
    .filter((a) => typeof a?.name === 'string')
    .map((a) => ({ name: a.name, url: a.browser_download_url ?? a.url ?? null }))
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
  }
}
