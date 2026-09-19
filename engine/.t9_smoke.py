#!/usr/bin/env python3
"""GlassPane T9 渐进退化（泄漏注入）真机冒烟（P2 spec v2.1 §18 / P4 v4.0 §34.5）。

原理：T9 由 EngineCore 每次 act() 采样（proc_pidinfo 内存 + 句柄 + AX ping，
无 TCC 依赖，daemon 默认启用）。本脚本构建并运行一个"泄漏金丝雀"AppKit 应用：
每次点击按钮 = 保留 8MB 内存 + 保留 1 个 fd（真实泄漏注入），接着对 daemon 驱动
N 轮 act → 内存/句柄斜率持续为正 → 联合裁决 degrading → evidence reason 以
`degradation|` 携带 → Classifier 判 T9。

退出语义：
- maxActs 内达到 degrading 且 diagnose 判 T9 → PASS（exit 0）；
- 达到上限仍未检出 → FAIL（exit 1），打印最近 evidence 轨迹供人工分析。

用法：
  python3 .t9_smoke.py [socket] [max-acts] [delay-s]
    socket    默认 ~/.glasspane/engine.sock
    max-acts  默认 24；delay-s 默认 1.0（次/秒节奏，给内存斜率留时间）
"""
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time

SOCK = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/.glasspane/engine.sock")
MAX_ACTS = int(sys.argv[2]) if len(sys.argv) > 2 else 24
ACT_DELAY = float(sys.argv[3]) if len(sys.argv) > 3 else 1.0

CANARY_SOURCE = r"""// GlassPane T9 泄漏金丝雀（冒烟专用，随脚本构建）。
// 每次点击：追加 8MB 保留内存 + 保留 1 个 fd（/dev/null 只开不关）。
import AppKit
import Foundation

private let LEAK_BYTES = 8 * 1024 * 1024

final class LeakCanary: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var slabs: [[UInt8]] = []
    private var leakedFds: [Int32] = []
    private var clicks = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        print("CANARY_PID=\(ProcessInfo.processInfo.processIdentifier)")
        fflush(stdout)
        let rect = NSRect(x: 120, y: 120, width: 360, height: 220)
        window = NSWindow(contentRect: rect, styleMask: [.titled, .closable],
                          backing: .buffered, defer: false)
        window.title = "Leak Canary"
        let button = NSButton(title: "leak", target: self, action: #selector(leakOne(_:)))
        button.frame = NSRect(x: 120, y: 90, width: 120, height: 40)
        window.contentView?.addSubview(button)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func leakOne(_ sender: Any?) {
        clicks += 1
        slabs.append([UInt8](repeating: 0, count: LEAK_BYTES))
        let fd = open("/dev/null", O_RDWR)
        if fd >= 0 {
            leakedFds.append(fd)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}

let app = NSApplication.shared
let delegate = LeakCanary()
app.delegate = delegate
app.run()
"""


def recv_frame(sock):
    sock.settimeout(30)
    buf = b""
    while b"\n" not in buf:
        chunk = sock.recv(65536)
        if not chunk:
            break
        buf += chunk
    return json.loads(buf.decode("utf-8").strip())


def send(sock, mid, method, params):
    sock.sendall(json.dumps({"id": mid, "method": method, "params": params}).encode() + b"\n")
    resp = recv_frame(sock)
    if "error" in resp:
        raise AssertionError(f"{method}: {json.dumps(resp['error'])[:300]}")
    return resp.get("result", resp)


def fail(msg):
    print(f"FAIL {msg}")
    sys.exit(1)


def find_leak_button(tree, depth=0):
    if depth > 5:
        return None
    if isinstance(tree, list):
        for item in tree:
            found = find_leak_button(item, depth + 1)
            if found:
                return found
        return None
    if not isinstance(tree, dict):
        return None
    if tree.get("role") == "AXButton" and tree.get("title") == "leak":
        return {"role": "AXButton", "title": "leak"}
    for child in tree.get("children", []) or []:
        found = find_leak_button(child, depth + 1)
        if found:
            return found
    return None


def build_and_launch_canary(workdir):
    src = os.path.join(workdir, "LeakCanary.swift")
    bin_path = os.path.join(workdir, "leak-canary")
    with open(src, "w") as handle:
        handle.write(CANARY_SOURCE)
    compiled = subprocess.run(
        ["swiftc", "-O", src, "-o", bin_path], capture_output=True, text=True, timeout=300
    )
    if compiled.returncode != 0:
        fail(f"swiftc 金丝雀编译失败：{compiled.stderr[:400]}")
    launched = subprocess.Popen(
        [bin_path], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
    )
    pid = None
    deadline = time.time() + 20
    while time.time() < deadline:
        line = launched.stdout.readline()
        if line.strip().startswith("CANARY_PID="):
            pid = int(line.strip().split("=", 1)[1])
            break
    if pid is None:
        launched.kill()
        fail("金丝雀未在超时内输出 CANARY_PID")
    time.sleep(1.5)  # 留给 AppKit 完成窗口与 AX 树就绪
    return launched, pid


def main():
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.connect(SOCK)
    except OSError as error:
        fail(f"连接 daemon socket {SOCK} 失败：{error}（冒烟前先启动 daemon）")
    counter = [0]

    def nid():
        counter[0] += 1
        return counter[0]

    frame = send(sock, nid(), "hello", {})
    if "version" not in frame:
        fail(f"hello 无 version: {frame}")
    print(f"PASS daemon hello（version={frame.get('version')}）")

    workdir = tempfile.mkdtemp(prefix="gp-t9-canary-")
    canary = None
    try:
        canary, pid = build_and_launch_canary(workdir)
        print(f"PASS 泄漏金丝雀已启动（pid={pid}，内存 8MB/次 + fd 1/次）")

        frame = send(sock, nid(), "attach", {"pid": pid})
        assert "pid" in frame and "appName" in frame, f"attach by pid 失败: {frame}"
        print(f"PASS attach by pid → appName={frame.get('appName')}")

        # 等 AX 树暴露按钮（最多 10 次×0.5s），保证 act 可真实执行。
        button = None
        for _ in range(10):
            try:
                frame = send(sock, nid(), "observe", {"maxDepth": 5})
                button = find_leak_button(frame.get("axTree"))
                if button:
                    break
            except AssertionError:
                break
            time.sleep(0.5)
        if button is None:
            fail("金丝雀 AX 树中未找到 title='leak' 的 AXButton（AX 权限未授予 daemon？）")

        trajectory = []
        verdict_reason = None
        for round_index in range(1, MAX_ACTS + 1):
            frame = send(sock, nid(), "act", {"selector": button, "action": "press"})
            if frame.get("actConfirmed") is not True:
                fail(f"第 {round_index} 轮 act 未确认：{json.dumps(frame)[:300]}")
            frame = send(sock, nid(), "last_evidence", {})
            pack = frame.get("evidencePack", frame)
            circuit = pack.get("circuitBreaker") or {}
            reason = circuit.get("reason") or ""
            trajectory.append((round_index, circuit.get("level"), reason))
            if "degradation|" in reason:
                verdict_reason = reason
                print(f"PASS 第 {round_index}/{MAX_ACTS} 轮：evidence 升级 degraded + degradation|")
                break
            print(f"  第 {round_index}/{MAX_ACTS} 轮：level={circuit.get('level')} reason={reason or '-'}")
            time.sleep(ACT_DELAY)

        if verdict_reason is None:
            print("最近 evidence 轨迹：")
            for entry in trajectory:
                print(f"  act#{entry[0]} level={entry[1]} reason={entry[2] or '-'}")
            fail(f"{MAX_ACTS} 轮内未检出 degradation|，T9 未触发（见轨迹人工分析泄漏注入是否生效）")

        # 退化裁决已落到 evidence → diagnose 应以 T9 归类（Classifer T9 规则）。
        frame = send(sock, nid(), "diagnose", {})
        assert "class" in frame and "report" in frame, f"diagnose 缺字段: {frame}"
        if frame.get("class") != "T9":
            print(json.dumps(frame.get("report"), ensure_ascii=False, indent=2))
            fail(f"diagnose.class={frame.get('class')}，期望 T9")
        print(f"PASS diagnose.class=T9（驱动：{verdict_reason}）")
    finally:
        if canary is not None:
            canary.send_signal(signal.SIGTERM)
            try:
                canary.wait(timeout=5)
            except subprocess.TimeoutExpired:
                canary.kill()
        sock.close()
        shutil_rmtree(workdir)

    print("T9 SMOKE OK")


def shutil_rmtree(workdir):
    import shutil

    shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    main()