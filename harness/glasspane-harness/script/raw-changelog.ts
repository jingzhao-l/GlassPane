#!/usr/bin/env bun

import { $ } from "bun"
import { parseArgs } from "util"

// READ, not write — the distinction that decides this script's fix. Every GitHub call below is a GET:
// `/repos/<repo>/releases`, `/repos/<repo>/compare/<base>...<head>`, and `gh release view`, plus local
// `git log` / `git diff-tree`. Nothing POSTs, PATCHes, closes or labels, so naming a repository here
// asks its release notes a question rather than writing on someone else's infrastructure. That is why
// the fix is an explicit printed source and not a block — contrast `script/github/close-issues.ts` and
// `script/github/close-prs.ts`, which do write and therefore refuse a foreign target unless an
// operator opts in.
// The default target is now this product's own repository, because the changelog assembled here joins
// the remote's commit metadata with LOCAL refs: `git log ${base}..${head}` resolves the tags this tree
// carries, and those are our `v0.x` tags, not upstream's `v1.18.x`. Reading `anomalyco/opencode` by
// default therefore asked one repository for its releases and another for its bytes, and printed the
// intersection. `--repo` (or `GH_REPO`) still reads any repository's public release data, and the
// output header always names which one was read, so a changelog can never be silent about its source.
const product = await Bun.file(new URL("../product.json", import.meta.url)).json()
const ownRepo = requireOwnRepo(product)

const { values: cli } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    from: { type: "string", short: "f" },
    to: { type: "string", short: "t", default: "HEAD" },
    repo: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
})

const repo = cli.repo ?? process.env.GH_REPO ?? ownRepo
if (!repo.includes("/")) {
  console.error(`Invalid repo ${JSON.stringify(repo)}; expected owner/name`)
  process.exit(1)
}

type Release = {
  tag_name: string
  draft: boolean
}

type Commit = {
  hash: string
  author: string | null
  message: string
  areas: Set<string>
}

type User = Map<string, Set<string>>
type Diff = {
  sha: string
  login: string | null
  message: string
}

const bot = ["actions-user", "github-actions[bot]", "opencode", "opencode-agent[bot]"]
// `.github/TEAM_MEMBERS` is upstream's file and is NOT in this tree (measured: `git ls-files | grep
// -i team_members` answers nothing), so the old unconditional read crashed this script before it
// printed a line — the defect below could not even be demonstrated. The list only decides which
// authors are exempt from the "thanks" section, so a missing one is a stated gap in the output, not
// a safety property: read it when present, say loudly when it is not, and keep the bot exclusions.
const teamFile = new URL("../.github/TEAM_MEMBERS", import.meta.url)
const teamNames = (await Bun.file(teamFile).exists())
  ? await Bun.file(teamFile)
      .text()
      .then((x) => x.split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !x.startsWith("#")))
  : []
if (!teamNames.length) console.error(`NOTE: no team-exempt list (../.github/TEAM_MEMBERS is absent from this tree), so team members are counted as community contributors in the thanks section`)
const team = [...teamNames, ...bot]
const order = ["Core", "TUI", "Desktop", "SDK", "Extensions"] as const
const sections = {
  core: "Core",
  tui: "TUI",
  app: "Desktop",
  tauri: "Desktop",
  sdk: "SDK",
  plugin: "SDK",
  "extensions/vscode": "Extensions",
  github: "Extensions",
} as const

function ref(input: string) {
  if (input === "HEAD") return input
  if (input.startsWith("v")) return input
  if (input.match(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/)) return `v${input}`
  return input
}

async function latest() {
  const data = await $`gh api "/repos/${repo}/releases?per_page=100"`.json()
  const release = (data as Release[]).find((item) => !item.draft)
  if (!release) throw new Error("No releases found")
  return release.tag_name.replace(/^v/, "")
}

async function diff(base: string, head: string) {
  const list: Diff[] = []
  for (let page = 1; ; page++) {
    const text =
      await $`gh api "/repos/${repo}/compare/${base}...${head}?per_page=100&page=${page}" --jq '.commits[] | {sha: .sha, login: .author.login, message: .commit.message}'`.text()
    const batch = text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Diff)
    if (batch.length === 0) break
    list.push(...batch)
    if (batch.length < 100) break
  }
  return list
}

function section(areas: Set<string>) {
  const priority = ["core", "tui", "app", "tauri", "sdk", "plugin", "extensions/vscode", "github"]
  for (const area of priority) {
    if (areas.has(area)) return sections[area as keyof typeof sections]
  }
  return "Core"
}

function type(message: string) {
  if (message.match(/fix/i)) return "Bugfixes"
  return "Improvements"
}

function reverted(commits: Commit[]) {
  const seen = new Map<string, Commit>()

  for (const commit of commits) {
    const match = commit.message.match(/^Revert "(.+)"$/)
    if (match) {
      const msg = match[1]!
      if (seen.has(msg)) seen.delete(msg)
      else seen.set(commit.message, commit)
      continue
    }

    const revert = `Revert "${commit.message}"`
    if (seen.has(revert)) {
      seen.delete(revert)
      continue
    }

    seen.set(commit.message, commit)
  }

  return [...seen.values()]
}

async function commits(from: string, to: string) {
  const base = ref(from)
  const head = ref(to)

  const data = new Map<string, { login: string | null; message: string }>()
  for (const item of await diff(base, head)) {
    data.set(item.sha, { login: item.login, message: item.message.split("\n")[0] ?? "" })
  }

  const log =
    await $`git log ${base}..${head} --format=%H -- packages/opencode packages/sdk packages/plugin packages/desktop packages/app sdks/vscode packages/extensions github`.text()

  const list: Commit[] = []
  for (const hash of log.split("\n").filter(Boolean)) {
    const item = data.get(hash)
    if (!item) continue
    if (item.message.match(/^(ignore:|test:|chore:|ci:|release:)/i)) continue

    const diff = await $`git diff-tree --no-commit-id --name-only -r ${hash}`.text()
    const areas = new Set<string>()

    for (const file of diff.split("\n").filter(Boolean)) {
      if (file.startsWith("packages/opencode/src/cli/cmd/")) areas.add("tui")
      else if (file.startsWith("packages/opencode/")) areas.add("core")
      else if (file.startsWith("packages/desktop/src-tauri/")) areas.add("tauri")
      else if (file.startsWith("packages/desktop/") || file.startsWith("packages/app/")) areas.add("app")
      else if (file.startsWith("packages/sdk/") || file.startsWith("packages/plugin/")) areas.add("sdk")
      else if (file.startsWith("sdks/vscode/") || file.startsWith("github/")) areas.add("extensions/vscode")
    }

    if (areas.size === 0) continue

    list.push({
      hash: hash.slice(0, 7),
      author: item.login,
      message: item.message,
      areas,
    })
  }

  return reverted(list)
}

async function contributors(from: string, to: string) {
  const base = ref(from)
  const head = ref(to)

  const users: User = new Map()
  for (const item of await diff(base, head)) {
    const title = item.message.split("\n")[0] ?? ""
    if (!item.login || team.includes(item.login)) continue
    if (title.match(/^(ignore:|test:|chore:|ci:|release:)/i)) continue
    if (!users.has(item.login)) users.set(item.login, new Set())
    users.get(item.login)!.add(title)
  }

  return users
}

async function published(to: string) {
  if (to === "HEAD") return
  const body = await $`gh release view ${ref(to)} --repo ${repo} --json body --jq .body`.text().catch(() => "")
  if (!body) return

  const lines = body.split(/\r?\n/)
  const start = lines.findIndex((line) => line.startsWith("**Thank you to "))
  if (start < 0) return
  return lines.slice(start).join("\n").trim()
}

async function thanks(from: string, to: string, reuse: boolean) {
  const release = reuse ? await published(to) : undefined
  if (release) return release.split(/\r?\n/)

  const users = await contributors(from, to)
  if (users.size === 0) return []

  const lines = [`**Thank you to ${users.size} community contributor${users.size > 1 ? "s" : ""}:**`]
  for (const [name, commits] of users) {
    lines.push(`- @${name}:`)
    for (const commit of commits) lines.push(`  - ${commit}`)
  }
  return lines
}

function format(from: string, to: string, list: Commit[], thanks: string[]) {
  const grouped = new Map<string, Map<string, string[]>>()
  for (const title of order) {
    grouped.set(
      title,
      new Map([
        ["Improvements", []],
        ["Bugfixes", []],
      ]),
    )
  }

  for (const commit of list) {
    const attr = commit.author && !team.includes(commit.author) ? ` (@${commit.author})` : ""
    grouped.get(section(commit.areas))!.get(type(commit.message))!.push(`- \`${commit.hash}\` ${commit.message}${attr}`)
  }

  const lines = [
    `Source repository: ${repo} (READ ONLY — this script only GETs releases, compare data and release bodies; it writes nothing anywhere)`,
    ...(repo === ownRepo
      ? []
      : [`Foreign read target: this product's own repository is ${ownRepo}, so this output describes ${repo}'s releases, not ours`]),
    `Last release: ${ref(from)}`,
    `Target ref: ${to}`,
    "",
  ]

  if (list.length === 0) {
    lines.push("No notable changes.")
  }

  for (const title of order) {
    const groups = grouped.get(title)
    if (!groups || [...groups.values()].every((entries) => entries.length === 0)) continue
    lines.push(`## ${title}`)
    const improvements = groups.get("Improvements")!
    const bugfixes = groups.get("Bugfixes")!
    if (bugfixes.length === 0) {
      lines.push(...improvements)
      lines.push("")
      continue
    }

    for (const [subtitle, entries] of groups) {
      if (entries.length === 0) continue
      lines.push(`### ${subtitle}`)
      lines.push(...entries)
      lines.push("")
    }
  }

  if (thanks.length > 0) {
    if (lines.at(-1) !== "") lines.push("")
    lines.push("## Community Contributors Input")
    lines.push("")
    lines.push(...thanks)
  }

  if (lines.at(-1) === "") lines.pop()
  return lines.join("\n")
}

function requireOwnRepo(product: { repo?: unknown }) {
  const own = typeof product.repo === "string" ? product.repo : ""
  if (!own.includes("/")) {
    console.error(
      `product.json has no usable "repo" (read ${JSON.stringify(product?.repo)}) — this script prints which repository a changelog was read from, so it needs the product's own repository as its default source`,
    )
    process.exit(1)
  }
  return own
}

if (import.meta.main) {
  if (cli.help) {
    console.log(`
Usage: bun script/raw-changelog.ts [options]

Builds a changelog from commit metadata. READ ONLY: every GitHub call is a GET (releases, compare,
release body) and the local calls are \`git log\` / \`git diff-tree\`. Nothing is created, edited or
closed. The source repository is printed in the output header, because a changelog that does not say
whose releases it read is a second answer to one question.

Options:
  -f, --from <version>   Starting version (default: latest non-draft GitHub release of the source repo)
  -t, --to <ref>         Ending ref (default: HEAD)
  --repo <owner/name>    Repository to READ from (default: ${ownRepo}, this product's own repository —
                         the tags \`git log\` resolves here are ours; override only to read another
                         repository's public release data, e.g. upstream's for lineage)
  -h, --help             Show this help message

Examples:
  bun script/raw-changelog.ts
  bun script/raw-changelog.ts --from 0.14.1
  bun script/raw-changelog.ts -f 0.14.1 -t 0.14.2
  bun script/raw-changelog.ts --repo anomalyco/opencode --from 1.0.200   # reads upstream, says so
`)
    process.exit(0)
  }

  const to = cli.to
  const from = cli.from ?? (await latest())
  const list = await commits(from, to)
  console.log(format(from, to, list, await thanks(from, to, !cli.from)))
}
