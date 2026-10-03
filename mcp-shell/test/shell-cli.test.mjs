import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, "..", "dist", "index.js");

/** Run the shipped shell with these argv, close stdin, collect the outcome. */
function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end();
  });
}

/**
 * 认不出的参数从前被 `parseArgs` 的循环**静默丢掉**：`--socket-pth /tmp/x` 起得来，
 * 然后连到它自己猜的默认根，而操作者以为自己点名了另一个 daemon。连错 daemon
 * 意味着 act 落在别的 app、别的机器上，而这一面没有任何东西会再提这件事。
 *
 * 反向变异：删掉 `parseArgs` 里新增的 `else { throw }`，这一条整块变红
 * （进程会以 0 退出并安静地等着 stdin）。
 */
test("a misspelled or stray argument refuses to start instead of guessing", async () => {
  for (const argv of [["--socket-pth", "/tmp/nope"], ["nonsense"], ["--socket-pathx=/tmp/nope"]]) {
    const { code, err } = await run(argv);
    assert.notEqual(code, 0, `${argv.join(" ")}：打错的开关不能被判成"没有这个开关"，它必须当场拒绝`);
    assert.match(err, /unknown argument/, `${argv.join(" ")} 要说出是哪个参数不认识：${err}`);
    assert.match(err, /usage:/, "拒绝要带上它能听懂的写法");
  }
});

test("the two flags that do exist still work", async () => {
  const help = await run(["--help"]);
  assert.equal(help.code, 0, help.err);
  assert.match(help.out + help.err, /--socket-path/);
  const named = await run(["--socket-path", "/tmp/glasspane-definitely-not-listening.sock"]);
  assert.equal(named.err.match(/unknown argument/g) ? 1 : 0, 0,
    `合法点名不该被误伤：${named.err}`);
});
