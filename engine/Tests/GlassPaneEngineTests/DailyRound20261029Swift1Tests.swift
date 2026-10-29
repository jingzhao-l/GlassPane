import XCTest
@testable import GlassPaneEngine

/// 每日任务 2026-10-29 · 修复泳道 2（Swift 引擎存储与 socket 归属）。
///
/// S2-1 `EvidenceModels.swift`（`JSONValue.encode`）：整数量级的号码被交给 `encode(Double)`，
/// 而 `JSONEncoder` 把 `1e16` 拼成 `1e+16`、`canonicalJson` 拼 `10000000000000000`。决策日志
/// 读取侧逐行比 `canonicalJson(entry) !== raw` ⇒ 那一行判 corrupt，哈希链从该行起不可复算。
/// 旧判据 `abs(value) < …e14` 又比 `CanonicalJSON` 里那道 cut 小了一个数量级——两份规则不是
/// 同一个数，所以这里钉的是"只有一个出口"，不是"两份规则刚好对齐"。参考答案全部**跑自本机
/// node**（`JSON.stringify`），不是手推的：这一族的失败形态恰好是"没人去问 node"。
///
/// S2-2 `SocketNameOwnership.swift`：`removeIfOurs` 用 `Bool` 把"名字不是我的"和"是我的但
/// `unlink()` 失败"压成同一个 false，errno 被丢，两个调用方再对 false 一律打印"名字已经不
/// 指着本实例 bind 的那个 socket"——那句在删不掉那一支里恰好是反的。这里用真 `bind()` + 真
/// 权限夹具（父目录 `chmod 0500` ⇒ `EACCES`；文件 `chflags uchg` ⇒ `EPERM`）把它量出来。
/// ⚠ 全部夹具都在本测试自己的临时目录里，不碰 `~/.glasspane`。
///
/// S2-3 `EvidenceStore.swift`：`maxAgeDays`/`setRetention` 在整个 `engine/Sources` 里零个调用者
/// （本文件那条接线测试就是这一句的闸门），于是每次写都跑的 `pruneExpiredIfNeeded()` 在生产恒
/// no-op，而 `retentionNotice` 那句 "older than N day(s)" 与模块头让读者以为年龄会到期。修法是
/// 发布事实（`stats()` 的 `ageRetention` 读数 + 没设年龄闸时的那句结论），不新增配置入口。
/// "aged entry must survive a disabled TTL" 已由 `EngineP5Batch3Tests` 量过，这里不重复。
final class DailyRound20261029Swift1Tests: XCTestCase {

    // MARK: - 夹具

    /// 参考答案来自真 node：与 `Qoder20261019CanonicalBytesTests` 同一个手法、同一个动机——
    /// "这一族的判据不该由任何人凭记忆拼"。本机没有 node 时这一条**跳过并说明原因**，
    /// 而不是把断言改写成"未观测"。
    private static func nodeBinary() throws -> String {
        for candidate in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
        where FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
        throw XCTSkip("no node binary on this host, so JSON.stringify has no reference answer")
    }

    /// `JSON.stringify(Number(<literal>))`——与台账里那条命令逐字同形。
    private func nodeSpelling(of literal: String) throws -> String {
        let node = try Self.nodeBinary()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = ["-e", "process.stdout.write(JSON.stringify(Number(\(literal))))"]
        let out = Pipe()
        process.standardOutput = out
        process.standardError = Pipe()
        try process.run()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0, "node refused \(literal)")
        return String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    }

    /// `JSON.stringify(<jsExpression>)`（整对象那一侧的参考答案）。
    private func nodeStringify(_ expression: String) throws -> String {
        let node = try Self.nodeBinary()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = ["-e", "process.stdout.write(JSON.stringify(\(expression)))"]
        let out = Pipe()
        process.standardOutput = out
        process.standardError = Pipe()
        try process.run()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0, "node refused \(expression)")
        return String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    }

    private func sourceText(_ relative: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(relative)
        guard let text = try? String(contentsOf: url, encoding: .utf8) else {
            throw XCTSkip("读不到 \(url.path)；这一条对照在没有该文件的环境里不作数")
        }
        return text
    }

    /// 真 `socket()` + 真 `bind()`：夹具形状来自系统调用，判据量的就是生产那一对数。
    private func bindListener(at path: String) throws -> Int32 {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw XCTSkip("socket() 失败：\(String(cString: strerror(errno)))") }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else {
            close(fd)
            throw XCTSkip("路径超出 sun_path：\(path)")
        }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in raw.copyBytes(from: bytes) }
        let bound = withUnsafePointer(to: &addr) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                Darwin.bind(fd, sockaddrPointer, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound == 0 else {
            let code = errno
            close(fd)
            XCTFail("bind(\(path)) 失败：errno \(code) \(String(cString: strerror(code)))")
            throw NSError(domain: "DailyRound20261029Swift1", code: Int(code))
        }
        return fd
    }

    /// 短路径的私有目录：`sun_path` 只有 104 字节，`/var/folders/…` 那种 XCTest 临时目录会超。
    /// 一律在 `/tmp` 下自建，**不**碰 `~/.glasspane`。
    private func makeShortPrivateDirectory(tag: String) throws -> String {
        let dir = "/tmp/gp29\(tag)-\(String(UUID().uuidString.prefix(8)))"
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        chmod(dir, 0o700)
        XCTAssertLessThan((dir + "/engine.sock").utf8.count, 104,
                          "socket 名字超出 sun_path，这一条测不到东西：\(dir)")
        return dir
    }

    // MARK: - S2-1：JSONValue 的号码拼写只有一个出口

    /// 这些字面量必须与 node 对账（本机有 node，实测在下面）。旧代码里 `1e16`/`1e17`/`1.78e18`
    /// 过不了那道小了一个数量级的 cut，被交给 `encode(Double)`，于是 `1e+16` 进了本该是
    /// `10000000000000000` 的那一行字节。
    /// REVERSE：把 `JSONValue.encode` 的号码那一支逐字改回
    /// `if value.rounded() == value, abs(value) < 9.007_199_254_740_992e14 { encode(Int(value)) } else { encode(value) }`
    /// ⇒ 本条在 `1e16` 上红（`{"v":1e+16}` ≠ `{"v":10000000000000000}`）。
    func testIntegralLedgerNumbersEncodeToExactlyWhatNodeSpellsThem() throws {
        let literals = [
            "1e15", "1e16", "1e17", "1.78e18",                 // 台账点名的那一组
            "9007199254740991", "9007199254740992",            // MAX_SAFE_INTEGER 与其本身
            "4611686018427387904", "12345678901234567890",     // 超出 Int64 精确性的整数量级
            "1e21", "1e22", "3.0", "0", "-1e16", "1000000000000000",
            "0.1", "0.00001", "1e-6", "1234.5678", "1.5e20",   // 非整数：固定记数法那一带（旧代码在 1e-5/1e-6 上也拼错过）
        ]
        var checked = 0
        for literal in literals {
            let fromNode = try nodeSpelling(of: literal)
            let raw = "{\"v\":\(literal)}"
            let decoded = try JSONDecoder().decode(JSONValue.self, from: Data(raw.utf8))
            let encoded = String(
                decoding: try EvidencePack.encoder.encode(decoded), as: UTF8.self
            )
            XCTAssertEqual(
                encoded, "{\"v\":\(fromNode)}",
                "revert: \(literal) 编码出来的字节不是 node 的那一串（链取的是 canonical 字节）"
            )
            // 载体换了，值不许换：重新解回来必须还是同一个 JSONValue。
            XCTAssertEqual(
                try JSONDecoder().decode(JSONValue.self, from: Data(encoded.utf8)), decoded,
                "revert: \(literal) 换了载体之后不再是同一个数"
            )
            // 出口内部也必须自洽：`canonicalJSONText` 与 `encode` 在这一类值上同串。
            let canonical = decoded.canonicalJSONText
            XCTAssertEqual(
                String(canonical.utf8.dropFirst("{\"v\":".utf8.count).dropLast()), fromNode,
                "revert: canonicalJSONText 与 node 分家了：\(literal)"
            )
            checked += 1
        }
        XCTAssertEqual(checked, literals.count, "每一个列出的字面量都真的对过账")
    }

    /// 两份阈值是同一个数——最硬的写法是**只有一份**。这条按文本钉：整数量级那道 cut 的字面量
    /// 只许出现在 `CanonicalJSON.swift` 里一处，`EvidenceModels.swift` 一个字都不许留。
    /// REVERSE：把旧那句 `abs(value) < 9.007_199_254_740_992e14` 逐字改回去 ⇒ 本条红
    /// （`EvidenceModels.swift` 里出现了 `9.007`），同时上面那条也红。
    func testOnlyOneFileStatesTheIntegralCutAndBothSidesAgreeAcrossIt() throws {
        let models = try sourceText("Sources/GlassPaneEngine/EvidenceModels.swift")
        let canonical = try sourceText("Sources/GlassPaneEngine/CanonicalJSON.swift")

        let cutFragments = ["9.007", "9.0e15", "9e15", "9.007_199_254_740_992"]
        for fragment in cutFragments {
            XCTAssertEqual(models.components(separatedBy: fragment).count - 1, 0,
                "revert: EvidenceModels 又自己写了一份数量级阈值（\(fragment)）——两份判据就会是两个数")
        }
        XCTAssertGreaterThanOrEqual(canonical.components(separatedBy: "9.0e15").count - 1, 1,
            "出口那边那道 cut 不见了：这条闸就变成了只看一个文件")

        // 行为那一半：跨过 `CanonicalJSON` 的 cut（2^53 = 9007199254740992）两侧，
        // `encode` 的字节必须与出口的字节逐字相同——不是"约等于"，是同一串。
        for literal in ["9007199254740988", "9007199254740990", "9007199254740992",
                        "9007199254740994", "9000000000000000", "9007199254740991"] {
            let decoded = try JSONDecoder().decode(JSONValue.self, from: Data("{\"v\":\(literal)}".utf8))
            let encoded = String(decoding: try EvidencePack.encoder.encode(decoded), as: UTF8.self)
            XCTAssertEqual(encoded, decoded.canonicalJSONText,
                "revert: cut 两侧 \(literal) 的两个出口又分成两串了")
        }
    }

    /// 非有限值：`JSON.stringify(NaN)` 是 `null`，`CanonicalJSON` 也回 `"null"`，而旧代码把它
    /// 交给 `encode(Double)` ——实测抛 `EncodingError`（"Unable to encode Double.nan directly in
    /// JSON"），于是一个带 NaN 的 payload 在 `validateInvariants` 里抛的是编码错。
    /// REVERSE：删掉 `guard value.isFinite` 那一行 ⇒ 本条红（抛错）。
    func testNonFinitePayloadNumbersSpellAsNullOnBothSides() throws {
        for (literal, expression) in [("NaN", "NaN"), ("Infinity", "Infinity"), ("-Infinity", "-Infinity")] {
            let fromNode = try nodeStringify(expression)
            XCTAssertEqual(fromNode, "null", "premise: node 把 \(literal) 拼成 null")
            for value in [Double.nan, Double.infinity, -Double.infinity] {
                let payload = JSONValue.object(["v": .number(value)])
                let encoded = String(
                    decoding: try EvidencePack.encoder.encode(payload), as: UTF8.self
                )
                XCTAssertEqual(encoded, "{\"v\":null}",
                    "revert: \(literal) 的 Codable 出口与 node 分家（拿到的是 \(encoded)）")
                XCTAssertEqual(payload.canonicalJSONText, "{\"v\":null}")
            }
        }
    }

    /// 载体到不了的那一支要**点名**，不许留成"没人测过的断言"：单位数负指数的拼写（`1e-7`、
    /// `1.2345e-8`）在 `Encodable` 里没有载体——`Double` 打 `1e-07`（补零）、`Decimal` 打
    /// `0.0000001`（固定），而 node 打 `1e-7`。钉三件事：①`canonicalJSONText`（链的口径）对
    /// 两支都与 node 逐字相同；②补零那一支的 `encode` 确实还差着，差多少写在明面上；
    /// ③两位数负指数那一支 `encode` 与出口同串——残差的范围是被量出来的，不是猜的。
    /// REVERSE：把 `canonicalJSONText` 改成走 `encode` 的输出 ⇒ ① 立刻红。
    func testTheCarriersResidueIsMeasuredAndTheOutletStillAnswersWhatNodeAnswers() throws {
        // 单位数负指数：Swift 补零 ⇒ 载体发不出 canonical 那一串。
        let padded = ["1e-7", "7e-7", "1.2345e-8", "5e-9", "1.5e-7"]
        // 两位数负指数：Swift 的 `e-10` 与 ECMAScript 同形 ⇒ 这一支本来就对得上。
        let aligned = ["2.5e-10", "1e-20", "1.2345e-12"]
        for literal in padded + aligned {
            let fromNode = try nodeSpelling(of: literal)
            let decoded = try JSONDecoder().decode(JSONValue.self, from: Data("{\"v\":\(literal)}".utf8))
            XCTAssertEqual(
                decoded.canonicalJSONText, "{\"v\":\(fromNode)}",
                "revert: 出口在 \(literal) 上不再等于 JSON.stringify——那链的口径就换了"
            )
        }
        for literal in padded {
            let decoded = try JSONDecoder().decode(JSONValue.self, from: Data("{\"v\":\(literal)}".utf8))
            let encoded = String(decoding: try EvidencePack.encoder.encode(decoded), as: UTF8.self)
            XCTAssertNotEqual(encoded, decoded.canonicalJSONText,
                "记录在案的残差被改掉了：\(literal) 的 Codable 载体居然能发出 canonical 那串——"
                + "那就该把这条用例改成等于，而不是让文件头那句还写着『发不出』：\(encoded)")
        }
        for literal in aligned {
            let decoded = try JSONDecoder().decode(JSONValue.self, from: Data("{\"v\":\(literal)}".utf8))
            let encoded = String(decoding: try EvidencePack.encoder.encode(decoded), as: UTF8.self)
            XCTAssertEqual(encoded, decoded.canonicalJSONText,
                "两位负指数那一支本来是对得上的（\(literal)）：改坏了就去读 `encode` 那三个分支")
        }
    }

    /// `canonicalJSONText` 走的是同一个 `CanonicalJSON.stringify`（键排序、布尔不落成 1、null
    /// 与嵌套都在），不是第二份实现。
    func testCanonicalJSONTextWalksTheWholeTreeThroughTheOneOutlet() throws {
        let payload = JSONValue.object([
            "b": .number(1e16),
            "a": .array([.bool(true), .bool(false), .null, .string("x\n"), .number(0.5)]),
        ])
        XCTAssertEqual(
            payload.canonicalJSONText,
            "{\"a\":[true,false,null,\"x\\n\",0.5],\"b\":10000000000000000}",
            "revert: 桥接把布尔落成了 1、或把键序/转义交给了另一个 writer"
        )
    }

    // MARK: - S2-2：unlink 失败不是"名字不属于本实例"

    /// 真 socket bind 之后把**父目录** `chmod 0500`：inode 还是本实例的，`unlink()` 回 `EACCES`
    /// (13)。旧签名把这一支折成 `false`，调用方于是打印"名字已经不指着本实例 bind 的那个
    /// socket"——实测恰好相反，而且 errno 被丢。
    /// REVERSE：把 `removeIfOurs` 改回 `Bool`（`return unlink(path) == 0`）⇒ 本条编译/断言红。
    func testUnlinkFailureDueToReadOnlyParentIsReportedWithItsErrno() throws {
        let dir = try makeShortPrivateDirectory(tag: "own")
        let path = dir + "/engine.sock"
        let fd = try bindListener(at: path)
        defer {
            chmod(dir, 0o700)          // 收尾必须先解掉夹具，不然临时目录删不掉
            close(fd)
            try? FileManager.default.removeItem(atPath: dir)
        }

        let recorded = try XCTUnwrap(SocketNameOwnership.currentInode(atPath: path),
                                    "lstat 读不出刚 bind 出来的这个名字")
        XCTAssertEqual(chmod(dir, 0o500), 0, "夹具没装上：父目录 chmod 0500 失败")

        let outcome = SocketNameOwnership.removeIfOurs(recorded: recorded, atPath: path)
        XCTAssertEqual(outcome, .unlinkFailed(errno: Int32(EACCES)),
            "revert: 名字是我的、目录删不掉，这一支被折进了『不是我的』或别的什么态里")
        XCTAssertTrue(FileManager.default.fileExists(atPath: path),
                      "判据说过不去就一个字节都不动，可名字却没了")

        let line = outcome.line(for: path)
        XCTAssertTrue(line.contains("13"), "那句必须带上 errno 数字：\(line)")
        XCTAssertTrue(line.contains(String(cString: strerror(EACCES))),
                      "那句必须带上 strerror：\(line)")
        XCTAssertTrue(line.contains("the name IS the socket this instance bound"),
                      "那句必须说清『是我的』：\(line)")
        XCTAssertFalse(line.contains("does not point at the socket this instance bound"),
            "revert: 删不掉的现场又回到了『名字不是我的』那句——实测恰好相反：\(line)")
    }

    /// 同一个现场的另一种造法：文件带 `uchg`（父目录仍可写）⇒ `unlink()` 回 `EPERM` (1)。
    /// 两支各测一个 errno，是为了证明 errno 是**读数**而不是硬编码的文案。
    func testUnlinkFailureOnAnImmutableFlagReportsEPERMNotNotOurs() throws {
        let dir = try makeShortPrivateDirectory(tag: "flag")
        let path = dir + "/engine.sock"
        let fd = try bindListener(at: path)
        defer {
            chflags(path, 0)
            close(fd)
            try? FileManager.default.removeItem(atPath: dir)
        }

        let recorded = try XCTUnwrap(SocketNameOwnership.currentInode(atPath: path))
        XCTAssertEqual(chflags(path, UInt32(UF_IMMUTABLE)), 0, "夹具没装上：chflags uchg 失败")

        let outcome = SocketNameOwnership.removeIfOurs(recorded: recorded, atPath: path)
        XCTAssertEqual(outcome, .unlinkFailed(errno: Int32(EPERM)),
            "revert: 文件带不可变位时又被压成同一个 false 了")
        let line = outcome.line(for: path)
        XCTAssertTrue(line.contains("1"), "那句要带 errno 1：\(line)")
        XCTAssertTrue(line.contains(String(cString: strerror(EPERM))), "那句要带 strerror：\(line)")
        chflags(path, 0)   // 解掉夹具之后必须真删得掉——证明这一支差的只是那一位
        XCTAssertEqual(SocketNameOwnership.removeIfOurs(recorded: recorded, atPath: path), .removed)
        XCTAssertFalse(FileManager.default.fileExists(atPath: path))
    }

    /// 对照臂：名字确实被继任者拿走时，回的是 `.notOurs`，且那句话里**不许**出现 errno
    /// （那是另一件事：判据在起作用，什么都没测到失败）。三态不许再被压成两态。
    /// 现场就是 `--force-socket` 那一条：继任先清掉这个名字再 bind 出自己的 inode，所以
    /// 中间那次 `unlink` 是夹具，不是被测的判据。
    func testNotOursStaysItsOwnStateAndCarriesNoErrno() throws {
        let dir = try makeShortPrivateDirectory(tag: "ours")
        let path = dir + "/engine.sock"
        let first = try bindListener(at: path)
        let recorded = try XCTUnwrap(SocketNameOwnership.currentInode(atPath: path))
        XCTAssertEqual(unlink(path), 0, "premise: 继任接管之前这个名字得先空出来")
        let second = try bindListener(at: path)   // 同名继任：`--force-socket` 的形状
        XCTAssertNotEqual(
            try XCTUnwrap(SocketNameOwnership.currentInode(atPath: path)), recorded,
            "premise: 继任的 socket 是另一个 inode，否则这一臂测不到归属"
        )
        defer {
            close(first); close(second)
            try? FileManager.default.removeItem(atPath: dir)
        }

        let outcome = SocketNameOwnership.removeIfOurs(recorded: recorded, atPath: path)
        XCTAssertEqual(outcome, .notOurs)
        XCTAssertTrue(FileManager.default.fileExists(atPath: path), "继任正在监听，不许被删")
        XCTAssertFalse(outcome.line(for: path).contains("errno"),
                       "『不是我的』那一支没有失败的 unlink 可报：\(outcome.line(for: path))")
        XCTAssertNotEqual(outcome, .unlinkFailed(errno: Int32(EACCES)),
                          "三态被压回去了：notOurs 与 unlinkFailed 必须是两个不同的值")
        XCTAssertEqual(SocketNameOwnership.removeIfOurs(recorded: nil, atPath: path), .notOurs)
        XCTAssertTrue(FileManager.default.fileExists(atPath: path))
    }

    /// 生产接线：三个收尾位点都按三态出文（文案来自 `SocketNameRemoval.line(for:)` 那一份，
    /// 不是各自重写的一句），且那句被压成 false 时的旧文案一个字都不留。
    /// REVERSE：把 `SocketServer.swift`（或 `main.swift`）改回 `if removeIfOurs(...) { … } else
    /// { "left … not the socket this instance bound" }` ⇒ 本条红。
    func testEveryTeardownCallerPublishesAllThreeStatesItself() throws {
        let engine = try sourceText("Sources/GlassPaneEngine/SocketServer.swift")
        let probe = try sourceText("Sources/GlassPaneEngine/ProbeSocketServer.swift")
        let daemon = try sourceText("Sources/glasspaned/main.swift")
        // 两处 EngineLog 的收尾还得分级：删不掉是错误，不是 info。
        for (name, text) in [("SocketServer.swift", engine),
                             ("ProbeSocketServer.swift", probe)] {
            XCTAssertTrue(text.contains(".unlinkFailed"),
                           "revert: \(name) 又不区分『是我的但删不掉』那一态了")
            XCTAssertTrue(text.contains("line(for:"),
                           "revert: \(name) 自己重写了一句，而不是用三态那句（文案会漂移）")
        }
        XCTAssertTrue(daemon.contains("line(for:"),
                      "revert: sigwait 收尾没有按三态出文")
        XCTAssertTrue(daemon.contains(".isRemoved"),
                      "revert: sigwait 收尾又把三态折成一个布尔了")
        // 那句一次都没测过的断言（实测恰好相反）必须从生产文案里消失。
        XCTAssertFalse(daemon.contains("the name is not the socket this instance bound"),
                       "revert: sigwait 收尾又回到把 false 读成『名字不是我的』")
        XCTAssertFalse(engine.contains("the name no longer points at the socket this instance bound"),
                       "revert: run() 收尾又把两态压成一句了")
        // 判据本体不能被换成 `Bool`：三态是它的返回类型。
        let ownership = try sourceText("Sources/GlassPaneEngine/SocketNameOwnership.swift")
        XCTAssertTrue(ownership.contains("-> SocketNameRemoval"),
                      "revert: removeIfOurs 又回 Bool 了，两件事重新压成一件")
        XCTAssertTrue(ownership.contains("strerror"),
                      "revert: errno 又只是一个数，没带它自己那句解释")
    }

    // MARK: - S2-3：年龄留存的事实要有读者

    /// 接线测试（做的那一半是"诚实读数"）：`engine/Sources` 里除 `EvidenceStore.swift` 之外
    /// 确实没有 `maxAgeDays:` / `setRetention(` 的调用点 ⇒ 那么 `pruneExpiredIfNeeded()` 在生产
    /// 恒 no-op ⇒ `stats()` 这一面必须自己把这件事说出来。
    /// 今天就能红：修法落地之前，`func stats(` 里一个 `ageRetention` 都没有。
    /// REVERSE：把 `stats()` 里那句 `ageRetention:` 撤掉 ⇒ 本条红。
    func testAgeGateHasNoCallerAnywhereSoTheStatsSurfaceIsTheOneThatTells() throws {
        let store = try sourceText("Sources/GlassPaneEngine/EvidenceStore.swift")
        let directory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources")
        var callersOutsideTheStore = 0
        var scanned = 0
        guard let enumerator = FileManager.default.enumerator(
            at: directory, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]
        ) else {
            throw XCTSkip("读不到 engine/Sources；这条接线闸在没有该目录的环境里不作数")
        }
        for case let file as URL in enumerator where file.pathExtension == "swift" {
            let isTheStore = file.lastPathComponent == "EvidenceStore.swift"
            guard let text = try? String(contentsOf: file, encoding: .utf8) else { continue }
            scanned += 1
            for line in text.split(separator: "\n") {
                let trimmed = line.trimmingCharacters(in: CharacterSet.whitespaces)
                // 声明与折算都在 EvidenceStore.swift 里，本来就不算"调用点"；注释也不算。
                if trimmed.hasPrefix("//") || isTheStore { continue }
                if trimmed.contains("setRetention(") || trimmed.contains("maxAgeDays:") {
                    callersOutsideTheStore += 1
                }
            }
        }
        XCTAssertGreaterThan(scanned, 10, "源码扫描没读到东西：这条闸在看一个空目录")
        XCTAssertEqual(callersOutsideTheStore, 0,
            "台账那条『零个调用者』不再成立：有 \(callersOutsideTheStore) 处接线了，"
            + "那时这条用例与 `ageRetention` 那句都得改写——别让它替一个已经变了的事实背书")

        // 于是诚实读数必须在 `stats()` 那一面（引擎答得出来的那一面）。
        guard let statsBody = store.range(of: "func stats(") else {
            XCTFail("EvidenceStore.swift 里找不到 stats()：这条闸的对象消失了")
            return
        }
        let afterStats = store[statsBody.lowerBound...].prefix(4_000)
        XCTAssertTrue(afterStats.contains("ageRetention:"),
            "revert: stats() 不发布年龄闸的读数，而 `maxAgeDays` 一个调用者都没有——"
            + "『older than N day(s)』就又被读成『年龄会到期』了")
        XCTAssertTrue(afterStats.contains("ageRetentionReading"),
            "revert: 读数不是从 `maxAgeDays` 折算来的，而是一句写死的字符串")
    }

    /// 没设年龄闸时（= 生产的每一条档案柜），`stats()` 的回答必须点名唯一那条按年龄的路。
    func testStatsAnswersThatTheDaemonEnforcesNoAgeExpiry() throws {
        let dir = try makeShortPrivateDirectory(tag: "stats")
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let store = EvidenceStore(directory: dir)
        XCTAssertNil(store.maxAgeDays, "premise: 默认构造不带年龄闸")
        XCTAssertEqual(store.stats().ageRetention, EvidenceStore.ageRetentionNotEnforced)
        XCTAssertTrue(store.stats().ageRetention.contains("not enforced by the daemon"))
        XCTAssertTrue(store.stats().ageRetention.contains("--prune-evidence --older-than <days>"),
            "读数要把唯一那条按年龄的路点名出来，否则读者只能猜：\(store.stats().ageRetention)")
        // 读不了的归档也带读数：那一面回答的是两件事，少一件就是少一件。
        let unreadable = EvidenceArchiveStats(count: 0, totalBytes: 0, listFailure: "x")
        XCTAssertEqual(unreadable.ageRetention, EvidenceStore.ageRetentionNotEnforced)
    }

    /// 设了闸（今天只有测试会设）不许被写成"daemon 不执行"——那句会变成另一种假。
    func testAgeGateSetInProcessIsNamedAsTheCallersOwnNotTheDaemons() throws {
        let dir = try makeShortPrivateDirectory(tag: "gated")
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let store = EvidenceStore(directory: dir, maxAgeDays: 7)
        let reading = store.stats().ageRetention
        XCTAssertTrue(reading.contains("7 day(s)"), reading)
        XCTAssertTrue(reading.contains("no daemon flag"), reading)
        XCTAssertFalse(reading == EvidenceStore.ageRetentionNotEnforced,
                       "设了闸还回『没执行』，这条读数就变成假的")
        store.setRetention(maxAgeDays: nil)
        XCTAssertEqual(store.stats().ageRetention, EvidenceStore.ageRetentionNotEnforced)
    }

    /// `retentionNotice` 的形状：没有年龄闸时不许留下"N day(s)"式的到期承诺，且必须点名那是
    /// 唯一一条年龄路。设了闸那一支一个字不改（它说的是自己那半，`EvidenceRetentionNoticeTests`
    /// 钉的就是那一支的归属）。
    /// REVERSE：把 `ageClause` 那三元改回恒 `""` ⇒ 第一条红。
    func testRetentionNoticeMakesNoAgeExpiryPromiseWithoutAnAgeGate() throws {
        let notice = EvidenceStore.retentionNotice(
            capRemoved: 3, ttlRemoved: 0, maxFiles: 500, maxAgeDays: nil, directory: "/tmp/e"
        ) ?? ""
        XCTAssertFalse(notice.isEmpty, "删了 3 条却没有结论")
        XCTAssertTrue(notice.contains(EvidenceStore.ageRetentionNotEnforced),
            "revert: 没有年龄闸的那一句还留着『年龄会到期』的读法：\(notice)")
        let promise = try NSRegularExpression(pattern: "[0-9]+ day\\(?s\\)?")
        XCTAssertEqual(
            promise.numberOfMatches(in: notice, range: NSRange(location: 0, length: notice.utf16.count)), 0,
            "revert: 按条数删的那一句里又冒出了『N day(s)』式到期承诺：\(notice)"
        )
        // 设了闸那一支保持原样（不追加、不改口径）。
        let gated = EvidenceStore.retentionNotice(
            capRemoved: 3, ttlRemoved: 0, maxFiles: 500, maxAgeDays: 30, directory: "/tmp/e"
        ) ?? ""
        XCTAssertFalse(gated.contains(EvidenceStore.ageRetentionNotEnforced),
            "设了闸却宣布『不执行年龄到期』是另一句假话：\(gated)")
        XCTAssertTrue(gated.contains("500"), gated)
    }

    /// 模块头不再教读者"档案会按年龄到期"——这句按文本钉，因为它正是这条缺陷的载体。
    /// REVERSE：把文件头那段改回只讲 `{count, totalBytes}` ⇒ 本条红。
    func testModuleHeaderStatesTheAgeFactItself() throws {
        let store = try sourceText("Sources/GlassPaneEngine/EvidenceStore.swift")
        XCTAssertTrue(store.contains("`stats()` exposes `{count, totalBytes, ageRetention}`"),
                      "revert: 模块头还写着年龄会到期那一套")
        XCTAssertTrue(store.contains("Age is **not** one of the write-time passes"),
            "revert: 模块头没有把『生产不按年龄删』这一条写在它自己那一节里")
    }
}
