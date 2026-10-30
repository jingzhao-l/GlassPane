import XCTest
import Foundation
@testable import GlassPaneEngine

/// 每日任务 2026-10-30 · 泳道 1 · P2：三枚 `--check-*` 的退出码**不**携带判决，而 `--help`
/// 从没说过这件事。
///
/// 现状。`main.swift:1181-1216` 那三条（`--check-screen-permission` / `--check-input-permission`
/// / `--check-accessibility`）无论读到什么都退 0——0 说的是"这次测量跑了"。同文件里的同族命令
/// （`--permissions`、`--request-permission`、`--guide-screen-permission`、`--check-developer-tools`）
/// 却是**故意**让退出码带上读数的，`--help` 也只给那一族写了这条规矩（"exit 0 only when the seat
/// reads granted afterwards, 1 for every other reading"）。一个按 rc 分叉的脚本因此把"没批"读成
/// "批了"：这不是退出码的设计，是文档层的沉默。
///
/// 本轮只改文档层：**不动退出码**（那是既有调用方的契约，改它是一次破坏性变更，且这三位的历史
/// 口径一直是"我们跑了这次测量"）。`--help` 那三段各自补一句：0 只说明测量跑过，判决在打印出来的
/// 那个词里。
///
/// REVERSE：把新加的那句从任一段里删掉 → 那一段红；把它写到别的段（例如 `--permissions`）→
/// 三段全红，因为这条闸是**逐段**读的。
final class DailyRound20261030Swift1CheckFlagExitHonestyTests: XCTestCase {

    /// 三枚"跑了就退 0"的 check 旗标。名单本身由 `--help` 里真存在这几段来保证（找不到段落
    /// 就是 `helpSegment` 里的 XCTUnwrap 失败），所以这里不另设一张会漂移的表。
    private let measurementOnlyFlags = [
        "--check-screen-permission",
        "--check-input-permission",
        "--check-accessibility",
    ]

    private func mainSource() throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/glasspaned/main.swift")
        return try XCTUnwrap(try? String(contentsOf: url, encoding: .utf8), "读不到 \(url.path)")
    }

    /// 与 `DaemonPermissionVocabularyTests` 同一取法：从那一行起，到下一条同缩进的旗标行为止。
    private func helpSegment(for flag: String, in source: String) throws -> String {
        let lines = source.components(separatedBy: "\n")
        let start = try XCTUnwrap(
            lines.firstIndex { $0.hasPrefix("        \(flag)") },
            "--help 里找不到 \(flag) 这一段——文案被整块挪走时这条闸必须红，不许静默通过"
        )
        var collected = [lines[start]]
        var i = start + 1
        while i < lines.count {
            let line = lines[i]
            if line.range(of: "^ {8}--\\S", options: .regularExpression) != nil { break }
            collected.append(line)
            i += 1
        }
        return collected.map { $0.trimmingCharacters(in: .whitespaces) }.joined(separator: " ")
    }

    /// 每一段都要自己说出那句：0 只是"测量跑过"，判决在打印出来的词里。
    func testEveryCheckFlagSaysZeroIsNotTheVerdict() throws {
        let source = try mainSource()
        for flag in measurementOnlyFlags {
            let segment = try helpSegment(for: flag, in: source)
            XCTAssertTrue(
                segment.lowercased().contains("exit 0 only means"),
                "\(flag) 还在让读者自己猜退出码的意思：\(segment)"
            )
            XCTAssertTrue(
                segment.lowercased().contains("the verdict is the printed word"),
                "\(flag) 没说出判决住在哪一行：\(segment)"
            )
        }
    }

    /// 同族那三枚**故意**用退出码带判决的命令，口径一条不许被这次改动带跑：它们仍然要说
    /// "退出码读的是席位本身"。（这条断言只读既有的文案，不改它。）
    func testSeatCarryingCommandsStillStateTheirOwnRule() throws {
        let source = try mainSource()
        let guide = try helpSegment(for: "--guide-screen-permission", in: source)
        XCTAssertTrue(guide.contains("exit 0 only"), guide)
        XCTAssertTrue(guide.contains("a script that branches on the code"), guide)
    }

    /// 真行为对照：三条 check 命令对**没批下来**的席位也退 0——本轮改的是文档，代码不许跟着改
    /// （改了就是把既有调用方的契约掀了）。这里把"文档说的那句话是真的"钉在真二进制上。
    func testCheckFlagsStillExitZeroWhateverTheyRead() throws {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<3 { url.deleteLastPathComponent() }
        let binary = url.appendingPathComponent(".build/debug/glasspaned").path
        guard FileManager.default.isExecutableFile(atPath: binary) else {
            throw XCTSkip("没有 \(binary)；这一条要的是真二进制（swift build --package-path engine）")
        }
        let sandbox = TestSandbox.directory("check-exit")
        for flag in measurementOnlyFlags {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: binary)
            process.arguments = ["--state-dir", sandbox, flag]
            let outPipe = Pipe()
            let errPipe = Pipe()
            process.standardOutput = outPipe
            process.standardError = errPipe
            try process.run()
            // 两条流分开读：`--check-*` 在没给 `--state-dir` 时会先往 stderr 打一条
            // note（"reads no state…"），席位读数走的是 stdout。合成一条流再去
            // `trimmingCharacters` 比一个词，比的是"note + 词"整段——那是这条对照自己
            // 的形状错，不是产品的（把两条流并起来读还会让 write 端填满时互相等死）。
            let outData = outPipe.fileHandleForReading.readDataToEndOfFile()
            let errData = errPipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            let text = String(data: outData, encoding: .utf8) ?? ""
            let notes = String(data: errData, encoding: .utf8) ?? ""
            XCTAssertEqual(process.terminationStatus, 0,
                           "\(flag) 的退出码不再等于\"这次测量跑过了\"——本轮只动文档：\(text.prefix(200)) | \(notes.prefix(200))")
            XCTAssertTrue(["granted", "unverifiable", "notDetermined"].contains(
                text.trimmingCharacters(in: .whitespacesAndNewlines)),
                "\(flag) 的 stdout 不是一个取值表里的词：stdout=\(text.prefix(200)) stderr=\(notes.prefix(200))")
        }
    }
}
