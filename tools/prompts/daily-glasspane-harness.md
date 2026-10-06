# 每日任务 · 项目 2：glasspane-harness（opencode fork + 六把尺子）

> 用法：把下面「提示词正文」整段贴进一个全新会话。它与项目 1 的提示词互不重叠：那一份管主仓产品面，这一份管 fork 与量它的尺子。

---

## 提示词正文

请对 `/Volumes/Eng-Dev/GlassPane/harness/glasspane-harness`（glasspane-harness：上游 `anomalyco/opencode` 的产品级定制 fork，连同主仓里量它的尺子层）执行每日例行「全面审查 + 修复 + 发版」任务。本任务在全新会话中无人值守执行，请自主完整完成，勿遗漏，勿在中途向我确认。

【审查范围】

- fork 本体的**我们的定制面**（不是上游全树）：`packages/opencode/src/tool/glasspane/`（`gp_*` 工具面）、`packages/opencode/src/tool/registry.ts`、`packages/opencode/src/plugin/glasspane-decision-log.ts`、`packages/opencode/src/plugin/glasspane-compaction.ts`、`packages/opencode/src/plugin/index.ts`、`packages/tui/` 的会话流渲染（`routes/session/index.tsx` 的 `glasspaneRow`/`GlassPaneTool` 分支）、`packages/opencode/script/build.ts`、`script/publish.ts`、`script/postinstall.mjs`、`script/glasspane-preflight.sh`、`script/kernel-vendor.mjs`、`script/kernel-conformance.mjs`、`bin/`、`scripts/install.sh`、`product.json`、`packages/*/package.json`、`docs/`（含发布程序真源 `docs/release.md`）、`README.md`/`README.zh-CN.md`、`CHANGELOG.md`、`SECURITY.md`、`FORK.md`、`SYNCLOG.md`、`NOTICE`、自有 `.github/workflows/ci.yml` 与 `release.yml`、`.github/actions/setup-bun`。
- 尺子层（与 fork 同仓是第 3 条不可让步纪律）：`/Volumes/Eng-Dev/GlassPane/harness/tools/*.mjs`（`fork-diff`、`tool-surface`、`surface-semantics`、`brand-surface`、`product-surface`、`hook-liveness`）、`harness/contracts/*.json` 金样、`harness/upstream.json`、`harness/README.md`、`/Volumes/Eng-Dev/GlassPane/tools/sync-kernel.sh`。
- 明确不改：主仓产品面与主仓版本线（`engine/`、`mcp-shell/`、`installer/`、`updater/`、`bridge/`、根 `package.json`、主仓 `CHANGELOG.md`）——那是项目 1 的每日任务；`packages/opencode/vendor/kernel/`（vendored 内核，真源是 `/Volumes/Eng-Dev/iterate-skill/kernel`，手改一个字节即 `kernel-vendor --check` 红，唯一合法更新路径是 `KERNEL_SRC=/Volumes/Eng-Dev/iterate-skill tools/sync-kernel.sh --target=fork`，且只在 canonical 前进时跑）；`LICENSE` 与上游 `NOTICE` 原文；`.external/opencode`（参照检出，只读）。
- 上游血缘名**不洗**：`@opencode-ai/*` 工作区包名、`OPENCODE_*` 环境变量、协议与类型名由 `brand-surface` 按基线计数豁免（只许减不许增）；把 2,700 个文件里的内部标识全洗一遍会毁掉同步能力，不是本轮该做的事。

【开工前先确认工作树与前置条件】

1. 整树 `git status --porcelain`，记下开工 HEAD。主仓常被并行会话以 dirty 状态占用（项目 1 的任务就在同一棵树上跑），一旦发现不属于本任务的未提交批次：不混提、不 `git add -A`、绝不 `git checkout --`/`reset`/`stash` 别人的文件；改用隔离工作树（`git worktree add`，基于 main 的 HEAD）做本轮改动与提交。worktree 里 `.external/opencode` 做成指回主工作树那份的符号链接，别各存 223 MB。
2. 工具链：`bun` 必须是 `packageManager` 钉的 **1.3.14**（`~/.bun/bin/bun`）。**缺工具不等于闸红**——找不到 bun 就明说哪几道闸没跑，不许把"没跑"写成"通过"。
3. 参照检出必须在钉点上：`node -p "require('./harness/upstream.json').tag"` 得到 pin，`git -C .external/opencode describe --tags` 必须等于它，且 `git -C .external/opencode fsck` 无错、工作树干净。缺失时按 `harness/README.md` 的命令 clone：`git clone --branch <pin> --depth 1 https://github.com/anomalyco/opencode.git .external/opencode`。
4. 任何整包构建前先跑 preflight（秒级）：`sh harness/glasspane-harness/packages/opencode/script/glasspane-preflight.sh`（在 fork 目录里则是 `sh packages/opencode/script/glasspane-preflight.sh`）。本机对 `objects.githubusercontent.com` 的 TLS 由拦截代理签发（`CN=SteamTools Certificate`），curl/git 过得去而自带 CA 的 bun 正确拒绝，所以构建必须把信任锚传给子进程：`export NODE_EXTRA_CA_CERTS=<钥匙串导出的 PEM 束>`（本机约定路径 `/var/tmp/glasspane-harness/ca-bundle.pem`，完整钥匙串束 163 张；只给 158 张系统根会 verification FAILED——那正是 bun 失败时的配置）。**任何"跳过证书校验"的开关一律不用。** 整包构建单次 >10 分钟，别放进每条改动后的复跑里：闸是按包的 typecheck + 固定点测试 + 六把尺子。

【执行流程】

1. **全面代码实现审查**：调用 `review-bugbot` skill 审查上面列出的定制面与尺子层（正确性、边界、异常处理、与 `FORK.md` 纪律的一致性、潜在缺陷）；再调用 `review-security` skill 过发布与供应链面（`script/publish.ts` 与 `build.ts` 有没有往别人基础设施推、`postinstall`/安装器是否校验 SHA256 与 GPG 签名、升级路径是否会 fetch 并执行第三方脚本、配置目录解析顺序谁赢）。列出全部问题并完整修复；每个修复配**固定点测试**（`packages/opencode/test/tool/glasspane-*.test.ts`、`test/plugin/glasspane-*.test.ts`、`packages/tui/test/cli/tui/*.test.tsx`），并附反向控制：破坏被修的点必须让具名用例变红，`grep` 之类模式没匹配上就等于假绿。尺子自身的改动必须重新验一次"它能红"（金样伪写、删金样、藏参照检出三条路径），并按既有口径把结论写进 `harness/README.md` 的「闸自己被验过吗」。
2. **用户体验审查 + 功能缺口分析**：审产品门面（`glasspane-harness` / `gp-harness` 两个命令的文案与 `--version`、错误 remedy 是否 agent 可执行、TUI 里引擎拒绝与真实结果是否视觉可分、`docs/` 六页、`scripts/install.sh` 三条安装通道与失败提示）。分析功能增加需求并确定后完整实现（含测试，同步 `CHANGELOG.md` 与 `docs/`、README 双语两侧）。挂账清单要逐条回代码复核后再决定是否本轮收口（别用提交信息统计"已修"）：真 TUI 会话里的观感未观测；M2 决策日志的 `logged` 分支仍需一次证据成包的真轮次；真模型轮次未跑；`product.json` 声明的 musl/baseline 目标没有 CI lane；`packages/{app,session-ui,desktop}` 会不会取代 TUI 仍是待决项。
3. **重新自查 + 门禁全绿**。六把尺子**从主仓根**跑（尺子在 `harness/tools/`，不在 fork 目录里；这是设计）：
   - `node harness/tools/fork-diff.mjs --check`（约 2 分钟，逐文件 blob 比对，要参照检出）
   - `node harness/tools/tool-surface.mjs --check`（占比棘轮；无参照时会打印 `NOT re-measured`，那不算复测）
   - `node harness/tools/surface-semantics.mjs --check`（工具面不得自行判定证据语义）
   - `node harness/tools/brand-surface.mjs --check`（品牌棘轮 + 全树血缘只减不增）
   - `node harness/tools/product-surface.mjs --check`（产品面一致性，**无基线、无 `--record`**：规则错了就改规则）
   - `node harness/tools/hook-liveness.mjs --check`（对齐 pin 的扩展点存活）；没有参照的环境用 `--offline`，它必须大声声明"上游未在此观测"
   - `node harness/glasspane-harness/script/kernel-vendor.mjs --check`（vendored 内核逐文件 sha256 == 溯源清单）；canonical 在场时加 `KERNEL_SRC=/Volumes/Eng-Dev/iterate-skill` 跨读，镜像落后即红并说"STALE，重跑同步"
   fork 包内测试（**仓根有一个故意的 `do-not-run-tests-from-root` 挡路，不要绕开它**）：
   - `cd harness/glasspane-harness/packages/opencode && bun test --timeout 30000 test/tool/glasspane-surface.test.ts test/tool/glasspane-kernel.test.ts test/plugin/glasspane-decision-log.test.ts test/plugin/glasspane-compaction.test.ts`（`test/preload.ts` 的 afterAll 要 dispose runtime + 删临时目录，5 秒默认超时会被打断成"无名失败"，所以必须带 `--timeout 30000`）
   - `cd harness/glasspane-harness/packages/tui && bun test --timeout 30000 test/cli/tui/inline-tool-wrap-snapshot.test.tsx`
   - typecheck 四个发布包：`cd harness/glasspane-harness && for pkg in opencode tui sdk/js plugin; do (cd packages/$pkg && bun run typecheck); done`
   - 内核行为：`bun harness/glasspane-harness/script/kernel-conformance.mjs`（哈希只证明字节没变，这条证明我们依赖的那些答案还是那些答案）
   - 发布形态：`cd harness/glasspane-harness/packages/opencode && bun run script/publish.ts --dry-run`（pack 形状、bins 可执行、wrapper 的 optionalDependencies == `product.json` 目标矩阵、os/cpu gate）
   - 主仓公共闸（尺子层文档也归它管）：`node scripts/check-workflows.mjs --self-test`、`node scripts/check-workflows.mjs`、`node scripts/check-doc-links.mjs`
   规则：改动前先记录各闸基线（面 A/面 B 行数与占比、血缘计数、product-surface 断言条数、固定点用例数），跑完对着计数判定；**"闸是绿的"要连计数一起看**（历史上计数从 83 变 86 才发现死代码插在了 `process.exit` 之后）。日志禁止 `tail`/`head` 截断后再下结论；包装脚本退出码不可信；只跑一次不算做完。上游 13 条时序敏感全量用例在本机不可靠（已挂账为"本机不可靠"而非"能修"），**不许为了让它们变绿而改判据或加超时**，要跑就隔离单条跑并如实记。棘轮转红只有两种诚实出路：同批 `--record` 并在提交正文说清长了多少/为什么，或者把改动挪走；不许用 `--record` 掩盖语义外移，也不许删注释换绿。
4. **发版**（产品 `glasspane-harness`，pre-1.0 语义：产品面/CLI 形状变动=minor，纯修复=patch；判据写进 `CHANGELOG.md` 条目开头）：
   a. 版本线两处：`harness/glasspane-harness/product.json` 的 `version` 是**真源**，`packages/opencode/package.json` 的 `version` 跟随。改完必须 `node harness/tools/product-surface.mjs --check` 报「N 条一致 / 0 条问题」，并确认 manifest / `build.ts` / `publish.ts` / `postinstall` / bin shim / 两个安装器 / 两条工作流都认同一个号。
   b. `CHANGELOG.md`：把 `[Unreleased]` 内容归入新版本条目（`[Unreleased]` 留空但保留注释行），写清"修掉的是什么、怎么证的"。若条目里必须引用被改掉的用户可见字符串（旧值），`brand-surface` 血缘计数会按字面 +1——按既有先例（9616/9617/9618）`--record` 并在金样 `source` 里写明"字样出现在说明它已被改掉的位置"，反证仍要成立。
   c. 任何触碰 vendored 树的提交，必须在**同一个提交**里 `node harness/tools/fork-diff.mjs --record` 更新 `harness/contracts/fork-diff.json`（不更新即红；光有名单不够，金样对每个 edited 文件钉了双侧内容哈希，"已在名单里的文件又长几行"也咬）。有意新增我们的行导致 `tool-surface` 转红时，同批 `--record`。
   d. 提交并推送主仓 `origin main`：提交信息以 **`[gp] ` 前缀**（于是"我们改了什么"永远可枚举：`git log <pin>..HEAD --oneline --grep '^\[gp\]'`），Conventional Commits + 中文正文，一提交一逻辑变更，含中文/括号一律 `git commit -F <文件>`。发版提交形如 `[gp] release(harness): <X.Y.Z> —— <一句话>`。
   e. **先证明再推**（subtree split 发布；本产品的发布程序真源是 `harness/glasspane-harness/docs/release.md`，冲突时以它为准并在汇报里说明差异）：`git subtree split --prefix=harness/glasspane-harness -b split/glasspane-harness`，然后断言 split 分支的 tree 哈希与 `git rev-parse HEAD:harness/glasspane-harness` **逐字相等**（不等就别推，先查是哪里掉了文件——历史事故：import 漏了 7 个"在磁盘上但从未提交"的文件，四桶比的是工作树 vs 参照 index，看起来逐字节相同）。相等后推到 split 仓：`git push https://github.com/jingzhao-l/glasspane-harness.git split/glasspane-harness:refs/heads/main`。那条文档写的是 `--force`：**别直接照抄**——先试普通 push（fast-forward 就过了），只有确实需要覆盖时才用带显式 SHA 的 `--force-with-lease=split/glasspane-harness:<expected-sha>`，并在 `SYNCLOG.md` 记下为什么要覆盖、覆盖掉的是哪些提交。仍落后到需要丢别人提交时，停下汇报。token 因 workflow scope 拒推 `.github/workflows/**` 时改 SSH 形式（`git@github.com:jingzhao-l/glasspane-harness.git`）。
   f. 在 split 仓打 tag 并推送：`git push <split-url> split/glasspane-harness:refs/tags/v<X.Y.Z>`。这触发 split 仓 release.yml：`version-check`（tag 必须等于 `product.json` 的 version）→ `create-release`（不存在才建，可重跑）→ `binaries`（darwin-x64 用 `macos-15-intel`、darwin-arm64 用 `macos-14`；`bun run build --single`，`OPENCODE_VERSION` 从 `../../product.json` 读）→ `checksums` + GPG 签名（`release` 环境读不到 `GPG_PRIVATE_KEY` 就失败，remedy 是 `gh secret set GPG_PRIVATE_KEY --env release --repo jingzhao-l/glasspane-harness`；**不得改成 best-effort 跳过**）。逐 job 确认：`gh run list --repo jingzhao-l/glasspane-harness --workflow Release`、`gh run view <id> --log`。
   g. npm 发布（与 tag 是两条独立动作，不可逆）：先 `bun run script/publish.ts --dry-run` 本地验形态，再 `gh workflow run release.yml --repo jingzhao-l/glasspane-harness --ref v<X.Y.Z> -f publish_npm=true -f confirm=true`（`publish-platform` 两个目标包 + `publish-wrapper` 的 `glasspane-harness`，带 provenance；staged-only 被拒时 `npm stage approve <stage-id>` 属 owner 2FA 人工动作，列进汇报别硬闯）。**`--ref` 必须显式写成被发的那个 tag**：这两条 job 的 `actions/checkout` 取 dispatch 的 ref，不传就落到 split 仓默认分支 HEAD，发出去的字节就不保证等于被 tag 的树。签名与发布的前置诊断复用主仓的 `tools/gpg-signing.sh verify`（它会把"已证明的"与"仍无法证明的"分开说）。
   h. 复核发布物与 registry（**tag ≠ npm，"publish 退 0" ≠ "装得上跑得通"**）：`gh release view v<X.Y.Z> --repo jingzhao-l/glasspane-harness --json isDraft,targetCommitish,assets`（资产应含 `glasspane-harness-darwin-arm64.zip`、`glasspane-harness-darwin-x64.zip`、各自 `.asc`、`SHA256SUMS.txt` 与其 `.asc`）；registry 在 publish 刚过的几分钟里可能返回读副本旧值，所以按版本号点名再带 `--prefer-online`：`npm view glasspane-harness@<X.Y.Z> version --prefer-online`、`npm view glasspane-harness-darwin-arm64@<X.Y.Z> version --prefer-online`、`npm view glasspane-harness-darwin-x64@<X.Y.Z> version --prefer-online`；最后跑发布专有的那一条（它走的就是用户的路径：把**已发布**的 tarball 装进临时前缀、跑 `--version`、在 macOS 上确认那份二进制真在供内嵌 web）：`cd harness/glasspane-harness/packages/opencode && bun run script/verify-published.ts <X.Y.Z>`——publish 绿而这条红，就是一个坏发布，不是噪声。另记一条实测事实：v0.6.4 那次 `targetCommitish` 是分支名 `main` 而不是被 tag 的 commit（split 仓的 `create-release` 步没显式 `--target`），本轮如实核对并把这条可复现性锚点的改进项列进汇报，别把它当成已具备的保证。
   i. 端到端实测（"一键下载"真正成立的那一步）：`npm install -g --prefix "$HOME/.local" glasspane-harness` → `glasspane-harness --version` 与 `gp-harness --version` 都等于新版本；curl 兜底通道装到临时前缀并**真的校验** SHA256SUMS 与 `.asc`（0.6.4 之前的这条路径从未成功过且不验签）；`bun add -g` 同理。npm ≥ 11 对首次见到的包会打 `allow-scripts` 警告（安装仍成功）与全局前缀不可写时给确切补救，这两条文案要与 `scripts/install.sh`、README 一致。`gp_*` 工具面需要 `glasspaned` 在跑（daemon 权限席位齐），起不来就如实标"未观测"，不得声称通过。
   j. `SYNCLOG.md` 留痕（本轮的测量数字、红过又修好的项、未观测的边界），主仓与 split 仓收口时 `git status --porcelain` 均为空；只要有文件更新就及时提交推送。

【不可让步的纪律】

- **判定性验证逻辑 100% 留在 Swift**：fork 里可以有 UI、编排、语义层与呈现，但"这次变化是不是这次操作造成的"只能由 `glasspaned` 经 local socket 给出。方法数与名字不写死，从 daemon `hello.capabilities` / 协商结果读（错误帧恒 `{code, message, remedy}`）。fork 绝不做"同一份状态两边各写一份实现"的第三份。
- **分叉必须可测量**：定制多少不是问题，不知道定制了多少才是。
- **尺子必须和 fork 同仓**，成果必须落回主干（长期寄生 worktree 曾让 4 条命令里 3 条在 main 上 `MODULE_NOT_FOUND` 两个月没人发现）。
- **vendored 内核不是我们的代码，也不是可以改的地方**。
- `permission.ask` 在上游是**死钩子**（pin 上全树只在声明处出现一次＝零派发）：权限引导必须走 `event` 收 `permission.asked` + `client.permission.reply`，不许挂它。金样里的死钩子集就是这条的报警器。
- 产品面只发 **CLI + TUI**（含无头 `serve`/`run`）；Web UI 内嵌、桌面 app、上游文档站不进产品，但这是**可回滚决策**——真要开回来就改 `product.json` + build 默认值并说清代价。
- 品牌与分发面：安装/文档/脚本里不许出现上游 npm 名、平台包名或上游 registry（ghcr / AUR / homebrew tap / opencode.ai install），也不许把发布推到别人家基础设施。
- 诚实性：测不出、没跑、没观测就写"未观测"；`fork-diff`/CI 没有参照克隆时只能核"我们这一侧"，别把降级输出当成复测结论。

【环境约束】

- 每次执行任何终端命令前，必须先执行：`export PATH="/opt/homebrew/bin:/opt/miniconda3/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.npm-global/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH"`。禁止在未恢复 PATH 时直接调用 git、bun、node、npm、gh、python3 等命令；仍不可用就用绝对路径（本机 `bun`=/Users/ethanlin/.bun/bin/bun、`gh`=/opt/homebrew/bin/gh）。禁止依赖 `source ~/.zshrc`。构建/发布类命令要同时带上 `NODE_EXTRA_CA_CERTS`（见前置第 4 条）。
- zsh 的 tmux 钩子会杀掉管道（症状 `command not found: tmux` + exit 127，不是 PATH 问题）：多段命令用 `/bin/bash -c '…'` 跑；heredoc 一律用引号形式 `<<'EOF'`，否则反引号会被执行；BSD `grep -o` 有 255 字符上限，长行匹配别依赖它。
- 长时间命令（`fork-diff`、整包构建、`bun install` 4,671 个包）用后台跑并轮询状态，别在前台等超时；超时不等于失败，先看日志再判定。
- 已授权（本任务内不必再问）：改 fork 定制面与尺子层、加/改测试、提交并推送主仓 `origin main`、`subtree split` 推送到 `jingzhao-l/glasspane-harness`、打 tag 与观察两条工作流、npm 发布、`--record` 重记金样（按上面第 3、4 步的口径）。仍需我点头、不得自动做：强推覆盖别人的提交、删除 Release/包/tag、改 GitHub secrets 或仓库设置、动主仓产品代码与版本线、动 `packages/opencode/vendor/kernel/` 或 `kernel/schemas/**`、把 dependabot 重新打开、把产品面边界（CLI+TUI）改成别的。
- 若审查中发现主仓产品面或 canonical kernel 的问题，仅在最终汇报中列出而不改动。

【最终汇报】

简明列出：开工/收口 HEAD 与是否用了隔离工作树；pin 与参照检出状态（`describe` == pin？）；版本判断依据与两处版本线核对结果；每条闸的**实际数字**（面 A/面 B 行数与占比、血缘计数、product-surface 断言条数、固定点用例通过/失败/跳过、`fork-diff` 四桶计数）；改了哪些文件、对应哪条 `[gp]` 提交；split 发布的 tree-hash 等式证据、tag/Release 资产、registry 三个版本号实测值；端到端安装与验签结果；反向验证证据（破坏哪一处、哪条具名用例或哪把尺子变红）；未修清单（待真机/待观测 / 待我裁决 / 主仓与 canonical 侧问题）。不要贴大段日志。
