import Foundation

/// 一次 act 收尾采集的退化样本（P2 spec v2.1 §18.1）。
/// 可选字段 = 信号诚实缺失：探针读不到（进程退出/权限异常）时该信号不参与
/// 回归统计、不产假斜率。ping 仅在 responsive 时计入——AX 超时是一次性尖峰
/// 而非漂移，纳入会污染主线程漂移曲线。
public struct DegradationSample: Equatable {
    /// epoch 秒（可注入时钟）。
    public let timestamp: Double
    /// 主线程 AX ping 延迟；nil = 本次响应不可用（超时/未采样）。
    public let pingMs: Double?
    /// 目标进程常驻内存字节数；nil = 探针读不到。
    public let memoryBytes: Int64?
    /// 目标进程句柄/文件描述符数；nil = 探针读不到。
    public let handleCount: Int?

    public init(
        timestamp: Double,
        pingMs: Double?,
        memoryBytes: Int64?,
        handleCount: Int?
    ) {
        self.timestamp = timestamp
        self.pingMs = pingMs
        self.memoryBytes = memoryBytes
        self.handleCount = handleCount
    }
}

/// 三信号联合裁决（P2 spec v2.1 §18.2）。
public enum DegradationTier: String, Equatable {
    /// 上倾信号数 <2（0 个或样本不足/信号缺失）：无症状。
    case healthy
    /// 恰好 1 个信号呈持续正斜率：早期预警，暂不升级。
    case watch
    /// ≥2 个信号呈持续正斜率：联合判定成立，T9 检出。
    case degrading
}

/// 一次联合裁决结果（供 evidence reason 与审计/报告使用）。
public struct DegradationVerdict: Equatable {
    public let tier: DegradationTier
    public let pingSlopeMsPerSec: Double?
    public let memorySlopeBytesPerSec: Double?
    public let handleSlopePerSec: Double?
    public let sampleCount: Int
    public let elapsedSeconds: Double
    public let longSession: Bool
    /// 上倾信号名（"ping" / "memory" / "handles"），按信号顺序稳定排序。
    public let drivers: [String]

    public init(
        tier: DegradationTier,
        pingSlopeMsPerSec: Double?,
        memorySlopeBytesPerSec: Double?,
        handleSlopePerSec: Double?,
        sampleCount: Int,
        elapsedSeconds: Double,
        longSession: Bool,
        drivers: [String]
    ) {
        self.tier = tier
        self.pingSlopeMsPerSec = pingSlopeMsPerSec
        self.memorySlopeBytesPerSec = memorySlopeBytesPerSec
        self.handleSlopePerSec = handleSlopePerSec
        self.sampleCount = sampleCount
        self.elapsedSeconds = elapsedSeconds
        self.longSession = longSession
        self.drivers = drivers
    }
}

/// 纯逻辑：渐进退化检测核心（P2 spec v2.1 §18.2）。对三个信号（主线程 ping /
/// 常驻内存 / 句柄）分别做最小二乘线性回归求斜率，噪声地板之上的正斜率计为
/// 一个上倾信号；≥2 个上倾信号 → `degrading`（联合判定，T9 检出）。可注入
/// 窗口大小 / 最低统计数 / 长会话阈值 / 噪声地板，100% 单测覆盖，无 AX 依赖。
public final class DegradationTracker {

    /// 默认滑动窗口：最近 64 个样本（FIFO 修剪，与 evidence 环形历史同范式）。
    public static let defaultWindowSize = 64
    /// 默认最低统计样本数：不足不妄判（healthy）。
    public static let defaultMinimumSamplesForTrend = 6
    /// 默认长会话阈值：窗口跨度 ≥ 该秒数 → longSession = true。
    public static let defaultLongSessionThresholdSeconds: Double = 300
    /// 默认噪声地板：ping 斜率（ms/s）低于该值视为 jitter。
    public static let defaultPingNoiseFloorMsPerSec: Double = 0.5
    /// 默认噪声地板：内存斜率（bytes/s）低于该值视为 jitter。
    public static let defaultMemoryNoiseFloorBytesPerSec: Double = 512
    /// 默认噪声地板：句柄斜率（fds/s）低于该值视为 jitter。
    public static let defaultHandleNoiseFloorPerSec: Double = 0.05

    private let windowSize: Int
    private let minimumSamplesForTrend: Int
    private let longSessionThresholdSeconds: Double
    private let pingNoiseFloorMsPerSec: Double
    private let memoryNoiseFloorBytesPerSec: Double
    private let handleNoiseFloorPerSec: Double

    private var samples: [DegradationSample] = []

    public init(
        windowSize: Int = DegradationTracker.defaultWindowSize,
        minimumSamplesForTrend: Int = DegradationTracker.defaultMinimumSamplesForTrend,
        longSessionThresholdSeconds: Double = DegradationTracker.defaultLongSessionThresholdSeconds,
        pingNoiseFloorMsPerSec: Double = DegradationTracker.defaultPingNoiseFloorMsPerSec,
        memoryNoiseFloorBytesPerSec: Double = DegradationTracker.defaultMemoryNoiseFloorBytesPerSec,
        handleNoiseFloorPerSec: Double = DegradationTracker.defaultHandleNoiseFloorPerSec
    ) {
        self.windowSize = max(windowSize, 1)
        self.minimumSamplesForTrend = max(minimumSamplesForTrend, 2)
        self.longSessionThresholdSeconds = longSessionThresholdSeconds
        self.pingNoiseFloorMsPerSec = pingNoiseFloorMsPerSec
        self.memoryNoiseFloorBytesPerSec = memoryNoiseFloorBytesPerSec
        self.handleNoiseFloorPerSec = handleNoiseFloorPerSec
    }

    /// 追加一个样本；超出窗口上限时按 FIFO 修剪最旧样本。
    public func record(_ sample: DegradationSample) {
        samples.append(sample)
        if samples.count > windowSize {
            samples.removeFirst(samples.count - windowSize)
        }
    }

    /// 清空窗口（attach 切换到不同 app 时调用，退化轨迹按被测会话隔离）。
    public func reset() {
        samples.removeAll()
    }

    /// 当前窗口内样本数（测试断言使用）。
    public var sampleCount: Int { samples.count }

    /// 联合裁决。样本数 < minimumSamplesForTrend 时返回 healthy（数据不足不妄判）；
    /// 长会话标记仅随裁决输出，不改变 tier 本身。
    public func verdict() -> DegradationVerdict {
        guard samples.count >= minimumSamplesForTrend else {
            return DegradationVerdict(
                tier: .healthy,
                pingSlopeMsPerSec: nil,
                memorySlopeBytesPerSec: nil,
                handleSlopePerSec: nil,
                sampleCount: samples.count,
                elapsedSeconds: 0,
                longSession: false,
                drivers: []
            )
        }

        let pingSlope = Self.slope(
            samples: samples,
            value: { $0.pingMs }
        )
        let memorySlope = Self.slope(
            samples: samples,
            value: { $0.memoryBytes.map { Double($0) } }
        )
        let handleSlope = Self.slope(
            samples: samples,
            value: { $0.handleCount.map { Double($0) } }
        )

        guard
            let firstTimestamp = samples.first?.timestamp,
            let lastTimestamp = samples.last?.timestamp,
            lastTimestamp >= firstTimestamp
        else {
            return .init(
                tier: .healthy, pingSlopeMsPerSec: nil, memorySlopeBytesPerSec: nil,
                handleSlopePerSec: nil, sampleCount: samples.count, elapsedSeconds: 0,
                longSession: false, drivers: []
            )
        }
        let elapsedSeconds = lastTimestamp - firstTimestamp

        var drivers: [String] = []
        if let pingSlope, pingSlope >= pingNoiseFloorMsPerSec {
            drivers.append("ping")
        }
        if let memorySlope, memorySlope >= memoryNoiseFloorBytesPerSec {
            drivers.append("memory")
        }
        if let handleSlope, handleSlope >= handleNoiseFloorPerSec {
            drivers.append("handles")
        }

        let tier: DegradationTier
        if drivers.count >= 2 {
            tier = .degrading
        } else if drivers.count == 1 {
            tier = .watch
        } else {
            tier = .healthy
        }

        return DegradationVerdict(
            tier: tier,
            pingSlopeMsPerSec: pingSlope,
            memorySlopeBytesPerSec: memorySlope,
            handleSlopePerSec: handleSlope,
            sampleCount: samples.count,
            elapsedSeconds: elapsedSeconds,
            longSession: elapsedSeconds >= longSessionThresholdSeconds,
            drivers: drivers
        )
    }

    /// 最小二乘线性回归斜率（y 随 x = timestamp 变化）；样本 <2 或 x 跨度为 0
    /// 时返回 nil（不足统计）。
    private static func slope(
        samples: [DegradationSample],
        value: (DegradationSample) -> Double?
    ) -> Double? {
        var points: [(x: Double, y: Double)] = []
        points.reserveCapacity(samples.count)
        for sample in samples {
            if let y = value(sample) {
                points.append((x: sample.timestamp, y: y))
            }
        }
        guard points.count >= 2 else { return nil }
        let count = Double(points.count)
        let sumX = points.reduce(0) { $0 + $1.x }
        let sumY = points.reduce(0) { $0 + $1.y }
        let sumXY = points.reduce(0) { $0 + $1.x * $1.y }
        let sumXX = points.reduce(0) { $0 + $1.x * $1.x }
        let denominator = count * sumXX - sumX * sumX
        guard abs(denominator) > Double.ulpOfOne else { return nil }
        return (count * sumXY - sumX * sumY) / denominator
    }
}