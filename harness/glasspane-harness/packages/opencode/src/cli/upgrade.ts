import { Config } from "@/config/config"
import { AppRuntime } from "@/effect/app-runtime"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Installation } from "@/installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { GlobalBus } from "@/bus/global"

/**
 * [gp] Product: whether the auto-update path may attempt a self-upgrade for this
 * detected install method.
 *
 * `curl` is a channel for *reading* a version (a curl install checks this product's own
 * GitHub releases), but it is not a channel this product can *self-upgrade* over —
 * `Installation.upgrade("curl", …)` always refuses with "does not self-upgrade over
 * curl". Reaching that call from auto-update and swallowing the refusal (the old
 * `.catch(() => {})` in `upgrade()`) meant a curl-installed copy silently did nothing
 * on every patch, and the only signal was a throw that was discarded. Exported so the
 * guard has a fixed-point test with a reverse control: the predicate is the gate, and a
 * channel that cannot self-upgrade must not reach `Installation.upgrade` at all.
 */
export function canSelfUpgrade(method: string): boolean {
  return method !== "curl"
}

export async function upgrade() {
  const config = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal()))
  if (config.autoupdate === false || Flag.OPENCODE_DISABLE_AUTOUPDATE) return
  const method = await Installation.method()
  // Ask first whether this copy has a channel at all. Checking that after the fetch
  // meant a network round trip on every startup for installs this product cannot
  // update, and whatever it returned was not this product's version.
  if (method === "unknown") return
  const latest = await Installation.latest(method).catch(() => {})
  if (!latest) return

  if (Flag.OPENCODE_ALWAYS_NOTIFY_UPDATE) {
    GlobalBus.emit("event", {
      directory: "global",
      payload: {
        type: Installation.Event.UpdateAvailable.type,
        properties: { version: latest },
      },
    })
    return
  }

  if (InstallationVersion === latest) return

  // [gp] Product guard (see `canSelfUpgrade`): a channel this product cannot self-upgrade
  // over is a known no-op here, not an error to hide. Failing fast, before the upgrade
  // attempt, keeps the auto-update path honest.
  if (!canSelfUpgrade(method)) return

  const kind = Installation.getReleaseType(InstallationVersion, latest)

  if (config.autoupdate === "notify" || kind !== "patch") {
    GlobalBus.emit("event", {
      directory: "global",
      payload: {
        type: Installation.Event.UpdateAvailable.type,
        properties: { version: latest },
      },
    })
    return
  }

  await Installation.upgrade(method, latest)
    .then(() =>
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: latest },
        },
      }),
    )
    .catch(() => {})
}
