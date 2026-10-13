# 每日任务 · 项目 1：GlassPane 主仓（引擎 + MCP 壳 + 安装器 + 更新器）

> 用法：把下面「提示词正文」整段贴进一个全新会话。它是自足的——所有命令、判据、坑都写在里面，不依赖本轮对话上下文。

---

## 提示词正文

请对 `/Volumes/Eng-Dev/GlassPane` 项目（GlassPane 主仓库）执行每日例行「全面审查 + 修复 + 发版」任务。**这是无人值守场景**：全程没有人在旁边，任何正常情况下需要我决策的地方都由你自己判断并执行到底，不许中途停下来问我，也不许把任何事项留成"待裁决/待补/下一轮再看"。

【无人值守：零遗留与全线发布授权（本节优先级最高）】

- **授权范围**：审查、改代码、加测试、提交、推送 `origin main`、升版本线、打 tag、触发并观察 GitHub Release 与 npm 两条发布通道、`gh workflow run -f mode=publish` 真的发 npm、改 `.github/workflows/*`、重记棘轮金样、以及（在你判定必要且已证明被覆盖内容不丢的前提下）对 split/远端分支的覆盖推送。这些都不必再问我。
- **收口定义（不成立就是本轮失败，不是"差一点"）**：① 本轮全部改动已落在 **main** 上并推送，`git status --porcelain` 为空；② 该发的版已发完——版本号进 5 处派生位点与 lock、CHANGELOG 有条目、tag 已推、GitHub Release 非草稿且资产/签名核过、registry 两个包的版本号等于新号；③ 没有任何属于你的半成品留在临时分支、worktree 或未提交状态里。**把发版做在 `daily/main-<date>` 这类自己开的分支上而没并进 main，等于没收口**（这件事真发生过）；④ **本轮发现的缺陷全部已修完**，数量对得上——发现 N 条就要有 N 条的修复提交与测试，不存在"决定不修"这一格；⑤ 工作区与远端已按下面【收口清理】那节做完，本轮不再留下游离的分支、工作树与临时件。
- **发现问题必须完全解决，而且只允许一种终态**：本轮审出的每一个缺陷，收口时必须已经是**已修复（有测试、已进 main、该发版的随本版一起发出）**。**"判定不属于本轮"这个出口不存在**：缺陷长在哪条线上就跨到哪条线去修完——要改 canonical 内核就在 `/Volumes/Eng-Dev/iterate-skill/kernel` 改、跑它门禁、发版、再回写本仓镜像；判定语义的问题就修到 Swift 那一层；安装器/发布链的缺陷就修脚本本身。中间态一律不合格："已知的未修项""待补实现""留到下一轮""已在案"。半修尤其不合格：改了 A 面而 B 面还指着旧行为（GUI 有控件而 daemon 无命令、schema 加了字段而读侧没管、remedy 指着一个不存在的开关）比不修更糟，因为它把缺陷伪装成进展。收口之后还能存在的未完成项只有一类：物理上做不到的（见下面那条），且必须写成一条可执行的人工动作而不是"未修"。**下一轮可以发现新问题，但本轮发现的问题必须本轮清零。**
- **替你做的决定要留痕**：取号判断、要不要动风险区文件、修到哪一层、棘轮是否重记、契约是否升级——每个决定在提交正文或 `CHANGELOG.md`/`specs/` 新增记录里写下依据，汇报里再汇总一条「本轮决定 → 依据 → 回滚命令」。我不需要你问我，我需要我能复查你决定了什么。
- **只有两件事是物理上做不到的**，别把它们当决策遗留：`npm stage approve`（要你的 2FA）与 Apple 公证（要付费账号）。碰上时先把其余一切做完，再把确切补救命令写进汇报最上方（含 stage-id、包名、版本）。除此之外，汇报里不许出现"需要你决定/需要你确认"。
- **范围纪律**：不得为了"清零"而擅自扩大产品面（新增对外 `gp_*` 工具、改发布平台矩阵、改产品定位）。那是范围变更而不是遗留项；按最小正确修法收口，需要扩面也照此自己决定并留痕。**但这条不是"可以不修"的出口**：它限制的是产品形状，不是缺陷处置——已发现的问题仍要本轮修完，只是修的时候别顺手加没人要的新能力。
- **诚实性优先于零遗留**：两者冲突时选诚实——测不出就写"未观测"。但"如实标注"不是不做完的理由：能在本机做的（含真机项：面板走 AX `kAXPressAction`、权限走 `glasspaned --permissions`、状态复现走隔离 `GLASSPANE_STATE_DIR`）必须做完。

【收口清理：每轮必做的最后一步（属收口硬条件，不是收尾礼貌）】

发完版不等于结束。截至 2026-10-11 本仓积下 **18 个 worktree、41 条本地分支、7 条远端分支**，其中 `daily/main-*`、`gp-harness-*`、`fix/*`、`backup/*`、`split/*` 大多是历轮任务"做完就走"留下的——这正是你要消灭的形态。收口前按这个顺序清：

1. **列清单**：`git fetch origin --prune` → `git worktree list` → `git for-each-ref --format="%(refname:short)" refs/heads`（本地）→ `git branch -r`（远端）。逐条分类：本轮我建的 / 往轮我这条线建的 / 别的线（harness、canonical、并行会话）建的 / 发布锚点。
2. **判定去向用内容，不用分支名**：`git cherry main <b>` 对 **squash 合并**的分支会误报成"未落地"（`release/1.6.0`、`release/1.6.0-pr` 就是这样，内容其实经 cherry-pick 进了 main），所以证实/证伪要用 `git diff main <b> -- <路径>` 或 `git log --oneline main..<b>` 看具体提交；`split/*` 是 subtree 搬运产物，其内容由 tag 与 split 仓承载，不参与这个判定。
3. **删除规则**：证实在 main 里的分支 → `git branch -d <b>`（**只用 `-d`**；需要 `-D` 就说明判据不成立，回去做第 2 步），远端同名用 `git push origin --delete <b>`；本轮自己建的 worktree → 先确认里面没有未提交内容（`git -C <wt> status --porcelain` 为空），再 `git worktree remove <wt>`，最后 `git worktree prune`。**内容未落地的分支不许"留着"**：那是本线该收的活——本轮并回 main、跑齐闸、把缺陷修完再删；若它已被 main 的更新版本取代，就用第 2 步的字节比对证明"取代"，然后删。唯一的例外是**别人正在飞的未提交批次**：不替别人提交、不 checkout/reset/stash，保持原状并在汇报里点名，给出它与本轮改动是否重叠的判断；但那一批里若含你已经发现的缺陷，缺陷本身仍要本轮修掉（在所属那层的代码里修完并证明），"等它的会话"不是不修的理由。
4. **快照分支（`backup/*`、`safety/*`）是有条件的例外**：它们是某批未提交工作的唯一回滚点。只在该批已收口、且本轮不再需要回滚点时才删；删前把 `git log -1 --format=%s <b>` 与内容比对结果写进汇报，别顺手清掉别人的保险。
5. **临时件**：`/var/tmp/glasspane-main-check/` 快照、往轮临时前缀与归档、`engine/.build` 之外的本轮产物、`.worktrees/` 下已 remove 的目录残留，一并清掉。`npm cache`/`node_modules` 只在空间不足时清（那是环境不是遗留）。
6. **台账侧的遗留同样算遗留**：`CHANGELOG.md` 的 `[Unreleased]` 归入本版；本轮记录已进 `specs/`（只新增，不改历史结论）；`gh pr list --repo jingzhao-l/GlassPane --state open` 为空或每条都给出去向；GitHub 上没有悬挂的 draft Release；npm 没有待批的 staged publish（有就按物理边界处理并写明）；CI 最新一条为 success。
7. **不许删的**：任何 tag（发布锚点，`install.sh` 与 updater 钉的就是它）、别人的活跃分支、内容未证实落地的分支、以及为"数量好看"而删掉的任何历史。
8. **收口快照进汇报**：清理后的 `git worktree list` 行数、`git branch -a` 条数，以及一张「删了什么 / 留下什么 / 各自去向与判据」的表。



【审查范围】

- 只审查主仓产品面：`engine/`（Swift：`Sources/GlassPaneEngine`、`Sources/glasspaned`、`Sources/glasspane-settings`、`probe/`、`scripts/make-app.sh`、`.signal_smoke.py`、`smoke.md`）、`mcp-shell/`（TypeScript MCP 壳）、`installer/`（`glasspane-install`）、`updater/`（自动更新引擎）、`bridge/`（Python LLDB 桥）、`scripts/`、`.github/workflows/`、`install.sh`、根 `package.json` 与各 workspace 的 `package.json`/lockfile、`CHANGELOG.md`、`README.md`/`README.zh-CN.md`/`SECURITY.md`/`SECURITY.zh-CN.md`/`CONTRIBUTING.md`/`CONTRIBUTING.zh-CN.md`、`ITERATE.md`、`iterate.config.yaml`。
- 明确忽略 `harness/` 整个目录（`harness/glasspane-harness` fork 本体 + `harness/tools` 六把尺子 + `harness/contracts` 金样 + `harness/upstream.json`）。它有独立的每日任务与独立发布通道，不审查、不修改、不发版，不得把 `harness/*` 纳入任何改动与发布包。
- `kernel/` 与本仓 `kernel/schemas/**` 是跨语言契约真源的**镜像**，canonical 编辑入口在 `/Volumes/Eng-Dev/iterate-skill/kernel`。本轮若判定"必须改契约才能修掉缺陷"，你有权限自己决定并做完：在 canonical 侧改、跑它的门禁与发版，再经 `KERNEL_SRC=/Volumes/Eng-Dev/iterate-skill tools/sync-kernel.sh --target=repo` 回写本仓镜像，两侧同轮落地——**不许把它列成「待裁决」了事**。你也可以决定不动契约、在本层把缺陷修掉，那同样是修复；但**"缺陷存在、本轮不处理"不是选项**。除此之外不要单边手改 `kernel/schemas/**`（那是复制品，手改必被同步判红）。
- 禁区：`specs/**`（验收台账与决策记录，不得改写历史结论，只可新增本轮记录）、`LICENSE`、`.external/`。
- 风险区（可以改，但必须在汇报里单独点名并给出证据）：`engine/Sources/GlassPaneEngine/`（归因与证据语义）、`engine/Sources/glasspaned/main.swift`（信号与 socket 生命周期；sigwait + 早期 `pthread_sigmask` 的方案已被真机证伪过替代方案，别改回去）、`mcp-shell/src/tools.ts`（对外 MCP 工具契约，三处镜像：kernel schema / daemon `FrameCodec` / mcp-shell）、`.github/workflows/release.yml`（不可逆发布通道）、`scripts/version-sites.mjs`（版本线位点表）。

【开工前先确认工作树】

1. 整树 `git status --porcelain`（不要只看子目录），并记下开工 HEAD sha。
2. **先找上一轮没收口的活**：`git fetch origin --prune` 后列出没并进 main 的本线分支（`git branch -r --list "origin/daily/main-*"`、`git worktree list`），逐条判定「已落地 / 被后续提交取代 / 真没落地」——判据是内容而不是分支名或提交信息（`git cherry` 或逐文件比对）。真没落地的，本轮就把它并回 main 跑齐闸后一起收口；决定不并也要写下理由。**"上一轮的遗留"不是本轮的输入，是本轮的待办。**
3. **环境余量先查**：`df -k /Volumes/Eng-Dev`（或 `/`）看可用空间。本任务的构建（Swift `.build`、`npm ci`、`node --test`、临时归档）会吃盘，而 2026-10-10/10-11 那两轮就是被 ENOSPC 半路杀掉的（任务记录只留 `session-failed`，不说为什么）。可用空间低于 ~4 GiB 就先清可再生物：`engine/.build`、`*/node_modules` + 重装、`npm cache`（必要时 `sudo npm cache clean --force`）、`/var/tmp` 下往轮归档与临时前缀。清完仍不够就**如实按"环境不足"终止**并在汇报最上方给出确切数字与补救命令——那是物理边界，不是遗留项；但别硬跑到会话被杀，留一堆未提交改动给别人。
4. 主仓常被并行会话以 dirty 状态占用，可能存在**别人未提交的批次**。这时：不要混提、不要 `git add -A`、绝不 `git checkout --`/`reset`/`stash` 别人的文件。改用隔离工作树做本轮改动与提交（`git worktree add`，基于 main 的 HEAD）。那不是本轮该清的遗留项（那是别人正在做的工作），但你必须在汇报里点名它、并给出判断：它是否和本轮改动重叠、会不会让本轮收口变成半真半假。
5. 对每个要改的文件先复制到 scratch 目录（如 `/var/tmp/glasspane-main-check/`）留快照——这是唯一回滚点。

【执行流程】

1. **全面代码实现审查**：调用 `review-bugbot` skill 对审查范围内全部代码做正确性、边界条件、异常处理、规范一致性、潜在缺陷审查；再调用 `review-security` skill 过一遍本产品的信任边界（unix socket `~/.glasspane/engine.sock` `chmod 0600` 且**无 peer 鉴权**＝同用户即全权、TCC 四张权限席位、证据落盘内容不得泄露屏幕文本、结构化错误里的 remedy 必须 agent 可执行）。列出全部问题并完整修复；每个修复配可复现测试（Swift 用 Swift Testing/XCTest，TS 用 `node --test` 且不引第三方测试框架，Python 用 pytest），覆盖正常、异常与边界路径。测试夹具的形状必须来自真报文/真进程（真 daemon 响应、真 `npm pack` 产物、真 socket 帧），不许用桩里编出来的形状。
2. **用户体验审查 + 功能缺口分析**：审 CLI（`glasspaned` 的开关与退出码、`--permissions` 自报）、SwiftUI 设置面板（折叠/展开、按钮禁用理由是否给人下一步动作）、`install.sh` 与 `npx glasspane-install` 的引导与报错文案、全部 `gp_*` 工具的返回形状（**数目不写死**：以 `kernel/schemas`、daemon `hello.capabilities` 与 `mcp-shell/src/tools.ts` 三处实测为准，三者不一致本身就是缺陷）、更新器的 `needs-consent` 三道门是否各自给得出动作。特别检查一类缺陷：**GUI 上有控件而 daemon 没有对应能力**（按钮按下去无事发生）——发现即 P0。分析功能增加需求，确定后完整实现（含新增测试），并同步 `CHANGELOG.md` 与 README 双语两侧。
3. **重新自查 + 门禁全绿**：迭代完成后重新通读改动，修遗留问题，然后逐条跑门禁。**命令必须逐字精确匹配**（加参数、换目录、串 `&&` 都会得到一条假的绿）：
   - `npm ci`（仓库根）
   - `npm run build`
   - `npm test --workspaces --if-present`
   - `node scripts/check-version.mjs`
   - `node scripts/check-doc-links.mjs`
   - `node scripts/check-workflows.mjs --self-test` 然后 `node scripts/check-workflows.mjs`
   - `swift build --package-path engine`
   - `swift test --package-path engine`
   - `swift test --package-path engine/probe`
   - `python3 -m pytest -q bridge`
   - `sh -n install.sh`
   - 信号闸：`cd engine && python3 .signal_smoke.py .build/debug/glasspaned`（需先 `swift build --package-path engine`）
   - 发布形态闸（等价 CI 的 publish-shape）：`cd mcp-shell && npm run bundle && npm pack --dry-run`
   规则：**先记录基线计数再改代码**（`swift test` 的通过/失败/跳过数、pytest 计数、各闸的输出摘要），跑完对着计数判定；`swift test` 有按设计跳过的 opt-in 真机项，不许为了让它变绿而删断言或补模拟数据。完整读取构建/测试日志，**禁止 `tail`/`head` 截断后再下结论**；grep 判据必须同时覆盖 Swift Testing 与 XCTest 两种行格式。包装脚本的退出码不可信，绿要落到具体用例名。因机器负载造成的计时假红→隔离复跑再提交，不改判据、不加超时。**只跑一次闸就宣布通过不算做完**。
   - `node harness/tools/tool-surface.mjs --check`（CI 的 harness-rulers lane 每跑都读它）：若它因本次 `mcp-shell/src` 或 `engine` 的**有意功能增长**而转红，允许的唯一 harness 动作是 `node harness/tools/tool-surface.mjs --record` 重记基线，并单独一条提交 `chore(harness): 面 A 基线补记 <哪次改动那 N 行>`，正文说清长了多少行为什么。除此之外 `harness/` 一律不动。若转红的是 `surface-semantics`（工具面开始自行判定证据语义），**不许 `--record` 掩盖**——那是架构问题，把判定挪回 Swift。
4. **发版**（仅主仓产品面；`harness/` 不发版）：
   a. **版本判断**：真源 = 根 `package.json` 的 `version`。判据沿用 `CHANGELOG.md` 的 1.6.2 条目里本仓自己写下那一条：patch 要求「状态文件的字段没动、退出码集合没动、CLI 参数没动、npm 包的 `bin` 声明没动」；动了其中任一项（含新增用户可见控制件）＝minor。开工先跑 `node scripts/check-version.mjs` 看版本线是否已漂移，并用 `git tag --sort=-v:refname | head -5` 与 `npm view glasspane-mcp version`、`npm view glasspane-install version` **实测**当前状态（tag、npm、仓库版本线三者不一致是常态，别信任何文档里的数字，包括这条）。
   b. `node scripts/set-version.mjs <X.Y.Z>` —— 改版本的唯一入口（10 个位点：根/mcp-shell/installer/updater/kernel 的 `package.json`、`mcp-shell/src/dispatch.ts` 的 `SERVER_INFO`、`engine/Sources/GlassPaneEngine/EngineCore.swift` 的 daemon hello、`engine/scripts/make-app.sh` 的 `CFBundleShortVersionString`、`install.sh` 与 `installer/cli.js` 钉的发布 tag，外加三个 lockfile）。禁止手改单个 `package.json`（会让派生位点漂移、`version-line` 直接红）。改完 `node scripts/check-version.mjs <X.Y.Z>` 必须绿。
   c. `CHANGELOG.md`：把 `[Unreleased]` 的内容归入新版本条目（旧条目只新增不删），写清版本判断依据、本版是否合并了未发布版本、每条修复的失效模式与证据。
   d. 本地验证：第 3 步全部命令复跑一遍全绿；再 `npm ci` 干净复跑一次。
   e. 提交并推送 `origin main`：Conventional Commits 前缀 + 中文正文（`feat:` / `fix:` / `refactor:` / `test:` / `docs:` / `chore:` / `release:`），一次提交一项逻辑变更；含中文与括号的正文一律用 `git commit -F <文件>`，别用 `-m` 内联。
   f. 打 tag 并推送：`git tag v<X.Y.Z>` + `git push origin v<X.Y.Z>`。这会**自动**触发 release.yml 的 `github-release` job：`npm ci && npm run build && npm run bundle` → 确定性归档 `GlassPane-<X.Y.Z>.tar.gz`（= 被 tag 的树**减去 `harness/`**，加上 `mcp-shell/dist`、`mcp-shell/schemas` 两份构建产物）→ `SHA256SUMS-<X.Y.Z>.txt` → 两者的 `.asc` GPG 签名（签名是**必须成功的一步**，`release` 环境读不到 `GPG_PRIVATE_KEY` 就整版不发）→ 建/更新 Release 并 `--draft=false --latest`、target 显式钉在被 checkout 的 commit 上。逐 job 确认真绿：`gh run list --repo jingzhao-l/GlassPane --workflow Release` + `gh run view <id> --log`。签名类失败按 CI 里那条 remedy 修（`gh secret set GPG_PRIVATE_KEY --env release`），**绝不通过删签名步骤或放宽判据让它变绿**。
   g. 复核发布物：`gh release view v<X.Y.Z> --json isDraft,targetCommitish,assets`（draft=false、target==本轮 commit）；归档自证用 `node scripts/make-release-archive.mjs --verify <archive> <X.Y.Z>` 而不是 `tar -tzf | grep -q`（`grep -q` 首个命中就退出，tar 死于 SIGPIPE，`pipefail` 会把一条通过的检查判成失败——本仓真栽过）。确认归档确实不含 harness：`tar -tzf <archive> | grep -c '^harness/'` 应为 0（数数用 `grep -c`，不要用 `grep -q`）。
   h. npm 发布（**与 tag 是两条独立动作**）：先 `gh workflow run release.yml --repo jingzhao-l/GlassPane --ref v<X.Y.Z> -f mode=dry` 验打包形态，再 `--ref v<X.Y.Z> -f mode=publish` 发两个裸名包（`glasspane-mcp`、`glasspane-install`，带 provenance；trusted publisher 直发已实测可成，被 staged-only 拒时 `npm stage approve <stage-id>` 是需要 owner 2FA 的人工动作，列进汇报别硬闯）。**`--ref` 必须显式写成被发的那个 tag**：`npm-publish` job 的 `actions/checkout` 取的是 dispatch 的 ref，不传就落到默认分支 HEAD——那样 registry 上的字节与被 tag 的树不对应，`check-version` 还会拿 main 的版本线去自证。顺序固定为：push → tag → `--ref v<X.Y.Z>` dry → 看绿 → `--ref v<X.Y.Z>` publish。
   i. **tag ≠ npm**：job 绿了不算发完，必须回查 registry：`npm view glasspane-mcp version`、`npm view glasspane-install version` 都要等于新版本；registry 在 publish 刚过的几分钟里可能返回读副本的旧值，所以按版本号点名再带 `--prefer-online`：`npm view glasspane-mcp@<X.Y.Z> version --prefer-online`、`npm view glasspane-install@<X.Y.Z> version --prefer-online`；`npm view glasspane-mcp versions --json | tail` 复算一次。
   j. 端到端实测（能本机做的就做完）：把发布归档解到临时目录 → 在树内 `npm pack` → 装进干净前缀 → 用 stdin 打一条 MCP `initialize` 断言回包含 `glasspane-mcp`；daemon 冒烟写 `engine/.build/debug/glasspaned --state-dir <临时根> --permissions`。**不要写 `GLASSPANE_STATE_DIR=<临时目录> glasspaned --permissions`**：2026-10-06 实测 daemon 不读那个环境变量，它照旧落到 home 默认根 `/Users/<you>/.glasspane` 并打一句"state is read and written under the home default"的警告后继续跑——同一条命令换成 `--prune-evidence` 就是在真机上删真档案（本轮差点就这么干了，事后核对 `~/.glasspane/evidence` 582 条完好）。归档类检查一律带 `--state-dir`。另外归档内容的判定要用 `grep -cE "(^|/)harness/"`：tar 里所有条目都在单一顶层目录 `GlassPane-<ver>/` 下，锚在 `^harness/` 的检查一条不中、会**空过成绿**。**CI 承载不了真机验收**（无障碍、事件监听、屏幕录制需登录 GUI 会话与已勾权限，记录在 `engine/smoke.md`），但**这条任务就跑在有 GUI 会话的本机上**，所以真机项属于"你能做就做完"，不是"标给别人"：用 AX `kAXPressAction` 按 `gp-*` 标识点面板控件、用 `--state-dir <临时根>` 复现状态、跑 `glasspaned --permissions` 核对读数，做完把实测结果写进汇报与 `engine/smoke.md` 的本轮记录。只有当这台机器确实没有登录会话/权限没勾时才允许写"未观测"，且必须附一句"补上它需要哪一条人工动作 + 为什么本轮跑不了"。**不得把未验证写成已验证。**
5. 全程只要有文件更新，都必须及时提交并推送 GitHub，**且推的是 `main`**：临时分支、worktree 分支只能是你的工作台，不能是交付终点。收口时 `git status --porcelain` 为空、`git log origin/main -1` 就是本轮最后一笔。
6. 发版与验证都完成后，执行上面【收口清理】那一节的八步，把工作区与远端清干净——**这一步没做完，本轮就不算完**。

【不可让步的诚实性红线】

- 产品立身之本是证据诚实性：测不出来的必须写"未验证"，绝不能为了好看点亮指示器。任何改动若在这一点上让步，即使测试全绿也算失败。
- 面板只呈现 daemon 实测结果：不得代测、不得借用别的卡读数；开发者工具卡恒"未验证"是设计。
- 判定性逻辑留在 Swift：MCP 壳与 fork 不自行判定证据语义（小数阈值比较、pass/fail 合成、证据字段比较）。错误帧恒 `{code, message, remedy}` 三字段。
- 金样一律由 `--record` 生成，不手改；任何闸转红，先反向破坏证明它**能红**（具名用例/具名文件变红，不是"跑过了"），再决定是修代码还是重记基线。改错基准不等于撤销结论——要重算看符号。
- 修在跑不到的路径上等于没交付；只在负载下才红的计时断言是坏对照。文档主张必须能指到代码位置或已发生的实测；公证（Developer ID + notarytool）仍是 owner 未启用决策，不得写成已完成。

【环境约束】

- 每次执行任何终端命令前，必须先执行：`export PATH="/opt/homebrew/bin:/opt/miniconda3/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"`。禁止在未恢复 PATH 时直接调用 git、npm、node、swift、python3、pytest、gh 等命令；仍不可用就改用绝对路径（实测本机：`swift`=/usr/bin/swift、`node`=/usr/local/bin/node、`gh`=/opt/homebrew/bin/gh、`pytest`=/opt/miniconda3/bin/pytest）。禁止依赖 `source ~/.zshrc` 恢复环境。
- 本机会话的 zsh tmux 钩子会杀掉管道（症状是 `command not found: tmux` + exit 127，不是 PATH 问题）：多段命令改用 `/bin/bash -c '…'` 跑。写 heredoc 用引号形式（`<<'EOF'`），否则反引号会被执行。
- 推送涉及 `.github/workflows/**` 被 token scope 拒时，改用 SSH remote 形式（`git@github.com:jingzhao-l/GlassPane.git`）；需要 `--force-with-lease` 时必须写显式 SHA 形式，否则恒报 "stale info"。
- 授权见开头【无人值守：零遗留与全线发布授权】那一节，那一条覆盖本节。这里只留两条不是"决策"而是"别做错"的纪律：`--record` 只用于本轮自己的有意增长，不许拿来洗掉非本轮造成的红；要覆盖任何远端分支或丢弃提交之前，必须先证明被覆盖的内容已在别处落地（`git merge-base --is-ancestor` 或逐文件内容比对），并留一条记录说清覆盖了什么。
- `harness/` 的问题不在本轮范围内动手（它有 10:30 那条独立任务与独立发布通道，你改它会和那条线撞车）；把发现写进汇报，并**明确给出该不该由那条线修、判据是什么**——只列出发现不给结论，就是遗留项。

【最终汇报】

简明列出，按这个顺序：① **收口证据**——main 的收口 HEAD、`git status --porcelain` 为空、tag/Release（draft=false、target sha、归档是否含 harness）/registry 两个包的版本号实测值；② 版本判断依据与 `set-version` 前后位点核对；③ 每条门禁命令的**实际计数**（不是"全绿"两个字）；④ 改了哪些文件、对应哪条提交；⑤ 做过哪些反向验证（破坏哪一处、哪条具名用例变红）；⑥ **本轮我替你做了哪些决定**（含依据与回滚命令）——一项都没有通常意味着你把该决定的东西推给了别人；⑦ **未观测项**——只限物理边界那一类，每条写明"为什么本机做不了"与"补上它的确切一条命令"；**"未修项"这一格必须为空**，非空就是本轮没收口（发现 N 条就要有 N 条修复，数量要在汇报里对得上）；⑧ **清理盘点**——收口后的 `git worktree list` 行数与 `git branch -a` 条数，加一张「删了什么 / 留下什么 / 各自去向与判据」的表（留下的只有两类合法：别人正在飞的未提交批次，与物理边界；其余一律不许留）。不要贴大段日志。
