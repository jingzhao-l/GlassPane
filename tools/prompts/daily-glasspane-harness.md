# 每日任务 · 项目 2：glasspane-harness（opencode fork + 六把尺子）

> 用法：把下面「提示词正文」整段贴进一个全新会话。它与项目 1 的提示词互不重叠：那一份管主仓产品面，这一份管 fork 与量它的尺子。

---

## 提示词正文

请对 `/Volumes/Eng-Dev/GlassPane/harness/glasspane-harness`（glasspane-harness：上游 `anomalyco/opencode` 的产品级定制 fork，连同主仓里量它的尺子层）执行每日例行「全面审查 + 修复 + 发版」任务。**这是无人值守场景**：全程没有人在旁边，任何正常情况下需要我决策的地方都由你自己判断并执行到底，不许中途停下来问我，也不许把任何事项留成"待裁决/待补/下一轮再看"。

【无人值守：零遗留与全线发布授权（本节优先级最高）】

- **授权范围**：审查与改 fork 定制面、改尺子层与金样（`--record` 按纪律）、加/改测试、提交并推送主仓 `main`、`subtree split` 推到 `jingzhao-l/glasspane-harness` 的 `main`、打 tag 并推（触发 binaries + checksums + 签名）、`gh workflow run -f publish_npm=true -f confirm=true` 真的发 npm（wrapper + 平台包）、改 split 仓与主仓的 `.github/workflows/*`、以及在需要覆盖时用带显式 SHA 的 `--force-with-lease`。这些不必再问我。
- **收口定义（不成立就是本轮失败）**：① 本轮改动全部落在主仓 **main** 上并推送，`git status --porcelain` 为空；② split 仓的 `main` 与 tag `v<X.Y.Z>` 都在，Release 非草稿、资产带签名；③ registry 上 wrapper 与平台包的版本号实测等于新号；④ `SYNCLOG.md`/`CHANGELOG.md` 已留痕；⑤ 没有属于你的半成品留在临时分支、worktree 或未提交状态里。**把发版做在 `gp-harness-daily-<date>` 这类分支上而没并进 main，等于没收口**（2026-10-10 那轮就是栽在这，5 个文件的真修复挂在未提交状态里）；⑥ 工作区与两个远端已按下面【收口清理】做完，不再留下游离分支与工作树。
- **发现问题必须完全解决，而且只允许一种终态**：本轮审出的每个缺陷收口时只能是「已修复 + 有固定点测试 + 已进 main（该发版的随本版发出）」。**"判定不属于本轮"这个出口不存在**——缺陷长在哪条线就跨到哪条线修完：要改 canonical 内核就在 `/Volumes/Eng-Dev/iterate-skill/kernel` 改、跑它门禁、发版、再升级 fork 的 pin；属主仓产品面的就在主仓那层修（同轮提交推送，按那条线的节奏发版）。"已知未修""待补实现""下一轮再看""已在案"一律不合格；**半修更糟**——改了呈现面而判定/契约面还按旧行为走（例如 `verify-published` 那句拿 `product.json` 跟自己比的自回显断言、注册表加了工具而 `hello.capabilities` 没跟上），它把缺陷伪装成进展。收口后唯一还能存在的未完成项是物理边界那一类（见下面那条）。下一轮可以发现新问题，但本轮发现的问题必须本轮清零。
- **替你做的决定要留痕**：取号判断、split 是否需要覆盖、棘轮重记、契约 pin 是否升级、产品边界是否调整——每个决定写进 `SYNCLOG.md`/提交正文，汇报里汇总一条「本轮决定 → 依据 → 回滚命令」。
- **物理上做不到的只有两件**：`npm stage approve`（要你的 2FA）与上游参照网络不可达时的构建。碰上先把其余一切做完，再给出确切补救命令（stage-id、包名、版本）。除此之外汇报里不许出现"需要你决定"。
- **范围纪律**：不得为了"清零"擅自扩产品面（把 Electron 桌面 app、上游文档站、Web UI 内嵌拉进发布，或给 `product.json` 加新平台目标却没有对应 CI lane）。那属于范围变更；要做就连同代价、构建通道、brand/product 闸一起做完并留痕，否则按最小正确修法收口。**这条限制的是产品形状，不是缺陷处置**：已发现的问题仍要本轮修完，只是修的时候别顺手加没人要的新能力。
- **诚实性优先于零遗留**：测不出的（真模型轮次、真 TUI 观感、musl/baseline 目标）照实写"未观测"，但仍要给出"补它的确切一条命令 + 为什么本轮没跑"。"如实标注"不等于可以不做。

- **发布顺序这一格，2026-10-27 一天里花了三个号，别再花第四次的理由写在这里**：`harness/tools/release-artifact.mjs` 要求「已发布 tag 背后的树 == 主干 `harness/glasspane-harness` 子树」，豁免只有 `SYNCLOG.md`/`CHANGELOG.md` 在落后方向那一格。由此三条硬顺序：① **非台账文件（两份 README、`docs/**`、`script/**`、`scripts/install.sh`、`product.json`……）必须赶在本轮 tag 之前进 main**——tag 之后再改一行，那一行就只能由下一个号吸收（当天实测：`9ba1183c` 的 +94 行换来 `0.12.2`；`039df15e` 落在 `v0.12.3` 之后一分钟、两份各 1 行，又吃掉 `0.12.3`）。② **金样那一半不花钱**：`node harness/tools/fork-diff.mjs --record` 跟一笔即可，只许 hash 移动、不许三张计数（`285 edited / 112 added / 1707 deleted`）移动——版本号换三次不等于分叉面变过。③ **第 3 步的 split 推送要排在主仓 CI 起跑之前**：主仓 `ci.yml` 的 `harness-rulers` lane 里就住着这把尺子，你推完 main 才推 split，它读到的就是旧 split，于是红一次再 `gh run rerun --failed`。当天这种时序红出现三次、三次都能 rerun 转绿，所以**"旧 sha 转不了绿"不是恒真**——它不能当成"反正转不了就别重切"的借口，也不该被写成"这条 lane 修不好"。④ 与下一条并读：主仓那条线若在你的 tag 之后改了子树里的非台账文件，本线取号时把它一起带走，别让它留成一格红。

【收口清理：每轮必做的最后一步（属收口硬条件）】

本线跨**两个远端**（主仓 + split 仓），游离物会双倍积累。截至 2026-10-11 主仓积下 18 个 worktree、41 条本地分支、7 条远端分支，其中 `gp-harness-daily-*`、`gp-harness-orphan-*`、`gp-harness-port-*`、`split/*`、`harness/daily-*` 全是历轮任务"做完就走"的产物——你要消灭的就是这个形态。收口前按八步走：

1. **列清单**：`git fetch origin --prune` 与 `git fetch <split-url> --prune` 两边的分支都要盘；`git worktree list`、`git for-each-ref refs/heads`、`git branch -r`；split 仓侧另有 `git ls-remote --heads <split-url>` 与 `gh pr list --repo jingzhao-l/glasspane-harness --state open`。
2. **判去向用内容不用分支名**：`git cherry main <b>` 对 squash 合并过的分支会误报"未落地"，证实/证伪用 `git log --oneline main..<b>` 与逐文件 `git diff main <b> -- <路径>`。`split/*` 是 `git subtree split` 的搬运产物，其内容已由 tag 与 split 仓承载，不参与这个判定，但**用完的那条要删**。
3. **删除**：证实在 main 里 → `git branch -d`（只用 `-d`；要用 `-D` 就说明第 2 步没做扎实），远端同名 `git push origin --delete <b>` / 同理删 split 仓侧分支；本轮自建 worktree 在确认 `git -C <wt> status --porcelain` 为空后 `git worktree remove`，最后 `git worktree prune`。**内容未落地的分支不许"留着"**：本轮把它并回 main、跑齐闸、修完再删；已被 main 的更新版本取代的，用第 2 步的字节比对证明"取代"，再删。唯一例外是**别的线（主仓 07:30 那条、canonical iterate-skill）正在飞的未提交批次**：不替别人提交、不 checkout/reset/stash，保持原状并点名，给出与本轮改动是否重叠的判断；但那批内容里若含你已发现的缺陷，缺陷本身仍要本轮修完——"等它的会话"不是不修的理由。
4. **快照分支**（`backup/*`、`safety/pre-harness-merge`）是一批未提交工作的唯一回滚点，只在该批已收口后才删，删前把判据写进 `SYNCLOG.md`。
5. **临时件**：`/var/tmp/glasspane-harness/`（含往轮 `ca-bundle.pem` 之外的临时前缀、拆分归档、`split-*` 工作目录）、`harness/glasspane-harness/packages/*/dist/`、往轮 worktree 的目录残留。`node_modules`（4,671 个包）与 `.external/opencode`（223 MB 参照克隆）**不是遗留项**，是环境，别为"数量好看"去删——磁盘不足时按前置第 3 条处理。
6. **台账类遗留也算遗留**：`CHANGELOG.md` 的 `[Unreleased]` 归入本版；`SYNCLOG.md` 本轮条目已写；fork-diff/tool-surface/brand 金样与本轮改动同批且 `--check` 复跑绿；split 仓 CI 最新一条 success；无悬挂 draft Release；无待批 staged publish；本轮开的 PR 已合并或给出去向。
7. **不许删**：tag（发布锚点与 provenance 起点）、未证实落地的分支、别人的活跃分支、split 仓 `main` 的历史。
8. **收口快照进汇报**：清理后主仓与 split 仓各自的 `git worktree list` 行数、分支条数，加一张「删了什么 / 留下什么 / 各自去向与判据」。



【审查范围】

- fork 本体的**我们的定制面**（不是上游全树）：`packages/opencode/src/tool/glasspane/`（`gp_*` 工具面）、`packages/opencode/src/tool/registry.ts`、`packages/opencode/src/plugin/glasspane-decision-log.ts`、`packages/opencode/src/plugin/glasspane-compaction.ts`、`packages/opencode/src/plugin/index.ts`、`packages/tui/` 的会话流渲染（`routes/session/index.tsx` 的 `glasspaneRow`/`GlassPaneTool` 分支）、`packages/opencode/script/build.ts`、`script/publish.ts`、`script/postinstall.mjs`、`script/glasspane-preflight.sh`、`script/kernel-pin.mjs`、`script/kernel-conformance.mjs`、`bin/`、`scripts/install.sh`、`product.json`、`packages/*/package.json`、`docs/`（含发布程序真源 `docs/release.md`）、`README.md`/`README.zh-CN.md`、`CHANGELOG.md`、`SECURITY.md`、`FORK.md`、`SYNCLOG.md`、`NOTICE`、自有 `.github/workflows/ci.yml` 与 `release.yml`、`.github/actions/setup-bun`。
- 尺子层（与 fork 同仓是第 3 条不可让步纪律）：`/Volumes/Eng-Dev/GlassPane/harness/tools/*.mjs`（`fork-diff`、`tool-surface`、`surface-semantics`、`brand-surface`、`product-surface`、`hook-liveness`）、`harness/contracts/*.json` 金样、`harness/upstream.json`、`harness/README.md`。跨语言契约语料的镜像由 `scripts/check-kernel-corpus.mjs` 管（`tools/sync-kernel.sh` 连同 `kernel/` 那份代码镜像于 2026-10-18 退役；再跑它只会拿到拒绝与三条出路）。
- 明确不改：主仓产品面与主仓版本线（`engine/`、`mcp-shell/`、`installer/`、`updater/`、`bridge/`、根 `package.json`、主仓 `CHANGELOG.md`）——那是项目 1 的每日任务；`node_modules/iterate-kernel/`（共享内核是 npm 依赖，不是仓里的抄本；出处与契约语料字节由 `contracts/kernel-pin.json` 记，升级走 `packages/opencode/package.json` 的依赖行 + `bun install` + `node script/kernel-pin.mjs --record`）；`LICENSE` 与上游 `NOTICE` 原文；`.external/opencode`（参照检出，只读）。
- 上游血缘名**不洗**：`@opencode-ai/*` 工作区包名、`OPENCODE_*` 环境变量、协议与类型名由 `brand-surface` 按基线计数豁免（只许减不许增）；把 2,700 个文件里的内部标识全洗一遍会毁掉同步能力，不是本轮该做的事。

【开工前先确认工作树与前置条件】

1. 整树 `git status --porcelain`，记下开工 HEAD。主仓常被并行会话以 dirty 状态占用（项目 1 的任务就在同一棵树上跑），一旦发现不属于本任务的未提交批次：不混提、不 `git add -A`、绝不 `git checkout --`/`reset`/`stash` 别人的文件；改用隔离工作树（`git worktree add`，基于 main 的 HEAD）做本轮改动与提交。worktree 里 `.external/opencode` 做成指回主工作树那份的符号链接，别各存 223 MB。
2. **先找上一轮没收口的活**：`git fetch origin --prune` 后逐条判定「已落地 / 被后续提交取代 / 真没落地」，判据用内容而不是分支名或提交信息（`git cherry`、逐文件比对）。已知的一笔：**`gp-harness-orphan-20261010`**（远端已有）保住了 10-10 那轮被 ENOSPC 杀掉时留在未提交状态的五个文件——`verify-published.ts`（把"拿 `product.json` 的声明跟自己比"的自回显 os/cpu 断言改成读**已安装**包清单的 `os`/`cpu`/`version`）、`scripts/install.sh`（兜底通道的签名抓取与资产校验面）、`installer-selftest.sh`、`script/publish.ts`、`harness/tools/product-surface.mjs`。main 上那句自回显断言现在仍在（`grep -n "platform block" -A3 harness/glasspane-harness/packages/opencode/script/verify-published.ts` 可复查）。本轮把它带证明地并回 main、补齐 fork-diff/CHANGELOG/SYNCLOG 与所有闸，再决定它是否触发一次发版；判定不并也要写下理由。**"上一轮的遗留"不是输入，是待办。** **2026-10-21 主仓轮新增的一笔（同一条机制）**：**`gp-harness-sc5-fork-20261020`**（远端已有，tip `f32ef8dd`）保住场景⑤的引擎侧两笔——`6bcbb18a`（`packages/opencode/src/tool/glasspane/providers.ts`：判定生产者按内核 provider 契约注册，`gp_diagnose` 归属到注册表）与 `f32ef8dd`（`script/registry-readiness.ts` + `verify-published.ts`：装之前先等 registry 读得到这个版本）。面 A 的那一半主仓已经并进 main（`8e321d4c`，`mcp-shell/src/providers.ts` 与分支逐字节相同，已证），**这两笔没并**：主仓 07:30 那条线无权改 `harness/` 内容与版本，而 `harness/tools/release-artifact.mjs --check` 要求「发布物 == 主干」——把 fork 侧新代码并进主干而不打新 tag，那把尺子必红，只有本线取号才能同时满足。所以移交：并回主干、重记 fork-diff/tool-surface/brand-surface/surface-semantics 金样、由本线决定是否随下一个版本发出去。判据用字节（`git diff main <b> -- harness/`），别用分支名。
3. **环境余量先查**：`df -k /Volumes/Eng-Dev` 看可用空间。`bun install`（4,671 个包）、`bun run build --single`、参照检出 223 MB 都要吃盘，而 2026-10-10 那轮就是在盘满时被 ENOSPC 半路杀掉（任务记录只留 `session-failed`，不写原因）。低于 ~4 GiB 先清可再生物：`harness/glasspane-harness/packages/*/node_modules`、`dist/`、`/var/tmp/glasspane-harness/` 下往轮临时前缀与归档；清完仍不够就按"环境不足"如实终止并在汇报最上方给数字与补救命令，别硬跑到会话被杀、把半成品丢在树里。
4. 工具链：`bun` 必须是 `packageManager` 钉的 **1.3.14**（`~/.bun/bin/bun`）。**缺工具不等于闸红**——找不到 bun 就明说哪几道闸没跑，不许把"没跑"写成"通过"。
5. 参照检出必须在钉点上：`node -p "require('./harness/upstream.json').tag"` 得到 pin，`git -C .external/opencode describe --tags` 必须等于它，且 `git -C .external/opencode fsck` 无错、工作树干净。缺失时按 `harness/README.md` 的命令 clone：`git clone --branch <pin> --depth 1 https://github.com/anomalyco/opencode.git .external/opencode`。
6. 任何整包构建前先跑 preflight（秒级）：`sh harness/glasspane-harness/packages/opencode/script/glasspane-preflight.sh`（在 fork 目录里则是 `sh packages/opencode/script/glasspane-preflight.sh`）。本机对 `objects.githubusercontent.com` 的 TLS 由拦截代理签发（`CN=SteamTools Certificate`），curl/git 过得去而自带 CA 的 bun 正确拒绝，所以构建必须把信任锚传给子进程：`export NODE_EXTRA_CA_CERTS=<钥匙串导出的 PEM 束>`（本机约定路径 `/var/tmp/glasspane-harness/ca-bundle.pem`，完整钥匙串束 163 张；只给 158 张系统根会 verification FAILED——那正是 bun 失败时的配置）。**任何"跳过证书校验"的开关一律不用。** 整包构建单次 >10 分钟，别放进每条改动后的复跑里：闸是按包的 typecheck + 固定点测试 + 六把尺子。

【执行流程】

1. **全面代码实现审查**：调用 `review-bugbot` skill 审查上面列出的定制面与尺子层（正确性、边界、异常处理、与 `FORK.md` 纪律的一致性、潜在缺陷）；再调用 `review-security` skill 过发布与供应链面（`script/publish.ts` 与 `build.ts` 有没有往别人基础设施推、`postinstall`/安装器是否校验 SHA256 与 GPG 签名、升级路径是否会 fetch 并执行第三方脚本、配置目录解析顺序谁赢）。列出全部问题并完整修复；每个修复配**固定点测试**（`packages/opencode/test/tool/glasspane-*.test.ts`、`test/plugin/glasspane-*.test.ts`、`packages/tui/test/cli/tui/*.test.tsx`），并附反向控制：破坏被修的点必须让具名用例变红，`grep` 之类模式没匹配上就等于假绿。尺子自身的改动必须重新验一次"它能红"（金样伪写、删金样、藏参照检出三条路径），并按既有口径把结论写进 `harness/README.md` 的「闸自己被验过吗」。
2. **用户体验审查 + 功能缺口分析**：审产品门面（`glasspane-harness` / `gp-harness` 两个命令的文案与 `--version`、错误 remedy 是否 agent 可执行、TUI 里引擎拒绝与真实结果是否视觉可分、`docs/` 六页、`scripts/install.sh` 三条安装通道与失败提示）。分析功能增加需求并确定后完整实现（含测试，同步 `CHANGELOG.md` 与 `docs/`、README 双语两侧）。下面这些历史挂账要逐条回代码复核（别用提交信息统计"已修"），**并在本轮变成你的决定——修掉、或判定维持现状并写下依据，两条都算收口，继续挂着不算**：真 TUI 会话里的观感；M2 决策日志的 `logged` 分支需要的那一次证据成包真轮次；真模型轮次；`product.json` 声明了却没有 CI lane 的 musl/baseline 目标；`packages/{app,session-ui,desktop}` 与 TUI 的取舍（这条属于产品边界，维持现状是默认答案，改它要连代价、构建通道、brand/product 闸一起做完）。
3. **重新自查 + 门禁全绿**。六把尺子**从主仓根**跑（尺子在 `harness/tools/`，不在 fork 目录里；这是设计）：
   - `node harness/tools/fork-diff.mjs --check`（约 2 分钟，逐文件 blob 比对，要参照检出）
   - `node harness/tools/tool-surface.mjs --check`（占比棘轮；无参照时会打印 `NOT re-measured`，那不算复测）
   - `node harness/tools/surface-semantics.mjs --check`（工具面不得自行判定证据语义）
   - `node harness/tools/brand-surface.mjs --check`（品牌棘轮 + 全树血缘只减不增）
   - `node harness/tools/product-surface.mjs --check`（产品面一致性，**无基线、无 `--record`**：规则错了就改规则）
   - `node harness/tools/hook-liveness.mjs --check`（对齐 pin 的扩展点存活）；没有参照的环境用 `--offline`，它必须大声声明"上游未在此观测"
   - `node harness/glasspane-harness/script/kernel-pin.mjs --check`（装的版本 == pin、lock 是 registry 解析且 integrity 对得上、随包 26 个契约文件（18 fixtures + 8 schemas）逐条 sha256）；`--probe` 问 registry 有没有更新的一版（漂移是要人看的发现，不是 CI 失败）
   fork 包内测试（**仓根有一个故意的 `do-not-run-tests-from-root` 挡路，不要绕开它**）：
   - `cd harness/glasspane-harness/packages/opencode && bun test --timeout 30000 test/tool/glasspane-surface.test.ts test/tool/glasspane-kernel.test.ts test/plugin/glasspane-decision-log.test.ts test/plugin/glasspane-compaction.test.ts`（`test/preload.ts` 的 afterAll 要 dispose runtime + 删临时目录，5 秒默认超时会被打断成"无名失败"，所以必须带 `--timeout 30000`）
   - `cd harness/glasspane-harness/packages/tui && bun test --timeout 30000 test/cli/tui/inline-tool-wrap-snapshot.test.tsx`
   - typecheck 四个发布包：`cd harness/glasspane-harness && for pkg in opencode tui sdk/js plugin; do (cd packages/$pkg && bun run typecheck); done`
   - 内核行为：`bun harness/glasspane-harness/script/kernel-conformance.mjs`（哈希只证明字节没变，这条证明我们依赖的那些答案还是那些答案）；canonical checkout 在场时加 `--impl <它>`，两条 zod major 必须同答案
   - 发布形态：`cd harness/glasspane-harness/packages/opencode && bun run script/publish.ts --dry-run`（pack 形状、bins 可执行、wrapper 的 optionalDependencies == `product.json` 目标矩阵、os/cpu gate）
   - 主仓公共闸（尺子层文档也归它管）：`node scripts/check-workflows.mjs --self-test`、`node scripts/check-workflows.mjs`、`node scripts/check-doc-links.mjs`
   规则：改动前先记录各闸基线（面 A/面 B 行数与占比、血缘计数、product-surface 断言条数、固定点用例数），跑完对着计数判定；**"闸是绿的"要连计数一起看**（历史上计数从 83 变 86 才发现死代码插在了 `process.exit` 之后）。日志禁止 `tail`/`head` 截断后再下结论；包装脚本退出码不可信；只跑一次不算做完。上游 13 条时序敏感全量用例在本机不可靠（已挂账为"本机不可靠"而非"能修"），**不许为了让它们变绿而改判据或加超时**，要跑就隔离单条跑并如实记。棘轮转红只有两种诚实出路：同批 `--record` 并在提交正文说清长了多少/为什么，或者把改动挪走；不许用 `--record` 掩盖语义外移，也不许删注释换绿。
4. **发版**（产品 `glasspane-harness`，pre-1.0 语义：产品面/CLI 形状变动=minor，纯修复=patch；判据写进 `CHANGELOG.md` 条目开头）：
   a. 版本线两处：`harness/glasspane-harness/product.json` 的 `version` 是**真源**，`packages/opencode/package.json` 的 `version` 跟随。改完必须 `node harness/tools/product-surface.mjs --check` 报「N 条一致 / 0 条问题」，并确认 manifest / `build.ts` / `publish.ts` / `postinstall` / bin shim / 两个安装器 / 两条工作流都认同一个号。
   b. `CHANGELOG.md`：把 `[Unreleased]` 内容归入新版本条目（`[Unreleased]` 留空但保留注释行），写清"修掉的是什么、怎么证的"。若条目里必须引用被改掉的用户可见字符串（旧值），`brand-surface` 血缘计数会按字面 +1——按既有先例（9616/9617/9618）`--record` 并在金样 `source` 里写明"字样出现在说明它已被改掉的位置"，反证仍要成立。
   c. 任何改变 fork 树构成的提交，必须在**同一个提交**里 `node harness/tools/fork-diff.mjs --record` 更新 `harness/contracts/fork-diff.json`（不更新即红；光有名单不够，金样对每个 edited 文件钉了双侧内容哈希，"已在名单里的文件又长几行"也咬）。有意新增我们的行导致 `tool-surface` 转红时，同批 `--record`。
   d. 提交并推送主仓 `origin main`：提交信息以 **`[gp] ` 前缀**（于是"我们改了什么"永远可枚举：`git log <pin>..HEAD --oneline --grep '^\[gp\]'`），Conventional Commits + 中文正文，一提交一逻辑变更，含中文/括号一律 `git commit -F <文件>`。发版提交形如 `[gp] release(harness): <X.Y.Z> —— <一句话>`。
   e. **先证明再推**（subtree split 发布；本产品的发布程序真源是 `harness/glasspane-harness/docs/release.md`，冲突时以它为准并在汇报里说明差异）：`git subtree split --prefix=harness/glasspane-harness -b split/glasspane-harness`，然后断言 split 分支的 tree 哈希与 `git rev-parse HEAD:harness/glasspane-harness` **逐字相等**（不等就别推，先查是哪里掉了文件——历史事故：import 漏了 7 个"在磁盘上但从未提交"的文件，四桶比的是工作树 vs 参照 index，看起来逐字节相同）。相等后推到 split 仓：`git push https://github.com/jingzhao-l/glasspane-harness.git split/glasspane-harness:refs/heads/main`。那条文档写的是 `--force`：**别直接照抄**——先试普通 push（fast-forward 就过了），只有确实需要覆盖时才用带显式 SHA 的 `--force-with-lease=split/glasspane-harness:<expected-sha>`，并在 `SYNCLOG.md` 记下为什么要覆盖、覆盖掉的是哪些提交哈希、以及**逐条证明**它们已经以某种形式存在于本树或 main 里（`git merge-base --is-ancestor` 或逐文件内容比对）。"落后"不是你停下的理由：把差集逐笔核对，重复的重放成一条，别人未落地的成果就带上——只有当你无法证明被覆盖内容不丢时才不许推，那种情况你要自己找出第三条路（新分支名、先 merge 再推、或改用 fast-forward 的基线），并把选择与依据写进 `SYNCLOG.md`。token 因 workflow scope 拒推 `.github/workflows/**` 时改 SSH 形式（`git@github.com:jingzhao-l/glasspane-harness.git`）。
   f. 在 split 仓打 tag 并推送：`git push <split-url> split/glasspane-harness:refs/tags/v<X.Y.Z>`。这触发 split 仓 release.yml：`version-check`（tag 必须等于 `product.json` 的 version）→ `create-release`（不存在才建，可重跑）→ `binaries`（darwin-x64 用 `macos-15-intel`、darwin-arm64 用 `macos-14`；`bun run build --single`，`OPENCODE_VERSION` 从 `../../product.json` 读）→ `checksums` + GPG 签名（`release` 环境读不到 `GPG_PRIVATE_KEY` 就失败，remedy 是 `gh secret set GPG_PRIVATE_KEY --env release --repo jingzhao-l/glasspane-harness`；**不得改成 best-effort 跳过**）。逐 job 确认：`gh run list --repo jingzhao-l/glasspane-harness --workflow Release`、`gh run view <id> --log`。
   g. npm 发布（与 tag 是两条独立动作，不可逆）：先 `bun run script/publish.ts --dry-run` 本地验形态，再 `gh workflow run release.yml --repo jingzhao-l/glasspane-harness --ref v<X.Y.Z> -f publish_npm=true -f confirm=true`（`publish-platform` 两个目标包 + `publish-wrapper` 的 `glasspane-harness`，带 provenance；staged-only 被拒时 `npm stage approve <stage-id>` 属 owner 2FA 人工动作，列进汇报别硬闯）。**`--ref` 必须显式写成被发的那个 tag**：这两条 job 的 `actions/checkout` 取 dispatch 的 ref，不传就落到 split 仓默认分支 HEAD，发出去的字节就不保证等于被 tag 的树。签名与发布的前置诊断复用主仓的 `tools/gpg-signing.sh verify`（它会把"已证明的"与"仍无法证明的"分开说）。
   h. 复核发布物与 registry（**tag ≠ npm，"publish 退 0" ≠ "装得上跑得通"**）：`gh release view v<X.Y.Z> --repo jingzhao-l/glasspane-harness --json isDraft,targetCommitish,assets`（资产应含 `glasspane-harness-darwin-arm64.zip`、`glasspane-harness-darwin-x64.zip`、各自 `.asc`、`SHA256SUMS.txt` 与其 `.asc`）；registry 在 publish 刚过的几分钟里可能返回读副本旧值，所以按版本号点名再带 `--prefer-online`：`npm view glasspane-harness@<X.Y.Z> version --prefer-online`、`npm view glasspane-harness-darwin-arm64@<X.Y.Z> version --prefer-online`、`npm view glasspane-harness-darwin-x64@<X.Y.Z> version --prefer-online`；最后跑发布专有的那一条（它走的就是用户的路径：把**已发布**的 tarball 装进临时前缀、跑 `--version`、在 macOS 上确认那份二进制真在供内嵌 web）：`cd harness/glasspane-harness/packages/opencode && bun run script/verify-published.ts <X.Y.Z>`——publish 绿而这条红，就是一个坏发布，不是噪声。另记一条实测事实：v0.6.4 那次 `targetCommitish` 是分支名 `main` 而不是被 tag 的 commit（split 仓的 `create-release` 步没显式 `--target`），本轮如实核对并把这条可复现性锚点的改进项列进汇报，别把它当成已具备的保证。
   i. 端到端实测（"一键下载"真正成立的那一步）：`npm install -g --prefix "$HOME/.local" glasspane-harness` → `glasspane-harness --version` 与 `gp-harness --version` 都等于新版本；curl 兜底通道装到临时前缀并**真的校验** SHA256SUMS 与 `.asc`（0.6.4 之前的这条路径从未成功过且不验签）；`bun add -g` 同理。npm ≥ 11 对首次见到的包会打 `allow-scripts` 警告（安装仍成功）与全局前缀不可写时给确切补救，这两条文案要与 `scripts/install.sh`、README 一致。`gp_*` 工具面需要 `glasspaned` 在跑（daemon 权限席位齐），起不来就如实标"未观测"，不得声称通过。
   j. `SYNCLOG.md` 留痕（本轮的测量数字、红过又修好的项、未观测的边界），主仓与 split 仓收口时 `git status --porcelain` 均为空；只要有文件更新就及时提交推送。
5. 上面全部完成后，执行【收口清理】那八步——主仓与 split 仓两边的分支、worktree、临时件与台账都要盘，**这一步没做完本轮就不算完**。

【不可让步的纪律】

- **判定性验证逻辑 100% 留在 Swift**：fork 里可以有 UI、编排、语义层与呈现，但"这次变化是不是这次操作造成的"只能由 `glasspaned` 经 local socket 给出。方法数与名字不写死，从 daemon `hello.capabilities` / 协商结果读（错误帧恒 `{code, message, remedy}`）。fork 绝不做"同一份状态两边各写一份实现"的第三份。
- **分叉必须可测量**：定制多少不是问题，不知道定制了多少才是。
- **尺子必须和 fork 同仓**，成果必须落回主干（长期寄生 worktree 曾让 4 条命令里 3 条在 main 上 `MODULE_NOT_FOUND` 两个月没人发现）。
- **共享内核不是我们的代码**：它是 `iterate-kernel` 依赖，规范源在 `/Volumes/Eng-Dev/iterate-skill/kernel`；要改语义就改 canonical 再发版，别在 fork 或 node_modules 里改。
- `permission.ask` 在上游是**死钩子**（pin 上全树只在声明处出现一次＝零派发）：权限引导必须走 `event` 收 `permission.asked` + `client.permission.reply`，不许挂它。金样里的死钩子集就是这条的报警器。
- 产品面只发 **CLI + TUI**（含无头 `serve`/`run`）；Web UI 内嵌、桌面 app、上游文档站不进产品，但这是**可回滚决策**——真要开回来就改 `product.json` + build 默认值并说清代价。
- 品牌与分发面：安装/文档/脚本里不许出现上游 npm 名、平台包名或上游 registry（ghcr / AUR / homebrew tap / opencode.ai install），也不许把发布推到别人家基础设施。
- 诚实性：测不出、没跑、没观测就写"未观测"；`fork-diff`/CI 没有参照克隆时只能核"我们这一侧"，别把降级输出当成复测结论。

【环境约束】

- 每次执行任何终端命令前，必须先执行：`export PATH="/opt/homebrew/bin:/opt/miniconda3/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.npm-global/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH"`。禁止在未恢复 PATH 时直接调用 git、bun、node、npm、gh、python3 等命令；仍不可用就用绝对路径（本机 `bun`=/Users/ethanlin/.bun/bin/bun、`gh`=/opt/homebrew/bin/gh）。禁止依赖 `source ~/.zshrc`。构建/发布类命令要同时带上 `NODE_EXTRA_CA_CERTS`（见前置第 6 条）。
- zsh 的 tmux 钩子会杀掉管道（症状 `command not found: tmux` + exit 127，不是 PATH 问题）：多段命令用 `/bin/bash -c '…'` 跑；heredoc 一律用引号形式 `<<'EOF'`，否则反引号会被执行；BSD `grep -o` 有 255 字符上限，长行匹配别依赖它。
- 长时间命令（`fork-diff`、整包构建、`bun install` 4,671 个包）用后台跑并轮询状态，别在前台等超时；超时不等于失败，先看日志再判定。
- 授权见开头【无人值守：零遗留与全线发布授权】那一节，那一条覆盖本节；这里只留三条不是"决策"而是"别做错"的纪律：`--record` 只用于本轮自己造成的有意变化，`product-surface` 永远不许 `--record`（它没有基线）；覆盖任何远端分支前先逐条证明被覆盖内容不丢；本轮不改主仓产品代码与主仓版本线，也不手改 `node_modules/iterate-kernel/` 或 `kernel/schemas/**` 这类复制品（要动语义就走 canonical 再 pin/同步）。
- 发现主仓产品面或 canonical 内核的问题时，**不是"列进汇报"或"交给那条线"就完事**：那仍是本轮要修掉的缺陷。修法是你直接在所属那一层改（canonical 侧改完跑它门禁并发版、再升级 fork 的 pin；主仓侧的改动按主仓那条线的口径提交推送并随其发版），并在汇报里给出改了哪层、跑了哪些闸、两侧版本号是多少。写"该由哪条线修"只允许作为**执行路径的说明**，不允许作为不修的出口。

【最终汇报】

简明列出，按这个顺序：① **收口证据**——主仓 main 的收口 HEAD、`git status --porcelain` 为空、split 仓 `main` 与 `v<X.Y.Z>` tag 都在、Release 是否 draft=false 及资产清单、registry 三个版本号（wrapper + darwin-arm64 + darwin-x64）实测值；② pin 与参照检出状态（`describe` == pin？）；③ 版本判断依据与两处版本线核对结果；④ 每条闸的**实际数字**（面 A/面 B 行数与占比、血缘计数、product-surface 断言条数、固定点用例通过/失败/跳过、`fork-diff` 四桶计数）；⑤ 改了哪些文件、对应哪条 `[gp]` 提交；⑥ split 发布的 tree-hash 等式证据；⑦ 端到端安装与验签结果；⑧ 反向验证证据（破坏哪一处、哪条具名用例或哪把尺子变红）；⑨ **本轮我替你做了哪些决定**（含依据与回滚命令）——一项都没有通常意味着你把该决定的东西推给了别人；⑩ **未观测项**——只限物理边界那一类，每条写明"为什么本机做不了"与"补上它的确切一条命令"；**"未修项"这一格必须为空**，非空就是本轮没收口（发现 N 条就要有 N 条修复与固定点测试，数量要在汇报里对得上）；⑪ **清理盘点**——主仓与 split 仓各自的 `git worktree list` 行数与分支条数，加一张「删了什么 / 留下什么 / 各自去向与判据」的表（合法的"留下"只有两类：别人正在飞的未提交批次，与物理边界；其余一律不许留）。不要贴大段日志。
