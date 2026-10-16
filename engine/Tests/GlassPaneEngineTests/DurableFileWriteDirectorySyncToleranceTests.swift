import XCTest
@testable import GlassPaneEngine

/// 目录项 sync 的**容错边界**（2026-10-16，复审提出）。
///
/// 缺陷形状：`syncPublished` 原来对文件与目录两次 fsync 一视同仁地"非 0 即抛"，而
/// `Failure.isDurabilityFault` 把 `.syncDirectory` 归进"不许被 fallback 掩盖成成功"那一族。
/// 合起来的效果是：在一块**不支持目录 sync** 的卷上（smbfs / NFS / exFAT / 只读挂载都是
/// `--state-dir` 的合法去处），每一份档案、每一条台账、每一条注册都会答"没落盘"——而字节
/// 明明落下了。那是用一条证明不了的东西去否决一次实测到的写。
///
/// 容错只给目录那一半：文件本体的 fsync 失败仍然是硬拒（否则 `evidencePersisted:true`
/// 又是一句假话）。反向变异：把 `tolerateUnsupported` 也传给 `.syncFile` → 第 2 条红；
/// 把 EIO 也吞掉 → 第 3 条红。
final class DurableFileWriteDirectorySyncToleranceTests: XCTestCase {

    /// 真 `open`/`close`，唯独 fsync 由参数决定；每次 fsync 记一个号，用来分清
    /// 第一次（文件）与第二次（目录）。
    private func injected(fsyncErrnoForDirectory: Int32, fsyncErrnoForFile: Int32? = nil)
        -> (ops: DurableFileWrite.Operations, calls: () -> Int) {
        var calls = 0
        var lastErrno: Int32 = 0
        let ops = DurableFileWrite.Operations(
            open: { path, flags, mode in path.withCString { Darwin.open($0, flags, mode) } },
            write: { _, _, _ in 0 },
            fsync: { fd in
                calls += 1
                let want = (calls == 1) ? (fsyncErrnoForFile ?? 0) : fsyncErrnoForDirectory
                if want != 0 {
                    lastErrno = want
                    _ = fd
                    return Int32(-1)
                }
                return Darwin.fsync(fd)
            },
            close: { fd in Darwin.close(fd) },
            lastErrno: { lastErrno }
        )
        return (ops, { calls })
    }

    private func publishedFile(_ label: String) -> String {
        let root = TestSandbox.directory(label)
        let file = root + "/subject.json"
        let tmp = file + ".tmp-proved"
        let data = Data("{\"entries\":[]}\n".utf8)
        let (ops, _) = injected(fsyncErrnoForDirectory: 0)
        try! DurableFileWrite.stage(data, to: tmp, operations: ops)
        try! FileManager.default.moveItem(atPath: tmp, toPath: file)
        return file
    }

    /// 第 1 条：目录 fsync 报 ENOTSUP —— 这一次写**算成了**，不抛。
    func testDirectoryWithoutSyncSupportIsNotARefusal() throws {
        let file = publishedFile("dirsync-unsupported")
        let (ops, calls) = injected(fsyncErrnoForDirectory: Int32(ENOTSUP))
        do {
            try DurableFileWrite.syncPublished(atPath: file, operations: ops)
        } catch {
            XCTFail("不支持目录 sync 的卷上，一次已落盘的注册不该被拒：\(error)")
        }
        XCTAssertGreaterThanOrEqual(calls(), 1, "连一次目录 sync 都没试过，这条对照就是空的")
    }

    /// 第 2 条：同样报 ENOTSUP，但发生在**文件**那一步 —— 必须仍然硬拒。
    func testFileLevelSyncFailureIsStillAHardRefusal() throws {
        let file = publishedFile("dirsync-file-einval")
        let (ops, _) = injected(fsyncErrnoForDirectory: 0, fsyncErrnoForFile: EINVAL)
        XCTAssertThrowsError(try DurableFileWrite.syncPublished(atPath: file, operations: ops)) { error in
            let fault = error as? DurableFileWrite.Failure
            XCTAssertEqual(fault?.step, .syncFile, "拒的是文件那一步，别把目录的容错漏到这儿")
            XCTAssertTrue(fault?.isDurabilityFault ?? false, "字节没落这一族不许被 fallback 顶掉")
        }
    }

    /// 第 3 条：目录那一步报 EIO（存储自己在错）—— 容错不许把它也吞了。
    func testDirectoryEioIsNotSwallowed() throws {
        let file = publishedFile("dirsync-eio")
        let (ops, _) = injected(fsyncErrnoForDirectory: EIO)
        XCTAssertThrowsError(try DurableFileWrite.syncPublished(atPath: file, operations: ops)) { error in
            XCTAssertEqual((error as? DurableFileWrite.Failure)?.step, .syncDirectory)
            XCTAssertEqual((error as? DurableFileWrite.Failure)?.systemError, Int32(EIO))
        }
    }
}
