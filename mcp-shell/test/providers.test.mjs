import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Fixed-point tests for 面 A's provider registration (specs §8.5 / R40 scenario ⑤).
 *
 * The fork's half is pinned by
 * `packages/opencode/test/tool/glasspane-provider-registration.test.ts`; these are the
 * same questions asked of the *other* surface — the one that ships as `glasspane-mcp`
 * and answers an agent's `tools/call`. The expectations are read from the shipped
 * corpus (`kernel/fixtures/provider-registration.ok-01.json`, the copy
 * `scripts/check-kernel-corpus.mjs` proves equals the installed package's own) rather
 * than copied into this file, because the claim under test is "the registration this
 * shell writes agrees with the contract" — a hand-copied literal could only ever agree
 * with itself.
 *
 * Note what is NOT an expectation here: the fixture's `1.11.0` version strings are the
 * corpus's engine version at authoring time. Asserting against them would certify a
 * version this product never shipped, so the version leg below reads this shell's own
 * manifest instead.
 */
import {
  GLASSPANE_AE_PROVIDER_ID,
  GLASSPANE_EVIDENCE_PROVIDER_ID,
  PROVIDER_CODES,
  PROVIDER_ID_MAX_LENGTH,
  KernelProviderError,
  KernelSchemaError,
  CLAIMED_ENGINE_METHODS,
  UNSTATED_REGISTRATION_VERSION,
  attributeCapability,
  claimForEngineMethod,
  coveredMethods,
  emptyProviderRegistry,
  methodForSignals,
  parseProviderRegistration,
  providerAttributionLine,
  providerIdsInCommon,
  registerProvider,
  requireMethod,
  resolveProvider,
  shellManifestPath,
  shellProductVersion,
  shellProviderDrafts,
  shellProviderRegistry,
} from "../dist/providers.js";
import { TOOL_BY_NAME, TOOL_SPECS, executeTool } from "../dist/tools.js";
import { SERVER_INFO } from "../dist/dispatch.js";
import { canonicalJson } from "../dist/canonical.js";
import { EvidenceAuditSession } from "../dist/audit-session.js";
import { ENGINE_PROTOCOL_VERSION, engineClientOver } from "../dist/engine-client.js";
import { makeEngine, FakeLineIo } from "./helpers.mjs";
import { executableSource } from "./support/source.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

function readUtf8(url) {
  return fs.readFileSync(fileURLToPath(url), "utf8");
}

const FIXTURE = JSON.parse(readUtf8(new URL("../../kernel/fixtures/provider-registration.ok-01.json", import.meta.url)));
const SHELL_MANIFEST = JSON.parse(readUtf8(new URL("../package.json", import.meta.url)));
const PROVIDERS_SOURCE = readUtf8(new URL("../src/providers.ts", import.meta.url));
const TOOLS_SOURCE = readUtf8(new URL("../src/tools.ts", import.meta.url));

/** The two glasspane registrations the corpus names, as the corpus writes them. */
const GLASSPANE_FIXTURE = FIXTURE.registry.glasspane;
const ITERATE_FIXTURE = FIXTURE.registry.iterate;

/** Build a registry from a list of registrations — the way the other harness does it. */
function registryFrom(list) {
  return list.reduce(
    (registry, entry) => registerProvider(registry, parseProviderRegistration(entry)),
    emptyProviderRegistry(),
  );
}

const SHELL_VERSION = shellProductVersion();
const SHIPPED = shellProviderRegistry(SHELL_VERSION ?? "");

/**
 * A client whose `hello` handshake has been answered by a daemon reporting `version`.
 *
 * `FakeLineIo` has no `onOpen`, so this gives it one before the client is constructed —
 * the transport opening is what makes `engine-client.ts` send the handshake — and then
 * answers it. This is the only way to test the attributed version as a *measurement*: a
 * registry built in-process would be stating the version the test wrote down.
 */
async function handshakenEngine(version, protocolVersion = ENGINE_PROTOCOL_VERSION) {
  const io = new FakeLineIo();
  let opened = null;
  io.onOpen = (handler) => {
    opened = handler;
  };
  const engine = engineClientOver(io, 500);
  opened?.();
  io.respond({ engine: "glasspaned", version, protocolVersion, pid: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  return { io, engine };
}

/** The version a daemon would report that this shell could not have produced. */
const DAEMON_REPORTED_VERSION = "1.9.9-daemon-only";

describe("面 A registers the producers the contract names", () => {
  test("the version this shell registers with is read from its own manifest, not typed in", () => {
    assert.equal(typeof SHELL_VERSION, "string");
    assert.notEqual(SHELL_VERSION, "");
  });

  test("the shipped registry holds exactly the ids the fixture's glasspane half names", () => {
    assert.deepEqual(Object.keys(SHIPPED).sort(), GLASSPANE_FIXTURE.map((entry) => entry.id).sort());
    assert.equal(GLASSPANE_AE_PROVIDER_ID, "glasspane-engine-ae");
    assert.equal(GLASSPANE_EVIDENCE_PROVIDER_ID, "glasspane-evidence");
  });

  test("both ids resolve by exact id", () => {
    assert.equal(resolveProvider(SHIPPED, GLASSPANE_AE_PROVIDER_ID).id, GLASSPANE_AE_PROVIDER_ID);
    assert.equal(resolveProvider(SHIPPED, GLASSPANE_EVIDENCE_PROVIDER_ID).id, GLASSPANE_EVIDENCE_PROVIDER_ID);
  });

  test("the drafts are the fixture's glasspane registrations, apart from the version", () => {
    const restated = JSON.parse(JSON.stringify(GLASSPANE_FIXTURE));
    for (const entry of restated) {
      entry.version = SHELL_VERSION;
    }
    assert.deepEqual(JSON.parse(JSON.stringify(shellProviderDrafts(SHELL_VERSION))), restated);
  });

  test("the registered method tables are the fixture's, prerequisite lists included", () => {
    assert.deepEqual(
      resolveProvider(SHIPPED, GLASSPANE_AE_PROVIDER_ID).methods.map((method) => method.name),
      GLASSPANE_FIXTURE[0].methods.map((method) => method.name),
    );
    // The `requires` lists are what the other harness reads to know what a call may
    // assume, so they are pinned, not the names alone.
    assert.deepEqual(
      requireMethod(SHIPPED, GLASSPANE_AE_PROVIDER_ID, "diagnose").requires,
      GLASSPANE_FIXTURE[0].methods[0].requires,
    );
    assert.deepEqual(requireMethod(SHIPPED, GLASSPANE_EVIDENCE_PROVIDER_ID, "capture").requires, ["ax-tree"]);
    assert.deepEqual(requireMethod(SHIPPED, GLASSPANE_EVIDENCE_PROVIDER_ID, "last-evidence").requires, []);
  });

  test("the version this shell registers its own drafts with is read from its manifest, not typed in", () => {
    // Three surfaces for the *shell's* string: the manifest a release carries, the
    // `serverInfo` this shell answers `initialize` with (and sends as its `hello`
    // identity), and the version `shellProviderRegistry` is built with. This is about the
    // shell, and it is NOT what a verdict is attributed to — see the next test.
    assert.equal(SHELL_VERSION, SHELL_MANIFEST.version);
    assert.equal(SERVER_INFO.version, SHELL_MANIFEST.version);
    assert.equal(SHIPPED[GLASSPANE_AE_PROVIDER_ID].version, SHELL_VERSION);
    assert.equal(SHIPPED[GLASSPANE_EVIDENCE_PROVIDER_ID].version, SHELL_VERSION);
  });

  test("the version a verdict is attributed to is the DAEMON's measured hello version, not this package's", () => {
    // MUTATION THIS PINS: hand `attributeCapability` `shellProductVersion()` again (the
    // defect it replaced) and the first assertion goes red on a machine whose bundle is
    // older than the shell — the agent would be told the verdict came from a build that
    // did not produce it.
    const measured = attributeCapability("diagnose", { producerVersion: DAEMON_REPORTED_VERSION });
    assert.equal(measured.status, "ok");
    assert.equal(measured.provider.version, DAEMON_REPORTED_VERSION);
    assert.notEqual(measured.provider.version, SHELL_VERSION,
      "把壳的 manifest 版本当成生产者的版本：这正是被测的那个缺陷");
    assert.match(measured.provider.versionNote, /daemon's own hello self-report/);
    assert.doesNotMatch(measured.provider.versionNote, /cannot read its own/);

    const line = providerAttributionLine(measured.provider);
    assert.match(line, new RegExp(`provider: ${GLASSPANE_AE_PROVIDER_ID} version ${DAEMON_REPORTED_VERSION} method diagnose`));
    assert.equal(line.includes(SHELL_VERSION), false,
      `归因行里不得再出现壳自己的版本 ${SHELL_VERSION}：${line}`);
  });

  test("with no handshake measured, the attribution states no version instead of borrowing one", () => {
    // MUTATION THIS PINS: defaulting `producerVersion` to `shellProductVersion()` (or to
    // any literal) when nothing was read — "version unmeasured" leaves the sentence and
    // this goes red.
    const unmeasured = attributeCapability("diagnose");
    assert.equal(unmeasured.status, "ok", "no handshake is not a reason to refuse a call the daemon can answer");
    assert.equal(unmeasured.provider.version, null);
    assert.match(unmeasured.provider.versionNote, /unmeasured/);
    const line = providerAttributionLine(unmeasured.provider);
    assert.match(line, /version unmeasured method diagnose/);
    assert.equal(line.includes(SHELL_VERSION), false, `没测过的版本不许出现在归因行里：${line}`);
    assert.equal(line.includes(UNSTATED_REGISTRATION_VERSION), false,
      "注册表内部的那个占位名不得泄漏给 agent");
  });

  test("the attributed version travels from the handshake to the line the agent reads, end to end", async () => {
    // The whole chain on one real client: the daemon's bytes off the transport, the
    // measurement `engine-client.ts` stores, the version `tools.ts` hands the seam, the
    // line appended to the reply. Nothing here passes a version in by hand.
    const { io, engine } = await handshakenEngine(DAEMON_REPORTED_VERSION);
    assert.equal(engine.reportedEngineVersion, DAEMON_REPORTED_VERSION,
      "hello 的 version 没有被存下来：修 1 的源头又断了");
    const reply = { class: "T1", summary: "ok" };
    const promise = executeTool(TOOL_BY_NAME.get("gp_diagnose"), {}, engine, new EvidenceAuditSession());
    io.respond(reply);
    const outcome = await promise;
    assert.equal(outcome.isError, false);
    const line = outcome.content[outcome.content.length - 1].text;
    assert.match(line, new RegExp(`version ${DAEMON_REPORTED_VERSION}`), line);
    assert.equal(line.includes(SHELL_VERSION), false, line);
    engine.close();
  });

  test("a daemon that reports no version leaves the attribution unmeasured rather than defaulting it", async () => {
    const { io, engine } = await handshakenEngine("   ");
    assert.equal(engine.reportedEngineVersion, null,
      "空白自报要当成没测过：把空格存成版本号，归因行就念出一个不存在的版本");
    const promise = executeTool(TOOL_BY_NAME.get("gp_diagnose"), {}, engine, new EvidenceAuditSession());
    io.respond({ class: "T1", summary: "ok" });
    const outcome = await promise;
    assert.match(outcome.content[outcome.content.length - 1].text, /version unmeasured/);
    engine.close();
  });

  test("the manifest is read beside the build, not out of a path compiled in", () => {
    // Resolved from this module's own URL — the same expression `providers.ts` writes,
    // which is what makes it a *runtime* source: the published-artifact test bundles
    // into `dist/index.js`, and `../package.json` is the package root from there too.
    const moduleUrl = new URL("../dist/providers.js", import.meta.url);
    assert.equal(shellManifestPath(),
      path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..", "package.json"));
    assert.equal(path.basename(shellManifestPath()), "package.json");
    assert.equal(fs.existsSync(shellManifestPath()), true, "the shipped manifest this shell reads is not on disk");
    const read = JSON.parse(fs.readFileSync(shellManifestPath(), "utf8"));
    assert.equal(read.name, "glasspane-mcp", "the registration reads the product's manifest, and refuses another");
    assert.equal(read.version, SHELL_VERSION);
  });
});

describe("resolution refuses instead of guessing", () => {
  test("an undeclared method is refused, and the refusal names what IS declared", () => {
    const aeDeclaresPixelOnly = registryFrom([
      { ...GLASSPANE_FIXTURE[0], methods: [{ name: "diagnose-pixel", requires: ["pixel-diff"] }] },
    ]);
    const refused = attributeCapability("diagnose", { registry: aeDeclaresPixelOnly });
    assert.equal(refused.status, "refused");
    assert.equal(refused.error.code, PROVIDER_CODES.missingMethod);
    assert.match(refused.error.message, /diagnose/);
    // The remedy is the half that tells the caller what exists; a generic one leaves it
    // guessing, which is the failure this contract forbids.
    assert.match(refused.error.remedy, /diagnose-pixel/);
  });

  test("requireMethod on the shipped registry throws with the declared names in its remedy", () => {
    let thrown;
    try {
      requireMethod(SHIPPED, GLASSPANE_AE_PROVIDER_ID, "diagnose-without-looking");
      throw new Error("requireMethod accepted a method nobody registered");
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof KernelProviderError, `expected a KernelProviderError, got ${String(thrown)}`);
    assert.equal(thrown.code, PROVIDER_CODES.missingMethod);
    assert.equal(thrown.providerId, GLASSPANE_AE_PROVIDER_ID);
    for (const name of GLASSPANE_FIXTURE[0].methods.map((method) => method.name)) {
      assert.match(thrown.remedy, new RegExp(name), `the remedy should name ${name}`);
    }
  });

  test("there is no cross-provider fallback", () => {
    // `last-evidence` is registered — on the OTHER provider. A resolver that searched the
    // whole registry would answer here and attribute an AE verdict to a producer that
    // never claimed to make one.
    assert.throws(() => requireMethod(SHIPPED, GLASSPANE_AE_PROVIDER_ID, "last-evidence"), KernelProviderError);
    assert.throws(() => requireMethod(SHIPPED, GLASSPANE_EVIDENCE_PROVIDER_ID, "diagnose"), KernelProviderError);
  });

  test("an unknown provider id is refused with the registered ids, not a default", () => {
    let thrown;
    try {
      resolveProvider(SHIPPED, "glasspane-engine-aee");
      throw new Error("resolveProvider accepted an id it does not hold");
    } catch (error) {
      thrown = error;
    }
    assert.equal(thrown.code, PROVIDER_CODES.unknown);
    assert.match(thrown.remedy, new RegExp(GLASSPANE_AE_PROVIDER_ID));
    assert.match(thrown.remedy, new RegExp(GLASSPANE_EVIDENCE_PROVIDER_ID));

    const evidenceOnly = attributeCapability("diagnose", { registry: registryFrom([GLASSPANE_FIXTURE[1]]) });
    assert.equal(evidenceOnly.status, "refused");
    assert.equal(evidenceOnly.error.code, PROVIDER_CODES.unknown);
  });

  test("an engine method the registry claims nothing about is not claimed, and not refused", () => {
    // The two answers are different sentences: 面 A forwards `act`, `observe`, `snapshot`
    // and the rest without saying anything about who judges them. Reading that silence as
    // a refusal would break the tools that work.
    assert.equal(attributeCapability("act").status, "not-claimed");
    assert.equal(attributeCapability("observe").status, "not-claimed");
    assert.equal(claimForEngineMethod("act"), null);
    assert.deepEqual([...CLAIMED_ENGINE_METHODS], ["diagnose"]);
    // The evidence provider is registered, and 面 A draws no consumer claim from it yet:
    // `last_evidence` reaches the agent exactly as the daemon answered it.
    assert.equal(claimForEngineMethod("last_evidence"), null);
    assert.equal(requireMethod(SHIPPED, GLASSPANE_EVIDENCE_PROVIDER_ID, "last-evidence").name, "last-evidence");
  });
});

describe("registry semantics: replaced whole, never edited", () => {
  test("re-registering an id is refused and the registry keeps exactly what it had", () => {
    const keysBefore = Object.keys(SHIPPED).sort();
    const aeBefore = JSON.parse(JSON.stringify(SHIPPED[GLASSPANE_AE_PROVIDER_ID]));
    const drafts = shellProviderDrafts(SHELL_VERSION);
    for (const draft of drafts) {
      assert.throws(() => registerProvider(SHIPPED, parseProviderRegistration(draft)), KernelProviderError);
    }
    assert.deepEqual(Object.keys(SHIPPED).sort(), keysBefore);
    assert.deepEqual(JSON.parse(JSON.stringify(SHIPPED[GLASSPANE_AE_PROVIDER_ID])), aeBefore);
    let code = "";
    try {
      registerProvider(SHIPPED, parseProviderRegistration(drafts[0]));
    } catch (error) {
      code = error.code;
    }
    assert.equal(code, PROVIDER_CODES.duplicateId);
  });

  test("a second registration of a new id returns a NEW registry and leaves the first untouched", () => {
    const extra = parseProviderRegistration({
      schemaVersion: GLASSPANE_FIXTURE[0].schemaVersion,
      id: "glasspane-report-render",
      kind: "report-render",
      version: SHELL_VERSION,
      origin: "glasspane",
      methods: [{ name: "render-markdown", requires: [] }],
    });
    const grown = registerProvider(SHIPPED, extra);
    assert.equal(Object.keys(grown).length, Object.keys(SHIPPED).length + 1);
    assert.deepEqual(Object.keys(SHIPPED).sort(), [GLASSPANE_AE_PROVIDER_ID, GLASSPANE_EVIDENCE_PROVIDER_ID]);
  });
});

describe("an empty requires is a claim, a missing requires is not one", () => {
  test("the shipped last-evidence method states [] and the kernel accepts that as a statement", () => {
    assert.deepEqual(requireMethod(SHIPPED, GLASSPANE_EVIDENCE_PROVIDER_ID, "last-evidence").requires, []);
    assert.deepEqual(GLASSPANE_FIXTURE[1].methods[1], { name: "last-evidence", requires: [] });
  });

  test('the same method with "requires" omitted is refused, with the path naming the omission', () => {
    const case_ = FIXTURE.cases.find((item) => item.name === "method-without-requires");
    assert.ok(case_, "the shipped corpus still carries the method-without-requires case");
    let thrown;
    try {
      registerProvider(emptyProviderRegistry(), parseProviderRegistration(case_.input));
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof KernelSchemaError, '"nothing was written" must never read as "nothing is needed"');
    assert.equal(thrown.code, "KERNEL_E_SCHEMA");
    assert.equal(thrown.issues.some((issue) => issue.path === "methods.0.requires"), true);
  });

  test("a draft written here with the prerequisites dropped cannot enter the registry either", () => {
    const broken = shellProviderDrafts(SHELL_VERSION).map((entry) => ({
      ...entry,
      methods: entry.id === GLASSPANE_AE_PROVIDER_ID ? [{ name: "diagnose" }] : entry.methods,
    }));
    assert.throws(() => parseProviderRegistration(broken[0]), KernelSchemaError);
    assert.throws(() => registryFrom(broken), KernelSchemaError);
  });

  test("a registration the kernel will not accept reaches the surface as a refusal, not a stack", () => {
    // This is the arm a shipped build can actually hit: the drafts are this product's own
    // bytes, so a registration the kernel refuses must surface as the three-field answer
    // an agent reads, never as an uncaught throw out of `tools/call`. The version that
    // breaks it here is one the daemon reported and the kernel's bound refuses.
    // MUTATION THIS PINS: let `shellProviderRegistry`'s throw escape `attributeCapability`
    // (drop the catch) and this becomes an uncaught KernelSchemaError, not a refusal.
    const refused = attributeCapability("diagnose", { producerVersion: "x".repeat(PROVIDER_ID_MAX_LENGTH + 1) });
    assert.equal(refused.status, "refused");
    assert.equal(refused.error.code, "KERNEL_E_SCHEMA");
    assert.match(refused.error.message, /this product writes itself/);
    assert.match(refused.error.message, /the daemon's own hello self-report/,
      "拒绝要说出这张注册表是用哪个测量填的版本：${JSON.stringify(refused.error)}");
    assert.match(refused.error.remedy, /shellProviderDrafts/);
    for (const field of ["code", "message", "remedy"]) {
      assert.equal(typeof refused.error[field], "string", `error frame 少了 ${field} 这一字段`);
    }
  });

  test("a method declared twice is refused rather than collapsed", () => {
    // Fixture case `duplicate-method-differs-only-by-requires`: the published JSON Schema
    // accepts it (`jsonSchemaAccepts: true`) and only the validator refuses, so this is
    // the case a second implementation is most likely to miss.
    const case_ = FIXTURE.cases.find((item) => item.name === "duplicate-method-differs-only-by-requires");
    assert.equal(case_.expect, "refused");
    assert.equal(case_.jsonSchemaAccepts, true);
    assert.throws(() => parseProviderRegistration(case_.input), KernelSchemaError);
  });
});

describe("two harnesses must not mean different things", () => {
  test("面 A's ids and the iterate corpus's ids have nothing in common", () => {
    assert.deepEqual(providerIdsInCommon(SHIPPED, registryFrom(ITERATE_FIXTURE)), []);
    assert.deepEqual(FIXTURE.registry.idsInCommon, []);
  });

  test("the fixture's collision block yields exactly the ids to settle, sorted", () => {
    const a = registryFrom(FIXTURE.registry.collision.a);
    const b = registryFrom(FIXTURE.registry.collision.b);
    assert.deepEqual(providerIdsInCommon(a, b), [...FIXTURE.registry.collision.expect].sort());
    assert.deepEqual(providerIdsInCommon(a, b), ["glasspane-ae", "shared-render"]);
    // …and the two `glasspane-ae` entries really are different claims, which is why the
    // collision is a rename question and not a "whichever map was consulted first" answer.
    assert.deepEqual(requireMethod(a, "glasspane-ae", "diagnose").requires, ["ax-event"]);
    assert.deepEqual(requireMethod(b, "glasspane-ae", "diagnose").requires, ["evidence-pack"]);
    assert.deepEqual(providerIdsInCommon(SHIPPED, a), []);
  });

  test("the two GlassPane surfaces answer to one name, and never to a different claim", () => {
    // `providerIdsInCommon` is a cross-*product* guard: one id meaning two different
    // judgements in two harnesses. Two surfaces of the same product are meant to share
    // their ids — that is what "registers once, both harnesses consume it" says — so the
    // honest claim here is that the ids match AND every method 面 A declares is declared
    // by the corpus's glasspane half with the same prerequisites.
    const corpus = registryFrom(GLASSPANE_FIXTURE);
    assert.deepEqual(providerIdsInCommon(SHIPPED, corpus).sort(),
      [GLASSPANE_AE_PROVIDER_ID, GLASSPANE_EVIDENCE_PROVIDER_ID]);
    for (const id of Object.keys(SHIPPED)) {
      for (const method of SHIPPED[id].methods) {
        assert.deepEqual(requireMethod(corpus, id, method.name).requires, method.requires,
          `${id}/${method.name} must mean the same thing on both sides`);
      }
    }
  });
});

describe("methodForSignals: a declaration query, not a reading of evidence", () => {
  test("a signal set that covers exactly one declaration names it", () => {
    assert.equal(methodForSignals(["ax-event", "attribution", "circuit-breaker"], SHIPPED), "diagnose");
    // Extra names do not un-cover a declaration: the question is "is everything this
    // method requires present", never "does this set equal it".
    assert.equal(methodForSignals(["ax-event", "attribution", "circuit-breaker", "pixel-diff"], SHIPPED), "diagnose");
    assert.deepEqual(coveredMethods(["ax-event", "attribution", "circuit-breaker"], SHIPPED).map((m) => m.name), ["diagnose"]);
  });

  test("nothing declared covers a partial set, or an empty one", () => {
    assert.equal(methodForSignals(["ax-event", "attribution"], SHIPPED), null);
    assert.equal(methodForSignals([], SHIPPED), null);
    assert.equal(methodForSignals(["made-up-signal"], SHIPPED), null);
  });

  test("a signal set that covers two parallel declarations answers nothing", () => {
    const parallel = registryFrom([{
      ...GLASSPANE_FIXTURE[0],
      methods: [
        { name: "diagnose", requires: ["ax-event"] },
        { name: "diagnose-blind", requires: ["ax-event"] },
      ],
    }]);
    assert.deepEqual(coveredMethods(["ax-event"], parallel).map((m) => m.name), ["diagnose", "diagnose-blind"]);
    assert.equal(methodForSignals(["ax-event"], parallel), null);
    // …and the consumer refuses on it: naming a verdict's producer by picking between two
    // indistinguishable declarations is a default resolution, which this contract forbids.
    const refused = attributeCapability("diagnose", { registry: parallel });
    assert.equal(refused.status, "refused");
    assert.match(refused.error.message, /diagnose, diagnose-blind/);
  });

  test("methodForSignals takes an explicit registry — the throwing default arm is gone", () => {
    // MUTATION THIS PINS: restore the default argument
    // `registry = shellProviderRegistry(shellProductVersion() ?? "")`. On a build whose
    // manifest cannot be read that throws `KernelSchemaError` out of a default argument,
    // which is the trap this choice removes; the guard below is what a JS caller that
    // omits the argument gets instead, and it names the fix rather than the kernel bound.
    assert.equal(methodForSignals(["ax-event", "attribution", "circuit-breaker"], SHIPPED), "diagnose");
    let thrown;
    try {
      methodForSignals(["ax-event"], undefined);
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof TypeError, `省略 registry 要得到点名这条契约的 TypeError，got ${String(thrown)}`);
    assert.match(thrown.message, /explicit ProviderRegistry/);
    assert.match(thrown.message, /shellProviderRegistry/);
    assert.equal(thrown instanceof KernelSchemaError, false,
      "默认臂又回到用壳的 manifest 版本建 registry：读不到清单的构建会从参数默认值里抛出内核模式错误");
    const source = executableSource(PROVIDERS_SOURCE);
    assert.equal(/methodForSignals\([\s\S]{0,200}?registry: ProviderRegistry = /.test(source), false,
      "src 里的 methodForSignals 重新给 registry 写了默认值");
  });
});

describe("the consumer on 面 A: attribution, and a refusal that never reaches the daemon", () => {
  test("gp_diagnose is answered, the daemon's JSON untouched, with the attribution beside it", async () => {
    const { engine, io } = makeEngine();
    const reply = { class: "T1", summary: "ok" };
    const promise = executeTool(TOOL_BY_NAME.get("gp_diagnose"), {}, engine, new EvidenceAuditSession());
    io.respond(reply);
    const outcome = await promise;
    assert.equal(outcome.isError, false);
    assert.equal(outcome.content[0].text, canonicalJson(reply), "the reply an agent parses stays byte-identical");
    const line = outcome.content[outcome.content.length - 1].text;
    // This client never had its `hello` answered, so the producer's version is unmeasured
    // and the line says exactly that. Pinning `version ${SHELL_VERSION}` here used to
    // endorse the defect: it certified the shell's own build as the producer of a verdict
    // the daemon made.
    assert.match(line, new RegExp(`provider: ${GLASSPANE_AE_PROVIDER_ID} version unmeasured method diagnose`));
    assert.match(line, /no daemon hello handshake has been answered on this connection/);
    assert.match(line, /the verdict above is the engine's/);
    assert.equal(line.includes(SHELL_VERSION), false, line);
    assert.match(
      providerAttributionLine({
        id: "x", version: "1", method: "m", requires: [], versionNote: "the producer's version is the daemon's own hello self-report",
      }),
      /prerequisites: none/,
    );
  });

  test("a tool the registry claims nothing about keeps its exact reply shape", async () => {
    for (const name of ["gp_observe", "gp_act"]) {
      const { engine, io } = makeEngine();
      const spec = TOOL_BY_NAME.get(name);
      const promise = executeTool(spec, name === "gp_act"
        ? { selector: { role: "button", title: "Submit" }, action: "press" }
        : {}, engine, new EvidenceAuditSession());
      io.respond(name === "gp_observe" ? { tree: {} } : { actConfirmed: true });
      const outcome = await promise;
      assert.equal(outcome.content.length, 1, JSON.stringify(outcome.content.map((item) => item.text.slice(0, 40))));
      assert.equal(outcome.content[0].text.startsWith("provider: "), false, `${name} is not a claimed capability`);
    }
  });

  test("tools.ts asks the registry before it forwards, and renders the attribution it gets", () => {
    const code = executableSource(TOOLS_SOURCE);
    assert.match(code, /attributeCapability\(spec\.engineMethod, \{/);
    assert.match(code, /providerAttributionLine\(/);
    // The version it hands the seam is the client's measurement, not this package's
    // manifest: `providers.ts` has no way to reach the handshake, so a call site that
    // dropped this argument would silently re-measure nothing.
    assert.match(code, /producerVersion: engine\.reportedEngineVersion/,
      "tools.ts 不再把这次连接上量到的 daemon 版本交给归因入口：修 1 在调用侧断了");
    const forwarded = code.indexOf("await engine.call(spec.engineMethod");
    assert.ok(forwarded > 0, "the forwarded call site this gate measures moved out of tools.ts");
    assert.ok(code.indexOf("attributeCapability(spec.engineMethod") < forwarded,
      "the claim is that an unattributable capability never reaches the daemon; a guard sitting after the call would not make it true");
  });

  test("a claimed engine method always travels the path that renders its attribution", () => {
    // The attribution is appended on the forwarded path; a claimed method whose tool has
    // an executor of its own would be gated but never attributed. Not reachable today —
    // and that is exactly why it has to be checked rather than noticed later.
    for (const engineMethod of CLAIMED_ENGINE_METHODS) {
      const specs = TOOL_SPECS.filter((spec) => spec.engineMethod === engineMethod);
      assert.equal(specs.length, 1, `${engineMethod} should be forwarded by exactly one tool`);
      assert.equal(specs[0].execute, undefined,
        `${specs[0].name} has its own executor: the attribution would be computed and never presented`);
    }
  });

  test("a build with no readable manifest still forwards, still attributes what it measures, and says its own version is unreadable", async () => {
    // Not a mock: the shipped `dist` copied into a tree with no manifest above it, so the
    // version source is proved to be the runtime read rather than a string compiled in.
    // MUTATION THIS PINS: making the unreadable manifest a refusal again (`GP_E_INTERNAL`
    // + the "run glasspane-mcp from a package directory…" remedy) — the daemon was healthy
    // and the diagnosis was answerable, and the remedy named a thing an agent cannot do
    // from where it is standing.
    const base = fs.mkdtempSync(path.join(TEST_DIR, ".gp-nomanifest-"));
    try {
      fs.cpSync(path.join(TEST_DIR, "..", "dist"), path.join(base, "dist"), { recursive: true });
      fs.mkdirSync(path.join(base, "test"), { recursive: true });
      fs.copyFileSync(path.join(TEST_DIR, "helpers.mjs"), path.join(base, "test", "helpers.mjs"));
      const load = (name) => import(new URL(`./${path.basename(base)}/dist/${name}`, import.meta.url));

      const local = await load("providers.js");
      assert.equal(local.shellProductVersion(), null, "a build with no manifest beside it must not report a version");

      // (a) Nothing measured: the seam answers, states no producer version, and says the
      //     manifest is unreadable instead of refusing.
      const bare = local.attributeCapability("diagnose");
      assert.equal(bare.status, "ok", "读不到 manifest 不是拒绝诊断的理由");
      assert.equal(bare.provider.version, null);
      assert.match(bare.provider.versionNote, /cannot read its own glasspane-mcp manifest/);
      assert.match(bare.provider.versionNote, new RegExp(local.shellManifestPath().replace(/[/.]/g, (c) => `\\${c}`)));
      const bareLine = local.providerAttributionLine(bare.provider);
      assert.match(bareLine, /version unmeasured/);
      assert.equal(bareLine.includes(local.UNSTATED_REGISTRATION_VERSION), false,
        `内部占位版本不得念给 agent：${bareLine}`);

      // (b) The daemon measured: its own hello version is what gets attributed, through the
      //     real tool path, and the daemon is actually asked.
      const localTools = await load("tools.js");
      const { engineClientOver: over } = await load("engine-client.js");
      const { EvidenceAuditSession: LocalSession } = await load("audit-session.js");
      const io = new FakeLineIo();
      let opened = null;
      io.onOpen = (handler) => {
        opened = handler;
      };
      const engine = over(io, 500);
      opened?.();
      io.respond({ engine: "glasspaned", version: DAEMON_REPORTED_VERSION, protocolVersion: ENGINE_PROTOCOL_VERSION });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(engine.reportedEngineVersion, DAEMON_REPORTED_VERSION,
        "no-manifest 的构建读不到自己的 hello 测量：这条端到端就没有源头");
      const promise = localTools.executeTool(
        localTools.TOOL_BY_NAME.get("gp_diagnose"),
        {},
        engine,
        new LocalSession(),
      );
      io.respond({ class: "T1", summary: "ok" });
      const answered = await promise;
      assert.equal(answered.isError, false, JSON.stringify(answered.content.map((c) => c.text.slice(0, 80))));
      assert.equal(io.sent.filter((line) => JSON.parse(line).method === "diagnose").length, 1,
        "读不到 manifest 的壳照样要把这条转给 daemon");
      const line = answered.content[answered.content.length - 1].text;
      assert.match(line, new RegExp(`version ${DAEMON_REPORTED_VERSION}`), line);
      assert.match(line, /cannot read its own glasspane-mcp manifest/);
      engine.close();
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("the binding's import shape", () => {
  test("providers.ts imports kernel subpaths, never the barrel that reads ../schemas at init", () => {
    const code = executableSource(PROVIDERS_SOURCE);
    assert.equal((code.match(/from\s+"iterate-kernel"/g) ?? []).length, 0,
      "the barrel reads ../schemas/*.json at module init and dies in the esbuild bundle");
    assert.match(code, /from "iterate-kernel\/provider-registration"/);
    assert.match(code, /from "iterate-kernel\/parse"/);
    assert.match(code, /from "iterate-kernel\/errors"/);
  });

  test("the registration carries no literal version string of its own", () => {
    const code = executableSource(PROVIDERS_SOURCE);
    assert.equal(code.includes(FIXTURE.input.version), false,
      `the corpus's authoring-time version ${FIXTURE.input.version} is not this product's`);
    assert.equal(code.includes(`"${SHELL_MANIFEST.version}"`), false,
      "the shell's own version is read from its manifest, never copied into the registration");
    for (const draft of shellProviderDrafts("9.9.9-test")) {
      assert.equal(draft.version, "9.9.9-test");
    }
  });

  test("an unusable version is refused by the kernel, not papered over here", () => {
    // The bounds are the kernel's: the empty version fails the floor, and the long probe
    // rides on the bound the package exports rather than a number restated here.
    assert.throws(() => shellProviderRegistry(""), KernelSchemaError);
    assert.throws(() => shellProviderRegistry("x".repeat(PROVIDER_ID_MAX_LENGTH + 1)), KernelSchemaError);
    assert.deepEqual(Object.keys(shellProviderRegistry("x".repeat(PROVIDER_ID_MAX_LENGTH))).length, 2);
  });

  test("nothing in 面 A's registration reaches for the repository's kernel mirror or a CommonJS require", () => {
    const code = executableSource(PROVIDERS_SOURCE);
    assert.equal(/from\s+"\.\.[/\\]kernel/.test(code), false, "the published package is the contract; the mirror is not");
    assert.equal(/require\(|createRequire/.test(code), false, "a CommonJS require would not survive the esbuild bundle");
  });
});
