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
const failures: string[] = []
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures.push(label)
}

if (process.platform !== "darwin") {
  // The product is macOS-only; on another host the install is refused by npm's own
  // os field, which is itself worth asserting rather than skipping.
  console.log(`note: host is ${process.platform}; verifying the refusal path instead`)
  const out = await $`npm install -g --dry-run --prefix ${tmpdir()}/gp-verify ${product.name}@${version}`.nothrow()
  check(
    "npm refuses the install on a non-macOS host (os field)",
    out.exitCode !== 0,
    `exit ${out.exitCode}`,
  )
  process.exit(failures.length > 0 ? 1 : 0)
}

const prefix = mkdtempSync(path.join(tmpdir(), "gp-verify-"))
try {
  console.log(`installing the published ${product.name}@${version} into a throwaway prefix`)
  // `-g --prefix`, not a bare `--prefix`: a local install creates **no** bin links,
  // so "is the command there?" would fail for a reason that has nothing to do with
  // the package. (The first run of this script failed exactly that way, which is
  // the reason the comment exists.)
  const install = await $`npm install -g --prefix ${prefix} ${product.name}@${version}`.nothrow()
  if (install.exitCode !== 0) {
    check("npm install of the published package", false, install.stderr.toString().split("\n").slice(-3).join(" "))
    throw new Error("install failed")
  }
  check("npm install of the published package", true)

  const bin = path.join(prefix, "bin", product.binary)
  check("the command exists in the prefix", existsSync(bin), bin)
  if (!existsSync(bin)) throw new Error("no binary")

  const shown = (await $`${bin} --version`.nothrow()).stdout.toString().trim()
  check("`--version` reports the published version", shown === version, shown || "(no output)")
  check(
    "the package's os/cpu gate matches the product's platform block",
    product.platform?.os?.includes("darwin") === true,
    `os=${JSON.stringify(product.platform?.os)}`,
  )

  // The embedded web app: the companion surface that only exists if the bundle
  // really travelled into the binary.
  const port = 4500 + Math.floor(Math.random() * 300)
  const server = Bun.spawn([bin, "serve", "--port", String(port)], { stdout: "pipe", stderr: "pipe" })
  try {
    let served = false
    for (let i = 0; i < 30; i++) {
      await Bun.sleep(500)
      const response = await fetch(`http://127.0.0.1:${port}/`).catch(() => undefined)
      if (response?.ok) {
        const body = await response.text()
        served = body.includes("<!doctype html") || body.includes("<html")
        if (served) break
      }
    }
    check("the installed binary serves the embedded web app", served)
  } finally {
    server.kill()
  }
} finally {
  rmSync(prefix, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`verify-published: ${failures.length} check(s) failed — the release is NOT good, regardless of what npm said`)
  process.exit(1)
}
console.log(`verify-published: ${product.name}@${version} installs, reports its version, and serves the web app`)
