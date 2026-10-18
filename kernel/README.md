# `kernel/` — 已发布内核的**语料镜像**（corpus mirror），不是内核代码

这个目录现在只有两份东西：`fixtures/` 与 `schemas/`。它们的字节属于
[`iterate-kernel`](https://www.npmjs.com/package/iterate-kernel)，由
iterate-skill 的 `kernel/` 发布；这里放的是一份**被钉住的对副本**，不是第二份真源。

## 为什么还留一份

有些消费者读不到 TypeScript：

- `engine/Tests/GlassPaneEngineTests/TestSupport.swift` 的 C35 腿按文件名读
  `kernel/fixtures/<name>.json`——Swift 侧与 TS 侧比的是同一批语料，这才是"双向绑定"里
  引擎那半条腿。`kernel/fixtures/report.ok-01.md` / `.html` 同理是两份渲染器的共同金样。
- `engine/Sources/glasspane-settings/RecipesTabView.swift` 在运行时读
  `kernel/schemas/recipe-config.schema.json`（读不到就退回它自己那份写明"内置快照"的副本）。
- `scripts/make-release-archive.mjs` 的归档**要求清单**是从 `kernel/schemas` 推出来的：
  那份清单必须能独立于"打包步骤产出了什么"说话，否则它只是在复述自己。

## 它凭什么不是第二真源

`node scripts/check-kernel-corpus.mjs`（CI 每一步都跑）判三件事，缺一件就红：

1. `kernel/fixtures|schemas` 逐文件 sha256 == `harness/glasspane-harness/contracts/kernel-pin.json`
   记的那一份 pin —— pin 记的又是**已发布包**里的字节（`--record` 只肯从装好的包里抄，
   且抄之前先比 pin，比不上就拒）。
2. 反方向也核：镜像里多出 pin 没记的文件，同样红。一份不被任何清单承认的契约文件，
   就是第二条没人验证的真相。
3. `mcp-shell/package.json` 声明捆的 `iterate-kernel` 版本 == pin 的版本。两个消费者
   （fork 的产品代码与发布出去的 `glasspane-mcp`）共用一份契约，这件事得有个人管。

追平语料用 `node scripts/check-kernel-corpus.mjs --record`（前提：`harness/glasspane-harness`
里 `bun install` 过，且装到的就是 pin 那一版）。

## 这里**没有**什么

没有 `src/`、没有 `test/`、没有 `package.json`、也不是根 workspace 的成员。
2026-10-18 之前这里是一份靠 `tools/sync-kernel.sh` 手工抄的内核代码镜像，`mcp-shell`
经 `"@iterate/kernel": "file:../kernel"` 用它——那份代码**没有任何出处记录**（pin 只覆盖
`fixtures/`+`schemas/`），抄漏一次就是把一整套陈旧契约捆进发布物，而两边 CI 照样绿。
现在壳吃发布包 `iterate-kernel`，内核代码的测试住在 canonical 与它自己的 CI 里；
本仓对"行为是否一致"的回答住在 `harness/glasspane-harness/script/kernel-conformance.mjs`
（把 pin 记的语料跑在**装好的那份包**上，与金样比）。
