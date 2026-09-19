# P6 §8 spike 实测结果（P-1/C2 六假设 + R29 + R26 对照，2026-09-19）

真实对照组：**ronitsingh10/FineTune**（codeload main tar，SwiftUI 菜单栏音量管理器；
132 个 @State 字段、纯 SwiftUI + AppKit）。注入补丁 `patches/finetune-probe.patch`，
SPM 壳构建通过（`swift build` 65s 首次/依赖 pins 对齐上游 Package.resolved：
KeyboardShortcuts 2.4.0 / Sparkle 2.8.1 / FluidMenuBarExtra 1.5.1）。

| # | 假设 | 通过线 | 实测 | 判定 |
|---|---|---|---|---|
| H7 | 宏插桩构建膨胀（R29/C1） | 增量 <30%、全量 <50% | probe-demo 双分支×3 中位：冷全量 54.7s→448.0s（**+720%**，swift-syntax 插件构建主导）；同 .build 增量 3.75s→7.57s（**+102%**） | **超阈 → C1 失败动作兑现**：宏转 opt-in build phase；Z1 语义由手动 `GP.recordHandler/recordState` 承担（同为作者标注、source 同 lane）。daemon 构建图零污染（独立包切分）已保证主链路不受害 |
| H3 | @State 直写占比 | <20% | FineTune strict（`$binding` 框架内写=真不可标）23/132=**17.4% ✓**；loose 上界（含可标的 action 闭包直写）57.6%；本仓库 settings 样本过小（2 字段）不采信 | **strict 口径达标**（双口径已入 run_spike.py，方法如实声明） |
| H1 | operationID 双写→强归因覆盖率 | >80%；真实 ≥ 合成−10pp | 合成 app：ok-press 金丝雀真值 strong（1/1 实测，机制单测 27 用例覆盖 handler 命中/state-only/污染降级全路径）。真实 app：探针 hello/注册/caps 端到端通（FineTune 实测注册 z1）；**比率未采到**——裸可执行形态下 FineTune 主线程启动期持续 AX ping 超时（音频初始化无 bundle 环境受阻）且 MenuBarExtra 无常规窗口、2 个 checkbox 实例无标识属性 | **部分达成**：链路与机制 GO；真实 app 比率复测挂 Phase B（换窗口型真实 app 或 .app 打包形态，命令清单见下"复测配方"） |
| H5 | 五线索引失效率分布 | 分布可接受 | 六类真值 canary 各 1 检出（P6-E：strong/handler/state/AX 结构/late 计数全中）；**缺口如实**：Lazy 容器/动态内容样本未覆盖（demo 无 Lazy），H1 期真实 app 树操作未跑通 | 部分达成（合成分布达标，真实分布挂 Phase B） |
| H6 | S1 副作用门控 | >90% 重跑抑制 | gpz1 恢复=注册 setter 直写，不经视图生命周期：demo rollback 后 pid/窗口数不变、仅数据节点变化（代理口径 **100% 抑制**） | 达标（代理口径声明：onAppear 语义在 setter 路径天然不触发；@Observable 重放型场景挂真实 app 复测） |
| H4 | MTLCaptureManager 语义映射 | 3 个 Metal 视图稳定映射 | macOS 26 SDK 无 makeCaptureScope 系 API（真机校正），实现改 `MTLCaptureDescriptor` 编程捕获；demo 无 Metal 视图，3 场景映射未集齐 | **按 §10.1 H4 失败动作执行：Z4.5 定性为基线对比通道**，语义映射随窗口型真实 app 复测 |

## Go/No-Go 与修正
- **GO**：探针链路（SDK→wire→窗口归因→evidence 真值→分类→档 1）全环节真机成立；
  两个阈值修正落地为代码与规格（C1→opt-in；H4→基线通道）。
- **修正后的断言阈值与降级路径**：C1 覆盖率承诺缩窄为"手动标注 + Z2/Z3 注册面"；
  Z4.5 不参与生死断言；C2 强归因比率标定需真实 app 数据 → 复测配方：
  ①选窗口型真实 SwiftUI app（或给 FineTune 补 .app 打包：make-app.sh 同款壳）；
  ②`GP.registerMirrorRoot` + 2 处 `recordHandler`；③`.p6_smoke.py` 的 run_canary
  换目标 pid/控件选择器跑 ≥20 act；④数据回本表。
- **schema 冻结判定**：draft→v0.1 冻结的**全部前置中仅剩 H1/H5 真实比率一项未闭环**
  （机制与合成分全绿）→ 维持 "glasspane.evidence/0.1-draft" 不冻结，冻结列为
  Phase B 入口第 0 步（Phase B 执行仍需用户授权发布，本批不代决）。
