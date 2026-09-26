import { privateSandbox } from './support/sandbox.mjs'
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AGENT_PATH_PROTECTION } from "../dist/project-registry.js";
import {
  FORCE_OVERWRITE_ENV,
  PROJECTS_FILE_ENV,
  ProjectRegistryError,
  daemonProjectsPath,
  daemonRestartNotice,
  projectGet,
  projectList,
  projectSet,
} from "../dist/project-registry.js";
import { GP_E_NO_USER_RECORD } from "../dist/errors.js";
import { TOOL_BY_NAME, executeTool } from "../dist/tools.js";
import { makeEngine } from "./helpers.mjs";

/* ------------------------------------------------------------------ *
 * Registry boundary tests (P1 spec v1.4 §4 file-level access):
 *  - agent-supplied storage paths are refused before they are stored
 *  - an unloadable projects.json is reported, never overwritten
 *  - a write says what the running daemon cannot yet see
 * All state lives in a fresh mkdtemp directory pointed at by
 * GLASSPANE_PROJECTS_FILE; nothing here touches the real ~/.glasspane.
 * ------------------------------------------------------------------ */

function useRegistry() {
  const sandbox = privateSandbox("gp-registry-");
  const root = sandbox.dir;
  const filePath = path.join(root, "projects.json");
  const previousFile = process.env.GLASSPANE_PROJECTS_FILE;
  const previousForce = process.env[FORCE_OVERWRITE_ENV];
  process.env.GLASSPANE_PROJECTS_FILE = filePath;
  delete process.env[FORCE_OVERWRITE_ENV];
  return {
    root,
    filePath,
    /** A deep, project-owned path — the shape the boundary accepts. */
    storageDir: path.join(root, "proj", "notes-app", ".glasspane", "evidence"),
    dispose() {
      if (previousFile === undefined) delete process.env.GLASSPANE_PROJECTS_FILE;
      else process.env.GLASSPANE_PROJECTS_FILE = previousFile;
      if (previousForce === undefined) delete process.env[FORCE_OVERWRITE_ENV];
      else process.env[FORCE_OVERWRITE_ENV] = previousForce;
      fs.rmSync(root, { recursive: true, force: true });
      sandbox.dispose();
    },
  };
}

function expectRegistryError(fn, code, note) {
  let thrown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof ProjectRegistryError, `${note}: expected a ProjectRegistryError, got ${thrown}`);
  assert.equal(thrown.code, code, `${note}: unexpected code ${thrown.code}`);
  return thrown.message;
}

function read(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function siblings(dir, substring) {
  return fs.readdirSync(dir).filter((name) => name.includes(substring));
}

const baseArgs = { displayName: "Notes", bundleId: "com.example.notes" };

// ----- Storage-path boundary -----

test("projectSet refuses a relative evidenceStoragePath and writes nothing", () => {
  const reg = useRegistry();
  try {
    const message = expectRegistryError(
      () => projectSet({ ...baseArgs, evidenceStoragePath: "evidence/notes" }),
      "GP_E_BAD_PARAMS",
      "relative path",
    );
    assert.match(message, /must be an absolute path/);
    assert.match(message, /An acceptable value is a project-owned directory/);
    assert.equal(fs.existsSync(reg.filePath), false, "a refused call must not create the registry");
  } finally {
    reg.dispose();
  }
});

test("projectSet refuses traversal components in every path field", () => {
  const reg = useRegistry();
  try {
    const hostile = [
      `${reg.root}/../../etc/passwd`,
      `${reg.root}/./evidence`,
    ];
    for (const field of ["evidenceStoragePath", "recipeConfigPath", "calibrationAssetsPath"]) {
      for (const value of hostile) {
        const message = expectRegistryError(
          () => projectSet({ ...baseArgs, [field]: value }),
          "GP_E_BAD_PARAMS",
          `${field}=${value}`,
        );
        assert.match(message, /must not contain "\." or "\.\." components/);
      }
    }
    assert.equal(fs.existsSync(reg.filePath), false);
  } finally {
    reg.dispose();
  }
});

test("projectSet refuses sensitive roots, volume roots and the home directory", () => {
  const reg = useRegistry();
  try {
    const home = os.homedir();
    const refused = [
      "/",
      "/Applications",
      "/Applications/Notes.app/Contents",
      "/System",
      "/System/Library/CoreServices",
      "/System/Volumes/Data/Users",
      "/Library",
      "/Library/Preferences",
      "/Users",
      "/private",
      "/private/etc/ssh",
      "/etc/ssh",
      "/tmp",
      "/Volumes",
      "/Volumes/ExternalDrive",
      home,
      `${home}/Library`,
      `${home}/Library/Application Support`,
    ];
    for (const value of refused) {
      const message = expectRegistryError(
        () => projectSet({ ...baseArgs, evidenceStoragePath: value }),
        "GP_E_BAD_PARAMS",
        value,
      );
      assert.match(message, /evidenceStoragePath/);
      assert.match(message, /An acceptable value is a project-owned directory/);
    }
    assert.equal(fs.existsSync(reg.filePath), false);
  } finally {
    reg.dispose();
  }
});

test("projectSet refuses a symlinked hop into a protected root", () => {
  const reg = useRegistry();
  try {
    // The literal string looks project-owned; only resolving the existing
    // ancestor shows it lands in the home directory.
    const link = path.join(reg.root, "home-link");
    fs.symlinkSync(os.homedir(), link, "dir");
    const message = expectRegistryError(
      () => projectSet({ ...baseArgs, evidenceStoragePath: link }),
      "GP_E_BAD_PARAMS",
      "symlink into home",
    );
    assert.ok(
      message.includes(`resolves to ${os.homedir()},`),
      `the refusal must name the link target it judged, not the link: ${message}`,
    );
    assert.match(message, /home directory/);
    assert.ok(message.includes(`(given: "${link}")`), "the caller's own string stays visible");
    assert.equal(fs.existsSync(reg.filePath), false);

    // A symlink in the middle of the path is caught the same way: the literal
    // string is under the private sandbox, only resolution reaches the system tree.
    // 目标不再写死 /private/etc：那条只存在于 macOS，Linux runner 上 /etc 才是系统
    // 配置树（/private/etc 根本不存在，于是断言的是"守卫判了一条不存在的路径"）。
    // 从守卫自己导出的清单里取本平台真实存在、且自身不是软链的系统树来验，
    // macOS 得到 /private/etc + /usr，Linux 得到 /etc + /usr —— 覆盖同一分支。
    const candidates = ["/private/etc", "/etc", "/usr"].filter((p) => {
      try {
        return (
          AGENT_PATH_PROTECTION.subtrees.includes(p) &&
          fs.existsSync(p) &&
          !fs.lstatSync(p).isSymbolicLink()
        )
      } catch {
        return false
      }
    });
    assert.ok(
      candidates.length > 0,
      `本平台必须至少有一条可验证的系统树，实际候选: ${candidates.join(", ")}`,
    );
    for (const systemTree of candidates) {
      const link = path.join(reg.root, `link-${path.basename(systemTree)}`);
      try { fs.unlinkSync(link) } catch { /* 首次 */ }
      fs.symlinkSync(systemTree, link, "dir");
      const hop = path.join(link, "ssh");
      const nested = expectRegistryError(
        () => projectSet({ ...baseArgs, evidenceStoragePath: hop }),
        "GP_E_BAD_PARAMS",
        `symlinked ancestor into a system tree (${systemTree})`,
      );
      const resolved = path.join(fs.realpathSync(systemTree), "ssh");
      assert.ok(
        nested.includes(`resolves to ${resolved}, which is inside the system-owned tree`),
        `the refusal must name the resolved location it judged, not the literal hop: ${nested}`,
      );
      assert.equal(
        nested.includes(`resolves to ${hop}`),
        false,
        `未解析的字面量不能冒充解析结果: ${nested}`,
      );
      assert.ok(
        nested.includes(`(given: "${hop}")`),
        `调用方自己传的串要在拒绝理由里保留可见: ${nested}`,
      );
    }

  } finally {
    reg.dispose();
  }
});

test("projectSet accepts a deep project-owned directory and stores it verbatim", () => {
  const reg = useRegistry();
  try {
    const entry = projectSet({ ...baseArgs, evidenceStoragePath: reg.storageDir });
    assert.equal(entry.evidenceStoragePath, reg.storageDir);
    const stored = JSON.parse(read(reg.filePath));
    assert.equal(stored.length, 1);
    assert.equal(stored[0].evidenceStoragePath, reg.storageDir);
    // The restart fields are a tool-result concern; the shared file keeps the
    // daemon's own five-field shape.
    assert.equal(Object.prototype.hasOwnProperty.call(stored[0], "requiresDaemonRestart"), false);
    assert.deepEqual(
      Object.keys(stored[0]).sort(),
      ["bundleId", "createdAt", "displayName", "evidenceStoragePath", "projectId"].sort(),
    );
  } finally {
    reg.dispose();
  }
});

// ----- Corrupt / undecodable registry (A-15) -----

test("an unreadable registry is reported as unreadable, not as zero projects", () => {
  const reg = useRegistry();
  try {
    fs.writeFileSync(reg.filePath, "{ not json,,,", "utf8");
    const before = read(reg.filePath);

    const listMessage = expectRegistryError(() => projectList(), "GP_E_INTERNAL", "projectList");
    assert.match(listMessage, /is not valid JSON/);
    assert.match(listMessage, /not an empty registry/);
    expectRegistryError(() => projectGet("prj_AAAAAAAAAAAAAAAAAAAAAAAAAA"), "GP_E_INTERNAL", "projectGet");

    const setMessage = expectRegistryError(
      () => projectSet(baseArgs),
      "GP_E_INTERNAL",
      "projectSet",
    );
    assert.match(setMessage, new RegExp(FORCE_OVERWRITE_ENV));
    assert.match(setMessage, /refused to write/);

    assert.equal(read(reg.filePath), before, "the unloadable file must survive untouched");
    assert.deepEqual(siblings(reg.root, ".tmp"), [], "no partial write was attempted");
    assert.deepEqual(siblings(reg.root, ".unreadable-"), []);
  } finally {
    reg.dispose();
  }
});

test("an entry the daemon cannot decode blocks the write, because Swift rejects the whole file", () => {
  const reg = useRegistry();
  try {
    fs.writeFileSync(
      reg.filePath,
      JSON.stringify([
        { projectId: "prj_AAAAAAAAAAAAAAAAAAAAAAAAAA", displayName: "Ok", bundleId: "com.ok", createdAt: "2026-09-22T00:00:00.000Z" },
        { projectId: "prj_BBBBBBBBBBBBBBBBBBBBBBBBBB", displayName: "Poison", pid: 3_000_000_000, createdAt: "2026-09-22T00:00:00.000Z" },
      ]),
      "utf8",
    );
    const before = read(reg.filePath);

    const message = expectRegistryError(() => projectList(), "GP_E_INTERNAL", "poisoned registry");
    assert.match(message, /entry 1 has a 'pid' outside the range the daemon can decode/);
    expectRegistryError(() => projectSet(baseArgs), "GP_E_INTERNAL", "write refused");
    assert.equal(read(reg.filePath), before);
  } finally {
    reg.dispose();
  }
});

test("the named escape hatch moves the unloadable file aside instead of deleting it", () => {
  const reg = useRegistry();
  try {
    fs.writeFileSync(reg.filePath, "[oops", "utf8");
    const before = read(reg.filePath);
    process.env[FORCE_OVERWRITE_ENV] = "1";

    const entry = projectSet(baseArgs);
    assert.match(entry.projectId, /^prj_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.equal(entry.requiresDaemonRestart, true);

    const stored = JSON.parse(read(reg.filePath));
    assert.equal(stored.length, 1, "the rebuilt registry holds exactly the new entry");

    const kept = siblings(reg.root, ".unreadable-");
    assert.equal(kept.length, 1, "the unloadable file was moved aside, not deleted");
    assert.equal(read(path.join(reg.root, kept[0])), before);
    assert.equal(entry.discardedUnreadableFile, path.join(reg.root, kept[0]));
  } finally {
    reg.dispose();
  }
});

test("a missing registry is still an honest empty list", () => {
  const reg = useRegistry();
  try {
    assert.deepEqual(projectList(), []);
    assert.equal(projectGet("prj_AAAAAAAAAAAAAAAAAAAAAAAAAA"), undefined);
  } finally {
    reg.dispose();
  }
});

// ----- Write hygiene (R7-05) -----

test("writes use a unique temp name and never reuse a fixed .tmp", () => {
  const reg = useRegistry();
  try {
    // A stale fixed-name temp from an earlier writer: reuse would rename this
    // garbage into projects.json.
    fs.writeFileSync(`${reg.filePath}.tmp`, "{ half written", "utf8");

    const first = projectSet(baseArgs);
    const second = projectSet({ ...baseArgs, projectId: first.projectId, displayName: "Notes 2" });

    assert.equal(read(`${reg.filePath}.tmp`), "{ half written", "the shared .tmp name is not used");
    assert.deepEqual(siblings(reg.root, ".tmp-"), [], "each write's temp file is cleaned up");
    const stored = JSON.parse(read(reg.filePath));
    assert.equal(stored.length, 1);
    assert.equal(stored[0].displayName, "Notes 2");
    assert.equal(second.projectId, first.projectId);
  } finally {
    reg.dispose();
  }
});

// ----- Daemon-restart honesty (R4-03 / B-10) -----

test("projectSet result states that the running daemon has not seen the entry", () => {
  const reg = useRegistry();
  try {
    const entry = projectSet(baseArgs);
    assert.equal(entry.requiresDaemonRestart, true);
    assert.match(entry.daemonRestartNotice, /background service/);
    assert.match(entry.daemonRestartNotice, /restart/i);
    assert.match(entry.daemonRestartNotice, /GP_E_NOT_FOUND/);
    assert.match(entry.daemonRestartNotice, /launchctl kickstart -k gui\/\d+\/com\.glasspane\.daemon/);
    assert.ok(entry.daemonRestartNotice.includes(reg.filePath), "it names the file that was written");
  } finally {
    reg.dispose();
  }
});

/**
 * B-10: that notice used to be one unconditional sentence, which claimed a
 * restart would surface a file the daemon never loads (the daemon reads only
 * `~/.glasspane/projects.json`; `GLASSPANE_PROJECTS_FILE` is shell-only) and
 * prescribed a kickstart that cannot work for a job that was never bootstrapped.
 * The default-path branch is asserted through the pure builder below rather than
 * by writing to ~/.glasspane, which this suite must never do.
 */
test("the notice for a file the daemon cannot load says a restart will not help", () => {
  const reg = useRegistry();
  try {
    const notice = daemonRestartNotice(reg.filePath);
    assert.match(notice, /never reads that file/);
    assert.ok(notice.includes(daemonProjectsPath()), "it names the file the daemon loads");
    assert.match(notice, new RegExp(PROJECTS_FILE_ENV));
    assert.match(notice, /restarting the service will not help/);
    assert.equal(notice.includes("until the service restarts"), false);
  } finally {
    reg.dispose();
  }
});

test("the notice for the daemon's own file states the restart, with the un-bootstrapped fallback", () => {
  const notice = daemonRestartNotice(daemonProjectsPath());
  assert.match(notice, /running background service loaded that file once/);
  assert.match(notice, new RegExp(`launchctl kickstart -k gui/${process.getuid()}/com\\.glasspane\\.daemon`));
  assert.match(notice, /never bootstrapped/); // the helper's case, named not assumed
  assert.match(notice, /--restore-launchd/);
});

test("gp_project_set surfaces the restart requirement in the tool result", async () => {
  const reg = useRegistry();
  try {
    const { engine } = makeEngine();
    const outcome = await executeTool(TOOL_BY_NAME.get("gp_project_set"), baseArgs, engine);
    assert.equal(outcome.isError, false, outcome.content[0].text);
    const parsed = JSON.parse(outcome.content[0].text);
    assert.equal(parsed.project.requiresDaemonRestart, true);
    assert.match(parsed.project.daemonRestartNotice, /background service/);
    const storedAfterCreate = read(reg.filePath);

    const bad = await executeTool(
      TOOL_BY_NAME.get("gp_project_set"),
      { ...baseArgs, evidenceStoragePath: "/tmp" },
      engine,
    );
    assert.equal(bad.isError, true);
    assert.ok(bad.content[0].text.startsWith("GP_E_BAD_PARAMS"), bad.content[0].text);
    assert.ok(bad.content[0].text.includes("An acceptable value is a project-owned directory"));
    assert.equal(read(reg.filePath), storedAfterCreate, "a refused path never reaches the file");

    const overflow = await executeTool(
      TOOL_BY_NAME.get("gp_project_set"),
      { displayName: "Notes", pid: 3_000_000_000 },
      engine,
    );
    assert.equal(overflow.isError, true);
    assert.ok(overflow.content[0].text.startsWith("GP_E_BAD_PARAMS"), overflow.content[0].text);
    assert.equal(read(reg.filePath), storedAfterCreate, "an un-storable pid never reaches the file");
  } finally {
    reg.dispose();
  }
});

// ----- One identity per entry, and a way to clear a field (B-11) -----

test("an entry can never carry both identities, on create or after a merge", () => {
  const reg = useRegistry();
  try {
    const both = expectRegistryError(
      () => projectSet({ displayName: "Both", bundleId: "com.example.notes", pid: 4242 }),
      "GP_E_BAD_PARAMS",
      "create with two identities",
    );
    assert.match(both, /bundleId .*and pid .* are both set/);
    assert.equal(fs.existsSync(reg.filePath), false, "a refused identity never creates the registry");

    const created = projectSet(baseArgs); // bundleId only
    const before = read(reg.filePath);
    // The shape the old merge could produce: an update that *adds* pid to a
    // stored bundleId, which neither write path ever creates.
    const merged = expectRegistryError(
      () => projectSet({ projectId: created.projectId, displayName: "Notes", pid: 4242 }),
      "GP_E_BAD_PARAMS",
      "update adding a second identity",
    );
    assert.match(merged, /both set/);
    assert.match(merged, /com\.example\.notes/, "the message names the values it found");
    assert.match(merged, /4242/);
    assert.equal(read(reg.filePath), before, "a refused update leaves the stored entry intact");

    const neither = expectRegistryError(
      () => projectSet({ projectId: created.projectId, displayName: "Notes", bundleId: null, pid: null }),
      "GP_E_BAD_PARAMS",
      "update clearing both identities",
    );
    assert.match(neither, /neither bundleId nor pid/);
    assert.equal(read(reg.filePath), before);
  } finally {
    reg.dispose();
  }
});

test("an explicit null switches the identity and clears a path field; omitting keeps it", async () => {
  const reg = useRegistry();
  try {
    const { engine } = makeEngine();
    const recipe = `${reg.root}/proj/recipe.json`;
    const created = await executeTool(
      TOOL_BY_NAME.get("gp_project_set"),
      { ...baseArgs, evidenceStoragePath: reg.storageDir, recipeConfigPath: recipe },
      engine,
    );
    assert.equal(created.isError, false, created.content[0].text);
    const projectId = JSON.parse(created.content[0].text).project.projectId;

    // Through the tool surface, so the explicit null has to survive zod too.
    const switched = await executeTool(
      TOOL_BY_NAME.get("gp_project_set"),
      { projectId, displayName: "Notes", bundleId: null, pid: 4242 },
      engine,
    );
    assert.equal(switched.isError, false, switched.content[0].text);
    const entry = JSON.parse(switched.content[0].text).project;
    assert.equal(entry.pid, 4242);
    assert.equal("bundleId" in entry, false, "the cleared field is absent, not null");

    const kept = projectSet({ projectId, displayName: "Renamed" });
    assert.equal(kept.evidenceStoragePath, reg.storageDir, "omitting a path field keeps what is stored");

    const cleared = projectSet({ projectId, displayName: "Renamed", evidenceStoragePath: null });
    assert.equal(cleared.evidenceStoragePath, undefined);
    assert.equal(cleared.recipeConfigPath, recipe, "the other fields survive");
    const stored = JSON.parse(read(reg.filePath))[0];
    assert.deepEqual(Object.keys(stored).sort(),
      ["createdAt", "displayName", "pid", "projectId", "recipeConfigPath"],
      "a cleared field is gone from the file, in the key set the daemon decodes");
  } finally {
    reg.dispose();
  }
});

// ----- Storage root must sit under a directory this user owns (B-13) -----

test("a storage root in a shared or foreign tree is refused by the ownership rule", () => {
  const reg = useRegistry();
  try {
    // Owned by this user but world-writable: the case a deny list of named
    // subtrees cannot cover, closed by the positive shape rule.
    const open = path.join(reg.root, "open-to-all");
    fs.mkdirSync(open);
    fs.chmodSync(open, 0o777);

    const refused = [
      ["/Users/Shared/notes-app/.glasspane/evidence", /owned by the current user/],
      ["/Users/somebody-else/work/notes/.glasspane/evidence", /owned by the current user/],
      ["/var/folders/none/T/notes/.glasspane/evidence", /owned by the current user/],
      [path.join(open, "evidence"), /world-writable/],
    ];
    for (const [value, reason] of refused) {
      const message = expectRegistryError(
        () => projectSet({ ...baseArgs, evidenceStoragePath: value }),
        "GP_E_BAD_PARAMS",
        value,
      );
      assert.match(message, /An acceptable value is a project-owned directory/);
      assert.match(message, reason, `refused for the wrong reason: ${message}`);
    }
    assert.equal(fs.existsSync(reg.filePath), false, "none of them created a registry");
  } finally {
    reg.dispose();
  }
});

test("a private ancestor the current user owns is what makes a deep root acceptable", () => {
  const reg = useRegistry();
  try {
    const parent = path.join(reg.root, "notes-app");
    fs.mkdirSync(parent);
    fs.chmodSync(parent, 0o750);
    const target = path.join(parent, ".glasspane", "evidence");
    assert.equal(projectSet({ ...baseArgs, evidenceStoragePath: target }).evidenceStoragePath, target);
  } finally {
    reg.dispose();
  }
});

/* ------------------------------------------------------------------ *
 * The home the daemon actually reads (round-8 MCP review, 高2)
 *
 * The daemon's state root is `StateRoot.homeDefault()` =
 * `NSHomeDirectory() + "/.glasspane"`, and `StateRoot.swift` says in its own
 * header that on macOS that lookup "does **not** honour a `HOME` override set
 * by the caller" — the non-inheritance that has already cost this project real
 * registrations. Node has *two* home lookups and they differ on exactly this:
 * `os.homedir()` reads `$HOME`, `os.userInfo().homedir` reads the passwd record.
 * Measured on this machine:
 *
 *   HOME=/tmp/fake-sbx-home node -e 'const os=require("os"); \
 *     console.log(os.homedir(), "|", os.userInfo().homedir)'
 *   -> /tmp/fake-sbx-home | /Users/ethanlin
 *
 * So the two `$HOME`-following lookups in `project-registry.ts` resolved a
 * different directory than the daemon from the moment a caller exported `HOME`:
 *  - `daemonProjectsPath()` handed back a sandbox path while its own doc
 *    promises "the file the *daemon* reads … a write aimed elsewhere is a write
 *    nothing loads", and `daemonRestartNotice()` compared against that value —
 *    so the stray-write guard passed the file nothing loads and refused the file
 *    the daemon does load;
 *  - `refuseCandidate()`'s home rule protected the sandbox, leaving the real
 *    home and `~/Library` registrable — one exported variable switched the
 *    protection off.
 * Both are pinned below, through the exported surface rather than the private
 * helper. Neither test writes anywhere but its own sandbox: `useRegistry()`
 * pins `GLASSPANE_PROJECTS_FILE` for the whole run, so no call here can reach
 * the real `~/.glasspane` whatever the home lookup returns.
 * ------------------------------------------------------------------ */

/**
 * Run `body` with `$HOME` pointed at a fresh private sandbox directory, then put
 * `$HOME` back. The restore is in `finally` because this file runs sequentially
 * inside one process and the tests above (and the daemon-path ones below) judge
 * the *real* home: leaking a sandboxed `HOME` would turn a green run into an
 * accident. The fake home exists only to poison `$HOME` — it is never passed to
 * `projectSet` as a storage root.
 */
function withSandboxHome(body) {
  const fakeHome = privateSandbox("gp-fake-home-");
  const previous = process.env.HOME;
  process.env.HOME = fakeHome.dir;
  try {
    // The premise, checked rather than assumed. If `os.homedir()` ever stopped
    // following `$HOME`, every assertion below would hold vacuously and the
    // regression it exists to catch would sail through.
    assert.equal(
      os.homedir(),
      fakeHome.dir,
      "premise broken: os.homedir() did not follow $HOME into the sandbox, so nothing " +
      "below distinguishes the two lookups — re-read Node's home semantics before trusting this test",
    );
    return body(fakeHome.dir);
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
    fakeHome.dispose();
  }
}

test("daemonProjectsPath follows the daemon's home, not $HOME", () => {
  const reg = useRegistry();
  try {
    withSandboxHome(() => {
      const expected = path.join(os.userInfo().homedir, ".glasspane", "projects.json");
      const sandboxed = path.join(process.env.HOME, ".glasspane", "projects.json");
      const actual = daemonProjectsPath();
      assert.equal(
        actual,
        expected,
        `the shell and the daemon must name the same file (Swift: StateRoot.homeDefault() \
         = NSHomeDirectory() + "/.glasspane/projects.json"). With $HOME=${process.env.HOME} \
         this shell named ${actual}`,
      );
      assert.notEqual(
        actual,
        sandboxed,
        `a $HOME-derived path is a file nothing loads: ${actual} — and \`daemonRestartNotice\` \
         built from it would tell the agent to write *there*`,
      );
      assert.equal(
        actual.startsWith(`${process.env.HOME}/`),
        false,
        `the daemon's registry must not resolve inside the sandbox: ${actual}`,
      );
    });
  } finally {
    reg.dispose();
  }
});

test("the stray-write guard still points at the daemon's file when $HOME moves", () => {
  const reg = useRegistry();
  try {
    withSandboxHome(() => {
      // The guard's whole job is to tell the caller "the file you wrote is not
      // the file the daemon loads". With $HOME pointing into the sandbox the
      // sandbox path *was* the computed daemon path, so a write to the real
      // registry — the one write that does load — got the warning, and a write
      // to the sandbox got the reassuring sentence. Both halves are pinned.
      const notice = daemonRestartNotice(reg.filePath);
      assert.match(
        notice,
        /never reads that file/,
        `a sandboxed file is not the one the daemon loads, and the notice must say so: ${notice}`,
      );
      assert.ok(
        notice.includes(path.join(os.userInfo().homedir, ".glasspane", "projects.json")),
        `the notice must name the daemon's real file, not a $HOME-derived one: ${notice}`,
      );

      const own = daemonRestartNotice(daemonProjectsPath());
      assert.match(
        own,
        /loaded that file once/,
        `the daemon's own file must get the plain restart sentence: ${own}`,
      );
      assert.equal(
        own.includes("never reads that file"),
        false,
        `the daemon's own file cannot be the one it never reads: ${own}`,
      );
    });
  } finally {
    reg.dispose();
  }
});

test("a sandboxed $HOME does not move the home and ~/Library protections", () => {
  const reg = useRegistry();
  try {
    withSandboxHome(() => {
      const systemHome = os.userInfo().homedir;
      const refused = [
        [systemHome, "the current user's home directory"],
        [path.join(systemHome, "Library"), "inside the current user's Library folder"],
        [
          path.join(systemHome, "Library", "Preferences", "GlassPane"),
          "inside the current user's Library folder",
        ],
      ];
      for (const [value, reason] of refused) {
        const message = expectRegistryError(
          () => projectSet({ ...baseArgs, evidenceStoragePath: value }),
          "GP_E_BAD_PARAMS",
          `${value} while HOME=${process.env.HOME}`,
        );
        // The *named* rule, by name: an accidental refusal for some other
        // reason (an ownership complaint, say) would pass a "was it refused"
        // check while the home protection itself stayed off.
        assert.ok(
          message.includes(reason),
          `${value} must be refused by the named rule "${reason}" — exporting HOME must not \
           switch the protection off, and a different reason means it did: ${message}`,
        );
        assert.match(message, /An acceptable value is a project-owned directory/);
      }
      assert.equal(
        fs.existsSync(reg.filePath),
        false,
        "none of them reached the registry",
      );
    });
  } finally {
    reg.dispose();
  }
});

/**
 * The refusal branch, made executable rather than asserted in prose.
 *
 * `systemHome()` says that when the user record cannot be read it refuses
 * instead of falling back. A branch nobody can run is a branch nobody keeps, and
 * the regression here would be invisible to the cross-language gate if someone
 * wrote the fallback as `process.env.HOME` rather than `os.homedir()` — the ban
 * is on the spelling, this is on the behaviour. So the lookup is made to fail
 * while `$HOME` still answers, and the answer must be a refusal that names
 * neither the sandbox nor any path at all.
 */
test("no user record is a refusal, not a $HOME guess", () => {
  const reg = useRegistry();
  try {
    withSandboxHome((sandboxHome) => {
      const realUserInfo = os.userInfo;
      const recordHome = os.userInfo().homedir;
      try {
        os.userInfo = () => {
          throw Object.assign(new Error("getpwuid: no such user"), { code: "ENOENT" });
        };
        // GP_E_NO_USER_RECORD, not GP_E_INTERNAL: `tools.ts` maps GP_E_INTERNAL
        // to "the projects file is damaged, go read it", and for this failure
        // there is no damaged file — naming one would send the agent to open a
        // healthy projects.json. The behavioural assertions below (no `$HOME`
        // fallback, the missing lookup named) are the point of this test.
        const message = expectRegistryError(
          () => daemonProjectsPath(),
          GP_E_NO_USER_RECORD,
          "home lookup with no user record",
        );
        assert.equal(
          message.includes(sandboxHome),
          false,
          `$HOME is not the fallback: the shell answered with a path derived from it. ${message}`,
        );
        assert.match(message, /NSHomeDirectory/, `must say which lookup it needed: ${message}`);
        assert.match(message, /password database/, `must name a remedy: ${message}`);
        // The tolerant branch it refuses to fake: nothing was written, and the
        // registry the caller pointed at is still absent.
        assert.equal(fs.existsSync(reg.filePath), false);
      } finally {
        os.userInfo = realUserInfo;
      }
      // The patch is gone again — otherwise every later test in this file would
      // be judging a stub, and "green" would mean nothing.
      assert.equal(
        daemonProjectsPath(),
        path.join(recordHome, ".glasspane", "projects.json"),
        "os.userInfo must be back to the real lookup after the stub",
      );
    });
  } finally {
    reg.dispose();
  }
});
