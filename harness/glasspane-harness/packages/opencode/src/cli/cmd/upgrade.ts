import type { Argv } from "yargs"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { Installation } from "../../installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"

export const UpgradeCommand = {
  command: "upgrade [target]",
  describe: "upgrade glasspane-harness to the latest or a specific version",
  builder: (yargs: Argv) => {
    return yargs
      .positional("target", {
        describe: "version to upgrade to, for ex '0.1.48' or 'v0.1.48'",
        type: "string",
      })
      .option("method", {
        alias: "m",
        describe: "installation method to use",
        type: "string",
        // [gp] Product: only the channels this product publishes a version feed to. brew/choco/scoop
        // stayed in this list after the fork stopped publishing to them, so the CLI advertised an
        // upgrade path whose every ending is "there is no such channel". The list is Installation's
        // own, so the offer and `latest()`'s refusal cannot drift apart again.
        choices: [...Installation.UpdateChannels],
      })
  },
  handler: async (args: { target?: string; method?: string }) => {
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro("Upgrade")
    const detectedMethod = await Installation.method()
    const method = (args.method as Installation.Method) ?? detectedMethod
    if (method === "unknown") {
      prompts.log.error(`glasspane-harness is installed to ${process.execPath} and may be managed by a package manager`)
      const install = await prompts.select({
        message: "Install anyways?",
        options: [
          { label: "Yes", value: true },
          { label: "No", value: false },
        ],
        initialValue: false,
      })
      if (!install) {
        prompts.outro("Done")
        return
      }
    }
    // [gp] Product: the gate is the method, not a side effect of looking a version up. An
    // explicit [target] skipped `latest()` altogether, and `latest()` is where the refusal for a
    // channel this product does not publish to lives — so `glasspane-harness upgrade 1.2.3` on a
    // brew or scoop install handed that manager an upgrade instruction for a package this product
    // never shipped. Same sentence as the `latest()` path, from the same helper.
    if (!Installation.isUpdateChannel(method)) {
      prompts.log.warn(Installation.noUpdateChannel(method).message)
      prompts.outro("Done")
      return
    }
    prompts.log.info("Using method: " + method)
    // `latest()` now refuses for a channel this product does not publish to, instead of
    // reading some other project's release feed. The refusal carries the sentence the user
    // needs, so it is delivered as a warning and the command ends — not as an exception
    // through yargs' `.fail()`, which is what an unguarded `await` would have done.
    let target: string
    if (args.target) {
      target = args.target.replace(/^v/, "")
    } else {
      const latest = await Installation.latest().catch((err) => err)
      if (latest instanceof Installation.NoUpdateChannelError) {
        prompts.log.warn(latest.message)
        prompts.outro("Done")
        return
      }
      if (latest instanceof Error) throw latest
      target = latest
    }

    if (InstallationVersion === target) {
      prompts.log.warn(`glasspane-harness upgrade skipped: ${target} is already installed`)
      prompts.outro("Done")
      return
    }

    prompts.log.info(`From ${InstallationVersion} → ${target}`)
    const spinner = prompts.spinner()
    spinner.start("Upgrading...")
    const err = await Installation.upgrade(method, target).catch((err) => err)
    if (err) {
      spinner.stop("Upgrade failed", 1)
      if (err instanceof Installation.UpgradeFailedError) {
        // necessary because choco only allows install/upgrade in elevated terminals
        if (method === "choco" && err.stderr.includes("not running from an elevated command shell")) {
          prompts.log.error("Please run the terminal as Administrator and try again")
        } else {
          prompts.log.error(err.stderr)
        }
      } else if (err instanceof Error) prompts.log.error(err.message)
      prompts.outro("Done")
      return
    }
    spinner.stop("Upgrade complete")
    prompts.outro("Done")
  },
}
