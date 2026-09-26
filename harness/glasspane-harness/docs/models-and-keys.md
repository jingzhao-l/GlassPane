# Models and API keys

**Bring your own key.** This harness has no account of its own and no model gateway of
its own. Every provider in the models.dev catalog works the way it does in any other
opencode-based tool: you give it a key, it talks to that provider directly from your Mac.

There is nothing to log into, and nothing to sign up for here.

## What is in the catalog

The full models.dev catalog ships with the binary — hundreds of models across dozens of
providers — and the catalog is refreshed automatically. Two things were removed from it:

| Removed | Why |
| --- | --- |
| the first-party `opencode` provider | it was a gateway to opencode's own paid cloud, unlocked by logging into an opencode account. This product has no such account, so offering the provider would be offering something that cannot work |
| the `opencode auth login` / `logout` / `switch` commands, the `/org` command, and the org switcher | those were the account surfaces of the provider above |

Everything else — Anthropic, OpenAI, Google, GitHub Copilot, Amazon Bedrock, Azure, OpenRouter,
and the rest — is still there, with its own key or its own OAuth flow, exactly as upstream
defines it.

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
     "$schema": "https://opencode.ai/config.json",
     "provider": {
       "anthropic": { "options": { "apiKey": "{env:ANTHROPIC_API_KEY}" } }
     }
   }
   ```

   The `{env:NAME}` form is a template: the value is read from the environment at load
   time, so the file never contains a secret. (`$schema` still points at opencode's
   published config schema — the config shape is upstream's, which is exactly what the
   compatibility promise means.)

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
