/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill"

import { define } from "./internal"
import { Effect } from "effect"
import { AbsolutePath } from "../schema"
import { SkillV2 } from "../skill"
import customizeHarnessContent from "./skill/customize-harness.md" with { type: "text" }

export const CustomizeHarnessContent = customizeHarnessContent

export const Plugin = define({
  id: "skill",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.skill.transform((draft) => {
      draft.source(
        SkillV2.EmbeddedSource.make({
          type: "embedded",
          skill: SkillV2.Info.make({
            name: "customize-harness",
            description:
              // [gp] Same product text as the v1 skill: the product's own config
              // surface first, upstream names kept as legacy fallbacks.
              "Use ONLY when the user is editing or creating glasspane-harness's own configuration: glasspane-harness.json, glasspane-harness.jsonc, files under .glasspane-harness/, or files under ~/.config/glasspane-harness/ (legacy: opencode.json, opencode.jsonc, .opencode/, ~/.config/opencode/). Also use when creating or fixing glasspane-harness agents, subagents, commands, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring glasspane-harness itself.",
            location: AbsolutePath.make("/builtin/customize-harness.md"),
            content: CustomizeHarnessContent,
          }),
        }),
      )
    })
  }),
})
