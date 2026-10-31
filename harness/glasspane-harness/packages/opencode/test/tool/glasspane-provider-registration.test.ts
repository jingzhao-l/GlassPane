import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

import { InstallationVersion } from "@opencode-ai/core/installation/version"

import { kernelFixture } from "../lib/kernel-contract"

/**
 * Fixed-point tests for the fork's provider registration (specs §8.5 / R40
 * scenario ⑤). The ruler for the same contract is `script/kernel-conformance.mjs`,
 * which drives the corpus through the installed kernel; these tests pin the half
 * the ruler cannot see — that THIS PRODUCT registers the two producers the corpus
 * names, and refuses in the ways the corpus says a consumer must refuse.
 *
 * Two different anchors are used below, on purpose, and the shape of each claim
 * decides which one it gets:
 *  - the `requires` lists, the refusal semantics and the registry rules come from
 *    the fixture shipped inside the pinned package
 *    (`node_modules/iterate-kernel/fixtures/provider-registration.ok-01.json`,
 *    sha256-pinned by `contracts/kernel-pin.json`), because that contract is the
 *    kernel's and is read rather than copied;
 *  - WHICH METHODS MAY BE REGISTERED is an engine claim, and the fixture cannot
 *    anchor it: the corpus's top-level `input.methods` lists `diagnose-pixel` and
 *    `diagnose-probed`, names the daemon has no case for. Comparing this product's
 *    registration against the bytes it was copied from is a self-echo — it grades
 *    the copy, not the claim. The method table below is therefore anchored to
 *    `EngineMethod`, the enum that decides what the daemon can answer at all.
 *
 * Note the fixture's `1.11.0` version strings are NOT used as an expectation here:
 * they are the corpus's own engine version at authoring time, and asserting against
 * them would certify a version this product never shipped.
 */
import {
  GLASSPANE_AE_PROVIDER_ID,
  GLASSPANE_EVIDENCE_PROVIDER_ID,
  PROVIDER_CODES,
  KernelProviderError,
  KernelSchemaError,
  diagnoseAttribution,
  emptyProviderRegistry,
  glasspaneProviderDrafts,
  glasspaneProviderRegistry,
  parseProviderRegistration,
  providerIdsInCommon,
  registerProvider,
  requireDiagnoseMethod,
  requireMethod,
  resolveProvider,
} from "../../src/tool/glasspane/providers"
import type { ProviderRegistry } from "../../src/tool/glasspane/providers"

interface FixtureMethod {
  readonly name: string
  readonly requires: string[]
}
/** A case input may omit `requires` — that omission is the case, so it cannot be typed away. */
interface LooseMethod {
  readonly name: string
  readonly requires?: string[]
}
interface FixtureRegistration {
  readonly schemaVersion: string
  readonly id: string
  readonly kind: string
  readonly version: string
  readonly origin?: string
  readonly methods: FixtureMethod[]
}
interface CaseRegistration extends Omit<FixtureRegistration, "methods"> {
  readonly methods: LooseMethod[]
}
interface ProviderFixture {
  readonly input: FixtureRegistration
  readonly expectedMethods: readonly string[]
  readonly cases: readonly { readonly name: string; readonly input: CaseRegistration; readonly expect: string; readonly path?: string }[]
  readonly registry: {
    readonly glasspane: readonly FixtureRegistration[]
    readonly iterate: readonly FixtureRegistration[]
    readonly idsInCommon: readonly string[]
    readonly collision: { readonly a: readonly FixtureRegistration[]; readonly b: readonly FixtureRegistration[]; readonly expect: readonly string[] }
  }
}

const FIXTURE = kernelFixture<ProviderFixture>(import.meta.dir, "provider-registration.ok-01")

/** Build one registry from a fixture list — the way the iterate side does it, through the same functions. */
function registryFrom(list: readonly FixtureRegistration[]): ProviderRegistry {
  return list.reduce<ProviderRegistry>(
    (registry, entry) => registerProvider(registry, parseProviderRegistration(entry)),
    emptyProviderRegistry(),
  )
}

const SHIPPED = glasspaneProviderRegistry(InstallationVersion)

/**
 * THE ENGINE'S METHOD TABLE, AS MEASURED. `EngineMethod` is declared at
 * `engine/Sources/GlassPaneEngine/FrameCodec.swift:73-82` in the parent tree, and
 * `RequestParser.parse` in the same file maps the frame's `method` string through
 * `EngineMethod(rawValue:)` and refuses anything outside the enum
 * (`:150-152`, "is not in the whitelist"). Nothing named here can be called, so
 * nothing named here may be registered.
 *
 * It is written into this file rather than read from the Swift because the engine
 * lives in the parent repository and never enters the subtree-split product tree —
 * a test that walked up to it passed on a maintainer machine and died in the split
 * repo's CI on the missing file (measured 2026-10-15, the same lesson
 * `test/tool/glasspane-surface.test.ts` records). The copy is kept honest by the
 * test below that compares it against `contracts/engine-methods.json`, the artifact
 * `harness/tools/product-surface.mjs` rule `engine-methods` re-derives from the enum.
 */
const ENGINE_METHODS = [
  "hello",
  "attach",
  "act",
  "observe",
  "assert_element",
  "diagnose",
  "last_evidence",
  "snapshot",
  "restore",
  "audit_ui",
  "capture_view",
  "probe_status",
  "shutdown",
] as const

/**
 * What this surface's two producers claim, and the engine method each claim is the
 * daemon's answer for. The registration speaks kebab-case provider names (the
 * contract's own vocabulary); the values are the engine's wire names, and every one
 * of them must be in `ENGINE_METHODS` — that assertion is what makes this table, and
 * not this file's opinion, the anchor.
 */
const REGISTRATION_TO_ENGINE: Record<string, string> = {
  diagnose: "diagnose",
  capture: "capture_view",
  "last-evidence": "last_evidence",
}

/** The provider each side of the registration belongs to. */
const AE_METHODS = ["diagnose"]
const EVIDENCE_METHODS = ["capture", "last-evidence"]

function registeredMethodNames(registry: ProviderRegistry, id: string): string[] {
  return resolveProvider(registry, id).methods.map((method) => method.name)
}

/**
 * The engine-anchored check, as a pure function so the negative control can run the
 * same code the production claim runs. Returns the problems; empty means the table
 * equals the engine's.
 */
function registrationDrift(ae: readonly string[], evidence: readonly string[]): string[] {
  const problems: string[] = []
  for (const [side, names] of [
    ["glasspane-engine-ae", ae],
    ["glasspane-evidence", evidence],
  ] as const) {
    for (const name of names) {
      if (REGISTRATION_TO_ENGINE[name] === undefined) {
        problems.push(`${side}: '${name}' is not a method this surface claims an engine answer for`)
        continue
      }
      if (!ENGINE_METHODS.includes(REGISTRATION_TO_ENGINE[name] as (typeof ENGINE_METHODS)[number])) {
        problems.push(`${side}: '${name}' maps to '${REGISTRATION_TO_ENGINE[name]}', which the engine's table does not carry`)
      }
    }
    if (names.length !== new Set(names).size) problems.push(`${side}: a method registered twice is two claims, not one`)
  }
  const declared = [...ae, ...evidence].sort()
  const expected = Object.keys(REGISTRATION_TO_ENGINE).sort()
  if (JSON.stringify(declared) !== JSON.stringify(expected)) {
    problems.push(`the registration declares ${JSON.stringify(declared)} but the engine-anchored table is ${JSON.stringify(expected)}`)
  }
  return problems
}

describe("the registration is anchored to the engine's method table", () => {
  test("the list written here is the contract's list, so the copy cannot go stale in silence", () => {
    const contract = path.join(import.meta.dir, "..", "..", "..", "..", "contracts", "engine-methods.json")
    expect(existsSync(contract), `${contract} is missing — the engine table has no anchor without it`).toBe(true)
    const parsed = JSON.parse(readFileSync(contract, "utf8")) as { methods?: unknown }
    expect(Array.isArray(parsed.methods), "contracts/engine-methods.json carries no method list").toBe(true)
    expect([...(parsed.methods as string[])].sort()).toEqual([...ENGINE_METHODS].sort())
  })

  test("every wire name the registration maps to is one the engine answers", () => {
    for (const [name, wire] of Object.entries(REGISTRATION_TO_ENGINE)) {
      expect(ENGINE_METHODS, `'${name}' claims the engine answers '${wire}'`).toContain(wire)
    }
  })

  test("a draft adding a method the engine does not answer is caught, not echoed", () => {
    // THE NEGATIVE CONTROL, run through the same function as the production claim above. These two
    // names are the corpus's own invented pair: they are legal kebab-case, so `parseProviderRegistration`
    // accepts them and a fixture-to-registration comparison accepts them too — only the engine refuses
    // them, by having no such case. Re-adding either to `providers.ts` turns the test above red.
    for (const invented of ["diagnose-pixel", "diagnose-probed"]) {
      expect(ENGINE_METHODS).not.toContain(invented)
      expect(ENGINE_METHODS.map((wire) => wire.replaceAll("_", "-"))).not.toContain(invented)
      expect(registrationDrift([...AE_METHODS, invented], EVIDENCE_METHODS).length).toBeGreaterThan(0)
    }
    // A name the engine does answer for (`assert_element`), but which no provider this surface ships
    // declares, is refused by the same check: the table is the engine's methods this surface claims,
    // not "anything the daemon could reply to".
    expect(registrationDrift(AE_METHODS, [...EVIDENCE_METHODS, "assert-element"]).length).toBeGreaterThan(0)
  })
})

describe("GlassPane registers its two producers", () => {
  test("the shipped registry holds exactly the two ids the corpus names for glasspane", () => {
    expect(Object.keys(SHIPPED).sort()).toEqual(
      FIXTURE.registry.glasspane.map((entry) => entry.id).sort(),
    )
    expect(GLASSPANE_AE_PROVIDER_ID).toBe("glasspane-engine-ae")
    expect(GLASSPANE_EVIDENCE_PROVIDER_ID).toBe("glasspane-evidence")
  })

  test("both ids resolve by exact id", () => {
    expect(resolveProvider(SHIPPED, GLASSPANE_AE_PROVIDER_ID).id).toBe(GLASSPANE_AE_PROVIDER_ID)
    expect(resolveProvider(SHIPPED, GLASSPANE_EVIDENCE_PROVIDER_ID).id).toBe(GLASSPANE_EVIDENCE_PROVIDER_ID)
  })

  test("the registered method table is the engine's, not the fixture's", () => {
    // The claim a partner harness relies on is "asking this provider for this method gets an
    // answer", and only the engine's enum can anchor that. The old version of this assertion
    // compared the registration with `FIXTURE.input.methods` — the very bytes it was copied
    // from — so it stayed green while the file certified two judgement producers the daemon
    // answers with unknown-method.
    expect(registrationDrift(registeredMethodNames(SHIPPED, GLASSPANE_AE_PROVIDER_ID), registeredMethodNames(SHIPPED, GLASSPANE_EVIDENCE_PROVIDER_ID))).toEqual([])
    expect(registeredMethodNames(SHIPPED, GLASSPANE_AE_PROVIDER_ID)).toEqual(AE_METHODS)
    expect(registeredMethodNames(SHIPPED, GLASSPANE_EVIDENCE_PROVIDER_ID)).toEqual(EVIDENCE_METHODS)
    // The `requires` lists are the other harness's reading material, so they stay pinned — to the
    // fixture, which is the contract that owns them.
    expect(requireMethod(SHIPPED, GLASSPANE_AE_PROVIDER_ID, "diagnose").requires).toEqual(
      FIXTURE.registry.glasspane[0]!.methods[0]!.requires,
    )
    expect(requireMethod(SHIPPED, GLASSPANE_EVIDENCE_PROVIDER_ID, "capture").requires).toEqual(["ax-tree"])
    expect(requireMethod(SHIPPED, GLASSPANE_EVIDENCE_PROVIDER_ID, "last-evidence").requires).toEqual([])
  })

  test("the registered version is the product's own runtime version, read the same way --version reads it", () => {
    // `packages/opencode/src/index.ts` hands `InstallationVersion` to yargs' `.version(...)`,
    // so this is literally the string `glasspane-harness --version` prints. Build-time it is
    // the `OPENCODE_VERSION` define burned from `product.json`; run from a test tree the global
    // is absent and the same module answers "local" — which is still the honest answer, because
    // it is the product's own value rather than a number copied out of the fixture.
    expect(SHIPPED[GLASSPANE_AE_PROVIDER_ID]!.version).toBe(InstallationVersion)
    expect(SHIPPED[GLASSPANE_EVIDENCE_PROVIDER_ID]!.version).toBe(InstallationVersion)
    const attributed = diagnoseAttribution("diagnose")
    expect(attributed.ok).toBe(true)
    if (!attributed.ok) return
    expect(attributed.provider.version).toBe(InstallationVersion)
  })

  test("the attribution the tool surface records names the provider, the version and the declared method", () => {
    const attributed = diagnoseAttribution("diagnose")
    expect(attributed.ok).toBe(true)
    if (!attributed.ok) return
    expect(attributed.provider.id).toBe(GLASSPANE_AE_PROVIDER_ID)
    expect(attributed.provider.method).toBe("diagnose")
    expect(attributed.provider.version).toBe(InstallationVersion)
    expect(attributed.provider.requires).toEqual(FIXTURE.input.methods[0]!.requires)
  })
})

describe("resolution refuses instead of guessing", () => {
  test("an undeclared method is refused, and the refusal names the declared ones", () => {
    let thrown: unknown
    try {
      requireDiagnoseMethod(SHIPPED, "diagnose-without-looking")
      throw new Error("requireDiagnoseMethod accepted a method nobody registered")
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(KernelProviderError)
    const refusal = thrown as KernelProviderError
    expect(refusal.code).toBe(PROVIDER_CODES.missingMethod)
    expect(refusal.providerId).toBe(GLASSPANE_AE_PROVIDER_ID)
    // Asserted on the registered list, not on "it threw": the remedy is the half that tells the
    // caller what exists, and an empty or generic one would leave it guessing. The list it has to
    // name is the AE provider's own — every entry of which the engine's table carries — and it must
    // not name a method the daemon would answer with unknown-method.
    for (const name of AE_METHODS) {
      expect(refusal.remedy, `remedy should name ${name}`).toContain(name)
    }
    for (const name of FIXTURE.input.methods.map((method) => method.name)) {
      if (REGISTRATION_TO_ENGINE[name] !== undefined) continue
      expect(refusal.remedy, `remedy must not offer '${name}' — no EngineMethod case answers for it`).not.toContain(name)
    }
    expect(refusal.message).toContain("diagnose-without-looking")
  })

  test("a method the EVIDENCE provider declares is not found on the AE provider", () => {
    // No cross-provider fallback: `capture` is registered, so a resolver that "helpfully"
    // searched the whole registry would answer here and attribute an AE verdict to a
    // provider that never claimed to make one.
    expect(() => requireDiagnoseMethod(SHIPPED, "capture")).toThrow(KernelProviderError)
    expect(requireMethod(SHIPPED, GLASSPANE_EVIDENCE_PROVIDER_ID, "capture").name).toBe("capture")
  })

  test("an unknown provider id is refused with the registered ids, not a default", () => {
    let thrown: unknown
    try {
      resolveProvider(SHIPPED, "glasspane-engine-aee")
      throw new Error("resolveProvider accepted an id it does not hold")
    } catch (error) {
      thrown = error
    }
    const refusal = thrown as KernelProviderError
    expect(refusal.code).toBe(PROVIDER_CODES.unknown)
    expect(refusal.remedy).toContain(GLASSPANE_AE_PROVIDER_ID)
    expect(refusal.remedy).toContain(GLASSPANE_EVIDENCE_PROVIDER_ID)
  })

  test("the tool surface's attribution call refuses rather than defaulting when the method is not declared", () => {
    const refused = diagnoseAttribution("diagnose-pixel-but-spelled-wrong")
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.error.code).toBe(PROVIDER_CODES.missingMethod)
    // The remedy lists what the provider really registered. It used to be asserted against
    // `diagnose-probed` — a name this surface copied out of the kernel's fixture and the daemon
    // has no case for, so pinning it here was pinning the defect.
    expect(refused.error.remedy).toContain("diagnose")
    expect(refused.error.remedy).not.toContain("diagnose-pixel")
    expect(refused.error.remedy).not.toContain("diagnose-probed")
  })

  test("a name the engine cannot answer for is refused, not registered", () => {
    // The corpus's `input.methods` is a fixture of the kernel's *shape*, not a claim about
    // GlassPane's engine: `diagnose-pixel` and `diagnose-probed` appear in no `EngineMethod`
    // case (`contracts/engine-methods.json`, which `harness/tools/product-surface.mjs` rule
    // `engine-methods` re-derives from `FrameCodec.swift`). Registering them would advertise
    // judgement producers the daemon answers with unknown-method, so the fixture's extras have
    // to be the refused half of this loop.
    for (const name of FIXTURE.input.methods.map((method) => method.name)) {
      const claim = REGISTRATION_TO_ENGINE[name]
      const engineCarries = claim !== undefined && (ENGINE_METHODS as readonly string[]).includes(claim)
      expect(
        diagnoseAttribution(name).ok,
        engineCarries ? `${name} is an engine method and must attribute` : `${name} is not an engine method and must not attribute`,
      ).toBe(engineCarries)
    }
  })
})

describe("registry semantics: replaced whole, never edited", () => {
  test("re-registering an id is refused and the registry keeps exactly what it had", () => {
    const before = glasspaneProviderDrafts(InstallationVersion)
    const registry = glasspaneProviderRegistry(InstallationVersion)
    const keysBefore = Object.keys(registry).sort()
    const aeBefore = { ...registry[GLASSPANE_AE_PROVIDER_ID]! }
    for (const draft of before) {
      expect(() => registerProvider(registry, parseProviderRegistration(draft))).toThrow(KernelProviderError)
    }
    expect(Object.keys(registry).sort()).toEqual(keysBefore)
    expect(registry[GLASSPANE_AE_PROVIDER_ID]).toEqual(aeBefore)
    let code = ""
    try {
      registerProvider(registry, parseProviderRegistration(before[0]!))
    } catch (error) {
      code = (error as KernelProviderError).code
    }
    expect(code).toBe(PROVIDER_CODES.duplicateId)
  })

  test("a second registration of a new id returns a NEW registry and leaves the first untouched", () => {
    const registry = glasspaneProviderRegistry(InstallationVersion)
    const extra = parseProviderRegistration({
      schemaVersion: FIXTURE.input.schemaVersion,
      id: "glasspane-report-render",
      kind: "report-render",
      version: InstallationVersion,
      origin: "glasspane",
      methods: [{ name: "render-markdown", requires: [] }],
    })
    const grown = registerProvider(registry, extra)
    expect(Object.keys(grown).length).toBe(Object.keys(registry).length + 1)
    expect(Object.keys(registry).sort()).toEqual([GLASSPANE_AE_PROVIDER_ID, GLASSPANE_EVIDENCE_PROVIDER_ID])
  })
})

describe("an empty requires is a claim, a missing requires is not one", () => {
  test("the shipped last-evidence method states [] and the kernel accepts that as a statement", () => {
    expect(glasspaneProviderDrafts(InstallationVersion)[1]!.methods).toBeTruthy()
    expect(requireMethod(SHIPPED, GLASSPANE_EVIDENCE_PROVIDER_ID, "last-evidence").requires).toEqual([])
  })

  test("the same method with requires omitted is refused, with the path naming the omission", () => {
    // Mirrors the fixture case `method-without-requires` (expect refused, path
    // `methods.0.requires`): the shipped registration is not allowed to be looser than
    // the corpus, and "nothing was written" must never be read as "nothing is needed".
    const case_ = FIXTURE.cases.find((item) => item.name === "method-without-requires")
    expect(case_, "the shipped corpus still carries the method-without-requires case").toBeTruthy()
    let thrown: unknown
    try {
      registerProvider(emptyProviderRegistry(), parseProviderRegistration(case_!.input))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(KernelSchemaError)
    const schema = thrown as KernelSchemaError
    expect(schema.code).toBe("KERNEL_E_SCHEMA")
    expect(schema.issues.some((issue) => issue.path === "methods.0.requires")).toBe(true)
  })

  test("a registration built here with `requires` dropped cannot enter the registry either", () => {
    const draft = {
      schemaVersion: FIXTURE.input.schemaVersion,
      id: "glasspane-half-written",
      kind: "ae-diagnosis",
      version: InstallationVersion,
      origin: "glasspane",
      methods: [{ name: "diagnose" }],
    }
    expect(() => parseProviderRegistration(draft)).toThrow(KernelSchemaError)
    // And the same refusal reaches the surface through the attribution path, as a
    // three-field rejection rather than a thrown stack: `diagnoseAttribution` is the
    // boundary the tool call stands on. The half-written AE draft below is exactly the
    // regression that would otherwise be invisible — a registration that quietly stops
    // claiming its prerequisites.
    const broken = glasspaneProviderDrafts(InstallationVersion).map((entry) => ({
      ...entry,
      methods: String(entry.id) === GLASSPANE_AE_PROVIDER_ID ? [{ name: "diagnose" }] : entry.methods,
    }))
    expect(() =>
      broken.reduce<ProviderRegistry>(
        (registry, entry) => registerProvider(registry, parseProviderRegistration(entry)),
        emptyProviderRegistry(),
      ),
    ).toThrow(KernelSchemaError)
  })

  test("a method declared twice is refused rather than collapsed", () => {
    // Fixture case `duplicate-method-differs-only-by-requires`: the published JSON Schema
    // accepts it (`jsonSchemaAccepts: true`) and only the validator refuses, so this is the
    // case a second implementation is most likely to miss.
    const case_ = FIXTURE.cases.find((item) => item.name === "duplicate-method-differs-only-by-requires")
    expect(case_!.expect).toBe("refused")
    expect(() => parseProviderRegistration(case_!.input)).toThrow(KernelSchemaError)
  })
})

describe("two harnesses must not mean different things", () => {
  test("the shipped ids and the iterate corpus's ids have nothing in common", () => {
    const iterate = registryFrom(FIXTURE.registry.iterate)
    expect(providerIdsInCommon(SHIPPED, iterate)).toEqual([])
    expect(FIXTURE.registry.idsInCommon).toEqual([])
  })

  test("the fixture's collision block yields exactly the ids to settle, sorted", () => {
    // This is the "settle before a run" guard, so it has to be able to go red: if a lane
    // ever registers one of these ids on both sides, this test names the collision instead
    // of the run discovering it. `glasspane-ae` is the dangerous one — the same id meaning
    // two different diagnoses, one requiring `ax-event` and one requiring `evidence-pack`.
    const a = registryFrom(FIXTURE.registry.collision.a)
    const b = registryFrom(FIXTURE.registry.collision.b)
    expect(providerIdsInCommon(a, b)).toEqual([...FIXTURE.registry.collision.expect].sort())
    expect(providerIdsInCommon(a, b)).toEqual(["glasspane-ae", "shared-render"])
    // …and the two `glasspane-ae` entries really are different claims, which is why the
    // collision is a rename question and not a "whichever map was consulted first" answer.
    expect(requireMethod(a, "glasspane-ae", "diagnose").requires).toEqual(["ax-event"])
    expect(requireMethod(b, "glasspane-ae", "diagnose").requires).toEqual(["evidence-pack"])
    expect(providerIdsInCommon(SHIPPED, a)).toEqual([])
  })
})

describe("the binding's import shape", () => {
  test("providers.ts imports kernel subpaths, never the barrel that reads ../schemas at init", () => {
    const source = readFileSync(
      path.join(import.meta.dirname, "..", "..", "src", "tool", "glasspane", "providers.ts"),
      "utf8",
    )
    const bare = [...source.matchAll(/from\s+"iterate-kernel"/g)].length
    expect(bare, "the barrel reads ../schemas/*.json at module init and dies in the bundle").toBe(0)
    expect(source).toContain('from "iterate-kernel/provider-registration"')
    expect(source).toContain('from "iterate-kernel/parse"')
    expect(source).not.toContain('"1.11.0"')
  })

  test("the registration carries no literal version string of its own", () => {
    // The fixture's `1.11.0` is the corpus's engine version at authoring time. Nothing in
    // the shipped drafts may restate it, so the only version a registration can carry is
    // the one the caller hands in.
    for (const draft of glasspaneProviderDrafts("9.9.9-test")) {
      expect(draft.version).toBe("9.9.9-test")
    }
    expect(() => glasspaneProviderRegistry("")).toThrow(KernelSchemaError)
    expect(() => glasspaneProviderRegistry("x".repeat(65))).toThrow(KernelSchemaError)
  })
})
