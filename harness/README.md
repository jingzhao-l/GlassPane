# harness/ — 工具面 B（opencode fork）的仓库侧资产

这里放的**不是 fork 本身**，也不是上游代码的副本。fork 是另一个仓库/另一条 upstream；本目录只承载 GlassPane 侧必须存在、且必须与上游坐标死死对齐的东西：pin、契约闸、以及将来的 patch series。

## 为什么上游代码不进仓

2026-09-24 的调研（`specs/GlassPane_Harness_Fork_调研与方案_v0.1.md` §6.2）实测了另一条路会通向哪里：iterate 侧的 "harness fork" 是 vendored 全量就地改，194 个共享文件里只有 50 个还字节一致，包名也改了——**对上游 rebase 在结构上已不可能**，而它的设计文档仍写着"8 处定点修改"。本仓库不再制造第二个真源。上游参照检出留在仓库外（`/Volumes/Eng-Dev/.upstream/opencode-<tag>`，只读），仓内只存坐标。

## 目录

| 路径 | 作用 |
|---|---|
| `upstream.json` | 上游坐标真源：repo / **pinned tag** / license / 发布节奏 / 参照检出位置 / 该扫哪些目录 |
| `tools/hook-liveness.mjs` | 契约闸：从 `Hooks` 声明反推每个钩子是否真被引擎派发 |
| `contracts/hook-liveness.json` | 金样（由 `--record` 生成，**不要手改**） |

## hook-liveness：它防的是哪一种事故

上游的插件宿主按**名字**派发钩子：`Plugin.trigger(name, input, output)` → `hook[name]?.(input, output)`（`packages/opencode/src/plugin/index.ts:284-298`）。于是"声明了但没人 trigger"的钩子会**类型合法、加载成功、永不运行**。

这不是假想：在 pin 的 `v1.18.32` 上，`Hooks["permission.ask"]`（`packages/plugin/src/index.ts:261`）**全树只出现这一次＝只有声明、零派发**，而上游自己的仓内文档 `packages/core/src/plugin/skill/customize-opencode.md:354` 把它列在"Hook surface"里。任何挂在它上面的权限引导都会看起来正常地完全不工作——这正是"失败无法归因于上游"的那种失效，会让契约测试纪律失去全部价值。

金样当前的判定（`--record` 实测，20 个声明）：**14 live / 5 structural / 1 dead**。structural 那 5 个（`config`/`tool`/`auth`/`provider`/`dispose`）是宿主在初始化期直接读对象字段，不按名派发，因此**不算死钩子**——豁免理由写在 `hook-liveness.mjs` 的 `STRUCTURAL` 表里，每条都点名读取位点。

## 怎么跑

```bash
node harness/tools/hook-liveness.mjs --check    # 对齐 pin：金样 vs 参照检出，漂移即红
node harness/tools/hook-liveness.mjs --probe    # 问"升级到新 tag 会不会伤我们"：HARNESS_UPSTREAM_CHECKOUT 指向那份检出
node harness/tools/hook-liveness.mjs --offline  # 没有上游源码的 lane：只做金样自洽，并大声声明"上游未在此观测"
node harness/tools/hook-liveness.mjs --record   # 换 pin 后重新生成金样（会拒绝版本与 pin 不一致的检出）
```

退出码：**0** 通过（含如实的离线跳过）；**1** 契约漂移（归因＝上游坏，冻结升级）；**2** 工具做不了事（缺 `upstream.json`、缺金样、检出版本与 pin 混用）。

取一份新的参照检出：

```bash
mkdir -p /Volumes/Eng-Dev/.upstream && cd /Volumes/Eng-Dev/.upstream
curl -sSL -o oc.tgz https://codeload.github.com/anomalyco/opencode/tar.gz/refs/tags/v1.18.32 && tar xzf oc.tgz && rm oc.tgz
```

## 闸自己被验过吗

验过，且验它的方式不落仓（脚本在 `/tmp/gp-harness-verify.sh`，破坏性用例跑在 `harness/` 的临时副本上）：① `--check`/`--probe` 对 pin 绿；② `--offline` 绿但**明确声明未观测上游**；③ 把金样里的 `permission.ask` 伪写成 live → `--check` 与 `--probe` 双双 exit 1；④ 删掉金样 → exit 2 并指名 `--record`；⑤ `--record` 重跑得到的 dead 集仍是 `[permission.ask]`，且与仓内金样**逐字节相同**（可复现，不依赖时间序）。

上游侧那条真检测（新 release → `--probe` → 漂移即冻结）在 `.github/workflows/harness-contract.yml`：每周一次 + 手动可触发。**这个机制今天在全球范围内都还没有先例**（iterate 侧只有文档承诺），所以它是这条线最先要立住的东西，而不是 fork 代码本身。
