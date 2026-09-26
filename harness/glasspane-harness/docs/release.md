# Releasing

How a version actually ships: bump, tag, publish, then verify what was published. The
npm channel is primary; the GitHub release assets are the installer's fallback.

## Before the first npm publish from CI: trusted publishing

npm's **Trusted Publisher** (OIDC) is what lets the release workflow publish without a
long-lived npm token sitting in GitHub secrets. Each package needs one connection
configured on npmjs.com, and it must match the workflow exactly.

For this repository, the values are fixed by `.github/workflows/release.yml`:

| Field in npmjs.com | Value |
| --- | --- |
| Registry | npmjs.com |
| Provider | GitHub Actions |
| Organization or user | `jingzhao-l` |
| Repository name | `glasspane-harness` |
| Workflow filename | `release.yml` (the file in `.github/workflows/`, not a path) |
| Environment name | `release` |

The publishing jobs carry `environment: release` and `permissions: id-token: write`,
so those two lines in the workflow exist precisely to match the form above. The
environment is also the place to require a reviewer, which is the human half of the gate.

To configure it, for each of the three packages
(`glasspane-harness`, `glasspane-harness-darwin-arm64`, `glasspane-harness-darwin-x64`):

1. Sign in to npmjs.com as `jingzhao-l`.
2. Open the package → **Settings** → **Trusted Publisher** (under "Access", next to
   Collaborators).
3. Choose **GitHub Actions**, then fill in the five fields above.
4. Tick **Automatically publish to npmjs** (or, if you want the two-step flow, leave
   that off and use `npm stage publish` / `npm stage approve` — the workflow falls back
   to staging when a direct publish is refused, and prints the stage id).
5. Save.

The same thing from a terminal, if you have a token that is allowed to change package
settings:

```bash
npm trust github glasspane-harness          --file release.yml --repo jingzhao-l/glasspane-harness --env release --allow-publish --allow-stage-publish
npm trust github glasspane-harness-darwin-arm64 --file release.yml --repo jingzhao-l/glasspane-harness --env release --allow-publish --allow-stage-publish
npm trust github glasspane-harness-darwin-x64   --file release.yml --repo jingzhao-l/glasspane-harness --env release --allow-publish --allow-stage-publish
npm trust list glasspane-harness          # read back
```

Things worth knowing, because they are the usual way this is set up wrong:

- **npm does not validate the configuration when you save it.** A typo surfaces as a
  publish failure, not a form error. After configuring, run one real publish.
- **The fields are case-sensitive and exact**, and the workflow name is the *calling*
  workflow. Our publish is a `workflow_dispatch` on `release.yml`, so `release.yml` is
  the name to use.
- `npm trust list` / `npm trust revoke` need interactive-equivalent auth; a token that
  bypasses 2FA gets `403` on trust endpoints, which is why this is an owner step and not
  an automated one.
- Connections cannot be edited: delete and recreate. Up to 10 per package.
- Cloud-hosted runners only (ours are `macos-13`/`macos-14`/`ubuntu-latest` — fine).
- Until this is configured, publishing from CI is not possible; publish from a machine
  with `npm login` and a granular access token, or add the environment secrets and skip
  the OIDC path.


## Cutting a release

1. **Bump the version** in `product.json` only. `packages/opencode/package.json` follows
   it (`check-version` fails the build if they disagree, and the build fails if you edit
   the second one alone). Then update `CHANGELOG.md`.

   ```bash
   # from the fork root
   $EDITOR product.json CHANGELOG.md
   node ../../tools/product-surface.mjs      # manifest, build, publish, installers, pipelines agree
   node ../../scripts/check-doc-links.mjs
   ```

2. **Commit** with the golden records in the same commit as the tree changes:

   ```bash
   node ../../tools/fork-diff.mjs --record
   node ../../tools/tool-surface.mjs --record
   node ../../tools/brand-surface.mjs --record
   git add -A && git commit -m "harness: v0.4.0"
   ```

3. **Push, then sync the split** (the published repository is a subtree of this monorepo):

   ```bash
   git push origin harness/fork-import
   git subtree split --prefix=harness/glasspane-harness -b split/glasspane-harness
   git push --force https://github.com/jingzhao-l/glasspane-harness.git \
     split/glasspane-harness:refs/heads/main
   ```

4. **Tag** the same tree that is on `main` — the tag *is* the release identity:

   ```bash
   git push --force https://github.com/jingzhao-l/glasspane-harness.git \
     split/glasspane-harness:refs/tags/v0.4.0
   ```

   The tag push fires `release.yml`, which builds the two macOS targets, checksums them,
   and (only for a `workflow_dispatch`, dry by default) publishes. Asset publishing is a
   separate manual dispatch.

5. **Publish to npm** — either let the workflow do it:

   ```
   gh workflow run release.yml -f publish_npm=true -f confirm=true
   ```

   or from a machine with a token, which is the path that works before trusted publishing
   is configured:

   ```bash
   cd packages/opencode
   bun run build                      # two targets: darwin-arm64, darwin-x64
   bun run script/publish.ts --dry-run  # validate every tarball, publish nothing
   bun run script/publish.ts            # platform packages, then the wrapper
   ```

6. **Verify what was published.** The npm registry can serve a stale read replica for a
   few minutes after an accepted publish, so verify with the CLI (which is authoritative),
   and then run the end-to-end check:

   ```bash
   npm view glasspane-harness@0.4.0 version --prefer-online
   cd packages/opencode && bun run script/verify-published.ts
   ```

   `verify-published` installs the *published* tarball into a throwaway prefix, runs
   `--version`, and checks the embedded web app is served by that binary. A green publish
   with a red `verify-published` is a broken release, not a noisy one.

7. **Deprecate, do not unpublish.** If a version turns out to be broken, publish a fixed
   one and `npm deprecate` the bad version with the reason in the message. Unpublishing
   burns the version number for everyone who already has it.

## Assets (the installer's fallback)

`install.sh` prefers npm and only reaches for a release asset when npm is unavailable. The
assets are built by the `binaries` job with `OPENCODE_RELEASE=1`; they are named
`glasspane-harness-<platform>-<version>.tar.gz`. If the asset lane is still queued on
macOS runners, that is fine: npm is the channel that has to work, and the installer's npm
path does not depend on it.
