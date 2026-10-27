# GlassPane 更新系统 · 2026-10-26 状态与量测

本轮起点是用户报的两件事：旧版 GUI 里点「安装更新」探测到更新却显示失败；改用 `npx` 重装，被
"本地已有同名目录"拒掉。他要的是把这个产品的更新路径修到"能推荐用户直接用 npm 装、装不动时给得出
精确补救"的程度，并授权发版。下面四格是查出来的真原因与本轮的处理；每一格的读数都注明量法。

台账唯一真源是本文件。代码侧的判据原文在
[规格 §3.3/§3.5](./GlassPane_规格_自动更新_2026-09-27.md)（本轮按契约改了 4a），契约决定记在那里，
本轮的过程与实测记在这里。

## 四条根因

1. **读回在册作业吃的是本仓发明的形状。** `updater/lib/launchd.js` 的两个读取器：
   `parseLaunchctlEnvironment` 在 `=` 处切行，而 launchd 的字典写的是 `KEY => value`——箭头的 `>`
   被当成值的开头，于是每一项读数都比本次渲染的多一个前缀，`registerAgent` 的那格环境比较在一台
   两边逐字一致的机器上恒答"环境仍不一致"。`parseLaunchctlSchedule` 找的
   `start calendar interval = { … }` 块 launchd 根本不打印（每天的钟点在
   `event triggers → <label> → descriptor → "Hour" => 12`），于是它永远答 null——2026-10-19 为
   "bootout 没成而 argv 不变"加上的那格钟点比较，从未在任何真机器上跑过一次。
   两者在 CI 常绿，因为夹具发的就是那两种假形状（夹具形状必须来自真报文那一族的旧账）。
2. **一次"读失败的读数"能改掉机器的每日时间。** 盘上那份 plist 被 `readAgentSchedule` 读不出时，
   不带 `--hour` 的 `enable` 就用文档默认 12:00 渲染并注册；这一格在 §11 的换版交接里每版都跑一次。
   代价只写在消息尾巴上，状态里没有任何一行说这台机器的钟点被换过。
3. **npm 全局层刷不动 ⇒ 整场更新被取消。** §3.5 的预检本身是对的（2026-10-01 那台机器"换完再退、
   一天两回"就是靠它结束的），但它的答案此前是 `deferred` + "什么都没换"。用户看到的"探测到更新、
   显示更新失败"就是这一条：那两个 `.app` 明明装得上去，被一层本来就没有的全局包取消了。
4. **安装目录里那棵旧 clone 没人管。** `install.sh` 打印一句"既有 clone 不会被自动切到
   v1.21.0"然后**照用那棵树**构建（这台机器上那是 v1.5.0 的 clone）；`npx glasspane-install` 对同一
   个目录跑 `git clone`，被 git 以 "destination path … already exists and is not an empty directory"
   拒掉，提示是"换个目录"——下次还落在同一个地方。同一件事两条一键入口给两种答案。

## 契约（用户 2026-10-26 定的三条）

- **部分成功＋精确补救**：够不着 npm、前缀写不进去、npm 答不出前缀，只挡住全局层那一格；bundle 照换、
  daemon 照重启并读回版本，结论 `applied` 带 `npm-not-refreshed`，同一句话里给出
  `npm install -g glasspane-mcp@<版本> glasspane-install@<版本>`，并写明它取 registry 的发布物、不是
  本轮核验过的暂存树。这一句挂在 `lastError` 上，面板与 `gp_diagnose` 一直说到那行被跑过。
  两条不松：预检说够不着就不许再碰全局层；被留下的旧转发层若**装着却答不出 `tools/list`**，这次换版
  就是它坏的原因，照旧回滚（"那一半没答上来"与"这台机器本来没有那一半"是两件事，后者按 §3.3 在
  2026-10-01 认下的那条只读 daemon 这一半，并在结论里写明 MCP 那一半没被问过）。
- **既有 clone：干净就前进，脏就拒＋给命令。** 判据一份（`existingCloneDecision`）：porcelain 空 ⇒
  fetch + `checkout --detach`；不空 ⇒ 拒绝 + 点名前 10 个路径 + 给换 `GLASSPANE_INSTALL_DIR` 的走法；
  HEAD 或该 tag 指向的 commit 读不出 ⇒ 也拒绝。切完按事实复判。没有 `-f`、`stash`、`clean`、
  `reset --hard`——安装器不该有能把别人的未提交工作抹掉的那一格。
- **在 `glasspane-install` 里加一条 `glasspane`**（不新起裸名包）：`doctor`（六格只读，每格
  available / absent / unverified）、`update`（先 check 再 apply，检查停住就不进安装）、
  `status`。一切按 `~/.glasspane/update-install.json` 解析，绝不从 cwd 猜一份安装。

## 量测（每条写明量法，不是"我数过了"）

- 本机 `enable` 的前后对照：**已装的 1.21.0** 在修之前跑
  `node /Users/ethanlin/glasspane-v1.21.0/updater/cli.js enable --state-dir ~/.glasspane --json`
  → rc=3，句子是那句假不一致（`PATH, NODE_EXTRA_CA_CERTS`）；修后同一条命令（dev 树，注册的仍是
  同一个稳定入口 `~/.glasspane/runtime/agent-entry.js`）→ rc=0，消息里看得见读回来的钟点。
  顺带量到这台机器的历史：钟点曾从盘上读不出（本机那份 plist 的具体字节被第一次 enable 覆盖掉了，
  取证顺序是我的错——应先拷贝再动手），而 launchd 当时挂着 12:30。
- `glasspane doctor` 在本机跑通：`装着=` 那格从前答 `?`，因为 `status --json` 把状态整体放在
  `state` 里；`全局 npm 包` 那格从前答"不知道"，因为 `npm ls -g --depth=0 --json` 是**美化过的多行**
  文档而读取器取的是最后一行（拿到 `}`）。两处都改并按真形状建了夹具。修后本机读数：
  `glasspane-mcp=1.21.0 glasspane-install=1.20.2`——这台机器自己的全局层就是半新的，正是
  `npm-not-refreshed` 要说的那种状态。
- `glasspane update` 在本机跑通：`检查：up-to-date` → 不进安装；`glasspane status` 随后把状态里的
  `current` 从 1.6.2 刷到 1.21.0（盘上两枚 bundle 的 `CFBundleShortVersionString` 实测均为 1.21.0）。
- 测试：`npm test`（三个 workspace 各跑一次）rc=0 —— mcp-shell 652 / installer 241 / updater 688，
  三个套件各自 0 fail（这一行的旧读数 237+10 是 1.22.0 那棵树量的，1.23.0 的三条修复把 installer
  那一套加到 241 条）；`node scripts/check-doc-links.mjs` 32 份文档 / 262 条内链无死链、双语成对、
  可复算主张与真源一致。
- 反向变异 26 笔（`/var/tmp/mutation-battery-2428.py`，逐笔要求具名用例变红；被改的七个文件每笔之后
  按 sha256 与原件逐字核回）。这一轮它抓到两类东西：产品侧一处**没有读者的句子**（回滚时"这一趟没碰
  全局层"那句当时没有任何断言读它，M15 因此零红——补了断言才成立），以及电池自己的一处作用域错
  （`apply.js` 的变异只跑了 `apply.test.mjs`，而钉它的是另外两个套件的用例；扩了范围才问得到）。

## 剩下没闭合的格子，写清不藏

1. ~~**1.22.0 的发布链**~~ **已闭合**（2026-10-27 零三分，逐格读数见下面"发布读数"）。
   本文件写完之后真机走查又抓出三条，都已修并发出去（见"发布之后抓到的三条"那一节）。
2. ~~**本机 `~/glasspane` 那棵旧 clone**~~ **已前进**（2026-10-27 零六分，用户当天选的正是"让它前进到
   发布 tag"）。走的不是手工 `git`，是 npm 入口自己的两个生产函数（`bootstrapPlan` +
   `advanceExistingClone`）——这一趟把 #27 那条判据的真缺陷抓出来了，见下一节第 1 条。
   改后的读数：`HEAD` 从 `fb63118`（`v1.5.0-1-gfb63118`）到 `434bc51`，`git describe --tags` = `v1.22.0`，
   `git status --porcelain` 仍 0 行，`--is-shallow-repository` 仍 `true`（前进没有改变深浅）。
3. **面板那一格**：`npm-not-refreshed` 通过既有的 `lastError` 通道显示（`showsFailureCard` 在
   `lastErrorMessage` 非空时不看状态），所以本轮没改 Swift。真正的缺口是**没有一条 npm 交付的预编译
   引擎**：三条渠道最后都要本地 `swift build`，所以"用 npm 装"仍然要求 Command Line Tools——这句
   写在两份 README 里，不是可以悄悄省掉的代价。
4. ~~**daemon 是否还在 1.6.2**~~ **已换到 1.23.0**（2026-10-27 零四十三分，`updater apply` 在这台机器上
   真跑完，见"1.23.0 的发布读数"那一节最后一条）。盘上两枚 bundle、`glasspaned --version` 与状态里的
   `current` 三处同读一个数，在跑的进程（pid 97127）就是那枚新二进制。
   本轮动了的是**全局 npm 层**（`npm install -g`，见下面的本机交付读数），那一层不需要重启任何进程；
   daemon 那一格最后也动了，动之前先量过"此刻没有别的客户端连在 socket 上"（`lsof` 只有监听者自己一行）。

## 发布读数（2026-10-27，每条写明命令）

### harness 0.12.1

用户 2026-10-27 在"等下一轮带上真修复"与"现在发"之间选了后者。理由不是"想发个版本"，是父仓那把
尺子 `harness/tools/release-artifact.mjs` 要求搬运仓 `refs/heads/main` **始终**等于主干的
`harness/glasspane-harness` 子树，只给已发布的 tag 一格具名豁免（`△ artifact`），而那格只允许
`SYNCLOG.md` / `CHANGELOG.md` 在"台账落后"这一个方向存在。v0.12.0 之后主干落的是两份 README
（npm 优先那处改写），不在豁免里 ⇒ 那一格红的是"发布物里没有主干已经有的东西"——0.7.10 与 0.8.0
两次事故的同一个形状。

- 搬运分支：`git subtree split --prefix=harness/glasspane-harness -b split/glasspane-harness` → `f21b4f32`。
  推之前证明它是同一棵树：`git rev-parse split/glasspane-harness^{tree}` 与
  `git rev-parse HEAD:harness/glasspane-harness` 都是 `ab049bff0dad1e6261f23038043ed764f6b429cb`。
  **这次是快进**（`git merge-base --is-ancestor harness/main split/glasspane-harness` 成功），
  所以按 `docs/release.md` 第 3 步用普通推送，`--force-with-lease` 那条兜底没有动用。
- tag：`git push harness split/glasspane-harness:refs/tags/v0.12.1` →
  `git ls-remote --tags harness` 回 `f21b4f32`。推 tag 之前先 `git fetch harness` 回读确认远端 main
  已到 `f21b4f32`（10-16 那次 403 就是顺序反了）。
- GitHub Release：tag 推送触发的 run `40419832597` 全绿（9m26s，`version-check` → `create-release` →
  两个 `binary` → `checksums`+签名 → `publish-release`）；
  `gh release view v0.12.1 --json isDraft,assets` 回 `isDraft=false` 与 6 件资产。
  `version-check` 里"CI for the commit this tag points at"是 `assert-ci-green.mjs --budget 1800000
  --poll 30000` **等**到的：CI run `40419788621` 两 job 全绿。
- 签名锚点：`gpg --verify --status-fd 1 SHA256SUMS.txt.asc SHA256SUMS.txt` 打出的
  `VALIDSIG 0929EA31DF4F7429F63FC53189D88B1D043A1298` 与 `updater/lib/signature.js:118` 的
  `PINNED_PRIMARY_FINGERPRINT` 逐字相等。
- npm：`gh workflow run release.yml --repo jingzhao-l/glasspane-harness --ref v0.12.1
  -f publish_npm=true -f confirm=true` → run `40420968912` 全绿，含最后一格
  `install the published bytes and run them`；`npm view <包> version --prefer-online` 三个都回 `0.12.1`。

### GlassPane v1.22.0

- 打 tag 前先问 `node scripts/assert-tag-ready.mjs 1.22.0 --repository jingzhao-l/GlassPane`
  → 放行（`HEAD == origin/main == 434bc516`，`ci.yml` 在**这笔 sha**、`event=push` 通道里最新一条
  success；那条红过的 `harness-rulers` 是 `gh run rerun 40419140202 --failed` 转的绿，10 个 job 全绿——
  它红在重切**之前**的时序，是"旧 sha 转不了绿"的反例）。
- tag：`git tag -s v1.22.0 -F /var/tmp/gp-tag-1220-msg` → `git verify-tag v1.22.0` 打出
  使用 `0929EA31DF4F7429F63FC53189D88B1D043A1298`、"完好的签名"、`[绝对]`；
  `git push origin v1.22.0` → `refs/tags/v1.22.0^{}` = `434bc516`（tag 指的是发布线那一笔，可达）。
- GitHub Release：run `40421130342` success（`release archive` job）；
  `gh release view v1.22.0` 回 `isDraft=false` 与 4 件资产；
  `SHA256SUMS-1.22.0.txt` 里那行 `337b0d05…7df8ad  GlassPane-1.22.0.tar.gz` 与 API
  `assets[].digest` 的 `sha256:` 逐字相等（本机不重新下载大文件做哈希，这条 10-16 就记过）。
  `.asc` 的 `VALIDSIG` 同一把钥匙。
- npm：`gh workflow run release.yml --ref v1.22.0 -f mode=publish` → run `40421215427` success
  （`publish bare names with provenance`）；`npm view glasspane-mcp version --prefer-online` 与
  `glasspane-install version` 都回 `1.22.0`，`@1.22.0` 逐字同号。
  **交付形状**：`npm view glasspane-install@1.22.0 bin` 回
  `{ glasspane: 'glasspane.js', 'glasspane-install': 'cli.js' }`——第三条契约（"注册一条 `glasspane`
  命令"）到这一格才算交到用户手上。
- 本机交付：`npm install -g glasspane-mcp@1.22.0 glasspane-install@1.22.0` rc=0。

  跑之前先量了那两个目录（§3.4a 的预检口径）：`/usr/local/lib/node_modules` 与 `/usr/local/bin`
  实测 owner `501:0`、`W_OK` 通过 ⇒ **这条补救在这台机器上 agent 自己做得动，不需要谁 sudo**。
  装完 `/usr/local/bin/glasspane` 是 `../lib/node_modules/glasspane-install/glasspane.js` 的符号链接
  （与 1.12.3 那次把 `glasspane-install` 打回 0 字节的同一形状），命令照常答话：
  `glasspane doctor` 六格全答、`全局 npm 包：glasspane-mcp=1.22.0 glasspane-install=1.22.0`、rc=0。
  这就是第 3 条根因（"探测到更新、显示更新失败"）留下的那半台机器被那句 remedy 收尾的样子。

## 发布之后真机走查抓到的三条（归 1.23.0）

上面那格"已前进"不是一句顺手的交代——它是**走查的产物**，而走查第一趟是红的。

1. **npm 入口对"本地还没有那个 tag"的旧 clone 恒拒**（真缺陷，`installer/cli.js`）。
   1.22.0 刚交付的前进判据里，"该 tag 指向的 commit 读不出"与"HEAD 读不出"被并成同一句
   "判不出来就拒"；而 `bootstrapPlan` 在**判据**这一层就问到答案，于是真正会去 fetch 那个 tag 的
   `advanceExistingClone` 永远轮不到执行。`install.sh` 那一支是对的（先 fetch 再判），
   于是两条一键入口对同一棵树给两种答案——正是 finding 10 那一族，只不过这次是我自己新造的。
   实测形状取自本机那棵树：porcelain 0 行、HEAD `fb63118`、tag 表停在 `v1.5.0`、浅仓 ⇒
   `rev-parse --verify v1.22.0^{commit}` 答非零 ⇒ 旧代码回 `refuse`，拒绝文案还让人自己去跑
   `git fetch --tags --depth 1`（那本来是代码自己会做的事）。
   现在 tag 缺席归到"前进"，fetch 不成仍由 IO 步拒并交出 git 的原话；HEAD 读不出照旧是拒：
   前者是**能补的事实缺口**，后者是**判据本身没了**。
2. **前进旧 clone 的那次 fetch 会把完整仓变成浅仓**（`install.sh` + `installer/cli.js` 两处）。
   无条件 `fetch --tags --depth 1` 的实测代价（`/var/tmp/gp-depth-probe`，2026-10-27 零二分）：
   一棵 `is-shallow-repository=false` 的 clone，跑一次 `git fetch -q --tags --depth 1 origin v2`
   之后答 `true` 且 `.git/shallow` 出现——而脚本当时打印的是"只往 .git 里加对象，不动工作树"，
   那句话把"给一份完整历史落下人为边界"说成了无害。改成先问 `git rev-parse --is-shallow-repository`：
   只有 git 亲口答 `true` 才带 `--depth 1`；答不出来（老 git、不是仓库）按完整仓处理，
   宁可多取一点也不替别人的历史加边界。本机那棵是浅仓，所以它走 `--depth 1` 那一支、深浅不变。
3. **`glasspane --help` 回的是 rc=2 与一句"不认得命令"**（`installer/glasspane.js`）。
   用**发布物**量到的：`/usr/local/bin/glasspane --help` 非零，而同产品的 `glasspane-install --help`
   打用法退 0；agent 与人敲的第一反应都是 `--help`，给它非零等于教它"这条命令不能用"。
   `-h` / `--help` 现在是一张明面上的别名表（`VERB_ALIASES`），用法页也写了；`--version` 这类
   未知选项照旧退 2——打错的命令不许被读成帮助。

### 这三条各自的闸

- 新增/改指用例：`installer/test/cli.test.mjs` 40 条（判据分叉、`readCloneFacts` 的三态深浅、
  `advanceExistingClone` 的 fetch argv 两形与 fetch 失败那一拒），
  `installer/test/install-sh.test.mjs` 26 条（浅/完整两棵真 clone 端到端、两侧动作对照表补了
  "干净但本地还没有那个 tag"这一行），`installer/test/glasspane-command.test.mjs` 11 条。
- **夹具自己翻过一次车**：第一版"完整 clone"用 `git clone --branch <旧 tag>` 造，而全量 clone 会连
  `refs/heads/main` 一起拉下来 ⇒ 要装的 tag 可达、被 auto-follow 带进本地 ⇒ 前提"本地还没有这个 tag"
  根本没成立，fetch 那一支一步都没走而用例照样绿。补了 `--single-branch` 与两条**夹具前提断言**
  （`isShallow()`、`hasTagLocal()`）才问得到这件事。
- **反向变异 9 笔**（`/var/tmp/mutation-battery-2027.py`，日志 `/var/tmp/gp-battery-2027-run2.log`：
  `落地=True 具名命中=是 核回=是` ×9，`battery rc=0`；三个被改文件写回原件后 sha256 与原件逐字相等）。
  它同时抓到我自己两处：M9（把命令里的 `$_depth` 删掉、`say` 那行照打）**第一次绿了过去**——因为断言读的是
  stdout 那句回显而不是执行的 argv，于是补了一只记账的假 `git`（`makeGitSpy`，转给 `/usr/bin/git` 干活、
  把 argv 落文件）改读 argv；另一处是电池自己的读数错（`核回` 在写回原件**之前**量，九笔全打"否"），
  那是把仪器当结论的现成例子。这是本项目第三次记"断言回显状态而不是指令"那一族。
- 真机复跑：`node` 直接吃 dev 树的 `installer/cli.js`（`/var/tmp/gp-advance-devtree.mjs`）把本机
  `~/glasspane` 从 `fb63118` 前进到 `434bc51`（`v1.22.0`），随后用 git 自己的命令独立复核而不是信
  代码那句自述：`rev-parse HEAD` = `434bc516…`、`describe --tags` = `v1.22.0`、`status --porcelain`
  0 行、`--is-shallow-repository` 仍 `true`。

### 版本判断：为什么这三条走 minor（1.23.0）而不是 1.22.1

1.22.0 的条目里我自己写下了判据：**patch 要求"状态文件的字段没动、退出码集合没动、CLI 参数没动、
npm 包的 `bin` 声明没动"**。本轮动了其中一项——`glasspane` 新接受 `-h` / `--help` 两种写法，
且一条原本拒绝的调用（旧 clone 上的 `npx glasspane-install`）现在会前进。
四十分钟前发布的规则不当场改口，否则版本号就不再是机器读得到的承诺。`1.23.0` 实测未被占用：
`git ls-remote --tags origin` 里没有 `refs/tags/v1.23*`（`grep -c` 回 `0`），
`npm view glasspane-mcp versions` / `glasspane-install versions` 的列表都以 `1.22.0` 结尾。
已发布的 `v1.22.0` 一律不动（tag 绝不移动，那枚锚点的字节与版本号从此锁死）。

## 1.23.0 的发布读数，与用发布物的端到端复跑

### 发布链（每条命令都在文件里，不写"应该已经"）

- CI：push main 的那一条 run `40425929662` 首跑红在 `harness rulers` 的
  `The released artifact and the split branch are trunk's bytes` 那一格——**时序**，不是我改坏的判据：
  那次 push 在 00:22:01 起跑，而 3b 的重切推送（`harness/main` → `d47f84d6`）落在 00:24。
  `gh run rerun 40425929662 --failed` 之后 10 个 job 全绿（这是"旧 sha 转不了绿"那条的第二个反例，
  前一个是 2026-10-23 的 `de5e3ac5`）。搬运仓自己的 CI run `40426210032` 两 job 全绿。
- 重切与推送：`git subtree split --prefix=harness/glasspane-harness -b split/glasspane-harness`
  → `d47f84d6`；`git rev-parse split/glasspane-harness^{tree}` ==
  `git rev-parse HEAD:harness/glasspane-harness` == `d6d420e7…`；快进判定
  `git merge-base --is-ancestor harness/main split/glasspane-harness` 成功 ⇒ 普通推送。
- 金样：`node harness/tools/fork-diff.mjs --record` 只动两行（`observedAt` 的日期 +
  `SYNCLOG.md` 那一条的 `forkHash` `53ec0a2d` → `c9d16f85`），三张计数逐字不变
  （`4640/6744 byte-identical, 285 edited, 112 added, 1707 deleted`）。
- tag：`node scripts/assert-tag-ready.mjs 1.23.0 --repository jingzhao-l/GlassPane` 放行
  （`HEAD == origin/main == 34bc3015`，`ci.yml` 在该 sha 的 `event=push` 通道最新一条 success）→
  `git tag -s v1.23.0 -F /var/tmp/gp-tag-1230-msg`；`git verify-tag` 回"完好的签名"、
  密钥 `0929EA31DF4F7429F63FC53189D88B1D043A1298`、`[绝对]`；
  `git ls-remote --tags origin` 回 `refs/tags/v1.23.0^{}` = `34bc3015`（tag 指的是那笔 CI 绿的树）。
- GitHub Release：tag 推送的 run `40426894454` success（25s），`gh release view v1.23.0` 回
  `isDraft=false` 与 4 件资产；`SHA256SUMS-1.23.0.txt` 那行
  `5baed8914d09a7516aa296cf9ff1360bb07ed27109210131fbc69234d013f40e  GlassPane-1.23.0.tar.gz`
  与 API `assets[].digest` 逐字相等；`.asc` 的 `VALIDSIG` 是那把钉住的钥匙。
- npm：`gh workflow run release.yml --ref v1.23.0 -f mode=publish` → run `40426954729` success；
  `npm view glasspane-mcp version` / `glasspane-install version` 都回 `1.23.0`；
  `npm view glasspane-install@1.23.0 bin` 回 `{ glasspane: 'glasspane.js', 'glasspane-install': 'cli.js' }`，
  `dist.shasum = 0dd2d3e0703c6d99cc3098ca098d31dd276641ac`。

### 用**发布物**把三条修复各重跑一遍（本机，2026-10-27 零三分起）

`npm install -g glasspane-mcp@1.23.0 glasspane-install@1.23.0` rc=0，随后：

1. `glasspane --help` → 打用法、**rc=0**（1.22.0 的发布物在同一条命令上回"不认得命令「--help」"退 2）。
2. `glasspane doctor` → 六格全答、rc=0，`全局 npm 包：glasspane-mcp=1.23.0 glasspane-install=1.23.0`。
3. 旧 clone 前进：`node /var/tmp/gp-advance-real-clone.mjs`（它 import 的是
   `/usr/local/lib/node_modules/glasspane-install/cli.js`，即发布物本体）→ 打印的钉住 ref 是 `v1.23.0`，
   前进之前 `HEAD=434bc51 tag=null 未提交=0 处`——**这一串事实正是 1.22.0 判 refuse 的那一串**，
   发布物现在答 `use`：`从 434bc51 前进到 v1.23.0（34bc301）`。
   独立复核（不读代码的自述）：`rev-parse --short HEAD` = `34bc301`、`describe --tags` = `v1.23.0`、
   `status --porcelain` 0 行、`--is-shallow-repository` 仍 `true`。
4. 下载-验签-暂存这一整条链在真机上过：
   `NODE_EXTRA_CA_CERTS=/var/tmp/glasspane-harness/ca-bundle.pem node
   /Users/ethanlin/glasspane-v1.21.0/updater/cli.js check --json --state-dir ~/.glasspane`
   → rc=0、`status=staged`、`current 1.21.0 → latest 1.23.0`，
   stderr 里 `gate 8: SHA256SUMS-1.23.0.txt.asc … gpg exit 0 (verified)`，且
   `digest measured 5baed8914d09…`——**暂存树量出来的 sha256 与发布物 API digest 同一个值**。
   这一趟还顺手量到一个只属于本机环境的事：不带 `NODE_EXTRA_CA_CERTS` 时同一条命令是
   `gate refused: release-unreachable … UNABLE_TO_VERIFY_LEAF_SIGNATURE`（那条代理拦 api.github.com
   的旧账），它拒得老实、没有把"问不到"报成"没更新"。在册的定时代理自带 `NODE_EXTRA_CA_CERTS`，
   所以 `doctor` 那一格答 `state=running`。
5. **最后一步也跑了**：`… updater/cli.js apply --state-dir ~/.glasspane --json` → rc=0、
   `status=applied`、`message="updated 1.21.0 -> 1.23.0"`，`authorship` 记的是
   `signature: verified / keyFingerprint: 0929EA31…043A1298`，`runtime` 记的是
   `status: refreshed, version: 1.23.0, cliPath: ~/.glasspane/runtime/1.23.0/updater/cli.js
   （previousCliPath 是 /Users/ethanlin/glasspane-v1.21.0/updater/cli.js）, agentVerified: true`，
   `caRoots.status=ok, certs=163`，而 `code` 是 `null`——**不是** `npm-not-refreshed`：这台机器的全局层
   写得进去，那一格这次真的装上了。跑之前先量过"此刻没有别的客户端挂在 socket 上"
   （`lsof ~/.glasspane/engine.sock` 只有监听者自己一行）。
   事后三处独立复核，不读 apply 自己的话：`plutil -extract CFBundleShortVersionString` 对
   `~/Applications/GlassPane.app` 与 `GlassPane Daemon.app` 都回 `1.23.0`；
   `glasspaned --version` 回 `glasspaned 1.23.0`；在跑的进程（pid 97127，08:42:57 起）就是那枚新二进制。
   `glasspane doctor` 随后六格全答：`status=applied 装着=1.23.0 最新=1.23.0`、
   `定时代理：在册作业装载着，state=running`、`全局 npm 包：glasspane-mcp=1.23.0 glasspane-install=1.23.0`。
   **这就是用户报的那条链路的终态**：旧 GUI 里那颗按钮当时是"探测到更新→显示更新失败"，
   现在同一条链（探测 → 下载 → 验签 → 暂存 → 换 bundle → 重启并握手回读 → 刷全局层）在真机上走通，
   且中途任何一格失败都说得出是哪一格。

