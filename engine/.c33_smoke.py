#!/usr/bin/env python3
"""GlassPane C33 输入监控真机冒烟（P2 spec v2.0 §17.2 / P4 v4.0 §34.5）。

目的：真机验证"输入监控 TCC 授权"后的真实可观察面，如实区分可运行与不可运行。

本轮履约边界（如实声明，非缺陷）：
- C33 输入流污染判定 = daemon 注入 AttributionGuard 才启用（spec v2.0 §17.2
  降级口径：guard 不注入 = daemon 不启用 C33 检测，纯操作权互斥形态）。
- 因此本脚本在 TCC granted 时执行的真实验证是：输入监控状态可如实读出 +
  完整操作回路（hello/attach/observe/act/last_evidence）在授权环境下跑通 +
  归因面（attribution.level/contaminated/circuitBreaker）如实落盘；输入流
  污染判定的"注入验证"需 daemon 注入 guard 后进行（见冒烟文档边界）。

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


def send(sock, mid, method, params):
    sock.sendall(json.dumps({"id": mid, "method": method, "params": params}).encode() + b"\n")
    resp = recv_frame(sock)
    if "error" in resp:
        raise AssertionError(f"{method}: {json.dumps(resp['error'])[:300]}")
    return resp.get("result", resp)


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

    frame = send(sock, nid(), "act", {"selector": button, "action": "press"})
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

    print(
        "NOTE 输入监控已授权观察面确认；C33 输入流污染判定需 daemon 注入 "
        "AttributionGuard（spec v2.0 §17.2 履约：当前为纯操作权互斥形态）。"
    )
    if want_shutdown:
        frame = send(sock, nid(), "shutdown", {})
        assert frame.get("bye") is True, f"shutdown: {frame}"
        print("PASS shutdown bye")
    sock.close()
    print("C33 SMOKE OK")


if __name__ == "__main__":
    main()