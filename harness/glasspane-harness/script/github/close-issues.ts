#!/usr/bin/env bun

import { parseArgs } from "util"

// WRITE SCRIPT. Everything below POSTs comments and PATCHes issue state with $GITHUB_TOKEN, so the
// repository it names is a repository it changes. It used to name `anomalyco/opencode` — a repository
// this product does not own — which is how a fork's own dev script becomes a way to write on someone
// else's infrastructure. The default target is therefore this product's own repository, read from
// `product.json`'s `repo` (one source of truth, not a second copy of the name in a script), and any
// other repository needs the explicit opt-in below.
// Nothing in CI invokes this script at all: upstream's `.github/workflows/close-issues.yml` was
// deleted in the fork (recorded in `harness/contracts/fork-diff.json`), and grep finds this file
// referenced by no workflow, package.json script, or doc — so `--foreign-repo` is passed by nobody
// automatically, which is the point of making it a flag rather than a default.
const product = await Bun.file(new URL("../../product.json", import.meta.url)).json()
const ownRepo = requireOwnRepo(product)
const days = 60

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "foreign-repo": { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
})

if (values.help) {
  console.log(`
Usage: bun script/github/close-issues.ts [--foreign-repo <owner/name>]

Closes issues with no activity for ${days} days and posts the standard comment. This script WRITES:
it POSTs issue comments and PATCHes issue state to closed/not_planned using $GITHUB_TOKEN.

Target:
  default                 ${ownRepo} — this product's own repository, read from product.json's "repo"
  --foreign-repo <repo>   OPT-IN override naming a different repository to write to. Use it only when
                          you act for that repository and have authority over it; the run prints what
                          it is about to write and to whom before the first write, and no CI job
                          passes this flag.

Options:
  -h, --help              Show this help message
`)
  process.exit(0)
}

const repo = values["foreign-repo"] ?? ownRepo
if (!repo.includes("/")) {
  console.error(`Invalid repo ${JSON.stringify(repo)}; expected owner/name`)
  process.exit(1)
}
if (values["foreign-repo"]) {
  console.log(
    `FOREIGN REPOSITORY OPT-IN: this run writes to ${repo}, which is not this product's own repository (${ownRepo}).`,
  )
  console.log(
    `Writes it will perform: POST comments and PATCH state to closed/not_planned on open issues older than ${days} days whose author is not exempt.`,
  )
  console.log(
    `Credentials: $GITHUB_TOKEN of whoever ran this command. All of the above is printed before the first write; the run then proceeds with no further confirmation.`,
  )
}

const msg = `To stay organized issues are automatically closed after ${days} days of no activity. If the issue is still relevant please open a new one.`

const token = process.env.GITHUB_TOKEN
if (!token) {
  console.error("GITHUB_TOKEN environment variable is required")
  process.exit(1)
}

const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
const agentLogin = "opencode-agent[bot]"
const teamMembers = new Set(
  (await Bun.file(new URL("../../.github/TEAM_MEMBERS", import.meta.url)).text())
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean),
)
const teamAssociations = new Set(["OWNER", "MEMBER"])

type Issue = {
  number: number
  updated_at: string
  author_association: string
  user: { login: string } | null
}

const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
}

function shouldSkip(i: Issue) {
  const login = i.user?.login.toLowerCase()
  return login === agentLogin || (login ? teamMembers.has(login) : false) || teamAssociations.has(i.author_association)
}

async function close(num: number) {
  const base = `https://api.github.com/repos/${repo}/issues/${num}`

  const comment = await fetch(`${base}/comments`, {
    method: "POST",
    headers,
    body: JSON.stringify({ body: msg }),
  })
  if (!comment.ok) throw new Error(`Failed to comment #${num}: ${comment.status} ${comment.statusText}`)

  const patch = await fetch(base, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ state: "closed", state_reason: "not_planned" }),
  })
  if (!patch.ok) throw new Error(`Failed to close #${num}: ${patch.status} ${patch.statusText}`)

  console.log(`Closed https://github.com/${repo}/issues/${num}`)
}

async function main() {
  let page = 1
  let closed = 0

  while (true) {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/issues?state=open&sort=updated&direction=asc&per_page=100&page=${page}`,
      { headers },
    )
    if (!res.ok) throw new Error(res.statusText)

    const all = (await res.json()) as Issue[]
    if (all.length === 0) break
    console.log(`Fetched page ${page} ${all.length} issues`)

    const stale: number[] = []
    for (const i of all) {
      const updated = new Date(i.updated_at)
      if (updated < cutoff) {
        if (shouldSkip(i)) {
          console.log(`Skipping stale issue #${i.number}; author ${i.user?.login ?? "unknown"} is exempt`)
          continue
        }
        stale.push(i.number)
      } else {
        console.log(`\nFound fresh issue #${i.number}, stopping`)
        if (stale.length > 0) {
          for (const num of stale) {
            await close(num)
            closed++
          }
        }
        console.log(`Closed ${closed} issues total`)
        return
      }
    }

    if (stale.length > 0) {
      for (const num of stale) {
        await close(num)
        closed++
      }
    }

    page++
  }

  console.log(`Closed ${closed} issues total`)
}

function requireOwnRepo(product: { repo?: unknown }) {
  const own = typeof product.repo === "string" ? product.repo : ""
  if (!own.includes("/")) {
    console.error(
      `product.json has no usable "repo" (read ${JSON.stringify(product?.repo)}) — this script writes issues, so it needs the product's own repository as its default target rather than a guessed one`,
    )
    process.exit(1)
  }
  return own
}

main().catch((err) => {
  console.error("Error:", err)
  process.exit(1)
})
