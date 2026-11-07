#!/usr/bin/env bash
# tag-identity.sh — prove a tag is a SIGNED tag made by the key the installer names.
#
# WHY THIS MOVED OUT OF THE WORKFLOW. The judgement existed as ~50 lines of inline bash inside
# `version-check`, which runs only on a `push` event. The npm half of this release is a separate
# trigger (`workflow_dispatch` -> `publish-gate` -> `publish-platform` -> `publish-wrapper`), and
# nothing in that chain ever asked who raised the ref. So the two chains shared a version number and
# shared nothing else: a tag pointing at bytes trunk never carried, signed by nobody the product
# trusts, could be dispatched straight onto the registry by any actor with `contents: write`.
# That is the "同一份状态两边各写一份实现" failure in its release-chain form — the rule was written
# once, in one job, and the second job silently disagreed with it. The fix is not to paste a copy:
# a copy is how the gap came back the next time somebody edits one of the two. Both chains now call
# this file, so the rule has one implementation and one test battery.
#
# `git verify-tag` is still not used, for the same reason the inline version abandoned it: the
# runner checkout does not guarantee the tag ref nor a key on the default keyring, so the tag object
# is fetched by name, its armored signature and canonical payload are split apart, and gpg is asked
# directly with `--status-fd` — GOODSIG, VALIDSIG, and the fingerprint equal to the one
# `scripts/install.sh` pins. No best-effort: a tag this script cannot attribute exits 1.
#
# Usage: tag-identity.sh [tag]
#   TAG defaults to $GITHUB_REF_NAME (what the push chain knows). `INSTALL_SH` defaults to
#   `scripts/install.sh` under the repo root, which is where the trust anchor actually lives.
set -euo pipefail

TAG="${1:-${GITHUB_REF_NAME:-}}"
if [ -z "$TAG" ]; then
  echo "tag-identity: no tag named — pass it as argv 1 or set GITHUB_REF_NAME. Refusing to check \"nothing\"." >&2
  exit 2
fi
ROOT="${ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}"
INSTALL_SH="${INSTALL_SH:-$ROOT/scripts/install.sh}"

# The fetch writes into the repository the caller is standing in; the local test battery points
# `ROOT` at a fixture repo, CI leaves it at the checkout.
git -C "$ROOT" fetch --no-tags --force origin "refs/tags/${TAG}:refs/tags/${TAG}"
OBJECT_TYPE="$(git -C "$ROOT" for-each-ref --format='%(objecttype)' "refs/tags/${TAG}")"
if [ "$OBJECT_TYPE" != "tag" ]; then
  echo "::error::${TAG} is not an annotated tag (objecttype=${OBJECT_TYPE:-the ref is not readable here}), so there is no signature to attribute. A pointer with no signature behind it is not provenance: it can be re-pointed by any actor with write access and nothing here would notice. Remedy: git tag -s ${TAG} -m <message>."
  exit 1
fi
want_fpr="$(sed -n 's/^GLASSPANE_HARNESS_SIGNING_FPR="\(.*\)"/\1/p' "$INSTALL_SH")"
if [ -z "$want_fpr" ]; then
  echo "::error::could not read GLASSPANE_HARNESS_SIGNING_FPR out of scripts/install.sh — the installer's trust anchor moved shape and this gate refuses to publish under a guessed one"
  exit 1
fi
# Key material lives in its own directory, never in the scanned checkout: writing
# `signer.asc` next to the served assets is what made v0.14.0's flip step read its OWN key as
# an orphan sidecar and refuse (correctly) to publish. Measured, not theorised.
keys="$(mktemp -d)"
chmod 700 "$keys"
awk '/-----BEGIN PGP PUBLIC KEY BLOCK-----/{f=1} f{print} /-----END PGP PUBLIC KEY BLOCK-----/{exit}' "$INSTALL_SH" > "$keys/signer.asc"
if [ ! -s "$keys/signer.asc" ]; then
  echo "::error::scripts/install.sh carries no armored PGP public key, so there is no key to attribute the tag to"
  exit 1
fi
gnupg="$(mktemp -d)"
chmod 700 "$gnupg"
if ! GNUPGHOME="$gnupg" gpg --batch --quiet --import < "$keys/signer.asc"; then
  echo "::error::gpg could not import the signing key embedded in scripts/install.sh — the tag cannot be attributed, so the release is not made"
  exit 1
fi
work="$(mktemp -d)"
chmod 700 "$work"
trap 'rm -rf "$work" "$keys" "$gnupg"' EXIT
git -C "$ROOT" cat-file tag "refs/tags/${TAG}" > "$work/tag.obj"
awk '/-----BEGIN PGP SIGNATURE-----/{f=1} f{print}' "$work/tag.obj" > "$work/tag.sig"
awk '/-----BEGIN PGP SIGNATURE-----/{exit} {print}' "$work/tag.obj" > "$work/tag.payload"
if [ ! -s "$work/tag.sig" ] || [ ! -s "$work/tag.payload" ]; then
  echo "::error::the tag object carries no armored signature block beside its payload — it is annotated but unsigned, which is the same refusal as a lightweight tag"
  exit 1
fi
STATUS="$(GNUPGHOME="$gnupg" gpg --batch --status-fd 2 --verify "$work/tag.sig" "$work/tag.payload" 2>&1 || true)"
# here-string, not a pipe: `grep -q` leaves on its first match, and a piped producer dies of
# EPIPE once the bytes pass the pipe buffer — pipefail would turn the refusal into a 141 and
# the reader could not tell "no good signature" from "the check could not finish".
grep -q '^\[GNUPG:\] GOODSIG' <<<"$STATUS" || {
  echo "::error::gpg does not call the signature on ${TAG} a good signature. Refusing rather than publishing under an unverifiable ref."
  exit 1; }
signer_fpr="$(printf '%s\n' "$STATUS" | sed -n 's/^\[GNUPG:\] VALIDSIG \([0-9A-F]*\) .*/\1/p' | tail -1)"
# `tr`, not `${var^^}`: the expansion form is bash 4+, and a gate whose comparison line dies of
# a shell-version difference is a gate that changes answer when the image moves.
if [ "$(printf '%s' "$signer_fpr" | tr 'a-z' 'A-Z')" != "$(printf '%s' "$want_fpr" | tr 'a-z' 'A-Z')" ]; then
  echo "::error::${TAG} was signed by ${signer_fpr:-nothing readable}, not by the fingerprint scripts/install.sh pins (${want_fpr}). A tag signed by another key is not this product's tag."
  exit 1
fi
echo "tag identity held: ${TAG} is a signed tag whose signature validates against the key scripts/install.sh embeds and names (${want_fpr})"\n