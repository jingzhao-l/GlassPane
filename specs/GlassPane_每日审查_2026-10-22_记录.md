# GlassPane 主仓 · 每日审查记录 2026-10-22

本轮为无人值守每日任务（`tools/prompts/daily-glasspane-main.md`）。开工 HEAD `1c2a495b`（本地 main 落后 origin 4 笔，
`git merge --ff-only origin/main` 追平后基线为 `8e4dd6a1`），整树 `git status --porcelain` 开工时为空。
收口版本 `1.20.0`。工作树就在主仓本树（本轮全程无人占树）；快照：`/var/tmp/gp-daily-20261022/snapshot/`
（`worktree-now.tgz` = 改动落盘前的全仓 tracked 文件，`head-8e4dd6a1.tar.gz` = 基线 commit 的产品面原件）。
盘余量开工实测 `df -k /Volumes/Eng-Dev` = 12 600 180 × 1024 B ≈ 12.0 GiB 可用，高于 4 GiB 底线，未清理任何可再生物。

## 1. 上一轮没收口的活（判据只用文件字节）

`git fetch origin --prune` 后盘本线分支：远端只剩 `origin/main`、`origin/gp-sc5-rebased`、`origin/gp-harness-sc5-fork-20261020`、
一条 dependabot；本地多一枚 `gp-sc5-rebased` 与它的 worktree，以及 `split/glasspane-harness` 搬运分支。

| 那一条 | 判定 | 判据 |
|---|---|---|
| `origin/gp-sc5-rebased` | 已被 main 包含，无独有内容 | `git rev-list --left-right --count origin/main...origin/gp-sc5-rebased` = `1 0`（分支侧 0 笔独有）；`git log origin/main..origin/gp-sc5-rebased` 空 |
| 本地 `gp-sc5-rebased` + worktree `/Volumes/Eng-Dev/.worktrees/gp-sc5-rebased` | 同上，工作树内只有未跟踪的 `.external`（参照克隆，禁区） | `git rev-list --left-right --count origin/main...gp-sc5-rebased` = `0 0`（与 main 同一枚 commit） |
| `origin/gp-harness-sc5-fork-20261020`（3 笔） | **全部已落地或被取代**，且它属 harness 线（`gp-harness-*`），不由本线删 | 逐文件 sha1：`registry-readiness.ts` `843477cd…` 两侧同值、fork 侧 `providers.ts` `df79123d…` 两侧同值；壳侧 `providers.ts` 分支那份 `1fef0418…` 与 main 的 `48d5381c…` 不同，而 main 那份是 10-21 并入后经同日面 A 追加的较新版本，分支侧无独有文件（`git diff --diff-filter=A main origin/gp-harness-sc5-fork-20261020` 空） |
| 本地 `split/glasspane-harness` | subtree 搬运产物，不参与"是否落地"判定 | 提示词第 2 步口径；其内容由 split 仓与 harness tag 承载 |

`origin/main` 那 4 笔（`b5bf9dc2`、`f0f0ce6b`、`7b87b70a`、`8e4dd6a1`）全是 `harness/**`，是 harness 线 0.10.0 的发布；
本轮不改 `harness/` 的内容或版本，只把它作为基线追平。

## 2. main 上那格红的来历（不是本轮缺陷，判据是实测）

`8e4dd6a1` 推上去时 CI 的 `harness rulers` lane 判红，红的步骤是
`node harness/tools/release-artifact.mjs --check`。本机复跑同一把尺子（它会 `git ls-remote` split 仓现读）读数为
`2 agreement(s) held, 0 tolerated lag(s), 0 problem(s)`，`gh run rerun --failed` 复通后该 lane 结论 `success`。
判据：**红是发布顺序造成的，不是内容造成的**——那条 lane 跑的时候 harness 线的 split 搬运还没落到 split 仓的
`refs/heads/main`，尺子量的是远端实时状态，事后就自洽了。旧 sha 事后转不了绿这一条从前记过（`v1.17.0`），
这次能转恰恰因为它是实时读远端的，所以本轮不放宽任何判据、不动 `harness/`。

## 3. 审查面与本轮发现

审查面七条泳道（`bugbot`/`security-review` 这两个 subagent 类型在本机不存在——`Agent` 只认
`Explore`/`Plan`/`general-purpose`，所以按 `review-bugbot`/`review-security` 两套 skill 的原简报改用
`general-purpose` 派发，简报逐字保留）：mcp-shell 传输层、mcp-shell 工具面/网关/注册表、Swift 引擎核心、
发布与门禁层、信任边界安全、bridge/probe/文档、以及主代理自查（`tools/`、版本线、三处方法表）。
每条回代码复核后才动手；复核后不成立的写在下面「复核判为不是缺陷」一节，不占修复名额。

本轮共 **76 条发现、76 条修复**。其中 73–76 这四条不在任何泳道简报里，是**门禁复跑尾段自己撞出来的**：
跑闸跑到红的那一处就是缺陷现场，而四处红全部是"对照自己红"（不是被测代码错）——这类红最"合理"的
处置是改断言换绿，所以四条各自都另打了一次变异，证明判据在修后的形状上仍然能红。

（发现与修复的逐条表在 `CHANGELOG.md` 的 `[1.20.0]` 条目里——那才是给人读的那一份。）

## 4. 复核判为不是缺陷的几条（附判据）

| 那条发现 | 判据 |
|---|---|
| `evidence-report.ts` 的 `diagnostics` 兜底在产物里没人调用（4 个调用点全传 `undefined`） | `specs/GlassPane_P1_实施规格_v1.3_evidence审查UX.md:266`「设计缺口补述 2」原文就写着**两个审计工具不携带 diagnostics（不手工撰写诊断），调用渲染器时传 nil**——"没有生产者"是规格，不是半修；删掉它才是改契约 |
| CI 只读 lane 的 action 没有按 SHA 钉死（只有 `environment: release` 那条钉了） | `.github/workflows/release.yml:62-68` 把这条范围决策连同**理由**写在文件里（读不道的 lane 手里没有 secret，可改写面在别处已被 `check-workflows.mjs` 的 unresolvable/未钉两条挡住）；它是一处留痕的取舍，不是一处漏 |
| `spike/` 与 `specs/` 随发布归档出去 | `CONTRIBUTING.md:36`/`.zh-CN.md:33` 明写 `spike/` = 可行性实验与实测留档、不入门禁，`specs/**` 是验收台账且被 `check-doc-links.mjs` 的链接图引用；把它们从归档里剔掉是产品形状变更，不是缺陷处置。本轮只处理了"开发者机器路径字面量"那一半（见 CHANGELOG） |
| `harness rulers` 那格红（见 §2） | 实测复跑 + `gh run rerun --failed` 复通，判据在 §2 |
| `bridge/**`、`engine/**` 的 `__pycache__` 会随发布物出去 | `.gitignore:6` 挡着，`git ls-files` 与 `git ls-tree -r HEAD` 两条都数到 0（本机实测，不是推断） |
| `updater/lib/ca-bundle.js` 也属"remedy 里插了未 quote 的路径"那一族 | 该文件把客户端可控路径插进 remedy 的站点为 0：`grep -n 'remedy:.*${' updater/lib/ca-bundle.js` 命中 0；`:196` 那句是占位示例，不是插值 |
| `hello` / `shutdown` 也该进 `acceptedParamKeys` 白名单 | 两个 handler 一个 `params` 键都不读，而握手帧、面板与 updater 可能带自己的东西；收紧属产品契约变更，不在本轮缺陷范围。这条判断由一条用例钉住"它们仍然不在表里"，所以将来有人动表会被抓住 |
| 面板上有控件而 daemon 没有对应命令（P0 那一形） | 三条泳道逐条核过：updater 子命令与 `--project-prune`/`--project-remove`/`--evidence-stats`/`--recipe-validate`/`--permissions`/`--approval-verify` 全是一次性 CLI 面，`ApprovalGate` 是只读台账且面板明写"没有人工审批入口"——本轮没找到这一形，不把它写成缺陷 |

## 5. 已知边界（物理边界，不是遗留）

- `npm stage approve`（要 owner 2FA）与 Apple 公证（要付费开发者账号）仍是只有人能做的动作；本轮 trusted-publisher
  直发若成功就不产生 stage 件，公证按 owner 未启用决策如实写着。
- `/Volumes/Eng-Dev/iterate-skill/harness/iterate-harness/src/iterate_harness/mcp/client.py` 的
  `"\n".join(parts)` 抹掉 MCP 回包 item 边界那一条，属 iterate-skill 那条线（修在消费端），且本机已有该线自己在飞的
  worktree（`.worktrees/it-sc1-async`、`.worktrees/it-host` 里都有 `tests/test_mcp/test_call_tool_parts.py`）；
  判据与从前相同：`content[0]` 逐字节还是 daemon 那份回包，坏的是自己 join 的客户端。本仓产品面本轮实测**没有**
  销毁 item 边界的代码（`dispatch.ts` 原样转发 `outcome.content`，`stdio-session.ts` 用 `canonicalJson` 序列化整个对象）。

## 6. 本轮我替你做的决定（依据与回滚）

汇报里同名那一节是给人的这一份；这里留**可执行的回滚**，按 SHA 落地（`git log --oneline` 从旧到新）：

| 决定 | 依据（写在哪儿） | 回滚 |
|---|---|---|
| 取号 **1.20.0**（minor，不是 patch） | 四条判据的实测读数记在 `CHANGELOG.md` 的本版条目开头；15 处位点由 `scripts/version-sites.mjs` 统一 | `git revert -n c98fce5e` 后 `node scripts/set-version.mjs 1.19.0`，再按本版条目里的"发布链"那节把 tag/Release/npm 三格如实标注为"号已占用但撤回"（npm 已发布版本不可撤回，只能发更高号——既有纪律） |
| 把并行那条线的 `[Unreleased]` 整段收进本版（原文照录） | `CHANGELOG.md` 本版条目末尾那一格标着"原文照录，判据不改写" | 该段文本删回 `## [Unreleased]` 标题即可，代码一笔不动 |
| `mcp-shell/src/errors.ts` 的合并冲突标记按"两侧都留"解决，随后补 `http-gateway.ts` 的 import | `315b9dc1` 正文（含我误读 `grep -c` 的那处自审） | `git revert 315b9dc1` 会把标记放回——**不要这样回滚**；正确的退路是把那两个码各自删掉并同步其消费方 |
| 新增错误码 `GP_E_STATE_ROOT_REFUSED` 与它的 HTTP 503 归宿 | `066c2477`/`315b9dc1`；分区判据在 `mcp-shell/test/http-gateway.test.mjs` 的 `SHELL_REQUEST_REFUSAL_CODES` 那条 | `git revert 066c2477`（该码不进 request-refusal 名单，是有正面测试支撑的判断） |
| 面板 exec 门加 root-owned 系统工具豁免 | `9402f52a` 正文与 `gp-daemon-refused-binary` 那条 AX 标识 | `git revert 9402f52a` 会同时撤掉那条徽标；豁免本身只放宽"root 所有的 /usr/bin 工具"一格 |
| `LSMinimumSystemVersion` 抬到 14.0 而 `Package.swift` 编译下限不动 | `54` 号那一行 + `engine/scripts/make-app.sh` 的 `MACOS_MIN_VERSION` 注释 | `git revert` 相应笔并把 `MACOS_MIN_VERSION` 改回 `13.0`；两者是同一处声明的两半，回滚要一起 |
| `CFBundleVersion` 进位点表（第 15 处） | `54` 号那一行、`fdcbbfac`；夹具两行的教训写在 `scripts/version-sites.mjs` 注释里 | 从 `SITES` 删那一位 + `updater/test/scripts-version-sites.test.mjs` 的条数改回 14 |
| `--record` 重记面 A（10826 → 11422，+596） | `b88bf97e` 正文逐文件归因；`node harness/tools/tool-surface.mjs --check` 现为绿 | `git checkout b88bf97e^ -- harness/contracts/tool-surface.json`（金样是纯记录，回滚它不会让代码变错，只会让闸重新红） |
| `iterate.config.yaml` 撤下 `package.json` 指纹 | `c98fce5e` 的 diff（`fingerprints:` 那三行 → `[]` 加理由注释）；理由是"每发一版按设计被重写的清单不是漂移检查对象" | 把 `fingerprints: []` 改回那一条目并重新采集 sha（`iterate refresh`） |
| README 安装命令改两步式，而不是给安装器加"管道失败也报错"的探测 | `8f881f7a`（5 处 6 行与 `pipedInstallCommands()` 同批）；形状禁令由 `scripts/check-doc-links.mjs` 守着 | 还原 5 处 6 行；那条形状闸会立刻把管道写法判红（这是有意的） |
| 本轮不新增对外 `gp_*` 工具、不加功能（范围纪律） | 面 A 棘轮与 `product-surface` 的读数即为此 | 无需回滚 |
| CI 新增 `macos-node-gate`（darwin 断言终于有人在 mac 上跑） | `8f881f7a`；`node scripts/check-workflows.mjs --jobs` 现报 10 个 job | `git revert 8f881f7a` 同时撤掉两条 job 计数判据；推这一笔必须走 SSH remote（token 无 `workflow` scope） |
| 尾段四条"对照自己红"的修法：改判据的读法，不放松判据 | `1e974171`/`ddad39e8`/`a598534e`/`080e69f3`，每条正文都附了一次真红 + 一次变异 | 逐笔 `git revert`；注意 74 号里"位点表条数"若回到 14 会与 `CFBundleVersion` 那一位冲突 |

## 7. 收口读数（2026-10-22 那一轮，跑到 10-23 傍晚的尾巴）

### 7.1 尾段又是两条"对照自己红"

- `engine/.p4i4_smoke.py` 把"这一趟没等到面板的 AX 树"打印成"面板改版，锚点需同步"并退 1。
  修 + 两个出口各自实测可执行：`d10b8a90`。
- 本轮自己写的 `DailyRound20261022VerdictTests.testTheSummaryConstantIsTheSameNumberOnAllThreeSides`
  读的是 `kernel/dist/decision-log-entry.js`——**本机在、git 不在、干净检出不在**，于是本机 `swift test`
  恒绿而 CI 的 `engine (Swift)` 恒红。自证三条：`git ls-files kernel/dist` 数出 0；本机那份是 924 字节、
  日期 2026-10-14（10-18 内核代码镜像退场后留下的旧副本）；本会话那个干净检出的 `kernel/` 下只有
  `README.md`、`fixtures`、`schemas`。这一条"量到了"比"量不到"更坏：本机那份副本与装好的包不同号也照样
  读出 2048。修落在并发会话那一笔 `a8ec2488`（把这条臂搬到 `mcp-shell/test/kernel-validator-bound.test.mjs`，
  读 `node_modules/iterate-kernel/dist/…`，CI 每格跑前都 `npm ci`），已进 main，`engine (Swift)` 随后转绿。
  本会话不重复改同一处——两个人各修一遍同一个函数，main 上留下的是两套判据而不是一套。

### 7.2 门禁逐字复跑（都在 `d10b8a90` 的干净检出里跑，绕开并发会话的脏树；日志 `/var/tmp/gp-daily-20261022/gates-isolated/`）

| 命令 | 读数 |
|---|---|
| `npm run build` | rc 0（`tsc -p tsconfig.json`） |
| `npm test --workspaces --if-present` | mcp-shell **616/616**、installer **206/206**、updater **618/618**；0 红、0 跳 |
| `node scripts/check-version.mjs` | OK：版本线一致（1.20.0），15 处位点 + 两个 lockfile |
| `node scripts/check-doc-links.mjs` | 文档 32 份 / 仓内链接 238 / 外链 30（不请求）/ 表格 413 张（扫 116 份 markdown），OK |
| `node scripts/check-workflows.mjs --self-test` → 无参 | 两次 rc 0；`--jobs` 报 10 个 job |
| `sh -n install.sh` | rc 0 |
| `cd mcp-shell && npm run bundle && npm pack --dry-run` | rc 0：`dist/index.js` 246.3kB、`dist/http-gateway.js` 207.5kB、`schemas/` 8 份（`bundle-kernel-schemas` 从 `iterate-kernel@0.1.9` 取） |
| `node harness/tools/tool-surface.mjs --check` | no growth past the recorded baseline（面 A 11422 / 分母 29584，`b88bf97e` 补记后的形状） |
| surface-semantics / product-surface / release-artifact / fork-diff / brand-surface / check-kernel-corpus | 0 命中 23 文件 / 6505 agreements 0 problems / 1 ✓ 1 △ 0 ✗ / 4640 与 6730 中 4640 逐字节相同 / 血缘 9607 处 3315 文件 / 26 份语料与 pin 同号（`iterate-kernel@0.1.9`） |
| `swift test --package-path engine`（主树，**树上压着并发会话未提交的 VerdictTests 改动**，所以这一条不能当 main 的读数） | 1361 XCTest + 33 Swift Testing，3 skip，**0 失败**；`node scripts/assert-test-count.mjs swift 1 <log>` ✓ 两种 runner 都出了声 |
| `swift test --package-path engine/probe`、`python3 .signal_smoke.py` | **本会话未复跑**，如实记：probe 包要编 `swift-syntax`，跑它时盘余量掉到 3.4 GiB（低于本轮自己那条 ~4 GiB 地板），我把构建中断了。补它的两条命令：`swift test --package-path engine/probe`（CI 同名步骤已过：10-22 电池里 `09_probe_test.log` 绿）与 `cd engine && python3 .signal_smoke.py .build/debug/glasspaned`（同一电池 `SIGNAL SMOKE OK`）。两格的源码自电池以来未变——`git diff c98fce5e..HEAD -- engine/probe engine/Sources` 输出为空 |
| `python3 -m pytest -q bridge` | **126 passed, 1 skipped, 4 subtests passed**（73.56s） |

### 7.3 真机读数（本会话亲跑，命令照抄可复现）

- `./engine/.build/debug/glasspaned --state-dir <隔离根> --permissions` → 退 0，一帧 JSON：
  `accessibility=granted`、`inputMonitoring=granted`、`screenRecording=granted`、
  `developerTools=unverifiable`，`subject.binaryPath` 指向那枚未打包裸二进制且
  `hasBundleIdentity=false`。**那个隔离根里一个文件都没留下**——这条一次性 CLI 不建 socket，
  所以"它把状态根写脏了"这一族在本机是可排除的。
- `sh scripts/make-app.sh --settings-bin .build/debug/glasspane-settings --daemon-bin .build/debug/glasspaned --out <临时>`
  → 两份 bundle 的 `Info.plist` 实测都是 `CFBundleShortVersionString=1.20.0`、
  `CFBundleVersion=1.20.0`（第 15 处位点真的推得动）、`LSMinimumSystemVersion=14.0`；
  `plutil -lint` OK，ad-hoc 签名自查通过，`CFBundleExecutable` 分别是 `glasspane-settings` / `glasspaned`
  ——这正是 `DEFAULT_BUNDLES` 那条缺陷（49 号）要求的形状：面板名以打包脚本为真源。
- 面板 AX 走查（`p4i4_helper texts <pid>`，隔离根 + 真产物）：页脚点名的是
  `面板探的是 GLASSPANE_STATE_DIR 那个状态根下的 daemon.sock：…/root-b/daemon.sock；服务端自己报的根 …/root-b`，
  同屏 `glasspaned 1.20.0`、`授权主体：glasspaned（未打包（系统设置列表内只显示文件名））`；
  四卡徽标为三条「已授权」+ `developerTools`「未验证」（不假点亮）。
  对照档也在同一次里读到：只设 env 而那个根上没有 daemon 时，页脚写「状态根未上报」、Socket 回落到
  家目录默认根并明说"这一级是猜的"，连的是 launchd 那台 **1.6.2** 的在册 daemon。
  上一轮记着「那一眼仍未在真机读到」——读到了，全文在 `engine/smoke.md` 2026-10-23 那一节 §3。

### 7.4 发布链：本轮**没有** tag，这不是选择，是判据没过

实测（本会话写这一节时）：`git ls-remote --tags origin` 里没有 `v1.20.0`；`gh release list` 最新是
`v1.19.0`（2026-10-21）；`npm view glasspane-mcp version --prefer-online` 与 `glasspane-install` 均答
`1.19.0`；仓内版本线是 `1.20.0` 且 `check-version` 自证一致。CI 在 `dfd3250a` 上仍有 4 格红：
`macOS node suites`、`mcp-shell (TypeScript)`、`public docs`、`root workspace gate`（`engine (Swift)` 已绿）。
`node scripts/assert-tag-ready.mjs 1.20.0` 要的是**该 sha 的 CI 全绿**，前提不成立。

更决定性的那半：这四格对应的文件此刻在并发那条每日线（2026-10-23）手里，它 09:39Z 还在往 main 上提交
（`ed77cef6`、`a8ec2488`、`dfd3250a`），而它自己的记录写着"上一轮把 20 笔留在本地就断了……本轮把它推完、发完，
版本号不动，仍 1.20.0"。同一枚 tag 由两个会话各切一次、同两个裸名包各 `npm publish` 一次，后果是发布物与
tag 不是同一棵树、registry 上留下一个没人能解释是谁发的版本——对外且不可逆。所以本会话把 main 上的活干完
（`d10b8a90` 已在 main，`git rev-list --left-right --count` 为 0/0），**不抢这一刀**。

CI 十格齐绿之后，按序补的就是这一串：

```bash
node scripts/assert-tag-ready.mjs 1.20.0
git tag -s v1.20.0 -m "GlassPane 1.20.0" \
  && git push git@github.com:jingzhao-l/GlassPane.git v1.20.0
gh workflow run release.yml --ref v1.20.0 -f mode=dry      # 看它绿
gh workflow run release.yml --ref v1.20.0 -f mode=publish  # 真发
gh release view v1.20.0 --json isDraft,targetCommitish,assets
node scripts/make-release-archive.mjs --verify <归档路径> 1.20.0
tar -tzf <归档路径> | grep -cE "(^|/)harness/"            # 必须是 0
npm view glasspane-mcp version --prefer-online            # 期望 1.20.0
npm view glasspane-install version --prefer-online        # 期望 1.20.0
```

### 7.5 环境读数与本会话产物的回收

- `/Volumes/Eng-Dev` 盘余量：开工 9.9 GiB → 本会话两个隔离 worktree + 一次 probe 构建后 **3.4 GiB**
  （低于本轮自己那条 ~4 GiB 地板，probe 复跑因此被中断，见 §7.2）→ 回收本会话产物后 3.8–4.1 GiB。
  这条不是装饰：它决定了一个门禁没跑完。
- 本会话创建并已回收：worktree + 分支 `gp-p4i4-wait`（内容以 `d10b8a90` 落在 main，删前用
  `git cherry origin/main gp-p4i4-wait` 判为空＝无独有补丁）、worktree `gp-gates-d10b8a`（detached，
  含一次未完成的 probe 构建，`rm -rf` 并 kill 掉它留下的孤儿 `swift-frontend`）。
- 留在盘上到报告之后才该清的：`/var/tmp/gp-daily-20261022/**`（开工整树快照 `snapshot/worktree-now.tgz`
  与 `snapshot/head-8e4dd6a1.tar.gz`——那是这批未推送年代的唯一回滚点，还有全部逐字门禁日志）。
