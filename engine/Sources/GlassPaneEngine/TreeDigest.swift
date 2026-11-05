import Foundation
import CryptoKit

/// AX tree node — the shape observe returns and the digest input.
public struct AxNode: Codable, Equatable {
    public let role: String
    public let title: String?
    public let identifier: String?
    public let children: [AxNode]

    public init(role: String, title: String? = nil, identifier: String? = nil, children: [AxNode] = []) {
        self.role = role
        self.title = title
        self.identifier = identifier
        self.children = children
    }
}

/// Tree digest: SHA-256 over the canonical (key-sorted, compact) JSON
/// serialization of the depth-limited tree, truncated to the first 16 bytes
/// as lowercase hex (P0 spec §3.3).
public enum TreeDigest {

    public static let digestHexLength = 32

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }()

    public static func digest(_ roots: [AxNode]) throws -> String {
        let data = try encoder.encode(roots)
        let sha = SHA256.hash(data: data)
        return sha.prefix(16).map { String(format: "%02x", $0) }.joined()
    }

    public static func nodeCount(_ roots: [AxNode]) -> Int {
        var count = 0
        var stack = roots
        while let node = stack.popLast() {
            count += 1
            stack.append(contentsOf: node.children)
        }
        return count
    }

    /// 正好落在深度上限那一档的节点数——也就是**这一趟没展开过**的那些。
    ///
    /// 存在的理由（R-12，2026-11-05 复审）：`buildNode` 在 `depth == maxDepth` 那一档既不读
    /// 子节点、也不留记号，交出去的树与"这棵子树真的是叶子"长得一模一样；`gp_observe` 的回话
    /// 里只有 `axTree`/`nodeCount`/`digest`，于是"这里往下没有控件了"成了一句没量过的话——
    /// 同一层里 `selectorMissReason(truncatedByDepth:)` 与 `walkGeometry` 的 unread 占位都已经
    /// 把截断说出来了，只有这一路没说。数得出来是因为它只看已经交回的树，不需要再问一次 AX。
    static func nodesAtDepth(_ roots: [AxNode], depth limit: Int) -> Int {
        guard limit >= 0 else { return 0 }
        var frontier = roots
        var reached = 0
        for _ in 0..<limit {
            frontier = frontier.flatMap(\.children)
            if frontier.isEmpty { return 0 }
        }
        reached = frontier.count
        // 上限那一档的节点仍带着 children 时（调用方给的树本来就这么深），下面那些也是没读过的，
        // 但这一条只报"停在何处"，不替下面的子树作任何陈述。
        return reached
    }
}
