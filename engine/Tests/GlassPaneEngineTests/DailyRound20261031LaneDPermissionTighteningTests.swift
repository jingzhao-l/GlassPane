import Foundation
import Testing
@testable import GlassPaneEngine

/// 收尾那句 "permissions tightened to owner-only" 必须是**量出来的**，不是问出来的。
///
/// 2026-10-31 P2-a 的缺陷本体：`tightenPermissions` 对状态根（`stat` 回读）与每一个文件
/// （`isolateFile` 的 `attributesOfItem` 回读）都判"chmod 之后模式到底粘住了没有"，唯独证据
/// 目录那一支只判 `chmod(...) != 0`。而在忽略权限位的卷上——只读挂载、无权限支持的 NFS/SMB
/// 导出、被 ACL 吞掉的写、驱动不认权限位的介质——`chmod` 回 0 而 `st_mode` 原样不动：syscall
/// 被接受 ≠ 模式被保住。于是 notes 全空、日志打印"收紧到了 0700/0600"，磁盘上那个证据目录仍是
/// 0755：一句本运行没做到的收紧。这句是给面板与 agent 读的证据（`EngineLog` 的 stderr → launchd
/// 那份 `installer-daemon.log`），不是注释。
///
/// 修法是同一把判据：`StateRoot.tightenDirectory` 先 chmod、再 `stat` 回读、模式不等于目标就
/// 出 notes（沿用既有那条通道的措辞 `<label>: mode is <实测>, not <目标>`，读侧已有读者）。
/// 状态根与证据目录两个调用点共用它，所以两者不可能各学一份。
///
/// 夹具为什么是接缝而不是真卷（本机实测，2026-10-31）：
///   * APFS：`chmod(0700)` 之后 `stat` 就是 0700 —— 回读通过，那一趟确实做到了；
///   * `hdiutil create -fs MS-DOS`（同 `-fs ExFAT`；用户态可挂，默认 `noowners`）：`chmod` 一律回 0，
///     模式由驱动说了算——目录**固定报 0700**（恰好等于目标模式：回读通过，通过的原因是介质不是这一
///     趟），文件**固定报 0700**（`isolateFile` 在 `before & 0o077 == 0` 那一句就读成"已是
///     owner-only"，连 chmod 都不走）。⇒ 这一种卷两侧都演示不出来；
///   * 只读挂载 / `chflags uchg` / 别人拥有的目录：`chmod` 直接回 -1（EPERM/EROFS），走的是既有那条
///     失败分支，不是这一条。
/// 也就是说"目录的 chmod 回 0 而模式不是 0700"需要一个真的不保存权限位、又把目录折算成 0755/0777
/// 那一类的挂载（SMB 共享是最容易中的那一个；本机 NFS 服务端落在 APFS 上、认权限位，不算）。非 root
/// 在本机起不了那个服务端。`DailyRound20261031LaneDIgnoreVolumeTests`（同轮，XCTest）把那一步做成
/// 了可执行的补口：挂载命令与环境变量名都写在它的注释里，卷挂上之后它自己跑、不挂就 skip（本轮已在
/// 那个 MS-DOS 镜像上真跑过一遍：全绿，因为那里的 0700 是驱动给的、别的账号确实进不来）。
/// 这里注入的是判据读不到的那一种卷，走 `tightenPermissions(log:chmodDirectory:)` 这一个参数——
/// 与 `EvidenceStore.isolationCheck` 同一类接缝，存在的唯一理由也是"这一条拒绝否则没有任何测试
/// 能执行"。
@Suite("StateRoot: a directory is only tightened when its mode reads back")
struct DailyRound20261031LaneDPermissionTighteningTests {

    // MARK: - 夹具

    /// 一趟扫描的收口：notes + 日志真正写出去的那几行字节。断言读的是**线上那一条形状**
    /// （`log.error("state permission not isolatable — …")` 与
    /// `log.info("… permissions tightened to owner-only …")`），不是另一个平行实现。
    ///
    /// `quiet: false` 是必须的：那句宣布走 INFO，而 INFO 归 `--verbose` 管（见
    /// `EngineLog.emits(level:quiet:)`）。用 quiet 的日志去断言"这句没出现"，红的或是那句
    /// 本来就被级别门吞了——这一条要读的是判据决定的那句话，不是门。
    private struct Sweep {
        let notes: [String]
        let log: String
    }

    private final class LogCapture {
        var lines: [String] = []
        var text: String { lines.joined() }
    }

    private func run(_ root: StateRoot, apply: ((String, mode_t) -> Int32)? = nil) -> Sweep {
        let capture = LogCapture()
        let notes = root.tightenPermissions(
            log: EngineLog(quiet: false, sink: {
                capture.lines.append(String(decoding: $0, as: UTF8.self))
            }),
            chmodDirectory: apply ?? { path, mode in chmod(path, mode) }
        )
        return Sweep(notes: notes, log: capture.text)
    }

    /// "chmod 被接受、模式不粘"的那种卷：对 `ignoring` 那一个路径只回 0、什么都不做，其余路径
    /// 走真 chmod。磁盘上留下的因此是这台机器**实测**到的旧模式，不是断言里写死的数。
    private static func nonStickyVolume(ignoring: String) -> (String, mode_t) -> Int32 {
        { path, mode in path == ignoring ? 0 : chmod(path, mode) }
    }

    private func mode(of path: String) -> Int {
        var info = stat()
        guard stat(path, &info) == 0 else { return -1 }
        return Int(info.st_mode & 0o777)
    }

    /// 一个"预置好的旧安装"：根 0755、证据目录 0755、登记表 0644 —— R5-04 那三种形状，也正是
    /// 这句打印最容易被读错的一种（一切都是世界可读的）。
    private func oldInstallationRoot(_ label: String, evidence: Bool) throws -> StateRoot {
        let root = StateRoot(path: TestSandbox.directory(label))
        #expect(chmod(root.path, mode_t(0o755)) == 0, "前置：这台机器装不上 0755 的根")
        if evidence {
            try FileManager.default.createDirectory(
                atPath: root.evidenceDirectory, withIntermediateDirectories: true
            )
            #expect(chmod(root.evidenceDirectory, mode_t(0o755)) == 0, "前置：证据目录要能装成 0755")
        }
        return root
    }

    // MARK: - 用例

    /// P2-a 本体。证据目录处在一个"chmod 回 0 而模式不粘"的卷上：
    ///  1. notes 必须说出这件事，并带上**实测到的**那个模式（读者的下一步是 `ls -l`，只能对着
    ///     一个被打印出来的数比）；
    ///  2. 收尾那句 "permissions tightened to owner-only" 一个字都不许出现——那一趟没做到；
    ///  3. 磁盘上它仍是 0755，所以这条拒绝不是夹具在说谎。
    ///
    /// REVERSE：删掉 `tightenDirectory` 里的回读（`stat` + 比对）、只留 `apply(...) != 0`
    /// ⇒ 本条红（notes 变空、那句 announcement 出现）。
    @Test("An evidence directory whose chmod is accepted but does not stick is reported, not announced")
    func evidenceDirectoryThatKeepsItsModeIsNotClaimedTightened() throws {
        let root = try oldInstallationRoot("evidence-notsticky", evidence: true)
        try "[]".write(toFile: root.projectsFile, atomically: true, encoding: .utf8)
        #expect(chmod(root.projectsFile, mode_t(0o644)) == 0, "前置：登记表要能装成 0644")
        #expect(mode(of: root.evidenceDirectory) == 0o755, "夹具测到的那个世界可读的证据目录")

        let sweep = run(root, apply: Self.nonStickyVolume(ignoring: root.evidenceDirectory))

        let note = try #require(sweep.notes.first)
        #expect(
            sweep.notes.count == 1,
            "只有一个路径的量没到，notes 就该只有那一条：\(sweep.notes)"
        )
        #expect(
            note == "evidence directory \(root.evidenceDirectory): mode is 0755, not 0700",
            "点名证据目录、带上实测模式、沿用状态根那一支的措辞：\(note)"
        )
        #expect(
            !sweep.log.contains("permissions tightened to owner-only"),
            "本运行没做到的收紧不许打印：\(sweep.log)"
        )
        #expect(
            sweep.log.contains("state permission not isolatable — evidence directory"),
            "这条要走 notes 既有那条 ERROR 通道（面板与 agent 读的就是这里）：\(sweep.log)"
        )
        #expect(
            mode(of: root.evidenceDirectory) == 0o755,
            "报告不许顺手把磁盘改成另一个样子——它仍是那个没被保住的模式"
        )
        #expect(mode(of: root.path) == 0o700, "同一次扫描里做得到的部分照做：根真的到了 0700")
        #expect(mode(of: root.projectsFile) == 0o600, "登记表同理：一条报告不停下整趟扫描")
    }

    /// 对照（同一片磁盘、同一个夹具，唯一变的是判据走真 chmod）：模式确实粘住时 notes 为空、
    /// 那句 announcement 出现。没有这一条，上面那条红可以是"接缝让谁都过不去"红出来的。
    @Test("The same tree on a volume that keeps the mode is tightened and announced — the control")
    func theSameTreeOnANormalVolumeIsAnnounced() throws {
        let root = try oldInstallationRoot("evidence-normal", evidence: true)

        let sweep = run(root)

        #expect(sweep.notes.isEmpty, "这台机器的卷保住权限位，所以这里没有可报的：\(sweep.notes)")
        #expect(
            sweep.log.contains("permissions tightened to owner-only"),
            "做到了就该宣布——这一条钉的是『不是永远不宣布』：\(sweep.log)"
        )
        #expect(mode(of: root.evidenceDirectory) == 0o700)
        #expect(mode(of: root.path) == 0o700)
    }

    /// 同一个判据、第二个调用点：状态根自己（从前它就有回读）。两条一起说的才是"两处目录共用
    /// 一份判据"——把根那一支的措辞或通道改味，本条红。
    @Test("The state root is judged by the same re-read and keeps its own wording")
    func stateRootUsesTheSameReRead() throws {
        let root = try oldInstallationRoot("root-notsticky", evidence: true)
        #expect(chmod(root.evidenceDirectory, mode_t(0o700)) == 0)

        let sweep = run(root, apply: Self.nonStickyVolume(ignoring: root.path))

        #expect(
            sweep.notes == ["state root \(root.path): mode is 0755, not 0700"],
            "根那一支的既有形状不许因为抽公共判据而变味：\(sweep.notes)"
        )
        #expect(
            !sweep.log.contains("permissions tightened to owner-only"),
            "根都没量到 0700，这句宣布不许出口：\(sweep.log)"
        )
        #expect(mode(of: root.path) == 0o755, "回读说没粘住，磁盘就得还是旧的：测到 \(mode(of: root.path))")
    }

    /// 既有那条失败分支的形状是这次重构的兼容责任：`chmod` 直接回非 0（EPERM/EROFS/别人拥有的
    /// 目录）时 notes 仍是那一条 "…: chmod(0700) failed: <strerror>"，不许多出一条回读报告，
    /// 也不许换新措辞——`SECURITY.md` 与面板读者认的就是这一条。
    @Test("A chmod that refuses outright keeps its existing single note")
    func chmodRefusalKeepsItsExistingNote() throws {
        let root = try oldInstallationRoot("evidence-eperm", evidence: true)
        #expect(chmod(root.path, mode_t(0o700)) == 0, "根先装好，让失败只发生在证据目录")

        let sweeper: (String, mode_t) -> Int32 = { path, mode in
            if path == root.evidenceDirectory {
                errno = EPERM
                return -1
            }
            return chmod(path, mode)
        }
        let sweep = run(root, apply: sweeper)

        let note = try #require(sweep.notes.first)
        #expect(sweep.notes.count == 1, "一次失败的 chmod 只该给一条：\(sweep.notes)")
        #expect(
            note.hasPrefix("evidence directory \(root.evidenceDirectory): chmod(0700) failed: "),
            "拒绝分支的既有单条形状：\(note)"
        )
        #expect(
            note.contains("Operation not permitted"),
            "errno 要在 chmod 之后立刻取（SocketDirectoryRule 同一条规矩）：\(note)"
        )
        #expect(mode(of: root.evidenceDirectory) == 0o755)
    }

    /// 缺目录不是缺陷，也不许"为了检查而 mkdir/chmod"把它变成一次创建：新装的根里 `evidence/`
    /// 是第一次写证据时才建的。这一条钉的是重构把 `stat(...) == 0` 那道前置保住了。
    @Test("An absent evidence directory is neither reported nor created by the sweep")
    func absentEvidenceDirectoryIsNotTouched() throws {
        let root = try oldInstallationRoot("evidence-absent", evidence: false)
        #expect(!FileManager.default.fileExists(atPath: root.evidenceDirectory))

        final class Asked {
            var paths: [String] = []
        }
        let asked = Asked()
        let sweeper: (String, mode_t) -> Int32 = { path, mode in
            asked.paths.append(path)
            return chmod(path, mode)
        }
        let sweep = run(root, apply: sweeper)

        #expect(sweep.notes.isEmpty, "没有那个目录就没有暴露，也不该被报成缺陷：\(sweep.notes)")
        #expect(
            !asked.paths.contains(root.evidenceDirectory),
            "扫描不许 chmod 一个不存在的路径，更不许为此建它：\(asked.paths)"
        )
        #expect(!FileManager.default.fileExists(atPath: root.evidenceDirectory))
        #expect(
            sweep.log.contains("permissions tightened to owner-only"),
            "根与文件的模式都量到了，这里宣布是真做到了：\(sweep.log)"
        )
    }

    /// 判据本体（不走 `tightenPermissions` 那一圈磁盘）：三种答案各自唯一，且比对用的是 chmod
    /// **之后**的那一次读数——把回读挪到 chmod 之前、或把 `!=` 写成 `>=`，这里就红。
    @Test("tightenDirectory measures the mode after the chmod, not the chmod's answer")
    func tightenDirectoryJudgmentIsTheReRead() throws {
        let path = TestSandbox.directory("helper")
        #expect(chmod(path, mode_t(0o755)) == 0)
        // 回读那一支：apply 什么都不做但回 0，判据必须仍然看见 0755。
        #expect(
            StateRoot.tightenDirectory(path, to: mode_t(0o700), label: "evidence directory \(path)/") {
                _, _ in 0
            } == "evidence directory \(path)/: mode is 0755, not 0700"
        )
        #expect(mode(of: path) == 0o755, "判据是只读的：报告一条，磁盘不动一处")
        // 真装上之后同一个调用必须回 nil——否则上面那条红可以是"谁都过不去"红出来的。
        #expect(
            StateRoot.tightenDirectory(path, to: mode_t(0o700), label: "state root \(path)") {
                inner, mode in chmod(inner, mode)
            } == nil
        )
        #expect(mode(of: path) == 0o700)
        // 失败分支：措辞与 errno 同源。
        #expect(
            StateRoot.tightenDirectory(path, to: mode_t(0o700), label: "state root \(path)") {
                _, _ in errno = EROFS; return -1
            } == "state root \(path): chmod(0700) failed: Read-only file system"
        )
    }
}
