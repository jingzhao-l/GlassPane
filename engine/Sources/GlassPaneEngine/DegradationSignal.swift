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
    /// 上倾信号数 0：窗口内没测到持续上倾。注意"没判"也落在这个取值上，靠
    /// `DegradationVerdict.judged` 与它区分——样本不足/窗口太短时不得升级，但
    /// 也不许对读者宣称"测出来是健康的"（R6-01）。
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
    /// R6-01：这次裁决到底**做了没有**。`false` 表示窗口不够长或样本不够多，
    /// 于是 `tier == .healthy` 说的是"还没法判"，不是"测出来是健康的"——以前两者
    /// 共用一个取值，R5-06 把 tier 发到 `probe_status` 之后，这个混淆第一次有了
    /// 读者（复审："新发布的 tier 把『没采到』印成『健康』"）。
    public let judged: Bool
    /// 为什么判 / 为什么没判。一句人话，带实测数字，供诊断与 `probe_status` 转发。
    public let basis: String
    /// 这次裁决实际生效的两道门槛（不是文档里的默认值——追踪器可以被注入不同的数）。
    /// 发出去时与 `samples` / `spanSeconds` 成对出现，读者才不需要猜门限值。
    public let minimumSamplesForTrend: Int
    public let minimumTrendSpanSeconds: Double

    public init(
        tier: DegradationTier,
        pingSlopeMsPerSec: Double?,
        memorySlopeBytesPerSec: Double?,
        handleSlopePerSec: Double?,
        sampleCount: Int,
        elapsedSeconds: Double,
        longSession: Bool,
        drivers: [String],
        judged: Bool = true,
        basis: String = "",
        minimumSamplesForTrend: Int = DegradationTracker.defaultMinimumSamplesForTrend,
        minimumTrendSpanSeconds: Double = DegradationTracker.defaultMinimumTrendSpanSeconds
    ) {
        self.tier = tier
        self.pingSlopeMsPerSec = pingSlopeMsPerSec
        self.memorySlopeBytesPerSec = memorySlopeBytesPerSec
        self.handleSlopePerSec = handleSlopePerSec
        self.sampleCount = sampleCount
        self.elapsedSeconds = elapsedSeconds
        self.longSession = longSession
        self.drivers = drivers
        self.judged = judged
        self.basis = basis
        self.minimumSamplesForTrend = minimumSamplesForTrend
        self.minimumTrendSpanSeconds = minimumTrendSpanSeconds
    }
}

/// 纯逻辑：渐进退化检测核心（P2 spec v2.1 §18.2）。对三个信号（主线程 ping /
/// 常驻内存 / 句柄）分别做最小二乘线性回归求斜率，噪声地板之上的正斜率计为
/// 一个上倾信号；≥2 个上倾信号 → `degrading`（联合判定，T9 检出）。可注入
/// 窗口大小 / 最低统计数 / 长会话阈值 / 噪声地板，100% 单测覆盖，无 AX 依赖。
///
/// R6-01 加了两条与**调用频率**解耦的规则（斜率的自变量是秒，所以采样密度和窗口
/// 时间深度都不能由客户端节奏决定）：`record` 按 `minSampleIntervalSeconds` 拒收
/// 过密的样本，`verdict` 在窗口跨度不足 `minimumTrendSpanSeconds` 时不判（并把
/// "没判"说成没判，见 `DegradationVerdict.judged`）。
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

    /// 默认采样最小间隔（秒）：距上一个入库样本不足该间隔的新样本**不收**。
    ///
    /// 为什么要有这条：窗口是按条数（64）剪的，三条地板是按秒算的。2026-09-25
    /// 之前采样密度＝客户端调用频率，于是同一个真实泄漏在"每秒一次"与"每 50 ms
    /// 一次"两种节奏下会得到不同裁决——R5-06 让 observe 也采样之后，一个只读代理
    /// 能在几秒内把 64 格填满，把带泄漏的历史整窗挤出去（漏检），反过来也能用几次
    /// 抖动凑出两个驱动（假警）。0.5 秒这个数不改变 act 路径的节奏：真机冒烟
    /// 留档数字，不是推演：2026-09-25 14:13 那次 `engine/.t9_smoke.py` 以 0.5 s 节流
    /// + 20 s 跨度闸的配置，在第 **12/24** 轮触发（驱动对 `memory+handles`、
    /// `longSession=false`；日志 `/var/tmp/gp-iterate-gates/runs/r622-fullchain.log`）。
    /// 同一闸在加闸之前的留档是 16/24（`engine/smoke.md` 已同步为这一轮的实测值）。
    /// 每轮多少秒这里不写：那份日志没有时间戳，写了就是拿源码常量宣读运行时事实。
    public static let defaultMinSampleIntervalSeconds: Double = 0.5

    /// 默认趋势判定的最小窗口跨度（秒）。数是从地板反推出来的，不是手感：
    /// 每通道"最小可分辨变化 ÷ 自己的地板"——句柄只能是整数，1 个 fd 摊在跨度 S
    /// 上就是 1/S fd/s，要不让它越过 0.05 fd/s 就得 S ≥ 20 s；内存按一页 4 KB 要
    /// S ≥ 8 s；ping 按 1 ms 要 S ≥ 2 s。三条通道共用一个窗口，取最紧的 20 s。
    public static let defaultMinimumTrendSpanSeconds: Double = 20

    private let windowSize: Int
    private let minimumSamplesForTrend: Int
    private let longSessionThresholdSeconds: Double
    private let pingNoiseFloorMsPerSec: Double
    private let memoryNoiseFloorBytesPerSec: Double
    private let handleNoiseFloorPerSec: Double
    private let minSampleIntervalSeconds: Double
    private let minimumTrendSpanSeconds: Double

    private var samples: [DegradationSample] = []

    public init(
        windowSize: Int = DegradationTracker.defaultWindowSize,
        minimumSamplesForTrend: Int = DegradationTracker.defaultMinimumSamplesForTrend,
        longSessionThresholdSeconds: Double = DegradationTracker.defaultLongSessionThresholdSeconds,
        pingNoiseFloorMsPerSec: Double = DegradationTracker.defaultPingNoiseFloorMsPerSec,
        memoryNoiseFloorBytesPerSec: Double = DegradationTracker.defaultMemoryNoiseFloorBytesPerSec,
        handleNoiseFloorPerSec: Double = DegradationTracker.defaultHandleNoiseFloorPerSec,
        minSampleIntervalSeconds: Double = DegradationTracker.defaultMinSampleIntervalSeconds,
        minimumTrendSpanSeconds: Double = DegradationTracker.defaultMinimumTrendSpanSeconds
    ) {
        self.windowSize = max(windowSize, 1)
        self.minimumSamplesForTrend = max(minimumSamplesForTrend, 2)
        self.longSessionThresholdSeconds = longSessionThresholdSeconds
        self.pingNoiseFloorMsPerSec = pingNoiseFloorMsPerSec
        self.memoryNoiseFloorBytesPerSec = memoryNoiseFloorBytesPerSec
        self.handleNoiseFloorPerSec = handleNoiseFloorPerSec
        self.minSampleIntervalSeconds = max(minSampleIntervalSeconds, 0)
        self.minimumTrendSpanSeconds = max(minimumTrendSpanSeconds, 0)
    }

    /// 追加一个样本；超出窗口上限时按 FIFO 修剪最旧样本。
    ///
    /// 返回是否入库（`@discardableResult`：调用方可以不管，测试必须能证明"拒收"
    /// 这条路真的会走到——一个永远返回 true 的节流阀等于没有节流阀）。时间戳不
    /// 前进的样本（时钟回拨、同一刻重复投递）同样被拒：它会把自变量为时间的回归
    /// 变成计数游戏。
    @discardableResult
    public func record(_ sample: DegradationSample) -> Bool {
        if let last = samples.last, minSampleIntervalSeconds > 0,
           sample.timestamp - last.timestamp < minSampleIntervalSeconds {
            return false
        }
        samples.append(sample)
        if samples.count > windowSize {
            samples.removeFirst(samples.count - windowSize)
        }
        return true
    }

    /// 清空窗口（attach 切换到不同 app 时调用，退化轨迹按被测会话隔离）。
    public func reset() {
        samples.removeAll()
    }

    /// 当前窗口内样本数（测试断言使用）。
    public var sampleCount: Int { samples.count }

    /// 联合裁决。样本数 < `minimumSamplesForTrend`、或窗口跨度 < `minimumTrendSpanSeconds`
    /// 时**不判**：`tier` 仍是 `.healthy`（没有升级的依据），但 `judged == false` 且
    /// `basis` 带实测数字说明为什么没判。长会话标记仅随裁决输出，不改变 tier 本身。
    public func verdict() -> DegradationVerdict {
        guard samples.count >= minimumSamplesForTrend else {
            return notJudged(
                basis: "not judged: \(samples.count) samples in the window, "
                    + "\(minimumSamplesForTrend) needed"
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
            return notJudged(
                basis: "not judged: the window has no usable time span"
                    + " (first/last timestamp missing or reversed)"
            )
        }
        let elapsedSeconds = lastTimestamp - firstTimestamp
        guard elapsedSeconds >= minimumTrendSpanSeconds else {
            // R6-01: the floors are per-second rates, so a slope measured over a
            // window this short is not a trend. Six samples 50 ms apart used to be
            // enough to call two channels "trending" off a few KB of allocator
            // jitter — the false-alarm half of the coupling this round removed.
            return notJudged(
                basis: "not judged: window spans \(Self.secondsText(elapsedSeconds)), "
                    + "\(Self.secondsText(minimumTrendSpanSeconds)) needed for a per-second rate",
                elapsedSeconds: elapsedSeconds
            )
        }

        // Strictly above the floor, as this file's own wording has always said
        // ("噪声地板**之上**的正斜率计为一个上倾信号"). With `>=` the boundary itself
        // was a driver: at exactly the 20.0 s minimum span, one single fd is
        // 0.05 fd/s — the very reading the span floor exists to disallow.
        var drivers: [String] = []
        if let pingSlope, pingSlope > pingNoiseFloorMsPerSec {
            drivers.append("ping")
        }
        if let memorySlope, memorySlope > memoryNoiseFloorBytesPerSec {
            drivers.append("memory")
        }
        if let handleSlope, handleSlope > handleNoiseFloorPerSec {
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

        // Which channels the judgement could not see at all. A nil slope is not a
        // zero slope: `memory` is absent when the metrics probe cannot read the
        // process, `ping` is absent when every sample in the window was an
        // unresponsive round trip or an `observe` (which does not pay for a ping).
        // Without this, "two channels are clean" and "one channel was never read"
        // print the same `drivers: []`.
        var unread: [String] = []
        if pingSlope == nil { unread.append("ping") }
        if memorySlope == nil { unread.append("memory") }
        if handleSlope == nil { unread.append("handles") }
        let basis = "judged from \(samples.count) samples over "
            + "\(Self.secondsText(elapsedSeconds))"
            + (unread.isEmpty ? "" : "; no slope for \(unread.joined(separator: ", "))")

        return DegradationVerdict(
            tier: tier,
            pingSlopeMsPerSec: pingSlope,
            memorySlopeBytesPerSec: memorySlope,
            handleSlopePerSec: handleSlope,
            sampleCount: samples.count,
            elapsedSeconds: elapsedSeconds,
            longSession: elapsedSeconds >= longSessionThresholdSeconds,
            drivers: drivers,
            judged: true,
            basis: basis,
            minimumSamplesForTrend: minimumSamplesForTrend,
            minimumTrendSpanSeconds: minimumTrendSpanSeconds
        )
    }

    /// 一个"没有判"的裁决：不升级、不产假斜率，并说自己为什么没判。
    private func notJudged(basis: String, elapsedSeconds: Double = 0) -> DegradationVerdict {
        DegradationVerdict(
            tier: .healthy,
            pingSlopeMsPerSec: nil,
            memorySlopeBytesPerSec: nil,
            handleSlopePerSec: nil,
            sampleCount: samples.count,
            elapsedSeconds: elapsedSeconds,
            longSession: false,
            drivers: [],
            judged: false,
            basis: basis,
            minimumSamplesForTrend: minimumSamplesForTrend,
            minimumTrendSpanSeconds: minimumTrendSpanSeconds
        )
    }

    /// Seconds, one decimal, for the `basis` strings: those sentences go into
    /// `probe_status`, and a reader comparing them against the thresholds needs
    /// the number, not `6.666666666666667`.
    private static func secondsText(_ seconds: Double) -> String {
        String(format: "%.1fs", seconds)
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