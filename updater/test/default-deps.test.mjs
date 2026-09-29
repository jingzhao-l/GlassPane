/**
 * `defaultDeps` 是这台机器真跑的那一套依赖，而它此前**一条测试都没有**：
 * `enable.test.mjs` / `apply.test.mjs` 全都注入自己的桩，于是"桩给的东西形状对"被当成了
 * "生产跑起来也对"。复审 #1/#3 落在这上面的方式是具体的：
 *   · `refreshCaBundle` 若把 `resolveBase(env)` 这个**对象**当 probeUrl 传下去，束导出会
 *     记成 `probe-failed`，而 URL 那句 `[object Object]` 只有真机才看得见；
 *   · `fetchJson` 若没带上 `caBundlePath(stateRoot)`，TLS 失败的 remedy 就退回一句没有路径的
 *     道理——而那正是人/代理唯一会去执行的一行。
 * 所以这里测的就是**默认值本身**，不替换任何依赖（只替换两处外部事实：`exportCa` 的接缝与
 * `globalThis.fetch`）。
 *
 * 反向变异（本轮实测，见 `.iterate_decisions.md`）：
 *   · `probeUrl: releaseProbeUrl(env)` → `resolveBase(env)`            → 第一条红
 *   · `caBundlePath: caBundlePath(stateRoot)` → `null`                 → 第三、四条红
 *   · `usableCaBundle` 读错文件（读 `/etc/protocols`）                  → 第二条红
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { defaultDeps, releaseProbeUrl } from '../cli.js'
import { CA_BUNDLE_NAME, CA_ENV_VAR } from '../lib/ca-bundle.js'
import { CODES } from '../lib/codes.js'
import { DEFAULT_BASE } from '../lib/source.js'
import { TMP_PREFIX, removeDir, tempDir } from './helpers.mjs'

const RELEASE_PATH = '/releases/latest'
const CERT = (n) => `-----BEGIN CERTIFICATE-----\nMIIB${n}DEFAULTDEPS\n-----END CERTIFICATE-----\n`

function scratch(label) {
  return path.resolve(tempDir(`${TMP_PREFIX}defaults-${label}-`))
}

function depsFor(stateRoot, extra = {}) {
  return defaultDeps({ stateRoot, appsDir: path.join(stateRoot, 'apps'), env: {}, flags: {}, ...extra })
}

test('the default exporter is handed a string https URL, not the base object', () => {
  const stateRoot = scratch('url-')
  try {
    const seen = []
    const deps = depsFor(stateRoot, {
      exportCa: ({ probeUrl }) => {
        seen.push(probeUrl)
        return { status: 'ok', certs: 1, path: path.join(stateRoot, CA_BUNDLE_NAME), exportedAt: 'now', detail: null }
      },
    })
    const record = deps.refreshCaBundle()
    assert.equal(record.status, 'ok')
    assert.equal(seen.length, 1, 'enable 那一趟只导一次，多次导出会把上一轮的记录盖掉')
    assert.equal(typeof seen[0], 'string', `probeUrl 必须是能进 fetch 的字符串，收到的是 ${typeof seen[0]}：${JSON.stringify(seen[0])}`)
    assert.doesNotMatch(seen[0], /\[object Object\]/, '这就是 1.5.0 那台机器全部记成 probe-failed 的形状')
    assert.equal(seen[0], `${DEFAULT_BASE}${RELEASE_PATH}`, seen[0])

    // 自建基址要一路带到探测器手里，否则探测打到一个不存在的地方又记成 probe-failed。
    const mirror = defaultDeps({
      stateRoot,
      appsDir: path.join(stateRoot, 'apps'),
      flags: {},
      env: { GLASSPANE_UPDATE_BASE: 'https://mirror.example.test' },
      exportCa: ({ probeUrl }) => {
        seen.push(probeUrl)
        return { status: 'ok', certs: 1, path: '', exportedAt: 'now', detail: null }
      },
    })
    mirror.refreshCaBundle()
    assert.equal(seen[1], `https://mirror.example.test/repos/jingzhao-l/GlassPane${RELEASE_PATH}`, seen[1])
    assert.equal(releaseProbeUrl({}), `${DEFAULT_BASE}${RELEASE_PATH}`)
  } finally {
    removeDir(stateRoot)
  }
})

test('the default usability check reads the file the production path names', () => {
  const stateRoot = scratch('usable-')
  try {
    const bundle = path.join(stateRoot, CA_BUNDLE_NAME)
    const deps = depsFor(stateRoot)

    const absent = deps.usableCaBundle()
    assert.equal(absent.usable, false, '还没有束的时候不许说"能用"')
    assert.equal(absent.reason, 'absent', JSON.stringify(absent))

    fs.mkdirSync(stateRoot, { recursive: true })
    fs.writeFileSync(bundle, '', { mode: 0o600 })
    const zeroBytes = deps.usableCaBundle()
    assert.equal(zeroBytes.usable, false, '0 字节的文件不是束——它一张根都不加')
    assert.equal(zeroBytes.reason, 'empty', JSON.stringify(zeroBytes))

    fs.writeFileSync(bundle, CERT(1) + CERT(2), { mode: 0o600 })
    const good = deps.usableCaBundle()
    assert.equal(good.usable, true, JSON.stringify(good))
    assert.equal(good.certs, 2, '张数是要写进状态、说给人听的那个数')

    // 读的就是 `<stateRoot>/ca-roots.pem` 这一个文件：换成别处（哪怕读得到）就是假证据。
    fs.writeFileSync(path.join(stateRoot, 'other-ca.pem'), CERT(9))
    assert.equal(deps.usableCaBundle().certs, 2, '默认依赖读错文件了')
  } finally {
    removeDir(stateRoot)
  }
})

test('a TLS failure from the default fetcher names the bundle this machine must be handed', async () => {
  const stateRoot = scratch('remedy-')
  const realFetch = globalThis.fetch
  try {
    fs.mkdirSync(stateRoot, { recursive: true })
    fs.writeFileSync(path.join(stateRoot, CA_BUNDLE_NAME), CERT(1), { mode: 0o600 })
    const bundle = path.join(stateRoot, CA_BUNDLE_NAME)
    globalThis.fetch = async () => {
      const error = new TypeError('fetch failed')
      error.cause = { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', message: 'self signed certificate in certificate chain' }
      throw error
    }
    // fetchJson 在 defaultDeps 被调用那一刻抓走 globalThis.fetch，所以替换必须发生在之前。
    const deps = depsFor(stateRoot)
    for (const [name, call] of [['fetchJson', () => deps.fetchJson('https://api.github.com/x')],
      ['fetchBytes', () => deps.fetchBytes('https://objects.githubusercontent.com/x')]]) {
      const failure = await call().then(() => null, (error) => error)
      assert.ok(failure, `${name} 不许把证书事故咽下去`)
      assert.equal(failure.code, CODES.releaseUnreachable, `${name} 报错了但不是那条码：${failure.code}`)
      assert.equal(failure.tlsVerification, true, `${name} 的结构化判据丢了，§9.10 的恢复分支就瞎了`)
      assert.match(String(failure.details), new RegExp(CA_ENV_VAR), `remedy 得说出那个变量的名字：${failure.details}`)
      assert.ok(String(failure.details).includes(bundle),
        `${name} 的 remedy 里必须是**这台机器真有的那个路径**（${bundle}），不是一句道理：${failure.details}`)
      assert.match(failure.message, /UNABLE_TO_VERIFY_LEAF_SIGNATURE/, 'cause code 不能再被吞掉')
    }
  } finally {
    globalThis.fetch = realFetch
    removeDir(stateRoot)
  }
})
