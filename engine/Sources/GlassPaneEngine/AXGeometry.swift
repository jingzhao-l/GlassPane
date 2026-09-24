import Foundation

/// 元素几何：AX 的 position+size 合成一个窗口坐标系下的矩形（点为单位，非像素）。
public struct AxFrame: Codable, Equatable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    public var area: Double { max(0, width) * max(0, height) }
    public var midX: Double { x + width / 2 }
    public var midY: Double { y + height / 2 }
    public var maxX: Double { x + width }
    public var maxY: Double { y + height }

    /// 完全落在 `outer` 内（含边界相切）。
    public func contained(in outer: AxFrame) -> Bool {
        x >= outer.x && y >= outer.y && maxX <= outer.maxX && maxY <= outer.maxY
    }

    /// 中心点在 `outer` 内——"看得见、点得到"的最低条件。
    public func centerInside(_ outer: AxFrame) -> Bool {
        midX >= outer.x && midX <= outer.maxX && midY >= outer.y && midY <= outer.maxY
    }

    public func intersectionArea(with other: AxFrame) -> Double {
        let w = min(maxX, other.maxX) - max(x, other.x)
        let h = min(maxY, other.maxY) - max(y, other.y)
        guard w > 0, h > 0 else { return 0 }
        return w * h
    }
}

/// 单个元素的几何读数状态。
///
/// 三态而非 `frame: AxFrame?` 两态，是因为"这个元素不暴露 position/size"和
/// "这次读没读出来"是两件不同的事：前者是应用的诚实回答，后者是我们没看到。
/// 把它们混成一个 nil，审计就会把没测到的部分算进"通过"——正是本项目最不允许的
/// 那种绿（同 R2-06：树遍历里未完成的读曾被当成"叶子"报出去）。
public enum GeometryRead: Codable, Equatable {
    case measured(AxFrame)
    /// 应用明确不提供该属性（如某些容器/分组元素）。
    case absent
    /// 读取超时或被拒：结论未知，只能计入覆盖率分母，不能当作"没问题"。
    case unread(reason: String)

    public var frame: AxFrame? {
        if case let .measured(frame) = self { return frame }
        return nil
    }

    private enum CodingKeys: String, CodingKey { case status, frame, reason }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .status) {
        case "measured": self = .measured(try container.decode(AxFrame.self, forKey: .frame))
        case "absent": self = .absent
        default: self = .unread(reason: (try? container.decode(String.self, forKey: .reason)) ?? "unknown")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .measured(frame):
            try container.encode("measured", forKey: .status)
            try container.encode(frame, forKey: .frame)
        case .absent:
            try container.encode("absent", forKey: .status)
        case let .unread(reason):
            try container.encode("unread", forKey: .status)
            try container.encode(reason, forKey: .reason)
        }
    }
}

/// 扁平的几何节点：`path` 是它在无障碍树里的索引路径（"0/3/1"），
/// 与 `AxNode` 树同一次遍历产生，因此两者可以按 path 对上。
///
/// 几何**不进入** `AxNode`，也就不进入 `TreeDigest`：树摘要必须是结构摘要，
/// 否则一次 hover、一段动画或光标移动都会让"前后对比"报出变更，把归因语义
/// 从"这次操作造成了这次变化"降级成"这段时间里屏幕上有点什么动了"。
public struct AxGeometryNode: Codable, Equatable {
    public let path: String
    public let role: String
    public let title: String?
    public let identifier: String?
    public let geometry: GeometryRead

    public init(path: String, role: String, title: String? = nil, identifier: String? = nil, geometry: GeometryRead) {
        self.path = path
        self.role = role
        self.title = title
        self.identifier = identifier
        self.geometry = geometry
    }
}

/// 一次几何遍历的结果，独立于 `AxTreeSnapshot`。
public struct AxGeometrySnapshot: Codable, Equatable {
    public let nodes: [AxGeometryNode]
    public let window: AxFrame?
    public let latencyMs: Double

    public init(nodes: [AxGeometryNode], window: AxFrame?, latencyMs: Double) {
        self.nodes = nodes
        self.window = window
        self.latencyMs = latencyMs
    }
}
