/**
 * Emits both tool surfaces' provider registrations as one JSON document, for
 * `harness/tools/provider-surface.mjs`.
 *
 * WHY RUNNING THE CODE AND NOT READING THE TEXT. `surface-semantics` and friends can grep for a
 * shape; a correspondence rule cannot. The claim this ruler guards is "the AE/evidence methods
 * these two surfaces register with the kernel's provider contract mean the same thing", and the
 * only trustworthy reading of a registration is what `providers.ts` returns after the kernel has
 * validated it. A text scan would happily agree with a draft the kernel refuses to register, and
 * would break on a reformat that changes nothing about the claim.
 *
 * The version argument is fixed to `"probe"` on purpose: each surface carries its own product
 * version (the harness's `0.x.y`, the shell's `1.x.y`), and those two numbers are *supposed* to
 * differ. Comparing them across surfaces would be a rule that goes red every release for no
 * reason; what must agree is the shape of the claims — ids, kinds, origins, method names and
 * their prerequisite lists.
 *
 * Resolution is per-file: `providers.ts` imports `iterate-kernel` subpaths, and bun resolves that
 * from the importing file's own tree — the fork's pinned copy for the harness surface, the
 * workspace copy for the shell. So this runner needs no `--cwd` trickery and reports what each
 * surface actually resolves today.
 */
import { glasspaneProviderDrafts } from "../glasspane-harness/packages/opencode/src/tool/glasspane/providers"
import { shellProviderDrafts } from "../../mcp-shell/src/providers"

const normalize = (drafts: readonly unknown[]) =>
  (drafts as readonly Record<string, unknown>[]).map((draft) => ({
    id: draft.id,
    kind: draft.kind,
    origin: draft.origin,
    methods: (draft.methods as readonly Record<string, unknown>[]).map((method) => ({
      name: method.name,
      requires: [...(method.requires as readonly string[])],
    })),
  }))

console.log(
  JSON.stringify(
    {
      harness: normalize(glasspaneProviderDrafts("probe")),
      shell: normalize(shellProviderDrafts("probe")),
    },
    null,
    2,
  ),
)
