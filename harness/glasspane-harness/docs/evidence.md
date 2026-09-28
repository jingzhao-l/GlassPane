# Evidence

## What the engine measures

For each operation the GlassPane engine records, among others:

- **Signals** — accessibility-tree diff (`axEvent`), pixel diff (`pixelDiff`),
  responsiveness samples, crash events, handler probes, state diffs;
- **Attribution** — `strong` / `soft` / `none`, plus a contamination flag (an operation
  performed while an input window was busy is *contaminated*, not "successful");
- **Circuit breaker** — the engine's own budget state for that target;
- **Diagnosis** — why an operation did not produce the expected change
  (`contaminated`, `out-of-band`, `callback`, `pre-existing`, `no-change`);
- **Outcome** — `pass` / `fail` / `inconclusive`, computed by the engine from the above.

The harness reads these fields and transcribes them. It never compares a ratio against a
number of its own; the CI ratchet `surface-semantics` fails the build if one appears in a
tool surface.

## The decision log

Every `gp_*` call that comes back with a real evidence pack appends one entry:

```
{"schemaVersion":"…","entryId":"…","operationId":"op_…","outcome":"pass",
 "summary":"…","createdAt":"…","prevEntryHash":"<sha256 of the previous line>"}
```

The file is a JSONL chain: `prevEntryHash` is the SHA-256 of the previous *line*, the first
entry's is the empty string, and the file is 0600. Verification does not require trusting
the writer — the fixed points recompute the chain with two independent hash
implementations, and `sed -n '2p' ledger | sha256sum` is enough to check one link by hand.

Where the log lives: under the harness's own data directory, never inside the engine's
state root (`~/.glasspane`). One writer per state file is a rule this project already paid
for once (`projects.json`); the binding refuses the engine's root outright.

## Compaction anchors

When a session is compacted, upstream summarises the conversation. A summary can keep the
story and drop the hashes, and then nothing ties the session's claims to the chain. The
compaction hook re-injects the session's anchors into the summarisation prompt:

```
## GlassPane evidence anchors (M4)
gp_* calls: 3 · decisions recorded: 2 · without a decision record: 1
- gp_act · op op_… · outcome pass · ledger #12 · entry sha256 9f3c1d7a…
```

Absence is arithmetic: a session that used the tool surface but recorded nothing says
"decisions recorded: 0" rather than staying silent. The block is transcription only — it
never claims the UI was correct; that is the kernel's and the engine's call.

## What the harness must never do

- compare pixel ratios or confidences against its own thresholds;
- synthesise "pass"/"fail" strings for the model;
- write into the engine's state root or invent a second copy of a state file;
- claim a method exists because a list in a file says so (capabilities come from `hello`).
