import SwiftUI

/// GlassPane 面板入口（P1 spec v1.2 §6.2，控制台化见同文件 §12）。
///
/// 主窗口 = 左侧导航（权限 / 证据档案 / 项目 / 审批台账）+ 右侧内容；
/// 菜单栏项 = 轻量入口（打开主窗口 / 刷新 / 退出）。
/// 面板不持久化任何配置：权限状态实时检测，档案每次进页重读。
@main
struct GlassPaneSettingsApp: App {
    @StateObject private var model: SettingsModel
    @StateObject private var console: ConsoleModel
    @StateObject private var updates: UpdateModel

    init() {
        let settings = SettingsModel(socketPath: Self.resolveSocketPath())
        _model = StateObject(wrappedValue: settings)
        _console = StateObject(wrappedValue: ConsoleModel())
        _updates = StateObject(wrappedValue: UpdateModel())
    }

    /// 解析 `--socket-path <path>`（与 daemon CLI 同语义；缺省用默认路径）。
    private static func resolveSocketPath() -> String? {
        let arguments = CommandLine.arguments
        var index = 1
        while index < arguments.count {
            let argument = arguments[index]
            if argument == "--socket-path" {
                if index + 1 < arguments.count {
                    return arguments[index + 1]
                }
                return nil
            }
            if argument.hasPrefix("--socket-path=") {
                let value = String(argument.dropFirst("--socket-path=".count))
                return value.isEmpty ? nil : value
            }
            index += 1
        }
        return nil
    }

    var body: some Scene {
        // 带 id 的唯一窗口：菜单里那一枚要用它点名同一个去处（见 `SettingsWindow`）。
        // 用 `Window` 而不是 `WindowGroup`：这一面板只有一个窗口，重复的打开请求
        // 应当把它前置，而不是再开第二个——修一个"点了没反应"不该顺手把窗口变成 N 个。
        Window(SettingsWindow.title, id: SettingsWindow.id) {
            ConsoleRootView()
                .environmentObject(model)
                .environmentObject(console)
                .environmentObject(updates)
                .frame(minWidth: 820, minHeight: 560)
        }
        .commands {
            // 键盘入口：菜单栏里"刷新"要同时刷新权限与档案，与侧栏底部那枚
            // 按钮同一语义，不留两套口径。
            CommandGroup(after: .toolbar) {
                Button("刷新状态") {
                    model.refresh()
                    console.refreshAll()
                    updates.refresh()
                }
                .keyboardShortcut("r", modifiers: [.command])
            }
        }
        MenuBarExtra("GlassPane", systemImage: "gearshape.2") {
            SettingsMenuBarContent(model: model, console: console, updates: updates)
        }
    }
}

/// 设置窗口这件事在屏幕上的唯一说法。
enum SettingsWindow {
    /// 场景 id：菜单项与 `Window` 声明共用同一个名字，两边不可能指向不同的窗口。
    static let id = "settings"
    static let title = "GlassPane 设置"

    /// 「打开设置面板」按下去做什么。
    ///
    /// 从前这一枚只做一件事：遍历 `NSApplication.shared.windows`，把标题对得上的那几个
    /// `makeKeyAndOrderFront`——窗口已经关了（Cmd-W 关掉，`MenuBarExtra` 让进程还活着）
    /// 就再没有对得上的窗口，于是它按下去什么都不发生，也什么都不说。
    /// 现在它走 `openWindow(id:)`：没有就新开一个，有就前置。
    ///
    /// 那句话**不写"窗口已打开"**：`openWindow` 没有回话，这一枚测不到窗口有没有真的
    /// 出现在屏幕上，宣称它出现了就是替一件没观测到的事背书。所以按下去仍然看不见时，
    /// 同一个地方给出下一步。
    static let openHelp = "设置窗口在屏幕上就把它带到前面，不在（比如被 Cmd-W 关掉了）就新开一个。"
        + "这一枚只能发出打开请求，它读不到窗口有没有真的出现：按下去仍然看不见时，"
        + "下一步先用菜单里的「刷新状态」确认后台服务还在应门，还是没有窗口就用「退出」关掉面板再重新打开。"

    /// 菜单里「刷新状态」那一句：它与侧栏底部那枚同语义，不留两套口径。
    static let refreshHelp = "重新测一次权限状态、证据档案与更新结论——与侧栏底部那枚「刷新」同一语义。"
}

/// 菜单栏那一屏。单独成一个 `View`：`@Environment(\.openWindow)` 只能在视图里取，
/// 而 `App` 的 `body` 取不到它——这正是从前那枚按钮只能去遍历窗口列表的原因。
struct SettingsMenuBarContent: View {
    @Environment(\.openWindow) private var openWindow
    @ObservedObject var model: SettingsModel
    @ObservedObject var console: ConsoleModel
    @ObservedObject var updates: UpdateModel

    var body: some View {
        Button("打开设置面板") {
            // 没有那个窗口时新开一个，有就前置；随后把应用带回前台
            // （菜单栏场景自己不抢焦点）。
            openWindow(id: SettingsWindow.id)
            NSApplication.shared.activate(ignoringOtherApps: true)
        }
        .help(SettingsWindow.openHelp)
        .accessibilityIdentifier("gp-open-settings-panel")
        Button("刷新状态") {
            model.refresh()
            console.refreshAll()
            updates.refresh()
        }
        .help(SettingsWindow.refreshHelp)
        Divider()
        Button("退出") {
            NSApplication.shared.terminate(nil)
        }
    }
}
