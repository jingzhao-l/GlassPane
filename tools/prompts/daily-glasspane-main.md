# 每日任务 · 项目 1：GlassPane 主仓（引擎 + MCP 壳 + 安装器 + 更新器）

> 用法：把下面「提示词正文」整段贴进一个全新会话。它是自足的——所有命令、判据、坑都写在里面，不依赖本轮对话上下文。

---

## 提示词正文

请对 `/Volumes/Eng-Dev/GlassPane` 项目（GlassPane 主仓库）执行每日例行「全面审查 + 修复 + 发版」任务。本任务在全新会话中无人值守执行，请自主完整完成，勿遗漏，勿在中途向我确认。

【审查范围】

- 只审查主仓产品面：`engine/`（Swift：`Sources/GlassPaneEngine`、`Sources/glasspaned`、`Sources/glasspane-settings`、`probe/`、`scripts/make-app.sh`、`.signal_smoke.py`、`smoke.md`）、`mcp-shell/`（TypeScript MCP 壳）、`installer/`（`glasspane-install`）、`updater/`（自动更新引擎）、`bridge/`（Python LLDB 桥）、`scripts/`、`.github/workflows/`、`install.sh`、根 `package.json` 与各 workspace 的 `package.json`/lockfile、`CHANGELOG.md`、`README.md`/`README.zh-CN.md`/`SECURITY.md`/`SECURITY.zh-CN.md`/`CONTRIBUTING.md`/`CONTRIBUTING.zh-CN.md`、`ITERATE.md`、`iterate.config.yaml`。
- 明确忽略 `harness/` 整个目录（`harness/glasspane-harness` fork 本体 + `harness/tools` 六把尺子 + `harness/contracts` 金样 + `harness/upstream.json`）。它有独立的每日任务与独立发布通道，不审查、不修改、不发版，不得把 `harness/*` 纳入任何改动与发布包。
- `kernel/` 只读：它的 canonical 编辑入口是 `/Volumes/Eng-Dev/iterate-skill/kernel`，本仓 `kernel/` 是镜像；`kernel/schemas/**` 是跨语言契约真源。本轮若得出"必须改 schema/kernel 才能修掉某个缺陷"的结论，不要动手，列进汇报的「待裁决」。唯一合法的镜像更新路径是 `KERNEL_SRC=/Volumes/Eng-Dev/iterate-skill tools/sync-kernel.sh --target=repo`，且只在 canonical 已前进时跑。
- 禁区：`specs/**`（验收台账与决策记录，不得改写历史结论，只可新增本轮记录）、`LICENSE`、`.external/`。
- 风险区（可以改，但必须在汇报里单独点名并给出证据）：`engine/Sources/GlassPaneEngine/`（归因与证据语义）、`engine/Sources/glasspaned/main.swift`（信号与 socket 生命周期；sigwait + 早期 `pthread_sigmask` 的方案已被真机证伪过替代方案，别改回去）、`mcp-shell/src/tools.ts`（对外 MCP 工具契约，三处镜像：kernel schema / daemon `FrameCodec` / mcp-shell）、`.github/workflows/release.yml`（不可逆发布通道）、`scripts/version-sites.mjs`（版本线位点表）。

【开工前先确认工作树】

1. 整树 `git status --porcelain`（不要只看子目录），并记下开工 HEAD sha。
2. 主仓常被并行会话以 dirty 状态占用，可能存在**别人未提交的批次**。这时：不要混提、不要 `git add -A`、绝不 `git checkout --`/`reset`/`stash` 别人的文件。改用隔离工作树做本轮改动与提交（`git worktree add`，基于 main 的 HEAD），未提交批次留给它的会话，只在汇报里点名它存在。
3. 对每个要改的文件先复制到 scratch 目录（如 `/var/tmp/glasspane-main-check/`）留快照——这是唯一回滚点。

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
   j. 端到端实测（能本机做的就做完）：把发布归档解到临时目录 → 在树内 `npm pack` → 装进干净前缀 → 用 stdin 打一条 MCP `initialize` 断言回包含 `glasspane-mcp`；`GLASSPANE_STATE_DIR=<临时目录> engine/.build/debug/glasspaned --permissions` 冒烟。**CI 承载不了真机验收**（无障碍、事件监听、屏幕录制需登录 GUI 会话与已勾权限，记录在 `engine/smoke.md`），这类结论只能标「待真机复跑」，不得标「已验证」。面板验证别用 cliclick（点不动裸可执行文件），走 AX `kAXPressAction` 按 `gp-*` 标识。
5. 全程只要有文件更新，都必须及时提交并推送 GitHub；收口时整树 `git status --porcelain` 应为空。

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
- 已授权（本任务内不必再问）：提交、推送 `origin main`、打 tag、触发与观察 release.yml、npm 发布、改动上述产品面文件与测试。仍需我点头、不得自动做：合并到其他分支、强推覆盖别人的提交、删除 Release/包/tag、改 GitHub secrets 与仓库设置、启用公证流程、动 `harness/` 与 `kernel/` 的内容或版本、`--record` 洗掉非本轮造成的红。
- 若审查中发现 `harness/` 或 `kernel/` 相关问题，仅在最终汇报中列出而不改动。

【最终汇报】

简明列出：开工/收口 HEAD 与是否用了隔离工作树；版本判断依据与 `set-version` 前后位点核对结果；每条门禁命令的**实际计数**（不是"全绿"两个字）；改了哪些文件、对应哪条提交；发布物实测值（tag、Release 是否 draft=false 与 target sha、归档是否含 harness、registry 两个包的版本号）；做过哪些反向验证（破坏哪一处、哪条具名用例变红）；未修清单（待真机复跑 / 待我裁决 / harness 与 kernel 侧问题）。不要贴大段日志。
