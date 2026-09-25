# harness/ — 工具面 B（opencode fork）的仓库侧资产

本目录有两类东西：**fork 本体**（`glasspane-harness/`，上游全树照搬后在其上定制）与**测量它的尺子**（`upstream.json` + `tools/*.mjs` + `contracts/*.json`）。尺子必须和 fork 同仓，否则"我们改了多少"又会变回一句散文。

## fork 为什么在仓内（2026-09-24 用户裁决）

形态与 `iterate-skill` / `iterate-harness` 一致：**fork 是项目源头仓库里的一个受版本控制的子目录**，远端发布用 `git subtree split` 切出去。因此 `harness/glasspane-harness/` 是上游 `anomalyco/opencode@v1.18.32`（commit `545f51d`）的**全树忠实照搬**（6,632 个条目，不删减），我们的定制以 `[gp]` 前缀提交叠在其上。

上游参照检出放在 `.external/opencode/`（gitignore，223 MB）——尺子读它，它不进版本控制。这不是"把上游代码仓内化"的第二次决策，而是让 diff 可复算的必要条件：`fork-diff` 逐文件比 blob 哈希，需要一个能 `git ls-files -s` 的本地参照。

取一份参照检出：

```bash
mkdir -p .external && cd .external
git clone --branch v1.18.32 --depth 1 https://github.com/anomalyco/opencode.git opencode
```

并行 worktree **不要各存一份**（221 MB 起）。当前布局是主工作树放真克隆、每个 worktree 里
`.external/opencode` 做成指回它的符号链接——`upstream.json.checkout` 与 `fork.referenceClone`
都按仓根解析，链接对它俩透明（本 worktree 的 `--check`/`--record`/`fork-diff` 全部实测照跑）。
链接是机器级的、`.external/` 本身 gitignore，所以这套安排不进版本控制，新环境照上面命令自建。

## 目录

| 路径 | 作用 |
|---|---|
| `glasspane-harness/` | fork 本体。M1 的 `gp_*` 工具面在 `packages/opencode/src/tool/glasspane/`，M2 的决策日志插件在 `packages/opencode/src/plugin/glasspane-decision-log.ts`；被改的 vendored 文件有两个（`tool/registry.ts`、`plugin/index.ts`），各 3 / 2 个 hunk |
| `glasspane-harness/packages/opencode/vendor/kernel/` | **vendored 的 @iterate/kernel 源**（M3）。真源是 `iterate-skill/kernel`，这里只是同步目标，手改一处即被 `kernel-vendor --check` 判红 |
| `glasspane-harness/FORK.md` / `SYNCLOG.md` | fork 自己的坐标、不可让步的纪律、每次同步/每批定制的实测数字 |
| `upstream.json` | 上游坐标真源：repo / **pinned tag** / license / 发布节奏 / fork 位置 / 参照检出位置 / 该扫哪些目录 |
| `tools/hook-liveness.mjs` | 契约闸：从 `Hooks` 声明反推每个钩子是否真被引擎派发 |
| `tools/fork-diff.mjs` | 分叉尺子：fork 全树 vs 参照，逐文件 blob 哈希，四桶清单 + 每个 edited 文件的**双侧内容哈希** |
| `tools/kernel-vendor.mjs` | 溯源尺子：vendored 内核的每个文件必须等于清单里的 sha256；canonical 在场时还交叉复核（镜像落后＝红） |
| `tools/tool-surface.mjs` | 工具面占比棘轮：engine 与两个工具面的 LOC 比例，只挡"没被记录的增长" |
| `tools/surface-semantics.mjs` | 工具面**语义**棘轮（方案 §9-6）：阈值比较 / pass-fail 合成 / 证据字段比较，只挡"没被记录的新命中" |
| `tools/product-surface.mjs` | 产品面**一致性**闸（私有化批次 B）：`product.json` ↔ package.json / build / publish / postinstall / bin shim / 安装器 / 工作流逐条对齐，且产品面可执行文本里不许再出现上游 registry（AUR / homebrew tap / ghcr / opencode.ai/install / opencode-ai 包名） |
| `contracts/hook-liveness.json` | 金样：20 声明 → 14 live / 5 structural / **1 dead（`permission.ask`）** |
| `contracts/fork-diff.json` | 金样：声明过的分叉面（当前 `6539 identical / 36 edited / 43 added / 57 deleted`；added 里 23 个是 vendored 内核，deleted 是上游 26 个工作流 + 20 份 locale README 等，批次 A/B 的 SYNCLOG 逐类记了账） |
| `contracts/kernel-vendor.json` | 溯源清单：canonical 的 repo/ref/branch/version + 23 个文件的 sha256/字节数（`--record` 在对不齐时直接拒绝写） |
| `contracts/tool-surface.json` | 基线（2026-09-25 私有化批次 A 后复算）：engine 18,335 / 面 A 3,859（15.89%）/ 面 B 2,098（8.64%），并记着被排除的测试（5 文件 952 行）与 vendored 依赖行数 |
| `contracts/surface-semantics.json` | 基线（2026-09-25 首次记录）：**0 命中 / 15 个文件**——两个工具面今天都不判证据语义；规则说明逐条进金样 |
| `spike/` | E1/E2/E5/E6 的运行时探针与离线 mock 模型（`run.sh` 一键；结论见调研方案 §5.0）。E7（决策链对着真 daemon）在 fork 内：`packages/opencode/script/glasspane-e7-ledger.ts`；E8（压缩钩子对着真宿主，不花钱）也在 fork 内：`packages/opencode/script/glasspane-e8-compaction.ts` |

金样一律由 `--record` 生成，**不要手改**。

跑 fork 侧的测试要在 `harness/glasspane-harness/packages/opencode` 里跑（仓根有一个故意的
`do-not-run-tests-from-root` 挡路），并且用包脚本的 `--timeout 30000`：`test/preload.ts` 的
afterAll 要 dispose runtime + 删临时目录，5 秒默认超时会把它打断成一条"无名失败"。工具链是
`packageManager` 钉的 **bun@1.3.14**（这台机器上的 bun 曾经消失过，导致一批闸误判成红——缺工具
不等于失败，`tools/sync-kernel.sh` 现在会明说哪几道闸没跑）。

## 尺子各防哪一种事故

**hook-liveness** — 上游宿主按**名字**派发钩子：`Plugin.trigger(name, input, output)` → `hook[name]?.(...)`（`packages/opencode/src/plugin/index.ts:284-298`）。"声明了但没人 trigger"的钩子于是**类型合法、加载成功、永不运行**。pin 的 `v1.18.32` 上 `Hooks["permission.ask"]`（`packages/plugin/src/index.ts:261`）全树只出现这一次＝零派发，而上游仓内文档 `packages/core/src/plugin/skill/customize-opencode.md:354` 却把它列在"Hook surface"里。structural 那 5 个（`config`/`tool`/`auth`/`provider`/`dispose`）是宿主初始化期直接读字段，不按名派发，因此**不算死钩子**；豁免理由写在 `hook-liveness.mjs` 的 `STRUCTURAL` 表里，每条点名读取位点。

**fork-diff** — iterate 侧的真实教训不是"改了 144 个文件"，而是"文档写 8 处定点、树里 144 处、且没有任何机器检查发现这件事"。定制多少不是问题，**不知道定制了多少才是问题**。所以每个文件比 blob 哈希（"只改了空白"藏不住，符号链接与模式也算），四桶清单进金样，漂移即红。**光有名单还不够**：名单以文件名为单位，"已经在名单里的文件又长几行"它天生看不见（实测如此，见下条负例）。金样因此对每个 edited 文件另钉**上游哈希 + 我们的哈希**，内容漂移与名单变化同级现形。

**tool-surface** — 三条架构铁律里唯一带数字的那条（工具面 <10% 代码量）此前只是散文：实测工具面 A = 3,719 / 21,455 = **17.8%**（合流与 M2/M3 之后是 3,859 / 23,252 = 16.60%），而仓库里没有任何东西能发现。做成**棘轮**：允许增长，不允许没人注意到——超基线即红，出路是同批 `--record` 并在提交里说清为什么。A 的越限是既有事实，金样如实记着，闸只保证它不再变大。**口径对称性**：面 A 从来只量 `src/`，所以面 B 也不把测试算成工具面（5 个文件 952 行，M4 批后），vendored 依赖同样排除（10 个代码文件 1,150 行，由溯源清单判定）；两个排除都被打印并计入金样，因为**不报出来的排除就是偷改口径**。

**kernel-vendor** — `@iterate/kernel` 不单独发布（P6 §13），所以它以 **vendored 源**的形式活在 fork 里；而 subtree split 之后的独立仓又够不到 `../../kernel`。"vendored" 与"我们自己的第二份实现"只差一条清单：`contracts/kernel-vendor.json` 记 canonical 的 repo/ref/branch/version 和每个文件的 sha256，`--check` 在**没有 canonical 的 CI 里**也能抓到任何手改、新增或删除。它和 fork-diff 是两种不同的红：改一行 vendored 内容 → 占比闸**不动**（那不是我们的行），溯源闸**变红**。

**surface-semantics** — 占比闸量的是"长厚了多少"，它量的是"长的还是不是**判**"：铁律"工具面不得自行判定任何证据语义"此前同样只是散文，而判定悄悄外移到 shell 的失败模式是**编译通过、测试全绿**，另外三把尺子一条都看不见。所以扫两个工具面（`mcp-shell/src` + fork 的 `src/tool/glasspane/**` 与 `src/plugin/glasspane-*.ts`），三条规则——小数阈值比较、pass/fail 的三元/相等**合成**（按主语判：`x.status !== "failed"` 是台账记账，`ok ? "pass" : "fail"` 才是判定）、证据字段比较（`!== undefined` 在场检查豁免，因为"缺席必须说得出"），同样做成棘轮 + 基线金样。**首次基线 0 命中**：两个工具面今天都不判证据语义，三条反向因果已验可红。校准记录在 `SYNCLOG.md`：第一版规则把本仓 `status: "failed"` 与 `pixelDiff !== undefined` 判成命中，基线一度 6 命中——**先校准规则再记基线**，否则金样记的是规则的噪声。

**product-surface** — 私有化是**分布式事实**：产品名住在 `product.json`，但同一事实散在 `packages/opencode/package.json`、`script/build.ts`、`script/publish.ts`、`script/postinstall.mjs`、`bin/glasspane-harness`、两个安装器和工作流里，**没有任何东西会发现其中一处还写着上游的名字**。症状不是红测试——是装出来的东西不对，或者发布推到陌生人 registry（这正是批次 A 从上游脚本里拆掉的 ghcr/AUR/homebrew tap/opencode.ai/install 四条路）。brand 那道闸量字符串，这道量**一致**：86 条断言，**无基线**（它量的不是数字，是"该不该一样"——规则错了就改规则，没有 `--record` 可盖）。安装器不只被读：`sh -n` 过语法，`--dry-run` 真跑一遍并断言计划里出现产品名。反向因果五条已验可红（版本漂移、代码里塞回 ghcr、安装器指向别人仓、多一个工作流、配置发现丢掉遗留回退），另有两条是**校准负例**：第一版 URL 规则被注释里的仓库名喂饱（改为只看可执行文本），以及 state-root/config 两条一度被分段插入落在 `process.exit` 之后成为死代码（计数从 83 变 86 才发现——**"闸是绿的"要连计数一起看**）。

## 怎么跑

```bash
node harness/tools/hook-liveness.mjs --check    # 对齐 pin：金样 vs 参照检出，漂移即红
node harness/tools/hook-liveness.mjs --probe    # "升级到新 tag 会不会伤我们"：HARNESS_UPSTREAM_CHECKOUT 指向那份检出
node harness/tools/hook-liveness.mjs --offline  # 没有上游源码的 lane：只做金样自洽，并大声声明"上游未在此观测"
node harness/tools/hook-liveness.mjs --record   # 换 pin 后重新生成金样（会拒绝版本与 pin 不一致的检出）

node harness/tools/fork-diff.mjs --check        # 分叉面 == 金样？（本地/发布前；要参照检出）
node harness/tools/fork-diff.mjs --record       # 有意改动后重新声明
node harness/tools/tool-surface.mjs --check     # 工具面没有偷偷长（CI 每跑）
node harness/tools/tool-surface.mjs --record    # 有意长厚后重新记基线
node harness/tools/surface-semantics.mjs --check  # 工具面没有开始自行判定证据语义（CI 每跑）
node harness/tools/surface-semantics.mjs --record # 有意新增命中（并说清为什么合法）
node harness/tools/product-surface.mjs --check   # 产品面各件与 product.json 一致？（CI 每跑，含 sh -n + --dry-run）
node harness/tools/kernel-vendor.mjs --check    # vendored 内核 == 溯源清单？（CI 每跑，不需要 canonical）
KERNEL_SRC=/path/to/iterate-skill node harness/tools/kernel-vendor.mjs --check  # 更强：连 canonical 一起跨读
KERNEL_SRC=/path/to/iterate-skill tools/sync-kernel.sh --target=fork            # 唯一的合法更新路径
```

退出码：**0** 通过（含如实的离线跳过）；**1** 契约/分叉/占比漂移；**2** 工具做不了事（缺 `upstream.json`、缺金样、检出版本与 pin 混用）。

## 闸自己被验过吗

验过，每次都是"反向破坏 → 必须变红"的因果验证，而不是"跑过了"。破坏脚本不落仓（本次跑在 `/var/tmp/glasspane-harness/`，日志同名目录）：

- hook-liveness：① `--check`/`--probe` 对 pin 绿；② `--offline` 绿但**明确声明未观测上游**；③ 金样伪写成 `permission.ask` 是活的 → `--check` 与 `--probe` 双双 exit 1；④ 删金样 → exit 2 并指名 `--record`；⑤ `--record` 重跑与仓内金样**逐字节相同**。
- fork-diff：未记录的自有新增 → 报 `added` 并 exit 1；`--record` 后转绿；给 vendored 文件加一行 → 报 `1 edited` 且**点名该文件**；从参照还原 → 转绿。**内容级**：给已在名单里的 `registry.ts` 再加 3 行，名单不变但金样钉着的 fork 侧哈希变了 → **exit 1 点名 "our content moved"**（同一步在加哈希钉之前是绿的，日志 `/var/tmp/glasspane-harness/blind-spot.log`）；拿**没有哈希字段的老金样**跑 → exit 1 并指名 `--record`。把参照克隆藏掉（＝CI 形态）后仍核我们这一侧：清树 exit 0 并报 `1 edited hash-checked, 5 added present`、`registry.ts` 加 2 行 exit 1、金样被剥掉哈希 → **exit 1 直说"这条 lane 无事可控"**、删一个 added 文件 → exit 1。参照克隆被中途杀过，所以另验 `git fsck` 无错 + 工作树干净 + `describe` == pin。
- tool-surface：给 `mcp-shell/src/tools.ts` 加 3 行 → A 报 `+3` exit 1；给我们的 fork 文件加 20 行 → B 报 `+20` exit 1；给 **edited** 的 `registry.ts` 加 3 行 → B 报 `+3` exit 1（证明 `+N` 是真的对着参照重算的）；还原 → 转绿；藏掉参照克隆 → exit 0 但**打印 "NOT re-measured"**；删 `fork-diff.json` → **exit 1**（量不到 ≠ 过关）；`--record` 重跑逐字节相同。三条文件 MD5 前后一致，`git status` 零残留。**它自己被抓出来两个错**：① 排除测试的正则写成 `/(^|\/test\/)/`，那个 `^` 匹配空串 ⇒ 所有文件都被当成测试、面 B 一度只剩 14 行；② `--record` 会在归因失败时照样写金样（差点把 B = 0 记成基线）。现在正则修成 `/(^|\/)test\//`，并加了两条兜底：**该有内容的清单被排除空了＝红**、**归因失败时拒绝 record**。
- kernel-vendor（vendored 内核的溯源闸）：清树绿；改一个 vendored 源文件 → exit 1 点名新旧哈希；删一个 → exit 1；**新增**一个清单没声明的文件 → exit 1 并说"fork 长出了自己的内核文件"；`KERNEL_SRC` 在场时跨读 canonical，镜像落后 → exit 1 并说"STALE，重跑同步"；`--record` 在镜像与 canonical 不一致时**拒绝盖章**。两条控制与占比闸咬合：往清单声明的 vendored 文件里加 6 行 → 占比**不动**（1058 依旧）、溯源**变红**；往同一目录塞一个未声明文件并把它记进分叉名单 → 占比把它算成**我们的行**并变红（`/var/tmp/glasspane-harness/vendor-accounting2.log`）。
- surface-semantics：`mcp-shell/src/tools.ts` 加 `ratio > 0.95` → threshold-comparison 红；`glasspane-decision-log.ts` 加 `ok ? "pass" : "fail"` → verdict-synthesis 红；`mcp-shell/src/evidence-report.ts` 加 `pack.signals.pixelDiff >= 0.5` → 两条规则同红（都点名文件与规则计数）；删金样 → exit 2 并指名 `--record`；还原三处 → 转绿。**校准也是负例**：第一版规则把本仓 `status: "failed"` 与 `pixelDiff !== undefined` 判成命中（基线一度 6 命中），按"按主语判合成 / 在场检查豁免"收窄后回到 0 命中——先校准再记基线，否则金样记的是规则的噪声。
- `tools/sync-kernel.sh --target=fork`：一道红闸（用 `BUN=/usr/bin/false` 强制）→ 回滚后镜像 23 个文件、内容签名、溯源清单三项都在，**没有任何东西被删**；这条控制是补出来的——脚本的第一版回滚用 `git clean`，在首次 vendoring（路径还没进版本控制）时把刚 vendor 进来的 23 个文件删掉了，而触发它的根本不是代码问题，是 `bun: command not found`。**"缺工具"与"闸红"现在分开处理**：找不到 bun 就明说哪两道闸没跑，并在成功行里保留警告。

一条如实挂账的分工：**CI 没有参照克隆，那里能核的只有"我们这一侧"**——`fork-diff --check` 无克隆时比对金样钉着的 fork 侧哈希与 added 文件是否还在（改内容照样红，实测 1 秒，所以它进了 `install-gate`）；`tool-surface` 在离线时把 vendored 文件的**行数**降级为上次记录并打印 `NOT re-measured`，不假绿。**上游字节的复测（6,632 个哈希 + 参照 `ls-files`，约 2 分钟、要背 223 MB 克隆）只在本地/发布前与同步上游时跑**，那是 `SYNCLOG.md` 每次必须留痕的原因。这个分工是设计而不是妥协：把 223 MB 参照塞进 PR CI 的结局是被人关掉守卫。

上游侧那条真检测（新 release → `--probe` → 漂移即冻结）在 `.github/workflows/harness-contract.yml`：每周一次 + 手动可触发，手动输入的 tag 先钳成 `vMAJOR.MINOR.PATCH` 形状、事件数据只经环境变量下发。**这个机制今天在全球范围内都还没有先例**（iterate 侧只有文档承诺），所以它是这条线最先要立住的东西，而不是 fork 代码本身。

还有一条属于"闸的闸"：`scripts/check-workflows.mjs`（挂在 `docs` job 里）检查工作流文件里没有重名 job 键、且每条 `run:` 引用的仓内脚本真的存在（按各 step 的 `working-directory` 解析）。它的来历就是本仓真出过的事故——一次跨 base 的 ci.yml 搬移让 `git merge` 把 `docs:` job 复制成两份，而我最初用 YAML 解析器数 job 数（映射重名键后覆盖前）**看不出任何问题**。看不见不等于不存在，所以这条检查现在机器做，六条负例见 `harness/glasspane-harness/SYNCLOG.md`。
