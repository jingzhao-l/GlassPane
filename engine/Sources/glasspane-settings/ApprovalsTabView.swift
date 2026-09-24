import SwiftUI
import AppKit
import GlassPaneEngine

/// 审批台账页（控制台「审批」页）。
///
/// 台账是一条 SHA-256 签名链（P5 §3）：任何一条历史记录被改过，其后所有哈希
/// 都对不上。面板把校验结论如实呈现——完整、断裂在第几条、或者文件根本读不开。
///
/// 诚实呈现的重点：当前协议里没有人类审批交互，高风险操作的记录由后台服务
/// 自登记（`daemon:auto`）。面板不会把这种记录显示成"人已批准"。
struct ApprovalsTabView: View {
    @EnvironmentObject private var model: ConsoleModel

    var body: some View {
        VStack(spacing: 0) {
            PageTitleView(title: "审批台账", systemImage: "checkmark.seal")
                .padding(.horizontal, 12)
                .padding(.top, 12)
            switch model.approvalsState {
            case .loading, .idle:
                ProgressView().controlSize(.small)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failed(let message):
                EmptyStateView(
                    systemImage: "exclamationmark.triangle",
                    title: "台账读不了",
                    message: message,
                    actionTitle: "重试",
                    action: { model.reloadApprovals() }
                )
            case .loaded:
                if let report = model.approvalReport {
                    if report.records.isEmpty {
                        EmptyStateView(
                            systemImage: "checkmark.seal",
                            title: report.fileExists ? "台账是空的" : "还没有台账文件",
                            message: "执行过一次高风险操作（如回滚）后，这里会出现带签名链的审批记录。"
                        )
                    } else {
                        chainBanner(report)
                        recordList(report)
                    }
                }
            }
        }
        .toolbar {
            ToolbarItem(placement: .automatic) {
                Button {
                    model.reloadApprovals()
                } label: {
                    Label("刷新", systemImage: "arrow.clockwise")
                }
                .help("重新读取台账并校验签名链")
                .accessibilityIdentifier("gp-refresh-approvals")
            }
            ToolbarItem(placement: .automatic) {
                Button {
                    NSWorkspace.shared.selectFile(
                        nil, inFileViewerRootedAtPath: (ApprovalGate.defaultPath as NSString).deletingLastPathComponent
                    )
                } label: {
                    Label("台账文件", systemImage: "folder")
                }
                .help("在访达中显示 approvals.json")
            }
        }
    }

    // MARK: - 链校验结论

    private func chainBanner(_ report: ApprovalLedgerReport) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: chainIcon)
                .font(.title3)
                .foregroundStyle(chainColor)
            VStack(alignment: .leading, spacing: 3) {
                Text(chainTitle)
                    .font(.callout.weight(.semibold))
                Text(chainSubtitle(report))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 4) {
                ChipView(
                    text: "\(report.records.count) 条记录",
                    color: .secondary,
                    systemImage: "list.number"
                )
                if report.autoApprovedHighRiskCount > 0 {
                    ChipView(
                        text: "\(report.autoApprovedHighRiskCount) 条自批",
                        color: .orange,
                        systemImage: "exclamationmark.circle"
                    )
                }
            }
        }
        .padding(12)
        .consoleCard(tint: chainColor)
        .padding(12)
        .accessibilityIdentifier(chainIdentifier(report))
    }

    private var chainIcon: String {
        guard let report = model.approvalReport else { return "questionmark.circle" }
        if report.loadFailed { return "exclamationmark.triangle.fill" }
        return report.chainValid ? "checkmark.seal.fill" : "lock.open.fill"
    }

    private var chainColor: Color {
        guard let report = model.approvalReport else { return .secondary }
        if report.loadFailed { return .red }
        return report.chainValid ? .green : .red
    }

    private var chainTitle: String {
        guard let report = model.approvalReport else { return "台账状态未知" }
        if report.loadFailed { return "台账文件读不开" }
        return report.chainValid ? "签名链完整" : "签名链已断裂"
    }

    private func chainSubtitle(_ report: ApprovalLedgerReport) -> String {
        if report.loadFailed {
            return "文件存在但解不开。这种状态下不要把台账当作可信记录——先确认它是否被截断或改写过。"
        }
        if !report.chainValid, let index = report.firstBrokenIndex {
            return "第 \(index + 1) 条起的哈希与链不符，说明该条或其之前的内容被改动过。"
        }
        var text = "每条记录的哈希都覆盖前一条，改动任何历史都会在这里暴露。"
        if report.autoApprovedHighRiskCount > 0 {
            text += " 其中 \(report.autoApprovedHighRiskCount) 条高风险操作由后台服务自行登记——当前版本没有人工审批入口，这些不是人批的。"
        }
        return text
    }

    private func chainIdentifier(_ report: ApprovalLedgerReport) -> String {
        if report.loadFailed { return "gp-approval-load-failed" }
        return report.chainValid ? "gp-approval-chain-valid" : "gp-approval-chain-broken"
    }

    // MARK: - 记录列表

    private func recordList(_ report: ApprovalLedgerReport) -> some View {
        ScrollView {
            LazyVStack(spacing: 8) {
                ForEach(Array(report.records.enumerated()), id: \.element.approvalId) { index, record in
                    ApprovalRowView(index: index, record: record)
                }
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 12)
        }
    }
}

/// 单条审批记录。
struct ApprovalRowView: View {
    let index: Int
    let record: ApprovalRecord

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Text("\(index + 1)")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.tertiary)
                .frame(width: 24, alignment: .trailing)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(record.operationType).font(.callout.weight(.semibold))
                    Text(record.operationRef)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer()
                    Text(ConsoleTheme.timestamp(record.timestamp))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Text(record.reason)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 5) {
                    ChipView(text: riskText, color: riskColor, systemImage: riskIcon)
                    ChipView(
                        text: record.decision == .approve ? "已批准" : "已拒绝",
                        color: record.decision == .approve ? .green : .red,
                        systemImage: record.decision == .approve ? "checkmark" : "xmark"
                    )
                    if record.approvedBy == ApprovalGate.autoApprover {
                        ChipView(text: "后台服务自批", color: .orange, systemImage: "desktopcomputer")
                    } else {
                        ChipView(text: "由 \(record.approvedBy) 批准", color: .blue, systemImage: "person")
                    }
                }
            }
        }
        .padding(10)
        .consoleCard()
    }

    private var riskText: String {
        switch record.riskTier {
        case .low: return "低风险"
        case .medium: return "中风险"
        case .high: return "高风险"
        }
    }

    private var riskColor: Color {
        switch record.riskTier {
        case .low: return .secondary
        case .medium: return .blue
        case .high: return .red
        }
    }

    private var riskIcon: String {
        switch record.riskTier {
        case .low: return "shield"
        case .medium: return "shield.lefthalf.filled"
        case .high: return "exclamationmark.shield"
        }
    }
}
