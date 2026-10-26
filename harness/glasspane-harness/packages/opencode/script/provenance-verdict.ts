/**
 * Did the registry record a provenance attestation for the version we just verified?
 *
 * `verify-published.ts` used to answer this by printing a note found from `/\bprovenance\b/` over
 * the whole `npm view --json` blob. Two things were wrong with that, and they compound: the string
 * `provenance` is a KEY NAME in npm's own metadata (`dist.attestations.provenance`), so the probe
 * could fire on the shape of the document rather than on an attestation being present — and being a
 * note, its answer was never allowed to fail the lane. The product's publish policy says every
 * release ships with provenance, so a version published without one was reported and then passed.
 *
 * This module reads the field. The caller keeps the three outcomes the file already uses:
 *  - `attested`  → a check that passes, and says which predicate it saw;
 *  - `absent`    → a check that FAILS: the registry answered, and what it answered was not an
 *                  attestation. This is a bad release, not a missing tool;
 *  - metadata that could not be read at all is not this function's business — `verify-published.ts`
 *    routes it to `cannotObserve()`, because "could not ask" is neither of those.
 *
 * `attestations` is read as an object with an optional `provenance` member carrying a
 * `predicateType` — the shape measured on the live registry for the published wrapper on 2026-10-26
 * (`https://registry.npmjs.org/-/npm/v1/attestations/glasspane-harness@0.11.1` answers a
 * `slsa.dev/provenance/v1` bundle, and the same document is reachable as `dist.attestations`).
 * Anything else the registry may grow (a second predicate type, a `url` only) is reported as what
 * was seen rather than guessed at, so a future npm change shows up as a named reading instead of a
 * silent pass.
 */
export type ProvenanceAnswer =
  | { readonly state: "attested"; readonly predicateType: string; readonly others: readonly string[] }
  | { readonly state: "absent"; readonly seen: string }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** Predicate types the npm registry has been observed to key attestations by. */
const KNOWN_KEYS = ["provenance", "dsse"] as const

export function provenanceFromMetadata(meta: unknown): ProvenanceAnswer {
  const dist = isRecord(meta) && isRecord(meta.dist) ? meta.dist : undefined
  const attestations = dist && isRecord(dist.attestations) ? dist.attestations : undefined
  if (!attestations) {
    return {
      state: "absent",
      seen: dist ? `dist carries no attestations object (keys: ${Object.keys(dist).join(", ") || "none"})` : "the metadata document carries no dist object",
    }
  }
  // Collected explicitly: `Object.entries(...).filter(([, v]) => isRecord(v))` leaves the tuple
  // element `unknown` to TS, and the next line would have needed a cast to read the predicate.
  const entries: [string, Record<string, unknown>][] = []
  for (const [key, value] of Object.entries(attestations)) {
    if (isRecord(value)) entries.push([key, value])
  }
  for (const [key, value] of entries) {
    const predicate = typeof value.predicateType === "string" ? value.predicateType : ""
    if (!predicate) continue
    if (predicate.includes("provenance")) {
      return { state: "attested", predicateType: predicate, others: entries.map(([k]) => k).filter((k) => k !== key) }
    }
  }
  const keys = Object.keys(attestations).join(", ") || "none"
  return {
    state: "absent",
    seen: entries.length
      ? `attestations hold predicate types ${entries.map(([, v]) => (isRecord(v) ? String(v.predicateType) : "?")).join(", ")} — none of them a provenance attestation`
      : `attestations object is present but holds no attestation records (keys: ${keys})`,
  }
}

/**
 * Parse the registry document, or answer `null` when it is not JSON at all. Kept next to the verdict
 * so the "could not ask" branch cannot be confused with "the registry said no" — the distinction is
 * the whole reason this is a check and not a note. A 200 carrying an HTML error page parses to null,
 * and that is a transport story, not a missing attestation.
 */
export const parseRegistryMetadata = (raw: string): unknown | null => {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export const KNOWN_ATTESTATION_KEYS = KNOWN_KEYS
