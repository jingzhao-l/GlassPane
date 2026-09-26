import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  parseEvidencePack,
  parseEvidencePackRead,
  parseDecisionLogEntry,
  parseRecipeConfig,
} from "@iterate/kernel";

import { canonicalJson } from "../dist/canonical.js";
import { EvidenceAuditSession } from "../dist/audit-session.js";
import { RESTORE_MODES, TOOL_BY_NAME, executeTool } from "../dist/tools.js";
import { LineReader, MAX_FRAME_BYTES } from "../dist/io.js";
import { executableSource } from "./support/source.mjs";
import { makeEngine } from "./helpers.mjs";

/**
 * C28/C35 consumer consistency (spec v3.0 §21–§22, R33/R34).
 *
 * The MCP shell is a real kernel consumer: at runtime its glue
 * (gp_last_evidence → parseEvidenceFrame → kernel parse* → canonicalJson) is
 * the boundary where a Swift↔TS drift surfaces as GP_E_INTERNAL. This suite
 * reads the SAME truth fixtures the kernel and the engine-side Swift tests
 * consume, and runs three layers:
 *
 *   kernel-api      — fixture parses through the kernel API and re-encodes
 *                     canonically through the shell's own canonicalizer;
 *   consumer-glue   — evidence fixtures survive the gp_last_evidence tool
 *                     path end to end without drift;
 *   failure triage  — a failed assertion attributes to one of
 *                     kernel-api / consumer-glue / fixture-upstream (R34).
 *
 * fixture-upstream means the fixture itself cannot be read (missing/broken
 * file) — validation of the shared truth set, not of any consumer.
 *
 * The kernel offers two parsers on purpose: the strict write-side one (what
 * any pack the engine may store must satisfy) and the read-side one, which
 * additionally accepts the archives the engine itself produced before the
 * schema froze (legacy `0.1-draft` label, `pixelDiff.bounds` omitted instead of
 * null). Both are exercised here, because the shell's job is to let a user read
 * their own audit trail *and* to refuse off-contract bodies.
 *
 * The last layer below is a different kind of consumer consistency: the framing
 * both processes speak. `MAX_FRAME_BYTES` (this shell) and
 * `FrameCodec.maxFrameBytes` (the daemon) are one protocol fact written twice, and
 * until now no test compared them — see the section's own header for why reading
 * the *guard*, not just the number, is the part that makes the comparison mean
 * something.
 */

function fixture(relativePath) {
  return JSON.parse(
    readFileSync(new URL(`../../kernel/fixtures/${relativePath}`, import.meta.url), "utf8"),
  );
}

const FIXTURE_MATRIX = [
  { file: "evidence-pack.ok-01.json", parse: parseEvidencePack },
  { file: "evidence-pack.ok-02.json", parse: parseEvidencePack },
  // R4-12: the P6 probe-carrying form is a truth fixture on both other sides;
  // leaving it out of this matrix meant the shell's glue never saw it.
  { file: "evidence-pack.ok-03.json", parse: parseEvidencePack },
  { file: "decision-log-entry.ok-01.json", parse: parseDecisionLogEntry },
  { file: "recipe-config.ok-01.json", parse: parseRecipeConfig },
];

/** Legacy archive shapes: readable through the shell, never writable. */
const READ_ONLY_EVIDENCE_FIXTURES = [
  "evidence-pack.ok-04-legacy-draft.json",
  "evidence-pack.ok-05-pixelbounds-null.json",
];

const EVIDENCE_FIXTURES = [
  "evidence-pack.ok-01.json",
  "evidence-pack.ok-02.json",
  "evidence-pack.ok-03.json",
  ...READ_ONLY_EVIDENCE_FIXTURES,
];

/* ------------------------------------------------------------------ *
 * Layer 1 — kernel API: parse → canonicalize → compare fixture form.
 * ------------------------------------------------------------------ */

for (const { file, parse } of FIXTURE_MATRIX) {
  test(`kernel-api ${file}: kernel parse roundtrips canonically through the shell canonicalizer`, () => {
    const value = fixture(file);
    const parsed = parse(value);
    assert.equal(canonicalJson(parsed), canonicalJson(value));
  });
}

for (const file of READ_ONLY_EVIDENCE_FIXTURES) {
  test(`kernel-api(read) ${file}: the read path parses it, the write path refuses it`, () => {
    const value = fixture(file);
    assert.doesNotThrow(() => parseEvidencePackRead(value));
    // Nothing may be archived in a legacy shape: the strict parser still
    // rejects it, so the shell can read history without extending it.
    assert.throws(() => parseEvidencePack(value));
  });
}

/* ------------------------------------------------------------------ *
 * Layer 2 — consumer glue: gp_last_evidence end to end on truth fixtures.
 * ------------------------------------------------------------------ */

for (const file of EVIDENCE_FIXTURES) {
  test(`consumer-glue ${file}: gp_last_evidence end-to-end preserves the fixture canonical form`, async () => {
    const { engine, io } = makeEngine();
    const value = fixture(file);
    const tool = TOOL_BY_NAME.get("gp_last_evidence");
    const promise = executeTool(tool, {}, engine);
    // The daemon wraps the pack body in the last_evidence result frame.
    io.respond({ evidencePack: value });
    const outcome = await promise;
    assert.equal(outcome.isError, false);
    assert.equal(outcome.content.length, 1);
    assert.equal(outcome.content[0].text, canonicalJson({ evidencePack: value }));
  });
}

/* ------------------------------------------------------------------ *
 * Layer 3 — failure attribution (R34): kernel-api / consumer-glue /
 * fixture-upstream each fails with a distinguishable, attributable shape.
 * R4-16: "the pack body breaks the contract" and "the daemon never sent a
 * pack body" are different causes and must not share one remedy.
 * ------------------------------------------------------------------ */

test("failure/kernel-api: a schema-violating pack body fails zod with the C35 remedy", async () => {
  const { engine, io } = makeEngine();
  const tool = TOOL_BY_NAME.get("gp_last_evidence");
  const promise = executeTool(tool, {}, engine);
  io.respond({ evidencePack: { operationId: "bad" } });
  const outcome = await promise;
  assert.equal(outcome.isError, true);
  assert.ok(outcome.content[0].text.startsWith("GP_E_INTERNAL"));
  // zod-level attribution: the issue names the missing pack field.
  assert.ok(outcome.content[0].text.includes("schemaVersion"));
  assert.ok(outcome.content[0].text.includes("assertion C35"));
  // A body violation is not a dead daemon: no restart guidance on this path.
  assert.ok(!outcome.content[0].text.includes("restore-launchd"));
});

test("failure/consumer-glue: a structurally broken frame is not reported as fixture drift", async () => {
  const brokenFrames = [
    [{ evidencePack: "not-an-object" }, "evidencePack field is not an object"],
    [{ evidencePack: null }, "evidencePack field is not an object"],
    [{}, "missing evidencePack field in last_evidence result"],
  ];
  for (const [frame, detail] of brokenFrames) {
    const { engine, io } = makeEngine();
    const tool = TOOL_BY_NAME.get("gp_last_evidence");
    const promise = executeTool(tool, {}, engine);
    io.respond(frame);
    const outcome = await promise;
    assert.equal(outcome.isError, true);
    assert.ok(outcome.content[0].text.startsWith("GP_E_INTERNAL"));
    // glue-level attribution: the envelope guard, not the pack schema, rejects —
    // and it names which part of the envelope is wrong.
    assert.ok(
      outcome.content[0].text.includes("without an evidencePack object"),
      `frame ${JSON.stringify(frame)} must name the envelope as the cause`,
    );
    assert.ok(
      outcome.content[0].text.includes(detail),
      `frame ${JSON.stringify(frame)} must report "${detail}"`,
    );
    // The C35 remedy sent agents off to edit shared truth files that were never
    // involved; the frame carried no pack at all.
    assert.ok(!outcome.content[0].text.includes("assertion C35"));
    assert.ok(!outcome.content[0].text.includes("drifted"));
    // and the remedy it does carry is an executable one.
    assert.ok(outcome.content[0].text.includes("retry gp_last_evidence"));
    assert.ok(outcome.content[0].text.includes("restore-launchd"));
  }
});

test("consumer-glue keeps the legacy archive byte-for-byte in the agent's answer", async () => {
  // Reading normalises for validation only: what the agent gets back is the
  // daemon's frame, so an archived pack keeps its own label and key set.
  const { engine, io } = makeEngine();
  const value = fixture("evidence-pack.ok-04-legacy-draft.json");
  const tool = TOOL_BY_NAME.get("gp_last_evidence");
  const promise = executeTool(tool, {}, engine);
  io.respond({ evidencePack: value });
  const outcome = await promise;
  assert.equal(outcome.isError, false);
  assert.ok(outcome.content[0].text.includes("glasspane.evidence/0.1-draft"));
});

test("consumer-glue gp_export_evidence renders a pack whose pixelDiff has no bounds key", async () => {
  // R1-02: "no pixel change" is the commonest outcome, and the renderer reads
  // `bounds !== null` — an omitted key used to blow up here and surface as an
  // unrelated shell error.
  const { engine, io } = makeEngine();
  const value = fixture("evidence-pack.ok-05-pixelbounds-null.json");
  const tool = TOOL_BY_NAME.get("gp_export_evidence");
  const promise = executeTool(tool, { operationId: value.operationId }, engine);
  io.respond({ evidencePack: value });
  const outcome = await promise;
  assert.equal(outcome.isError, false);
  assert.ok(outcome.content[0].text.includes("pixelDiff: changedRatio=0 windowId=12"));
  assert.ok(!outcome.content[0].text.includes("bounds="));
  assert.ok(outcome.content[0].text.includes("**schemaVersion**: glasspane.evidence/0.1\n"));
  // A pack that carries the frozen label needs no provenance note; only a fold
  // is annotated (asserted on the legacy fixture below).
  assert.ok(!outcome.content[0].text.includes("read as"));
});

test("a legacy pack's report states the measured label and what it was read as", async () => {
  // B-09: this test asserted the opposite before — that the report must not
  // contain `0.1-draft`. That pinned the contradiction being fixed: the panel
  // prints the label it decoded (`EvidenceReportGenerator.swift` renders
  // `pack.schemaVersion`, and Swift's decoder keeps legacy labels), so one
  // archive produced two different contract statements and the agent-facing one
  // claimed a conformance the bytes do not carry.
  const { engine, io } = makeEngine();
  const value = fixture("evidence-pack.ok-04-legacy-draft.json");
  const promise = executeTool(
    TOOL_BY_NAME.get("gp_export_evidence"),
    { operationId: value.operationId },
    engine,
  );
  io.respond({ evidencePack: value });
  const outcome = await promise;
  assert.equal(outcome.isError, false);
  assert.ok(
    outcome.content[0].text.includes(
      "**schemaVersion**: glasspane.evidence/0.1-draft (read as glasspane.evidence/0.1)\n",
    ),
    outcome.content[0].text.slice(0, 400),
  );
  // The reading is still stated, so a consumer comparing against the frozen
  // const can see which contract the pack was validated against.
  assert.ok(outcome.content[0].text.includes("(read as glasspane.evidence/0.1)"));
  assert.equal(value.schemaVersion, "glasspane.evidence/0.1-draft");
});

test("gp_recent_reports annotates a folded pack the same way as a single export", async () => {
  // The provenance fold has two render call sites (`gp_export_evidence` and the
  // aggregate); fixing one and leaving the other to print the bare const would
  // put two of this shell's own reports in the contradiction B-02/B-09 removed.
  const { engine, io } = makeEngine();
  const value = fixture("evidence-pack.ok-04-legacy-draft.json");
  const session = new EvidenceAuditSession();
  session.record({ operationId: value.operationId });
  const promise = executeTool(TOOL_BY_NAME.get("gp_recent_reports"), { limit: 1 }, engine, session);
  // This tool's first frame waits for its audit-trail turn; drain the
  // microtasks before answering it (`tools.test.mjs`: `flush`).
  await new Promise((resolve) => setImmediate(resolve));
  io.respond({ evidencePack: value });
  const outcome = await promise;
  assert.equal(outcome.isError, false);
  assert.ok(
    outcome.content[0].text.includes("glasspane.evidence/0.1-draft (read as glasspane.evidence/0.1)"),
    outcome.content[0].text.slice(0, 400),
  );
});

test("failure/fixture-upstream: an unreadable fixture surfaces as an upstream read error", () => {
  // Triage boundary: a broken shared fixture must fail loudly at read time
  // (ENOENT), never masquerade as a consumer regression.
  assert.throws(() => fixture("evidence-pack.does-not-exist.json"));
});

/* ------------------------------------------------------------------ *
 * R4-01 — the shell is the last consumer in front of the daemon's `pid_t`
 * narrowing: `pid_t(3000000000)` traps the daemon while it decodes the frame,
 * and a pid that large stored in projects.json makes Swift fail to decode the
 * whole registry file. So the value must die here, and tools/list must say so.
 * ------------------------------------------------------------------ */

const PID_INT32_MAX = 2_147_483_647;

test("gp_attach refuses pids outside the daemon's Int32 domain without a frame", async () => {
  const spec = TOOL_BY_NAME.get("gp_attach");
  for (const pid of [0, -1, 1.5, PID_INT32_MAX + 1, 3_000_000_000]) {
    const { engine, io } = makeEngine();
    const outcome = await executeTool(spec, { pid }, engine);
    assert.equal(outcome.isError, true, `pid ${pid} must not reach the daemon`);
    assert.ok(
      outcome.content[0].text.startsWith("GP_E_BAD_PARAMS"),
      `pid ${pid} reported as ${outcome.content[0].text}`,
    );
    assert.equal(io.sent.length, 0, `pid ${pid} was forwarded over the socket`);
  }
});

test("gp_attach accepts the boundary pids the daemon can hold", async () => {
  const spec = TOOL_BY_NAME.get("gp_attach");
  for (const pid of [1, PID_INT32_MAX]) {
    const { engine, io } = makeEngine();
    const promise = executeTool(spec, { pid }, engine);
    io.respond({ pid, bundleId: "com.example.app", appName: "Example" });
    const outcome = await promise;
    assert.equal(outcome.isError, false, `pid ${pid} is inside Int32`);
    assert.equal(io.sent.length, 1);
  }
});

test("the advertised pid schemas state the domain the validators enforce", () => {
  // gp_attach forwards to the daemon's `pid_t` narrowing and gp_project_set
  // stores the value as a Swift `Int32?`: same domain (R4-01). The registry's
  // own fields are additionally patch-shaped, so `null` — "clear it" (B-11) — is
  // part of what its advertised type has to state.
  assert.deepEqual(TOOL_BY_NAME.get("gp_attach").inputSchema.properties.pid, {
    type: "integer",
    minimum: 1,
    maximum: PID_INT32_MAX,
  });
  const project = TOOL_BY_NAME.get("gp_project_set").inputSchema.properties;
  assert.deepEqual(project.pid, { type: ["integer", "null"], minimum: 1, maximum: PID_INT32_MAX });
  assert.deepEqual(project.bundleId, { type: ["string", "null"], maxLength: 256 });
  for (const field of ["recipeConfigPath", "calibrationAssetsPath", "evidenceStoragePath"]) {
    assert.deepEqual(project[field], { type: ["string", "null"], maxLength: 1024 });
  }
});

/**
 * The daemon's authoritative `restore.mode` set, read out of the Swift source
 * that declares it. B-06: `tools/list` still advertised free text ≤32 after
 * `ParamValidation.optRestoreMode` closed the set, so the shell offered a shape
 * the service always refuses. Comparing the advertisement against this file's
 * own mirror could never notice that — both sides of it live here.
 */
function daemonRestoreModes() {
  const swift = readFileSync(
    new URL("../../engine/Sources/GlassPaneEngine/ParamValidation.swift", import.meta.url),
    "utf8",
  );
  const declared = /static let restoreModes: \[String\] = \[([\s\S]*?)\]/.exec(swift);
  assert.ok(declared, "ParamValidation.restoreModes must exist for this assertion to have a source");
  return [...declared[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

test("restore.mode is advertised as the daemon's closed set, not free text", () => {
  const modes = daemonRestoreModes();
  assert.ok(modes.length > 0);
  assert.deepEqual([...RESTORE_MODES], modes, "the shell's mirror of ParamValidation.restoreModes drifted");
  assert.deepEqual(
    TOOL_BY_NAME.get("gp_restore").inputSchema.properties.mode,
    { type: "string", enum: modes },
  );
});

test("gp_restore refuses a mode the daemon does not accept, without sending a frame", async () => {
  const spec = TOOL_BY_NAME.get("gp_restore");
  const snapshotId = "snap_0123456789ABCDEFGHJKMNPQRS";
  for (const mode of ["restore executed: everything", "FFWD", "rollback", "compare ", ""]) {
    const { engine, io } = makeEngine();
    const outcome = await executeTool(spec, { snapshotId, mode }, engine);
    assert.equal(outcome.isError, true, `mode ${JSON.stringify(mode)} must not reach the daemon`);
    assert.ok(outcome.content[0].text.startsWith("GP_E_BAD_PARAMS"), outcome.content[0].text);
    assert.equal(io.sent.length, 0, "a refused mode never touches the socket");
  }
});

test("every advertised restore mode passes the validator and is forwarded verbatim", async () => {
  const spec = TOOL_BY_NAME.get("gp_restore");
  const snapshotId = "snap_0123456789ABCDEFGHJKMNPQRS";
  for (const mode of daemonRestoreModes()) {
    const { engine, io } = makeEngine();
    const promise = executeTool(spec, { snapshotId, mode }, engine);
    const frame = io.lastFrame();
    assert.equal(frame.method, "restore");
    assert.equal(frame.params.mode, mode);
    io.respond({ snapshotId, confirmed: 0, total: 0 });
    assert.equal((await promise).isError, false, `${mode} is a mode the daemon documents`);
  }
});

/* ------------------------------------------------------------------ *
 * The frame cap: ONE byte count, written twice in two languages
 * (`mcp-shell/src/io.ts` `MAX_FRAME_BYTES`, `FrameCodec.swift`
 * `maxFrameBytes`), and until now kept in sync by a comment on each side
 * that named the other one. A comment cannot be run, so this reads the
 * number out of both sources, evaluates it, and then checks that the
 * number it got is the one each side's *guard* compares against — not a
 * leftover literal elsewhere in the same file — and that this shell's
 * reader actually cuts at the daemon's value.
 * ------------------------------------------------------------------ */

/** The byte-count declarations this gate resolves, and where they live. */
const FRAME_CAP_DECLARATIONS = {
  MAX_FRAME_BYTES: { file: "../src/io.ts", declaration: "MAX_FRAME_BYTES" },
  maxFrameBytes: {
    file: "../../engine/Sources/GlassPaneEngine/FrameCodec.swift",
    declaration: "maxFrameBytes",
  },
};

/**
 * The judgements that consume the cap. Each is the statement that decides
 * whether a line is delivered or dropped, matched against comment-stripped
 * source so prose that quotes the cap (`FrameCodec.swift`'s own header, and
 * `PngEncoder.swift`'s "`FrameCodec.maxFrameBytes = 4 MB`") cannot be read as a
 * second declaration, and requiring the operand to be a *named constant* so a
 * guard re-pointed at a literal or at another constant of the same file fails
 * here instead of silently changing what this compares.
 *
 * The shell has no outbound cap of its own (`StreamLineIo.writeLine` writes
 * whatever it is given), so the shell half of the pair is its inbound reject —
 * which is also what bounds what it will accept back, and what its remedy text
 * quotes (`GP_E_PAYLOAD_TOO_LARGE`).
 */
const FRAME_CAP_CRITERIA = [
  {
    role: "this shell's inbound reject (LineReader.consume → onOversize)",
    file: "../src/io.ts",
    site: /if\s*\(\s*this\.bytes\s*\+\s*segmentBytes\s*>\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)/,
  },
  {
    role: "the daemon's inbound reject (FrameCodec.append → .oversize)",
    file: "../../engine/Sources/GlassPaneEngine/FrameCodec.swift",
    site: /if\s+buffer\.count\s*>\s*(?:Self|FrameCodec)\.([A-Za-z_][A-Za-z0-9_]*)/,
  },
  {
    role: "the daemon's outbound reject (Dispatcher.response guard)",
    file: "../../engine/Sources/GlassPaneEngine/Dispatcher.swift",
    site: /guard\s+data\.count\s*\+\s*1\s*<=\s*FrameCodec\.([A-Za-z_][A-Za-z0-9_]*)\s+else\b/,
  },
];

/**
 * One byte-count declaration, read from `file` and *evaluated*.
 *
 * Evaluated rather than string-compared because both sides spell the number as an
 * expression today, and a gate that read the spelling would fire on `1024 * 1024 *
 * 4` or `4_194_304` — false alarms are how a guard like this ends up deleted. The
 * evaluator is a sum of products of integers, written out on purpose: a byte count
 * this file has to `eval` to read is a byte count it should not be claiming.
 */
function frameCapBytes(file, declaration) {
  const source = executableSource(readFileSync(new URL(file, import.meta.url), "utf8"));
  const pattern = new RegExp(`\\b${declaration}\\b\\s*(?::[^=]*)?=\\s*([0-9][0-9_ *+]*)`, "g");
  const hits = [...source.matchAll(pattern)];
  assert.equal(
    hits.length,
    1,
    `${file} has to declare \`${declaration}\` exactly once, as a readable byte count ` +
    `(found ${hits.length}: ${JSON.stringify(hits.map((hit) => hit[1].trim()))}). Zero means the cap ` +
    `moved or stopped being a literal — point this gate at its new home and say why; more than one ` +
    `means one file now holds two answers to the same question`,
  );
  const expression = hits[0][1].trim();
  assert.match(
    expression,
    /^[0-9][0-9_]*(?:\s*[*+]\s*[0-9][0-9_]*)*$/,
    `${file}: \`${declaration} = ${expression}\` is not a product/sum of integers, so this gate ` +
    `refuses to guess what byte count it means`,
  );
  return expression
    .split("+")
    .map((term) => term
      .split("*")
      .reduce((total, factor) => total * Number(factor.trim().replace(/_/g, "")), 1))
    .reduce((total, term) => total + term, 0);
}

/* ------------------------------------------------------------------ *
 * R8b: the PNG budget and the frame cap are two numbers with one
 * inequality between them, and until now nothing wrote that inequality
 * down. `PngEncoding.defaultMaxBytes` (2.4 MB) exists *because*
 * `FrameCodec.maxFrameBytes` is 4 MiB and base64 inflates a body by 4/3
 * (PngEncoder.swift's own comment). Raise the budget past ~3.1 MB and every
 * `capture_view` reply is dropped by the framing layer as oversize — while the
 * 4 MiB three-way gate added above stays green, because both of *its* numbers
 * are still 4 MiB. That is the shape this guard exists for.
 * ------------------------------------------------------------------ */

test("the PNG budget still fits the frame cap after base64 inflation", () => {
  const budget = frameCapBytes("../../engine/Sources/GlassPaneEngine/PngEncoder.swift", "defaultMaxBytes");
  const frame = frameCapBytes("../../engine/Sources/GlassPaneEngine/FrameCodec.swift", "maxFrameBytes");
  // Integer arithmetic, no floating point: `* 4 <= * 3` is the same statement as
  // "budget × 4/3 fits", without rounding a threshold into a silent off-by-one.
  assert.ok(
    budget * 4 <= frame * 3,
    `base64 后是 ${(budget * 4 / 3).toFixed(0)} 字节，帧上限只有 ${frame}：`
    + "每一帧 capture_view 都会被 Framing 层丢掉，而两条 cap 自己仍然相等",
  );
  // The comment promises the JSON envelope gets headroom too; say how much, so a
  // future raise is a decision with a number attached rather than a guess.
  const headroom = frame - Math.ceil(budget * 4 / 3);
  assert.ok(headroom > 0, `信封余量已经用尽（headroom=${headroom}）`);
  // And the TS side must not be carrying its own copy of the budget number.
  const tsSources = ["../src/tools.ts", "../src/engine-client.ts", "../src/http-gateway.ts"];
  const restated = tsSources.filter((file) => readFileSync(new URL(file, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").includes(String(budget)));
  assert.deepEqual(restated, [],
    `TS 侧把 PNG 预算抄成了字面量，Swift 一改这里就悄悄过期：${restated.join(", ")}`);
});

test("the frame cap is one byte count across both languages, and each guard uses that one", () => {
  const readings = FRAME_CAP_CRITERIA.map((criterion) => {
    const source = executableSource(readFileSync(new URL(criterion.file, import.meta.url), "utf8"));
    const site = criterion.site.exec(source);
    assert.ok(
      site,
      `${criterion.role} no longer compares against a named constant, so nothing here can say which ` +
      `number decides an oversize frame. Either the guard started spelling a literal or it moved: in ` +
      `both cases the two sides need re-pointing at each other rather than left to match by hope`,
    );
    const declared = FRAME_CAP_DECLARATIONS[site[1]];
    assert.ok(
      declared,
      `${criterion.role} judges with \`${site[1]}\`, which this gate cannot resolve to the cap — a ` +
      `second constant took over the guard, or the cap's declaration changed name. Add the real one ` +
      `to FRAME_CAP_DECLARATIONS with the file that declares it and why it is the same rule`,
    );
    return { ...criterion, symbol: site[1], bytes: frameCapBytes(declared.file, declared.declaration) };
  });

  const values = [...new Set(readings.map((one) => one.bytes))];
  assert.equal(
    values.length,
    1,
    `the frame cap is not one number any more:\n` +
      readings.map((one) => `  ${one.role} → ${one.symbol} = ${one.bytes}`).join("\n") +
      `\nTwo caps means a frame the daemon answers with GP_E_PAYLOAD_TOO_LARGE and this shell ` +
      `buffers, or the reverse — the drift a comment on each side was supposed to prevent`,
  );
  const cap = values[0];
  assert.ok(
    Number.isSafeInteger(cap) && cap > 0,
    `a frame cap of ${cap} is not a byte count any transport can honour`,
  );

  // The declaration is read from source, so the module this shell actually loads
  // has to agree with it: an edited-but-unbuilt file, or a second cap exported
  // from somewhere else, would otherwise pass on the strength of prose.
  assert.equal(
    MAX_FRAME_BYTES,
    cap,
    `the shell's loaded MAX_FRAME_BYTES (${MAX_FRAME_BYTES}) is not the ${cap} its source declares`,
  );

  // And the loaded number is the one the reader *cuts at*, measured against the
  // daemon's value rather than against the constant imported next to it — one
  // byte either side of the boundary, both directions asserted.
  const lines = [];
  const oversize = [];
  const reader = new LineReader({
    onLine: (line) => lines.push(line.length),
    onOversize: (bytes) => oversize.push(bytes),
  });
  reader.push(`${"z".repeat(cap)}\n`);
  assert.deepEqual(
    { lines, oversize },
    { lines: [cap], oversize: [] },
    `a frame of exactly the daemon's cap must be a frame here, not an oversize`,
  );
  reader.push(`${"z".repeat(cap + 1)}\n`);
  assert.deepEqual(
    { lines, oversize },
    { lines: [cap], oversize: [cap + 1] },
    `one byte past the daemon's cap must be dropped here, with its size reported`,
  );
});