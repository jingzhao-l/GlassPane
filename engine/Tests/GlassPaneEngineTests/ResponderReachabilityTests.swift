import XCTest
@testable import GlassPaneEngine

/// "响应函数能从哪里走到"这条声明，必须与真正的线表 + 路由对照得上（P2 #7）。
///
/// 缺陷形状：`EngineCore.projectList/projectSet/projectGet` 与 `pruneEvidence` 既没有
/// `EngineMethod` 的线名（`FrameCodec.swift`），`Dispatcher.dispatch` 里也没有它们的
/// case，所以 socket 上没有任何一帧能走到它们；而 `projectSet` 的注释写着
/// "this method is a second writer of the same file"——读起来像"壳层经 socket 写之外
/// 还有 daemon 这一路"，而实测的两路写者是**一次性 CLI** 和 mcp-shell 的
/// `src/project-registry.ts`（它用 fs 直接改那份文件）。也就是说：一句不可达的
/// 函数自述了可达。
///
/// 只改注释是修不掉这病的：下一轮还会有别的响应函数这么写。所以这里立一条闸——
/// `EngineCore.swift` 里每个带 `REACHABILITY:` 标记的响应函数都要与两个真源对照：
///  `socket(<name>)` → `<name>` 必须是 `EngineMethod` 的线名，且 Dispatcher 里
///  确实有这一 case；
///  `none` → 这个函数自己既不能出现在 Dispatcher 的任何调用点上，它的线名候选
///  （camelCase→snake_case）也不能在 `EngineMethod` 里。
/// 谁将来把它们接上线，就必须同时改这条注释——一句假自述从此不能悄悄回来。
final class ResponderReachabilityTests: XCTestCase {

    private func source(_ relative: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(relative)
        return try String(contentsOf: url, encoding: .utf8)
    }

    private var engineCoreSource: String {
        get throws { try source("engine/Sources/GlassPaneEngine/EngineCore.swift") }
    }

    private var dispatcherSource: String {
        get throws { try source("engine/Sources/GlassPaneEngine/Dispatcher.swift") }
    }

    /// 每个标记连同它下面第一条 `func` 的名字。判据取"标记之后 400 字符内第一条
    /// func 声明"，因为这份注释与函数之间只夹着别的 `///` 行。
    private struct Claim {
        let functionName: String
        let claimedWireName: String?   // nil = 声明不可达
        let line: String
    }

    private func claims() throws -> [Claim] {
        let lines = try engineCoreSource.components(separatedBy: "\n")
        var found: [Claim] = []
        for (index, line) in lines.enumerated() {
            guard let range = line.range(of: "REACHABILITY:") else { continue }
            let tail = line[range.upperBound...]
            let claimedWireName: String?
            if tail.contains("socket(") {
                guard let start = tail.range(of: "socket(")?.upperBound,
                      let end = tail.range(of: ")", range: start..<tail.endIndex)?.lowerBound
                else {
                    XCTFail("REACHABILITY: socket( 的写法不完整：\(line)")
                    continue
                }
                claimedWireName = String(tail[start..<end])
            } else if tail.contains("none") {
                claimedWireName = nil
            } else {
                XCTFail("读不懂这条 REACHABILITY 标记（只允许 socket(<线名>) 或 none）：\(line)")
                continue
            }
            // 标记之后**最早**出现的那一条函数声明，就是这句注释所属的函数。
            let rest = lines[index...].joined(separator: "\n")
            var funcRange: Range<String.Index>?
            for candidate in ["\n    public func ", "\n    private func ", "\n    static func ", "\n    func "] {
                guard let foundRange = rest.range(of: candidate) else { continue }
                if funcRange == nil || foundRange.lowerBound < funcRange!.lowerBound {
                    funcRange = foundRange
                }
            }
            guard let declared = funcRange else {
                XCTFail("REACHABILITY 标记下面没有函数声明，这条对照已经指不到东西：\(line)")
                continue
            }
            let declaration = rest[declared.upperBound...].prefix(60)
            guard let nameEnd = declaration.firstIndex(where: { $0 == "(" }) else { continue }
            found.append(Claim(
                functionName: String(declaration[..<nameEnd]).trimmingCharacters(in: .whitespaces),
                claimedWireName: claimedWireName,
                line: line
            ))
        }
        return found
    }

    /// `EngineMethod` 的全部线名（真源，不是手抄）。
    private var wireNames: Set<String> {
        Set(EngineMethod.allCases.map(\.rawValue))
    }

    private static func snakeCase(_ name: String) -> String {
        var out = ""
        for character in name {
            if character.isUppercase {
                if !out.isEmpty { out.append("_") }
                out.append(Character(character.lowercased()))
            } else {
                out.append(character)
            }
        }
        return out
    }

    // MARK: - 抽取本身得能红：先在空表上立住

    func testTheExtractorFindsTheMeasuredUnreachableResponders() throws {
        let found = try claims()
        let names = Set(found.map(\.functionName))
        for responder in ["projectList", "projectSet", "projectGet", "pruneEvidence"] {
            XCTAssertTrue(
                names.contains(responder),
                "\(responder) 没有 REACHABILITY 标记：它不可达这件事从此没人对照，假自述可以悄悄回来"
            )
        }
    }

    /// 抽取机器本身有效：真线名必须能在 `EngineMethod` 里查到，查不到的就是假名。
    func testWireTableNameIsNotEmptyAndHoldsTheRealMethods() {
        XCTAssertTrue(wireNames.isSuperset(of: ["hello", "attach", "act", "observe", "snapshot", "restore"]))
    }

    // MARK: - 主闸：声明可达的，必须真的可达

    func testEveryResponderClaimedReachableHasAMethodAndARoute() throws {
        let dispatcher = try dispatcherSource
        for claim in try claims() {
            guard let wireName = claim.claimedWireName else { continue }
            XCTAssertTrue(
                wireNames.contains(wireName),
                "\(claim.functionName) 自述走 socket(\(wireName))，而 \(wireName) 不是 EngineMethod 的线名：\(claim.line)"
            )
            XCTAssertTrue(
                dispatcher.contains("case .\(wireName)") || dispatcher.contains("case .\(camel(wireName))"),
                "EngineMethod 里有 \(wireName)，Dispatcher 却没有这一条 case：一帧进来只会回 unknown"
            )
        }
    }

    // MARK: - 反方向：声明不可达的，测得到它确实不可达

    func testEveryResponderClaimedUnreachableIsActuallyUnreachable() throws {
        let dispatcher = try dispatcherSource
        for claim in try claims() where claim.claimedWireName == nil {
            XCTAssertFalse(
                dispatcher.contains("core.\(claim.functionName)"),
                "\(claim.functionName) 被声明成不可达，Dispatcher 里却有它的调用点——这句注释现在是假的"
            )
            XCTAssertFalse(
                wireNames.contains(Self.snakeCase(claim.functionName)),
                "\(claim.functionName) 有了线名 \(Self.snakeCase(claim.functionName))：它的 REACHABILITY 标记要重读，不能沿用"
            )
        }
    }

    /// `attach`/`act` 这些名字在 Dispatcher 里确实有调用点，作为反向对照证明上一条
    /// 不是"永远为真"的空断言。
    func testReachableRespondersDoHaveCallSitesInTheDispatcher() throws {
        let dispatcher = try dispatcherSource
        XCTAssertTrue(dispatcher.contains("core.attach("))
        XCTAssertTrue(dispatcher.contains("try core.act("))
        XCTAssertFalse(dispatcher.contains("core.projectList("))
        XCTAssertFalse(dispatcher.contains("core.pruneEvidence("))
    }

    /// `pruneEvidence` 的对外路线只能由 CLI 走：二进制里那条分支不碰这个方法。
    /// （这条是上一条的实测补充：不可达说的是"socket"，CLI 那一路是真的。）
    func testMaintenanceCliDoesNotRouteThroughTheUnreachableEngineMethod() throws {
        let main = try source("engine/Sources/glasspaned/main.swift")
        XCTAssertFalse(
            main.contains("core.pruneEvidence(") || main.contains("EngineCore.pruneEvidence("),
            "一次性 CLI 如果改成调 `EngineCore.pruneEvidence`，那条路径的可达性说明要重写"
        )
    }

    private func camel(_ wireName: String) -> String {
        let parts = wireName.split(separator: "_").map(String.init)
        guard var out = parts.first else { return wireName }
        for part in parts.dropFirst() {
            out += part.prefix(1).uppercased() + part.dropFirst()
        }
        return out
    }
}
