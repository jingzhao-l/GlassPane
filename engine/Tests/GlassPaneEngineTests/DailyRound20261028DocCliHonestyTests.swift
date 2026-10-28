import XCTest
@testable import GlassPaneEngine

/// 文档 / CLI 面与真源的一致性闸（2026-10-28 一轮四个已核实缺陷的具名检查）。
///
/// 这一族的判据都不抄字面量，全部回到真源现算：
///  - 断言属性集合 = `AssertionProperty.allCases`（`EvidenceModels.swift`），
///    与 `mcp-shell/src/tools.ts` 的 `property.enum`、
///    `kernel/schemas/evidence-pack.schema.json` 同源；
///  - synopsis 的读法来自被交付的 `main.swift` 的 `printUsage()` 块；
///  - 屏幕录制拒绝分支、`bannerHint` 死字段的判据来自各自源文件的实际形状。
/// 每一条都设计成"改回旧行为必红"，是四个缺陷的反向变异靶。
final class DailyRound20261028DocCliHonestyTests: XCTestCase {

    private var repoRoot: String {
        var url = URL(fileURLWithPath: #filePath)
        url.deleteLastPathComponent()
        url.deleteLastPathComponent()
        url.deleteLastPathComponent()
        url.deleteLastPathComponent()
        return url.path
    }

    private func read(_ relative: String) throws -> String {
        let path = repoRoot + "/" + relative
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else {
            throw XCTSkip("读不到 \(relative)；这一条对照在该文件缺席的环境里不作数")
        }
        return text
    }

    // MARK: - DEFECT 2 — README 的可断言属性必须等于闭集，且不得含 "present"

    /// `gp_assert_element` 的可断言属性闭集就是 `AssertionProperty`（title/value/role/
    /// enabled/focused）。README 双语四处（bullet、At a Glance、Q&A 表、工具表）曾把它写成
    /// "present / enabled / value"——"present" 不是属性，且漏了 role 与 focused。
    /// 反向变异：把任意一处改回 "present"，或去掉 role/focused 之一，本条红。
    func testReadmeAssertElementListsTheClosedPropertySet() throws {
        // 真源：枚举顺序无关，判据是集合本身。
        let truth = Set(AssertionProperty.allCases.map { $0.rawValue })
        XCTAssertEqual(truth, ["title", "value", "role", "enabled", "focused"],
                       "真源枚举变了先在这里显形：README 闸的意义就是跟着它走")

        for (file, keyword) in [
            ("README.md", ["assert_element", "element-level assertion"]),
            ("README.zh-CN.md", ["assert_element", "元素级断言", "控件属性"]),
        ] {
            let text = try read(file)
            let lower = text.lowercased()
            let matchedLines = text
                .components(separatedBy: "\n")
                .filter { line in
                    let l = line.lowercased()
                    let keywordHit = keyword.contains { l.contains($0) }
                    // 只有真正枚举属性的行才纳入（散文中提到 gp_assert_element 但不列属性的行排除）。
                    let enumerates = truth.filter { l.contains($0) }.count >= 1
                    return keywordHit && enumerates
                }
            XCTAssertGreaterThanOrEqual(matchedLines.count, 3,
                "\(file) 只抠到 \(matchedLines.count) 行属性枚举，抽取窗口没张开，断言不作数")
            for line in matchedLines {
                let l = line.lowercased()
                let missing = truth.filter { !l.contains($0) }.sorted()
                XCTAssertTrue(missing.isEmpty,
                    "\(file) 有一行列不出闭集的全部属性（缺 \(missing.joined(separator: ", "))）：\(line)")
                XCTAssertFalse(l.contains("present"),
                    "\(file) 又把不是属性的 present 写回枚举里：\(line)")
                XCTAssertFalse(line.contains("存在"),
                    "\(file) 又把不是属性的「存在」写回枚举里：\(line)")
            }
        }
    }

    /// 旧错误串在任何一份 README 里都不许复现（防止把一处改对、另一处漏改）。
    func testReadmeHasNoStaleWrongPropertyEnumeration() throws {
        for file in ["README.md", "README.zh-CN.md"] {
            let text = try read(file)
            for stale in ["present / enabled / value", "present, enabled, value",
                          "存在/可用/值", "存在 / 可用 / 值"] {
                XCTAssertFalse(text.contains(stale),
                    "\(file) 仍写着旧的可断言属性串「\(stale)」")
            }
        }
    }

    // MARK: - DEFECT 3 — `--check-developer-tools` 必须在 SYNOPSIS，不只是 OPTIONS

    /// `printUsage()` 的 USAGE 段逐条列出每条一次性命令；`--check-developer-tools` 从前
    /// 只在 OPTIONS 里出现，读 SYNOPSIS 的调用方找不到它。反向变异：删掉新加的那行 → 红
    /// （该开关仍会出现在 OPTIONS 段，但 OPTIONS 在切片之外）。
    func testDeveloperToolsFlagIsInUsageSynopsis() throws {
        let text = try read("engine/Sources/glasspaned/main.swift")
        guard let usageStart = text.range(of: "USAGE:"),
              let optionsStart = text.range(of: "OPTIONS:", range: usageStart.upperBound..<text.endIndex)
        else {
            return XCTFail("printUsage 里找不到 USAGE:/OPTIONS: 边界，切片判据失效")
        }
        let synopsis = String(text[usageStart.upperBound..<optionsStart.lowerBound])
        XCTAssertTrue(synopsis.contains("glasspaned --check-developer-tools"),
            "--check-developer-tools 必须作为一条 `glasspaned --…` 出现在 SYNOPSIS 段：\(synopsis)")
        // 与其它 check-* 同一形状：独占一行、`glasspaned ` 前缀。
        let siblingCount = synopsis
            .components(separatedBy: "\n")
            .filter { $0.trimmingCharacters(in: .whitespaces).hasPrefix("glasspaned --check-") }
            .count
        XCTAssertGreaterThanOrEqual(siblingCount, 4,
            "check-* 那批同形兄弟应至少 4 行（screen/input/accessibility/developer-tools），实得 \(siblingCount)")
    }

    // MARK: - DEFECT 4 (option b) — 够不到的拒绝分支不再打印未测到的拒绝

    /// `runGuideScreenPermission` 从前有一个够不到的 `.denied` 分支（`state` 永不为
    /// `.denied`），却打印一句"已拒绝"当作实测结果。反向变异：把那句拒绝打印加回源文件 → 红。
    func testGuideScreenPermissionDoesNotPrintAnUnmeasuredDenial() throws {
        let text = try read("engine/Sources/glasspaned/main.swift")
        XCTAssertFalse(text.contains("Screen recording permission is denied"),
            "够不到的分支又打印了一句未测到的屏幕录制拒绝——产品规矩：绝不凭推断点亮指示")
        XCTAssertTrue(text.contains("Screen recording permission has not been granted yet"),
            "未授予的那句如实陈述必须还在")
        XCTAssertTrue(text.contains("Screen recording is still not granted after the request"),
            "请求后仍未批的那句诚实回执必须还在（旧 DaemonPermissionVocabulary 闸同源）")
    }

    /// 探针的 `state` 用注入的 preflight 真算：预检恒 false 也只会得到 `.notDetermined`，
    /// 永远拿不到 `.denied`——这正是那句拒绝打印够不到的根据。
    func testScreenCaptureStateNeverObservesDenied() {
        let ungranted = ScreenCapturePermissionProbe(preflight: { false }, requestAccess: {})
        XCTAssertEqual(ungranted.state, .notDetermined)
        _ = ungranted.guideAccess()
        XCTAssertNotEqual(ungranted.state, .denied,
            "state 又能给出 denied：option (b) 的删除依据就没了")
    }

    // MARK: - DEFECT 4 (part 2) — 没有读者的 `bannerHint` 已删除，活的 `bannerTitle` 保留

    /// `bannerHint` 全仓唯一读者是它自己的 `isEmpty` 断言，面板从不渲染它（面板读
    /// `bannerTitle`）。死字段按产品规矩删除。反向变异：重新声明 `static let bannerHint` → 红。
    func testDeadBannerHintFieldIsGoneButLiveBannerTitleRemains() throws {
        let text = try read("engine/Sources/GlassPaneEngine/PermissionStatus.swift")
        XCTAssertFalse(text.contains("static let bannerHint"),
            "无人读的 bannerHint 又作为声明回来了——那是条没人接线的主张")
        XCTAssertTrue(text.contains("static let bannerTitle"),
            "bannerTitle 有面板读者（SettingsPanelView 渲染它），不许被一起删掉")
    }
}
