import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { QuestionV2 } from "@opencode-ai/core/question"
import { errorMessage } from "./error"

/* ------------------------------------------------------------------ *
 * What a human refusal looks like on the wire.
 *
 * There is one channel and it is free text. `SessionProcessor.failToolCall` stores
 * the failed tool part as `error: errorMessage(error)`
 * (`packages/opencode/src/session/processor.ts:194`) and `ToolStateError.error` is a
 * plain `string` (`packages/sdk/js/src/gen/types.gen.ts:277`) — no `_tag`, no class
 * identity, no typed field ever arrives at the TUI. `errorMessage` returns
 * `error.message` when the class supplies one, which the refusal classes do, so what
 * reaches a row is the sentence those classes' `get message()` returns today.
 *
 * The detection this replaces was four hand-typed substrings (`"rejected permission"`,
 * `"specified a rule"`, `"user dismissed"`, `"QuestionRejectedError"`). Those are
 * upstream's words, not ours: reword a `get message()` upstream and a refusal repaints
 * itself as an ordinary call error, while any test that typed the same substring keeps
 * passing. Reading the sentences out of the classes instead means a reword moves the
 * code and the test together, in one commit, and the two cannot drift apart silently.
 *
 * Two constraints worth knowing before editing this file:
 * - The question rejection the server throws is `Question.RejectedError` in
 *   `packages/opencode/src/question/index.ts:27`, which this package must not import
 *   (`packages/opencode` depends on the TUI — see its `util/error.ts` re-exporting
 *   this module). Its message is defined identically to core's `QuestionV2.RejectedError`
 *   used below; if those two definitions ever diverge, this is the file to fix.
 * - The type-name markers match nothing live today: all four classes supply prose, and
 *   prose is what `errorMessage` returns for them. They are insurance for the change
 *   that is easy to imagine — a refusal arriving as its serialized identity (`name`, and
 *   for these classes `_tag` is the same string), which is exactly what `errorMessage`
 *   yields for a class with no message of its own. `PermissionV2.DeclinedError` is such a
 *   class and is deliberately *not* a marker here: a V2 decline never becomes tool-part
 *   text, the runner publishes `"Tool execution interrupted"` instead
 *   (`packages/core/src/session/runner/llm.ts:306`). Naming that in the markers would
 *   relabel an interruption as a human refusal.
 * ------------------------------------------------------------------ */

/**
 * The part of `errorMessage(...)` a class owns: compare two payloads that diverge
 * immediately and keep what both renderings share, so the marker is a prefix of every
 * real refusal no matter what feedback text or ruleset JSON gets interpolated after it.
 */
function denialMarker(primary: unknown, alternate: unknown) {
  const a = errorMessage(primary)
  const b = errorMessage(alternate)
  let end = 0
  while (end < a.length && a[end] === b[end]) end++
  return a.slice(0, end)
}

const questionRejected = new QuestionV2.RejectedError()

export const toolDenialMarkers: readonly string[] = [
  denialMarker(new PermissionV1.RejectedError(), new PermissionV1.RejectedError()),
  denialMarker(new PermissionV1.CorrectedError({ feedback: "a" }), new PermissionV1.CorrectedError({ feedback: "b" })),
  // A string and a number encode differently, which cuts the marker at the sentence
  // boundary rather than carrying `JSON.stringify`'s opening quote into it.
  denialMarker(new PermissionV1.DeniedError({ ruleset: "a" }), new PermissionV1.DeniedError({ ruleset: 0 })),
  denialMarker(questionRejected, questionRejected),
  new PermissionV1.RejectedError().name,
  new PermissionV1.CorrectedError({ feedback: "a" }).name,
  new PermissionV1.DeniedError({ ruleset: "a" }).name,
  questionRejected.name,
].filter(
  // A zero-length marker means the class put its entire message behind dynamic text.
  // Dropping it keeps the safe reading — an ordinary call error — instead of matching
  // every error there is.
  (marker) => marker.length > 0,
)

/** Whether this tool-part error text is a human refusal rather than a broken call. */
export function isToolDenial(error: string | undefined) {
  if (!error) return false
  return toolDenialMarkers.some((marker) => error.includes(marker))
}
