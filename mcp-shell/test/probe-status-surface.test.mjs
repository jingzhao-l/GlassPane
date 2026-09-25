import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { TOOL_BY_NAME } from "../dist/tools.js";

/**
 * R6-02: every key the daemon publishes under `probe_status` has to be described
 * in the `gp_probe_status` tool description, because that description is the only
 * thing an agent reads before it decides what the reply means.
 *
 * Why a source-scanning test rather than a runtime one: the shell has no daemon to
 * ask in a unit run, and the alternative — writing the key list twice, once in
 * Swift and once in prose here — is the drift that produced the real defect. R5-06
 * published a `degradation` block (the T9 watch, which an agent must be able to
 * read without clicking) and the description kept enumerating every *other* key.
 * An agent that trusted it would have seen `"tier":"healthy"` with no `judged`
 * alongside and concluded the app was clean.
 *
 * The key names are read out of `EngineCore.probeStatus()` itself, so adding a
 * published key without describing it turns this red. The vacuity guards at the
 * bottom are what keep a broken extraction from passing quietly: the extraction
 * has to have found a plausible number of keys, has to have found one in each of
 * the two regions it exists to cover, and the checker has to refuse a key that is
 * not in the description (a control that cannot go red is not a control).
 */

const ENGINE_CORE = new URL("../../engine/Sources/GlassPaneEngine/EngineCore.swift", import.meta.url);

function probeStatusBody(source) {
  const start = source.indexOf("public func probeStatus() -> [String: Any]");
  assert.notEqual(start, -1, "probeStatus() vanished from EngineCore.swift: the gate must move with it");
  const rest = source.slice(start + "public func probeStatus()".length);
  const next = rest.search(/\n {4}public (?:func|var) /);
  const body = next === -1 ? rest : rest.slice(0, next);
  assert.ok(body.length > 500 && body.length < 8_000, `extracted region looks wrong: ${body.length} chars`);
  return body;
}

function publishedKeys(body) {
  const keys = new Set();
  // `payload["x"] = …`, `block["x"] = …`, `slopes["x"] = …`
  for (const match of body.matchAll(/\[(?:"|)([a-z][A-Za-z]*)"?]\s*=/g)) keys.add(match[1]);
  for (const match of body.matchAll(/\w+\["([a-z][A-Za-z]*)"\]\s*=/g)) keys.add(match[1]);
  // dictionary literals: `"tier": watch.tier.rawValue`
  for (const match of body.matchAll(/^\s+"([a-z][A-Za-z]*)":\s/gm)) keys.add(match[1]);
  return [...keys].sort();
}

function undescribed(keys, description) {
  return keys.filter((key) => !description.includes(key));
}

const description = TOOL_BY_NAME.get("gp_probe_status").description;
const keys = publishedKeys(probeStatusBody(fs.readFileSync(ENGINE_CORE, "utf8")));

test("every published probe_status key is named in the tool description", () => {
  assert.deepEqual(undescribed(keys, description), [], `undocumented key: ${JSON.stringify(keys)}`);
});

test("the extraction found the surface it claims to cover, not nothing", () => {
  assert.ok(keys.length >= 15, `only ${keys.length} keys found: ${JSON.stringify(keys)}`);
  // One from the top-level payload and one from inside the degradation block: a
  // parser that silently matched only the first region would still have keys.
  assert.ok(keys.includes("probes"), JSON.stringify(keys));
  assert.ok(keys.includes("degradation"), JSON.stringify(keys));
  assert.ok(keys.includes("judged"), JSON.stringify(keys));
  assert.ok(keys.includes("basis"), JSON.stringify(keys));
});

test("the checker does refuse an undocumented key", () => {
  // The negative half: with only the strings above the gate could pass because it
  // never reports anything. `slopes` is a real published key, so removing its name
  // from the description has to be what turns the check red.
  assert.deepEqual(undescribed(["judged"], "the reply carries tier and samples"), ["judged"]);
  assert.deepEqual(undescribed(["judged"], "read `judged` before `tier`"), []);
});
