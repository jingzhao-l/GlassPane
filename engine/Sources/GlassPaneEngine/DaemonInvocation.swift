import Foundation

/// 出路句子交给读者的那一条 **daemon 命令**，必须是一个可以直接粘进 shell 的词。
///
/// 缺陷一（2026-11-03 记账）：`glasspaned` 不在 PATH 上（实测 `command -v glasspaned` 无输出，
/// 且没有任何 npm 包声明这个 `bin`），而三十多处 remedy/advice/print 仍印裸名 `glasspaned --…`。
/// 读者照抄就拿到一次 `command not found`（127）——那句"出路"承诺的正是修复。这一条与
/// 2026-10-31 的 `updater <裸动词>`（70 处、改成 `updater/lib/invocation.js` 一处出口）同一形状。
///
/// 缺陷二（2026-11-04 由门禁抓到，属缺陷一的修法本身）：`Bundle.main.executablePath` 回答的是
/// **"当前这个进程是谁"**，而 `EngineCore` / `PermissionSeatReport` / `LocalArchive` 是被设置面板
/// 当**库**链接的。于是在面板里它给出面板二进制，在 `swift test` 里它给出
/// `/Applications/Xcode.app/Contents/Developer/usr/bin/xctest`——三条 XCTest 用例真变红
/// （`Qoder20261024PermissionSeatReportTests`、`ProjectRegistryTests`、`HumanInterventionAuditTests`）。
/// 把读者领到他刚点过的那个二进制上，那句出路就成了 127 的变种：命令存在、什么也不做。
/// 所以自报只在一个进程真是 daemon 时才作证据，其余调用方一律用在册安装位。
///
/// 为什么回的是**带引号的整个词**而不是光秃秃的路径：交付形态的安装目录叫
/// `GlassPane Daemon.app`——中间那一枚空格会把一条出路劈成两个词，`~/Applications/GlassPane`
/// 后面接什么都是错的。所以取路径与加引号必须在同一个地方做完，分两处写迟早再漂一次。
public enum DaemonInvocation {
    /// daemon 二进制的文件名；`installer/cli.js` 与 `mcp-shell/src/project-registry.ts` 说的是同一个。
    static let daemonBinaryName = "glasspaned"

    /// 与 `installer/cli.js`（安置到 `~/Applications`）/ `mcp-shell` 的在册安装位同一句话。
    public static func installedPath(home: String) -> String {
        "\(home)/Applications/GlassPane Daemon.app/Contents/MacOS/\(daemonBinaryName)"
    }

    /// 这一枚进程的可执行文件路径，**仅当它真是 daemon**（`hasSuffix("/glasspaned")`）才算证据。
    ///
    /// 名字而不是 inode：面板与 daemon 住在同一个 bundle 里，面板自己那条
    /// `Contents/MacOS/glasspane-settings` 永远不匹配这一支，正是这里要的判别。
    static var ownDaemonPathIfThisIsTheDaemon: String? {
        guard let path = Bundle.main.executablePath, !path.isEmpty else { return nil }
        return path.hasSuffix("/\(daemonBinaryName)") ? path : nil
    }

    /// 给读者的那一条命令用的可执行文件位置：daemon 进程自报，其余调用方用在册安装位。
    public static var executableOrInstalledPath: String {
        ownDaemonPathIfThisIsTheDaemon ?? installedPath(home: NSHomeDirectory())
    }

    /// 出路里用的那一串：绝对路径 + 单引号成一个词。
    ///
    /// 引号那一半**不重写**：`RemedyCommand.quote` 是本仓唯一的"把一个值变成 shell 里一个词"的
    /// 出口（`StateRoot.swift`），路径与旗标值都必须经它，否则就是 2026-11-03 #18 记过的
    /// "一条事实两种拼写"。这里只负责"哪一枚值值得被这样拼"。
    public static var command: String { RemedyCommand.quote(executableOrInstalledPath) }
}
