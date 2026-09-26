/**
 * Canonical JSON serialization: object keys sorted, no insignificant
 * whitespace. Mirrors the cross-language convention used by the kernel C35
 * roundtrips so engine results and evidence packs stay byte-stable.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortKeys(entry));
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    // Null-prototype on purpose. A literal `{}` inherits the `__proto__` setter,
    // so `sorted["__proto__"] = …` — which is what an object parsed from the wire
    // with that key asks for — reassigns the prototype instead of writing a
    // member, and the entry silently vanishes from the canonical form. This
    // function serialises every outbound stdio frame and the raw daemon replies
    // the agent is shown (`tools.ts`), so a dropped member is data the agent is
    // told does not exist. `Object.create(null)` has no inherited setter, so the
    // key is written like any other, and `JSON.stringify` reads only own
    // enumerable properties — the bytes are otherwise identical (pinned in
    // `test/canonical.test.mjs` against the daemon's own writer,
    // `engine/Sources/GlassPaneEngine/CanonicalJSON.swift`, which treats the key
    // as an ordinary dictionary entry).
    const sorted: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortKeys(record[key]);
    }
    return sorted;
  }
  return value;
}