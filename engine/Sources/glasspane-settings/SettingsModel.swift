import SwiftUI
import GlassPaneEngine

/// 设置面板状态模型：聚合 **daemon 自报**的四类权限席位与 daemon 探测，提供
/// 快照供 UI 渲染（P1 spec v1.2 §11.2 权限主体修正）。
///
/// 关键约束：TCC 席位按「每个进程身份」记账，因此
///  - 状态真源是 daemon 自己（经 `hello` 的 `permissions` 字段上报），面板
///    **不代测**——面板进程被授权不等于 daemon 被授权；daemon 未运行或为不上报
///    该字段的旧版本时，卡片如实显示"未验证"；
///  - 申请动作由 daemon 以自身身份发起（`launchctl submit` 起一过性任务，
///    避免面板成为责任父进程而把席位记到面板 app 头上）；
///  - 面板仍负责打开系统设置深链与文案引导，勾选由用户在系统面板完成。
///
/// 状态判定全部在 engine 库探针层，本层仅做编排与缓存
/// （P1 spec v1.2 §9.3：SwiftUI 壳不做逻辑单测）。
@MainActor
final class SettingsModel: ObservableObject {

    /// 单权限条目（供卡片渲染）。
    struct PermissionEntry: Identifiable {
        let kind: PermissionKind
        let descriptor: PermissionDescriptor
        var status: PermissionStatus
        /// 状态来源说明（daemon 自报 / daemon 未运行 / 旧 daemon 不上报）。
        var statusNote: String?
        var id: PermissionKind { kind }
    }

    /// 后台服务存活的**实测**结局，唯一来源是一次 hello 握手（`DaemonProbe.liveness`）。
    ///
    /// 从前这里是一个 `reachable: Bool`，而它的取数是"socket 文件在不在"——崩掉的
    /// 服务会把文件留在那儿，于是页脚顶着绿点写"运行中"，同一页四张权限卡同时说
    /// 服务没在运行。socket 在不在从来不是存活判据；"有人接了连接却不开口"也不是
    /// "运行中"，更不是"未运行"，所以它有自己的一个成员。
    enum DaemonLiveness: Equatable {
        /// 还没实测过（面板刚起来、一次握手都还没跑）：不点亮也不熄灭。
        case unmeasured
        /// 它回了合规的 hello——这一枚绿点背后有一次真实测量。
        case answering
        /// 那个名字后面没有监听者（文件不在、没人接这个连接）。
        case notRunning
        /// 连接建好了却没有回话（或回来的不是 hello）：占着门的那个进程不应门。
        case presentButSilent(reason: String)
    }

    /// daemon 状态卡内容。
    struct DaemonEntry {
        var socketPath: String
        /// 存活判定：只有实测到 hello 回话才是 `.answering`。
        var liveness: DaemonLiveness
        var version: String?
        var protocolVersion: String?
        var pid: Int?
        /// daemon 自报的授权主体（nil = 未连上或旧 daemon 不上报）。
        var subject: PermissionSubject?
        /// daemon 自报的状态根（`hello.stateRoot`）。nil 是"这一帧没上报"，
        /// 不是"没有根"——面板不许拿自己这一侧的根去替它填。
        var stateRoot: String?
        /// daemon 自报的"台账最近一次追加没落盘"（`hello.approvalPersistFailed`）。
        /// 只有正在服务的实例能知道这件事：`--approval-verify` 是一次性读文件，
        /// 它自己永远不会有这个字段。
        var approvalPersistFailed: String?
    }

    @Published var entries: [PermissionEntry] = []
    @Published var daemon: DaemonEntry
    @Published var isRefreshing = false
    /// 面板探的那一个名字是哪一级定下来的（显式 → `GLASSPANE_ENGINE_SOCK` → 点名根的
    /// `daemon.sock` → 家目录默认根的 `engine.sock`）。页面上那一行必须说得出它连的是
    /// 哪一个根：daemon 用自己的隔离 flag 起时，屏幕上"后台服务"与"状态根"要指同一件事。
    @Published private(set) var socketSource: SocketPathSource = .homeDefault
    /// 回落表里探过的每一个名字（顺序即优先级）。"未运行"那句话只在整张表都没人应门
    /// 时才说得出，所以这张表本身也要能被读者看见。
    @Published private(set) var socketCandidates: [String] = []
    /// `socketCandidates` 那一张表的完整形态（名字 + 出处），顺序即优先级。
    private var socketCandidateEntries: [(path: String, source: SocketPathSource)] = []
    // 「刷新失败」那一行从前挂在一个只被赋过 nil 的 `lastRefreshError` 上——一条永远
    // 点不亮的红行（这一产品里"看着会亮却永远不亮"就是 P0）。它要说的三件事都已经有
    // 能亮的出口：`daemonCaption`/`daemonTone`（四种实测存活结局各有一句）、
    // 「应门不回话」那一支的专属文案与 `gp-daemon-silent-reason` 标识，以及四张权限卡
    // 各自的 `statusNote`。这里选**删**而不是把它接到某个失败态上：接过去只会让同一
    // 件事实有两个说法，其中一个是红的。
    /// 拖拽引导状态：最近一次落点的权限类别（nil = 无进行中的引导）。
    @Published var pendingGuideKind: PermissionKind?
    /// 拖拽引导文案（`PermissionGuide.instruction` 或手动按钮引导文案）。
    @Published var pendingGuideText: String?

    /// 面板进程的席位探针：仅用于"本窗口自身"这一次要信息，不作为卡片状态真源。
    private let panelProbes: PermissionProbeSet
    private let daemonProbe: DaemonProbe
    /// 本面板进程自己的身份（只作说明用；它的授权不等于 daemon 的授权）。
    let panelSubject: PermissionSubject
    /// hello 往返在途标记（1s 轮询不得叠加 3s 超时的 socket 会话）。
    private var probeInFlight = false
    /// 同一身份新进程的重探结果（用于区分"系统里没授权"与"授权了但 daemon
    /// 需重启才生效"，P1 v1.2 §11.4）。
    @Published var reprobed: PermissionReprobe.Result?
    private var reprobeInFlight = false
    private var lastReprobeAt = Date.distantPast
    /// 重探节流：只在有必备权限未达成且距上次超过该间隔时才发起。
    static let reprobeInterval: TimeInterval = 4
    /// 重探节流上限：面板长期开着又未授权时，不该每 4s 起一个一次性任务。
    static let reprobeIntervalCap: TimeInterval = 60
    /// 当前节流间隔（指数退避；必备权限达成或重启后复位）。
    private var reprobeIntervalNow: TimeInterval = SettingsModel.reprobeInterval
    /// launchd 作业标签（安装器写入的同名 plist）。
    static let launchdLabel = "com.glasspane.daemon"

    /// daemon 未运行 / 旧 daemon 不上报时的卡片注记。
    static let noDaemonReportNote = "后台服务未在运行或版本过旧，暂时读不到它的授权状态"

    /// "有人应门但没回话"那一支的卡片注记：它既不是未运行，也不是运行中，
    /// 权限卡不能借用上面那句（那句会把人支去重启一个其实还活着的进程）。
    static let silentDaemonReportNote = "后台服务接了连接却没回话，暂时读不到它的授权状态"

    /// 页脚与后台服务卡共用的存活陈述。`footer` 决定要不要带上"后台服务"主语
    /// （侧栏那一行没有上下文，需要主语；卡内标题不需要）。
    static func livenessCaption(_ liveness: DaemonLiveness, footer: Bool) -> String {
        let subject = footer ? "后台服务" : ""
        switch liveness {
        case .unmeasured: return subject + "还没实测过"
        case .answering: return subject + "运行中"
        case .notRunning: return subject + "未运行"
        case .presentButSilent: return footer ? "后台服务应了门，却没回话" : "有人应门但没回话"
        }
    }

    /// 那一枚点的颜色：实测到回话才给绿点，没实测过给中性点，应门不回话给警示点。
    static func livenessTone(_ liveness: DaemonLiveness) -> StatusDotView.Tone {
        switch liveness {
        case .unmeasured: return .neutral
        case .answering: return .good
        case .notRunning: return .bad
        case .presentButSilent: return .warning
        }
    }

    /// 后台服务卡标题那一行：状态 + 实测到的版本号（没测到就不写，不占位）。
    static func daemonSummaryLine(_ entry: DaemonEntry) -> String {
        let caption = livenessCaption(entry.liveness, footer: false)
        guard entry.liveness == .answering, let version = entry.version, !version.isEmpty else {
            return caption
        }
        return caption + " \(version)"
    }

    /// 存活那一行的无障碍标识（带状态段）：中文文案不进 AXTitle，真机冒烟
    /// 要靠它读出"此刻 lit 的到底是哪一种实测结局"。
    static func livenessIdentifier(_ liveness: DaemonLiveness) -> String {
        let key: String
        switch liveness {
        case .unmeasured: key = "unmeasured"
        case .answering: key = "answering"
        case .notRunning: key = "not-running"
        case .presentButSilent: key = "silent"
        }
        return "gp-daemon-liveness-\(key)"
    }

    /// 当前存活结局那一行的文案与点色（页脚与卡共用，两处不许各写一套判据）。
    var daemonCaption: String { Self.livenessCaption(daemon.liveness, footer: false) }
    var daemonFooterCaption: String { Self.livenessCaption(daemon.liveness, footer: true) }
    var daemonTone: StatusDotView.Tone { Self.livenessTone(daemon.liveness) }
    var daemonLivenessIdentifier: String { Self.livenessIdentifier(daemon.liveness) }

    /// 第一帧 hello 回来**之前**的卡片状态。从前这里初始化成 `.notDetermined`
    /// （面板上写"未请求"），那是对一个还没问过的 daemon 声称它没请求过授权——
    /// 面板进程自己更不曾替它请求。三者（未验证 / 未在运行 / 未请求）必须各说各话，
    /// 与 `rebuildEntries()` 里"daemon 没上报"那一支同判据；开发者工具一项按设计
    /// 恒为未验证（TCC 无公开查询接口），它的注记同样不该先斩后奏。
    static func entriesBeforeDaemonReport() -> [PermissionEntry] {
        PermissionDescriptor.all.map { descriptor in
            PermissionEntry(
                kind: descriptor.kind,
                descriptor: descriptor,
                status: .unverifiable,
                statusNote: descriptor.kind == .developerTools ? nil : noDaemonReportNote
            )
        }
    }

    /// 顶部总览那一行与侧栏标记共用的**唯一**判据（纯函数，供单测）。
    ///
    /// 判据是"这一页读到过几条自报席位"，不是"有几张卡不是绿的"。第一帧 hello
    /// 回来之前（以及 daemon 没在运行、应门不回话时）四张卡全是 `unverifiable`，
    /// 那种状态下写"还有 3 项必备权限没授权"是替本机 TCC 做一次它从没量过的断言——
    /// 而它就印在那几张自己写着"读不到它的授权状态"的卡上面，两句话互相打脸。
    /// `unverifiable` 与 `denied`/`notDetermined` 是两种事实，只有后者才数得出"没授权"。
    enum PermissionOverview: Equatable {
        /// 一条自报席位都没读到：既不能说还差几项，也不能说已经齐了。
        case awaitingDaemonReport
        /// 必备三类都由 daemon 自报为 granted（这一次读到了，而且都在）。
        case allGranted
        /// 读到的席位里有 `ungranted` 项没授权；另有 `unreported` 项这一帧没上报。
        /// 两个数各记各的账，不合并成一句"没授权"。
        case measured(ungranted: [String], unreported: Int)

        nonisolated static func make(entries: [PermissionEntry]) -> PermissionOverview {
            let essential = entries.filter { $0.kind != .developerTools }
            guard !essential.isEmpty else { return .awaitingDaemonReport }
            let reported = essential.filter { $0.status != .unverifiable }
            guard !reported.isEmpty else { return .awaitingDaemonReport }
            let ungranted = reported.filter { $0.status != .granted }
            let unreported = essential.count - reported.count
            if ungranted.isEmpty && unreported == 0 { return .allGranted }
            return .measured(
                ungranted: ungranted.map { $0.descriptor.displayName },
                unreported: unreported
            )
        }

        /// 大字那一行。没说过的话一个字都不写：没读到席位时不报数、不报"没授权"。
        nonisolated var headline: String {
            switch self {
            case .awaitingDaemonReport: return "后台服务还没上报它的授权状态"
            case .allGranted: return "必备权限已全部授权"
            case .measured(let ungranted, let unreported):
                if ungranted.isEmpty { return "有 \(unreported) 项必备权限这一帧没上报" }
                return "实测到 \(ungranted.count) 项必备权限没授权"
                    + (unreported > 0 ? "，另有 \(unreported) 项这一帧没上报" : "")
            }
        }

        /// 小字那一行：点名是哪几项，并说清下一眼该看哪儿。
        nonisolated var detail: String {
            switch self {
            case .awaitingDaemonReport:
                return "这一页一次都没读到它自报的席位，所以既说不出还差哪几项，也不能说已经齐了。"
                    + "点「刷新」让它报一次；各张卡自己的注记写的就是现在的实测结局。"
            case .allGranted:
                return "开发者工具是可选的深度调试通道，不影响日常使用。"
            case .measured(let ungranted, let unreported):
                if ungranted.isEmpty {
                    return "\(unreported) 项这一帧没上报——那是没读到，不是没授权。点「刷新」重读一次。"
                }
                let named = ungranted.joined(separator: "、")
                var text = "没授权的是：\(named)（后台服务自报的席位）。缺得越多，能验证的通道越少。"
                if unreported > 0 {
                    text += "另有 \(unreported) 项这一帧没上报（没读到不等于没授权）。"
                }
                return text
            }
        }

        /// 承载状态的形状（颜色只是附带：色盲可用，形状必须自己说得清）。
        nonisolated var icon: String {
            switch self {
            case .awaitingDaemonReport: return "questionmark.circle"
            case .allGranted: return "checkmark.circle.fill"
            case .measured: return "exclamationmark.circle.fill"
            }
        }

        /// 该不该点亮那枚"齐了/还差几项"的颜色。没读到过席位 = 哪边都不站。
        nonisolated var tone: OverviewTone {
            switch self {
            case .awaitingDaemonReport: return .unmeasured
            case .allGranted: return .granted
            case .measured: return .pending
            }
        }

        enum OverviewTone: Equatable {
            case unmeasured
            case granted
            case pending
        }
    }

    /// 顶部总览那一行此刻的读数（视图只读这一个，不再自己数一遍）。
    var permissionOverview: PermissionOverview {
        PermissionOverview.make(entries: entries)
    }

    /// 侧栏「权限」那一行的标记：与顶部总览同一判据、同一份读数，两处不许各数一遍。
    /// 没读到席位时它说的是"没上报"这件事（这一页确实没收到过），而不是差几项。
    nonisolated static func sidebarPermissionBadge(entries: [PermissionEntry]) -> String? {
        switch PermissionOverview.make(entries: entries) {
        case .awaitingDaemonReport:
            return "未上报"
        case .allGranted:
            return nil
        case .measured(let ungranted, let unreported):
            if !ungranted.isEmpty { return "\(ungranted.count) 项待处理" }
            return unreported > 0 ? "\(unreported) 项没上报" : nil
        }
    }

    /// 顶部图标的拖拽源：daemon 有 bundle 身份时提供 **daemon 真身 .app**
    /// 的 fileURL（可直接拖进系统设置列表并显示图标）；daemon 未上报身份时
    /// 只提供纯文本导航——把设置面板自己的 .app 拖进去会授权错主体。
    var dragSource: PermissionGuide.DragSource {
        PermissionGuide.dragSource(for: daemon.subject)
    }

    /// 拖拽横幅副标题里给出的主体说明。
    var dragSourceHint: String {
        switch dragSource {
        case .bundleURL(let bundlePath):
            return "顶部图标就是后台服务本体（\(bundlePath)）：拖到下方卡片可直接打开对应授权面板"
        case .plainText:
            return "后台服务当前是未打包形态，系统设置列表里只显示文件名：拖拽仅用于跳转，重新安装打包版本后点「刷新」"
        }
    }

    /// 与 daemon 默认一致的 socket 路径（家目录那一个：默认根的叶子名是 `engine.sock`）。
    /// 面板实际探的往往不是这一个——回落顺序见 `resolveSocketPath(explicitSocketPath:env:home:)`。
    public static func defaultSocketPath() -> String {
        DaemonProbe.defaultSocketPath
    }

    /// socket 的解析顺序（纯函数，供单测）：显式 socket → `GLASSPANE_ENGINE_SOCK` →
    /// 面板已知状态根的 `daemon.sock` → 家目录默认根的 `engine.sock`；只有这一个名字
    /// 后面确实没人时，才轮得到"未运行"那句话。
    ///
    /// 缺陷形状：这里从前只有最后一级。`glasspaned --state-dir X`——它自己的帮助文本
    /// 教的那条隔离 flag——绑的是 `X/daemon.sock`（`main.swift` 走
    /// `StateRoot.engineSocketPath(explicitSocketPath:stateRoot:)`，名字跟着根换是既有
    /// 文档化规则），面板于是把一个正在应门的 daemon 报成"后台服务未运行"，四张权限卡
    /// 一起挂"未验证"。`mcp-shell` 认 `GLASSPANE_ENGINE_SOCK`，`updater/lib/idle.js` 也认，
    /// 而 `grep GLASSPANE_ENGINE_SOCK engine/Sources` 回空：这一组读者里面板是最后一个
    /// 还在自己猜的。空白串按"没点名"处理（`export GLASSPANE_ENGINE_SOCK=` 之后不能拿
    /// 空串去 connect；与 `mcp-shell` 的 socket-override-blank 同一条规则）。
    ///
    /// 以及这一帧 hello 报回来的状态根（`daemonStateRootCaption`——它只在服务端真报过
    /// 时说服务端的事，面板不许拿自己探的那一个去替它填）。
    static func resolveSocketPath(
        explicitSocketPath: String? = nil,
        env: [String: String] = ProcessInfo.processInfo.environment,
        home: String = NSHomeDirectory()
    ) -> String {
        if let explicit = explicitSocketPath?.trimmingCharacters(in: .whitespacesAndNewlines),
           !explicit.isEmpty {
            return explicit
        }
        if let named = env["GLASSPANE_ENGINE_SOCK"]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !named.isEmpty {
            return named
        }
        let namedRoot = env["GLASSPANE_STATE_DIR"]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !namedRoot.isEmpty {
            // 根的路径由 `UpdatePanel.stateRoot` 那一份规则算（tilde 展开与空白判据都
            // 在那儿）：同一份规矩不许在这一面再抄第二遍。叶子名跟着换——点名过的根
            // 是 `daemon.sock`，只有没点名才留 `engine.sock`。
            let root = StateRoot(path: UpdatePanel.stateRoot(env: env, home: home))
            return StateRoot.engineSocketPath(explicitSocketPath: nil, stateRoot: root)
        }
        return DaemonProbe.defaultSocketPath
    }

    /// 上面那一条只答"第一级是哪个名字"。这一条把**整张回落表**交出去：一次运行只探
    /// 一个名字是不够的——`GLASSPANE_ENGINE_SOCK` 指着一个已经退役的 socket、而真正的
    /// daemon 正绑在点名根的 `daemon.sock` 上时，只探第一个名字的面板依旧报"未运行"，
    /// 而这一次它其实连的是别人。所以按这张表逐个探，**第一个真回了 hello 的赢**，
    /// 整张表都没人应门才轮得到"未运行"那句话（`socketSource` 记下赢的是哪一级，
    /// 页面上那一行就说得出它在跟哪一个根说话）。
    static func socketPathCandidates(
        explicitSocketPath: String? = nil,
        env: [String: String] = ProcessInfo.processInfo.environment,
        home: String = NSHomeDirectory()
    ) -> [(path: String, source: SocketPathSource)] {
        var out: [(path: String, source: SocketPathSource)] = []
        func add(_ path: String, _ source: SocketPathSource) {
            let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, !out.contains(where: { $0.path == trimmed }) else { return }
            out.append((trimmed, source))
        }
        if let explicit = explicitSocketPath?.trimmingCharacters(in: .whitespacesAndNewlines),
           !explicit.isEmpty {
            add(explicit, .explicitArgument)
        }
        if let named = env["GLASSPANE_ENGINE_SOCK"]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !named.isEmpty {
            add(named, .engineSocketEnvironment)
        }
        let namedRoot = env["GLASSPANE_STATE_DIR"]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !namedRoot.isEmpty {
            let root = StateRoot(path: UpdatePanel.stateRoot(env: env, home: home))
            add(StateRoot.engineSocketPath(explicitSocketPath: nil, stateRoot: root), .namedStateRoot)
        }
        add(DaemonProbe.defaultSocketPath, .homeDefault)
        return out
    }

    /// 面板探的那一个名字是**哪一级**定下来的。与 `ConsoleModel.StateRootSource` 同一套
    /// 说法：出处不是给读的人增加装饰的，屏幕上并排两个"状态根"时它要说得出谁是谁。
    enum SocketPathSource: Equatable {
        /// 面板自己的 `--socket-path`（与 daemon 同语义）。
        case explicitArgument
        /// `GLASSPANE_ENGINE_SOCK`：`mcp-shell` 与 `updater/lib/idle.js` 认的那一个变量。
        case engineSocketEnvironment
        /// 面板已知状态根（`GLASSPANE_STATE_DIR`）下的 `daemon.sock`。
        case namedStateRoot
        /// 家目录默认根下的 `engine.sock`——最后一级，也是唯一一级"猜"。
        case homeDefault

        /// 那一行的出处说法（三态三句话，没有一级冒充另一级）。
        var caption: String {
            switch self {
            case .explicitArgument: return "面板启动时显式点名的 socket"
            case .engineSocketEnvironment: return "GLASSPANE_ENGINE_SOCK 点名的 socket"
            case .namedStateRoot: return "GLASSPANE_STATE_DIR 那个状态根下的 daemon.sock"
            case .homeDefault: return "谁都没点名时家目录默认根的 engine.sock（这一级是猜的）"
            }
        }
    }

    init(
        socketPath: String? = nil,
        refreshOnAppear: Bool = true,
        probes: PermissionProbeSet = PermissionProbeSet(),
        daemonProbe: DaemonProbe = DaemonProbe(),
        env: [String: String] = ProcessInfo.processInfo.environment,
        home: String = NSHomeDirectory()
    ) {
        self.panelProbes = probes
        self.daemonProbe = daemonProbe
        self.panelSubject = probes.snapshot().subject
        let candidates = Self.socketPathCandidates(explicitSocketPath: socketPath, env: env, home: home)
        socketCandidateEntries = candidates
        socketCandidates = candidates.map { $0.path }
        socketSource = candidates.first?.source ?? .homeDefault
        daemon = DaemonEntry(
            socketPath: candidates.first?.path ?? DaemonProbe.defaultSocketPath,
            liveness: .unmeasured,
            version: nil,
            protocolVersion: nil,
            pid: nil,
            subject: nil
        )
        entries = Self.entriesBeforeDaemonReport()
        if refreshOnAppear {
            refresh()
        }
    }

    // MARK: - 引导动作（P1 v1.2 §11.2：由 daemon 自己申请，面板只导航）

    /// 把申请交给 daemon 那一步**实测到的**结局。横幅里那句话只能由它折算：
    /// 从前这里只有 `try? process.run()`——起没起来、退出码多少都不落进状态，
    /// 而横幅照旧写着"已请求「辅助功能」授权"，等于面板替系统声明了一次它
    /// 从没量过的申请。还有更直的一支：daemon 身份没上报时一个任务都没提交，
    /// 同一句话照样发出去。
    enum DaemonRequestStage: Equatable {
        /// `launchctl submit` 已经交出去，这一趟还没回话。
        case submitting
        /// 提交子进程返回 0——"已请求授权"这句话现在背后有那个退出码了。
        case submitted
        /// 子进程返回非 0：申请没提交成，理由就是它自己回的那句话。
        case refused(status: Int32, detail: String)
        /// 连退出码都没拿到：起不来，或没在时限内回话。
        case notStarted
        /// 一次都没提交：daemon 没上报身份，面板代申请会把席位记到面板自己头上。
        case notAttempted
    }

    /// 权限卡的统一引导入口：
    ///  1. 已授权 → 只把系统设置里对应那一页打开（按钮语义是"查看"）；
    ///  2. 取到 daemon 身份 → `launchctl submit` 让 daemon 以**自身身份**发起
    ///     系统申请，随后打开对应系统面板深链；
    ///  3. 取不到 daemon 身份 → 只打开深链并如实说明"面板代申请会记错主体"，
    ///     绝不把申请动作落在面板进程上。
    ///
    /// 第 2 支的那句话由提交结局折算（`DaemonRequestStage`），不再在提交之前先
    /// 宣称"已请求"：跑一次子进程不等于系统批了申请，退出码没读到就更不能说"已请求"。
    func guide(_ kind: PermissionKind, droppedName: String? = nil) {
        switch kind {
        case .developerTools:
            // 无系统总开关、无公开查询 API：仅打开面板 + 文案（恒 unverifiable）。
            setPendingGuide(kind, droppedName: droppedName)
            PermissionGuide.openSystemPane(for: kind)
            return
        case .accessibility, .inputMonitoring, .screenRecording:
            if status(of: kind) == .granted {
                // 已授权时按钮的语义是"跳到系统设置里那一行"，所以必须真的跳。
                // 早先这里直接 return，用户点一个写着"查看"的按钮却毫无反应。
                pendingGuideKind = kind
                pendingGuideText = "系统设置已打开，\(PermissionGuide.descriptorName(for: kind))这一项当前是开启的。"
                PermissionGuide.openSystemPane(for: kind)
                return
            }
            let reportedBinaryPath = daemon.subject?.binaryPath
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard let subject = daemon.subject, !reportedBinaryPath.isEmpty else {
                // 身份没上报 = 一个申请都不会提交，这一支有它自己那句话。
                // （`binaryPath` 是空串时 launchd 那头什么也不会起，说"已请求"就是假的。）
                setPendingGuide(kind, droppedName: droppedName, stage: .notAttempted)
                PermissionGuide.openSystemPane(for: kind)
                refresh()
                return
            }
            setPendingGuide(kind, droppedName: droppedName, stage: .submitting)
            PermissionGuide.openSystemPane(for: kind)
            requestPermissionViaDaemon(kind, subject: subject, daemonBinaryPath: reportedBinaryPath)
            refresh()
        }
    }

    func guideAccessibility() { guide(.accessibility) }
    func guideInputMonitoring() { guide(.inputMonitoring) }
    func guideScreenRecording() { guide(.screenRecording) }
    func guideDeveloperTools() { guide(.developerTools) }

    /// 拖拽落点入口：语义是"精确导航 + 让 daemon 自己申请"。`droppedName` 是
    /// 被拖入 bundle 的可读名——它**不再是授权对象**（授权对象恒为 daemon），
    /// 因此仅用于回落文案，不进入卡片状态判定。
    @discardableResult
    func handleDrop(kind: PermissionKind, droppedName: String?) -> String {
        guide(kind, droppedName: droppedName)
        return pendingGuideText
            ?? PermissionGuide.instruction(for: kind, droppedName: droppedName ?? "GlassPane")
    }

    /// 以 launchd 一过性任务的方式让 daemon 发起申请。命令构造是 engine 侧纯
    /// 函数（`PermissionGuide.daemonRequestCommand`），本处只负责执行与清理。
    ///
    /// 提交那一趟走 `ConsoleModel.runDaemonCLI`——这一面**已经有**一条捕获退出码 +
    /// 两路输出并带超时的通道（且被单测钉过），不再复制第二份执行器，也不再
    /// `try? process.run()` 把结局丢掉。
    private func requestPermissionViaDaemon(
        _ kind: PermissionKind, subject: PermissionSubject, daemonBinaryPath: String
    ) {
        // `binaryPath` 是 daemon 在 hello 帧里自报的，而 engine.sock 的口径是"同用户即全权、
        // 无 peer 鉴权"。面板这一侧是那条声明唯一的读者，所以校验也必须落在这里：任何能在
        // 候选 socket 名上回一帧的进程，都能借这个按钮把任意路径送进用户那个已登录的 Aqua
        // 会话。形状规则（绝对、无控制字符）拦不住 `/tmp/x/payload`。
        guard PermissionReprobe.isSubmittableExecutable(daemonBinaryPath) else {
            guideEpoch += 1
            pendingGuideText = PermissionGuide.daemonRequiredText
                + " 后台服务自报的程序路径不能被提交：它不是这个账号拥有的普通文件——"
                + daemonBinaryPath + "。本次没有向 launchd 提交任何任务。"
            return
        }
        let nonce = "\(Int(Date().timeIntervalSince1970))-\(UInt32.random(in: 1...UInt32.max))"
        let command = PermissionGuide.daemonRequestCommand(
            for: kind,
            daemonBinaryPath: daemonBinaryPath,
            nonce: nonce
        )
        let epoch = guideEpoch
        let dropped = pendingDroppedName
        Task.detached(priority: .userInitiated) {
            let run = ConsoleModel.runDaemonCLI(
                binary: command.launchPath, arguments: command.arguments, timeoutSeconds: 10
            )
            let stage = Self.daemonRequestStage(from: run)
            await MainActor.run {
                // 迟到的结局不许改写已经换过主题（或被用户关掉）的横幅。
                guard epoch == self.guideEpoch, self.pendingGuideKind == kind else { return }
                self.pendingGuideText = Self.guideText(
                    for: kind, subject: subject, stage: stage, droppedName: dropped
                )
            }
        }
        // 任务为一次性（申请动作即起即停）；清理标签失败静默是故意的——
        // 它不产出任何面向用户的结论，所以不需要一条 measured 的文案。
        let cleanup = PermissionGuide.daemonRequestCleanupCommand(jobLabel: command.jobLabel)
        Task.detached(priority: .utility) {
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            _ = ConsoleModel.runDaemonCLI(
                binary: cleanup.launchPath, arguments: cleanup.arguments, timeoutSeconds: 5
            )
        }
    }

    /// 提交子进程的结局折算。nil = 连退出码都没拿到（起不来 / 超时 / 输出读不出），
    /// 那**不是**"已经提交"，也不能与"它回了非 0"共用一句话。
    nonisolated static func daemonRequestStage(
        from run: (output: String, errorOutput: String, status: Int32)?
    ) -> DaemonRequestStage {
        guard let run else { return .notStarted }
        guard run.status == 0 else {
            let detail = run.errorOutput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? run.output
                : run.errorOutput
            return .refused(status: run.status, detail: detail)
        }
        return .submitted
    }

    /// 横幅那句话：只由**测到的那一步**折算，每种结局各说各话。
    /// 抽成纯函数（入参就是这一次引导的实测材料），这样"没有实测就不许说已请求"
    /// 能单测——单测不该为了读一句话去构造一个会查 TCC 席位的模型。
    nonisolated static func guideText(
        for kind: PermissionKind,
        subject: PermissionSubject?,
        stage: DaemonRequestStage?,
        droppedName: String? = nil
    ) -> String {
        let subjectName = subject?.tccEntryName ?? "glasspaned"
        let hasBundleIdentity = subject?.hasBundleIdentity ?? false
        let name = PermissionGuide.descriptorName(for: kind)
        let base: String
        switch stage {
        case .submitted, nil:
            // devTools 那一支（stage 恒为 nil）说的是"打开了面板"，不含申请主张。
            base = PermissionGuide.instruction(
                for: kind, subjectName: subjectName, hasBundleIdentity: hasBundleIdentity
            )
        case .submitting:
            base = "这一页正在为后台服务申请「\(name)」授权：申请已经交给 launchctl，它还没回话。"
                + "回话之前这句话只说明这一趟在跑，不说明系统已经批了；卡片状态只由「刷新」"
                + "读到的自报席位决定。"
        case .notStarted:
            base = "「\(name)」的申请没有提交成功：这一页连 \(Launchctl.path) 的退出码都没读到"
                + "（起不来，或没在时限内回话）。这一页没有向系统发起任何申请，卡片状态不会因此改变。"
                + "下一步：点「刷新」确认后台服务在运行，再点一次这一卡的「授权」。"
        case .refused(let status, let detail):
            base = "「\(name)」的申请没有提交成功：\(Launchctl.path) 退出码 \(status)。"
                + "\(ConsoleModel.quoteDaemonWords(detail)) 这一页没有向系统发起任何申请，"
                + "卡片状态不会因此改变。下一步：点「刷新」确认后台服务在运行后重试一次；"
                + "也可以直接到系统设置的「隐私与安全性」里为 \(subjectName) 打开开关。"
        case .notAttempted:
            base = PermissionGuide.daemonRequiredText + " " + PermissionGuide.instruction(
                for: kind, subjectName: subjectName, hasBundleIdentity: hasBundleIdentity
            )
        }
        guard let droppedName, !droppedName.isEmpty else { return base }
        return base + "（拖入的『\(droppedName)』只是帮你跳转；真正要勾选的是后台服务本身）"
    }

    // MARK: - 状态测量（真源 = daemon 自报）

    /// 周期性权限检测（拖拽/按钮后自动点亮）：向 daemon 打一次 hello 取其自报
    /// 席位。必备权限全部 granted 时返回 true，供 UI 停表。
    ///
    /// 每一轮都是**新的实测**：这一轮没拿到回话就把灯灭掉（socket 文件还在而
    /// 对端不应门的那台进程，不是"运行中"的凭证）。只有"同一时刻已有另一轮在途"
    /// 才保持现状——那一轮正在测，这里既不该亮也不该灭。
    func pollPermissions() async -> Bool {
        if let liveness = await probeLiveness() {
            applyLiveness(liveness)
        }
        if !essentialPermissionsGranted {
            // 运行实例没达成：先分清"系统里真没授权"还是"授权了没重启"。
            await reprobeSeats()
        }
        return essentialPermissionsGranted
    }

    /// 必备三类（辅助功能/输入监控/屏幕录制）是否全部达成——`unverifiable`
    /// 不算达成（诚实呈现：daemon 不可达时不得停表假称已完成）。
    var essentialPermissionsGranted: Bool {
        entries.filter { $0.kind != .developerTools }.allSatisfy { $0.status == .granted }
    }

    func status(of kind: PermissionKind) -> PermissionStatus {
        entries.first { $0.kind == kind }?.status ?? .unverifiable
    }

    /// 系统里已授权、但运行中的 daemon 还读不到的权限（需重启生效）。
    var kindsNeedingRestart: [PermissionKind] {
        PermissionReprobe.kindsNeedingRestart(running: daemonReportedStatuses, reprobed: reprobed)
    }

    /// 横幅在屏上、手里却没有"待重启的权限"可指时那一句（重启在途或已出结论时就是它）。
    /// 它只说这一枚按钮做什么，不声称任何席位状态——那种主张要有重探撑着。
    static let restartBannerWithoutReprobeHint =
        "重启后台服务：让它重新读一次系统里的授权。这会打断正在执行的操作，所以只由你点。"

    var restartHint: String {
        let kinds = kindsNeedingRestart
        return kinds.isEmpty
            ? Self.restartBannerWithoutReprobeHint
            : PermissionGuide.restartNeededText(kinds)
    }

    /// daemon 自报的席位（重探/重启后需要重算注记，单独留一份）。
    private var daemonReportedStatuses: [PermissionKind: PermissionStatus] = [:]

    /// 「重启后台服务」那一块横幅在不在屏上（纯函数，供单测）。
    ///
    /// 判据**不能**是 `kindsNeedingRestart`。`restartDaemon()` 一被按下就把 `reprobed`
    /// 清空——重启之后不许再信上一次的重探，这个意图是对的——而
    /// `PermissionReprobe.kindsNeedingRestart` 读不到重探就回空表。把同一张表当横幅的
    /// 显示条件，等于那一次点击把自己那段唯一的出口从屏幕上抹掉：按钮和
    /// `gp-permission-restart-outcome` 那一行都长在横幅里，实测到的重启结论于是永远
    /// 没有读者（点了之后屏幕上什么都不会出现）。
    nonisolated static func showsRestartBanner(
        kindsNeedingRestart: [PermissionKind],
        isRestartInFlight: Bool,
        outcome: DaemonRestartOutcome
    ) -> Bool {
        if !kindsNeedingRestart.isEmpty { return true }
        if isRestartInFlight { return true }
        return outcome != .idle
    }

    /// 现在这一帧该不该有那块横幅：在途、已有结论、或确实有待重启的权限，三者任一。
    var showsRestartBanner: Bool {
        Self.showsRestartBanner(
            kindsNeedingRestart: kindsNeedingRestart,
            isRestartInFlight: isRestartInFlight,
            outcome: restartOutcome
        )
    }

    /// 最近一次"调试能力"机器探测结果（P6 §7 的 `--check-developer-tools`，
    /// 由 daemon 自己的二进制在 launchd 上下文中跑）。显式触发、带时刻，
    /// 不作为实时席位。
    @Published var developerToolsCapability: DeveloperToolsCapability.Report?
    /// developerToolsCapability 是在哪个 daemon 进程上测得；pid 变了必须作废
    /// （旧结论不能冒充新进程的状态）。
    @Published var developerToolsProbePid: Int?
    @Published var isProbingDeveloperTools = false
    @Published var developerToolsProbeError: String?
    /// 失败在哪一步（供标识与自动化判读；文案仍走 developerToolsProbeError）。
    @Published var developerToolsProbeFailure: CapabilityFailure?
    private var capabilityInFlight = false
    /// 调试能力探测含真实 lldb 冷启动（P6 §0 F5 预算 120s × 两侧），等待窗要宽。
    static let capabilityProbeTimeout: TimeInterval = 260

    /// 用 daemon 自己的二进制重跑一次 `--permissions`（launchd 一次性任务，
    /// 责任上下文是 daemon 本身）：拿到"同一身份的新进程"看到的席位。
    func reprobeSeats(force: Bool = false) async -> PermissionReprobe.Result? {
        guard let binaryPath = daemon.subject?.binaryPath else { return nil }
        // 同一条口径：自报路径必须是本账号拥有的普通文件，才许被 launchd 起起来。
        guard PermissionReprobe.isSubmittableExecutable(binaryPath) else { return reprobed }
        guard !reprobeInFlight else { return reprobed }
        if !force && Date().timeIntervalSince(lastReprobeAt) < reprobeIntervalNow { return reprobed }
        reprobeInFlight = true
        reprobeIntervalNow = min(reprobeIntervalNow * 2, Self.reprobeIntervalCap)
        lastReprobeAt = Date()
        defer { reprobeInFlight = false }
        let nonce = "\(Int(Date().timeIntervalSince1970))"
        let directory = NSTemporaryDirectory()
        let scriptPath = directory + "glasspane-reprobe-\(nonce).zsh"
        let outputPath = directory + "glasspane-reprobe-\(nonce).json"
        guard let submission = PermissionReprobe.submission(
            scriptPath: scriptPath, nonce: nonce,
            daemonBinaryPath: binaryPath, outputPath: outputPath
        ) else {
            // 路径不合规格＝这帧 hello 不可信（或 daemon 换了形态）。宁可不动。
            return reprobed
        }
        // 一次性任务轮询是阻塞调用——必须在主 actor 之外执行，否则面板整窗
        // 冻结（launchd 挂起 UI 进程会被看门狗杀掉，用户侧症状就是"点了没反应"）。
        let outcome = await Task.detached(priority: .utility) {
            Self.runOneShot(
                script: submission.script, scriptPath: scriptPath,
                outputPath: outputPath, command: submission.command
            )
        }.value
        let result: PermissionReprobe.Result?
        if case .text(let text) = outcome { result = PermissionReprobe.parse(text) } else { result = nil }
        if let result {
            reprobed = result
            rebuildEntries()
        }
        return result
    }

    /// 显式验证 daemon 的调试能力（开发者工具席位）。探测本身是受限的真
    /// `xcrun lldb` 运行（P6 §7），代价高，因此只由用户点击触发，结果带时刻
    /// 呈现；`hello.permissions.developerTools` 仍是 `unverifiable`（TCC 无公开
    /// 查询接口这一事实不变）。
    func verifyDeveloperTools() async {
        guard let binaryPath = daemon.subject?.binaryPath else {
            recordProbeFailure(.unreadable, "还没连上后台服务：调试能力要由它自己实测。点「刷新」恢复连接后重试。")
            return
        }
        guard PermissionReprobe.isSubmittableExecutable(binaryPath) else {
            recordProbeFailure(.unreadable, "后台服务自报的程序路径不能被提交：它不是这个账号拥有的普通文件。本次没有起一次性任务。")
            return
        }
        guard !capabilityInFlight else { return }
        capabilityInFlight = true
        isProbingDeveloperTools = true
        developerToolsProbeError = nil
        defer { capabilityInFlight = false; isProbingDeveloperTools = false }
        let nonce = "\(Int(Date().timeIntervalSince1970))"
        let directory = NSTemporaryDirectory()
        let scriptPath = directory + "glasspane-devtools-\(nonce).zsh"
        let outputPath = directory + "glasspane-devtools-\(nonce).json"
        guard let submission = PermissionReprobe.submission(
            scriptPath: scriptPath, nonce: nonce,
            daemonBinaryPath: binaryPath, outputPath: outputPath,
            arguments: PermissionReprobe.developerToolsArguments
        ) else {
            // daemon 自报的路径不是绝对路径（或含换行）——这帧 hello 不可信，
            // 也不该把它交给 launchd 去执行。如实记失败，不改脚本形态去"绕一下"。
            recordProbeFailure(
                .writeFailed,
                "后台服务自报的程序路径不合规格（需为绝对路径），本次验证未提交：\(binaryPath)"
            )
            return
        }
        // 同 reprobeSeats：分钟级的实测等待绝不占用主线程。
        let timeout = Self.capabilityProbeTimeout
        let outcome = await Task.detached(priority: .utility) {
            Self.runOneShot(
                script: submission.script, scriptPath: scriptPath, outputPath: outputPath,
                command: submission.command, timeoutSeconds: timeout
            )
        }.value
        switch outcome {
        case .text(let text):
            if let report = DeveloperToolsCapability.parse(text, observedAt: Date()) {
                developerToolsCapability = report
                developerToolsProbePid = daemon.pid
                developerToolsProbeError = nil
                developerToolsProbeFailure = nil
                setPendingGuide(.developerTools)
            } else {
                recordProbeFailure(.unreadable)
            }
        case .writeFailed:
            recordProbeFailure(.writeFailed)
        case .spawnFailed:
            recordProbeFailure(.spawnFailed)
        case .submitRefused(let status, let detail):
            // 阶段落在 `.spawnFailed` 这一档（`CapabilityFailure` 的词表只有四类，而这一条
            // 说的正是"任务没起来"），但文案必须是**拒绝**而不是超时：`launchctl` 回了非 0，
            // 它说的就是它为什么不肯起。判据与文案抽成纯函数（`submitRefusalText`），因为
            // "把拒绝说成超时"正是这条缺陷本体，它得能在不碰 launchd/TCC 的情况下被验红。
            recordProbeFailure(.spawnFailed, Self.submitRefusalText(status: status, detail: detail))
        case .timedOut:
            recordProbeFailure(.timedOut)
        case .directoryUnsafe(let reason):
            // 阶段仍记作 writeFailed（脚本确实一个字都没落盘），但文案要说清这是
            // 目录不合格，不是磁盘写不进：下一步是换临时目录，不是重试。
            recordProbeFailure(.writeFailed,
                "调试能力没有实测：\(reason) 下一步：确认 TMPDIR 指向本用户专有、同组与其他人都写不动的目录（ls -ld 那个目录），或清掉 TMPDIR 让系统回到默认的每用户临时目录后重试。")
        }
    }

    /// 一次性任务被 `launchctl submit` **拒了**的那句话（纯函数，供单测）。
    ///
    /// 这条文案的存在理由就是这条缺陷：从前提交那一趟是 `try? process.run()`，起了就走、
    /// 退出码从不落地，于是"标签已存在""作业被拒"只能靠"输出文件一直没内容"发现，dev-tools
    /// 那一趟等完整笔预算（260 秒）之后报 `.timedOut`，用的还是
    /// `CapabilityFailure.timedOut.fallbackText` 那句"这次验证等得有点久……再点一次"。
    /// 一次**实测到的拒绝**被说成一次超时，而给出的下一步（再点一次）不会改变 launchd 的回答。
    nonisolated static func submitRefusalText(status: Int32, detail: String) -> String {
        "调试能力没有实测：\(Launchctl.path) submit 退出码 \(status)。"
            + ConsoleModel.quoteDaemonWords(detail)
            + " 一次性任务没有被 launchd 收下，那一趟 daemon 探测一次也没有跑，所以这张卡没有新结论、"
            + "状态保持\"未验证\"。这一步不是超时：上面那句是 launchctl 自己说的为什么不肯起。"
            + "下一步：按那句处理（同一个标签还在就先让它结束，路径不认就核对服务装的在哪），"
            + "再点一次「验证调试能力」——单靠再点一次不会改变 launchd 的回答。"
    }

    /// 记录一次验证失败：文案（可覆盖为上下文更贴切的说法）+ 可判读的失败阶段。
    ///
    /// 旧结论必须同一步作废。从前这里只写失败，于是徽标还挂着上一次的
    /// "可用（实测）"，而下面那一行说的是这次超时——两句话讲的是同一个席位，
    /// 留一句假的比留两句更糟。
    func recordProbeFailure(_ failure: CapabilityFailure, _ text: String? = nil) {
        invalidateDeveloperToolsVerdict()
        developerToolsProbeFailure = failure
        developerToolsProbeError = text ?? failure.fallbackText
    }

    /// 作废"验证调试能力"的那次实测结论（结论、时刻与失败阶段一起）：
    /// daemon 换了进程、或这一次没测成，旧结论都不再代表现状。
    private func invalidateDeveloperToolsVerdict() {
        developerToolsCapability = nil
        developerToolsProbeError = nil
        developerToolsProbePid = nil
        developerToolsProbeFailure = nil
    }

    /// 结论行的状态标记：在途 / 失败(在哪一步) / 已出结论；nil = 整行不渲染。
    var capabilityMarker: PermissionGuide.CapabilityMarker? {
        if isProbingDeveloperTools { return .pending }
        if let report = developerToolsCapability { return .concluded(report.status) }
        if let failure = developerToolsProbeFailure { return .failed(failure) }
        return nil
    }

    /// 「重启后台服务」的结局。每个非 `idle` 的取值都来自一次实测：要么拿到
    /// `launchctl` 的退出码，要么读到重启后 hello 报回来的进程号。
    /// 从前这个动作只有 `try? process.run()` 一句，成败都不落进状态，
    /// 于是调用方一律按"重启好了"处理——那是面板自己点亮一个没测过的指示器。
    enum DaemonRestartOutcome: Equatable {
        case idle
        case inFlight
        case confirmed(previousPid: Int?, currentPid: Int)
        case unchanged(pid: Int?)
        case launchctlFailed(status: Int32, detail: String)
        case spawnFailed
    }

    @Published private(set) var restartOutcome: DaemonRestartOutcome = .idle
    private var restartInFlight = false

    /// 重启后读回 hello 的次数与间隔。`kickstart -k` 换进程不是瞬时的，一次
    /// 1.5s 的采样会把"还没起来"读成"没重启"；但也只采样这么多次——
    /// 读不到就如实说读不到，不无限等。
    static let restartReadbackAttempts = 4
    static let restartReadbackInterval: TimeInterval = 1.5

    /// pid 对照是这条结论里唯一的判定，抽成纯函数供单测：换了进程号才算重启
    /// 成功；同一个进程号回话说明没换过；没读到回话不许点亮。
    nonisolated static func restartVerdict(pidBefore: Int?, pidAfter: Int?) -> DaemonRestartOutcome {
        guard let pidAfter else { return .unchanged(pid: pidBefore) }
        if pidAfter == pidBefore { return .unchanged(pid: pidAfter) }
        return .confirmed(previousPid: pidBefore, currentPid: pidAfter)
    }

    /// `launchctl` 那一步的结局折算（退出码非 0 / 起不了进程都是"没重启"，
    /// 不是"重启中"）。与 pid 对照分开，两层失败才能各说各话。
    nonisolated static func restartLaunchStepOutcome(
        _ run: (output: String, errorOutput: String, status: Int32)?
    ) -> DaemonRestartOutcome? {
        guard let run else { return .spawnFailed }
        guard run.status == 0 else {
            return .launchctlFailed(status: run.status, detail: run.errorOutput)
        }
        return nil
    }

    /// 面板上那一句重启结论：说实测到了什么，并给出下一步。nil = 这一面还没重启过。
    /// 抽成纯函数（入参就是那个结局），这样"失败态必须给得出动作"这条能单测——
    /// 单测不该为了读一句文案去构造一个会去查 TCC 席位的模型。
    nonisolated static func restartOutcomeText(
        for outcome: DaemonRestartOutcome, uid: Int, jobLabel: String
    ) -> String? {
        let jobPath = "launchctl print gui/\(uid)/\(jobLabel)"
        switch outcome {
        case .idle:
            return nil
        case .inFlight:
            return "正在重启后台服务，等它回话确认换了进程……"
        case .confirmed(let previous, let current):
            return previous == nil
                ? "后台服务已在新进程上运行（pid \(current)），注册表从这一刻起按新表加载。"
                : "后台服务已换新进程（pid \(previous!) → \(current)），注册表从这一刻起按新表加载。"
        case .unchanged(let pid):
            return pid == nil
                ? "重启指令发出去了，但后台服务一直没回话，读不到它的进程号就没法确认换过进程。核对作业是否还在：\(jobPath)；不在了就重新安装。"
                : "后台服务还是同一个进程（pid \(pid!)）：它没被换掉，注册表仍是旧表。再点一次「重启后台服务」；仍是同一个进程就手动退出它再重新打开。"
        case .launchctlFailed(let status, let detail):
            let quoted = ConsoleModel.quoteDaemonWords(detail)
            return "没有重启成功：launchctl 退出码 \(status)\(quoted.isEmpty ? "" : "，原话：\(quoted)")。后台服务仍是原来那个进程，注册表还没换新表。先核对作业：\(jobPath)。"
        case .spawnFailed:
            // 引擎里那份"手动退出再重新打开"的说明终于有读者了：它从前是一段
            // 没有任何界面引用的常量，而这一条恰是它唯一成立的情形——
            // launchctl 都起不来，就没有"再点一次重启"可推荐。
            return PermissionGuide.manualRestartHint
        }
    }

    var restartOutcomeText: String? {
        Self.restartOutcomeText(for: restartOutcome, uid: Int(getuid()), jobLabel: Self.launchdLabel)
    }

    /// 重启在途：按钮据此禁用，禁用理由由 `restartOutcomeText` 给出。
    var isRestartInFlight: Bool { restartOutcome == .inFlight }

    /// 「注册表已改动，重启后台服务后它才会用新表」这面旗子该不该收起——只认实测到换过
    /// 进程号那一个读数（2026-10-27 审查 E2）。
    ///
    /// 为什么收成纯函数：项目页的收起是靠 `.onChange(of: settings.restartOutcome)`，而
    /// `onChange` 只在那个视图**挂在屏上**的时候收得到变化。于是"在项目页之外按下重启、
    /// 且 1s 轮询没抓到 kill→bind 之间的空隙（liveness 不翻转，
    /// `ConsoleModel.adoptDaemonReport` 那一支也不触发）"会留下屏上两句互相矛盾的话：
    /// 「需要重启后才生效」和 `restartOutcomeText` 的「已换新进程（pid X → Y）」。
    /// 判据在两个入口（变化时、回到这一页时）共用这一句，不各写一份。
    nonisolated static func pruneBannerCleared(by outcome: DaemonRestartOutcome) -> Bool {
        if case .confirmed = outcome { return true }
        return false
    }

    /// 重启 launchd 托管的 daemon 让授权生效。会打断正在进行的 act，
    /// 因此只作为用户显式点击的动作提供，绝不自动执行。
    ///
    /// 结论一律由实测折算：`launchctl` 的退出码，加上重启后 hello 报回来的
    /// 进程号是否变了。调用方（项目页的重启横幅）只在 `.confirmed` 时才收起
    /// "需要重启"的提示。
    func restartDaemon() {
        guard !restartInFlight else { return }
        restartInFlight = true
        restartOutcome = .inFlight
        let pidBefore = daemon.pid
        let command = PermissionGuide.daemonRestartCommand(label: Self.launchdLabel, uid: Int(getuid()))
        reprobed = nil
        reprobeIntervalNow = Self.reprobeInterval
        Task.detached(priority: .userInitiated) {
            // 管道读取与超时交给 ConsoleModel.runDaemonCLI（同一条已单测的一过性
            // 执行通道），这里不再复制第二份。
            let run = ConsoleModel.runDaemonCLI(
                binary: command.launchPath,
                arguments: command.arguments,
                timeoutSeconds: 10
            )
            await MainActor.run {
                if let failure = Self.restartLaunchStepOutcome(run) {
                    self.restartInFlight = false
                    self.restartOutcome = failure
                    return
                }
                Task { @MainActor in
                    // 本轮把存活判定换成了 `probeLiveness()` 三态（`.answered` 才算活），
                    // 上游这段读回原来走的是 `helloSummary()` + `applyDaemonSummary()`。
                    // 接同一把来源，不在这里留第二条"只要拿到摘要就算活着"的判定：
                    // pid 回读的对比对象是 `.answered` 里那份自报摘要。
                    var answered: DaemonProbe.Liveness?
                    for _ in 0..<Self.restartReadbackAttempts {
                        try? await Task.sleep(
                            nanoseconds: UInt64(Self.restartReadbackInterval * 1_000_000_000))
                        if case .answered(let summary)? = await self.probeLiveness() {
                            answered = .answered(summary)
                            break
                        }
                    }
                    if let answered { self.applyLiveness(answered) }
                    self.restartInFlight = false
                    var pidAfter: Int?
                    if case .answered(let summary)? = answered { pidAfter = summary.pid }
                    self.restartOutcome = Self.restartVerdict(
                        pidBefore: pidBefore, pidAfter: pidAfter)
                }
            }
        }
    }

    /// 一次性任务的结局：文本，或失败在哪一步。两者必须分开——面板曾在
    /// "启动器路径不存在"与"实测超时"共用一个 nil 的状态里摸黑排查。
    enum OneShotOutcome {
        case text(String)
        case writeFailed
        case spawnFailed
        /// `launchctl submit` **回了非 0**：这一趟一次性任务被 launchd 拒了，理由是它自己
        /// 回的那句话。单列一态，因为它的下一步与 `.timedOut` 完全不同——再点一次不会
        /// 改变 launchd 的回答，而"等得有点久"那句文案会把一次实测的拒绝洗成一次没测。
        case submitRefused(status: Int32, detail: String)
        case timedOut
        /// 临时目录本身不合格（别人拥有、同组/其他人可写、或那个位置不是目录）。
        /// 单列一态：它的下一步不是"重试一次"，而是换一个可隔离的临时目录——
        /// 与 `writeFailed`（磁盘/权限抛错）混成一条，排查方向就错了。
        case directoryUnsafe(String)
    }

    /// 一次性 launchd 任务的执行面（后台队列）：落脚本 → submit → 轮询读回
    /// 原始输出 → 清理任务标签与临时文件。
    nonisolated private static func runOneShot(
        script: String,
        scriptPath: String,
        outputPath: String,
        command: PermissionGuide.PermissionRequestCommand,
        timeoutSeconds: TimeInterval = 6
    ) -> OneShotOutcome {
        let url = URL(fileURLWithPath: scriptPath)
        let directory = url.deletingLastPathComponent().path
        // 这个脚本随后由 `launchctl submit` **以 daemon 自己的责任上下文**执行，
        // outputPath 也在那一趟里被写入。从前这里只 mkdir 就开写：$TMPDIR 被改指到
        // 共享目录（agent 宿主、launchd 上下文都干过）时，含时钟 nonce 的脚本名与
        // 输出名别的账号能预置，面板却照写不误。判定与证据报告共用
        // `StateRoot.directoryIsolation`——同一份规矩不许有两个实现。
        if StateRoot.directoryIsolation(at: directory) == .missing {
            try? FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        }
        switch StateRoot.directoryIsolation(at: directory) {
        case .usable, .missing: break  // missing 交给下面的写：抛错就是 writeFailed
        case .notADirectory:
            return .directoryUnsafe("临时目录的位置被一个非目录占住：\(directory)")
        case .ownedBy(let uid):
            return .directoryUnsafe("临时目录不属于当前用户（uid \(uid)）：\(directory)")
        case .sharedWritable(let mode):
            return .directoryUnsafe(
                "临时目录同组或其他人可写（\(String(format: "%04o", mode))）：\(directory)——"
                + "一次性任务的脚本名与输出名在那里都能被预置。")
        }
        do {
            // NSTemporaryDirectory() 对非 sandbox 进程可能指向尚未创建的目录，
            // 不先 mkdir 时原子写直接抛错、一次性任务从未提交（面板侧表现为
            // "点了没反应"）。目录不存在就必须先建。
            try? FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try script.write(to: url, atomically: true, encoding: .utf8)
            // Owner 的 x 就够了：一次性任务由同一个 uid 的 launchd 起，0755 只是把这个
            // uid 之外的读者加进来——而它所在的目录只要 0755 就通过
            // `StateRoot.directoryIsolation`（那条规矩拒的是"可写"，不是"可读"）。脚本里
            // 写着 daemon 二进制路径与状态根，同组/其他人可读不是一个需要存在的性质。
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: scriptPath)
        } catch {
            FileHandle.standardError.write(Data("runOneShot script-write failed: \(error) path=\(scriptPath)\n".utf8))
            return .writeFailed
        }
        try? FileManager.default.removeItem(atPath: outputPath)
        // 输出文件由那一趟 shell 重定向创建，所以它的模式是**那个执行上下文的 umask**
        // 说了算，不是面板说了算。先按 0600 建好：重定向只截断已存在的文件，不改它的模式。
        // 同一类由屏幕/权限派生的东西在引擎侧要 0600（`EvidenceReportGenerator.swift:196-201`），
        // 一份 `--permissions` 的读数（主体路径、pid、每个席位的判决）不该是例外。
        FileManager.default.createFile(
            atPath: outputPath, contents: Data(), attributes: [.posixPermissions: 0o600]
        )
        // `launchctl submit` 那一趟走**带退出码的通道**（`ConsoleModel.runDaemonCLI`，
        // 同文件重启那腿 :947 用的就是它）。从前这里是 `try? process.run()`：起了就走，
        // 不等、不读码，于是"标签已存在""作业被 launchd 拒了"这种**实测到的拒绝**只能靠
        // "输出文件一直没内容"发现——dev-tools 那一趟把整笔预算（260 秒）等完之后报
        // `.timedOut`，文案是"这次验证等得有点久……再点一次「验证调试能力」"：一次拒绝
        // 被说成一次超时，下一步也被指成了一个不会改变回答的重试。
        let submit = ConsoleModel.runDaemonCLI(
            binary: command.launchPath, arguments: command.arguments, timeoutSeconds: 10
        )
        guard let submit else {
            removeJobLabel(command.jobLabel)
            try? FileManager.default.removeItem(atPath: scriptPath)
            try? FileManager.default.removeItem(atPath: outputPath)
            return .spawnFailed
        }
        if submit.status != 0 {
            let detail = submit.errorOutput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? submit.output
                : submit.errorOutput
            removeJobLabel(command.jobLabel)
            try? FileManager.default.removeItem(atPath: scriptPath)
            try? FileManager.default.removeItem(atPath: outputPath)
            return .submitRefused(status: submit.status, detail: detail)
        }
        // 提交成了（那一趟回 0）——任务在 launchd 那边跑，读数落在 `outputPath`。
        var result: OneShotOutcome = .timedOut
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        while Date() < deadline {
            if let text = try? String(contentsOfFile: outputPath, encoding: .utf8),
               !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                result = .text(text)
                break
            }
            Thread.sleep(forTimeInterval: 0.25)
        }
        removeJobLabel(command.jobLabel)
        try? FileManager.default.removeItem(atPath: scriptPath)
        try? FileManager.default.removeItem(atPath: outputPath)
        return result
    }

    /// `launchctl remove <label>`：幂等清理，失败静默——它不产出任何面向用户的结论。
    /// 但它现在**等得到退出码**（从前是 `try? remover.run()`，起了就走，留下一个没人收
    /// 的子进程与一次没有读者的失败）。
    nonisolated private static func removeJobLabel(_ jobLabel: String) {
        let cleanup = PermissionGuide.daemonRequestCleanupCommand(jobLabel: jobLabel)
        _ = ConsoleModel.runDaemonCLI(
            binary: cleanup.launchPath, arguments: cleanup.arguments, timeoutSeconds: 5
        )
    }

    /// 按回落表逐个探：第一个真回 hello 的名字赢。都没回话时也要把两件事分开说——
    /// "有人占着门却不开口"比"整张表一个名字都没人听"更值得让人知道，而两种都不是
    /// "未运行"。全部落空才回 `.noListener`，并把探过的名字一起交出去，否则那句
    /// "未运行"说的是一个这一页从没找过的地址。
    ///
    /// 为什么不能只探第一个名字：`GLASSPANE_ENGINE_SOCK` 指着一个已经退役的 socket、
    /// 真正的 daemon 正绑在点名根的 `daemon.sock` 上时，只探头一级的气象仍报"未运行"，
    /// 而这一句要人去做的事一件也做不出来。
    nonisolated static func probeSocketPaths(
        _ transport: DaemonProbe, paths: [String]
    ) -> (index: Int, liveness: DaemonProbe.Liveness) {
        var silent: (index: Int, reason: String)?
        var absent: (index: Int, reason: String)?
        for (index, path) in paths.enumerated() {
            switch transport.liveness(socketPath: path) {
            case .answered(let summary):
                return (index, .answered(summary))
            case .presentButNotAnswering(let reason):
                if silent == nil { silent = (index, reason) }
            case .noListener(let reason):
                if absent == nil { absent = (index, reason) }
            }
        }
        if let silent {
            return (silent.index, .presentButNotAnswering(reason: silent.reason))
        }
        let fallback = absent ?? (0, "no name was resolved to probe")
        let index = min(max(fallback.index, 0), max(paths.count - 1, 0))
        let tried = paths.joined(separator: "、")
        return (index, .noListener(reason: "\(fallback.reason)——这一页探过 \(paths.count) 个名字：\(tried)"))
    }

    /// 这一页连的是哪一个名字，以及那个名字是**谁**点名的。与
    /// `ConsoleModel.displayedStateRootCaption` 同一套说法：屏幕上并排两行"状态根"时，
    /// 读者要能看出它们说的是不是同一个实例。
    var daemonSocketOriginCaption: String {
        var text = "面板探的是 \(socketSource.caption)：\(daemon.socketPath)"
        if let root = daemon.stateRoot, !root.isEmpty {
            text += "；服务端自己报的根 \(root)"
        } else if socketCandidates.count > 1 {
            text += "（回落表里 \(socketCandidates.count) 个名字都没报回状态根）"
        }
        return text
    }

    /// 重查全部权限与 daemon 状态：一次真实的 hello 握手（3s 会话，放后台不阻塞主线程）。
    ///
    /// 这里刻意不再取 `reachable(socketPath:)` 的数——那个函数只回答"文件在不在"，
    /// 拿它当存活判据就是"灯亮着而服务早没了"这一类缺陷的由来。
    func refresh() {
        isRefreshing = true
        let transport = daemonProbe
        let paths = socketCandidates
        Task.detached(priority: .userInitiated) {
            let outcome = Self.probeSocketPaths(transport, paths: paths)
            Task { @MainActor in
                self.applySocketProbe(outcome, paths: paths)
                self.isRefreshing = false
            }
        }
    }

    /// 一次逐个探测的结局落到发布状态上：赢家的名字与出处一起换，灯跟着实测走。
    private func applySocketProbe(
        _ outcome: (index: Int, liveness: DaemonProbe.Liveness), paths: [String]
    ) {
        let path = paths.indices.contains(outcome.index) ? paths[outcome.index] : daemon.socketPath
        if path != daemon.socketPath {
            daemon.socketPath = path
            if socketCandidateEntries.indices.contains(outcome.index) {
                socketSource = socketCandidateEntries[outcome.index].source
            }
        }
        applyLiveness(outcome.liveness)
    }

    /// 一次性存活实测（后台队列，带在途保护）。
    /// nil = 这一轮根本没跑（已有在途），调用方必须保持现状，不得据此改灯。
    private func probeLiveness() async -> DaemonProbe.Liveness? {
        guard !probeInFlight else { return nil }
        probeInFlight = true
        defer { probeInFlight = false }
        let paths = socketCandidates
        let transport = daemonProbe
        let outcome = await withCheckedContinuation {
            (continuation: CheckedContinuation<(index: Int, liveness: DaemonProbe.Liveness), Never>) in
            DispatchQueue.global(qos: .userInitiated).async {
                continuation.resume(returning: Self.probeSocketPaths(transport, paths: paths))
            }
        }
        await MainActor.run { self.applySocketProbe(outcome, paths: paths) }
        return outcome.liveness
    }

    /// 把一次实测的存活结局落到发布状态上：daemon 自报什么就显示什么；没有回话
    /// 就没有自报，权限卡一律 `unverifiable` + 注记，不用面板进程的席位冒充。
    ///
    /// 从前这里写着"探测失败不推翻此前的 reachable=true 判定"，那句话就是这个缺陷
    /// 本身的形状：残留 socket 让绿点一直亮着，而它下面四张卡说服务没在运行。
    /// 现在没有回话就灭灯，重新应门才会再亮。
    private func applyLiveness(_ liveness: DaemonProbe.Liveness) {
        switch liveness {
        case .answered(let summary):
            daemon.liveness = .answering
            daemon.version = summary.version
            daemon.protocolVersion = summary.protocolVersion
            daemon.pid = summary.pid
            daemon.subject = summary.subject
            daemon.stateRoot = summary.stateRoot
            daemon.approvalPersistFailed = summary.approvalPersistFailed
            daemonReportedStatuses = summary.permissions
            if let probePid = developerToolsProbePid, probePid != summary.pid {
                // daemon 换过进程：上一次"验证调试能力"的结论不再代表现状。
                invalidateDeveloperToolsVerdict()
            }
        case .noListener:
            clearDaemonReport(to: .notRunning)
        case .presentButNotAnswering(let reason):
            clearDaemonReport(to: .presentButSilent(reason: reason))
        }
        rebuildEntries()
    }

    /// 没回话时能读到的东西就是没有：版本号 / 协议 / PID / 身份 / 自报席位一起清空。
    /// 留着任何一个都是"上一次测量的结论冒充这一次的现状"。
    private func clearDaemonReport(to liveness: DaemonLiveness) {
        daemon.liveness = liveness
        daemon.version = nil
        daemon.protocolVersion = nil
        daemon.pid = nil
        daemon.subject = nil
        daemon.stateRoot = nil
        daemon.approvalPersistFailed = nil
        daemonReportedStatuses = [:]
    }

    /// 侧栏那行"服务端的根"。旧版 daemon 的 hello 不带这个键，这里就写没上报——
    /// 面板自己那一份 `ConsoleModel.displayedStateRoot` 是**这一页读数用的根**，
    /// 两者可以不同（smoke.md 记过这条歧义），所以谁也不能替谁填。
    var daemonStateRootCaption: String {
        guard let root = daemon.stateRoot, !root.isEmpty else { return "状态根未上报" }
        return "服务端的根 \(root)"
    }

    /// 由 daemon 自报席位 + 重探结果重算卡片状态与注记。
    private func rebuildEntries() {
        let reported = daemonReportedStatuses
        let restartKinds = Set(kindsNeedingRestart)
        for index in entries.indices {
            let kind = entries[index].kind
            if kind == .developerTools {
                entries[index].status = .unverifiable
                entries[index].statusNote = nil
                continue
            }
            if let status = reported[kind] {
                entries[index].status = status
                entries[index].statusNote = restartKinds.contains(kind)
                    ? "系统设置里已勾选，重启后台服务后生效"
                    : nil
            } else {
                entries[index].status = .unverifiable
                entries[index].statusNote = noReportNote
            }
        }
    }

    /// "这张卡为什么没有状态"那一句，按实测到的存活结局分两种说法：没在运行、
    /// 应了门但不回话是两件不同的事——后者让人去重启一个其实还活着的进程就是支错招。
    private var noReportNote: String {
        if case .presentButSilent = daemon.liveness { return Self.silentDaemonReportNote }
        return Self.noDaemonReportNote
    }

    /// 那一行现在写的是**哪一次**引导：每一次新引导与用户手动关闭都让它前进，
    /// 迟到的提交结局据此决定自己还能不能说上话（`requestPermissionViaDaemon`）。
    private var guideEpoch = 0
    /// 当前横幅属于哪一次拖入（提交结局回来时要把那半句一起续上，不能只留结论）。
    private var pendingDroppedName: String?

    private func setPendingGuide(
        _ kind: PermissionKind,
        droppedName: String? = nil,
        stage: DaemonRequestStage? = nil
    ) {
        guideEpoch += 1
        pendingGuideKind = kind
        pendingDroppedName = droppedName
        pendingGuideText = Self.guideText(
            for: kind, subject: daemon.subject, stage: stage, droppedName: droppedName
        )
    }

    /// 用户关掉这条横幅： epoch 必须一起前进，否则上一次提交的结局会把
    /// 一条刚被关掉的横幅再画回来（"我关掉了它，它又自己出现"不是诚实呈现）。
    func dismissPendingGuide() {
        guideEpoch += 1
        pendingDroppedName = nil
        pendingGuideKind = nil
        pendingGuideText = nil
    }
}
