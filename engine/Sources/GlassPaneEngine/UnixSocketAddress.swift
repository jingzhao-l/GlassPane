import Foundation

// MARK: - Unix socket address capacity

/// `sockaddr_un` 的构造，带**真实**的容量判定。
///
/// 从前 bind/connect 四处都是同一段代码：`strncpy` 拷进 `sun_path`，然后检查
/// "拷没拷成功"——而 `strncpy` 对超长输入是**静默截断**并返回目标指针，那个检查
/// 于是恒为真。后果分两条路：
///  - `bind`：在一个被截短的名字上绑定成功，接着 `chmod(socketPath)` 打的是调用方
///    给的那个全名（ENOENT），`unlink` 又删了个不存在的名字——截短出来的那个套接字
///    文件留在盘上，而 `SocketErrorResponse.invalidPath`（"too long or invalid"）
///    在它自己注释所说的场景里永远走不到；
///  - `connect`：连到截短名，报"没有监听者"，而真名上确实有一个。
///
/// 装不下就回 nil，由调用方走它本来就写好的那条拒绝路径。
enum UnixSocketAddress {

    /// `sun_path` 能放多少字节（含结尾 NUL）。macOS 上是 104。
    static var capacity: Int {
        let probe = sockaddr_un()
        return MemoryLayout.size(ofValue: probe.sun_path)
    }

    /// 这个名字能不能原样放进 `sun_path`：长度要留出终结符，且不能带 NUL
    /// （带 NUL 的名字到了 C 字符串里就短了，那是同一种"静默换一个名字"）。
    static func fits(_ path: String) -> Bool {
        path.utf8.count < capacity && !path.utf8.contains(0)
    }

    /// 装得下、且写回读确认落的是同一个名字，才给地址。
    static func address(for path: String) -> sockaddr_un? {
        guard fits(path) else { return nil }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        path.withCString { source in
            withUnsafeMutableBytes(of: &address.sun_path) { destination in
                guard let base = destination.baseAddress else { return }
                _ = strncpy(base.assumingMemoryBound(to: CChar.self), source, destination.count)
            }
        }
        // 写回读：判定不能只凭"我拷进去了"，要看槽里现在装的到底是不是那个名字。
        let stored = withUnsafeBytes(of: &address.sun_path) { raw in
            String(decoding: raw.prefix(while: { $0 != 0 }), as: UTF8.self)
        }
        return stored == path ? address : nil
    }
}
