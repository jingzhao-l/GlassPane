<!--
标题用 Conventional Commits 前缀 + 中文正文，与提交历史一致：
  fix: 请求超时定时器不再 unref，超时必须交付
  feat: gp_* 新增 XXX 工具
  ci+release: provenance 发布通道与 publish-shape 守卫
一个 PR 只做一件逻辑上完整的事；跨层改动请拆开提。
-->

## 这个 PR 做什么

<!-- 一句话动机 + 关键取舍。不要只写「修了个 bug」。 -->

## 影响到哪几层

- [ ] `kernel/schemas/`（JSON Schema 真值）
- [ ] `engine/` daemon（`GlassPaneEngine` / `glasspaned`）
- [ ] `engine/` 设置面板（`glasspane-settings`）
- [ ] `engine/probe/`（探针 SDK）
- [ ] `mcp-shell/`（`gp_*` 工具表）
- [ ] `installer/` 与 `install.sh`
- [ ] `bridge/`（LLDB 桥）
- [ ] `specs/` 文档与 `README.md` / `CHANGELOG.md`
- [ ] `.github/workflows/` 与发布形态

## 门禁清单（照实勾选）

本地跑绿，CI 只是同一套东西的重复：

- [ ] 根 workspace：`npm ci && npm run build && npm test` 全绿
- [ ] engine：`cd engine && swift build && swift test` 全绿
- [ ] 探针包：`cd engine/probe && swift test` 全绿（动过探针时）
- [ ] 信号收尾闸：`cd engine && swift build && python3 .signal_smoke.py .build/debug/glasspaned` 通过
      （SIGTERM/SIGINT 干净退出 + socket 被 unlink）
- [ ] 桥：`cd bridge && python3 -m pytest -q` 全绿（动过 `bridge/` 时）
- [ ] kernel：`cd kernel && npm test`（C35 与 fixtures 往返）全绿（动过 schema/kernel 时）
- [ ] mcp-shell：`cd mcp-shell && npm test` 全绿
- [ ] 发布形态有变动时补跑 publish-shape 守卫：`cd mcp-shell && npm run bundle && npm pack`，
      并在干净目录里装上后完成 MCP `initialize` 握手
- [ ] 安装器有变动时跑 `npm test --workspace glasspane-install`；改 `install.sh` 时补
      `GLASSPANE_INSTALL_DRY_RUN=1 sh install.sh` 的分支验证

未跑或跑不过的项，请保留未勾并写明原因（不要留一个勾在没跑过的行上）。

## 契约与文档同步

- [ ] 改动了 `gp_*` 工具：`kernel/schemas/` + daemon 方法/分类器 + `mcp-shell/src/tools.ts` 三处已同步
- [ ] 改动了行为语义（错误码、降级形态、权限主体、证据字段）：对应 `specs/` 文档已更新
- [ ] 内部重构且行为逐字节不变：在此明确写出「行为不变」并列出对照测试
- [ ] 版本变更只经 `node scripts/set-version.mjs <version>`，没有手改单个 `package.json`
- [ ] 错误码表未动；新增失败路径遵循「码不动、语义不动、remedy 可执行」

## 只能真机验的部分

CI 不承载 GUI 会话、真实 TCC 席位与真实被测 app 的流程。若本 PR 触及：

- [ ] 已在真机执行相应冒烟，并把结果（含失败与降级形态）写入 [engine/smoke.md](engine/smoke.md)
- [ ] 权限主体核对通过：设置面板「Daemon 状态 → 主体」与实际服务的二进制一致
- [ ] 涉及 launchd 的作业，验证过 `--restore-launchd` 的修复路径

没有真机记录的项请留空并说明「待真机」。

## 诚实性

- [ ] 没有为了让指示变绿而新增未经实测的状态推断；拿不到数据即 `未验证` / `INCONCLUSIVE`
- [ ] 没有用 mock、放宽阈值或跳过断言来制造通过
- [ ] PR 描述里的每个「已验证」都对应上面某条可复现的门禁或真机记录

## 关联

- 相关 issue：
- 相关 specs：
