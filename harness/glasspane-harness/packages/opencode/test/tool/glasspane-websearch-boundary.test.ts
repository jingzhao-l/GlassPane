import { describe, expect, test } from "bun:test"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { webSearchEnabled } from "../../src/tool/registry"

/**
 * The one place a reader can check the first-party-gateway boundary this fork draws inside the tool
 * registry, without diffing against the pinned upstream tag.
 *
 * Upstream's `webSearchEnabled` returns true for two provider ids that are opencode's own paid
 * gateway, and this fork deleted those two disjuncts when it deleted the first-party account face
 * (`provider.ts` filters `opencode` out of the catalog; `product.json` records the removal under
 * `models.removedFirstParty`). Deleting a line from a fork is exactly the thing `fork-diff` counts
 * but cannot judge, so the judgement lives here: an id this build cannot load must not be able to
 * turn a tool on, and the two doors that remain must both still open.
 *
 * The negative half is not decoration. Restoring either first-party disjunct turns this red by
 * name — which is the point, because a silent re-add would otherwise look like an upstream sync and
 * ship a route to a service this product has no account for.
 */
describe("the web-search door is the user's own key, not a first-party account", () => {
  const firstParty = [ProviderV2.ID.opencode, ProviderV2.ID.make("opencode-go")]

  test("a first-party gateway id enables nothing on its own", () => {
    for (const id of firstParty) expect(webSearchEnabled(id)).toBe(false)
    for (const id of firstParty) expect(webSearchEnabled(id, { exa: false, parallel: false })).toBe(false)
  })

  test("and enabling one for a first-party id, without a flag, is the regression this file refuses", () => {
    // Driven as a value, not as a source scan: the assertion below is what a re-added disjunct
    // breaks. A grep for `ID.opencode` would also pass while the function decided nothing at all.
    const opened = firstParty.filter((id) => webSearchEnabled(id, { exa: false, parallel: false }))
    expect(opened.map(String)).toEqual([])
  })

  test("exa still opens it, for any provider including a first-party one", () => {
    // The flags are the user's own opt-in and stay provider-independent; the boundary is only about
    // a gateway unlocking a tool by itself.
    expect(webSearchEnabled(ProviderV2.ID.make("anthropic"), { exa: true, parallel: false })).toBe(true)
    expect(webSearchEnabled(firstParty[0]!, { exa: true, parallel: false })).toBe(true)
  })

  test("parallel still opens it", () => {
    expect(webSearchEnabled(ProviderV2.ID.make("openai"), { exa: false, parallel: true })).toBe(true)
  })

  test("a third-party id with no flags gets nothing, so the default is closed", () => {
    expect(webSearchEnabled(ProviderV2.ID.make("anthropic"))).toBe(false)
  })
})
