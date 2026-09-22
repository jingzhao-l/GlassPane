import Foundation
import Darwin

/// 目标进程指标（进程级、无需 TCC 权限的采样）。
public typealias ProcessMetrics = (memoryBytes: Int64?, handleCount: Int?)

/// 进程指标提供者抽象：engine 用它按 pid 采集常驻内存与句柄数。
/// 测试注入脚本探针；nil 字段 = 该信号本次采样失败（诚实缺失）。
public protocol ProcessMetricsProviding: AnyObject {
    func metrics(for pid: pid_t) -> ProcessMetrics
}

/// `PROC_PIDLISTFDS` 一次采样的结局（P2 spec v2.1 §18.3）。
///
/// 三态**必须**分开（R2-14）：把错误折成 `0` 句柄会造出"进程活着但一个 fd
/// 都没有"这条不可能的样本 —— 那正是 `metrics(for:)` 注释里要防的形状，而且它
/// 在退化曲线上表现为一次真实的下降（假斜率）。只有 `.measured` 是观测值。
enum HandleScan: Equatable {
    /// 可信观测：枚举到的完整 fd 记录数。`0` 只来自尺寸探测自己报出的合法
    /// 空表，绝不来自错误返回或 0 字节短写。
    case measured(Int)
    /// proc_pidinfo 返回负数（ESRCH / EACCES / EINVAL…）：本次没有测量。
    case failed(errno: Int32)
    /// 采到了原始返回但推不出条数：两次调用之间 fd 表变了（短读到不足一条 /
    /// 探到字节数却一个字节没写出来），分不清"真的空了"与"读丢了"，按未测量
    /// 处理，并在串里写清是哪一种。
    case indeterminate(String)

    /// 唯一能进 `DegradationSample.handleCount` 的取值；其余为诚实缺失。
    var count: Int? {
        switch self {
        case .measured(let count): return count
        case .failed, .indeterminate: return nil
        }
    }
}

/// macOS proc_pidinfo 适配层（P2 spec v2.1 §18.3）：读目标进程常驻内存
/// （PROC_PIDTASKINFO）与句柄/文件描述符数（PROC_PIDLISTFDS）。
/// 任一读取失败返回 nil——退化信号诚实缺失，不让假斜率进入判定。
public final class ProcessMetricsProbe: ProcessMetricsProviding {

    public init() {}

    public func metrics(for pid: pid_t) -> ProcessMetrics {
        // Existence is validated through the TASKINFO probe: on macOS the
        // LISTFDS nil-buffer size probe returns 0 without validating the pid
        // (a dead pid would masquerade as "alive with zero handles"). When the
        // process is not inspectable, both signals are honestly absent.
        let memory = Self.residentMemoryBytes(pid: pid)
        let handles = memory == nil ? nil : Self.handleScan(pid: pid).count
        return (memoryBytes: memory, handleCount: handles)
    }

    /// 常驻内存（RSS 字节数）。PROC_PIDTASKINFO 读取失败返回 nil。
    static func residentMemoryBytes(pid: pid_t) -> Int64? {
        var info = proc_taskinfo()
        let size = MemoryLayout<proc_taskinfo>.stride
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            proc_pidinfo(pid, PROC_PIDTASKINFO, 0, pointer, Int32(size))
        }
        guard result > 0 else { return nil }
        return Int64(info.pti_resident_size)
    }

    /// 一条 `proc_fdinfo` 记录的字节数（解释两次返回值的单位）。
    static var fdRecordStride: Int { MemoryLayout<proc_fdinfo>.stride }

    /// 句柄/文件描述符数：先探尺寸，再读表，最后交给 `interpretFDScan` 分三态。
    static func handleScan(pid: pid_t) -> HandleScan {
        let stride = fdRecordStride
        let needed = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, nil, 0)
        guard needed > 0 else {
            // 负数（错误）与 0（合法空表）都不需要第二次调用。
            return interpretFDScan(sizeProbe: needed, readResult: nil, recordStride: stride)
        }
        var buffer = [UInt8](repeating: 0, count: Int(needed))
        let bytesWritten = buffer.withUnsafeMutableBytes { rawBuffer in
            proc_pidinfo(pid, PROC_PIDLISTFDS, 0, rawBuffer.baseAddress, needed)
        }
        return interpretFDScan(sizeProbe: needed, readResult: bytesWritten, recordStride: stride)
    }

    /// 纯折叠函数：把两次 proc_pidinfo 的原始返回分成三态。单独存在是因为
    /// "fd 表在两次调用之间变了一半"这种输入无法按需让真进程演出来，分支只能
    /// 在这里钉住。
    static func interpretFDScan(
        sizeProbe: Int32,
        readResult: Int32?,
        recordStride: Int
    ) -> HandleScan {
        if sizeProbe < 0 {
            return .failed(errno: sizeProbe)
        }
        guard sizeProbe > 0 else {
            // 值 0 = 进程存在但没有可枚举的 fd 表（合法空态）；负数为失败。
            return .measured(0)
        }
        guard let readResult else {
            // 防御性分支：`handleScan` 只在真的做过第二次读取后才带值进来。
            return .indeterminate("size probe reported \(sizeProbe) bytes but no read followed")
        }
        if readResult < 0 {
            // R2-14 的原缺陷就在这条分支：-1 曾被折成 `0 handles`。
            return .failed(errno: readResult)
        }
        if readResult == 0 {
            // 探到 sizeProbe 字节却一个字节都没写出来：表在这两次调用之间空了，
            // 或读失败到 0。分不清，按未测量处理（不给假的 0 斜率点）。
            return .indeterminate("size probe reported \(sizeProbe) bytes, read produced none")
        }
        guard recordStride > 0 else {
            return .indeterminate("non-positive fd record stride \(recordStride)")
        }
        let complete = Int(readResult) / recordStride
        guard complete > 0 else {
            return .indeterminate(
                "short read of \(readResult) bytes: less than one \(recordStride)-byte fd record"
            )
        }
        // 末尾不足一条的残缺记录 = fd 表在两次调用之间发生了变化（正常现象）。
        // 已完整落进缓冲的那 `complete` 条仍是真实观测，不该连同错误一起丢掉。
        return .measured(complete)
    }
}
