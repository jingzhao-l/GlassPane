import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createSignal, For, Show } from "solid-js"
import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core"
import { testRender, type JSX } from "@opentui/solid"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { PermissionV2 } from "@opencode-ai/core/permission"
import {
  formatCompletedSubagentDetail,
  formatSubagentRetry,
  formatSubagentTitle,
  formatSubagentToolcalls,
  InlineToolRow,
  parseApplyPatchFiles,
  parseDiagnostics,
  parseQuestionAnswers,
  parseQuestions,
  parseTodos,
  alwaysSeparate,
  toolDisplay,
  glasspaneRow,
  glasspaneRowLook,
  toolPartShouldHide,
} from "../../../src/routes/session"
import { errorMessage } from "../../../src/util/error"
import { isToolDenial, toolDenialMarkers } from "../../../src/util/tool-denial"

/**
 * The dismissal the server fails into a tool part is `Question.RejectedError` in the fork's
 * own tool package (`src/question/index.ts:27`), not core's `QuestionV2.RejectedError` — and
 * that package depends on the TUI, so this test may not import it either. Its wire values are
 * read out of that file instead: rename the tag or reword the sentence there and the fixtures
 * below move with it, which is what makes these assertions evidence about the host rather than
 * a restatement of whatever `tool-denial.ts` happened to type.
 */
const hostQuestion = (() => {
  const source = readFileSync(new URL("../../../../opencode/src/question/index.ts", import.meta.url), "utf8")
  const rejected = /class RejectedError[\s\S]{0,200}?\("([^"]+)"[\s\S]{0,200}?return "([^"]+)"/.exec(source)
  if (!rejected) throw new Error("Question.RejectedError's tag and message are no longer readable in its source")
  // `Schema.TaggedErrorClass` gives the class a `name` and a `_tag` holding the same string.
  return { tag: rejected[1], dismissed: rejected[2] }
})()

/**
 * The refusal texts below are not typed into this file. `failToolCall` writes a denied
 * tool call as `errorMessage(error)` into a bare string field, so the only thing the TUI
 * can see is the sentence the error class emits — and building it here from the classes
 * themselves is what makes the assertion mean anything. The previous version of this
 * file fed `error: "user rejected permission"`, a literal hand-typed from the very
 * substrings the implementation grepped for: it could not fail when the prose changed,
 * while a reword upstream would have repainted a refusal as an ordinary call error.
 */
const refusal = {
  rejected: errorMessage(new PermissionV1.RejectedError()),
  corrected: errorMessage(new PermissionV1.CorrectedError({ feedback: "not that app" })),
  deniedByRule: errorMessage(new PermissionV1.DeniedError({ ruleset: [{ permission: "bash", action: "deny" }] })),
  dismissed: hostQuestion.dismissed,
}
// The same refusals read as identity rather than as prose: `errorMessage` returns
// `error.name` when a refusal carries no sentence of its own. Not what the server writes
// today — this is the second key the detection claims to have, so it is asserted through
// `glasspaneRow` rather than left as a comment. The question's identity comes from the host,
// whose tag is not core's class name.
const refusalIdentity = [
  new PermissionV1.RejectedError(),
  new PermissionV1.CorrectedError({ feedback: "not that app" }),
  new PermissionV1.DeniedError({ ruleset: [] }),
]
  .flatMap((error) => [error.name, error._tag])
  .concat(hostQuestion.tag)
const notARefusal = "socket closed"
// Not one of the four sentences, and not an identity either: a guess at what a reword
// could say. The branch is real, so an unknown text reads as a call error — and if that
// prose ever actually ships, it ships from the classes, the markers move with them and
// this case moves to `denied` in the same commit.
const rewordedRefusal = "The user declined this tool call."

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(() => {
  testSetup?.renderer.destroy()
  testSetup = undefined
})

type ToolFixture = { icon: string; label: string; error?: string }

const tools: readonly ToolFixture[] = [
  {
    icon: "✱",
    label:
      'Grep "OPENCODE.*DB|database|sqlite|drizzle|dev.*db|data.*dir|xdg|APPDATA" in packages/opencode/src (151 matches)',
  },
  {
    icon: "✱",
    label: 'Glob "**/*db*" in packages/opencode (6 matches)',
  },
  {
    icon: "→",
    label: "Read packages/opencode/src/storage/db.ts [offset=1, limit=130]",
  },
  {
    icon: "→",
    label: "Read packages/opencode/src/index.ts [offset=1, limit=100]",
    error: "No LSP server available for this file type.",
  },
  {
    icon: "✱",
    label:
      'Grep "export const OPENCODE_DB|OPENCODE_DB|OPENCODE_DEV|Global\\.Path\\.data|data =" in packages/opencode/src (115 matches)',
  },
] as const

function ShellOutput() {
  return (
    <box
      ref={(el: BoxRenderable) => alwaysSeparate.add(el)}
      marginTop={1}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      gap={1}
    >
      <box gap={1}>
        <text>$ ls</text>
        <text>file.ts</text>
      </box>
    </box>
  )
}

function UserMessage() {
  return (
    <box ref={(el: BoxRenderable) => alwaysSeparate.add(el)}>
      <box paddingTop={1} paddingBottom={1} paddingLeft={2}>
        <text>Check whether the next tool remains separated.</text>
      </box>
    </box>
  )
}

function Fixture(props: { errorExpanded?: boolean; before?: "shell" | "user" }) {
  return (
    <box flexDirection="column" width={72}>
      <box flexDirection="column">
        {props.before === "shell" && <ShellOutput />}
        {props.before === "user" && <UserMessage />}
        <For each={tools}>
          {(item) => (
            <InlineToolRow
              icon={item.icon}
              complete={true}
              pending=""
              failed={Boolean(item.error)}
              error={item.error}
              errorExpanded={props.errorExpanded}
            >
              {item.label}
            </InlineToolRow>
          )}
        </For>
      </box>
    </box>
  )
}

function TaskRowsFixture() {
  return (
    <box flexDirection="column" width={72}>
      <InlineToolRow icon="✱" complete={true} pending="">
        Grep "Task" (2 matches)
      </InlineToolRow>
      <InlineToolRow icon="⠙" complete={true} pending="" separate={true}>
        Explore Task — Inspect active task spacing
      </InlineToolRow>
      <InlineToolRow icon="✓" complete={true} pending="" separate={true}>
        {"General Task — Confirm completed task spacing\n↳ 1 toolcall · 501ms"}
      </InlineToolRow>
      <InlineToolRow icon="→" complete={true} pending="">
        Read src/cli/cmd/tui/routes/session/index.tsx
      </InlineToolRow>
    </box>
  )
}

function LoadedReadBeforeTaskFixture() {
  return (
    <box flexDirection="column" width={72}>
      <InlineToolRow icon="→" complete={true} pending="">
        Read src/cli/cmd/tui/routes/session/index.tsx
      </InlineToolRow>
      <box paddingLeft={3}>
        <text paddingLeft={3}>↳ Loaded src/cli/cmd/tui/routes/session/tools.tsx</text>
      </box>
      <InlineToolRow icon="✓" complete={true} pending="" separate={true}>
        {"Explore Task — Inspect active task spacing\n↳ 1 toolcall · 501ms"}
      </InlineToolRow>
    </box>
  )
}

function AssistantSummaryBeforeInlineFixture() {
  return (
    <box flexDirection="column" width={72}>
      <box ref={(el: BoxRenderable) => alwaysSeparate.add(el)} paddingLeft={3}>
        <text>▣ Build · Little Frank · 53.1s</text>
      </box>
      <InlineToolRow icon="✓" complete={true} pending="">
        {"Build Task — Review changes\n↳ 48 toolcalls · 1m 40s"}
      </InlineToolRow>
    </box>
  )
}

function AssistantErrorBeforeInlineFixture() {
  return (
    <box flexDirection="column" width={72}>
      <box
        ref={(el: BoxRenderable) => alwaysSeparate.add(el)}
        border={["left"]}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
      >
        <text>Managed inference requires an active Member plan</text>
      </box>
      <InlineToolRow icon="✓" complete={true} pending="">
        {"Build Task — Review changes\n↳ 48 toolcalls · 1m 40s"}
      </InlineToolRow>
    </box>
  )
}

function StickyScrollFixture(props: { separated: boolean; scroll: (scroll: ScrollBoxRenderable) => void }) {
  return (
    <scrollbox ref={props.scroll} stickyScroll={true} stickyStart="bottom" height={3} width={72}>
      <box height={1}>
        <text>First row</text>
      </box>
      <box height={1}>
        <text>Second row</text>
      </box>
      <Show when={props.separated}>
        <box ref={(el: BoxRenderable) => alwaysSeparate.add(el)}>
          <text>Assistant text</text>
        </box>
      </Show>
      <InlineToolRow icon="→" complete={true} pending="">
        Read src/cli/cmd/tui/routes/session/index.tsx
      </InlineToolRow>
    </scrollbox>
  )
}

function FailedPendingToolFixture() {
  return (
    <InlineToolRow icon="%" complete={false} pending="Preparing patch…" failed={true} failure="Patch failed">
      Patch
    </InlineToolRow>
  )
}

function FailedCompleteToolFixture() {
  return (
    <InlineToolRow icon="→" complete={true} pending="Reading file…" failed={true} failure="Read failed">
      Read src/index.ts
    </InlineToolRow>
  )
}

function DeniedGlassPaneToolFixture() {
  // The props the session row passes for `state: "denied"`: finished, not failed, not
  // success — with the denial's own reason available on click.
  return (
    <InlineToolRow icon="⊘" complete={true} denied={true} pending="Performing action…" error={refusal.rejected}>
      gp_act
    </InlineToolRow>
  )
}

function InFlightGlassPaneToolFixture() {
  // The look a denial used to get: `complete` false, so InlineToolRow paints the
  // unfinished tilde line and drops the tool entirely. Kept as the counter-example that
  // proves the assertions below can fail — a fixture only the fixed props satisfy is not
  // evidence, and this row is the one place the user reads whether the engine said no.
  return (
    <InlineToolRow icon="◈" complete={false} denied={true} pending="Performing action…">gp_act</InlineToolRow>
  )
}

async function renderFrame(component: () => JSX.Element, options: { width: number; height: number }) {
  testSetup = await testRender(component, options)
  await testSetup.renderOnce()
  await testSetup.renderOnce()

  return testSetup
    .captureCharFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd()
}

describe("TUI inline tool wrapping", () => {
  test("falls back for unknown tool names", () => {
    expect(toolDisplay("bash")).toBe("bash")
    expect(toolDisplay("plugin_tool")).toBe("generic")
  })

  test("routes the GlassPane family to the evidence renderer, including future methods", () => {
    expect(toolDisplay("gp_act")).toBe("glasspane")
    expect(toolDisplay("gp_last_evidence")).toBe("glasspane")
    // A method added after this renderer was written must not fall back to generic.
    expect(toolDisplay("gp_audit_ui")).toBe("glasspane")
    expect(toolDisplay("gp")).toBe("generic")
  })

  test("glasspaneRow transcribes a successful act without judging it", () => {
    const row = glasspaneRow({
      tool: "gp_act",
      status: "completed",
      metadata: {
        ok: true,
        method: "act",
        result: { actConfirmed: true, axChanged: true, pixelChanged: false, operationId: "op123" },
      },
    })
    expect(row.state).toBe("success")
    expect(row.method).toBe("act")
    expect(row.line).toBe("confirmed=true tree=true pixels=false · op op123")
    expect(row.detail).toBeUndefined()
  })

  test("glasspaneRow makes an engine failure distinct from success and carries the remedy", () => {
    const row = glasspaneRow({
      tool: "gp_last_evidence",
      status: "completed",
      metadata: {
        ok: false,
        method: "last_evidence",
        code: "GP_E_NO_EVIDENCE",
        message: "the engine archived no evidence for that operation",
        remedy: "call gp_act first so the engine has an operation to report",
      },
    })
    // The tool call COMPLETED; only metadata.ok flags the engine refusal.
    expect(row.state).toBe("engine-failure")
    expect(row.line).toBe("gp_last_evidence GP_E_NO_EVIDENCE")
    expect(row.detail).toContain("the engine archived no evidence")
    expect(row.detail).toContain("remedy: call gp_act first")
  })

  test("glasspaneRow gives a missing engine verdict its own state, apart from success and refusal", () => {
    // Reachable, not hypothetical: `registry.ts` gives any plugin or custom tool
    // `metadata: {...metadata, truncated}`, so a `gp_`-prefixed plugin tool that
    // returns a string arrives with `{}` — and `toolDisplay` routes anything starting
    // with `gp_` into this branch. Painting that "success" would tell the person
    // watching the terminal that the engine answered when it answered nothing.
    const missing = glasspaneRow({ tool: "gp_act", status: "completed", metadata: {} })
    expect(missing.state).toBe("no-verdict")
    expect(missing.line).toBe("no engine verdict")
    expect(missing.detail).toBeUndefined() // no verdict to expand, and none invented

    const success = glasspaneRow({
      tool: "gp_act",
      status: "completed",
      metadata: { ok: true, method: "act", result: { actConfirmed: true } },
    })
    const refusal = glasspaneRow({
      tool: "gp_act",
      status: "completed",
      metadata: { ok: false, method: "act", code: "GP_E_NO_EVIDENCE", message: "no pack", remedy: "call gp_act" },
    })
    // Three different rows, all three from a completed tool call.
    expect(success.state).toBe("success")
    expect(refusal.state).toBe("engine-failure")
    expect(new Set([missing.state, success.state, refusal.state]).size).toBe(3)
    expect(missing.line).not.toBe(success.line)
    expect(missing.line).not.toBe(refusal.line)

    // A non-boolean `ok` is the same absence, not a verdict of its own.
    for (const ok of [undefined, null, "true", 1]) {
      expect(glasspaneRow({ tool: "gp_act", status: "completed", metadata: { ok, method: "act" } }).state).toBe(
        "no-verdict",
      )
    }
    // A refusal on a call that never finished is still the call error's story.
    expect(glasspaneRow({ tool: "gp_act", status: "error", error: "socket closed", metadata: {} }).state).toBe("call-error")
  })

  test("glasspaneRow denies every refusal shape the server can raise, and only those", () => {
    // Each of these is what `failToolCall` actually stores for a human "no": the
    // rejection, the rejection with feedback, the rule that blocked the call, and the
    // dismissed question.
    for (const error of [refusal.rejected, refusal.corrected, refusal.deniedByRule, refusal.dismissed]) {
      const row = glasspaneRow({ tool: "gp_act", status: "error", error, metadata: {} })
      expect(row.state).toBe("denied")
      // The reason stays readable on click; the row invents nothing.
      expect(row.detail).toBe(error)
    }
    // The branch is real: text no refusal class emits stays an ordinary call error, and
    // so does a refusal whose prose has moved out from under us — until the classes
    // themselves change, at which point the markers and this case move together.
    for (const error of [notARefusal, rewordedRefusal]) {
      const row = glasspaneRow({ tool: "gp_act", status: "error", error, metadata: {} })
      expect(row.state).toBe("call-error")
      expect(row.detail).toBe(error)
    }
    // The half a prose-only check cannot see: a refusal that reaches the row as the class
    // identity instead of as the class sentence. The pre-fix detection grepped four
    // sentences, so every assertion above stays green when it is restored and only this
    // loop turns red — it is the reverse-control case for `glasspaneRow`.
    for (const error of refusalIdentity) {
      expect(glasspaneRow({ tool: "gp_act", status: "error", error, metadata: {} }).state).toBe("denied")
    }
    for (const error of [new PermissionV2.DeclinedError().name, new PermissionV2.BlockedError({ rules: [] }).name]) {
      expect(glasspaneRow({ tool: "gp_act", status: "error", error, metadata: {} }).state).toBe("call-error")
    }
    expect(glasspaneRow({ tool: "gp_act", status: "error", metadata: {} }).state).toBe("call-error")
  })

  test("denial detection is read out of the error classes instead of copied into the TUI", () => {
    // The one-way link that makes the assertions above evidence: every marker is text a
    // refusal class produces, and every text a refusal class produces carries a marker.
    // Restoring hand-typed substrings breaks this — that was the drift the old test and
    // the old implementation could not see, because they typed the same words to each other.
    expect(toolDenialMarkers.length).toBeGreaterThan(0)
    for (const marker of toolDenialMarkers) {
      expect(marker.length).toBeGreaterThan(10)
      // A marker short enough to appear in an unrelated failure would deny live calls.
      expect(notARefusal.includes(marker)).toBe(false)
    }
    expect(toolDenialMarkers).toContain(refusal.rejected)
    // Cross-package now: the marker is read off core's class, this text off the class the host
    // actually fails into the tool part. They agree only as long as the two definitions do.
    expect(toolDenialMarkers).toContain(refusal.dismissed)
    expect(toolDenialMarkers).toContain(hostQuestion.tag)
    // The two classes that interpolate carry the sentence up to the data, which is what
    // every real rendering of them starts with.
    for (const error of [refusal.corrected, refusal.deniedByRule]) {
      expect(toolDenialMarkers.some((marker) => error.startsWith(marker))).toBe(true)
    }
    // Both keys, read from the classes: the sentence and the identity. `errorMessage`
    // prefers prose, so the identity half only matters for a refusal that arrives without
    // one — which is what `PermissionV2.DeclinedError` would do, and why its name is
    // deliberately absent below.
    for (const error of [...Object.values(refusal), ...refusalIdentity]) {
      expect(isToolDenial(error)).toBe(true)
    }
    for (const error of [new PermissionV2.DeclinedError().name, new PermissionV2.BlockedError({ rules: [] }).name]) {
      expect(isToolDenial(error)).toBe(false)
    }
    expect(isToolDenial(undefined)).toBe(false)
    expect(isToolDenial("")).toBe(false)
  })

  test("the gp_* family row model is not gated by the methods it happens to name", () => {
    // The engine's method table is derived from `enum EngineMethod` and grows without
    // telling the TUI, and the TUI carries no capability channel to read it from, so
    // presentation has to be a function of the `gp_` prefix. Anything that makes the
    // wording override load-bearing fails here: that is how `audit_ui`, `capture_view`
    // and the next one get caught instead of drifting into the generic text wall.
    for (const method of ["audit_ui", "capture_view", "assert_element", "snapshot", "restore", "not_in_any_list"]) {
      const tool = `gp_${method}`
      expect(toolDisplay(tool)).toBe("glasspane")
      const running = glasspaneRow({ tool, status: "running", metadata: {} })
      expect(running.state).toBe("pending")
      expect(running.pending).toBe(`Running ${tool}…`)
      expect(glasspaneRowLook(running, tool).spinner).toBe(true)
      expect(glasspaneRow({ tool, status: "completed", metadata: { ok: true, method } }).state).toBe("success")
      expect(glasspaneRow({ tool, status: "completed", metadata: {} }).state).toBe("no-verdict")
      expect(glasspaneRow({ tool, status: "completed", metadata: { ok: false, code: "GP_E_NO_TARGET" } }).state).toBe(
        "engine-failure",
      )
      expect(glasspaneRow({ tool, status: "error", error: refusal.rejected, metadata: {} }).state).toBe("denied")
      expect(glasspaneRow({ tool, status: "error", error: notARefusal, metadata: {} }).state).toBe("call-error")
    }
    // Methods that do have bespoke wording keep it, so the override table stays honest.
    expect(glasspaneRow({ tool: "gp_act", status: "running", metadata: {} }).pending).toBe("Performing action…")
  })

  test("glasspaneRow surfaces evidence-pack fields for last_evidence, verbatim", () => {
    const row = glasspaneRow({
      tool: "gp_last_evidence",
      status: "completed",
      metadata: {
        ok: true,
        method: "last_evidence",
        result: {
          evidencePack: {
            operationId: "op9",
            attribution: { level: "strong", contaminated: true },
            circuitBreaker: { level: 2 },
            assertion: { passed: false },
          },
        },
      },
    })
    expect(row.state).toBe("success")
    expect(row.line).toBe("attribution strong contaminated=true · cb 2 · assertion.passed=false")
  })

  test("glasspaneRow transcribes the assertion field instead of naming its verdict", () => {
    const line = (assertion: unknown, attribution: unknown) =>
      glasspaneRow({
        tool: "gp_last_evidence",
        status: "completed",
        metadata: { ok: true, method: "last_evidence", result: { evidencePack: { assertion, attribution } } },
      }).line
    // The engine's field name and the engine's value, the way every other field on this row is
    // written. Choosing the word for a boolean — "passed", "failed", "contaminated" — is the
    // verdict, and the verdict belongs to the engine.
    expect(line({ passed: true }, { level: "weak", contaminated: false })).toBe(
      "attribution weak contaminated=false · assertion.passed=true",
    )
    expect(line({ passed: false }, { level: "strong", contaminated: true })).toBe(
      "attribution strong contaminated=true · assertion.passed=false",
    )
    // No boolean from the engine is absence, and absence must stay sayable as `?`.
    expect(line({}, {})).toBe("attribution ? contaminated=? · assertion.passed=?")
  })

  test("glasspaneRow renders observe's node count as the number the engine sends", () => {
    // `nodeCount: Int` (EngineCore.swift:1403). Read as a string it is always absent, and every
    // successful tree read painted `nodes=?` — the measurement was there, the row said unknown.
    const row = glasspaneRow({
      tool: "gp_observe",
      status: "completed",
      metadata: { ok: true, method: "observe", result: { nodeCount: 207, digest: "9f3ac1" } },
    })
    expect(row.state).toBe("success")
    expect(row.line).toBe("nodes=207 digest=9f3ac1")
  })

  test("glasspaneRow names the attached app with the field the engine reports", () => {
    // `attachResult` sends appName (EngineCore.swift:2160-2168); a bundle id alone is not the
    // app name the row claims to show, and a target without one showed only its pid.
    const named = glasspaneRow({
      tool: "gp_attach",
      status: "completed",
      metadata: { ok: true, method: "attach", result: { pid: 4242, appName: "Notes", bundleId: "com.apple.Notes" } },
    })
    expect(named.line).toBe("Notes · pid 4242")
    const noBundle = glasspaneRow({
      tool: "gp_attach",
      status: "completed",
      metadata: { ok: true, method: "attach", result: { pid: 7, appName: "Calculator" } },
    })
    expect(noBundle.line).toBe("Calculator · pid 7")
  })

  test("glasspaneRow never invents a shape for unknown methods or missing results", () => {
    expect(glasspaneRow({ tool: "gp_probe_status", status: "running", metadata: {} }).state).toBe("pending")
    const unknown = glasspaneRow({ tool: "gp_future", status: "completed", metadata: { ok: true, method: "future" } })
    expect(unknown.state).toBe("success")
    expect(unknown.line).toBe("future")
    const noResult = glasspaneRow({ tool: "gp_observe", status: "completed", metadata: { ok: true, method: "observe" } })
    expect(noResult.line).toBe("observe")
  })

  test("replaces pending copy when a tool fails before completion", async () => {
    const frame = await renderFrame(() => <FailedPendingToolFixture />, { width: 72, height: 3 })
    expect(frame).toContain("Patch failed")
    expect(frame).not.toContain("Preparing patch")
  })

  test("preserves useful completed copy when a tool fails", async () => {
    const frame = await renderFrame(() => <FailedCompleteToolFixture />, { width: 72, height: 3 })
    expect(frame).toContain("Read src/index.ts")
    expect(frame).not.toContain("Read failed")
  })

  test("a denied call is drawn as finished history, not as a call still running", async () => {
    const denied = await renderFrame(() => <DeniedGlassPaneToolFixture />, { width: 72, height: 3 })
    expect(denied).toContain("gp_act")
    expect(denied).not.toContain("Performing action")

    const inFlight = await renderFrame(() => <InFlightGlassPaneToolFixture />, { width: 72, height: 3 })
    expect(inFlight).toContain("Performing action")
    expect(inFlight).not.toContain("gp_act")
  })

  test("the row wiring gives a denial the same finishedness as a failure", () => {
    // `glasspaneRow` was always right about the state; the component's mapping of that state
    // to `InlineToolRow`'s props is what made a refusal look like a call still in flight.
    // This drives the exported mapping, so reversing `complete` or the icon goes red here —
    // the fixture test above only pins what `InlineToolRow` does with props it is handed.
    const look = (input: Parameters<typeof glasspaneRow>[0]) => glasspaneRowLook(glasspaneRow(input), input.tool)
    const denied = look({ tool: "gp_act", status: "error", error: refusal.rejected, metadata: {} })
    expect(denied.denied).toBe(true)
    expect(denied.failed).toBe(false)
    expect(denied.complete).toBe(true)
    expect(denied.spinner).toBe(false)
    expect(denied.icon).toBe("⊘")
    expect(denied.color).toBe("warning")
    expect(denied.label).toBe("gp_act")

    const four = [
      look({ tool: "gp_act", status: "running", metadata: {} }),
      look({ tool: "gp_act", status: "completed", metadata: { ok: true, method: "act", operationId: "op_1" } }),
      look({ tool: "gp_act", status: "error", error: notARefusal, metadata: {} }),
      denied,
    ]
    expect(four[0].spinner).toBe(true)
    expect(four[0].complete).toBe(false)
    expect(four[1].complete).toBe(true)
    expect(four[2].failed).toBe(true)
    expect(new Set(four.map((l) => `${l.icon}|${l.failed}|${l.denied}|${l.noVerdict}|${l.complete}|${l.spinner}|${l.color}`)).size).toBe(4)

    // Every refusal shape the server raises gets the same finishedness, not just the one
    // this file used to type by hand.
    for (const error of [refusal.corrected, refusal.deniedByRule, refusal.dismissed]) {
      const other = look({ tool: "gp_act", status: "error", error, metadata: {} })
      expect(other.denied).toBe(true)
      expect(other.failed).toBe(false)
      expect(other.complete).toBe(true)
      expect(other.icon).toBe("⊘")
    }
  })

  test("the detail-visibility toggle hides results but never an engine refusal", () => {
    const hidden = (row: Parameters<typeof glasspaneRow>[0]) => toolPartShouldHide({ showDetails: false, row })
    const refused = { tool: "gp_act", status: "completed", metadata: { ok: false, code: "GP_E_NO_EVIDENCE" } }
    const silent = { tool: "gp_act", status: "completed", metadata: {} }
    const answered = { tool: "gp_act", status: "completed", metadata: { ok: true, method: "act", result: {} } }
    // An engine refusal is a COMPLETED part (a human denial is the error status this row model
    // still calls finished), so `status === "completed"` alone hid the refusal and left the
    // crash next to it — the quiet transcript erased the one distinction the row model keeps.
    expect(hidden(refused)).toBe(false)
    expect(hidden(silent)).toBe(false)
    expect(hidden({ tool: "gp_act", status: "error", error: refusal.rejected, metadata: {} })).toBe(false)
    expect(hidden({ tool: "gp_act", status: "error", error: hostQuestion.tag, metadata: {} })).toBe(false)

    // What the toggle is for stays hidden: an answer the engine gave, on any tool, and a
    // non-evidence completed part must not be dragged in by the refusal exemption.
    expect(hidden(answered)).toBe(true)
    expect(hidden({ tool: "read", status: "completed", metadata: {} })).toBe(true)
    expect(hidden({ tool: "read", status: "error", error: notARefusal, metadata: {} })).toBe(false)

    // Parts that never finished are not the toggle's business, and details on hides nothing.
    expect(hidden({ tool: "gp_act", status: "running", metadata: {} })).toBe(false)
    expect(hidden({ tool: "read", status: "pending", metadata: {} })).toBe(false)
    expect(toolPartShouldHide({ showDetails: true, row: { tool: "read", status: "completed", metadata: {} } })).toBe(
      false,
    )
    expect(toolPartShouldHide({ showDetails: true, row: silent })).toBe(false)
  })

  test("filters malformed nested tool wire data", () => {
    expect(
      parseApplyPatchFiles([
        null,
        { type: "add" },
        { type: "add", relativePath: "a.ts", filePath: "a.ts", patch: "diff", deletions: 0 },
      ]),
    ).toEqual([
      { type: "add", relativePath: "a.ts", filePath: "a.ts", patch: "diff", deletions: 0, movePath: undefined },
    ])
    expect(parseTodos([null, { status: "pending" }, { status: "pending", content: "Safe" }])).toEqual([
      { status: "pending", content: "Safe" },
    ])
    expect(parseQuestions([{}, { question: 1 }, { question: "Continue?" }])).toEqual([{ question: "Continue?" }])
    expect(parseQuestionAnswers([null, ["yes", 1], "no"])).toEqual([[], ["yes"], []])
    expect(parseQuestionAnswers({})).toBeUndefined()
  })

  test("ignores diagnostics with malformed nested ranges", () => {
    expect(
      parseDiagnostics(
        {
          "a.ts": [
            { severity: 1, message: "missing range" },
            { severity: 1, message: "bad line", range: { start: { line: "0", character: 1 } } },
            { severity: 1, message: "valid", range: { start: { line: 2, character: 3 } } },
          ],
        },
        "a.ts",
      ),
    ).toEqual([{ message: "valid", range: { start: { line: 2, character: 3 } } }])
  })

  test("formats completed subagent toolcall details", () => {
    expect(formatCompletedSubagentDetail(0, "501ms")).toBe("501ms")
    expect(formatCompletedSubagentDetail(1, "501ms")).toBe("1 toolcall · 501ms")
    expect(formatCompletedSubagentDetail(2, "501ms")).toBe("2 toolcalls · 501ms")
    expect(formatSubagentToolcalls(0)).toBe("0 toolcalls")
  })

  test("keeps background state attached to the subagent identity", () => {
    expect(formatSubagentTitle("Explore", "Inspect renderer", false)).toBe("Explore Task — Inspect renderer")
    expect(formatSubagentTitle("Explore", "Inspect renderer", true)).toBe(
      "Explore Task (background) — Inspect renderer",
    )
  })

  test("keeps retry status ahead of wrapping messages", () => {
    expect(formatSubagentRetry(2, "Rate limited by provider")).toBe("Retrying (attempt 2) · Rate limited by provider")
  })

  test("snapshots consecutive grep, glob, and read rows at a narrow width", async () => {
    expect(await renderFrame(() => <Fixture />, { width: 72, height: 12 })).toMatchSnapshot()
  })

  test("snapshots expanded tool errors under the tool text", async () => {
    expect(await renderFrame(() => <Fixture errorExpanded />, { width: 72, height: 12 })).toMatchSnapshot()
  })

  test("keeps separation after a shell output block", async () => {
    expect(await renderFrame(() => <Fixture before="shell" />, { width: 72, height: 16 })).toMatchSnapshot()
  })

  test("keeps separation after a padded user message", async () => {
    expect(await renderFrame(() => <Fixture before="user" />, { width: 72, height: 14 })).toMatchSnapshot()
  })

  test("separates after a multi-line task row", async () => {
    expect(await renderFrame(() => <TaskRowsFixture />, { width: 72, height: 10 })).toMatchSnapshot()
  })

  test("separates a task row from a preceding inline detail", async () => {
    expect(await renderFrame(() => <LoadedReadBeforeTaskFixture />, { width: 72, height: 8 })).toMatchSnapshot()
  })

  test("separates an inline row from the previous assistant summary", async () => {
    expect(await renderFrame(() => <AssistantSummaryBeforeInlineFixture />, { width: 72, height: 5 })).toMatchSnapshot()
  })

  test("separates an inline row from the previous assistant error", async () => {
    expect(await renderFrame(() => <AssistantErrorBeforeInlineFixture />, { width: 72, height: 7 })).toMatchSnapshot()
  })

  test("updates sticky-bottom geometry when a text separator mounts and unmounts", async () => {
    const [separated, setSeparated] = createSignal(false)
    let scroll: ScrollBoxRenderable | undefined
    testSetup = await testRender(
      () => <StickyScrollFixture separated={separated()} scroll={(value) => (scroll = value)} />,
      {
        width: 72,
        height: 3,
      },
    )

    await testSetup.renderOnce()
    expect(scroll?.scrollHeight).toBe(3)
    expect(scroll?.scrollTop).toBe(Math.max(0, scroll!.scrollHeight - scroll!.viewport.height))

    setSeparated(true)
    await testSetup.renderOnce()
    expect(scroll?.scrollHeight).toBe(5)
    expect(scroll?.scrollTop).toBe(Math.max(0, scroll!.scrollHeight - scroll!.viewport.height))

    setSeparated(false)
    await testSetup.renderOnce()
    expect(scroll?.scrollHeight).toBe(3)
    expect(scroll?.scrollTop).toBe(Math.max(0, scroll!.scrollHeight - scroll!.viewport.height))
  })
})
