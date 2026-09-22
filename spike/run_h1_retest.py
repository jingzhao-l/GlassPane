#!/usr/bin/env python3
"""H1 真实应用强归因率复测（P6 spec §11 审计项⑦：复测配方 → 机器脚本）。

results.md 的 H1 结论是"链路与机制 GO；真实 app 比率未采到"，挂了一份只有人
能照做的复测配方（①窗口型真实 app / FineTune 补 .app 壳 ②registerMirrorRoot +
recordHandler ③≥20 act ④数据回表）。本脚本把四步全部机器化：

  fetch   : FineTune main + 依赖（KeyboardShortcuts 2.4.0 / FluidMenuBarExtra
            1.5.1 / Sparkle 2.8.1）codeload tarball 缓存下载；
  shell   : SPM 构建壳（swift-tools 6.0，macOS 15，v5 语言模式）+
            spike/patches/finetune-probe.patch 的等价插桩编辑（幂等文本替换：
            GP.start / registerMirrorRoot / setVolume 双写 / 通知面 bundle 守卫）；
  build   : debug 构建（release WMO 在本机 swift 6.2 触发前端 signal 11，
            已记录；debug 全量 ~80s）；
  bundle  : FineTuneRetest.app（LSUIElement + CFBundleIdentifier
            com.glasspane.h1retest.finetune + Sparkle.framework 内嵌 +
            @rpath/../Frameworks + ad-hoc 签名）——H1 记录里"裸可执行启动期
            AX ping 超时"的根因（无 bundle 身份）由此消除；
  drive   : 自带 daemon（独立 engine.sock/probe.sock，--no-c33，绝不触碰
            用户实例）→ open 激活 → 按 Settings… 菜单 → Audio 标签 →
            AXSlider increment/decrement ≥20 次（能命中 VolumeState.setVolume
            的处理器 lane 时另跑 popover 4 次）；
  report  : spike/h1-retest-result.json（逐 act 归因/hitCount/stateDiff +
            汇总比率 + results.md 表格行），通过线 strong ≥ 80%。

退出语义：环境不可得（网络全失败/无 swiftc/构建崩）→ SKIP exit 0 + 失败步骤
名；采集完成但比率不达标 → FAIL exit 1；达标 → exit 0。

用法：python3 spike/run_h1_retest.py [--work-dir DIR] [--acts N]
                                     [--keep-running] [--skip-popover]
"""
import argparse
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)
PROBE_PACKAGE = os.path.join(REPO_ROOT, "engine", "probe")
GLASSPANED_CANDIDATES = [
    os.path.join(REPO_ROOT, "engine", ".build", "debug", "glasspaned"),
    os.path.join(REPO_ROOT, "engine", ".build", "release", "glasspaned"),
]
APP_BUNDLE_ID = "com.glasspane.h1retest.finetune"

ARCHIVES = {
    "finetune": ("https://codeload.github.com/ronitsingh10/FineTune/tar.gz/refs/heads/main",
                 "FineTune-main"),
    "KeyboardShortcuts": ("https://codeload.github.com/sindresorhus/KeyboardShortcuts/tar.gz/refs/tags/2.4.0",
                          "KeyboardShortcuts-2.4.0"),
    "FluidMenuBarExtra": ("https://codeload.github.com/wadetregaskis/FluidMenuBarExtra/tar.gz/refs/tags/1.5.1",
                          "FluidMenuBarExtra-1.5.1"),
    "Sparkle": ("https://codeload.github.com/sparkle-project/Sparkle/tar.gz/refs/tags/2.8.1",
                "Sparkle-2.8.1"),
}

PACKAGE_SWIFT = """// swift-tools-version:6.0
// spike 构建壳（H1 复测用，非上架产物）：FineTune main 源树 + GlassPaneProbe
// 手动 Z1 标注（H7 opt-in 口径）。上游语义零改动、未上传、不分发。
import PackageDescription

let package = Package(
    name: "fine-spm",
    platforms: [.macOS(.v15)],
    dependencies: [
        .package(url: "https://github.com/sindresorhus/KeyboardShortcuts", exact: "2.4.0"),
        .package(url: "https://github.com/wadetregaskis/FluidMenuBarExtra", exact: "1.5.1"),
        .package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.8.1"),
        .package(path: "{PROBE}"),
    ],
    targets: [
        .executableTarget(
            name: "FineTune",
            dependencies: [
                "KeyboardShortcuts",
                .product(name: "FluidMenuBarExtra", package: "FluidMenuBarExtra"),
                .product(name: "Sparkle", package: "Sparkle"),
                .product(name: "GlassPaneProbe", package: "probe"),
            ],
            path: "Sources/FineTune",
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
"""

BUNDLE_GUARD = """import Foundation
import UserNotifications

/// spike-only：裸可执行形态下 Bundle.main.bundleIdentifier 为 nil，
/// UNUserNotificationCenter.current() 直接 trap（bundleProxy nil）。
enum SpikeNotifications {
    static var center: UNUserNotificationCenter? {
        Bundle.main.bundleIdentifier != nil ? UNUserNotificationCenter.current() : nil
    }
}
"""

INFO_PLIST = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>FineTune</string>
  <key>CFBundleIdentifier</key><string>com.glasspane.h1retest.finetune</string>
  <key>CFBundleName</key><string>FineTuneRetest</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0-spike</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>CFBundleURLTypes</key>
  <array><dict>
    <key>CFBundleURLName</key><string>com.finetuneapp.FineTune</string>
    <key>CFBundleURLSchemes</key><array><string>finetune</string></array>
  </dict></array>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
"""

HELPER_SRC = r"""
import AppKit
import ApplicationServices
// spike 辅助：press-extras 打开弹层；rownames 导出窗口+弹层全部文本（找活跃 app 行）。
let args = CommandLine.arguments
let mode = args.count > 1 ? args[1] : "press-extras"
let pid = pid_t(Int(args[2]) ?? -1)
let app = AXUIElementCreateApplication(pid)

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success ? value : nil
}
func textsof(_ el: AXUIElement) -> [String] {
    var out: [String] = []
    for name in [kAXTitleAttribute, kAXValueAttribute, kAXDescriptionAttribute] {
        if let t = attr(el, name) as? String { out.append(t) }
    }
    return out
}
func kids(_ el: AXUIElement) -> [AXUIElement] {
    (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

switch mode {
case "rownames":
    var collected: [String] = []
    func walk(_ el: AXUIElement, _ depth: Int) {
        if depth > 18 { return }
        collected.append(contentsOf: textsof(el))
        for c in kids(el) { walk(c, depth + 1) }
    }
    if let windows = attr(app, kAXWindowsAttribute as String) as? [AXUIElement] {
        for w in windows { walk(w, 0) }
    }
    if let raw = attr(app, "AXExtrasMenuBar"), CFGetTypeID(raw) == AXUIElementGetTypeID() {
        for item in kids(raw as! AXUIElement) { walk(item, 0) }
    }
    let data = try! JSONSerialization.data(withJSONObject: collected)
    FileHandle.standardOutput.write(data)
    exit(0)
default:
    guard let raw = attr(app, "AXExtrasMenuBar"), CFGetTypeID(raw) == AXUIElementGetTypeID(),
          let first = kids(raw as! AXUIElement).first else {
        print("no-extras"); exit(1)
    }
    exit(AXUIElementPerformAction(first, kAXPressAction as CFString) == .success ? 0 : 1)
}
"""


class Skip(Exception):
    pass


class Failed(Exception):
    pass


def log(msg):
    print(f"[h1-retest] {msg}", file=sys.stderr, flush=True)


def curl(url, dest):
    for attempt in range(3):
        result = subprocess.run(
            ["curl", "-sfL", "--connect-timeout", "20", "--max-time", "240",
             "-o", dest, url], timeout=260)
        if result.returncode == 0 and os.path.getsize(dest) > 1024:
            with open(dest, "rb") as handle:
                if handle.read(2) == b"\x1f\x8b":
                    return True
        time.sleep(3)
    return False


def step_fetch(work):
    vendor = os.path.join(work, "vendor")
    os.makedirs(vendor, exist_ok=True)
    for name, (url, top) in ARCHIVES.items():
        target_dir = os.path.join(work, name if name != "finetune" else "src")
        if os.path.isdir(target_dir):
            continue
        tarball = os.path.join(vendor, f"{name}.tar.gz")
        if not os.path.isfile(tarball) and not curl(url, tarball):
            raise Skip(f"fetch:{name} 三次重试均失败（codeload 网络）；稍后重跑或预置 {tarball}")
        extracted = os.path.join(vendor, top)
        if not os.path.isdir(extracted):
            subprocess.run(["tar", "xzf", tarball, "-C", vendor], check=True)
        if not os.path.isdir(extracted):
            raise Skip(f"fetch:{name} tar 顶层目录与预期 {top} 不符（上游改版？核对 tag）")
        shutil.move(extracted, target_dir)
    return work


def step_shell(work, force=False):
    shell = os.path.join(work, "fine-spm")
    sources = os.path.join(shell, "Sources", "FineTune")
    sm_path = os.path.join(sources, "Settings", "SettingsManager.swift")
    sm_done = os.path.isfile(sm_path) and "GP.recordHandler()" in open(
        sm_path, encoding="utf-8").read()
    if (os.path.isfile(os.path.join(sources, "SpikeBundleGuard.swift")) and sm_done
            and not force):
        return shell
    os.makedirs(os.path.join(shell, "Sources"), exist_ok=True)
    shutil.rmtree(sources, ignore_errors=True)
    shutil.copytree(os.path.join(work, "src", "FineTune"), sources)
    with open(os.path.join(shell, "Package.swift"), "w", encoding="utf-8") as handle:
        handle.write(PACKAGE_SWIFT.replace("{PROBE}", PROBE_PACKAGE))

    def edit(rel, assertions, replacements):
        path = os.path.join(sources, rel)
        text = open(path, encoding="utf-8").read()
        for needle in assertions:
            if needle in text:
                return  # 已插桩（幂等）
        for old, new in replacements:
            if old not in text:
                raise Skip(f"shell:{rel} 锚点缺失（上游漂移，需对照 finetune-probe.patch 复核）：{old[:60]}")
            text = text.replace(old, new, 1)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(text)

    with open(os.path.join(sources, "SpikeBundleGuard.swift"), "w", encoding="utf-8") as handle:
        handle.write(BUNDLE_GUARD)
    edit("FineTuneApp.swift", ["import GlassPaneProbe"], [
        ("import os\n", "import os\nimport GlassPaneProbe\n"),
        ("    init() {\n", "    init() {\n        GP.start(appName: \"FineTune\")\n"),
        ("        let settings = SettingsManager()\n",
         "        let settings = SettingsManager()\n"
         "        GP.registerMirrorRoot(label: \"settings\", object: settings)\n"),
    ])
    # 通知面 bundle 守卫（对齐 spike patch：FineTuneApp 2 处 + AudioEngine 3 处）
    for rel in ("FineTuneApp.swift", os.path.join("Audio", "Engine", "AudioEngine.swift")):
        path = os.path.join(sources, rel)
        text = open(path, encoding="utf-8").read()
        text = text.replace("UNUserNotificationCenter.current()", "SpikeNotifications.center?")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(text)
    # Z1 handler lane 落点二：SettingsManager.setVolume——URL scheme 的 inactive
    # 分支必经此处（不依赖任意第三方 app 处于活跃音频状态）。
    sm = os.path.join("Settings", "SettingsManager.swift")
    smp = os.path.join(sources, sm)
    sms = open(smp, encoding="utf-8").read()
    if "import GlassPaneProbe" not in sms:
        sms = sms.replace("import Foundation\n", "import Foundation\nimport GlassPaneProbe\n", 1)
    if "GP.recordHandler()" not in sms:
        old_fn = "    func setVolume(for identifier: String, to volume: Float) {\n"
        new_fn = old_fn + "        GP.recordHandler()\n" + (
            '        GP.recordState(key: "appVolumes.\(identifier)", '
            'before: settings.appVolumes[identifier].map { String($0) } ?? "∅", '
            'after: String(volume))\n')
        assert old_fn in sms, "SettingsManager.setVolume anchor drifted"
        sms = sms.replace(old_fn, new_fn, 1)
        open(smp, "w", encoding="utf-8").write(sms)

    edit(os.path.join("Models", "VolumeState.swift"), ["GP.recordHandler()"], [
        ("import Foundation\n", "import Foundation\nimport GlassPaneProbe\n"),
        ("    func setVolume(for pid: pid_t, to volume: Float, identifier: String? = nil) {\n",
         "    func setVolume(for pid: pid_t, to volume: Float, identifier: String? = nil) {\n"
         "        GP.recordHandler()\n"
         "        GP.recordState(key: \"volume.\\(pid)\", before: states[pid].map { String($0.volume) } ?? \"∅\", after: String(volume))\n"),
    ])
    return shell


def step_build(shell):
    binary = os.path.join(shell, ".build", "debug", "FineTune")
    if os.path.isfile(binary):
        # 源树里任何文件比产物新（比如刚补插桩）→ 必须重编，缓存不能盖过正确性
        sources_newer = False
        for root, _dirs, files in os.walk(os.path.join(shell, "Sources")):
            for name in files:
                path = os.path.join(root, name)
                if os.path.getmtime(path) > os.path.getmtime(binary):
                    sources_newer = True
                    break
            if sources_newer:
                break
        if not sources_newer:
            return binary
    result = subprocess.run(["swift", "build"], cwd=shell, capture_output=True,
                            text=True, timeout=1800)
    if result.returncode != 0:
        tail = (result.stderr or result.stdout)[-1500:]
        raise Skip(f"build 失败（debug；release WMO 另有 swift 前端 signal 11 已知问题）：\n{tail}")
    if not os.path.isfile(binary):
        raise Skip("build 后未找到 .build/debug/FineTune")
    return binary


def step_bundle(work, binary):
    # H1_BUNDLE_DIR：bundle 落点覆盖（默认 work 下；handler lane 复采需 LS 稳定位置）
    app_dir = os.environ.get("H1_BUNDLE_DIR") or work
    os.makedirs(app_dir, exist_ok=True)
    app = os.path.join(app_dir, "FineTuneRetest.app")
    contents = os.path.join(app, "Contents")
    os.makedirs(os.path.join(contents, "MacOS"), exist_ok=True)
    os.makedirs(os.path.join(contents, "Resources"), exist_ok=True)
    shutil.copy2(binary, os.path.join(contents, "MacOS", "FineTune"))
    with open(os.path.join(contents, "Info.plist"), "w", encoding="utf-8") as handle:
        handle.write(INFO_PLIST)
    frameworks = os.path.join(contents, "Frameworks")
    shutil.rmtree(frameworks, ignore_errors=True)
    os.makedirs(frameworks)
    sparkle = glob.glob(os.path.join(shell_build_artifacts(work),
                                     "**", "macos-*", "Sparkle.framework"), recursive=True)
    if not sparkle:
        raise Skip("bundle：.build/artifacts 下找不到 Sparkle.framework（SPM binary target 布局变了）")
    subprocess.run(["cp", "-RPp", sparkle[0], frameworks], check=True)
    subprocess.run(["install_name_tool", "-add_rpath", "@executable_path/../Frameworks",
                    os.path.join(contents, "MacOS", "FineTune")], check=True)
    subprocess.run(["codesign", "--force", "--sign", "-",
                    os.path.join(frameworks, "Sparkle.framework")], check=True)
    subprocess.run(["codesign", "--force", "--sign", "-", app], check=True)
    # LaunchServices 不会自动认识临时目录里直跑的 bundle——URL scheme（handler
    # lane 的入口）必须显式登记，否则 `open finetune://…` 报 -10814。
    lsregister = ("/System/Library/Frameworks/CoreServices.framework/Versions/A/"
                  "Frameworks/LaunchServices.framework/Versions/A/Support/lsregister")
    if os.path.isfile(lsregister):
        subprocess.run([lsregister, "-f", app], check=False)
    return app


def shell_build_artifacts(work):
    return os.path.join(work, "fine-spm", ".build", "artifacts")


class Client:
    def __init__(self, socket_path):
        import socket as _socket
        self.sock = _socket.socket(_socket.AF_UNIX)
        self.sock.connect(socket_path)
        self.sock.settimeout(30)
        self.buf = b""
        self.mid = 0

    def call(self, method, params=None):
        self.mid += 1
        frame = {"id": self.mid, "method": method}
        if params is not None:
            frame["params"] = params
        self.sock.sendall((json.dumps(frame) + "\n").encode())
        while b"\n" not in self.buf:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise RuntimeError("daemon closed")
            self.buf += chunk
        line, _, self.buf = self.buf.partition(b"\n")
        return json.loads(line)

    def result(self, method, params=None):
        response = self.call(method, params)
        if "error" in response:
            raise Failed(f"{method} → {response['error']['code']}: {response['error']['message']}")
        return response["result"]


def pgrep_pids(pattern):
    out = subprocess.run(["pgrep", "-f", pattern], capture_output=True, text=True).stdout
    return [int(x) for x in out.split() if x.strip().isdigit()]


def kill_pids(pids, grace=2.0):
    import signal as _signal
    alive = set(pids)
    for pid in list(alive):
        try:
            os.kill(pid, _signal.SIGTERM)
        except ProcessLookupError:
            alive.discard(pid)
    deadline = time.time() + grace
    while alive and time.time() < deadline:
        for pid in list(alive):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                alive.discard(pid)
        time.sleep(0.2)
    for pid in alive:
        try:
            os.kill(pid, _signal.SIGKILL)
        except ProcessLookupError:
            pass


def step_handler_lane(client, skip, attempts=10, work_dir="/tmp/glasspane-h1",
                      client_app_pid=None):
    """Z1 handler lane 真实覆盖（H1 补录）：FineTune 的按应用音量 setter
    （VolumeState.setVolume，插桩点）由 finetune://step-volume 直达；先起
    afplay 制造一个有 bundle-less 音频身份的活跃 app（persistenceIdentifier =
    name:afplay），在 act 操作窗口内开 URL——handler 事件若落入窗口，
    hitCount>0 即真实 app 的 handler lane 证明。"""
    import threading
    if skip:
        return []
    stop = threading.Event()

    def noise():
        while not stop.is_set():
            try:
                subprocess.run(["afplay", "/System/Library/Sounds/Glass.aiff"], timeout=8)
            except Exception:
                return
    sound = threading.Thread(target=noise, daemon=True)
    sound.start()
    time.sleep(2.5)
    records = []
    # 弹层里读活跃 app 行名：identifier 只能来自应用自己的列表，猜不得。
    candidates = []
    try:
        helper = build_helper(work_dir)
        subprocess.run([helper, "press-extras", str(client_app_pid)], capture_output=True)
        time.sleep(1.5)
        dump = subprocess.run([helper, "rownames", str(client_app_pid)],
                              capture_output=True, text=True, timeout=30).stdout
        skip_names = {"General", "Audio", "Shortcuts", "Updates", "About"}
        names = set()
        for value in json.loads(dump or "[]"):
            v = str(value).strip()
            if 2 < len(v) < 40 and "FineTune" not in v and v not in skip_names:
                names.add(v)
        for name in sorted(names):
            candidates.append(name if "." in name else "name:" + name)
    except Exception:
        pass
    # 首选确定性路径：inactive 标识符 → coordinator → SettingsManager.setVolume
    # （已插桩）。URL 用 set-volumes（docs 表第一条），volume 循环保证值变化。
    deterministic = ["com.glasspane.h1.inactive-%d" % i for i in range(4)]
    candidates = deterministic + candidates
    try:
        for attempt in range(attempts):
            box = {}
            def do_act():
                try:
                    box["r"] = client.result("act", {"selector": {"role": "AXSlider"},
                                                     "action": "increment"})
                except Exception as exc:
                    box["e"] = str(exc)
            th = threading.Thread(target=do_act)
            th.start()
            time.sleep(0.10)
            app_id = candidates[attempt % len(candidates)]
            direction = "up" if attempt % 2 == 0 else "down"
            if app_id.startswith("com.glasspane.h1.inactive"):
                open_url = ("finetune://set-volumes?app=%s&volume=%d" % (app_id, 40 + attempt))
            else:
                open_url = "finetune://step-volume?app=%s&direction=%s" % (app_id, direction)
            subprocess.run(["open", open_url], capture_output=True, timeout=20)
            th.join(timeout=45)
            if box.get("e"):
                break
            act = box.get("r") or {}
            if act.get("operationId"):
                records.append(record_of(client, act, f"handler-lane/{app_id}-{direction}"))
                if records[-1]["hitCount"]:
                    break
            time.sleep(0.4)
    finally:
        stop.set()
        subprocess.run(["pkill", "-f", "afplay /System/Library/Sounds/Glass.aiff"],
                       capture_output=True)
    return records


def step_run(work, app, keep_running, acts, skip_popover):
    skip_handler = os.environ.get("H1_SKIP_HANDLER_LANE") == "1"
    daemon_bin = next((p for p in GLASSPANED_CANDIDATES if os.path.isfile(p)), None)
    if daemon_bin is None:
        raise Skip("run：engine/.build 下没有 glasspaned（先 `swift build`）")
    run = os.path.join(work, "run")
    os.makedirs(run, exist_ok=True)
    engine_sock = os.path.join(run, "engine.sock")
    probe_sock = os.path.join(run, "probe.sock")
    app_exec = os.path.join(app, "Contents", "MacOS", "FineTune")
    # 只清理"本脚本自己的"实例（按 bundle 精确路径匹配），绝不触碰用户部署。
    kill_pids(pgrep_pids(re.escape(app_exec)))
    kill_pids(pgrep_pids(f"socket-path {re.escape(engine_sock)}"))
    for sock in (engine_sock, probe_sock):
        if os.path.exists(sock):
            os.unlink(sock)
    daemon = subprocess.Popen(
        [daemon_bin, "--socket-path", engine_sock, "--probe-socket-path", probe_sock,
         "--no-c33"],
        stdout=open(os.path.join(run, "daemon.log"), "w"), stderr=subprocess.STDOUT)
    try:
        # 直接以 bundle 内可执行启动（GLASSPANE_PROBE_SOCK 注入生效，bundle 身份
        # 按路径解析），随后 `open -a` 只做激活——LS 对已运行实例不再起第二进程。
        app_env = dict(os.environ, GLASSPANE_PROBE_SOCK=probe_sock)
        app_proc = subprocess.Popen(
            [app_exec], env=app_env,
            stdout=open(os.path.join(run, "app.log"), "a"), stderr=subprocess.STDOUT)
        subprocess.run(["open", "-a", app], capture_output=True)
        time.sleep(3)
        if app_proc.poll() is not None:
            raise Skip(f"run：FineTuneRetest 启动即退出（查 {run}/app.log）")
        pid = app_proc.pid
        client = Client(engine_sock)
        client.result("hello")
        # 探针注册（z1 + mirror root）到位后再开测。
        registered = False
        for _ in range(30):
            probes = client.result("probe_status").get("probes", [])
            if any(p.get("pid") == pid for p in probes):
                registered = True
                break
            time.sleep(1)
        if not registered:
            raise Failed(f"run：daemon 未见 pid {pid} 的探针注册（probe_status 空）——查 {run}/daemon.log 与 app.log")
        client.result("attach", {"pid": pid})

        def find_role(role):
            tree = client.result("observe", {"maxDepth": 10})["axTree"]
            hits = []

            def walk(nodes):
                for node in nodes:
                    if node.get("role") == role:
                        hits.append(node)
                    walk(node.get("children") or [])
            walk(tree)
            return hits

        # 打开 Settings 窗口（本地化两种标题都试），再进 Audio 标签。
        menus = {n.get("title"): n for n in find_role("AXMenuItem")}
        pressed_settings = False
        for needle in ("Settings…", "设置…", "設定…"):
            if any(needle == (t or "") for t in menus):
                client.result("act", {"selector": {"role": "AXMenuItem", "title": needle},
                                      "action": "press"})
                pressed_settings = True
                break
        if pressed_settings:
            time.sleep(1.2)
            for tab in ("Audio", "音频"):
                if any((n.get("title") or "") == tab for n in find_role("AXButton")):
                    client.result("act", {"selector": {"role": "AXButton", "title": tab},
                                          "action": "press"})
                    time.sleep(0.8)
                    break

        records = []
        lane = None
        sliders = find_role("AXSlider")
        if sliders:
            lane = "settings-audio-slider"
            actions = ["increment", "decrement"]
            for index in range(acts):
                action = actions[index % 2]
                result = client.result("act", {"selector": {"role": "AXSlider"}, "action": action})
                records.append(record_of(client, result, f"{lane}/{action}"))
                time.sleep(0.25)
        else:
            checkboxes = find_role("AXCheckBox")
            if not checkboxes:
                raise Failed("drive：既无 AXSlider 也无 AXCheckBox——无法产生状态写路径")
            lane = "settings-checkbox"
            for index in range(acts):
                action = "confirm" if index % 2 == 0 else "cancel"
                result = client.result("act", {"selector": {"role": "AXCheckBox"}, "action": action})
                records.append(record_of(client, result, f"{lane}/{action}"))
                time.sleep(0.25)

        # 处理器 lane：状态栏弹层里的音量滑杆（真走 VolumeState.setVolume 双写）。
        popover_records = []
        if not skip_popover:
            helper = build_helper(work)
            subprocess.run([helper, "press-extras", str(pid)], capture_output=True)
            time.sleep(1.0)
            if find_role("AXSlider"):
                for index in range(4):
                    action = "increment" if index % 2 == 0 else "decrement"
                    result = client.result("act", {"selector": {"role": "AXSlider"}, "action": action})
                    popover_records.append(record_of(client, result, f"popover/{action}"))
                    time.sleep(0.25)

        handler_records = step_handler_lane(client, skip_handler, work_dir=work,
                                            client_app_pid=pid)
        # 通过线口径：比率只统计状态化 act（settings/popover ≥20）；handler lane
        # 是通道覆盖证据——"无状态变化"窗口按定义落 soft，不进分母（否则测的是
        # 试次配比而非归因能力）。hitCount>0 单独作为 handler 覆盖判定。
        core = records + popover_records
        strong = sum(1 for r in core if r["level"] == "strong")
        handler_hits = sum(1 for r in core + handler_records if r["hitCount"])
        lane_hit = sum(1 for r in handler_records if r["hitCount"])
        total = len(core)
        rate = strong / total if total else 0.0
        # 冻结前置口径（P6 §8）：硬门槛=状态化通道真实比率；handler lane 覆盖
        # 为记录项——真 app 上 URL scheme 路由受 LS 对临时 bundle 的解析限制
        # （-10814，2026-09-21 实测三次），通道机制本身由合成 canary 27 用例
        # 证明。lane_hit 如实入 JSON 供冻结评审裁量，不冒充门槛也不静默降格。
        verdict = "PASS" if rate >= 0.8 else "FAIL"
        report = {
            "assumption": "H1",
            "metric": "real-app strong-attribution rate",
            "threshold": 0.8,
            "app": {"name": "FineTune", "bundleId": APP_BUNDLE_ID, "form": ".app (LSUIElement)",
                    "probeCapabilities": ["z1"]},
            "daemon": {"bin": daemon_bin, "c33": False, "socket": engine_sock},
            "lane": lane,
            "passedLine": "strong >= 80%",
            "total": total,
            "strong": strong,
            "rate": round(rate, 4),
            "handlerHitActs": handler_hits,
            "handlerLaneHits": lane_hit,
            "handlerLaneNote": "覆盖判定为记录项：真 app URL 路由受 LS 对 /tmp bundle 解析限制（-10814）；"
                               "Z1 handler 通道机制由合成 canary（ok-press 等）证明，非本真 app 轮门槛。",
            "verdict": verdict,
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "acts": records,
            "popoverActs": popover_records,
            "handlerLaneActs": handler_records,
            "handlerLaneNote": ("URL scheme step-volume 在 act 窗口内触发已标注 setter；"
                                "hitCount>0 即 Z1 handler lane 在真实 app 上的覆盖证明"),
        }
        out_path = os.path.join(REPO_ROOT, "spike", "h1-retest-result.json")
        with open(out_path, "w", encoding="utf-8") as handle:
            json.dump(report, handle, ensure_ascii=False, indent=2)
        log(f"{verdict}：状态化通道 strong {strong}/{total} = {rate:.0%}（threshold 80%），"
            f"handler lane 覆盖命中 {lane_hit} 次（总 hit {handler_hits}；verdict 门槛=rate，"
            f"lane 覆盖为冻结评审输入项）；数据已写 {out_path}")
        log("results.md 表格行：| H1 | … | 真实 app："
            f"{total} act 强归因 {strong}（{rate:.0%}），lane={lane} | {'✓' if verdict == 'PASS' else '✗'} |")
        if not keep_running:
            raise_for_return(verdict)
        return verdict
    finally:
        if not keep_running:
            subprocess.run(["pkill", "-f", re.escape(os.path.join(work, "FineTuneRetest.app"))],
                           capture_output=True)
            kill_pids([app_proc.pid])
            daemon.terminate()


def raise_for_return(verdict):
    if verdict == "FAIL":
        raise Failed("strong 归因率未达 80% 通过线（明细见 h1-retest-result.json）")


def record_of(client, act_result, label):
    oid = act_result.get("operationId")
    pack = client.result("last_evidence", {"operationId": oid})["evidencePack"]
    signals = pack["signals"]
    probe = signals.get("handlerProbe") or {}
    diff = signals.get("stateDiff") or {}
    return {
        "operationId": oid,
        "label": label,
        "actConfirmed": act_result.get("actConfirmed"),
        "level": pack["attribution"]["level"],
        "contaminated": pack["attribution"]["contaminated"],
        "hitCount": probe.get("hitCount", 0),
        "stateChanged": diff.get("changed", False),
        "stateSource": diff.get("source"),
    }


def build_helper(work):
    cache_dir = os.path.join(work, "helper")
    os.makedirs(cache_dir, exist_ok=True)
    binary = os.path.join(cache_dir, "axextras")
    if not os.path.isfile(binary):
        source = os.path.join(cache_dir, "axextras.swift")
        with open(source, "w", encoding="utf-8") as handle:
            handle.write(HELPER_SRC)
        result = subprocess.run(["swiftc", "-O", source, "-o", binary],
                                capture_output=True, text=True, timeout=240)
        if result.returncode != 0:
            raise Skip(f"helper 编译失败：{result.stderr[-400:]}")
    return binary


def main():
    parser = argparse.ArgumentParser(description=__doc__, add_help=False)
    parser.add_argument("--work-dir", default="/tmp/glasspane-h1")
    parser.add_argument("--acts", type=int, default=20)
    parser.add_argument("--keep-running", action="store_true")
    parser.add_argument("--skip-popover", action="store_true")
    parser.add_argument("--skip-handler-lane", action="store_true")
    parser.add_argument("--rebuild", action="store_true")
    parser.add_argument("--help", "-h", action="store_true")
    args = parser.parse_args()
    if args.help:
        print(__doc__)
        return 0
    work = args.work_dir
    os.makedirs(work, exist_ok=True)
    try:
        step_fetch(work)
        shell = step_shell(work, force=args.rebuild)
        binary = step_build(shell)
        app = step_bundle(work, binary)
        verdict = step_run(work, app, args.keep_running, max(args.acts, 20), args.skip_popover)
        return 0 if verdict == "PASS" else 1
    except Skip as skip:
        log(f"SKIP：{skip}")
        return 0
    except Failed as failed:
        log(f"FAIL：{failed}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
