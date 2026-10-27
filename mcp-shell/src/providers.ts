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
 * reports as unreadable.
 */
export function shellManifestPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
}

/**
 * The version *this shell* carries, or `null` when this build cannot read it.
 *
 * This is the shell's own measurement, from the manifest beside the `dist/` it ships in,
 * and it is the string this shell sends as its `hello` identity and answers in
 * `initialize`'s `serverInfo` (`dispatch.ts`'s `SERVER_INFO`). It is **not** the version a
 * verdict is attributed to: the verdict an agent is given came out of the *daemon's*
 * build, and that build advertises its own version in `hello`, which
 * `engine-client.ts` stores and `attributeCapability` states. Equating the two was the
 * defect — on a machine whose app bundle is older than the shell, the agent was told the
 * verdict came from a build that did not produce it.
 *
 * It is also no longer a hard dependency for answering a call: a relocated `dist/` with
 * no manifest above it leaves this `null`, the shell still forwards, and the attribution
 * says the shell's own version is unreadable instead of refusing the diagnosis.
 *
 * A version literal written into a registration would be a claim this surface never
 * measured; `kernel/fixtures/provider-registration.ok-01.json` carries `1.11.0` in every
 * entry because that was the corpus's engine version the day it was authored, and copying
 * it here would certify a release this product never shipped.
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
 * THE REGISTRY IS NOT DEFAULTED. This used to default it to
 * `shellProviderRegistry(shellProductVersion() ?? "")`, and that default arm was a trap:
 * a build that could not read its manifest got a `KernelSchemaError` thrown out of a
 * default argument, bypassing the three-field `{code, message, remedy}` shape every other
 * arm of this file keeps. Every caller now names the registry it means, and an omitted
 * one is refused by the guard below with the sentence that says so rather than by the
 * kernel's schema error.
 */
export function methodForSignals(
  signals: Iterable<string>,
  registry: ProviderRegistry | undefined,
): string | null {
  if (registry === undefined) {
    throw new TypeError(
      "methodForSignals takes an explicit ProviderRegistry — build one with shellProviderRegistry(<measured version>). "
      + "The old default arm threw the kernel's schema error for any build that could not read its manifest, which is "
      + "the throw this file's three-field refusal shape exists to avoid.",
    );
  }
  const covered = coveredMethods(signals, registry);
  const only = covered.length === 1 ? covered[0] : undefined;
  return only === undefined ? null : only.name;
}

/** What a verdict is attributed to: the registered id, its version, the declared method. */
export interface ProviderAttribution {
  readonly id: string;
  /**
   * The producer's version as measured from its own `hello` reply, or `null` when this
   * connection has not read one. Nothing that was not measured is stated here.
   */
  readonly version: string | null;
  readonly method: string;
  readonly requires: readonly string[];
  /**
   * What was and was not measured about versions on this call, in one sentence the
   * surface is allowed to print: whose `hello` was read, and whether this build can read
   * its own manifest.
   */
  readonly versionNote: string;
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
 * What the caller hands the consumer seam, all of it measurements it made itself.
 *
 * `producerVersion` is the version the daemon named in its own `hello`, read through
 * `EngineJsonRpcClient.reportedEngineVersion` (the HTTP surface reads the same value off
 * its client); `null`/absent means no handshake has answered one yet. `shellVersion` and
 * `registry` exist so a test can pin the refusals from the other side without touching
 * this build's manifest; production calls pass the measurement and nothing else.
 */
export interface CapabilityQuery {
  readonly registry?: ProviderRegistry;
  readonly producerVersion?: string | null;
  readonly shellVersion?: string | null;
}

/**
 * The consumer half: which registered producer does this forwarded call belong to?
 *
 * Refuses rather than defaults, in every arm:
 *   - a method the named provider does not declare → the kernel's
 *     `KERNEL_E_PROVIDER_METHOD`, whose remedy names what *is* declared;
 *   - a prerequisite list covering more than one declaration → refuse and name them;
 *   - a registration the kernel itself will not accept → refuse with its schema code,
 *     naming which measurement the registration was built from, because these bytes are
 *     this product's own and a call site must never be where the contract gets relaxed;
 *   - anything else → rethrow. An unexpected fault is not dressed up as a refusal.
 *
 * An unreadable manifest is **not** one of those arms. The version a verdict is
 * attributed to is the producer's, measured from its `hello`; this build's own version is
 * a second, separate fact, and when it cannot be read the answer says so plainly instead
 * of refusing a call the healthy daemon is perfectly able to answer. When *neither* is
 * measurable, the registration is still built — from {@link UNSTATED_REGISTRATION_VERSION}
 * — so the kernel's declaration check keeps running, and the visible version stays `null`:
 * the placeholder names nothing an agent is told.
 */
export function attributeCapability(engineMethod: string, query: CapabilityQuery = {}): CapabilityAnswer {
  const claim = claimForEngineMethod(engineMethod);
  if (claim === null) {
    return { status: "not-claimed" };
  }
  const measured = typeof query.producerVersion === "string" && query.producerVersion.trim() !== ""
    ? query.producerVersion.trim()
    : null;
  const own = query.shellVersion === undefined ? shellProductVersion() : query.shellVersion;
  const usable = (value: string | null): string | null =>
    (value !== null && value.trim() !== "" ? value.trim() : null);
  const registrationVersion = measured ?? usable(own) ?? UNSTATED_REGISTRATION_VERSION;
  let target = query.registry;
  try {
    if (target === undefined) {
      target = shellProviderRegistry(registrationVersion);
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
        // Never `provider.version`: that field is whatever the registration was built
        // with, which can be the placeholder. The version an agent is told is the one the
        // producer itself reported.
        id: provider.id,
        version: measured,
        method: declared.name,
        requires: declared.requires,
        versionNote: versionNote(measured, usable(own)),
      },
    };
  } catch (error) {
    // Both classes below are the KERNEL's vocabulary (`KERNEL_E_*`), and this value is
    // about to become an agent-facing tool error frame. The contract this repository
    // enforces on that surface is one code family — `GP_E_*`, authored only in
    // `errors.ts` — so the kernel's name is carried in the message (never dropped: it
    // is the precise fault an integrator needs) while the `code` field answers in the
    // language the caller is parsing. Finding B2, 2026-10-27: forwarding the raw
    // `KERNEL_E_*` here made the frame unparseable by anyone holding the published
    // code table, and the HTTP twin mapped it through the `default` arm to a 422.
    if (error instanceof KernelProviderError) {
      return {
        status: "refused",
        error: {
          code: GP_E_INTERNAL,
          message: `provider registration refused (${error.code}): ${error.message}`,
          remedy: error.remedy,
        },
      };
    }
    if (error instanceof KernelSchemaError) {
      return {
        status: "refused",
        error: {
          code: GP_E_INTERNAL,
          message: `the kernel refused a registration this product writes itself (${error.code}): `
            + `${error.message} — built with the version from ${registrationVersionSource(measured, usable(own))}`,
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
 * The version slot of a registration when neither the producer nor this build reports one.
 *
 * The kernel's shape needs a non-empty `version` string to accept the registration at all,
 * and the declaration check that refuses an undeclared capability before the frame reaches
 * the daemon runs against that registration — so it is filled with this named constant,
 * never with an invented release number, and never surfaced: `attributeCapability` reports
 * the measured producer version (here `null`) and `providerAttributionLine` prints
 * "version unmeasured" for that. Redden the arm by changing the value it reports, not by
 * making this string printable.
 */
export const UNSTATED_REGISTRATION_VERSION = "unmeasured-registration-placeholder";

/** Which measurement the refused registration was built from, named in the refusal. */
function registrationVersionSource(measured: string | null, own: string | null): string {
  if (measured !== null) {
    return "the daemon's own hello self-report";
  }
  return own === null
    ? `the ${MANIFEST_NAME} manifest this build cannot read at ${shellManifestPath()}`
    : "this build's own manifest";
}

/**
 * The one line 面 A adds to a forwarded judgement: who is being trusted for it.
 *
 * Appended as its own content item, never folded into the daemon's JSON, because the
 * reply an agent parses has to stay byte-identical (the same rule `tools.ts` already
 * follows for the update-state block and the stdout-backlog note). The HTTP surface
 * renders the *same* string, as the envelope's `attribution` key — two doorways, one
 * provenance answer.
 *
 * The version clause states only a measurement: the daemon's own `hello` self-report, or
 * "version unmeasured" when this connection has not read one.
 */
export function providerAttributionLine(attributed: ProviderAttribution): string {
  const needs = attributed.requires.length > 0 ? attributed.requires.join(", ") : "none";
  const version = attributed.version === null ? "version unmeasured" : `version ${attributed.version}`;
  return `provider: ${attributed.id} ${version} method ${attributed.method}`
    + ` | declared prerequisites: ${needs}`
    + ` | ${attributed.versionNote}`
    + " | the verdict above is the engine's, transcribed unchanged; this line names the registered producer"
    + " this surface attributes it to, from the kernel's provider-registration contract";
}

/**
 * What this surface can and cannot say about versions on this call.
 *
 * Two separate facts, because they are two separate measurements: whose version was read,
 * and whether this build can read its own manifest. The second is why a relocated `dist/`
 * no longer refuses a diagnosis — it is said out loud here, beside the answer, and the
 * call still goes through.
 */
function versionNote(measured: string | null, own: string | null): string {
  const producer = measured === null
    ? "the producer's version is unmeasured: no daemon hello handshake has been answered on this connection, so this line states no version"
    : "the producer's version is the daemon's own hello self-report, read on this connection";
  return own === null
    ? `${producer}; this build cannot read its own ${MANIFEST_NAME} manifest at ${shellManifestPath()}, so it states no version of itself either`
    : producer;
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
