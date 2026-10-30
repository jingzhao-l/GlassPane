/**
 * Every environment variable this product reads has to be in the published table — in both languages.
 *
 * WHY: a structured error's remedy names `GLASSPANE_PROJECTS_FILE` and
 * `GLASSPANE_PROJECTS_FORCE_OVERWRITE` as the next move, and the settings panel honours
 * `GLASSPANE_STATE_DIR`, while `README.md` / `README.zh-CN.md` listed six variables and none of
 * those four (measured 2026-10-30: each had 0 hits in both files). An agent that follows a remedy
 * into the documentation then finds no such knob and reasonably concludes it was invented — which
 * is how a real capability starts reading like a lie.
 *
 * The rule is measured from the sources, not from prose: walk the production files, harvest
 * `GLASSPANE_[A-Z_]+`, and require each one in both tables. Adding a variable without documenting
 * it reddens this; so does documenting one nothing reads (`unbacked` below), which is the other
 * half of the same honesty rule.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Production source roots — test fixtures are excluded so a fixture-only name never counts. */
const ROOTS = [
  "engine/Sources", "engine/probe/Sources", "engine/scripts",
  "mcp-shell/src", "updater", "installer", "scripts", "bridge", "tools",
];
const ROOT_FILES = ["install.sh", "package.json"];
/** Directories inside those roots that hold tests, not shipped code. */
const SKIP_DIR = /(^|[/\\])(tests?|test-support|__pycache__|node_modules|dist|fixtures|\.build)([/\\]|$)/;
/**
 * Only code counts as " somebody reads this". A README or a `.pyc` mentioning a name is not a read:
 * the first version of this control harvested `GLASSPANE_CA_REEXEC` out of `updater/README.md` and
 * `GLASSPANE_REAL_LLDB` out of `bridge/__pycache__/*.pyc`, which is the scan accusing the docs of
 * not documenting the docs.
 */
const CODE_EXT = new Set([".swift", ".ts", ".js", ".mjs", ".py", ".sh"]);
/** Test files are not shipped code: `bridge/test_bridge.py` opts a *scenario* in, it is not a
 *  knob of the installed product. (Its own `GLASSPANE_REAL_LLDB` row still documents the opt-in.) */
const TEST_FILE = /(^|[/\\])(test_[^/\\]+\.py|[^/\\]+\.test\.(mjs|js)|daily-[^/\\]+\.test\.mjs)$/;

function walk(target, out) {
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    if (CODE_EXT.has(path.extname(target)) && !TEST_FILE.test(target)) out.push(target);
    return;
  }
  for (const name of fs.readdirSync(target)) {
    const child = path.join(target, name);
    if (SKIP_DIR.test(child)) continue;
    const childStat = fs.statSync(child);
    if (childStat.isDirectory()) walk(child, out);
    else if (CODE_EXT.has(path.extname(child)) && !TEST_FILE.test(child)) out.push(child);
  }
}

/**
 * What counts as "the product reads this from the environment":
 *  (1) the name appears as a **string literal** — `= "GLASSPANE_HTTP_TOKEN"`, `envKey = '…'`:
 *      that is how an indirect read registers the name it will consult;
 *  (2) property/bracket access on an environment object — `env.GLASSPANE_APPS_DIR`,
 *      `process.env["…"]`, `environment["…"]`, `os.environ["…"]`, `getenv("…")`;
 *  (3) a shell expansion — `${GLASSPANE_INSTALL_DRY_RUN}` or `$GLASSPANE_INSTALL_DRY_RUN`.
 * A bare identifier is NOT a read: `export const GLASSPANE_AE_PROVIDER_ID = "glasspane-engine-ae"`
 * and `GLASSPANE_SIGNING_KEY_ID = '0929E…'` are symbols whose *values* are not environment names,
 * and the first version of this control accused the READMEs of failing to document them.
 * Doc comments and prose are excluded too — a README mentioning a variable is not a read, and
 * harvesting one makes the gate "document the docs".
 */
const ENV_PROPERTY = /(?:process\.env|(^|[^\w.])env|environment|os\.environ|getenv)\s*[.[]/;
const STRING_LITERAL = /["']GLASSPANE_[A-Z][A-Z0-9_]*["']/;
const SHELL_REF = /\$\{?GLASSPANE_[A-Z][A-Z0-9_]*/;

function harvestedVariables() {
  const files = [];
  for (const root of ROOTS) {
    const absolute = path.join(REPO, root);
    if (fs.existsSync(absolute)) walk(absolute, files);
  }
  for (const file of ROOT_FILES) {
    const absolute = path.join(REPO, file);
    if (fs.existsSync(absolute)) files.push(absolute);
  }
  const found = new Map();
  // `export const GLASSPANE_HTTP_TOKEN_ENV = "GLASSPANE_HTTP_TOKEN"` — the identifier on the left
  // is a symbol holding the *real* env name; the environment is consulted under the value, never
  // under the symbol. Declared symbols are therefore not documentation obligations.
  const declaredSymbols = new Set();
  for (const file of files) {
    for (const m of fs.readFileSync(file, "utf8").matchAll(/(?:const|let|var|static let)\s+(GLASSPANE_[A-Z][A-Z0-9_]*)\s*[:=]/g)) {
      declaredSymbols.add(m[1]);
    }
  }
  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|#|\*|--)/.test(line)) return;
      const shell = file.endsWith(".sh");
      const counts = STRING_LITERAL.test(line)
        || (ENV_PROPERTY.test(line) && /GLASSPANE_[A-Z][A-Z0-9_]*/.test(line))
        || (shell && SHELL_REF.test(line));
      if (!counts) return;
      for (const match of line.matchAll(/["']?(GLASSPANE_[A-Z][A-Z0-9_]*)["']?/g)) {
        // `env.GLASSPANE_X` / `${GLASSPANE_X}` / `"GLASSPANE_X"` — the quotes or the accessor
        // carry the meaning; a bare unquoted identifier outside those shapes does not.
        const whole = match[0];
        const bare = whole === match[1];
        if (bare && !ENV_PROPERTY.test(line) && !SHELL_REF.test(line)) continue;
        if (declaredSymbols.has(match[1])) continue;
        if (!found.has(match[1])) found.set(match[1], `${path.relative(REPO, file)}:${i + 1}`);
      }
    });
  }
  return found;
}

function tableVariables(readme) {
  const text = fs.readFileSync(path.join(REPO, readme), "utf8");
  const section = /### (Environment variables|环境变量)([\s\S]*?)\n### /.exec(text);
  assert.ok(section, `${readme}: 找不到环境变量那一节 — 这张表被搬走了还是改名了？重读这条判据，别删它`);
  return new Set([...section[2].matchAll(/`(GLASSPANE_[A-Z][A-Z0-9_]*)`/g)].map((m) => m[1]));
}

test("every GLASSPANE_* variable the production sources read is documented, in both languages", () => {
  const found = harvestedVariables();
  assert.ok(found.size >= 8,
    `只从生产源码里收到 ${found.size} 个变量名——这条判据已经看不见东西（扫描根：${ROOTS.join(", ")}）`);
  const en = tableVariables("README.md");
  const zh = tableVariables("README.zh-CN.md");
  const missingEn = [...found.keys()].filter((name) => !en.has(name));
  const missingZh = [...found.keys()].filter((name) => !zh.has(name));
  assert.deepEqual(missingEn, [],
    `这些变量真的有人读（首个出处点名），但英文 README 的表里没有：${missingEn.map((n) => `${n}(${found.get(n)})`).join(", ")}`);
  assert.deepEqual(missingZh, missingEn,
    `双语必须同集合：中文缺 ${missingZh.join(", ")}，英文缺 ${missingEn.join(", ")}`);
});

test("the table promises no variable that nothing reads", () => {
  const found = new Set(harvestedVariables().keys());
  /**
   * Names the shipped product does not read, each with the tree that has to prove it honours it.
   * Not an exemption — a relocated obligation: `GLASSPANE_REAL_LLDB` is read by
   * `bridge/test_bridge.py` (a test suite this scan deliberately does not treat as shipped code),
   * and the three ledger knobs belong to the harness line, which is another task's write scope.
   * A row survives here only as long as that tree really mentions the name.
   */
  const OTHER_TREE = {
    GLASSPANE_REAL_LLDB: "bridge",
    GLASSPANE_DECISION_LOG: "harness/glasspane-harness",
    GLASSPANE_RUN_PLAN: "harness/glasspane-harness",
    GLASSPANE_RECIPE: "harness/glasspane-harness",
  };
  for (const readme of ["README.md", "README.zh-CN.md"]) {
    const table = tableVariables(readme);
    const unbacked = [...table].filter((name) => !found.has(name) && !(name in OTHER_TREE));
    assert.deepEqual(unbacked, [],
      `${readme} 的表里出现了源码从不读的变量：${unbacked.join(", ")}。
（这一条曾经抓到我自己：第一版把 GLASSPANE_SIGNING_PUBLIC_KEY 当成环境变量写进了表，而它是
installer/cli.js 的一个 module export——字符串字面量出现在 TRUST_ANCHOR_EXPORTS 里不等于
有人从环境里读它。）`);
    for (const [name, dir] of Object.entries(OTHER_TREE)) {
      if (!table.has(name)) continue;
      const consulted = grepTree(path.join(REPO, dir), name);
      assert.ok(consulted,
        `${readme} 把 ${name} 记成 ${dir} 那一侧的旋钮，但那里没有文件提到它——这一行是给不存在的能力作背书`);
    }
  }
});

/** Any code file under `dir` mentioning `name`. Shared build dirs are skipped — walking them
 *  is how this control first reported "no file honours it" for a knob the harness really reads. */
function grepTree(dir, name) {
  const PRUNE = new Set(["node_modules", ".build", "dist", ".git", ".turbo"]);
  const stack = [dir];
  let visited = 0;
  while (stack.length) {
    if (++visited > 20000) return false;
    const current = stack.pop();
    let stat;
    try { stat = fs.statSync(current); } catch { continue; }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) {
        if (PRUNE.has(entry)) continue;
        stack.push(path.join(current, entry));
      }
      continue;
    }
    if (!CODE_EXT.has(path.extname(current)) && !current.endsWith(".md")) continue;
    try {
      if (fs.readFileSync(current, "utf8").includes(name)) return true;
    } catch { /* a binary-ish file is not a read */ }
  }
  return false;
}
