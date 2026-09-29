/**
 * 本机给 node 的那份根证书束（`<stateRoot>/ca-roots.pem`）。
 *
 * 为什么需要：node 的 `fetch` 只认随二进制打包的 Mozilla CA 束，**不读 macOS 钥匙串**。装了
 * HTTPS 中间人的机器（企业网关、加速器）会给 `api.github.com` 出示一张由本地根签发的证书 ——
 * `curl` / `git` / `gh` 都查系统信任库所以一切正常，只有 updater 每天在 `release-unreachable`
 * 上撞死，而且看起来完全像"网络没问题，是它在闹脾气"。第一次真跑 `check` 就撞上这件事。
 *
 * 这里只做一件事：把这台机器**的管理员已经选择信任**的那些根导出成 PEM，交给
 * `NODE_EXTRA_CA_CERTS`。那是**追加**信任，不是替换，更不是关闭校验：node 仍然验证完整链，
 * Mozilla 束继续有效。内容级的作者性也不靠这条腿 —— 下载的字节必须匹配那份由我们自己的 key
 * 签过的 `SHA256SUMS`（§1 第 5、8 道），中间人签不出它。
 *
 * 为什么实现在 updater 而不是安装器：安装器注册 agent 走的就是 `updater enable`，把导出放在
 * 那里，"信任从哪来"就只有一个作者、一份路径解析口径（§8.10 的同一类错误不能犯第二次）。
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'

import { CODES } from './codes.js'
import { UpdaterError, writePrivateFile } from './fsutil.js'

export const CA_BUNDLE_NAME = 'ca-roots.pem'
export const CA_ENV_VAR = 'NODE_EXTRA_CA_CERTS'

/**
 * 封闭枚举。每个取值都必须有能到达它的调用点和一条测试；`ok` 之外的四个都要带 remedy ——
 * 一个说不出下一步的失败态只是把异常换了个名字。
 */
export const CA_STATUSES = Object.freeze(['ok', 'empty', 'unavailable', 'write-unverified', 'probe-failed'])

// 管理员装的根在 System.keychain，出厂根在 SystemRootCertificates.keychain。两份都要：
// 只导前者会漏掉正常的公网根，只导后者会漏掉拦截证书 —— 拦截场景恰好是这份文件存在的理由。
export const KEYCHAIN_SOURCES = Object.freeze([
  '/System/Library/Keychains/SystemRootCertificates.keychain',
  '/Library/Keychains/System.keychain',
])

const CERT_BEGIN = '-----BEGIN CERTIFICATE-----'

export function caBundlePath(stateRoot) {
  if (typeof stateRoot !== 'string' || stateRoot === '') {
    throw new UpdaterError(CODES.homeRecordUnavailable, 'ca bundle needs a state root, got ' + JSON.stringify(stateRoot))
  }
  if (!path.isAbsolute(stateRoot)) {
    // This path ends up inside a launchd job's environment, and a relative one is
    // resolved against whatever directory the job happens to start in. node would
    // then read a bundle that exists only from the right CWD, and refuse the TLS
    // path every other time.
    throw new UpdaterError(CODES.homeRecordUnavailable, `the CA bundle needs an absolute state root, got ${JSON.stringify(stateRoot)}`)
  }
  return path.join(stateRoot, CA_BUNDLE_NAME)
}

export function countCertificates(text) {
  return String(text ?? '').split(CERT_BEGIN).length - 1
}

/**
 * 这个文件现在能不能交给 node。判据是**里面有几张证书**，不是文件在不在、也不是它多大。
 *
 * 理由要说准（本机 node v26.4.0 实测，`probe-ca-env3.sh` 可复现）：一份 0 字节的
 * `NODE_EXTRA_CA_CERTS` **不会**让 node 在启动期报错——它能正常起、正常做 TLS 握手，只是
 * 一张额外的根都没加进去；文件根本不存在时 node 也只往 stderr 打一行
 * `Warning: Ignoring extra certs …`，不崩。把"空束"写成"启动失败"是我编的，已删。
 *
 * 那为什么仍然判它不可用：一台真被拦截的机器上，空束的表现与"什么都没做"**一模一样**——检查
 * 照样倒在第一道门上，而状态里却记着"束已导出"。那种记录会把人支去查网络，而缺的是信任。
 * 一张都没有的束不能证明任何事，所以它不是 `ok`。
 */
export function usableBundle(bundlePath, { readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  let text
  try {
    text = readFile(bundlePath)
  } catch {
    return { usable: false, certs: 0, reason: 'absent' }
  }
  const certs = countCertificates(text)
  return { usable: certs > 0, certs, reason: certs > 0 ? null : 'empty' }
}

/**
 * 失败态的可执行说法。`probe-failed` 与 `empty`/`unavailable` 的区别必须留在文案里：前者是
 * "束写好了但仍连不通"（拦截根不在这两个钥匙串里，或网络真的断了），后两者是"这台机器上导不出
 * 东西"。把它们混成一句，读的人就只能猜。
 */
export function describeCa(record, { bundlePath = null } = {}) {
  if (!record) {
    return {
      summary: 'this install has never exported a root bundle for node',
      remedy: bundlePath
        ? `run the installer again, or "updater enable": either one re-exports ${bundlePath} and re-registers the agent with it.`
        : 'run the installer again, or "updater enable": either one exports the machine\'s root bundle as ca-roots.pem inside your update state root (the stateRoot field of "updater status --json" names that directory) and re-registers the agent with it.',
    }
  }
  const where = record.path ? ` ${record.path}` : ''
  switch (record.status) {
    case 'ok':
      return {
        summary: `node will be handed ${record.certs} exported root certificate(s)${where}`,
        remedy: null,
      }
    case 'empty':
      return {
        summary: record.path
          ? `"security find-certificate" ran but produced no certificate, so nothing was exported; the bundle already at ${record.path} is kept and still handed to the agent`
          : '"security find-certificate" ran but produced no certificate, and this machine has no exported bundle at all',
        remedy: 'check the two keychains are readable ("security dump-keychain" lists them), then re-run "updater enable". Until then a machine that intercepts TLS keeps failing the first update gate.',
      }
    case 'unavailable':
      return {
        summary: 'the macOS "security" tool is not here, so no system root bundle could be exported',
        remedy: 'point NODE_EXTRA_CA_CERTS at a PEM bundle you trust yourself, e.g. export NODE_EXTRA_CA_CERTS=/path/to/roots.pem before running the updater.',
      }
    case 'write-unverified':
      return {
        summary: `the bundle that was read back is not what was written${where} (${record.detail ?? 'no further detail'})`,
        remedy: 'fix permissions or free space on the state root, then re-run "updater enable"; a bundle nobody can read back is not a bundle.',
      }
    case 'probe-failed':
      return {
        summary: `${record.certs} root certificate(s) were exported${where}, but a node started with them could not reach the release endpoint (${record.detail ?? 'no reason reported'})`,
        remedy: 'the intercepting root is not in the system keychains, or the network really is down. Import it ("sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain /path/to/the-intercepting-root.pem"), or export NODE_EXTRA_CA_CERTS to a bundle you control before invoking the updater.',
      }
    default:
      // 枚举外的一切都是"这份记录读不懂"。当成 ok 就是规格 §9.7 明令禁止的那种静默放行。
      return {
        summary: `the recorded CA status ${JSON.stringify(record.status)} is not one this program knows`,
        remedy: 're-run "updater enable" to produce a status this build understands.',
      }
  }
}

const defaultRun = (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', ...options })

/**
 * 起一个**子进程**去探测，而不是在当前进程里 fetch。理由很具体：node 只在进程启动时读
 * `NODE_EXTRA_CA_CERTS`，在当前进程里设这个环境变量什么都不会改变 —— 那样"探测通过"证明的是
 * 一件根本没发生的事。子进程带上与 launchd/面板将要用的一模一样的环境，测出来的才是那条路。
 *
 * URL 走 argv 传给子进程（`process.argv[1]`），不插进脚本字符串：安装状态根里的路径永远不该
 * 变成一次 shell 求值（§8.5 同一条纪律）。
 */
export function probeWithBundle({
  bundlePath,
  url,
  run = defaultRun,
  nodePath = process.execPath,
  env = process.env,
}) {
  // 子进程把**它自己那一侧的失败原因**打到 stderr：真机第一次安装时探测失败，记录里只剩
  // "TLS or DNS refused the connection" 这种我猜的话 —— 而当时盘上的束其实已经能用（几分钟后
  // 同一个 URL 直接 200）。没有 cause code 的失败描述是猜谜，不是诊断。
  const script = 'const f=(m)=>{process.stderr.write(m+"\\n");process.exit(1)};'
    + 'fetch(process.argv[1],{headers:{accept:"application/vnd.github+json"}})'
    + '.then((r)=>{if(r.ok)process.exit(0);process.stderr.write("HTTP "+r.status+" "+(r.statusText||""));process.exit(20)},'
    + '(e)=>{const c=e&&e.cause||{};process.stderr.write("REJECT "+(e&&e.name||"error")+" "+(c.code||"")+" "+String(c.message||e&&e.message||"").slice(0,160));process.exit(21)})'
    + '.catch((e)=>f("CRASH "+(e&&e.message||e)))'
  const res = run(nodePath, ['-e', script, url], { env: { ...env, [CA_ENV_VAR]: bundlePath }, timeout: 30_000 })
  const stderr = String((res && res.stderr) ?? '').trim().split('\n')[0]
  if (res && res.error && res.error.code === 'ENOENT') {
    return { kind: 'transport', detail: `node could not be started to run the probe (${res.error.message})` }
  }
  if (res && res.error && /timeout|ETIMEDOUT/i.test(String(res.error.message ?? ''))) {
    return { kind: 'transport', detail: 'the probe did not answer within 30s' }
  }
  const status = res ? res.status : null
  if (status === 0) return { kind: 'ok', detail: null }
  // 端点**答了**（哪怕 403/404）：TLS 这条腿走通了。这不能算信任束失败 —— 把限流写成
  // "证书没配对"会把人支去动信任配置，而那正是这里最不该动的东西。
  if (status === 20) return { kind: 'answered-non-ok', detail: stderr || 'the endpoint answered a non-2xx status' }
  const hint = status === 21 ? (stderr || 'the connection was refused before an answer') : `probe exited ${String(status)}`
  return { kind: 'transport', detail: hint }
}

/**
 * 导出 + （可选）探测，返回写进状态文件的那条记录。
 * 这个函数**从不抛**：它是一次安装/换版的附属动作，机器导不出根证书不该让更新整条链失败
 * ——没有拦截的机器本来就不需要这份文件。失败必须可见，可见由返回的记录负责。
 */
export function exportCaBundle({
  stateRoot,
  probeUrl = null,
  run = defaultRun,
  nodePath = process.execPath,
  env = process.env,
  sources = KEYCHAIN_SOURCES,
  writeFile = (p, text) => writePrivateFile(p, text),
  readFile = (p) => fs.readFileSync(p, 'utf8'),
  now = () => new Date().toISOString(),
} = {}) {
  const target = caBundlePath(stateRoot)
  const chunks = []
  let missingTool = false
  for (const source of sources) {
    const res = run('security', ['find-certificate', '-a', '-p', source])
    if (res && res.error && res.error.code === 'ENOENT') {
      missingTool = true
      break
    }
    // 单个钥匙串读不动（不存在、权限）不能把另一份的成果一起丢掉：系统根与管理员根正是
    // 分开装在这两处的。
    if (!res || res.status !== 0 || !res.stdout) continue
    chunks.push(res.stdout)
  }
  if (missingTool) {
    return { status: 'unavailable', certs: 0, path: null, exportedAt: now(), detail: 'the "security" command was not found on this machine' }
  }

  const pem = chunks.join('')
  const certs = countCertificates(pem)
  if (certs === 0) {
    // Nothing was produced, so nothing is written — and the bundle already in place
    // is *kept*: it is the trust this machine has been running on, and a failed
    // export has no business revoking it. `path` names it so a reader (and the
    // panel) can tell "empty because this machine exports nothing" from "empty and
    // no bundle at all".
    const kept = usableBundle(target, { readFile })
    return {
      status: 'empty',
      certs: 0,
      path: kept.usable ? target : null,
      exportedAt: now(),
      detail: kept.usable
        ? `neither keychain produced a PEM certificate (${sources.join(', ')}); the ${kept.certs}-certificate bundle already at ${target} was left in place`
        : `neither keychain produced a PEM certificate (${sources.join(', ')})`,
    }
  }

  try {
    writeFile(target, pem)
  } catch (error) {
    return { status: 'write-unverified', certs, path: target, exportedAt: now(), detail: String(error && error.message ? error.message : error).slice(0, 200) }
  }
  let readBack
  try {
    readBack = readFile(target)
  } catch (error) {
    return { status: 'write-unverified', certs, path: target, exportedAt: now(), detail: `the bundle could not be read back: ${String(error && error.message ? error.message : error).slice(0, 160)}` }
  }
  if (readBack !== pem) {
    return { status: 'write-unverified', certs, path: target, exportedAt: now(), detail: `read back ${countCertificates(readBack)} certificate(s) of the ${certs} written` }
  }

  const record = { status: 'ok', certs, path: target, exportedAt: now(), detail: null }
  if (!probeUrl) return record
  const probe = probeWithBundle({ bundlePath: target, url: probeUrl, run, nodePath, env })
  if (probe.kind === 'ok') return record
  if (probe.kind === 'answered-non-ok') {
    // 束能用是这条记录要回答的问题；端点自己的答复质量不是它的失败。
    return { ...record, detail: `the bundle verified TLS; ${probe.detail}` }
  }
  return { ...record, status: 'probe-failed', detail: probe.detail }
}
