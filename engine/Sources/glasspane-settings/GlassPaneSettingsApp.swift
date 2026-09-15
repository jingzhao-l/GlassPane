import SwiftUI

/// GlassPane 设置面板入口（P1 spec v1.2 §6.2）。
///
/// 主窗口 = 权限清单卡片 + daemon 状态卡 + 拒绝降级形态折叠区；
/// 菜单栏项 = 轻量入口（打开主窗口 / 刷新 / 退出）。
/// 面板不持久化任何配置：权限状态实时检测，刷新即重查。
@main
struct GlassPaneSettingsApp: App {
    @StateObject private var model: SettingsModel

    init() {
        _model = StateObject(wrappedValue: SettingsModel(socketPath: Self.resolveSocketPath()))
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
            SettingsPanelView()
                .environmentObject(model)
                .frame(minWidth: 520, minHeight: 560)
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
            }
            Divider()
            Button("退出") {
                NSApplication.shared.terminate(nil)
            }
        }
    }
}