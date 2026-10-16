import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { fileURLToPath } from "url"
import path from "node:path"
import yargs from "yargs"
import { Installation } from "../../../src/installation"
import { UpgradeCommand } from "../../../src/cli/cmd/upgrade"
import { tmpdir } from "../../fixture/fixture"

// The registry asserted here is the product's declared fact (product.json), which
// harness/tools/product-surface.mjs gates every npm-facing lane to — not a copy of a constant the
// fix declares.
const Registry = ((await Bun.file(fileURLToPath(new URL("../../../../../product.json", import.meta.url))).json()) as {
  registry: string
}).registry

// A package manager that records the argv it was handed and answers what the product's detection
// looks for. Every spawn the upgrade command performs resolves through PATH, so a PATH holding only
// these stubs (plus the system directories Effect's spawner needs) means no real npm, pnpm, bun or
// brew is ever asked to install or upgrade anything.
async function stub(dir: string, name: string, log: string, answers: Record<string, string>) {
  const script = [
    "#!/bin/sh",
    `{ printf '${name}'; for a in "$@"; do printf ' %s' "$a"; done; printf '\\n'; } >> ${log}`,
    "case \"$1\" in",
    ...Object.entries(answers).map(([call, out]) => `  ${call}) echo '${out}' ;;`),
    "esac",
    "",
  ].join("\n")
  const file = path.join(dir, name)
  await Bun.write(file, script)
  await fs.chmod(file, 0o755)
}

async function calls(log: string) {
  return (await Bun.file(log).text().catch(() => ""))
    .split("\n")
    .map((call) => call.trim())
    .filter((call) => call.length > 0)
}

// Runs the real command handler with the managers stubbed, and returns what it printed.
async function runHandler(args: { target?: string; method?: string }, dir: string) {
  const previousPath = process.env.PATH
  const previousWrite = process.stdout.write.bind(process.stdout)
  const printed: string[] = []
  process.stdout.write = ((chunk: string | Uint8Array) => {
    printed.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  process.env.PATH = `${dir}:/usr/bin:/bin`
  try {
    await UpgradeCommand.handler(args)
  } finally {
    process.stdout.write = previousWrite
    process.env.PATH = previousPath
  }
  return printed.join("")
}

function parse(argv: readonly string[]) {
  const handled: string[] = []
  const errors: string[] = []
  yargs([...argv])
    .scriptName("glasspane-harness")
    .command({
      command: UpgradeCommand.command,
      describe: UpgradeCommand.describe,
      builder: UpgradeCommand.builder,
      handler: (args) => {
        handled.push(String(args.method))
      },
    })
    .fail((message) => {
      errors.push(message ?? "")
    })
    .exitProcess(false)
    .parseSync(argv)
  return { handled, errors: errors.join(" ") }
}

describe("glasspane-harness upgrade channels", () => {
  // [gp] Product: the `--method` offer still listed brew, choco and scoop after the fork stopped
  // publishing to them, so the CLI advertised three upgrade paths whose only possible ending is
  // "this channel does not exist". This is the real parser's verdict on real argv: those three are
  // rejected, and every channel the update path serves is accepted.
  test("--method accepts only the channels this product publishes to", () => {
    for (const method of ["brew", "choco", "scoop"]) {
      const result = parse(["upgrade", "--method", method, "9.9.9"])
      // The shipped CLI's `.fail()` (src/index.ts) exits on this message, so the validation error
      // is the rejection. The `Choices:` list must not still carry the channel being rejected —
      // that would mean the refusal came from somewhere other than the offer this fix narrows.
      expect(result.errors).toContain("Invalid values")
      expect(result.errors).toContain(`Given: "${method}"`)
      expect(result.errors.split("Choices:")[1]?.includes(`"${method}"`)).toBe(false)
    }

    for (const method of Installation.UpdateChannels) {
      const result = parse(["upgrade", "--method", method, "9.9.9"])
      expect(result.errors).toBe("")
      expect(result.handled).toEqual([method])
    }
  })

  // [gp] Product: the refusal for a channel this product does not publish to lived inside
  // `latest()`, and an explicit `[target]` never calls `latest()` — so
  // `glasspane-harness upgrade 1.2.3` on a brew install handed brew an upgrade instruction for a
  // package this product never shipped to brew. The gate is the method now, not the version lookup.
  test("an explicit target on a brew install refuses instead of running brew upgrade", async () => {
    await using tmp = await tmpdir()
    const log = path.join(tmp.path, "calls.log")
    await stub(tmp.path, "npm", log, {})
    await stub(tmp.path, "yarn", log, {})
    await stub(tmp.path, "pnpm", log, {})
    await stub(tmp.path, "bun", log, {})
    await stub(tmp.path, "scoop", log, {})
    await stub(tmp.path, "choco", log, {})
    await stub(tmp.path, "brew", log, {
      list: "glasspane-harness",
      info: '[{"name":"glasspane-harness","full_name":"glasspane-harness"}]',
    })

    const printed = await runHandler({ target: "9.9.9" }, tmp.path)
    const recorded = await calls(log)

    // The detection really did see a brew-managed install — without that premise, the refusal below
    // would prove nothing about the case being fixed.
    expect(recorded).toContain("brew list --formula glasspane-harness")
    expect(recorded.some((call) => call.startsWith("brew upgrade"))).toBe(false)
    expect(printed).toContain("publishes no brew package")
    expect(printed).toContain("npm install -g glasspane-harness")
  })

  // The gate is not decoration in the other direction either: a channel this product does publish
  // to still reaches its package manager, and the install leg names the product's registry.
  test("an explicit target on a supported channel still runs the install, with the registry pinned", async () => {
    await using tmp = await tmpdir()
    const log = path.join(tmp.path, "calls.log")
    await stub(tmp.path, "npm", log, {})
    await stub(tmp.path, "brew", log, {})

    const printed = await runHandler({ method: "npm", target: "9.9.9" }, tmp.path)
    const recorded = await calls(log)

    expect(recorded).toContain(`npm install -g --registry ${Registry} glasspane-harness@9.9.9`)
    expect(printed).toContain("Upgrade complete")
  })
})
