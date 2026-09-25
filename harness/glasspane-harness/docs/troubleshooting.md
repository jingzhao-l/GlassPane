# Troubleshooting

Start with `gp_probe_status`. It answers "is the engine there, what can it do, which
permissions are missing" in one call, and every other answer refers back to it.

| Symptom / code | What it means | What to do |
|---|---|---|
| `GP_E_ENGINE_UNREACHABLE` | no socket at the engine's path, or the daemon is not running | start GlassPane (`launchctl kickstart -k gui/$(id -u)/com.glasspane.daemon` or the installer), then retry |
| `GP_E_ENGINE_TIMEOUT` | the daemon accepted the connection but did not answer in time | a busy input window stalls the accessibility plane — stop moving the mouse/keyboard and retry |
| `GP_E_NO_EVIDENCE` | the engine has no evidence for that operation | perform the action, then call `gp_diagnose` with the operation id; the engine explains *why* there is no change |
| `GP_E_CAPABILITY_UNAVAILABLE` | the running engine does not advertise that method | `gp_probe_status` lists what it does advertise; the method list grows with the engine, not with this page |
| `GP_E_PAYLOAD_TOO_LARGE` | the engine's frame exceeded 4 MiB before a frame boundary | retry with a narrower query: lower `maxDepth` on `gp_observe`, or a `role` filter |
| permission prompt rejected | the agent asked, the human said no | the tool call fails with a denial; nothing moved in the app. Grant it in the TUI prompt or configure the permission |
| `GP_E_NO_SOCKET` in a *test* run | `GLASSPANE_SOCKET` points somewhere the test does not control | unset it for the run; the default is `~/.glasspane/engine.sock` |
| `opencode: command not found` after an npm install | a previous install's command name (the product installs as `glasspane-harness` / `gp-harness`) | `glasspane-harness --version`; the old name is gone since 0.1.0 |
| `npm ERR! code EBADPLATFORM` | the package is macOS-only (`os: darwin`) | there is no Linux/Windows build by decision; on a Mac, check the architecture (arm64 / x64) |
| global prefix not writable / command not on PATH | npm's global prefix needs root | `npm install -g --prefix "$HOME/.local" glasspane-harness` and put `~/.local/bin` on PATH; the one-click installer does this for you |
| build fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` | your network intercepts TLS and the toolchain does not trust the proxy | export `NODE_EXTRA_CA_CERTS=<your proxy CA bundle>`; never disable certificate checks |
| the web app is missing from `serve` | the binary was built with `--skip-embed-web-ui` | rebuild without that flag; the runtime flag `OPENCODE_DISABLE_EMBEDDED_WEB_UI` also hides it |

## Reading the decision log

```bash
wc -l ~/.local/share/glasspane-harness/decisions.jsonl   # path may differ; the tool surface prints it
sed -n '2p' ~/.local/share/glasspane-harness/decisions.jsonl | jq -r .prevEntryHash   # link to line 1
```

If verification fails, the entry that broke the chain names itself and the entries before
it are still valid — the chain is append-only by construction.
