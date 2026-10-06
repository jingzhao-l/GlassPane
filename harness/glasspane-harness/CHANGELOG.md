# Changelog

All notable changes to **glasspane-harness** (the product) are recorded here. The
per-batch measurements of the *fork* live in `SYNCLOG.md`; upstream opencode's own
changelog is not this file's subject.

The format follows [Keep a Changelog](https://keepachangelog.com/); the product uses
semantic versioning starting at `0.1.0` (pre-1.0: the surface may still move, the evidence
contract does not).

## [Unreleased]

<!-- 内容归入下一版；此处留空以备下一批。 -->

## [0.7.0] - 2026-10-07

判据（pre-1.0）：**minor** —— 用户可见的安装器 CLI 形状（`--version <值>`、`--help`、
Intel Mac 的兜底通道）与同目录配置优先级都变了，不是纯修复。证据契约（判定仍全在
Swift、错误帧仍 `{code,message,remedy}`）一条没动。

这一批同样来自一次全面审查（正确性 + 发布/供应链两条泳道），但重点不在"改了多少行"，
而在**有几道闸当时是绿的却红不了**——逐条给出破坏证据后才算修完（口径见
`harness/README.md` 的「闸自己被验过吗」）。

### Fixed — 发给用户的东西

- **兜底安装器在 Intel Mac 上把自己拒了。** `uname -m` 报 `x86_64`，而白名单只收
  npm 词表里的 `arm64|x64`，于是在写着"this product ships darwin-arm64 and
  darwin-x64"的那一行拒绝了一台正好是 darwin-x64 的机器。加了 `x86_64→x64` /
  `aarch64→arm64` 的映射层，其余架构照旧明确拒绝。
- **安装器宣称它没做过的校验。** 收尾无条件打印 `sha256 + GPG verified`，而
  无 `SHA256SUMS.txt`、资产未被列出、机器上没有 `gpg`、没有 `.asc` 四种情况各自
  只 warn 后继续安装。现在结论由实际状态拼出（`sha256: verified (SHA256SUMS.txt);
  GPG: skipped (no .asc published …)`），两者都没验时额外警告"装上的字节未被完整
  校验"。缺签名仍只警告不拒装是 0.6.4 定的策（区分"策略缺口"与"篡改"），这一版
  改的是**别把没做的事说成做过**；校验不匹配照旧直接拒装。
- **`install.sh --version 0.1.0` 100% 失败**（文件开头就教这条写法）：`for arg in "$@"`
  里的 `shift` 不影响已展开的循环，版本号随后被当成未知参数报错退出。改成 `while/[ $# ]`
  循环。`--help` 在 `curl … | bash` 形态下用 `sed "$0"` 打印自身，而那时 `$0` 是
  `bash`，必失败；改为直接输出用法。
- **GPG 验签失败会杀死整个安装器。** `set -e` 下 `out="$(gpg --verify …)"` 一失败脚本
  就地退出，其后的 `rc=$?`、警告分支、`rm -rf "$gnupg"` 全是死代码，用户只看到 gpg 的
  stderr 和一个泄漏的临时目录。改为在 `if` 里取值，清理先行。
- **引擎没答话时，工具说"成功了"。** `daemon.ts` 对既无 `error` 又无 `result` 的帧
  回 `{ok:true, result:undefined}`，TUI 于是渲染成 `gp_act: act ok` ——模型读到"这次
  点下去了"，而引擎其实什么都没答。改为按帧契约拒绝（`{id,result}` 或 `{id,error}`，
  `result` 缺席＝缺陷）；`result: null`（"这个 id 没有证据包"）仍算合法回答。
  同批补：`close`/`end` 事件（守护进程一次只服务一条连接，此前挂断要空等满 30/60 秒
  超时，remedy 还教 agent"别动鼠标键盘"）、响应 `id` 核对、跨 chunk 的 UTF-8 解码
  （CJK 窗口标题此前会被截成替换字符，再报成"引擎发的不是合法 JSON"）。
- **同目录里旧名字的配置赢过新名字。** `~/.config/glasspane-harness/` 下四个候选文件的
  合并顺序把 `glasspane-harness.jsonc` 排在 `opencode.jsonc` 之前，而"后合并者赢"正是
  `product.json.compatRead`、`config/paths.ts:26-31` 与本文件自己（项目级那段）写的
  规则——于是遗留文件静默劫持产品配置。改成遗留在前、产品在后。
- **构建把第三方响应原文当源码插进二进制。** `script/generate.ts` 取
  `https://models.dev/api.json` 的响应体**原文**交给 `Bun.build({define})`，而 `define`
  是源码文本替换：JSON 恰好是合法表达式所以一直没出事。现在要求 2xx、必须是 JSON
  对象、每个 provider 是对象，再重新序列化——非法响应让构建点名失败，不再可能成为
  发给所有用户的那份二进制里的代码。

### Fixed — 闸自己（这几条在坏的时候都是绿的）

- **`kernel-vendor` 的跨读读的是"碰巧 checkout 的那一支"，却把结论标成钉点。**
  实测：canonical 检在 `main`、pin 是 `kernel/decision-log-chain@2ed342b`，25 个与
  清单逐字节一致的文件报了 9 条红，remedy 写"backflow or drop it"。改为按
  `git show <ref>:kernel/<file>` 从对象库读；对象不在场时大声声明"未跨读"而不是判红；
  canonical 工作树脏不再污染测量。`checkDeclaredMode()` 一直在找一条任何布局下都不存在
  的路径 ⇒ `kernel.mode` 与树的形态是否一致**从未被检查过**，现已执行并两条验红。
- **`product-surface` 的 4 条断言落在判决之后**（打印与 `process.exit(1)` 都发生在它们
  之前），把 bin shim / 升级包名 / 卸载包名改回上游写法照样绿。收成底部唯一一处判决，
  断言计数 **84 → 88**。
- **`hook-liveness` 缺参照检出时 `TypeError` 退 1**，而 1 的语义是"上游坏了，冻结升级"
  ——把"这台机器没克隆"报成了上游事故（现退 2 并指向 `--offline`）。钩子名正则不认
  下划线，`experimental.provider.small_model` 被漏掉（声明 21、金样 20）；补上后又发现
  fire-site 正则不认带泛型的 `plugin.trigger<"…">(`，会把**活的**钩子判成 dead。
  金样重记为 21（live 15 / structural 5 / dead 仍只有 `permission.ask`），并加了
  "声明解析出 0 个名字＝无法测量（退 2）"的兜底。
- **`tool-surface` 的 `--record` 会在没有参照克隆时把沿用行数盖成新基线**（此后该 lane
  对 edited 文件的增长永久失明）；无参照时面 B 还会把"上游文件改名而来"算成我们写的行
  （同一棵树 5,115 vs 6,203）。现在两种都拒绝，且无参照 lane 拒绝断言面 B 在限内。
- **`brand-surface` 在产品语言目录被搬走时抛 ENOENT 退 1**（会被读成"品牌漂移"），
  改为退 2 并写明"跑不了不等于过"。

### Internal

- 新增 `packages/opencode/script/installer-selftest.sh`：桩 curl/uname/npm/gpg，把
  GitHub 兜底通道**离线跑完**（31 条断言，含校验不匹配必须拒装、无清单必须不说"已验"）。
  此前这条路径没有任何测试碰过，`product-surface` 的 `--dry-run` 也走不到它。
- 新增固定点测试 7 条：`test/tool/glasspane-surface.test.ts` 传输层 6 条、
  `test/config/config.test.ts` 同目录优先级 1 条；每条都对**改动前**的源码跑出具名红。
- `harness/README.md` 的金样数字全部按本轮实测校正（fork-diff 四桶、面 A/面 B、
  血缘计数、product-surface 断言数、surface-semantics 扫描集），并把 `kernel-vendor`
  清单与 fixture 的真实路径写对（它们在 fork 树里，不在 `harness/contracts/`）。
- `FORK.md` 订正两处与代码不符的主张：仓里没有 `--embed-web-ui` 这个 flag（内嵌自
  2026-09-25 起是默认，反向开关是 `--skip-embed-web-ui`），以及"本 pin 的内核没有
  `dimensionContext`"——重新钉 pin 后它已在 `vendor/kernel/src/dimension-context.ts:179`。

### 未观测（不写成通过）

真模型轮次仍未跑（这台机器上没有可用的 provider key，且花别人的额度该由 owner 决定）；
真 TUI 会话里的观感仍未观测（`gp_*` 需要 daemon 席位齐，本轮只跑到无头 `serve` 形态）；
`packages/{app,session-ui,desktop}` 与 TUI 的关系仍是待决项；canonical kernel 已前进到
`4541cd1` 并发到 npm（`iterate-kernel@0.1.1`），是否改换分发形态属 owner 裁决。

## [0.6.4] - 2026-10-03

这一版的内容全部来自一次全面审查：把 harness 从长期寄生的 worktree 合回主仓
`main`（形态与 iterate 生态对齐），然后逐道复核它的六把尺子。三个 P0 都是
「发布出去的东西是坏的」，其中两个在 npm 与 GitHub release 上已存在数日。

### Fixed

- **GitHub release 兜底安装此前从未成功过。** 安装器请求
  `<product>-<platform>-<version>.tar.gz`，而 `script/build.ts` 上传的是
  `<product>-<os>-<arch>.zip`：文件名里没有版本号（版本由 URL 里的 tag 承载），
  且只有 Linux 目标才打成 tar.gz。实测 v0.6.3 / v0.5.1 / v0.4.0 的两种猜法
  全部 HTTP 404。npm 不可用时（无 Node、无 npm、被代理拦）这条路径只会报
  "download failed"。
- **兜底安装不校验任何东西。** 0.6.3 随包发出的 `install.sh` 里
  sha256 / gpg / asc / checksum 一个都没有——发布链给每个资产签了 `.asc`、
  发了 `SHA256SUMS.txt`，而收到它们的安装器从不读。现在两个判定都补上：
  对 `SHA256SUMS.txt` 校验 sha256（完整性；**不匹配直接拒绝安装**，不降级为
  警告，因为字节不是发布的字节），对 `<asset>.asc` 验签（来源；缺 gpg 或缺
  签名仍只警告，区分「策略缺口」与「篡改」）。两者不可互相替代。
  对 v0.6.3 的真实资产实测：sha256 通过、GPG GOODSIG 通过；追加一个字节后
  sha256 判定拒绝安装。
- **`verify_asset_gpg` 读全局变量而不是参数。** 它声明了 `local asc` 却用
  `"$TMP/$ASSET"`，并引用 `$URL`——在 `set -u` 下以非 `$URL` 的 URL 调用会
  直接 `URL: unbound variable` 而死。改为全部走 `$1/$2/$3`。
- **版本序崩坏。** CHANGELOG 的章节顺序是 0.6.3 / 0.6.1 / 0.6.0 /
  `[Unreleased]` / 0.1.0 / 0.2.0 / 0.5.1 / 0.5.0 / 0.4.0 / 0.3.0——`[Unreleased]`
  卡在文件中部，且 M4 一条在 0.6.0 与 `[Unreleased]` 下逐字重复。改为严格
  降序、`[Unreleased]` 置顶，删掉重复的那条（它仍在 0.6.0 下）。

### Internal

- **尺子层合回主干，`harness-rulers` 成为主仓 CI 的一条 lane。** 此前
  `harness/tools`（6 把尺子）与 `harness/contracts`（5 份金样）只存在于一个
  worktree 的分支里，不在 `main` 的版本控制内——`FORK.md` 却把「分叉必须
  可测量」列为不可让步纪律并给出 4 条命令，其中 3 条在 `main` 上是
  `MODULE_NOT_FOUND`，而 `main` 的 CI 里 `grep -c harness` 当时是 0。
  纪律变成了散文，**两个月里没有任何东西发现**。现在每次 push 先断言 6 把
  尺子与 5 份金样在树里（就是这次的回归形态），再逐道跑。
- **三道闸的金样重记**（`fork-diff` / `brand-surface` / `tool-surface`）。逐条
  查证后重记，不是盖数：`fork-diff` 的 9 条过期项先逐文件比对确认与已发布的
  0.6.3 逐字节一致；`brand-surface` 的 +1 定位到一处**注释**（同一提交把用户
  可见的 `opencode -s <id>` 修成了 `glasspane-harness -s <id>`，注释里提到
  旧名，按字面计数 +1）；`tool-surface` 的两处增长分别是 main 上 1.6.x 的
  真实产品代码与尺子第一次在有上游参照检出时正确归属我们自己的 `gp_*` 工具面。
  `surface-semantics` 同批仍 0 hit——判定全部留在 Swift 引擎里，这条才是本棘轮
  真正要守的不变量。
- **`FORK.md` 新增第 3 条纪律「尺子必须和 fork 同仓」**，并说明 `subtree split`
  只带走 `harness/glasspane-harness/` 是对的：尺子量的是主仓里这棵树，不随产品
  分发。

### Added

- **Kernel conformance lane** (`bun script/kernel-conformance.mjs`): the kernel's own
  fixtures, mirrored into `contracts/kernel-fixtures/` and hash-pinned, are run through the
  kernel this package ships. Byte-identical answers or exit 1. With `--impl <dir>` it runs
  a second implementation — a built `dist/` or an installed `@iterate/kernel` — and
  demands the same answers, which is the evidence that changing how the kernel is
  delivered does not change what it means.
- **Kernel provenance gate** (`node script/kernel-vendor.mjs --check`) now also covers the
  mirrored fixtures, and both gates live in the product tree so this repository can
  verify itself.

### Fixed (kernel provenance, shipped in this version)

- The kernel's pinned ref was unresolvable because the canonical branch had never been
  pushed; the branch is now published and the manifest re-anchored to it.
- The drift probe asked `git ls-remote` to resolve a commit SHA. `ls-remote` matches ref
  names, so it reported "anchor unreachable" even for refs that were on the remote. It now
  asks the one question `ls-remote` can answer, and declines to guess at ancestry it cannot
  see.

## [0.6.3] - 2026-09-30

### Fixed

- **npm 发布通道被两个版本号卡住，现在绕过。** `0.6.1` 与 `0.6.2` 在 npm 侧处于
  *staged* 状态，`npm publish` 对这两个号一律返回
  `E409 Cannot publish over previously staged version`，而 `npm stage list`
  并**不显示**它们。成因是一次误操作：本机这个 npm 版本上
  `npm publish --dry-run` 仍然真的 PUT 了版本号（dry-run 并不 dry），于是被
  用来排查的号自己也进了 stage。stage 需要交互式认证才能 reject，因此这一版
  改发 `0.6.3`。**内容与 `v0.6.1` 的 GitHub release 完全相同**——跳号只影响
  npm 上的版本号连续性，不含任何功能差异。
- **GitHub release 的资产现在带 GPG 签名。** `v0.6.1` 起，两个平台归档与
  `SHA256SUMS.txt` 各带一份 `.asc`；`gpg --verify` 对从 release 下载的文件
  通过。签名步在 secret 缺失时**拒绝发布**而不是静默跳过——静默跳过正是
  GlassPane 自己的 v1.4.0 发出无签名产物的原因。

### Internal

- **`script/gpg-signing.sh`** (new) — 签名配置与发布凭据的一处入口，
  `seed` / `install` / `verify` / `verify-pass` / `local` / `audit` / `selftest`。
  放在产品树内而非仓外 `tools/`，因为 subtree split 不带走仓外目录。
- keychain 里的私钥以 **base64** 存放：`security add-generic-password -w`
  在本机会把**多行**参数 hex 编码，keychain UI 看不出异常，而 CI 拿到的就是
  那串 hex，`gpg --import` 报 `no valid OpenPGP data found` 且不会提它来自
  keychain。存后读回比对字节，`install` 推之前拒收非 armored key 的值。

## [0.6.1] - 2026-09-30 (GitHub release only — never reached npm)

The binaries, checksums and GPG signatures for this version are on the GitHub
release. npm never received it: the version number was left *staged* by a
misstep (see 0.6.3), and `0.6.2` then went out as an empty placeholder. Both are
deprecated on npm with an explanation. **Install from npm: use 0.6.3 or 0.5.1.**

### Fixed

- **Release assets are now GPG-signed, and the release refuses to publish without
  them.** v0.6.0 shipped two platform archives and no `SHA256SUMS.txt.asc`:
  the signing step read `GPG_PRIVATE_KEY` from the `release` environment, where
  it had never been set, and the step failed after the archives were already
  uploaded. The two secrets are configured now, and the lane is re-run.

  Consumers can verify provenance, not just integrity:

  ```bash
  gh release download v0.6.1 -p glasspane-harness-darwin-arm64.zip -p '*.asc'
  gpg --verify glasspane-harness-darwin-arm64.zip.asc glasspane-harness-darwin-arm64.zip
  ```

### Internal

- **`script/gpg-signing.sh`** (new) holds how this product and the four other
  projects in the two ecosystems sign their releases, so the question stops
  being re-derived: `seed` (one-time, the only interactive step), `install`,
  `verify`, `verify-pass`, `local`, `audit`, `selftest`. It lives in the product
  tree rather than the fork's `tools/` because subtree split does not carry the
  fork's directories into the published repo.
- `audit` names the release workflows that still sign behind
  `if: secrets.GPG_PRIVATE_KEY != ''` — a condition under which the step
  disappears silently and the release publishes unsigned. GlassPane's own v1.4.0
  shipped that way; this repo's `release.yml` was already migrated to failing
  loudly with a remedy.

## [0.6.0] - 2026-09-28

### Fixed

- **The session epilogue printed a command that does not resolve.** Exiting a
  session showed `opencode -s <id>`; this product installs as
  `glasspane-harness`, so the line a user copies to resume was the wrong binary.
  It now prints `glasspane-harness -s <id>`.
- **The epilogue could print `-s undefined`.** `sessionID` is optional, because
  the session may not have finished loading. The continuation line is now
  omitted unless there is an id, rather than emitting a literal `undefined` that
  reads like a runnable command.
- **The provider dialog kept a dead upstream key** in its description table —
  unreachable, but shipped. Removed.

### Added

- **Dimension-aware compaction (M4).** A compacted `gp_*` session now carries a
  coverage line computed by the kernel: which planned review dimensions the
  engine recorded a decision for, which recorded nothing, and which recorded
  something the run never planned. A dimension with no decisions is reported as
  unverified — never dropped, and never described as fine, since only the engine
  may judge that. The dimension vocabulary is the iterate config's; this side
  neither enumerates it nor infers one from a method name.

### Internal

- **The release lane was broken end to end and had been for several releases.**
  Five separate defects sat between a tag and a published binary, each hiding the
  next: a `steps.*` expression that made GitHub reject the workflow file (zero
  jobs dispatched), a `secrets` reference in a step's `if:` (same, and invisible
  to any local YAML check), a `build` script invoked from the workspace root
  where it does not exist, an upload that globbed both `.zip` and `.tar.gz` when
  each runner only ever produces one, and no step creating the GitHub release
  before the upload. `darwin-x64` additionally never got a runner at all, because
  its matrix pinned `macos-13`, which GitHub has retired.
  `check-workflows` now rejects `secrets` in an `if:`, so the second class of
  failure is caught before it reaches the registry.

- `packages/tui` typechecks clean (11 errors, one root cause: a `createResource`
  whose `T` could not be inferred, so every consumer lost its element type).
- Two files that ship user-facing strings were outside the brand-surface
  ratchet's scan list, which is why the two leaks above reached a release. They
  are scanned now, and the ratchet is verified to fail on a regression in them.

## [0.5.1] - 2026-09-26

**The same content as 0.5.0, published cleanly.** 0.5.0 exists on the registry because
two publishes of it were launched by mistake and raced; npm accepted one and staged the
other, which burned the number for the wrapper. The release moved to 0.5.1, and
`publish.ts` now takes an exclusive lock (`dist/.publish.lock`, an atomic `mkdir`) so two
publishes cannot run at once — a mistake that cost a version number is now a script bug
instead of an operator one.

## [0.5.0] - 2026-09-26

**The product surface says our name, everywhere a person can see it — and the trees that
were never ours are gone from the repository.**

### Changed — the private-isation, audited rather than assumed
- **Environment variables**: every knob now has a `GLASSPANE_HARNESS_*` name, resolved in
  one place (`flag/flag.ts`'s `read()`). The old `OPENCODE_*` names still work — a
  private-isation that silently ignores a setting someone already exported is its own bug.
- **What we call ourselves on the wire**: `X-Title`, `X-Source`, `User-Agent`,
  `originator`, `HTTP-Referer`, the MCP client name and the OTLP service name all say
  `glasspane-harness`. Previously a request to OpenRouter, Cerebras, Kilo, Vercel,
  NVIDIA, Zenmux or a user's own web fetch identified itself as opencode.
- **The user's own files**: the database is `glasspane-harness.db` (with a one-time rename
  of the old file — losing someone's session history would be the worst possible
  private-isation bug), the log is `glasspane-harness.log`, and the server's basic-auth
  default username is the product's rather than `opencode`.
- **The LAN**: the mDNS default is now actually `glasspane-harness.local`. The help text
  was rebranded in 0.1.0 while the value was not, so the product advertised one domain and
  announced another.
- **The CLI**: `scriptName` is the product's, which is what `--help` and usage errors print.
  The ACP integration (what editors launch) no longer advertises a login that cannot exist.
- **The built-in skill** is `customize-harness`, and its body documents this product's
  config paths. It is injected into every session, so its text is product surface.
- **No third-party `$schema` is written into your config any more.** Upstream injected
  `https://opencode.ai/config.json` into every file it opened; the first line of a user's
  own config was somebody else's URL.
- First-party remnants removed from the TUI and web app: the Zen upsell and its link, the
  "free models" claims, the paid-plan nudge, the recommended tags, the provider ordering
  that floated the house gateway to the top.

### Removed — trees that were never this product
`packages/console`, `packages/enterprise`, `packages/stats`, `packages/web` (the docs
site), `packages/storybook`, `packages/containers`, `packages/function`,
`packages/identity`, `packages/slack`, `packages/docs`, plus `artifacts/` (an upstream
promo-video project for a model release), `.vscode/`, `install/` (the upstream
`opencode.ai/install` script), `nix/` + `flake.*`, `sdks/vscode` (an editor extension),
`infra/` + `sst.config.ts`, `perf/`, `github/` (the upstream bot action) and
`screenshot-uk.png`. None of them were referenced by shipped code — measured, not assumed.

**Kept on purpose**: `packages/desktop` (product surface, batch 2), `patches/` (bun
applies them at install time), `specs/` (the design record of the code we maintain).

### Gates
- `brand-surface` gained five rule classes — first-party gateway, wire identity, foreign
  schema writes, product file names, and removed trees — with a short explicit allowance
  list for the three places that legitimately *read* an old name (the database migration,
  the legacy config file names, a stored theme id).
- The ruler's own blind spot was fixed: `fork-diff` used to treat gitignored build output
  as "a file that exists but was never committed", which is the same class of false
  positive as the import bug it was built to catch.

## [0.4.0] - 2026-09-25

**A complete programming agent with the GlassPane kernel fused in — and no account to
log into.** This release is mostly the removal of a first-party vendor surface, plus the
npm and docs work that goes with it.

### Added
- `docs/models-and-keys.md` — the model catalog and the three ways to supply a key
  (env var, `{env:NAME}` config template, TUI `/connect`). "Bring your own key" is now the
  documented model story, not an accident.
- `docs/release.md` — the release runbook, including the **npm trusted-publisher setup**
  for all three packages (the field values are pinned to what `release.yml` presents:
  owner `jingzhao-l`, repo `glasspane-harness`, workflow `release.yml`, environment
  `release`). Until that is configured, CI cannot publish; the manual path is documented
  too.
- **npm READMEs.** 0.2.0's npm pages were a bare version string. The wrapper now ships the
  product README (EN + 中文) and each platform package ships a short README that says what
  the binary is and points at the wrapper. `publish.ts --dry-run` fails without them, so a
  README-less tarball cannot ship.
- The publishing jobs carry `environment: release`, which is both the value npm's trusted
  publisher must match and a place to require a human reviewer.

### Changed
- **This repository's own project directory is now `.glasspane-harness/`** (was upstream's
  `.opencode/`): the agent, command, skill, glossary and theme config that opencode used to
  develop itself now lives under the product's own name, so the repo dogfoods the rename.
  `.opencode/` is kept as a *read-only compatibility target* in a user's project — a
  `product-surface` assertion fails if a `.opencode/` reappears at the root **or** if the
  compat read is deleted.
- The repo's dev config file is `glasspane-harness.jsonc` (the name the product reads
  first).

### Removed — the first-party account surface (BYOK instead)
- The `opencode` first-party provider is filtered out of the model catalog.
- `auth login` / `logout` / `switch`, the `/org` TUI command and the console-org dialog.
- `/experimental/console*` server endpoints, the console-managed-provider config state,
  and the provider dialog's "managed by console" branch.
- Session sharing to opencode's cloud: the share modules, share/unshare endpoints, the
  `share` and `autoshare` config keys, the TUI `/share` command and the web app's share
  affordances (kept in the component shape, permanently off, one line to flip).
- The local `account` / `account_state` tables are no longer managed by the schema. The
  tables remain in existing databases — no destructive migration; the rows are inert.
- `import <share-url>` no longer fetches console shares; import a local JSON export.

Everything else in the catalog is untouched: Anthropic, OpenAI, Google, GitHub Copilot,
Bedrock, Azure, OpenRouter and the rest still ship, unlocked by your own key.

## [0.3.0] - 2026-09-25

**macOS-only, and the npm distribution says so.** The GlassPane engine, its four macOS
permission seats and the whole evidence pipeline exist only on macOS, so the product is
macOS-only (owner decision). The npm side enforces it rather than describing it.

### Changed
- The npm distribution is macOS-only: the wrapper declares `os: ["darwin"]` /
  `cpu: ["arm64", "x64"]`, so `npm install` on Linux or Windows is **refused by the
  package manager with a reason** instead of downloading a binary that cannot run. The
  target matrix in `product.json` is now exactly the two macOS targets.
- `scripts/install.ps1` (Windows one-click) is **removed** — the POSIX installer is the
  only one, and on a non-macOS host it says "macOS-only is a decision, not a missing
  port" and exits.
- The Linux/Windows/Intel-baseline platform packages published before this decision are
  **deprecated on npm with the reason attached** (they cannot be unpublished; a
  deprecation that explains itself beats a package that still installs).
- The release lane builds the two macOS targets on `macos-14` / `macos-13`.

### Added — npm infrastructure
- `publish.ts --dry-run`: packs every artifact and validates its shape **without
  touching the registry** — bin targets exist inside the tarball, the platform binary is
  present and executable, the wrapper's `optionalDependencies` match `product.json`'s
  target matrix, and the wrapper's `os`/`cpu` agree with the product's platform block.
  Wired into the fork's CI, so a broken package shape fails a PR instead of a release.
- `verify-published.ts`: "published" is not "works" — installs the **published** tarball
  into a throwaway prefix, runs `--version`, and confirms the embedded web app is served
  by that binary. Runs as the release lane's final job; on a non-macOS host it asserts
  that npm refuses the install.
- Wrapper metadata completed for its npm page: `engines.node`, `funding`,
  `publishConfig` (access + tag), `sideEffects`, and a dist-tag policy —
  `latest` for stable, `next` for anything on a non-latest channel, so a preview can
  never be installed by `npm i -g glasspane-harness` by accident.
- The npm publish/deprecation policy is recorded in `product.json` (`npm` block) so it
  travels with the code instead of living in someone's head.

### Docs
- READMEs, `docs/install.md`, `docs/index.md` and `docs/troubleshooting.md` state the
  platform boundary up front, with the npm `EBADPLATFORM` case in the troubleshooting
  table.

## [0.2.0] - 2026-09-25

The companion product surfaces, brought in as first-class citizens (owner decision:
"那几个配套产品面还是需要的"), plus the release infrastructure around them.

### Added
- **Web app embedded in the binary again** (upstream default, and what iterate-harness
  does with its dashboard): `glasspane-harness serve` serves the browser UI from the same
  process. `--skip-embed-web-ui` still produces a CLI-only build, and a build without the
  bundle starts and says the UI is absent instead of failing.
- Product README (EN + 简体中文) rebuilt in the iterate-harness shape: language switch,
  npm-downloads / version / CI / license / stars badges, product-surface table, the
  problem statement, quick start, docs index, and the attribution block.
- `assets/logo.svg` + `assets/banner.svg` (SVG on purpose: the brand stays diffable text).
- `docs/` (six pages: index, install, tools, evidence, migrate-from-opencode,
  troubleshooting) — the in-repo canonical documentation the READMEs link to.
- `CHANGELOG.md` for the product (this file), `SECURITY.md` for the product (upstream's
  pointed at upstream's disclosure process).
- GitHub issue templates (bug with a mandatory `gp_probe_status` payload, feature with an
  "which evidence does it rely on" question) and a PR template carrying the line's
  checklist (fork-diff record, product.json first, brand gate, fixed points with reverse
  controls, stated boundaries).

### Changed
- The docs link checker now covers the product's documents too (24 files, 212 links): a
  dead link in the product README is the same red as one in the repository's.
- The M1 rows in `FORK.md` / `SYNCLOG.md` no longer hard-code a tool count — the count was
  a claim the checker could not verify, and this line's doctrine is "read it from
  `hello.capabilities`, never copy it".

### Not in this release
- The docs **site** (`packages/web`) is still upstream's Astro/Starlight tree: it builds
  and is kept for lineage, but its content is not yet our documentation. Until that is
  done, the canonical docs are `docs/` in this repository — the docs site is marked
  `not-yet-ours` in `product.json` rather than being quietly presented as finished.
- Electron desktop app (second batch; needs signing and notarisation accounts).

## [0.1.0] - 2026-09-25

First public release of the private customisation. Everything below is a decision that
used to be upstream's, recorded so the next release notes can be diffed against reality.

### Added
- Product identity: `glasspane-harness` (binaries, `gp-harness` alias, npm wrapper
  `glasspane-harness` + 12 platform packages, user agent, mDNS name, `~/.glasspane-harness`
  state root, `glasspane-harness.json(c)` config names with upstream names kept as legacy
  fallbacks, default TUI theme, basic-auth default user name).
- GlassPane's native `gp_*` tool surface: `gp_probe_status`, `gp_attach`, `gp_observe`,
  `gp_act`, `gp_diagnose`, `gp_last_evidence` — capabilities read from the running engine,
  never hard-coded.
- Evidence discipline: hash-chained decision log (op id ↔ entry hash) written through the
  vendored `@iterate/kernel`; a compaction hook that re-injects the session's evidence
  anchors; tool-surface ratchets that keep judgement in the engine (no threshold, pixel
  verdict or pass/fail synthesis in a shell).
- Session-flow evidence rendering in the TUI (engine refusal vs engine answer are visually
  distinct; the row model is a pure function the fixed points pin).
- Product surfaces: CLI + TUI, the **web app embedded in the binary**, the docs site and
  in-repo `docs/`, SDKs shipped with the tree.
- One-click installers (`scripts/install.sh`, `install.ps1`): npm first, GitHub release
  asset as fallback, verification step, and the GlassPane-daemon prerequisite spelled out.
- Fixed-point tests for every module (M1–M5), plus two runtime probes: E7 (decision chain
  against bytes the engine wrote) and E8 (the compaction hook against a real host).

### Changed
- Project configuration directory is `.glasspane-harness/`; `.opencode/` is still read
  (legacy), and when both exist the product's directory wins the merge.
- Web UI embedding is the default again (`--skip-embed-web-ui` opts out).
- `glasspane-harness --version` reports the manifest's version verbatim (it used to
  inherit upstream's release-time patch bump and print a version that was never built).

### Removed (on purpose, recorded)
- The hosted console / enterprise / stats stack and its SST infrastructure — a private
  harness has no organisation-and-quota back office.
- Paths that would have executed or published *another project's* assets: the upstream
  docker/AUR/Homebrew publishing tail and the `opencode.ai/install` self-upgrade.
- The Electron desktop app is not shipped in 0.1.0 (second batch; needs signing and
  notarisation accounts). It remains in the tree as lineage.
