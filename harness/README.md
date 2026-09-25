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

## 目录

| 路径 | 作用 |
|---|---|
| `glasspane-harness/` | fork 本体。M1 的 `gp_*` 工具面在 `packages/opencode/src/tool/glasspane/`，唯一被改的 vendored 文件是 `.../tool/registry.ts`（3 个 hunk） |
| `glasspane-harness/FORK.md` / `SYNCLOG.md` | fork 自己的坐标、不可谈判的两条不变量、每次同步的实测数字 |
| `upstream.json` | 上游坐标真源：repo / **pinned tag** / license / 发布节奏 / fork 位置 / 参照检出位置 / 该扫哪些目录 |
| `tools/hook-liveness.mjs` | 契约闸：从 `Hooks` 声明反推每个钩子是否真被引擎派发 |
| `tools/fork-diff.mjs` | 分叉尺子：fork 全树 vs 参照，逐文件 blob 哈希，identical/edited/added/deleted 四桶，与金样比对 |
| `tools/tool-surface.mjs` | 工具面占比棘轮：engine 与两个工具面的 LOC 比例，只挡"没被记录的增长" |
| `contracts/hook-liveness.json` | 金样：20 声明 → 14 live / 5 structural / **1 dead（`permission.ask`）** |
| `contracts/fork-diff.json` | 金样：声明过的分叉面（当前 `6631 identical / 1 edited / 5 added / 0 deleted`） |
| `contracts/tool-surface.json` | 基线：engine 17,197 / A 3,719（17.33%）/ B 539（2.51%） |
| `spike/` | E1/E2/E5/E6 的运行时探针与离线 mock 模型（`run.sh` 一键；结论见调研方案 §5.0） |

金样一律由 `--record` 生成，**不要手改**。

## 三把尺子各防哪一种事故

**hook-liveness** — 上游宿主按**名字**派发钩子：`Plugin.trigger(name, input, output)` → `hook[name]?.(...)`（`packages/opencode/src/plugin/index.ts:284-298`）。"声明了但没人 trigger"的钩子于是**类型合法、加载成功、永不运行**。pin 的 `v1.18.32` 上 `Hooks["permission.ask"]`（`packages/plugin/src/index.ts:261`）全树只出现这一次＝零派发，而上游仓内文档 `packages/core/src/plugin/skill/customize-opencode.md:354` 却把它列在"Hook surface"里。structural 那 5 个（`config`/`tool`/`auth`/`provider`/`dispose`）是宿主初始化期直接读字段，不按名派发，因此**不算死钩子**；豁免理由写在 `hook-liveness.mjs` 的 `STRUCTURAL` 表里，每条点名读取位点。

**fork-diff** — iterate 侧的真实教训不是"改了 144 个文件"，而是"文档写 8 处定点、树里 144 处、且没有任何机器检查发现这件事"。定制多少不是问题，**不知道定制了多少才是问题**。所以每个文件比 blob 哈希（"只改了空白"藏不住，符号链接与模式也算），四桶清单进金样，漂移即红。**光有名单还不够**：名单以文件名为单位，"已经在名单里的文件又长几行"它天生看不见（实测如此，见下条负例）。金样因此对每个 edited 文件另钉**上游哈希 + 我们的哈希**，内容漂移与名单变化同级现形。

**tool-surface** — 三条架构铁律里唯一带数字的那条（工具面 <10% 代码量）此前只是散文：实测工具面 A = 3,719 / 21,455 = **17.33%**，而仓库里没有任何东西能发现。做成**棘轮**：允许增长，不允许没人注意到——超基线即红，出路是同批 `--record` 并在提交里说清为什么。A 的越限是既有事实，金样如实记着，闸只保证它不再变大。

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
```

退出码：**0** 通过（含如实的离线跳过）；**1** 契约/分叉/占比漂移；**2** 工具做不了事（缺 `upstream.json`、缺金样、检出版本与 pin 混用）。

## 闸自己被验过吗

验过，每次都是"反向破坏 → 必须变红"的因果验证，而不是"跑过了"。破坏脚本不落仓（本次跑在 `/var/tmp/glasspane-harness/`，日志同名目录）：

- hook-liveness：① `--check`/`--probe` 对 pin 绿；② `--offline` 绿但**明确声明未观测上游**；③ 金样伪写成 `permission.ask` 是活的 → `--check` 与 `--probe` 双双 exit 1；④ 删金样 → exit 2 并指名 `--record`；⑤ `--record` 重跑与仓内金样**逐字节相同**。
- fork-diff：未记录的自有新增 → 报 `added` 并 exit 1；`--record` 后转绿；给 vendored 文件加一行 → 报 `1 edited` 且**点名该文件**；从参照还原 → 转绿。**内容级**：给已在名单里的 `registry.ts` 再加 3 行，名单不变但金样钉着的 fork 侧哈希变了 → **exit 1 点名 "our content moved"**（同一步在加哈希钉之前是绿的，日志 `/var/tmp/glasspane-harness/blind-spot.log`）；拿**没有哈希字段的老金样**跑 → exit 1 并指名 `--record`。把参照克隆藏掉（＝CI 形态）后仍核我们这一侧：清树 exit 0 并报 `1 edited hash-checked, 5 added present`、`registry.ts` 加 2 行 exit 1、金样被剥掉哈希 → **exit 1 直说"这条 lane 无事可控"**、删一个 added 文件 → exit 1。参照克隆被中途杀过，所以另验 `git fsck` 无错 + 工作树干净 + `describe` == pin。
- tool-surface：给 `mcp-shell/src/tools.ts` 加 3 行 → A 报 `+3` exit 1；给我们的 fork 文件加 20 行 → B 报 `+20` exit 1；给 **edited** 的 `registry.ts` 加 3 行 → B 报 `+3` exit 1（证明 `+N` 是真的对着参照重算的）；还原 → 转绿；藏掉参照克隆 → exit 0 但**打印 "NOT re-measured"**；删 `fork-diff.json` → **exit 1**（量不到 ≠ 过关）；`--record` 重跑逐字节相同。三条文件 MD5 前后一致，`git status` 零残留。

一条如实挂账的分工：**CI 没有参照克隆，那里能核的只有"我们这一侧"**——`fork-diff --check` 无克隆时比对金样钉着的 fork 侧哈希与 added 文件是否还在（改内容照样红，实测 1 秒，所以它进了 `install-gate`）；`tool-surface` 在离线时把 vendored 文件的**行数**降级为上次记录并打印 `NOT re-measured`，不假绿。**上游字节的复测（6,632 个哈希 + 参照 `ls-files`，约 2 分钟、要背 223 MB 克隆）只在本地/发布前与同步上游时跑**，那是 `SYNCLOG.md` 每次必须留痕的原因。这个分工是设计而不是妥协：把 223 MB 参照塞进 PR CI 的结局是被人关掉守卫。

上游侧那条真检测（新 release → `--probe` → 漂移即冻结）在 `.github/workflows/harness-contract.yml`：每周一次 + 手动可触发，手动输入的 tag 先钳成 `vMAJOR.MINOR.PATCH` 形状、事件数据只经环境变量下发。**这个机制今天在全球范围内都还没有先例**（iterate 侧只有文档承诺），所以它是这条线最先要立住的东西，而不是 fork 代码本身。
