import SwiftUI
import GlassPaneEngine

/// 「更新」页：这台机器装的 GlassPane 新不新、下一次会不会自己动、
/// 不动的时候怎么让它现在动一次。
///
/// 这一页只做两件事：把更新器回的那一行读成人话，以及把两个按钮开在
/// 该开的地方。下载、校验、换版、重启后台服务全在更新器那一条命令里，
/// 面板不留第二套实现——所以这里也**没有**任何重启入口：换版后的重启
/// 由更新器在它自己确认空闲之后做，早一步都会打断用户眼前的动作。
///
/// 呈现纪律与其余页一致：状态用"文字 + 带标识的图标"双表达，不靠颜色；
/// 读不到的东西一律写"读不到"，不折算成"没有新版本"。
struct UpdateTabView: View {
    @EnvironmentObject private var model: UpdateModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                statusCard
                if let prompt = model.promptText {
                    promptBanner(prompt)
                }
                actionCard
                if let failure = model.readFailure {
                    // 指针没了 / 那一行读不出来：先说这一句，再谈版本。
                    failureCard(UpdatePanel.failureText(failure))
                } else if let error = model.errorText, showsErrorLine {
                    failureCard(error)
                }
                updaterCard
            }
            .padding(20)
            .frame(maxWidth: 760, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear { model.refresh() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 7) {
                Image(systemName: "arrow.triangle.2.circlepath").font(.title3).foregroundStyle(.secondary)
                Text("更新").font(.title2.bold())
                Spacer()
                if model.isRunning {
                    HStack(spacing: 5) {
                        ProgressView().controlSize(.small)
                        Text(runningCaption).font(.caption).foregroundStyle(.secondary)
                    }
                } else {
                    Button {
                        model.refresh()
                    } label: {
                        Label("刷新", systemImage: "arrow.clockwise")
                    }
                    .controlSize(.small)
                    .accessibilityIdentifier("gp-update-refresh")
                }
            }
            Text("这台机器上装的 GlassPane 每天自动检查一次并装新版本。到点时电脑是关着的、或者装上后没通过自检，都会在这一页告诉你，并给出你现在能按的按钮。")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var runningCaption: String {
        switch model.runningCommand {
        case .check: return "正在问源上有没有新版本……"
        case .apply: return "正在安装，可能要几分钟（它只在后台服务空闲时动手）"
        case .enable, .disable: return "正在改动定时检查……"
        case .status, nil: return "正在读更新状态……"
        }
    }

    /// 这一页是否连一份状态都没读到——读到了才把状态文档里的原话摆出来，
    /// 否则页面上方那句失败原因已经说清了状况。
    private var showsErrorLine: Bool {
        guard let status = model.status else { return false }
        switch status {
        case .upToDate, .applied, .disabled:
            return false
        default:
            return true
        }
    }

    // MARK: - 状态卡

    private var statusCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                StatusDotView(tone: statusTone)
                Text(statusHeadline)
                    .font(.callout.weight(.semibold))
                    .accessibilityIdentifier("gp-update-status")
                if let raw = model.status?.rawValue {
                    ChipView(text: raw, color: .secondary, identifier: "gp-update-status-code")
                }
                Spacer()
            }
            Divider()
            DetailRowView(label: "当前版本", value: model.snapshot?.current ?? "读不到")
            DetailRowView(label: "最新版本", value: model.snapshot?.latest ?? "读不到")
            DetailRowView(label: "上次检查", value: model.lastCheckText)
            DetailRowView(label: "待装版本", value: model.snapshot?.stagedVersion ?? "没有")
            digestRow
        }
        .consoleCard(tint: cardTint)
    }

    /// 校验和原样给出（64 位十六进制），并说明它是拿来跟发布页核对的——
    /// 这个仓库的 release 标签没有签名，所以"是谁做的"这件事只能由人来认。
    private var digestRow: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("暂存校验和")
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 92, alignment: .leading)
            if let digest = model.snapshot?.stagedDigest {
                Text(digest)
                    .font(.caption.monospaced())
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
                    .help(digest)
                    .accessibilityIdentifier("gp-update-digest")
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(digest, forType: .string)
                } label: {
                    Image(systemName: "doc.on.doc").font(.caption2)
                }
                .buttonStyle(.borderless)
                .help("复制校验和，与发布页上的 SHA256SUMS 核对")
                .accessibilityIdentifier("gp-copy-update-digest")
            } else {
                Text("没有已暂存的版本")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
    }

    private var statusHeadline: String {
        if let failure = model.readFailure, model.snapshot == nil {
            return UpdatePanel.failureText(failure)
        }
        guard let status = model.status else { return UpdatePanel.unreadableText }
        return status.caption
    }

    private var statusTone: StatusDotView.Tone {
        guard let status = model.status else { return .neutral }
        switch status {
        case .upToDate, .applied: return .good
        case .deferred, .disabled, .needsConsent, .checkOverdue: return .warning
        case .available, .staged: return .good
        case .rolledBack, .checkFailed, .stagedBuildFailed, .applyFailed,
             .rollbackFailed, .installerPointerStale: return .bad
        }
    }

    private var cardTint: Color? {
        guard let status = model.status else { return nil }
        if !status.needsAttention { return nil }
        switch status {
        case .rollbackFailed, .applyFailed, .installerPointerStale, .checkFailed, .stagedBuildFailed:
            return .red
        default:
            return .orange
        }
    }

    // MARK: - 提示条

    private func promptBanner(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "info.circle.fill").foregroundStyle(.blue)
            Text(text)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("gp-update-prompt")
            Spacer()
        }
        .padding(10)
        .background(Color.blue.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func failureCard(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: 6) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.callout)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("gp-update-failure-icon")
                Text(text)
                    .font(.callout)
                    .foregroundStyle(.primary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("gp-update-failure")
            }
            Text("这句话是更新器原样给的，可以选中后复制。")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .consoleCard(tint: .red)
    }

    // MARK: - 动作卡

    private var actionCard: some View {
        let buttons = model.buttons
        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Button("立即检查") { model.checkNow() }
                    .controlSize(.small)
                    .accessibilityIdentifier("gp-update-check")
                    .disabled(!buttons.checkEnabled)
                    .help(buttons.checkReason ?? "现在问一次源上有没有新版本")

                Button("安装更新") { model.applyUpdate() }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .accessibilityIdentifier("gp-update-apply")
                    .disabled(!buttons.applyEnabled)
                    .help(buttons.applyReason ?? "装那份已经校验过的新版本")

                Spacer()

                Toggle(isOn: autoUpdateBinding) {
                    Text("自动更新").font(.callout)
                }
                .toggleStyle(.switch)
                .controlSize(.small)
                .disabled(!buttons.toggleEnabled)
                .help(buttons.toggleReason ?? "每天到点自动检查并安装（跨大版本不算，它永远等你按按钮）")
                .accessibilityIdentifier("gp-update-auto")
            }
            // 不可用的理由必须看得见：只把按钮灰掉，用户读到的是"界面坏了"。
            if !buttons.checkEnabled, let reason = buttons.checkReason {
                reasonLine(key: "check", title: "立即检查", reason: reason)
            }
            if !buttons.applyEnabled, let reason = buttons.applyReason {
                reasonLine(key: "apply", title: "安装更新", reason: reason)
            }
            if !buttons.toggleEnabled, let reason = buttons.toggleReason {
                reasonLine(key: "auto", title: "自动更新", reason: reason)
            }
            Text("关掉自动更新后，这两个按钮照样能用；换版成功与否都会写在上面那一行状态里。")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .consoleCard()
    }

    /// `key` 是标识里的 ASCII 段：标识放中文，自动化按标识选不中元素。
    private func reasonLine(key: String, title: String, reason: String) -> some View {
        HStack(alignment: .top, spacing: 5) {
            Image(systemName: "lock.circle")
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text("「\(title)」现在按不动：\(reason)")
                .font(.caption)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("gp-update-reason-\(key)")
        }
    }

    /// 开关的读值永远来自状态文档：点下去之后由更新器回的那一行决定
    /// 它是开还是关，面板不自作主张先把滑块挪过去。
    private var autoUpdateBinding: Binding<Bool> {
        Binding(
            get: { model.autoUpdateOn ?? false },
            set: { model.setAutoUpdate($0) }
        )
    }

    // MARK: - 更新器在哪

    private var updaterCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(
                title: "更新器",
                subtitle: "定时检查与手动按钮走的都是同一个程序。",
                systemImage: "externaldrive"
            )
            VStack(alignment: .leading, spacing: 6) {
                if let cli = model.pointer.cliPath {
                    PathRowView(label: "程序", path: cli, identifierKey: "updater-cli")
                } else {
                    PathRowView(label: "记录", path: model.pointerFile, identifierKey: "updater-pointer")
                }
                HStack(spacing: 6) {
                    Text("状态根")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(width: 52, alignment: .leading)
                    Text(model.stateRoot)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                        .help(model.stateRoot)
                    Spacer()
                }
            }
        }
        .consoleCard()
    }
}
