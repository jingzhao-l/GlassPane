# glasspane-harness docs

GlassPane Harness is a coding agent (an opencode fork) wired to the **GlassPane** engine
through a native `gp_*` tool surface. The engine measures what happened to a real macOS
app; the harness transcribes the engine's conclusions, keeps an audit chain, and never
invents a verdict.

- [Install](install.md) — channels, prerequisites, permissions, verification, uninstall
- [Tools](tools.md) — the `gp_*` surface, argument by argument
- [Evidence](evidence.md) — attribution, diagnosis, the decision log, compaction anchors
- [Migrate from opencode](migrate-from-opencode.md) — what the private customisation
  changed and what deliberately stayed
- [Troubleshooting](troubleshooting.md) — engine unreachable, permission denials, `GP_E_*`

## The four laws

1. **Judgement stays in Swift.** Attribution, diagnosis class, circuit-breaker level and
   the pass/fail/inconclusive outcome are the engine's. The harness transcribes.
2. **The model reads `output`.** Error codes and agent-executable remedies live in the
   tool's output string, not only in metadata.
3. **The audit chain is verifiable without us.** Decision-log entries are hash-chained;
   the fixed points recompute the chain with two independent hashers.
4. **Compaction may not erase evidence.** The session's anchors are re-injected into the
   summarisation prompt, and absence is arithmetic, never an assumption.

## Support policy

Versions track `product.json`; releases are cut from the fork branch in the GlassPane
repository and published to npm as `glasspane-harness` plus one package per platform.
The engine is versioned separately in [GlassPane](https://github.com/jingzhao-l/GlassPane);
this product works with the engine versions its `gp_probe_status` reports as
`capabilities`-complete, and says so plainly when a method is missing.
