import Foundation

/// The one rule set that decides whether a directory is safe to publish a unix
/// socket into — shared by the engine listener and the probe listener (X-25).
///
/// Both listeners used to carry their own copy of this prose, which is how the
/// probe side ended up with none of it: `ProbeSocketServer.start()` called
/// `createDirectory(attributes: 0o700)` and bound. That call is a **no-op on an
/// existing directory** — `createDirectory` only applies the attributes to a
/// directory it creates — so a state root or `/tmp` subdirectory left group- or
/// world-readable by an earlier run, another product, or an installer that ran
/// under a different umask, was accepted as the probe's listen directory. The probe
/// answers `hello`/`handler`/`state` frames the daemon then upgrades into strong
/// attribution, so a writable parent next to that name is an injection path into
/// the very evidence the panel shows.
///
/// Every refusal names the directory **and the mode actually measured**: "the
/// volume ignores chmod" and "you do not own this" are different next steps, and a
/// reader with `ls -l` output can only compare against a number that was printed.
enum SocketDirectoryRule {
    /// `nil` when the directory exists, is owned by this account, and now measures
    /// 0700. Otherwise the defect, phrased to be read by a person or an agent.
    static func enforce(directory: String) -> String? {
        guard !directory.isEmpty else { return nil }
        // 兜底（2026-10-29 S4-3），排在所有动盘动作之前：这一条规则 chmod 的是**传进来的
        // 那一个目录**，而它分不清调用方是 CLI 的 `--socket-path`、探针的默认名、设置面板
        // 注入的路径还是下一个调用方。CLI 那两道闸（`StateRootArgument.rejectionForSocketParent`）
        // 只看得见命令行给的值；这一条是谁来了都拦得住的那一半。家目录与 `/` 永远不是
        // 本产品拥有的 socket 目录，所以这里**一句 chmod 都不做**就回拒绝——不是"chmod 完
        // 再说"：`chmod(home, 0700)` 之后没有任何拒绝能把它还给用户。
        if let defect = ownsItNeverChmodDefect(directory) { return defect }
        // The leaf may not be a symlink. `chmod`, `stat` and `bind` all follow it, so
        // every check below would measure — and pass on — the directory the link
        // *points at*, while `ancestorDefect(for:)` walks the string path it was given.
        // That pair is the hole: a state root named `/Users/me/.glasspane` whose leaf
        // links to `/tmp/somebody/mine` measures the target's owner and mode (both fine)
        // and never asks whether the parents of the real location let another account
        // create names there. The archive side refuses exactly this shape for the same
        // reason (`EvidenceStore.nameIsUsableArchiveDirectory`: "chmod 会跟着符号链接走").
        if let defect = leafSymlinkDefect(directory) { return defect }
        // Measure the leaf, then act — the same order the archive side keeps in
        // `EvidenceStore.nameIsUsableArchiveDirectory`. Until 2026-10-22 the
        // not-a-directory verdict sat *below* the `createDirectory` and the
        // `chmod(0700)` that follow, so `--socket-path /Users/me/notes/engine.sock`
        // with `notes` a regular file re-permissioned that file (a mode this run has
        // no business setting: the name is not a socket directory, and 0700 is not
        // what the owner wrote there) and only then refused. `createDirectory` under
        // `try?` keeps whatever it reports about a name that is already there, so
        // `chmod` was the step that changed the disk while nothing was said about it.
        if let defect = leafNotDirectoryDefect(directory) { return defect }
        try? FileManager.default.createDirectory(
            atPath: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        var info = stat()
        if chmod(directory, 0o700) != 0 {
            let code = errno
            // 失败之后仍然要读数：读者要知道它**现在**是什么模式，才知道这是 immutable
            // 标志、只读卷还是别人拥有的目录。
            let measured = stat(directory, &info) == 0
                ? String(format: "%04o", Int(info.st_mode & 0o777))
                : "unreadable (\(String(cString: strerror(errno))))"
            return "chmod(0700) on \(directory) failed: \(String(cString: strerror(code))) — it is still \(measured), and a socket directory other accounts can reach would publish every frame passing through it to those accounts"
        }
        guard stat(directory, &info) == 0 else {
            let code = errno
            return "\(directory) cannot be examined after chmod (\(String(cString: strerror(code)))) — isolation unproven"
        }
        guard (info.st_mode & S_IFMT) == S_IFDIR else {
            return notDirectoryDefect(directory, measuredMode: Int(info.st_mode & 0o777))
        }
        let owner = Int64(info.st_uid)
        if owner != getuid() {
            let name = (try? FileManager.default.attributesOfItem(atPath: directory))?[.ownerAccountName] as? String
                ?? "uid \(owner)"
            return "\(directory) is owned by \(name) (mode \(String(format: "%04o", Int(info.st_mode & 0o777)))), not this account — serving from a directory somebody else owns means they can replace the socket file"
        }
        let mode = Int(info.st_mode & 0o777)
        guard mode == 0o700 else {
            return "\(directory) is still \(String(format: "%04o", mode)) after chmod(0700) — this volume does not keep the permission bits, so isolating the socket here is impossible"
        }
        return ancestorDefect(for: directory)
    }

    /// 这个名字**永远不该被本规则 chmod**：`/` 本身，或者账号的家目录本身（两种拼写
    /// 都算：`NSHomeDirectory()` 与 `homeDirectoryForCurrentUser`，`--state-dir` 那一条
    /// 判据量的就是这一对，见 `StateRootArgument.notADedicatedRoot`）。尾斜杠与多个尾斜杠
    /// 折叠成同一个比较，因为"只认一种拼写"的拒绝下一次打错字就走过去了。
    ///
    /// 纯读，不碰磁盘——它唯一的动作是比字符串。缺目录（ENOENT）在这里也不是 defect：
    /// "daemon 会自己建"仍然是常态，只是建之前先问这一句。
    static func ownsItNeverChmodDefect(_ directory: String) -> String? {
        var normalized = directory
        while normalized.count > 1, normalized.hasSuffix("/") {
            normalized.removeLast()
        }
        if normalized == "/" {
            return "\(directory) is the filesystem root — a socket directory is brought to 0700 before it "
                + "binds, and `/` is nobody's directory to re-permission: every account's files, every "
                + "mounted volume and every system path sit under it. Nothing was chmod-ed here. Put the "
                + "socket inside a directory this install owns, e.g. let it default under --state-dir, or "
                + "pass --socket-path " + RemedyCommand.quote(NSHomeDirectory() + "/.glasspane/engine.sock")
        }
        for home in Array(Set([
            NSHomeDirectory(),
            FileManager.default.homeDirectoryForCurrentUser.path,
        ])) {
            var root = home
            while root.count > 1, root.hasSuffix("/") { root.removeLast() }
            guard normalized == root else { continue }
            return "\(directory) is a home directory — a socket directory is brought to 0700 before it binds, "
                + "which would re-permission everything this user owns and drop engine files beside their "
                + "own documents. Nothing was chmod-ed here. Put the socket inside the engine's own "
                + "directory, e.g. --socket-path " + RemedyCommand.quote(home + "/.glasspane/engine.sock")
                + ", or name --state-dir and let the socket default to living under it"
        }
        return nil
    }

    /// The leaf's own type, taken without following it. A symlink at the end of the
    /// path is refused rather than resolved: `chmod`/`stat`/`bind` would all act on the
    /// directory the link points at while the ancestor walk below is handed the link's
    /// own path, so the real location's parents never get asked. `lstat` failing with
    /// ENOENT is not a defect — that is the ordinary "the daemon creates it" case.
    static func leafSymlinkDefect(_ directory: String) -> String? {
        var info = stat()
        guard lstat(directory, &info) == 0 else { return nil }
        guard (info.st_mode & S_IFMT) == S_IFLNK else { return nil }
        return "\(directory) is a symlink — the socket would be bound through it into whatever it points at, while the parent checks below can only see this path. Refusing without following it (the same rule the evidence archive applies to its directory, `EvidenceStore.nameIsUsableArchiveDirectory`): point --state-dir at a real directory this account owns"
    }

    /// The leaf's own type again, taken without following it: a name that **is**
    /// there and is not a directory is refused before `createDirectory` or `chmod`
    /// gets to act on it. A missing leaf is not a defect — `lstat` failing with
    /// ENOENT is the ordinary "the daemon creates it" case, and the `createDirectory`
    /// this check guards is exactly the call that creates it.
    ///
    /// A symlink at the leaf is answered by `leafSymlinkDefect`, which `enforce`
    /// asks **first**: calling it "not a directory" would be a different lie about
    /// the same name, and the refusal that follows the link is what makes that shape
    /// dangerous. Nothing here resolves or modifies the name — it only reads it.
    static func leafNotDirectoryDefect(_ directory: String) -> String? {
        var info = stat()
        guard lstat(directory, &info) == 0 else { return nil }
        guard (info.st_mode & S_IFMT) == S_IFDIR else {
            return notDirectoryDefect(directory, measuredMode: Int(info.st_mode & 0o777))
        }
        return nil
    }

    /// The one spelling of "this leaf is not a directory". The pre-flight and the
    /// re-read after `chmod` both use it, so the message cannot fork into two
    /// variants a reader — or a test matching on it — has to learn separately.
    static func notDirectoryDefect(_ directory: String, measuredMode: Int) -> String {
        "\(directory) is not a directory (mode \(String(format: "%04o", measuredMode)))"
    }

    /// The leaf's own checks say nothing about the path above it, and that is the
    /// half an attacker needs: a state root at `/tmp/obs/st` binds a `0700` `st`
    /// that `/tmp/obs` — owned by a **different account** — still lets its owner
    /// rename aside and plant its own `engine.sock` under the same name. The daemon
    /// then serves its fd to nobody while every client that connects by name reaches
    /// the other account's listener. `createDirectory(withIntermediateDirectories:)`
    /// applies its attributes only to the directory it creates, so the intermediates
    /// were never brought into the rule at all.
    ///
    /// Measured on this machine: `/`, `/var/folders`, `/var/folders/5h` are root 0755,
    /// the DARWIN_USER_DIR levels belong to this account, and `~/.glasspane` is 0700 —
    /// so the ordinary paths pass and only a genuinely foreign or group-writable
    /// ancestor refuses.
    static func ancestorDefect(for directory: String) -> String? {
        var parent = (directory as NSString).deletingLastPathComponent
        while !parent.isEmpty, parent != "/" {
            var info = stat()
            guard stat(parent, &info) == 0 else {
                let code = errno
                return "cannot examine the ancestor \(parent) of \(directory) (\(String(cString: strerror(code)))) — isolation unproven"
            }
            let fullMode = Int(info.st_mode & 0o7777)
            guard ancestorIsIsolated(
                ownerUID: Int64(info.st_uid), fullMode: fullMode, ourUID: Int64(getuid())
            ) else {
                return "\(parent) — an ancestor of \(directory) — is not isolated (owner uid \(info.st_uid), mode \(String(format: "%04o", fullMode))): whoever owns or can write it can move this socket aside and answer clients that connect by name. Put the state root under a directory this account owns, e.g. --state-dir ~/.glasspane"
            }
            parent = (parent as NSString).deletingLastPathComponent
        }
        return nil
    }

    /// An ancestor is trusted when nobody but this account (or root, for the
    /// system levels of the path) can create names in it. World/group-writable is
    /// still acceptable with the sticky bit set — that is `/tmp`, where the sticky
    /// flag is exactly what stops another account from renaming my directory away.
    static func ancestorIsIsolated(ownerUID: Int64, fullMode: Int, ourUID: Int64) -> Bool {
        let writableByOthers = (fullMode & 0o022) != 0
        let sticky = (fullMode & 0o1000) != 0
        if writableByOthers && !sticky { return false }
        return ownerUID == ourUID || ownerUID == 0
    }
}
