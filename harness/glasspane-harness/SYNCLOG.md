# SYNCLOG — glasspane-harness 与上游的同步记录

一次同步一条，倒序。每条必须给出：**改动面数字**（`fork-diff` 输出）、**跑了哪些闸、结果如何**、**没跑的部分照实写没跑**。

## 2026-10-12 · 每日批次（harness 线，第四次会话）：能力闸问错了对象、被拒的调用画成"还在跑"，发 0.7.6

**开工态**：主树 HEAD 开工时 `5f0fb54`（== origin/main）、整树干净；约一小时后并行会话把 main 推到
`2e83542` 并持续写入，**我第一轮闸读数被它的未提交编辑污染**（`kernel-conformance.mjs` 396→441、
`publish.ts` authored 198→240 全是它手上的活），于是改用隔离工作树
`/Volumes/Eng-Dev/.worktrees/gp-harness-daily-20261010`（`.external/opencode` 做成指回主树的符号链接，
不各存 223 MB）。中途该工作树被并行会话 `git switch` 走去做 `gp-harness-orphan-20261010`（`a054fdc`）的
收口，我那两笔 `install.sh` / `installer-selftest.sh` 被那笔 wip 提交收走。
**取号过程**：按新提示词第 2 条以内容判据重取基准（`git fetch --prune` + 逐文件比对，不看分支名也不看
提交信息）→ `c3dbfee` → 再到 `185c095`。我这九处里**五处主线已有另一种实现**（根 `script/publish.ts`
死路、`no-foreign-publish`、`readCode`、corpus 形状、`verify-published` 读已装 manifest）——不重复、
不覆盖；并的是主线仍缺的六处。`0.7.5` 被同日第三次会话占用，而它当时"已提交未发布"（split 无 tag、
npm live 仍 0.7.4），同号并发＝当年 0.5.0 那笔版本号被 stage 烧掉的成因，所以本批先挂 `[Unreleased]`
让号；随后实测 `v0.7.5` 两条通道全部落地（npm 三个包均 0.7.5；Release 两条 run completed/success），
通道空出才按 patch 取 **0.7.6**。

**前置**：bun 1.3.14 == `packageManager` 钉值；参照检出 `describe` == pin `v1.18.32`、`fsck` 无错、
工作树干净；preflight 不带 `NODE_EXTRA_CA_CERTS=/var/tmp/glasspane-harness/ca-bundle.pem`（163 张）时
exit 1、带它 exit 0，两条方向都实测；全程没有使用任何跳过证书校验的开关。

**改了哪些**：`tool/glasspane/index.ts`（能力闸第三参删除，`gp_attach` 不再被 `"observe"` 代表；
`gp_diagnose`/`gp_last_evidence` 不加闸的理由写进代码）、`packages/tui/src/routes/session/index.tsx`
（row→props 映射抽成导出的纯函数 `glasspaneRowLook`，`denied` 算已结束、⊘ + warning + 可按开）、
`script/glasspane-e7-ledger.ts`（恒真谓词拆两条）、`plugin/glasspane-compaction.ts`（维度覆盖声明按
as-shipped 改写 + 一条走真路径的钉子测试）、`harness/tools/hook-liveness.mjs`（`--offline` 不再谎报
"检出缺席"）、fork `release.yml`（注释不再声称五个原生目标）、`CHANGELOG.md`（0.7.4 条目里 116 处
模板字面量转义剥掉，全文转义残留 0）、版本线两处 + `bun.lock` 那条停在 0.7.3 的包 `"version"`。

**改动面数字**：`fork-diff --record` 对 `v1.18.32` = **4665 identical / 262 edited / 82 added /
1705 deleted**；`tool-surface --record` 面 A **8975 行 / 22.20%**（未变；比例降只因分母动）、面 B
**6736 行 / 16.66%**（记录值随本批的行上调，逐文件归因见下）、测试排除 28 文件 / 2027 行、
`iterate-kernel@0.1.5` 作为依赖不计入面 B；`brand-surface` 血缘 **9623 / 3303 文件**，与基线逐字相同
（0 命中、覆盖率未变，故不重记）。面 B 的增量全部来自本轮点名的四个文件：
`packages/tui/src/routes/session/index.tsx`、`packages/opencode/src/tool/glasspane/index.ts`、
`packages/opencode/script/glasspane-e7-ledger.ts`、`packages/opencode/src/plugin/glasspane-compaction.ts`
——`--record` 是在"整棵树只有我这一笔"的隔离工作树里做的，别人未提交的行没被洗进基线。

**跑了哪些闸**：`product-surface` **123 条一致 / 0 问题**（98 → 123 是第三次会话新增的断言，不是本批）；
`surface-semantics` 0 命中 / 18 文件；`hook-liveness` 21 钩子对齐 pin 无漂移；`kernel-pin --check`
0.1.5 + 24 契约文件逐条 sha256 对、`--probe` 回"0.1.5 就是已发布的最新"；`kernel-conformance` 14 条
fixture 全对；`installer-selftest.sh` 全过（含三条"跟随重定向"的 fetch 断言）；`packages/tui` 固定点
**26 pass / 0 fail**；`packages/opencode` **90 pass / 1 fail**——唯一那条是下面这条不稳定对照；
typecheck opencode 绿；主仓 `check-workflows --self-test` 6/6 各证能红、`check-workflows` 5 个
workflow 干净、`check-doc-links` 24 文档 / 225 内链 OK。

**一条判为不稳定对照、没有修掉的计时断言**：`test/tool/glasspane-surface.test.ts` 的
"an over-sized engine frame is refused in-band"。同一棵树上多次读数：旧基准两次绿（单条 24.19s /
26.96s，距它自己的 30s 预算只剩 3 秒）、旧基准整包一次红、新基准整包红（30121ms）、新基准单跑也红
（两条用例花 199s）。红时的形状都是 `Daemon.call(…, 30_000)` 先到期 → 报 `GP_E_ENGINE_TIMEOUT`
而不是期望的 `GP_E_PAYLOAD_TOO_LARGE`，也就是那 4 MiB 帧在本机负载下没能在预算内写完。
**判据没改、超时没加**：加超时只会让计时器照样先到，改判据等于把它要问的问题扔掉；把它写成
"复跑证明是假红"就是本仓最常见的那种自我原谅。发版凭据因此取**该 sha 在干净 runner 上的 CI**
（fork `.github/workflows/ci.yml:49` 正是这条命令），而不是高负载下的本地读数。

**尺子自身的反向路径**（本批改过的尺子只有 `hook-liveness`，三条重验，不沿用旧结论）：金样伪写
`permission.ask` 为 live → `--check` exit 1 点名 `dead-hook set changed: golden=[] now=[permission.ask]`
加 2 条 drift——**第一次的 perl 没落地，那条控制当场作废重做**（`grep` 证明 dead 计数没变，才承认
控制生效）；删金样 → exit 2 指名 `--record`，不是绿；藏本工作树的参照符号链接 → `--check` exit 2 给出
`--offline` 出路，`--offline` exit 0 且明说"那个路径没被打开过"，还原后重新绿在 21 钩子无漂移。
撤销一律自建备份 + sha256 核回，不用 `git checkout`/`stash`；`/var/tmp/gp-harness-daily-20261010/mut/`
留着每一步前后日志。

**没跑 / 未观测**：整包构建（>10 分钟，闸的形状不含它）；`kernel-conformance --impl`（本轮没读
canonical 检出）；真 TUI 会话里的观感（含本批新画的 ⊘ 拒绝行）；真模型轮次；`gp_*` 对活 daemon 的
实跑（daemon 在跑，但本轮没驱动任何 `gp_*` 调用）。继续挂账的功能缺口：引擎方法表 11 个可使能力里
fork 只发了 6 个（缺 `assert_element`/`audit_ui`/`capture_view`/`snapshot`/`restore`），而
`gp_observe` 的文案正叫模型"别用眼睛比树"——新增工具属产品面变化＝minor，不在 patch 这批里做。

## 2026-10-12（第四次会话）· 面 B 那 90 分钟有了成因；发布闸不再用墙钟裁产品；本轮不发版

**收的是上一轮的尾**：0.7.5 发完之后 main 上还压着三笔未记录/未验证的变化（b004813 改了
`verify-published.ts` 的判据、d8b1892 修我自己推上去的 3× TS2451、金样因"一趟 90 分钟"一直
没补）。这一批全在**闸与尺子**这一侧，产品字节一行未动。

**决定：不发新版本**（依据与回滚都在下面，不留成"待裁决"）。本轮内容与发布物字节零交集
（改的是尺子层与 dev-only 的发布脚本），所以不该占用一个用户可见的号。
**并进来时那条线已把号取到 0.7.6**（`product.json` 与 `packages/opencode/package.json` 两处都是
0.7.6，在 main 上），但**实测它还没落地**：split 仓 `main` 与 tag 仍是 `61b15d6` = `v0.7.5`，
registry 上 `glasspane-harness` / `-darwin-arm64` 的读数也仍是 **0.7.5**。于是当前的形状是
"main 领先发布面一个号"，那一个号归它的批次（能力闸 + 被拒调用的呈现），我的两笔 `[gp]` 排在
它后面进树、随下一次发布一起出去——**不是我另取一个号**：两条线共用一条版本线，同号并发正是
当年 0.5.0 那笔版本号被 stage 烧掉的成因。
回滚本轮只需 `git revert f9a0fb2 d10e99e`（尺子层与发布脚本各自独立，无发布动作需要撤）。

**面 B 的 90 分钟找到了成因**（`harness/tools/ref-batch.mjs`，d10e99e）。不是负载，是**成本模型**：
`tool-surface` 每问一句上游就 spawn 一次 `git show`——216 个 `edited` 各一次，"这是不是一次纯
改名"的探针又把**每个同扩展名的上游删除文件**按 `added` 文件逐个重读（3,829 次），合计
**4,045 个子进程覆盖 682 个不同 blob（10.0 MB）**。load 88 时单 spawn ≈1.3 s ⇒ 一趟 ≈90 分钟，
且 `build()` 之前一行不打印，无人值守时与"卡死"不可区分（另一支同一命令跑到 4 h 50 m 无输出，
上一轮的 `--record` 记成"77 min 墙钟 / 3 min CPU"也是这同一条）。改管道不改判据：
`cat-file --batch-check` + `cat-file --batch` 两次子进程按 size 分帧读回，其余（utf8 落临时文件、
`diff -u`、去品牌一对一配对、缺路径读 `null`）一字未动。实测同一棵树 **7 分钟**出全量报告。
等价性两条都取了指纹：① `ref-batch-selftest.mjs` 从 fork-diff 金样定步长抽 24 条
（`edited`/`deleted` 各 12、覆盖 9 种扩展名）与 `git show HEAD:<path>` **逐字节相等**，缺路径＝
`null` 而非 0 字节；两条反向控制各自具名红（期望值翻 1 bit、把分帧前进量 `+size+1` 写成 `+size`
的阉割版解析器）——实测 rc=0。② 整树对账：新实现报出的 **216 个 edited + 14 个 added 的每一个
行数，与旧实现当年记进金样的数相同**，`--check` 全场只点一个动过的文件。

**发布闸的第三种答案**（`packages/opencode/script/verify-published.ts`，f9a0fb2）。旧形状两次把
一次好发布判成坏发布：墙钟 15 s 那版印 `no response`，事件门 180 s 那版印
`no "listening on" line within 180s` 却仍走 exit 1 并写"the release is NOT good"。本轮把
**已发布的 0.7.5** 手测一遍：`listening on` 在 **326 s** 后出现（load 88），随后
`Content-Type: text/html` + 2,884 字节 `<!doctype html>` + 2 处 `/assets/` 引用——发布物是好的，
错的是拿墙钟裁它的判据（日志 `/var/tmp/gp-sess4-handserve.log`）。现在三态：
exit 0＝听到 listening 且页面是打包产物；exit 1＝听到 listening 却供不出页面（坏发布，别重跑）；
exit 2＝`NOT OBSERVED`（机器的成因，沿用本文件已有的"这台机什么都验不了"语义），预算 900 s。
`GLASSPANE_VERIFY_LISTENING_POLLS` 只能把预算改**短**——改短只会少看见，不可能造出假绿。
`--prefix <dir>` 是为了让 FAIL 分支**可执行**才加的（npm 安装实测 21 分钟，错误页没法靠真发布物
造出来），它会打印自己跳过了安装。`harness/tools/verify-published-selftest.sh` 用三个假前缀
驱动三条分支 + 一条"位置参数真被吃了"的控制，实测 8 条断言全中 rc=0；
把页面判据阉成 `/<html/i` 的副本（`VP_GATE=` 指过去，真文件不动）喂同一条测试 ⇒
**2 条具名红 + rc=1**（`/var/tmp/gp-sess4-mut.log`）。
这条测试自己红过两次，两处都留在测试里并写明：`run_case` 漏赋值 `$1..$3` ⇒
`grep -qF ""` 对任何输出都成立、三个用例跑的其实是同一个假发布物还报绿（现在期望串为空即判
FAIL——**夹具必须能拒绝**）；断言改用 shell 子串匹配而不是 `grep`，因为闸的文案里有 em dash，
grep 会把这种管道输入当"二进制"而停止匹配。
同一笔里还抓出我自己刚写进去的解析 bug：`--prefix` 缺席时 `flagAt == -1`，无条件
`i !== flagAt + 1` 会把位置参数当标志值丢掉 ⇒ `verify-published.ts 0.7.5` 会去验
`product.json` 的版本却打印 0.7.5；由那条 9.9.9 控制钉住。

**金样（`harness/contracts/`，记的是并入后的那棵树）**：`fork-diff` 四桶
**4,665/6,714 逐字节相同、262 edited、82 added、1,705 deleted**（桶计数与 d8b1892 上那次
`--check` 相同——两条线都没有增删 fork 树里的文件，`ref-batch*` 与
`verify-published-selftest.sh` 都在尺子层）；`tool-surface` 记
**engine 25,033 / 62 文件，面 A 9,119 LOC（22.26%）、面 B 6,893 LOC（16.61%）**，
测试排除 28 文件 / 2,163 行。逐文件归因是**对旧金样重算差值**算出来的，不照提交信息抄，
三批各归各：
- 面 B 本 lane 一处：`packages/opencode/script/verify-published.ts` 206 → 287（+81），
  即 b004813 的 +7 与本笔的 +74；其余 216 个 `edited` 与另外 13 个 `added` 的行数与旧金样
  逐一相同——这一段同时是 d10e99e 那次改管道的等价性证据（新实现复算了旧实现记进金样的
  每一个数）。
- 面 B 另一条 lane 四处（随 0.7.6 那批并进来）：`packages/tui/src/routes/session/index.tsx`
  210 → 252（+42）、`src/tool/glasspane/index.ts` 357 → 371（+14）、
  `script/glasspane-e7-ledger.ts` 142 → 155（+13）、`src/plugin/glasspane-compaction.ts`
  339 → 346（+7），合计 +76。两批的号第一次在这棵树上合流，所以金样按**合并树**重记。
- 面 A +144（8,975 → 9,119）分 8 个文件（`engine-client.ts` +50、`update-state.ts` +34、
  `io.ts` +23、`tools.ts` +20、`http-gateway.ts` +6、`errors.ts` +6、`index.ts` +4、
  `project-registry.ts` +1），来自并入的 1.13.0 那批（`mcp-shell/src/*`）；分母 engine 相对
  金样 +284（24,749 → 25,033）同一批——**这两段没有一行是本 lane 写的**。
`--record` 在这里不是掩盖：这些字节都已经在 main 的树上，棘轮的职责是"增长不许没人注意到"，
注意到的方式就是把归属逐文件写进这一行；不记的另一种出路是让每条 CI 停在一件已经发生、
且无人记账的事上。

**发布面读数（复核，不是本轮动作）**：split 仓 `main` = `61b15d6` = tag `v0.7.5`；
registry `glasspane-harness` / `-darwin-arm64` / `-darwin-x64` 三格实测 **0.7.5**、
`latest` 0.7.5；`verify-published 0.7.5` 在本机（load ~104）跑出的结果是安装/两条命令
`--version`/已安装包清单的 os·cpu·version/registry integrity 全 ok，web 那一条
`NOT OBSERVED`（exit 2）——**这一格由手测补**，见上。
本轮之后 main 又前进了三笔，split 仓的 `main` 需要跟着同步（不含新 tag、不触发发布）。


## 2026-10-11（第三次会话）· 文案还在替上游说话、平台包发布没跑自家校验，发 0.7.5