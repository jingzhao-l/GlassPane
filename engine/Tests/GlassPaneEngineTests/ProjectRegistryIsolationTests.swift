import XCTest
@testable import GlassPaneEngine

/// B2 测试隔离闸（2026-09-22 审计 §4.4 的 B2，2026-09-03 事故复盘后的必做项）。
///
/// A-1 的根因不是"某一处忘了传路径"，而是"活路径可以被悄悄用上"：
/// `EngineCore` 曾经的缺省是 `ProjectRegistry()`（= `~/.glasspane/projects.json`），
/// 于是每一个不注入注册表的用例都绑在开发者的真实注册表上；实测一次覆盖事故
/// 就是 71 条 → 2 条，且无快照不可恢复。修一处调用点挡不住下一次，所以这里
/// 把"测试不得引用活路径"变成机检：出现即红，不需要人记得住。
///
/// 本文件里的被禁字样全部用拼接写出，避免自指命中；扫描时也会跳过本文件。
final class ProjectRegistryIsolationTests: XCTestCase {

    // MARK: - 路径定位（编译期烘焙的 #filePath，CI 与本机一致）

    private var thisFile: String { #filePath }
    private var testsDir: String { (thisFile as NSString).deletingLastPathComponent }
    private var engineDir: String {            // …/engine
        ((testsDir as NSString).deletingLastPathComponent as NSString).deletingLastPathComponent
    }

    private func swiftFiles(in dir: String) -> [String] {
        let fm = FileManager.default
        guard let en = fm.enumerator(atPath: dir) else { return [] }
        return en.compactMap { $0 as? String }
            .filter { $0.hasSuffix(".swift") }
            .map { (dir as NSString).appendingPathComponent($0) }
            .filter { $0 != thisFile }
    }

    private func read(_ path: String) throws -> String {
        String(decoding: try Data(contentsOf: URL(fileURLWithPath: path)), as: UTF8.self)
    }

    /// 只看代码，不看注释：这条闸管的是"有没有代码解析到活路径"，而解释事故缘由的
    /// 注释里必然要提到那些名字（本文件自己的文档就是）。不做这个区分，第一次
    /// 认真写注释的人就会把闸关掉——那正是"闸的拒绝分支不可执行"的另一种写法。
    private func codeOnly(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("*") }
            .joined(separator: "\n")
    }

    /// 禁止出现在 Tests/ 里的字样：每一个都会解析到 `~/.glasspane`。
    private var forbiddenInTests: [String] {
        [
            "ProjectRegistry." + "live()",
            "EvidenceStore." + "live()",
            "defaultProjects" + "Path",
            "NSHome" + "Directory()",
            "ApprovalGate." + "defaultPath",
            "EvidenceStore." + "defaultDirectory",
            // 无参调用＝读真实档案/真实台账：不毁数据，但会让用例随本机状态变绿变红。
            "LocalArchive.scanEvidence" + "()",
            "LocalArchive.readApprovalLedger" + "()",
        ]
    }

    func testNoTestReferencesLiveUserPaths() throws {
        let files = swiftFiles(in: testsDir)
        XCTAssertFalse(files.isEmpty, "扫不到任何测试文件＝闸本身失效（路径推导错了）")
        var violations: [String] = []
        for file in files {
            let text = codeOnly(try read(file))
            for token in forbiddenInTests where text.contains(token) {
                let line = text.prefix(while: { c in c != "\n" }).count   // 只为报错可读
                violations.append("\((file as NSString).lastPathComponent): \"\(token)\" (offset ~\(line))")
            }
        }
        XCTAssertTrue(violations.isEmpty, "测试引用了活用户路径，见 [[ProjectRegistryIsolationTests]]：\n" + violations.joined(separator: "\n"))
    }

    /// 活路径进入进程只允许两处：各自的定义文件，和 daemon 入口 `glasspaned`。
    /// 核心不得再留任何"缺省即活路径"的回落（那正是 A-1 的形状）。
    func testLivePathsAreBoundOnlyByProductionEntryPoints() throws {
        let sourcesDir = (engineDir as NSString).appendingPathComponent("Sources")
        let files = swiftFiles(in: sourcesDir)
        XCTAssertFalse(files.isEmpty, "扫不到 Sources ＝闸本身失效")
        let needles = [
            "ProjectRegistry." + "live()",
            "EvidenceStore." + "live()",
        ]
        // 定义处写的是 `static func live()`，不会自引用，所以引用活路径的应当
        // 只有 daemon 入口一个文件。
        let allowed = ["main.swift"]
        var hits: [String] = []
        for file in files {
            let name = (file as NSString).lastPathComponent
            let text = codeOnly(try read(file))
            if needles.contains(where: { text.contains($0) }) { hits.append(name) }
        }
        XCTAssertEqual(
            hits.sorted(), allowed,
            "只有 daemon 入口可以绑定活路径，实到：\(hits.sorted())"
        )
        // 活路径的两个入口本身必须还在（定义丢了＝这条闸要一起改，不是悄悄放行）。
        for defining in [
            "GlassPaneEngine/ProjectRegistry.swift",
            "GlassPaneEngine/EvidenceStore.swift",
        ] {
            let text = try read((sourcesDir as NSString).appendingPathComponent(defining))
            XCTAssertTrue(
                text.contains("public static func live()"),
                "\(defining) 里的 live() 定义不见了"
            )
        }
        // 核心不得留任何"缺省即活路径"的回落，也不得再引用活目录常量：
        // 那类引用一旦落在删档路径上，就是一个从单测能触到用户真实档案的删除面。
        let core = codeOnly(try read((sourcesDir as NSString)
            .appendingPathComponent("GlassPaneEngine/EngineCore.swift")))
        for fallback in [
            "?? ProjectRegistry(",
            "EvidenceStore." + "defaultDirectory",
        ] {
            XCTAssertFalse(
                core.contains(fallback),
                "EngineCore 重新出现了活路径回落 `\(fallback)`＝A-1 同形回归"
            )
        }
    }

    /// 探针包是另一个 SPM target，引用不到这里的常量，所以它的默认路径必须被
    /// **断言一致**而不是靠人记（同 C-1 收敛掉的那三处字面量是同一类坑）。
    func testProbeSocketDefaultsAgreeAcrossPackages() throws {
        let probeSource = (engineDir as NSString)
            .appendingPathComponent("probe/Sources/GlassPaneProbe/GlassPaneProbe.swift")
        guard FileManager.default.fileExists(atPath: probeSource) else {
            throw XCTSkip("探针包源码不在预期位置：\(probeSource)")
        }
        let text = try read(probeSource)
        let needle = "." + "glasspane/probe.sock"
        XCTAssertTrue(text.contains(needle), "探针包里的默认 probe 路径写法变了，请同步这条闸")
        XCTAssertTrue(
            DaemonProbe.defaultProbeSocketPath.hasSuffix(needle),
            "daemon 侧与探针 SDK 侧的默认 probe.sock 路径不再一致：\(DaemonProbe.defaultProbeSocketPath)"
        )
        XCTAssertTrue(
            DaemonProbe.defaultSocketPath.hasSuffix("." + "glasspane/engine.sock"),
            DaemonProbe.defaultSocketPath
        )
    }
}
