export * as Database from "./database"

import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Context, Effect, Layer } from "effect"
import { Global } from "../global"
import { Flag } from "../flag/flag"
import { existsSync, renameSync } from "node:fs"
import { isAbsolute, join } from "path"
import { DatabaseMigration } from "./migration"
import { InstallationChannel } from "../installation/version"
import { makeGlobalNode } from "../effect/app-node"
import { read as EnvRead } from "../flag/flag"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

export interface Interface {
  db: DatabaseShape
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/storage/Database") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* makeDatabase

    yield* db.run("PRAGMA journal_mode = WAL")
    yield* db.run("PRAGMA synchronous = NORMAL")
    yield* db.run("PRAGMA busy_timeout = 5000")
    yield* db.run("PRAGMA cache_size = -64000")
    yield* db.run("PRAGMA foreign_keys = ON")
    yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
    yield* DatabaseMigration.apply(db)

    return { db }
  }).pipe(Effect.orDie),
)

export function layerFromPath(filename: string) {
  return layer.pipe(Layer.provide(sqliteLayer({ filename })))
}

/**
 * The database file, with the product's name.
 *
 * WHY THE MIGRATION IS HERE AND NOT OPTIONAL: this file *is* the user's history
 * (sessions, messages, parts). Renaming it without moving the old one would make
 * every existing install look empty — the worst possible private-isation bug, and
 * invisible until a user complained. So the legacy name is renamed into place
 * once, only when the new name does not exist yet. Both channel-suffixed legacy
 * names are handled for the same reason.
 */
export function path() {
  if (Flag.OPENCODE_DB) {
    if (Flag.OPENCODE_DB === ":memory:" || isAbsolute(Flag.OPENCODE_DB)) return Flag.OPENCODE_DB
    return join(Global.Path.data, Flag.OPENCODE_DB)
  }
  const channel = ["latest", "beta", "prod"].includes(InstallationChannel)
    ? ""
    : `-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}`
  const legacy = ["latest", "beta", "prod"].includes(InstallationChannel) ||
      EnvRead("OPENCODE_DISABLE_CHANNEL_DB") === "1" ||
      EnvRead("OPENCODE_DISABLE_CHANNEL_DB") === "true"
    ? "opencode.db"
    : `opencode-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`
  const current = join(Global.Path.data, `glasspane-harness${channel}.db`)
  const legacyPath = join(Global.Path.data, legacy)
  try {
    if (!existsSync(current) && existsSync(legacyPath)) renameSync(legacyPath, current)
  } catch {
    // A read-only or busy data dir is not a reason to refuse to start: the new
    // path is used and the old file stays where it is.
  }
  return current
}

export const node = makeGlobalNode({ service: Service, layer: layerFromPath(path()), deps: [] })
