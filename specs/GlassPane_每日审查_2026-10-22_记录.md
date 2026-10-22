# GlassPane 主仓 · 每日审查记录 2026-10-22

本轮为无人值守每日任务（`tools/prompts/daily-glasspane-main.md`）。开工 HEAD `1c2a495b`（本地 main 落后 origin 4 笔，
`git merge --ff-only origin/main` 追平后基线为 `8e4dd6a1`），整树 `git status --porcelain` 开工时为空。
收口版本 `1.20.0`。工作树就在主仓本树（本轮全程无人占树）；快照：`/var/tmp/gp-daily-20261022/snapshot/`
（`worktree-now.tgz` = 改动落盘前的全仓 tracked 文件，`head-8e4dd6a1.tar.gz` = 基线 commit 的产品面原件）。
盘余量开工实测 `df -k /Volumes/Eng-Dev` = 12 600 180 × 1024 B ≈ 12.0 GiB 可用，高于 4 GiB 底线，未清理任何可再生物。

## 1. 上一轮没收口的活（判据只用文件字节）

`git fetch origin --prune` 后盘本线分支：远端只剩 `origin/main`、`origin/gp-sc5-rebased`、`origin/gp-harness-sc5-fork-20261020`、
一条 dependabot；本地多一枚 `gp-sc5-rebased` 与它的 worktree，以及 `split/glasspane-harness` 搬运分支。

| 那一条 | 判定 | 判据 |
|---|---|---|
| `origin/gp-sc5-rebased` | 已被 main 包含，无独有内容 | `git rev-list --left-right --count origin/main...origin/gp-sc5-rebased` = `1 0`（分支侧 0 笔独有）；`git log origin/main..origin/gp-sc5-rebased` 空 |
| 本地 `gp-sc5-rebased` + worktree `/Volumes/Eng-Dev/.worktrees/gp-sc5-rebased` | 同上，工作树内只有未跟踪的 `.external`（参照克隆，禁区） | `git rev-list --left-right --count origin/main...gp-sc5-rebased` = `0 0`（与 main 同一枚 commit） |
| `origin/gp-harness-sc5-fork-20261020`（3 笔） | **全部已落地或被取代**，且它属 harness 线（`gp-harness-*`），不由本线删 | 逐文件 sha1：`registry-readiness.ts` `843477cd…` 两侧同值、fork 侧 `providers.ts` `df79123d…` 两侧同值；壳侧 `providers.ts` 分支那份 `1fef0418…` 与 main 的 `48d5381c…` 不同，而 main 那份是 10-21 并入后经同日面 A 追加的较新版本，分支侧无独有文件（`git diff --diff-filter=A main origin/gp-harness-sc5-fork-20261020` 空） |
| 本地 `split/glasspane-harness` | subtree 搬运产物，不参与"是否落地"判定 | 提示词第 2 步口径；其内容由 split 仓与 harness tag 承载 |

`origin/main` 那 4 笔（`b5bf9dc2`、`f0f0ce6b`、`7b87b70a`、`8e4dd6a1`）全是 `harness/**`，是 harness 线 0.10.0 的发布；
本轮不改 `harness/` 的内容或版本，只把它作为基线追平。

## 2. main 上那格红的来历（不是本轮缺陷，判据是实测）

`8e4dd6a1` 推上去时 CI 的 `harness rulers` lane 判红，红的步骤是
`node harness/tools/release-artifact.mjs --check`。本机复跑同一把尺子（它会 `git ls-remote` split 仓现读）读数为
`2 agreement(s) held, 0 tolerated lag(s), 0 problem(s)`，`gh run rerun --failed` 复通后该 lane 结论 `success`。
判据：**红是发布顺序造成的，不是内容造成的**——那条 lane 跑的时候 harness 线的 split 搬运还没落到 split 仓的
`refs/heads/main`，尺子量的是远端实时状态，事后就自洽了。旧 sha 事后转不了绿这一条从前记过（`v1.17.0`），
这次能转恰恰因为它是实时读远端的，所以本轮不放宽任何判据、不动 `harness/`。

## 3. 审查面与本轮发现

审查面七条泳道（`bugbot`/`security-review` 这两个 subagent 类型在本机不存在——`Agent` 只认
`Explore`/`Plan`/`general-purpose`，所以按 `review-bugbot`/`review-security` 两套 skill 的原简报改用
`general-purpose` 派发，简报逐字保留）：mcp-shell 传输层、mcp-shell 工具面/网关/注册表、Swift 引擎核心、
发布与门禁层、信任边界安全、bridge/probe/文档、以及主代理自查（`tools/`、版本线、三处方法表）。
每条回代码复核后才动手；复核后不成立的写在下面「复核判为不是缺陷」一节，不占修复名额。

（发现与修复的逐条表在 `CHANGELOG.md` 的 `[1.20.0]` 条目里——那才是给人读的那一份。）

## 4. 复核判为不是缺陷的几条（附判据）

| 那条发现 | 判据 |
|---|---|
| `evidence-report.ts` 的 `diagnostics` 兜底在产物里没人调用（4 个调用点全传 `undefined`） | `specs/GlassPane_P1_实施规格_v1.3_evidence审查UX.md:266`「设计缺口补述 2」原文就写着**两个审计工具不携带 diagnostics（不手工撰写诊断），调用渲染器时传 nil**——"没有生产者"是规格，不是半修；删掉它才是改契约 |
| CI 只读 lane 的 action 没有按 SHA 钉死（只有 `environment: release` 那条钉了） | `.github/workflows/release.yml:62-68` 把这条范围决策连同**理由**写在文件里（读不道的 lane 手里没有 secret，可改写面在别处已被 `check-workflows.mjs` 的 unresolvable/未钉两条挡住）；它是一处留痕的取舍，不是一处漏 |
| `spike/` 与 `specs/` 随发布归档出去 | `CONTRIBUTING.md:36`/`.zh-CN.md:33` 明写 `spike/` = 可行性实验与实测留档、不入门禁，`specs/**` 是验收台账且被 `check-doc-links.mjs` 的链接图引用；把它们从归档里剔掉是产品形状变更，不是缺陷处置。本轮只处理了"开发者机器路径字面量"那一半（见 CHANGELOG） |
| `harness rulers` 那格红（见 §2） | 实测复跑 + `gh run rerun --failed` 复通，判据在 §2 |

## 5. 已知边界（物理边界，不是遗留）

- `npm stage approve`（要 owner 2FA）与 Apple 公证（要付费开发者账号）仍是只有人能做的动作；本轮 trusted-publisher
  直发若成功就不产生 stage 件，公证按 owner 未启用决策如实写着。
- `/Volumes/Eng-Dev/iterate-skill/harness/iterate-harness/src/iterate_harness/mcp/client.py` 的
  `"\n".join(parts)` 抹掉 MCP 回包 item 边界那一条，属 iterate-skill 那条线（修在消费端），且本机已有该线自己在飞的
  worktree（`.worktrees/it-sc1-async`、`.worktrees/it-host` 里都有 `tests/test_mcp/test_call_tool_parts.py`）；
  判据与从前相同：`content[0]` 逐字节还是 daemon 那份回包，坏的是自己 join 的客户端。本仓产品面本轮实测**没有**
  销毁 item 边界的代码（`dispatch.ts` 原样转发 `outcome.content`，`stdio-session.ts` 用 `canonicalJson` 序列化整个对象）。

## 6. 本轮我替你做的决定（依据与回滚）

见汇报里同名那一节；每条决定的依据同时写进 `CHANGELOG.md` 的本版条目与相应提交正文。
