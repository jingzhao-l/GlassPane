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
 * 2026-11-05 本轮的两段（都是**这一半源码扫描**的缺陷，行为半边不动）：
 *
 * ① 静态那半边（缺陷二）。旧闸里 `if (!literal.includes("${")) continue;` 只把**带插值的**
 *    命令字面量送进词解析；一条**静态**的、含空格的 bundle 路径（`$HOME/Applications/
 *    GlassPane Daemon.app/Contents/MacOS/glasspaned`）于是从来没被交给拆词器，代理照抄得到
 *    argv[0]="...GlassPane"，命令根本跑不起来（本轮实测 src 里 11 处）。新增的
 *    `scanStaticOperands` 按行读原始文本（行首注释滤掉、行内残渣交给 executableSource），
 *    反引号成对先认转义对内层、再认掩蔽后的外层，判据是**可判定的那一形**：一个裸词含有
 *    `.app/`、且前一词落在路径尾巴上——空格把 bundle 劈开了。修法形状是双引号包住整段路径、
 *    保留 `$HOME` 展开，所以静态这半的双引号段按"作者的静态展开"放行（"双引号不惰性"讲的是
 *    会带调用方值的洞；一段没有洞的文字里，`$` 只能是作者自己写下的那枚 `$HOME`）。
 *    两个独立操作数（`mv /tmp/a b/c`）在文本上与"断开的操作数"不可区分，这条闸不越界去猜——
 *    bundle 那一形是判定得到的全部。REVERSE：把 src 任一处引号撤掉 ⇒ 本文件具名那处 file:line。
 *
 * ② 比较句不是命令（缺陷三）。`updater/cli.js` 的拒绝句
 *    `--state-dir /a and --state-root /b name two different roots` 是**说两枚旗标不相等**的
 *    散文：选项左边没有命令词，印出来的文本里也没有反引号——行为半边（反引号是命令边界）
 *    从不把它当命令，源码这半却按"选项紧贴洞"的形状判据把它读成了参数位并要它加引号。
 *    错的是闸，不是 updater：给比较句加引号等于向读者展示一条他并不执行的命令，而那条句子
 *    根本没有照抄位。修法只关掉**形状**那一半对"以选项开头的字面量"的适用；动词名单、
 *    赋值位、选项后置位照常判定，文末的具名 floor（inspected 的各半）与
 *    "the scanner bites"对照（比较句静默、`glasspaned --state-dir ${dir}` 仍被具名）证明
 *    这一刀不是把闸看瞎。
 *
 * MUTATION THIS PINS: drop a `quoteShellArg(...)` at any of those sites and the source
 * gate names it; make the helper double-quote (or delete it and interpolate raw) and the
 * behavioural half goes red on the hostile path, with the injected word appearing as a
 * separate shell word; un-quote the bundle path at any of the 11 printed sites (or re-shape
 * the refusal sentence into a command) and the static half / the leading-flag carve-out
 * names it — both directions are measured, not asserted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { quoteShellArg } from "../dist/errors.js";
import { absoluteNodeCommand, readUpdateState, STATE_DIR_ENV } from "../dist/update-state.js";
import { daemonUnreachableRemedy } from "../dist/engine-client.js";
import { FORCE_OVERWRITE_ENV, PROJECTS_FILE_ENV, registryReaders } from "../dist/project-registry.js";
import { TOOL_BY_NAME, executeTool } from "../dist/tools.js";
import { EvidenceAuditSession } from "../dist/audit-session.js";
import { makeEngine } from "./helpers.mjs";
import { executableSource } from "./support/source.mjs";
import { privateSandbox } from "./support/sandbox.mjs";

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "src");
const UPDATER = path.resolve(SRC, "..", "..", "updater");
const INSTALLER = path.resolve(SRC, "..", "..", "installer");

/**
 * The scan set: this package's TypeScript sources, the standalone updater's plain-JS
 * sources (lib/ plus the two package-root scripts), and the standalone installer's two
 * shipped scripts (2026-10-30: `installer/cli.js` printed `node "${tree.cli}" --restore-launchd`
 * for twelve of its repair lines, where `tree.cli` comes from `--repo` / `GLASSPANE_REPO` /
 * `GLASSPANE_INSTALL_DIR` — a double-quoted run still expands `$()` and backticks, so the
 * "copy this command" line was a command-execution channel from a directory name).
 * Same argument-position judgement for all of them — only the file set widened, never the rule.
 */
const SCAN_TARGETS = [
  { label: "src", dir: SRC, ext: ".ts" },
  { label: "updater/lib", dir: path.join(UPDATER, "lib"), ext: ".js" },
  { label: "updater", dir: UPDATER, ext: ".js" },
  { label: "installer", dir: INSTALLER, ext: ".js" },
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
  // 不在 `os.tmpdir()` 下铺：CI 那台 Linux 上那是 world-writable 的 `/tmp`，
  // `projectSet` 的守卫会先把它拒了，这条测试就再也走不到它要量的那一句。
  const sandbox = privateSandbox("gp-shellquote-");
  const base = sandbox.dir;
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
// 两半并集，谁也不许单独担责：
// ① 旧的动词名单——留着是为了不比今天少测任何东西（`cat ${file}`、`plutil -p ${file}` 这类
//    没有选项的调用位，只有名单认得）。
// ② 动词无关的**形状**：一枚选项（`-C`、`--branch`）紧贴在参数位前面，或紧跟在参数位后面。
//    这一半才是本轮补上的那块：名单里没有 `git`，于是 `git -C "${repoDir}" tag -v …` 十四处
//    全在闸的盲区里（本轮实测：把它们改回双引号，旧版一条都不红）。
const COMMAND_VERB_PREFIX = new RegExp(
  "(?:^|[^A-Za-z0-9_$])(?:/?(?:usr/)?(?:bin|s?bin)/)?"
  + "(?:chmod|chown|chgrp|mv|cp|cat|ls|df|plutil|python3|node|npx|launchctl|diskutil|"
  + "kill|rm|mkdir|touch|open|curl|security|defaults|export|gzip|tar|sqlite3|grep|stat|find|sh|"
  + "glasspaned|updater|installer|git|git ls-remote)(?:\\s+(?:-[A-Za-z0-9_-]+|\\d{3,4}))*[\"'\\s]+$"
);
/** 参数位紧邻一枚选项：`git -C <洞>`、`node <洞> --restore-launchd`。 */
const OPTION_BEFORE = /(?:^|[\s"'([{])-{1,2}[A-Za-z][\w-]*(?:[ \t]+[\w-]+)*[ \t]*["']?$/;
const OPTION_AFTER = /^[^\n]{0,40}[ \t"']-{1,2}[A-Za-z]/;
/**
 * 字面量以一枚选项**开头**：那一串选项是在点名旗标，不是在下一道命令（2026-11-05 缺陷三：
 * `updater/cli.js` 的 `--state-dir ${dir} and --state-root ${root} name two different roots`
 * 是比较句，行为半边从不把它当命令，形状判据也不许当）。只关掉 OPTION_* 这半；动词名单与
 * 赋值位照常——见文末对照里"比较句静默、命令形仍具名"那一对。
 */
const LEADING_OPTION = /^\s*-{1,2}[A-Za-z]/;
const COMMAND_PREFIX = (before, after, body) =>
  COMMAND_VERB_PREFIX.test(before)
  || (!LEADING_OPTION.test(body)
    && ((OPTION_BEFORE.test(before) && !/[\w-]{17,}$/.test(before)) || OPTION_AFTER.test(after)));

const ANY_HOLE = /\$\{([^{}]*)\}/g;
/** An interpolation whose name says it carries a filesystem location. */
// "路径"之外还有一类：坐在命令位上的**名字**（在册远端名）。本机实测 `git remote` 会原样
// 列出一枚含空格与 `$( )` 的名字（`git config 'remote.up stream.url' …` 就能造出来），所以
// 它和目录名一样是 shell 文本，不是参数值。2026-11-04 那两处注入之一就是从这里漏的。
const PATH_TYPED = /(?:path|Path|dir|Dir|file|File|root|Root|target|Target|cli|Script|directory|remote|Remote)/;

/**
 * 插值那一半：带洞的命令字面量里，坐在参数位上的洞必须走引号助手。
 * `where` 是"哪一半扫描集/哪个文件"的名字，offender 条目原样带上它。
 */
function scanInterpolatedOperands(where, source) {
  const offenders = [];
  const inspected = [];
  for (const match of source.matchAll(/`(?:[^`\\]|\\.)*`/g)) {
        const literal = match[0];
        // 静态那半边不在这里——看不见没洞的字面量正是 2026-11-05 缺陷二（src 里 11 处印出来的
        // bundle 路径从没进过拆词器）。行级判据在 `scanStaticOperands`；这个 `continue` 现在
        // 只对插值洞负责，不再决定这条闸能看见什么。
        if (!literal.includes("${")) continue;
        const body = literal.slice(1, literal.length - 1);
        // 第二半的结构判据（不是词表）：一条**待照抄的命令**在这个仓库里总是带着至少一枚选项
        // （`-p`、`--restore-launchd`、`-C`、`--depth`）。没有选项的那一行是"提到一个函数/一个
        // 模式号"的散文——`chmod ${(dir.mode & 0o7777).toString(8)} failed: ${error.message}`
        // 与 `homeDefaultSocketPath()` 都是这类，把它们算成缺陷就是让闸去要求一件不可能的事。
        // 旧的动词名单同样不会碰它们，所以这一半不是放宽，是"改成形状之后必须补上的那一刀"。
        let sawOperand = false;
        for (const hole of body.matchAll(ANY_HOLE)) {
          const expression = (hole[1] ?? "").trim();
          const before = body.slice(Math.max(0, hole.index - 80), hole.index);
          const after = body.slice(hole.index + hole[0].length, hole.index + hole[0].length + 44);
          // 与文档残渣闸同一句老话（S10-5，2026-10-29）：**汉字后面接的不算命令**。
  // 这一半是形状判据必需的：`两个都跑不通就是 ${path.dirname(target)} 的权限问题，看 \`ls -ld …\``
  // 与 `daemon 在 ${socketPath} 应答了 hello…` 都是中文说明，形状里的"选项"来自句中最深处的一个
  // markdown 代码段，而不是一个待照抄的参数位。本轮实测：少了这一刀，三处中文说明被误报。
  // 赋值位单独认：`VAR=<洞>` 后面接的一定是一个 shell 词，语言环境不参与这个判断。
  // 但"整条字面量只剩一次赋值"不是命令位，是在**展示一个环境变量的值**——`updater/lib/binaries.js`
  // 与 `signature.js` 那句 `PATH=${pathValue}` 是 "this process runs with PATH=…" 的一半，给它的
  // 值加 shell 引号是要求一件没有意义的事（本轮实测：不加这一刀，两处说明被误报）。
  // 边界用 `\W` 而不是 ASCII 空白表：本仓的出路句子是双语的，`…：GLASSPANE_INSTALL_DIR=<洞>` 里
  // 赋值位前面是**全角冒号**，只认 ASCII 边界的话这一处又被语言环境短路了（本轮实测）。
  const ASSIGN_HOLE = /(?:^|\W)[A-Za-z_][A-Za-z0-9_]*=(?:"|')?$/;
  const assignmentShaped = ASSIGN_HOLE.test(before)
    && !(/^[A-Za-z_][A-Za-z0-9_]*=(?:"|')?$/.test(body.slice(0, hole.index).trim())
         && body.slice(hole.index + hole[0].length).trim() === "");
  if (!assignmentShaped && /[\p{Script=Han}]/u.test(before)) continue;
  if (!assignmentShaped && !COMMAND_PREFIX(before, after, body)) continue;
          // 选项必须**紧挨着这一枚参数位**——在它前面那一段里，或者紧跟其后（`node "${cli}"
          // --restore-launchd` 就是后者）。整条字面量里"出现过一根横杠"不算：
          // `nothing installed at ${appsDir} reports a version (no .app bundle …)` 那句是散文，
          // 它带着 `.app`、破折号与括号，却没有任何一处是要照抄的参数位（本轮实测它会误报，
          // 而误报的下一条出路就是有人来把这条闸改松）。
          // 参数位上的插值只有指向**路径**时才需要引号。`(chmod ${(want & 0o777).toString(8)}
          // failed: …)` 是一句"chmod 以模式 600 失败"的说明文字，那个洞是八进制模式号，不是
          // 文件名；把它算成缺陷就是让闸去要求一件不可能的事。
          if (!PATH_TYPED.test(expression)) continue;
          sawOperand = true;
          // 两侧包各自 import 各自的同名助手（`src/errors.ts` 与 `updater/lib/shell-quote.js`
          // 是同一规则的两份可执行体，规则本身由本文件的行为半边钉死）；判据只看名字，
          // 所以 `quoteShellArg(` 前缀对两种语言同样放行。
          if (expression.startsWith("quoteShellArg(") || ALREADY_QUOTED_PRODUCERS.has(expression)) continue;
          offenders.push(`${where}: ${JSON.stringify(expression)} 坐在命令 ${JSON.stringify(literal.slice(0, 90))} 的参数位上，却没走引号助手`);
        }
        if (sawOperand) inspected.push(`${where}: ${literal.slice(0, 90)}`);
  }
  return { offenders, inspected };
}

/** 静态命令词按 shell 词切开：被引号包住的整段算一枚词，其余按空白。不抛错——这里只找"劈开"。 */
function staticShellWords(text) {
  const words = [];
  let current = null;
  let quoted = false;
  let i = 0;
  const flush = () => {
    if (current !== null && current !== "") words.push({ text: current, quoted });
    current = null;
    quoted = false;
  };
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\t") {
      flush();
      i += 1;
      continue;
    }
    if (c === "'" || c === '"') {
      if (current === null) current = "";
      quoted = true;
      i += 1;
      while (i < text.length && text[i] !== c) {
        current += text[i];
        i += 1;
      }
      i += 1;
      continue;
    }
    if (current === null) current = "";
    current += c;
    i += 1;
  }
  flush();
  return words;
}

/**
 * 可判定的那一形：一枚**裸词**带着 `.app/` 的 bundle 尾巴、坐在另一枚含 `/` 的词后面——
 * 空格劈开的是一段路径，不是两个操作数。双引号里的那枚 `$HOME` 是作者自己写下的展开，
 * 这一段文字没有洞、没有调用方能塞东西进来的位置，所以包成一个词就作数（行为半边讲的
 * "双引号不惰性"针对的是会带值的插值，不是静态文字）。两个独立操作数（`mv /tmp/a b/c`）
 * 在文本上与"被劈开的一段"不可区分，判据不越界去猜——bundle 那一形是判定的全部。
 */
function bundleSplitsOf(span) {
  const splits = [];
  const words = staticShellWords(span);
  for (let index = 1; index < words.length; index += 1) {
    const prev = words[index - 1];
    const cur = words[index];
    if (cur.quoted || !cur.text.includes(".app/")) continue;
    if (/^(?:[-/<$(~[])/.test(cur.text)) continue;
    if (!prev.text.includes("/")) continue;
    splits.push(`${prev.text} ${cur.text}`);
  }
  return splits;
}

/**
 * 静态那一半（2026-11-05 缺陷二）：按**行**读原始文本，行号就是文件行号——撤掉引号的出路
 * 必须被点名到 file:line，否则修的人还得自己对一遍十一处。行首注释滤掉、行内残渣交给
 * executableSource，与裸名闸（daily-20261104-bare-daemon-name）同一口径：散文不许点燃闸。
 * 转义对内层先认（那是印给读者的反引号边界），掩掉之后再认外层成对——从左到右统一配对
 * 会把内层词挪出视野（本轮实测：2480/316 两行的内层 pair 会被外层反引号挤错奇偶）。
 */
function scanStaticOperands(where, rawText) {
  const offenders = [];
  const inspected = [];
  rawText.split("\n").forEach((line, index) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    const code = executableSource(line);
    const spans = [];
    for (const match of code.matchAll(/\\`([^`\n]*?)\\`/g)) spans.push(match[1]);
    const masked = code.replace(/\\`[^`\n]*?\\`/g, "@@SPAN@@").replace(/\\"/g, '"');
    for (const match of masked.matchAll(/`([^`\n]*?)`/g)) spans.push(match[1]);
    spans.forEach((span, spanIndex) => {
      const at = `${where}:${index + 1}#${spanIndex + 1}`;
      if (span.includes(".app/")) inspected.push(`${at}: ${span.slice(0, 90)}`);
      for (const split of bundleSplitsOf(span)) {
        offenders.push(`${at}: 未加引号的空格把 bundle 路径劈成 ${JSON.stringify(split)}，照抄的命令词不再是可执行文件 — ${span.slice(0, 90)}`);
      }
    });
  });
  return { offenders, inspected };
}

test("every interpolated value inside a command-shaped literal in src and updater goes through the quoting helper", () => {
  const offenders = [];
  const inspected = [];
  const staticInspected = [];
  for (const target of SCAN_TARGETS) {
    for (const name of fs.readdirSync(target.dir).filter((entry) => entry.endsWith(target.ext))) {
      const rawText = fs.readFileSync(path.join(target.dir, name), "utf8");
      const where = `${target.label}/${name}`;
      const interpolation = scanInterpolatedOperands(where, executableSource(rawText));
      offenders.push(...interpolation.offenders);
      inspected.push(...interpolation.inspected);
      const staticHalf = scanStaticOperands(where, rawText);
      offenders.push(...staticHalf.offenders);
      staticInspected.push(...staticHalf.inspected);
    }
  }
  assert.deepEqual(offenders, [], `这些命令位上的值没有过引号助手、或 bundle 路径被未加引号的空格劈开，代理照着执行时会被 shell 重排：${offenders.join(" | ")}`);
  // Vacuity: the scan must actually be looking at the sites this fix converted, or a
  // refactor that moves the commands into another shape would silently retire the gate.
  assert.ok(inspected.length >= 4,
    `命令样式的字面量只扫到 ${inspected.length} 处，这条闸已经看不见东西：${inspected.join(" | ")}`);
  assert.ok(inspected.some((entry) => entry.includes("plutil")), "registryReaders 的那两条读者命令不在扫描结果里");
  // 2026-11-04 新加的那一半判据不许是装饰：一键安装那句 `GLASSPANE_INSTALL_DIR=<洞>` 必须在扫描结果里
  //（它从前被"汉字存在即跳过"整条洗掉，两处注入面因此看不见）。
  assert.ok(inspected.some((entry) => entry.includes("GLASSPANE_INSTALL_DIR")),
    "赋值位那一半没扫到一键安装命令，说明它又被语言环境短路了");
  // `git ls-remote <洞>`：动词名单里从前没有 `git`，而参数位上坐的是"在册远端名"（不是路径），
  // 两处合起来让这条待照抄的命令整条在闸外（2026-11-04 的一处真注入面）。试过把"动词与参数位之间
  // 允许一枚裸词"改成形状判据——本机实测造出 4 处误报（`the new updater script ${cliPath} could
  // not be started`、`installer pointer ${pointerFile} could not be parsed` 一类的英文说明），
  // 所以留下这一枚精确条目，并由下面这条非空转对照证明它真的在扫这一处。
  assert.ok(inspected.some((entry) => entry.includes("git ls-remote")),
    "git 的 ls-remote 命令位不在扫描结果里，那条出路仍然看不见");
  assert.ok(inspected.some((entry) => entry.includes("chmod")), "chmod 的出路不在扫描结果里");
  // The widened half must not be decoration: the updater's own sites have to be *in* the scan
  // (2026-10-22, `lib/check.js`'s `ls -lO` repair line), or "we now also read updater/" is a
  // claim no run can check.
  const updaterInspected = inspected.filter((entry) => entry.startsWith("updater/"));
  assert.ok(updaterInspected.length >= 1,
    `扫描集里 updater 那半边一处命令位都没看见（src 侧 ${inspected.length - updaterInspected.length} 处）——扩集只是装饰：${inspected.join(" | ")}`);
  assert.ok(updaterInspected.some((entry) => entry.includes("ls -lO")), "updater 的 `ls -lO` 分辨命令不在扫描结果里");
  // The installer half of the widening, same test as above: 2026-10-30 found twelve
  // double-quoted `node "${tree.cli}" …` repair lines here that no gate was reading, so
  // "the scan now covers installer/" has to be checkable from a run, not from the comment.
  const installerInspected = inspected.filter((entry) => entry.startsWith("installer/"));
  assert.ok(installerInspected.length >= 1,
    `扫描集里 installer 那半边一处命令位都没看见（其余 ${inspected.length - installerInspected.length} 处）——扩集只是装饰：${inspected.join(" | ")}`);
  assert.ok(installerInspected.some((entry) => entry.includes("--restore-launchd")),
    "installer 的 `--restore-launchd` 补救命令不在扫描结果里");
  // 2026-11-03：动词表改成形状之后，`git` 那一批必须**看得见**——否则"改成形状"这句话没有读数。
  // 这八处是本轮修掉的（`git -C "${repoDir}" tag -v …` 一类），旧名单一条都不报。
  // 形状那一半的读数：至少一处 `git -C ${quoteShellArg(…)}` 必须真被扫到，否则"名单改成形状"
  // 这句话没有证据。边界如实写下：紧贴参数位的那一段里含汉字的**中文说明**由上面那一刀跳过
  // （`下一步：确认 ${targetDir} 是一棵 git 仓库（git -C … rev-parse --show-toplevel 能不能答话）`
  // 就是这一形）——那一处本轮也改了，但它是靠**改掉双引号**改的，不是靠这条闸抓的；
  // 抓不到它不等于可以不管它，所以它由 daily-20261103-shell-printed-operand-inertness 那条
  // 真进程对照与 installer 侧的三条断言一起钉。
  assert.ok(installerInspected.filter((entry) => entry.includes("git -C ${quoteShellArg(")).length >= 2,
    `installer 的 git -C 出路不在扫描结果里（动词形状没生效）：${installerInspected.join(" | ")}`);
  assert.ok(installerInspected.some((entry) => entry.includes("--accept-unverified-signature")),
    "installer 的 --accept-unverified-signature 出路不在扫描结果里");
  // 静态那一半的空转对照（style 同上 527 行的 floor）：本轮修掉的 11 处印出来的 bundle 命令词
  // 必须**仍在闸的视野里**——修法把它们引好之后，闸不是"没东西可报"，而是"看见了、判过、放行"。
  assert.ok(staticInspected.length >= 11,
    `静态那半边只扫到 ${staticInspected.length} 处 bundle 命令词，2026-11-05 的十一处印出位已不在闸的视野里：${staticInspected.join(" | ")}`);
  assert.ok(staticInspected.filter((entry) => entry.startsWith("src/project-registry.ts")).length >= 5
    && staticInspected.filter((entry) => entry.startsWith("src/tools.ts")).length >= 5,
    `daemon 的 bundle 命令词必须两份文件都在视野里：${staticInspected.join(" | ")}`);
});

test("the two halves bite: a split bundle word is named with file:line, a comparison sentence is not", () => {
  // 反向对照，两半各一对——缺了它们，上面那条 floor 只需要"扫到东西"，不需要"咬得住缺陷形"。
  // 静态半边（缺陷二的 REVERSE）：撤掉引号就是本轮修掉的那一形，必须被点名到 file:line。
  const bad = 'const notice = "start it as `$HOME/Applications/GlassPane Daemon.app/Contents/MacOS/glasspaned --state-dir <root>` first";';
  const badScan = scanStaticOperands("synthetic/bad.ts", bad);
  assert.equal(badScan.offenders.length, 1, `劈开的 bundle 词必须被具名一次：${JSON.stringify(badScan.offenders)}`);
  assert.ok(badScan.offenders[0].includes("synthetic/bad.ts:1"), `offender 要报出文件与行号：${badScan.offenders[0]}`);
  // 修好的形态：静默，但仍在 inspected 里——"不再报"与"看不见"是两件事。
  const fixed = 'const notice = "start it as `\\"$HOME/Applications/GlassPane Daemon.app/Contents/MacOS/glasspaned\\" --state-dir <root>` first";';
  const fixedScan = scanStaticOperands("synthetic/fixed.ts", fixed);
  assert.deepEqual(fixedScan.offenders, [], "整段引起来的路径是一个词，不许再被报成劈开");
  assert.ok(fixedScan.inspected.length >= 1, "修好的形态必须留在闸的视野里，否则 floor 是空转");
  // 不可判形不越界：两个独立操作数在文本上与"被劈开的一段"无法区分，要求引号是不可能的事。
  const operands = "run `mv /tmp/one /tmp/two.app/Contents` once";
  assert.deepEqual(bundleSplitsOf(operands), [], "两个独立操作数被误判成劈开的 bundle，下一条出路就是有人把闸改松");
  // 洞半边（缺陷三的 REVERSE）：以旗标开头的比较句不是命令；同一对旗标坐在真命令词后面仍必须被具名。
  const prose = "const refusal = `--state-dir ${dir} and --state-root ${root} name two different roots. These two flags are documented synonyms`;\n";
  const proseScan = scanInterpolatedOperands("synthetic/prose.js", prose);
  assert.deepEqual(proseScan.offenders, [], `比较句被读成了命令位（缺陷三那一红）：${proseScan.offenders.join(" | ")}`);
  const command = "fail(`glasspaned --state-dir ${dir} --permissions`);";
  const commandScan = scanInterpolatedOperands("synthetic/command.js", command);
  assert.equal(commandScan.offenders.length, 1, `真命令位上的裸 ${"${dir}"} 必须仍然被具名——这一刀不许把闸看瞎：${JSON.stringify(commandScan.offenders)}`);
});
