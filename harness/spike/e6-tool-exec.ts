// Spike E6: execute the plugin's own tool body through the plugin contract,
// with no model in the loop. Proves: the plugin module loads under Bun (the
// runtime opencode plugins actually run in), the Hooks shape is what the host
// expects, and `gp_probe_status` reaches glasspaned over the local socket and
// returns the agent-facing {title, output, metadata} triple.
import { hostname } from "node:os"

const mod = await import("/Volumes/Eng-Dev/.upstream/spike/plugin.ts")
const hooks: any = await mod.default({
  project: { id: "spike", worktree: "/Volumes/Eng-Dev/.upstream/spike" },
  client: {} as any,
  $: (() => {}) as any,
  directory: "/Volumes/Eng-Dev/.upstream/spike",
  worktree: "/Volumes/Eng-Dev/.upstream/spike",
})

const declared = Object.keys(hooks).filter((k) => k !== "then")
console.log("hooks object keys exposed to the host:", declared.length, "— tool present:", declared.includes("tool"))

const ids = Object.keys(hooks.tool ?? {})
console.log("tool ids as the host will register them:", JSON.stringify(ids))

const result = await hooks.tool.gp_probe_status.execute({}, { sessionID: "ses_spike", messageID: "msg_spike", callID: "call_spike" })
console.log("--- title ---");   console.log(result.title)
console.log("--- output ---");  console.log(result.output)
console.log("--- metadata keys ---"); console.log(Object.keys(result.metadata ?? {}).join(", "))
console.log("--- metadata.engine (from daemon hello) ---")
console.log(JSON.stringify(result.metadata?.engine?.permissions ?? null), "host:", hostname())

const remedyOk = typeof result.output === "string" && result.output.length > 0
console.log("REMEDY VISIBLE TO THE MODEL (output is the only thing the model reads):", remedyOk ? "yes" : "NO — contract violation")
