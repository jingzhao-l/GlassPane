// GlassPane 崩溃夹具（P6 §6/§7.5 的 capture 执行面用）。
//
// 为什么要把它写进仓库：入库的 `bridge/crashcanary` 是 spike 当时在临时目录里
// 编译的（其调试信息指向 `crashme/crashme.swift`），源不在仓库 = 夹具不可复现，
// 任何一次 capture 回归失败都无从判断是桥坏了还是夹具坏了。本文件是等价再生成源。
//
// 重建（不要覆盖已入库那一份，除非刻意更新夹具——`bridge/capture-sample.json`
// 是按它采样的留档数据）：
//   swiftc -g -o /tmp/crashcanary bridge/crashcanary.swift
// 自检（真崩溃 + 桥能采到栈）：
//   python3 bridge/glasspane_bridge.py capture --exe /tmp/crashcanary --out /tmp/capture.json
//
// 形态要求：进程必须在调试器就位**之后**才崩（否则采不到现场），且崩溃点要有一
// 层可辨认的调用帧，供 Z5/T1 判定与 capture 的 6 帧样本对齐。
import Foundation

/// 刻意命名的中间帧：capture 样本里能认出夹具自身，而不是 libc 噪声。
func raiseCanaryCrash() -> Never {
    let payload: [String: Int] = ["alpha": 1, "beta": 2]
    // 越界下标 → SIGTRAP/SIGILL 级致命错误，稳定、可复现、无外部依赖。
    let missing = payload["gamma"]!
    fatalError("unreachable, missing=\(missing)")
}

FileHandle.standardOutput.write(Data("crashcanary: armed, crashing in 250ms\n".utf8))
Thread.sleep(forTimeInterval: 0.25)
raiseCanaryCrash()
