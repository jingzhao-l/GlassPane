#!/usr/bin/env node

import childProcess from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { createRequire } from "module"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
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

function resolveBinary(name) {
  const packageJsonPath = require.resolve(`${name}/package.json`)
  const binaryPath = path.join(path.dirname(packageJsonPath), "bin", sourceBinary)
  if (!fs.existsSync(binaryPath)) throw new Error(`Binary not found at ${binaryPath}`)
  return binaryPath
}

function installPackage(name) {
  const version = packageJson.optionalDependencies?.[name]
  if (!version) return

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "glasspane-harness-install-"))
  try {
    const result = childProcess.spawnSync(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-save",
        "--loglevel=error",
        // The registry has to be named. npm resolves `npm_config_registry` (which npm exports
        // into lifecycle scripts), `NPM_CONFIG_REGISTRY`, `~/.npmrc` and a project `.npmrc`, so
        // without this the bytes fetched here — then chmod 0755 and executed — come from
        // whatever mirror the ambient config names, and the package's integrity hash is
        // self-attested by that same mirror. `script/verify-published.ts` passes `--registry`
        // for exactly this reason; the install path is the one that runs on a user's machine.
        "--registry",
        REGISTRY,
        "--prefix",
        temp,
        `${name}@${version}`,
      ],
      { stdio: "inherit", windowsHide: true },
    )
    if (result.status !== 0) return
    const packageDir = path.join(temp, "node_modules", name)
    copyBinary(path.join(packageDir, "bin", sourceBinary), targetBinary)
    return true
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

function copyBinary(source, target) {
  if (!fs.existsSync(source)) throw new Error(`Binary not found at ${source}`)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  if (fs.existsSync(target)) fs.unlinkSync(target)
  try {
    fs.linkSync(source, target)
  } catch {
    fs.copyFileSync(source, target)
  }
  fs.chmodSync(target, 0o755)
}

function verifyBinary() {
  const result = childProcess.spawnSync(targetBinary, ["--version"], {
    encoding: "utf8",
    stdio: "ignore",
    windowsHide: true,
  })
  return result.status === 0
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

  for (const name of names) {
    try {
      copyBinary(resolveBinary(name), targetBinary)
      if (verifyBinary()) return
    } catch {
      if (installPackage(name) && verifyBinary()) return
    }
  }

  throw new Error(
    `It seems your package manager failed to install the right glasspane-harness CLI package. Try manually installing ${names
      .map((name) => JSON.stringify(name))
      .join(" or ")}.`,
  )
}

try {
  main()
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
