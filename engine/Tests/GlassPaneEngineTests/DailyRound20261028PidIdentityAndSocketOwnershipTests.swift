import XCTest
import AppKit
import ApplicationServices
@testable import GlassPaneEngine

/// pid 复用与 socket 名字归属（每日任务 2026-10-28，两条 P0）。
///
/// 缺陷一（`AXChannel.isProcessAlive()`）：从前是 `kill(attached.pid, 0) == 0 || errno != ESRCH`，
/// 它回答的是"有没有一个进程占着这个号"。号被回收复用之后它答"有"，而那个进程与附着对象
/// 毫无关系：`EngineCore` 的两处 CrashSignal 都读到"活着"，AX 继续可读、合成事件继续可投、
/// `captureWindow()` 比的是新住户的窗口，而档案按原来的 bundleId/appName 归档。
///
/// 缺陷二（收尾 unlink）：`SocketServer.run()/cleanup()`、`ProbeSocketServer.stop()` 与
/// `glasspaned` 的 sigwait waiter 都按**路径字符串**删文件。`--force-socket` 的成文语义是
/// "旧实例继续活着，但失去这个 socket 名"，于是前任与继任握着同一个字符串；前任后来的收尾
/// 删掉的是继任正在监听的那个。`SocketServer.swift` 文件头那句 "never unlink a socket file
/// this instance did not create" 一直在，撑着它的却只有一个"我打算删"的布尔。
///
/// 两条都能用真东西测：身份判据有真 `NSRunningApplication` 可比，socket 归属有真文件可比
/// （夹具形状来自真系统调用，不是桩编出来的）。
final class DailyRound20261028PidIdentityAndSocketOwnershipTests: XCTestCase {

    // MARK: - W2：身份判据（纯函数那一半）

    /// 判据的真值表。**★ 对照**：完全相同的一次读数必须是 true，否则整条判据就是一句
    /// "永远拒绝"，那等于把修复做成删除功能。
    func testIdentityMatchesTruthTable() {
        let stamp: UInt64 = 1_762_000_000_123_456
        // 同一个 app、同一个进程 ⇒ 还是它。
        XCTAssertTrue(AXChannel.identityMatches(
            recordedBundleId: "com.example.app", recordedStartMicros: stamp,
            current: ProcessIdentity(bundleId: "com.example.app", startMicros: stamp)
        ))
        // bundle 换了 ⇒ 不是它（哪怕起始时刻读到的居然是同一个数）。
        XCTAssertFalse(AXChannel.identityMatches(
            recordedBundleId: "com.example.app", recordedStartMicros: stamp,
            current: ProcessIdentity(bundleId: "com.other.app", startMicros: stamp)
        ))
        // 同 bundle、不同起始时刻 ⇒ 同一个 app 的**另一个进程**（重启过一次），句柄已经过期。
        XCTAssertFalse(AXChannel.identityMatches(
            recordedBundleId: "com.example.app", recordedStartMicros: stamp,
            current: ProcessIdentity(bundleId: "com.example.app", startMicros: stamp + 1)
        ))
        // 那个号上已经没有"运行中的 app" ⇒ false，而不是"没读数所以放过"。
        XCTAssertFalse(AXChannel.identityMatches(
            recordedBundleId: "com.example.app", recordedStartMicros: stamp, current: nil
        ))
        // 只记下过 bundleId（当时 `proc_pidinfo` 没答）⇒ 就按这一条判，且缺的那半不许放过。
        XCTAssertTrue(AXChannel.identityMatches(
            recordedBundleId: "com.example.app", recordedStartMicros: nil,
            current: ProcessIdentity(bundleId: "com.example.app", startMicros: nil)
        ))
        XCTAssertFalse(AXChannel.identityMatches(
            recordedBundleId: "com.example.app", recordedStartMicros: nil,
            current: ProcessIdentity(bundleId: nil, startMicros: stamp)
        ))
        // 只记下过起始时刻（无 bundle 的进程）⇒ 现在读不到时刻就是"不等"：附着那一次读得到。
        XCTAssertFalse(AXChannel.identityMatches(
            recordedBundleId: nil, recordedStartMicros: stamp,
            current: ProcessIdentity(bundleId: nil, startMicros: nil)
        ))
        // 两半都没记下 ⇒ 无从证明。这条形状在附着处就被拒了（见下面那条运行时用例），
        // 但判据自己也不许把它读成"相同"。
        XCTAssertFalse(AXChannel.identityMatches(
            recordedBundleId: nil, recordedStartMicros: nil,
            current: ProcessIdentity(bundleId: nil, startMicros: nil)
        ))
    }

    /// 真实系统读数（不是桩）：这台机器上一个真在跑的 app，身份必须**读得出 bundleId 与
    /// 起始时刻**，且两次读一致。读不出来（无 GUI 会话/没有 app 在跑）就按未观测跳过，
    /// 不许让这条用例由桩代答。
    func testRealProcessIdentityIsReadableAndStable() throws {
        guard let running = NSWorkspace.shared.runningApplications.first(where: {
            $0.bundleIdentifier != nil && $0.processIdentifier > 1
        }) else {
            throw XCTSkip("这台机器上此刻没有一个带 bundleIdentifier 的运行中 app，身份读数无法实测；补上它：在桌面会话里跑本套件")
        }
        let pid = running.processIdentifier
        let first = try XCTUnwrap(AXChannel.readProcessIdentity(pid),
                                 "真 app 的身份读不出来：pid \(pid)")
        XCTAssertEqual(first.bundleId, running.bundleIdentifier, "bundleId 必须是同一个来源的读数")
        let stamp = try XCTUnwrap(first.startMicros, "proc_pidinfo 没答出起始时刻")
        XCTAssertGreaterThan(stamp, 0, "起始时刻是一次真实读数，不是 0 这个缺省")
        XCTAssertEqual(AXChannel.readProcessIdentity(pid), first, "两次读同一份身份必须相同（否则判据在抖）")
        // pid 1 是 launchd：它的号永远不换人，但**不是**附着对象——用一个不可能的
        // recorded 值验证"同 pid 不同身份"确实判 false。
        XCTAssertFalse(AXChannel.identityMatches(
            recordedBundleId: "com.example.definitely-not-here", recordedStartMicros: stamp,
            current: AXChannel.readProcessIdentity(pid)
        ))
    }

    /// 附着处的那一问：身份两半都记不到 ⇒ 不附着。判据抽成纯函数是因为 `bundleId` 来自
    /// 真的 `NSRunningApplication`（测试造不出一个 bundleId 为 nil 的真 app）；接线由文本钉，
    /// 判据由运行时回答——两边都有，缺一边就是"跑得到的判据 + 没人接的线"。
    func testAttachRefusesWhenIdentityCannotBeRecorded() throws {
        XCTAssertFalse(AXChannel.identityIsRecordable(bundleId: nil, startMicros: nil),
                       "两半都记不到时必须拒附着")
        XCTAssertTrue(AXChannel.identityIsRecordable(bundleId: "com.example.app", startMicros: nil))
        XCTAssertTrue(AXChannel.identityIsRecordable(bundleId: nil, startMicros: 1_762_000_000_000_000))
        // 真读数那一半：这台机器上真在跑的 app 一定记得到，否则下面所有用例都是空的。
        let (pid, bundleId, stamp) = try liveAppIdentity()
        XCTAssertTrue(AXChannel.identityIsRecordable(bundleId: bundleId, startMicros: stamp))
        let channel = AXChannel()
        channel.startStampReader = { _ in nil }
        let attached = try attachIgnoringThePermissionSeat(channel, pid: pid)
        XCTAssertNotNil(attached?.bundleId, "起始时刻读不到时，bundleId 那一条必须撑起附着")

        let source = try sourceText("Sources/GlassPaneEngine/AXChannel.swift")
        XCTAssertTrue(
            source.contains("guard AXChannel.identityIsRecordable(bundleId: app.bundleId, startMicros: startMicros) else {"),
            "附着不再问这一问了：那条拒绝分支又变成没人接的判据"
        )
    }

    /// 附着不抛错时把结果拿出来（`attach` 在无席位的机器上会抛 `axUnavailable`，那不是
    /// 本条的对象，所以这里只把 `appNotFound` 当成失败）。
    private func attachIgnoringThePermissionSeat(_ channel: AXChannel, pid: pid_t) throws -> AttachedApp? {
        do {
            return try channel.attach(bundleId: nil, pid: pid)
        } catch let error as ChannelError {
            if case .appNotFound = error {
                XCTFail("只缺起始时刻、bundleId 还在时不许拒附着")
            }
            return nil
        }
    }

    /// `isProcessAlive()` 现在是身份问题，不是存在性问题：注入"号上换了人"的读数，它必须
    /// 报 false。**对照**：注入同一份身份时必须报 true——没有这一支，上一支可以由"恒返回
    /// false"来满足。
    func testIsProcessAliveFollowsIdentityNotExistence() throws {
        let channel = AXChannel()
        XCTAssertFalse(channel.isProcessAlive(), "没附着过时不许凭空报活")

        let (pid, bundleId, stamp) = try liveAppIdentity()
        channel.attached = AttachedApp(pid: pid, bundleId: bundleId, appName: "unit-test-fixture")
        channel.attachedStartMicros = stamp
        XCTAssertTrue(channel.isProcessAlive(), "premise：身份与真读数一致时必须报活")

        // 同一个号上换了别的 app：报"没活着"。
        channel.identityReader = { _ in ProcessIdentity(bundleId: "com.somebody.else", startMicros: stamp) }
        XCTAssertFalse(channel.isProcessAlive(), "pid 被复用给别的 app 时报活，就是本轮那条缺陷")
        // 同一个号、同一个 bundle、换了起始时刻（重启过）：也报"没活着"。
        channel.identityReader = { _ in ProcessIdentity(bundleId: bundleId, startMicros: stamp + 7) }
        XCTAssertFalse(channel.isProcessAlive(), "同 bundle 的另一个进程不是附着对象")
        // ★ 对照：读数与附着时一致 ⇒ 报活。
        channel.identityReader = { _ in ProcessIdentity(bundleId: bundleId, startMicros: stamp) }
        XCTAssertTrue(channel.isProcessAlive())
        // 号上已经没有 app ⇒ 报"没活着"，而不是"读不到就放过"。
        channel.identityReader = { _ in nil }
        XCTAssertFalse(channel.isProcessAlive())
        // 只记下过 bundleId 的附着（当时 `proc_pidinfo` 没答）：仍认得出复用。
        channel.attachedStartMicros = nil
        channel.identityReader = { _ in ProcessIdentity(bundleId: "com.somebody.else", startMicros: stamp) }
        XCTAssertFalse(channel.isProcessAlive())
        channel.identityReader = { _ in ProcessIdentity(bundleId: bundleId, startMicros: nil) }
        XCTAssertTrue(channel.isProcessAlive(), "只剩 bundleId 这一条时，它就是判据")
    }

    /// 动手路径必须问身份（不然"复用之后仍在驱动别人"只被 `isProcessAlive` 那一个读数
    /// 管着，而 act 走的是 `requireAppElement()`）。
    func testChannelOperationsRefuseAReusedPid() throws {
        let channel = AXChannel()
        let (pid, bundleId, stamp) = try liveAppIdentity()
        channel.attached = AttachedApp(pid: pid, bundleId: bundleId, appName: "unit-test-fixture")
        channel.attachedStartMicros = stamp
        channel.appElement = AXUIElementCreateApplication(pid)
        channel.identityReader = { _ in ProcessIdentity(bundleId: "com.somebody.else", startMicros: stamp) }
        XCTAssertThrowsError(try channel.ping(), "身份不符时 ping 必须拒") { error in
            XCTAssertEqual(error as? ChannelError, .appNotFound,
                           "拒的是既有的 appNotFound，不是新造一个线上代号")
        }
        // ★ 对照：身份一致时不许拒在判据上（此后能不能读 AX 取决于本机席位，不是这条用例的对象）。
        channel.identityReader = { _ in ProcessIdentity(bundleId: bundleId, startMicros: stamp) }
        do {
            _ = try channel.ping()
        } catch let error as ChannelError {
            if case .appNotFound = error {
                XCTFail("身份一致却被身份判据拒了：判据在抖")
            }
        } catch {
            // 权限/超时一类的其它拒因：与本轮这条缺陷无关，放过。
        }
    }

    // MARK: - W3：socket 名字的归属（真文件、真 inode）

    /// 判据本体：bind 成功后立刻记的 inode 与名字此刻的 inode 必须是同一个（这一条同时
    /// 是本判据的前提闸——`fstat(fd)` 在 macOS 上回的是 VNONCE 的 `st_dev = -1`，与路径的
    /// `lstat` 不同，所以记账走名字；本轮的测试先把这件事量红了，才改成现在这一版）。
    /// REVERSE：把 `mayRemove` 改成恒 true → 复用那两条红；改成恒 false → 下面第一支红。
    func testInodeOwnershipFollowsTheRealFiles() throws {
        let dir = try makePrivateDirectory()
        let path = dir + "/engine.sock"
        let first = try bindListener(at: path)
        defer { close(first); try? FileManager.default.removeItem(atPath: path) }

        let recorded = try XCTUnwrap(SocketNameOwnership.currentInode(atPath: path),
                                    "lstat 读不出刚 bind 出来的这个名字")
        XCTAssertNotEqual(recorded.device, dev_t(-1),
                          "名字上的读数该是真实卷（`fstat` 那种 VNONCE 的 -1 不能用来认名字）")
        XCTAssertGreaterThan(recorded.inode, 0, "inode 必须是一次真读数")
        XCTAssertTrue(SocketNameOwnership.mayRemove(recorded: recorded, atPath: path))
        XCTAssertTrue(SocketNameOwnership.removeIfOurs(recorded: recorded, atPath: path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: path), "删的是自己那一个")

        // 继任者 bind 同一个名字（`--force-socket` 的形状）：前任手里的凭证与名字现在的
        // inode 不再是同一个东西。
        let second = try bindListener(at: path)
        let secondInode = try XCTUnwrap(SocketNameOwnership.currentInode(atPath: path))
        XCTAssertNotEqual(secondInode, recorded, "premise：继任者的 socket 是另一个 inode")
        XCTAssertFalse(SocketNameOwnership.mayRemove(recorded: recorded, atPath: path),
                       "名字已经不是前任 bind 的那个，它就不许删")
        // ★ 关键那一支：前任收尾，删完名字必须还在（继任还在听）。
        XCTAssertFalse(SocketNameOwnership.removeIfOurs(recorded: recorded, atPath: path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: path),
                      "前任把继任正在监听的 socket 删掉了——这就是本轮修的那件事")
        // 继任自己删得掉。
        XCTAssertTrue(SocketNameOwnership.removeIfOurs(recorded: secondInode, atPath: path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: path))
        close(second)

        // 没记到凭证 ⇒ 一个字都不删。
        let third = try bindListener(at: path)
        XCTAssertFalse(SocketNameOwnership.removeIfOurs(recorded: nil, atPath: path),
                       "没记到 inode 就删，等于回到按名字删的旧行为")
        XCTAssertTrue(FileManager.default.fileExists(atPath: path))
        close(third)
    }

    /// 名字换成一个普通文件（有人占了这个名字）⇒ 判据也不许删：`removeIfOurs` 只认 inode。
    func testOwnershipDoesNotDeleteAForeignRegularFile() throws {
        let dir = try makePrivateDirectory()
        let path = dir + "/engine.sock"
        try Data("not a socket".utf8).write(to: URL(fileURLWithPath: path))
        let listener = try bindListener(at: dir + "/real.sock")
        let recorded = try XCTUnwrap(SocketNameOwnership.currentInode(atPath: dir + "/real.sock"))
        XCTAssertFalse(SocketNameOwnership.removeIfOurs(recorded: recorded, atPath: path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: path), "别人的普通文件一个字节都不动")
        close(listener)
    }

    /// 生产接线：三个收尾位点都必须走 `SocketNameOwnership.removeIfOurs`，且 bind 成功之后
    /// 真的记下 inode。这一半按文本钉——`SocketServer.run()` 要一个活 Dispatcher 与真核心，
    /// 单元测试里跑不出"两个实例抢同一个名字"。
    /// REVERSE：把 `cleanup()` 里的 `removeIfOurs` 换回 `unlink(socketPath)` → 第一条红。
    func testTeardownPathsAllRouteThroughTheOwnershipCheck() throws {
        let engine = try sourceText("Sources/GlassPaneEngine/SocketServer.swift")
        let probe = try sourceText("Sources/GlassPaneEngine/ProbeSocketServer.swift")
        let daemon = try sourceText("Sources/glasspaned/main.swift")

        XCTAssertEqual(engine.components(separatedBy: "SocketNameOwnership.removeIfOurs").count - 1, 4,
                       "engine socket 该有四处收尾（run / cleanup / chmod 失败 / listen 失败）都认 inode")
        XCTAssertEqual(engine.components(separatedBy: "boundInode = SocketNameOwnership.currentInode(atPath: socketPath)").count - 1, 1,
                       "bind 成功之后没按名字记 inode，那四处判据拿的都是 nil")
        XCTAssertEqual(probe.components(separatedBy: "SocketNameOwnership.removeIfOurs").count - 1, 3,
                       "探针 socket 该有三处（stop / chmod 失败 / listen 失败）都认 inode")
        XCTAssertTrue(probe.contains("boundInode = inode"),
                      "探针 bind 之后没记 inode")
        XCTAssertTrue(daemon.contains("SocketNameOwnership.removeIfOurs(recorded: entry.inode, atPath: entry.path)"),
                      "sigwait 收尾又回到按名字删了")
        XCTAssertTrue(daemon.contains("SocketNameOwnership.currentInode(atPath: path)"),
                      "收尾登记表没记 inode，判据就是空转")
        // bind 之前那两处 unlink 是对的（`--force-socket` 的接管语义与陈旧 socket 清理），
        // 但它们必须先过 `nameIsClearableSocketName`——这一条钉的是"不许删非 socket 的名字"。
        XCTAssertTrue(engine.contains("guard DaemonProbe.nameIsClearableSocketName(socketPath) else"),
                      "接管那一支又不看名字形状了：那是另一条已修的缺陷")
    }

    /// 0600 从 bind 那一刻成立，不是 chmod 之后才成立（本轮加宽中间窗口时被
    /// `ReviewLifecycleTests` 量到的那条真实竞态的判据）。两支都要有：只量"收紧后是
    /// 0600"而不同样量"不设防时它不是 0600"，这条用例可以由一台 umask 本来就严的机器
    /// 空过，那样 `SocketBindGuard` 消失了它也不会红。
    func testSocketNameIsCreatedPrivateNotChmoddedIntoPrivacy() throws {
        let dir = try makePrivateDirectory()
        let guardlessUmask = umask(0o022)
        umask(guardlessUmask)
        XCTAssertEqual(guardlessUmask & 0o022, 0o022, "本机的 umask 不该严到让对照无法产生：\(Int(guardlessUmask))")

        // 不设防的一支：名字出现时是本机 umask 决定的那个位（0755 on this host）。
        let plain = dir + "/plain.sock"
        let plainFD = try bindListener(at: plain, usesBindGuard: false)
        defer { close(plainFD); try? FileManager.default.removeItem(atPath: plain) }
        var plainInfo = stat()
        XCTAssertEqual(lstat(plain, &plainInfo), 0)
        XCTAssertNotEqual(Int(plainInfo.st_mode & 0o777), 0o600,
                          "不设防时已经是 0600，那这一台的 umask 让对照失效，本条要改判据而不是空过")

        // 设防的一支：bind 成功返回时名字就已经是 0600，没有任何 chmod 参与。
        let guarded = dir + "/guarded.sock"
        let guardedFD = try bindListener(at: guarded, usesBindGuard: true)
        defer { close(guardedFD); try? FileManager.default.removeItem(atPath: guarded) }
        var guardedInfo = stat()
        XCTAssertEqual(lstat(guarded, &guardedInfo), 0)
        XCTAssertEqual(Int(guardedInfo.st_mode & 0o777), 0o600,
                       "名字出现的瞬间就该是 0600（`SocketBindGuard`），chmod 只是复验")
    }

    // MARK: - helpers（真系统调用，不用桩）

    /// 身份读数取自**真在跑的 app**（不是编造的常量）：pid、bundleId、`proc_pidinfo` 的
    /// 起始时刻。这三个数一旦是假的，上面的用例测的就是桩而不是判据。
    private func liveAppIdentity() throws -> (pid: pid_t, bundleId: String, startMicros: UInt64) {
        guard let running = NSWorkspace.shared.runningApplications.first(where: {
            $0.bundleIdentifier != nil && $0.processIdentifier > 1
        }) else {
            throw XCTSkip("这台机器上此刻没有一个带 bundleIdentifier 的运行中 app（无登录的 GUI 会话？）；补上它：在桌面会话里跑本套件")
        }
        let identity = try XCTUnwrap(AXChannel.readProcessIdentity(running.processIdentifier))
        return (
            running.processIdentifier,
            try XCTUnwrap(identity.bundleId),
            try XCTUnwrap(identity.startMicros)
        )
    }

    /// socket 名字有 104 字节的硬上限，而 macOS 给每个进程的 `$TMPDIR` 是
    /// `/var/folders/5h/…/T/` 这一串——真放进去必然超 `sun_path`，用例只会"跳过"，而一次
    /// 跳过会被读成"测过了"。所以这里用一个刻意短的前缀，并在建目录之后先量一次长度：
    /// 量不到就明确失败，不许静默放过。
    private func makePrivateDirectory() throws -> String {
        let short = "/tmp/gp28"
        let dir = short + "-" + String(UUID().uuidString.prefix(8))
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        chmod(dir, 0o700)
        XCTAssertLessThan((dir + "/engine.sock").utf8.count, 104,
                          "socket 名字超出 sun_path，这一条测不到东西：\(dir)")
        return dir
    }

    /// 真的 socket()+bind()：夹具形状来自真系统调用，判据量的也就是生产那一对数。
    /// **不**做 chmod——做了就把"创建即私有"那条用例判据洗掉了。
    private func bindListener(at path: String, usesBindGuard: Bool = false) throws -> Int32 {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw XCTSkip("socket() 失败：\(String(cString: strerror(errno)))") }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else {
            close(fd)
            throw XCTSkip("路径超出 sun_path：\(path)")
        }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            raw.copyBytes(from: bytes)
        }
        let bindOnce = {
            withUnsafePointer(to: &addr) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                    Darwin.bind(fd, sockaddrPointer, socklen_t(MemoryLayout<sockaddr_un>.size))
                }
            }
        }
        let bound = usesBindGuard ? SocketBindGuard.bindWithPrivateMode(bindOnce) : bindOnce()
        guard bound == 0 else {
            let code = errno
            close(fd)
            XCTFail("bind(\(path)) 失败：errno \(code) \(String(cString: strerror(code)))")
            throw NSError(domain: "test", code: Int(code))
        }
        return fd
    }

    private func sourceText(_ relative: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(relative)
        return try String(contentsOf: url, encoding: .utf8)
    }
}
