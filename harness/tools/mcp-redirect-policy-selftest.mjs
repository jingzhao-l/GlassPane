#!/usr/bin/env node
/*
 * mcp-redirect-policy-selftest — proves the redirect gate can go red, and that each red is the one
 * this file claims.
 *
 *   node harness/tools/mcp-redirect-policy-selftest.mjs
 *
 * WHY. The gate exists because a sentence in the 0.10.1 SYNCLOG ("same-origin redirects are not
 * followed, which changes nothing on a loopback endpoint") turned out to be half wrong under
 * measurement: a 302 is refused even inside the origin, because following it would downgrade the
 * POST to a GET. An assumption written down is exactly as dangerous as one never written, so the
 * gate states five behaviours and drives the installed SDK's own transport. This selftest then
 * drives the gate: it flips one expectation at a time, breaks one endpoint shape at a time, and
 * builds throwaway fork roots for the three ways the gate can fail to measure at all. A case that
 * asserts only "exit 1" would still pass if every red collapsed into one generic message — which is
 * the failure mode `kernel-pin-selftest` was written to catch, so every expectation below names the
 * sentence it requires.
 *
 * Nothing in the real tree is edited. Mutants are copies under a 0700 temp directory, run against
 * the real install through the gate's GP_MCP_SDK_FORK seam; the refusal fixtures are synthetic roots
 * with nothing but package.json files in them. The tree's gate file is re-hashed at the end and must
 * match the bytes read at the start.
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const GATE = path.resolve(here, "mcp-redirect-policy.mjs")
const FORK = path.resolve(here, "..", "glasspane-harness")
const NAME = "@modelcontextprotocol/sdk"

const hash = (f) => createHash("sha256").update(readFileSync(f)).digest("hex")

if (!existsGate()) {
  console.error("mcp-redirect-policy-selftest: harness/tools/mcp-redirect-policy.mjs is not in the tree — nothing to test, so nothing was measured")
  process.exit(2)
}
function existsGate() {
  try {
    readFileSync(GATE)
    return true
  } catch {
    return false
  }
}

const pristine = readFileSync(GATE, "utf8")
const before = hash(GATE)
const root = mkdtempSync(path.join(tmpdir(), "gp-redirect-selftest-"))
chmodSync(root, 0o700)

let failures = 0
const check = (label, ok, detail = "") => {
  if (!label) {
    console.log("FAIL  an assertion arrived with no label — a blank expectation matches anything")
    failures += 1
    return
  }
  if (ok) {
    console.log(`ok    ${label}`)
    return
  }
  console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`)
  failures += 1
}

/** A mutant is a copy with one substitution; a needle that is not in the file is a case that would
 *  silently run unmutated code, so it is reported as a failure by name instead of being skipped. */
function mutant(name, from, to) {
  if (!pristine.includes(from)) {
    check(`mutant ${name} lands`, false, `the needle ${JSON.stringify(from.slice(0, 70))} is not in the gate — the case below would have measured the unmutated file`)
    return null
  }
  const file = path.join(root, `${name}.mjs`)
  writeFileSync(file, pristine.replace(from, to))
  return file
}

function run(file, forkRoot) {
  const env = { ...process.env }
  if (forkRoot === null) delete env.GP_MCP_SDK_FORK
  else env.GP_MCP_SDK_FORK = forkRoot
  const r = spawnSync(process.execPath, [file], { env, encoding: "utf8", timeout: 180_000 })
  return { rc: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }
}

/** A fork root that is only declarations — enough for the discovery refusals, which all fire before
 *  the SDK modules are imported. */
function fixture(name, { copies = [], declared }) {
  const dir = path.join(root, name)
  const specs = []
  for (const copy of copies) {
    const at = path.join(dir, ...copy.dir.split("/"), NAME, "package.json")
    mkdirSync(path.dirname(at), { recursive: true })
    writeFileSync(at, `{"name":"${NAME}","version":"${copy.version}"}\n`)
    specs.push(at)
  }
  if (declared) {
    const at = path.join(dir, "packages", "opencode", "package.json")
    mkdirSync(path.dirname(at), { recursive: true })
    writeFileSync(at, JSON.stringify({ name: "fixture", dependencies: { [NAME]: declared } }, null, 2))
  }
  return { dir, specs }
}

// ---- 1 the honest tree answers green, and says which copy it measured --------------------------
{
  const r = run(GATE, null)
  check("the shipped gate answers green on this tree", r.rc === 0, `rc=${r.rc} ${r.out.slice(0, 400)}`)
  check("and reports all five behaviours", (r.out.match(/^ok    /gm) ?? []).length === 5, r.out.slice(0, 400))
  const sdkReal = realpathSync(path.resolve(FORK, "packages/opencode/node_modules", NAME))
  const measured = (r.out.match(/the copy measured: (.+)/) ?? [])[1]?.trim()
  // The product resolves through a symlink into the bun store; this is what makes the verdict about
  // the transport the product builds rather than another copy on disk.
  check("the copy it measured is the one packages/opencode resolves to", measured === sdkReal, `measured ${measured ?? "(nothing)"}, expected ${sdkReal}`)
}

// ---- 2 a flipped expectation reddens the case by name ------------------------------------------
{
  const f = mutant("flipped-302", 'shape: { status: 302, sameOrigin: true }, expect: "refused"', 'shape: { status: 302, sameOrigin: true }, expect: "connected"')
  if (f) {
    const r = run(f, FORK)
    check("a permissive-looking 302 expectation goes red", r.rc === 1, `rc=${r.rc}`)
    check("and names the 302 case", r.out.includes("302 within the origin is refused"), r.out.slice(0, 400))
    check("and reports both sides of the disagreement", r.out.includes("expected connected, got refused"), r.out.slice(0, 400))
  }
}

// ---- 3 a "connected" that never touched a redirect target cannot pass --------------------------
{
  const f = mutant("vacuous-connected", '    if (request.pathname === "/moved") return initialize(request.json().id ?? 1)', '    if (request.pathname === "/mcp") return initialize(request.json().id ?? 1)')
  if (f) {
    const r = run(f, FORK)
    check("a connect that never reached the redirect target goes red", r.rc === 1, `rc=${r.rc}`)
    check("and says it never reached a target", r.out.includes("without reaching a redirect target"), r.out.slice(0, 500))
    check("and names a followed case rather than a count", r.out.includes("is followed"), r.out.slice(0, 500))
  }
}

// ---- 4 a refusal for the wrong reason is not a pass -------------------------------------------
{
  const f = mutant("wrong-reason-refusal", "return { status, headers: { location } }", 'return { status: 500, body: { error: "boom" }, headers: { location } }')
  if (f) {
    const r = run(f, FORK)
    check("a 500 where a redirect was expected goes red", r.rc === 1, `rc=${r.rc}`)
    check("and names the redirect statement the guard requires", r.out.includes("not with a redirect statement"), r.out.slice(0, 500))
  }
}

// ---- 5 both refusals permissive: the 1.32.0 security change is what is being caught ------------
{
  if (!pristine.includes('expect: "refused"')) {
    check("mutant permissive-refusals lands", false, 'no case expects "refused" — the file no longer states a refusal, so this battery is measuring nothing')
  } else {
    const file = path.join(root, "permissive-refusals.mjs")
    writeFileSync(file, pristine.split('expect: "refused"').join('expect: "connected"'))
    const r = run(file, FORK)
    check("an SDK that follows every redirect is caught", r.rc === 1, `rc=${r.rc}`)
    check("naming the in-origin 302 refusal", r.out.includes("302 within the origin is refused"), r.out.slice(0, 500))
    check("naming the cross-origin refusal", r.out.includes("307 to another port is refused"), r.out.slice(0, 500))
  }
}

// ---- 6 nothing installed: refuse, do not answer green ------------------------------------------
{
  const { dir } = fixture("no-install", { declared: "1.32.0" })
  const r = run(GATE, dir)
  check("an empty fork root exits 2", r.rc === 2, `rc=${r.rc} ${r.out.slice(0, 300)}`)
  check("and says nothing was observed", r.out.includes("no installed") && r.out.includes("nothing was observed"), r.out.slice(0, 300))
}

// ---- 7 two distinct copies: which one the product loads is not knowable -----------------------
// Store entries are named the way bun names them (`<name-with-+>@<version>+<peer hash>`), because
// the gate's discovery keys on that shape; naming them "a" and "b" would test the fixture instead of
// the refusal.
{
  const { dir } = fixture("two-copies", {
    copies: [
      { dir: "node_modules/.bun/@modelcontextprotocol+sdk@1.32.0+first/node_modules", version: "1.32.0" },
      { dir: "node_modules/.bun/@modelcontextprotocol+sdk@1.32.0+second/node_modules", version: "1.32.0" },
    ],
    declared: "1.32.0",
  })
  const r = run(GATE, dir)
  check("two distinct copies exit 2", r.rc === 2, `rc=${r.rc} ${r.out.slice(0, 300)}`)
  check("and name the count", r.out.includes("found 2"), r.out.slice(0, 300))
  check("and refuse attribution", r.out.includes("not knowable"), r.out.slice(0, 300))
}

// ---- 8 two locations that are one copy are NOT ambiguous --------------------------------------
// The over-reach case: dedupe is by realpath, because every bun layout shows a symlink beside the
// store bytes. Treating that as "two installs" would make the gate cry on a healthy tree, and a gate
// that cries gets deleted. It gets past discovery here (the refusal is absent) and only stops later,
// where a fixture with no dist is expected to stop.
{
  const storeEntry = "node_modules/.bun/@modelcontextprotocol+sdk@1.32.0+real/node_modules"
  const { dir } = fixture("symlinked-copy", {
    copies: [{ dir: storeEntry, version: "1.32.0" }],
    declared: "1.32.0",
  })
  const store = path.join(dir, ...storeEntry.split("/"), NAME)
  const link = path.join(dir, "packages", "opencode", "node_modules", NAME)
  mkdirSync(path.dirname(link), { recursive: true })
  symlinkSync(store, link, "dir")
  const r = run(GATE, dir)
  check("one copy seen through a symlink is not refused as ambiguous", !r.out.includes("found 2"), r.out.slice(0, 300))
  check("and the run continues past discovery to the import a fixture cannot satisfy", r.rc !== 2 && r.out.includes("Cannot find module"), `rc=${r.rc} ${r.out.slice(0, 300)}`)
}

// ---- 9 a range instead of a pin cannot be attributed ------------------------------------------
{
  const { dir } = fixture("range", { copies: [{ dir: "node_modules", version: "1.32.0" }], declared: "^1.32.0" })
  const r = run(GATE, dir)
  check("a range declaration exits 2", r.rc === 2, `rc=${r.rc} ${r.out.slice(0, 300)}`)
  check("and says which answer it needs", r.out.includes("a range") && r.out.includes("bun.lock"), r.out.slice(0, 300))
}

// ---- 10 the copy on disk is not the copy declared ----------------------------------------------
{
  const { dir } = fixture("mismatch", { copies: [{ dir: "node_modules", version: "1.32.0" }], declared: "1.31.0" })
  const r = run(GATE, dir)
  check("measuring an undeclared version goes red", r.rc === 1, `rc=${r.rc} ${r.out.slice(0, 300)}`)
  check("and says it is not the product's transport", r.out.includes("not the transport the product builds"), r.out.slice(0, 300))
}

// ---- the tree's bytes are the bytes this battery measured -------------------------------------
check("the gate file in the tree is untouched by the battery", hash(GATE) === before, `${hash(GATE)} != ${before}`)
rmSync(root, { recursive: true, force: true })

console.log(
  failures === 0
    ? "mcp-redirect-policy-selftest: every case verified red, and red for the named reason"
    : `mcp-redirect-policy-selftest: ${failures} assertion(s) FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
