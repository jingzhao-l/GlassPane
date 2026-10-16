/**
 * D2 — the exit-adjacent stderr write, measured through a real pipe.
 *
 * `index.ts`'s `writeDescriptor` comment records the loss ("a 256 KiB piped stderr
 * write stops at the 64 KiB pipe capacity, its tail gone"), but the writer stayed
 * private to that file while `http-gateway-cli.ts` kept using raw
 * `process.stderr.write(...)` immediately before `process.exit(2/3)`. Under a pipe —
 * `| tee`, or launchd's capture — the operator therefore got the exit code with the
 * explanation, including the FATAL "the gateway is not serving" block, truncated.
 *
 * Measured on the unfixed artifact before this file was written
 * (`dist/http-gateway-cli.js`, parent draining the pipe continuously, 100 KB message):
 * 6/6 runs returned exactly 65 536 bytes and lost the sentence naming the bad flag,
 * while the same bytes through `writeDescriptor` returned all 100 005 with the tail.
 * That is what these tests reproduce — with a real child process and a real pipe, not
 * a faked `Writable`, because the thing at risk is the kernel's pipe buffer and the
 * libuv request queue, neither of which a stub has.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HTTP_CLI = fileURLToPath(new URL("../dist/http-gateway-cli.js", import.meta.url));
const MCP_CLI = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const IO_MODULE = fileURLToPath(new URL("../dist/io.js", import.meta.url));

/**
 * Above the 64 KiB pipe capacity, below Linux's 128 KiB per-argument ceiling — the
 * same window `review-2026-10-09.test.mjs` settled on, so this file measures the same
 * thing on both platforms.
 */
const OVER_CAPACITY = 100_000;
const UNDER_CAPACITY = 10_000;
/** The sentence an operator needs, and the one that sits at the end of the message. */
const TAIL = "|END-OF-EXIT-PATH-MESSAGE|";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gp-exit-writes-"));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

/**
 * A child that prints a message on the exit path and exits, in one of the two
 * shapes: `raw` is the defect (`process.stderr.write` then `process.exit` on the next
 * line), `writer` is the production `writeDescriptor` imported from `dist/io.js` —
 * the same file the shipped entrypoints use, not a copy of its logic.
 */
const CHILD = path.join(dir, "exit-child.mjs");
fs.writeFileSync(CHILD, `
import process from "node:process";
import { writeDescriptor } from ${JSON.stringify(IO_MODULE)};

const mode = process.argv[2];
const bytes = Number(process.argv[3]);
const text = "z".repeat(bytes - ${JSON.stringify(TAIL)}.length - 1) + "\\n" + ${JSON.stringify(TAIL)};

if (mode === "raw") {
  process.stderr.write(text);
} else if (mode === "writer") {
  writeDescriptor(2, text);
} else {
  process.stderr.write("no answer for mode '" + mode + "'\\n");
  process.exit(9);
}
process.exit(2);
`);

/** Spawn with `fd 2` a real pipe the parent reads continuously, like `| tee`. */
function runCapturingStderr(file, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stderrBytes = 0;
    let stderrText = "";
    child.stdout.resume();
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrBytes += Buffer.byteLength(chunk);
      stderrText += chunk;
    });
    child.on("error", (error) => {
      throw error;
    });
    child.on("close", (code) => {
      // One turn for the pipe to empty into the parent, then read the bytes back.
      setTimeout(() => resolve({ code, stderrBytes, stderrText }), 250);
    });
  });
}

test("a raw exit-path stderr write loses its tail through a real pipe (the premise)", async () => {
  // The measurement every assertion below is judged against: a *queued* piped write
  // followed by `process.exit()` hands the kernel what the pipe can hold and dies with
  // the rest. That is what this machine (macOS) does — and CI's ubuntu runner does NOT:
  // there the same 100 000 bytes all arrive before the process is reaped, so the
  // premise cannot be reproduced there at all.
  //
  // So the premise is measured, not demanded: whichever regime the runner is in, the
  // platform-independent half of the claim is still asserted (the under-capacity control
  // must arrive whole, and the child must exit by itself). When truncation does not
  // reproduce, that is printed — a survival assertion that cannot fail here is worth
  // nothing, and pretending otherwise would make this gate lie on the machine it ran on.
  const messageBytes = OVER_CAPACITY;
  const raw = await runCapturingStderr(CHILD, ["raw", String(messageBytes)]);
  assert.equal(raw.code, 2, `the child must exit by itself, not be killed: ${raw.code}`);
  const truncated = !raw.stderrText.includes(TAIL);
  if (truncated) {
    assert.ok(raw.stderrBytes < messageBytes,
      `tail absent yet delivered ${raw.stderrBytes} of ${messageBytes} bytes：这两个读数互相矛盾`);
    console.log(`# premise: 这台 runner 上退出路径的管道写会截尾（${raw.stderrBytes}/${messageBytes}）`);
  } else {
    console.log(`# premise-not-reproducible: 这台 runner 把 ${raw.stderrBytes} 字节全送完了，`
      + "退出前把管道排空了；下面的存活断言仍在本机执行，只是没有可比的截尾参照");
  }
  // And the loss is the *capacity*, not "pipes drop things at any size": the same
  // raw writer under 64 KiB delivers whole. Without this control the gate would pass
  // on a message that was never at risk.
  const small = await runCapturingStderr(CHILD, ["raw", String(UNDER_CAPACITY)]);
  assert.equal(small.stderrBytes, UNDER_CAPACITY, `the under-capacity control wrote ${small.stderrBytes} bytes`);
  assert.equal(small.stderrText.includes(TAIL), true, "the under-capacity control must not truncate");
});

test("writeDescriptor delivers the same oversize message complete through the same pipe", async () => {
  const raw = await runCapturingStderr(CHILD, ["raw", String(OVER_CAPACITY)]);
  const fixed = await runCapturingStderr(CHILD, ["writer", String(OVER_CAPACITY)]);
  assert.equal(fixed.code, 2);
  // 这一半在两种 runner 上都判得动：共享写者必须把整句话送完，包括最后一行。
  assert.equal(fixed.stderrBytes, OVER_CAPACITY,
    `the shared writer delivered ${fixed.stderrBytes} of ${OVER_CAPACITY} bytes`);
  assert.equal(fixed.stderrText.includes(TAIL), true, "the last sentence must arrive");
  // 只有在这台机器真的截尾时，"写者改变了结局"才是可证的事；否则它就不该被当成通过的理由，
  // 于是这里宁可红着提醒（前一条已经把 regime 打出来了），也不写一条永远成立的比较。
  if (!raw.stderrText.includes(TAIL)) {
    assert.ok(raw.stderrBytes < fixed.stderrBytes,
      `no truncation to compare against (raw ${raw.stderrBytes} vs writer ${fixed.stderrBytes})`);
  }
});

test("glasspane-http's exit-2 argument refusal arrives whole through a pipe", async () => {
  // The operator-visible half, on the real entrypoint: a misspelled flag is echoed
  // into the message, so a long one crosses the pipe capacity, and the tail of that
  // message is the sentence that says which flags are accepted at all.
  const arg = `--socket-pth${"y".repeat(OVER_CAPACITY)}`;
  const run = await runCapturingStderr(HTTP_CLI, [arg], { env: { ...process.env } });
  assert.equal(run.code, 2, `a configuration refusal must exit 2, got ${run.code}`);
  assert.match(run.stderrText, /unknown argument: --socket-pth/);
  assert.match(run.stderrText, /usage: glasspane-http/);
  // The last line of the refusal is the one that used to be cut: it names the flags,
  // which is the operator's only next move.
  assert.ok(
    run.stderrText.includes("A flag spelled wrong here is not an error the daemon will ever report."),
    `the refusal's closing sentence — the next move — never arrived (${run.stderrBytes} bytes received)`,
  );
  assert.ok(run.stderrBytes > OVER_CAPACITY,
    `the whole message must survive the exit; received ${run.stderrBytes} bytes`);
});

test("glasspane-mcp's exit-2 argument refusal arrives whole through a pipe", async () => {
  // Same class on the other bin, and the reason the writer had to be *shared* rather
  // than copied: `index.ts` was already fixed and `glasspane-http` was not, which is
  // how one entrypoint's exit path silently keeps the old bug.
  const arg = `--socket-pth${"x".repeat(OVER_CAPACITY)}`;
  const run = await runCapturingStderr(MCP_CLI, [arg]);
  assert.equal(run.code, 2);
  assert.match(run.stderrText, /unknown argument: --socket-pth/);
  assert.ok(run.stderrBytes > OVER_CAPACITY,
    `the whole message must survive the exit; received ${run.stderrBytes} bytes`);
});

test("glasspane-http's FATAL not-listening block arrives whole and exits 3", async () => {
  // The most consequential of the sites: a gateway that bound nothing. The block is
  // short — well under the pipe capacity — so this half is not a truncation demo; it
  // is the guard that converting these writes did not break the wording, the exit
  // code, or the last line an operator reads while the process is already gone.
  const { createServer } = await import("node:net");
  const blocker = createServer();
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });
  const port = blocker.address().port;
  try {
    const run = await runCapturingStderr(HTTP_CLI, ["--port", String(port)], {
      env: { ...process.env, GLASSPANE_HTTP_TOKEN: "0123456789abcdef-0123456789abcdef" },
    });
    assert.equal(run.code, 3, `a failed bind is fatal and must exit 3, got ${run.code}`);
    assert.match(run.stderrText, /FATAL: the gateway is not serving and this process is exiting/);
    assert.match(run.stderrText, /could not bind 127\.0\.0\.1:/);
    assert.match(run.stderrText, /EADDRINUSE/);
    // The line that stops the operator escalating to a daemon restart, and the last
    // one written before `process.exit(EXIT_LISTEN_FAILED)`.
    assert.match(run.stderrText, /the daemon is not implicated by this line/);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test("no exit-adjacent stderr write is left in the gateway CLI", () => {
  // The shape gate, kept for the case where a machine delivers the bytes anyway: a
  // queued `process.stderr.write` must not sit between a message and the `exit` that
  // cancels it. Read as "the nearest write before each exit", so the two listening
  // lines — which are not exit-adjacent, and deliberately stay asynchronous — pass.
  const source = fs.readFileSync(fileURLToPath(new URL("../src/http-gateway-cli.ts", import.meta.url)), "utf8");
  const exits = [...source.matchAll(/process\.exit\(/g)];
  assert.ok(exits.length >= 7, `the gateway CLI should still exit at every refusal (${exits.length} found)`);
  for (const match of exits) {
    const before = source.slice(Math.max(0, match.index - 900), match.index);
    const cut = before.lastIndexOf("process.exit(");
    const window = cut === -1 ? before : before.slice(cut);
    assert.equal(
      /process\s*\.\s*(stderr|stdout)\s*\.\s*write\s*\(/.test(window),
      false,
      `an exit is preceded by a queued ${window.slice(0, 80).trim()}… — process.exit does not wait for it`,
    );
  }
  assert.match(source, /import \{ writeDescriptor \} from "\.\/io\.js"/,
    "the gateway must use the shared writer, not a local copy of it");
  assert.equal((source.match(/writeDescriptor\(/g) ?? []).length, 8,
    "every exit-adjacent site (config, help, no token, weak token, create failure, FATAL, shutdown, shutdown error) goes through it");
});
