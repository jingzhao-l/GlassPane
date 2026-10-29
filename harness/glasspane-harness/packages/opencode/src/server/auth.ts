export * as ServerAuth from "./auth"

import { ConfigService } from "@/effect/config-service"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Config as EffectConfig, Context, Option, Redacted } from "effect"

export type Credentials = {
  password?: string
  username?: string
}

export type DecodedCredentials = {
  readonly username: string
  readonly password: Redacted.Redacted
}

// Both names are read here, product name first. `Flag.OPENCODE_SERVER_PASSWORD` — which is what
// `cli/cmd/serve.ts` consults before it prints "server is unsecured", and what `header()` below
// uses to build the credential it sends — resolves `GLASSPANE_HARNESS_SERVER_PASSWORD` first and
// then the legacy spelling. This class did not, because `ConfigService`'s layer is provided without
// `runtime-flags.ts`'s resolver layer, so Effect read the literal `OPENCODE_*` name off
// `process.env`. The two sides therefore disagreed about one specific and very bad case: an operator
// who exported only the product name saw the warning disappear while `required()` still answered
// false and every route stayed open. Enforcement must read the knob the presentation reads.
export class Config extends ConfigService.Service<Config>()("@opencode/ServerAuthConfig", {
  password: EffectConfig.string("GLASSPANE_HARNESS_SERVER_PASSWORD").pipe(
    EffectConfig.orElse(() => EffectConfig.string("OPENCODE_SERVER_PASSWORD")),
    EffectConfig.option,
  ),
  username: EffectConfig.string("GLASSPANE_HARNESS_SERVER_USERNAME").pipe(
    EffectConfig.orElse(() => EffectConfig.string("OPENCODE_SERVER_USERNAME")),
    EffectConfig.withDefault("glasspane-harness"),
  ),
}) {}

export type Info = Context.Service.Shape<typeof Config>

export function required(config: Info) {
  return Option.isSome(config.password) && config.password.value !== ""
}

export function authorized(credentials: DecodedCredentials, config: Info) {
  return (
    Option.isSome(config.password) &&
    credentials.username === config.username &&
    Redacted.value(credentials.password) === config.password.value
  )
}

export function header(credentials?: Credentials) {
  const password = credentials?.password ?? Flag.OPENCODE_SERVER_PASSWORD
  if (!password) return undefined

  const username = credentials?.username ?? Flag.OPENCODE_SERVER_USERNAME ?? "glasspane-harness"
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

export function headers(credentials?: Credentials) {
  const authorization = header(credentials)
  if (!authorization) return undefined
  return { Authorization: authorization }
}
