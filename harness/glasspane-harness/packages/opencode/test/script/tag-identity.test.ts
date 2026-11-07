import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * Fixed points for `script/tag-identity.sh` — the half of the release chain that asks WHO raised the
 * ref rather than what the ref contains.
 *
 * WHY THIS SCRIPT, AND WHY ITS BATTERY ASKS ABOUT BOTH CHAINS. The judgement used to be ~50 lines of
 * inline bash inside `version-check`, a job conditioned on `github.event_name == 'push'`. The npm half
 * of a release is a different trigger (`workflow_dispatch` → `publish-gate` → `publish-platform` →
 * `publish-wrapper`), so the two chains shared a version number and shared no check: a tag that no key
 * of ours signed, pointing at bytes trunk never carried, could be dispatched onto the registry by any
 * actor holding `contents: write`. Every gate in that chain was self-consistent and none of them asked
 * across — the same shape as v0.13.0's half-publish.
 *
 * A fixture keyring is built for real (throwaway `GNUPGHOME`, throwaway git repo with a local bare
 * `origin`) rather than by stubbing `gpg`, because the thing under test IS the three-condition
 * judgement on gpg's own status output: GOODSIG, VALIDSIG, and the fingerprint equal to the one the
 * installer names. A stub that always answers "good signature" would grade a missing verification as
 * a pass — which is the failure mode this file exists to close. The refusal branches are driven by
 * changing the INPUTS (lightweight tag, unsigned tag, a named fingerprint that is not the signer's, an
 * installer with no key block), not by faking the tool.
 *
 * REVERSE: make the script print `tag identity held` before checking VALIDSIG ⇒ ③ and ④ go red;
 * delete the fingerprint comparison ⇒ ④ goes red; return early when `objecttype` is not `tag` ⇒ ②
 * goes red; drop the `exit 2` for an unnamed tag ⇒ ① goes red.
 */
const SCRIPT = path.join(import.meta.dir, "../../../../script/tag-identity.sh")
const RELEASE_YML = path.join(import.meta.dir, "../../../../.github/workflows/release.yml")
const KEYRING_PARENT = mkdtempSync(path.join(tmpdir(), "gp-tagid-keyrings-"))

let gpgHome: string
let signerFpr: string
let armoredPub: string
let repo: string
let repoRoot: string
let installSh: string

function gpg(args: string[]) {
  return spawnSync("gpg", ["--batch", "--pinentry-mode", "loopback", "--passphrase", "", ...args], {
    encoding: "utf8",
    env: { ...process.env, GNUPGHOME: gpgHome },
    timeout: 60_000,
  })
}

function git(args: string[], cwd = repo) {
  return spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, GNUPGHOME: gpgHome, GPG_TTY: "" },
    timeout: 60_000,
  })
}

/** Raise a tag of a given shape in the fixture repo and push it to the fixture `origin`. */
function makeTag(name: string, shape: "lightweight" | "unsigned" | "signed") {
  if (shape === "lightweight") {
    const made = git(["tag", name])
    expect(made.status, `fixture could not make a lightweight tag: ${made.stderr}`).toBe(0)
  } else if (shape === "unsigned") {
    const made = git(["tag", "-a", "-m", "fixture", name])
    expect(made.status, `fixture could not make an unsigned annotated tag: ${made.stderr}`).toBe(0)
  } else {
    // One argv per `-c` assignment: `["-c", "user.signingkey", fpr]` is not a config pair, it is a
    // malformed one, and git then creates nothing — the failure surfaces three tests later as an
    // unrelated push error.
    const made = git(["-c", `user.signingkey=${signerFpr}`, "-c", "gpg.program=gpg", "tag", "-s", "-m", "fixture", name])
    expect(made.status, `fixture could not make a signed tag: ${made.stdout}${made.stderr}`).toBe(0)
  }
  const pushed = git(["push", "origin", `refs/tags/${name}`])
  expect(pushed.status, `fixture could not push ${name}: ${pushed.stderr}`).toBe(0)
  // The script fetches the tag from `origin` and then asks the local repository about it, exactly as
  // the runner does after a `checkout` that only carries the commit; delete the local ref so a stale
  // local copy can never be what the judgement actually read.
  git(["update-ref", "-d", `refs/tags/${name}`])
}

function writeInstaller({ fpr, keyBlock }: { fpr: string | null; keyBlock: string | null }) {
  const lines = ["#!/bin/sh", "# fixture installer, shape taken from the real scripts/install.sh"]
  if (fpr !== null) lines.push(`GLASSPANE_HARNESS_SIGNING_FPR="${fpr}"`)
  if (keyBlock !== null) lines.push(keyBlock.trimEnd())
  writeFileSync(installSh, `${lines.join("\n")}\n`, "utf8")
  chmodSync(installSh, 0o755)
}

function run(tag?: string) {
  const args = tag === undefined ? [] : [tag]
  const result = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, ROOT: repo, INSTALL_SH: installSh, GITHUB_REF_NAME: tag ?? "" },
  })
  return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` }
}

beforeAll(() => {
  gpgHome = path.join(KEYRING_PARENT, "gnupg")
  mkdirSync(gpgHome, { mode: 0o700 })
  const generated = gpg(["--quick-generate-key", "GlassPane Fixture <fixture@example.invalid>", "default", "default", "never"])
  expect(generated.status, `fixture key generation failed: ${generated.stderr}`).toBe(0)

  const listed = gpg(["--with-colons", "--list-secret-keys"])
  expect(listed.status).toBe(0)
  const fprLine = listed.stdout.split("\n").find((line) => line.startsWith("fpr:"))
  expect(fprLine, "gpg answered no fingerprint").toBeDefined()
  // The SECRET key ring lists the key's own fpr in field 10 (the same field the release lane reads);
  // taking the first `fpr:` line instead would grab the primary key's, which is the one that signs a
  // tag — so this is the value `git tag -s` must be pointed at.
  signerFpr = (fprLine ?? "").split(":")[9].toUpperCase()
  expect(signerFpr).toHaveLength(40)

  const exported = gpg(["--armor", "--export", signerFpr])
  expect(exported.status).toBe(0)
  armoredPub = exported.stdout

  const root = mkdtempSync(path.join(tmpdir(), "gp-tagid-repo-"))
  repoRoot = root
  repo = path.join(root, "work")
  const bare = path.join(root, "origin.git")
  spawnSync("git", ["init", "--bare", "-q", bare])
  mkdirSync(repo, { recursive: true })
  git(["init", "-q", "."])
  git(["remote", "add", "origin", bare])
  mkdirSync(path.join(repo, "scripts"), { recursive: true })
  installSh = path.join(repo, "scripts/install.sh")
  writeFileSync(path.join(repo, "product.json"), JSON.stringify({ version: "0.0.0-fixture" }), "utf8")
  git(["add", "-A"])
  git(["commit", "-q", "-m", "fixture"])
  const pushed = git(["push", "-q", "origin", "HEAD"])
  expect(pushed.status, `fixture could not seed origin: ${pushed.stderr}`).toBe(0)
  writeInstaller({ fpr: signerFpr, keyBlock: armoredPub })
}, 120_000)

afterAll(() => {
  // Both scratch trees go away, not just the keyring. `repoRoot` holds a bare `origin.git`, a work
  // tree and the fixture installer carrying the exported key, and it used to survive every run: the
  // cleanup named one of the two `mkdtempSync` calls, so four of these directories piled up per suite
  // while the ledger claimed the battery cleans after itself. The assertions are the point — a
  // `rmSync` that silently fails (a `gpg-agent` still holding a path, a permission error) would
  // otherwise leave the leak restored and the run still green.
  rmSync(KEYRING_PARENT, { recursive: true, force: true })
  rmSync(repoRoot, { recursive: true, force: true })
  expect(existsSync(KEYRING_PARENT), `keyring scratch survived: ${KEYRING_PARENT}`).toBe(false)
  expect(existsSync(repoRoot), `repo scratch survived: ${repoRoot}`).toBe(false)
})

describe("the identity of the ref a release is cut from", () => {
  test("① no tag named is a refusal to check, not a silent pass", () => {
    const { code, out } = run()
    expect(code).toBe(2)
    expect(out).toContain("no tag named")
  })

  test("② a lightweight tag has no signature to attribute", () => {
    writeInstaller({ fpr: signerFpr, keyBlock: armoredPub })
    makeTag("v0.0.0-light", "lightweight")
    const { code, out } = run("v0.0.0-light")
    expect(code).toBe(1)
    expect(out).toContain("not an annotated tag")
    // The remedy has to be something the reader can run, not a description of the defect.
    expect(out).toContain("git tag -s v0.0.0-light")
  })

  test("③ an annotated but UNSIGNED tag is the same refusal as a lightweight one", () => {
    writeInstaller({ fpr: signerFpr, keyBlock: armoredPub })
    makeTag("v0.0.0-unsigned", "unsigned")
    const { code, out } = run("v0.0.0-unsigned")
    expect(code).toBe(1)
    expect(out).toContain("no armored signature block")
  })

  test("④ a signature from a key the installer does not name is refused by fingerprint", () => {
    makeTag("v0.0.0-signed", "signed")
    // Same armored public key, a different named constant: this is what "the trust anchor moved" looks
    // like from the inside, and the judgement must fall on the VALIDSIG fingerprint, not on the fact
    // that a signature verified at all.
    writeInstaller({ fpr: "0123456789ABCDEF0123456789ABCDEF01234567", keyBlock: armoredPub })
    const { code, out } = run("v0.0.0-signed")
    expect(code).toBe(1)
    expect(out).toContain("not by the fingerprint")
    expect(out).toContain(signerFpr)
  })

  test("⑤ the named key signing the tag is the one pass, and it says which key proved it", () => {
    writeInstaller({ fpr: signerFpr, keyBlock: armoredPub })
    const { code, out } = run("v0.0.0-signed")
    expect(code).toBe(0)
    expect(out).toContain("tag identity held")
    expect(out).toContain(signerFpr)
  })

  test("⑥ an installer whose trust-anchor line moved shape is a refusal, not a guess", () => {
    makeTag("v0.0.0-signed2", "signed")
    writeInstaller({ fpr: null, keyBlock: armoredPub })
    const { code, out } = run("v0.0.0-signed2")
    expect(code).toBe(1)
    expect(out).toContain("could not read GLASSPANE_HARNESS_SIGNING_FPR")
  })

  test("⑦ an installer carrying no public key cannot attribute anything", () => {
    writeInstaller({ fpr: signerFpr, keyBlock: null })
    const { code, out } = run("v0.0.0-signed2")
    expect(code).toBe(1)
    expect(out).toContain("carries no armored PGP public key")
  })
})

describe("both release chains consume the one implementation", () => {
  const source = () => readFileSync(RELEASE_YML, "utf8")

  test("the push chain and the dispatch chain call the same script", () => {
    const yml = source()
    // The defect this file closes was a rule that existed in exactly one job. Asserting two call sites
    // is what keeps it closed: a future edit that deletes the dispatch-chain step goes red here, while
    // every content assertion above stays green.
    const calls = yml.split("\n").filter((line) => line.trim() === "bash script/tag-identity.sh")
    expect(calls.length, "tag-identity.sh is not called by both chains").toBe(2)
    const anchors = yml.split("\n").filter((line) => line.trim() === "node script/tree-anchor.mjs")
    expect(anchors.length, "tree-anchor.mjs is not called by both chains").toBe(2)
  })

  test("no inline copy of the judgement survived in either chain", () => {
    const yml = source()
    // A pasted copy would let the two chains drift apart again while both "call the script" lines
    // exist somewhere in the file. The decisive strings are the ones only the inline version had.
    expect(yml).not.toContain("git cat-file tag")
    expect(yml).not.toContain("--status-fd 2 --verify tag.sig")
    expect(yml).not.toContain("tag identity held")
  })
})
