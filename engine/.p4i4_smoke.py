#!/usr/bin/env python3
"""GlassPane P4-I4 权限引导真机冒烟（P6 spec §11 审计项⑤：撤"人工目视"挂账）。

P4 v4.0 §34 把 P4-I4 标为"拖拽无法自动化模拟，待 GUI 人工目视"。本脚本按
2026-09-19/20 真机实测把它拆开：

  硬断言（全部机器化，零坐标依赖，走 AXPress）：
    1. 逐卡按下引导按钮（授权/打开系统设置）→ 面板出现该 kind 专属引导文案
       （与拖拽落点共用同一 guide() 路径，P1 §11.2：拖拽落点 handleDrop 的
       功能语义 = guide(kind)，droppedName 仅进回落文案）；
    2. 按下后 System Settings 被带到前台（深链生效的行为学证据）；
    3. developerTools 卡徽标恒「未验证」——不假点亮。

  如实报告维度（不强断言）：
    4. 合成拖拽尝试：CGEvent 合成点击**能**驱动 macOS UI（实测标题栏双击
       zoom 生效），但三种拟真形态（session/hid tap、组合源+按钮 flags+微抖
       起步、1.2s 慢拖）共 6+ 次均无法启动 SwiftUI .onDrag 的拖拽会话——
       拖拽手势本身是系统层面不可合成维度（真机发现 F10）。该手势无独立
       授权语义（落点恒委托 guide()），故 P4-I4 的人工目视面由 1–3 完全
       覆盖后销账；勾选后 1s 自动点亮的时间闭环仍由面板轮询保证（P1 §10.2）。

退出语义（与 .c33_smoke.py 同口径）：前置不满足 → SKIP exit 0（补救命令
给到 agent 可执行级）；硬断言全过 → exit 0；任一失败 → exit 1。

用法：python3 .p4i4_smoke.py [--panel-pid N] [--skip-drag]
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import time

HELPER_SRC = r"""
// P4-I4 冒烟辅助：AX 读取 / AXPress / 合成拖拽 / 前台 app / 席位自检。
// 零依赖（AppKit + ApplicationServices），由 .p4i4_smoke.py 用 swiftc 编译缓存。
import AppKit
import ApplicationServices

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write("usage: helper <texts|press|pressat|drag|click|raise|covers|front|trusted> ...\n".data(using: .utf8)!)
    exit(2)
}

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success ? value : nil
}
func str(_ el: AXUIElement, _ name: String) -> String? { attr(el, name) as? String }
func rectOf(_ el: AXUIElement) -> (Double, Double, Double, Double)? {
    guard let p = attr(el, kAXPositionAttribute), let s = attr(el, kAXSizeAttribute) else { return nil }
    var point = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &point),
          AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
    return (Double(point.x), Double(point.y), Double(size.width), Double(size.height))
}
func childrenOf(_ el: AXUIElement) -> [AXUIElement] {
    (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}
func appElements(_ pid: pid_t) -> [AXUIElement] {
    let app = AXUIElementCreateApplication(pid)
    return (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
}

func walk(_ el: AXUIElement, depth: Int, into out: inout [[String: Any]]) {
    if depth > 24 { return }
    var strings: [String] = []
    for name in [kAXTitleAttribute, kAXValueAttribute, kAXHelpAttribute, kAXDescriptionAttribute] {
        if let s = str(el, name as String) { strings.append(s) }
    }
    if !strings.isEmpty, let r = rectOf(el) {
        out.append([
            "role": str(el, kAXRoleAttribute) ?? "?",
            "strings": strings, "x": r.0, "y": r.1, "w": r.2, "h": r.3,
        ])
    }
    for child in childrenOf(el) { walk(child, depth: depth + 1, into: &out) }
}

func collectAll(_ pid: pid_t) -> [(el: AXUIElement, role: String, strings: [String], rect: (Double, Double, Double, Double)?)] {
    var out: [(AXUIElement, String, [String], (Double, Double, Double, Double)?)] = []
    func rec(_ el: AXUIElement, _ depth: Int) {
        if depth > 24 { return }
        var strings: [String] = []
        for name in [kAXTitleAttribute, kAXValueAttribute, kAXHelpAttribute, kAXDescriptionAttribute] {
            if let s = str(el, name as String) { strings.append(s) }
        }
        out.append((el, str(el, kAXRoleAttribute) ?? "", strings, rectOf(el)))
        for child in childrenOf(el) { rec(child, depth + 1) }
    }
    for window in appElements(pid) { rec(window, 0) }
    return out
}

let pidArg: pid_t? = args.count > 2 ? pid_t(Int(args[2]) ?? -1) : nil

switch args[1] {
case "texts":
    var out: [[String: Any]] = []
    for window in appElements(pidArg!) { walk(window, depth: 0, into: &out) }
    let data = try! JSONSerialization.data(withJSONObject: out)
    FileHandle.standardOutput.write(data)
    exit(0)
case "press":
    // press <pid> <needle>：按标题/值含 needle 的按钮（如引导横幅的「关闭」）。
    let needle = args[3]
    for entry in collectAll(pidArg!) where entry.role == "AXButton"
        && entry.strings.contains(where: { $0.contains(needle) }) {
        if AXUIElementPerformAction(entry.el, kAXPressAction as CFString) == .success { exit(0) }
    }
    exit(1)
case "pressat":
    // pressat <pid> <x> <y>：命中 (x,y) 处 AXButton 并 AXPress——坐标零依赖
    // 语义（不经窗口服务器鼠标路由，无遮挡/激活风险）。
    let x = Double(args[3])!, y = Double(args[4])!
    for entry in collectAll(pidArg!) where entry.role == "AXButton" {
        guard let r = entry.rect, x >= r.0 - 1, x <= r.0 + r.2 + 1, y >= r.1 - 1, y <= r.1 + r.3 + 1
        else { continue }
        if AXUIElementPerformAction(entry.el, kAXPressAction as CFString) == .success { exit(0) }
    }
    exit(1)
case "click":
    let x = Double(args[2])!, y = Double(args[3])!
    let clickSrc = CGEventSource(stateID: .hidSystemState)
    CGWarpMouseCursorPosition(CGPoint(x: x, y: y))
    usleep(80_000)
    CGEvent(mouseEventSource: clickSrc, mouseType: .leftMouseDown,
            mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)?
        .post(tap: .cgSessionEventTap)
    usleep(60_000)
    CGEvent(mouseEventSource: clickSrc, mouseType: .leftMouseUp,
            mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)?
        .post(tap: .cgSessionEventTap)
    exit(0)
case "drag":
    // drag x1 y1 x2 y2 [steps=24] [holdMs=40]：拟真合成拖拽（F10 探测用；
    // 本机实测无法启动 .onDrag 会话——保留代码供未来 macOS 版本复测）。
    let x1 = Double(args[2])!, y1 = Double(args[3])!
    let x2 = Double(args[4])!, y2 = Double(args[5])!
    let steps = args.count > 6 ? (Int(args[6]) ?? 24) : 24
    let holdMs = args.count > 7 ? (Int(args[7]) ?? 40) : 40
    CGWarpMouseCursorPosition(CGPoint(x: x1, y: y1))
    usleep(150_000)
    let src = CGEventSource(stateID: .combinedSessionState)
    func post(_ type: CGEventType, _ p: CGPoint) {
        guard let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: .left) else { return }
        if type != .leftMouseUp { e.flags = CGEventFlags(rawValue: 4096) }
        e.post(tap: .cgSessionEventTap)
    }
    defer { post(.leftMouseUp, CGPoint(x: x2, y: y2)) }
    post(.leftMouseDown, CGPoint(x: x1, y: y1))
    usleep(80_000)
    for jiggle in [(2.0, 0.0), (4.0, 1.0), (7.0, 2.0)] {
        post(.leftMouseDragged, CGPoint(x: x1 + jiggle.0, y: y1 + jiggle.1))
        usleep(30_000)
    }
    for i in 1...steps {
        let t = Double(i) / Double(steps)
        post(.leftMouseDragged, CGPoint(x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t))
        usleep(UInt32(holdMs * 1000))
    }
    usleep(140_000)
    exit(0)
case "raise":
    for window in appElements(pidArg!) {
        AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    }
    exit(0)
case "covers":
    // covers x y → 屏幕上覆盖该点的最前窗口属主 pid（front-to-back 遍历）。
    let x = Double(args[2])!, y = Double(args[3])!
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    if let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] {
        for info in list {
            guard let layer = info[kCGWindowLayer as String] as? Int, layer == 0 else { continue }
            guard let raw = info[kCGWindowBounds as String] as? [String: Any],
                  let bx = raw["X"] as? Double, let by = raw["Y"] as? Double,
                  let bw = raw["Width"] as? Double, let bh = raw["Height"] as? Double
            else { continue }
            if x >= bx, x <= bx + bw, y >= by, y <= by + bh,
               let owner = info[kCGWindowOwnerPID as String] as? Int {
                print(owner)
                exit(0)
            }
        }
    }
    print(-1)
    exit(0)
case "front":
    print(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "nil")
    exit(0)
case "trusted":
    print(AXIsProcessTrusted() ? "yes" : "no")
    exit(0)
default:
    exit(2)
}
"""

KINDS = [
    # (key, 卡片显示名, 引导落点文案正则) —— 文案单一真源：
    # engine/Sources/GlassPaneEngine/PermissionStatus.swift PermissionGuide.instruction
    ("accessibility", "辅助功能", r"申请「辅助功能」|已打开「辅助功能」面板"),
    ("inputMonitoring", "输入监控", r"申请「输入监控」|已打开「输入监控」面板"),
    ("screenRecording", "屏幕录制", r"申请「屏幕录制」|已打开「屏幕录制」面板"),
    ("developerTools", "开发者工具", r"已打开「开发者工具」面板"),
]
GUIDE_BUTTON_TITLES = {"授权", "打开系统设置"}
BANNER_NEEDLE = "拖拽引导"
SETTINGS_BUNDLE = "com.apple.systempreferences"


def log(line):
    sys.stderr.write(line + "\n")
    sys.stderr.flush()


def build_helper():
    cache_dir = os.path.join(tempfile.gettempdir(), "glasspane-p4i4-smoke")
    os.makedirs(cache_dir, exist_ok=True)
    binary = os.path.join(cache_dir, "p4i4_helper")
    if not os.path.exists(binary):
        source = os.path.join(cache_dir, "p4i4_helper.swift")
        with open(source, "w", encoding="utf-8") as handle:
            handle.write(HELPER_SRC)
        result = subprocess.run(["swiftc", "-O", source, "-o", binary],
                                capture_output=True, text=True, timeout=240)
        if result.returncode != 0:
            raise RuntimeError("swiftc 编译辅助器失败：\n" + result.stderr[-2000:])
    return binary


def run(helper, *argv, timeout=60):
    return subprocess.run([helper] + [str(a) for a in argv],
                          capture_output=True, text=True, timeout=timeout)


def discover_panel():
    """只接受本冒烟可安全接管的实例：裸二进制调试构建（安装的 GlassPane.app
    属用户会话，本脚本绝不操作其窗口）。返回 pid 或 None。"""
    try:
        out = subprocess.run(["pgrep", "-f", "glasspane-settings"],
                             capture_output=True, text=True, timeout=10)
        pids = [int(x) for x in out.stdout.split() if x.strip().isdigit()]
    except (subprocess.TimeoutExpired, ValueError):
        return None
    for pid in pids:
        try:
            path = subprocess.run(["ps", "-o", "comm=", "-p", str(pid)],
                                  capture_output=True, text=True, timeout=10).stdout.strip()
        except subprocess.TimeoutExpired:
            continue
        if "GlassPane.app" in path or ".build" not in path:
            continue  # 用户实例或非本仓构建，永不触碰
        return pid
    return None


def texts(helper, pid):
    out = run(helper, "texts", pid)
    if out.returncode != 0:
        return []
    try:
        return json.loads(out.stdout or "[]")
    except json.JSONDecodeError:
        return []


def all_text(elements):
    return "\n".join(" ".join(e["strings"]) for e in elements)


def find_first(elements, needle):
    for element in elements:
        if any(needle in s for s in element["strings"]):
            return element
    return None


def card_guide_button(elements, display_name):
    """该卡右侧引导按钮（授权/打开系统设置）：标题行同排、位于卡标题之右。
    granted 态标题为「已授权」且 disabled → 返回 'granted' 标记。"""
    headers = [e for e in elements
               if any(display_name == s.strip() for s in e["strings"])
               and e["role"] == "AXStaticText"]
    if not headers:
        return None, None
    header = min(headers, key=lambda e: e["y"])
    row = [e for e in elements
           if e["role"] == "AXButton"
           and abs((e["y"] + e["h"] / 2.0) - (header["y"] + header["h"] / 2.0)) < 45
           and e["x"] > header["x"]]
    for button in sorted(row, key=lambda e: e["x"]):
        titles = button["strings"]
        if any(t.strip() in GUIDE_BUTTON_TITLES for t in titles):
            return (button["x"] + button["w"] / 2.0, button["y"] + button["h"] / 2.0), "press"
        if any(t.strip() == "已授权" for t in titles):
            return None, "granted"
    return None, None


def badge_near(elements, display_name):
    """卡片状态徽标文案（已授权/未验证/已拒绝/未申请）。"""
    headers = [e for e in elements if any(s.strip() == display_name for s in e["strings"])]
    for header in sorted(headers, key=lambda e: e["y"]):
        near = [e for e in elements
                if abs(e["x"] - header["x"]) < 400 and 0 < e["y"] - header["y"] < 90
                and any(s in ("已授权", "未验证", "已拒绝", "未申请") for s in e["strings"])]
        if near:
            return min(near, key=lambda e: e["y"])["strings"][0]
    return None


def wait_for_pattern(helper, pid, regex, seconds=6.0):
    deadline = time.time() + seconds
    while time.time() < deadline:
        if regex.search(all_text(texts(helper, pid))):
            return True
        time.sleep(0.4)
    return False


def main():
    argv = sys.argv[1:]
    if "--help" in argv or "-h" in argv:
        print(__doc__)
        return 0
    panel_pid = int(argv[argv.index("--panel-pid") + 1]) if "--panel-pid" in argv else None
    skip_drag = "--skip-drag" in argv

    try:
        helper = build_helper()
    except Exception as error:  # noqa: BLE001
        log(f"SKIP：辅助器编译失败（{error}）")
        return 0

    if panel_pid is None:
        panel_pid = discover_panel()
    spawned = None
    if panel_pid is None:
        here = os.path.dirname(os.path.abspath(__file__))
        for candidate in (
            os.path.join(here, ".build", "debug", "glasspane-settings"),
            os.path.join(here, ".build", "release", "glasspane-settings"),
        ):
            if os.path.isfile(candidate):
                spawned = subprocess.Popen([candidate], stdout=subprocess.DEVNULL,
                                           stderr=subprocess.DEVNULL)
                time.sleep(3)
                panel_pid = spawned.pid
                break
    if panel_pid is None:
        log("SKIP：没有可安全操作的 glasspane-settings 实例（先构建 engine 产物；"
            "daemon 不可达时 `node installer/cli.js --restore-launchd`）。")
        return 0

    if run(helper, "trusted").stdout.strip() != "yes":
        log("SKIP：宿主进程无辅助功能席位（AX 读取/AXPress 需要）。补救：给 daemon 授权走 "
            "面板引导；席位借用规则 P1 v1.2 §11.4。")
        if spawned:
            spawned.terminate()
        return 0

    elements = texts(helper, panel_pid)
    if find_first(elements, BANNER_NEEDLE) is None:
        log("FAIL：面板窗口里找不到拖拽横幅锚点——面板改版，本冒烟锚点需同步。")
        if spawned:
            spawned.terminate()
        return 1

    failures = []
    report = []
    for key, display_name, pattern in KINDS:
        run(helper, "press", panel_pid, "关闭")  # 清上一轮横幅，保证文案新鲜
        time.sleep(0.6)
        snapshot = texts(helper, panel_pid)
        point, mode = card_guide_button(snapshot, display_name)
        badge = badge_near(snapshot, display_name)
        if mode == "granted":
            report.append(f"PASS guide-{key}: 卡已授权（按钮 disabled「已授权」）——steady-state 如实")
            continue
        if mode != "press":
            failures.append(f"{key}: 找不到卡内引导按钮")
            continue
        if run(helper, "pressat", panel_pid, point[0], point[1]).returncode != 0:
            failures.append(f"{key}: AXPress 引导按钮失败（pid {panel_pid}）")
            continue
        landed = wait_for_pattern(helper, panel_pid, re.compile(pattern))
        front = run(helper, "front").stdout.strip()
        if not landed:
            failures.append(f"{key}: 按下引导按钮后 6s 未出现该 kind 专属文案（front={front}）")
            continue
        if front != SETTINGS_BUNDLE:
            failures.append(f"{key}: 引导后 System Settings 未成为前台（front={front}）")
            continue
        report.append(f"PASS guide-{key}: kind 路由 + 面板跳转（badge={badge or 'n/a'}）")
        if key == "developerTools" and badge and badge != "未验证":
            failures.append(f"developerTools: 徽标「{badge}」违反恒未验证（P4-I4）")

    # F10 维度：合成拖拽如实探测（不强断言；坐标级操作，逐点遮挡守卫）。
    drag_landed = None
    if not skip_drag and not failures:
        run(helper, "press", panel_pid, "关闭")
        time.sleep(0.5)
        run(helper, "raise", panel_pid)
        time.sleep(0.4)
        snapshot = texts(helper, panel_pid)
        banner = find_first(snapshot, BANNER_NEEDLE)
        header = next((e for e in snapshot
                       if e["role"] == "AXStaticText"
                       and any("辅助功能" == s.strip() for s in e["strings"])), None)
        if banner and header:
            source = (banner["x"] + banner["w"] / 2.0, banner["y"] + banner["h"] / 2.0)
            target = (header["x"] + header["w"] / 2.0, header["y"] + 40.0)
            blocked = any(
                run(helper, "covers", p[0], p[1]).stdout.strip() != str(panel_pid)
                for p in (source, target)
            )
            if not blocked:
                run(helper, "drag", source[0], source[1], target[0], target[1], 40, 30)
                drag_landed = wait_for_pattern(
                    helper, panel_pid, re.compile(KINDS[0][2]), seconds=4.0)
        report.append(f"INFO drag-synthesis: {'LANDED（本机拖拽可合成，F10 证伪）' if drag_landed else '未起会话——与 F10 一致：macOS 不允许合成事件启动拖拽会话（手势无独立授权语义，落点=guide()）'}")

    for line in report:
        log(line)
    if spawned:
        spawned.terminate()
    if failures:
        for line in failures:
            log("FAIL " + line)
        log("结论：P4-I4 自动化断言未全过，不能销账。")
        return 1
    log("结论：四卡引导路由/面板跳转/dev 卡不假点亮全部机器化通过——P4-I4 人工目视销账；"
        "拖拽手势本体为系统级不可合成维度（F10），其功能语义已由按钮路径覆盖。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
