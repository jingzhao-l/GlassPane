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

    init() {
        let settings = SettingsModel(socketPath: Self.resolveSocketPath())
        _model = StateObject(wrappedValue: settings)
        _console = StateObject(wrappedValue: ConsoleModel())
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
        WindowGroup("GlassPane 设置") {
            ConsoleRootView()
                .environmentObject(model)
                .environmentObject(console)
                .frame(minWidth: 820, minHeight: 560)
        }
        .commands {
            // 键盘入口：菜单栏里"刷新"要同时刷新权限与档案，与侧栏底部那枚
            // 按钮同一语义，不留两套口径。
            CommandGroup(after: .toolbar) {
                Button("刷新状态") {
                    model.refresh()
                    console.refreshAll()
                }
                .keyboardShortcut("r", modifiers: [.command])
            }
        }
        MenuBarExtra("GlassPane", systemImage: "gearshape.2") {
            Button("打开设置面板") {
                // 通过 AppKit 激活并前置主窗口（菜单栏场景不抢焦点）。
                NSApplication.shared.activate(ignoringOtherApps: true)
                for window in NSApplication.shared.windows {
                    if window.title == "GlassPane 设置" {
                        window.makeKeyAndOrderFront(nil)
                    }
                }
            }
            Button("刷新状态") {
                model.refresh()
                console.refreshAll()
            }
            Divider()
            Button("退出") {
                NSApplication.shared.terminate(nil)
            }
        }
    }
}
