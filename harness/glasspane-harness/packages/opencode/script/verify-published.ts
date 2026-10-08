#!/usr/bin/env bun
/**
 * verify-published.ts — "published" is not "works".
 *
 *   cd packages/opencode && bun run script/verify-published.ts [version]
 *
 * A release lane that only checks `npm publish`'s exit code has verified nothing a
 * user cares about: the wrapper's postinstall resolves a platform package, places
 * the real binary, and the command runs. This script does exactly the user's path:
 * install the **published tarball** into a throwaway prefix, run `--version`, and
 * (on macOS) confirm the embedded web app is actually served by that binary.
 *
 * Why it is not in CI by default: it needs the registry and a writable temp prefix,
 * so it belongs to the release lane (and to any release done by hand), not to a PR.
 * The PR-time counterpart is `publish.ts --dry-run`, which validates package shape
 * without touching the registry.
 */
import { $ } from "bun"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import product from "../../../product.json"

const version = process.argv[2] ?? product.version
const registry = product.npm?.registry ?? "https://registry.npmjs.org"
const failures: string[] = []
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures.push(label)
}

if (process.platform !== "darwin") {
  // This used to assert `install.exitCode !== 0` and call that "npm refuses because of
  // the os field". Any failure satisfies that — offline, a TLS proxy, a 404, npm missing
  // (exit 127) — so the lane printed a green check for a cause it had not established, on
  // every non-macOS host. The product is macOS-only, so on another host the honest output
  // is "nothing was verified here", with its own exit code.
  console.error(`verify-published: host is ${process.platform}; this product is macOS-only and NOTHING was verified`)
  console.error("  Run it on macOS to exercise the install path a user actually takes.")
  process.exit(2)
}

/** Reported, never asserted: whether the registry can show a provenance attestation. */
async function reportProvenance() {
  // `.quiet(true)`: a release log that buries its own verdict under the registry's whole
  // metadata blob is a log nobody reviews. The value is still read from stdout. (This bun's
  // typings take a boolean here, not the `"ignore"` string; `bun run typecheck` caught the
  // string form and it is fixed rather than cast.)
  const meta = await $`npm view ${product.name}@${version} --registry ${registry} --json`
    .nothrow()
    .quiet(true)
  if (meta.exitCode !== 0) {
    console.log("note: could not read registry metadata — provenance NOT checked here")
    return
  }
  console.log(
    /\bprovenance\b/.test(meta.stdout.toString())
      ? "note: the registry lists a provenance attestation for this version (the attestation's own content is not checked by this lane)"
      : "note: the registry lists NO provenance attestation for this version",
  )
}

const prefix = mkdtempSync(path.join(tmpdir(), "gp-verify-"))
try {
  // The registry is named explicitly: "the registry I happen to be pointed at serves
  // something runnable" is a weaker claim than "the published artifact installs", and an
  // ambient mirror or a lagging read replica must not be what a release verdict rests on.
  console.log(`installing the published ${product.name}@${version} from ${registry} into a throwaway prefix`)
  // `-g --prefix`, not a bare `--prefix`: a local install creates **no** bin links,
  // so "is the command there?" would fail for a reason that has nothing to do with the
  // package. (The first run of this script failed exactly that way, which is the reason
  // the comment exists.)
  const install = await $`npm install -g --registry ${registry} --prefix ${prefix} ${product.name}@${version}`.nothrow()
  if (install.exitCode !== 0) {
    check("npm install of the published package", false, install.stderr.toString().split("\n").slice(-3).join(" "))
    throw new Error("install failed")
  }
  check("npm install of the published package", true)

  // Every command the product ships, not just the first. `gp-harness` is a second bin of
  // the same binary; a wrapper whose extra bin still resolves to the placeholder is a
  // release that half works, and the old single-`product.binary` check could not see it.
  const bins = product.bins?.length ? product.bins : [product.binary]
  for (const binName of bins) {
    const bin = path.join(prefix, "bin", binName)
    check(`the command ${binName} exists in the prefix`, existsSync(bin), bin)
    if (!existsSync(bin)) continue
    const run = await $`${bin} --version`.nothrow()
    const shown = run.stdout.toString().trim()
    // The placeholder `publish.ts` leaves behind prints an apology on stderr and exits 1
    // when postinstall never ran. Reading stdout only made that an empty version string;
    // the exit code is asserted as well, so a stub cannot pass by being quiet.
    check(
      `${binName} --version reports the published version`,
      run.exitCode === 0 && shown === version,
      `exit ${run.exitCode}, output ${shown || "(none)"}`,
    )
    if (binName !== product.binary) continue

    check(
      "the package's os/cpu gate matches the product's platform block",
      product.platform?.os?.includes("darwin") === true,
      `os=${JSON.stringify(product.platform?.os)}`,
    )
    // What the registry vouches for these exact bytes. Integrity, not provenance: it says
    // the downloaded tarball is the one the registry records for this version, and nothing
    // about who built it — hence the separate note below.
    const dist = await $`npm view ${product.name}@${version} dist.integrity --registry ${registry}`
      .nothrow()
      .quiet(true)
    check(
      "the published version carries a registry integrity hash",
      dist.exitCode === 0 && dist.stdout.toString().trim().startsWith("sha512-"),
      dist.stdout.toString().trim() || `exit ${dist.exitCode}`,
    )
    await reportProvenance()

    // The embedded web app: the companion surface that only exists if the bundle
    // really travelled into the binary.
    const port = 4500 + Math.floor(Math.random() * 300)
    const server = Bun.spawn([bin, "serve", "--port", String(port)], { stdout: "pipe", stderr: "pipe" })
    try {
      let served = false
      let detail = "no response"
      for (let i = 0; i < 30; i++) {
        await Bun.sleep(500)
        const response = await fetch(`http://127.0.0.1:${port}/`).catch(() => undefined)
        if (!response?.ok) continue
        const body = await response.text()
        const type = response.headers.get("content-type") ?? ""
        // `<html` alone is satisfied by an error page. The doctype plus a bundled asset
        // reference is what this binary serves when the web assets really are embedded.
        const hasAssets = /(?:src|href)="\/?assets\//i.test(body)
        served = type.includes("text/html") && /<!doctype html>/i.test(body) && hasAssets
        detail = `content-type=${type || "(none)"} doctype=${/<!doctype html>/i.test(body)} assets=${hasAssets ? "referenced" : "absent"}`
        if (served) break
      }
      check("the installed binary serves the embedded web app", served, detail)
    } finally {
      server.kill()
    }
  }
} finally {
  rmSync(prefix, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`verify-published: ${failures.length} check(s) failed — the release is NOT good, regardless of what npm said`)
  process.exit(1)
}
console.log(`verify-published: ${product.name}@${version} installs, every shipped command reports its version, and the web app is served`)
