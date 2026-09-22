import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  FORCE_OVERWRITE_ENV,
  ProjectRegistryError,
  projectGet,
  projectList,
  projectSet,
} from "../dist/project-registry.js";
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-registry-"));
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
    assert.match(message, /resolves to/);
    assert.match(message, /home directory/);
    assert.equal(fs.existsSync(reg.filePath), false);

    // A symlink in the middle of the path is caught the same way: the literal
    // string is under the temp dir, only resolution reaches the system tree.
    const etcLink = path.join(reg.root, "etc-link");
    fs.symlinkSync("/private/etc", etcLink, "dir");
    const nested = expectRegistryError(
      () => projectSet({ ...baseArgs, evidenceStoragePath: path.join(etcLink, "ssh") }),
      "GP_E_BAD_PARAMS",
      "symlinked ancestor into a system tree",
    );
    assert.match(nested, /inside the system-owned tree/);
    assert.equal(fs.existsSync(reg.filePath), false);
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

// ----- Daemon-restart honesty (R4-03) -----

test("projectSet result states that the running daemon has not seen the entry", () => {
  const reg = useRegistry();
  try {
    const entry = projectSet(baseArgs);
    assert.equal(entry.requiresDaemonRestart, true);
    assert.match(entry.daemonRestartNotice, /background service/);
    assert.match(entry.daemonRestartNotice, /restart/i);
    assert.match(entry.daemonRestartNotice, /GP_E_NOT_FOUND/);
    assert.match(entry.daemonRestartNotice, /launchctl kickstart -k gui\/\d+\/com\.glasspane\.daemon/);
  } finally {
    reg.dispose();
  }
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
