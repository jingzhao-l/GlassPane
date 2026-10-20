/**
 * providers.ts — GlassPane's half of the kernel's provider-registration contract
 * (specs §8.5 / R40 scenario ⑤: "a judgement producer registers once, and both
 * harnesses consume it through the same shape").
 *
 * WHY THIS FILE EXISTS. Before it, this repository had no product-side provider
 * registration at all: the contract existed only as bytes — the ruler
 * `script/kernel-conformance.mjs`, which drives the fixture corpus through the
 * installed kernel, and the recorded goldens under `contracts/`. A contract that
 * nothing on the product side implements is a measurement of a package, not of
 * this product, so the scenario could pass while GlassPane registered nothing.
 * These two registrations are the thing the other side is allowed to consume.
 *
 * WHAT IS NOT DECIDED HERE, and that is the load-bearing part. A registration is
 * metadata — who provides what, and what it needs to do it. Nothing in this file
 * compares a signal, weighs a threshold, or produces a verdict; the verdict stays
 * where it already is (the daemon's reply, transcribed by `kernel.ts`). Selecting
 * which *declared method* to ask for is a registry query, and the kernel's own
 * `requireMethod` answers it. That distinction is what keeps this file inside
 * `harness/tools/surface-semantics.mjs`; if a later change makes a surface judge
 * evidence, that ruler goes red and this file is not where the fix belongs.
 *
 * NO PATTERNS OR LENGTHS RESTATED. The id shape, the method-name shape, the
 * `requires` bounds, the version bounds and the schema version are the kernel's;
 * every entry below is funnelled through `parseProviderRegistration` +
 * `registerProvider`, so a draft this product writes is accepted or refused by
 * the same validator the iterate side runs. A local regex here would be a second
 * source of truth about the shape, which is the failure the contract exists to
 * prevent.
 */
import { InstallationVersion } from "@opencode-ai/core/installation/version"

// Subpath imports only, never the `iterate-kernel` barrel — same product
// requirement as the long note in `kernel.ts`: the barrel pulls `schemas`, which
// reads `../schemas/*.json` at module init, a path that does not exist next to the
// esbuild bundle. `test/tool/glasspane-provider-registration.test.ts` pins this
// shape for THIS file too, because the rule was written for one doorway and the
// doorway is now two files.
import { KernelSchemaError } from "iterate-kernel/errors"
import { parseProviderRegistration } from "iterate-kernel/parse"
import {
  PROVIDER_CODES,
  PROVIDER_SCHEMA_VERSION,
  KernelProviderError,
  emptyProviderRegistry,
  providerIdsInCommon,
  registerProvider,
  requireMethod,
  resolveProvider,
} from "iterate-kernel/provider-registration"
import type { ProviderMethod, ProviderRegistry, ProviderRegistration } from "iterate-kernel/provider-registration"

import type { KernelRejection } from "./kernel"

/**
 * The registry functions, re-exported rather than imported by each consumer.
 *
 * This module is the fork's second kernel doorway, and `kernel.ts` already sets the
 * precedent for this (`outcomeOf`/`summaryOf`/`entryHashOf` have no `src/` consumer —
 * they exist so a test can pin the binding through the doorway rather than by
 * reaching past it). A test that imports `iterate-kernel/provider-registration`
 * directly proves nothing about whether the product's import shape survives the
 * bundle; only a re-export can be pinned.
 */
export {
  KernelProviderError,
  KernelSchemaError,
  PROVIDER_CODES,
  PROVIDER_SCHEMA_VERSION,
  emptyProviderRegistry,
  parseProviderRegistration,
  providerIdsInCommon,
  registerProvider,
  requireMethod,
  resolveProvider,
}
export type { ProviderMethod, ProviderRegistry, ProviderRegistration }

/** The two producers GlassPane actually ships, named so a typo cannot invent a third. */
export const GLASSPANE_AE_PROVIDER_ID = "glasspane-engine-ae"
export const GLASSPANE_EVIDENCE_PROVIDER_ID = "glasspane-evidence"

/** The engine method the diagnosis verdict is transcribed from (`Dispatcher`'s `diagnose`). */
export const GLASSPANE_DIAGNOSE_METHOD = "diagnose"

/**
 * A registration before the kernel has said anything about it.
 *
 * Deliberately loose (`unknown` values, no `ProviderRegistration` type): typing the
 * drafts with the kernel's own output type would let the TypeScript compiler be the
 * only validator, and the contract being certified here is the runtime one — the
 * same one a Python or Swift consumer reproduces from
 * `fixtures/provider-registration.ok-01.json`. A missing `requires` must be refused
 * by the kernel, not prevented by an editor.
 */
export type ProviderDraft = { readonly [key: string]: unknown }

/**
 * The two registrations, as data.
 *
 * THE VERSION IS PASSED IN, AND THAT IS THE POINT. `kernel/fixtures/provider-registration.ok-01.json`
 * carries `1.11.0` in every entry, and it is worth being exact about what that
 * string is: the fixture's own comment says "the package/engine versions at the time
 * of writing" — the *kernel corpus's* version, of the *engine*, on the day the corpus
 * was authored. Copying it into a GlassPane registration would certify that this
 * product ships a version it never measured, and the registration's whole purpose is
 * to be a claim another harness can rely on. So the version arrives from the caller,
 * and the caller takes it from `InstallationVersion` below — the same value
 * `packages/opencode/src/index.ts` hands to yargs' `.version(...)`, i.e. the string
 * `glasspane-harness --version` prints, burned at build time from
 * `product.json` (`script/build.ts`: `OPENCODE_VERSION: '<Script.version>'`).
 *
 * The `requires` names are not invented here either: they are the evidence-pack
 * contract's own signal vocabulary (`SignalsSchema` keys rendered kebab-case), which
 * is what the fixture says they are. `last-evidence`'s empty list is a claim — "this
 * method needs no prerequisite signal" — and it is written as `[]` rather than
 * omitted, because the contract treats the two as different statements.
 */
export function glasspaneProviderDrafts(version: string): readonly ProviderDraft[] {
  return [
    {
      schemaVersion: PROVIDER_SCHEMA_VERSION,
      id: GLASSPANE_AE_PROVIDER_ID,
      kind: "ae-diagnosis",
      version,
      origin: "glasspane",
      methods: [
        { name: "diagnose", requires: ["ax-event", "attribution", "circuit-breaker"] },
        { name: "diagnose-pixel", requires: ["ax-event", "pixel-diff", "attribution", "circuit-breaker"] },
        { name: "diagnose-probed", requires: ["ax-event", "handler-probe", "state-diff", "attribution"] },
      ],
    },
    {
      schemaVersion: PROVIDER_SCHEMA_VERSION,
      id: GLASSPANE_EVIDENCE_PROVIDER_ID,
      kind: "evidence-source",
      version,
      origin: "glasspane",
      methods: [
        { name: "capture", requires: ["ax-tree"] },
        { name: "last-evidence", requires: [] },
      ],
    },
  ]
}

/**
 * GlassPane's registry: both producers, each validated and added by the kernel.
 *
 * `parseProviderRegistration` then `registerProvider` is not double work — the two
 * refuse different things. The parse step is the record-level contract (shape,
 * bounds, name-level uniqueness inside one registration), and `registerProvider`
 * owns the registry-level semantics: an id already present is refused rather than
 * overwritten, and the registry comes back replaced whole instead of mutated, so a
 * refused registration leaves the previous one exactly as it was.
 */
export function glasspaneProviderRegistry(version: string): ProviderRegistry {
  return glasspaneProviderDrafts(version).reduce<ProviderRegistry>(
    (registry, draft) => registerProvider(registry, parseProviderRegistration(draft)),
    emptyProviderRegistry(),
  )
}

/**
 * Ask the AE provider for one method, by name.
 *
 * The provider id is spelled out on purpose. `resolveProvider` has no default, no
 * fuzzy match and no "the only one registered, so it must be that one" — that last
 * convenience is precisely what this contract forbids, because it turns a second
 * registration (a plugin's AE provider, a renamed one) into a silent change of
 * which judgement the word "the AE provider" means. Asking for a method the provider
 * does not declare propagates the kernel's `KERNEL_E_PROVIDER_METHOD`, whose remedy
 * names what it DOES offer, so the caller learns the real method table rather than a
 * guessed one.
 */
export function requireDiagnoseMethod(registry: ProviderRegistry, method: string): ProviderMethod {
  return requireMethod(registry, GLASSPANE_AE_PROVIDER_ID, method)
}

/** What a verdict is attributed to: the registered id, its version, and the declared method. */
export interface ProviderAttribution {
  readonly id: string
  readonly version: string
  readonly method: string
  readonly requires: readonly string[]
}

/**
 * The non-throwing form the tool surface uses.
 *
 * The refusal is not caught and defaulted — it is turned into this repository's
 * existing three-field shape (`code`/`message`/`remedy`) with the kernel's own words
 * kept, so a verdict attributed to a method nobody registered cannot be transcribed
 * and the reader is told which methods actually are.
 *
 * `version` defaults to `InstallationVersion`, the product's real version source
 * (see `glasspaneProviderDrafts`), so no caller has to be remembered to pass it;
 * passing one explicitly is how a test pins the same claim from the other side.
 */
export function diagnoseAttribution(
  method: string = GLASSPANE_DIAGNOSE_METHOD,
  version: string = InstallationVersion,
): { ok: true; provider: ProviderAttribution } | { ok: false; error: KernelRejection } {
  try {
    const registry = glasspaneProviderRegistry(version)
    const declared = requireDiagnoseMethod(registry, method)
    const provider = resolveProvider(registry, GLASSPANE_AE_PROVIDER_ID)
    return {
      ok: true,
      provider: {
        id: provider.id,
        version: provider.version,
        method: declared.name,
        requires: declared.requires,
      },
    }
  } catch (error) {
    if (error instanceof KernelProviderError) {
      return {
        ok: false,
        error: { code: error.code, message: error.message, remedy: error.remedy },
      }
    }
    if (error instanceof KernelSchemaError) {
      return {
        ok: false,
        error: {
          code: error.code,
          message: `${error.message} — the kernel refused a registration this product writes itself`,
          remedy:
            "fix the registration in src/tool/glasspane/providers.ts; it is the contract both harnesses read, so it cannot be relaxed at a call site — run bun run script/kernel-conformance.mjs and compare against kernel/fixtures/provider-registration.ok-01.json",
        },
      }
    }
    throw error
  }
}
