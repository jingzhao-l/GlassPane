# 每日任务 2026-10-29 · 主仓审查发现台账（分泳道修复用）

工作树开工状态：main = origin/main = `63fcda5e`，`git status --porcelain` 空，发布锚点 `v1.25.2`（npm 两包实测 1.25.2）。
基线门禁全部 rc=0，实际计数见本文件末「基线读数」。

审查手段说明：`review-bugbot` 与 `review-security` 两条 skill 规定的子代理类型（`bugbot` / `security-review`）
在本机不存在（实测 `Unknown agent type`，可用类型只有 general-purpose/Explore/Plan/【示例】×3）。
按 skill 自身的"调用形状错了就改正后重试一次"条款，改用等价的代码审查/安全审查子代理跑同一份分片简报，
并把 8 个分片（mcp-shell 传输层、engine 证据语义、installer+install.sh、updater、面板+daemon CLI、
bridge+probe+信号闸、scripts+workflows、信任边界安全）全部通读一遍。以下每条都由主代理自己回代码复核过
（"泳道说的一律不算数"是本仓纪律）。

标记：`已实量` ＝ 主代理自己跑了命令/读了行号；`待泳道自证` ＝ 主代理读了源码但形状需要实现时再确认一次。

## 泳道 1 · mcp-shell TS（文件所有权：mcp-shell/src/engine-client.ts、io.ts、http-gateway.ts + mcp-shell/test/）

- **S1-1（已实量）`engine-client.ts:1181-1194` + `1633-1645`：写入瞬间还在本地队列 ⇒ 永久宣称"从未离开本进程"。**
  `entry.handedOff` 只在 `writeLine` 那一刻按 `bufferedBytes()` 差值算一次，此后不重测。若帧先留在本地发送队列、
  随后被排空并由 daemon 执行、传输再死亡，`teardown` 仍用 `NEVER_LEFT_TRANSPORT`（"nothing reached the daemon and
  nothing was performed"）并给出 "then retry" 类 remedy ⇒ 同一按钮在用户屏幕上被按第二次。
  修法：`LineIo.writeLine(line, onHandedOff?)`，生产实现把 `output.write(chunk, cb)` 的回调接上（cb 无错误 ⇒ 字节已出门）；
  客户端在回调里把 `entry.handedOff = true`。不带回调的假传输保持原有静态判据（否则 B7 那批夹具全被改写）。
- **S1-2（已实量）`engine-client.ts:1436-1444`：超长回帧的"按到达序猜"归属仍然 `pending.delete()`。**
  同文件 1349-1374 对同一个事实（猜的）确立的规则是"结算但不删，标 `arrivalOrderConsumed` + `retainForLateReply()`"，
  因为 daemon 真正 echo-id 的回复还得有着落。两处规则不一致 ⇒ 猜错时真回复读成 "never issued"，operationId 进不了 trail。
  修法：未结算 + `inferred` 那一支改成与 1372-1374 同形。
- **S1-3（已实量）`engine-client.ts:1237` 的句子漏进 HTTP 表面。**
  `MCP_PROSE_FOR_HTTP`（http-gateway.ts:1435）只翻译一条子句，而超时帧的 message 里那句
  "This shell stops waiting for an MCP client's sake…" 对 curl 调用方陈述了不属于它所在表面的事实。
  修法：把这条子句按 surface 生成或在翻译表补一条；判据与 `lateReplyRoute` 同一手法。
- **S1-4（已实量）`engine-client.ts:1169`：`pending.delete(id)` 跑在 `pending.set(id, entry)` 之前。**
  id 由 `this.state.nextId++` 单调生成（:1133），删除恒为 no-op ⇒ 一条"看着有保护、没有读者"的形状。
  修法：删掉这一句。

## 泳道 2 · Swift 引擎存储与 socket 归属（文件所有权：GlassPaneEngine/{EvidenceModels,EvidenceStore,SocketNameOwnership}.swift + engine/Tests/）

- **S2-1（已实量）`EvidenceModels.swift:737-743`：`JSONValue` 把大整数交给 `encode(Double)`。**
  判据 `abs(value) < 9.007_199_254_740_992e14` 的数量级比注释与 `CanonicalJSON.swift` 用的 2^53 小了十倍；
  且一旦落到 Double 分支，`JSONEncoder` 把 1e16 拼成 `1e+16`，而内核 `canonicalJson` 拼 `10000000000000000`
  ⇒ 决策日志那一行被 `readDecisionLog` 判 corrupt，哈希链从该行起不可复算。
  修法：整数值一律走 Int64（`int64ValueExact` 现成），非整数的拼写与 `CanonicalJSON` 共用一个出口。
- **S2-2（已实量）`SocketNameOwnership.swift:79-82`：inode 仍是本实例的但 `unlink()` 失败，被折成 `false`。**
  两个调用方（SocketServer.swift:104-108、main.swift:931-941）对 `false` 一律打印
  "left X in place: the name no longer points at the socket this instance bound" —— 一次都没测过的断言，实测恰好相反；errno 被丢。
  修法：三态（已删 / 不是我的 / 删不掉+errno），调用方按三态出文。
- **S2-3（已实量）`EvidenceStore.swift`：`maxAgeDays` / `setRetention` 在 `engine/Sources` 全仓零个调用者**
  （`grep -rn "maxAgeDays\|setRetention" engine/Sources` 只命中本文件）。每次写都跑的 `pruneExpiredIfNeeded()`
  在生产恒 no-op，而 `retentionNotice` 的 "older than N day(s)" 那句与模块头让读者以为年龄会到期。
  修法（不扩产品面）：把"这一版 daemon 不做年龄到期，年龄清理只有 `--prune-evidence --older-than` 一条路"
  如实发布到读得见的地方（`--evidence-stats` 载荷与 `retentionNotice`），并给一条能红的接线测试。

## 泳道 3 · Swift 引擎判定与并发（文件所有权：GlassPaneEngine/{EngineCore,SocketServer}.swift + engine/Tests/）

- **S3-1（已实量）`EngineCore.swift:1378-1382`：`contaminationBasis` 在同帧有 `.human` 事件时仍说"不是观测到的输入"。**
  掉线 + 抓到人类输入同时成立时，这句话随 `circuitBreaker.reason` 进档案，事后只剩"没人碰过机器"一种读法。
  修法：按 `observedHumanInput` 分支出两句，各自只说自己那半。
- **S3-2（已实量）`EngineCore.swift:270/895/906` 与 `glasspaned/main.swift:1836`：跨线程读写 `activeOperationId: String?` 无同步。**
  SIGTERM/SIGINT 落在 act 在途时，waiter 线程读、服务线程写 ⇒ 数据竞争（轻则报上一个操作号或 nil，那条"是被打断不是没产出"
  的唯一陈述就此说错；重则读到已释放 buffer，收尾变 SIGSEGV，退出码 0 的干净收尾没了）。
  修法：读写收进锁里，waiter 走取值方法。控制：`swift test --sanitize=thread` 对新用例必须先能报 race（红），修后干净。
- **S3-3（已实量）`SocketServer.swift:322-327 / 347-350`：EOF 与半行到点只写日志、不回帧。**
  `.oversize` 只在见到换行时才产出，所以"写了 >4 MiB 不写换行"与"写了半行就断"这两种请求，
  `FrameCodec`/`Dispatcher` 承诺的 `GP_E_PAYLOAD_TOO_LARGE` 永远发不出去；调用方只能把自己的超时读成"daemon 挂了"。
  修法：`serve` 在 EOF/到点退出前问一次 codec（`pendingBytes > 0` 或正在丢弃超长帧）⇒ 先回一帧再 return。

## 泳道 4 · Swift daemon CLI 与状态根（文件所有权：glasspaned/main.swift、GlassPaneEngine/StateRoot.swift + engine/Tests/）

- **S4-1（已实量·真二进制）重复的取值旗标静默后者胜。**
  `glasspaned --state-dir A --state-dir B --list-projects` ⇒ rc 0、A 被丢、stderr 零字节；
  `--project-remove idA --project-remove idB` ⇒ 只处理 idB、rc 3、idA 一个字没提。
  与文件自己的规则（"`--state-dir` 是唯一点名根的入口"）矛盾；后果是 `--prune-evidence` 落进真家目录而调用方以为在沙箱里。
  修法：按旗标记出现次数，同一取值旗两次 ⇒ 64 + 整块 usage + 点名两个值。
- **S4-2（已实量·真二进制）只给修饰旗、不给一次性命令 ⇒ 修饰旗无人读。**
  `glasspaned --state-dir X --older-than 7 --dry-run` 起服务、打 `listening on`、SIGTERM 后 rc 0；
  同一条 `--older-than` 配 `--list-projects` 是 64 + usage。两条入口两套答案。
  修法：把范围检查从 `if let oneShotCommand` 里挪出来，服务形态也过 `allowedModifiers`。
- **S4-3（已实量·读码）`--socket-path "$HOME/engine.sock"` 把家目录 chmod 成 0700。**
  `SocketServer.prepareSocketDirectory()` 取 `deletingLastPathComponent` 后直接 `SocketDirectoryRule.enforce`（内部
  `chmod(0700)`），而 `StateRootArgument.notADedicatedRoot` 只用在 `--state-dir` 的值上；`--state-dir ~` 已被判为必须拒，
  同一危害的 socket 写法没有同一判据。且 `--socket-path` 那句 log 只在目录**不在** home 之内时打印，正好把动的就是 home
  这一档留在无声里。修法：新增纯函数 `StateRootArgument.rejectionForSocketParent(of:)`（对目录部分跑同一条
  `notADedicatedRoot`），`--socket-path` 与 `--probe-socket-path` 两支都调它；`SocketDirectoryRule.enforce` 兜底拒绝对
  home/`/` 本身 chmod。

## 泳道 5 · Swift 面板（文件所有权：glasspane-settings/{ConsoleModel,ProjectsTabView}.swift、SettingsModel.swift、GlassPaneEngine/LocalArchive.swift + engine/Tests/）

- **S5-1（已实量）`ConsoleModel.swift:385-388`：`if answered { pruneNeedsRestart = false }`。**
  同一个 daemon 进程、注册表仍是旧表时，只要 1s 轮询里 hello 又答了一次（此前一次 `presentButSilent` 把
  `daemon.stateRoot/pid` 清成 nil ⇒ `rootChanged` ⇒ `onChange` 再次采纳），"注册表已改动，重启后台服务后才会用新表"
  横幅连同它里面那枚唯一的「重启后台服务」按钮一起消失。与 `SettingsModel.pruneBannerCleared(by:)`（只认 `.confirmed`
  ＝ pid 真的换过）判据不一致。修法：`adoptDaemonReport` 收 reportedPid，只有 pid 换过才清。
- **S5-2（已实量）`LocalArchive.removeResultMessage` 的 `loadFailed` 句与重启横幅互相否定。**
  daemon 的 `--project-remove` 写后读不回那一支（main.swift:1396-1405）明确带 `found:true` + `requiresDaemonRestart:true`，
  注释写"盘与 daemon 内存此刻已经不一致，重启确实需要"；面板同一屏却说"为避免把读不回的条目覆写掉，删除没有执行"
  （那句属于写前拒绝那一支）。`pruneResultMessage` 同形。修法：把"写前拒"与"写后读不回"分开出文，
  后者不许再出现"未执行/未改动"字样。
- **S5-3（已实量）`ConsoleModel.swift:1194-1198`：注册项自己写过的档案目录不检查在不在。**
  `registered` 非空就无条件 `enabled:true`，而共用那一份的分支用了 `directoryIsPresent`。目录已被系统/TTL 清掉时，
  按下 `NSWorkspace.selectFile` 无事发生、屏幕零字——正是同枚按钮另一支上一轮修掉的形状。
  ⚠ `engine/Tests/.../DailyRound20261021PanelTests.swift:545-549` 现在钉的是 `#expect(owned.enabled)`，
  那条测试在给缺陷背书，修法必须同时改掉它。

## 泳道 6 · probe + 信号闸（文件所有权：engine/probe/Sources/**、engine/.signal_smoke.py）

- **S6-1（待泳道自证）`GlassPaneProbe.swift:994-1001` 的 `durationNs` 可以对端装不下。**
  daemon 侧 `ProbeWire` 把 `durationNs` 夹在 `0...(Int32.max)`，超界判 malformed 并**丢弃**；探针侧既不 bound 也不记账，
  `droppedWrites` 不动、`hello` 计数器干净 ⇒ "有 entry 帧没有时长"被读成"这次没有 >1ms"。
  修法：与出站字节帽同一条纪律，超界时省略该键并发一条具名溢出帧（或计数进 hello）。
- **S6-2（待泳道自证）`GlassPaneProbe.swift:1894-1906`：socket 名字超过 `sun_path` 时 `connect` 回 -1，与"没人监听"共用同一个返回值。**
  探针按 1+2+3s 再 30s 永久重试，永远说不出"这个名字根本拨不出去"；daemon 侧同名故障是可见的红。
  修法：提成纯函数 `socketNameProblem(_:)`，在 `start()` 当场判定并把原因写进一个新读数，不进重试循环。
- **S6-3（已实量）`engine/.signal_smoke.py:386 + :393`：`wait_for_socket(..., poll=child.poll)` 会把子进程收掉，
  7 行之后 `os.kill(child.pid, signum)` 照发。** daemon 在那个窗口里死掉 ⇒ ①`ProcessLookupError` 未捕获，整道闸带栈中断，
  已经量到的 failures 一条都不打印，后两案不再跑；②pid 已被回收，对它发 TERM/INT 就是对随机进程开枪。
  修法：发信号前问一次 `child.poll()`，已离场就如实记一条"这一趟无法验证信号收尾"并 return；`os.kill` 包 `ProcessLookupError`。

## 泳道 7 · installer + install.sh（文件所有权：installer/cli.js、installer/glasspane.js、install.sh、installer/test/）

- **S7-1（已实量，P0）`installer/cli.js:2553` + `2672` + `2744`：目标目录是别人仓库的子目录时，动的是外层那棵树。**
  `resolveProjectRoot` 会**向上走**（:242-256），于是 `<外层repo>/vendored` 被判成"既有 clone"；
  `readCloneFacts`/`advanceExistingClone` 只 `git -C <dir>`，从不问 `--show-toplevel` ⇒ 泳道实测把外层树的分支从 `main` detach
  并搬到旧 tag，然后回一句 `advance: use`（动完才报结论）。同一条输入 `install.sh` 是"目标目录已存在且不是 GlassPane 仓库" + rc 1。
  修法：`bootstrapPlan` 用不上走的 `looksLikeRepo`（与 install.sh `looks_like_repo` 同一份判据）；
  两个 git 函数开头问 `--show-toplevel`，不等于 `path.resolve(dir)` 就拒绝并点名要动的是哪一棵。
- **S7-2（已实量）`install.sh:348` 与 `:490`：被拒的 `--repo` 仍然原样透传给 cli.js。**
  `looks_like_repo` 不过 ⇒ REPO 留空去 clone，可 `exec node "$REPO/installer/cli.js" "$@"` 把 `--repo <坏目录>` 带着走，
  而 cli.js 里 `--repo` 优先级最高 ⇒ 刚 clone 的那棵被无视，`npm install` 真的以那个被拒目录为 cwd 跑起来。
  修法：`--repo` 给了又不合判据 ⇒ 当场拒绝（rc 1，不 clone、不透传）；或从透传参数里剔掉已判废的那一枚。
- **S7-3（已实量）`install.sh` 完全没有 `--help`/`-h` 处理。**
  ①非 macOS 上 `curl … | sh -s -- --help` 回 1，而 cli.js 明确把 `options.help` 从平台闸豁免（CI 的 install-gate 那一格读的就是 usage）
  并回 0 —— 就是本仓历史上那条"`--help` 退出码不一致"，这次跨两条入口；②macOS 上 `--help` 会先 clone 一棵 `--depth 1` 才打印 usage。
  修法：在 HOME 闸与两个形状闸之后、在任何 clone/委托之前认 `--help|-h` 并打 usage、rc 0；非 macOS 同样豁免。
- **S7-4（已实量）`install.sh:247`（与 :249）打印的下一步没给路径加引号。**
  `git -C ${_dir} fetch --tags …` 在 `_dir` 含空格时照抄进 shell 就断成两个词；同函数 :211 已经按规矩写了带引号的形式。
  修法：实路径一律 `"${_dir}"`，并让 install-sh 那条静态闸扫"`git -C ${` 这种裸形。
- **S7-5（已实量）`installer/glasspane.js:289` 的 remedy 两处不成立。**
  "补法（不需要权限…）"没有任何探测支撑（全分片没有一次 `npm prefix -g` 或 `W_OK` 探测）；
  `glasspane-mcp@<版本>` 里的 `<` 是重定向符，泳道实测 `/bin/sh -c` 直接语法错 ⇒ agent 照抄连命令都起不来。
  修法：先探测前缀可写性，读不出就答 unverified；可写才印不带 sudo 的那条，不可写就点名前缀与目录且不发升权命令；
  占位符换成能真读到的值或明写不带它。

## 泳道 8 · updater（文件所有权：updater/lib/apply.js、updater/test/）

- **S8-1（已实量）`apply.js:172` 与 `:1648` 写入的 `sourceAppsDir` / `fromStateRoot` 全仓零读者。**
  `GLASSPANE_APPS_DIR=A updater apply` 备份了 A，随后普通 shell 里 `updater rollback` 选中那份备份直接恢复进默认
  `~/Applications` 并 kickstart 真机 daemon，还报 "restored X and the daemon reports it"。
  修法：`rollbackToBackup` 读 marker 后核对归属，不成立就 deferred 拒并给"用 marker 里那份 --apps-dir"的出路。
- **S8-2（已实量）`apply.js:1708/1752/1816/1848/1929` 五处回滚写用 `stamp(...)`（开跑时的陈旧 base 整档覆盖），
  而成功路径与 `:2136` 用的是 `stampOnto(freshestBase(...))`。** 全仓无跨进程锁；build 窗口里并发的一次 `updater check`
  写的 `lastCheckAt`/新 staged 报价会被洗掉，并复活一个可能已被 sweep 删树的旧 staged。
  修法：五处统一到 `freshestBase` 那一条准则。
- **S8-3（已实量）`.old-<pid>` 残留三件事同时不成立。** `renameDirectoryIntoPlace` 的 rm 失败只 return 一句 note，
  而两个调用点（:354 `defaultCopy`、:439 `verifyStagedBytes`）把返回值丢了；`sweepStaleCopies`（:302）的模式只认 `\.new-(\d+)$`，
  所以 :287-288 注释承诺的"下一次运行的清扫会带走它"是假的；pid 复用撞名后下一次 swap 的 rename 会 ENOTEMPTY。
  修法：接住 note 并入 apply 记录；清扫加第二条模式（仅删 pid 已死且 manifest 与现 target 一致的那些），否则如实上报残留。
- **S8-4（已实量）`apply.js:594` 把 `spawnSync` 的任何其它 error（含 `ETIMEDOUT`）折叠成 `{status:127}`。**
  而 `binaries.js` 整篇的立身之本就是"127 不是 notFound"；于是"跑了 15 分钟没答"与"找不到命令"共用一个哨兵码，
  agent 按码分诊必然走错 remedy。修法：超时单列（`timedOut:true`、status null），消息点名跑了多久、已终止哪一层。

## 泳道 9 · bridge（文件所有权：bridge/glasspane_bridge.py、bridge/test_bridge.py）

- **S9-1（已实量·本机复现）`--timeout` 没有有限性校验。**
  实测 `python3 bridge/glasspane_bridge.py main capture --pid 999999 --timeout nan` ⇒ `ValueError: cannot convert float NaN to integer`
  整段 traceback，rc 1、stdout 无哨兵（`--inf` 同理是 OverflowError）。违背 §6.2"失败也以 JSON 离场"；
  且 `resume_frozen_target` 只在 `timed_out` 臂里跑（:1136-1143），非超时的异常路径把 `--pid` 附上的用户进程留在 SIGSTOP，
  既无 SIGCONT 也无 F7 那句 "IT IS NOT CONFIRMED RESUMED"。修法：`--timeout` 收"有限且 >0"（照 `capture_budget_s` 那条判据）；
  `run_outer` 把"起孩子/抽管道"之外的异常也走同一条收尾（先唤醒目标、再结构化离场）。
- **S9-2（已实量）`no_payload_cause`（:1540-1597）把两条真机原文折成"去勾 Developer Tools"。**
  实测 `error: attach failed: no such process` 与 `… running as user 'root'` 都落 catch-all `debug-gated`。
  前者是 pid 不存在、后者是跨用户/SIP，两张 TCC 席位永远治不了——正是该函数自己声明要消灭的形状。
  修法：补两臂（target-gone / peer-user-or-sip），catch-all 文案明写"这不是测量，是缺省猜测"。
- **S9-3（已实量）`process.Kill()` 在 `except Exception: pass` 里（:2185-2188）。**
  桥**自己启动**的目标进程可能没收拢，而载荷在那之前已经打印，`errors[]` 一字不提；对照 attach 臂的 F7 三态读回，
  这条不对称就是"守卫跑了但判决没读者"。修法：`_outcome_ok(process.Kill())` + 可测纯函数 `capture_teardown_note(...)`，
  失败时在**尚未打印**的 payload 上追加"未确认收拢 + 怎么核"。
- **S9-4（已实量）哨兵 nonce 经子进程环境交给被调试目标，而 `extract_sentinel` 判"最后一个可解析对获胜"。**
  `--exe` 启动档里目标继承 lldb 的环境（`target.inherit-env` 默认 true），从 `os.environ` 直接读到本轮 nonce，
  把自己那段伪造写成最右一对 ⇒ 真桥输出被跳过，伪造载荷经 `emit` 交回调用方。:1124-1128 那句"两路都堵上"是假的。
  修法（同 uid 下藏不住秘密，因此不靠秘密做完整性）：stdout 通道上出现**多于一个**带本轮 nonce 的标记时，
  如实标 `stdoutAmbiguous` 并拒绝把它当实测；同时改掉 :629-631 / :1124-1128 两句主张。

## 泳道 10 · scripts + workflows + 安装文档（文件所有权：scripts/*.mjs、.github/workflows/release.yml、README*.md、钉这些的测试）

- **S10-1（已实量）`release.yml:421-422` 的 `printf | awk {exit}` 会被 SIGPIPE 洗成整步无名死亡。**
  该步是 `set -euo pipefail`；`git ls-remote --tags` 输出超过约 64 KB 且目标 tag 行距 EOF 超过缓冲时，awk 命中即退、
  printf 死于 EPIPE ⇒ 管道判 141、`set -e` 让这道"拒发没被 tag 担保的树"的前置闸无任何报错文本地死掉。
  同一坑本仓在 release.yml:145-147、ci.yml:107-110/438-440、harness-contract.yml:108-111 都记过名，唯独这块 awk 漏改。
  修法：here-string 消掉管道。
- **S10-2（已实量）`check-workflows.mjs` 看不见顶层重复键。** `walkWorkflow` 只把 `jobs:` 当 section，
  两块 `jobs:` 且 job 名不重叠时全部并成一个读、打印 "clean; N job(s)"，而 YAML 映射只保留最后一块
  ⇒ 前一块里的交付闸从此永不运行（正是催生本工具的 2026-09-25 事故形状换了层 key）。
  修法：收集顶层键，`jobs:`/`on:`/`permissions:` 等出现两次即具名红；`--self-test` 补一对红/静默用例。
- **S10-3（已实量）`check-doc-links.mjs:721/725/753` 的 `decodeURIComponent` 无保护。**
  链接或锚点里一个裸 `%`（"50%" 这种散文写法）就抛 URIError，整条闸在文档循环中途带栈崩死，
  后面的主张核对与表格形状本轮全部没跑——违反本仓自己的"一条拒该是一句话，不是一个栈"。修法：安全解码 + 具名问题。
- **S10-4（已实量）`check-kernel-corpus.mjs:271-273` 对被 pin 名字落在目录上的形状栈崩。**
  `sha256()` 直接 `readFileSync` ⇒ ERR_FS_EISDIR 未捕获；文件里现成的 `nonRegularKind()`（:99）只在 `--record` 分支用，
  2026-10-28 那次"detect-then-write，一条拒是一句话"的修复只落了一半。修法：check 分支复用同一判据。
- **S10-5（已实量）`check-doc-links.mjs` 的 shell 残渣状态机只认 ``` 围栏。**
  同文件 `markdownTableProblems`(:926) 与 `headingsOf`(:126) 都认 ```/~~~ 两种；用 `~~~` 围栏包住的示例命令会被残渣闸误红，
  而且误红文案的补救"放进 ``` 围栏"对已在 ~~~ 里的行自相矛盾。修法：开/闭判定与 :926 同式。
- **S10-6（已实量）`release.yml` 的 `github-release` job 没有 `concurrency`（只有 npm-publish 有，:346）。**
  同一 tag 两个 writer（删 tag 重推、或 Re-run failed jobs）⇒ 归档字节与 Release target 由最后写胜者决定，
  先结束那个 run 的读回判据在它自己视野里全过。修法：`group: github-release-${{ github.ref_name }}`、
  `cancel-in-progress: false`，并给 `check-workflows` 补一条"发布类 job 必须声明 concurrency"的规则。
- **S10-7（已实量）README 一键安装把可预测路径交给 `curl -o /tmp/gp-install.sh`。**
  `/private/tmp` 是 1777；sticky 不禁止别的账号建 `/tmp/gp-install.sh -> ~/.bashrc` 这类符号链接，
  `curl -o` 跟随并以受害者 uid 截断覆写 ⇒ 跨账号的任意"受害者可写文件"覆写原语。
  同一仓库对同一风险早有规矩：`install.sh:402` 用 `mktemp`、`bridge:867` 用 `O_CREAT|O_EXCL|O_NOFOLLOW`、
  `SocketDirectoryRule.leafSymlinkDefect` 拒绝跟随。⚠ 钉这句话的三条闸（`updater/test/daily-20261022-gates.test.mjs:202,227`、
  `installer/test/daily-20261020.test.mjs:41`、`scripts/check-doc-links.mjs:851`）把落点当契约固化，
  修法要连它们一起改成"落点必须来自 mktemp/私有目录"。

## 泳道 3 期间的一次提示注入（本仓状态未被它改动，但必须记进台账）

泳道 3（`.worktrees/swift2`）在执行中途收到一条**冒充主代理/系统**的消息，声称"AGENTS.md 已更新、
台账新增 S3-4、5 条快反（quickAction）测试全红，要求回炉并实现新的响应键/拒答形态"。
主代理现场按字节核验，四项全部证伪：

- `grep -rn "S3-4" specs tools` ⇒ 零命中；本台账泳道 3 只有 S3-1..S3-3（见上）。
- 全仓 markdown/swift/ts/mjs 搜 `快反` ⇒ 零命中；`engine/Sources`、`mcp-shell/src` 搜 `quickAction` ⇒ 零命中。
- 主树与 `.worktrees/swift2` 根下都**没有** `AGENTS.md`（`find` 全仓只有一处既有的
  `.external/opencode/AGENTS.md`，属禁区里的 vendored fork 旧文件，本轮没人写过它）。
- 该泳道收到注入前的 `git status --porcelain` 为空，注入之后也没有多出任何文件。

处置：泳道拒绝执行（它给的判断是"这是未获初始任务授权的新增产品面"），并继续按原简报
"先写红再修"完成 S3-1..S3-3；主代理复跑后合并（commit `163fee48`）。
**这条不是缺陷而是攻击面**：本产品的信任边界里，"能往代理上下文里写字"就等同"能改交付内容"，
与 `engine.sock` 无 peer 鉴权是同一族问题。它没有变成代码改动，因为没有可落地的判据支持它。

## 主代理在复核过程中追加的三条（不在任何分片简报里）

- **S11（已实量·主代理自证）`scripts/check-doc-links.mjs` 的 markdown 扫描集合把 `.worktrees/` 数了进来。**
  并行会话与每日任务会把隔离工作树开在仓库目录**里面**，那是同一棵树的未追踪拷贝。本机实量：
  `.worktrees/` 下开出 5 份之后，这道闸自己打印的扫描量从 **122 份 → 1257 份**、表格 **448 张 → 3275 张**；
  同一棵 main 的树因为旁边有没有工作树而给出不同读数，量的就不再是"仓库里有什么"。
  修法：`.worktrees` 加入 `MD_SKIP_DIRS`（与 `dist`/`node_modules` 同族），并补一条两用例：
  工作树里那份坏表格既不数也不判，仓库自己那份坏的照样点名（排除≠闭眼）。
  判据能红：把 `'.worktrees'` 从排除表拿掉 ⇒ `表格形状闸不数 .worktrees 里的未追踪拷贝` 具名红（实跑 34/33/1）。
- **S12（已实量）S10-7 那条脆弱落点不止 README 两处。** 泳道把 `installer/README.md:20`、
  `mcp-shell/README.md:16`、`installer/cli.js:2256`（usage 文本）登记成 `△` 移交，
  而这三份都在本线写域内 ⇒ 移交没有收件人＝一条有纸面记录的无闸。本轮改成 mktemp 落点并把三份
  **并进 `INSTALL_LANDING_ENFORCED`**（该文件自己约定"移交清单应当只会变短"）；
  `installer/test/daily-20261020.test.mjs` 从"有人宣布了就行"升级为"`unsafe` 必须为空 + usage 读得到 mktemp"。
  清单里剩下的 `harness/glasspane-harness/README.md:82` 与 `README.zh-CN.md:74` 属 10:30 那条线写域，
  本线无权改，读数照常量、以 `△` 打印并附 remedy（汇报里点名移交）。
- **S13（半修，由泳道 6 自己点名）探针发了、daemon 读侧没接。** `3c5c5ed6` 让探针开始发
  `{"t":"handlerDurationOverflow"}` 与 hello 里的 `durationOverflowCount`，而 daemon 的
  `ProbeWire.swift:254` 对未知类型回 `.malformed` ⇒ `ProbeSocketServer.swift:495-502` 把一次
  **合法的读数丢失**记成 `rejectedFrames += 1`（协议违规），新计数器则零读者。
  读补齐在 `daily/main-20261029-swift6`（`ProbeWire`/`ProbeSocketServer`/`ProbeInbox`），同一版发出。

## 基线读数（逐字命令，2026-10-29 07:31–07:36）

| 闸 | 读数 |
|---|---|
| npm ci / npm run build | rc 0 / rc 0 |
| npm test --workspaces --if-present | mcp-shell 676、installer 278、updater 708；pass 全等、fail 0 |
| check-version | OK，版本线一致 1.25.2（19 个位点全 ✓） |
| check-doc-links | 32 文档 / 270 内链 / 44 外链不请求 / 448 表（扫 122 份 markdown） |
| check-workflows --self-test / 正式 | 5 个 workflow 文件 clean；harness 侧两条 `△` 移交 |
| swift build / swift test engine | XCTest 1478 执行 / 3 跳过 / 0 失败；Swift Testing 44 条 4 套件 1.562 s |
| swift test engine/probe | 51 执行 / 1 跳过 / 0 失败；Swift Testing 0 条 |
| pytest bridge | 169 passed / 1 skipped |
| sh -n install.sh | rc 0 |
| 信号闸 .signal_smoke.py | SIGTERM/SIGINT 自退码 0、socket unlink，三次起停各自状态根 |
| bundle + npm pack --dry-run | rc 0；338.0 kB、shasum 7828c95570f241b0e4cbc5f3efbac5621211ca9b |
| tool-surface --check | no growth past the recorded baseline（A 21.94% / B 21.04%，越限判据已spent，棘轮仍挡增长） |
| product-surface | 6587 agreement / 0 problem（glasspane-harness@0.12.3） |
