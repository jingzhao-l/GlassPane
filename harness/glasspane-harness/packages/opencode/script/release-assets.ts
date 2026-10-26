/**
 * Whether this run may write assets onto a GitHub release.
 *
 * `script/build.ts` uploads with `gh release upload … --clobber`. That flag is what lets a re-run of
 * a failed `binaries` job replace its own half-built asset, and the release lane depends on it: the
 * tag is pushed, `create-release` makes a DRAFT, both platform jobs build, `checksums` signs, and
 * only `publish-release` flips the release public. So a draft is a workspace, and clobbering inside
 * it is the intended behaviour.
 *
 * A public release is not. Re-dispatching `release.yml` on a tag whose release is already public
 * would replace the bytes that a published version number names, while npm — which is the channel
 * most users install from — refuses the same version a second time and leaves its tarballs alone.
 * The result is one version number describing two sets of bytes, with only one of them matching the
 * registry, and `SHA256SUMS.txt` re-signed over the new pair. `create-release` already refuses the
 * differing-anchor case; this is the sibling hole it does not cover.
 *
 * "Could not ask" is its own answer. A release whose visibility is unknown is not a release that is
 * known to be draft, and uploading on that assumption is how an irreversible overwrite happens
 * because a token lacked `contents: read`.
 */
export type ReleaseVisibility = "draft" | "published" | "unaskable"

export type AssetUploadDecision =
  | { readonly ok: true; readonly why: string }
  | { readonly ok: false; readonly message: string; readonly remedy: string }

export function assetUploadDecision(state: ReleaseVisibility, tag: string): AssetUploadDecision {
  if (state === "draft") return { ok: true, why: `${tag} is a draft: this run is the one assembling it` }
  if (state === "published") {
    return {
      ok: false,
      message: `${tag} is already public, so its assets are the bytes that version number names — uploading with --clobber would replace them while the registry keeps the tarballs it already refused to re-publish`,
      remedy: `cut the next version instead: change product.json's version, re-run the release chain from that tag. To repair the assets of ${tag} without moving the version, delete the release's asset and re-run the binaries job with the draft restored (\`gh release edit ${tag} --draft=true --repo <repo>\`) — and know that a re-download of that tag then no longer gives the bytes an earlier reader got`,
    }
  }
  return {
    ok: false,
    message: `this run could not tell whether ${tag} is draft or public, and "unknown" is not "draft"`,
    remedy: `check what the release actually is with \`gh release view ${tag} --json isDraft --repo <repo>\`; a token that cannot read releases is fixed with \`gh auth status\`, not by uploading anyway`,
  }
}

/**
 * The gh answer mapped onto the three states. `isDraft` is read as a boolean because `gh` prints
 * `true`/`false` in JSON, and a missing field is `unaskable` rather than `false` — a silent default
 * to "draft" would be this function authorising the overwrite it exists to refuse.
 */
export function visibilityFromGhOutput(raw: string, exitCode: number): ReleaseVisibility {
  if (exitCode !== 0) return "unaskable"
  try {
    const read = JSON.parse(raw) as { isDraft?: unknown }
    if (typeof read.isDraft === "boolean") return read.isDraft ? "draft" : "published"
    return "unaskable"
  } catch {
    return "unaskable"
  }
}
