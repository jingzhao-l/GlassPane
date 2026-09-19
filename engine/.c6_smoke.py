#!/usr/bin/env python3
"""GlassPane P1-C6 真机冒烟（spec v1.2 §10.4）：通过 daemon 的 AX 通道读取
glasspane-settings 面板的 UI 树，从结构断言四权限卡、跳转按钮与降级折叠区。

真机观察（2026-09-19 留档）：SwiftUI 静态文本内容暴露在 AX value 通道，
而 daemon observe/selector 方法表冻结在 role/title/identifier 三字段
（P0 §3），故不读文本内容，改验结构：每卡一枚 AXImage（identifier 对应
四种权限图标）+ 3×AXStaticText + 1×AXButton（跳转），加上 AXDisclosureTriangle
（拒绝降级折叠区）。文本性断言（如"已授予"字样）标注为 AX 通道字段白名单
限制，详见 smoke.md。

附带验证 attach by pid（此前只冒烟过 bundleId）。
"""
import json
import socket
import sys

SOCK = sys.argv[1] if len(sys.argv) > 1 else "/tmp/c6.sock"
SETTINGS_PID = int(sys.argv[2]) if len(sys.argv) > 2 else None

# 四权限卡的 AXImage identifier（SettingsPanelView 渲染 PermissionKind 图标）
EXPECTED_CARD_ICONS = [
    "accessibility",          # 辅助功能
    "cursorarrow.click.2",    # 输入监控
    "rectangle.on.rectangle", # 屏幕录制
    "hammer",                 # 开发者工具
]


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
    return resp.get("result", resp)


def fail(msg):
    print(f"FAIL {msg}")
    sys.exit(1)


def walk(node, fn):
    if isinstance(node, list):
        for item in node:
            walk(item, fn)
        return
    if not isinstance(node, dict):
        return
    fn(node)
    for child in node.get("children", []) or []:
        walk(child, fn)


def main():
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect(SOCK)
    counter = [0]

    def nid():
        counter[0] += 1
        return counter[0]

    if SETTINGS_PID is None:
        fail("settings pid required")

    frame = send(sock, nid(), "hello", {})
    if "version" not in frame:
        fail(f"hello: {json.dumps(frame)[:200]}")
    print("PASS daemon hello (version reachable)")

    frame = send(sock, nid(), "attach", {"pid": SETTINGS_PID})
    if "pid" not in frame:
        fail(f"attach by pid: {json.dumps(frame)[:200]}")
    print(f"PASS attach by pid -> appName={frame.get('appName')}")

    frame = send(sock, nid(), "observe", {"maxDepth": 10})
    if "axTree" not in frame:
        fail(f"observe: {json.dumps(frame)[:200]}")

    nodes = []
    walk(frame.get("axTree"), nodes.append)
    print(f"info: nodeCount={frame.get('nodeCount')}")

    identifiers = {n.get("identifier") for n in nodes if n.get("identifier")}
    for icon in EXPECTED_CARD_ICONS:
        if icon not in identifiers:
            fail(f"permission card icon missing: {icon}")
        print(f"PASS permission card: {icon}")

    # 每张权限卡 = AXImage + 3×AXStaticText + AXButton（跳转）的同轴结构。
    # 以卡图标节点为锚，检查其父级子节点里出现 AXButton 与 AXStaticText。
    parents = {}
    def collect_with_parent(node, parent=None):
        if isinstance(node, list):
            for item in node:
                collect_with_parent(item, parent)
            return
        if not isinstance(node, dict):
            return
        parents.setdefault(id(node), parent)
        for child in node.get("children", []) or []:
            collect_with_parent(child, node)

    collect_with_parent(frame.get("axTree"))
    icon_names = {"accessibility": "accessibility卡", "cursorarrow.click.2": "inputMonitoring卡",
                  "rectangle.on.rectangle": "screenRecording卡", "hammer": "developerTools卡"}
    for icon in EXPECTED_CARD_ICONS:
        card = next(n for n in nodes if n.get("identifier") == icon)
        parent = parents.get(id(card))
        if parent is None:
            fail(f"{icon_names[icon]} has no parent")
        sibling_roles = {n.get("role") for n in parent.get("children", [])}
        if "AXButton" not in sibling_roles:
            fail(f"{icon_names[icon]} missing jump AXButton")
        if not any(n.get("role") == "AXStaticText" for n in parent.get("children", [])):
            fail(f"{icon_names[icon]} missing text rows")
        print(f"PASS {icon_names[icon]} jump button + text rows present")

    # 卡片主体文本节点（displayName/purpose/degradation 三行）按数量断言：
    # 4 卡 × 3 行 = 12 个最少；daemon 卡与折叠区文本未计入 title（value 通道）。
    static_texts = [n for n in nodes if n.get("role") == "AXStaticText"]
    if len(static_texts) < 12:
        fail(f"fewer static-text nodes than 4×3 cards: {len(static_texts)}")
    print(f"PASS card text rows rendered ({len(static_texts)} AXStaticText)")

    # 拒绝降级形态折叠区（spec §6.3）
    if not any(n.get("role") == "AXDisclosureTriangle" for n in nodes):
        fail("degradation disclosure triangle missing")
    print("PASS degradation disclosure triangle")

    # 窗口标题与菜单就位
    titles = {n.get("title") for n in nodes if n.get("title")}
    if "GlassPane 设置" not in titles:
        fail("window title missing")
    print("PASS window title 'GlassPane 设置'")

    sock.sendall(json.dumps({"id": nid(), "method": "shutdown", "params": {}}).encode() + b"\n")
    sock.close()
    print("C6 SMOKE OK")


if __name__ == "__main__":
    main()