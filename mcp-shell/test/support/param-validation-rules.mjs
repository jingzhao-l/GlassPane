/**
 * The daemon's own `selector` emptiness rules, derived from `ParamValidation.swift`.
 *
 * Two gates read this — `test/tools.test.mjs` (the shell's request path) and
 * `test/consumer-consistency.test.mjs` (the published contract: JSON Schema, kernel zod,
 * `tools/list`) — and they must reach the same verdict from the same reading, because two
 * copies of a derivation is how one of them goes blind. This one reads
 * `ParamValidation.optSelector` **per field over its whole body**, because that is where
 * the rule for the field in question lives:
 *
 *  - a field is refused when `optSelector` itself binds `dict["<field>"]` and throws on it
 *    being empty (`role` always did; `title` joined it when the daemon grew the guard the
 *    published evidence-pack schema had promised), and
 *  - a field is refused when the shared reader it is delegated to refuses emptiness for
 *    everything it reads.
 *
 * Reading only the delegated helper — what this used to do — reported "the daemon accepts
 * `title: ""`" *after* the guard was added, so the four-surface gate could not see the rule
 * it exists to compare four surfaces against, and deleting the Swift guard left every TS
 * gate green. Comments are stripped first (`executableSource`): the Swift around these
 * guards explains the rule at length and names `isEmpty` while doing exactly that.
 */
import assert from "node:assert/strict";

import { executableSource } from "./source.mjs";

/** Where one Swift member ends: an explicit terminator, else the next member at the same indent. */
function memberEnd(source, opened, signature, terminator) {
  const rest = source.slice(opened + signature.length);
  if (terminator !== undefined && terminator !== null) {
    const at = rest.indexOf(terminator);
    return at === -1 ? -1 : opened + signature.length + at;
  }
  const next = rest.search(/\n {4}(?:private |public |internal |fileprivate )?(?:static )?func /);
  return next === -1 ? -1 : opened + signature.length + next;
}

/**
 * One Swift function's body, comments stripped, braces intact.
 *
 * `terminator` names the member the extraction expects next (so a function that moved
 * makes a red rather than a silent over-read); without it the next sibling member closes
 * the body, which is the same rule for every reader function in the file.
 */
export function swiftFunctionBody(source, signature, where, terminator = null) {
  const opened = source.indexOf(signature);
  assert.notEqual(opened, -1, `${where}: '${signature}' is gone — this gate reads the daemon's rule out of it, so move the gate with the code and say where the rule lives now`);
  const closed = memberEnd(source, opened, signature, terminator);
  assert.notEqual(closed, -1, `${where}: nothing follows '${signature}' that this gate could treat as its end — re-read how the file is laid out`);
  const body = executableSource(source.slice(opened, closed));
  assert.ok(body.length > 120, `${where}: extracted a ${body.length}-character body for '${signature}', which is not that function`);
  return body;
}

/** The helper `optSelector` reads one field through, or null when it reads it inline. */
function delegatedReaderOf(body, field) {
  const match = new RegExp(`\\b([A-Za-z][A-Za-z0-9]*)\\(\\s*dict\\s*,\\s*"${field}"`).exec(body);
  return match === null ? null : match[1];
}

/**
 * The emptiness verdict per selector field, as the daemon's Swift currently writes it.
 *
 * @param {string} source the whole `ParamValidation.swift`
 */
export function deriveSelectorEmptiness(source, { where = "ParamValidation.swift" } = {}) {
  const body = swiftFunctionBody(source, "static func optSelector", where, "static func requireSelector");
  assert.ok(/\bif\s+let\b|\bguard\s+let\b/.test(body), `${where}: optSelector's body has no binding form — the shape this gate reads has changed`);

  const maxLength = /static let selectorMaxLength\s*=\s*(\d+)/.exec(source);
  assert.ok(maxLength !== null, `${where}: selectorMaxLength is gone, so the length half of this rule is unreadable too`);

  // `field` is refused on its own either where it is read (`guard`/`if` binding
  // `dict["field"]` and throwing on `.isEmpty`), or by the shared reader it is delegated
  // to. The consequence has to be a refusal: `if !x.isEmpty { … }` reads the field, it does
  // not reject it, so the throw is part of the match rather than an assumption.
  const refusalPattern = (field) => new RegExp(
    `(?:guard|if)\\s+let\\s+[A-Za-z_][A-Za-z0-9_]*\\s*=\\s*dict\\["${field}"\\][^{}]*?\\.isEmpty[^{}]*?\\{\\s*(?:throw|GPError)`,
  );

  const fields = {};
  for (const field of ["role", "title", "identifier"]) {
    const directGuard = refusalPattern(field).test(body);
    const reader = delegatedReaderOf(body, field);
    let readerRefusesEmpty = false;
    if (reader !== null) {
      const readerBody = swiftFunctionBody(source, `static func ${reader}`, `${where} (${reader})`);
      readerRefusesEmpty = /\.isEmpty/.test(readerBody);
    }
    fields[field] = {
      refusedAlone: directGuard || readerRefusesEmpty,
      directGuard,
      reader,
      readerRefusesEmpty,
    };
  }
  for (const field of ["role", "title", "identifier"]) {
    // The one thing that may not happen silently is this gate losing track of the field:
    // a guard *removed* is a verdict to report (and a red four-surface gate), while a field
    // no longer read in `optSelector` at all means the rule moved somewhere this derivation
    // does not look — and that is a re-read, not a false.
    assert.ok(
      body.includes(`"${field}"`),
      `${where}: optSelector no longer mentions "${field}" anywhere — the rule moved out of the function this gate reads, so move the gate and say where it went`,
    );
  }
  return { selectorMaxLength: Number(maxLength[1]), fields };
}
