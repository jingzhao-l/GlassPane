import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { Effect, Layer } from "effect"
import { Config } from "@opencode-ai/core/config"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { Policy } from "@opencode-ai/core/policy"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { testEffect } from "../lib/effect"

/**
 * The v2 config plane's directory precedence, pinned behaviourally.
 *
 * `product.json` keeps `.opencode` as a **read-compatibility** target only: an old
 * checkout must still work, but the product's own `.glasspane-harness` has to win
 * when a directory carries both. `Config.Interface.entries` is documented "from
 * lowest to highest priority" and consumers merge later-wins (`tool/bash.ts`
 * builds the bash `shell` with `Object.assign({}, ...entries)`), so the last
 * directory in the list is the one that decides.
 *
 * This is the assertion the sibling `glasspane-project-config-dirs.test.ts` could
 * not make: its v2 check only greps that the source *mentions*
 * `.glasspane-harness`, which stays true no matter which order the two names are
 * probed in. Discovery pushes targets in list order and `config.ts` then reverses
 * the whole result, so the array literal reads backwards from the effective
 * priority — exactly the place a structural grep cannot see.
 */
const it = testEffect(Layer.empty)

function layerFor(directory: string, globalDirectory: string) {
  const locationLayer = Layer.succeed(
    Location.Service,
    Location.Service.of({
      directory: AbsolutePath.make(directory),
      workspaceID: undefined,
      project: { id: Project.ID.global, directory: AbsolutePath.make(directory) },
      vcs: undefined,
    } satisfies Location.Interface),
  )
  return AppNodeBuilder.build(LayerNode.group([Config.node, Policy.node]), [
    [Location.node, locationLayer],
    [Global.node, Global.layerWith({ config: globalDirectory })],
  ])
}

/** Writes `shell` into each named project directory and answers the merged winner. */
function winner(shells: Record<string, string>) {
  return Effect.acquireRelease(
    Effect.promise(() => fs.mkdtemp(path.join(tmpdir(), "gp-config-prec-"))),
    (root) => Effect.promise(() => fs.rm(root, { recursive: true, force: true })),
  ).pipe(
    Effect.flatMap((root) =>
      Effect.gen(function* () {
        const globalDirectory = path.join(root, "global")
        yield* Effect.promise(async () => {
          await fs.mkdir(globalDirectory, { recursive: true })
          for (const [dir, shell] of Object.entries(shells)) {
            const full = path.join(root, dir)
            await fs.mkdir(full, { recursive: true })
            await fs.writeFile(path.join(full, "opencode.json"), JSON.stringify({ shell }))
          }
        })
        return yield* Effect.gen(function* () {
          const config = yield* Config.Service
          const entries = yield* config.entries()
          const documents = entries.filter((entry) => entry.type === "document")
          return {
            merged: Config.latest(entries, "shell"),
            order: documents.map((document) => document.info.shell),
          }
        }).pipe(Effect.provide(layerFor(root, globalDirectory)))
      }),
    ),
  )
}

describe("v2 config directory precedence", () => {
  it.live("when both directories exist at one level the product directory wins the merge", () =>
    Effect.map(
      winner({ ".opencode": "/bin/legacy", ".glasspane-harness": "/bin/product" }),
      ({ merged, order }) => {
        expect(order).toEqual(["/bin/legacy", "/bin/product"])
        expect(merged).toBe("/bin/product")
      },
    ),
  )

  it.live("a legacy-only checkout is still read (compat must not be dropped to win)", () =>
    Effect.map(winner({ ".opencode": "/bin/legacy" }), ({ merged }) => expect(merged).toBe("/bin/legacy")),
  )

  it.live("a product-only checkout is read", () =>
    Effect.map(winner({ ".glasspane-harness": "/bin/product" }), ({ merged }) => expect(merged).toBe("/bin/product")),
  )
})