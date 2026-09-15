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
}
