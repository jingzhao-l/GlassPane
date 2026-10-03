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
        /// 这台机器给 node 的那份根证书束的导出记录。nil = 状态里没有这一项，
        /// 或它写着 `null`——两种都是"这份安装从没导出过"，不是"导出成功了"。
        var caRoots: CaRootsRecord? = nil
        /// 更新器自己那份已安装副本有没有跟着这次换版移动的记录。nil = 状态里没有这一项，
        /// 或它写着 `null`——两种都是"这台机器从没记录过更新器自身换过版"，不是"已经换上"。
        var runtime: RuntimeRecord? = nil
    }

    // MARK: - 根证书束的导出记录

    /// `caRoots.status` 的封闭枚举（与 `updater/lib/ca-bundle.js` 的 `CA_STATUSES` 一一对应）。
    ///
    /// 五个成员各自是一个不同的下场，所以各有一句人话；把它们并成"行/不行"两种，
    /// 读的人就只能猜是哪一种，而猜错的那个人会去查网络。
    enum CaRootsStatus: String, CaseIterable {
        case ok
        case empty
        case unavailable
        case writeUnverified = "write-unverified"
        case probeFailed = "probe-failed"

        /// 只认得封闭枚举里的写法；其余一律 nil（由文案层如实说"这一项读不懂"）。
        static func parse(_ raw: String?) -> CaRootsStatus? {
            guard let raw, !raw.isEmpty else { return nil }
            return CaRootsStatus(rawValue: raw)
        }
    }

    /// 那条记录里面板要呈现的部分。`status` 为 nil 而 `rawStatus` 有值 = 写着枚举外的东西。
    struct CaRootsRecord: Equatable {
        var status: CaRootsStatus? = nil
        var rawStatus: String? = nil
        var certificates: Int? = nil
        var path: String? = nil
        var exportedAt: String? = nil
        /// 失败原因原文：必须出现在页面上，不能读进来又丢掉。
        var detail: String? = nil

        /// 只有 `ok` 算可用；其余四态与读不懂都不算。
        var isUsable: Bool { status == .ok }
    }

    // MARK: - 更新器自身的换版记录

    /// `runtime.status` 的封闭枚举（与 `updater/lib/runtime.js` 的 `RUNTIME_STATUSES` 一一对应）。
    ///
    /// 为什么这一项值得单独有一张卡：每天跑检查的那份代码是**安装记录指的那一份**，
    /// 换版换掉的是 `.app` 与 npm 两个包，从不碰它。于是"修好更新器的那次发版"能不能
    /// 送到这台机器上，只看这一项说不说 refreshed。四个成员各自是一个不同的下场，
    /// 把它们并成"行/不行"两种，读的人就只能猜是哪一种。
    enum RuntimeStatus: String, CaseIterable {
        case refreshed
        case failed
        case kept
        case skipped

        /// 只认得封闭枚举里的写法；其余一律 nil（由文案层如实说"这一项读不懂"）。
        static func parse(_ raw: String?) -> RuntimeStatus? {
            guard let raw, !raw.isEmpty else { return nil }
            return RuntimeStatus(rawValue: raw)
        }
    }

    /// 那条记录里面板要呈现的部分。`status` 为 nil 而 `rawStatus` 有值 = 写着枚举外的东西。
    struct RuntimeRecord: Equatable {
        var status: RuntimeStatus? = nil
        var rawStatus: String? = nil
        /// 换到的是哪一个版本；记录没写就是 nil，不编。
        var version: String? = nil
        /// 这份记录说的那一台上真实存在的更新器脚本；nil = 记录没给出路径。
        var cliPath: String? = nil
        /// 换版之前那一份（回退的目标），记录给了才显示。
        var previousCliPath: String? = nil
        /// 只有 `true` 是"在册的定时任务被读回来、里面写的就是这份新脚本"。
        /// false 与没写都算没核对过——`refreshed` 的说法因此不能单独成立。
        var agentVerified: Bool? = nil
        var at: String? = nil
        /// 拦住它的那一道门的稳定代号（`runtime-stale` 这一类）。
        var code: String? = nil
        /// 失败原因原文：必须出现在页面上，不能读进来又丢掉。
        var detail: String? = nil

        /// 只有"换上了"与"在册任务读回来核对过"这一对才算换上；
        /// `kept` 特意不算——那台机器的自动更新是关着的，没有任何任务会去跑它。
        var isUsable: Bool { status == .refreshed && agentVerified == true }
    }

    /// 这一项在页面上要的注意力等级。四种说法各归一类，避免"读不懂"与"没问题"共用一个绿点。
    enum RuntimeAttention: Equatable {
        /// 确实换上了且核对过。
        case confirmed
        /// 按这台机器自己的选择或按流程本来如此（关了自动更新、这一轮没尝试）。
        case informational
        /// 要人做点什么：没换上、说换上但没核对、读不懂、这台机器从没记录过。
        case attention
        /// 连一份状态都没读到，这一项无从判断。
        case unknown
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
            command: document.command,
            // 束的读不懂与状态的读不懂是两件事：这一项读不懂只是这一项没说清，
            // 把整行判成"读不到更新状态"会连带把版本、按钮理由一起丢掉。
            caRoots: state?.caRoots.map { record in
                CaRootsRecord(
                    status: CaRootsStatus.parse(record.status),
                    rawStatus: record.status,
                    certificates: record.certs,
                    path: record.path,
                    exportedAt: record.exportedAt,
                    detail: record.detail
                )
            },
            // 同一套口径：更新器自身的换版读不懂也只是这一项没说清，不作废那一行。
            runtime: state?.runtime.map { record in
                RuntimeRecord(
                    status: RuntimeStatus.parse(record.status),
                    rawStatus: record.status,
                    version: record.version,
                    cliPath: record.cliPath,
                    previousCliPath: record.previousCliPath,
                    agentVerified: record.agentVerified,
                    at: record.at,
                    code: record.code,
                    detail: record.detail
                )
            }
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
        /// 更新器给这一轮结论起的稳定代号（`code`）。`needs-consent` 背后是哪一道门，
        /// 只有它说得清——只看版本差会把"作者身份缺口"当成"跨大版本"处理。
        var code: String?
        var isRunning: Bool
        var pointerReady: Bool
        var now: Date

        static func reading(_ status: Status?, staged: Bool = false, exitCode: Int? = nil,
                            current: String? = nil, stagedVersion: String? = nil,
                            code: String? = nil,
                            running: Bool = false, pointerReady: Bool = true,
                            now: Date = Date(timeIntervalSince1970: 0)) -> ButtonContext {
            ButtonContext(status: status, hasStagedOffer: staged, exitCode: exitCode,
                          current: current, stagedVersion: stagedVersion, code: code,
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
        /// 「信任这个发布并重新检查」：作者身份缺口下唯一做得动的确认动作。
        /// 默认关——只有 `needs-consent` 且门确实是作者身份那一道才开得出来。
        var consentEnabled: Bool = false
        var consentReason: String? = nil
        /// 这一枚按钮要发的那条 `check` 的额外参数（`--consent unsigned-release`）。
        var consentArguments: [String] = []
    }

    // MARK: - `needs-consent` 到底是哪一道门

    /// `needs-consent` 不是一件事，是三件：跨大版本、作者身份没证明、以及面板
    /// 无权代签的那一类（例如后台服务要写别人的状态根）。它们**手上有没有东西可装**
    /// 都不一样：跨大版本那一次检查已经把新版本暂存好了，缺的只是人按下按钮；
    /// 作者身份那一次检查在下载之前就拒了，`staged` 是空的。
    ///
    /// 早先的面板只认第一种，另外两种落进同一分支后「安装更新」被永久禁掉，
    /// 而禁用理由又让用户去点「立即检查」——检查只会原样再拒一次。真机上这台机器
    /// 连着的三次 `check → needs-consent / signature-tool-missing` 就是这个死循环。
    enum ConsentGate: Equatable {
        /// 跨大版本：`apply --consent major`，按下即确认。
        case major
        /// 发布没签名 / 这台机器验不了签名：得先带着确认重跑一次**检查**才会暂存。
        case unsignedRelease
        /// 面板不代签的门，或读不出是哪一道：只能把门说出来，不能给一个按不动的按钮。
        case none
    }

    /// 三道门里面板能代签的那两种，各自要 updater 收下的 `--consent` 取值。
    static let majorConsentArgument = ["--consent", "major"]
    static let unsignedReleaseConsentArgument = ["--consent", "unsigned-release"]

    /// 按更新器写的代号认门；代号缺失时退回版本差判断（读不出版本就当面板无权代签）。
    static func consentGate(code: String?, current: String?, stagedVersion: String?) -> ConsentGate {
        switch code {
        case "release-unsigned", "signature-tool-missing":
            return .unsignedRelease
        case "consent-required":
            return .major
        case .some:
            return .none
        case nil:
            return isMajorBump(current: current, candidate: stagedVersion) ? .major : .none
        }
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
            // 三道门各有各的动作。把它们并成"等跨大版本那一下"，另外两道就只剩
            // 一个永远按不动的按钮，而禁用理由还把用户推回「立即检查」——
            // 检查只会原样再拒一次，这一页就成了死循环。
            switch consentGate(code: ctx.code, current: ctx.current, stagedVersion: ctx.stagedVersion) {
            case .major:
                // 跨大版本永不自动应用：必须由人按下这个按钮，所以按钮按下即确认。
                return Buttons(checkEnabled: true, checkReason: nil,
                               applyEnabled: staged,
                               applyReason: staged ? nil : retryCheck,
                               toggleEnabled: true, toggleReason: nil,
                               applyArguments: staged ? Self.majorConsentArgument : [])
            case .unsignedRelease:
                // 检查在下载之前就拒了，手上没有任何暂存好的版本：`apply` 按不动是对的，
                // 但必须给出做得动的那一枚——带着确认再跑一次检查。
                return Buttons(checkEnabled: true, checkReason: nil,
                               applyEnabled: false,
                               applyReason: "这个发布没有可核验的签名，检查在下载前就停了，所以还没有可装的版本。"
                                   + "要装它，先按下面那枚按钮带着确认重新检查一次。",
                               toggleEnabled: true, toggleReason: nil,
                               applyArguments: [],
                               consentEnabled: true, consentReason: nil,
                               consentArguments: Self.unsignedReleaseConsentArgument)
            case .none:
                // 面板无权代签的那一道（或代号读不出来）：说清是哪一道门，
                // 绝不写"先点「立即检查」"——那正是把人绕回死循环的那半句。
                let which = ctx.code ?? "这一页认不出的代号"
                return Buttons(checkEnabled: true, checkReason: nil,
                               applyEnabled: false,
                               applyReason: "拦住更新的是「\(which)」这一道确认，面板不替它签字。"
                                   + "要看清缺什么、以及怎么把它补上，请跑一次 `updater status` 读更新器那句原话。",
                               toggleEnabled: true, toggleReason: nil,
                               applyArguments: [])
            }
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
            switch consentGate(code: snapshot.code, current: snapshot.current,
                               stagedVersion: snapshot.stagedVersion) {
            case .major:
                return "\(version) 是跨大版本升级，可能改变对外行为，点「安装更新」才装。"
            case .unsignedRelease:
                return "\(version) 没有可核验的签名（\(snapshot.code ?? "作者身份未证明")）。"
                    + "自动更新不会替这个发布签字；你核对过发布页的校验和后，"
                    + "点「信任这个发布并重新检查」才会把它下载并暂存。"
            case .none:
                return "\(version) 停在一道需要你本人判断的确认上（\(snapshot.code ?? "代号未给出")），"
                    + "面板不替它签字。"
            }
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

    /// 被拦截的网络上，这一项没备好意味着什么——四个失败态与"没记录"共用这一句后果，
    /// 省得每一态各说一半、说得还不一样。
    static let caBundleConsequence = "在这台机器的网络被本地代理或企业网关拦下的时候，每一次检查与安装都会连不上发布站点。"

    /// 把「自动更新」开关关掉再打开一次 = 让更新器重跑一遍导出并重新登记定时任务，
    /// 这是这一页上人人做得动的动作；另一条路是重装。前面按语境接"请"或"再"。
    static let caBundleRedo = "重新运行安装程序，或把「自动更新」开关关掉再打开一次，两种都会重新导出这一份。"

    /// 「更新」区里关于这份束的那句人话：**每一态各有一句，每一句都带一个你现在做得动的动作**。
    ///
    /// 记录缺失或写着 `null` 说的是"这台机器没记录过导出"，绝不显示成正常——那正是
    /// "这一页每天看着都在干活，其实一次都没连上发布站点"的形状。
    /// 认不出的取值也只能如实说认不出，不就近映射到 `ok`。
    static func caRootsText(_ snapshot: Snapshot?) -> String {
        guard let snapshot else {
            return "还没读到更新状态，也就读不到这台机器的根证书导出记录。先点「刷新」或「立即检查」读一次。"
        }
        guard let record = snapshot.caRoots else {
            return "这台机器未记录过导出结果（旧安装）：这份安装从没把系统的根证书导给更新器用。"
                + caBundleConsequence + "请" + caBundleRedo
        }
        // 失败原因的原文一个字都不改、也不丢：它是人与代理唯一能拿去接着查的东西。
        let detail = record.detail.flatMap { trimmed($0) }.map { " 更新器那句原话：\($0)" } ?? ""
        switch record.status {
        case .ok:
            let count = record.certificates.map { "共 \($0) 张" } ?? "记录里没写张数"
            let stamp = record.exportedAt.flatMap { trimmed($0) }.map { "，记于 \(ConsoleTheme.timestamp($0))" } ?? ""
            return "面板与定时任务每一次起更新器，都会带上这台机器导出的系统根证书（\(count)\(stamp)）。"
        case .empty:
            return "这台机器导不出任何系统根证书（empty）：导出跑了，一张也没拿到，所以这一份是空的。"
                + caBundleConsequence + "请先确认证书钥匙串读得到，再" + caBundleRedo + detail
        case .unavailable:
            return "这台机器上没有导出系统根证书所需的工具（unavailable），更新器只能带着 node 自带的那份证书束去连，"
                + "而这台机器另外信任的那些根不在里面。" + caBundleConsequence
                + "这一份本机导不出来，所以没有可指的路径；要自己给一份信任的证书束，请在启动更新器之前把它设进 NODE_EXTRA_CA_CERTS。" + detail
        case .writeUnverified:
            return "导出的根证书束写盘之后读回来跟写进去的不一样（write-unverified），这一份没有采信，起更新器时不会带上它。"
                + caBundleConsequence + "请先修好状态目录的权限或腾出空间，再" + caBundleRedo + detail
        case .probeFailed:
            let count = record.certificates.map { "\($0) 张" } ?? "那些"
            return "根证书束已经写好（\(count)），可带着它的更新器仍然连不上发布站点（probe-failed）："
                + "拦这台机器的那一方还没被系统信任，或者网络是真的断了。"
                + "请让管理员把拦截用的那张根证书装进系统钥匙串，或自己指定一份信任的证书束后设进 NODE_EXTRA_CA_CERTS。"
                + detail
        case nil:
            let raw = trimmed(record.rawStatus ?? "") ?? ""
            let written = raw.isEmpty ? "这一项没写是什么状态" : "这一项写着的状态是 \(raw)"
            return "\(written)，这一页认不出来，只能按没备好对待。" + caBundleConsequence + "请" + caBundleRedo + detail
        }
    }

    /// 这一项算不算备好了（呈现用的色调）：**只有 `ok` 算**，其余一律不算。
    static func caRootsIsUsable(_ snapshot: Snapshot?) -> Bool {
        snapshot?.caRoots?.isUsable == true
    }

    // MARK: - 更新器自身那一句人话

    /// 没换上的后果，四个说法共用：这一句说清"这一项跟这台机器每天的动作有什么关系"，
    /// 省得每一态各说一半、说得还不一样。
    ///
    /// 用"可能"不是含糊其辞，是这一句能断言的上限：记录里只有换版的结果，没有那次回退把作业交回去
    /// 了没有（`enable` 跑成、下一步才失败的那一支，在册的恰恰是新那一份）。确切的那半句在更新器
    /// 自己的原话里，页面把它原样附在后面。
    static let runtimeConsequence = "定时检查跑的可能还是旧那一份更新器，"
        + "专门修更新器的那一次发版可能送不到这台机器上。"

    /// 只有重装能做的那一步：重写安装记录并把新那一份代码落地。
    /// 调用处按语境自己接"请"或"再"，与根证书那一卡同一写法。
    static let runtimeReinstall = "重新运行安装程序装一次 GlassPane，它会重写安装记录并把新那一份更新器放到位。"

    /// 这一页做得动的那一步：开关关掉再打开一次 = 让盘上那一份代码自己重新登记定时任务。
    static let runtimeRedoOnThisPage = "把「自动更新」开关关掉再打开一次，让盘上那一份自己重新登记一次定时任务。"

    /// 记录里那份真实的程序位置：**有就说出来，没有就如实说没有**。
    /// 页面上出现一个尖括号模板等于什么也没说（这一条是 1.5.1 那次改版定下的规矩）。
    private static func runtimeCopyClause(_ record: RuntimeRecord) -> String {
        let which = record.version.flatMap { trimmed($0) }.map { "第 \($0) 版的那一份" } ?? "那一份更新器"
        guard let path = record.cliPath.flatMap({ trimmed($0) }) else {
            return "\(which)，记录里没有它的路径"
        }
        return "\(which)，路径是 \(path)"
    }

    /// 换版之前那一份（也是这台机器现在真正在跑的那一份），记录给了才说。
    private static func runtimePreviousClause(_ record: RuntimeRecord) -> String? {
        guard let path = record.previousCliPath.flatMap({ trimmed($0) }) else { return nil }
        return "现在还在跑的是 \(path)。"
    }

    /// 「更新器自身」那一句人话：**每一态各有一句，每一句都带一个做得动的动作**。
    ///
    /// 记录缺失或写着 `null` 说的是"这台机器从没记录过更新器自己换过版"，绝不显示成正常——
    /// 那正是"面板每天都看着在干活，其实跑的一直是装进来那一份"的形状。
    /// 认不出的取值也只能如实说认不出，不就近映射到 `refreshed`。
    /// `refreshed` 还要跟 `agentVerified` 成对才敢说"已换上"：前者是代码说它换了，
    /// 后者是把在册任务读回来核对过，只有核对过才是真的在跑新那一份。
    static func runtimeText(_ snapshot: Snapshot?) -> String {
        guard let snapshot else {
            return "还没读到更新状态，也就读不到这台机器更新器自身的换版记录。先点「刷新」或「立即检查」读一次。"
        }
        guard let record = snapshot.runtime else {
            return "这台机器未记录过更新器自身的换版（旧安装）：这份安装是在这个能力之前装出来的，"
                + "定时任务跑的还是安装那一次留下的那一份更新器，它不会自己换版。"
                + runtimeConsequence + "请" + runtimeReinstall
                + "这一步要人工做一次；做完之后，每一次装成功都会把这一项重新记下来。"
        }
        // 失败原因的原文一个字都不改、也不丢：它是人与代理唯一能拿去接着查的东西。
        let detail = record.detail.flatMap { trimmed($0) }.map { " 更新器那句原话：\($0)" } ?? ""
        let gate = record.code.flatMap { trimmed($0) }.map { "记录里拦住的这一道门是 \($0)。" } ?? ""
        switch record.status {
        case .refreshed:
            if record.isUsable {
                let stamp = record.at.flatMap { trimmed($0) }.map { "，记于 \(ConsoleTheme.timestamp($0))" } ?? ""
                return "更新器自身已换上并核对过（refreshed）：" + runtimeCopyClause(record)
                    + "，在册的定时任务读回来的就是这一份\(stamp)。"
                    + "下一次修更新器的发版会自己送到这台机器上，这一项现在不用管。"
            }
            // 两个字段说的是两件事：代码自己说换好了，和有人把在册任务读回来核对过。
            // 只有成对才敢说"已换上"——这一句里那句肯定的话一次都不出现。
            let missingCheck = record.agentVerified == false
                ? "可它读回来的在册任务写的不是这一份新脚本"
                : "可这份记录没有把在册的定时任务读回来核对过"
            return "这份记录说更新器自身换到了新那一份（refreshed）：" + runtimeCopyClause(record)
                + "，" + missingCheck + "，所以不能说它已经在跑：明天那次检查很可能还是旧那一份，"
                + "修更新器的那一次发版也就还没送到这台机器上。请先" + runtimeRedoOnThisPage
                + "如果还是这一句，请" + runtimeReinstall + detail
        case .failed:
            // 这一句不能断言"在册的定时任务还在跑之前那一份"：记录里只有换版的结果，没有那次回退
            // 是否把作业也交回去的成功——`enable` 已经跑成、之后一步才失败的那一支，在册的恰恰是新
            // 那一份。要说的是这一轮没有把更新器自身换到位，以及怎么做才做得动。
            return "更新装上了，但更新器自身没换上（failed）：" + runtimeCopyClause(record) + "。"
                + (runtimePreviousClause(record) ?? "")
                + "这不是「更新失败」：新版本确实装到这台机器上了，要处理的是下一次跑检查的那份代码。"
                + runtimeConsequence + gate + "请" + runtimeReinstall + detail
        case .kept:
            return "这台机器把自动更新关着（kept）：更新器的代码与安装记录已经移到新那一份（"
                + runtimeCopyClause(record) + "），但没有登记定时任务。"
                + "这是按这台机器的开关做的，不是失败，也不算已经会自己换版——在打开之前它不会自己动。"
                + "要让它自己换版，请把「自动更新」开关打开；先不想打开的话，点「立即检查」手动跑一次，"
                + "用的也是这一份新代码。" + detail
        case .skipped:
            // 这一支从"每次定时换版都欠一次 enable"收窄成了"这台机器欠一次迁移"：代码、指针、还有那个
            // 不随版本变的入口都已就位，缺的只是把在册任务从"按版本点名"换成走那个入口。换过来之后，
            // 往后的换版就只是一次文件写入，不再需要人做这一步——所以这句话必须把"一次"说出来，否则
            // 读者会一直等下一轮同样的交代。
            return "这一轮没有重新登记定时任务（skipped）：定时那一次跑的就是这个作业本身，"
                + "在它里头重新登记会把自己这个作业拆掉，所以这一轮只换了代码与指针，把交接留给下一次 enable。"
                + (record.cliPath.flatMap { trimmed($0) } == nil ? "" : "下一代该跑的那一份已经就位：" + runtimeCopyClause(record) + "。")
                + "这不是失败，但也不能读成这台机器已经在跑新那一份 —— 在册的作业还是按版本点名那一条。"
                + "请把「自动更新」开关关掉再打开一次（那就会跑一次 enable），或者让它在下一次人工安装时接手；"
                + "这一步只做这一次，做完以后换版就不需要再动手。"
                + "如果这台机器翻来覆去只出现这一句，请" + runtimeReinstall + detail
        case nil:
            let raw = trimmed(record.rawStatus ?? "") ?? ""
            let written = raw.isEmpty ? "这一项没写是什么状态" : "这一项写着的状态是 \(raw)"
            return "\(written)，这一页认不出来，只能按没换上对待："
                + "既不能说更新器已经换上，也不能说这次更新失败。"
                + runtimeConsequence + gate + "请" + runtimeReinstall + detail
        }
    }

    /// 这一项在页面上要多少注意力：**只有"换上 + 核对过"是好消息**，
    /// 读不懂与从没记录过都要人做点什么，`kept`/`skipped` 则既不报错也不报功。
    static func runtimeAttention(_ snapshot: Snapshot?) -> RuntimeAttention {
        guard let snapshot else { return .unknown }
        guard let record = snapshot.runtime else { return .attention }
        if record.isUsable { return .confirmed }
        switch record.status {
        case .kept, .skipped:
            return .informational
        case .refreshed, .failed, nil:
            return .attention
        }
    }

    /// 这一项算不算真的换上了（呈现用的色调）：**只有 `refreshed` 且核对过在册任务才算**。
    static func runtimeIsUsable(_ snapshot: Snapshot?) -> Bool {
        snapshot?.runtime?.isUsable == true
    }

    private static func trimmed(_ text: String) -> String? {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return clean.isEmpty ? nil : clean
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
        inStateRoot(stateRoot, pointerFileName)
    }

    /// 状态根下的一个文件：指针与根证书束都从这一处拼，两处不得各写一份斜杠规则。
    private static func inStateRoot(_ stateRoot: String, _ name: String) -> String {
        stateRoot.hasSuffix("/") ? stateRoot + name : stateRoot + "/" + name
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

    // MARK: - 本机给 node 的那份根证书束

    /// 束的文件名：路径永远是「状态根 + 这一个文件名」，与安装器写的、更新器读的是同一个名字。
    static let caBundleFileName = "ca-roots.pem"

    /// node 只在**进程启动那一刻**读这个变量，所以面板必须在起子进程之前把它放进环境里；
    /// 起完了再设、或者设给自己看，都改不了已经跑起来的那一个 node。
    static let extraCaCertsKey = "NODE_EXTRA_CA_CERTS"

    static func caBundleFile(stateRoot: String) -> String {
        inStateRoot(stateRoot, caBundleFileName)
    }

    /// 盘上那一份束对面板而言只有三种下场。判据是**里面有几张证书**，不是文件在不在、
    /// 也不是它多大。
    ///
    /// 为什么空文件也算"不能用"——本机 node v26.4.0 实测：`NODE_EXTRA_CA_CERTS` 指向一份
    /// 0 字节文件时 node 照常启动、照常握手，只是一张额外的根也没加；文件不存在时也只多打
    /// 一行 `Warning: Ignoring extra certs …` 而已，**不会**启动失败。所以危险不是"起不来"，
    /// 而是"看起来做了、其实什么都没做"：被拦截的机器上它的表现与什么都没设一模一样，状态里
    /// 却会记着"束已导出"。一张证书都没有的束不能当证据用。
    enum CaBundleOnDisk: Equatable {
        /// 读不出来：不存在、没权限、或不是文本。三种都对面板是同一个结论——不能交给 node。
        case absent
        /// 文件在、读得出来，但一张证书也没有。
        case empty(path: String)
        case usable(path: String, certificates: Int)
    }

    private static let certificateMarker = "-----BEGIN CERTIFICATE-----"

    /// 判读本身（纯函数）：交进来的文本读不出来就是 `.absent`，读得出来就数证书。
    static func judgeCaBundle(path: String, text: String?) -> CaBundleOnDisk {
        guard let text else { return .absent }
        let certificates = text.components(separatedBy: certificateMarker).count - 1
        return certificates > 0 ? .usable(path: path, certificates: certificates) : .empty(path: path)
    }

    /// 真盘版：读不出内容时落成 `.absent`——那不是"没有失败"，是"这一份交不出去"，
    /// 结论照旧可见（面板因此不会带上它），只是不存在与读不懂要面板替用户区分也没有意义。
    static func inspectCaBundle(at path: String) -> CaBundleOnDisk {
        do {
            return judgeCaBundle(path: path, text: try String(contentsOfFile: path, encoding: .utf8))
        } catch {
            return .absent
        }
    }

    /// 起更新器子进程用的环境：**束能用才带上那个键**。
    ///
    /// 束不在或空着时返回的就是原环境——**不设**与**设成空串**不是同一件事，但原因不是"空串会
    /// 让 node 崩"（实测 v26.4.0：空值与没设表现一致，都不影响启动）。区别在继承：从终端把变量
    /// 带进来的人那份会被空串**静默覆盖掉**，而那正是操作者自己给的信任。所以这里宁可不写这个键，
    /// 也不写一个空值去"表示没有"。
    /// 反过来，从终端把变量带进来的人那份也不被删掉：那份信任是操作者自己给的，
    /// 面板没有资格替他取消。
    static func caBundleEnvironment(base: [String: String], bundle: CaBundleOnDisk) -> [String: String] {
        guard case .usable(let path, let certificates) = bundle, certificates > 0 else { return base }
        var env = base
        env[extraCaCertsKey] = path
        return env
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

    /// 这台机器给 node 的那份根证书束的导出记录（`caRoots`，可为 `null`）。
    /// `certs` 是张数、`detail` 是失败原因原文——两者都要能被看见。
    struct CaRoots: Decodable {
        let status: String?
        let certs: Int?
        let path: String?
        let exportedAt: String?
        let detail: String?
    }

    /// 更新器自己那份已安装副本的换版记录（`runtime`，可为 `null`）。
    /// 八个键与状态文件的 schema 一一对应；缺的都显示为"记录里没写"，不猜。
    struct Runtime: Decodable {
        let status: String?
        let version: String?
        let cliPath: String?
        let previousCliPath: String?
        let agentVerified: Bool?
        let at: String?
        let code: String?
        let detail: String?
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
    let caRoots: CaRoots?
    let runtime: Runtime?
}

/// 安装器写的指针 `<状态根>/update-install.json`：面板只从它取更新器的位置。
private struct InstallerPointer: Decodable {
    let updaterCli: String?
    let installRoot: String?
    let agentLabel: String?
    let registeredAt: String?
}
