#!/usr/bin/env node
/*
 * mcp-redirect-policy — pin what the MCP SDK's redirect rule does to the transport this product
 * actually builds, measured against the installed package rather than against its release notes.
 *
 * WHY THIS IS A CHECK AND NOT A NOTE. 0.10.1 bumped `@modelcontextprotocol/sdk` to 1.32.0, whose
 * security change is "follow a redirect only within the endpoint's origin". The SYNCLOG for that
 * round said, in words, that this makes no observable difference on a loopback endpoint — an
 * assumption nobody had measured. Measuring it (first run 2026-10-24) found the assumption half
 * wrong: same-origin is not the whole rule, because a 302 on a POST is refused *even within the
 * origin* — a 302 would downgrade the method to GET, and the SDK will not silently change the verb
 * of an MCP request. So this file asserts five behaviours by name, which is the difference between
 * "we read the changelog" and "we know what breaks if the daemon ever answers a redirect".
 *
 * The fork constructs the transport with no custom `fetch` (`src/mcp/index.ts` passes only
 * `authProvider` and `requestInit.headers`), so the SDK's own wrapper is what governs the request —
 * driving it here is driving the product's path, not a reinterpretation of it.
 *
 * `node:http` rather than `Bun.serve` on purpose: siblings in this directory are run with `node`,
 * and a gate that crashes under the interpreter a reader reaches for reads as a broken gate.
 *
 * Exit codes: 0 all five behaviours as stated, 1 one of them changed (or the loaded copy is not the
 * declared version), 2 cannot measure — no install, more than one distinct copy, a range instead of a
 * pin, or no declaration. Each of those says what to do: `bun install` in the fork, or name the copy
 * before asking a file what the product does.
 */
import { createServer } from "node:http"
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
// `GP_MCP_SDK_FORK` is for the battery in this directory's own discipline: mutants have to run as
// copies outside the tree, and this file finds the fork next door, so a copy in a scratch directory
// resolves to a fork with no install and every mutant would "fail" for that reason alone.
// Unset — CI, and anyone reading a checkout — it is the tree this file lives in.
const forkRoot = process.env.GP_MCP_SDK_FORK ? path.resolve(process.env.GP_MCP_SDK_FORK) : path.resolve(here, "..", "glasspane-harness")
const NAME = "@modelcontextprotocol/sdk"

function refuse(code, message) {
  console.error(`mcp-redirect-policy: ${message}`)
  process.exit(code)
}

/**
 * Every directory the fork could load `NAME` from, deduped by realpath: the root install, each
 * workspace package's own, and the bun store (where the bytes actually live when the first two are
 * symlinks into it). Same three roots as `script/patched-deps.mjs` reads, for the same reason — a
 * gate that looks in one place answers "not installed" whenever the layout moves, and a gate that
 * measures a copy the product does not load answers about bytes nobody runs.
 */
function installsOf(name) {
  const levels = [path.join(forkRoot, "node_modules", name)]
  const packagesDir = path.join(forkRoot, "packages")
  if (existsSync(packagesDir)) {
    for (const workspace of readdirSync(packagesDir).sort()) levels.push(path.join(packagesDir, workspace, "node_modules", name))
  }
  const store = path.join(forkRoot, "node_modules", ".bun")
  if (existsSync(store)) {
    const key = `${name.replace("/", "+")}@`
    for (const entry of readdirSync(store).sort()) {
      if (entry.startsWith(key)) levels.push(path.join(store, entry, "node_modules", name))
    }
  }
  const seen = new Map()
  for (const dir of levels) {
    if (!existsSync(path.join(dir, "package.json"))) continue
    let real
    try {
      real = realpathSync(dir)
    } catch {
      continue
    }
    if (!seen.has(real)) seen.set(real, dir)
  }
  return [...seen.entries()]
}

const found = installsOf(NAME)
const where = process.env.GP_MCP_SDK_FORK ? "the fork root GP_MCP_SDK_FORK names" : "the fork beside this file"
if (found.length === 0) {
  refuse(2, `no installed ${NAME} under ${forkRoot} (${where}) — looked in node_modules, packages/*/node_modules and node_modules/.bun; run 'bun install' in the fork, because nothing was observed`)
}
if (found.length > 1) {
  refuse(2, `expected one installed ${NAME}, found ${found.length} distinct copies (${found.map(([real]) => real).join(", ")}) — which one the product loads is not knowable from here, so no behaviour measured here can be attributed to it`)
}
const sdkDir = found[0][0]
const sdkPackage = JSON.parse(readFileSync(path.join(sdkDir, "package.json"), "utf8"))
// Binding the copy under test to the version the product declares is what makes the five verdicts
// about *this product's* transport rather than about an SDK that happens to be on disk. An exact pin
// is checkable; a range is not resolvable from here, so the gate says it cannot measure.
const declaredPackage = path.join(forkRoot, "packages", "opencode", "package.json")
if (!existsSync(declaredPackage)) refuse(2, `no ${declaredPackage} — the declaration that would name the version is not in the tree`)
const declaredSpec = JSON.parse(readFileSync(declaredPackage, "utf8")).dependencies?.[NAME]
if (!declaredSpec) refuse(2, `packages/opencode declares no dependency on ${NAME} — there is no version to bind the measured copy to`)
if (/[\^~><*x|]/.test(declaredSpec)) {
  refuse(2, `packages/opencode declares ${NAME}@${declaredSpec}, a range: which version resolves is the lockfile's answer, so this gate cannot name the copy it measured. Read the resolution (script/patched-deps.mjs reads bun.lock) and pin it before treating these five behaviours as the product's.`)
}
if (sdkPackage.version !== declaredSpec) {
  refuse(1, `the copy this gate loaded at ${sdkDir} is ${sdkPackage.version} but packages/opencode declares ${declaredSpec} — it is not the transport the product builds, so its redirect behaviour says nothing about this release`)
}

const { Client } = await import(pathToFileURL(path.join(sdkDir, "dist/esm/client/index.js")).href)
const { StreamableHTTPClientTransport } = await import(pathToFileURL(path.join(sdkDir, "dist/esm/client/streamableHttp.js")).href)
const { LATEST_PROTOCOL_VERSION } = await import(pathToFileURL(path.join(sdkDir, "dist/esm/types.js")).href)

const HOST = "127.0.0.1"

function listen(handler) {
  const server = createServer((request, response) => {
    const chunks = []
    request.on("data", (chunk) => chunks.push(chunk))
    request.on("end", async () => {
      let result
      try {
        result = await handler({
          method: request.method ?? "GET",
          pathname: new URL(request.url ?? "/", `http://${HOST}`).pathname,
          json: () => JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"),
        })
      } catch (error) {
        result = { status: 500, body: String(error) }
      }
      const body = (result ?? { status: 404 }).body ?? ""
      response.writeHead(result?.status ?? 404, { "content-type": "application/json", ...(result?.headers ?? {}) })
      response.end(typeof body === "string" ? body : JSON.stringify(body))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, HOST, () => resolve({ server, port: server.address().port }))
  })
}

const initialize = (id) => ({
  status: 200,
  body: {
    jsonrpc: "2.0",
    id,
    result: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, serverInfo: { name: "probe", version: "1" } },
  },
})

/** One case: a front server whose `/mcp` redirects, and a second server for the cross-origin target. */
async function probe({ status, sameOrigin, policy }) {
  // Names, not paths: a verdict of "connected" is only worth anything if the hit list shows which
  // endpoint answered, and a path read off the wire (`front:/moved`) is easy to compare against the
  // wrong string. Each endpoint has one label and the labels are what the assertions below use.
  const hits = []
  const other = await listen(async (request) => {
    hits.push("other-endpoint")
    if (request.method !== "POST") return { status: 405 }
    return initialize(request.json().id ?? 1)
  })
  const front = await listen(async (request) => {
    hits.push(request.pathname === "/moved" ? "front-redirect-target" : "front-endpoint")
    if (request.method !== "POST") return { status: 405 }
    if (request.pathname === "/moved") return initialize(request.json().id ?? 1)
    const location = sameOrigin ? `http://${HOST}:${front.port}/moved` : `http://${HOST}:${other.port}/mcp`
    return { status, headers: { location } }
  })
  // The handler below reads `front.port`, which is settled by the time a request arrives.

  const client = new Client({ name: "probe", version: "1" })
  const transport = new StreamableHTTPClientTransport(new URL(`http://${HOST}:${front.port}/mcp`), policy ? { redirectPolicy: policy } : {})
  let outcome = "connected"
  let reported = ""
  try {
    await client.connect(transport)
    await client.close()
  } catch (cause) {
    outcome = "refused"
    reported = `${cause instanceof Error ? cause.message : String(cause)}`.replace(/\s+/g, " ")
  } finally {
    front.server.close()
    other.server.close()
  }
  return { outcome, reported, hits }
}

const cases = [
  { name: "307 within the origin (same host and port) is followed", shape: { status: 307, sameOrigin: true }, expect: "connected" },
  { name: "308 within the origin is followed", shape: { status: 308, sameOrigin: true }, expect: "connected" },
  // The half the 2026-10-23 ledger sentence missed: the rule is not only about origins.
  { name: "302 within the origin is refused — a 302 would downgrade the POST to a GET", shape: { status: 302, sameOrigin: true }, expect: "refused" },
  { name: "307 to another port is refused (loopback-to-loopback across ports is still cross-origin)", shape: { status: 307, sameOrigin: false }, expect: "refused" },
  { name: "redirectPolicy: 'follow' opts back out, and the cross-origin redirect is taken", shape: { status: 307, sameOrigin: false, policy: "follow" }, expect: "connected" },
]

let failures = 0
console.log(`mcp-redirect-policy — SDK ${sdkPackage.version}, declared as ${NAME}@${declaredSpec}`)
console.log(`  the copy measured: ${sdkDir}`)
for (const one of cases) {
  const seen = await probe(one.shape)
  if (seen.outcome !== one.expect) {
    failures += 1
    console.log(`FAIL  ${one.name}: expected ${one.expect}, got ${seen.outcome}; path ${JSON.stringify(seen.hits)}${seen.reported ? `; reported: ${seen.reported.slice(0, 160)}` : ""}`)
    continue
  }
  // A refusal has to say why, and a "connected" has to have actually reached a redirect target —
  // otherwise the same verdict could come from a transport that never issued the request at all.
  if (one.expect === "refused" && !seen.reported.includes("not followed")) {
    failures += 1
    console.log(`FAIL  ${one.name}: refused, but not with a redirect statement: ${seen.reported.slice(0, 160)}`)
    continue
  }
  const reachedTarget = seen.hits.includes("front-redirect-target") || seen.hits.includes("other-endpoint")
  if (one.expect === "connected" && !reachedTarget) {
    failures += 1
    console.log(`FAIL  ${one.name}: reported connected without reaching a redirect target — path ${JSON.stringify(seen.hits)}`)
    continue
  }
  console.log(`ok    ${one.name}`)
}

if (failures > 0) refuse(1, `${failures} of ${cases.length} stated behaviours did not hold — the installed SDK changed what the product's transport does with redirects`)
console.log(`mcp-redirect-policy: all ${cases.length} behaviours hold, and a refusal still explains itself as "not followed"`)
