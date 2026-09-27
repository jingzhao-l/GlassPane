import Foundation
import GlassPaneEngine

/// 更新页的**判定层**：把更新器回的那一行 JSON 折算成三件事——现在是什么状态、
/// 哪两个按钮能点、点下去该发哪条子命令。
///
/// 这里不下载、不校验、不换版、不重启后台服务：那四件事只在
/// `node <updaterCli> <子命令>` 里实现一次，面板只是它的第二个入口。
/// 「安装更新」按钮尤其不碰后台服务——换版后的重启由更新器自己在它判断
/// 空闲之后做，面板抢着重启会打断用户眼前正在执行的动作。
///
/// 全部是纯函数（输入状态文档 + 当下时刻，输出文案与开关），所以能在
/// `engine/Tests/GlassPaneEngineTests/UpdatePanelTests.swift` 里被直接验红。
enum UpdatePanel {

    // MARK: - 封闭枚举

    /// 更新器 `status` 的封闭枚举（与 `updater/lib/codes.js` 的 `STATUSES` 一一对应）。
    ///
    /// 面板按它决定按钮的开关，所以**读不认识的成员就等于读不到状态**，
    /// 绝不猜一个最近的成员顶上——猜错的按钮会替用户点掉一次换版。
    enum Status: String, CaseIterable {
        case upToDate = "up-to-date"
        case available
        case staged
        case applied
        case deferred
        case needsConsent = "needs-consent"
        case checkOverdue = "check-overdue"
        case rolledBack = "rolled-back"
        case checkFailed = "check-failed"
        case stagedBuildFailed = "staged-build-failed"
        case applyFailed = "apply-failed"
        case rollbackFailed = "rollback-failed"
        case disabled
        case installerPointerStale = "installer-pointer-stale"

        /// 只认得封闭枚举里的写法；其余一律 nil（由调用方折算成"读不到"）。
        static func parse(_ raw: String?) -> Status? {
            guard let raw, !raw.isEmpty else { return nil }
            return Status(rawValue: raw)
        }

        /// 状态行上的人话（枚举原值另以标签呈现，供人与日志核对）。
        var caption: String {
            switch self {
            case .upToDate: return "已是最新版本"
            case .available: return "有新版本可用"
            case .staged: return "新版本已下载并校验通过，可以安装"
            case .applied: return "刚安装完成"
            case .deferred: return "这次没有安装，稍后再试"
            case .needsConsent: return "这个新版本要你亲自确认"
            case .checkOverdue: return "检查已过期，还不知道有没有新版本"
            case .rolledBack: return "新版本装过但没通过自检，已退回原版本"
            case .checkFailed: return "上次检查没成功"
            case .stagedBuildFailed: return "新版本没能准备好"
            case .applyFailed: return "更新中途失败"
            case .rollbackFailed: return "更新中断，且没能自动退回原版本"
            case .disabled: return "自动更新已关闭"
            case .installerPointerStale: return "没找到可用的更新器"
            }
        }

        /// 这个结论需不需要用户现在做点什么（决定状态行的强调色）。
        var needsAttention: Bool {
            switch self {
            case .available, .staged, .needsConsent, .checkOverdue, .rolledBack,
                 .checkFailed, .stagedBuildFailed, .applyFailed,
                 .rollbackFailed, .installerPointerStale:
                return true
            case .upToDate, .applied, .deferred, .disabled:
                return false
            }
        }
    }

    // MARK: - 读不出来的那几种原因

    /// 一次读取的失败方式。**每一种都有自己的文案**，不折算成"一切正常"。
    enum ReadFailure: Error, Equatable {
        /// stdout 里不是那一行能读的 JSON。
        case unreadable
        /// 没有安装记录（`<状态根>/update-install.json` 不在）。
        case missingPointer
        /// 安装记录在，但它指的更新器脚本已经不在盘上。
        case stalePointer(path: String)
        /// 安装记录读不出内容，或没写出脚本路径。
        case unreadablePointer
        /// 这台机器上找不到能跑更新器的 node 程序。
        case nodeMissing
        /// 子进程起来了但没在时限内回话。
        case timedOut
        /// 子进程压根起不来。
        case launchFailed
    }

    /// 呈现给用户的失败原因（含按钮不可用的理由）。
    static func failureText(_ failure: ReadFailure) -> String {
        switch failure {
        case .unreadable:
            return unreadableText
        case .missingPointer:
            return "没有记录到 GlassPane 更新器的安装位置（installer-pointer-stale）。请重新运行安装程序装一次 GlassPane，再回这一页看。"
        case .stalePointer(let path):
            return "安装记录指向 \(path)，可那个文件已经不在了（installer-pointer-stale）。请重新运行安装程序装一次 GlassPane，再回这一页看。"
        case .unreadablePointer:
            return "安装记录读不出更新器的位置（installer-pointer-stale）。请重新运行安装程序装一次 GlassPane，再回这一页看。"
        case .nodeMissing:
            return "这台机器上找不到运行更新器所需的 node，检查与安装都跑不起来。装好 node 后重新运行安装程序，再回这一页看。"
        case .timedOut:
            return "更新器没有按时回话，这一轮的结论没读到。可以再点一次「立即检查」。"
        case .launchFailed:
            return "没能启动更新器，这一轮的结论没读到。可以再点一次「立即检查」。"
        }
    }

    /// 规格要的那句原话：解析不出来时显示它，而不是显示成功。
    static let unreadableText = "读不到更新状态"

    /// 重装指引（指针失效时与状态行同时呈现，不留"看起来一切正常"的余地）。
    static let reinstallText = "请重新运行安装程序装一次 GlassPane。"

    // MARK: - 状态文档的投影

    /// 面板真正用到的那几个字段（读不到的一律 nil，由文案层如实说"没读到"）。
    struct Snapshot: Equatable {
        /// 更新器那一行给的结论状态（未经过期判定加成）。
        var reportedStatus: Status? = nil
        /// 状态文档里存着的上一次结论。
        var storedStatus: Status? = nil
        var code: String? = nil
        var current: String? = nil
        var latest: String? = nil
        var lastCheckAt: String? = nil
        var stagedVersion: String? = nil
        var stagedDigest: String? = nil
        var lastErrorCode: String? = nil
        /// `lastError.message` 的原话——失败时面板**逐字**显示它。
        var lastErrorMessage: String? = nil
        /// 这一条命令自己给的句子（可能为 nil）。
        var commandMessage: String? = nil
        var disabled: Bool = false
        var autoApply: Bool = false
        /// 子进程退出码（0/2/3/4/5）；没读到为 nil。
        var exitCode: Int? = nil
        var command: String? = nil
    }

    // MARK: - 解析

    /// 一行 JSON → 状态投影。任何读不出来的输入都回 `.failure(.unreadable)`。
    static func parseLine(_ stdout: String) -> Result<Snapshot, ReadFailure> {
        let candidates = stdout
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        // 契约是"恰好一行"。多出来的行只能是噪声：取最后一行，
        // 但绝不在**没有**一行时假装读到了什么。
        guard let line = candidates.last else { return .failure(.unreadable) }
        guard let data = line.data(using: .utf8),
              let document = try? JSONDecoder().decode(UpdaterLine.self, from: data) else {
            return .failure(.unreadable)
        }
        let state = document.state
        // 顶层 status 是这一条命令的结论；空对象（`state` 缺失）时仍能读到它。
        let reported = Status.parse(document.status)
        let stored = Status.parse(state?.status)
        if document.status != nil && reported == nil { return .failure(.unreadable) }
        if state?.status != nil && stored == nil { return .failure(.unreadable) }
        return .success(Snapshot(
            reportedStatus: reported ?? stored,
            storedStatus: stored,
            code: document.code ?? state?.code,
            current: state?.current,
            latest: state?.latest,
            lastCheckAt: state?.lastCheckAt,
            stagedVersion: state?.staged?.version,
            stagedDigest: state?.staged?.digest,
            lastErrorCode: state?.lastError?.code,
            lastErrorMessage: state?.lastError?.message,
            commandMessage: document.message,
            disabled: state?.disabled == true,
            autoApply: state?.autoApply == true,
            exitCode: document.exitCode,
            command: document.command
        ))
    }

    /// 安装记录（`update-install.json`）→ 能不能用它、用的话脚本在哪。
    enum PointerRead: Equatable {
        case ready(cliPath: String)
        case failed(ReadFailure)

        var cliPath: String? {
            if case .ready(let path) = self { return path }
            return nil
        }

        var isReady: Bool { cliPath != nil }

        var failure: ReadFailure? {
            if case .failed(let reason) = self { return reason }
            return nil
        }
    }

    /// 纯函数形态的指针判读：把"文件内容"与"脚本在不在盘上"当参数传进来，
    /// 这样缺指针与指针悬空两种情况都能被单测打到，不必碰真盘。
    static func readPointer(json: String?, cliExists: (String) -> Bool) -> PointerRead {
        // 文件不在与文件在读不出内容，是两件不同的事：前者是"从没装过/装到了
        // 别处"，后者是"装过但这份记录坏了"。两句话都得说重装，但不能混。
        guard let json else { return .failed(.missingPointer) }
        guard let data = json.data(using: .utf8),
              let pointer = try? JSONDecoder().decode(InstallerPointer.self, from: data),
              let raw = pointer.updaterCli, !raw.trimmingCharacters(in: .whitespaces).isEmpty else {
            return .failed(.unreadablePointer)
        }
        let path = (raw as NSString).expandingTildeInPath
        guard cliExists(path) else { return .failed(.stalePointer(path: path)) }
        return .ready(cliPath: path)
    }

    // MARK: - 过期判定

    /// 「固定时间到点但那台电脑是关的」的兜底阈值：36 小时。
    static let overdueThreshold: TimeInterval = 36 * 60 * 60

    /// 距上次检查是否已超过阈值。**从没检查过也算过期**——那正是这一页要
    /// 把人叫回来的情形。自动更新关闭时不做过期判定（没有定时任务可过期），
    /// 与更新器自身的口径保持一致，两处不得给出两个答案。
    static func isCheckOverdue(lastCheckAt: String?, now: Date, disabled: Bool = false) -> Bool {
        if disabled { return false }
        guard let stamp = date(from: lastCheckAt) else { return true }
        return now.timeIntervalSince(stamp) > overdueThreshold
    }

    /// 检查距今多久（给人看的相对时间；读不出时刻就说"从没检查过"）。
    static func checkAgeText(lastCheckAt: String?, now: Date) -> String {
        guard let stamp = date(from: lastCheckAt) else { return "从没检查过" }
        let seconds = max(0, now.timeIntervalSince(stamp))
        if seconds < 60 { return "就在刚刚" }
        if seconds < 60 * 60 { return "\(Int(seconds / 60)) 分钟前" }
        if seconds < 24 * 60 * 60 { return "\(Int(seconds / 3600)) 小时前" }
        return "\(Int(seconds / 86_400)) 天前"
    }

    /// 面板显示用的状态：更新器给的那一个，外加过期的加成。
    ///
    /// 与更新器 `effectiveStatus` 同一套规则：只有"上一次确实没什么可做的"
    /// 那几种结论（已是最新 / 刚装好 / 什么都没记着）会被换成"检查已过期"；
    /// 手上还有一份待装版本、或者上一次是被拒的，那些结论必须留着——
    /// 把它们盖掉就等于把按钮为什么不可用的原因一起盖掉了。
    static func effectiveStatus(_ snapshot: Snapshot?, now: Date) -> Status? {
        guard let snapshot else { return nil }
        let stored = snapshot.reportedStatus ?? snapshot.storedStatus
        let replaceable: [Status?] = [.upToDate, .applied, nil]
        guard replaceable.contains(stored) else { return stored }
        if snapshot.disabled { return .disabled }
        if isCheckOverdue(lastCheckAt: snapshot.lastCheckAt, now: now) { return .checkOverdue }
        return stored ?? .checkOverdue
    }

    // MARK: - 按钮开关

    /// 决定两个按钮与开关时用到的全部输入（值类型，便于逐成员列表测试）。
    struct ButtonContext: Equatable {
        var status: Status?
        var hasStagedOffer: Bool
        var exitCode: Int?
        var current: String?
        var stagedVersion: String?
        var isRunning: Bool
        var pointerReady: Bool
        var now: Date

        static func reading(_ status: Status?, staged: Bool = false, exitCode: Int? = nil,
                            current: String? = nil, stagedVersion: String? = nil,
                            running: Bool = false, pointerReady: Bool = true,
                            now: Date = Date(timeIntervalSince1970: 0)) -> ButtonContext {
            ButtonContext(status: status, hasStagedOffer: staged, exitCode: exitCode,
                          current: current, stagedVersion: stagedVersion,
                          isRunning: running, pointerReady: pointerReady, now: now)
        }
    }

    struct Buttons: Equatable {
        var checkEnabled: Bool
        var checkReason: String?
        var applyEnabled: Bool
        var applyReason: String?
        var toggleEnabled: Bool
        var toggleReason: String?
        /// 「安装更新」这一次要额外带的参数（确认跨大版本时是 `--consent major`）。
        var applyArguments: [String]
    }

    static let runningText = "上一个操作还在进行，等它结束再点。"

    /// 按钮开关的唯一实现：不可用是**带着理由的禁用**，不是把按钮藏掉。
    static func buttons(for ctx: ButtonContext) -> Buttons {
        if ctx.isRunning {
            return Buttons(checkEnabled: false, checkReason: runningText,
                           applyEnabled: false, applyReason: runningText,
                           toggleEnabled: false, toggleReason: runningText,
                           applyArguments: [])
        }
        if !ctx.pointerReady || ctx.status == .installerPointerStale {
            // 找不到更新器时两个按钮都没有意义：按下也不会发生任何事，
            // 所以禁用 + 给出重装这句话，而不是让它看起来能点。
            let reason = "没有找到可用的更新器（installer-pointer-stale）。" + reinstallText
            return Buttons(checkEnabled: false, checkReason: reason,
                           applyEnabled: false, applyReason: reason,
                           toggleEnabled: false, toggleReason: reason,
                           applyArguments: [])
        }
        guard let status = ctx.status else {
            return Buttons(checkEnabled: true, checkReason: nil,
                           applyEnabled: false, applyReason: "还没读到更新状态：先点「立即检查」。",
                           toggleEnabled: true, toggleReason: nil,
                           applyArguments: [])
        }
        let staged = ctx.hasStagedOffer
        let retryCheck = "先点「立即检查」拿到新版本，再装。"
        switch status {
        case .available, .staged:
            return Buttons(checkEnabled: true, checkReason: nil,
                           applyEnabled: true, applyReason: nil,
                           toggleEnabled: true, toggleReason: nil,
                           applyArguments: [])
        case .deferred, .rolledBack, .checkFailed, .disabled:
            // 手上确实有一份校验过的版本时，这几个状态下都值得再按一次。
            return Buttons(checkEnabled: true, checkReason: nil,
                           applyEnabled: staged,
                           applyReason: staged ? nil : retryCheck,
                           toggleEnabled: true, toggleReason: nil,
                           applyArguments: [])
        case .needsConsent:
            // 跨大版本永不自动应用：必须由人按下这个按钮，所以按钮按下即确认。
            let major = isMajorBump(current: ctx.current, candidate: ctx.stagedVersion)
            return Buttons(checkEnabled: true, checkReason: nil,
                           applyEnabled: staged && major,
                           applyReason: staged && major ? nil
                               : "这个新版本要你确认后才会安装，请先点「立即检查」。",
                           toggleEnabled: true, toggleReason: nil,
                           applyArguments: (staged && major) ? ["--consent", "major"] : [])
        case .upToDate, .applied:
            return Buttons(checkEnabled: true, checkReason: nil,
                           applyEnabled: false, applyReason: "现在没有要装的新版本。",
                           toggleEnabled: true, toggleReason: nil,
                           applyArguments: [])
        case .checkOverdue:
            return Buttons(checkEnabled: true, checkReason: nil,
                           applyEnabled: false, applyReason: retryCheck,
                           toggleEnabled: true, toggleReason: nil,
                           applyArguments: [])
        case .stagedBuildFailed:
            return Buttons(checkEnabled: true, checkReason: nil,
                           applyEnabled: false,
                           applyReason: "上一次没能把新版本准备好，先重新检查一次。",
                           toggleEnabled: true, toggleReason: nil,
                           applyArguments: [])
        case .applyFailed:
            // 退出码 5 表示连自动退回都没成：这时候不能再按安装。
            let manual = ctx.exitCode == 5
            return Buttons(checkEnabled: true, checkReason: nil,
                           applyEnabled: staged && !manual,
                           applyReason: (staged && !manual) ? nil
                               : "这台机器的安装状态不确定，需要人工重新安装。",
                           toggleEnabled: true, toggleReason: nil,
                           applyArguments: [])
        case .rollbackFailed:
            return Buttons(checkEnabled: true, checkReason: nil,
                           applyEnabled: false,
                           applyReason: "自动退回没成功，请先人工重新安装，再谈更新。",
                           toggleEnabled: true, toggleReason: nil,
                           applyArguments: [])
        case .installerPointerStale:
            break  // 上面已处理，这里只为让 switch 覆盖封闭枚举。
        }
        return Buttons(checkEnabled: true, checkReason: nil,
                       applyEnabled: false, applyReason: retryCheck,
                       toggleEnabled: true, toggleReason: nil, applyArguments: [])
    }

    /// 候选版本是不是跨大版本（读不出版本号时按"不是"处理：宁可少确认一次）。
    static func isMajorBump(current: String?, candidate: String?) -> Bool {
        guard let current, let candidate,
              let lhs = versionTriple(current), let rhs = versionTriple(candidate) else {
            return false
        }
        return rhs.major > lhs.major
    }

    private static func versionTriple(_ raw: String) -> (major: Int, minor: Int, patch: Int)? {
        let parts = raw.trimmingCharacters(in: .whitespaces)
            .replacingOccurrences(of: "v", with: "")
            .split(separator: ".")
            .compactMap { Int($0) }
        guard parts.count >= 2 else { return nil }
        return (parts[0], parts[1], parts.count > 2 ? parts[2] : 0)
    }

    // MARK: - 行文案

    /// 状态行下面那一句"该做什么"。过期时它必须是可动作的提示，
    /// 因为固定时间那一下很可能机器就是关着的。
    static func promptText(snapshot: Snapshot?, status: Status?, now: Date) -> String? {
        guard let snapshot else { return nil }
        if status == .checkOverdue {
            return "到了该检查的时候没检查成（上次检查：\(checkAgeText(lastCheckAt: snapshot.lastCheckAt, now: now))）。"
                + "现在有「立即检查」可以马上问一次有没有新版本。"
        }
        if snapshot.disabled {
            return "自动更新已关闭（上次检查：\(checkAgeText(lastCheckAt: snapshot.lastCheckAt, now: now))）。"
                + "「立即检查」与「安装更新」仍然可以手动用。"
        }
        if status == .staged || status == .available {
            let version = snapshot.stagedVersion ?? snapshot.latest ?? "新版本"
            return "\(version) 已经备好，点「安装更新」就会在你的后台服务空闲时换上。"
        }
        if status == .needsConsent {
            let version = snapshot.stagedVersion ?? snapshot.latest ?? "新版本"
            return "\(version) 是跨大版本升级，可能改变对外行为，点「安装更新」才装。"
        }
        return nil
    }

    /// 失败/拒绝时要**逐字**显示的那句话：优先 `lastError.message`，
    /// 其次这一条命令自己的句子。两者都没有才用状态行兜底。
    static func errorText(snapshot: Snapshot?) -> String? {
        guard let snapshot else { return nil }
        if let message = snapshot.lastErrorMessage, !message.isEmpty { return message }
        if let message = snapshot.commandMessage, !message.isEmpty { return message }
        return nil
    }

    /// 「自动更新」开关的显示值：**永远来自盘上的 `disabled`**，不是点下去时
    /// 猜的那个方向。连一份状态都没读到时为 nil（这一页不假称它是开着的）。
    static func autoUpdateOn(_ snapshot: Snapshot?) -> Bool? {
        guard let snapshot else { return nil }
        return snapshot.disabled != true
    }

    /// 上一次检查的时间（读不出就明说读不出，绝不编一个）。
    static func lastCheckText(_ snapshot: Snapshot?, now: Date) -> String {
        guard let snapshot else { return "读不到" }
        guard let stamp = snapshot.lastCheckAt else { return "从没检查过（\(checkAgeText(lastCheckAt: nil, now: now))）" }
        return "\(ConsoleTheme.timestamp(stamp))（\(checkAgeText(lastCheckAt: stamp, now: now))）"
    }

    static func date(from iso: String?) -> Date? {
        guard let iso, !iso.isEmpty else { return nil }
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let parsed = withFraction.date(from: iso) { return parsed }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: iso)
    }

    // MARK: - node 与状态根

    /// 状态根：与更新器同一优先级（环境变量 → 家目录下的默认根）。
    static func stateRoot(env: [String: String] = ProcessInfo.processInfo.environment,
                          home: String = NSHomeDirectory()) -> String {
        if let named = env["GLASSPANE_STATE_DIR"], !named.trimmingCharacters(in: .whitespaces).isEmpty {
            return tildeExpanded(named, home: home)
        }
        return StateRoot.homeDefault().path
    }

    /// `~/…` 按注入的家目录展开（不注入时才是进程自己的那个家）。
    private static func tildeExpanded(_ path: String, home: String) -> String {
        let trimmed = path.trimmingCharacters(in: .whitespaces)
        if trimmed == "~" { return home }
        if trimmed.hasPrefix("~/") { return home + String(trimmed.dropFirst()) }
        return trimmed
    }

    /// 装更新器时写下的那份指针的文件名（与更新器读的是同一份）。
    static let pointerFileName = "update-install.json"

    static func pointerFile(stateRoot: String) -> String {
        stateRoot.hasSuffix("/")
            ? stateRoot + pointerFileName
            : stateRoot + "/" + pointerFileName
    }

    /// 能跑更新器的 node：显式指定的优先，其次 PATH，最后是几个常见安装位置。
    ///
    /// 面板是 launchd 起界面的进程，环境里的 PATH 比登录 shell 短得多，
    /// 所以只查 `which node` 会稳定地找不到——这里把常见位置写死一遍，
    /// 找不到就如实报 nodeMissing，而不是发一条起不来的命令再显示成功。
    static func nodeCandidates(env: [String: String] = ProcessInfo.processInfo.environment,
                               home: String = NSHomeDirectory()) -> [String] {
        var candidates: [String] = []
        if let named = env["GLASSPANE_NODE_BIN"], !named.trimmingCharacters(in: .whitespaces).isEmpty {
            candidates.append(tildeExpanded(named, home: home))
        }
        if let path = env["PATH"] {
            candidates += path.split(separator: ":")
                .filter { !$0.isEmpty }
                .map { ($0 as NSString).appendingPathComponent("node") }
        }
        candidates += [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "\(home)/.volta/bin/node",
            "\(home)/.asdf/shims/node",
            "\(home)/.nvm/current/bin/node",
            "/usr/bin/node",
        ]
        var seen = Set<String>()
        return candidates.filter { seen.insert($0).inserted }
    }

    /// 纯形态的 node 选址：把"在不在盘上"当参数注入，便于测试两种答案。
    static func resolveNode(candidates: [String], exists: (String) -> Bool) -> String? {
        candidates.first(where: exists)
    }
}

// MARK: - 更新器那一行 JSON 的形状

/// `node <updaterCli> <子命令> --json` 的 stdout：**恰好一行**，
/// 外层是这条命令的结论，`state` 里是 `<状态根>/update-state.json` 的同一份文档。
private struct UpdaterLine: Decodable {
    let command: String?
    let status: String?
    let code: String?
    let exitCode: Int?
    let ok: Bool?
    let message: String?
    let reason: String?
    let state: UpdaterState?
}

/// 状态文档里面板要读的那几个字段（其余字段忽略；缺的都显示为"读不到"）。
private struct UpdaterState: Decodable {
    struct Staged: Decodable {
        let version: String?
        let dir: String?
        let digest: String?
        let at: String?
    }

    struct LastError: Decodable {
        let code: String?
        let message: String?
        let at: String?
    }

    let status: String?
    let code: String?
    let current: String?
    let latest: String?
    let lastCheckAt: String?
    let disabled: Bool?
    let autoApply: Bool?
    let staged: Staged?
    let lastError: LastError?
}

/// 安装器写的指针 `<状态根>/update-install.json`：面板只从它取更新器的位置。
private struct InstallerPointer: Decodable {
    let updaterCli: String?
    let installRoot: String?
    let agentLabel: String?
    let registeredAt: String?
}
