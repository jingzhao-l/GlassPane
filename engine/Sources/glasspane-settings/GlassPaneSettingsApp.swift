import SwiftUI

/// 面板窗口标题与场景标识的**唯一真源**：WindowGroup 的标题、菜单里前置窗口时的
/// 标题比对、页内大标题三处共用同一个常量。此前这个字面量抄了三份（外加
/// `.c6_smoke.py` 里的第四份），改任何一处都会让菜单项静默选不中窗口。
enum SettingsPanelScene {
    static let title = "GlassPane 设置"
    static let windowID = "glasspane-settings"
}

/// GlassPane 设置面板入口（P1 spec v1.2 §6.2）。
///
/// 主窗口 = 权限清单卡片 + daemon 状态卡 + 拒绝降级形态折叠区；
/// 菜单栏项 = 轻量入口（打开主窗口 / 刷新 / 退出）。
/// 面板不持久化任何配置：权限状态实时检测，刷新即重查。
///
/// 面板**不接受 `--state-dir`**（daemon 才有那个参数）。它不写 projects.json、
/// 不写审批台账、不删证据档案——它只连一个 daemon，读它的权限席位并把申请/重启
/// 请求转过去。在这里加一个"状态根"参数不会搬动任何数据，只会让用户以为面板
/// 换了数据面；要指向另一个 daemon，用 `--socket-path`，那才是面板唯一的定位参数。
/// 默认那条路径与 daemon 同源（`SettingsModel.defaultSocketPath` → `StateRoot`），
/// 不再在本文件里另算一遍。
@main
struct GlassPaneSettingsApp: App {
    @StateObject private var model: SettingsModel

    init() {
        switch Self.socketPathArgument() {
        case .unspecified:
            // Nothing named: resolve through the shared rule, i.e. the socket of
            // the daemon running on its default state root.
            _model = StateObject(wrappedValue: SettingsModel(socketPath: nil))
        case .path(let path):
            _model = StateObject(wrappedValue: SettingsModel(socketPath: path))
        case .malformed(let reason):
            Self.refuseToStart(reason)
        }
    }

    /// `--socket-path` 的三种结局：**没写这个参数** / 写了且给出可用路径 /
    /// 写了但取值读不出（缺值、空值、把下一个参数当成值）。
    enum SocketPathArgument: Equatable {
        case unspecified
        case path(String)
        case malformed(String)
    }

    /// 区分"没写"与"写了但打错"：后者**绝不**静默回落到默认路径——默认 socket 是
    /// 真实后台服务的，一次隔离参数笔误就会把授权、重启这些动作全落在它身上。
    static func socketPathArgument() -> SocketPathArgument {
        let arguments = CommandLine.arguments
        let flag = "--socket-path"
        var index = 1
        while index < arguments.count {
            let argument = arguments[index]
            if argument == flag {
                guard index + 1 < arguments.count else {
                    return .malformed("\(flag) 后面没有取值")
                }
                let value = arguments[index + 1]
                if value.isEmpty {
                    return .malformed("\(flag) 的取值是空字符串")
                }
                if value.hasPrefix("--") {
                    return .malformed("\(flag) 的取值像是另一个参数（\(value)）")
                }
                return .path(value)
            }
            if argument.hasPrefix(flag + "=") {
                let value = String(argument.dropFirst(flag.count + 1))
                return value.isEmpty
                    ? .malformed("\(flag)= 的取值是空字符串")
                    : .path(value)
            }
            index += 1
        }
        return .unspecified
    }

    /// 参数打错就**不启动**（退出码 64，与 daemon 的用法错误同口径），并把原因写到
    /// stderr：静默改用缺省 socket 起面板，比干脆不起更糟——缺省那条路径上是真实的
    /// 后台服务，随后的授权、重启动作会全落在它身上。
    static func refuseToStart(_ reason: String) -> Never {
        let lines = [
            "glasspane-settings 启动参数有误：\(reason)",
            "用法：glasspane-settings [--socket-path <socket 路径>]",
            "本面板没有 --state-dir：它不持有状态面（不写注册表、不写审批台账、不删证据档案），",
            "要连哪一个后台服务只由 --socket-path 决定；不传即按 daemon 的默认 socket 解析。",
            "已拒绝启动：不回落缺省 socket 路径（那是真实后台服务在用的），"
                + "把取值补全后重新运行本命令。",
        ]
        FileHandle.standardError.write(Data((lines.joined(separator: "\n") + "\n").utf8))
        exit(64)
    }

    var body: some Scene {
        WindowGroup(SettingsPanelScene.title, id: SettingsPanelScene.windowID) {
            SettingsPanelView()
                .environmentObject(model)
                .frame(minWidth: 520, minHeight: 560)
        }
        MenuBarExtra("GlassPane", systemImage: "gearshape.2") {
            OpenSettingsWindowButton()
            Button("刷新状态") {
                model.refresh()
            }
            Divider()
            Button("退出") {
                NSApplication.shared.terminate(nil)
            }
        }
    }
}

/// 菜单里的「打开设置面板」：窗口还开着就激活并前置它，已经被关掉就**再开一扇**。
/// 旧实现只遍历 `NSApplication.shared.windows`，从不请求建窗——用户关窗后这条菜单
/// 项永久 no-op，而 MenuBarExtra 让进程一直活着，症状是"点了没反应，只能重启面板"。
private struct OpenSettingsWindowButton: View {
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Button("打开设置面板") {
            // 菜单栏场景不抢焦点：先激活，再决定是前置现有窗口还是新建一个。
            NSApplication.shared.activate(ignoringOtherApps: true)
            if let window = existingPanelWindow {
                window.makeKeyAndOrderFront(nil)
            } else {
                openWindow(id: SettingsPanelScene.windowID)
            }
        }
    }

    /// 现存的面板窗口（标题与 WindowGroup 同源，比对才不会落空）。
    private var existingPanelWindow: NSWindow? {
        NSApplication.shared.windows.first { $0.title == SettingsPanelScene.title }
    }
}
