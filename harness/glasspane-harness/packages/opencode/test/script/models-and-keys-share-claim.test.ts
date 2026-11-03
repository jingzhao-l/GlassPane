import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * Fixed point: every sentence `docs/models-and-keys.md` writes about the share channel is a command
 * a reader can run against this tree.
 *
 * The claim under test is the one `product.json` → `models.removedFirstParty` calls
 * "session sharing to opencode's cloud (share/share-next modules, share endpoints, share/autoshare
 * config keys, the GitHub bot's session card)". Two of those four items are not in this tree the way
 * the sentence says: the `share`/`autoshare` config keys are still declared and accepted, and the web
 * app's share markup — still embedded into every binary, because `build.ts` embeds it unless
 * `--skip-embed-web-ui` is passed — is stubbed off rather than deleted. The doc used to say nothing
 * about either, which left a reader with an assertion the shipped bytes can falsify.
 *
 * So the cases below do not re-derive a rule; they run the two greps the document itself prints and
 * assert the document's own answers, then check each named leftover at the file:line the document
 * points at. A claim that has moved out of the doc makes the matching case red — that is the point,
 * not the prose.
 */
const FORK = path.join(import.meta.dir, "../../../..")
const DOC = readFileSync(path.join(FORK, "docs/models-and-keys.md"), "utf8")

function section() {
  const start = DOC.indexOf("## Session sharing")
  if (start < 0) throw new Error("docs/models-and-keys.md has no `## Session sharing` section — the share channel is claimed nowhere a reader can check")
  const end = DOC.indexOf("\n## ", start + 1)
  return DOC.slice(start, end < 0 ? DOC.length : end)
}

async function grep(pattern: string, ...target: string[]) {
  const child = Bun.spawn(["grep", "-rn", pattern, ...target], { cwd: FORK, stdout: "pipe", stderr: "pipe" })
  const [code, stdout] = await Promise.all([child.exited, Bun.readableStreamToText(child.stdout)])
  return { hits: stdout.trim(), ran: code === 0 || code === 1 }
}

async function read(rel: string) {
  return readFileSync(path.join(FORK, rel), "utf8")
}

describe("the share-channel claims in docs/models-and-keys.md are checkable", () => {
  test("the document states both halves: the upload path is gone, the markup is left in", () => {
    const text = section()
    expect(text).toContain("No endpoint shares a session")
    expect(text).toContain("Left in")
    // The two leftovers the old blanket sentence erased. If the doc goes back to claiming the whole
    // channel was deleted, these two assertions are what go red.
    expect(text).toContain("session.share")
    expect(text).toContain("autoshare")
    // …and the fact that makes the leftovers shippable at all: embedding is the default.
    expect(text).toContain("--skip-embed-web-ui")
  })

  test("the route-table grep the document prints really answers nothing", async () => {
    const read = await grep('"/share', "packages/opencode/src/server/routes/instance/httpapi")
    expect(read.ran).toBe(true)
    expect(read.hits, `a share endpoint exists after all:\n${read.hits}`).toBe("")
  })

  test("and the share URL the document says is absent really is absent from the shipped sources", async () => {
    const read = await grep("opencode.ai/share", "packages/opencode/src", "packages/core/src", "packages/app/src", "packages/tui/src")
    expect(read.ran).toBe(true)
    expect(read.hits, `the binary's sources do reach a share host:\n${read.hits}`).toBe("")
  })

  test("web embedding is on by default, exactly as the document says", () => {
    const build = readFileSync(path.join(FORK, "packages/opencode/script/build.ts"), "utf8")
    expect(build).toContain('process.argv.includes("--skip-embed-web-ui")')
    expect(build).not.toMatch(/const embeddedFileMap = (?:true|null)[\s\S]{0,40}skipEmbedWebUi \?/)
    expect(build).toContain("const embeddedFileMap = skipEmbedWebUi ? null : await createEmbeddedWebUIBundle()")
  })

  test("the embedded app pins the affordances off, and the markup is still there to be dead", async () => {
    const timeline = await read("packages/app/src/pages/session/timeline/message-timeline.tsx")
    expect(timeline).toContain("const shareUrl = createMemo(() => undefined as string | undefined)")
    expect(timeline).toContain("const shareEnabled = createMemo(() => false)")
    expect(timeline).toMatch(/when=\{shareUrl\(\)\}/)
    const en = await read("packages/app/src/i18n/en.ts")
    expect(en).toContain('"session.share.action.share"')
    expect(en).toContain('"session.share.copy.copyLink"')
  })

  test("the config keys the document names are still accepted, and the local column still exists", async () => {
    const config = await read("packages/core/src/v1/config/config.ts")
    expect(config).toMatch(/^\s*share: Schema\.optional\(Schema\.Literals\(\["manual", "auto", "disabled"\]\)/m)
    expect(config).toMatch(/^\s*autoshare: Schema\.optional\(Schema\.Boolean\)/m)
    const sql = await read("packages/core/src/session/sql.ts")
    expect(sql).toContain("share_url: text()")
    const shareTable = await read("packages/core/src/share/sql.ts")
    expect(shareTable).toContain('sqliteTable("session_share"')
  })

  test("and the GitHub footer says where its session card went", async () => {
    const handler = await read("packages/opencode/src/cli/cmd/github.handler.ts")
    expect(handler).toMatch(/shareable session card/)
  })
})
