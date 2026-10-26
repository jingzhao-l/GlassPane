import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { parseRegistryMetadata, provenanceFromMetadata } from "../../script/provenance-verdict"

/**
 * Fixed points for the provenance assertion in the release lane.
 *
 * The lane used to print a note found by `/\bprovenance\b/` over the whole metadata blob, which had
 * two ways to be wrong at once: the word is a KEY NAME npm writes even when no attestation follows
 * it, and a note cannot fail a release, so a version published against the product's own
 * publishPolicy passed. `provenance-from-metadata` reads the field; these tests are the proof that
 * the reading is the field and not the string.
 *
 * The positive fixture is the shape measured on the live registry for the published wrapper
 * (`dist.attestations.provenance.predicateType = https://slsa.dev/provenance/v1`, same document
 * reachable at `…/-/npm/v1/attestations/glasspane-harness@0.11.1`), not a shape invented to agree
 * with the implementation.
 */
const MEASURED = {
  name: "glasspane-harness",
  version: "0.11.1",
  dist: {
    integrity: "sha512-…=",
    shasum: "c63f3191…",
    attestations: {
      url: "https://registry.npmjs.org/-/npm/v1/attestations/glasspane-harness@0.11.1",
      provenance: { predicateType: "https://slsa.dev/provenance/v1" },
    },
  },
}

describe("the registry document that does carry an attestation", () => {
  test("reads the predicate type it measured", () => {
    const answer = provenanceFromMetadata(MEASURED)
    expect(answer.state).toBe("attested")
    if (answer.state !== "attested") return
    expect(answer.predicateType).toBe("https://slsa.dev/provenance/v1")
  })

  test("and a non-provenance predicate named `provenance` nowhere still reads as attested only when the predicate says so", () => {
    const answer = provenanceFromMetadata({
      dist: { attestations: { dsse: { predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1" } } },
    })
    expect(answer.state).toBe("absent")
    if (answer.state !== "absent") return
    expect(answer.seen).toContain("none of them a provenance attestation")
  })
})

describe("the documents that must NOT read as attested", () => {
  test("the old text probe's own false positive: the word appears, no attestation is behind it", () => {
    // This is the exact shape the removed regex accepted: a metadata document whose npm-internal
    // key name contains "provenance" (here, an empty attestations object plus a field literally
    // named provenance=false). The note printed "the registry lists a provenance attestation".
    const hostile = { dist: { attestations: {}, provenance: false }, _npmVersion: "12.2.0" }
    expect(JSON.stringify(hostile)).toContain("provenance")
    const answer = provenanceFromMetadata(hostile)
    expect(answer.state).toBe("absent")
    if (answer.state !== "absent") return
    expect(answer.seen).toContain("no attestation records")
  })

  test("a dist with no attestations object at all", () => {
    const answer = provenanceFromMetadata({ dist: { integrity: "sha512-…=", shasum: "abc" } })
    expect(answer.state).toBe("absent")
    if (answer.state !== "absent") return
    expect(answer.seen).toContain("carries no attestations object")
  })

  test("a document with no dist at all — the registry answered, and it answered about nothing", () => {
    const answer = provenanceFromMetadata({ name: "glasspane-harness" })
    expect(answer.state).toBe("absent")
    if (answer.state !== "absent") return
    expect(answer.seen).toContain("no dist object")
  })

  test("an array or a string where the object should be is absent, never a crash", () => {
    expect(provenanceFromMetadata({ dist: { attestations: [] } }).state).toBe("absent")
    expect(provenanceFromMetadata("attested").state).toBe("absent")
    expect(provenanceFromMetadata(null).state).toBe("absent")
  })
})

describe("the transport answer stays separate from the artifact answer", () => {
  test("a re-signed proxy page is not JSON, and parsing says so instead of concluding", () => {
    expect(parseRegistryMetadata("<!doctype html><html>…")).toBeNull()
    expect(parseRegistryMetadata("{\"dist\":{\"attestations\":{\"provenance\":{\"predicateType\":\"https://slsa.dev/provenance/v1\"}}}}")).not.toBeNull()
  })

  test("and the verdict is driven off the parsed document, not off a substring of the raw text", () => {
    const raw = JSON.stringify(MEASURED)
    const parsed = parseRegistryMetadata(raw)
    if (parsed === null) throw new Error("fixture is not JSON")
    expect(provenanceFromMetadata(parsed).state).toBe("attested")
  })
})

describe("the release lane actually consumes this verdict", () => {
  const script = readFileSync(new URL("../../script/verify-published.ts", import.meta.url), "utf8")
  // Comments carry the old string on purpose — they describe what was replaced. A pin that read them
  // would report the defect as still present, so they go before the scan.
  const code = script.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")

  test("the note that could not fail anything is gone from the executable text", () => {
    expect(code).not.toContain(/\\bprovenance\\b/.source)
    expect(code).not.toMatch(/console\.log\([^)]*note: the registry lists/)
  })

  test("the check is asserted through the verdict module", () => {
    expect(code).toContain("provenanceFromMetadata(")
    expect(code).toContain("parseRegistryMetadata(")
    expect(code).toContain('const label = "the published wrapper carries a provenance attestation"')
    // Three outcomes, each routed differently: attested → pass, absent → fail, unaskable → NOT OBSERVED.
    expect(code).toMatch(/if \(read\.state === "unaskable"\)[\s\S]{0,200}cannotObserve\(label/)
    expect(code).toMatch(/check\(label, false[\s\S]{0,120}publishPolicy/)
  })
})
