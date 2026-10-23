/**
 * D4 — the shape that is actually published, and the two entries that ship in it.
 *
 * Every other test in this directory imports `../dist/*.js`, and `dist` is what
 * `npm run build` (tsc) writes: one module per source file, importing its siblings.
 * What `npm publish` ships is something else: `prepublishOnly` runs `npm run bundle`,
 * whose esbuild output *overwrites* those same paths and then deletes every other
 * `dist/*.js` (`find dist -maxdepth 1 -name '*.js' ! -name ... -delete`). The suite
 * had never executed the artifact that is delivered — the two are different files with
 * the same names.
 *
 * So this file builds the real thing, in a scratch tree, and drives it:
 *
 *   npm run bundle  ->  npm pack  ->  npm i -g --prefix <scratch>  ->  spawn <prefix>/bin/...
 *
 * with no `node` in front of the bin, because that is the claim being tested: the
 * symlink resolves, the exec bit is set on the file it points at, the shebang survived
 * bundling, and the bundle answers a framed stdio session against a daemon on a real
 * Unix socket.
 *
 * The second half is the entry point itself. `src/index.ts` is both the bin and the
 * package's root export, and it calls `main()` at import: `import "glasspane-mcp"`
 * takes over whatever process did it. That is the documented behaviour of a *program*
 * entry, and the split keeps the library half reachable as its own export
 * (`glasspane-mcp/stdio-session`), which imports cleanly and touches neither stdin nor
 * stdout. Both halves are asserted here against the **installed package**, by package
 * specifier, because `exports` is what decides whether a consumer can reach them at
 * all: before `./stdio-session` was listed, the clean entry shipped in `files` and no
 * consumer could import it (`ERR_PACKAGE_PATH_NOT_EXPORTED`), so the split existed on
 * disk and nowhere else. The split is deliberately *not* an `argv[1]`/`require.main`
 * self-exec guard — that guard is the shape that made a bin symlink resolve to a module
 * nobody ran and 0-byte'd the published package across 19 versions.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SERVER_INFO } from "../dist/dispatch.js";
import { ENGINE_SOCKET_ENV } from "../dist/engine-client.js";
import { FAKE_PROBE_BUNDLE_ID, startFakeDaemon } from "./support/fake-daemon.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELL = path.resolve(HERE, "..");
const WORKTREE = path.resolve(SHELL, "..");

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "gp-published-"));
after(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

/** PATH with the worktree's hoisted `.bin` first: esbuild lives at the repo root. */
/**
 * 干净、且**与自己一份缓存绑定**的外部 npm 环境。
 *
 * 两个坑都是这台机器实测到的：
 * ① 从父 `npm test` 继承下来的 `npm_config_*` / `npm_lifecycle_*` / `npm_execpath`
 * 会让嵌套的 `npm pack` 走生命周期语义；
 * ② 更关键——`npm pack` 会把 tarball 写进 `~/.npm/_cacache`，而那台机器上的共享缓存里
 * 已经有一个同键的文件（实测：`File exists: ~/.npm/_cacache/content-v2/sha512/f0/a4`，
 * 退 243）。一条测试不该依赖"用户的全局缓存此刻恰好干净"，所以给它一份自己的缓存目录。
 * 同时**不许**用 `--silent`：那正是这条红读起来像"包坏了"的原因——npm 在 --silent 下
 * 失败时一句话都不打（stdout/stderr 全空，只剩一个 243）。
 * 这里把 worktree 的 .bin 放在 PATH 前面，让 esbuild/tsc 还能被 bundle 脚本找到。
 */
const ENV = (() => {
  const env = { ...process.env, PATH: `${path.join(WORKTREE, "node_modules", ".bin")}:${process.env.PATH}` };
  for (const key of Object.keys(env)) {
    if (
      /^npm_(config|lifecycle|package|init|user|loglevel)/.test(key)
      || key === "npm_execpath"
      || key === "npm_config"
    ) {
      delete env[key];
    }
  }
  env.npm_config_cache = path.join(SCRATCH, "npm-cache");
  return env;
})();

function run(program, args, cwd, { timeoutMs = 900_000 } = {}) {
  const res = spawnSync(program, args, {
    cwd,
    env: ENV,
    encoding: "utf8",
    timeout: timeoutMs,
    // npm's own progress output goes to stderr; the 1 MiB default truncates it and
    // `spawnSync` then reports ENOBUFS as a failed install with no message at all —
    // which is exactly the shape of a misleading red.
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    error: res.error ? String(res.error) : null,
  };
}

/**
 * Build, pack and install once for the whole file: each of these is minutes on a
 * loaded machine, and they all describe the same artifact.
 */
let artifact = null;
function linkInto(target, dest) {
  // 幂等：一次 setup 半途而废之后，后面每条用例都会在这里再撞一次 EEXIST，
  // 于是一个 npm pack 的失败变成七条互不相干的红。软链已经在了就跳过，
  // 让第一条失败保持它本来的样子（并且只失败一次）。
  if (fs.existsSync(dest)) return;
  fs.symlinkSync(target, dest);
}

function published() {
  if (artifact !== null) {
    return artifact;
  }
  const tree = path.join(SCRATCH, "tree");
  const pkg = path.join(tree, "mcp-shell");
  fs.mkdirSync(path.join(pkg, "dist"), { recursive: true });
  // The scratch tree stands where the worktree's own layout puts a package relative to its
  // dependencies: esbuild and zod resolve from the hoisted root `node_modules`, the shipped
  // schemas are copied by `../scripts/bundle-kernel-schemas.mjs` out of the installed
  // `iterate-kernel`, and `../kernel` is the pinned corpus the archive's schema list is
  // required against (the bundle itself no longer reads it).
  linkInto(path.join(WORKTREE, "node_modules"), path.join(tree, "node_modules"));
  linkInto(path.join(WORKTREE, "kernel"), path.join(tree, "kernel"));
  linkInto(path.join(WORKTREE, "scripts"), path.join(tree, "scripts"));
  linkInto(path.join(SHELL, "node_modules"), path.join(pkg, "node_modules"));
  for (const name of ["package.json", "tsconfig.json", "LICENSE", "README.md"]) {
    fs.copyFileSync(path.join(SHELL, name), path.join(pkg, name));
  }
  fs.cpSync(path.join(SHELL, "src"), path.join(pkg, "src"), { recursive: true });

  const bundle = run("npm", ["run", "bundle"], pkg);
  assert.equal(bundle.status, 0, `npm run bundle failed in the scratch tree: ${bundle.stderr.slice(0, 900)}`);
  const packed = run("npm", ["pack"], pkg);
  // npm 在负载下有时会不带一句话就退出（实测 243、stderr 全空）。那时 stdout 与
  // spawn 自己的 error 字段是仅有的线索，必须一起报出来，不然这条红读起来像是
  // 发布物坏了，而其实是一次子进程没跑完。
  assert.equal(
    packed.status,
    0,
    `npm pack failed (${packed.status}; ${packed.error ?? "no spawn error"}): `
    + `stderr=${packed.stderr.slice(0, 900)} stdout=${packed.stdout.slice(-900)}`,
  );
  const tarball = path.join(pkg, packed.stdout.trim().split("\n").pop());
  assert.ok(fs.existsSync(tarball), `no tarball at ${packed.stdout.trim()}`);

  const prefix = path.join(SCRATCH, "prefix");
  const install = run("npm", [
    "i", "-g", "--prefix", prefix, "--omit=dev", "--no-audit", "--no-fund", "--prefer-offline", tarball,
  ], SCRATCH);
  assert.equal(
    install.status,
    0,
    `the packed artifact did not install into a prefix (${install.status}; `
    + `${install.error ?? "no spawn error"}): `
    + `${install.stderr.slice(0, 900) || install.stdout.slice(-900)}`,
  );

  artifact = {
    pkg,
    tarball,
    prefix,
    bin: path.join(prefix, "bin", "glasspane-mcp"),
    httpBin: path.join(prefix, "bin", "glasspane-http"),
    libRoot: path.join(prefix, "lib", "node_modules", "glasspane-mcp"),
  };
  return artifact;
}

/**
 * A second, *local* install of the same tarball, to import from.
 *
 * The two entries are reached by package specifier (`glasspane-mcp`,
 * `glasspane-mcp/stdio-session`), and the only way to test what `exports` delivers is to
 * resolve it the way a consumer does: a real `node_modules` inside a project that asked
 * npm for the package. A path import of `dist/stdio-session.js` would bypass the map
 * entirely and prove nothing about reachability.
 */
let consumer = null;
function consumerDir() {
  if (consumer !== null) {
    return consumer;
  }
  const { tarball } = published();
  const dir = path.join(SCRATCH, "consumer");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "gp-published-consumer",
    private: true,
    type: "module",
  }) + "\n");
  const installed = run("npm", [
    "i", "--prefix", dir, "--no-audit", "--no-fund", "--prefer-offline", tarball,
  ], dir);
  assert.equal(
    installed.status,
    0,
    `the packed artifact did not install into a consumer project (${installed.status}; `
    + `${installed.error ?? "no spawn error"}): ${installed.stderr.slice(0, 900) || installed.stdout.slice(-900)}`,
  );
  consumer = {
    dir,
    packageRoot: path.join(dir, "node_modules", "glasspane-mcp"),
  };
  assert.ok(fs.existsSync(path.join(consumer.packageRoot, "package.json")), "npm did not lay the package down");
  return consumer;
}

/** Spawn a bin the way a host does: the installed path, no interpreter in front. */
function spawnBin(binPath, args, env = {}) {
  return spawn(binPath, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...ENV, ...env } });
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "publisher-test", version: "1" } },
};
const TOOLS_LIST = { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} };
const PROBE = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "gp_probe_status", arguments: {} } };

function lines(...objects) {
  return objects.map((o) => `${JSON.stringify(o)}\n`).join("");
}

/**
 * Drive one stdio session against the installed bin and the fake daemon.
 *
 * `split` names frame *indices* whose bytes are written in two writes 40ms apart, so
 * the reader has to reassemble a frame across a chunk boundary — which is what a Unix
 * socket and a pipe actually hand it.
 *
 * stdin is held open until every id in `expect` has been answered, then closed, and a
 * 180s ceiling closes it anyway: the shell queues `shutdown()` behind the replies it
 * already took, so closing on arrival is the session ending normally, while closing on
 * the ceiling lets a mutation show up as a red assertion instead of a hung suite.
 *
 * The reply frames come back parsed (`replyFrames`), unparsed lines included as
 * `{unparsed: …}`, and the bytes are kept alongside them (`rawOut`): an assertion that
 * reached for a property this does not return is how a whole stdio session silently
 * proved nothing.
 */
function session(binPath, args, frames, { expect, env = {}, split = [] } = {}) {
  return new Promise((resolve) => {
    const child = spawnBin(binPath, args, env);
    let out = "";
    let err = "";
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdin.on("error", () => undefined);
    const settle = (code) => {
      if (settled) {
        return;
      }
      settled = true;
      const replyFrames = out
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return { unparsed: line };
          }
        });
      resolve({ replyFrames, rawOut: out, err, code });
    };
    const seenAll = () => expect.every((id) => out.includes(`"id":${id}`));
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (seenAll() && !child.stdin.writableEnded) {
        child.stdin.end();
      }
    });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("close", (code) => setTimeout(() => settle(code), 100));

    (async () => {
      for (let index = 0; index < frames.length; index++) {
        if (child.stdin.writableEnded || child.stdin.destroyed) {
          return;
        }
        const text = frames[index];
        if (split.includes(index)) {
          const cut = Math.floor(text.length / 2);
          child.stdin.write(text.slice(0, cut));
          await new Promise((r) => setTimeout(r, 40));
          if (!child.stdin.writableEnded) {
            child.stdin.write(text.slice(cut));
          }
        } else {
          child.stdin.write(text);
        }
        await new Promise((r) => setTimeout(r, 30));
      }
    })();

    const ceiling = setTimeout(() => {
      if (!child.stdin.writableEnded) {
        child.stdin.end();
      }
    }, 180_000);
    ceiling.unref();
  });
}

/** One line out of the session's replies, by JSON-RPC id; absent means absent. */
function replyFor(result, id) {
  return result.replyFrames.find((frame) => frame !== null && typeof frame === "object" && frame.id === id) ?? null;
}

test("the bundle is a different artifact from the tsc build the suite imports", () => {
  const { pkg } = published();
  const pkgJson = JSON.parse(fs.readFileSync(path.join(SHELL, "package.json"), "utf8"));
  // The publish chain, stated: what ships is build-then-bundle, so `dist/index.js` at
  // publish time is the esbuild output, not the tsc output the suite imports.
  assert.match(pkgJson.scripts.prepublishOnly, /^npm run build && npm run bundle$/,
    `prepublishOnly no longer bundles over the tsc build: ${pkgJson.scripts.prepublishOnly}`);

  const shipped = fs.readFileSync(path.join(pkg, "dist", "index.js"), "utf8");
  const tested = fs.readFileSync(path.join(SHELL, "dist", "index.js"), "utf8");
  assert.match(shipped, /^#!\/usr\/bin\/env node/, "the bundle must keep the shebang or the bin cannot be exec'd");
  assert.equal(/from "\.\//.test(shipped), false,
    "the bundle must be self-contained: a relative import in what is shipped means it is not the bundle");
  assert.match(tested, /from "\.\/[\w-]+\.js"/, "the tsc build is the multi-file one, as expected");
  assert.notEqual(shipped, tested, "the two artifacts are the same path with different bytes — the point of this file");
  // zod stays external in both, which is why the install step below has to work.
  assert.match(shipped, /from "zod"/, "zod must stay external, as the bundle script declares");
});

test("the packed artifact carries the delivered entry, the schemas and no source", () => {
  const { tarball } = published();
  const listing = run("tar", ["-tzf", tarball], SCRATCH);
  assert.equal(listing.status, 0, listing.stderr.slice(0, 400));
  const entries = listing.stdout.split("\n").filter((l) => l.trim() !== "");
  for (const needed of [
    "package/dist/index.js",
    "package/dist/http-gateway-cli.js",
    "package/dist/http-gateway.js",
    "package/dist/stdio-session.js",
    "package/schemas/evidence-pack.schema.json",
    "package/package.json",
  ]) {
    assert.ok(entries.includes(needed), `${needed} is not in the packed artifact: ${entries.join(", ")}`);
  }
  assert.equal(entries.some((e) => e.startsWith("package/src/")), false, "source must not ship");

  // 2026-10-23（缺陷 83 的第二半）：那份 schema 光"在档里"还不够——它对外声明的上限必须与
  // **同一个包里执行的那份验证器**是同一个数。`kernel-validator-bound.test.mjs` 量的是
  // tracked 语料 ↔ 装好的内核；这一条量的是发布 tarball 里的那一份，也就是用户机器上真被读到的
  // 那份字节。两处不同号时，包对外声明一个上限、执行另一个，而没有任何一条闸会说这件事。
  const schemaText = run("tar", ["-xzOf", tarball, "package/schemas/decision-log-entry.schema.json"], SCRATCH)
  assert.equal(schemaText.status, 0, `tarball 里读不出那份 schema：${schemaText.stderr.slice(0, 300)}`)
  const shippedBound = JSON.parse(schemaText.stdout)?.properties?.summary?.maxLength
  assert.equal(typeof shippedBound, "number", "发出去的 schema 里没有 properties.summary.maxLength")
  const kernelDir = fs.existsSync(path.join(WORKTREE, "node_modules", "iterate-kernel"))
    ? path.join(WORKTREE, "node_modules", "iterate-kernel")
    : path.join(WORKTREE, "mcp-shell", "node_modules", "iterate-kernel")
  const validatorSrc = fs.readFileSync(path.join(kernelDir, "dist", "decision-log-entry.js"), "utf8")
  const validatorBound = Number(/export const SUMMARY_MAX_LENGTH = ([0-9]+);/.exec(validatorSrc)?.[1])
  assert.ok(Number.isFinite(validatorBound), "装好的内核里读不到 SUMMARY_MAX_LENGTH，这一条就没法核对")
  assert.equal(shippedBound, validatorBound,
    `发布包对外声明 summary.maxLength=${shippedBound}，而它捆进去的内核执行的是 ${validatorBound}`)
});

test("the installed bin is a symlink into the package and execs through its shebang", () => {
  const { bin, httpBin, libRoot } = published();
  for (const binPath of [bin, httpBin]) {
    assert.ok(fs.lstatSync(binPath).isSymbolicLink(), `${binPath} must be the npm bin symlink`);
    const target = fs.realpathSync(binPath);
    assert.ok(target.startsWith(fs.realpathSync(libRoot)), `${binPath} resolves outside the installed package: ${target}`);
    assert.match(fs.readFileSync(target, "utf8").split("\n")[0], /^#!\/usr\/bin\/env node/,
      `${target} lost its shebang in the bundle`);
    // The mode bit npm sets for `bin` entries: without it, the symlink cannot be exec'd
    // and every host that spawns it by name fails with EACCES. `mode & 0o111` is the
    // number to compare — `assert.equal(x & 0o111 !== 0, true)` compares that number
    // against `true`, can never pass, and used to throw here before the real proof below
    // ever ran.
    // eslint-disable-next-line no-bitwise
    assert.notEqual(fs.statSync(target).mode & 0o111, 0, `${target} is not executable`);
  }

  // And the proof, not the paperwork: spawn the symlink with no interpreter in front.
  // `spawnSync` resolving a shebang is the whole claim — the file is the bundle, the
  // kernel execs it, and `node` is found through the shebang's `/usr/bin/env`.
  const help = spawnSync(bin, ["--help"], { env: ENV, encoding: "utf8", timeout: 300_000 });
  assert.equal(help.error, undefined, `spawning the installed symlink failed: ${help.error}`);
  assert.equal(help.status, 0, `--help through the symlink exited ${help.status}`);
  assert.match(help.stdout, /usage: glasspane-mcp/, help.stdout.slice(0, 200));

  const httpHelp = spawnSync(httpBin, ["--help"], { env: ENV, encoding: "utf8", timeout: 300_000 });
  assert.equal(httpHelp.error, undefined, `spawning the http symlink failed: ${httpHelp.error}`);
  assert.match(httpHelp.stdout + httpHelp.stderr, /usage: glasspane-http/,
    `the second command did not exec through its shebang: ${(httpHelp.stdout + httpHelp.stderr).slice(0, 300)}`);
});

test("the installed bundle answers a stdio session against a daemon on a real socket", async () => {
  const { bin } = published();
  const daemon = await startFakeDaemon(path.join(SCRATCH, "engine.sock"), {
    version: SERVER_INFO.version,
    splitFrames: true,
  });
  try {
    const result = await session(
      bin,
      ["--socket-path", daemon.socketPath],
      [
        lines(INITIALIZE),
        lines({ jsonrpc: "2.0", method: "notifications/initialized" }),
        lines(PROBE),
        lines(TOOLS_LIST),
      ],
      { expect: [1, 2, 3], split: [2] },
    );
    const hello = replyFor(result, 1);
    assert.ok(hello, `no initialize reply; stdout was ${result.rawOut.slice(0, 400)}; stderr ${result.err.slice(0, 300)}`);
    assert.equal(hello.error, undefined, JSON.stringify(hello));
    assert.equal(hello.result?.serverInfo?.name, "glasspane-mcp", "the reply must name this package");
    assert.equal(typeof hello.result?.protocolVersion, "string", `the initialize reply must name a protocol: ${JSON.stringify(hello.result?.serverInfo ?? null)}`);

    // The tool table the published bundle carries — the same `TOOL_SPECS` an agent reads
    // before it forms a request, out of the artifact that is actually shipped.
    const tools = replyFor(result, 3);
    assert.ok(tools, `tools/list never answered: ${result.rawOut.slice(0, 400)}`);
    assert.equal(tools.error, undefined, JSON.stringify(tools));
    assert.ok(Array.isArray(tools.result?.tools), `tools/list answered without a tool array: ${JSON.stringify(tools.result ?? null)}`);
    assert.ok(tools.result.tools.length >= 10, `the shipped bundle advertises only ${tools.result.tools.length} tools`);
    for (const name of ["gp_probe_status", "gp_act", "gp_recent_reports"]) {
      assert.ok(tools.result.tools.some((tool) => tool.name === name), `gp_${name} is not in the published tool table`);
    }

    const probe = replyFor(result, 2);
    assert.ok(probe, `the daemon round trip never answered: ${result.rawOut.slice(0, 400)}`);
    assert.equal(probe.result?.isError, false, JSON.stringify(probe.result?.content?.[0]?.text ?? probe.result ?? probe).slice(0, 400));
    assert.match(probe.result.content[0].text, new RegExp(FAKE_PROBE_BUNDLE_ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "the bytes must come from the daemon on the socket, through the bundle's own transport");
    assert.equal(result.code, 0, `the session should exit cleanly on stdin close, got ${result.code}: ${result.err.slice(0, 300)}`);
  } finally {
    await daemon.stop();
  }
});

test("the installed bundle survives an oversize frame and a non-JSON line, and keeps serving", async () => {
  const { bin } = published();
  const daemon = await startFakeDaemon(path.join(SCRATCH, "engine-2.sock"), { version: SERVER_INFO.version });
  const oversize = `${JSON.stringify({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    // A blob past `MAX_FRAME_BYTES`, with the `"id"` early so the shell can attribute
    // the drop instead of leaving that caller waiting.
    params: { name: "gp_observe", arguments: { blob: "b".repeat(4 * 1024 * 1024 + 64 * 1024) } },
  })}\n`;
  try {
    const result = await session(
      bin,
      ["--socket-path", daemon.socketPath],
      [
        lines(INITIALIZE),
        oversize,
        "{not json at all\n",
        lines(PROBE),
      ],
      { expect: [1, 7, 2] },
    );
    const tooBig = replyFor(result, 7);
    assert.ok(tooBig, `the oversize request was never answered: ${result.rawOut.slice(0, 400)}`);
    assert.match(tooBig.error?.message ?? "", /GP_E_PAYLOAD_TOO_LARGE/, JSON.stringify(tooBig));
    assert.equal(tooBig.error.code, -32600, "an unframeable request is an invalid request, not a crash");

    const parseError = result.replyFrames.find((frame) => frame?.error?.code === -32700);
    assert.ok(parseError, `a non-JSON line must be answered as a parse error and not kill the session: ${result.rawOut.slice(0, 400)}`);

    const probe = replyFor(result, 2);
    assert.ok(probe, "the session must keep answering after both a dropped frame and a parse error");
    assert.match(probe.result?.content?.[0]?.text ?? "", new RegExp(FAKE_PROBE_BUNDLE_ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await daemon.stop();
  }
});

/* ------------------------------------------------------------------ *
 * The two entries, imported the way a consumer imports them.
 *
 * The harness imports one specifier, then tries to read the stdin the parent handed
 * the process. A module that self-executes queues itself on that same stream and
 * answers the frame on stdout — which is the root entry's documented behaviour, and is
 * what makes the library half worth having. It waits a settle window before reporting
 * because the shell's reply is queued behind the frame that produced it: reading the
 * first newline and exiting in the same tick printed nothing and made the root entry
 * look clean. It writes with `fs.writeSync(1, …)` because the self-executing entry
 * calls `stdout.end()` on its way down, and a stream write after that is dropped.
 * ------------------------------------------------------------------ */

const HARNESS = (specifier) => `
import fs from "node:fs";
import process from "node:process";
await import(${JSON.stringify(specifier)});
let got = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { got += chunk; });
process.stdin.on("error", () => {});
await new Promise((resolve) => setTimeout(resolve, 2500));
fs.writeSync(1, "IMPORTER-STDIN " + JSON.stringify(got) + "\\n");
process.exit(0);
`;

/** Run the importer harness against one specifier, with one initialize frame on stdin. */
function importSpecifier(specifier) {
  const { dir } = consumerDir();
  const harnessPath = path.join(dir, "importer.mjs");
  fs.writeFileSync(harnessPath, HARNESS(specifier));
  const res = spawnSync(process.execPath, [harnessPath], {
    cwd: dir,
    // The socket this process would guess if it ever guessed: pointed into the scratch
    // tree so no importer harness, however it behaves, can reach a real state root.
    env: { ...ENV, [ENGINE_SOCKET_ENV]: path.join(SCRATCH, "importer-must-not-connect.sock") },
    encoding: "utf8",
    input: lines(INITIALIZE),
    timeout: 240_000,
  });
  return {
    out: res.stdout ?? "",
    err: res.stderr ?? "",
    status: res.status,
    error: res.error ? String(res.error) : null,
  };
}

test("importing the library entry by package specifier leaves the importer's stdio alone", () => {
  const { packageRoot } = consumerDir();
  const clean = importSpecifier("glasspane-mcp/stdio-session");
  assert.equal(clean.error, null, `the library entry could not be imported at all: ${clean.error}`);
  assert.match(clean.out, /^IMPORTER-STDIN /m,
    `importing the library entry did not leave a clean importer: ${clean.out.slice(0, 300)} / ${clean.err.slice(0, 300)}`);
  assert.equal(clean.out.includes('"jsonrpc"'), false,
    `the library entry answered the importer's request frame: ${clean.out.slice(0, 300)}`);
  // The bytes the importer was handed back are still its own stdin, unread by the import.
  assert.match(clean.out, /IMPORTER-STDIN ".*method.*initialize.*"/s, clean.out.slice(0, 300));
  // And what was imported is the bundle, not a source tree: the installed package's own
  // file, reached through the map — no relative import to resolve, no `src/` to ship.
  const bundle = fs.readFileSync(path.join(packageRoot, "dist", "stdio-session.js"), "utf8");
  assert.equal(/from "\.\//.test(bundle), false, "the library entry in the installed package is not a bundle");
  assert.match(bundle, /export \{|export\{/, "the library entry must still export its wiring");
});

test("importing the root entry runs the program, exactly as the README documents", () => {
  // The root export is the bin. Importing it *does* take the session: it answers the
  // frame on the importer's stdout. That is asserted rather than wished away, because the
  // alternative — a self-exec guard on the file the bin points at — is the shape that
  // 0-byte'd this package across 19 versions, and because the README tells an embedder
  // which specifier is which.
  const hijack = importSpecifier("glasspane-mcp");
  assert.equal(hijack.error, null, `the root entry could not be imported at all: ${hijack.error}`);
  assert.match(hijack.out, /"serverInfo"/,
    `the root entry no longer runs the program on import — if that changed on purpose, update the README's entry table and this gate together: ${hijack.out.slice(0, 300)}`);
  assert.match(hijack.out, /"jsonrpc":"2\.0"/, `the reply the root entry wrote is not a JSON-RPC frame: ${hijack.out.slice(0, 300)}`);
});

test("package.json names both entries, keeps the bin contract byte-identical, and the README documents them", () => {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(SHELL, "package.json"), "utf8"));
  const readme = fs.readFileSync(path.join(SHELL, "README.md"), "utf8");
  // The bundle must keep emitting the library entry, and the clean-up step must keep it.
  assert.match(pkgJson.scripts.bundle, /src\/stdio-session\.ts/, "the bundle must emit the library entry");
  const findDelete = /find dist[^&]*? -delete/.exec(pkgJson.scripts.bundle);
  assert.match(findDelete[0], /! -name 'stdio-session\.js'/, "the clean-up step must not delete the library entry");

  // `exports` is what makes each entry reachable, so the map is asserted against the
  // artifact the map points into — including the README that tells a consumer which is
  // which, since the root entry's takeover is now a documented property rather than a
  // gap this lane could not close.
  assert.equal(pkgJson.exports["."].default, `./${pkgJson.bin["glasspane-mcp"]}`,
    'exports["."] no longer names the bin: the root entry and the command are a documented pair, update the README table with it');
  assert.equal(pkgJson.exports["./stdio-session"].default, "./dist/stdio-session.js",
    'exports["./stdio-session"] must name the clean entry, or the split ships unreachable');
  assert.match(readme, /glasspane-mcp\/stdio-session/, "the README must document the library specifier a consumer imports");
  assert.match(readme, /exports\["\."\]/, "the README must say what importing the root entry does");

  const { packageRoot } = consumerDir();
  for (const [subpath, file] of Object.entries(pkgJson.exports)) {
    const target = typeof file === "string" ? file : file.default;
    assert.ok(fs.existsSync(path.join(packageRoot, target)), `exports["${subpath}"] points at ${target}, which is not in the installed package`);
  }
  // The bin contract itself: two commands, unchanged paths, and both still executable
  // through the installed symlink (proven above) — a map edit must not move either.
  assert.deepEqual(pkgJson.bin, { "glasspane-mcp": "dist/index.js", "glasspane-http": "dist/http-gateway-cli.js" },
    "the bin contract changed with the exports edit");

  // And the reachability claim is the map's, not the filesystem's: a path npm shipped in
  // `files` is *not* importable unless `exports` says so. Without the guard below, an
  // `exports` block that grew a `"./*"` wildcard would silently turn every build artefact
  // into a public entry — the shape that made `dist/stdio-session.js` reachable-by-accident
  // and the split's promise meaningless.
  const deep = importSpecifier("glasspane-mcp/dist/stdio-session.js");
  assert.match(deep.err + deep.out, /ERR_PACKAGE_PATH_NOT_EXPORTED/,
    `a non-exported deep path imported anyway: ${JSON.stringify({ out: deep.out.slice(0, 200), err: deep.err.slice(0, 300) })}`);
});
