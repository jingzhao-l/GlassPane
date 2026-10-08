/**
 * Spec §1 gate 6: the staged tree has to prove it is the version its tag says.
 *
 * Two halves, both required:
 *
 * 1. Three version constants read straight out of the tree: root
 *    `package.json`, `mcp-shell/package.json`, and the daemon's own version
 *    literal in `engine/Sources/GlassPaneEngine/EngineCore.swift` —
 *    `public let version` up to 1.9.x, `public static let buildVersion` from
 *    1.10.0, where it became the single source `hello` and `--version` both read.
 *    All three must equal the release version.
 * 2. The tree runs **its own** `node scripts/check-version.mjs`. This repository
 *    keeps a single version line, so the release carries the very CI guard that
 *    protects it — using it as an acceptance test catches "tag and content came
 *    from different commits", which no digest check can see.
 *
 * A non-zero exit from the tree's own script is `version-line-broken`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { CODES } from './codes.js'
import { UpdaterError } from './fsutil.js'

/** The three constants that must all equal the release version. */
export const VERSION_SITES = Object.freeze([
  { id: 'root-package', file: 'package.json', kind: 'npm-package-json' },
  { id: 'mcp-shell-package', file: path.join('mcp-shell', 'package.json'), kind: 'npm-package-json' },
  {
    id: 'daemon-hello',
    file: path.join('engine', 'Sources', 'GlassPaneEngine', 'EngineCore.swift'),
    kind: 'swift-let',
  },
])

function readTreeFile(stagedDir, site) {
  const target = path.join(stagedDir, site.file)
  if (!fs.existsSync(target)) {
    throw new UpdaterError(CODES.versionLineBroken, `the staged tree has no ${site.file}: that is not a GlassPane release`)
  }
  return fs.readFileSync(target, 'utf8')
}

/** Pull one version constant out of a staged file according to its site kind. */
export function siteVersion(stagedDir, site, { readText } = {}) {
  const text = readText ? readText(site.file) : readTreeFile(stagedDir, site)
  if (site.kind === 'npm-package-json') {
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new UpdaterError(CODES.versionLineBroken, `${site.file} in the staged tree is not valid JSON (${error.message})`)
    }
    return requirePlainVersion(parsed?.version, site.file)
  }
  // 1.10.0 起 daemon 那份字面量收成了单一出处的 static（`public static let buildVersion = "…"`，
  // 实例属性只是转读它），好让 `hello` 与 `glasspaned --version` 说不出两套话。而一份 1.9.x
  // 及更早的暂存树里写的还是 `public let version = "…"`。一个比目标发布更新的 updater 必须两种
  // 都认得：因为"那一行搬家了"就拒掉一份完全正常的暂存树，等于这个工具亲手掐断自己的升级路径。
  //
  // 顺序不是任意的：**先找 static，找不到才回落 instance**。实测一份两份都在的树，按"文件里第一个
  // 字面量"取会随两行谁在前面而读到不同的数字——那份多出来的常量是谁写的都说不清，而权威出处只有
  // static 一个。按位置取第一个，等于让行序决定版本号。
  const authoritative = /public static let buildVersion = "([^"]+)"/.exec(text)
  const match = authoritative ?? /public let version = "([^"]+)"/.exec(text)
  if (!match) {
    throw new UpdaterError(
      CODES.versionLineBroken,
      `${site.file} in the staged tree carries neither \`public static let buildVersion\` nor \`public let version\``,
    )
  }
  return requirePlainVersion(match[1], site.file)
}

/**
 * A version constant that is not a plain `x.y.z` (an `unreleased` placeholder, a
 * `1.4.0-beta.2`) cannot equal a release tag, so it refuses here rather than
 * reaching the comparison below as a confusing mismatch.
 */
function requirePlainVersion(value, file) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(value ?? '').trim())
  if (!match) {
    throw new UpdaterError(CODES.versionLineBroken, `${file} in the staged tree reports version ${JSON.stringify(value)}, which is not a released x.y.z`)
  }
  return match[0]
}

/** Half 1: every site equals `version`. */
export function assertVersionSites(stagedDir, version, { readText } = {}) {
  const seen = {}
  for (const site of VERSION_SITES) {
    seen[site.id] = siteVersion(stagedDir, site, { readText })
  }
  const off = Object.entries(seen).filter(([, value]) => value !== version)
  if (off.length > 0) {
    throw new UpdaterError(
      CODES.versionLineBroken,
      `the staged tree says ${off.map(([id, v]) => `${id}=${v}`).join(', ')} but the release tag says ${version}: tag and content are not the same version`,
      { seen, want: version },
    )
  }
  return seen
}

/**
 * Half 2: run the tree's own guard. `runner` is injectable for *process
 * selection only* — the exit code that decides the verdict is the real one from
 * a real `node` child process (see `test/selfcheck.test.mjs`).
 */
export function runTreeGuard(stagedDir, { runner = defaultRunner, nodeExecPath = process.execPath, timeoutMs = 120_000 } = {}) {
  const script = path.join(stagedDir, 'scripts', 'check-version.mjs')
  if (!fs.existsSync(script)) {
    return {
      ok: false,
      code: CODES.versionLineBroken,
      message: `the staged tree carries no scripts/check-version.mjs, so it cannot prove its own version line`,
      stdout: '',
      stderr: '',
    }
  }
  const result = runner(nodeExecPath, [script], { cwd: stagedDir, timeoutMs })
  if (!result || result.status !== 0) {
    return {
      ok: false,
      code: CODES.versionLineBroken,
      message: `the release's own version-line check failed (exit ${result?.status ?? 'null'}): ${(result?.stderr ?? '').trim().slice(0, 400) || 'no output'}`,
      stdout: result?.stdout ?? '',
      stderr: result?.stderr ?? '',
    }
  }
  return { ok: true, code: null, message: null, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function defaultRunner(bin, args, { cwd, timeoutMs }) {
  const res = spawnSync(bin, args, { cwd, encoding: 'utf8', timeout: timeoutMs })
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? (res.error ? String(res.error.message) : ''),
  }
}

/**
 * Both halves. Anything short of two passes is a verdict rather than an
 * exception: the caller (`check`) records `version-line-broken` and throws the
 * staged tree away.
 */
export function selfCheckStagedTree(stagedDir, version, opts = {}) {
  let sites
  try {
    sites = assertVersionSites(stagedDir, version, opts)
  } catch (error) {
    return { ok: false, code: error.code ?? CODES.versionLineBroken, message: error.message, sites: null, guard: null }
  }
  const guard = runTreeGuard(stagedDir, opts)
  if (!guard.ok) return { ok: false, code: guard.code, message: guard.message, sites, guard }
  return { ok: true, code: null, message: null, sites, guard }
}
