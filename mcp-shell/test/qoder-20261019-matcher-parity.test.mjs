import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AGENT_PATH_PROTECTION, PROJECTS_FILE_ENV } from "../dist/project-registry.js";
import { EvidenceAuditSession } from "../dist/audit-session.js";
import { executeTool, TOOL_BY_NAME } from "../dist/tools.js";
import { makeEngine } from "./helpers.mjs";
import { privateSandbox } from "./support/sandbox.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SWIFT_FILE = path.resolve(HERE, "../../engine/Sources/GlassPaneEngine/EngineCore.swift");
const REGISTRY_TS = path.resolve(HERE, "..", "src", "project-registry.ts");

/**
 * Cross-language source gate (the style `test/consumer-consistency.test.mjs` uses): the
 * shared-scratch rule exists twice, once per language, and the only honest guard is one
 * that reads the other side.
 *
 * `project-registry.ts` registered this as an **open split** — its header said the shell
 * treats `/tmp`, `/private/tmp` and `/private/var/tmp` as trees while
 * `EngineCore.resolvedStoragePathDefect` "still compares `sharedScratchStoragePaths` for
 * exact equality, so that path is accepted by the daemon — same list, two verdicts", and
 * pointed at a spec section for "仍未收口". That claim is stale: the Swift side
 * subtree-matches today, `EngineCore.swift`'s own comment records the equality form it
 * replaced, and `test/path-consistency.test.mjs` already reddens if that form comes back.
 *
 * A stale claim in shipped source is a defect of its own — it is contract drift someone
 * will "fix" twice — so this file does two things: it re-checks that the *code* on the two
 * sides really is one rule (names and matcher), which is what makes the prose checkable
 * rather than a second opinion, and it then requires the prose to state what the code does.
 * The second half is the red this file was written for.
 */

/** One declared Swift `[String]` literal, as the names it lists. */
function swiftStringList(name) {
  const source = fs.readFileSync(SWIFT_FILE, "utf8");
  const declared = new RegExp(`static let ${name}: \\[String\\] = \\[([\\s\\S]*?)\\]`).exec(source);
  assert.ok(declared,
    `EngineCore.swift 不再把 ${name} 声明成 [String] 字面量——重读 daemon 现在用哪份名单守这条路`);
  return [...declared[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/**
 * The daemon's `resolvedStoragePathDefect`, with its own `///` lines taken out: the
 * function's doc comment quotes the equality form it replaced, so matching prose would
 * report the fixed shape as present forever (same reasoning as `path-consistency`'s gate).
 */
function swiftResolvedStorageBody() {
  const source = fs.readFileSync(SWIFT_FILE, "utf8");
  const declaration = "static func resolvedStoragePathDefect";
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `${declaration} 搬了家：这条闸要跟着指过去，并说明它现在住在哪`);
  const next = source.indexOf("static func", start + declaration.length);
  const raw = next === -1 ? source.slice(start) : source.slice(start, next);
  return raw.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
}

test("both sides match the shared scratch names as subtrees, and name the same ones", async () => {
  const body = swiftResolvedStorageBody();
  const scratch = swiftStringList("sharedScratchStoragePaths");
  const trees = swiftStringList("systemOwnedStorageTrees");
  assert.ok(scratch.length > 0 && trees.length > 0, "两份名单都空了，这条对照就没有对象");

  // Swift: the loop that walks each list has to reach a subtree primitive inside its guard,
  // whatever the variable names or line breaks are — a glyph-pinned regex reddens on an
  // equivalent refactor, which is how a real gate gets deleted rather than updated.
  for (const list of ["sharedScratchStoragePaths", "systemOwnedStorageTrees"]) {
    assert.match(
      body.replace(/\s+/g, " "),
      new RegExp(`for\\s+[A-Za-z_][A-Za-z0-9_]*\\s+in\\s+${list}\\s+[^{]*?hasPrefix\\(`),
      `${list} 在 resolvedStoragePathDefect 里不再是子树匹配：它下面一层的目录会被 daemon 收下、被这一侧拒掉，`
        + "两侧又变成一条规则两个答案",
    );
  }
  assert.doesNotMatch(
    body,
    /(?:sharedScratchStoragePaths|systemOwnedStorageTrees)\s*\.contains\(/,
    "整路径相等的判据又回到了 resolvedStoragePathDefect",
  );

  // TypeScript: one union list, one two-armed matcher, walked over that list.
  const ts = fs.readFileSync(REGISTRY_TS, "utf8");
  assert.deepEqual(
    [...AGENT_PATH_PROTECTION.subtrees].sort(),
    [...trees, ...scratch].sort(),
    `project-registry.ts 的子树清单不再是 daemon 两份名单的并集：daemon 侧 ${[...trees, ...scratch].sort()}，`
      + `这一侧 ${[...AGENT_PATH_PROTECTION.subtrees].sort()}`,
  );
  assert.match(
    ts,
    /function isInside\(root: string, target: string\): boolean \{\s*return target === root \|\| target\.startsWith\(`\$\{root\}\/`\)/,
    "isInside 不再是'等于该树或以 <tree>/ 为前缀'这两支，Swift 那侧的子树匹配在这里没有了对应物",
  );
  assert.match(
    ts,
    /for \(const tree of PROTECTED_SUBTREES\) \{\s*if \(isInside\(tree, target\)\)/,
    "refuseCandidate 不再用 isInside 遍历 PROTECTED_SUBTREES：这一侧退回整路径相等的那一半就没人说了",
  );

  // Behavioural half, through the seam an agent hits: one level below a named scratch
  // directory is refused here, exactly as the daemon refuses it there.
  const sandbox = privateSandbox("gp-scratch-parity-");
  const saved = process.env[PROJECTS_FILE_ENV];
  process.env[PROJECTS_FILE_ENV] = path.join(sandbox.dir, "projects.json");
  try {
    const { engine } = makeEngine();
    const outcome = await executeTool(
      TOOL_BY_NAME.get("gp_project_set"),
      { displayName: "Parity", bundleId: "com.example.parity", evidenceStoragePath: "/private/tmp/deep/one" },
      engine,
      new EvidenceAuditSession(),
    );
    const text = outcome.content.map((item) => item.text ?? "").join(" ");
    assert.equal(outcome.isError, true, `/private/tmp/deep/one 在这一侧被收下了，daemon 却拒它：${text}`);
    assert.match(text, /GP_E_BAD_PARAMS/, text);
    assert.match(text, /\/private\/tmp/, `拒绝的理由要点名那条共享暂存树本身：${text}`);
  } finally {
    if (saved === undefined) delete process.env[PROJECTS_FILE_ENV];
    else process.env[PROJECTS_FILE_ENV] = saved;
    sandbox.dispose();
  }
});

test("the shipped comment states the parity instead of registering an open split", () => {
  // The red this file was written for: prose that says the two sides still disagree is a
  // drift someone will "fix" twice. It must name the rule the code now implements and the
  // gate that keeps it true.
  const raw = fs.readFileSync(REGISTRY_TS, "utf8");
  const blocks = raw.match(/\/\*[\s\S]*?\*\//g) ?? [];
  const relevant = blocks.filter((block) => block.includes("resolvedStoragePathDefect"));
  assert.ok(relevant.length > 0,
    "project-registry.ts 里再没有注释提到 resolvedStoragePathDefect：要么这段对照搬了家，要么它被删掉了——"
      + "两种都要重读，别让这条跨语言口径只活在 Swift 的一侧");
  for (const block of relevant) {
    assert.doesNotMatch(block, /still compares/,
      `注释还在用现在时宣称 daemon 那一侧是整路径相等（代码早已子树匹配）：${block.slice(0, 400)}`);
    assert.doesNotMatch(block, /仍未收口/,
      `这条口径在 round 4 就收口了，注释不能继续把它登记成未收口的裂缝：${block.slice(0, 400)}`);
    assert.match(block, /subtree/i, `注释要说清两侧现在都是子树匹配，而不是留给读者去猜：${block.slice(0, 400)}`);
    assert.match(block, /path-consistency/,
      "这段口径的守门人是 test/path-consistency.test.mjs，注释要点名它，否则下一个读者会再修一遍已经修好的那一半");
  }
});
