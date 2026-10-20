import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
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
 * The expectations below are read from the fixture shipped inside the pinned
 * package (`node_modules/iterate-kernel/fixtures/provider-registration.ok-01.json`,
 * sha256-pinned by `contracts/kernel-pin.json`) rather than copied, because the
 * claim being tested is "the registration GlassPane writes agrees with the
 * contract" — a hand-copied literal could only ever agree with itself. Note the
 * fixture's `1.11.0` version strings are NOT used as an expectation here: they are
 * the corpus's own engine version at authoring time, and asserting against them
 * would certify a version this product never shipped.
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

  test("the registered method table is the fixture's, in order", () => {
    expect(resolveProvider(SHIPPED, GLASSPANE_AE_PROVIDER_ID).methods.map((method) => method.name)).toEqual(
      FIXTURE.input.methods.map((method) => method.name),
    )
    // The AE entry at the top of the fixture is the same shape as `registry.glasspane[0]`
    // only for `diagnose`; the requires lists are what the other harness reads to know
    // what a call is allowed to assume, so they are pinned, not the names alone.
    expect(requireMethod(SHIPPED, GLASSPANE_AE_PROVIDER_ID, "diagnose").requires).toEqual(
      FIXTURE.input.methods[0]!.requires,
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
    // Asserted on the named list, not on "it threw": the remedy is the half that tells the
    // caller what exists, and an empty or generic one would leave it guessing.
    for (const name of FIXTURE.input.methods.map((method) => method.name)) {
      expect(refusal.remedy, `remedy should name ${name}`).toContain(name)
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
    expect(refused.error.remedy).toContain("diagnose-probed")
  })

  test("every declared AE method attributes cleanly, so the refusal above is about the name", () => {
    for (const name of FIXTURE.input.methods.map((method) => method.name)) {
      expect(diagnoseAttribution(name).ok, `${name} is registered and must attribute`).toBe(true)
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
