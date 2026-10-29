import Foundation

/// socket 文件名的归属判据——unlink 之前必须先证明"这个名字还指着我建的那个 inode"。
///
/// 为什么 `unlink(socketPath)` 单独一句是不够的：`--force-socket` 的成文语义就是
/// "旧实例继续活着，但失去这个 socket 名"（`glasspaned/main.swift` 的 usage 那一段）。
/// 于是继任者 B 把同一个路径字符串 bind 成自己的监听 socket，而前任 A 手里那个
/// `socketPath` 字符串**一模一样**。A 后来被 SIGTERM（或走 `cleanup()` / `stop()`）
/// 时按名字删文件，删掉的是 B **正在监听**的那个：B 进程还活着、accept 还在跑，
/// 但按名字再也连不上——`liveness` 回 `.noListener`，下一次启动再 unlink + bind 出
/// 第三个。A-18 那一族"两份归因指向不同实例"的形态就是从这种分裂里长出来的。
///
/// 做法是标准的那一种：bind 成功后对**自己的 fd** 取 `fstat` 的 (st_dev, st_ino)，
/// 收尾时对该名字取 `lstat`。两个相等才动手。读不到任何一个 ⇒ 不删：留一个 proven
/// stale 的 socket 文件比删掉别人正在用的那个便宜得多——下一次启动那条路径本来就会
/// 在亲眼确认"没有监听者 + 这名字是个 socket"之后清理它（`DaemonProbe.takeoverDecision`
/// 与 `nameIsClearableSocketName` 两条都在）。
public enum SocketBindGuard {

    /// 在 umask 收紧到 `0177` 的情况下跑一次 `bind` 那一步，随后恢复原值。
    ///
    /// 为什么这件事要发生在 bind 而不是 chmod：AF_UNIX 的 inode 是按 `0777 & ~umask`
    /// 创建的，所以 `bind()` 返回的那一刻到 `chmod(0600)` 落下去之间，这个名字存在且
    /// 对本账号可连——本机 umask 是 `022` 时它是 `0755`。`chmod` 那句是"修复 + 复验"，
    /// 不是"建立不变量"：把 0600 这条硬不变量交在一个 syscall 之后的窗口上，就等于它
    /// 有时候成立（每日任务 2026-10-28 由 `ReviewLifecycleTests` 量到：中间插入任何一次
    /// 系统调用都会加宽那个窗口，说明它本来就不是一个能被依赖的次序）。
    ///
    /// 恢复用的是 `bind` 之前读到的那一个 umask，且这一段里不做任何别的事——本进程此
    /// 刻还在启动序列里，没有其它线程在建文件。收紧方向上的错误代价是"更严"，不是"更松"。
    public static func bindWithPrivateMode(_ bind: () -> Int32) -> Int32 {
        let previous = umask(0o177)
        defer { _ = umask(previous) }
        return bind()
    }
}

public struct SocketInode: Equatable {

    public let device: dev_t
    public let inode: ino_t

    public init(device: dev_t, inode: ino_t) {
        self.device = device
        self.inode = inode
    }
}

/// 收尾那一次 unlink 的**三态**结论。
///
/// 为什么不能用 `Bool`（2026-10-29 S2-2）：旧签名把两件不同的事压成同一个 `false`——
/// 「这个名字不是我的（什么都不该删）」与「这个名字是我的、但 `unlink()` 失败了」。
/// 两个调用方（`SocketServer.run()` 与 `glasspaned` 的 sigwait 收尾）对 `false` 一律打印
/// "the name no longer points at the socket this instance bound"，而 `unlink()` 失败那一支里
/// inode 恰恰**就是**本实例的：socket 目录只读、父目录被 `chflags uchg`、卷 remount ro 都会走到
/// 这里（实测 `EACCES`/`EPERM`）。那句话在那个现场是反的，而且 errno 被整个丢掉——运维照着
/// 那句去查"谁抢了这个名字"，永远查不到"这个目录删不掉文件"。`errno` 是被测到的事实，
/// 不是实现细节，所以它进结论、也进那句话。
public enum SocketNameRemoval: Equatable {

    /// 名字是本实例的，且已经删掉了。
    case removed
    /// 名字不是本实例的那个 inode（或根本读不到）——**一个字节都没动**，这是判据在起作用。
    case notOurs
    /// 名字**是**本实例的那个 inode，`unlink()` 却失败了；带着 errno。
    case unlinkFailed(errno: Int32)

    public var isRemoved: Bool { self == .removed }

    /// 这一态该说出口的那句话（两个调用方共用一份文案；判决与措辞都不许落到壳/面板那边去）。
    public func line(for path: String) -> String {
        switch self {
        case .removed:
            return "removed \(path): it was the socket this instance bound"
        case .notOurs:
            return "left \(path) in place: the name does not point at the socket this instance bound "
                + "(or this instance never recorded one) — nothing was removed"
        case .unlinkFailed(let code):
            return "left \(path) in place: the name IS the socket this instance bound but unlink() failed "
                + "with errno \(code) (\(String(cString: strerror(code)))) — the socket file is still there "
                + "and this process cannot remove it; make the parent directory writable (or clear its "
                + "immutable flag) and remove that name by hand"
        }
    }
}

public enum SocketNameOwnership {

    /// 这个名字此刻指着哪一个 inode（`lstat`：不跟随符号链接——链接本身就是要认出的那种
    /// "名字不属于任何监听者"的形态）。不存在、或读不到 ⇒ nil。
    ///
    /// 这一条同时也是 bind 之后**记账**用的读数：`bind()` 创建的那个目录项就指着本实例
    /// 刚建的 socket inode，所以紧跟着 bind 取一次 `lstat`，记下的就是"我的那一个"。
    ///
    /// 为什么不用 `fstat(listenFD)`（本平台上的常规做法听起来更直接）：实测在 macOS 上
    /// 两者不是同一个东西——socket fd 的 `fstat` 回 `st_dev = -1`（VNONCE）与一个 nonce
    /// 号，而路径的 `lstat` 回真实卷与 inode（本轮的测试就是把这一对数当前提量出来的，
    /// 所以它先红，而不是让生产拿到一条"永不删"的空判据）。
    public static func currentInode(atPath path: String) -> SocketInode? {
        var stat = stat()
        guard lstat(path, &stat) == 0 else { return nil }
        return SocketInode(device: stat.st_dev, inode: stat.st_ino)
    }

    /// 只有"记到过自己那个 inode"且"名字现在仍指着它"才许删。
    /// `recorded == nil` 就是没记到（bind 之后 lstat 失败），此时**不删**——见文件头。
    public static func mayRemove(recorded: SocketInode?, atPath path: String) -> Bool {
        guard let recorded else { return false }
        guard let current = currentInode(atPath: path) else { return false }
        return current == recorded
    }

    /// 动手那一条：判据成立才 unlink，并把结果**按三态**如实报出去（调用方要把它写进日志——
    /// "没删"是一次测量，不是一个沉默的分支；而"删不掉"与"不是我的"是两次不同的测量）。
    /// 调用方拿到的必须是 `outcome.line(for:)` 那一句，不是自己重写的一句：旧签名回 `Bool`
    /// 时两个调用方对 `false` 共用同一句"名字不是我的"，那正是 S2-2 修掉的东西。
    @discardableResult
    public static func removeIfOurs(recorded: SocketInode?, atPath path: String) -> SocketNameRemoval {
        guard mayRemove(recorded: recorded, atPath: path) else { return .notOurs }
        // `unlink` 之前不清 errno：它只在返回 -1 时才可信，而这里判的就是返回 -1。
        return unlink(path) == 0 ? .removed : .unlinkFailed(errno: errno)
    }
}
