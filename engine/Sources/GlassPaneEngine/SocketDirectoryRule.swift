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
            return "\(directory) is not a directory (mode \(String(format: "%04o", Int(info.st_mode & 0o777))))"
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
