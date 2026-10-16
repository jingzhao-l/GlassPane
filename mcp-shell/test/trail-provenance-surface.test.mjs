/**
 * R10-中2, the reporting half: `gp_recent_reports` must say which of the ids it
 * lists the trail only *guessed* an owner for.
 *
 * `audit-session.ts` already files every trail entry with the mechanism that wrote
 * it (`provenanceOf`, `TRAIL_PROVENANCE_NOTES`) and its own comment promises that
 * "`gp_recent_reports` has to say so from here rather than from the log line"
 * (`audit-session.ts:56-59`). Before this file's fix nothing in `src/` read that
 * mechanism at all — grep for `provenanceOf` returned the definition and one
 * comment in `engine-client.ts` — so an id attributed only by arrival order (a
 * daemon frame that echoed no request id) was fetched, rendered and listed exactly
 * like an id the daemon confirmed by echoing the id, and an agent stopped
 * re-checking it.
 *
 * What is asserted here is the *pairing*: the existing note text, beside the id it
 * describes, in every arm that lists ids — and the controls that stop a
 * blanket-annotating renderer from passing: the in-order id in the same report gets
 * no caveat, and a frame that echoed its id gets the `late` caveat rather than the
 * `late-inferred` one.
 *
 * The trail entries are produced through the production wiring — a real
 * `EngineJsonRpcClient` over `FakeLineIo`, `createTrackedMcpServer`'s late-reply
 * sink, and daemon frames with the bytes the daemon actually sends — because a
 * fixture that set the provenance by hand would test the renderer's bookkeeping
 * instead of the mechanism it is meant to report.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { TOOL_BY_NAME, executeTool } from "../dist/tools.js";
import { ARRIVAL_ORDER_MECHANISM, EvidenceAuditSession, TRAIL_PROVENANCE_NOTES } from "../dist/audit-session.js";
import { createTrackedMcpServer } from "../dist/dispatch.js";
import { EngineJsonRpcClient } from "../dist/engine-client.js";
import { FakeLineIo } from "./helpers.mjs";

/** `^op_[0-9A-HJKMNP-TV-Z]{26}$`, the grammar this shell sends. */
const OP_IN_ORDER = "op_0123456789ABCDEFGHJKMNPQRS";
const OP_LATE_CONFIRMED = "op_123456789ABCDEFGHJKMNPQRST";
const OP_LATE_GUESSED = "op_23456789ABCDEFGHJKMNPQRSTV";

/**
 * A `last_evidence` reply body as the daemon frames it: a whole
 * `glasspane.evidence/0.1` pack, the shape `parseEvidenceFrame` validates against
 * the kernel schema. Same bytes `test/tools.test.mjs` uses for this tool.
 */
function evidenceFrame(operationId) {
  return {
    evidencePack: {
      schemaVersion: "glasspane.evidence/0.1",
      operationId,
      createdAt: "2026-10-15T00:00:00.000Z",
      attribution: { level: "soft", contaminated: false },
      circuitBreaker: { level: 0 },
      signals: {
        act: { selector: { role: "AXButton", title: "Submit" }, action: "press", actConfirmed: true },
        axEvent: {
          axChanged: false, latencyMs: 9, nodeCount: 42,
          treeDigestBefore: "a".repeat(32), treeDigestAfter: "b".repeat(32),
        },
        handlerProbe: null,
        stateDiff: null,
      },
      assertion: null,
      diagnosis: {
        class: "T3",
        report: {
          path: "submit flow: press Submit -> title unchanged",
          anomaly: "expected retitle after press; title stayed 'Submit'",
          evidence: "assert title expected=Submitted actual=Submit",
          next: "check the button's action wiring",
        },
      },
    },
  };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

const ACT_ARGS = (title) => ({ selector: { role: "AXButton", title }, action: "press" });

/**
 * One session with all three arrival mechanisms really exercised, in trail order:
 *
 * 1. `OP_IN_ORDER` — an `act` answered before its deadline, by the frame that
 *    echoed its request id.
 * 2. `OP_LATE_CONFIRMED` — an `act` whose caller was answered by its deadline, then
 *    a late reply that *did* echo the id (`FrameAttribution "echoed-id"`).
 * 3. `OP_LATE_GUESSED` — the same, from a frame that echoed **no** id
 *    (`"arrival-order"`): which request it answers is inferred from the daemon's
 *    in-order scheduling and nothing on the wire confirms it.
 *
 * The deadline is driven with `t.mock.timers` so the transition from "in time" to
 * "late" is a tick rather than a wall-clock slice a loaded machine can move.
 */
async function trailWithAllThreeArrivals(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const io = new FakeLineIo();
  // `timeoutMs` is the caller's own bound (`engine-client.ts:826-827`) and is never
  // re-capped, so 20ms is the deadline every arm below is driven against.
  const client = new EngineJsonRpcClient(io, 20);
  const { session } = createTrackedMcpServer(client, () => undefined);
  const act = TOOL_BY_NAME.get("gp_act");

  // 1. In time, echoed id.
  const first = executeTool(act, ACT_ARGS("One"), client, session);
  await flush();
  io.respond({ operationId: OP_IN_ORDER, actConfirmed: true });
  assert.equal((await first).isError, false, "the in-time act is answered by its reply, not its deadline");
  assert.equal(session.provenanceOf(OP_IN_ORDER), "in-order", "fixture: in-order entry");

  // 2. Late, echoed id.
  const second = executeTool(act, ACT_ARGS("Two"), client, session);
  await flush();
  const secondFrame = JSON.parse(io.sent[io.sent.length - 1]);
  t.mock.timers.tick(20);
  assert.equal((await second).content[0].text.startsWith("GP_E_ENGINE_TIMEOUT"), true);
  io.send(JSON.stringify({ id: secondFrame.id, result: { operationId: OP_LATE_CONFIRMED, actConfirmed: true } }));
  await flush();
  assert.equal(session.provenanceOf(OP_LATE_CONFIRMED), "late", "fixture: echoed-id late entry");

  // 3. Late, no id on the frame at all.
  const third = executeTool(act, ACT_ARGS("Three"), client, session);
  await flush();
  t.mock.timers.tick(20);
  assert.equal((await third).content[0].text.startsWith("GP_E_ENGINE_TIMEOUT"), true);
  io.send(JSON.stringify({ id: null, result: { operationId: OP_LATE_GUESSED, actConfirmed: true } }));
  await flush();
  assert.equal(session.provenanceOf(OP_LATE_GUESSED), "late-inferred", "fixture: arrival-order late entry");

  assert.deepEqual(session.recentIds(20), [OP_IN_ORDER, OP_LATE_CONFIRMED, OP_LATE_GUESSED]);
  return { io, client, session };
}

/** Answer the `last_evidence` requests a report fans out, in the order they go out. */
async function answerReport(io, idsByOrder) {
  for (const id of idsByOrder) {
    await flush();
    const frame = JSON.parse(io.sent[io.sent.length - 1]);
    assert.equal(frame.method, "last_evidence", `the report must ask for ${id} on the wire`);
    io.respond(evidenceFrame(id));
  }
}

test("gp_recent_reports labels an arrival-order id with the trail's own note, beside that id", async (t) => {
  const { io, client, session } = await trailWithAllThreeArrivals(t);
  const promise = executeTool(TOOL_BY_NAME.get("gp_recent_reports"), { limit: 5 }, client, session);
  await answerReport(io, [OP_IN_ORDER, OP_LATE_CONFIRMED, OP_LATE_GUESSED]);

  const outcome = await promise;
  assert.equal(outcome.isError, false, outcome.content[0].text);
  const text = outcome.content[0].text;

  // Nothing was dropped: the guessed operation is still listed, because "no such
  // operation ran" is the more dangerous lie for an agent deciding whether to press
  // again (audit-session.ts:52-58).
  for (const id of [OP_IN_ORDER, OP_LATE_CONFIRMED, OP_LATE_GUESSED]) {
    assert.ok(text.includes(`# ${id} · T3 · normal`), `the report must still render ${id}: ${text.slice(0, 400)}`);
  }

  // The note is the existing literal, verbatim, and it is attached to the id it
  // describes rather than dumped somewhere in the report.
  assert.ok(
    text.includes(`${OP_LATE_GUESSED} is listed as unverified, not as confirmed: ${TRAIL_PROVENANCE_NOTES["late-inferred"]}`),
    `a guessed id must not read as verified. Got: ${text.slice(0, 600)}`,
  );
  assert.ok(
    text.includes(`${OP_LATE_CONFIRMED} is listed as unverified, not as confirmed: ${TRAIL_PROVENANCE_NOTES.late}`),
    "a late-but-confirmed id carries its own note, not the inferred one",
  );

  // CONTROL, and the half that a blanket annotation would fail: the one entry the
  // trail may call verified is printed with no caveat at all.
  assert.equal(text.includes(`${OP_IN_ORDER} is listed as unverified`), false,
    "an in-order id must not be caveated — that would tell the agent to distrust the id that *is* confirmed");
  assert.equal(text.split(TRAIL_PROVENANCE_NOTES["late-inferred"]).length - 1, 1,
    "the inferred note appears for the inferred id and for nothing else");
  assert.equal(text.split(TRAIL_PROVENANCE_NOTES.late).length - 1, 1,
    "the late note appears for the late id and for nothing else");

  client.close();
});

test("gp_recent_reports labels ids it lists in its notes, not only the packs it renders", async (t) => {
  // The other arm that names ids: an entry the daemon's bounded history no longer
  // holds is reported as *skipped*. A reader who only ever sees the skip list would
  // otherwise weigh a guessed id exactly like a confirmed one.
  const { io, client, session } = await trailWithAllThreeArrivals(t);
  const promise = executeTool(TOOL_BY_NAME.get("gp_recent_reports"), { limit: 5 }, client, session);
  await answerReport(io, [OP_IN_ORDER, OP_LATE_CONFIRMED]);
  await flush();
  const failedFrame = JSON.parse(io.sent[io.sent.length - 1]);
  assert.equal(failedFrame.params.operationId, OP_LATE_GUESSED, "the third request is the inferred one");
  io.respondError({
    code: "GP_E_NO_EVIDENCE",
    message: `no evidence recorded for ${OP_LATE_GUESSED}`,
    remedy: "read another operation with gp_last_evidence {operationId}",
  });

  const outcome = await promise;
  assert.equal(outcome.isError, false, outcome.content[0].text);
  const text = outcome.content[0].text;

  assert.ok(
    text.includes(`skipped 1 unreachable entry: ${OP_LATE_GUESSED} (${TRAIL_PROVENANCE_NOTES["late-inferred"]})`),
    `the skip list must carry the caveat beside the id. Got: ${text.slice(0, 600)}`,
  );
  // CONTROL: the confirmed ids in the same report are still comma-joined and bare.
  assert.ok(text.includes(`# ${OP_IN_ORDER} · T3 · normal`));
  assert.equal(text.includes(`${OP_IN_ORDER} (`), false, "an in-order id is printed as the id, nothing else");
  assert.equal(text.includes(`${OP_LATE_CONFIRMED} (`), false,
    "a pack that rendered is not double-listed; its caveat is its banner, not this arm");

  client.close();
});

test("gp_recent_reports labels an inferred id in the HTML report too", async (t) => {
  // The HTML half is its own surface: the banner goes in a `<p class=...>` and the
  // note goes through the same escaping path as everything else the report prints.
  const { io, client, session } = await trailWithAllThreeArrivals(t);
  const promise = executeTool(
    TOOL_BY_NAME.get("gp_recent_reports"),
    { limit: 5, format: "html" },
    client,
    session,
  );
  await answerReport(io, [OP_IN_ORDER, OP_LATE_CONFIRMED, OP_LATE_GUESSED]);

  const outcome = await promise;
  assert.equal(outcome.isError, false, outcome.content[0].text);
  const text = outcome.content[0].text;

  const banner = `<p class="gp-trail-unverified">${OP_LATE_GUESSED} is listed as unverified, not as confirmed: `
    + `${TRAIL_PROVENANCE_NOTES["late-inferred"]}</p>`;
  assert.ok(text.includes(banner), `HTML must carry the note. Got: ${text.slice(0, 600)}`);
  assert.equal(text.includes(`gp-trail-unverified">${OP_IN_ORDER}`), false,
    "no banner for the confirmed entry in either format");
  // The banner is the escaped form of the same literal, so the note reaching an HTML
  // report is the note the session wrote. Neither literal carries a metacharacter
  // today; if one ever does, the escaped arm has to keep it from restructuring the
  // report, so this pins the *absence* rather than assuming it.
  for (const note of Object.values(TRAIL_PROVENANCE_NOTES)) {
    assert.equal(/[<>&]/.test(note), false, `note literal carries markup, and the report escapes it: ${note}`);
  }

  client.close();
});

test("the provenance caveat does not invent an entry the trail does not hold", async () => {
  // A renderer that annotated every id would pass the tests above by accident, so
  // this one hands the tool a session holding a *single* in-order operation and
  // demands the report say nothing about provenance at all. It also answers nothing
  // the fake daemon has no frame for: one id in, one `last_evidence` reply out.
  const session = new EvidenceAuditSession();
  session.record({ operationId: OP_IN_ORDER });
  const localIo = new FakeLineIo();
  const client = new EngineJsonRpcClient(localIo, 5_000);
  const promise = executeTool(TOOL_BY_NAME.get("gp_recent_reports"), { limit: 5 }, client, session);
  await flush();
  localIo.respond(evidenceFrame(OP_IN_ORDER));
  const outcome = await promise;
  assert.equal(outcome.isError, false, outcome.content[0].text);
  const text = outcome.content[0].text;
  assert.ok(text.includes(`# ${OP_IN_ORDER} · T3 · normal`));
  assert.equal(text.includes("unverified"), false, "a verified entry prints no caveat");
  for (const note of Object.values(TRAIL_PROVENANCE_NOTES)) {
    assert.equal(text.includes(note), false, `no provenance note belongs in this report: ${note}`);
  }
  client.close();
});

test("the trail's provenance API is the one its surfaces read", () => {
  // The trail answers "how did this id get here" through `provenanceOf`, and that is what
  // `gp_recent_reports` and the log lines above read. `inferredIds()` used to sit beside it
  // with no reader in `src/` at all: a second accessor for the same map is a second source
  // of truth, and an unread function is not a surface — it is code nobody can turn red. The
  // question it answered is asked here through the API that has a reader (`inferredIn()`),
  // so this gate's red means the unread one came back.
  const session = new EvidenceAuditSession();
  session.record({ operationId: OP_IN_ORDER });
  assert.equal(session.provenanceOf(OP_IN_ORDER), "in-order");
  assert.deepEqual(
    session.recentIds(50).filter((id) => session.provenanceOf(id) === "late-inferred"),
    [],
    "an in-order entry is not an inferred one",
  );
  assert.equal(session.inferredIds, undefined,
    "an unread accessor is back on EvidenceAuditSession: either give it a reader or delete it again");
  assert.equal(ARRIVAL_ORDER_MECHANISM.length > 0, true, "the shared mechanism sentence is empty");
  assert.notEqual(ARRIVAL_ORDER_MECHANISM, TRAIL_PROVENANCE_NOTES["late-inferred"],
    "the clause and the note are different strings by construction; the note is the clause plus its verdict");
});

/* ------------------------------------------------------------------ *
 * R10-中2, the other two surfaces: `dispatch.ts`'s late-reply log lines.
 *
 * Both of them name operationIds for a frame that never reached the trail, and an
 * agent holding that id has no trail entry to read a caveat out of — the report
 * renderer above cannot help it. So the same mechanism sentence the trail note is
 * built from goes into the line when, and only when, the frame echoed no request id.
 * Describing the mechanism is the whole job: the line may not say the operation did
 * not run, and it may not say the guess is wrong.
 * ------------------------------------------------------------------ */

/**
 * One act whose caller timed out, then a trail generation change that supersedes it.
 *
 * `whichRefusal` picks the branch: `"at-arrival"` answers the re-attach before the
 * id-less frame lands (the fast path at `dispatch.ts`'s generation test), `"at-write"`
 * leaves the re-attach outstanding so the frame passes that test and is refused only
 * when the write takes its turn (the `chain restarted away from` arm). Both name ids
 * and both had no caveat.
 */
async function lateFrameAfterSupersededAttach(t, { idLess, whichRefusal }) {
  const io = new FakeLineIo();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = new EngineJsonRpcClient(io, 20);
  const notes = [];
  const { server, session } = createTrackedMcpServer(client, (note) => notes.push(note));
  void server;
  const act = TOOL_BY_NAME.get("gp_act");
  const attach = TOOL_BY_NAME.get("gp_attach");

  // Attach, in time: the trail now belongs to app A, generation 0.
  const attachA = executeTool(attach, { bundleId: "com.example.trail.a" }, client, session);
  await flush();
  io.respond({ attachedApp: "A", pid: 101, bundleId: "com.example.trail.a" });
  await attachA;

  // An act the caller gives up on: its entry stays tracked under generation 0.
  const actPromise = executeTool(act, ACT_ARGS("Submit"), client, session);
  await flush();
  const actFrame = JSON.parse(io.sent[io.sent.length - 1]);
  t.mock.timers.tick(20);
  assert.equal((await actPromise).content[0].text.startsWith("GP_E_ENGINE_TIMEOUT"), true);
  // The act carries the trail generation it was admitted under on the wire (its
  // correlation); every refusal below is about that number no longer being current.
  const generationAtAct = session.generation;

  // The re-attach that moves the trail to a new generation.
  const attachB = executeTool(attach, { bundleId: "com.example.trail.b" }, client, session);
  await flush();
  if (whichRefusal === "at-arrival") {
    io.respond({ attachedApp: "B", pid: 202, bundleId: "com.example.trail.b" });
    await attachB;
    assert.ok(session.generation !== generationAtAct,
      "the trail restarted before the late frame arrived, so the act's generation is superseded");
  }

  // The daemon's answer to the act: with its id, or with none at all.
  io.send(JSON.stringify(idLess
    ? { id: null, result: { operationId: OP_LATE_GUESSED, actConfirmed: true } }
    : { id: actFrame.id, result: { operationId: OP_LATE_CONFIRMED, actConfirmed: true } }));
  await flush();
  if (whichRefusal === "at-write") {
    // Only now does the re-attach land, restarting the trail under the write's feet.
    io.respond({ attachedApp: "B", pid: 202, bundleId: "com.example.trail.b" });
    await attachB;
    await flush();
    await flush();
  }
  return { io, client, session, notes };
}

/** The refusal line this fixture exists to produce. */
function refusalLine(notes) {
  const line = notes.find((note) => note.includes("not recorded") && note.includes("the operations it named are"));
  assert.ok(line, `no refusal naming an operationId: ${JSON.stringify(notes)}`);
  return line;
}

test("a superseded-attach refusal names a guessed frame's ids with the trail's own mechanism clause", async (t) => {
  // MUTATION THIS PINS: dropping `arrivalOrderClause(attribution)` from the
  // fast-path report, or passing the attribution into the sink at all. Without it the
  // line reads as a confirmed match for an id the transport only guessed an owner for,
  // and the agent goes to `gp_last_evidence` with a claim the shell never earned.
  const { client, notes } = await lateFrameAfterSupersededAttach(t, { idLess: true, whichRefusal: "at-arrival" });
  const line = refusalLine(notes);
  assert.match(line, /belongs to a superseded attach/);
  assert.ok(line.includes(OP_LATE_GUESSED), `the refusal must still name the id: ${line}`);
  assert.ok(line.includes(ARRIVAL_ORDER_MECHANISM),
    `an arrival-order frame's ids may not be named bare. Got: ${line}`);
  // Same vocabulary as the report renderer, not a second wording of it.
  assert.ok(TRAIL_PROVENANCE_NOTES["late-inferred"].includes(ARRIVAL_ORDER_MECHANISM),
    "the note and the log line must be built from one sentence, or they will drift apart");
  // Describes, never adjudicates: no verdict about whether the operation ran.
  assert.equal(/it (did not run|never ran)/.test(line), false, line);
  client.close();
});

test("the refusal at write time carries the same clause", async (t) => {
  // The other branch: the frame passes the fast generation test at arrival, takes its
  // turn, and is refused only when the restart lands before the write — the arm that
  // said "the operations it named are …" with no caveat either.
  const guessed = await lateFrameAfterSupersededAttach(t, { idLess: true, whichRefusal: "at-write" });
  const line = refusalLine(guessed.notes);
  assert.match(line, /chain restarted away from|superseded attach/, line);
  assert.ok(line.includes(ARRIVAL_ORDER_MECHANISM), `the write-path refusal lost the clause: ${line}`);
  guessed.client.close();
});

test("a refusal for a frame that echoed its request id carries no inference clause", async (t) => {
  // The control that keeps this from being a blanket annotation: a frame that *did*
  // echo its request id is matched, so its refusal line says exactly what it used to
  // and nothing about inference — an agent reading it is not being told to distrust an
  // id the transport actually confirmed.
  const confirmed = await lateFrameAfterSupersededAttach(t, { idLess: false, whichRefusal: "at-arrival" });
  const plain = refusalLine(confirmed.notes);
  assert.ok(plain.includes(OP_LATE_CONFIRMED), `the refusal must still name the id: ${plain}`);
  assert.equal(plain.includes(ARRIVAL_ORDER_MECHANISM), false,
    `a frame matched by its echoed id got an inference caveat it did not earn: ${plain}`);
  confirmed.client.close();
});
