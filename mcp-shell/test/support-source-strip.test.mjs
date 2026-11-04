/**
 * The comment stripper every source-scan gate reads through. It had no test of its own until
 * 2026-11-04, which is how a `/*` inside a doc comment (the words `installer/*.js` in
 * `installer/cli.js`) ate ~4.5 KB of real code out of the quoting gate's scan set — a blind gate
 * that still prints "clean". These cases are the guards for that class, not for style.
 */
import { test } from "node:test"
import assert from "node:assert/strict"

import { executableSource } from "./support/source.mjs"

test("a glob inside a block comment does not delete the code after it", () => {
  const source = [
    "/** the scan set covers installer/*.js files shipped by this package. */",
    "const cmd = `git ls-remote ${remoteName} ${ref}`",
    "export { cmd }",
    "",
  ].join("\n")
  const out = executableSource(source)
  assert.ok(out.includes("git ls-remote"), "注释里的 /* 开了一个假块注释，真代码被吃掉了（本轮实测的形状）")
  assert.ok(out.includes("${remoteName}"), "插值位必须留在扫描集里，否则引号闸看不见这一处")
  assert.ok(!out.includes("the scan set covers"), "注释本身还是要去掉的——不然闸会把说明文字判成缺陷")
})

test("slashes inside a value are not comments", () => {
  const source = [
    'const url = "https://example.test/a/*path*/b"',
    "const after = `chmod ${mode} ${file}`",
    "const trailing = 1 // after a line comment the next line still exists",
    "const survivor = `ls -lO ${file}`",
    "",
  ].join("\n")
  const out = executableSource(source)
  assert.ok(out.includes("https://example.test"), "字符串里的 // 被当成了行注释，后面的代码整条消失")
  assert.ok(out.includes("chmod"), "字符串里的 /* 被当成了块注释")
  assert.ok(out.includes("ls -lO"), "行注释之后的代码必须还在")
  assert.ok(!out.includes("after a line comment"), "行注释本身要掉")
})

test("line and block comments are removed, code survives", () => {
  const source = [
    "// leading line comment",
    "/* a block",
    "   spanning lines with a `code ${x}` lookalike */",
    "const kept = `plutil -p ${file}`",
    "",
  ].join("\n")
  const out = executableSource(source)
  assert.ok(!out.includes("leading line comment"))
  assert.ok(!out.includes("spanning lines"))
  assert.ok(out.includes("plutil -p"), "判据要求的是能跑的那一侧：真代码不许被剥离吞掉")
})

test("escape sequences inside strings keep their quotes", () => {
  const source = "const a = 'don\\'t';\nconst b = `chmod ${mode} ${file}`;\n"
  const out = executableSource(source)
  assert.ok(out.includes("`chmod"), "转义引号把字符串状态带偏了，后面的模板串不再被扫到")
})
