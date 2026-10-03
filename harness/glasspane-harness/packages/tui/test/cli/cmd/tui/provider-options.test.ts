import { describe, expect, test } from "bun:test"
import { normalizeCustomProviderID, providerOptions } from "../../../../src/component/dialog-provider"

describe("providerOptions", () => {
  test("includes a synthetic Other option for custom providers", () => {
    expect(providerOptions([{ id: "openai", name: "OpenAI" }]).at(-1)).toMatchObject({
      title: "Other",
      description: "Custom provider",
      category: "Providers",
    })
  })

  test("does not use Other as the generic provider category", () => {
    expect(providerOptions([{ id: "mistral", name: "Mistral" }])[0]?.category).toBe("Providers")
  })

  test("keeps popular providers first and sorts the rest alphabetically", () => {
    // `anthropic` leads because PROVIDER_PRIORITY ranks it 0 and `openai` 1 —
    // the list is ordered by that table, not by the order the providers arrive
    // in. The sentinel is the product's own (`__glasspane_harness_…`): the
    // upstream name must not survive here, since a provider id is matched
    // against this value.
    expect(
      providerOptions([
        { id: "openai", name: "OpenAI" },
        { id: "custom-z", name: "Zebra Provider" },
        { id: "anthropic", name: "Anthropic" },
        { id: "mistral", name: "Mistral" },
        { id: "aws", name: "AWS Bedrock" },
      ]).map((option) => option.value),
    ).toEqual(["anthropic", "openai", "aws", "mistral", "custom-z", "__glasspane_harness_custom_provider__"])
  })

  test("the custom-provider sentinel is the product's own, not the upstream one", () => {
    // A leftover upstream sentinel here would make a provider literally named
    // `__opencode_custom_provider__` collide with the synthetic option, and it
    // would ship the upstream product's internal name to users.
    const [first] = providerOptions([{ id: "openai", name: "OpenAI" }])
    const custom = providerOptions([{ id: "openai", name: "OpenAI" }]).at(-1)
    expect(custom?.value).toBe("__glasspane_harness_custom_provider__")
    expect(first?.value).not.toContain("opencode")
  })

  test("does not collide with a configured provider named other", () => {
    const values = providerOptions([{ id: "other", name: "Other Provider" }]).map((option) => option.value)
    expect(new Set(values).size).toBe(values.length)
  })

  test("normalizes and validates custom provider ids", () => {
    expect(normalizeCustomProviderID("  custom-provider  ")).toBe("custom-provider")
    expect(normalizeCustomProviderID("custom_provider")).toBe("custom_provider")
    expect(normalizeCustomProviderID("@ai-sdk/custom-provider")).toBe("custom-provider")
    expect(normalizeCustomProviderID("-custom-provider")).toBeUndefined()
    expect(normalizeCustomProviderID("Custom Provider")).toBeUndefined()
  })
})
