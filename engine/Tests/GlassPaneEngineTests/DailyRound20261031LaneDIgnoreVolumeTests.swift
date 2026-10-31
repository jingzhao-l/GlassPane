import XCTest
@testable import GlassPaneEngine

/// 「那句宣布只在模式真被量到时才出现」这一条**性质**，在一台真的忽略权限位的卷上跑一遍。
///
/// 为什么它是补口而不是主闸：P2-a 那条具名用例（`DailyRound20261031LaneDPermissionTighteningTests`）
/// 用接缝注入"chmod 回 0 而模式不粘"，任何机器上都确定性可红——本轮实测：把 `tightenDirectory`
/// 的回读删掉、只信 `chmod` 的返回值，那一条（连同根那一支与判据本体那一条）立刻红。这一条要
/// 把那个夹具换成**介质本身**，而本机（2026-10-31 实测）造不出目录那一支的红：
///   * APFS：`chmod(0700)` 之后 `stat` 就是 0700 —— 回读通过，那一趟确实做到了；
///   * MS-DOS / exFAT 磁盘镜像（用户态 `hdiutil`，默认 `noowners`）：`chmod` 一律回 0，模式由驱动
///     说了算。目录**固定报 0700**（恰好等于目标模式：回读通过，通过的原因是介质不是这一趟），
///     文件**固定报 0700**（`isolateFile` 在 `before & 0o077 == 0` 那一句就读成"已是 owner-only"，
///     连 chmod 都不走）。⇒ 这一种卷两侧都演示不出来；本轮在它上面真跑过这两条（见下面的命令），
///     结果是全绿——那已经是诚实的：这些卷上的 0700 是驱动给的，别的账号进不来；
///   * 只读挂载 / `chflags uchg` / 别人拥有的目录：`chmod` 回 -1（EROFS/EPERM），走的是既有那条
///     失败分支，不是这一条。
/// 需要的是**一个不保存 POSIX 权限位、又把目录折算成 0755/0777 那一类**的挂载：SMB 共享（NAS/Windows
/// 导出、无 unix 权限支持）最容易中；本机那台 NFS 服务端落在 APFS 上、认权限位，所以
/// `mount -t nfs 127.0.0.1:/…` 也不会出那个形状。补它的确切命令（前半段本机跑过，后半段要一座我
/// 没有的共享）：
///
///     hdiutil create -size 64m -fs MS-DOS -volname IGNOREPERM -o /tmp/ignoreperm.dmg
///     hdiutil attach /tmp/ignoreperm.dmg -mountpoint /tmp/ignoreperm -nobrowse
///     mkdir -p /tmp/ignoreperm/laneD
///     GP_LANE_D_IGNORE_PERMS_DIR=/tmp/ignoreperm/laneD \
///       swift test --package-path engine --filter DailyRound20261031LaneDIgnoreVolumeTests
///     hdiutil detach /tmp/ignoreperm
///
///     mkdir -p /tmp/smbmnt && mount_smbfs //USER@NAS/SHARE /tmp/smbmnt   # 无 unix 权限支持的共享
///     mkdir -p /tmp/smbmnt/laneD
///     GP_LANE_D_IGNORE_PERMS_DIR=/tmp/smbmnt/laneD \
///       swift test --package-path engine --filter DailyRound20261031LaneDIgnoreVolumeTests
///
/// 没挂卷时这两条 skip，不假装测过。挂上之后它们检查的是那一句打印的**充分条件**，判据与产品同源：
/// 目录必须是 `0700`（`tightenDirectory` 要的就是这个数），文件必须没有 group/other 位
/// （`isolateFile` 要的就是那个 `& 0o077 == 0`）。旧实现在一台把目录留在 0755 而 chmod 回 0 的卷上
/// 会在这里红：notes 全空、宣布出现、磁盘上那个证据目录仍然人人可进。
final class DailyRound20261031LaneDIgnoreVolumeTests: XCTestCase {

    /// 一个"预置好的旧安装"：目录装成 0755、登记表装成 0644。装不上也不是失败——那正是这一卷
    /// 不认权限位的证据，后面的判据只读**实测到的**模式。
    private func oldInstallation(under directory: String) throws -> StateRoot {
        let root = StateRoot(path: directory + "/laneD-root-\(UUID().uuidString.prefix(8))")
        try FileManager.default.createDirectory(atPath: root.evidenceDirectory, withIntermediateDirectories: true)
        _ = chmod(root.path, mode_t(0o755))
        _ = chmod(root.evidenceDirectory, mode_t(0o755))
        try "[]".write(toFile: root.projectsFile, atomically: true, encoding: .utf8)
        _ = chmod(root.projectsFile, mode_t(0o644))
        return root
    }

    private func mode(of path: String) -> Int {
        var info = stat()
        guard stat(path, &info) == 0 else { return -1 }
        return Int(info.st_mode & 0o777)
    }

    private func volumeDirectory() throws -> String {
        guard let raw = ProcessInfo.processInfo.environment["GP_LANE_D_IGNORE_PERMS_DIR"] else {
            throw XCTSkip("""
            需要 GP_LANE_D_IGNORE_PERMS_DIR=<一个忽略权限位的挂载里的目录>。本机造不出那一种目录形状\
            （实测与命令都在类注释里），所以这一条在没挂卷时不作数；判据本体那条确定性的红/绿由 \
            DailyRound20261031LaneDPermissionTighteningTests 负责。
            """)
        }
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: raw, isDirectory: &isDir), isDir.boolValue else {
            XCTFail("GP_LANE_D_IGNORE_PERMS_DIR 指向的不是一个存在的目录：\(raw)")
            return raw
        }
        return raw
    }

    /// 那条宣布的充分条件。**没量到就不许宣布**——一句，不是三句。
    func testTheOwnerOnlyAnnouncementOnlyAppearsWhenTheModesWereMeasured() throws {
        let root = try oldInstallation(under: volumeDirectory())
        final class Sink {
            var text = ""
        }
        let sink = Sink()
        let log = EngineLog(quiet: false, sink: { sink.text += String(decoding: $0, as: UTF8.self) })
        let notes = root.tightenPermissions(log: log)
        let announced = sink.text.contains("permissions tightened to owner-only")

        // 读数一律在扫描**之后**取：这一条比的是"宣布/报告"与"磁盘实际模式"这对矛盾。
        // 判据与产品同源，不许在这里改严（0600 那一句是打印的措辞，产品的承诺是 owner-only）。
        let directories = [root.path: mode(of: root.path), root.evidenceDirectory: mode(of: root.evidenceDirectory)]
        let fileMode = mode(of: root.projectsFile)
        let looseDirectories = directories.filter { $0.value != 0o700 }

        if announced {
            XCTAssertTrue(
                looseDirectories.isEmpty && fileMode & 0o077 == 0,
                """
                这句 "permissions tightened to owner-only (0700 dirs, 0600 files)" 是给面板与 agent 读的证据，\
                而这些路径的实际模式没到位（这一卷不保存权限位：chmod 回了 0 而模式没粘）——\
                目录=\(looseDirectories.map { "\($0.key):\(String(format: "%04o", $0.value))" }) \
                登记表=\(String(format: "%04o", fileMode))；notes=\(notes)
                """
            )
            XCTAssertTrue(notes.isEmpty, "宣布与报告不能同时出口：\(notes)")
        } else {
            XCTAssertFalse(
                sink.text.isEmpty,
                "既没宣布也没说清为什么——读者看到的是一条字没变的 stderr：\(directories) 登记表=\(fileMode)"
            )
        }
        // 反向的一半：这一卷上若确有目录没到 0700，notes 必须点名那一个，并带上实测数
        //（读者的下一步是 `ls -l`，只能对着一个被打印出来的数比）。
        for (path, measured) in looseDirectories {
            XCTAssertTrue(
                notes.contains { $0.contains(path) },
                "\(path) 实测 \(String(format: "%04o", measured)) 没到 0700，notes 却没有一句关于它：\(notes)"
            )
        }
    }

    /// 两侧判据必须同形：目录那一支是本轮补的，文件那一支本来就在。同一卷、同一个"模式没粘"的
    /// 事实，要么两侧都说得出话，要么两侧都沉默——旧实现下目录那侧是空的（P2-a 的本体）。
    func testBothSidesOfTheSweepUseTheSameJudgmentOnTheSameVolume() throws {
        let root = try oldInstallation(under: volumeDirectory())
        let log = EngineLog(quiet: true, sink: { _ in })
        let notes = root.tightenPermissions(log: log)
        let evidenceMode = mode(of: root.evidenceDirectory)
        let fileMode = mode(of: root.projectsFile)

        let directoryClaimed = notes.contains { $0.hasPrefix("evidence directory \(root.evidenceDirectory)") }
        let fileClaimed = notes.contains { $0.hasPrefix(root.projectsFile) }

        XCTAssertEqual(
            evidenceMode != 0o700, directoryClaimed,
            """
            证据目录实测 \(String(format: "%04o", evidenceMode))：没到 0700 就必须有一条 notes，\
            到了 0700 就不许凭空报一条；notes=\(notes)
            """
        )
        XCTAssertEqual(
            fileMode & 0o077 != 0, fileClaimed,
            "登记表实测 \(String(format: "%04o", fileMode))：文件那一侧的判据（owner-only）必须与目录同形；notes=\(notes)"
        )
    }
}
