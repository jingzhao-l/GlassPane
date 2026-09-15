# GlassPane P0 — 真机冒烟流程（A7）

> 对应 P0 实施规格 §7.3。CI 不承载本流程：AX 依赖辅助功能权限与真实 GUI 会话，
> 因此作为人工/自建 runner 验收步骤存在。

## 前置条件

1. **辅助功能权限**：运行 daemon 的终端（或直接运行二进制的父进程）必须在
   系统设置 > 隐私与安全性 > 辅助功能 中被授予权限。首次使用运行：

   ```sh
   swift run glasspaned --grant-accessibility
   ```

   该命令会弹出系统授权提示并打开设置面板，等待授权完成。
2. **屏幕录制权限（可选）**：仅像素信号需要。未授予时 pixelDiff 为 null、
   熔断级=1、T6 判定退化为 INCONCLUSIVE（降级形态，非失败）。
3. 一个被测 app 正在运行（下例使用 Notes；任意 SwiftUI/AppKit app 均可）。

## 冒烟步骤

```sh
cd engine
SOCK=/tmp/glasspane-smoke.sock

# 1. 启动 daemon（verbose 日志走 stderr）
swift run glasspaned --socket-path "$SOCK" --verbose &
sleep 3

# 2. 完整循环：attach -> act -> observe -> assert -> diagnose -> last_evidence
printf '%s\n' \
  '{"id":1,"method":"attach","params":{"bundleId":"com.apple.Notes"}}' \
  '{"id":2,"method":"act","params":{"selector":{"role":"AXButton","title":"新建备忘录"},"action":"press"}}' \
  '{"id":3,"method":"observe","params":{"maxDepth":3}}' \
  '{"id":4,"method":"assert_element","params":{"selector":{"role":"AXButton","title":"新建备忘录"},"property":"enabled","expected":true}}' \
  '{"id":5,"method":"diagnose"}' \
  '{"id":6,"method":"last_evidence"}' \
  '{"id":7,"method":"shutdown"}' \
  | /usr/bin/nc -U "$SOCK"
```

> selector 的 `title` 按被测 app 的实际 AX 标题替换（可先用一次 observe 查看树）。

## 验收断言（人工核对响应帧）

| # | 断言 |
|---|---|
| 1 | attach 返回 `{pid, bundleId, appName}` |
| 2 | act 返回 `operationId`（`op_` + 26 位 Crockford）、`actConfirmed: true`、`axChanged`/`pixelChanged`、`latencyMs`、`evidenceId` |
| 3 | observe 返回 `axTree`（role/title/identifier/children）、`nodeCount`、`digest`（32 hex）、`latencyMs` |
| 4 | assert_element 返回 `passed`、`actual`、`operationId`、`evidenceId` |
| 5 | diagnose 返回 `class`（T0–T9/NO_ANOMALY/INCONCLUSIVE 之一）与四字段报告（path/anomaly/evidence/next） |
| 6 | last_evidence 返回完整 evidence 包：`schemaVersion="glasspane.evidence/0.1-draft"`、`operationId`、`attribution.level="soft"`、`circuitBreaker.level` 0–3、`signals.act` 必填、`handlerProbe`/`stateDiff` 为显式 null |
| 7 | shutdown 返回 `{bye: true}`，daemon 进程随后退出，socket 文件被清理 |

## 常见失败形态

| 现象 | 处置 |
|---|---|
| `GP_E_AX_UNAVAILABLE` | 权限未授予/被撤销：重跑 `--grant-accessibility` |
| `GP_E_APP_NOT_FOUND` | 被测 app 未启动，或 bundleId 拼写错误 |
| `GP_E_ACT_FAILED` | selector 不匹配或元素不支持该 action：先 observe 核对 role/title |
| act 成功但 diagnose 为 INCONCLUSIVE + pixelDiff null | 屏幕录制权限缺失（降级形态，非 bug） |
