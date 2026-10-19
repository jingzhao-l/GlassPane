import Foundation

/// 落盘判定的唯一原语（P2：任何"已持久化"的答复都不许跑在字节前面）。
///
/// 这里存在的全部理由是一次**实测的缺席**：`grep -rn "fsync|F_FULLFSYNC"` 在
/// `engine/Sources`、`mcp-shell/src`、`updater/lib`、`installer`、`bridge` 里
/// 一个调用点都没有，而 `evidencePersisted: true`、`--project-remove` 的
/// "确认已删除"、审批链的"已记录"三句话都建在 `Data.write(.atomic)` /
/// `replaceItemAt` 上。那两个原语保证的是**原子可见性**（读者永远看不到半份文件），
/// 不是**持久性**：断电之后文件可以在，内容却可能是旧的或零长，而 daemon 已经
/// 回答过"存下了"。本仓对此早有先例口径——"chmod 没粘住的那次写要报成失败的写，
/// 不是报成存好了"（`EvidenceStore.isolationRefusalReport`、
/// `ProjectRegistry.save` 的 published-mode 拒绝）。这一条把同一口径用到
/// "数据没有真的落到设备上"。
///
/// 形状：临时名独占创建（`O_CREAT|O_EXCL`，mode 0600）→ 全量 write → **fsync(fd)**
/// → close，再由调用方按它已有的顺序做隔离（chmod 校验）与发布（rename）。发布后
/// 再 `syncPublished`：文件本体 + 所在目录项各 fsync 一次——rename 的持久化点在
/// 目录项上，只 fsync 文件等于没 fsync 那次改名。
///
/// 三个仓内写者（`EvidenceStore`、`ApprovalGate`、`ProjectRegistry`）共用这一份，
/// 不留三份拷贝。**没有**改用 `F_FULLFSYNC`：它要求卷支持、代价在百毫秒级，而
/// 这条修复要买的是"承诺不跑在页缓存前面"，不是"磁盘固件的掉电原子性"。残余
/// 限制说清楚：fsync 把数据推到设备，推不进 SSD 自己的写缓存——要连那一层也否认，
/// 需要 `F_FULLFSYNC`（本仓未做，也不在这里声称做过）。
enum DurableFileWrite {

    /// 失败发生在那一步。`open`/`write` 属于"这块盘/这个名字不好用"（调用方原有的
    /// fallback 分支就是为它准备的）；`fsync`/`close`/`sync*` 属于"字节没有真的落"，
    /// 那一步**不许**被 fallback 掩盖成成功。
    enum Step: String {
        case open, write, fsync, close, syncFile, syncDirectory
    }

    struct Failure: Error, Equatable {
        let step: Step
        let path: String
        let systemError: Int32

        /// 报给 agent 的那句话：点名哪一步、哪个路径、系统答了什么。
        var message: String {
            "\(step.rawValue)(\(path)) failed: \(String(cString: strerror(systemError)))"
        }

        /// 只有"数据没落"这一族才不能被 fallback 顶掉，判据说这一步。
        var isDurabilityFault: Bool {
            switch step {
            case .fsync, .close, .syncFile, .syncDirectory: return true
            case .open, .write: return false
            }
        }
    }

    /// 可注入的系统调用面。与 `EvidenceStore.isolationCheck`、
    /// `ApprovalGate.isolationCheck` 同一个理由：非 root 的单测造不出"fsync 返
    /// EIO 的卷"，而一条没有夹具执行过的拒绝分支正是本仓反复拒绝的形状。注入只
    /// 替换系统调用本身，不改"独占创建、写前收紧、写坏即拒"这套顺序。
    struct Operations {
        var open: (String, Int32, mode_t) -> Int32
        /// (fd, 待写字节, 偏移) → 实际写入的字节数；0 或负数算失败。
        var write: (Int32, Data, Int) -> Int
        var fsync: (Int32) -> Int32
        var close: (Int32) -> Int32
        /// 上一步失败时读到的错误号（真机就是 `errno`；夹具给的是一个数）。
        var lastErrno: () -> Int32

        /// 生产用的那一组：真的 `open(2)` / `write(2)` / `fsync(2)` / `close(2)`。
        static let live = Operations(
            open: { path, flags, mode in
                path.withCString { Darwin.open($0, flags, mode) }
            },
            write: { fd, data, offset in
                data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> Int in
                    guard let base = raw.bindMemory(to: UInt8.self).baseAddress else { return -1 }
                    return Darwin.write(fd, base + offset, data.count - offset)
                }
            },
            fsync: { fd in Darwin.fsync(fd) },
            close: { fd in Darwin.close(fd) },
            lastErrno: { errno }
        )
    }

    /// 把 `data` 落到 `path` 这个**临时名**上：独占创建 → 写全 → fsync → close。
    /// 抛出的 `Failure.step` 告诉调用方这次是"名字/盘不好用"（可以走它自己的
    /// fallback）还是"字节没落"（只能拒答）。
    static func stage(_ data: Data, to path: String, operations: Operations = .live) throws {
        let fd = operations.open(path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, mode_t(0o600))
        guard fd >= 0 else {
            throw Failure(step: .open, path: path, systemError: operations.lastErrno())
        }
        func closeFd() { _ = operations.close(fd) }

        var written = 0
        while written < data.count {
            let n = operations.write(fd, data, written)
            guard n > 0 else {
                let fault = Failure(step: .write, path: path, systemError: operations.lastErrno())
                closeFd()
                throw fault
            }
            written += n
        }
        // 关键的一步：改名之前，这块缓冲已经属于设备，不再属于这个进程。
        guard operations.fsync(fd) == 0 else {
            let fault = Failure(step: .fsync, path: path, systemError: operations.lastErrno())
            closeFd()
            throw fault
        }
        // APFS 上延迟分配的错误会在 close 才回来；close 失败时"落住了"这句话同样
        // 没有根据。
        guard operations.close(fd) == 0 else {
            throw Failure(step: .close, path: path, systemError: operations.lastErrno())
        }
    }

    /// 发布（rename）之后的持久化判定：文件本体一次、所在目录项一次。
    /// 只 fsync 文件而不 fsync 目录，等于承认"内容在"却声称"这个名字指向它"。
    static func syncPublished(atPath path: String, operations: Operations = .live) throws {
        try syncExisting(path: path, step: .syncFile, operations: operations)
        let directory = (path as NSString).deletingLastPathComponent
        // 目录那一次是**尽力而为**：smbfs / NFS / exFAT / 只读挂载都是 `--state-dir` 的合法
        // 去处，而那些卷压根不支持目录项 sync。把"证明不了"当成"没落盘"去拒绝一次已经
        // 成功写下的注册，就是用一条测不出来的保证去否决一次实测到的写——本仓对模式判定
        // 的同一条纪律（判据必须是量到的东西）反过来也成立。文件本体的 fsync 仍然是硬要求。
        // 容错的那一半写在 `syncExisting` 里，判据是 errno：`try?` 会连 EIO 一起吞掉，
        // 那才是真正"用一条测不出来的保证换一次安静"。
        try syncExisting(path: directory, step: .syncDirectory, operations: operations,
                         tolerateUnsupported: true)
    }

    /// 这台机器上"这个卷不支持目录 sync"的那几种回话。EIO / ENOMEM 不在其内：那是
    /// 存储自己在报错，必须继续当失败抛出去。
    ///
    /// **2026-10-19 实测后收紧**（原先这里还容错 EACCES 与 EPERM）。本机 APFS 卷
    /// （`/var/folders/…`，`statfs.f_fstypename == "apfs"`）量到的结果是：
    ///   • 目录 fsync 本身在 0700 目录、`O_DIRECTORY`、`uchg` 标记目录、以及密封只读
    ///     系统卷根目录上都**返回 0**——APFS 上没有任何"这个卷不会 sync 目录"要用
    ///     EACCES/EPERM 来回答的形态；
    ///   • EACCES(13) 却是能碰到的，而且碰在最坏的地方：档案目录 mode 0300（可写可
    ///     执行、**不可读**）时，rename 进去照样成功，紧跟着的 `open(O_RDONLY)` 回
    ///     EACCES。按旧集合容错，就等于"目录项从没 sync 过"而调用方仍然回答
    ///     `evidencePersisted: true`——正是本文件立起来要防的那句话，被一条权限状态
    ///     伪装成卷能力吞掉了。
    /// 因此这两个号回到"字节没有落"那一族；`smbfs/NFS/exFAT/只读挂载` 那几种真不
    /// 支持的形态仍然按 EINVAL/ENOTSUP/ENOSYS/EOPNOTSUPP 容错，
    /// `DurableFileWriteDirectorySyncToleranceTests` 的两条钉子（ENOTSUP 放行、EIO
    /// 拒绝）一字未动。判据还是量到的东西：`Qoder20261019CanonicalBytesTests` 在真
    /// 目录上跑这条 EACCES，跑不出来就 XCTSkip。
    static let unsupportedDirectorySyncErrnos: Set<Int32> = [
        EINVAL, ENOTSUP, ENOSYS, EOPNOTSUPP,
    ]

    private static func syncExisting(
        path: String, step: Step, operations: Operations, tolerateUnsupported: Bool = false
    ) throws {
        let fd = operations.open(path, O_RDONLY | O_CLOEXEC, 0)
        guard fd >= 0 else {
            let error = operations.lastErrno()
            if tolerateUnsupported, Self.unsupportedDirectorySyncErrnos.contains(error) { return }
            throw Failure(step: step, path: path, systemError: error)
        }
        guard operations.fsync(fd) == 0 else {
            let fault = Failure(step: step, path: path, systemError: operations.lastErrno())
            _ = operations.close(fd)
            if tolerateUnsupported,
               Self.unsupportedDirectorySyncErrnos.contains(fault.systemError) { return }
            throw fault
        }
        _ = operations.close(fd)
    }
}
