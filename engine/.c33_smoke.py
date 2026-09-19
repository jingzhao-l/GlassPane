#!/usr/bin/env python3
"""GlassPane C33 输入监控真机冒烟（P2 spec v2.0 §17.2 / P4 v4.0 §34.5、§36）。

目的：真机验证"输入监控 TCC 授权 + daemon 注入 AttributionGuard"后的完整 C33
判定面：操作权互斥（busy 拒绝）、持有期间污染检出（contaminated=true）、空闲
窗口干净路径（contaminated=false）。

本轮履约边界（如实声明，非缺陷）：
- daemon 自 2026-09-19（P4 §36）默认注入 AttributionGuard（CGEvent tap 创建
  失败时自动降级为纯操作权互斥，§17.2 口径）；本脚本要求三阶段全过。
- 注入的"用户输入"= 未占用鼠标键（button 29）的 otherMouseDown/Up 合成事件
  ——daemon 语义下凡非 AX 通道进入 CGEvent tap 的一律按 .human 处理，合成即
  可复现判定面；对系统无交互副作用（未知按钮 + 固定角落坐标）。
- busy 拒绝断言（GP_E_BUSY_INPUT）要求注入窗覆盖 act 的 500ms 空闲检测 +
  250ms 重试预算，脚本用 ≥3s 连发保证确定性。

退出语义：
- TCC 未授权 → SKIP（exit 0），附强制授权指引；
- 授权且全断言 PASS → exit 0；
- 任何断言失败 → FAIL（exit 1）。

用法：
  python3 .c33_smoke.py [socket] [daemon-bin] [target] [--shutdown]
    socket      默认 ~/.glasspane/engine.sock
    daemon-bin  默认 ../engine 同仓库 .build/release/glasspaned（引擎推导）
    target      可选：bundleId（如 com.apple.Notes）或 pid；缺省自动发现
                运行中的 glasspane-settings（点其"刷新"按钮，无副作用）
    --shutdown  结束前对 daemon 发 shutdown（仅自管实例使用；共享实例勿用）
"""
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time

DEFAULT_SOCKET = os.path.expanduser("~/.glasspane/engine.sock")
DEFAULT_DAEMON = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), ".build", "release", "glasspaned"
)


def parse_args(argv):
    rest = list(argv)
    sock = DEFAULT_SOCKET
    daemon_bin = DEFAULT_DAEMON
    target = None
    shutdown = False
    # 位置参数固定为 [socket] [daemon-bin] [target]；不含时用默认值。
    positional = [arg for arg in rest if not arg.startswith("--")]
    if len(positional) >= 1:
        sock = positional[0]
    if len(positional) >= 2:
        daemon_bin = positional[1]
    if len(positional) >= 3:
        target = positional[2]
    shutdown = "--shutdown" in rest
    return sock, daemon_bin, target, shutdown


def discover_settings_pids(daemon_bin):
    """发现运行中的 glasspane-settings 全部 pid（部署后通常已由安装器/GUI 拉起）。
    可能同时存在裸二进制与 .app 两实例、且其一窗口已关，故返回列表逐个尝试。
    真实探测，不伪造。"""
    candidates = [
        ["pgrep", "-f", "glasspane-settings"],
        ["pgrep", "-f", "GlassPane.app"],
    ]
    for candidate in candidates:
        try:
            probe = subprocess.run(candidate, capture_output=True, text=True, timeout=10)
            if probe.returncode == 0 and probe.stdout.strip():
                pids = [int(line) for line in probe.stdout.splitlines() if line.strip().isdigit()]
                if pids:
                    return pids
        except (subprocess.TimeoutExpired, ValueError):
            continue
    return []


def recv_frame(sock):
    sock.settimeout(30)
    buf = b""
    while b"\n" not in buf:
        chunk = sock.recv(65536)
        if not chunk:
            break
        buf += chunk
    return json.loads(buf.decode("utf-8").strip())


def send(sock, mid, method, params, raw=False):
    sock.sendall(json.dumps({"id": mid, "method": method, "params": params}).encode() + b"\n")
    resp = recv_frame(sock)
    if "error" in resp:
        if raw:
            return resp
        raise AssertionError(f"{method}: {json.dumps(resp['error'])[:300]}")
    return resp.get("result", resp)


INJECTOR_SRC = """
// C33 冒烟注入器：以未占用鼠标键（button 29）连发 otherMouseDown/Up。
// 该键无任何系统/应用语义，坐标固定在角落，事件仅用于被 daemon 的
// CGEvent tap 捕获为 .human——验证污染判定，不产生真实交互。
import CoreGraphics
import Foundation

let arguments = CommandLine.arguments
let count = arguments.count > 1 ? (Int(arguments[1]) ?? 10) : 10
let intervalMs = arguments.count > 2 ? (Int(arguments[2]) ?? 100) : 100
for _ in 0..<count {
    let point = CGPoint(x: 5, y: 5)
    if let down = CGEvent(mouseEventSource: nil, mouseType: .otherMouseDown,
                          mouseCursorPosition: point, mouseButton: CGMouseButton(rawValue: 29)!) {
        down.post(tap: .cgSessionEventTap)
    }
    if let up = CGEvent(mouseEventSource: nil, mouseType: .otherMouseUp,
                        mouseCursorPosition: point, mouseButton: CGMouseButton(rawValue: 29)!) {
        up.post(tap: .cgSessionEventTap)
    }
    usleep(UInt32(intervalMs * 1000))
}
"""


def build_injector():
    """编译注入器二进制（swiftc，一次性，缓存在 TMPDIR）。真机面专用。"""
    cache_dir = os.path.join(tempfile.gettempdir(), "glasspane-c33-smoke")
    os.makedirs(cache_dir, exist_ok=True)
    binary = os.path.join(cache_dir, "injector")
    if not os.path.exists(binary):
        source = os.path.join(cache_dir, "injector.swift")
        with open(source, "w", encoding="utf-8") as handle:
            handle.write(INJECTOR_SRC)
        compile_result = subprocess.run(
            ["swiftc", "-O", source, "-o", binary], capture_output=True, text=True, timeout=180
        )
        if compile_result.returncode != 0:
            fail(f"注入器编译失败（需 Xcode CLT）：{compile_result.stderr[:300]}")
    return binary


def start_injector(binary, count, interval_ms):
    """后台连发注入事件，返回 (进程, 计划存活秒数)。"""
    proc = subprocess.Popen([binary, str(count), str(interval_ms)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return proc, count * interval_ms / 1000.0


def stop_injector(proc):
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def evidence_attribution(sock, nid):
    frame = send(sock, nid(), "last_evidence", {})
    pack = frame.get("evidencePack", frame)
    return pack.get("attribution") or {}


def act_raw_error_code(sock, nid, button):
    try:
        resp = send(sock, nid(), "act", {"selector": button, "action": "press"}, raw=True)
    except (AssertionError, json.JSONDecodeError) as error:
        return f"<异常: {error}>"
    if "error" in resp:
        return resp["error"].get("code") or json.dumps(resp["error"])[:120]
    return None


def fail(msg):
    print(f"FAIL {msg}")
    sys.exit(1)


def find_button(tree, title=None, depth=0):
    # 深度上限对齐 observe maxDepth（C6 留档：跳转按钮在面板 6+ 层，浅裁会漏）。
    if depth > 12:
        return None
    if isinstance(tree, list):
        for item in tree:
            found = find_button(item, title, depth + 1)
            if found:
                return found
        return None
    if not isinstance(tree, dict):
        return None
    if tree.get("role") == "AXButton":
        if title is None or tree.get("title") == title:
            selector = {"role": "AXButton"}
            if tree.get("title"):
                selector["title"] = tree["title"]
            return selector
    for child in tree.get("children", []) or []:
        found = find_button(child, title, depth + 1)
        if found:
            return found
    return None


def attach_and_find_button(sock, nid, attach_params):
    """attach → observe → 优先"刷新"按钮（settings GUI 自带、无副作用），
    退化为任意 AXButton。返回 (attach 帧, observe 帧, 按钮 selector | None)。"""
    frame = send(sock, nid(), "attach", attach_params)
    assert "pid" in frame and "appName" in frame, f"attach 缺字段: {frame}"
    obs = send(sock, nid(), "observe", {"maxDepth": 10})
    assert "axTree" in obs and "nodeCount" in obs, f"observe 缺字段: {obs}"
    button = find_button(obs.get("axTree"), title="刷新")
    if button is None:
        button = find_button(obs.get("axTree"))
    return frame, obs, button


def main():
    sock_path, daemon_bin, target, want_shutdown = parse_args(sys.argv[1:])
    if not os.path.exists(daemon_bin):
        fail(f"daemon 二进制不存在：{daemon_bin}（先 swift build -c release）")
    probe = subprocess.run(
        [daemon_bin, "--check-input-permission"], capture_output=True, text=True, timeout=30
    )
    state = (probe.stdout or "").strip()
    if probe.returncode != 0 or state not in ("granted", "denied", "notDetermined"):
        fail(f"--check-input-permission 输出异常：rc={probe.returncode} stdout={probe.stdout!r} stderr={probe.stderr!r}")
    if state != "granted":
        print(
            f"SKIP C33 输入监控冒烟：TCC 状态={state}（未授权无从观察输入流）。\n"
            "修复：系统设置 > 隐私与安全性 > 输入监控，为本终端/glasspaned 打开开关后重跑本脚本。"
        )
        sys.exit(0)

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.connect(sock_path)
    except OSError as error:
        fail(f"连接 daemon socket {sock_path} 失败：{error}")
    counter = [0]

    def nid():
        counter[0] += 1
        return counter[0]

    frame = send(sock, nid(), "hello", {})
    assert "version" in frame, f"hello 无 version: {frame}"
    print(f"PASS daemon hello（version={frame.get('version')}, capabilities={frame.get('capabilities')}）")
    print(f"PASS 输入监控 TCC 已授权（inputMonitoring=granted，由 {daemon_bin} 如实探测）")

    # 目标解析：pid（纯数字）| bundleId（含点）| 缺省自动发现 settings GUI。
    if target is None:
        pids = discover_settings_pids(daemon_bin)
        if not pids:
            fail("未指定 target 且未发现运行中的 glasspane-settings（先启动设置面板，或用 bundleId/pid 指定目标）")
        picked = None
        for candidate_pid in pids:
            # 多实例/窗口已关场景：逐个 attach+observe，取第一个树中有按钮的实例。
            frame, obs, button = attach_and_find_button(sock, nid, {"pid": candidate_pid})
            if button is not None:
                picked = (candidate_pid, frame, obs, button)
                break
            print(f"  跳过 pid={candidate_pid}（AX 树无按钮，可能窗口已关）")
        if picked is None:
            fail("全部 glasspane-settings 实例的 AX 树均无按钮（窗口未开？先打开设置面板，或用 bundleId/pid 指定其他目标）")
        target_pid, frame, obs, button = picked
        print(f"PASS 自动发现目标 glasspane-settings（pid={target_pid}）")
    elif target.isdigit():
        frame, obs, button = attach_and_find_button(sock, nid, {"pid": int(target)})
        print(f"PASS 目标 pid={target}")
    else:
        frame, obs, button = attach_and_find_button(sock, nid, {"bundleId": target})
        print(f"PASS 目标 bundleId={target}")

    assert frame.get("pid") is not None and frame.get("appName") is not None, f"attach 缺字段: {frame}"
    print(f"PASS attach → appName={frame.get('appName')} pid={frame.get('pid')}")
    assert button is not None, "AX 树中未发现任何 AXButton（daemon AX 权限未授予？）"
    print(f"PASS observe → nodeCount={obs.get('nodeCount')}（action 目标={button.get('title') or 'role-only AXButton'}）")

    # 基础回路 act：guard 注入后若用户恰在输入，GP_E_BUSY_INPUT 是互斥机制的
    # 正确行为——脚本如实重试（期间请勿动键盘/鼠标）。
    frame = {}
    for attempt in range(3):
        frame = send(sock, nid(), "act", {"selector": button, "action": "press"}, raw=True)
        if "error" not in frame:
            break
        if (frame["error"] or {}).get("code") != "GP_E_BUSY_INPUT":
            raise AssertionError(f"act: {json.dumps(frame['error'])[:300]}")
        print(f"  act 因输入忙碌被拒（C33 互斥生效），1.5s 后重试（{attempt + 1}/3）")
        time.sleep(1.5)
    assert frame.get("actConfirmed") is True, f"act 未确认: {frame}"
    operation_id = frame.get("operationId")
    print(f"PASS act actConfirmed → operationId={operation_id}")

    frame = send(sock, nid(), "last_evidence", {})
    pack = frame.get("evidencePack", frame)
    attribution = pack.get("attribution") or {}
    assert "level" in attribution and "contaminated" in attribution, f"evidence 归因面缺失: {attribution}"
    assert attribution["level"] in ("soft", "weak"), f"归因 level 非法: {attribution.get('level')}"
    circuit = pack.get("circuitBreaker") or {}
    assert "level" in circuit, f"evidence 熔断面缺失: {circuit}"
    print(
        f"PASS evidence 归因面如实落盘 → attribution.level={attribution.get('level')} "
        f"contaminated={attribution.get('contaminated')} circuitBreaker.level={circuit.get('level')}"
    )

    # --- C33 三阶段完整判定（P4 §36：daemon 已默认注入 AttributionGuard）------
    # 运行期间请勿触碰键盘鼠标（真实输入会被如实判为污染/忙碌，属正确行为）。
    injector = build_injector()

    # 阶段一：操作权互斥——持续注入窗（≥3s，覆盖 500ms 空闲检测 + 250ms 重试
    # 预算）内 act 必须被如实拒绝。注入事件从 post 到 daemon tap 回调入队有
    # 百毫秒级系统投递延迟，实测 act 前先静候 1s 才稳定落在忙碌窗内。
    busy_proc, _ = start_injector(injector, 30, 100)
    time.sleep(1.0)
    busy_code = act_raw_error_code(sock, nid, button)
    stop_injector(busy_proc)
    assert busy_code == "GP_E_BUSY_INPUT", f"busy 拒绝未生效：{busy_code}"
    print("PASS C33 阶段一 操作权互斥 → 注入期 act 得 GP_E_BUSY_INPUT")
    time.sleep(1.2)

    # 阶段二：持有期间污染检出——act 先发出、注入器紧随启动，使注入事件落入
    # 操作持有窗（timestamp ≥ holdStart）→ contaminated=true、归因降 weak。
    # 时序敏感，最多 5 次尝试；busyInput 被拒也算机制在工作的如实呈现。
    verdict = {"contaminated": None, "level": None}
    for attempt in range(1, 6):
        result = {}

        def concurrent_act():
            result["frame"] = send(sock, nid(), "act", {"selector": button, "action": "press"}, raw=True)

        worker = threading.Thread(target=concurrent_act, daemon=True)
        worker.start()
        inject_proc, _ = start_injector(injector, 20, 100)
        worker.join(timeout=35)
        stop_injector(inject_proc)
        frame_act = result.get("frame") or {}
        if "error" in frame_act:
            if (frame_act["error"] or {}).get("code") != "GP_E_BUSY_INPUT":
                raise AssertionError(f"act: {json.dumps(frame_act['error'])[:300]}")
            print(f"  阶段二 第 {attempt} 次：act 忙碌被拒（注入太早），排空后重试")
            time.sleep(1.4)
            continue
        attribution_now = evidence_attribution(sock, nid)
        verdict = {
            "contaminated": attribution_now.get("contaminated"),
            "level": attribution_now.get("level"),
        }
        print(f"  阶段二 第 {attempt} 次：contaminated={verdict['contaminated']} level={verdict['level']}")
        if verdict["contaminated"] is True:
            break
        time.sleep(1.4)
    assert verdict["contaminated"] is True, "C33 污染判定未生效：5 次注入均未检出 contaminated=true"
    assert verdict["level"] == "weak", f"污染归因应降级为 weak，实为 {verdict['level']}"
    print("PASS C33 阶段二 污染检出 → contaminated=true + 归因降 weak")

    # 阶段三：干净路径——输入静默后 act 必须 contaminated=false（无误杀）。
    # 真机开发者在座，偶发真实输入会被如实判污（正确行为），给 3 次静默重试。
    attribution_clean = {}
    for attempt in range(3):
        time.sleep(1.4)
        clean_frame = send(sock, nid(), "act", {"selector": button, "action": "press"})
        assert clean_frame.get("actConfirmed") is True, f"阶段三 act 未确认: {clean_frame}"
        attribution_clean = evidence_attribution(sock, nid)
        if attribution_clean.get("contaminated") is False:
            break
        print(f"  阶段三 第 {attempt + 1} 次检到输入事件（或为真人在键鼠操作），静默重试")
    assert attribution_clean.get("contaminated") is False, \
        f"阶段三误杀（检测到不存在的用户输入）: {attribution_clean}"
    assert attribution_clean.get("level") == "soft", f"干净路径归因应回 soft: {attribution_clean}"
    print("PASS C33 阶段三 干净路径 → contaminated=false + level=soft（误杀率面通过）")
    if want_shutdown:
        frame = send(sock, nid(), "shutdown", {})
        assert frame.get("bye") is True, f"shutdown: {frame}"
        print("PASS shutdown bye")
    sock.close()
    print("C33 SMOKE OK")


if __name__ == "__main__":
    main()