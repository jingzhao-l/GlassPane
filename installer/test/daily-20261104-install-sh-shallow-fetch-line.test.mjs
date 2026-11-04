/**
 * `install.sh` prints one line for the operator to copy-paste when an existing clone is
 * missing the release ref. Its judgement is therefore: hand that line to a shell and check
 * what git receives.
 *
 * The defect (measured 2026-11-04): the template ran `--depth 1` through `sh_quote`, so the
 * printed line was `fetch --tags '--depth 1' …` — one word — and copying it fails with
 * `git: error: unknown option 'depth 1'`. The line install.sh *executes* two lines below does
 * not quote it and is correct, and the comment right above both says the printed form has to
 * keep them as two words. That is the half-fix shape: rule stated, one side implemented.
 *
 * This test does not run install.sh (it would build and install). It takes the real bytes out
 * of the file — the `sh_quote` definition and the exact `say "…"` line — renders them with the
 * values a real run would carry, and hands the result to a git that only records argv.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..")
const SCRIPT = fs.readFileSync(path.join(REPO, "install.sh"), "utf8")

const SAY_LINE = SCRIPT.split("\n").find((l) => l.includes("先 fetch 它") && l.trim().startsWith("say "))
assert.ok(SAY_LINE, "install.sh 里那条浅仓出路读不到了")

const SH_QUOTE = (() => {
  const start = SCRIPT.indexOf("sh_quote()")
  assert.notEqual(-1, start, "install.sh 里找不到 sh_quote()")
  const body = SCRIPT.slice(start)
  const end = body.indexOf("\n}")
  assert.notEqual(-1, end, "sh_quote() 的函数体读不到结尾")
  return body.slice(0, end + 2)
})()

/** Render the printed line with the values a real run would carry (passed via env, not interpolated). */
function printedLine(values) {
  const harness = [
    "#!/bin/sh",
    SH_QUOTE,
    'say() { printf "%s\\n" "$1"; }',
    `_dir="\${GP_DIR}"`,
    `_remote="\${GP_REMOTE}"`,
    `_ref="\${GP_REF}"`,
    `_depth="\${GP_DEPTH}"`,
    SAY_LINE,
    "",
  ].join("\n")
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "gp-install-render-"))
  const file = path.join(root, "render.sh")
  fs.writeFileSync(file, harness)
  const got = spawnSync("/bin/sh", [file], {
    encoding: "utf8",
    env: { ...process.env, ...values },
  })
  fs.rmSync(root, { recursive: true, force: true })
  assert.equal(0, got.status, `渲染这条出路失败：${got.stderr}`)
  return (got.stdout ?? "").trim()
}

/** The command a reader would copy: from `git -C` to the first Chinese comma. */
function copyable(rendered) {
  const from = rendered.indexOf("git -C")
  assert.notEqual(-1, from, `那一行里取不出待照抄的命令：${rendered}`)
  return rendered.slice(from).split("，")[0].trim()
}

function argvTheReaderWouldHandGit(command) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "gp-install-git-"))
  const bin = path.join(root, "bin")
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, "git"), "#!/bin/sh\nprintf '%s\\n' \"$@\"\n", { mode: 0o755 })
  const run = spawnSync("/bin/sh", ["-c", command], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  })
  fs.rmSync(root, { recursive: true, force: true })
  assert.equal(0, run.status, `照抄这一行跑不起来：${command}\n${run.stderr}`)
  return (run.stdout ?? "").split("\n").filter((l) => l !== "")
}

const shallow = { GP_DIR: "/Users/John Smith/glasspane", GP_REMOTE: "origin", GP_REF: "main", GP_DEPTH: "--depth 1" }

test("浅仓出路里的 --depth 与 1 抵达 git 时是两个词", () => {
  const argv = argvTheReaderWouldHandGit(copyable(printedLine(shallow)))
  assert.ok(argv.includes("fetch"), `假 git 没收到 fetch：${JSON.stringify(argv)}`)
  assert.ok(argv.includes("--tags"), `假 git 没收到 --tags：${JSON.stringify(argv)}`)
  assert.ok(!argv.includes("--depth 1"),
    `'--depth 1' 被当成一个参数交给了 git（真 git 答 unknown option）：${JSON.stringify(argv)}`)
  assert.ok(argv.includes("--depth") && argv.includes("1"),
    `--depth 与它的取值没有各自成词：${JSON.stringify(argv)}`)
})

test("不是浅仓时那一行不带 --depth（判据读 git 的答复，不猜边界）", () => {
  const argv = argvTheReaderWouldHandGit(copyable(printedLine({ ...shallow, GP_DEPTH: "" })))
  assert.ok(!argv.includes("--depth"), `完整 clone 被告知要加人为边界：${JSON.stringify(argv)}`)
  assert.ok(!argv.includes("1"), `--depth 的孤值留在了那一行里：${JSON.stringify(argv)}`)
})

test("目录/远端/引用三枚值各自一个词，且那一行里没有裸的展开面", () => {
  const hostile = {
    GP_DIR: "/tmp/x$(touch /tmp/gp-pwned)/it's here",
    GP_REMOTE: "up $(echo pwned)",
    GP_REF: "v1.0.0;touch /tmp/gp-pwned2",
    GP_DEPTH: "--depth 1",
  }
  const rendered = copyable(printedLine(hostile))
  // 判据不靠"抹掉单引号段再看有没有 $(" —— POSIX 的 it'\''s 一形会让那种正则自己先劈开。
  // 真正的判据在下面两条：值要么作为**一个 argv** 抵达 git（引号对了才会），要么被 shell 当成
  // 展开执行（那就留下 /tmp/gp-pwned 这个文件）。两条都是可观察的后果，不是文本长相。
  const argv = argvTheReaderWouldHandGit(rendered)
  assert.ok(argv.includes(hostile.GP_DIR), `带空格与 $() 的目录没作为一个词抵达 git：${JSON.stringify(argv)}`)
  assert.ok(argv.includes(hostile.GP_REMOTE), `远端名被劈开：${JSON.stringify(argv)}`)
  assert.ok(argv.includes(hostile.GP_REF), `引用被劈开：${JSON.stringify(argv)}`)
  assert.equal(false, fs.existsSync("/tmp/gp-pwned"), "照抄那一行不该真的执行任何东西")
  assert.equal(false, fs.existsSync("/tmp/gp-pwned2"), "照抄那一行不该真的执行任何东西")
})
