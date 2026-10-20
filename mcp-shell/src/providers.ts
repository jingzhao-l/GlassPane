/**
 * providers.ts — 面 A's half of the kernel's provider-registration contract
 * (specs §8.5 / R40 scenario ⑤: "a judgement producer registers once, and both
 * harnesses consume it through the same shape").
 *
 * WHY THIS FILE EXISTS. The fork registered its producers in
 * `packages/opencode/src/tool/glasspane/providers.ts`; the MCP shell — the surface an
 * agent actually calls, and the artifact that ships as `glasspane-mcp` — registered
 * nothing. A registration is a claim another harness is allowed to rely on, so a
 * product whose second surface says nothing about who produces its verdicts leaves
 * half the contract unimplemented while the corpus still reads green.
 *
 * WHAT IS NOT DECIDED HERE, and that is the load-bearing part. A registration is
 * metadata: who provides what, and what it needs to do it. Nothing in this file
 * compares a signal, weighs a threshold, or produces a verdict — the verdict stays
 * where it already is, in the daemon's reply, which `tools.ts` transcribes byte for
 * byte. Asking which *declared method* a call is attributed to is a registry query,
 * and the kernel's own `requireMethod` answers it. That distinction is what keeps
 * this file inside `harness/tools/surface-semantics.mjs`; if a later change makes
 * this surface judge evidence, that ruler goes red and this file is not where the
 * fix belongs.
 *
 * NO PATTERNS OR LENGTHS RESTATED. The id shape, the method-name shape, the
 * `requires` bounds, the version bounds and the schema version are the kernel's.
 * Every entry below is funnelled through `parseProviderRegistration` +
 * `registerProvider`, so a draft this product writes is accepted or refused by the
 * same validator the iterate side runs. A local regex here would be a second source
 * of truth about the shape — the failure the contract exists to prevent.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Subpath imports, never the `iterate-kernel` barrel — the same rule `tools.ts`
// states at its own import block, and for the same reason: the barrel re-exports
// `schemas`, which reads the corpus JSON files at module init, a path that does not
// exist next to the esbuild bundle this package ships as. `test/providers.test.mjs`
// pins the shape for THIS file too; a rule written for one doorway is worthless once
// the doorway is two files.
//
// This comment deliberately does not spell the corpus path with a glob: a star right
// after a slash is a block-comment opener to the two strippers that read this file
// (`executableSource` in the tests, `stripComments` in `harness/tools/surface-semantics.mjs`),
// and the early close it writes eats the import block underneath it — a doorway guard
// that pinned nothing would have looked exactly like this file passing.
import { KernelSchemaError } from "iterate-kernel/errors";
import { parseProviderRegistration } from "iterate-kernel/parse";
import {
  PROVIDER_CODES,
  PROVIDER_ID_MAX_LENGTH,
  PROVIDER_SCHEMA_VERSION,
  KernelProviderError,
  emptyProviderRegistry,
  providerIdsInCommon,
  registerProvider,
  requireMethod,
  resolveProvider,
} from "iterate-kernel/provider-registration";
import type { ProviderMethod, ProviderRegistry, ProviderRegistration } from "iterate-kernel/provider-registration";

import { GP_E_INTERNAL } from "./errors.js";

/**
 * The registry surface, re-exported rather than imported by each consumer.
 *
 * This module is 面 A's second kernel doorway, and `tools.ts` already sets the
 * precedent for the pattern (its kernel imports are the doorway a test can reach).
 * A test that imports `iterate-kernel/provider-registration` directly proves nothing
 * about whether *this* file's import shape survives the bundle; only a re-export can
 * be pinned.
 */
export {
  KernelProviderError,
  KernelSchemaError,
  PROVIDER_CODES,
  PROVIDER_ID_MAX_LENGTH,
  PROVIDER_SCHEMA_VERSION,
  emptyProviderRegistry,
  parseProviderRegistration,
  providerIdsInCommon,
  registerProvider,
  requireMethod,
  resolveProvider,
};
export type { ProviderMethod, ProviderRegistry, ProviderRegistration };

/** The two producers 面 A ships, named so a typo cannot invent a third. */
export const GLASSPANE_AE_PROVIDER_ID = "glasspane-engine-ae";
export const GLASSPANE_EVIDENCE_PROVIDER_ID = "glasspane-evidence";

/**
 * The name this package's manifest carries. Read rather than assumed: the version
 * below comes out of that manifest, and a manifest belonging to somebody else (a
 * host that vendored this build into its own package directory) must not be able to
 * pass itself off as the product's version.
 */
const MANIFEST_NAME = "glasspane-mcp";

/** `undefined` = never tried; `null` = tried and could not be read. */
let cachedProductVersion: string | null | undefined;

/**
 * Where this build looks for its own manifest: beside the `dist/` it ships in.
 *
 * Both layouts agree on that. The `tsc` output sits at `mcp-shell/dist/x.js` and the
 * esbuild bundle at `dist/index.js`, so `../package.json` is the package root either
 * way; a scratch tree without one is exactly the case {@link shellProductVersion}
 * refuses instead of guessing about.
 */
export function shellManifestPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
}

/**
 * The version `glasspane-mcp` really reports, or `null` when this build cannot read it.
 *
 * This is the registration's only version source: the `version` field of this
 * package's own manifest, resolved at runtime from this module's location — the same
 * string the shell hands to the daemon's `hello` identity and answers in
 * `initialize`'s `serverInfo` (`dispatch.ts`'s `SERVER_INFO`), and the equality of
 * those three is pinned by `test/providers.test.mjs`. A version literal written into a
 * registration would be a claim this surface never measured; `kernel/fixtures/
 * provider-registration.ok-01.json` carries `1.11.0` in every entry because that was
 * the corpus's engine version the day it was authored, and copying it here would
 * certify a release this product never shipped.
 */
export function shellProductVersion(): string | null {
  if (cachedProductVersion === undefined) {
    cachedProductVersion = readShellProductVersion();
  }
  return cachedProductVersion;
}

/** Re-read rather than trust the cache: how a test drives the unreadable-manifest arm. */
function readShellProductVersion(): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(shellManifestPath(), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (record.name !== MANIFEST_NAME) {
    return null;
  }
  // No shape check here on purpose: whether a version string is *legal* is the
  // kernel's rule (1..64 chars), and enforcing it twice is two sources of truth.
  return typeof record.version === "string" ? record.version : null;
}

/**
 * A registration before the kernel has said anything about it.
 *
 * Deliberately loose (`unknown` values, not the kernel's output type): typing the
 * drafts with `ProviderRegistration` would let the TypeScript compiler be the only
 * validator, and the contract being certified here is the runtime one — the same one
 * a Python or Swift consumer reproduces from the fixture. A missing `requires` must
 * be refused by the kernel, not prevented by an editor.
 */
export type ProviderDraft = { readonly [key: string]: unknown };

/**
 * The two registrations 面 A offers, as data — the fixture's `registry.glasspane`
 * half: the AE provider that declares the diagnosis, and the evidence source that
 * declares the pack.
 *
 * The method names and the `requires` names are not invented here either: they are
 * the evidence-pack contract's own signal vocabulary rendered kebab-case, and
 * `test/providers.test.mjs` compares these drafts against the shipped fixture rather
 * than against a copy of them. `last-evidence`'s empty list is a claim — "this method
 * needs no prerequisite signal" — written as `[]` rather than omitted, because the
 * contract treats the two as different statements.
 *
 * `glasspane-evidence` also declares `capture` (the daemon's `capture_view`). 面 A
 * registers it because the contract's glasspane half does, and the registration is
 * the claim; what it must not do is become a *consumer* of a capability this surface
 * only forwards an image for.
 */
export function shellProviderDrafts(version: string): readonly ProviderDraft[] {
  return [
    {
      schemaVersion: PROVIDER_SCHEMA_VERSION,
      id: GLASSPANE_AE_PROVIDER_ID,
      kind: "ae-diagnosis",
      version,
      origin: "glasspane",
      methods: [
        { name: "diagnose", requires: ["ax-event", "attribution", "circuit-breaker"] },
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
  ];
}

/**
 * 面 A's registry: both producers, each validated and added by the kernel.
 *
 * `parseProviderRegistration` then `registerProvider` is not double work — the two
 * refuse different things. The parse step is the record-level contract (shape, bounds,
 * name-level uniqueness inside one registration); `registerProvider` owns the
 * registry-level semantics: an id already present is refused rather than overwritten,
 * and the registry comes back replaced whole instead of mutated, so a refused
 * registration leaves the previous one exactly as it was.
 */
export function shellProviderRegistry(version: string): ProviderRegistry {
  return shellProviderDrafts(version).reduce<ProviderRegistry>(
    (registry, draft) => registerProvider(registry, parseProviderRegistration(draft)),
    emptyProviderRegistry(),
  );
}

/**
 * The declared AE methods a given set of prerequisite signals covers.
 *
 * Pure declaration arithmetic: the input is a set of *names*, and the only thing done
 * to them is membership against a registered provider's own `requires` lists. Nothing
 * here looks at an evidence pack, at a daemon frame, or at any value a judgement is
 * made of — which is why this can sit on the tool surface at all.
 */
export function coveredMethods(
  signals: Iterable<string>,
  registry: ProviderRegistry,
): ProviderMethod[] {
  const present = new Set<string>();
  for (const name of signals) {
    present.add(name);
  }
  const provider = resolveProvider(registry, GLASSPANE_AE_PROVIDER_ID);
  return provider.methods.filter((method) => method.requires.every((need) => present.has(need)));
}

/**
 * Which declared method a set of present signal names asks for — or `null`.
 *
 * `null` is returned in both directions of "this cannot be answered": no declared
 * method whose prerequisites are all present, and *more than one*. The second is the
 * interesting one. Two declarations covered by the same prerequisite list are two
 * names for one entitlement, and picking either would be a guess about which
 * judgement the caller is being given — the same refusal the contract makes of a
 * resolver that would "helpfully" take the only registered provider when the id it was
 * handed does not match.
 *
 * The default registry is the shipped one, built from {@link shellProductVersion}; a
 * build that cannot read its manifest gets the kernel's own refusal of an empty
 * version rather than an invented one.
 */
export function methodForSignals(
  signals: Iterable<string>,
  registry: ProviderRegistry = shellProviderRegistry(shellProductVersion() ?? ""),
): string | null {
  const covered = coveredMethods(signals, registry);
  const only = covered.length === 1 ? covered[0] : undefined;
  return only === undefined ? null : only.name;
}

/** What a verdict is attributed to: the registered id, its version, the declared method. */
export interface ProviderAttribution {
  readonly id: string;
  readonly version: string;
  readonly method: string;
  readonly requires: readonly string[];
}

/** A refusal, in this repository's existing three-field shape (`code`/`message`/`remedy`). */
export interface ProviderRefusal {
  readonly code: string;
  readonly message: string;
  readonly remedy: string;
}

/**
 * The three answers the surface can get, kept apart because they are three different
 * sentences to an agent: "this call is not a judgement 面 A registers" is not
 * "this call is refused", and neither is a verdict.
 */
export type CapabilityAnswer =
  | { readonly status: "not-claimed" }
  | { readonly status: "ok"; readonly provider: ProviderAttribution }
  | { readonly status: "refused"; readonly error: ProviderRefusal };

/**
 * A daemon method 面 A forwards that one of its providers *declares*.
 *
 * The correspondence (wire name `diagnose` → provider method `diagnose`) is written
 * out rather than derived by `_`→`-` substitution, because a rule that renames one
 * side is a rule the fixture does not carry, and `test/providers.test.mjs` checks
 * every pair here against the shipped contract instead.
 *
 * Deliberately absent: `last_evidence`, whose provider method `last-evidence` really
 * is declared. The registration claims it; the *consumer* seam is the reply that is a
 * verdict, and 面 A has exactly one. Widening this table is the step a later round
 * takes with its own ruler, not a step to take by accretion here.
 */
const CAPABILITY_CLAIMS: readonly CapabilityClaim[] = [
  { engineMethod: "diagnose", providerId: GLASSPANE_AE_PROVIDER_ID, method: "diagnose" },
];

export interface CapabilityClaim {
  readonly engineMethod: string;
  readonly providerId: string;
  readonly method: string;
}

/** The engine methods this surface claims a registered producer for, in declaration order. */
export const CLAIMED_ENGINE_METHODS: readonly string[] = CAPABILITY_CLAIMS.map((claim) => claim.engineMethod);

/** The claim for a daemon method, or `null` when the registry says nothing about it. */
export function claimForEngineMethod(engineMethod: string): CapabilityClaim | null {
  const found = CAPABILITY_CLAIMS.filter((claim) => claim.engineMethod === engineMethod);
  const only = found.length === 1 ? found[0] : undefined;
  return only === undefined ? null : only;
}

/**
 * The consumer half: which registered producer does this forwarded call belong to?
 *
 * Refuses rather than defaults, in every arm:
 *   - no version readable from this build's own manifest → refuse (naming the path it
 *     looked at); stating a version the product never measured is worse than not
 *     answering, because the whole point of the registration is to be relied on;
 *   - a method the named provider does not declare → the kernel's
 *     `KERNEL_E_PROVIDER_METHOD`, whose remedy names what *is* declared;
 *   - a prerequisite list covering more than one declaration → refuse and name them;
 *   - a registration the kernel itself will not accept → refuse with its schema code
 *     and the path back to the corpus, because these bytes are this product's own and
 *     a call site must never be where the contract gets relaxed;
 *   - anything else → rethrow. An unexpected fault is not dressed up as a refusal.
 *
 * `registry` and `version` are optional so a test can pin the same refusals from the
 * other side — a registry with one declaration removed, or a version the kernel will
 * not accept — without touching this build's manifest. Production calls pass only the
 * engine method, which is the arm that reads the version for real.
 */
export function attributeCapability(
  engineMethod: string,
  registry?: ProviderRegistry,
  version?: string,
): CapabilityAnswer {
  const claim = claimForEngineMethod(engineMethod);
  if (claim === null) {
    return { status: "not-claimed" };
  }
  let target = registry;
  let stated = version;
  if (target === undefined && stated === undefined) {
    const read = shellProductVersion();
    if (read === null) {
      return { status: "refused", error: versionUnavailable(claim) };
    }
    stated = read;
  }
  try {
    if (target === undefined) {
      target = shellProviderRegistry(stated ?? "");
    }
    const declared = requireMethod(target, claim.providerId, claim.method);
    const provider = resolveProvider(target, claim.providerId);
    const covered = coveredMethods(declared.requires, target);
    const only = covered.length === 1 ? covered[0] : undefined;
    if (only === undefined || only.name !== claim.method) {
      return { status: "refused", error: coverageAmbiguous(claim, covered) };
    }
    return {
      status: "ok",
      provider: {
        id: provider.id,
        version: provider.version,
        method: declared.name,
        requires: declared.requires,
      },
    };
  } catch (error) {
    if (error instanceof KernelProviderError) {
      return { status: "refused", error: { code: error.code, message: error.message, remedy: error.remedy } };
    }
    if (error instanceof KernelSchemaError) {
      return {
        status: "refused",
        error: {
          code: error.code,
          message: `${error.message} — the kernel refused a registration this product writes itself`,
          remedy: "fix shellProviderDrafts in mcp-shell/src/providers.ts; it is the contract both harnesses read, "
            + "so it cannot be relaxed at a call site — run node scripts/check-kernel-corpus.mjs and compare "
            + "against kernel/fixtures/provider-registration.ok-01.json",
        },
      };
    }
    throw error;
  }
}

/**
 * The one line 面 A adds to a forwarded judgement: who is being trusted for it.
 *
 * Appended as its own content item, never folded into the daemon's JSON, because the
 * reply an agent parses has to stay byte-identical (the same rule `tools.ts` already
 * follows for the update-state block and the stdout-backlog note).
 */
export function providerAttributionLine(attributed: ProviderAttribution): string {
  const needs = attributed.requires.length > 0 ? attributed.requires.join(", ") : "none";
  return `provider: ${attributed.id} version ${attributed.version} method ${attributed.method}`
    + ` | declared prerequisites: ${needs}`
    + " | the verdict above is the engine's, transcribed unchanged; this line names the registered producer"
    + " this surface attributes it to, from the kernel's provider-registration contract";
}

/** The kernel's own words, kept, for a manifest this build cannot read. */
function versionUnavailable(claim: CapabilityClaim): ProviderRefusal {
  return {
    code: GP_E_INTERNAL,
    message: `this build cannot name the version of the provider that declares '${claim.method}': no readable`
      + ` ${MANIFEST_NAME} manifest at ${shellManifestPath()}`,
    remedy: "run glasspane-mcp from a package directory that carries its own manifest — the registration's"
      + ` version is the string this shell reports in 'initialize' serverInfo and in the daemon's hello, and`
      + " this surface refuses to state a version it has not read rather than attribute a verdict to a"
      + " producer it invented",
  };
}

/** The refusal for a prerequisite list that names more than one declaration (or none). */
function coverageAmbiguous(claim: CapabilityClaim, covered: readonly ProviderMethod[]): ProviderRefusal {
  const names = covered.map((method) => method.name).join(", ");
  return {
    code: GP_E_INTERNAL,
    message: `the prerequisites declared for '${claim.method}' cover ${covered.length === 0 ? "no" : `${covered.length} parallel`}`
      + ` method${covered.length === 1 ? "" : "s"} of provider ${claim.providerId}${names === "" ? "" : ` (${names})`}`,
    remedy: "give each declared method a prerequisite list that tells it apart from the others, or ask for the"
      + " method by the one name the contract distinguishes — naming a verdict's producer by guessing which"
      + " of two indistinguishable declarations ran is the default resolution this contract forbids",
  };
}
