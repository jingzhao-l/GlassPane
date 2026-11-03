# Models and API keys

**Bring your own key.** This harness has no account of its own and no model gateway of
its own. Every provider in the models.dev catalog works the way it does in any other
opencode-based tool: you give it a key, it talks to that provider directly from your Mac.

There is nothing to log into, and nothing to sign up for here.

## What is in the catalog

The full models.dev catalog ships with the binary — hundreds of models across dozens of
providers. It is embedded from `contracts/models-catalog.json` at build time and is **not**
fetched at runtime: with no `OPENCODE_MODELS_URL` configured the product never contacts a
catalog endpoint, and the copy in your binary is the copy that was in the tagged tree. Two things were removed from it:

| Removed | Why |
| --- | --- |
| the first-party `opencode` provider | it was a gateway to opencode's own paid cloud, unlocked by logging into an opencode account. This product has no such account, so offering the provider would be offering something that cannot work |
| the `opencode auth login` / `logout` / `switch` commands, the `/org` command, and the org switcher | those were the account surfaces of the provider above |

Everything else — Anthropic, OpenAI, Google, GitHub Copilot, Amazon Bedrock, Azure, OpenRouter,
and the rest — is still there, with its own key or its own OAuth flow, exactly as upstream
defines it.

## Session sharing: what was removed, and what was left in

`product.json` (`models.removedFirstParty`) lists "session sharing to opencode's cloud", and that
phrasing invites a reading the shipped bytes do not support. So this is the narrow, checkable version.

**Removed: the way out.** No endpoint shares a session anywhere. Ask the server's route table —
`grep -rn '"/share' packages/opencode/src/server/routes/instance/httpapi` answers nothing — and no URL
in this tree reaches a share service (`grep -rn 'opencode\.ai/share' packages/*/src` is empty outside
the lineage log `SYNCLOG.md`). The `share` field a session still carries is one local column
(`share_url`, `packages/core/src/session/sql.ts`) that nothing in this product fills by contacting a
service; the GitHub bot's footer, which used to embed a shareable session card, says so where the
footer is built (`packages/opencode/src/cli/cmd/github.handler.ts`).

**Left in: the shape of the old UI.** The web app is embedded in the binary by default —
`packages/opencode/script/build.ts` skips it only when you pass `--skip-embed-web-ui` — and inside it
`packages/app/src/pages/session/timeline/message-timeline.tsx` pins `shareUrl` to `undefined` and
`shareEnabled` to `false`. Every branch that would have shown a Share button is therefore dead at
runtime, and it is still *there*: the markup, and the `session.share.*` copy strings in the locale
files under `packages/app/src/i18n/`. The deprecated `share` and `autoshare` config keys are still
accepted by the v1 config schema (`packages/core/src/v1/config/config.ts`) and do nothing, and the
`session_share` table is still created by the existing migrations, because dropping it would be a
destructive migration on databases that already have those rows.

So the claim about this channel is exactly: **nothing a user does in this product uploads a session
anywhere**. It is not "the words are gone from the bytes" — the words are in the binary, they render
nothing, and saying otherwise would be a claim a reader with `strings` could falsify.

## Supplying a key

Three ways, in the order opencode resolves them:

1. **Environment variable** — the provider's own variable, read by the process:

   ```bash
   export ANTHROPIC_API_KEY=sk-ant-...
   export OPENAI_API_KEY=sk-...
   glasspane-harness
   ```

2. **Config file** — `~/.config/glasspane-harness/glasspane-harness.json` (or the
   project-level `glasspane-harness.json`):

   ```json
   {
     "provider": {
       "anthropic": { "options": { "apiKey": "{env:ANTHROPIC_API_KEY}" } }
     }
   }
   ```

   The `{env:NAME}` form is a template: the value is read from the environment at load
   time, so the file never contains a secret. The example deliberately carries no
   `$schema` line: the config shape is upstream's, but pointing a user-owned file at a
   third-party schema URL is a claim that file makes about *that* project, and this
   product writes nothing like it.

3. **Interactive** — inside the TUI, `/connect` asks for the key and stores it in the
   credentials file (`~/.local/share/glasspane-harness/auth.json`). That file is created
   with owner-only permissions; treat it like a `.env`.

## Checking what is available

```bash
glasspane-harness models          # the catalog, and which providers are connected
glasspane-harness providers       # provider list with per-provider status
```

A provider shows as available once a key resolves. A model that needs a subscription tier
you do not have will simply fail with that provider's own error — this harness does not
gate models behind any account of its own.

## If a key is not picked up

See [troubleshooting](troubleshooting.md). The usual cause is a key in a shell profile
that the TUI did not inherit: macOS GUI applications do not read `.zshrc`, so export the
key in the shell you launch from, or put it in the config file with `{env:NAME}`.
