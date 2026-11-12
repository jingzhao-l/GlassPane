import { describe, expect, test } from "bun:test"
import { canSelfUpgrade } from "../../src/cli/upgrade"

// [gp] Product: the auto-update path must not attempt a self-upgrade over a channel this
// product cannot self-upgrade on. `curl` installs read their version from this product's
// own GitHub releases (they ARE a version channel), but `Installation.upgrade("curl", …)`
// always refuses with "does not self-upgrade over curl" — so a curl-installed copy used to
// reach that call and have the refusal swallowed by the auto-update path's `.catch()`,
// silently doing nothing on every patch. `canSelfUpgrade` is the gate: it is called BEFORE
// `Installation.upgrade`, so a channel that cannot self-upgrade never gets an upgrade
// attempt at all.
//
// Only methods that pass `Installation.latest()` reach this gate — `isUpdateChannel`
// refuses brew, choco, scoop and unknown before this point — so the gate's contract is
// exactly: curl (a version channel, not a self-upgrade channel) is refused, and every
// channel the update path can drive (npm, pnpm, bun) passes.
describe("glasspane auto-update self-upgrade gate", () => {
  // The named contract: curl is a no-op channel for self-upgrade; the channels the update
  // path CAN drive stay real. Breaking the guard (returning true for curl) turns the
  // first assertion red — the reverse control for this fix.
  test("curl cannot self-upgrade; the channels the update path drives can", () => {
    expect(canSelfUpgrade("curl")).toBe(false)
    expect(canSelfUpgrade("npm")).toBe(true)
    expect(canSelfUpgrade("pnpm")).toBe(true)
    expect(canSelfUpgrade("bun")).toBe(true)
  })
})
