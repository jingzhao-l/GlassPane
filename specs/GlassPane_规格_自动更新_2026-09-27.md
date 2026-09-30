# 规格 — 自动更新（2026-09-27，v1.4.0 新功能）

用户口径（原话归纳）：每天定时从源检查更新并自动更新；对象是**已安装的 daemon（.app + launchd 服务）**
与 **npm 两个包**；面板上要能手动检查/手动更新，并在"固定时间没跑成（关机）或重启失败"时**提示用户
有更新可用**；默认开、可一键关。

本文是这件事的契约：什么是"可信的更新"、什么时候允许换版、失败了留下什么。
判据不写"应该没问题"，每条都要能被测试变红（`updater/test/**`、`engine/Tests/**`）。

## 1. 更新源与信任链

- **源**：`https://api.github.com/repos/jingzhao-l/GlassPane/releases/latest`。仓库名是常量，
  不由参数或环境变量决定；`GLASSPANE_UPDATE_BASE` 只能把主机换成 **https** 或 **127.0.0.1**
  （后者仅供测试），换成明文地址即拒绝启动检查而不是降级。
- **资产可以换了主机，但不能换"是谁的发布"**（2026-09-29 真机查出来的一条：GitHub 报文里的
  `browser_download_url` 是 `https://github.com/<slug>/releases/download/<tag>/<file>`，与钉死的
  `api.github.com` 不同 origin；当时的规则只认 same-origin ⇒ 每一份真实 release 都死在这一步，而
  所有夹具写的是 GitHub 根本不产出的 `api.github.com/.../releases/download/…`）。现在的判据三条同时成立才放行：
  基址仍是钉死的 `api.github.com`（自建镜像不获得这层放宽，仍按 same-origin）、主机在**显式列出**的
  GitHub 发布主机集里（不是 `*.github.com` 那种后缀匹配）、且路径解码后属于**这个仓**的那两种形状
  （`/<slug>/releases/download/<tag>/<file>` 或 `/repos/<slug>/{tarball,zipball}/<ref>`）。
  同 origin 的 URL 也要过路径形状这一关——`api.github.com` 上不止放着这一个仓。
- **档案里的链接一律物化成副本，落盘的树里不许有任何链接**：`git archive` 会把仓里的符号链接原样打进
  release 资产（本仓的图标文件就是），所以 typeflag `1`/`2` 不再一律拒绝，而是**把档案里目标那份字节抄到
  链接的位置**，mode 跟随目标文件（tar 记的链接 mode 是 0777，照抄就是每台机器上多一个人人可写的发布字节）。
  仍然全拒：绝对目标、解析后越出暂存目录的目标、档案里不存在的目标、指向目录的链接、链接指向链接、
  设备与 FIFO。校验顺序仍是"先看全部条目，再一个字节都不写"，所以半棵树不会被留在盘上。
- **下载有两个时钟**：`stallMs`（默认 30s，**每收到一段字节就重置**）决定"这条连接死没死"，
  `timeoutMs`（默认 15min）只是兜底，防止永远滴流的服务器把每日作业吊死。单个总时长做不到这两件事——
  2026-09-29 实测那份 tarball 24 MiB、无人竞争时 39s，而在有竞争的链路上被 120s 总时长掐死，报出去的句子
  是 `This operation was aborted`（既不说到了哪条时限，也不说收到多少字节）。现在两种停止各自说清
  "停摆 30s 时已收到 8.4 MiB" 还是 "600s 没下完（已收到 …）"，并且**都不stage 半份内容**。
- **文档化的每一个 CLI 参数都必须走到用它的那行代码**，且至少有一条用例是**从进程那一侧**进去的。
  `--state-dir`、`--apps-dir`、`--daemon-bin`、`--socket`、`--at`、`--hour`、`--minute` 曾经被
  `parseArgs` 写进一个没人读的 `flags.overrides` 袋子，于是六个参数在命令行上全部静默失效——
  `check --state-dir /var/tmp/x` 实际把整份暂存 release 写进了活的 `~/.glasspane`（自己跑真机验收时撞见）。
  单元测试当时全绿，因为它们直接构造 `runCommand({ flags: {…} })` 那个消费者形状，从不经过解析器。
  `--disable`/`--enable` 同理：文案写着"no-op 别名"却什么都不做，比没有这个开关更坏——现在它们真的选择子命令，
  且拒绝与别的命令同时出现。
- **八道校验，任一不过就不换版**，并把不过的那条以稳定 code 记进状态文件：
  1. `tag` 必须匹配 `^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$`，且**语义化版本严格大于**当前
     （当前值取本机 `.app` 的 `CFBundleShortVersionString`，与 `glasspaned --version` 读回的值必须
     一致，不一致 = `version-mismatch-local`，不更新并提示重装）；`code=tag-unparseable`。
  2. 大版本号不同 ⇒ `status=needs-consent`：**major 升级永不自动应用**（本仓的 major 意味着
     对外契约变化，见 CHANGELOG 的 1.1.0/1.3.0 判断）。
  3. 该 release 必须同时带 `GlassPane-<ver>.tar.gz` 与 `SHA256SUMS-<ver>.txt` 两个资产，缺一即
     `assets-missing`（缺校验文件的 release 与没有校验文件等同）。
  4. `SHA25SUMS` 严格解析：只接受 `<64 hex>  <两个空格> 文件名` 的行，且必须**恰好一行**命中该
     tarball 名；多行命中或格式不符 = `sums-ambiguous`（不做"取第一个"的猜测）。
  5. tarball 落到 0700 的暂存目录后按 sha256 **实测**比对（读文件算，不信 Content-Length、不信头），
     不符 = `digest-mismatch`，暂存目录连同内容一起删除。
  6. 解包后**自我一致性**：暂存树里的根 `package.json`、`mcp-shell/package.json`、
     `engine/Sources/GlassPaneEngine/EngineCore.swift` 的版本常量三者都等于 `<ver>`，并**在暂存树里跑
     它自己的** `node scripts/check-version.mjs`（退出码非 0 即 `version-line-broken`）。这一条防的
     是"tag 与内容不同源"的版本混淆——本仓用单一版本线，所以拿它自己的守卫来验货。
  7. CI 凭据：该 release 的 `target_commitish` 指向的提交必须在 `main` 上有**结论为 success 的 CI run**
     （查询 `actions/runs?head_sha=…&branch=main`）；查不到 = `ci-unverified`，查得到但非 success =
     `ci-not-green`。理由与 1.3.0 的发版凭据同一条：这个仓库对外发布时用的就是 CI 绿。
  8. **来源证明（作者性）**：该 release 的 `SHA256SUMS-<ver>.txt` 必须带一份 detached ASCII-armored GPG
     签名资产，名字就是 `release.yml` 里 `gpg --detach-sign --armor` 自己写出的那个
     `SHA256SUMS-<ver>.txt.asc`（命名由 `test/signature.test.mjs` 从工作流原文反推，两边任一侧改名即红）。
     在**隔离的一次性 GNUPGHOME**（建在该版本的 0700 暂存目录里，验完即删）中导入公钥后用 `gpg --verify`
     判定；公钥**不复制第二份**——`installer/cli.js` 已经导出 `GLASSPANE_SIGNING_PUBLIC_KEY` 与
     `classifyTagVerify`，updater 侧动态 import 复用同一份值与同一套结论用词。四种状态各有 code 与句子：
     - `verified`：换版继续；状态文件记下被验的资产名与密钥指纹（`authorship` 字段）。
     - `invalid`（签名存在但对不上，或是对不上**我们内置的那把 key**）⇒ `signature-invalid`，**硬拒**：
       任何 consent 都不能覆盖一个坏签名——`--consent unsigned-release` 回答的是"没人签"，永远不回答
       "签名自相矛盾"。
     - `unsigned-release`（这个 release 压根没发 `.asc`；签名 job 是 1.3.1 之后加的，那之前的 release
       全是这一态）⇒ `release-unsigned`。
     - `signature-tool-missing`（这台机器没有 `gpg`，或读不到内置公钥）⇒ `signature-tool-missing`。
     后两种是"缺证据"而不是"证据为假"：**定时（`--auto`）运行一律拒绝**并落 `needs-consent`；
     人可以用 `updater check --consent unsigned-release` 继续，而状态文件与 `gp_diagnose` 的摘要在此后
     必须**一直**写明这份是"无作者性证明装上的"。次序上这条排在第 4 条之后、下载 tarball 之前，并且
     永远在任何执行暂存内容的步骤（第 6 条）之前——见 §8 第 2 条。
- **作者性（边界照实说，既不夸大也不假装不存在）**：第 8 条把"谁发布的"从**未经检验的假设**变成
  一条可网络验证的判断，但它的确切含义只有"这些字节匹配本程序内置的那把公钥"：内置 key 是随代码分发的
  字符串，不是仓库身份；能被换的只是 `installer/cli.js` 里那一个导出值。因此第 3–7 条仍负责完整性 /
  版本一致性 / 构建可追溯，而**签名缺失的 release 不再等于"和以前一样自动装"**：定时运行拒绝，
  人点一次才算数，并且这份记录留在状态文件里。人的兜底照旧有效：状态与面板显示 tarball 的 sha256
  （可与发布页核对），major 一律要人点按钮，一键关闭自动更新。
- **npm 两个包不走 registry 更新**：从**已校验的暂存树**里 `npm pack` 出 tgz 再
  `npm install -g <该 tgz>`，避免"校验了 A 却装了 B"的双源。安装后必须 `npm ls -g` 读回版本等于
  `<ver>`，否则 `rollback`。

## 2. 什么时候才允许换版

- **空闲判据**：向 daemon socket 发 `probe_status`，**答得上来**才算空闲——守护进程单连接、按到达顺序
  串行（P0 §6），探针被回答意味着它前面没有请求，也就是没有任何动作正落在用户屏幕上。
  答不上（超时/连接失败）⇒ `status=deferred, reason=busy-or-unreachable`，**本轮什么都不换**；
  绝不把"探针没答"当成宕机，也绝不在忙的时候 `kickstart`（那会取消并回滚在飞的 act——本仓为此已经修过
  三轮）。
- **不猜运行参数**：用 `launchctl print gui/<uid>/com.glasspane.daemon` 读回**正在跑的那个 job** 的
  参数；若它带着非默认 `--state-dir`，本工具的换版语义不适用于它 ⇒ `status=needs-consent`
  （提示由人来做，因为它写的是别人的状态根）。这条读法与 round 9/10 的注册表通知同源。
- **窗口**：launchd `StartCalendarInterval` 每日一次（时刻可配，默认 12:00 本地），
  `RunAtLoad=false`（不让它每次登录都抢启动）。macOS 在睡眠期间错过的日历任务会在唤醒后补跑一次，
  **但关机期间错过的不会**——所以有 §4 的兜底。

## 3. 换版、握手核对与回滚

1. 备份当前 `~/Applications/GlassPane.app` 与 `GlassPane Daemon.app` 到 `<stateRoot>/update-backup/`
   （含版本标记），备份成功后才动现场。
2. 从暂存树构建（`swift build -c release` + `engine/scripts/make-app.sh`）并安置两个 bundle；
   构建失败 ⇒ 现场未动，`status=staged-build-failed`。
3. `launchctl kickstart -k gui/<uid>/com.glasspane.daemon` 重启，**再读一次版本**：
   socket 的 `hello` 必须回 `<ver>`，且 `glasspane-mcp` 的 `tools/list` 可用；15 s 内不成立即
   `restore backup + kickstart`，状态记 `rolled-back`，并把两侧版本写进 `lastError`。
4. npm 全局包的安装同样先记录原版本，读回不符就装回原版本。
5. 一切成功才更新 `current`；历史保留最后 10 次（时间、动作、结论、digest 前 12 位）。

## 4. 没跑成 / 失败时，用户看得到也能动手

- 状态文件 `<stateRoot>/update-state.json`（**0600**，写临时文件 + `rename`，读回校验落盘 mode；
  chmod 不生效即报错，与注册表同一形状）：`{lastCheckAt, current, latest, status, staged, authorship,
  lastError, disabled, autoApply, history[]}`。`authorship` 记第 8 条的结论（哪一种状态、验的是哪个资产、
  用哪把 key 的指纹、是不是人给的 consent），并且**故意不进 `required`**：第 8 条之前写下的状态文件
  必须还读得出来，一份读不出来的状态等于这台机器再也更新不动。schema 是
  `additionalProperties: false` 的封闭形状：对象**内部**多一个没声明的键 = 直接拒绝落盘；顶层未声明的键
  会被 `nextState` 按"字段清单取自 schema 本身"滤掉（静默不落地）。两种漂移都靠测试红，不靠记性。
- **过期判定**：`now - lastCheckAt > 36 h` ⇒ 面板与 `gp_diagnose` 显示"检查已过期（上次 X）"并给
  「立即检查」；这一条专门兜住"固定时间电脑是关的"。
- `status` 是封闭枚举（`up-to-date / available / staged / applied / deferred / needs-consent /
  check-overdue / rolled-back / …-failed / disabled`），面板按它决定哪个按钮可用；
  **不可用不是隐藏，是 disabled 并带原因**（原因文案必须是人能照做的，不写 §、不写内部自辩）。
- 面板的「立即检查」「安装更新」只是同一个 CLI 的入口（`updater check` / `updater apply`），
  不允许面板自己实现第二套下载与换版逻辑——一处实现，一处真相。
- MCP 面：`gp_diagnose` 的响应里带上 `update` 摘要（当前/最新/状态/上次检查），让代理也能如实回答
  "这台机器的 GlassPane 是不是旧的"。方法表是冻结面，这是**响应字段的新增**，不是新方法。

## 5. 默认与关闭

- 默认**开**：安装器注册 `com.glasspane.update`（除显式 `--no-auto-update`）。
- 一键关：`updater --disable`（卸代理 + 状态里 `disabled=true`）与面板开关等效；
  关闭后面板仍显示"自动更新已关闭（上次检查 X）"，不静默消失。
- 关闭状态下 `check`/`apply` 仍可手动执行（手动不受自动开关约束）。

## 6. 每条判据对应哪个能红的测试

| 判据 | 测试 | 反向变异 |
| --- | --- | --- |
| 源只能是 https/pinned | `updater/test/source.test.mjs` | 放开明文 ⇒ 红 |
| 资产主机可以换、但"谁的发布"不能换（GitHub 真形状放行；别的仓、别的族、镜像基址拿到 github.com、同 origin 但路径不属于本仓，全部拒） | `source.test.mjs`（URL 逐字取自真机报文） | 两面路径判据**一起**拆才见血（两处互为冗余）；只拆放宽那面 ⇒ 红 |
| 档案里的链接物化成副本、mode 随目标；绝对/越界/悬空/指目录/指链接/设备/FIFO 全拒，且拒时一个字节都没写 | `tar.test.mjs` | 退回"链接一律拒" ⇒ 红；按 destDir 解析链接 ⇒ 红；目标不必在档 ⇒ 红；落成真链接 ⇒ 红；抄成 0777 ⇒ 红 |
| 下载两个时钟：stall 逐段重置、ceiling 兜底，两种停止都说到哪条与收到多少 | `source.test.mjs`（假流按真 fetch 的 abort 语义实现） | 不重置 stall ⇒ 红（慢而活的下载被杀）；`if (fired)` 删掉 ⇒ 红（回到那句 "This operation was aborted"） |
| CLI 参数走到消费者读的那个键（含从**进程**那一侧进去的用例） | `updater/test/cli-options.test.mjs` | 塞回 `flags.overrides` ⇒ 4 条红；`--disable` 退回装饰品 ⇒ 红 |
| tag 解析与 semver 严格大于 | `version.test.mjs` | 允许相等 ⇒ 红 |
| major 不自动应用 | `policy.test.mjs` | 去掉 consent 分支 ⇒ 红 |
| 双资产必须齐 | `assets.test.mjs` | 缺 SUMS 仍继续 ⇒ 红 |
| SUMS 严格解析 | `sums.test.mjs` | 取第一个命中 ⇒ 红 |
| 实测 sha256 | `digest.test.mjs` | 改用头长度 ⇒ 红 |
| 暂存树版本线自证 | `selfcheck.test.mjs` | 跳过 check-version ⇒ 红 |
| CI 凭据 | `ci.test.mjs` | 允许无 CI run ⇒ 红 |
| 来源证明的四态各自可判 | `signature.test.mjs` | `gpg` 退出 0 就判 verified（不比内置 key 指纹）⇒ 红；换成本地化文案的 gpg 输出也仍要判对 ⇒ 只 grep 英文句子的实现红 |
| `.asc` 资产名 = 工作流真产出的那个 | `signature.test.mjs`（从 `release.yml` 原文反推） | 改名 `.sig`、或工作流不再 `--detach-sign --armor` ⇒ 红 |
| 公钥只有一份（borrow，不 copy） | `signature.test.mjs` | 在 `updater/**` 里再抄一份 armored key ⇒ 红 |
| 未签名 release 不自动装、consent 才继续 | `check.test.mjs` | 删掉 `check.js` 的 gate 8 编排 ⇒ 红（那份 release 直接 stage） |
| 坏签名不可被任何 consent 覆盖 | `check.test.mjs` | 把 `invalid` 也当成"缺证据"去查 consents ⇒ 红 |
| 无作者性装上后仍然一直在说 | `check.test.mjs` + `overdue.test.mjs`（摘要形状） | applied 时把 `code` 清成 null（警告消失）⇒ 红 |
| 忙时不换版 | `idle.test.mjs`（假 socket 不答探针） | 把超时当空闲 ⇒ 红 |
| 非默认 state-dir 不动 | `launchd.test.mjs` | 去掉读参数 ⇒ 红 |
| 握手不符即回滚 | `apply.test.mjs` | 去掉 restore 调用 ⇒ 红 |
| 状态文件 0600 + 读回校验 | `state.test.mjs` | 去掉 chmod/校验 ⇒ 红 |
| 过期判定 | `overdue.test.mjs` | 阈值改成 ∞ ⇒ 红 |
| 面板按钮可达性 | `engine/Tests/…/UpdatePanelTests.swift` | 无条件可用 ⇒ 红 |

## 7. 接口契约（面板、launchd、代理共用一处实现）

- 入口：`node <installRoot>/updater/cli.js <子命令>`。子命令与语义：
  - `check` 拉 release → §1 八道校验 → 通过则解包暂存（`<stateRoot>/update-staging/<ver>/`）并写状态；
  - `apply` 只在**已暂存且 §2 空闲判据通过**时换版（含 §3 的备份/握手/回滚）；
  - `status` 读状态文件并附 §4 的过期判定，不联网；
  - `rollback` 用备份恢复上一版并重启核对；
  - `enable` / `disable` 注册或卸载 launchd agent，并写 `disabled`。
- 退出码是契约的一部分（面板与 launchd 只能靠它判成败）：`0` 成功；`2` 用法错误；
  `3` 被拒（忙 / needs-consent / 任一校验不过）；`4` 已换版但握手不成、**回滚成功**；
  `5` 换版失败**且回滚也未成功**（必须人工，面板要把这句原样显示）。
- `--json` 时 stdout 恰好一行 JSON（状态文件同 schema：`updater/schema/update-state.schema.json`，
  本包内自校验；**不进 kernel**，它是本机安装态而不是跨语言证据契约），日志与人类文案走 stderr。
  面板解析失败要显示"读不到更新状态"而不是显示成功。
- 面板**不自己实现下载/换版**，只 `Process` 起这条 CLI 并读那一行 JSON；launchd agent 也起同一条命令。
- 路径发现：安装器把 `{updaterCli, installRoot, agentLabel, registeredAt}` 写进
  `<stateRoot>/update-install.json`（0600，临时文件 + rename + 读回校验 mode），面板与诊断都从这份
  指针读；指针指向的脚本不存在时状态是 `installer-pointer-stale`，面板提示重装而不是静默失败。
- 环境变量：`GLASSPANE_STATE_DIR`（状态根，与 daemon 同义）、`GLASSPANE_UPDATE_BASE`（仅测试/自建镜像，
  见 §1 的 https 限制）、`GLASSPANE_UPDATE_DISABLE=1`（等效 disable，且不注册 agent）。

## 8. 审后追加（2026-09-27，round 11：审这份实现本身查出的，已升为契约）

第一轮审计（读代码 + 现场复现）在这份实现上查出下列条目。它们不是"以后再说"，而是本节契约的一部分：
实现与测试都要按这里说，缺一条就是缺陷。

1. **空闲证据不许过期**。§2 的探针只在**换版前一刻**有效：构建可能要十几分钟，探针答过一次就去
   `kickstart` 等于用一条过期证据取消用户屏幕上正在执行的动作。判据改为：每一次 `kickstart`
   （换版后重启、回滚后重启都算）**前**都必须重新探一次并拿到回答；拿不到就 `deferred`，一次都不重启。
2. **七道校验的次序与"整链"必须被测到**。逐条测各 gate 不算数：`check` 的编排（哪条 gate 在哪个动作之前、
   任一不过就不落地）要有端到端用例。且**任何会执行暂存内容的步骤（自检脚本）必须排在所有网络可验的
   gate 之后** —— 先验完再运行别人写的代码。
3. **CI 凭据要指名道姓**。只要求"该 sha 上有一个 success 的 run"不够（文档工作流也算）。必须指名
   发布所用的 CI 工作流；提交号取 release 的 `commit_id`，`target_commitish` 只作缺失时的回落，
   并把用的是哪一个记进结果。
4. **产物 URL 与重定向都要钉住**。载荷里给的资产 URL 只能落在钉住的主机上（回环例外只服务于测试基址）；
   `redirect: 'follow'` 之后必须比对 `response.url` 的主机，不同即拒。否则攻击者只要在自己的 release
   文本里换一个地址，校验的就是自己发的两份文件。
5. **launchd 里的命令不得经过 shell**。渲染 agent 时把路径插进 `/bin/sh -c "…"` 等于把"路径里有个引号"
   变成每天以用户身份执行一次任意命令。判据：`ProgramArguments` 用 argv 数组，或先拒掉含 shell 元字符的
   路径并证明拒得住。渲染出的 plist 还要能被 lint/解析。
6. **读别人的输出要 fail-closed**。`launchctl print` 的参数字符串解析不能在第一处 `}` 截断——那样
   `--note=}` 就能藏住后面的 `--state-dir /别人的目录`，§2 的"别人状态根"闸门直接形同不存在。
   解析不出/不平衡 ⇒ 判为 `unknown`，按需要人工处理。
7. **npm 侧也要读回校验**。§1 的"装完把版本读回，不符就装回原版本"必须真的存在：只检查子进程
   `ok===false` 不算，它测的是桩，不是门。
8. **换版之后的失败要说"已经换了"**。`installBundles` 之后再抛错，若被顶层当成 `check-failed`/退出 3，
   状态文件与现场就不一致（面板会显示"什么都没变"）。判据：换版后的任何失败必须落在 4/5 两个语义里，
   并写清哪一半成功。
9. **不允许换到相同或更旧的版本**。`apply` 必须对着**apply 当时**实际安装的版本要求 `upgrade`；
   一次失败的 `check` 要清掉 `staged`，否则一份过期暂存树能把人手工装好的新版本降回去。
10. **关闭开关与状态根同一个 home**。`disable`/agent 路径若按 `$HOME` 解析而状态根按口令库记录解析，
    重定向过 `HOME` 的调用会"关掉"一个并不存在的 agent 并报告成功。两处必须同一个来源。

## 9. 网络这一跳的信任从哪来（2026-09-29，第一次在真机跑 `check` 查出的，已升为契约）

真机事实：本机 `api.github.com` 的证书链被替换成 `issuer=CN=SteamTools Certificate, O=BeyondDimension`
（本地加速器把系统代理指到 `127.0.0.1:15556` 并做 HTTPS 中间人，其根证书装进了 macOS 信任库）。
`curl` / `git` / `gh` 都查系统信任库因而正常；**node 的 `fetch` 只认自己打包的 Mozilla CA 束，不读钥匙串**，
于是 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`。实测：把系统根束导出成 PEM（163 张）后，
`releases/latest` 与 `.asc` 资产下载都恢复。

这不是"某台机器特殊"：企业网的 Zscaler/Netskope 与各类加速器是同一个形状，而"每天定时自动更新"恰恰最容易
装在这种机器上。第一次真跑就死在第 1 道校验之前，而当时 198 条测试全用假 HTTP 层，没有任何一条测到它。

1. **只有一个作者：`updater/lib/ca-bundle.js`**。安装器**不**自己实现一份导出——它注册 agent 走的就是
   `updater enable`，那条路上导出一次；这样"信任从哪来"只有一个写的人，路径也只有一个解析口径。
   命令：`security find-certificate -a -p` 对
   `/System/Library/Keychains/SystemRootCertificates.keychain` 与 `/Library/Keychains/System.keychain`
   （管理员装的根在后者），合并写进 `<stateRoot>/ca-roots.pem`。
2. **写入与其余状态文件同形**：临时文件 + rename + 读回校验，0600。证书计数为 0 ⇒ 判为失败：不留半个
   文件、不写 agent 的环境变量、安装日志说清哪一步空了。绝不把"导出成功"建立在 `security` 的退出码上。
3. **常态消费者只有两个，且都在进程启动前拿到变量**：launchd agent 的 plist 写
   `EnvironmentVariables.NODE_EXTRA_CA_CERTS`；面板 `Process` 起 CLI 时把同一个变量放进环境。
   node 只在启动时读这份束，所以**不许改 `NODE_TLS_REJECT_UNAUTHORIZED`、不加 `--insecure`、不降级到 http**。
   这条禁令必须有读者，否则它就只是一句话：`updater/test/trust-inversion.test.mjs` 扫生产代码
   （`updater/`、`installer/`、`mcp-shell/src/`、面板那几个 Swift 文件、`install.sh`、launchd 模板）里的
   这些开关，注释里的提及不算（注释不能执行），发布那条路径上还单独禁明文 http。
   唯一被允许的 re-exec 是第 10 条，而且只在"已经失败在证书上"之后发生一次；除此之外，在终端手敲
   `node updater/cli.js check` 的人若没设这个变量，正确行为是**失败并把 remedy 说出来**（见第 6 条）。
4. **`NODE_EXTRA_CA_CERTS` 是追加而不是替换**：node 仍在验证完整链，Mozilla 束继续有效，只是另外把
   那两个钥匙串里的**全部**证书也当作信任锚。措辞必须按实测写，不能写成"这台机器的管理员已经选择信任的那些
   根"——**信任设置不参与过滤**：被显式判为不信任的根、以及为别的目的躺在 `System.keychain` 里的 CA，
   都会对这个作业生效。作者机器实测 158 + 5 = 163 张，其中 161 张声明 `CA:TRUE`，另 2 张**没有声明 basicConstraints**。
   导出前按 `filterToAnchors` 筛：**只剔显式声明 `CA:FALSE` 的**（实测这类证书当唯一锚时 OpenSSL 直接
   `INVALID_PURPOSE`，本来就锚不住任何链，所以剔它是可证明无损的），读不出的与没声明的一律保留——凭猜测
   剔掉一张旧根，坏掉的正是这条机制本身。本机实测剔 0 张；状态里记的张数从此是"node 真能用的张数"。
   文档写清方向，否则读者会把它
   读成"关了校验"，或者读成"只信任系统认可的那些"——两种都是错的。内容级作者性
   仍由 §1 第 5、8 道兜住：下载字节必须匹配那份被我们自己的 key 签过的 `SHA256SUMS`，中间人签不出它。
   为什么不按信任设置过滤：`security dump-trust-settings` 没有机器可读的契约，一次静默漏掉拦截根的过滤，
   坏的正是本条要保的那次检查；能被看见的失败态才允许存在（第 2 条）。
5. **刷新点**：`enable` 注册 agent 时（安装器走的就是这条路）、每次 `apply` 成功之后、以及第 10 条的
   证书类失败恢复时。理由很具体：拦截根会轮换（本机那张到 2027-02），只在前两个点刷新等于
   "后来装了新代理的机器永远刷不到那张新根"。
6. **失败文案必须带真因和可执行 remedy**。`release-unreachable` 现在写 `GET <url> failed: fetch failed`
   ——真因在 `error.cause.code` 里被吞掉了；一个人/代理看到 "fetch failed" 只会去查网络通不通，而浏览器里
   GitHub 明明打得开。契约：TLS 验证类失败必须报出 `cause` 的 code，并点名**解析后的真路径**
   （`export NODE_EXTRA_CA_CERTS=/Users/<you>/.glasspane/ca-roots.pem`）；拿不到路径时要说"去 `updater status
   --json` 的 stateRoot 字段看那个目录"，**不许**在给人或代理的句子里留 `<stateRoot>` 这类模板占位符——一句
   带尖括号的话粘贴不了，也就不是 remedy。非 TLS 失败（`ECONNREFUSED`、DNS、4xx）**不得**
   套用这句 remedy，要报自己那条原因 —— 否则 remedy 本身成为误导源。
7. **状态是封闭枚举，不是布尔**。实现与路径由 `updater/lib/ca-bundle.js` 独家持有（单一作者），调用点是
   第 5 条那三处。枚举：
   `ok`（写出 N>0 张）/ `probe-failed`（文件写出来了，但带着它仍连不上 release 端点——这才是"这台机器还在
   被拦且束里缺那张根"）/ `empty`（`security` 有输出但 0 张证书）/ `unavailable`（没有 `security`
   工具，即非 macOS）/ `write-unverified`（读回与写出内容不符）。
   **端点自己答了一个非 2xx 不是束的失败**：403/404 说明 TLS 已经验通、是服务器不同意，记录必须留在 `ok`
   并把那个答复写进 `detail`。把它写成 `probe-failed`，remedy 就指挥人去改信任配置——而那恰恰是这里
   最不该乱动的东西（真机第一次安装就把它写成了 `TLS or DNS refused`，而九分钟后同一个 URL 直接 200）。
   记进状态文件的字段是 `caRoots`（可为
   `null` = 这份安装从未导出过，面板与 `gp_diagnose` 要说"旧安装，未记录"而不是"正常"）。
   `empty`/`unavailable`/`write-unverified`/`probe-failed` 都必须附 remedy；**只有 `ok` 才算可用**。
8. **导出之后探一次真的 release 端点**（best-effort）：探不通不阻断安装，但必须把原因写进安装日志、状态文件
   与面板，因为这条不修好，每日 agent 从装好那天起就是死的，而它看起来完全像"在正常工作"。
   探测必须**起子进程**（node 只在进程启动时读这个变量，在当前进程里设它等于什么都没设），并且必须把子进程
   自己那侧的原因（`REJECT <code> <message>` / `HTTP <status>`）带进记录——只留一个退出码，读的人就只能猜。
9. **绝不因 TLS 不可用而降级**：不放宽 `GLASSPANE_UPDATE_BASE` 的 https 限制、不走 http、不跳过任何一道
   校验。宁可这一版不更新（停在 needs-consent、面板显示原因），也不在信任链上打洞。

10. **证书类失败时重导一次束，并带着它把自己重跑一次**（2026-09-29 由用户批准；起因是真机形状）。
    只有第 1–9 条会留下一个**永久**状态：束只在 `enable`/`apply` 刷新，而 TLS 失败永远走不到 `apply`；
    机器后来装了新代理 ⇒ 每天定时检查死在第 1 道门上，面板读起来像"没有可用更新"。规则：
    · 判据是**结构化事实** `tlsVerification`（`source.js` 依 `error.cause.code` 判定后随拒绝对象带上），
      不许靠匹配自己写的句子——文案会改，判据不能跟着改；
    · 调用方已经把 `NODE_EXTRA_CA_CERTS` 指到**别的路径**时**不介入**：那份信任是他自己指的，方向归他，
      我们替他改指自己导出的那一份等于静默取消他的选择；他指的就是我们导出的那一份时**照常恢复**
      （终端里按 remedy 设过变量的人，走的就是这一条）；
    · 只重跑一次：`GLASSPANE_CA_REEXEC=1` 是防循环标记，带标记那次不再重导也不再起子进程；
    · 重跑的 argv 逐字相同（少一个参数就是另一件事），`--json` 那一行**只由子进程写**，父进程一个字都不加；
    · 束导不出来（`empty`/`unavailable`/`write-unverified`）就不重跑，但结论必须落进状态文件；
    · 子进程被信号杀死或压根没起来 ⇒ 退出码 `3`，绝不能是 `0`：一个"看起来跑完了每日检查"的 0 会把事故抹掉；
    · 恢复只发生在 `main()`（可执行入口），不在 `runCommand()`（库接口）——安装器是库调用方，它背后
      绝不该被偷偷起一个 CLI 子进程。

| 判据 | 测试 | 反向变异怎么红 |
| --- | --- | --- |
| 0 张证书＝失败，不留文件不写环境变量 | `updater/test/ca-bundle.test.mjs` | 桩返回空文本仍写文件 ⇒ 红 |
| 写后读回校验 mode 与内容 | 同上 | 去掉读回 ⇒ 红 |
| plist 携带该变量且路径被 XML 转义 | `updater/test/launchd.test.mjs` | 删 `EnvironmentVariables` 或不转义 ⇒ 红 |
| 面板 spawn 带上同一变量 | `engine/Tests/…/UpdatePanelTests.swift` | 环境不设 ⇒ 红 |
| TLS 失败文案含 cause code 与 remedy；非 TLS 不含 | `updater/test/source.test.mjs` | 回到 `${error.message}` ⇒ 红 |
| 五态封闭、各有说法，且 `caRoots:null` 读成"旧安装未记录"而不是"正常" | `updater/test/ca-bundle.test.mjs` + `installer/test/auto-update.test.mjs` | 把 `probe-failed` 并入 `ok` ⇒ 红 |
| apply 后刷新 | `updater/test/apply.test.mjs` | 去掉刷新调用 ⇒ 红 |
| 端点答 403 仍算 `ok`，不是信任失败 | `updater/test/ca-bundle.test.mjs` | 把 answered-non-ok 并进 probe-failed ⇒ 红 |
| 探测记录带子进程自己的原因 | 同上 | 丢掉 stderr 首行 ⇒ 那条 match 红 |
| 渲染出的 plist 能被**严格**解析器读（注释内不得有连续连字符） | `updater/test/launchd.test.mjs` | 把 state-dir 的双连字符写回注释 ⇒ 红；`plutil` 这个宽容 oracle 看不见 |
| 证书失败重导并重跑：argv 逐字、只一次、信号不返回 0、库调用方不起子进程 | `updater/test/tls-recovery.test.mjs`（8 条） | 删标记判断 ⇒ 循环那条红；空束也重跑 ⇒ 那条红；`status ?? 0` ⇒ 信号那条红；把恢复挪进 `runCommand` ⇒ main 那条红 |
| 第 3 条的禁令**有读者**：生产代码里不许出现任何关闭校验的开关，注释除外；行号必须指到文件里那一行 | `updater/test/trust-inversion.test.mjs` | 往 `updater/lib/source.js` 塞 `rejectUnauthorized: false` ⇒ 红；把模式表或文件集清空 ⇒ 那条"只扫到 0 个文件"红；把禁令词只放进注释 ⇒ 不许红（自测盯这一对） |
| 注册到盘上的那份 plist 真带着**写成功的那份束**（python3 plistlib 严格读，不是 `includes`） | `installer/test/auto-update.test.mjs` | `caBundle: null`、写空串、指到一个从没写过的路径、把"能不能用"改成"文件在不在" ⇒ 四条反向变异实测全红 |
| 给人或代理的句子不留 `<模板>` 占位符，能拿到真路径就写真路径 | `updater/test/ca-bundle.test.mjs` + `engine/Tests/…/UpdatePanelTests.swift` | 把 `<stateRoot>` 或"那份束的路径"放回文案 ⇒ 红 |
| 导出的束只留能锚链的证书，且**写出去的字节能被 node 再读一遍**（块间换行丢了会让整份束被 `PEM routines::bad end line` 拒收，而张数与读回比对都看不出来——这条是真机抓的） | `updater/test/ca-bundle.test.mjs`（三张真证书夹具：CA:TRUE / CA:FALSE / 无 basicConstraints） | 改成不剔 ⇒ 张数那条红；把块间换行丢掉 ⇒ 重组与解析那两条红；把「没声明」也剔 ⇒ 保守保留那条红 |
| node 对这个变量的**实测行为**（不是注释里的假设）：空束不致命、缺文件只报一行 Warning、空值等于没设 | `updater/test/ca-bundle.test.mjs`（真起子进程跑 TLS） | node 哪天真的对空束硬失败 ⇒ 这条先红，判据理由随之改写；不许靠记忆维护这段 |

## 11. 更新器自身的换版（2026-09-30，把 §1/§9 那些修复真正送到用户机器上所必需）

写这一节的原因很具体：§1 那四条真机高危（资产域名钉死、档案里的符号链接、CLI 参数失效、下载时钟）
与 §9 那一整束，全都住在 `updater/` 与 `installer/` 里 —— 而**每日作业跑的正是安装那趟 clone 里的那份代码**
（`update-install.json` 的 `updaterCli`）。§3.5 换的是 `.app` 与 npm 两个包，从不碰这份代码。于是
"修好更新器的那次发版"永远传不到用户机器上：他们的作业会继续用 v1.4.0 那份钉死规则，天天
`asset-host-unpinned`，而面板写着"已是最新"。**一条机制救不了它自己的缺陷，就等于没修**。

1. **唯一真源不变**：谁在跑更新，由 `<状态根>/update-install.json` 的 `updaterCli` 决定（面板与 launchd
   都从它取位置，§7）。本节只加一件事：换版成功之后，这份指针可以、也必须指向**验证过的发布树**在
   本机上的落地位置 `<状态根>/runtime/<ver>/updater/cli.js`。
2. **来源只能是被八道校验放过的那棵树，但落地的是更新器需要跑的那部分**：取材于 §1.6 自检过的暂存树
   （同一棵已按 sha256 实测、签名 verified、CI 绿、版本线自证的树），不许有第二条取材路径；落地动作发生在
   §3.5 全成功之后、暂存目录被清理**之前**。落地的目录清单是封闭的：`updater/`、`installer/`
   （`updater/lib/signature.js` 要 `import('../../installer/cli.js')` 取签名公钥，少它就是装一个跑不起来的
   更新器）、发布根的 `package.json`。曾经照"整棵树"复制，代价与风险都不是修辞：`apply` 就在暂存树里
   `swift build --package-path <暂存>/engine`，产品直接落在它下面——本机实测 `engine/.build` 509 MB，
   于是"两代上限"实际是半个 GB，还顺带把 SwiftPM 自己造的符号链接搬了进来。清单之外的东西（`engine/`、
   `mcp-shell/`）是换版**过程**的输入，不是更新器**运行时**的依赖。
3. **绝不就地覆盖正在执行的那份代码**：落地是"新建一个版本目录"，不是把文件写回旧目录。旧那份原地
   保留，这既是为了让"下一次注册由新代码自己完成"有可回退的目标，也是为了让**回滚**有对象。
   3a. **落地后的树里不许有任何间接层**。本机实测（2026-09-30）：`fs.cpSync(..., {dereference:false})`
       **不保留相对符号链接**——`link -> a.txt` 会被重写成 `link -> /private/…/复制来源目录/a.txt`，
       也就是指向这次运行稍后要清理掉的暂存树。留在 `runtime/` 里的就不是"同一根链接"，而是一根悬空、
       且指向 `<状态根>/update-staging/<ver>/…` 的链接，而那个路径**下一次 `check` 会用新下载的字节
       重新造出来**：一台被拒的树的内容，就这样每天被定时作业重新引用一次。所以落地前后都要走
       `lstat` 检查——目录本身必须真是目录（不能是指向别处的软链），树里每一项必须真是普通文件或目录。
       任一条不满足 ⇒ 拒绝落地、临时目录一并删掉、指针不动。
   3b. **"这一代已经在盘上"不是可以跳过的理由**：`runtime/<ver>` 已存在时，重用的那条路要把新装那一路
       的每一项检查重做一遍（是目录不是链接、无间接层、`updater/cli.js` 读得出且非空、mode 能到 0700）。
       早先的版本只查"cli.js 存不存在"，于是一次 mode 检查失败的残留，会被下一次同一版本的换版**无条件
       接受**——一次"这台机器的 chmod 不生效"就永久变成了"这一代是干净的"。mode 检查现在也在标记落地
       **之前**做：不生效就连根目录一起删掉，绝不留给重用路径。
4. **换版本身的判定不因它而改**：`.app` 与 npm 都换成功、握手也过 ⇒ `status=applied` 与退出码 0 不变。
   更新器自己没换上是一句**长期可见的降级**：`runtime.status='failed'`、`code=runtime-stale`、
   `lastError` 带原因，面板与 `gp_diagnose` 必须原话说"这次更新器自身没换上，请重跑安装程序"。
   这与 `authorship` 同一处理形状：不把一次不完美的成功洗成干净。
5. **指针可回退**：写指针仍走 `writePointer`（临时文件 + rename + 读回校验 + mode）；落地/注册任何一步
   失败，先把指针写回旧值，再用**旧那份** `cli.js enable` 一次把作业指回去（best-effort，失败要写进
   状态与原话，不许静默）。
6. **交接（handover）分两种触发，因为定时那一次会把自己拆掉**：
    · **人工触发**（面板的「立即安装」、终端里的 `updater apply`）——注册由**新那份代码自己做**：
      `node <新 cli.js> enable --state-dir <状态根> --json`。理由不是风格：plist 里那条 CLI 路径的来源就是
      "谁在跑这次注册"（`fileURLToPath(import.meta.url)`），由旧代码去写新路径等于再造一个"两处作者"。
      注册完必须用 `launchctl print` 把**在册**参数读回来校验它真指过去了；读不到或指回旧的 ⇒
      `agentVerified=false`，这是一句要说出来的失败，不是"大概说话了"。
      这条比较必须是"同一个文件"而不是"同一个字符串"：plist 里那条路径是 node 自己报的模块位置，
      **node 会先把路径 realpath 化**（实测：通过 `/tmp` 下的软链启动脚本，`import.meta.url` 报的是
      `/private/tmp/…`），而状态根是 `path.resolve` 出来的字面量。两者在 `/tmp`、`/var/tmp` 或任何带
      软链的家目录上拼写不同、指向同一份文件——按字符串比就把这套机制在**它自己被验证的那种沙箱**里
      永久判成失败。
      `enable` 还要保住这台机器已有的每日时刻：不带 `--hour` 的 `enable`（交接那一次就是）先读盘上
      那份 plist 的 `StartCalendarInterval`，读到就沿用，读不到才用 §2 的默认值**并说出来**。之前它
      直接取常量，于是每台自己换过版的机器都在无人告知的情况下被搬回 12:00。
    · **定时触发**（agent 里的 `apply --auto`）——**不**在这次运行里 bootout/bootstrap：本次运行本身就是那个
      作业，`bootout` 会在"包已换、状态未写"之间把它拆掉，最坏形状是作业被卸了却没装上（自动更新静默消失）。
      这一支只做落地 + 换指针，并记 `runtime.status='skipped'`、`code=runtime-registration-pending`、
      `agentVerified=false`，原话说清"下一次 `updater enable`（面板开关关再开就是这个）会把它接手"。
      判据不许在这里含糊：没核实过就不能说核实过。
7. **硬关时不注册**：`GLASSPANE_UPDATE_DISABLE=1` 或状态里 `disabled=true` 时，runtime 与指针照刷
   （面板用的就是那份代码，不刷它面板会继续跑旧代码），但**绝不**新建/改写 launchd 作业，并把这句
   原话记进状态（`runtime.status='kept'`）。
8. **只留还被指着的那几代**：默认两代，但**凡是有人指着的一律不清**，而"指着"有三个互相独立的作者：
   新指针那一代、上一个指针值那一代，以及**在册作业自己那一代**。第三个最容易漏，也唯一致命：连续两次
   定时换版（用户从不碰开关）时，指针已经是 `1.8.0 → 1.7.0`，而 launchd 的定义里还写着 `1.6.0`——
   按"指针 + 上一指针"清理就会删掉作业真正要执行的那一棵，明早的每日作业变成 `Cannot find module`，
   面板上的开关仍然亮着，状态里还写着 `skipped`。所以 defer/kept 两支也必须 `launchctl print` 读回
   在册参数、把它那一代钉住。
   **读不回在册作业时不许清理任何东西**："不知道作业在跑哪一代"不能当作"哪一代都没人指"来花。跳过清理
   的代价是一个版本目录；猜错的代价是这台机器从此不再自动更新。这一句要原话进 `runtime.detail`。
   "最新的一代"必须由版本号比较决定，不能按字符串排：`1.9.0` 排在 `1.10.0` 前面，于是按字符串留下的
   回退代可能是谁都没指的那一个，而被删掉的恰是某个进程还在跑的那一个。
   清理只在状态根内走 `removeTreeWithin`，不许越界，失败要说出来，不许报成"已清理"。
   代价要写出来（并按第 2 条的封闭清单重算）：本机实测一份完整发布树 73 MB，其中 `updater/` 816 K、
   `installer/` 184 K，其余是换版**过程**的输入（`engine/` 里 1.8 G 的 `.build`、`mcp-shell/` 33 M）。
   按清单落地之后，一代就是更新器自己要跑的那些文件；两代的上限不再是半个 GB，而 `gp_diagnose`、
   换版日志仍要报清这次删了哪几代、为什么没删。
9. **写它的时机保证读者不会比写者旧**：`apply` 的顺序是先换 `.app`、重启并握手、再装 npm 两个包，
   **最后**才落地更新器自身并写 `runtime`。所以任何一份读到 `runtime` 的读者（面板在 `.app` 里、
   `gp_diagnose` 在 npm 包里）都已经是认识这个字段的版本——反过来（先写字段再换读者）会让已发布的
   shell 因为"schema 里多了一个不认识的键"把整份状态读成读不出，那才是真的看不见。
10. **封闭形状，三个读者**：`runtime` 进 `update-state.schema.json`（`additionalProperties:false`，
   状态是封闭枚举 `refreshed` / `failed` / `kept`），updater、面板、`gp_diagnose` 三处都读；
   读不懂的取值只能判成"读不出"，不许就近当 `refreshed`。枚举里**不许躺一个没有调用点的取值**，
   所以四个成员各自绑一个真实分支：`refreshed`（人工触发、已换且在册作业读回核对过）、`failed`（换版成功
   但更新器自身没换上，或被回退）、`kept`（这台机器自己关着定时作业，只换代码与指针）、`skipped`
   （定时那一次有意避让自己——见第 6 条，代码与指针换了，交接留给下一次 `enable`）。
   反向（旧读者遇到新记录）分两种，只有一种该失败：
   · 认不出**值**（`runtime.status` 是未来版本的某个词）必须响地失败：`loadState` 走 `assertValidState`，
     读不懂就抛错、命令拒绝执行；它绝不"退回空状态"，那等于把这台机器的更新历史抹掉一次。
   · 认不出**键**在**读**的路上必须被忽略。第 6 条的 defer 交接正是这个形状：定时那一次写了带新键的状态，
     而接下来几天跑的还是旧那份代码——旧读者若因"schema 里多了一个不认识的键"拒绝整份文件，这台机器的
     `updater status` 与每日检查会直接失败，把一台还能工作的机器读成一台坏了的机器。
   因此**写严格、读宽容**是刻意的不对称：`saveState` 仍按 `additionalProperties:false` 拒绝发布任何
   自己没声明的字段（否则第 9 条的写序保证就没了），`loadState` 只忽略不认识的键。新增字段仍须先让读者
   发布、再让写者写；新增**枚举取值**是破坏性变更，必须先换读者。
11. **装上的第一版仍是旧形状**：本节落地前装出来的机器，指针仍指着那趟浅 clone；它需要**一次**人工重装
    才会进入"由更新器自己换版"的形状。这句话必须写进 CHANGELOG 与 README，不能让人以为升级自动完成。
12. **回滚只回它换过的东西**：`updater rollback`（§3.6）换回两个 `.app` 并重启校验，但它**不**把
    `runtime` 与指针换回旧代——那是"上一版更新器的代码"，而回滚的动机通常是新 `.app` 有问题，不是新
    更新器有问题。这句话要写在这里，否则读代码的人会以为 §11 落地后回滚是整台机器的时间倒退。
    与之相对：`apply` 自己在**交接之后**才失败的那一条（重新导出根证书束、清理暂存树、写最后那份状态）
    必须把指针与作业一起交还给旧那一份——因为那一次的动机恰恰是"这次换版没走完"，留着新指针就等于
    一边说"已还原并核实"，一边让明天的作业跑刚被换出去的那一份。交还由旧那份自己 `enable` 完成，
    并用 `launchctl print` 读回核对；`registeredAt` 沿用原值，回退不是重新安装。
    读不回来时记录 `runtime.status='failed'` 并写清"指针可能还指着被换出去的那一份，请重跑安装程序"。

| 判据 | 测试 | 反向变异怎么红 |
| --- | --- | --- |
| 落地取自暂存树、发生在清理之前、不就地覆盖旧代码 | `updater/test/runtime.test.mjs` | 先清暂存再落地 ⇒ 红；写回旧目录 ⇒ 红 |
| 指针换到新路径且盘上真存在 | 同上（读回真文件，不信返回值） | 少写 `updaterCli` 或指到没落地的目录 ⇒ 红 |
| 注册由新那份跑，在册参数用 `launchctl print` 读回校验 | 同上 | 用旧那份注册 ⇒ 红；把"读不到"当成功 ⇒ 红 |
| 定时那一次不拆自己：只落地与换指针，并明说尚未接手 | `updater/test/runtime.test.mjs` + `apply.test.mjs`（`trigger:'auto'`） | 去掉 `handover:'defer'` 分支 ⇒ 那两条红（enable 被叫了、状态说成已核实） |
| 任一失败都把指针与作业指回旧值并说话 | 同上 | 只回滚指针不回滚注册 ⇒ 红；失败后不写 `lastError` ⇒ 红 |
| 硬关时刷代码不建作业 | 同上 | 去掉 disabled 分支 ⇒ 红 |
| 换版判定不被它改：applied 与退出码不变，降级长期可见 | `updater/test/apply.test.mjs` | 把它失败改成 `status`/退出码 ⇒ 红；洗成 `code:null` ⇒ 红 |
| 清理钉住三个作者各自指着的世代；读不回在册作业就一个都不删 | `updater/test/runtime.test.mjs`（`pruning never deletes a generation something still points at`、`a job book that cannot be read leaves every generation on disk`） | 把 `job.gen` 从 pinned 里去掉 ⇒ 那一代被删、红；把"读不到"当成"没人指" ⇒ 跳过清理那条红 |
| 世代新旧按版本号比，不按字符串 | `updater/test/runtime.test.mjs`（`the newest generation is decided by version, not by how the string sorts`，钉住最旧一代使两种顺序答案相反） | 换回 `.sort().reverse()` ⇒ 删的是 1.10.0 而不是 1.9.0，红 |
| 落地清单封闭，构建产物不进 runtime | `updater/test/runtime.test.mjs`（`engine/.build`、`mcp-shell/dist` 不在落地树里；`installer/cli.js` 在） | 清单里放回 `engine`/`mcp-shell` ⇒ 排除断言红 |
| 落地树里不许有间接层，`runtime/<ver>` 本身必须是真目录 | `updater/test/runtime.test.mjs`（`a copied tree that carries a symlink is refused`） | `findIndirection` 改成返回空 ⇒ 红 |
| 重用已存在的一代要把每一项检查重做 | `updater/test/runtime.test.mjs`（`an existing generation is re-verified, not trusted by name`） | 重用路径只查 cli.js 存在 ⇒ 红 |
| 在册路径与本地拼写按"同一个文件"比，不按字符串 | `updater/test/runtime.test.mjs`（realpath 拼写的那一代仍认得出世代） | 只比字面量前缀 ⇒ 认不出世代，红 |
| `enable` 保住盘上已有的每日时刻 | `updater/test/enable.test.mjs`（`a bare enable keeps the daily hour that is already installed`；断言打在**送进渲染器的参数**上，不是打在夹具自己写的文件上） | 常量优先 ⇒ 3:20 变成 12:00，红；读不到又不说 ⇒ 第二条红 |
| 注册是否成立由读回的在册作业判定 | `updater/test/launchd.test.mjs`（三条：核对过 / 仍指旧的 ⇒ 拒绝 / 读不回 ⇒ 明说未核实） | bootstrap 0 直接算成功 ⇒ "仍指旧的那条"红 |
| 交接之后才失败的回滚，指针与作业一起交还 | `updater/test/apply.test.mjs`（`a rollback that happens after the handover takes the pointer and the job back too`） | 去掉 undo 调用 ⇒ 交还那一次没发生，红；`runtime` 声明在 try 里 ⇒ catch 抛 ReferenceError，红 |
| 删除不越界、失败不报成已清理 | `updater/test/runtime.test.mjs` | 去掉 root 约束 ⇒ 红 |
