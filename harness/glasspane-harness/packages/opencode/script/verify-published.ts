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
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import product from "../../../product.json"
import { waitForRegistryVersion } from "./registry-readiness"

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
// `product.registry`, not `product.npm.registry`: the two fields existed side by side and only
// one of them was gated, so this lane could be pointed at a different registry than the one
// `publish.ts`, `postinstall.mjs` and `install.sh` pin — and a release verified against a mirror
// is a release nobody checked. `product-surface.mjs` now refuses if the two ever disagree.
const registry = product.registry
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

/**
 * What one `npm view` read actually established. npm exits non-zero for "the registry says this
 * version is not there" AND for ECONNRESET / ENOTFOUND / EAI_AGAIN / 429 / a proxy that answered
 * something else, so `if (seen.exitCode !== 0) missing.push(...)` was adjudicating a transport
 * failure as a bad release — the inverse of the three-state rule this file states at the top of
 * the block and already honours for the web-app check. Only `absent` may fail a release;
 * `unaskable` goes through exit 2 with its reason.
 *
 * The classification reads the registry's own answer from the error text rather than npm's exit
 * code, because the exit code is the same for all of them. E404 is the only one that is a fact
 * about the artifact.
 */
const npmAnswer = (
  exitCode: number,
  stdout: string,
  stderr: string,
): { state: "answered" | "absent" | "unaskable"; value: string } => {
  if (exitCode === 0) return { state: "answered", value: stdout.trim() }
  if (/code E404|404 Not Found/.test(stderr)) return { state: "absent", value: "the registry answers 404 for this version" }
  const lines = stderr.split("\n").filter((line) => line.trim() !== "")
  return { state: "unaskable", value: lines.length > 0 ? lines.slice(-2).join(" / ") : `npm exited ${exitCode} without a message` }
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
    // Ask the registry whether it can READ the version before asking it to INSTALL that version.
    // Measured 2026-10-20: this lane started 96 seconds after the publish job was accepted and npm
    // answered `ETARGET notarget No matching version found for glasspane-harness@0.9.1` — a red
    // named "install the published bytes and run them" for a read replica that had not caught up
    // with an artifact that had already been uploaded (npm's own notice: "Your package is being
    // processed and may take a few minutes to become available"; measured 12–20 min here). The
    // artifact was fine: that version installs today and its registry `dist.shasum` matches what CI
    // printed. "The previous job succeeded" is not the same claim as "this registry can serve it".
    const readiness = await waitForRegistryVersion({
      pkg: product.name,
      version,
      registry,
      probe: async () => {
        const look = await $`npm view ${product.name}@${version} version --registry ${registry}`
          .nothrow()
          .quiet(true)
        const answer = npmAnswer(look.exitCode, look.stdout.toString(), look.stderr.toString())
        if (answer.state === "answered") return answer.value
        // `absent` is the registry saying "not yet" about a fresh publish; `unaskable` is this
        // machine failing to ask, and the two must not be conflated — same split the file makes
        // for a 404 versus a proxy.
        if (answer.state === "absent") return undefined
        throw new Error(answer.value)
      },
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      note: (line) => console.log(`  waiting on the registry: ${line}`),
    })
    if (!readiness.ok) {
      cannotObserve(
        "the registry can read this published version",
        `${product.name}@${version} never became readable from ${registry} within ${Math.round(readiness.waitedMs / 60000)} min across ${readiness.attempts} look(s)${readiness.lastTransportError ? `; the last one failed to ask: ${readiness.lastTransportError}` : "; the registry kept answering that the version is not there yet"}`,
      )
      console.error(
        `verify-published: ${unobserved.length} check(s) could not be observed — NOTHING is concluded about the artifact, and this is not a pass`,
      )
      console.error("  the install was NOT attempted, so no claim is made about the bytes; re-run once the registry catches up")
      if (ownPrefix) rmSync(prefix, { recursive: true, force: true })
      process.exit(2)
    }
    // The observation is named whether or not it had to wait. Printing only
    // `ok npm install of the published package` left no record in a green log that the registry
    // was read first at all — and "it installed" is a different claim from "this registry could
    // serve this version", which is the whole reason the wait exists. `seen` is the version the
    // registry answered with, so the line also fails loudly if a read replica ever answers with
    // something other than the version this tag names.
    check(
      "the registry can read this published version",
      readiness.seen === version,
      `${product.name}@${readiness.seen} answered after ${readiness.attempts} look(s), ${Math.round(readiness.waitedMs / 1000)}s of waiting, from ${registry}`,
    )
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
    const couldNotAsk: string[] = []
    for (const [dep, depVersion] of optional) {
      const seen = await $`npm view ${dep}@${depVersion} version --registry ${registry}`.nothrow().quiet(true)
      const answer = npmAnswer(seen.exitCode, seen.stdout.toString(), seen.stderr.toString())
      if (answer.state === "unaskable") {
        couldNotAsk.push(`${dep}@${depVersion}: ${answer.value}`)
      } else if (answer.state === "absent") {
        missing.push(`${dep}@${depVersion} (${answer.value})`)
      } else if (answer.value !== depVersion) {
        missing.push(`${dep}@${depVersion} (registry answers ${JSON.stringify(answer.value)})`)
      }
    }
    // A read the registry never answered cannot exonerate the release either, and it must not
    // convict it: this is the lane whose red means "stop and fix the artifact", so a flaky
    // 429 or a dead DNS lookup has to leave the verdict unobserved (exit 2), not failed (exit 1).
    if (couldNotAsk.length > 0) {
      cannotObserve(
        "every platform package the wrapper declares is published at the version it names",
        `the registry could not be asked for ${couldNotAsk.length} of ${optional.length} declaration(s): ${couldNotAsk.join("; ")}. Re-run when the registry answers; nothing is concluded about those versions.`,
      )
    }
    if (couldNotAsk.length === 0) {
      check(
        "every platform package the wrapper declares is published at the version it names",
        optional.length > 0 && missing.length === 0,
        optional.length === 0
          ? "the installed wrapper declares no optionalDependencies at all — nothing resolves a binary for any platform"
          : missing.join("; "),
      )
    } else if (missing.length > 0) {
      // An answer that is bad for the release stays bad, whatever else could not be read.
      check("every platform package the wrapper declares is published at the version it names", false, missing.join("; "))
    }
    // What the registry vouches for these exact bytes. Integrity, not provenance: it says
    // the downloaded tarball is the one the registry records for this version, and nothing
    // about who built it — hence the separate note below.
    const dist = await $`npm view ${product.name}@${version} dist.integrity --registry ${registry}`
      .nothrow()
      .quiet(true)
    const distAnswer = npmAnswer(dist.exitCode, dist.stdout.toString(), dist.stderr.toString())
    if (distAnswer.state === "unaskable") {
      cannotObserve(
        "the published version carries a registry integrity hash",
        `npm view did not reach the registry (${distAnswer.value}). Nothing is concluded about the integrity field.`,
      )
    } else {
      check(
        "the published version carries a registry integrity hash",
        distAnswer.state === "answered" && distAnswer.value.startsWith("sha512-"),
        distAnswer.value || `npm view exit ${dist.exitCode}`,
      )
    }
    await reportProvenance()

    // The tree that built this artifact and the artifact itself are different witnesses.
    // `script/patched-deps.mjs --check` reads the *install* — it is what caught, on 2026-10-23, that
    // `bun install` had silently dropped `@modelcontextprotocol/sdk`'s patchedDependencies entry while
    // bumping 1.31.0→1.32.0, leaving the MCP client without 404 session recovery, request abort, or the
    // per-item `callTool` overloads both harnesses' verdicts rest on. That gate cannot see the release:
    // the build job installs on its own machine, from its own runner image. So the lane that already
    // installs the published bytes asks the same question of them — and reuses the same implementation
    // rather than writing a second criterion that could drift.
    //
    // The demand list is derived from the declared patch file, filtered to what a bundler provably
    // cannot rename: added string literals and added method names. Measured on the published 0.10.1
    // binary (sha256 equal to the asset digest GitHub computes), that is 8 of 8 present; the three
    // wider rules — every added line, every introduced identifier, added lines plus call names — all
    // had false misses (`.d.ts` content, renamed locals like `isSessionRetry`, erased module
    // specifiers), so they are not the rule. One package is named rather than the declarations swept
    // because 18 of this fork's 19 declared patches add no string literal or method name at all — for
    // those the artifact can be asked nothing, and the gate that could ask something is the
    // line-by-line one that reads the install.
    const patchGate = fileURLToPath(new URL("../../../script/patched-deps.mjs", import.meta.url))
    let artifactBytes = ""
    try {
      artifactBytes = realpathSync(bin)
    } catch {
      artifactBytes = ""
    }
    if (!artifactBytes || !existsSync(patchGate)) {
      cannotObserve(
        "the published bytes carry the fork's MCP SDK patch",
        artifactBytes
          ? `the patch gate is not at ${patchGate} — the criterion could not be run, which says nothing about the artifact`
          : `the installed command ${bin} does not resolve to a file, so there were no bytes to read`,
      )
    } else {
      const gate = await $`${process.execPath} ${patchGate} --artifact ${artifactBytes} --package @modelcontextprotocol/sdk`.nothrow()
      const gateOutput = `${gate.stdout?.toString() ?? ""}${gate.stderr?.toString() ?? ""}`.trim().split("\n")
      const rc = gate.exitCode ?? -1
      if (rc === 0) check("the published bytes carry the fork's MCP SDK patch", true, gateOutput.at(-1) ?? "")
      else if (rc === 1) check("the published bytes carry the fork's MCP SDK patch", false, gateOutput.slice(-3).join(" / "))
      else
        cannotObserve(
          "the published bytes carry the fork's MCP SDK patch",
          `the gate answered "cannot measure" (exit ${rc}): ${gateOutput.at(-1) ?? "(no output)"}`,
        )
    }

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
