import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { QuestionV2 } from "@opencode-ai/core/question"

import { errorMessage } from "../../../src/util/error"
import { isToolDenial, toolDenialMarkers } from "../../../src/util/tool-denial"

/**
 * Fixed points for `src/util/tool-denial.ts`'s marker construction.
 *
 * DEFECT pinned: the question-refusal marker was built as
 * `denialMarker(questionRejected, questionRejected)` — the SAME instance passed twice, from a
 * module-level `const`. `denialMarker` exists to keep only what two independent renderings of a
 * refusal share, so that a marker stays a prefix of whatever the wire text becomes when the class
 * interpolates feedback, a ruleset or an id. Handing it one object measures nothing: the two
 * strings are equal by construction, the whole message is published as the marker, and the day
 * `QuestionV2.RejectedError` puts anything dynamic in its `get message()` the published marker
 * stops being a prefix of any real refusal — a human refusal then repaints as an ordinary call
 * error, silently. The production line now constructs two fresh instances, like the three markers
 * above it already did.
 *
 * The behavioral half below is the invariant the module publishes, and it holds for both
 * spellings TODAY because this kernel of a class has a static message — that is stated, not
 * hidden, and it is why the shape of the call sites is pinned as well: on a message that is
 * static today, only the construction rule can see the difference (see the two named controls in
 * the second and third tests, both of which go red on the reverted line).
 */

/**
 * Every class the marker list is built from, with two *independent* ways to make one.
 *
 * The payload differs on purpose wherever the class takes one, because that is the whole point of
 * the prefix: the marker has to survive a message whose tail varies. The list itself is checked
 * against the shipped source in the second test, so a fifth marker cannot be added here, and a new
 * one in `src/` cannot be left out.
 */
const refusalClasses: Array<{ name: string; primary: () => unknown; alternate: () => unknown }> = [
  { name: "PermissionV1.RejectedError", primary: () => new PermissionV1.RejectedError(), alternate: () => new PermissionV1.RejectedError() },
  {
    name: "PermissionV1.CorrectedError",
    primary: () => new PermissionV1.CorrectedError({ feedback: "a" }),
    alternate: () => new PermissionV1.CorrectedError({ feedback: "something else entirely" }),
  },
  {
    name: "PermissionV1.DeniedError",
    primary: () => new PermissionV1.DeniedError({ ruleset: "a" }),
    alternate: () => new PermissionV1.DeniedError({ ruleset: [{ permission: "bash", action: "deny" }] }),
  },
  { name: "QuestionV2.RejectedError", primary: () => new QuestionV2.RejectedError(), alternate: () => new QuestionV2.RejectedError() },
]

/** The shared beginning of two renderings — `denialMarker`'s job, restated for the control. */
function commonPrefix(a: string, b: string) {
  let end = 0
  while (end < a.length && a[end] === b[end]) end++
  return a.slice(0, end)
}

/** Balanced-paren argument splitter, so a nested `new X({ ruleset: "a" })` stays one argument. */
function argumentsOf(source: string, callee: string): string[][] {
  const sites: string[][] = []
  for (const match of source.matchAll(new RegExp(`\\b${callee}\\(`, "g"))) {
    // The declaration `function denialMarker(primary: unknown, …)` is not a call site; reading it
    // as one would put two type annotations into the assertions below and fail on the fix.
    if (/function\s*$/.test(source.slice(Math.max(0, (match.index ?? 0) - 16), match.index ?? 0))) continue
    const args: string[] = []
    let current = ""
    let depth = 1
    let quote: string | null = null
    for (let index = (match.index ?? 0) + match[0].length; index < source.length; index++) {
      const char = source[index]
      if (quote !== null) {
        current += char
        if (char === "\\") current += source[++index] ?? ""
        else if (char === quote) quote = null
        continue
      }
      if (char === '"' || char === "`" || char === "'") {
        quote = char
        current += char
        continue
      }
      if (char === "{" || char === "(" || char === "[") depth++
      else if (char === "}" || char === ")" || char === "]") {
        depth--
        if (depth === 0) {
          args.push(current)
          break
        }
      }
      if (char === "," && depth === 1) {
        args.push(current)
        current = ""
        continue
      }
      current += char
    }
    sites.push(args.map((arg) => arg.trim()))
  }
  return sites
}

describe("the refusal markers a refusal is matched by", () => {
  test("each marker is the common prefix of two independently constructed instances", () => {
    // The published property, asserted off the classes and not off the strings in `src/`: for
    // every class the marker list names, build TWO fresh instances, take what their renderings
    // share, and require the result to be one of the markers the list publishes. A marker that is
    // longer than what two real refusals share matches nothing; a marker that is shorter than the
    // shared prefix matches things that are not refusals.
    expect(refusalClasses.length).toBeGreaterThan(3)
    for (const { name, primary, alternate } of refusalClasses) {
      const first = errorMessage(primary())
      const second = errorMessage(alternate())
      const shared = commonPrefix(first, second)
      expect(shared.length, `${name} shares no text between two renderings — its marker cannot be published`).toBeGreaterThan(0)
      expect(toolDenialMarkers, `${name}: the published marker is not what two independent refusals share`).toContain(shared)
      // And the marker actually recognises a refusal nobody pre-built for it.
      expect(isToolDenial(first), `${name}: a fresh rendering is not recognised`).toBe(true)
      expect(isToolDenial(second), `${name}: a fresh rendering with different payload text is not recognised`).toBe(true)
      expect(isToolDenial(second.slice(shared.length)), `${name}: the marker leaked into an over-broad match`).toBe(false)
    }
  })

  test("every denialMarker call site constructs its two renderings separately", () => {
    // THE CONSTRUCTION RULE, and the control that goes red on the reverted line. `src/` builds each
    // marker from two instances; a site that hands the same expression twice publishes a marker
    // that was never compared against anything, and nothing else in this file can see it.
    const source = readFileSync(path.join(import.meta.dirname, "..", "..", "..", "src", "util", "tool-denial.ts"), "utf8")
    const sites = argumentsOf(source, "denialMarker")
    expect(sites.length, "no denialMarker(...) call site is readable in src/util/tool-denial.ts").toBe(refusalClasses.length)
    const constructed: string[] = []
    for (const [index, args] of sites.entries()) {
      expect(args.length, `denialMarker site ${index} does not take exactly two renderings`).toBe(2)
      const [primary, alternate] = [args[0]!, args[1]!]
      expect(
        primary,
        `denialMarker site ${index} must construct its first rendering inline with new …, not name a stored instance`,
      ).toMatch(/^new\s+[A-Za-z0-9_.]+\(/)
      expect(
        alternate,
        `denialMarker site ${index} must construct its second rendering independently — the same expression twice measures nothing`,
      ).toMatch(/^new\s+[A-Za-z0-9_.]+\(/)
      // The reverted line was `denialMarker(questionRejected, questionRejected)`: a stored
      // identifier, twice. Two inline `new …()` expressions are two evaluations and therefore two
      // instances, which is exactly why a repeated text here is allowed and a repeated NAME is not.
      for (const arg of [primary, alternate]) {
        expect(arg, `denialMarker site ${index} reuses a stored instance instead of constructing one`).not.toMatch(/^[A-Za-z_$][\w$]*$/)
        const name = /^new\s+([A-Za-z0-9_.]+)\(/.exec(arg)![1]!
        if (!constructed.includes(name)) constructed.push(name)
      }
    }
    // Coverage in the other direction: the table above and the shipped source name the same
    // classes, so neither can grow quietly away from the other.
    expect(constructed.sort()).toEqual(refusalClasses.map((entry) => entry.name).sort())
  })

  test("and a same-instance marker is not stable, which is why the rule exists", () => {
    // THE SECOND CONTROL, shown rather than asserted about production: a class whose message carries
    // per-instance text — the change the rule is insurance against. Built here because no refusal
    // class in the contract is dynamic today, and a test may not edit `src/` to make one. Passing
    // one instance twice publishes the WHOLE message, which is not a prefix of the next refusal the
    // host renders; passing two fresh instances publishes what they share, which always is.
    let sequence = 0
    class DynamicRefusal extends Error {
      override get message() {
        return `The reviewer refused this call. Reference R${++sequence}.`
      }
    }
    const first = new DynamicRefusal()
    const shared = commonPrefix(errorMessage(first), errorMessage(new DynamicRefusal()))
    const sameInstanceTwice = errorMessage(first)

    expect(sameInstanceTwice).not.toBe(shared)
    // The two-instance construction is the stable one: it recognises a third, later refusal…
    expect(errorMessage(new DynamicRefusal()).startsWith(shared)).toBe(true)
    // …while the one-instance construction matches only the exact instance it was built from.
    expect(errorMessage(new DynamicRefusal()).startsWith(sameInstanceTwice)).toBe(false)

    // And that is the shape `toolDenialMarkers` has to stay in: every published marker is either a
    // substring of a refusal rendered right now, from an instance nothing held on to, or the
    // serialized identity the module header keeps as insurance for the day a refusal arrives as its
    // class name instead of its prose. An unexplained marker is a guess.
    const hostSource = readFileSync(new URL("../../../../opencode/src/question/index.ts", import.meta.url), "utf8")
    const hostTag = /class RejectedError[\s\S]{0,200}?\("([^"]+)"/.exec(hostSource)?.[1]
    const identities = refusalClasses.flatMap(({ primary }) => {
      const error = primary() as { name?: string; _tag?: string }
      return [error.name, error._tag]
    })
    expect(hostTag, "the host's own rejection tag is no longer readable in its source").toBeDefined()
    for (const marker of toolDenialMarkers) {
      const rendered = refusalClasses.some(
        ({ primary, alternate }) => errorMessage(primary()).includes(marker) || errorMessage(alternate()).includes(marker),
      )
      const identity = marker === hostTag || identities.includes(marker)
      expect(
        rendered || identity,
        `the published marker ${JSON.stringify(marker)} is neither a prefix of a fresh refusal nor a class identity`,
      ).toBe(true)
    }
    // Both lanes have to carry weight, or the rule above is a pass through for anything: the
    // marker list is longer than the prose lane, because the identity lane is in it.
    const proseOnly = refusalClasses.map(({ primary }) => commonPrefix(errorMessage(primary()), errorMessage(primary())))
    expect(toolDenialMarkers.length).toBeGreaterThan(proseOnly.length)
  })
})
