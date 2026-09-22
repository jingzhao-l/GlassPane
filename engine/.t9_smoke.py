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
  python3 .t9_smoke.py --daemon-bin <glasspaned> [max-acts] [delay-s]
    隔离模式（默认）：在临时目录起专用 daemon——临时 --socket-path/
    --probe-socket-path 一对 + HOME=临时目录（daemon 无 evidence 目录 flag，
    EvidenceStore/ApprovalGate 都走 NSHomeDirectory()，HOME 重定向是唯一
    agent-可执行的隔离通道），--no-c33（T9 采样走 proc_pidinfo，关输入监听
    免操作员键鼠把 act 打成 busy；镜像 .p6_smoke.py 的隔离 daemon 参数）。
    不给 --daemon-bin 时按 GLASSPANE_DAEMON_BIN → 仓库相对
    .build/{debug,release}/glasspaned 定位；都不可得 → NOT RUN exit 2。
    绝不隐式回落到 ~/.glasspane/engine.sock 现网口。
  python3 .t9_smoke.py <socket> [max-acts] [delay-s]
    旧契约：仅当显式传入 socket 才连接调用方已有的 daemon。
  退出码：0 = PASS，1 = FAIL，2 = NOT RUN（一条断言都没跑，≠ 通过）。
"""
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DAEMON_CANDIDATES = [
    os.path.join(HERE, ".build", "debug", "glasspaned"),
    os.path.join(HERE, ".build", "release", "glasspaned"),
]


def parse_args(argv):
    """→ (socket_path|None, daemon_bin|None, max_acts, delay_s)

    位置参数沿用旧契约 [socket] [max-acts] [delay-s]：第 1 个位置参数恒为
    显式 socket（连调用方已有的 daemon）。显式 --daemon-bin 时进入隔离
    模式，位置参数读作 [max-acts] [delay-s]。env GLASSPANE_DAEMON_BIN
    为可选补充，不改变位置语义。
    """
    socket_path = None
    daemon_bin = os.environ.get("GLASSPANE_DAEMON_BIN")
    isolated = "--daemon-bin" in argv or any(a.startswith("--daemon-bin=") for a in argv)
    positional = []
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg == "--daemon-bin":
            if index + 1 >= len(argv):
                fail("--daemon-bin 缺少取值")
            daemon_bin = argv[index + 1]
            index += 2
            continue
        if arg.startswith("--daemon-bin="):
            daemon_bin = arg.split("=", 1)[1]
        else:
            positional.append(arg)
        index += 1
    if positional and not isolated:
        socket_path = positional.pop(0)
    max_acts = int(positional[0]) if positional else 24
    delay = float(positional[1]) if len(positional) > 1 else 1.0
    return socket_path, daemon_bin, max_acts, delay

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
    socket_path, daemon_bin, max_acts, act_delay = parse_args(sys.argv[1:])
    workdir = tempfile.mkdtemp(prefix="gp-t9-canary-")
    daemon = None
    canary = None
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        if socket_path is None:
            # 隔离默认：不起现网连接，自己拉起临时 daemon（镜像 .p6_smoke.py 的
            # 隔离启动段）。socket 只接受调用方显式传入，绝不默认 ~/.glasspane。
            if daemon_bin is None:
                daemon_bin = next((c for c in DAEMON_CANDIDATES
                                   if os.path.exists(c)), None)
            if daemon_bin is None or not os.path.exists(daemon_bin):
                print("NOT RUN — 未显式传入已有 socket，且被测 daemon 二进制不可得"
                      "（一条断言都没执行，NOT RUN ≠ PASS）：")
                for cand in DAEMON_CANDIDATES:
                    print(f"  missing artifact: {cand}")
                print("REMEDY: cd engine && swift build -c release；或 --daemon-bin <path>"
                      "（env GLASSPANE_DAEMON_BIN 同义）；旧接口：第 1 位置参数显式给已有 socket")
                sys.exit(2)
            socket_path = os.path.join(workdir, "engine.sock")
            # HOME=workdir：daemon 无 evidence 目录 flag，EvidenceStore/ApprovalGate
            # 均走 NSHomeDirectory()，重定向 HOME 把 evidence/approvals 关进临时目录。
            daemon = subprocess.Popen(
                [daemon_bin, "--socket-path", socket_path,
                 "--probe-socket-path", os.path.join(workdir, "probe.sock"),
                 "--no-c33", "--verbose"],
                stdout=open(os.path.join(workdir, "daemon.log"), "w"),
                stderr=subprocess.STDOUT,
                env=dict(os.environ, HOME=workdir))
        # 连接重试：隔离 daemon 需要时间 bind（.p6_smoke.py 同口径 15s）；
        # 显式 socket 保留旧的快速失败。
        deadline = time.time() + (15 if daemon is not None else 5)
        while True:
            if daemon is not None and daemon.poll() is not None:
                fail(f"隔离 daemon 启动即退出（rc={daemon.returncode}，见 {workdir}/daemon.log）")
            try:
                sock.connect(socket_path)
                break
            except OSError as error:
                if time.time() >= deadline:
                    if daemon is not None:
                        fail(f"daemon 未在 15s 内监听 {socket_path}（见 {workdir}/daemon.log）")
                    fail(f"连接 daemon socket {socket_path} 失败：{error}"
                         "（默认请让本脚本自起隔离 daemon：--daemon-bin <glasspaned>；"
                         "仅确要连现网 daemon 时才显式传入其 socket 路径）")
                time.sleep(0.3)
        counter = [0]

        def nid():
            counter[0] += 1
            return counter[0]

        frame = send(sock, nid(), "hello", {})
        if "version" not in frame:
            fail(f"hello 无 version: {frame}")
        print(f"PASS daemon hello（version={frame.get('version')}）")

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
        for round_index in range(1, max_acts + 1):
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
                print(f"PASS 第 {round_index}/{max_acts} 轮：evidence 升级 degraded + degradation|")
                break
            print(f"  第 {round_index}/{max_acts} 轮：level={circuit.get('level')} reason={reason or '-'}")
            time.sleep(act_delay)

        if verdict_reason is None:
            print("最近 evidence 轨迹：")
            for entry in trajectory:
                print(f"  act#{entry[0]} level={entry[1]} reason={entry[2] or '-'}")
            fail(f"{max_acts} 轮内未检出 degradation|，T9 未触发（见轨迹人工分析泄漏注入是否生效）")

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
        if daemon is not None:
            try:
                daemon.terminate()
                daemon.wait(timeout=5)
            except Exception:
                daemon.kill()
            # 隔离模式留档（daemon.log + 临时 HOME 下的 evidence/approvals），
            # 与 .p6_smoke.py 同口径；显式 socket 模式维持旧的即时清理。
            print(f"NOTE 隔离工作目录：{workdir}（daemon.log/evidence 留档）")
        else:
            shutil_rmtree(workdir)

    print("T9 SMOKE OK")


def shutil_rmtree(workdir):
    import shutil

    shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    main()