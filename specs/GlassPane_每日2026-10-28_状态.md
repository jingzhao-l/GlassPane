# 每日任务 2026-10-28 · 主仓收口台账（v1.25.2）

## 收口格
- main 收口 HEAD `457ed816`；`git status --porcelain` 为空；`origin/main` 与之同步。
- tag：`v1.25.0`、`v1.25.1` 是**有解释的空号**（各因一条本线无权改的闸被 CI 拒；不移动、不删除），`v1.25.2` 是发布锚点。
- Release `v1.25.2`：draft=false、target=`457ed816`、4 件资产（tar.gz/.asc、SHA256SUMS/.asc）。
- 归档自证：`node scripts/make-release-archive.mjs --verify` = 746 entries / 4,417,030 bytes，`harness/` 条目实测 0。
- registry：`glasspane-mcp@1.25.2`、`glasspane-install@1.25.2`（`--prefer-online` 实测）。

## 门禁实际计数（逐字命令，最终树）
| 闸 | 读数 |
|---|---|
| npm ci / npm run build | rc 0 / rc 0 |
| npm test --workspaces --if-present | mcp-shell 676、installer 278、updater 708；pass 全等、fail 0 |
| check-version 1.25.2 | OK，版本线一致 |
| check-doc-links | 32 文档 / 270 内链 / 44 外链不请求 / 446 表 |
| check-workflows --self-test / 正式 | 28 例（17 捕获 / 11 沉默）；5 个 workflow 文件 clean |
| swift build / swift test engine | 1478 执行 / 3 跳过 / 0 失败；Swift Testing 44 条 4 套件 |
| swift test engine/probe | 51 执行 / 1 跳过 / 0 失败 |
| pytest bridge | 169 passed / 1 skipped |
| 信号闸 .signal_smoke.py | SIGTERM/SIGINT 自退码 0、socket unlink，三次起停各自状态根 |
| bundle + npm pack --dry-run | rc 0，44 条 notice |
| tool-surface --check | no growth past the recorded baseline（面 A 本轮两次 --record 都是本线有意变化，单独两笔 chore(harness)） |
| product-surface | 6587 agreement / 0 problem |

3 条跳过按设计：`GLASSPANE_SCK_DIAG` / `GLASSPANE_LAYOUT_DIAG` 两枚真机诊断 + 探针侧一条。

## 反向变异（具名红，全部核回字节）
| 变异 | 红的具名用例 |
|---|---|
| 七支里任一支装回 `${line}` / `${truncate(line)}` | 非 JSON 帧 / 陌生 id 的帧 / 非数字 id / 源码侧闸 |
| 网关把 `String(error)` 装回线上 | 兜底 catch 的报文里没有绝对路径… 等 3 条 |
| 删掉守卫的 `noteTapDisabled()` | testMidWindowDisableCannotReleaseACleanWindow 等 11 断言 |
| 协议默认值改 true | testSourceThatNeverDroppedTheTapKeepsTodaysVerdictShape（对照） |
| monitor 转发体改 false | testMonitorWiresItsOwnDisableLatchToAProductionReader |
| `--project-remove` 退回裸吃下一个 token | testRealBinaryRefusesAFlagSwallowedAsAValue + testEveryValueTakingFlagRoutesThroughTheOneAuthor |
| `total += listedSize ?? 0` 装回 | testUnmeasurableEntrySizeIsReportedAsUnmeasuredNotAsZero |
| 恢复「the daemon is ready to attach」 | testGrantAccessibilityStopsSpeakingForTheDaemon |
| `activeOperationId = nil`（不记在途） | testActiveOperationIdIsVisibleDuringActAndClearedAfter |
| ps 失败回 `[]` / unavailable 折进 warn / invalid 可覆盖 | 泳道 B 三组具名红（见其汇报，主代理复跑套件核过） |
| `export HOME=` 装回 / binaries 退回 os.homedir / --help 回 stderr | 泳道 E 三组具名红 |

## 本轮决定 → 依据 → 回滚
1. **取号 1.25.0 → 1.25.1 → 1.25.2（minor）**。依据：CLI 参数语义与 updater --help 的输出流都动了（1.6.2 那条判据）；两格空号各由一条本线无权改的闸拒收。回滚：`git tag -d v1.25.1 v1.25.2` 只删本地，已推 tag 一律不动。
2. **撤回 daemon 侧 `method` 回显上限那一处**。依据：`FrameCodec.swift` 的全文件 blob 被 `harness/glasspane-harness/contracts/engine-methods.json` 钉住，重记那份契约属于 10:30 那条线。交接判据与确切命令：那条线在 `product-surface` 之前把 `swiftBlob` 与 `methods` 一并从 `EngineMethod` 重derive；本线侧改动就是 `RequestParser.callerMethodDescription`（短的原样、超上限走 `ParamValidation.cappedParamKey`）。
3. **面 A 金样两次 `--record`**（+111 行 / 分母 -20 行）。依据：都是本线本轮有意变化，逐文件点名在两笔 chore(harness) 提交正文里。
4. **不扩面**：证据清理 GUI、审批链 `tailHash` 上屏、`updater rollback` 控件——三项是新增产品面而非缺陷，按范围纪律不在本轮做；已核实的缺陷 24 条全部本轮修完。
5. **W7 不改退出码**。依据：SIGTERM 收尾 exit 0 是 launchd `KeepAlive=SuccessfulExit=false` 的语义前提；诚实改由具名 operationId 落 stderr 兑现。

## 未观测（物理边界）
- `npx glasspane-mcp` 干净前缀装的 initialize 回包：本机装好后 stdin 一问一答没有输出（进程直接结束），未取到回包。补它：`cd $(mktemp -d) && npm i -g --prefix $PWD $(npm pack 的 tgz) && echo "…initialize…" | ./bin/glasspane-mcp`，需要在有 daemon socket 或显式 `--socket-path` 的环境里跑。
- npm `stage approve` 与 Apple 公证：需要 owner 2FA / 付费账号。本轮 publish 走 trusted publisher 直发成功，无 staged 待批。
