#!/usr/bin/env bun
/**
 * verify-published.ts — "published" is not "works".
 *
 *   cd packages/opencode && bun run script/verify-published.ts [version] [--prefix <dir>]
 *
 * A release lane that only checks `npm publish`'s exit code has verified nothing a
 * user cares about: the wrapper's postinstall resolves a platform package, places
 * the real binary, and the command runs. This script does exactly the user's path:
 * install the **published tarball** into a throwaway prefix, run `--version`, and
 * (on macOS) confirm the embedded web app is actually served by that binary.
 *
 * `--prefix <dir>` runs the same checks against an install that already exists, and says
 * out loud that the install step was skipped. It exists because the install is the slow
 * part (21 minutes measured on the 2026-10-12 run) and because the web-app verdict needs a
 * negative control: the only way to show the check can go red is to point it at a prefix
 * whose server serves something that is not the embedded app. `harness/tools/
 * verify-published-selftest.sh` does exactly that with a fake prefix.
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

// `--prefix` is a flag with a value, so it must not be read as the version. Everything
// positional that is not the flag's argument is the version, and a second one is refused:
// silently ignoring `verify-published.ts 0.7.5 0.7.4` would verify one release and name
// another in the log.
const argv = process.argv.slice(2)
const flagAt = argv.indexOf("--prefix")
const givenPrefix = flagAt === -1 ? undefined : argv[flagAt + 1]
if (flagAt !== -1 && !givenPrefix) {
  console.error("verify-published: --prefix needs a directory")
  process.exit(2)
}
// The flag's own argument is not positional, but only when the flag is present: `flagAt + 1`
// is `0` when it is not, and a filter that excluded index 0 unconditionally would drop the
// version from `verify-published.ts 0.7.5` and then verify `product.json`'s version while
// printing the one it was handed. `harness/tools/verify-published-selftest.sh` carries a case
// that names a version the manifest does not have, which is what catches that shape.
const positional = argv.filter((a, i) => a !== "--prefix" && !(flagAt !== -1 && i === flagAt + 1))
if (positional.length > 1) {
  console.error(`verify-published: more than one version named (${positional.join(", ")}) — verify one release per run`)
  process.exit(2)
}

const version = positional[0] ?? product.version
const registry = product.npm?.registry ?? "https://registry.npmjs.org"
const failures: string[] = []
const unobserved: string[] = []
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures.push(label)
}
/**
 * A check the machine made impossible. It is neither a pass nor a bad release, and calling
 * it either of those twice did damage: a 15s wall budget reported the published 0.7.5 as a
 * bad release on a loaded host (2026-10-11), and the day before that the same check said
 * "no response" about a binary that answered after 36s. A release lane that cries wolf gets
 * its red ignored, so the honest third verdict gets its own exit code — the one this file
 * already uses when the host cannot run the product at all.
 */
const cannotObserve = (label: string, detail: string) => {
  console.log(`NOT OBSERVED  ${label} — ${detail}`)
  unobserved.push(label)
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

const prefix = givenPrefix === undefined ? mkdtempSync(path.join(tmpdir(), "gp-verify-")) : path.resolve(givenPrefix)
const ownPrefix = givenPrefix === undefined
try {
  if (ownPrefix) {
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
  } else {
    console.log(
      `verifying the existing install at ${prefix} — the npm install step is skipped because --prefix named it, and the package it holds is NOT re-checked against the registry`,
    )
  }

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

    // The gate has to read the bytes that were *installed*. This asserted
    // `product.platform.os.includes("darwin")` — the product's declaration compared with
    // itself, red only if someone edited product.json (which breaks the build anyway), and
    // it never looked at `cpu` despite saying so in its own label. A wrapper published with a
    // missing or wrong `os` field — the thing that makes npm refuse Linux/Windows installs for
    // this product — passed here.
    const installedManifest = path.join(prefix, "lib", "node_modules", product.name, "package.json")
    const wantOs = [...(product.platform?.os ?? [])].sort()
    const wantCpu = [...(product.platform?.arch ?? [])].sort()
    let gate = ""
    let gateSeen = `no manifest at ${installedManifest}`
    const optional: Array<[string, string]> = []
    try {
      const installed = await Bun.file(installedManifest).json()
      gateSeen = `os=${JSON.stringify(installed.os)} cpu=${JSON.stringify(installed.cpu)} version=${JSON.stringify(installed.version)}`
      // Both sides go through the same normalisation: a field the tarball dropped entirely
      // reads as `[]` (a mismatch, not a crash), and neither side wins by having been
      // pre-sorted already. The form this replaced spread an `unknown` — tsgo refused it
      // (`TS2488: Type '{}' must have a [Symbol.iterator]()`) and the package's typecheck
      // went red, which is the gate this product runs per-package on every batch.
      const norm = (v: unknown) => JSON.stringify((Array.isArray(v) ? v : []).slice().sort())
      const same = (a: unknown, b: unknown) => norm(a) === norm(b)
      const mismatches: string[] = []
      if (!same(installed.os, wantOs)) mismatches.push(`os is ${JSON.stringify(installed.os)}, product declares ${JSON.stringify(wantOs)}`)
      if (!same(installed.cpu, wantCpu)) mismatches.push(`cpu is ${JSON.stringify(installed.cpu)}, product declares ${JSON.stringify(wantCpu)}`)
      if (installed.version !== version) mismatches.push(`the manifest says ${installed.version}, the version asked for was ${version}`)
      gate = mismatches.join("; ")
      for (const [dep, depVersion] of Object.entries((installed.optionalDependencies ?? {}) as Record<string, string>)) {
        optional.push([dep, depVersion])
      }
    } catch (error) {
      gate = `unreadable: ${error instanceof Error ? error.message : String(error)}`
    }
    check("the installed package's os/cpu/version gates match the product's platform block", gate === "", `${gateSeen}${gate ? ` — ${gate}` : ""}`)
    // Every platform package the wrapper *names* has to exist at that version, or the
    // optionalDependency is silently unsatisfiable: npm installs the wrapper successfully,
    // places no binary for that machine, and every gate that only looks at this host stays
    // green. Measured on the real 0.7.6 publish — the job printed
    // `+ glasspane-harness-darwin-x64@0.7.6`, its provenance reached the sigstore transparency
    // log, the run exited 0, and the registry's own metadata for that package still listed
    // `latest: 0.7.5` with no 0.7.6 at all. On an Intel Mac that is an install with no
    // command, and `verify-published` passing on arm64 could not have seen it.
    const missing: string[] = []
    for (const [dep, depVersion] of optional) {
      const seen = await $`npm view ${dep}@${depVersion} version --registry ${registry}`.nothrow().quiet(true)
      if (seen.exitCode !== 0) missing.push(`${dep}@${depVersion} (npm view exit ${seen.exitCode})`)
      else if (seen.stdout.toString().trim() !== depVersion) missing.push(`${dep}@${depVersion} (registry answers ${JSON.stringify(seen.stdout.toString().trim())})`)
    }
    check(
      "every platform package the wrapper declares is published at the version it names",
      optional.length > 0 && missing.length === 0,
      optional.length === 0
        ? "the installed wrapper declares no optionalDependencies at all — nothing resolves a binary for any platform"
        : missing.join("; "),
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
      // Drained in the background so a chatty server cannot fill the pipe and stall.
      const logged: string[] = []
      const drain = async (stream: ReadableStream<Uint8Array>) => {
        const decoder = new TextDecoder()
        const reader = stream.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          logged.push(decoder.decode(value, { stream: true }))
        }
      }
      void drain(server.stdout)
      void drain(server.stderr)
      // A give-up bound, not the criterion. Measured on the published 0.7.5 at load average
      // 88 (2026-10-12, 07:00): the same binary that answers with a real 2,884-byte
      // `<!doctype html>` page took **326s** to print its `listening on` line, because
      // paging in a 108 MB single-file build competes with two typechecks and a fork-diff.
      // So the wait is long enough for a loaded machine to be given the benefit of the
      // doubt, and when it expires the answer is "not observed", never "the release is bad"
      // — the bundle question is only answerable once the server has spoken.
      const listeningCap = Number(process.env.GLASSPANE_VERIFY_LISTENING_POLLS ?? 1800) // 900s
      if (!Number.isFinite(listeningCap) || listeningCap < 1) {
        console.error(`verify-published: GLASSPANE_VERIFY_LISTENING_POLLS=${process.env.GLASSPANE_VERIFY_LISTENING_POLLS} is not a poll count`)
        process.exit(2)
      }
      let listening = false
      for (let i = 0; i < listeningCap && !(listening = logged.join("").includes("listening on")); i++) {
        await Bun.sleep(500)
      }
      let served = false
      let detail = "no response"
      const polls = listening ? 40 : 0
      for (let i = 0; i < polls; i++) {
        const response = await fetch(`http://127.0.0.1:${port}/`).catch(() => undefined)
        if (response?.ok) {
          const body = await response.text()
          const type = response.headers.get("content-type") ?? ""
          // `<html` alone is satisfied by an error page. The doctype plus a bundled asset
          // reference is what this binary serves when the web assets really are embedded.
          const hasAssets = /(?:src|href)="\/?assets\//i.test(body)
          served = type.includes("text/html") && /<!doctype html>/i.test(body) && hasAssets
          detail = `waited ${(i + 1) * 0.5}s, content-type=${type || "(none)"} doctype=${/<!doctype html>/i.test(body)} assets=${hasAssets ? "referenced" : "absent"}`
          if (served) break
        }
        await Bun.sleep(500)
      }
      if (!served) {
        // Two earlier versions of this check both confused the machine with the release.
        // The first printed only "no response"; the second kept the same 30 × 500 ms wall
        // budget and merely *described* the difference — so on a loaded host it still called
        // a good release bad. Measured 2026-10-11 on the published 0.7.5: the binary answers
        // with a real 2,884-byte `<!doctype html>` page, but it took **36s** to get there
        // while nine concurrent `tool-surface` runs pushed the load average past 70, and
        // the 15s budget expired. The criterion is the server's own "listening on" line (an
        // event, so a slow boot cannot fake it), and the two ways to not get there are now
        // two different verdicts: the server said it was listening and still will not serve
        // the page is a bad release; the server never said anything is an unobserved claim.
        const tail = logged.join("").trim().split("\n").slice(-3).join(" / ").slice(0, 300)
        if (listening) {
          detail = `the server reported listening on :${port} but ${polls * 0.5}s of polling produced no valid embedded page — ${detail || "no response"}; that is a real serving failure${tail ? ` (server output: ${tail})` : ""}`
          check("the installed binary serves the embedded web app", false, detail)
        } else {
          cannotObserve(
            "the installed binary serves the embedded web app",
            `no "listening on" line within ${listeningCap * 0.5}s, so the page was never even attempted. This says nothing about the bundle. Re-run on a quieter machine, or by hand: ${bin} serve --port 4814; curl -s http://127.0.0.1:4814/ | head -c 200${tail ? ` (server output: ${tail})` : ""}`,
          )
        }
      } else {
        check("the installed binary serves the embedded web app", true, detail)
      }
    } finally {
      server.kill()
    }
  }
} finally {
  if (ownPrefix) rmSync(prefix, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`verify-published: ${failures.length} check(s) failed — the release is NOT good, regardless of what npm said`)
  process.exit(1)
}
if (unobserved.length > 0) {
  // Exit 2 with the checks that did pass listed, because "the install works" and "the bundle
  // was seen" are different claims and a lane that collapses them has already lied once.
  console.error(`verify-published: ${unobserved.length} check(s) could not be observed on this machine — NOTHING is concluded about them, and this is not a pass`)
  console.error(`  observed good: ${product.name}@${version} installed and reported its version`)
  console.error("  Re-run this lane when the load average is down, or run the hand command printed above.")
  process.exit(2)
}
console.log(`verify-published: ${product.name}@${version} installs, every shipped command reports its version, and the web app is served`)
