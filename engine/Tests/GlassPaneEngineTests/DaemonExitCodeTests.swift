import XCTest

/// daemon CLI 的退出码契约闸：**程序能回的码，`--help` 必须都说得出；说了的码，程序必须真能回。**
///
/// 缺陷形状：`--help` 的正文在四处散着"exit 64""exit 65""exits 3""exit 1"，
/// 而 `--project-remove` 缺值、`--older-than` 缺值/非数、`--recipe-validate` 文件读不开
/// 这三条路径回的是 **2**（`main.swift` 自己写着），使用文本一次都没提。一个必须按返回值
/// 分叉的调用方（更新器、CI 步骤、agent）读到的是四码之表，跑起来遇到第五码。
///
/// 判据形状抄 `PanelDaemonCommandContractTests`：从源码文本里把两边都抠出来对照，
/// 不信任何一方的自述。反向破坏：删掉 EXIT CODES 里 `2` 那一行 ⇒ "能回却没文档"变红；
/// 把 `exit(3)` 改成 `exit(30)` 而不改文档 ⇒ "文档里有个程序回不出的码"变红。
final class DaemonExitCodeTests: XCTestCase {

    private var mainSwift: String {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }   // → 仓库根
        return url.appendingPathComponent("engine/Sources/glasspaned/main.swift").path
    }

    private func source() throws -> String {
        guard let text = try? String(contentsOfFile: mainSwift, encoding: .utf8) else {
            throw XCTSkip("读不到 \(mainSwift)；这一条对照在没有该文件的环境里不作数")
        }
        return text
    }

    /// 抠出捕获组 1 的每个匹配。
    private func captures(_ pattern: String, in text: String) -> [String] {
        guard let regex = try? NSRegularExpression(pattern: pattern) else {
            XCTFail("正则写坏了：\(pattern)")
            return []
        }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        var out: [String] = []
        regex.enumerateMatches(in: text, range: range) { match, _, _ in
            guard let match, match.numberOfRanges > 1,
                  let group = Range(match.range(at: 1), in: text) else { return }
            out.append(String(text[group]))
        }
        return out
    }

    /// 程序能回的码：`exit(N)`（含 `exit(cond ? 1 : 0)` 这种三元里的两个分支）
    /// 与 `.errorCode(…, N)` 的最后一个数字。
    private func returnedCodes(_ text: String) -> (codes: Set<Int>, sites: Int) {
        var codes: Set<Int> = []
        var sites = 0
        for argument in captures(#"exit\(([^)]*)\)"#, in: text) {
            sites += 1
            // 捕获组必须有：`captures` 只收 group 1，写成 `\d+`（无组）会一条都不命中，
            // 于是这条对照自己变成空表——正是它该拦住的那种假绿。
            for digits in captures(#"(\d+)"#, in: argument) {
                if let value = Int(digits) { codes.insert(value) }
            }
        }
        for line in text.split(separator: "\n") where line.contains(".errorCode(") {
            guard let trailing = captures(#",\s*(\d+)\s*\)"#, in: String(line)).last,
                  let value = Int(trailing) else { continue }
            sites += 1
            codes.insert(value)
        }
        return (codes, sites)
    }

    /// `--help` 的 EXIT CODES 一节列出的码：小节内每一行以码的数字开头。
    private func documentedCodes(_ text: String) -> Set<Int> {
        guard let start = text.range(of: "EXIT CODES"),
              let end = text.range(of: "PROTOCOL:", range: start.upperBound..<text.endIndex) else {
            return []
        }
        var codes: Set<Int> = []
        for line in text[start.upperBound..<end.lowerBound].split(separator: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            let digits = trimmed.prefix { $0.isNumber }
            guard !digits.isEmpty, digits.count < trimmed.count,
                  trimmed[digits.endIndex].isWhitespace, let value = Int(digits) else { continue }
            codes.insert(value)
        }
        return codes
    }

    /// 抽取本身要先能证伪，否则"两边都抠到空集合"会一路绿。
    func testExtractorSeesBothSidesOfTheContract() throws {
        let text = try source()
        let returned = returnedCodes(text)
        XCTAssertGreaterThanOrEqual(returned.sites, 20,
            "只找到 \(returned.sites) 处退出点，这条对照已经在看不到东西的地方")
        XCTAssertGreaterThanOrEqual(returned.codes.count, 5,
            "只抠出 \(returned.codes.count) 个退出码（\(returned.codes.sorted())），形状大概变了")
        XCTAssertTrue(returned.codes.contains(64) && returned.codes.contains(65),
            "64/65 是这 CLI 的两根柱子，抠不到就是解析式失效：\(returned.codes.sorted())")
        let documented = documentedCodes(text)
        XCTAssertGreaterThanOrEqual(documented.count, 5,
            "EXIT CODES 一节只列出 \(documented.count) 个码（\(documented.sorted())），这一节没在交代整套")
    }

    /// 主闸（两个方向）：能回的都必须写，写的都必须能回。
    func testUsageDocumentsExactlyTheExitCodesTheBinaryCanReturn() throws {
        let text = try source()
        let returned = returnedCodes(text).codes
        let documented = documentedCodes(text)
        let undocumented = returned.subtracting(documented).sorted()
        XCTAssertTrue(undocumented.isEmpty,
            "这些退出码程序会回、`--help` 却没说：\(undocumented)（调用方读到的是四码之表）")
        let phantom = documented.subtracting(returned).sorted()
        XCTAssertTrue(phantom.isEmpty,
            "EXIT CODES 写了程序回不出的码：\(phantom)（文档不许比程序更能干）")
    }

    /// 0/1/64/65 这四根柱子各留一句具名断言：整套对照退化成空表时这几条先红。
    func testTheFourNamedPillarsAreStillThere() throws {
        let text = try source()
        let codes = returnedCodes(text).codes
        for pillar in [0, 1, 64, 65] {
            XCTAssertTrue(codes.contains(pillar), "程序不再能回 \(pillar)：这条闸的样本集变了")
            XCTAssertTrue(documentedCodes(text).contains(pillar), "`--help` 不再解释 \(pillar)")
        }
    }
}
