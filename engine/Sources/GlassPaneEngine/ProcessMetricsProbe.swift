import Foundation
import Darwin

/// 目标进程指标（进程级、无需 TCC 权限的采样）。
public typealias ProcessMetrics = (memoryBytes: Int64?, handleCount: Int?)

/// 进程指标提供者抽象：engine 用它按 pid 采集常驻内存与句柄数。
/// 测试注入脚本探针；nil 字段 = 该信号本次采样失败（诚实缺失）。
public protocol ProcessMetricsProviding: AnyObject {
    func metrics(for pid: pid_t) -> ProcessMetrics
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
        let handles = memory == nil ? nil : Self.handleCount(pid: pid)
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

    /// 句柄/文件描述符数。PROC_PIDLISTFDS 读取失败返回 nil；空表返回 0。
    static func handleCount(pid: pid_t) -> Int? {
        let needed = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, nil, 0)
        // 值为 0 说明进程存在但没有可枚举的 fd 表（合法空态）；负数为失败。
        guard needed >= 0 else { return nil }
        guard needed > 0 else { return 0 }
        var buffer = [UInt8](repeating: 0, count: Int(needed))
        let bytesWritten = buffer.withUnsafeMutableBytes { rawBuffer in
            proc_pidinfo(pid, PROC_PIDLISTFDS, 0, rawBuffer.baseAddress, Int32(needed))
        }
        guard bytesWritten > 0, bytesWritten % Int32(MemoryLayout<proc_fdinfo>.stride) == 0 else {
            return bytesWritten > 0 ? nil : 0
        }
        return Int(bytesWritten / Int32(MemoryLayout<proc_fdinfo>.stride))
    }
}