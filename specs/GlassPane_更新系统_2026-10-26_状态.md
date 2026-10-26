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
- 测试：`node --test updater/test/` 688 passed / 0 fail；`node --test installer/test/` 237+10 passed /
  0 fail；`node scripts/check-doc-links.mjs` 32 份文档 / 262 条内链无死链、双语成对、可复算主张与真源一致。
- 反向变异 26 笔（`/var/tmp/mutation-battery-2428.py`，逐笔要求具名用例变红；被改的七个文件每笔之后
  按 sha256 与原件逐字核回）。这一轮它抓到两类东西：产品侧一处**没有读者的句子**（回滚时"这一趟没碰
  全局层"那句当时没有任何断言读它，M15 因此零红——补了断言才成立），以及电池自己的一处作用域错
  （`apply.js` 的变异只跑了 `apply.test.mjs`，而钉它的是另外两个套件的用例；扩了范围才问得到）。

## 剩下没闭合的格子，写清不藏

1. **1.22.0 的发布链**：本轮改动只在本地 main（5 笔）之上；取号、CHANGELOG、tag、GitHub Release、
   npm 两包发布归版本线，逐格量法见本文件末尾的"发布读数"。
2. **本机 `~/glasspane` 那棵旧 clone**：它是 v1.5.0 的源码树，本轮修的是"以后再遇到该怎么办"，
   没有替你动它（它现在没有未提交改动，但把它切走会让另一个正在用这棵树的会话拿到不同的 HEAD）。
   要清掉就 `GLASSPANE_INSTALL_DIR=~/glasspane-v1.22.0` 另起一份，或自己确认后再前进。
3. **面板那一格**：`npm-not-refreshed` 通过既有的 `lastError` 通道显示（`showsFailureCard` 在
   `lastErrorMessage` 非空时不看状态），所以本轮没改 Swift。真正的缺口是**没有一条 npm 交付的预编译
   引擎**：三条渠道最后都要本地 `swift build`，所以"用 npm 装"仍然要求 Command Line Tools——这句
   写在两份 README 里，不是可以悄悄省掉的代价。
4. **daemon 是否还在 1.6.2**：`check` 之后状态记的是 1.21.0，盘上 bundle 也是 1.21.0；**在跑的进程**
   要不要再重启一次换到新二进制，取决于另一个会话是否还在用它，本轮没有动。

## 发布读数

（取号与发布执行后补在这里；每条写明命令与读数，不写"应该已经"。）
