/**
 * `NPM_PACKAGE_NAMES` 里不许有发明出来的包名（`updater/lib/apply.js:1424` 的注释一直说这条
 * 由本文件钉住，而那个文件 2026-10-31 之前不存在——一条指着不存在的闸的说法本身就是假清白）。
 *
 * 为什么值得有闸：那一串常量是**发布失败时印给读者照抄的命令**里的包名。名字发明错了，
 * 读者得到的是一条以另一种方式失败的命令，而这句话会被 `mcp-shell/src/update-state.ts`
 * 原样转发给 agent。
 *
 * 三条判据都能红：
 *  · 常量与两个包自己的 `package.json` 的 `name` 逐位相同，且顺序 = `installNpmPackages`
 *    的 `packageDirs` 顺序（发明一个名字、调换顺序、多一个包都会红）；
 *  · 那句话里的每个 `npm i -g …` / `npm pack` 目标都必须来自这份清单；
 *  · 判据自己吃一好一坏两个样本（把 `glasspane-mcp` 换成 `glasspane-mcpv2` 必须被点名），
 *    否则它可以靠改松判据永远"绿"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { NPM_PACKAGE_NAMES, npmLayerNotRefreshedNote } from '../lib/apply.js'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const ROOT = path.resolve(HERE, '..', '..')

/** 发布顺序的真源：`installNpmPackages` 用的那两个目录（读源码，不抄第二份清单）。 */
function packedDirs() {
  const source = fs.readFileSync(path.join(ROOT, 'updater', 'lib', 'apply.js'), 'utf8')
  const literal = /packageDirs[^\n]*=\s*\[([^\]]*)\]/.exec(source)
  assert.ok(literal !== null, 'apply.js 里读不到 packageDirs 这一份清单了——本文件的取材点要跟着一头改')
  return [...literal[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
}

const nameOf = (dir) => JSON.parse(fs.readFileSync(path.join(ROOT, dir, 'package.json'), 'utf8')).name

test('清单与两个包自己的 name 逐位相同，且顺序就是打包顺序', () => {
  const dirs = packedDirs()
  assert.equal(dirs.length, 2, `打包目录读出来是 ${JSON.stringify(dirs)}——这条判据的对照物变了`)
  assert.deepEqual(
    [...NPM_PACKAGE_NAMES],
    dirs.map(nameOf),
    `NPM_PACKAGE_NAMES（${NPM_PACKAGE_NAMES.join(', ')}）与 ${dirs.join(', ')} 自己的 name 不同：`
    + '失败话术里印出去的包名必须是 registry 上真存在的那两个',
  )
})

/** 句子半边：只允许出现清单里的名字。抽成一个函数，好让"会咬人"这一条能喂样本。 */
function inventedPackageNames(text) {
  const known = new Set(NPM_PACKAGE_NAMES)
  return [...new Set([...String(text).matchAll(/npm (?:i -g|pack|view)\s+([A-Za-z0-9._/-]+)/g)]
    .map((m) => m[1]).filter((n) => !known.has(n)))]
}

test('判据会咬人：发明一个包名要被点名，清单内的两个保持沉默', () => {
  const good = `npm i -g ${NPM_PACKAGE_NAMES[0]}；npm view ${NPM_PACKAGE_NAMES[1]} version`
  const bad = 'npm i -g glasspane-mcpv2'
  assert.deepEqual(inventedPackageNames(good), [], `合法的写法被误判：${good}`)
  assert.deepEqual(inventedPackageNames(bad), ['glasspane-mcpv2'], '发明出来的包名没被认出来——闸已经看不见东西')
})

test('那句"npm 层没跟上"给读者的命令里，包名全部来自这份清单', () => {
  // 跑真生产者，不扫源码：`npmLayerNotRefreshedNote` 印的是 `npm install -g <name>@<version>`
  // 那一行，扫源码会读到一个 `${NPM_PACKAGE_NAMES…}` 插值——那既证明不了名字对，也拦不住
  // 将来有人把它换成一个字面量。
  const note = npmLayerNotRefreshedNote('the launchd job could not be re-registered.', { version: '9.9.9' })
  const line = /npm install -g ([^\n`]+)/.exec(String(note.command ?? ''))
  assert.ok(line !== null, `这句话里读不到那条 install 命令：${JSON.stringify(note)}`)
  assert.ok(String(note.message).includes(`\`${line[0]}\``),
    `命令在 message 里不是原样出现的那一条：${note.message}`)
  const names = line[1].trim().split(/\s+/).map((token) => token.split('@')[0])
  assert.deepEqual(names, [...NPM_PACKAGE_NAMES], `命令里的包名与那份清单不是一份东西：${line[1]}`)
  for (const name of names) {
    assert.equal(name.length > 0, true, `空包名：${line[1]}`)
    assert.match(line[1], new RegExp(`${name}@9\\.9\\.9`), `每一个名字都得带上这一版的版本号：${line[1]}`)
  }
})
