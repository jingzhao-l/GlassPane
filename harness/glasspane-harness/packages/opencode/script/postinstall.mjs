#!/usr/bin/env node

import childProcess from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"
import { createHash } from "crypto"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"))

const platformMap = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
}
const archMap = {
  x64: "x64",
  arm64: "arm64",
  arm: "arm",
}

const platform = platformMap[os.platform()] ?? os.platform()
const arch = archMap[os.arch()] ?? os.arch()
// Product identity lives in product.json at the repo root; product-surface.mjs
// keeps these constants in step with it (this file ships inside the npm wrapper).
const base = `glasspane-harness-${platform}-${arch}`
const sourceBinary = platform === "windows" ? "glasspane-harness.exe" : "glasspane-harness"
// Same rule as the names above: the value lives in product.json (`npm.registry`), and
// harness/tools/product-surface.mjs is what keeps this literal from drifting away from it.
const REGISTRY = "https://registry.npmjs.org"
const targetBinary = path.join(__dirname, "bin", "glasspane-harness.exe")

// The installable platform packages are the target matrix, never an enumeration of possible
// suffixes. product.json holds that matrix and script/publish.ts seals it into this wrapper's
// own optionalDependencies (its --dry-run refuses a wrapper whose list disagrees), so both
// copies are the same declared set by construction. Read product.json the same way
// script/build.ts does — at the fork root, three directories above this file — which holds in
// the repo and in installer-selftest fixtures; inside an installed wrapper that path does not
// exist and the sealed optionalDependencies are the matrix's only surviving copy there. A
// foreign product.json three directories above node_modules (a project that happens to ship
// one) is rejected by the name check below, never obeyed.
const declaredNames = (() => {
  const namesFromMatrix = (matrix) =>
    matrix.map((target) =>
      [
        packageJson.name,
        target.os === "win32" ? "windows" : target.os,
        target.arch,
        target.avx2 === false ? "baseline" : undefined,
        target.abi ?? undefined,
      ]
        .filter(Boolean)
        .join("-"),
    )
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "product.json"), "utf8"))
    if (parsed?.name === packageJson.name && Array.isArray(parsed.platformTargets) && parsed.platformTargets.length > 0) {
      return namesFromMatrix(parsed.platformTargets)
    }
  } catch {
    // not in a repo checkout — fall through to the sealed manifest
  }
  return Object.keys(packageJson.optionalDependencies ?? {})
})()

function supportsAvx2() {
  if (arch !== "x64") return false

  if (platform === "linux") {
    try {
      return /(^|\s)avx2(\s|$)/i.test(fs.readFileSync("/proc/cpuinfo", "utf8"))
    } catch {
      return false
    }
  }

  if (platform === "darwin") {
    try {
      const result = childProcess.spawnSync("sysctl", ["-n", "hw.optional.avx2_0"], {
        encoding: "utf8",
        timeout: 1500,
      })
      if (result.status !== 0) return false
      return (result.stdout || "").trim() === "1"
    } catch {
      return false
    }
  }

  if (platform === "windows") {
    const command =
      '(Add-Type -MemberDefinition "[DllImport(""kernel32.dll"")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);" -Name Kernel32 -Namespace Win32 -PassThru)::IsProcessorFeaturePresent(40)'

    for (const executable of ["powershell.exe", "pwsh.exe", "pwsh", "powershell"]) {
      try {
        const result = childProcess.spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Command", command], {
          encoding: "utf8",
          timeout: 3000,
          windowsHide: true,
        })
        if (result.status !== 0) continue
        const output = (result.stdout || "").trim().toLowerCase()
        if (output === "true" || output === "1") return true
        if (output === "false" || output === "0") return false
      } catch {
        continue
      }
    }
  }

  return false
}

function isMusl() {
  if (platform !== "linux") return false

  try {
    if (fs.existsSync("/etc/alpine-release")) return true
  } catch {
    // Ignore filesystem probes that are blocked by the host.
  }

  try {
    const result = childProcess.spawnSync("ldd", ["--version"], { encoding: "utf8" })
    return `${result.stdout || ""}${result.stderr || ""}`.toLowerCase().includes("musl")
  } catch {
    return false
  }
}

function packageNames() {
  const baseline = arch === "x64" && !supportsAvx2()

  const candidates = (() => {
    if (platform === "linux") {
      if (isMusl()) {
        if (arch === "x64")
          return baseline
            ? [`${base}-baseline-musl`, `${base}-musl`, `${base}-baseline`, base]
            : [`${base}-musl`, `${base}-baseline-musl`, base, `${base}-baseline`]
        return [`${base}-musl`, base]
      }

      if (arch === "x64")
        return baseline
          ? [`${base}-baseline`, base, `${base}-baseline-musl`, `${base}-musl`]
          : [base, `${base}-baseline`, `${base}-musl`, `${base}-baseline-musl`]
      return [base, `${base}-musl`]
    }

    if (arch === "x64") return baseline ? [`${base}-baseline`, base] : [base, `${base}-baseline`]
    return [base]
  })()

  // Only a declared package can be installed (installPackage already refuses to run npm for a
  // name with no sealed version, so everything filtered here was ever just an unsatisfiable
  // fallback — naming one in the failure advice sent the reader to a package this product does
  // not publish), and a no-AVX2 x64 machine can only run a baseline build (the plain x64 build
  // needs AVX2; product.json's platform.dropped records that darwin-x64-baseline was dropped
  // by decision, so on such a machine the honest answer is the refusal below, not the plain
  // package that would not start). An empty list means "this machine has no build to install".
  return candidates.filter((name) => {
    if (!declaredNames.includes(name)) return false
    return !baseline || name.endsWith("-baseline") || name.endsWith("-baseline-musl")
  })
}

function machineLabel() {
  const parts = [`${platform}-${arch}`]
  if (platform === "linux" && isMusl()) parts.push("musl")
  if (arch === "x64" && !supportsAvx2()) parts.push("without AVX2")
  return parts.join(" ")
}

/**
 * Which copies this run may load, and what has to be true of them before one is executed.
 *
 * This used to be `require.resolve(`${name}/package.json`)`. That walks every `node_modules`
 * ABOVE this wrapper — out of the project, through the home directory, to `/` — and consults
 * `NODE_PATH`, so a package planted in an ancestor directory, or in any directory an environment
 * variable names, satisfied it. The only thing then said about those bytes was `--version` string
 * equality, which a 3-line shell script answers. This is the channel that copies a binary next to
 * the user's PATH, chmods it 0755 and runs it.
 *
 * Three separate statements are required now, none of them self-reported by the candidate:
 *  1. it sits inside THIS install's tree. The boundary is the outermost `node_modules` path
 *     component of the wrapper's own realpath, which is the project's (or the global prefix's)
 *     store and nothing above it — so every layout a manager really produces is inside it (npm
 *     hoisting to the project's `node_modules`, npm nesting under the wrapper, pnpm's `.pnpm`
 *     symlink farm, bun's isolated links), while an ancestor `node_modules` and a `NODE_PATH`
 *     detour are outside it by construction. This is derived from the path, not from a walk:
 *     `/Users/me/node_modules` is not a component of `/Users/me/app/node_modules/glasspane-harness`.
 *  2. its `package.json` names this package at the exact version this wrapper seals in its own
 *     `optionalDependencies` — a claim about the package, made by the manifest that npm resolved
 *     for this install, not about what the binary chooses to print.
 *  3. when the tree keeps an install record — `node_modules/.package-lock.json`, which npm writes
 *     for project installs (measured absent for `npm install -g`, pnpm and bun) — that record must
 *     name this directory, this version, an `sha512-` integrity and the `${name}-${version}.tgz`
 *     tarball it was unpacked from. A directory that exists but is not in the record was not
 *     placed by this install, which is precisely the pre-positioned-package case.
 * A copy that fails any of these is not installed; the caller then does its own registry-pinned
 * fetch, which is the branch that can still prove what it received.
 */
/**
 * The two directories a manager may have placed this wrapper's platform package in, and the tree
 * that bounds them. `nestedTree` is the wrapper's own `node_modules` (npm nests a copy there when
 * the hoisted one cannot be used, and every test fixture and pack directory is this shape);
 * `boundary` is the outermost `node_modules` component of the wrapper's own path — the project's
 * or the global prefix's store — which is where a hoisted npm copy, pnpm's `.pnpm` farm and bun's
 * isolated links all live. A wrapper that is not itself inside a `node_modules` has no boundary,
 * and then only its nested tree can be loaded from.
 */
function installTrees() {
  const own = fs.realpathSync(__dirname)
  const nestedTree = path.join(own, "node_modules")
  const segments = own.split(path.sep)
  let boundary = null
  for (let index = 1; index < segments.length; index++) {
    if (segments[index] === "node_modules") boundary = segments.slice(0, index + 1).join(path.sep)
  }
  return { nestedTree, boundary }
}

function candidateDirs(name) {
  const own = fs.realpathSync(__dirname)
  const dirs = [path.join(own, "node_modules", name)]
  const parent = path.dirname(own)
  if (path.basename(parent) === "node_modules") dirs.push(path.join(parent, name))
  return dirs
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"))
}

/** npm's own record of this tree, for this exact directory. Absent record: null, absent entry: a refusal. */
function installRecord(pkgDir, name, version) {
  const { nestedTree, boundary } = installTrees()
  const root = boundary ?? nestedTree
  const file = path.join(root, ".package-lock.json")
  if (!fs.existsSync(file)) return { state: "no-record", detail: `${file} does not exist (npm -g, pnpm and bun write no install record)` }
  let record
  try {
    record = readJson(file)
  } catch (error) {
    return { state: "refuse", detail: `${file} could not be read: ${error instanceof Error ? error.message : String(error)}` }
  }
  const key = `node_modules/${path.relative(root, pkgDir).split(path.sep).join("/")}`
  const entry = record?.packages?.[key]
  if (!entry) return { state: "refuse", detail: `${key} is not recorded in ${file}, so this install did not place it` }
  if (entry.version !== version) {
    return { state: "refuse", detail: `${file} records ${key} at ${entry.version}, this wrapper seals ${version}` }
  }
  if (!/^sha512-/.test(String(entry.integrity ?? ""))) {
    return { state: "refuse", detail: `${file} records no sha512 integrity for ${key}` }
  }
  // npm's own layout for a registry tarball: `<registry>/<name>/-/<basename>-<version>.tgz`, where
  // the basename drops the `@scope/` prefix. Shape read off a real `npm install` record on this
  // machine (`node_modules/@parcel/watcher-darwin-arm64` → resolved
  // `https://registry.npmjs.org/@parcel/watcher-darwin-arm64/-/watcher-darwin-arm64-2.5.1.tgz`).
  const url = String(entry.resolved ?? "")
  if (!url.includes(`/${name}/-/`) || !url.endsWith(`-${version}.tgz`)) {
    return { state: "refuse", detail: `${file} records ${key} as arriving from ${JSON.stringify(url)}, not the ${name}@${version} tarball` }
  }
  return { state: "recorded", detail: `${key} is recorded here as ${name}@${version} from ${entry.resolved}` }
}

function resolveBinary(name) {
  const declaredVersion = packageJson.optionalDependencies?.[name]
  if (!declaredVersion) throw new Error(`${name} is not one of this wrapper's optionalDependencies — there is no version to check it against`)
  const { nestedTree, boundary } = installTrees()
  const seen = []
  for (const dir of candidateDirs(name)) {
    if (!fs.existsSync(dir)) continue
    let real
    try {
      real = fs.realpathSync(dir)
    } catch (error) {
      seen.push(`${dir}: unreadable (${error instanceof Error ? error.message : String(error)})`)
      continue
    }
    const inside = (tree) => tree !== null && (real === tree || real.startsWith(tree + path.sep))
    if (!inside(boundary) && !inside(nestedTree)) {
      seen.push(`${real} is not inside this install (${boundary ?? nestedTree})`)
      continue
    }
    let manifest
    try {
      manifest = readJson(path.join(dir, "package.json"))
    } catch (error) {
      seen.push(`${real}: no readable package.json (${error instanceof Error ? error.message : String(error)})`)
      continue
    }
    if (manifest.name !== name) {
      seen.push(`${real}: its package.json names ${JSON.stringify(manifest.name)}, not ${name}`)
      continue
    }
    if (manifest.version !== declaredVersion) {
      seen.push(`${real} is ${manifest.name}@${manifest.version}, this wrapper seals ${declaredVersion}`)
      continue
    }
    const record = installRecord(real, name, declaredVersion)
    if (record.state === "refuse") {
      seen.push(record.detail)
      continue
    }
    const binaryPath = path.join(dir, "bin", sourceBinary)
    if (!fs.existsSync(binaryPath)) throw new Error(`Binary not found at ${binaryPath}`)
    return binaryPath
  }
  throw new Error(
    `no copy of ${name}@${declaredVersion} inside this install is loadable${seen.length === 0 ? "" : `:\n  ${seen.join("\n  ")}`}`,
  )
}

function installPackage(name) {
  const version = packageJson.optionalDependencies?.[name]
  if (!version) return

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "glasspane-harness-install-"))
  try {
    // The registry has to be named. npm resolves `npm_config_registry` (which npm exports
    // into lifecycle scripts), `NPM_CONFIG_REGISTRY`, `~/.npmrc` and a project `.npmrc`, so
    // without this the bytes fetched here — then chmod 0755 and executed — come from
    // whatever mirror the ambient config names, and the package's integrity hash is
    // self-attested by that same mirror. `script/verify-published.ts` passes `--registry`
    // for exactly this reason; the install path is the one that runs on a user's machine.
    //
    // This branch then goes one step further than "name the registry": it downloads the
    // tarball with `npm pack`, re-computes its sha512, and refuses it unless that hash equals
    // the `dist.integrity` the registry itself advertises. npm's own integrity check happens
    // against the registry's self-attested metadata during unpack — a mirror that serves a
    // tampered tarball can attest it with matching metadata. Comparing the bytes WE downloaded
    // against the registry's own claim closes that: `npm install <tarball>` below consumes
    // exactly the bytes we verified, never a re-fetch.
    const integrityProbe = childProcess.spawnSync(
      "npm",
      ["view", `${name}@${version}`, "dist.integrity", "--registry", REGISTRY],
      { encoding: "utf8", windowsHide: true },
    )
    const declaredIntegrity = (integrityProbe.stdout ?? "").trim()
    if (integrityProbe.status !== 0 || !/^sha512-[A-Za-z0-9+/]+=*$/.test(declaredIntegrity)) {
      console.error(`the registry did not answer a sha512 integrity for ${name}@${version} (${integrityProbe.stderr?.trim() || `exit ${integrityProbe.status}`}) — refusing to install bytes this run cannot verify`)
      return false
    }
    const pack = childProcess.spawnSync(
      "npm",
      ["pack", `${name}@${version}`, "--registry", REGISTRY, "--pack-destination", temp],
      { encoding: "utf8", windowsHide: true },
    )
    if (pack.status !== 0) {
      console.error(`npm pack failed for ${name}@${version}: ${pack.stderr?.trim() || `exit ${pack.status}`}`)
      return false
    }
    const tarballName = (pack.stdout ?? "").trim().split("\n").pop()?.trim()
    const tarballPath = tarballName ? path.join(temp, tarballName) : null
    if (!tarballPath || !fs.existsSync(tarballPath)) {
      console.error(`npm pack produced no readable tarball for ${name}@${version}`)
      return false
    }
    const actual = createHash("sha512").update(fs.readFileSync(tarballPath)).digest("base64")
    if (`sha512-${actual}` !== declaredIntegrity) {
      console.error(`the tarball for ${name}@${version} does not match the registry's own integrity — downloaded bytes hash to sha512-${actual}, registry declares ${declaredIntegrity}. Refusing it.`)
      return false
    }
    const result = childProcess.spawnSync(
      "npm",
      ["install", "--ignore-scripts", "--no-save", "--loglevel=error", "--prefix", temp, tarballPath],
      { stdio: "inherit", windowsHide: true },
    )
    if (result.status !== 0) return
    const packageDir = path.join(temp, "node_modules", name)
    // The fetch asked for `${name}@${version}` by name; what npm unpacked is checked rather than
    // trusted, because this is the branch that runs when nothing in the tree could be attributed
    // to this install and it is the one branch whose bytes we have not seen before.
    let fetched
    try {
      fetched = readJson(path.join(packageDir, "package.json"))
    } catch (error) {
      console.error(`the package this run fetched has no readable manifest: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
    if (fetched.name !== name || fetched.version !== version) {
      console.error(`the package this run fetched is ${fetched.name}@${fetched.version}, not ${name}@${version} — refusing it`)
      return false
    }
    // The placement, not `true`: the caller has to be able to undo exactly what this line did.
    return copyBinary(path.join(packageDir, "bin", sourceBinary), targetBinary)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

/**
 * Place the resolved bytes at `target`, and hand back what THIS run can undo.
 *
 * Two measured hazards live in these lines.
 *
 * The leaf (measured 2026-11-06): `fs.existsSync` answers FALSE for a dangling symlink, so the old
 * `existsSync → unlinkSync` guard left a stale link in place; `linkSync` then threw EEXIST, the
 * catch's `copyFileSync` wrote THROUGH the link to whatever it points at, and `chmodSync` chmodded
 * that file too. This project's own installer already refuses that class (`installer/cli.js`,
 * "chmod 不许穿过叶子链接"), so the decision is made from `lstatSync`, on the leaf itself, and only an
 * existing REGULAR file may be replaced.
 *
 * The undo (measured the same day, and the reason this returns something): `main()` placed first
 * and verified after, and when the check failed it moved on with the unverified bytes still sitting
 * at `targetBinary` — the command the user then ran was exactly the build this run had declared
 * wrong. `undo()` removes only the file this run placed and, by rename rather than by rewriting,
 * puts back the regular file that was here before, so a refused install leaves no executable behind
 * without destroying what this run did not create. `commit()` drops that backup once a check has
 * passed.
 */
function copyBinary(source, target) {
  if (!fs.existsSync(source)) throw new Error(`Binary not found at ${source}`)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  refuseLeaf(target)
  const backup = fs.existsSync(target) ? `${target}.previous-install` : null
  if (backup !== null) fs.renameSync(target, backup)
  try {
    fs.linkSync(source, target)
  } catch {
    fs.copyFileSync(source, target)
  }
  fs.chmodSync(target, 0o755)
  return { undo: () => undoPlacement(target, backup), commit: () => commitPlacement(backup) }
}

/**
 * Anything at `target` that `lstat` cannot call a regular file is refused before one byte is
 * written or chmodded, because both operations follow a link out of the tree. No later candidate
 * can work around this: `targetBinary` is the same path for every name.
 */
function refuseLeaf(target) {
  let leaf
  try {
    leaf = fs.lstatSync(target)
  } catch (error) {
    if (error.code === "ENOENT") return
    throw new Error(
      `${target} has no readable leaf (${error instanceof Error ? error.message : String(error)}): it cannot be shown not to be a symbolic link, so nothing was written and nothing was chmod-ed`,
    )
  }
  if (leaf.isFile()) return
  const where = leaf.isSymbolicLink() ? `a symbolic link to ${readLink(target)}` : "not a regular file"
  throw new Error(`${target} is ${where} — refusing to write or chmod through it; nothing was written and nothing was removed`)
}

function readLink(target) {
  try {
    return fs.readlinkSync(target)
  } catch {
    return "a target that cannot be read"
  }
}

function undoPlacement(target, backup) {
  // Never follow a leaf swapped in after the placement: `unlink` on the link would be a removal this
  // run did not make, so only a regular file this run created is removed.
  let leaf
  try {
    leaf = fs.lstatSync(target)
  } catch {
    leaf = null
  }
  if (leaf !== null && leaf.isFile()) fs.unlinkSync(target)
  if (backup !== null) fs.renameSync(backup, target)
}

function commitPlacement(backup) {
  if (backup === null) return
  fs.rmSync(backup, { force: true })
}

/**
 * The install has to prove it got *this* build, not merely "a binary that runs".
 *
 * `--version` exiting 0 used to be the whole check, so a platform package holding an older or
 * mislabelled binary installed green and every later claim about "the version you just installed"
 * was about bytes nobody compared. Both other channels already do this: `script/build.ts`'s smoke
 * test fails when the answer differs from the build's own version, and `scripts/install.sh` refuses
 * when the installed command reports something other than the release it asked for. This was the
 * one channel left asserting nothing — and it is the one that runs on every user's machine.
 */
function verifyBinary(expectedVersion) {
  const result = childProcess.spawnSync(targetBinary, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  })
  if (result.status !== 0) return { ok: false, detail: `--version exited ${result.status}` }
  const got = (result.stdout ?? "").trim().split("\n")[0].trim()
  if (got !== expectedVersion) {
    return { ok: false, detail: `--version answers ${JSON.stringify(got)}, this package declares ${JSON.stringify(expectedVersion)}` }
  }
  return { ok: true, detail: got }
}

function main() {
  const names = packageNames()
  // The machine has no installable build at all: say so plainly and name the supported set.
  // The old text here told Linux, Windows and no-AVX2 x64 Mac users to "manually install"
  // names like glasspane-harness-darwin-x64-baseline — packages this product has decided
  // (product.json platform.dropped) not to publish, so the printed remedy could never work.
  if (names.length === 0) {
    const supported = declaredNames.length
      ? `The builds it does publish are ${declaredNames.map((name) => JSON.stringify(name)).join(", ")}.`
      : "This wrapper declares no platform packages at all."
    throw new Error(`glasspane-harness does not ship a build for your platform (${machineLabel()}). ${supported}`)
  }

  const expected = packageJson.version
  // What each candidate actually answered, kept so the final refusal can name the observation
  // instead of blaming the package manager for something it may have delivered correctly.
  const seen = []
  // Every placement is undone when the check that follows it fails: `targetBinary` is the command
  // the user runs next, so bytes this run refused must not be sitting on it.
  for (const name of names) {
    try {
      const placement = copyBinary(resolveBinary(name), targetBinary)
      const check = verifyBinary(expected)
      if (check.ok) {
        placement.commit()
        return
      }
      placement.undo()
      seen.push(`${name}: ${check.detail}`)
    } catch (error) {
      const placement = installPackage(name)
      if (placement) {
        const check = verifyBinary(expected)
        if (check.ok) {
          placement.commit()
          return
        }
        placement.undo()
        seen.push(`${name}: ${check.detail}`)
      } else {
        seen.push(`${name}: not installable here (${error instanceof Error ? error.message : "unknown failure"})`)
      }
    }
  }

  throw new Error(
    `It seems your package manager failed to install the right glasspane-harness CLI package. Try manually installing ${names
      .map((name) => JSON.stringify(name))
      .join(" or ")}.${seen.length === 0 ? "" : `\nWhat this run observed: ${seen.join("; ")}`}`,
  )
}

try {
  main()
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
