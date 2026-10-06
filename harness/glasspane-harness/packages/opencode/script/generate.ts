import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const modelsUrl = process.env.OPENCODE_MODELS_URL || "https://models.dev"

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
 * consumer declares (`Record<string, Provider>`, packages/core/src/models-dev.ts:136),
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

export const modelsData = process.env.MODELS_DEV_API_JSON
  ? await readCatalog(`MODELS_DEV_API_JSON (${process.env.MODELS_DEV_API_JSON})`, await Bun.file(process.env.MODELS_DEV_API_JSON).text())
  : await fetch(`${modelsUrl}/api.json`).then(async (response) => {
      if (!response.ok) throw new Error(`${modelsUrl}/api.json answered HTTP ${response.status} — refusing to build on a non-catalog response`)
      return readCatalog(`${modelsUrl}/api.json`, await response.text())
    })
console.log("Loaded models.dev snapshot")
