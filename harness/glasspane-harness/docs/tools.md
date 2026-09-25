# The `gp_*` tool surface

Six tools, all with raw `gp_` ids (no namespace, no prefix rewriting), all registered as
builtins so the agent cannot lose them. Whether a method exists is read from the running
engine (`hello.capabilities`); this page describes the surface, the engine decides the
availability.

| Tool | Args | Returns (output) |
|---|---|---|
| `gp_probe_status` | — | engine version, capabilities, permission seats, then the engine's own probe payload |
| `gp_attach` | `bundleId?` or `pid?` | the app/pid the engine resolved, its measured Accessibility state |
| `gp_observe` | `maxDepth?` (1–10, enforced by the schema), `role?` | node count, tree digest, the tree as the engine serialised it |
| `gp_act` | `selector{role,title?,identifier?}`, `action` (`press`/`increment`/`decrement`/`showMenu`/`confirm`/`cancel`/`pick`), `degrade?` | `actConfirmed` / `axChanged` / `pixelChanged`, the operation id, latency; then "call `gp_diagnose` with this operation id before retrying" |
| `gp_diagnose` | `operationId?` (defaults to the most recent) | classification (`contaminated` / `out-of-band` / `callback` / `pre-existing` / `no-change`) plus the engine's four-part report |
| `gp_last_evidence` | `operationId?` | the evidence pack the engine archived (digests, pixel diff, attribution, circuit breaker, assertions) |

## Behaviour that is not negotiable

- **Every call asks permission first.** Mutating tools (`gp_act`) go through the harness
  permission plane before the engine is asked to do anything.
- **The engine decides.** No tool computes a threshold, a pixel verdict or a pass/fail
  string; outcomes and summaries are transcriptions of engine fields (the CI ratchet
  `surface-semantics` fails the build if a tool surface grows one).
- **Failures are readable.** A refusal is a `{code, message, remedy}` frame from the
  engine, rendered into `output` with the remedy spelled out.
- **Transport failures are not verdicts.** A socket error becomes
  `GP_E_ENGINE_UNREACHABLE` and is recorded as "no decision", never as "no change".

## Examples

```
attach to com.apple.Notes
observe the attached window (maxDepth 8)
press the AXButton whose title is "New Note"
diagnose the last operation
fetch the evidence pack for that operation id
```

The engine's own capability list is the authority on which of these the running daemon
accepts; `gp_probe_status` prints it.
