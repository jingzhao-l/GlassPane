/**
 * A remedy command may not let a path it names re-shape itself.
 *
 * This product's own rule is that a remedy is a command an agent runs on the machine it
 * is told this on. Every one of those commands is built by interpolating a path this
 * process did not author: a state root from `--state-dir` / `GLASSPANE_STATE_DIR` /
 * `GLASSPANE_PROJECTS_FILE`, a socket path from the daemon's own reply, an updater's
 * `runtime.cliPath` out of `update-install.json`. Unquoted, such a value is not an
 * argument — it is shell *text*: `/tmp/x\`;touch /tmp/pwned` turns "look at this file"
 * into "run this", and the double-quoted shape one helper used to reach for does not fix
 * it, because a command substitution expands inside double quotes too.
 *
 * So there is one quoting rule, and this file checks both halves:
 *  - the reachable producers, driven with hostile paths through the real code, with each
 *    command they emitted parsed the way a shell would parse it;
 *  - every command-shaped template literal in `src/` **and in `updater/`** (`updater/lib/*.js`
 *    and `updater/*.js`, 2026-10-22: the updater interpolates daemon-reported state roots into
 *    remedies the same way and its own helper is `updater/lib/shell-quote.js`, the ported twin
 *    of this package's `quoteShellArg` — the packages ship separately and cannot share an
 *    import, so the shared thing is the *gate*, which now sees both sides' files), so a site
 *    no test on this machine can reach (a read-only volume's `chmod`, an `fsync` failure's
 *    `ls -lO`) is covered by the same rule rather than by remembering to check it.
 *
 * MUTATION THIS PINS: drop a `quoteShellArg(...)` at any of those sites and the source
 * gate names it; make the helper double-quote (or delete it and interpolate raw) and the
 * behavioural half goes red on the hostile path, with the injected word appearing as a
 * separate shell word.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { quoteShellArg } from "../dist/errors.js";
import { absoluteNodeCommand, readUpdateState, STATE_DIR_ENV } from "../dist/update-state.js";
import { daemonUnreachableRemedy } from "../dist/engine-client.js";
import { FORCE_OVERWRITE_ENV, PROJECTS_FILE_ENV, registryReaders } from "../dist/project-registry.js";
import { TOOL_BY_NAME, executeTool } from "../dist/tools.js";
import { EvidenceAuditSession } from "../dist/audit-session.js";
import { makeEngine } from "./helpers.mjs";
import { executableSource } from "./support/source.mjs";

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "src");
const UPDATER = path.resolve(SRC, "..", "..", "updater");

/**
 * The scan set: this package's TypeScript sources, and the standalone updater's plain-JS
 * sources (lib/ plus the two package-root scripts). Same argument-position judgement for
 * all of them — only the file set widened, never the rule.
 */
const SCAN_TARGETS = [
  { label: "src", dir: SRC, ext: ".ts" },
  { label: "updater/lib", dir: path.join(UPDATER, "lib"), ext: ".js" },
  { label: "updater", dir: UPDATER, ext: ".js" },
];

/** The three payloads: command substitution via backtick, a space, and a single quote. */
const HOSTILE = {
  backtick: "/tmp/x`;touch /tmp/pwned",
  space: "/tmp/a b/update-state.json",
  quote: "/tmp/it's/update-state.json",
};

/* ------------------------------------------------------------------ *
 * The reader: split a command the way `sh` does, and refuse anything a
 * shell would act on. `throws` here is the whole test — an inert command
 * has no unquoted operator, expansion, glob or dangling quote in it.
 * ------------------------------------------------------------------ */

function shellWords(cmd) {
  const words = [];
  let current = null;
  let i = 0;
  const flush = () => {
    if (current !== null) {
      words.push(current);
      current = null;
    }
  };
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === " " || c === "\t" || c === "\n") {
      flush();
      i++;
      continue;
    }
    if (c === ";" || c === "|" || c === "&" || c === "<" || c === ">") {
      throw new Error(`unquoted control operator ${JSON.stringify(c)} in: ${cmd}`);
    }
    if (c === "`") {
      throw new Error(`unquoted backtick (command substitution) in: ${cmd}`);
    }
    if (c === "$" && (cmd[i + 1] === "(" || cmd[i + 1] === "{")) {
      throw new Error(`unquoted expansion ${JSON.stringify(c + cmd[i + 1])} in: ${cmd}`);
    }
    if (c === "*" || c === "?" || c === "[") {
      throw new Error(`unquoted glob ${JSON.stringify(c)} in: ${cmd}`);
    }
    if (c === "'") {
      current = current ?? "";
      i++;
      while (i < cmd.length && cmd[i] !== "'") {
        current += cmd[i];
        i++;
      }
      if (i >= cmd.length) throw new Error(`unterminated single quote in: ${cmd}`);
      i++;
      continue;
    }
    if (c === '"') {
      // A double-quoted run is NOT inert: `$` and backtick still expand inside it, which
      // is exactly why the helper this file guards uses single quotes.
      current = current ?? "";
      i++;
      let inner = "";
      while (i < cmd.length && cmd[i] !== '"') {
        inner += cmd[i];
        i++;
      }
      if (i >= cmd.length) throw new Error(`unterminated double quote in: ${cmd}`);
      i++;
      if (/[$`]/.test(inner)) {
        throw new Error(`double quotes are not inert quoting — ${JSON.stringify(inner)} still expands`);
      }
      current += inner;
      continue;
    }
    if (c === "\\") {
      current = current ?? "";
      current += cmd[i + 1] ?? "";
      i += 2;
      continue;
    }
    current = current ?? "";
    current += c;
    i++;
  }
  flush();
  return words;
}

/** Every backticked command in a reply an agent reads. */
function commandsIn(text) {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);
}

/**
 * The assertion, in the order the facts actually come in:
 *  1. every hostile path arrives wrapped in the quoting helper's own output, and after
 *     masking each such wrapped run away, **no bare copy of the path survives anywhere**
 *     in the sentence — that is the injection, and it is decided on the text itself;
 *  2. the sentences' backticked commands, read *after* that masking, still parse as inert
 *     shell (no operator, no expansion, no dangling quote), which is the evidence that a
 *     repair line is a command and not a shrug.
 *
 * The order matters and this file changed once already for it. This used to slice the
 * reply on backticks first and shell-parse each slice — and one of the payloads
 * (`/tmp/x`;touch…) *is* a backtick, so the slice boundary landed inside a filename and
 * the gate began reporting its own parser as a product defect ("node '/tmp/x — unterminated
 * single quote"). A control that fails on its own fixture is not a control.
 */
const MASKED_PATH = "@@PATH@@";

function assertCommandsKeepPathsInert(text, label, paths = [HOSTILE.space, HOSTILE.quote]) {
  let masked = text;
  let quotedSeen = 0;
  for (const p of paths) {
    const quoted = quoteShellArg(p);
    quotedSeen += masked.split(quoted).length - 1;
    masked = masked.split(quoted).join(MASKED_PATH);
  }
  // 任何一段单引号包住的文字都是一个已经安全的词，整段遮掉才不会再被路径自己的引号劈开。
  masked = masked.replace(/'[^'\n]*'/g, MASKED_PATH);
  const commands = commandsIn(masked);
  assert.ok(commands.length > 0, `${label}: 这句话里没有反引号命令，这条闸什么也没看`);
  if (paths.length === 0) return commands;
  assert.ok(quotedSeen > 0, `${label}: 这句话里一条引号包好的路径都没有，闸在看别的东西：${text}`);
  for (const cmd of commands) {
    let words;
    try {
      words = shellWords(cmd);
    } catch (error) {
      assert.fail(`${label}: 命令 ${JSON.stringify(cmd)} 会被 shell 拆成别的东西 — ${error.message}`);
    }
    for (const p of paths) {
      // 判据的范围是**命令**，不是整句话：句子用普通文字点名一个路径不构成注入，坐在参数位上
      // 的那一份才构成。所以先遮掉引号包好的形态，再看还剩在命令里的裸路径。
      assert.ok(!cmd.includes(p),
        `${label}: 遮掉包好形态之后，命令里还剩一份裸路径 ${JSON.stringify(p)}：${cmd}`);
    }
    if (cmd.includes(MASKED_PATH)) {
      assert.equal(words.filter((word) => word === MASKED_PATH).length, 1,
        `${label}: 包好的路径没有落成恰好一个词：${JSON.stringify(words)}`);
    }
  }
  return commands;
}

/* -------------------------- the helper itself -------------------------- */

test("quoteShellArg is POSIX single quoting: inert for the payloads, bare for what cannot act", () => {
  assert.equal(quoteShellArg(HOSTILE.backtick), `'${HOSTILE.backtick}'`);
  assert.equal(quoteShellArg(HOSTILE.space), `'${HOSTILE.space}'`);
  // The embedded quote is spliced out and re-added, which is the only correct way to put a
  // single quote inside a single-quoted word.
  assert.equal(quoteShellArg("/tmp/it's/x"), `'/tmp/it'\\''s/x'`);
  assert.equal(quoteShellArg("/Users/me/.glasspane"), "/Users/me/.glasspane", "普通绝对路径不该被裹起来");
  assert.equal(quoteShellArg(""), "''", "空串不写就是少一个参数：那已经是另一个命令行");
  assert.equal(quoteShellArg("-rf"), "'-rf'", "以 - 开头的值会被读成选项");
  for (const [label, p] of Object.entries(HOSTILE)) {
    const command = `chmod 600 ${quoteShellArg(p)}`;
    assert.deepEqual(shellWords(command), ["chmod", "600", p], `${label}: 引号没有把它还原成一个词`);
  }
});

test("the checker bites: the same paths unquoted are not one inert command", () => {
  // Without this control the whole file could be a gate that never fires.
  for (const p of Object.values(HOSTILE)) {
    // 两种"不惰性"都是真的：控制字符/反引号/通配那一类必须让解析器直接拒绝；一个空格那一类
    // 没有算子可拒，它的症状是**参数被劈成两个词**。只认前一种的对照会漏掉后者。
    let words = null;
    let thrown = null;
    try {
      words = shellWords(`chmod 600 ${p}`);
    } catch (error) {
      thrown = error;
    }
    const split = words !== null && words.length !== 3;
    assert.ok(thrown !== null || split,
      `未加引号的 ${JSON.stringify(p)} 既没被拒绝也没被劈开，那这条对照就什么都没证：${JSON.stringify(words)}`);
    if (thrown !== null) {
      assert.match(thrown.message, /control operator|backtick|glob|unquoted expansion|unterminated/);
    }
  }
  // The shape the old helper produced: double quotes, where a substitution still runs.
  assert.throws(() => shellWords(`chmod 600 "${HOSTILE.backtick}"`), /double quotes are not inert/);
  assert.throws(() => shellWords('chmod 600 "$(touch /tmp/pwned)"'), /double quotes are not inert/);
});

/* ---------------------- the reachable real producers ---------------------- */

/** A scratch root whose name is the payload; returns the update-state path under it. */
function hostileRootDir(payload) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "gp-shellquote-"));
  const root = path.join(base, payload);
  fs.mkdirSync(root, { recursive: true });
  return { base, root };
}

test("update-state's absent arm: the check command it prints keeps a hostile state root inert", () => {
  const { base, root } = hostileRootDir("a b");
  try {
    const reading = readUpdateState({}, root);
    assert.equal(reading.kind, "absent", `${reading.kind}: 这条支路要跑到印命令的那一句`);
    assertCommandsKeepPathsInert(reading.summary, "absent 的 check 命令", [root]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("update-state's group-readable arm: chmod 600 keeps a hostile path one word", () => {
  // `;touch` 那一档不做文本解析（路径自己含反引号，正文又用反引号划命令，切片必错），改问
  // 可判定的那一句：命令里那段路径必须整段被引号包住。
  const cases = ["a b", "it's"];
  for (const payload of cases) {
    const { base, root } = hostileRootDir(payload);
    try {
      const stateFile = path.join(root, "update-state.json");
      fs.writeFileSync(stateFile, JSON.stringify({ schemaVersion: 1, status: "up-to-date" }), { mode: 0o644 });
      const reading = readUpdateState({}, root);
      assert.equal(reading.kind, "unreadable", `${payload}: 组可读的状态必须落在这一档`);
      const commands = assertCommandsKeepPathsInert(reading.summary, `unreadable(${payload}) 的 chmod 出路`, [stateFile]);
      assert.ok(commands.some((c) => c.startsWith("chmod 600 ")), `${payload}: 没印出 chmod 那一条：${reading.summary}`);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  }
  const hostile = hostileRootDir("`;touch /tmp/pwned");
  try {
    const stateFile = path.join(hostile.root, "update-state.json");
    fs.writeFileSync(stateFile, JSON.stringify({ schemaVersion: 1, status: "up-to-date" }), { mode: 0o644 });
    const summary = readUpdateState({}, hostile.root).summary;
    assert.ok(summary.includes(quoteShellArg(stateFile)),
      `反引号载荷没有被整段包住就印进 chmod 出路：${summary}`);
  } finally {
    fs.rmSync(hostile.base, { recursive: true, force: true });
  }
});

test("gp_diagnose's CA bundle line: the export it prints keeps a hostile bundle path one word", async () => {
  const payload = "a b";
  const { base, root } = hostileRootDir(payload);
  const saved = process.env[STATE_DIR_ENV];
  process.env[STATE_DIR_ENV] = root;
  try {
    fs.writeFileSync(
      path.join(root, "update-state.json"),
      JSON.stringify({ schemaVersion: 1, status: "up-to-date", current: "1.18.0", latest: "1.18.0", updatedAt: "2026-10-20T04:00:00.000Z" }),
      { mode: 0o600 },
    );
    const { engine, io } = makeEngine();
    const promise = executeTool(TOOL_BY_NAME.get("gp_diagnose"), {}, engine, new EvidenceAuditSession());
    io.respond({ class: "T1", summary: "ok" });
    const outcome = await promise;
    const block = outcome.content.map((item) => item.text).join("\n");
    // 块里点名的是这一趟那个恶意状态根，不是 HOSTILE 表里的三个样本；把它们全当"这句话里
    // 该出现的引号包好路径"来要，是在测一张不存在的清单。
    // 块里印的是那份 **bundle 文件**的路径（`ca-roots.pem`），不是状态根本身；要求后者被引号
    // 包住是在考一道没存在的题。
    const caFile = path.join(root, "ca-roots.pem");
    const commands = assertCommandsKeepPathsInert(block, "gp_diagnose 的 update block", [caFile]);
    // 那一行不在反引号里（这句是给读者看的散文，不是本产品的"命令"惯例），所以只能对原文
    // 问可判定的那一句：变量赋值后面紧跟的必须是整段引号包住的路径。
    assert.ok(block.includes(`export NODE_EXTRA_CA_CERTS=${quoteShellArg(caFile)}`),
      `CA 那一行没把 export 的目标整段包住：${block}`);
    // `--state-dir` 只在装里有 updater 的 runtime 记录时才带；这份夹具故意没有那条记录
    // （走的是"从未记过导出"那一档），所以这里要求它会印出 --state-dir 是在考一个不存在
    // 的分支。改问这一档真的该出现的那条命令。
    assert.ok(commands.some((c) => c.startsWith("node ")),
      `CA 那一行没给出可执行的 node 命令：${JSON.stringify(commands)}`);
    engine.close();
  } finally {
    if (saved === undefined) delete process.env[STATE_DIR_ENV];
    else process.env[STATE_DIR_ENV] = saved;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("the registry readers keep a hostile projects path one word, in the message and in the tool error", async () => {
  const commands = assertCommandsKeepPathsInert(registryReaders(HOSTILE.space), "registryReaders 直读", [HOSTILE.space]);
  // 反引号那一档不能走文本解析：那段路径自己就含反引号，而这份产品的正文用反引号划命令，
  // 任何切片都会把文件名劈成两句（这条闸因此改过两次）。对它只问一个可判定的问题：印出来
  // 的那条命令里，路径必须整段以引号包好的形态出现，且没有裸的一份坐在命令位上。
  const readers = registryReaders(HOSTILE.backtick);
  assert.ok(readers.includes(quoteShellArg(HOSTILE.backtick)),
    `反引号载荷没有被整段包住：${readers}`);
  assert.equal(commands.length, 2, `两个读者就该是两条命令：${JSON.stringify(commands)}`);
  assert.ok(commands.every((c) => /^(\/usr\/bin\/plutil -p|\/bin\/cat) /.test(c)), JSON.stringify(commands));

  // And through the tool: the damaged registry's own path is the hostile one.
  const payload = "it's";
  const { base, root } = hostileRootDir(payload);
  const projectsFile = path.join(root, "projects.json");
  const savedEnv = process.env[PROJECTS_FILE_ENV];
  const savedForce = process.env[FORCE_OVERWRITE_ENV];
  process.env[PROJECTS_FILE_ENV] = projectsFile;
  delete process.env[FORCE_OVERWRITE_ENV];
  try {
    fs.writeFileSync(projectsFile, "{ this is not json", "utf8");
    const { engine } = makeEngine();
    const promise = executeTool(
      TOOL_BY_NAME.get("gp_project_set"),
      { bundleId: "com.example.app", displayName: "Quote" },
      engine,
      new EvidenceAuditSession(),
    );
    // 登记册坏了的时候这条支路**不发帧**——它在本地就拒了，所以这里不许替它安排一个回话；
    // 安排了的后果是假引擎报"no frame written"，而那读起来像产品缺陷。
    const outcome = await promise;
    assert.equal(outcome.isError, true, "坏登记册必须被拒，而不是被覆盖");
    // 这条出路的形状与 `registryReaders` 那份不同：它把文件点名在散文里，不给反引号命令，
    // 所以套不上上面那个"每条命令都得解析得动"的判据（那会要求一句不存在的话）。这里问
    // 两个仍然能红的句子：路径必须出现，而这句里凡是写成反引号命令的东西都不许带裸路径。
    const toolText = outcome.content[0].text;
    assert.ok(toolText.includes(projectsFile), `坏登记册的出路没点名那份文件：${toolText}`);
    for (const cmd of commandsIn(toolText.split(quoteShellArg(projectsFile)).join(MASKED_PATH))) {
      shellWords(cmd);
      assert.ok(!cmd.includes(projectsFile), `命令位上出现了裸路径：${cmd}`);
    }
    engine.close();
  } finally {
    if (savedEnv === undefined) delete process.env[PROJECTS_FILE_ENV];
    else process.env[PROJECTS_FILE_ENV] = savedEnv;
    if (savedForce === undefined) delete process.env[FORCE_OVERWRITE_ENV];
    else process.env[FORCE_OVERWRITE_ENV] = savedForce;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("the two path-built commands the shell composes from its own location keep the same rule", () => {
  // `daemonUnreachableRemedy` resolves beside this build, so the payload here is whatever
  // this checkout's path really is — the gate is that the command it prints always parses
  // inertly, and that a hostile operand cannot get through it either.
  // 这条 remedy 里的路径是**这台机器**的检出路径，不是构造出来的恶意值；对它只能要求"印出来
  // 的每一条命令解析得动"，恶意载荷那一档由下面 absoluteNodeCommand 那三条负责。
  assertCommandsKeepPathsInert(daemonUnreachableRemedy(), "daemonUnreachableRemedy", []);
  for (const payload of Object.values(HOSTILE)) {
    const command = absoluteNodeCommand(payload, " enable");
    assert.ok(command !== null);
    assertCommandsKeepPathsInert(`\`${command}\``, "absoluteNodeCommand", [payload]);
    assert.deepEqual(shellWords(command), ["node", payload, "enable"]);
  }
  assert.equal(absoluteNodeCommand("updater/cli.js", " enable"), null,
    "相对路径仍然点名不出命令：它按读者的 cwd 解析");
});

/* ------------------------------------------------------------------ *
 * The half no test can reach at runtime: the `chmod`/`ls -lO`/`diskutil`
 * remedies fire only when a volume refuses a chmod or an fsync, which
 * nothing on this machine can arrange. So the rule is checked where the
 * strings are written: every command-shaped template literal in `src/`
 * may interpolate only something the quoting helper produced.
 * ------------------------------------------------------------------ */

/** Expressions that already return a quoted command (they build it through `quoteShellArg`). */
const ALREADY_QUOTED_PRODUCERS = new Set([
  "command",
  "installerCommand",
  "installerCmd",
  "enableCmd(runtime.cliPath)",
  "enable",
  "check",
  "suffix",
  "installer",
  "named",
  "registryReaders(filePath)",
  "registryReaders(\"<that path>\")",
]);

/**
 * An interpolation is in an operand position when the text right before it ends with a
 * command word (plus optional flags) — `chmod 600 ${p}`, `plutil -p ${f}`. That is the one
 * position where a path has to be quoted.
 *
 * The first version of this scan asked "does this backtick span contain a command word
 * anywhere", and that is a question prose cannot survive: this codebase uses backticks for
 * emphasis, so "ca trust bundle: ok — node will use this exported root bundle (${countClause}
 * at ${target})" is a *sentence* containing a command word, and the scan demanded quotes
 * around a byte count. Twenty-one false positives, all of them messages, and not one of them
 * a command an agent runs. Position, not vocabulary — hence the anchor at the end of the
 * text that precedes each hole.
 */
const COMMAND_PREFIX = new RegExp(
  "(?:^|[\\s`;(\"'])(?:/?(?:usr/)?(?:bin|s?bin)/)?"
  + "(?:chmod|chown|chgrp|mv|cp|cat|ls|df|plutil|python3|node|npx|launchctl|diskutil|"
  + "kill|rm|mkdir|touch|open|curl|security|defaults|export|gzip|tar|sqlite3|grep|stat|find|sh|"
  + "glasspaned|updater|installer)(?:\\s+(?:-[A-Za-z0-9_-]+|\\d{3,4}))*\\s+$"
);
const ANY_HOLE = /\$\{([^{}]*)\}/g;
/** An interpolation whose name says it carries a filesystem location. */
const PATH_TYPED = /(?:path|Path|dir|Dir|file|File|root|Root|target|Target|cli|Script|directory)/;

test("every interpolated value inside a command-shaped literal in src and updater goes through the quoting helper", () => {
  const offenders = [];
  const inspected = [];
  for (const target of SCAN_TARGETS) {
    for (const name of fs.readdirSync(target.dir).filter((entry) => entry.endsWith(target.ext))) {
      const source = executableSource(fs.readFileSync(path.join(target.dir, name), "utf8"));
      for (const match of source.matchAll(/`(?:[^`\\]|\\.)*`/g)) {
        const literal = match[0];
        if (!literal.includes("${")) continue;
        const body = literal.slice(1, literal.length - 1);
        let sawOperand = false;
        for (const hole of body.matchAll(ANY_HOLE)) {
          const expression = (hole[1] ?? "").trim();
          const before = body.slice(Math.max(0, hole.index - 80), hole.index);
          if (!COMMAND_PREFIX.test(before)) continue;
          // 参数位上的插值只有指向**路径**时才需要引号。`(chmod ${(want & 0o777).toString(8)}
          // failed: …)` 是一句"chmod 以模式 600 失败"的说明文字，那个洞是八进制模式号，不是
          // 文件名；把它算成缺陷就是让闸去要求一件不可能的事。
          if (!PATH_TYPED.test(expression)) continue;
          sawOperand = true;
          // 两侧包各自 import 各自的同名助手（`src/errors.ts` 与 `updater/lib/shell-quote.js`
          // 是同一规则的两份可执行体，规则本身由本文件的行为半边钉死）；判据只看名字，
          // 所以 `quoteShellArg(` 前缀对两种语言同样放行。
          if (expression.startsWith("quoteShellArg(") || ALREADY_QUOTED_PRODUCERS.has(expression)) continue;
          offenders.push(`${target.label}/${name}: ${JSON.stringify(expression)} 坐在命令 ${JSON.stringify(literal.slice(0, 90))} 的参数位上，却没走引号助手`);
        }
        if (sawOperand) inspected.push(`${target.label}/${name}: ${literal.slice(0, 90)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `这些命令位上的路径没有过引号助手，代理照着执行时会被 shell 重排：${offenders.join(" | ")}`);
  // Vacuity: the scan must actually be looking at the sites this fix converted, or a
  // refactor that moves the commands into another shape would silently retire the gate.
  assert.ok(inspected.length >= 4,
    `命令样式的字面量只扫到 ${inspected.length} 处，这条闸已经看不见东西：${inspected.join(" | ")}`);
  assert.ok(inspected.some((entry) => entry.includes("plutil")), "registryReaders 的那两条读者命令不在扫描结果里");
  assert.ok(inspected.some((entry) => entry.includes("chmod")), "chmod 的出路不在扫描结果里");
  // The widened half must not be decoration: the updater's own sites have to be *in* the scan
  // (2026-10-22, `lib/check.js`'s `ls -lO` repair line), or "we now also read updater/" is a
  // claim no run can check.
  const updaterInspected = inspected.filter((entry) => entry.startsWith("updater/"));
  assert.ok(updaterInspected.length >= 1,
    `扫描集里 updater 那半边一处命令位都没看见（src 侧 ${inspected.length - updaterInspected.length} 处）——扩集只是装饰：${inspected.join(" | ")}`);
  assert.ok(updaterInspected.some((entry) => entry.includes("ls -lO")), "updater 的 `ls -lO` 分辨命令不在扫描结果里");
});
