import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

// The catalog the binary embeds is a file in this tree, not a response.
//
// `build.ts` pipes `modelsData` into `Bun.build({ define })`, which is a source-text
// substitution: these bytes become part of the program that ships inside a GPG-signed,
// provenance-attested artifact. Reading them from a live endpoint meant the released tree could
// not be rebuilt from the tag it names, and the answer to "which provider base URLs and npm
// packages did we route users' keys through" belonged to whoever owned models.dev on build day.
// Refreshing it is now a deliberate commit — `docs/release.md` prints the command — and a missing
// file is a failed build, never a silent fall back onto the network.
// Fork root, not package root: `contracts/` is where the provenance files of this product live
// (`kernel-pin.json`, `kernel-conformance.json`), and the split repository must carry them.
const committedCatalog = path.resolve(__dirname, "..", "..", "..", "contracts", "models-catalog.json")
const modelsUrl = process.env.OPENCODE_MODELS_URL || "https://models.dev"
const liveFetch = process.env.GLASSPANE_MODELS_FETCH_LIVE === "1"

/**
 * `build.ts` puts this string into `Bun.build({define: {OPENCODE_MODELS_DEV: ...}})`,
 * and `define` is a **source-text** substitution — whatever these bytes are becomes part
 * of the program that ships to every user. Passing a raw body through is only safe by
 * coincidence: a JSON object literal happens to parse as a valid expression, so a
 * catalog looks fine, while anything else — an HTML captive portal from the intercepting
 * proxy this box routes GitHub assets through, a 200 with an error page, or a body
 * crafted as an expression — is pasted into the binary as code.
 *
 * So: require a real response, require it to be JSON, require the shape the runtime
 * consumer declares (`Record<string, Provider>` in `packages/core/src/models-dev.ts`),
 * and re-serialize. After this boundary the value can only ever be data, and a
 * non-catalog answer fails the build by name instead of compiling.
 */
const readCatalog = async (label: string, bytes: string) => {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes)
  } catch (cause) {
    throw new Error(`${label} is not valid JSON — refusing to inline it into the binary (${String(cause).split("\n")[0]})`)
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} is not a JSON object of providers — refusing to inline it into the binary`)
  }
  const providers = parsed as Record<string, unknown>
  const names = Object.keys(providers)
  if (names.length === 0) throw new Error(`${label} carries zero providers — an empty catalog is a failure, not a build`)
  for (const name of names) {
    if (providers[name] === null || typeof providers[name] !== "object") {
      throw new Error(`${label} has a non-object entry '${name}' where a provider was expected`)
    }
  }
  console.log(`Validated models.dev snapshot from ${label}: ${names.length} provider(s)`)
  return JSON.stringify(parsed)
}

const explicit = process.env.MODELS_DEV_API_JSON
if (!explicit && !liveFetch && !(await Bun.file(committedCatalog).exists())) {
  throw new Error(
    `${committedCatalog} is missing — this build embeds the model catalog from the tree and will NOT fall back to fetching it. Restore the file from the tag, or refresh it deliberately and commit it (the command is in docs/release.md, "Refreshing the model catalog").`,
  )
}

export const modelsData = explicit
  ? await readCatalog(`MODELS_DEV_API_JSON (${explicit})`, await Bun.file(explicit).text())
  : liveFetch
    ? await fetch(`${modelsUrl}/api.json`).then(async (response) => {
        if (!response.ok) throw new Error(`${modelsUrl}/api.json answered HTTP ${response.status} — refusing to build on a non-catalog response`)
        return readCatalog(`${modelsUrl}/api.json (GLASSPANE_MODELS_FETCH_LIVE=1)`, await response.text())
      })
    : await readCatalog("committed contracts/models-catalog.json", await Bun.file(committedCatalog).text())
console.log(`Loaded models snapshot from ${explicit ? "MODELS_DEV_API_JSON" : liveFetch ? "the live endpoint (explicit opt-in)" : "the committed snapshot"}`)
