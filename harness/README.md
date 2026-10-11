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
| `glasspane-harness/packages/opencode` 的 `iterate-kernel` 依赖 | **M3 的内核形态（2026-10-08 起它是依赖，不是副本）**：`packages/opencode/vendor/kernel/`（25 文件：src 11 + schemas 3 + fixtures 11）已删除，fork 从 registry 解析 `iterate-kernel@0.1.3`（首记 0.1.2），`bun.lock` 记 integrity。入口仍只有一个文件（`src/tool/glasspane/kernel.ts`），且只走 per-module 子路径——barrel 会带进 `schemas`，它在模块加载时 `createRequire` 读包旁边的 schema 文件，单文件二进制因此起不来 |
| `glasspane-harness/FORK.md` / `SYNCLOG.md` | fork 自己的坐标、不可让步的纪律、每次同步/每批定制的实测数字 |
| `upstream.json` | 上游坐标真源：repo / **pinned tag** / license / 发布节奏 / fork 位置 / 参照检出位置 / 该扫哪些目录 |
| `tools/hook-liveness.mjs` | 契约闸：从 `Hooks` 声明反推每个钩子是否真被引擎派发 |
| `tools/fork-diff.mjs` | 分叉尺子：fork 全树 vs 参照，逐文件 blob 哈希，四桶清单 + 每个 edited 文件的**双侧内容哈希** |
| `glasspane-harness/script/kernel-pin.mjs` | 溯源尺子（**在 fork 树里**，因为 split 出的独立仓必须能自证溯源；取代 2026-10-08 退役的 `kernel-vendor.mjs`）：`--check` 验四件事——装进来的版本 == pin、`bun.lock` 那条 specifier **为空**（＝registry 解析，不是 `file:`/`link:`）、lock integrity == pin、随包发出的 17 个契约文件（11 fixtures + 3 schemas）逐个 sha256 == pin。`--probe` 问 registry（`npm view iterate-kernel version`），不再 `git ls-remote` 追分支头；`--record` 只在故意 bump 时写 |
| `glasspane-harness/script/kernel-conformance.mjs` | 行为尺子：把**随包发出**的语料跑过装进来的 `dist`，逐条比较答案；`--impl <canonical checkout>` 再跑第二份实现，两侧必须同答案（实测 11 条 fixture 同答案（2026-10-10，`--impl` 指向 `kernel/npm-canonical`@edf926f 构建出的那份：11 两侧逐字节相同，其中 dimension-context / evidence-decision / run-plan 三条另有 fixture 自带的 oracle），zod major 造成的**报错文案**差异由工具打印成 note 而不是抹平）。它与溯源闸互为补充：哈希只证明字节没变，这条证明那些答案还是那些答案 |
| `tools/tool-surface.mjs` | 工具面占比棘轮：engine 与两个工具面的 LOC 比例，只挡"没被记录的增长" |
| `tools/surface-semantics.mjs` | 工具面**语义**棘轮（方案 §9-6）：阈值比较 / pass-fail 合成 / 证据字段比较，只挡"没被记录的新命中" |
| `tools/product-surface.mjs` | 产品面**一致性**闸（私有化批次 B）：`product.json` ↔ package.json / build / publish / postinstall / bin shim / 安装器 / 工作流逐条对齐，且产品面可执行文本里不许再出现上游 registry（AUR / homebrew tap / ghcr / opencode.ai/install / opencode-ai 包名） |
| `tools/brand-surface.mjs` | 品牌棘轮（私有化批次 C）：26 个产品面文件 + 2 份 README 里不许再出现上游 npm 名/平台包名/上游 registry/用户可见 "opencode" 字符串；两份 README 的每处 opencode 必须落在署名行（fork/upstream/anomalyco/MIT/上游/血缘/**包路径**）上；另加全树血缘计数（以金样为准；2026-10-08 改依赖那批使扫描面 3,310→3,302 文件、9,627→9,619 处——少看的是退役掉的 vendored 树，不是品牌进步，故按新规则同批 `--record`）（排除 fork 自己的血缘文档；代码里那条"排除 vendored 内核目录"的规则还在，但那个目录已随 2026-10-08 改依赖退役，于是它现在匹配不到任何东西——装进来的包在 `node_modules`，本来就不在扫描集里）——**只许减不许增**，且 2026-10-09 起**覆盖率与数字同进退**：`--check` 每次并报 `filesScanned` 并把**覆盖率下降**判红（子树消失不许读成品牌进步），`--record` 拒绝把读不到的产品文件（`missing-product-file`）盖成基线 |
| `contracts/hook-liveness.json` | 金样：20 声明 → 14 live / 5 structural / **1 dead（`permission.ask`）** |
| `contracts/fork-diff.json` | 金样：声明过的分叉面（2026-10-08 记 **`4668 identical / 259 edited / 81 added / 1705 deleted`**，全树 6,713 个条目；上一记是 2026-10-07 的 `4669 / 258 / 114 / 1705`，6,746 个条目——差的 33 个 added 就是退役掉的 vendored 内核树与它的旧尺子，加回 3 个新文件。再往前本行写过 `6539 / 36 / 43 / 57`，那是批次 A 之前的形状，早就没人对着树核过——正是这把尺子存在的理由。added 里**不再有** vendored 内核（内核是依赖，不在树里），deleted 是上游 26 个工作流 + locale README 等，批次 A/B 的 SYNCLOG 逐类记了账） |
| `glasspane-harness/contracts/kernel-pin.json` | 出处清单（**在 fork 树里，不在本目录**——subtree split 之后独立仓必须自带溯源清单；`kernel-pin.mjs` 靠"向上找到 `product.json` 那一层"定位它，`tool-surface.mjs` 则在 `harness/glasspane-harness/contracts/` 与 `harness/contracts/` 两处里找第一个存在的）：`package`/`version` + registry 解析坐标（`lockKey` / `specifier` / `integrity`）+ canonical 的 repo/path/branch + 随包 **17** 个契约文件（13 fixtures + 4 schemas）的 sha256。此前这行写的是 `kernel-vendor.json`：25 个 vendored 文件的 sha256 + 9 份镜像 fixture——镜像已删（本仓 9 个 vs 随包发布的 11 个，早就漂移了），语料现在只从包内部取 |
| `contracts/tool-surface.json` | 基线（2026-10-09 复算）：engine 23,295 / 面 A 8,658（**22.84%**，已知越限、只挡再长）/ 面 B **5,953**（**15.70%**；内核改依赖那批记的是 5,376 / 14.50%，其间并入的并行批次与本批 conformance 脚本各自的行都进了面 B），并逐文件记着被排除的测试行数（本轮实测：测试 27 文件 1,544 行）；**vendored 内核排除项现在是 0 文件 / 0 行**（上一记 11 文件 / 1,464 行）——内核改依赖后树里没有它的字节可剔，金样因此另记 `kernel: iterate-kernel@0.1.3`，让这次口径变化在尺子上可读 |
| `contracts/surface-semantics.json` | 基线（2026-09-26 首记，2026-10-06 复跑）：**0 命中 / 18 个文件**（mcpShell 13 + fork 5；金样里那份 `filesScanned 15` 是 mcp-shell 长出新文件之前的值，`--check` 不比对扫描集，见下文「闸自己被验过吗」）——两个工具面今天都不判证据语义；规则说明逐条进金样 |
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

**tool-surface** — 三条架构铁律里唯一带数字的那条（工具面 <10% 代码量）此前只是散文：实测工具面 A = 3,719 / 21,455 = **17.8%**（合流与 M2/M3 之后是 3,859 / 23,252 = 16.60%），而仓库里没有任何东西能发现。做成**棘轮**：允许增长，不允许没人注意到——超基线即红，出路是同批 `--record` 并在提交里说清为什么。A 的越限是既有事实，金样如实记着，闸只保证它不再变大。**口径对称性**：面 A 从来只量 `src/`，所以面 B 也不把测试算成工具面（实测 27 文件 1,544 行）。曾经还需要排除 **vendored 内核**（最后一次 11 文件 1,464 行，由溯源清单判定），2026-10-08 内核改成 `iterate-kernel` 依赖后这一项归零——树里没有它的字节了。排除项被打印并计入金样，因为**不报出来的排除就是偷改口径**（打印的是本次**实际解析到的**清单路径，不是硬编码的一句 provenance），而排除项归零同样是个要记账的口径变化，所以金样另钉 `kernel: iterate-kernel@0.1.2`。这道闸的方向因此翻了：`measureFork` 现在**拒绝** `packages/opencode/vendor/kernel` 重新出现——那份树若回来，它那 1,464 行依赖字节会整份被算成我们写的，而已经没有清单能把它们剔出去。**作者行的配对是一对一的**：去品牌后与某条删除同形的新增最多抵掉一条，一行删除不抵无穷新增——"删 1 行、把同一句话改名重加 40 行"记 39 行。越限播报对**两面各走一遍**并带记录值→当前值，还点名那条"第一次越限才响"的 crossing 检查此刻是 LIVE 还是已经用掉（面 A/面 B的基线本身就在限外，所以它今天对两面都恒假；判红口径未变，变的是如实说）。

**kernel-pin / kernel-conformance** — `@iterate/kernel` 今天以 **registry 依赖** `iterate-kernel@0.1.4` 的形态活在 fork 里：`packages/opencode/vendor/kernel/` 那 25 个文件的副本已删除，`tools/sync-kernel.sh --target=fork` 也**明确拒绝**（它打印新的合法路径：bump 依赖 + `bun install` → `kernel-pin.mjs --record` → `kernel-conformance.mjs --impl <canonical checkout>`）。"依赖"与"今天随手装到的那个东西"只差一条清单：`contracts/kernel-pin.json` 记版本、registry 解析坐标与随包 17 个契约文件的 sha256，`--check` 在**没有 canonical 的 CI 里**就能抓到版本漂移、`file:`/`link:` 伪装成依赖的解析、被换掉的 artifact，以及包内部契约字节的改动。哈希只证明字节没变，所以行为面另有一把：`kernel-conformance.mjs` 把随包语料跑过装进来的 `dist`（`--impl` 再对一份实现），并且从 2026-10-08 起把 fork 一直在消费、此前却没有任何 fixture 校过的 `dimension-context` 一起驱动。它和 fork-diff 仍是两种不同的红：内核换了字节 → 占比闸**不动**（那不是我们的行），溯源与行为闸**变红**。

**surface-semantics** — 占比闸量的是"长厚了多少"，它量的是"长的还是不是**判**"：铁律"工具面不得自行判定任何证据语义"此前同样只是散文，而判定悄悄外移到 shell 的失败模式是**编译通过、测试全绿**，另外三把尺子一条都看不见。所以扫两个工具面（`mcp-shell/src` + fork 的 `src/tool/glasspane/**` 与 `src/plugin/glasspane-*.ts`），三条规则——小数阈值比较（**两个操作数方向都咬**：`ratio > 0.5` 与 `0.5 < ratio`、`0.02 <= pack.changedPixelRatio` 同算，口径仍限小数字面量，`> 0` 这种整数比较不算证据阈值，免得淹掉基线）、pass/fail 的三元/相等**合成**（按主语判：`x.status !== "failed"` 是台账记账，`ok ? "pass" : "fail"` 才是判定）、证据字段比较（`!== undefined` 在场检查豁免，因为"缺席必须说得出"），同样做成棘轮 + 基线金样。**首次基线 0 命中**：两个工具面今天都不判证据语义，三条反向因果已验可红。校准记录在 `SYNCLOG.md`：第一版规则把本仓 `status: "failed"` 与 `pixelDiff !== undefined` 判成命中，基线一度 6 命中——**先校准规则再记基线**，否则金样记的是规则的噪声。

**product-surface** — 私有化是**分布式事实**：产品名住在 `product.json`，但同一事实散在 `packages/opencode/package.json`、`script/build.ts`、`script/publish.ts`、`script/postinstall.mjs`、`bin/glasspane-harness`、两个安装器和工作流里，**没有任何东西会发现其中一处还写着上游的名字**。症状不是红测试——是装出来的东西不对，或者发布推到陌生人 registry（这正是批次 A 从上游脚本里拆掉的 ghcr/AUR/homebrew tap/opencode.ai/install 四条路）。brand 那道闸量字符串，这道量**一致**：88 条断言，**无基线**（它量的不是数字，是"该不该一样"——规则错了就改规则，没有 `--record` 可盖）。安装器不只被读：`sh -n` 过语法，`--dry-run` 真跑一遍并断言计划里出现产品名。反向因果五条已验可红（版本漂移、代码里塞回 ghcr、安装器指向别人仓、多一个工作流、配置发现丢掉遗留回退），另有两条是**校准负例**：第一版 URL 规则被注释里的仓库名喂饱（改为只看可执行文本），以及 state-root/config 两条一度被分段插入落在 `process.exit` 之后成为死代码（计数从 83 变 86 才发现——**"闸是绿的"要连计数一起看**）。

**brand-surface** — 私有化批次 A 改了名、B 钉住了"彼此一致"，但**一致地叫 glasspane-harness 旁边照样能长出一句 `npm install -g opencode-ai`**：安装器照跑，只是装错了名字；文档照读，只是叫错了人——品牌腐烂的失败模式全是"没人发现"。所以产品面 25 个文件零容忍（上游 npm 名/平台包名/上游 registry/用户可见字符串；注释不算，说明"我们删掉了 X"的注释是记录不是引用），两份 README 按**行**判定（每处 opencode 必须在署名行上，路径 `packages/opencode` 也算行——路径不是产品主张），再加一条全树**血缘计数只许减不许增**的棘轮（当前 9,618 处 / 3,309 文件（此数曾记到 18,649/3,906，是口径收窄前的全树形状）；今天全仓最大的数字就是它，而这正是它的用途：让 `@opencode-ai/*`、`OPENCODE_*` 这些刻意保留的名字成为**有基线的存量**而不是没人管的增量）。反向因果六条全验可红，其中两条**校准负例**最典型：① 无引号的 `npm i -g opencode-ai` 一开始只被 lineage 计数抓住、专属规则没咬（规则从"带引号"收紧为"任何出现"）；② 平台包规则只认成品名 `opencode-darwin`、没认模板形式 `opencode-${platform}`（postinstall 里正是模板形式）——**总计数兜住了一切，但兜底不能替代专属规则**，两条都收紧后各自单咬。又一轮校准同样入账：血缘计数最初把 fork 自己的 SYNCLOG/FORK/上游 AGENTS 也算进去，于是**诚实的文档写作会让代码血缘计数变红**——现在按文件排除这些"讲血缘故事的地方"（两份 README 仍走行级规则管住它们的措辞）；而 `upstream-npm-name` 收紧到"任何出现"时先误咬了 17 处刻意保留的 `@opencode-ai/*` 工作区作用域，改为"前面不是 @ 也不属于标识符"才是诚实的中间态。两条**口径级**的账也在同一批补上：`--record` 遇到 `missing-product-file`（列在名单里却读不到的文件）一律拒绝，除非另给显式 `--ack-missing-product-file`，且此后每次 `--check` 都重播这个洞——"没在看这个文件"不许被盖成绿色基线；血缘计数**每次并报扫描规模**（3,310 文件是口径的一部分），覆盖率**下降即红**（子树离开树＝计数变小＝假的"品牌进步"），上升只报不红（新增文件是正常干活，挡它只会逼人关闸）。

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
node harness/tools/brand-surface.mjs --check     # 没有新的未记录品牌漂移？（CI 每跑）
node harness/tools/brand-surface.mjs --record    # 有意新增（并说清为什么合法）
node harness/glasspane-harness/script/kernel-pin.mjs --check    # 装进来的内核 == 它的出处清单？（CI 每跑，不需要 canonical）
node harness/glasspane-harness/script/kernel-pin.mjs --probe    # registry 有没有发出更新的一版（只读，不改任何东西）
bun harness/glasspane-harness/script/kernel-conformance.mjs     # 随包语料跑过装进来的 dist（行为，不只是字节）
bun harness/glasspane-harness/script/kernel-conformance.mjs --impl /path/to/iterate-skill/kernel  # 再对一份实现，两侧必须同答案
node harness/glasspane-harness/script/kernel-pin.mjs --record   # 只在故意 bump 版本时写
KERNEL_SRC=/path/to/iterate-skill tools/sync-kernel.sh --target=fork            # 已退役：这条现在直接拒绝（exit 2）并打印上面那三步
KERNEL_SRC=/path/to/iterate-skill tools/sync-kernel.sh --target=repo            # mcp-shell 那份 kernel/ 镜像照旧（本批未动）
```

退出码：**0** 通过（含如实的离线跳过）；**1** 契约/分叉/占比漂移；**2** 工具做不了事（缺 `upstream.json`、缺金样、缺装进来的 `iterate-kernel` 或读不到 registry、检出版本与 pin 混用）。

## 闸自己被验过吗

验过，每次都是"反向破坏 → 必须变红"的因果验证，而不是"跑过了"。破坏脚本不落仓（本次跑在 `/var/tmp/glasspane-harness/`，日志同名目录）：

- hook-liveness：① `--check`/`--probe` 对 pin 绿；② `--offline` 绿但**明确声明未观测上游**；③ 金样伪写成 `permission.ask` 是活的 → `--check` 与 `--probe` 双双 exit 1；④ 删金样 → exit 2 并指名 `--record`；⑤ `--record` 重跑与仓内金样**逐字节相同**。
- fork-diff：未记录的自有新增 → 报 `added` 并 exit 1；`--record` 后转绿；给 vendored 文件加一行 → 报 `1 edited` 且**点名该文件**；从参照还原 → 转绿。**内容级**：给已在名单里的 `registry.ts` 再加 3 行，名单不变但金样钉着的 fork 侧哈希变了 → **exit 1 点名 "our content moved"**（同一步在加哈希钉之前是绿的，日志 `/var/tmp/glasspane-harness/blind-spot.log`）；拿**没有哈希字段的老金样**跑 → exit 1 并指名 `--record`。把参照克隆藏掉（＝CI 形态）后仍核我们这一侧：清树 exit 0 并报 `1 edited hash-checked, 5 added present`、`registry.ts` 加 2 行 exit 1、金样被剥掉哈希 → **exit 1 直说"这条 lane 无事可控"**、删一个 added 文件 → exit 1。参照克隆被中途杀过，所以另验 `git fsck` 无错 + 工作树干净 + `describe` == pin。
- tool-surface：给 `mcp-shell/src/tools.ts` 加 3 行 → A 报 `+3` exit 1；给我们的 fork 文件加 20 行 → B 报 `+20` exit 1；给 **edited** 的 `registry.ts` 加 3 行 → B 报 `+3` exit 1（证明 `+N` 是真的对着参照重算的）；还原 → 转绿；藏掉参照克隆 → exit 0 但**打印 "NOT re-measured"**；删 `fork-diff.json` → **exit 1**（量不到 ≠ 过关）；`--record` 重跑逐字节相同。三条文件 MD5 前后一致，`git status` 零残留。**它自己被抓出来两个错**：① 排除测试的正则写成 `/(^|\/test\/)/`，那个 `^` 匹配空串 ⇒ 所有文件都被当成测试、面 B 一度只剩 14 行；② `--record` 会在归因失败时照样写金样（差点把 B = 0 记成基线）。现在正则修成 `/(^|\/)test\//`，并加了两条兜底：**该有内容的清单被排除空了＝红**、**归因失败时拒绝 record**。
- kernel-vendor（vendored 内核的溯源闸；**2026-10-08 随 vendored 树一起退役，替换者是 `kernel-pin.mjs` + `kernel-conformance.mjs`**，以下是对旧形态的历史记录）：清树绿；改一个 vendored 源文件 → exit 1 点名新旧哈希；删一个 → exit 1；**新增**一个清单没声明的文件 → exit 1 并说"fork 长出了自己的内核文件"；`KERNEL_SRC` 在场时跨读 canonical，镜像落后 → exit 1 并说"STALE，重跑同步"；`--record` 在镜像与 canonical 不一致时**拒绝盖章**。两条控制与占比闸咬合：往清单声明的 vendored 文件里加 6 行 → 占比**不动**（1058 依旧）、溯源**变红**；往同一目录塞一个未声明文件并把它记进分叉名单 → 占比把它算成**我们的行**并变红（`/var/tmp/glasspane-harness/vendor-accounting2.log`）。
- kernel-pin / kernel-conformance（上面那条的现任）：闸问的不再是"树里的字节 == 清单"，而是"装到的东西 == 我们记下的那一次发布"——版本、`bun.lock` 的 registry 解析（specifier 必须为空，`file:`/`link:` 即红）、lock integrity、随包 17 个契约文件的 sha256。改 pin 的版本号、改随包契约文件的字节，两条都实测红（2026-10-08 那批记录的负例）。行为面另有一把：`kernel-conformance --impl` 要求两份实现对每条 fixture 给**逐字节相同**的答案，实测 11 条同答案，zod major 造成的报错文案差异由工具打印成 note 而不是抹平。占比闸的咬合换了方向：`vendor/kernel` 重新出现 → `tool-surface` **拒绝测量**（那份树的行已经没有清单可以把它们从我们的行数里剔出去）。
- kernel-vendor（vendored 内核的溯源闸）：清树绿；改一个 vendored 源文件 → exit 1 点名新旧哈希；删一个 → exit 1；**新增**一个清单没声明的文件 → exit 1 并说"fork 长出了自己的内核文件"；`KERNEL_SRC` 在场时跨读 canonical，镜像落后 → exit 1 并说"STALE，重跑同步"；`--record` 在镜像与 canonical 不一致时**拒绝盖章**。两条控制与占比闸咬合：往清单声明的 vendored 文件里加 6 行 → 占比**不动**（1058 依旧）、溯源**变红**；往同一目录塞一个未声明文件并把它记进分叉名单 → 占比把它算成**我们的行**并变红（`/var/tmp/glasspane-harness/vendor-accounting2.log`）。
- **2026-10-09 复验（本轮改了 tool-surface / brand-surface / surface-semantics 三把尺子，改完重新验"它能红"，不是沿用上面的旧结论）**：
  ① 金样伪写：`contracts/tool-surface.json` 的 fork `loc` 5548→5549 → `--check` 变红并指名"把新金样与代码同批提交"；从自己的备份还原后 `git diff` 干净。
  ② 删金样：把 `tool-surface.json` 移开 → `tool-surface: no golden at harness/contracts/tool-surface.json — run --record`（不是绿）。
  ③ 藏参照检出：只挪本工作树里那个**符号链接**（主树那份没动）→ hook-liveness 大声声明 `upstream was NOT observed` 并给出 `--offline` 出路；fork-diff 仍核我们这一侧，逐文件点名 `our content moved (<old> → <new>)` 并报 `5 mismatch(es)`。
  本轮三处改动各自要咬的是哪一类假绿：`countAuthoredLines` 里那个**永不前进的 `ri`**（一条删除行可以免掉任意多条新增行，40 份改名复制记 0 行）；**面 B 越过 10% 却没人说**（跨限判定 `was.ratio <= limit` 对已经超限的基线恒假，所以那句"already over"只写给面 A，面 B 15.86% 只在括号里出现一次）；排除清单的**出处打成一条不存在的.path**（`harness/contracts/kernel-vendor.json`，真文件在 fork 树里），以及 brand-surface 的 `--record` 会把"这个文件没被扫到"写成绿色基线、`--check` 又从不比对扫描覆盖（子树消失＝血缘计数下降＝看着像进步）。surface-semantics 的阈值规则只认一种操作数顺序（`ratio > 0.5` 命中，`0.5 < ratio` 记 0），换成两侧匹配后本树仍 0 命中/18 文件——**没有**为了这条改动动过金样。
- surface-semantics：`mcp-shell/src/tools.ts` 加 `ratio > 0.95` → threshold-comparison 红；`glasspane-decision-log.ts` 加 `ok ? "pass" : "fail"` → verdict-synthesis 红；`mcp-shell/src/evidence-report.ts` 加 `pack.signals.pixelDiff >= 0.5` → 两条规则同红（都点名文件与规则计数）；删金样 → exit 2 并指名 `--record`；还原三处 → 转绿。**校准也是负例**：第一版规则把本仓 `status: "failed"` 与 `pixelDiff !== undefined` 判成命中（基线一度 6 命中），按"按主语判合成 / 在场检查豁免"收窄后回到 0 命中——先校准再记基线，否则金样记的是规则的噪声。
- `tools/sync-kernel.sh --target=fork`（**该 leg 已于 2026-10-08 改为直接拒绝**，以下是它还在 vendoring 时的控制记录）：一道红闸（用 `BUN=/usr/bin/false` 强制）→ 回滚后镜像 23 个文件、内容签名、溯源清单三项都在，**没有任何东西被删**；这条控制是补出来的——脚本的第一版回滚用 `git clean`，在首次 vendoring（路径还没进版本控制）时把刚 vendor 进来的 23 个文件删掉了，而触发它的根本不是代码问题，是 `bun: command not found`。**"缺工具"与"闸红"分开处理**这条现在仍活在 `--target=repo`（mcp-shell 那份镜像）上：找不到 bun 就明说哪两道闸没跑，并在成功行里保留警告。

### 2026-10-10 每日批次（harness 线）：四条"绿着却红不了"，其中三条在发布链路上

- `script/publish.ts`：平台包的版本断言此前是 `dist 里的 package.json` 与它自己比（期望值就从那份文件读出来）。反向证据用**本机未重建的 dist**（0.7.0 vs 产品 0.7.1）而不是合成夹具：改前 `--dry-run` 报 `ok … packs cleanly`，改后报 `package.json version 0.7.0 != product version 0.7.1` + exit 1。同批两条：wrapper 不再被平台循环当平台包发第二次（改前 dry-run 里 wrapper 那行 `ok` 打了两遍），`--dry-run` 不再自称 `wrapper-only mode`。
- `harness/tools/probe-lane-selftest.sh`（新闸）：从 `.github/workflows/harness-contract.yml` 抽出真 step 正文，用桩喂 `hook-liveness --probe` 的三种退出码；正例 exit 0/1/2 → step 0/1/1，并把"未观测"写进 step 摘要。反例：改动前的正文喂进去 → `exit 2 → step exit 0` 等三条红。它可用 `PROBE_LANE_WORKFLOW=<fixture>` 指向别处，所以验旧逻辑不需要损坏真 lane。
- `tool-surface`：`LIMIT`/`LIMIT_SOURCE`/`caliber` 现在与金样比对，且放在 `build()` 之前。三条变异各自具名红（0.1→0.25；caliber 措辞改宽；source 换文档），还原用自建备份 + sha256 核回。改前那笔 0.1→0.25 是全绿的，并把两条越限面的 `← OVER LIMIT` 自报一起抹掉。
- `kernel-conformance --impl`：缺模块改为先验存在性再导入，`--impl <canonical main>` 现在具名四个缺项并指出 pin 的 canonical 坐标与产物出处不符（exit 3）。金样伪写 / 删金样 / 藏参照这三条老路子的结论不变。
- 未观测：`gp_*` 对活 daemon 的证据成包真轮次、真 TUI 会话观感、真模型轮次、多平台整包构建。

**2026-10-06/07 每日批次的反向控制**（破坏脚本同样不落仓，在 `/var/tmp/glasspane-harness/`；这一批全部是"先证明它能红，再说它守住了"）：

- kernel-vendor：它的跨读此前读的是 **canonical 检出的工作树**，却把结论标成清单钉着的那个 ref。实测形态——`iterate-skill` 检在 `main`（8130060）而 pin 是 `kernel/decision-log-chain@2ed342b`，于是 25 个字节完全正确的 vendored 文件报了 **9 条红**，remedy 还教人"backflow or drop it"（＝去删对的文件）。改为按钉点从对象库读（`git show <ref>:kernel/<file>`）。合成树验 11 条：钉点一致→绿并声明"read from the object store"；钉点字节不符→红点名"mislabels its own ref"；钉点缺该文件→红；检出没有该对象→**不判**，大声写"cross-read NOT performed"且不得出现 ✗；canonical 工作树被改脏→仍按对象库读，绿。同一段里 `checkDeclaredMode()` 找的是 `<productRoot>/harness/glasspane-harness/product.json`（discovery 早就把 productRoot 定在放 product.json 的那层，此路径在任何布局下都不存在）⇒ **kernel.mode 这条断言从未执行过**；改成读 `product.json` 后实测输出里多了 `declared mode 'vendored' matches the tree`，并把 `mode=npm` 而树里仍有 vendored、以及 `kernel.mode` 缺失两条都验成红。
- product-surface：4 条 `check()` 落在打印与 `process.exit(1)` 之后（同一个文件历史上因同一形状被记过一次 83→86）。把判决收成底部唯一一处后，断言计数 **84 → 88**；反向控制：把 bin shim 的平台包名改回上游写法 → `✗ [postinstall-identity]` 且 exit 1（这 4 条在修之前只会打印，不会让闸变红），还原后字节一致。
- hook-liveness：① 参照检出缺失时 `--check` 此前 `TypeError: observed is not iterable` 退 1——而本工具 1 的语义是"上游坏了，冻结升级"，把"这台机器没克隆"报成了上游事故；现在退 2 并指向 `--offline`。② 钩子名正则不认下划线，pin 上 `"experimental.provider.small_model"`（`packages/plugin/src/index.ts:297`）被静默漏掉，金样记 20 而声明是 21；补上后又发现它的派定点写作 `plugin.trigger<"…">(`（`provider.ts:1953`），而 fire-site 正则不认带泛型的 `trigger` ⇒ 把**活的**钩子判成 dead。两处都改，`--record` 重记为 21（live 15 / structural 5 / dead 仍只有 `permission.ask`），两次 record 逐字节相同。③ 反向控制：拿一份合成检出"声明全部 21 个、派定点为零"→ 16 条 drift 全红并逐个点名；④ 声明形状改成缩进不符 → exit 2「parsed 0 hook names …」，而不是"没有钩子"。
- tool-surface：① `--record` 此前只挡归因失败（`note`），不挡"无参照克隆"下的**沿用**基线，等于允许把旧行数重新盖成基线，此后 edited 文件的增长在那条 lane 上永远不红；现在两种都拒（实测藏掉参照后 `--record` exit 1，金样哈希不变）。② 面 B 的口径在没有克隆时会把"上游文件改名而来"当成我们写的行（实测同一棵树：有参照 5,115，无参照 6,203，虚报 +1,147）。改名识别没有免参照的形式，所以无参照 lane 现在**拒绝声明面 B 在限内**（给 `git clone --branch <pin> --depth 1 …` 这条 remedy），与 `.github/workflows/ci.yml:209-215` 早就写下的设计口径一致。
- brand-surface：`packages/app/src/i18n` 的 readdirSync 没有存在性保护——目录被搬走时抛 ENOENT 退 1，会被下游读成"品牌漂移"；改成 exit 2 并写"cannot run, which is not the same as passing"（实测：临时移走该目录 → exit 2；还原 → exit 0，`git status` 零残留）。
- fork 侧的三条修复各自带能红的固定点测试：`test/tool/glasspane-surface.test.ts` 新增 6 条传输层用例（拿真 unix socket 当对端），对**改动前**的 `daemon.ts` 跑出 5 条具名红（空响应被当成功、非对象帧、id 不符、对端挂断要空等满超时、跨 chunk 的多字节标题被截烂）；`test/config/config.test.ts` 新增的同目录优先级用例对改动前的 `config.ts` 红在 `Received: "from-legacy"`（这条第一版没设 `OPENCODE_CONFIG_DIR`，走的是另一条分支，于是对着未修的源码也绿——假绿样本记在这里，因为它正是本仓反复犯的形状）；`scripts/install.sh` 由新增的 `packages/opencode/script/installer-selftest.sh` 驱动（桩 curl/uname/npm/gpg，兜底通道离线跑完 31 条断言），对改动前的安装器红在"Intel Mac 被拒"与"`--version 0.1.0` 报 Unknown argument"等 10+ 条具名用例上。
- `script/generate.ts`：上游把 models.dev 的响应**原文**塞进 `Bun.build({define})`，而 `define` 是源码文本替换——JSON 恰好是合法表达式所以看起来没事，链上 MITM 或拦截代理的错误页就是往发给所有用户的二进制里插代码。改为要求 2xx、必须是 JSON 对象、逐条 provider 为对象、再 `JSON.stringify` 回写。实测：合法目录→0；HTML 页、`1;globalThis.pwned=…//`、数组、空对象、值非对象 → 全部 exit 1 具名拒绝。

**2026-10-08/09 每日批次（尺子泳道）的反向控制**（破坏脚本同样不落仓：分析脚本与前后日志在 `/var/tmp/gp-harness-daily-20261008/laneC/`，被变异文件的**原始字节备份**在同目录 `mut/`，撤销一律 `cp` 还原自己的备份，不用 `git checkout`/`stash`。这一批全部落在 `harness/tools/` 三把尺子上，`harness/contracts/*.json` 一份都没动（三份金样 md5 与 `580be9a` 时逐一相同）。**如实挂账**：本轮实测期间另一泳道在同一 worktree 连续提交，HEAD 从 `580be9a` 走到 `bc92107`，所以下面凡"当前读数"都含他人的行；凡"我的改动带来的增量"都另用 `git show <commit>:…` 的**已提交字节**单独算过，两者分开写）：

- **tool-surface `countAuthoredLines`：一行删除只抵一行新增（原来一行删无穷）**。反例做法：把 `packages/opencode/src/server/mdns.ts` 里那句与上游只差品牌字面量的行（上游 `const host = domain ?? "opencode.local"`）的**去品牌同句**复制成 6 行——即"1 处删除 + 6 条相同改写新增"。同一棵变异树跑两版实现（`/var/tmp/…/laneC/task5-*`、`task1-synthetic-6copies.log`）：**改动前该文件 authored = 1（6 条全部免单，`--check` 对这次增长毫无反应）；改动后 = 6（只免掉 1 条，按 N-1 记 5 条）**。端到端同一条命令的具名红：变异时 `    edited packages/opencode/src/server/mdns.ts  6` + `✗ surface B (fork, ours) grew: … LOC`，`cp` 还原后同一行回到 `  1`，两轮日志逐文件 diff 只有两处不同——这一处（6→1，我的变异撤销）与并发泳道的 `scripts/install.sh 473 → 476`，其余 205 个文件逐行相同。全树影响（钉在 `580be9a` 的已提交字节上、对每段 diff 同时跑两版实现：`laneC/task1-delta-at-580be9a.log`）：**面 B 5,548 → 5,571（+23），只来自两处真正的复制粘贴**——`packages/opencode/script/publish.ts` 180→191（+11）、`packages/tui/src/routes/session/index.tsx` 181→193（+12），内容全是同一行 `}`/`try {` 反复重加；被排除的 edited 测试另 +1（`packages/opencode/test/config/config.test.ts` 52→53，即"测试 26 文件 1,474 行"那行的 1,475）。面 A 8,601 行不变，比例随分母动：A 23.08%→23.07%、B 14.89%→14.94%。**这 +23 没有 `--record`，金样未改**——闸现在如实报 `✗ surface B grew`，是否承认这 23 行是"我们写的"归维护人判（判法则：那两处复制若确是同一句重排，记 0 才是对的，就该收窄 `debrand` 口径而不是盖基线）。
- **tool-surface 越限播报**：`if (was.ratio <= golden.limit && now.ratio > observed.limit)` 每把面**一生只响一次**，而面 A 记的 23.08% 与面 B 记的 14.89% 都已越过 10%，所以这条对两面**恒假**；旧播报又硬编码只看 `mcpShell`，于是面 B 只印一句"(documented limit 10%)"，既不说过限也不说这条检查已经用掉。现在 `announceOverLimit()` 两面都播、带**记录值→当前值**，并点名 crossing 检查是 LIVE 还是 ALREADY SPENT（判红口径一字未动）。反向控制两面各一条：真金样下 `--check` 出 `! surface B (fork, ours) is over the documented limit: recorded 14.89% → now 15.86% (> 10%)` + `The crossing check for this surface is ALREADY SPENT…`（`laneC/task2-task3-after-check.log`）；把金样**复制一份**改面 A 记录比例为 5.00%（仓内金样不动，probe 副本读 `/var/tmp` 那份）后 `--check` 同时出 `✗ surface A … crossed the documented limit: 5.00% → 22.82% (> 10%)` 与 `… is LIVE and fired on this run — it is reported red above`（`laneC/task2-crossing-live.log`）；`--record` 现在也在落笔前播同一段，不再无声盖一个越限基线。
- **tool-surface 排除清单路径**：成功行与头注释都写 `harness/contracts/kernel-vendor.json`，而**那个路径不存在**（真正被 `existsSync` 命中并读的是 `harness/glasspane-harness/contracts/kernel-vendor.json`）。溯源写成读不到的路径就不可核对，现在打印**本次实际解析到的路径**（`observed.surfaces.fork.vendorManifest`，金样也带）：`  vendored dependency excluded from surface B per harness/glasspane-harness/contracts/kernel-vendor.json (the manifest resolved on this run): 11 files, 1464 lines`。排除逻辑与命名一律未重构（另有泳道在把 fork 从 vendored 内核迁走）。
- **brand-surface：`--record` 不许把"没扫"盖成基线，`--check` 不许把"扫得少"读成进步**。① `missing-product-file` 此前作为普通 hit 进 `hits`，`--record` 照写——installer/product.json/bin shim 一旦改名或删除，"这个文件不再被看"就永久变绿。现在 `--record` 遇其直接拒（exit 1，逐个点名，与"归因失败不得写金样"同一条纪律），确要留洞必须另给显式开关 `--ack-missing-product-file`，且之后每次 `--check` 都重播 `! … is in the golden as NOT SCANNED`。实测：把我备份的 `packages/tui/src/context/editor.ts` 移开 → `--record` 退 1 并点名该文件、**仓内金样 md5 未变**（`laneC/task4-record-refusal.log`）；同状态 `--check` 双红（`missing-product-file ×1 … is new (no baseline)` + 覆盖率那条，`task4-check-missing.log`）；带 ack 的 record 只写 `/var/tmp` 的 probe 金样，随后 `--check` 转绿但把洞重播出来（`task4-ack-record.log`、`task4-ack-check.log`）；`cp` 备份还原后 editor.ts 与 HEAD 逐字节一致、真闸转绿。② 金样钉着 `filesScanned 3310`，`--check` 过去只比 `occurrences` 与 0 命中，**从不比扫描规模**——于是一棵子树消失＝血缘"变好"。取舍：**减才红，增不红**（新增文件是正常干活，红它只会逼人关掉守卫；而增量本来已由 occurrences 棘轮看着），并且**每次都说清覆盖率与方向**：`  lineage coverage: recorded 3310 file(s) → now 3309 file(s) (shrank 1 file(s)) — the occurrence count is a sum over a SMALLER tree` 配 `✗ lineage coverage shrank 3310 → 3309 file(s) (−1): lineage reads 9627 → 9615; that is NOT brand progress, it is 1 fewer file(s) being looked at`；合成金样 `filesScanned 3200`（覆盖率 +110）实测 exit 0 且照打印 `grew 110 file(s)`，金样没有该字段时打印"无法比较，请重记"而不判红（`task4-coverage-grew-clean.log`、`task4-coverage-unknown.log`）。本轮真实树里 occurrences 9,627 → 9,617 而覆盖率仍 3,310——现在这条下降是**可核对的下降**，不再是同一句话的猜测。
- **surface-semantics `threshold-comparison` 操作数顺序**：口径仍是"和小数字面量比较"，但正则只认字面量在右。合成 6 条实测（临时把 `mcp-shell/src/evidence-report.ts` 尾部加一个探针函数，`cp` 备份还原后 md5 逐字节一致）：**改动前 `threshold-comparison ×3`、改动后 `×6`**，`✗ mcpShell: mcp-shell/src/evidence-report.ts — threshold-comparison ×6 (not in the baseline)` 具名红；三条新增咬合的正是原来零命中的 `if (0.5 < ratio)`、`if (0.02 <= changed)` 与 `0.5 < pack.pixelDiff`（`laneC/task5-headlogic-mutated.log` vs `task5-fixedlogic-mutated.log`）。整数仍不 entry：`if (count > 0)`、`if (0 < count)` 改前改后都 0（`laneC/residual-probe.log`），免得淹基线。**现树复跑：0 命中 / 18 文件不变，金样未重记**——这次收窄没有在我们自己的代码里挖出新判定，是干净结果；若挖出来就属于架构信号而非尺子信号。

一条如实挂账的分工：**CI 没有参照克隆，那里能核的只有"我们这一侧"**——`fork-diff --check` 无克隆时比对金样钉着的 fork 侧哈希与 added 文件是否还在（改内容照样红，实测 1 秒，所以它进了 `install-gate`）；`tool-surface` 在离线时把行数降级为上次记录并打印 `NOT re-measured`，而 2026-10-07 起它进一步**拒绝把面 B 断言成在限内**——降级到旧行数的"不假绿"仍然需要一个能被证明为旧的测量，改名识别做不到这件事。**上游字节的复测（6,632 个哈希 + 参照 `ls-files`，约 2 分钟、要背 223 MB 克隆）只在本地/发布前与同步上游时跑**，那是 `SYNCLOG.md` 每次必须留痕的原因。这个分工是设计而不是妥协：把 223 MB 参照塞进 PR CI 的结局是被人关掉守卫。

上游侧那条真检测（新 release → `--probe` → 漂移即冻结）在 `.github/workflows/harness-contract.yml`：每周一次 + 手动可触发，手动输入的 tag 先钳成 `vMAJOR.MINOR.PATCH` 形状、事件数据只经环境变量下发。**这个机制今天在全球范围内都还没有先例**（iterate 侧只有文档承诺），所以它是这条线最先要立住的东西，而不是 fork 代码本身。

还有一条属于"闸的闸"：`scripts/check-workflows.mjs`（挂在 `docs` job 里）检查工作流文件里没有重名 job 键、且每条 `run:` 引用的仓内脚本真的存在（按各 step 的 `working-directory` 解析）。它的来历就是本仓真出过的事故——一次跨 base 的 ci.yml 搬移让 `git merge` 把 `docs:` job 复制成两份，而我最初用 YAML 解析器数 job 数（映射重名键后覆盖前）**看不出任何问题**。看不见不等于不存在，所以这条检查现在机器做，六条负例见 `harness/glasspane-harness/SYNCLOG.md`。
