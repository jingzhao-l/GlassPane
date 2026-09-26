import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import {
  parseEvidencePack,
  parseEvidencePackRead,
  parseDecisionLogEntry,
  parseRecipeConfig,
} from "@iterate/kernel";

import { canonicalJson } from "../dist/canonical.js";
import { EvidenceAuditSession } from "../dist/audit-session.js";
import { RESTORE_MODES, TOOL_BY_NAME, executeTool } from "../dist/tools.js";
import { ProjectSetArgs } from "../dist/project-registry.js";
import { LineReader, MAX_FRAME_BYTES } from "../dist/io.js";
import { executableSource } from "./support/source.mjs";
import { makeEngine } from "./helpers.mjs";
import { EngineJsonRpcClient } from "../dist/engine-client.js";
import { FakeLineIo } from "./helpers.mjs";

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
 * The last layers below are a different kind of consumer consistency: protocol
 * facts that are decided in one language and reached for in the other. The
 * framing both processes speak — `MAX_FRAME_BYTES` (this shell) and
 * `FrameCodec.maxFrameBytes` (the daemon) — is one byte count written twice, kept
 * in sync until recently by a comment on each side that named the other one; the
 * daemon's pid domain and the PNG budget's inequality against the frame cap are
 * the same defect in the same shape. A comment cannot be run, so these sections
 * read the fact out of the source that owns it, *evaluate* it (a ceiling spelled
 * `Int(Int32.max)` is a value, not a string), check that each side's *guard*
 * compares against it rather than a leftover literal, and require every use site
 * in this shell to reach the constant instead of carrying its digits — see each
 * section's own header for why that last part is what makes the comparison mean
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
  // R9-d: this used to pin the literal string "assertion C35" — developer
  // prose sitting inside agent-facing remedy text, and another lane is
  // stripping exactly that wording right now. What the sentence must keep
  // guaranteeing is the behaviour: a pack DID arrive and was rejected by the
  // evidence contract (schema/format), which is what separates this reply from
  // the envelope case below ("no pack at all") and from "the daemon is down".
  // Mutation: re-point this remedy at daemon liveness ("restart", "unreachable",
  // "no answer") without the contract attribution → red.
  assert.match(outcome.content[0].text, /schema|evidence format|evidence contract/i,
    "schema-violating pack body 必须被归因到证据契约本身，而不是缺包或死 daemon");
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
  // NOT `makeEngine()`: its 500 ms is a *caller deadline*, and this test must let one
  // microtask turn pass before it can answer (the audit-trail turn), so under load the
  // deadline can fire before the reply is even written — two lanes each saw this go red
  // once on an otherwise-identical tree. A control that fails for scheduling reasons is
  // not measuring the product: this client carries the method table's own bound instead,
  // so the render assertion below is the only thing that can fail here.
  const io = new FakeLineIo();
  const engine = new EngineJsonRpcClient(io);
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
 *
 * The bounds below come from {@link daemonPidDomain}, which evaluates them out
 * of `ParamValidation.swift`. They used to be `const PID_INT32_MAX = 2_147_483_647`
 * written out here — the third hand copy of that number in the shell, after
 * `src/tools.ts` and `src/project-registry.ts` — and a copy in the file whose
 * job is to compare the others cannot notice any drift: it *is* the drift, read
 * back as agreement. See "the daemon's pid domain" below for the gate.
 * ------------------------------------------------------------------ */

test("gp_attach refuses pids outside the daemon's Int32 domain without a frame", async () => {
  const { lower, upper } = daemonPidDomain();
  const spec = TOOL_BY_NAME.get("gp_attach");
  for (const pid of [lower - 1, lower - 2, 1.5, upper + 1, 3_000_000_000]) {
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
  const { lower, upper } = daemonPidDomain();
  const spec = TOOL_BY_NAME.get("gp_attach");
  for (const pid of [lower, upper]) {
    const { engine, io } = makeEngine();
    const promise = executeTool(spec, { pid }, engine);
    io.respond({ pid, bundleId: "com.example.app", appName: "Example" });
    const outcome = await promise;
    assert.equal(outcome.isError, false, `pid ${pid} is inside the daemon's domain`);
    assert.equal(io.sent.length, 1);
  }
});

test("the advertised pid schemas state the domain the validators enforce", () => {
  const { lower, upper } = daemonPidDomain();
  // gp_attach forwards to the daemon's `pid_t` narrowing and gp_project_set
  // stores the value as a Swift `Int32?`: same domain (R4-01). The registry's
  // own fields are additionally patch-shaped, so `null` — "clear it" (B-11) — is
  // part of what its advertised type has to state.
  assert.deepEqual(TOOL_BY_NAME.get("gp_attach").inputSchema.properties.pid, {
    type: "integer",
    minimum: lower,
    maximum: upper,
  });
  const project = TOOL_BY_NAME.get("gp_project_set").inputSchema.properties;
  assert.deepEqual(project.pid, { type: ["integer", "null"], minimum: lower, maximum: upper });
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
 * The fixed-width integer types whose bounds a limit here can be spelled with,
 * and how many bits each spans on the 64-bit platform this daemon runs on.
 */
const INTEGER_TYPE_BITS = {
  Int: 64,
  UInt: 64,
  Int8: 8,
  Int16: 16,
  Int32: 32,
  Int64: 64,
  UInt8: 8,
  UInt16: 16,
  UInt32: 32,
  UInt64: 64,
};

/** `Int32.max` / `UInt8.min` as a number — the form the daemon spells its ceilings. */
function integerTypeBound(name) {
  const [type, bound] = String(name).split(".");
  const bits = INTEGER_TYPE_BITS[type];
  assert.ok(
    bits !== undefined && (bound === "max" || bound === "min"),
    `\`${name}\` is not a fixed-width integer bound this gate resolves (\`Int\`/\`UInt\`, \`Int8\`…\`Int64\`, ` +
    `\`UInt8\`…\`UInt64\`, each with \`.max\`/\`.min\`). A limit written another way is a different fact, not the same ` +
    `fact spelled differently: point the gate at the new fact and say where it comes from`,
  );
  const signed = !type.startsWith("UInt");
  const magnitude = 2 ** (signed ? bits - 1 : bits);
  if (bound === "max") return magnitude - 1;
  return signed ? -magnitude : 0;
}

/** `Int(x)`: Swift's trapping conversion — out of range there is no value at all. */
function integerConversion(type, value, context) {
  const bits = INTEGER_TYPE_BITS[type];
  assert.ok(
    bits !== undefined,
    `${context}: \`${type}(…)\` is not an integer conversion this gate reads`,
  );
  const signed = !type.startsWith("UInt");
  const magnitude = 2 ** (signed ? bits - 1 : bits);
  const low = signed ? -magnitude : 0;
  const high = magnitude - 1;
  assert.ok(
    Number.isInteger(value) && value >= low && value <= high,
    `${context}: \`${type}(${value})\` is outside \`${type}\`, which is a run-time trap in Swift — the very failure ` +
    `mode the pid bound exists to stop. A gate that read it as a number would be measuring a value no process can hold`,
  );
  return value;
}

/**
 * Evaluate an integer expression read out of a source file: sums, products,
 * parentheses, a leading minus, `_`-separated literals, fixed-width bounds by
 * name, one-argument conversions of them, and whatever names the caller can
 * resolve (usually a sibling declaration).
 *
 * Shared by every gate in this file that reads a number out of someone else's
 * source — the frame cap, the pid domain, the PNG budget — because three
 * evaluators is three opinions about what `4 * 1024 * 1024` means, and the two
 * that agree out loud while disagreeing about `Int(Int32.max)` is exactly the
 * shape this round keeps finding. Nothing is `eval`ed: the whole expression has
 * to reassemble out of the tokens above, so a shift, a modulo, a ternary or a
 * `#if` fails here instead of returning a plausible-looking wrong number.
 */
function constExprValue(expression, { resolve, context }) {
  const text = String(expression).trim();
  const tokens = text.match(/\d[\d_]*|[A-Za-z_][A-Za-z0-9_.]*|[()+*,-]/g) ?? [];
  assert.equal(
    tokens.join(""),
    text.replace(/\s+/g, ""),
    `${context}: \`${text}\` is spelled with something this gate does not evaluate (only sums, products, ` +
    `parentheses, a leading minus, \`_\`-separated integers and resolvable names go through). Refusing is the ` +
    `point: a bound it cannot read is a bound it cannot mirror, and a guessed one passes while lying`,
  );
  let at = 0;
  const peek = () => tokens[at];
  const sum = () => {
    let total = product();
    while (peek() === "+" || peek() === "-") {
      const operator = tokens[at++];
      const right = product();
      total = operator === "+" ? total + right : total - right;
    }
    return total;
  };
  const product = () => {
    let value = unary();
    while (peek() === "*") {
      at += 1;
      value *= unary();
    }
    return value;
  };
  const unary = () => {
    if (peek() === "-") {
      at += 1;
      return -unary();
    }
    if (peek() === "+") {
      at += 1;
      return unary();
    }
    return atom();
  };
  const atom = () => {
    const token = tokens[at++];
    assert.ok(token !== undefined, `${context}: \`${text}\` ends in the middle of an operand`);
    if (token === "(") {
      const inner = sum();
      assert.equal(tokens[at++], ")", `${context}: \`${text}\` has unbalanced parentheses`);
      return inner;
    }
    if (/^\d/.test(token)) return Number(token.replace(/_/g, ""));
    assert.match(
      token,
      /^[A-Za-z_]/,
      `${context}: \`${token}\` is neither an integer nor a name this gate can resolve`,
    );
    if (peek() !== "(") return resolve(token, [], context);
    at += 1;
    const args = [sum()];
    while (peek() === ",") {
      at += 1;
      args.push(sum());
    }
    assert.equal(tokens[at++], ")", `${context}: \`${text}\` leaves a call unterminated`);
    return resolve(token, args, context);
  };
  const value = sum();
  assert.equal(
    at,
    tokens.length,
    `${context}: \`${text}\` leaves ${JSON.stringify(tokens.slice(at))} unread`,
  );
  assert.ok(
    Number.isSafeInteger(value),
    `${context}: \`${text}\` evaluates to ${value}, which no consumer here can hold exactly — widening a bound ` +
    `this shell mirrors is a contract change to make by hand, not one to read past`,
  );
  return value;
}

/**
 * The integer constants of one source file, read *by name* so that a use site can
 * be evaluated through the constant it references rather than through a copy of
 * its digits.
 *
 * `executableSource` is applied here, as in the frame-cap gate, so prose that
 * quotes a declaration cannot be read as a second declaration of it.
 */
function sourceIntegers(file) {
  const text = readFileSync(new URL(file, import.meta.url), "utf8");
  const code = executableSource(text);
  const values = new Map();
  const reading = [];

  function rightHandSide(declaration) {
    const pattern = new RegExp(
      `^[ \\t]*(?:(?:public|private|internal|fileprivate|static|final|override|export|declare|readonly)` +
        `\\s+)*(?:const|let|var)\\s+${declaration}\\b[ \\t]*(?::[^=\\n]*)?=[ \\t]*(.*)$`,
      "gm",
    );
    const hits = [...code.matchAll(pattern)];
    assert.equal(
      hits.length,
      1,
      `${file} has to declare \`${declaration}\` exactly once, as a one-line integer (found ${hits.length}: ` +
      `${JSON.stringify(hits.map((hit) => hit[1].trim()))}). Zero means it moved, stopped being a literal, or was ` +
      `split across lines — point this gate at its new home and say why; more than one means one file now holds ` +
      `two answers to the same question`,
    );
    return hits[0][1].trim().replace(/[;,][ \t]*$/, "");
  }

  function evaluate(expression, context) {
    return constExprValue(expression, {
      context: `${file}: ${context}`,
      resolve: (name, args, at) => {
        if (args.length > 0) {
          assert.equal(args.length, 1, `${at}: \`${name}(…)\` takes more than one argument, so this is not a conversion`);
          return integerConversion(name, args[0], at);
        }
        if (name.includes(".")) return integerTypeBound(name);
        return integer(name);
      },
    });
  }

  function integer(declaration) {
    if (!values.has(declaration)) {
      assert.ok(
        !reading.includes(declaration),
        `${file}: ${[...reading, declaration].join(" = ")} = … is a cycle, so none of these constants has a value ` +
        `for the mirrors to agree with`,
      );
      reading.push(declaration);
      try {
        const expression = rightHandSide(declaration);
        values.set(declaration, evaluate(expression, `\`${declaration} = ${expression}\``));
      } finally {
        reading.pop();
      }
    }
    return values.get(declaration);
  }

  /** A `[lower, upper]` pair, evaluated element by element (the registry's shape). */
  function tuple(declaration) {
    const expression = rightHandSide(declaration);
    const listed = /^\[(.*)\]$/.exec(expression);
    assert.ok(
      listed,
      `${file}: \`${declaration} = ${expression}\` is no longer a one-line \`[lower, upper]\`, so this gate cannot ` +
      `tell which bound is which — read it another way and say what each element means`,
    );
    assert.doesNotMatch(
      listed[1],
      /[[\]()]/,
      `${file}: \`${declaration}\` nests something inside its tuple, which this reader does not resolve`,
    );
    return listed[1].split(",").map((element) =>
      evaluate(element, `\`${declaration} = ${expression}\` element \`${element.trim()}\``));
  }

  return { file, text, code, rightHandSide, evaluate, integer, tuple };
}

/**
 * One byte-count declaration, read from `file` and *evaluated*.
 *
 * Evaluated rather than string-compared because both sides spell the number as an
 * expression today, and a gate that read the spelling would fire on `1024 * 1024 *
 * 4` or `4_194_304` — false alarms are how a guard like this ends up deleted. The
 * evaluator is a sum of products of integers, written out on purpose: a byte count
 * this file has to `eval` to read is a byte count it should not be claiming.
 *
 * Deliberately narrower than {@link constExprValue}, of which it is the digits-only
 * case: the frame cap is a count, so a cap spelled with a *name* is a different
 * question (whose answer may well be another file) and this gate refuses to
 * resolve it silently. The pid ceiling is the opposite case — there the name *is*
 * the fact — which is why `daemonPidDomain` goes through `sourceIntegers`.
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
  return constExprValue(expression, {
    context: `${file}: \`${declaration} = ${expression}\``,
    resolve: (name, _args, context) =>
      assert.fail(`${context}: it references \`${name}\`, which this digits-only reader cannot resolve`),
  });
}

/* ------------------------------------------------------------------ *
 * The daemon's pid domain: ONE range, decided in Swift
 * (`ParamValidation.pidLower` / `pidUpper`, handed to `optInt(range:)` by
 * `Dispatcher.attach:86`) and written three times in this shell —
 * `src/tools.ts`'s `PID_INT32_MAX`, `src/project-registry.ts`'s `PID_RANGE`, and
 * the bounds `tools/list` advertises — plus a fourth the task did not name
 * (`inspectStoredEntry`'s decode check). `project-registry.ts:44-46` *claims* in
 * a comment that it mirrors the Swift declarations; until this section nothing
 * compared them, which is the recurring shape: a note saying "these two agree",
 * with no run path that could ever notice they don't.
 * ------------------------------------------------------------------ */

const PARAM_VALIDATION_FILE = "../../engine/Sources/GlassPaneEngine/ParamValidation.swift";
const PNG_ENCODER_FILE = "../../engine/Sources/GlassPaneEngine/PngEncoder.swift";
const FRAME_CODEC_FILE = "../../engine/Sources/GlassPaneEngine/FrameCodec.swift";
const ENGINE_CORE_FILE = "../../engine/Sources/GlassPaneEngine/EngineCore.swift";
const TOOLS_FILE = "../src/tools.ts";
const REGISTRY_FILE = "../src/project-registry.ts";

/** Every source file in this shell, for the "who carries a copy of N" gates. */
const SHELL_SOURCE_FILES = [
  ...readdirSync(new URL("../src/", import.meta.url)).map((entry) => `../src/${entry}`),
  ...readdirSync(new URL(".", import.meta.url))
    .filter((entry) => entry.endsWith(".mjs"))
    .map((entry) => `./${entry}`),
];

const READERS = new Map();

/**
 * One reader per file, so every gate in this file evaluates the same reading of
 * it — and so a constant referenced from three places is parsed once.
 */
function sourceReader(file) {
  if (!READERS.has(file)) READERS.set(file, sourceIntegers(file));
  return READERS.get(file);
}

/**
 * The daemon's authoritative pid range, *evaluated* out of the Swift that decides
 * it, together with the fixed-width type its own doc comment claims the ceiling is
 * the top of.
 *
 * Why evaluation and never text: `pidUpper` is not written as a number there, it is
 * written as `Int(Int32.max)`, while both mirrors in the shell write the same fact
 * as digits. A text gate across those is either permanently red (the spellings
 * differ by design) or loosened into a substring test that a wrong ceiling still
 * passes. So {@link constExprValue} resolves the *name* — `Int32.max` → 2^31−1 — and
 * the gate then checks three independent things that can each be wrong on their
 * own: the width the comment claims, the value the declaration evaluates to, and
 * every mirror in this shell.
 */
function daemonPidDomain() {
  const swift = sourceReader(PARAM_VALIDATION_FILE);
  const lower = swift.integer("pidLower");
  const upper = swift.integer("pidUpper");
  // `/// attach.pid is narrowed to `pid_t` (Int32) by the dispatcher` — read from
  // the prose, because that is where the *reason* for the number lives.
  const claimed = /narrowed to `pid_t` \((Int\d+)\)/.exec(swift.text);
  assert.ok(
    claimed,
    `${PARAM_VALIDATION_FILE} no longer states which fixed-width type \`pid_t\` is, so \`pidUpper\` is a number ` +
    `with a reason stored somewhere else: re-point this at the new claim and say where the width comes from now`,
  );
  const width = claimed[1];
  assert.equal(
    upper,
    integerTypeBound(`${width}.max`),
    `\`pidUpper\` evaluates to ${upper}, but the comment above it claims the domain is \`${width}\` ` +
    `(whose top is ${integerTypeBound(`${width}.max`)}). Value and reason disagree inside one declaration, and ` +
    `every mirror below would then faithfully copy whichever one it happened to read`,
  );
  assert.ok(
    lower >= 1,
    `\`pidLower\` is ${lower}: pid 0 is the process-group sentinel and a negative pid is no process, so the ` +
    `daemon's floor moved under this shell. Re-point the sides named in PID_BOUND_CRITERIA at the new floor on ` +
    `purpose — do not let this gate go quiet by spreading ${lower} around`,
  );
  assert.ok(lower <= upper, `\`pidLower\` ${lower} sits above \`pidUpper\` ${upper}: the range admits nothing`);
  return { lower, upper, width };
}

/**
 * Every judgement in this shell that decides whether a pid is admissible, and the
 * two operands it decides with (floor, ceiling).
 *
 * Same discipline as `FRAME_CAP_CRITERIA` above: an operand has to resolve to a
 * *declaration*, because the digits are the same either way and a value-only
 * comparison stays green the day a validator stops using the constant and starts
 * carrying its own copy — which is precisely when the copy goes stale and nothing
 * is left that could notice.
 *
 * The floors are compared by value only, and that asymmetry is on purpose rather
 * than oversight: three of them (`tools.ts`'s `.min(1)` and the two advertised
 * `minimum: 1`) are spelled as digits today because that file declares no floor
 * constant to reference, so collapsing them is a `src/` change this test lane must
 * not make. The ceiling does have a constant in both files, so "reference it" is
 * enforceable there and enforced.
 */
const PID_BOUND_CRITERIA = [
  {
    role: "this shell's inbound pid validator (`tools.ts` OptionalPidSchema)",
    file: TOOLS_FILE,
    site: /const OptionalPidSchema = z\.number\(\)\.int\(\)\.min\(\s*([^)]*?)\s*\)\.max\(\s*([^)]*?)\s*\)/,
  },
  {
    role: "the pid `tools/list` advertises for gp_attach",
    file: TOOLS_FILE,
    site: /pid: \{ type: "integer", minimum: ([^,]*?), maximum: ([^,]*?) \}/,
  },
  {
    role: "the pid `tools/list` advertises for gp_project_set",
    file: TOOLS_FILE,
    site: /pid: \{ type: \["integer", "null"\], minimum: ([^,]*?), maximum: ([^,]*?) \}/,
  },
  {
    role: "the registry's patch-shaped pid schema (`ProjectSetArgs`)",
    file: REGISTRY_FILE,
    site: /pid: z\.number\(\)\.int\(\)\.min\(\s*([^)]*?)\s*\)\.max\(\s*([^)]*?)\s*\)/,
  },
  {
    role: "the registry's second line of defense (`assertStorablePid`)",
    file: REGISTRY_FILE,
    site: /!Number\.isInteger\(pid\) \|\| pid < ([^|\s]+) \|\| pid > ([^\s)]+)/,
  },
  {
    role: "the range `assertStorablePid`'s remedy text quotes",
    file: REGISTRY_FILE,
    site: /pid must be an integer in \$\{([^}]+)\}\.\.\$\{([^}]+)\}/,
  },
];

/** One operand of a pid judgement: what it says, what it means, whether it is a copy. */
function pidBoundOperand(file, operand) {
  const text = operand.trim();
  const listed = /^([A-Za-z_$][\w$]*)\[(\d)\]$/.exec(text);
  const value = listed
    ? sourceReader(file).tuple(listed[1])[Number(listed[2])]
    : /^[A-Za-z_$][\w$]*$/.test(text)
      ? sourceReader(file).integer(text)
      : Number(text.replace(/_/g, ""));
  assert.ok(
    Number.isSafeInteger(value),
    `${file}: the pid bound \`${text}\` does not resolve to an integer this shell can compare`,
  );
  return { text, value, copiesDigits: /^\d/.test(text) };
}

function pidBoundSides() {
  return PID_BOUND_CRITERIA.map((criterion) => {
    const site = criterion.site.exec(sourceReader(criterion.file).code);
    assert.ok(
      site,
      `${criterion.role} no longer spells its bounds where this gate can read them, so nothing here says which ` +
      `floor and ceiling decide whether a pid is admissible. Either the guard was rewritten or it moved: re-point ` +
      `this criterion at it and say which operand is which, rather than leaving the two sides to match by hope`,
    );
    return {
      ...criterion,
      floor: pidBoundOperand(criterion.file, site[1]),
      ceiling: pidBoundOperand(criterion.file, site[2]),
    };
  });
}

/** Files in this shell that spell `value` out as digits, with how many times. */
function digitCopiesOf(value, files = SHELL_SOURCE_FILES) {
  const found = [];
  for (const file of files) {
    // Code, not prose (`executableSource`, the one definition this repo's source
    // scans share): the file explaining *why* a number must not be copied has to
    // be allowed to spell the number out. A gate that fires on that sentence gets
    // the sentence deleted — which is how a copy ban ends up guarding nothing.
    const text = executableSource(readFileSync(new URL(file, import.meta.url), "utf8"));
    const hits = [...text.matchAll(/\b\d[\d_]*\b/g)].filter(
      (one) => Number(one[0].replace(/_/g, "")) === value,
    );
    if (hits.length > 0) found.push({ file, count: hits.length });
  }
  return found;
}

/**
 * Hand-copied ceilings this shell is allowed to hold, per file.
 *
 * A ratchet, not an approval. The copies it names are all held to the daemon's
 * evaluated value by the test above, so none of them can go stale in silence; what
 * a value comparison cannot see is a *new* copy arriving, and that is what this
 * count refuses. It is also the gate that goes red when the `src/` lane collapses
 * them into one export — the fix the task says this lane must not make — at which
 * point the allowance shrinks in the same commit.
 */
const KNOWN_CEILING_COPIES = {
  [TOOLS_FILE]: 1,
  [REGISTRY_FILE]: 2,
};

test("the daemon's pid domain is one range, and each TS side reaches it through a constant", () => {
  const { lower, upper, width } = daemonPidDomain();
  const drift = [];
  for (const side of pidBoundSides()) {
    if (side.floor.value !== lower) {
      drift.push(`${side.role}: floor \`${side.floor.text}\` = ${side.floor.value}, the daemon admits from ${lower}`);
    }
    if (side.ceiling.value !== upper) {
      drift.push(`${side.role}: ceiling \`${side.ceiling.text}\` = ${side.ceiling.value}, the daemon's ${width} ceiling is ${upper}`);
    }
    if (side.ceiling.copiesDigits) {
      drift.push(`${side.role}: ceiling spelled out as the digits \`${side.ceiling.text}\` instead of referencing the constant ${side.file} declares — from that day the copy and the constant are two answers to one question, and only an edit to both keeps them agreeing`);
    }
  }
  assert.deepEqual(drift, [], `the pid domain is not one range any more:\n  ${drift.join("\n  ")}`);

  // The comment that made the promise, checked as a claim rather than read as
  // reassurance: it has to name the two declarations whose values were just
  // compared, or it points at a rule that no longer exists — which is how a
  // "mirrors X" note stays plausible for years after X is deleted.
  const registry = sourceReader(REGISTRY_FILE);
  assert.match(registry.code, /\bconst PID_RANGE\b/, "project-registry.ts no longer declares PID_RANGE, so the mirror this section is about has moved");
  const above = registry.text.slice(0, registry.text.search(/\bconst PID_RANGE\b/)).trimEnd();
  const note = /\/\*\*(?:(?!\*\/)[\s\S])*\*\/\s*$/.exec(above);
  assert.ok(
    note,
    "the declaration note above `PID_RANGE` is gone, so nothing states any more which daemon rule the range mirrors",
  );
  assert.match(note[0], /ParamValidation/, "the note no longer names the daemon module it mirrors");
  for (const named of ["pidLower", "pidUpper"]) {
    assert.ok(
      note[0].includes(named),
      `the note above \`PID_RANGE\` (${JSON.stringify(note[0].slice(0, 80))}…) no longer names ` +
      `\`ParamValidation.${named}\`, so it no longer says which of the daemon's two bounds it mirrors`,
    );
    assert.ok(
      Number.isSafeInteger(sourceReader(PARAM_VALIDATION_FILE).integer(named)),
      `\`ParamValidation.${named}\`, named by that note, has no readable value: the promise points at a rule this gate cannot read`,
    );
  }
});

test("the registry's stored-pid check is the decode domain it names, not the accept domain", () => {
  const { width } = daemonPidDomain();
  const registry = sourceReader(REGISTRY_FILE);
  // A *stored* pid is a different question from an acceptable one: `Int32?` decodes
  // -500 fine, so `inspectStoredEntry` must not refuse to read a registry over it
  // (that would blank every registration for one hand-edited field), while
  // `assertStorablePid` above must never let -500 in. Two ranges, both derived from
  // one width — and only the width is shared truth, which is what this compares.
  const site = /pid < (-?[0-9_]+) \|\| pid > ([0-9_]+)\) \{\s*\n[^\n]*return[^\n]*outside the range the daemon can decode/
    .exec(registry.code);
  assert.ok(
    site,
    "project-registry.ts no longer checks a stored pid against hand-written bounds next to a message about the " +
    "decode range, so this gate cannot tell whether the read path still accepts what the write path refuses",
  );
  const [low, high] = [site[1], site[2]].map((digits) => Number(digits.replace(/_/g, "")));
  assert.equal(
    high,
    integerTypeBound(`${width}.max`),
    `the stored ceiling is ${high}, not \`${width}.max\` (${integerTypeBound(`${width}.max`)}). If the read path is ` +
    `now meant to tolerate something wider than the daemon can decode, that is a claim about Swift's \`Int32?\` ` +
    `decoder and this gate needs the new numbers plus the reason — a ceiling above the decode domain means one ` +
    `hand-edited entry makes the whole registry unreadable, which is the bug \`PID_RANGE\`'s note warns about`,
  );
  assert.equal(
    low,
    integerTypeBound(`${width}.min`),
    `the stored floor ${low} is not \`${width}.min\` — the accept floor is ${daemonPidDomain().lower}, and the two differ on purpose`,
  );
  const claimed = /outside the range the daemon can decode \((Int\d+)\)/.exec(registry.text);
  assert.ok(claimed, "the refusal no longer names the integer type it is measuring, so the numbers have no claim to check");
  assert.equal(
    claimed[1],
    width,
    `the registry refuses what is outside \`${claimed[1]}\` while the daemon's pid ceiling is \`${width}.max\`: one protocol fact, spelled twice, now disagreeing`,
  );
});

test("no file other than the ones named carries the daemon's ceiling as digits", () => {
  const { upper, width } = daemonPidDomain();
  const found = digitCopiesOf(upper);
  const unallowed = found.filter((one) => one.count > (KNOWN_CEILING_COPIES[one.file] ?? 0));
  assert.deepEqual(
    unallowed,
    [],
    `the ${width} ceiling is now hand-copied ${JSON.stringify(unallowed.map((one) => `${one.file} ×${one.count}`))} ` +
    `beyond the allowance (${JSON.stringify(KNOWN_CEILING_COPIES)}). Every copy is a place that goes stale alone: ` +
    `reference the constant the file already declares, or collapse them into one export — the collapse is the ` +
    `src/-side fix this test lane deliberately does not make`,
  );
  const tightening = Object.entries(KNOWN_CEILING_COPIES)
    .filter(([file, allowed]) => allowed > (found.find((one) => one.file === file)?.count ?? 0))
    .map(([file, allowed]) => `${file} carries ${allowed - (found.find((one) => one.file === file)?.count ?? 0)} fewer than the ${allowed} allowed`);
  assert.deepEqual(
    tightening,
    [],
    `a copy was removed — good — but the allowance still permits it to come back: ${tightening.join("; ")}. ` +
    `Tighten KNOWN_CEILING_COPIES in the same commit that collapses the source`,
  );
});

test("the loaded registry validator admits the daemon's whole domain and nothing past it", () => {
  const { lower, upper } = daemonPidDomain();
  // `ProjectSetArgs` alone: a pure zod parse, so nothing here reaches for
  // `~/.glasspane` or the sandbox helper.
  for (const [pid, storable] of [
    [lower, true],
    [upper, true],
    [lower - 1, false],
    [upper + 1, false],
    [null, true],
  ]) {
    const parsed = ProjectSetArgs.safeParse({ displayName: "x", pid });
    assert.equal(
      parsed.success,
      storable,
      `pid ${JSON.stringify(pid)} against the daemon range ${lower}..${upper}: ${JSON.stringify(parsed.error?.issues ?? parsed.data)}`,
    );
  }
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

test("reading the daemon's bounds is arithmetic, and the shapes it cannot read stay refused", () => {
  const { upper, width } = daemonPidDomain();
  const swift = sourceReader(PARAM_VALIDATION_FILE);
  // The name *is* the fact here: `Int(Int32.max)` and the digits this shell mirrors
  // it with are one value in two spellings, and no text comparison across them can
  // be both strict and quiet — so the gate evaluates. Proof, on the expression the
  // declaration is made of and on ones it is not:
  assert.equal(swift.evaluate(`Int(${width}.max)`, "synthetic ceiling"), upper);
  assert.equal(swift.evaluate(`Int(${width}.max) - 1`, "one below the ceiling"), upper - 1);
  // The signed range is asymmetric — `-Int32.min` is one *past* `Int32.max` — which
  // is why the daemon spells its ceiling from `.max` and could not have derived it
  // from the floor. If this ever reads as `upper`, the mirrors that copy one bound
  // out of the other are off by one and nobody has said so.
  assert.equal(swift.evaluate(`-${width}.min`, "the signed floor, negated"), upper + 1);
  assert.equal(swift.evaluate("2 * 1024 * 1024", "a product"), 2 ** 21);
  assert.equal(swift.evaluate("1024 * 1024 * 4", "the same product, reordered"), 2 ** 22);
  // …and refuse, rather than return something plausible, for every shape a limit
  // could be written with that this does not read. These are the samples that make
  // the gate's "I evaluated it" mean something: a pass on the one expression the
  // daemon happens to use today proves nothing about the evaluator's reach.
  for (const [expression, why] of [
    ["1 << 21", "a shift"],
    ["2 ** 21", "an exponent"],
    ["Int(Int32.max) + unpublishedLimit", "a name with no declaration behind it"],
    ["Int(Int64.max)", "a bound no consumer here can hold exactly"],
    ["UInt8(Int16.max)", "a conversion that would trap at run time in Swift"],
    ["max(1, 2)", "a call this gate has no rule for"],
  ]) {
    let refused = false;
    try {
      swift.evaluate(expression, `synthetic \`${expression}\``);
    } catch {
      refused = true;
    }
    assert.ok(
      refused,
      `${why}: \`${expression}\` was read as a number. A gate that guesses at shapes it has no rule for reports ` +
      `agreement where there is none, which is the failure this whole file is written against`,
    );
  }
});

/* ------------------------------------------------------------------ *
 * R8b: the PNG budget and the frame cap are two numbers with one
 * inequality between them, and until now nothing wrote that inequality
 * down. `PngEncoding.defaultMaxBytes` exists *because*
 * `FrameCodec.maxFrameBytes` is 4 MiB and base64 inflates a body by 4/3
 * (`PngEncoder.swift`'s own comment). Raise the budget past the widest body
 * that survives the inflation and every `capture_view` reply is dropped by the
 * framing layer as oversize — while the three-way cap gate above stays green,
 * because both of *its* numbers are still 4 MiB. That is the shape this guard
 * exists for.
 *
 * Three things make the inequality mean something rather than being two
 * numbers admiring each other, and each is a separate test below: the budget has
 * to be the quantity the encoder actually refuses on ({@link pngBudgetGuardChain},
 * the same "read the guard, not the number" discipline as `FRAME_CAP_CRITERIA`),
 * the 4/3 has to come from the place that chose the budget rather than from this
 * file ({@link base64Inflation}), and the inflation itself has to be *measured*
 * rather than believed, because the comment is prose.
 * ------------------------------------------------------------------ */

/**
 * The base64 inflation factor, read from the one place in this repo that states it.
 *
 * `PngEncoder.swift` never multiplies by 4/3: the encoder checks the *PNG* length
 * against the budget and hands the base64 on, and the cap is applied to the
 * serialised frame in `Dispatcher.swift` (already gated by `FRAME_CAP_CRITERIA`).
 * So the ratio's only declaration site is the prose above `defaultMaxBytes` that
 * says why the budget is not the cap — which makes this the one place in this file
 * where matching *inside* a comment is the point and `executableSource` is
 * deliberately not applied. The gate goes red when that prose moves or stops
 * naming a ratio, instead of keeping a private copy of 4 and 3 that would outlive
 * the reasoning. What the ratio is worth is then measured, not trusted.
 */
function base64Inflation() {
  const stated = [...sourceReader(PNG_ENCODER_FILE).text.matchAll(/放大\s*([0-9])\s*\/\s*([0-9])/g)];
  assert.equal(
    stated.length,
    1,
    `the base64 inflation this inequality is built on is stated ${stated.length} times in PngEncoder.swift. ` +
    `It has exactly one declaration site (the comment above \`defaultMaxBytes\`): if that prose was reworded or ` +
    `moved, re-point this at wherever the ratio lives now and say why — a 4/3 typed in here is a number this gate ` +
    `would keep honouring after the daemon stopped meaning it`,
  );
  const [numerator, denominator] = [Number(stated[0][1]), Number(stated[0][2])];
  assert.ok(
    Number.isInteger(numerator) && Number.isInteger(denominator) && denominator > 0 && numerator > denominator,
    `PngEncoder.swift states base64 inflation as ${numerator}/${denominator}, which is not a shrink-free ratio — ` +
    `an encoder that got smaller would let this gate bless budgets the framing layer then drops`,
  );
  return { numerator, denominator };
}

/**
 * Which quantity `defaultMaxBytes` actually decides, as a chain read out of the
 * encoder: the guard compares `X <= P`, `P` is `encode`'s own parameter, that
 * parameter defaults from the declared budget, and `X` is the encoder's output
 * length (`sink.length`) — i.e. the bytes *before* base64, which is what makes the
 * 4/3 an inequality on the budget instead of a decoration. Break any link and the
 * test below compares a number nobody applies with a cap nobody reads.
 */
function pngBudgetGuardChain() {
  const encoder = sourceReader(PNG_ENCODER_FILE);
  const defaulted = /maxBytes:\s*Int\s*=\s*([A-Za-z_][A-Za-z0-9_.]*)/.exec(encoder.code);
  assert.ok(
    defaulted,
    "PngEncoder.encode no longer takes its limit as a parameter defaulted from a named constant, so nothing here " +
    "can say that the budget in the inequality is the budget the encoder applies",
  );
  assert.equal(
    defaulted[1],
    "defaultMaxBytes",
    `\`encode(maxBytes:)\` defaults to \`${defaulted[1]}\`, not the budget this gate does arithmetic on — a second ` +
    `budget took over the call path, or the one being compared stopped being used`,
  );
  const guard = /guard\s+([A-Za-z_]\w*)\s*<=\s*([A-Za-z_]\w*)\s+else/.exec(encoder.code);
  assert.ok(
    guard,
    "the encoder no longer refuses with a `length <= limit` guard, so the budget decides nothing where this gate " +
    "reads it: it is checked against a cap it never touches",
  );
  assert.equal(
    guard[2],
    "maxBytes",
    `the encoder's guard compares against \`${guard[2]}\` rather than the parameter defaulted from the budget`,
  );
  const measured = /let\s+([A-Za-z_]\w*)\s*=\s*sink\.length/.exec(encoder.code);
  assert.ok(
    measured,
    "the length the encoder has is no longer its own output (`sink.length`), so this gate cannot say what the " +
    "budget is a budget *of* — pre- or post-base64 is exactly the distinction the 4/3 rides on",
  );
  assert.equal(
    guard[1],
    measured[1],
    `the guard compares \`${guard[1]}\` while the encoder's output length is named \`${measured[1]}\``,
  );
  const wrapped = /base64EncodedString\(\s*options:\s*(\[[^\]]*\])/.exec(encoder.code);
  assert.ok(wrapped, "the encoder no longer states how it writes base64, so the measured inflation below has no source");
  assert.equal(
    wrapped[1],
    "[]",
    `the base64 is written with options \`${wrapped[1]}\`: line breaks add bytes on top of the 4/3 measured below, ` +
    `and every one of them counts against the frame cap`,
  );
  const carried = sourceReader(ENGINE_CORE_FILE).code.match(/"pngBase64":\s*([A-Za-z_.]+)/);
  assert.ok(
    carried,
    "capture_view's reply no longer carries the encoder's base64 under `pngBase64`, so the frame bounded by this " +
    "inequality is not the frame the daemon sends",
  );
  return { guard: guard[0], carried: carried[1] };
}

test("the PNG budget still fits the frame cap after base64 inflation", () => {
  const budget = frameCapBytes(PNG_ENCODER_FILE, "defaultMaxBytes");
  const frame = frameCapBytes(FRAME_CODEC_FILE, "maxFrameBytes");
  const inflation = base64Inflation();
  // Integer arithmetic, no floating point: `budget × numerator <= frame × denominator`
  // is the same statement as "budget inflated by the documented ratio fits", with the
  // ratio read from the comment that chose the budget and without rounding a
  // threshold into a silent off-by-one.
  assert.ok(
    budget * inflation.numerator <= frame * inflation.denominator,
    `a PNG at the budget ${budget} inflates to ${inflation.numerator}/${inflation.denominator} of it, ` +
    `which is past the frame cap ${frame}: 每一帧 capture_view 都会被 framing 层丢掉，而两条 cap 自己仍然相等`,
  );
  // The inequality has to be a boundary and not a slogan: the widest budget that
  // still fits, plus one byte, must fail it. Otherwise this test would be a
  // comparison that cannot lose, which is what the comment above `defaultMaxBytes`
  // already was.
  const widest = Math.floor((frame * inflation.denominator) / inflation.numerator);
  // DECORATION: this assert is an arithmetic identity — `widest` is *defined*
  // as floor(frame×den/num), so `(widest+1)×num > frame×den` holds for every
  // input and can never redden. The weight in this test is carried by its
  // sibling above (`budget × num <= frame × den` over the two numbers measured
  // from the Swift sources) and by the `budget < widest` headroom check below;
  // kept because deleting a passing check is its own kind of loss, but nobody
  // should read it as coverage.
  assert.ok(
    (widest + 1) * inflation.numerator > frame * inflation.denominator,
    `${widest} + 1 still satisfies the inequality, so it admits bodies the frame cap rejects`,
  );
  // And the comment promises the JSON envelope gets headroom too, so the budget may
  // not sit *on* the boundary: `{"result":{"pngBase64":…}}` and the newline
  // `Dispatcher.response` appends before comparing both come out of the same cap.
  // Say how much is left, so a future raise is a decision with a number attached
  // rather than a guess.
  assert.ok(
    budget < widest,
    `预算 ${budget} 已经贴到 ${widest} 的边界：base64 之后的帧没有留给 JSON 信封的空间了`,
  );
  // And the TS side must not be carrying its own copy of the budget number, in
  // either spelling (`2400000` / `2_400_000` — the previous version of this check
  // looked for the undecorated one only, so the digits in the shell's own style
  // would have slipped past it).
  assert.deepEqual(
    digitCopiesOf(budget),
    [],
    `TS 侧把 PNG 预算抄成了字面量，Swift 一改这里就悄悄过期：${JSON.stringify(digitCopiesOf(budget))}`,
  );
});

test("the budget the inequality bounds is the budget the encoder applies", () => {
  pngBudgetGuardChain();
});

test("the frame a capture_view reply becomes is measured, not estimated", () => {
  const budget = frameCapBytes(PNG_ENCODER_FILE, "defaultMaxBytes");
  const frame = frameCapBytes(FRAME_CODEC_FILE, "maxFrameBytes");
  const inflation = base64Inflation();
  pngBudgetGuardChain();
  // The ratio in the comment is prose; this is the same claim made of bytes. The
  // chain above proved the capped quantity is the *pre*-base64 length, so the only
  // thing left to measure is what one of those bodies becomes on the wire — and
  // base64's alphabet is ASCII, so its length is its byte count.
  const body = Buffer.alloc(budget).toString("base64");
  const onTheWire = Buffer.byteLength(body, "ascii");
  // DECORATION: `byteLength(base64(n bytes)) === 4·ceil(n/3)` is a property of
  // base64 itself, true for every input length and for every budget/frame cap
  // — it cannot redden under any source change. The weight here is carried by
  // the sibling asserts below: the measured `onTheWire` compared against the
  // inflation ratio the encoder's comment *states* (red when prose and bytes
  // disagree), and `onTheWire + 1 <= frame` against the measured frame cap.
  assert.equal(
    onTheWire,
    4 * Math.ceil(budget / 3),
    `a ${budget}-byte PNG became ${onTheWire} bytes of base64, which is not the 4-per-3 the encoder's comment states`,
  );
  assert.ok(
    budget * inflation.numerator <= onTheWire * inflation.denominator
      && onTheWire * inflation.denominator <= budget * inflation.numerator + 2 * inflation.denominator,
    `the stated inflation (${inflation.numerator}/${inflation.denominator}) and the measured one `
    + `(${onTheWire}/${budget}) disagree by more than base64's rounded-up tail — the inequality above was checked `
    + "against a ratio the bytes do not have, which is the direction that lets an oversized budget pass",
  );
  // `Dispatcher.response` compares `data.count + 1`, the +1 being the newline that
  // terminates the frame; the envelope around the base64 is what the strict `<`
  // in the test above leaves room for, and this is the number that says how much.
  assert.ok(
    onTheWire + 1 <= frame,
    `the base64 alone (${onTheWire}) plus its terminating newline is already past the frame cap ${frame}`,
  );
  assert.ok(
    frame - onTheWire - 1 > 0,
    `no room left for the JSON envelope of a capture_view reply (cap ${frame}, body ${onTheWire})`,
  );
});

/**
 * Byte-count claims a tool advertisement could make, in the units this repo's
 * prose uses. "MB" is ambiguous *here* — `PngEncoder.swift`'s own comment calls
 * 4 194 304 "4 MB" — so a claim with a unit is read both ways and has to match the
 * daemon's number under one of them; a bare integer has only the one reading.
 */
function advertisedByteClaims(text) {
  const claims = [];
  for (const stated of text.matchAll(/\b\d[\d_]{5,}\b/g)) {
    claims.push({ stated: stated[0], readings: [Number(stated[0].replace(/_/g, ""))] });
  }
  const UNIT = { K: [1000, 1024], M: [1000 ** 2, 1024 ** 2], G: [1000 ** 3, 1024 ** 3] };
  for (const stated of text.matchAll(/([0-9]+(?:\.[0-9]+)?)\s*([KMG])(i?)B\b/g)) {
    const [decimal, binary] = UNIT[stated[2]];
    const magnitude = Number(stated[1]);
    claims.push({
      stated: stated[0],
      readings: stated[3] === "i" ? [Math.round(magnitude * binary)] : [Math.round(magnitude * decimal), Math.round(magnitude * binary)],
    });
  }
  return claims;
}

/** The claims above that do *not* state the daemon's number. */
function offBudgetClaims(claims, budget) {
  return claims.filter((claim) => !claim.readings.includes(budget)).map((claim) => claim.stated);
}

test("gp_capture_view advertises no second copy of the PNG budget", () => {
  const budget = frameCapBytes(PNG_ENCODER_FILE, "defaultMaxBytes");
  const spec = TOOL_BY_NAME.get("gp_capture_view");
  const claims = advertisedByteClaims(`${spec.description} ${JSON.stringify(spec.inputSchema)}`);
  // This shell does not carry the byte budget today: the advertisement says
  // "oversized windows are refused with a suggested scale" and names no number,
  // and the only restatement in the repo is prose in CHANGELOG.md. That is a fact
  // about the current advertisement, not a rule — so the comparison below is what
  // makes it safe: if an advertisement starts quoting a budget, it has to quote
  // *this* one.
  assert.deepEqual(
    offBudgetClaims(claims, budget),
    [],
    `gp_capture_view now advertises a byte budget that the daemon does not use: ${JSON.stringify(offBudgetClaims(claims, budget))} (daemon: ${budget})`,
  );
  assert.deepEqual(
    claims,
    [],
    `gp_capture_view advertises ${JSON.stringify(claims.map((claim) => claim.stated))}; the assertion above ` +
    `already holds each of them against the daemon's budget, so update this one to say how many restatements the ` +
    `advertisement carries rather than letting the count go unchecked`,
  );
  // The empty list is the only shape the real advertisement can produce today, so
  // both directions of the comparator are proven on synthetic text: an assertion
  // that can only ever see its happy path is the "a comment says they agree" shape
  // again, wearing a test's clothes.
  assert.deepEqual(advertisedByteClaims(`up to ${budget} bytes per PNG`).map((claim) => claim.readings), [[budget]]);
  assert.deepEqual(offBudgetClaims(advertisedByteClaims(`up to ${budget} bytes per PNG`), budget), []);
  assert.deepEqual(
    offBudgetClaims(advertisedByteClaims(`up to ${budget + 1} bytes per PNG, or 2.5 MB of them`), budget)
      .sort(),
    [`${budget + 1}`, "2.5 MB"].sort(),
  );
});