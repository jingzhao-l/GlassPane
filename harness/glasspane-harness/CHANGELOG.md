# Changelog

All notable changes to **glasspane-harness** (the product) are recorded here. The
per-batch measurements of the *fork* live in `SYNCLOG.md`; upstream opencode's own
changelog is not this file's subject.

The format follows [Keep a Changelog](https://keepachangelog.com/); the product uses
semantic versioning starting at `0.1.0` (pre-1.0: the surface may still move, the evidence
contract does not).

## [Unreleased]

<!-- 内容归入下一版；此处留空以备下一批。 -->

## [0.7.1] - 2026-10-09

判据（pre-1.0）：**patch** —— 本轮没有新增命令、没有改 CLI 形状、没有动参数；改的全是
"报告与实测不一致"。产品面与安装通道形状不变，证据契约（判定仍全在 Swift、错误帧仍
`{code,message,remedy}`）一条没动；`brand-surface` 血缘计数 9,627 → **9,617**（减 10，
去掉 brew/choco/scoop 与上游仓库那些字面），棘轮只许减不许增，方向对。

这一批来自两条审查泳道（定制面正确性 + 发布/供应链）与一次尺子自检。重点仍是**有几道闸
绿着却红不了**，以及**有几处把没做过的事说成做过**。每条修复都给反向证据（破坏被修的点 →
具名用例或某把尺子必须变红），口径见 `harness/README.md`「闸自己被验过吗」的 2026-10-09 段。

### Fixed — 发给模型与用户的话

- **升级路径向上游的基础设施要版本号。** `installation/index.ts` 的 `latest()` 在非
  npm 通道上落到 `api.github.com/repos/anomalyco/opencode/releases/latest` 并回上游的
  `tag_name`；而 `method()` 对我们自己的 install.sh 兜底装出来的位置正好回 `"curl"`，
  且 `cli/upgrade.ts` 在 `method === "unknown"` 守卫**之前**就发了这个请求，`upgrade()`
  每次 TUI 启动都跑。于是产品把上游的发布号当"可更新版本"报给自己装出去的用户。同段还去查
  `formulae.brew.sh/.../glasspane-harness.json`（我们没发这个 formula）、Chocolatey
  `Id eq 'opencode'`、Scoop 桶 `opencode.json`（后两个是上游包名）。现在只认两条真发过的
  通道（npm 家族读配置 registry 上的本产品包，curl 读 `jingzhao-l/glasspane-harness` 自己的
  releases），其余通道回 `NoUpdateChannelError`，**请求根本不出进程**。
  `docs/migrate-from-opencode.md` 那句"curl 自升级路径已去掉"与代码不符，按实测改写。
- **引擎忙 = 告诉模型"这个方法这个引擎没有"。** `requireCapability` 把
  `probeCapabilities() → null` 一律映射成写死的 `GP_E_CAPABILITY_UNAVAILABLE` 加
  "start or update the background service"；但 `hello()` 对任何非 ok 回帧都回 null，
  **包括** `GP_E_ENGINE_TIMEOUT`，而 daemon 是单连接的——槽位一忙，每条 `gp_*` 都被说成
  能力缺失，还被指去重启一个正常运行的服务。现在引擎给了什么就转达什么，只有真正确认过
  "没宣布过"才说不支持。`daemon.ts` 里 `{"error": "<字符串>"}` 那种帧被记成"既不是结果也
  不是错误"的错账，一并改正（拒绝不变，指错的条款变对）。
- **TUI 把没有引擎结论的一行画成有结论。** `glasspaneRow` 只对 `meta.ok === false` 走
  拒绝分支，其余一律 `success`；`registry.ts` 给任何插件工具塞
  `metadata: {...metadata, truncated}`，一个返回字符串的 `gp_*` 插件工具到手就是 `{}`，
  而 `toolDisplay` 把所有 `gp_` 开头的 id 都送进这条分支。新增 `no-verdict` 态（`?` +
  warning 色），只转达"这里没有结论"；判定仍然只在 `glasspaned` 那一侧。
- **curl 那条拒绝的话写在跑不到的字段上。** `upgradeCurl` 把 remedy 写进 `stderr`，统一
  出口随后用 `upgradeFailure(m, upgradeResult)` 覆盖成 `Upgrade failed for curl (exit code 1).`
  ——为"过滤抓来的脚本输出"而设的净化器把产品自己的那句话也滤掉了。现在原样送达；
  `cli/cmd/upgrade.ts` 那个无守卫的 `await Installation.latest()` 也不再让新错误从 yargs
  `.fail()` 裸抛。

### Fixed — 装到用户机器上的东西

- **兜底安装给一条根本没跑起来的命令打 [OK]。** 收尾用 `command -v` 验 PATH 上最先撞见的
  那份拷贝（本机实测：它指着一次旧安装给了绿，而这次装进去的是占位桩），再
  `"$BIN" --version 2>&1 | head -1` 配 `|| true`——管道状态是 `head` 的，连那个也丢了。
  占位桩往 stderr 道歉并 exit 1，于是打成 `[OK] … --version -> Error: … postinstall was
  not run.` 且退出 0。现在按安装通道定位这次真写进去的文件，退出码取命令本身。
- **验签失败照样装。** `GPG_STATE="FAILED (…)"` 后面只 warn 就 return 0，而这条路径上另一
  道检查 SHA256SUMS.txt 与资产同源。"没发布 .asc / 机器没 gpg"照旧是策略缺口（只警告，
  0.6.4 定的策不变）；"验不过"、"不是那把钥匙"、"拉签名不是 404 地失败"三类现在是篡改
  信号，拒装。`.asc` 的 404 与传输失败此前被 `curl -f` 折成同一件事，现按 HTTP 状态分开。
- **指纹只在注释里，没人断言。** 装钥与验签只要求 `grep -q GOODSIG`，任何一把能做出好签名
  的钥匙都算过。`VALIDSIG` 的完整 40 位现在必须等于安装器自带的指纹，不等就点名两把指纹
  并拒装。`gpg --import` 那条裸管道在 `set -e` 下会让安装器只留一句 gpg 的 stderr 就死掉且
  把临时钥匙环留在盘上，照 `--verify` 已有的写法收进 `if`，从创建起每条出口都清理。
  安装器自检从 31 条断言扩到 **51 条**，全部实测；三处旧夹具改为真形状（curl 桩回 HTTP
  状态码、gpg 桩补 `VALIDSIG` 全指纹行、发布物里的二进制打纯版本号——对已发布 0.7.0 实测
  `--version` 就输出 `0.7.0`）。

### Fixed — 发布链路与尺子

- **任何发布失败都被说成"staged-only 拒了直接发布"。** 平台包那条 `npm publish || { notice;
  npm stage publish .; }`、wrapper 那条 `if ! publish.ts; then …`，把 E401/404/5xx/打包问题/
  E409 重复版本（0.5.0 真踩过）全折进同一分支；而 `product.json` 记着 trusted publisher
  至今是 `owner-action: not yet configured`，也就是说这句归因当前从来不是真因。现在留住退出码
  与原始输出，只有日志真说"staged/trusted publisher"才降级，且明写 `STAGED, NOT PUBLISHED`。
- **checksums 把下载失败吞了**（`gh release download … || true` + 只判目录非空），两平台只
  到一个也能产出一份看着完整的清单；现去掉 `|| true` 并按 `product.json` 的 platformTargets
  逐个点名，缺一个就拒写。清单同时写明它**不**证明什么：算的是 GitHub 供回来的字节，
  担保"存的就是这些"，不担保"构建产出的就是这些"。
- **`gh release create` 没有 `--target`**，Release 记的是分支不是被 tag 的 commit（v0.6.4
  实测 `targetCommitish=main`）。现钉到 `$GITHUB_SHA`。四条 job 级 `if` 全部显式写成
  `success() && …`——"显式 `if` 是否替换隐式 needs 成功条件"这一条本轮没能从官方文档取证，
  所以不依赖那个未证实语义。
- **publish.ts 的校验只在 `--dry-run` 跑**，真正发布那条路一条断言都不做（而它自己的注释写着
  "checked before it can be published"）。现在两条路径都校验。反证：造一个有 package.json、
  无 `bin/glasspane-harness` 的平台包 → `--dry-run` exit 1 并点名缺件。
  残留如实记：wrapper 那几个文件是 publish.ts 自己写完再查自己，删掉 README 也会被重新生成，
  所以这条对 wrapper 近于自证；真正能咬的是 build.ts 产出的平台包——而 release.yml 现在仍用裸
  `npm publish` 发平台包，绕过 publish.ts，那一侧的闸本轮没接上。
- **npm 钉住了，而且是有证据地钉。** 上一条提交写"0.7.0 用的哪个 npm 已从 job log 查不出来"，
  只对一半：log 里没有，registry 有——已发布 0.7.0 wrapper 的元数据记着
  `_npmVersion: 12.2.0`、`_npmUser: GitHub Actions <npm-oidc-no-reply@github.com>`。
  三个发布 job 据此钉到 `npm@12.2.0`，版本仍照打。
- **verify-published 三条"过不了也报过"**：非 macOS 分支原断言 `exitCode !== 0`，离线/代理/
  404/npm 不存在(127) 全满足 → 改为显式拒答（exit 2，"什么都没验证"）；只查 `product.binary`
  一个命令 → 改为遍历 `product.bins` 并要求 `--version` exit 0 且等于版本号；"内嵌 web 已供出"
  原来正文里有 `<html` 就算过（错误页也满足）→ 改为 content-type + doctype + `/assets/…` 三项。
  registry 显式点名，integrity 断言与 provenance 分开写。对本机已发布的 0.7.0 实跑：全绿，
  `dist.attestations.provenance` 挂着 SLSA v1 predicateType。
- **preflight 的 `openssl verify` 只吃链里第一张证书**，中间证书既没当 untrusted 也没当 CA，
  一条本可通过的链会读成 FAILED；改为 leaf + `-untrusted`，并删掉算了却没用的 `issuer`，
  把 `ghostty-web` 的出处从 `build.ts` 改对到 `packages/app`。两条方向都实测：163 张束 → OK/0，
  158 张系统根 → FAILED/1 并给出正确 remedy。
- **三把尺子的假绿口径**：`tool-surface` 里 `let ri = 0` 从不前进，一条删除行可以免掉任意多
  条新增行（40 份改了品牌的复制行记 0）；面 B 越过书面 10% 却没人说（跨限判定对已超限的基线
  恒假，那句 "already over" 只写给面 A）；排除清单的出处打在屏幕上是**不存在的路径**。
  `brand-surface` 的 `--record` 会把"这个文件没被扫到"写成绿色基线，`--check` 从不比对扫描
  覆盖（子树消失＝血缘计数下降＝看着像进步）。`surface-semantics` 的阈值规则只认一种操作数
  顺序（`ratio > 0.5` 命中，`0.5 < ratio` 记 0）——两侧都认之后本树仍 0 命中/18 文件，
  **没有**为此重记金样。
- **SECURITY.md 那句 "npm releases carry provenance in CI (Trusted Publisher, staged-only)"
  三个限定词两个半不成立**，按实测改写；并补上此前四份文档里一个都没出现的"怎么验你装到的
  东西"（SHA256SUMS、`.asc`、GPG、`npm audit signatures`），以及一条边界：CI 那边仍是
  "secret 里是什么就用什么"，**没有任何一步证明发布用的私钥就是安装器断言的那把**，所以
  安装器是执法点而不是 CI 步骤。

### Measured — 本轮收口时各闸的实际数字

engine 23,209 LOC / 60 files；面 A `mcp-shell/src` 8,652 LOC = 22.85%；面 B（fork 内我们写的）
6,007 LOC = 15.86%（书面限制 10%，两面都超限且如实标注"跨限判定已用尽，还在守它的是 LOC
棘轮"）；测试排除 27 files / 1,718 lines；vendored 排除 11 files / 1,464 lines（清单出处
`harness/glasspane-harness/contracts/kernel-vendor.json`）。
`fork-diff`：4,667/6,746 byte-identical，260 edited，114 added，1,705 deleted。
`brand-surface`：26 product files + 2 docs，0 hit，血缘 9,617 / 3,310 files（覆盖不变）。
`surface-semantics`：0 hit / 18 files。`product-surface`：88 agreement / 0 problem @ 0.7.1。
`hook-liveness`：21 hooks against v1.18.32，no drift。`kernel-vendor`：25 files / 84,308 bytes
@ `2ed342b`，与溯源清单一致。`kernel-conformance`：8 fixtures ok。
固定点测试：`packages/opencode` 80 pass / 0 fail（305 expect），`test/installation`
13 pass / 0 fail，`packages/tui` 24 pass / 0 fail（8 snapshots，67 expect）；
四个发布包 `tsgo --noEmit` 各 exit 0。安装器自检 51 条断言全过。

金样本轮**同批 --record 两次**并在此说清长了多少、为什么：`fork-diff.json` 的 edited
258 → 260（`script/verify-published.ts` 与 `src/cli/cmd/upgrade.ts` 首次进入分叉记录面），
`tool-surface.json` 面 B 5,548 → 6,007（+459：其中约 +23 是**配对规则修正后重新计费**的
既有重复行，不是新写的代码；其余是本轮 install.sh/publish.ts/verify-published/尺子与测试
的真实新增）。面 A 的 +51 来自同日 main 上 1.9.0 那批 mcp-shell 改动，不是本线。


## [0.7.0] - 2026-10-07

判据（pre-1.0）：**minor** —— 用户可见的安装器 CLI 形状（`--version <值>`、`--help`、
Intel Mac 的兜底通道）与同目录配置优先级都变了，不是纯修复。证据契约（判定仍全在
Swift、错误帧仍 `{code,message,remedy}`）一条没动。

这一批同样来自一次全面审查（正确性 + 发布/供应链两条泳道），但重点不在"改了多少行"，
而在**有几道闸当时是绿的却红不了**——逐条给出破坏证据后才算修完（口径见
`harness/README.md` 的「闸自己被验过吗」）。

### Fixed — 发给用户的东西

- **兜底安装器在 Intel Mac 上把自己拒了。** `uname -m` 报 `x86_64`，而白名单只收
  npm 词表里的 `arm64|x64`，于是在写着"this product ships darwin-arm64 and
  darwin-x64"的那一行拒绝了一台正好是 darwin-x64 的机器。加了 `x86_64→x64` /
  `aarch64→arm64` 的映射层，其余架构照旧明确拒绝。
- **安装器宣称它没做过的校验。** 收尾无条件打印 `sha256 + GPG verified`，而
  无 `SHA256SUMS.txt`、资产未被列出、机器上没有 `gpg`、没有 `.asc` 四种情况各自
  只 warn 后继续安装。现在结论由实际状态拼出（`sha256: verified (SHA256SUMS.txt);
  GPG: skipped (no .asc published …)`），两者都没验时额外警告"装上的字节未被完整
  校验"。缺签名仍只警告不拒装是 0.6.4 定的策（区分"策略缺口"与"篡改"），这一版
  改的是**别把没做的事说成做过**；校验不匹配照旧直接拒装。
- **`install.sh --version 0.1.0` 100% 失败**（文件开头就教这条写法）：`for arg in "$@"`
  里的 `shift` 不影响已展开的循环，版本号随后被当成未知参数报错退出。改成 `while/[ $# ]`
  循环。`--help` 在 `curl … | bash` 形态下用 `sed "$0"` 打印自身，而那时 `$0` 是
  `bash`，必失败；改为直接输出用法。
- **GPG 验签失败会杀死整个安装器。** `set -e` 下 `out="$(gpg --verify …)"` 一失败脚本
  就地退出，其后的 `rc=$?`、警告分支、`rm -rf "$gnupg"` 全是死代码，用户只看到 gpg 的
  stderr 和一个泄漏的临时目录。改为在 `if` 里取值，清理先行。
- **引擎没答话时，工具说"成功了"。** `daemon.ts` 对既无 `error` 又无 `result` 的帧
  回 `{ok:true, result:undefined}`，TUI 于是渲染成 `gp_act: act ok` ——模型读到"这次
  点下去了"，而引擎其实什么都没答。改为按帧契约拒绝（`{id,result}` 或 `{id,error}`，
  `result` 缺席＝缺陷）；`result: null`（"这个 id 没有证据包"）仍算合法回答。
  同批补：`close`/`end` 事件（守护进程一次只服务一条连接，此前挂断要空等满 30/60 秒
  超时，remedy 还教 agent"别动鼠标键盘"）、响应 `id` 核对、跨 chunk 的 UTF-8 解码
  （CJK 窗口标题此前会被截成替换字符，再报成"引擎发的不是合法 JSON"）。
- **同目录里旧名字的配置赢过新名字。** `~/.config/glasspane-harness/` 下四个候选文件的
  合并顺序把 `glasspane-harness.jsonc` 排在 `opencode.jsonc` 之前，而"后合并者赢"正是
  `product.json.compatRead`、`config/paths.ts:26-31` 与本文件自己（项目级那段）写的
  规则——于是遗留文件静默劫持产品配置。改成遗留在前、产品在后。
- **构建把第三方响应原文当源码插进二进制。** `script/generate.ts` 取
  `https://models.dev/api.json` 的响应体**原文**交给 `Bun.build({define})`，而 `define`
  是源码文本替换：JSON 恰好是合法表达式所以一直没出事。现在要求 2xx、必须是 JSON
  对象、每个 provider 是对象，再重新序列化——非法响应让构建点名失败，不再可能成为
  发给所有用户的那份二进制里的代码。

### Fixed — 闸自己（这几条在坏的时候都是绿的）

- **`kernel-vendor` 的跨读读的是"碰巧 checkout 的那一支"，却把结论标成钉点。**
  实测：canonical 检在 `main`、pin 是 `kernel/decision-log-chain@2ed342b`，25 个与
  清单逐字节一致的文件报了 9 条红，remedy 写"backflow or drop it"。改为按
  `git show <ref>:kernel/<file>` 从对象库读；对象不在场时大声声明"未跨读"而不是判红；
  canonical 工作树脏不再污染测量。`checkDeclaredMode()` 一直在找一条任何布局下都不存在
  的路径 ⇒ `kernel.mode` 与树的形态是否一致**从未被检查过**，现已执行并两条验红。
- **`product-surface` 的 4 条断言落在判决之后**（打印与 `process.exit(1)` 都发生在它们
  之前），把 bin shim / 升级包名 / 卸载包名改回上游写法照样绿。收成底部唯一一处判决，
  断言计数 **84 → 88**。
- **`hook-liveness` 缺参照检出时 `TypeError` 退 1**，而 1 的语义是"上游坏了，冻结升级"
  ——把"这台机器没克隆"报成了上游事故（现退 2 并指向 `--offline`）。钩子名正则不认
  下划线，`experimental.provider.small_model` 被漏掉（声明 21、金样 20）；补上后又发现
  fire-site 正则不认带泛型的 `plugin.trigger<"…">(`，会把**活的**钩子判成 dead。
  金样重记为 21（live 15 / structural 5 / dead 仍只有 `permission.ask`），并加了
  "声明解析出 0 个名字＝无法测量（退 2）"的兜底。
- **`tool-surface` 的 `--record` 会在没有参照克隆时把沿用行数盖成新基线**（此后该 lane
  对 edited 文件的增长永久失明）；无参照时面 B 还会把"上游文件改名而来"算成我们写的行
  （同一棵树 5,115 vs 6,203）。现在两种都拒绝，且无参照 lane 拒绝断言面 B 在限内。
- **`brand-surface` 在产品语言目录被搬走时抛 ENOENT 退 1**（会被读成"品牌漂移"），
  改为退 2 并写明"跑不了不等于过"。

### Internal

- 新增 `packages/opencode/script/installer-selftest.sh`：桩 curl/uname/npm/gpg，把
  GitHub 兜底通道**离线跑完**（31 条断言，含校验不匹配必须拒装、无清单必须不说"已验"）。
  此前这条路径没有任何测试碰过，`product-surface` 的 `--dry-run` 也走不到它。
- 新增固定点测试 7 条：`test/tool/glasspane-surface.test.ts` 传输层 6 条、
  `test/config/config.test.ts` 同目录优先级 1 条；每条都对**改动前**的源码跑出具名红。
- `harness/README.md` 的金样数字全部按本轮实测校正（fork-diff 四桶、面 A/面 B、
  血缘计数、product-surface 断言数、surface-semantics 扫描集），并把 `kernel-vendor`
  清单与 fixture 的真实路径写对（它们在 fork 树里，不在 `harness/contracts/`）。
- `FORK.md` 订正两处与代码不符的主张：仓里没有 `--embed-web-ui` 这个 flag（内嵌自
  2026-09-25 起是默认，反向开关是 `--skip-embed-web-ui`），以及"本 pin 的内核没有
  `dimensionContext`"——重新钉 pin 后它已在 `vendor/kernel/src/dimension-context.ts:179`。

### 未观测（不写成通过）

真模型轮次仍未跑（这台机器上没有可用的 provider key，且花别人的额度该由 owner 决定）；
真 TUI 会话里的观感仍未观测（`gp_*` 需要 daemon 席位齐，本轮只跑到无头 `serve` 形态）；
`packages/{app,session-ui,desktop}` 与 TUI 的关系仍是待决项；canonical kernel 已前进到
`4541cd1` 并发到 npm（`iterate-kernel@0.1.1`），是否改换分发形态属 owner 裁决。

## [0.6.4] - 2026-10-03

这一版的内容全部来自一次全面审查：把 harness 从长期寄生的 worktree 合回主仓
`main`（形态与 iterate 生态对齐），然后逐道复核它的六把尺子。三个 P0 都是
「发布出去的东西是坏的」，其中两个在 npm 与 GitHub release 上已存在数日。

### Fixed

- **GitHub release 兜底安装此前从未成功过。** 安装器请求
  `<product>-<platform>-<version>.tar.gz`，而 `script/build.ts` 上传的是
  `<product>-<os>-<arch>.zip`：文件名里没有版本号（版本由 URL 里的 tag 承载），
  且只有 Linux 目标才打成 tar.gz。实测 v0.6.3 / v0.5.1 / v0.4.0 的两种猜法
  全部 HTTP 404。npm 不可用时（无 Node、无 npm、被代理拦）这条路径只会报
  "download failed"。
- **兜底安装不校验任何东西。** 0.6.3 随包发出的 `install.sh` 里
  sha256 / gpg / asc / checksum 一个都没有——发布链给每个资产签了 `.asc`、
  发了 `SHA256SUMS.txt`，而收到它们的安装器从不读。现在两个判定都补上：
  对 `SHA256SUMS.txt` 校验 sha256（完整性；**不匹配直接拒绝安装**，不降级为
  警告，因为字节不是发布的字节），对 `<asset>.asc` 验签（来源；缺 gpg 或缺
  签名仍只警告，区分「策略缺口」与「篡改」）。两者不可互相替代。
  对 v0.6.3 的真实资产实测：sha256 通过、GPG GOODSIG 通过；追加一个字节后
  sha256 判定拒绝安装。
- **`verify_asset_gpg` 读全局变量而不是参数。** 它声明了 `local asc` 却用
  `"$TMP/$ASSET"`，并引用 `$URL`——在 `set -u` 下以非 `$URL` 的 URL 调用会
  直接 `URL: unbound variable` 而死。改为全部走 `$1/$2/$3`。
- **版本序崩坏。** CHANGELOG 的章节顺序是 0.6.3 / 0.6.1 / 0.6.0 /
  `[Unreleased]` / 0.1.0 / 0.2.0 / 0.5.1 / 0.5.0 / 0.4.0 / 0.3.0——`[Unreleased]`
  卡在文件中部，且 M4 一条在 0.6.0 与 `[Unreleased]` 下逐字重复。改为严格
  降序、`[Unreleased]` 置顶，删掉重复的那条（它仍在 0.6.0 下）。

### Internal

- **尺子层合回主干，`harness-rulers` 成为主仓 CI 的一条 lane。** 此前
  `harness/tools`（6 把尺子）与 `harness/contracts`（5 份金样）只存在于一个
  worktree 的分支里，不在 `main` 的版本控制内——`FORK.md` 却把「分叉必须
  可测量」列为不可让步纪律并给出 4 条命令，其中 3 条在 `main` 上是
  `MODULE_NOT_FOUND`，而 `main` 的 CI 里 `grep -c harness` 当时是 0。
  纪律变成了散文，**两个月里没有任何东西发现**。现在每次 push 先断言 6 把
  尺子与 5 份金样在树里（就是这次的回归形态），再逐道跑。
- **三道闸的金样重记**（`fork-diff` / `brand-surface` / `tool-surface`）。逐条
  查证后重记，不是盖数：`fork-diff` 的 9 条过期项先逐文件比对确认与已发布的
  0.6.3 逐字节一致；`brand-surface` 的 +1 定位到一处**注释**（同一提交把用户
  可见的 `opencode -s <id>` 修成了 `glasspane-harness -s <id>`，注释里提到
  旧名，按字面计数 +1）；`tool-surface` 的两处增长分别是 main 上 1.6.x 的
  真实产品代码与尺子第一次在有上游参照检出时正确归属我们自己的 `gp_*` 工具面。
  `surface-semantics` 同批仍 0 hit——判定全部留在 Swift 引擎里，这条才是本棘轮
  真正要守的不变量。
- **`FORK.md` 新增第 3 条纪律「尺子必须和 fork 同仓」**，并说明 `subtree split`
  只带走 `harness/glasspane-harness/` 是对的：尺子量的是主仓里这棵树，不随产品
  分发。

### Added

- **Kernel conformance lane** (`bun script/kernel-conformance.mjs`): the kernel's own
  fixtures, mirrored into `contracts/kernel-fixtures/` and hash-pinned, are run through the
  kernel this package ships. Byte-identical answers or exit 1. With `--impl <dir>` it runs
  a second implementation — a built `dist/` or an installed `@iterate/kernel` — and
  demands the same answers, which is the evidence that changing how the kernel is
  delivered does not change what it means.
- **Kernel provenance gate** (`node script/kernel-vendor.mjs --check`) now also covers the
  mirrored fixtures, and both gates live in the product tree so this repository can
  verify itself.

### Fixed (kernel provenance, shipped in this version)

- The kernel's pinned ref was unresolvable because the canonical branch had never been
  pushed; the branch is now published and the manifest re-anchored to it.
- The drift probe asked `git ls-remote` to resolve a commit SHA. `ls-remote` matches ref
  names, so it reported "anchor unreachable" even for refs that were on the remote. It now
  asks the one question `ls-remote` can answer, and declines to guess at ancestry it cannot
  see.

## [0.6.3] - 2026-09-30

### Fixed

- **npm 发布通道被两个版本号卡住，现在绕过。** `0.6.1` 与 `0.6.2` 在 npm 侧处于
  *staged* 状态，`npm publish` 对这两个号一律返回
  `E409 Cannot publish over previously staged version`，而 `npm stage list`
  并**不显示**它们。成因是一次误操作：本机这个 npm 版本上
  `npm publish --dry-run` 仍然真的 PUT 了版本号（dry-run 并不 dry），于是被
  用来排查的号自己也进了 stage。stage 需要交互式认证才能 reject，因此这一版
  改发 `0.6.3`。**内容与 `v0.6.1` 的 GitHub release 完全相同**——跳号只影响
  npm 上的版本号连续性，不含任何功能差异。
- **GitHub release 的资产现在带 GPG 签名。** `v0.6.1` 起，两个平台归档与
  `SHA256SUMS.txt` 各带一份 `.asc`；`gpg --verify` 对从 release 下载的文件
  通过。签名步在 secret 缺失时**拒绝发布**而不是静默跳过——静默跳过正是
  GlassPane 自己的 v1.4.0 发出无签名产物的原因。

### Internal

- **`script/gpg-signing.sh`** (new) — 签名配置与发布凭据的一处入口，
  `seed` / `install` / `verify` / `verify-pass` / `local` / `audit` / `selftest`。
  放在产品树内而非仓外 `tools/`，因为 subtree split 不带走仓外目录。
- keychain 里的私钥以 **base64** 存放：`security add-generic-password -w`
  在本机会把**多行**参数 hex 编码，keychain UI 看不出异常，而 CI 拿到的就是
  那串 hex，`gpg --import` 报 `no valid OpenPGP data found` 且不会提它来自
  keychain。存后读回比对字节，`install` 推之前拒收非 armored key 的值。

## [0.6.1] - 2026-09-30 (GitHub release only — never reached npm)

The binaries, checksums and GPG signatures for this version are on the GitHub
release. npm never received it: the version number was left *staged* by a
misstep (see 0.6.3), and `0.6.2` then went out as an empty placeholder. Both are
deprecated on npm with an explanation. **Install from npm: use 0.6.3 or 0.5.1.**

### Fixed

- **Release assets are now GPG-signed, and the release refuses to publish without
  them.** v0.6.0 shipped two platform archives and no `SHA256SUMS.txt.asc`:
  the signing step read `GPG_PRIVATE_KEY` from the `release` environment, where
  it had never been set, and the step failed after the archives were already
  uploaded. The two secrets are configured now, and the lane is re-run.

  Consumers can verify provenance, not just integrity:

  ```bash
  gh release download v0.6.1 -p glasspane-harness-darwin-arm64.zip -p '*.asc'
  gpg --verify glasspane-harness-darwin-arm64.zip.asc glasspane-harness-darwin-arm64.zip
  ```

### Internal

- **`script/gpg-signing.sh`** (new) holds how this product and the four other
  projects in the two ecosystems sign their releases, so the question stops
  being re-derived: `seed` (one-time, the only interactive step), `install`,
  `verify`, `verify-pass`, `local`, `audit`, `selftest`. It lives in the product
  tree rather than the fork's `tools/` because subtree split does not carry the
  fork's directories into the published repo.
- `audit` names the release workflows that still sign behind
  `if: secrets.GPG_PRIVATE_KEY != ''` — a condition under which the step
  disappears silently and the release publishes unsigned. GlassPane's own v1.4.0
  shipped that way; this repo's `release.yml` was already migrated to failing
  loudly with a remedy.

## [0.6.0] - 2026-09-28

### Fixed

- **The session epilogue printed a command that does not resolve.** Exiting a
  session showed `opencode -s <id>`; this product installs as
  `glasspane-harness`, so the line a user copies to resume was the wrong binary.
  It now prints `glasspane-harness -s <id>`.
- **The epilogue could print `-s undefined`.** `sessionID` is optional, because
  the session may not have finished loading. The continuation line is now
  omitted unless there is an id, rather than emitting a literal `undefined` that
  reads like a runnable command.
- **The provider dialog kept a dead upstream key** in its description table —
  unreachable, but shipped. Removed.

### Added

- **Dimension-aware compaction (M4).** A compacted `gp_*` session now carries a
  coverage line computed by the kernel: which planned review dimensions the
  engine recorded a decision for, which recorded nothing, and which recorded
  something the run never planned. A dimension with no decisions is reported as
  unverified — never dropped, and never described as fine, since only the engine
  may judge that. The dimension vocabulary is the iterate config's; this side
  neither enumerates it nor infers one from a method name.

### Internal

- **The release lane was broken end to end and had been for several releases.**
  Five separate defects sat between a tag and a published binary, each hiding the
  next: a `steps.*` expression that made GitHub reject the workflow file (zero
  jobs dispatched), a `secrets` reference in a step's `if:` (same, and invisible
  to any local YAML check), a `build` script invoked from the workspace root
  where it does not exist, an upload that globbed both `.zip` and `.tar.gz` when
  each runner only ever produces one, and no step creating the GitHub release
  before the upload. `darwin-x64` additionally never got a runner at all, because
  its matrix pinned `macos-13`, which GitHub has retired.
  `check-workflows` now rejects `secrets` in an `if:`, so the second class of
  failure is caught before it reaches the registry.

- `packages/tui` typechecks clean (11 errors, one root cause: a `createResource`
  whose `T` could not be inferred, so every consumer lost its element type).
- Two files that ship user-facing strings were outside the brand-surface
  ratchet's scan list, which is why the two leaks above reached a release. They
  are scanned now, and the ratchet is verified to fail on a regression in them.

## [0.5.1] - 2026-09-26

**The same content as 0.5.0, published cleanly.** 0.5.0 exists on the registry because
two publishes of it were launched by mistake and raced; npm accepted one and staged the
other, which burned the number for the wrapper. The release moved to 0.5.1, and
`publish.ts` now takes an exclusive lock (`dist/.publish.lock`, an atomic `mkdir`) so two
publishes cannot run at once — a mistake that cost a version number is now a script bug
instead of an operator one.

## [0.5.0] - 2026-09-26

**The product surface says our name, everywhere a person can see it — and the trees that
were never ours are gone from the repository.**

### Changed — the private-isation, audited rather than assumed
- **Environment variables**: every knob now has a `GLASSPANE_HARNESS_*` name, resolved in
  one place (`flag/flag.ts`'s `read()`). The old `OPENCODE_*` names still work — a
  private-isation that silently ignores a setting someone already exported is its own bug.
- **What we call ourselves on the wire**: `X-Title`, `X-Source`, `User-Agent`,
  `originator`, `HTTP-Referer`, the MCP client name and the OTLP service name all say
  `glasspane-harness`. Previously a request to OpenRouter, Cerebras, Kilo, Vercel,
  NVIDIA, Zenmux or a user's own web fetch identified itself as opencode.
- **The user's own files**: the database is `glasspane-harness.db` (with a one-time rename
  of the old file — losing someone's session history would be the worst possible
  private-isation bug), the log is `glasspane-harness.log`, and the server's basic-auth
  default username is the product's rather than `opencode`.
- **The LAN**: the mDNS default is now actually `glasspane-harness.local`. The help text
  was rebranded in 0.1.0 while the value was not, so the product advertised one domain and
  announced another.
- **The CLI**: `scriptName` is the product's, which is what `--help` and usage errors print.
  The ACP integration (what editors launch) no longer advertises a login that cannot exist.
- **The built-in skill** is `customize-harness`, and its body documents this product's
  config paths. It is injected into every session, so its text is product surface.
- **No third-party `$schema` is written into your config any more.** Upstream injected
  `https://opencode.ai/config.json` into every file it opened; the first line of a user's
  own config was somebody else's URL.
- First-party remnants removed from the TUI and web app: the Zen upsell and its link, the
  "free models" claims, the paid-plan nudge, the recommended tags, the provider ordering
  that floated the house gateway to the top.

### Removed — trees that were never this product
`packages/console`, `packages/enterprise`, `packages/stats`, `packages/web` (the docs
site), `packages/storybook`, `packages/containers`, `packages/function`,
`packages/identity`, `packages/slack`, `packages/docs`, plus `artifacts/` (an upstream
promo-video project for a model release), `.vscode/`, `install/` (the upstream
`opencode.ai/install` script), `nix/` + `flake.*`, `sdks/vscode` (an editor extension),
`infra/` + `sst.config.ts`, `perf/`, `github/` (the upstream bot action) and
`screenshot-uk.png`. None of them were referenced by shipped code — measured, not assumed.

**Kept on purpose**: `packages/desktop` (product surface, batch 2), `patches/` (bun
applies them at install time), `specs/` (the design record of the code we maintain).

### Gates
- `brand-surface` gained five rule classes — first-party gateway, wire identity, foreign
  schema writes, product file names, and removed trees — with a short explicit allowance
  list for the three places that legitimately *read* an old name (the database migration,
  the legacy config file names, a stored theme id).
- The ruler's own blind spot was fixed: `fork-diff` used to treat gitignored build output
  as "a file that exists but was never committed", which is the same class of false
  positive as the import bug it was built to catch.

## [0.4.0] - 2026-09-25

**A complete programming agent with the GlassPane kernel fused in — and no account to
log into.** This release is mostly the removal of a first-party vendor surface, plus the
npm and docs work that goes with it.

### Added
- `docs/models-and-keys.md` — the model catalog and the three ways to supply a key
  (env var, `{env:NAME}` config template, TUI `/connect`). "Bring your own key" is now the
  documented model story, not an accident.
- `docs/release.md` — the release runbook, including the **npm trusted-publisher setup**
  for all three packages (the field values are pinned to what `release.yml` presents:
  owner `jingzhao-l`, repo `glasspane-harness`, workflow `release.yml`, environment
  `release`). Until that is configured, CI cannot publish; the manual path is documented
  too.
- **npm READMEs.** 0.2.0's npm pages were a bare version string. The wrapper now ships the
  product README (EN + 中文) and each platform package ships a short README that says what
  the binary is and points at the wrapper. `publish.ts --dry-run` fails without them, so a
  README-less tarball cannot ship.
- The publishing jobs carry `environment: release`, which is both the value npm's trusted
  publisher must match and a place to require a human reviewer.

### Changed
- **This repository's own project directory is now `.glasspane-harness/`** (was upstream's
  `.opencode/`): the agent, command, skill, glossary and theme config that opencode used to
  develop itself now lives under the product's own name, so the repo dogfoods the rename.
  `.opencode/` is kept as a *read-only compatibility target* in a user's project — a
  `product-surface` assertion fails if a `.opencode/` reappears at the root **or** if the
  compat read is deleted.
- The repo's dev config file is `glasspane-harness.jsonc` (the name the product reads
  first).

### Removed — the first-party account surface (BYOK instead)
- The `opencode` first-party provider is filtered out of the model catalog.
- `auth login` / `logout` / `switch`, the `/org` TUI command and the console-org dialog.
- `/experimental/console*` server endpoints, the console-managed-provider config state,
  and the provider dialog's "managed by console" branch.
- Session sharing to opencode's cloud: the share modules, share/unshare endpoints, the
  `share` and `autoshare` config keys, the TUI `/share` command and the web app's share
  affordances (kept in the component shape, permanently off, one line to flip).
- The local `account` / `account_state` tables are no longer managed by the schema. The
  tables remain in existing databases — no destructive migration; the rows are inert.
- `import <share-url>` no longer fetches console shares; import a local JSON export.

Everything else in the catalog is untouched: Anthropic, OpenAI, Google, GitHub Copilot,
Bedrock, Azure, OpenRouter and the rest still ship, unlocked by your own key.

## [0.3.0] - 2026-09-25

**macOS-only, and the npm distribution says so.** The GlassPane engine, its four macOS
permission seats and the whole evidence pipeline exist only on macOS, so the product is
macOS-only (owner decision). The npm side enforces it rather than describing it.

### Changed
- The npm distribution is macOS-only: the wrapper declares `os: ["darwin"]` /
  `cpu: ["arm64", "x64"]`, so `npm install` on Linux or Windows is **refused by the
  package manager with a reason** instead of downloading a binary that cannot run. The
  target matrix in `product.json` is now exactly the two macOS targets.
- `scripts/install.ps1` (Windows one-click) is **removed** — the POSIX installer is the
  only one, and on a non-macOS host it says "macOS-only is a decision, not a missing
  port" and exits.
- The Linux/Windows/Intel-baseline platform packages published before this decision are
  **deprecated on npm with the reason attached** (they cannot be unpublished; a
  deprecation that explains itself beats a package that still installs).
- The release lane builds the two macOS targets on `macos-14` / `macos-13`.

### Added — npm infrastructure
- `publish.ts --dry-run`: packs every artifact and validates its shape **without
  touching the registry** — bin targets exist inside the tarball, the platform binary is
  present and executable, the wrapper's `optionalDependencies` match `product.json`'s
  target matrix, and the wrapper's `os`/`cpu` agree with the product's platform block.
  Wired into the fork's CI, so a broken package shape fails a PR instead of a release.
- `verify-published.ts`: "published" is not "works" — installs the **published** tarball
  into a throwaway prefix, runs `--version`, and confirms the embedded web app is served
  by that binary. Runs as the release lane's final job; on a non-macOS host it asserts
  that npm refuses the install.
- Wrapper metadata completed for its npm page: `engines.node`, `funding`,
  `publishConfig` (access + tag), `sideEffects`, and a dist-tag policy —
  `latest` for stable, `next` for anything on a non-latest channel, so a preview can
  never be installed by `npm i -g glasspane-harness` by accident.
- The npm publish/deprecation policy is recorded in `product.json` (`npm` block) so it
  travels with the code instead of living in someone's head.

### Docs
- READMEs, `docs/install.md`, `docs/index.md` and `docs/troubleshooting.md` state the
  platform boundary up front, with the npm `EBADPLATFORM` case in the troubleshooting
  table.

## [0.2.0] - 2026-09-25

The companion product surfaces, brought in as first-class citizens (owner decision:
"那几个配套产品面还是需要的"), plus the release infrastructure around them.

### Added
- **Web app embedded in the binary again** (upstream default, and what iterate-harness
  does with its dashboard): `glasspane-harness serve` serves the browser UI from the same
  process. `--skip-embed-web-ui` still produces a CLI-only build, and a build without the
  bundle starts and says the UI is absent instead of failing.
- Product README (EN + 简体中文) rebuilt in the iterate-harness shape: language switch,
  npm-downloads / version / CI / license / stars badges, product-surface table, the
  problem statement, quick start, docs index, and the attribution block.
- `assets/logo.svg` + `assets/banner.svg` (SVG on purpose: the brand stays diffable text).
- `docs/` (six pages: index, install, tools, evidence, migrate-from-opencode,
  troubleshooting) — the in-repo canonical documentation the READMEs link to.
- `CHANGELOG.md` for the product (this file), `SECURITY.md` for the product (upstream's
  pointed at upstream's disclosure process).
- GitHub issue templates (bug with a mandatory `gp_probe_status` payload, feature with an
  "which evidence does it rely on" question) and a PR template carrying the line's
  checklist (fork-diff record, product.json first, brand gate, fixed points with reverse
  controls, stated boundaries).

### Changed
- The docs link checker now covers the product's documents too (24 files, 212 links): a
  dead link in the product README is the same red as one in the repository's.
- The M1 rows in `FORK.md` / `SYNCLOG.md` no longer hard-code a tool count — the count was
  a claim the checker could not verify, and this line's doctrine is "read it from
  `hello.capabilities`, never copy it".

### Not in this release
- The docs **site** (`packages/web`) is still upstream's Astro/Starlight tree: it builds
  and is kept for lineage, but its content is not yet our documentation. Until that is
  done, the canonical docs are `docs/` in this repository — the docs site is marked
  `not-yet-ours` in `product.json` rather than being quietly presented as finished.
- Electron desktop app (second batch; needs signing and notarisation accounts).

## [0.1.0] - 2026-09-25

First public release of the private customisation. Everything below is a decision that
used to be upstream's, recorded so the next release notes can be diffed against reality.

### Added
- Product identity: `glasspane-harness` (binaries, `gp-harness` alias, npm wrapper
  `glasspane-harness` + 12 platform packages, user agent, mDNS name, `~/.glasspane-harness`
  state root, `glasspane-harness.json(c)` config names with upstream names kept as legacy
  fallbacks, default TUI theme, basic-auth default user name).
- GlassPane's native `gp_*` tool surface: `gp_probe_status`, `gp_attach`, `gp_observe`,
  `gp_act`, `gp_diagnose`, `gp_last_evidence` — capabilities read from the running engine,
  never hard-coded.
- Evidence discipline: hash-chained decision log (op id ↔ entry hash) written through the
  vendored `@iterate/kernel`; a compaction hook that re-injects the session's evidence
  anchors; tool-surface ratchets that keep judgement in the engine (no threshold, pixel
  verdict or pass/fail synthesis in a shell).
- Session-flow evidence rendering in the TUI (engine refusal vs engine answer are visually
  distinct; the row model is a pure function the fixed points pin).
- Product surfaces: CLI + TUI, the **web app embedded in the binary**, the docs site and
  in-repo `docs/`, SDKs shipped with the tree.
- One-click installers (`scripts/install.sh`, `install.ps1`): npm first, GitHub release
  asset as fallback, verification step, and the GlassPane-daemon prerequisite spelled out.
- Fixed-point tests for every module (M1–M5), plus two runtime probes: E7 (decision chain
  against bytes the engine wrote) and E8 (the compaction hook against a real host).

### Changed
- Project configuration directory is `.glasspane-harness/`; `.opencode/` is still read
  (legacy), and when both exist the product's directory wins the merge.
- Web UI embedding is the default again (`--skip-embed-web-ui` opts out).
- `glasspane-harness --version` reports the manifest's version verbatim (it used to
  inherit upstream's release-time patch bump and print a version that was never built).

### Removed (on purpose, recorded)
- The hosted console / enterprise / stats stack and its SST infrastructure — a private
  harness has no organisation-and-quota back office.
- Paths that would have executed or published *another project's* assets: the upstream
  docker/AUR/Homebrew publishing tail and the `opencode.ai/install` self-upgrade.
- The Electron desktop app is not shipped in 0.1.0 (second batch; needs signing and
  notarisation accounts). It remains in the tree as lineage.
