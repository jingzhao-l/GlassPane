#!/usr/bin/env python3
"""GlassPane 真机冒烟客户端（P1-B7/A7 真机面、D6 前置 act）。

对运行中的 daemon 做 socket 全循环：
hello -> attach(Notes) -> observe -> act -> assert_element -> snapshot
-> diagnose -> last_evidence -> restore(ffwd 重演) -> shutdown。
每步断言关键字段，失败即退出码非 0。
"""
import json
import socket
import sys

SOCK = sys.argv[1] if len(sys.argv) > 1 else "/tmp/gp-smoke.sock"


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
    sock.sendall(
        json.dumps({"id": mid, "method": method, "params": params}).encode()
        + b"\n"
    )
    resp = recv_frame(sock)
    return resp.get("result", resp)


def require(cond, label, frame):
    if not cond:
        print(f"FAIL: {label} in {json.dumps(frame)[:300]}")
        sys.exit(1)
    print(f"PASS: {label}")


def find_button(tree, depth=0):
    if depth > 4:
        return None
    if isinstance(tree, list):
        for item in tree:
            found = find_button(item, depth + 1)
            if found:
                return found
        return None
    if not isinstance(tree, dict):
        return None
    # Preferred target: first AXButton (role-only). A Notes toolbar button is
    # the most benign press target; menu-bar items block on real AX, so they
    # are avoided here (a documented real-device observation).
    if tree.get("role") == "AXButton":
        selector = {"role": "AXButton"}
        if tree.get("title"):
            selector["title"] = tree["title"]
        if tree.get("identifier"):
            selector["identifier"] = tree["identifier"]
        return selector
    for child in tree.get("children", []) or []:
        found = find_button(child, depth + 1)
        if found:
            return found
    return None


def main():
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect(SOCK)
    counter = [0]

    def nid():
        counter[0] += 1
        return counter[0]

    frame = send(sock, nid(), "hello", {})
    require("version" in frame or "daemon" in frame, "hello daemon/version", frame)

    frame = send(sock, nid(), "attach", {"bundleId": "com.apple.Notes"})
    require("pid" in frame and "bundleId" in frame and "appName" in frame, "attach returns pid/bundleId/appName", frame)

    frame = send(sock, nid(), "observe", {"maxDepth": 3})
    require("axTree" in frame and "nodeCount" in frame and "digest" in frame, "observe returns tree/nodeCount/digest", frame)
    button = find_button(frame.get("axTree"))
    if button is None:
        button = {"role": "AXButton", "title": "新建备忘录"}
        print("WARN: no AXButton found in tree, falling back to 新建备忘录")

    frame = send(sock, nid(), "act", {"selector": button, "action": "press"})
    require(frame.get("actConfirmed") is True, "act actConfirmed", frame)
    require(str(frame.get("operationId", "")).startswith("op_"), "act operationId op_", frame)
    require("evidenceId" in frame, "act evidenceId", frame)

    frame = send(sock, nid(), "assert_element", {
        "selector": button, "property": "enabled", "expected": True,
    })
    require(frame.get("passed") is True, "assert_element passed", frame)
    require("operationId" in frame and "evidenceId" in frame, "assert_element evidence ids", frame)

    frame = send(sock, nid(), "snapshot", {})
    require("snapshotId" in frame and "treeDigest" in frame and "nodeCount" in frame, "snapshot snapshotId/treeDigest", frame)
    snapshot_id = frame["snapshotId"]
    require(str(snapshot_id).startswith("snap_"), "snapshot id prefix", frame)

    frame = send(sock, nid(), "diagnose", {})
    require("class" in frame and "report" in frame, "diagnose class/report", frame)

    frame = send(sock, nid(), "last_evidence", {})
    pack = frame.get("evidencePack", frame)
    require(pack.get("schemaVersion") == "glasspane.evidence/0.1-draft", "evidence schemaVersion", frame)
    require(str(pack.get("operationId", "")).startswith("op_"), "evidence operationId", frame)

    frame = send(sock, nid(), "restore", {
        "snapshotId": snapshot_id,
        "steps": [{"selector": button, "action": "press"}],
    })
    require("confirmed" in frame and "total" in frame, "restore ffwd replay", frame)

    frame = send(sock, nid(), "shutdown", {})
    require(frame.get("bye") is True, "shutdown bye", frame)

    sock.close()
    print("SMOKE OK")


if __name__ == "__main__":
    main()