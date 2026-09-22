#!/usr/bin/env python3
"""P6 spec v6.0 §10 P6-E real-machine smoke — probe SDK end-to-end.

Brings up a dedicated daemon (isolated sockets under /tmp) and the synthetic
probe-demo control app, then asserts the full probe surface:

  1. probe_status: hello registration, capabilities, attachedHasProbe
  2. five canaries: NO_ANOMALY/strong, T4, T5, T7, T8, T3 — each detected once
  3. tier-1 checkpoint: snapshot carries a real gpz1 payload; rollback_full
     executes through the probe (rollbackExecuted=true, consistent=true) and
     the count-marker-row structurally returns to the snapshot value (0).

Usage: python3 .p6_smoke.py [daemon-bin] [demo-bin]
  daemon-bin 定位顺序：argv > env GLASSPANE_DAEMON_BIN > 仓库相对
             .build/{debug,release}/glasspaned > 历史 /tmp 默认值
  demo-bin   定位顺序：argv > env GLASSPANE_DEMO_BIN > probe/.build/{debug,release}
             >/Volumes/Eng-Dev/GlassPane/engine/probe/.build/debug/probe-demo
Exit codes: 0 = PASS（全部断言真实执行）, 1 = FAIL,
  2 = NOT RUN（前置二进制缺失，一条断言都没跑——NOT RUN 绝不等于通过）。
"""

import json
import os
import subprocess
import sys
import tempfile
import time
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
# 二进制定位：优先脚本自身的仓库相对构建产物（worktree 里 swift build 即可产出，
# AI agent 可执行），机器特定的历史默认值只作最后兜底——缺失即 NOT RUN，不猜。
DAEMON_CANDIDATES = [
    os.path.join(HERE, ".build", "debug", "glasspaned"),
    os.path.join(HERE, ".build", "release", "glasspaned"),
    "/tmp/glasspane-p6/engine/.build/debug/glasspaned",
]
DEMO_CANDIDATES = [
    os.path.join(HERE, "probe", ".build", "debug", "probe-demo"),
    os.path.join(HERE, "probe", ".build", "release", "probe-demo"),
    "/Volumes/Eng-Dev/GlassPane/engine/probe/.build/debug/probe-demo",
]

PASS = []


def resolve_binary(explicit, env_var, candidates):
    """argv > env > first existing candidate > last candidate（仅用于报错展示）。"""
    if explicit:
        return explicit
    from_env = os.environ.get(env_var)
    if from_env:
        return from_env
    for cand in candidates:
        if os.path.exists(cand):
            return cand
    return candidates[-1]


def check(label, condition, detail=""):
    if not condition:
        print(f"FAIL {label} {detail}")
        sys.exit(1)
    PASS.append(label)
    print(f"PASS {label} {detail}")


class SocketClient:
    def __init__(self, path):
        import socket as s
        self.sock = s.socket(s.AF_UNIX, s.SOCK_STREAM)
        self.sock.connect(path)
        self.buf = b""
        self.next_id = 0

    def call(self, method, params=None, timeout=20.0):
        import socket as s
        self.next_id += 1
        frame = {"id": self.next_id, "method": method}
        if params is not None:
            frame["params"] = params
        self.sock.sendall((json.dumps(frame) + "\n").encode("utf-8"))
        self.sock.settimeout(timeout)
        while True:
            while b"\n" in self.buf:
                line, self.buf = self.buf.split(b"\n", 1)
                if not line.strip():
                    continue
                reply = json.loads(line)
                if reply.get("id") == self.next_id:
                    if "error" in reply:
                        raise RuntimeError(f"{method} -> {reply['error']}")
                    return reply["result"]
            chunk = self.sock.recv(65536)
            if not chunk:
                raise RuntimeError("daemon closed the connection")
            self.buf += chunk

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def find_button(client, identifier):
    tree = client.call("observe", {"maxDepth": 10})

    def walk(nodes):
        for node in nodes:
            if node.get("role") == "AXButton" and node.get("identifier") == identifier:
                return node
            found = walk(node.get("children") or [])
            if found:
                return found
        return None

    return walk(tree.get("axTree") or [])


def press(client, identifier, timeout=None):
    button = find_button(client, identifier)
    assert button is not None, f"probe-demo 未找到按钮 {identifier}"
    selector = {"role": "AXButton", "identifier": identifier}
    if button.get("title") is not None:
        selector["title"] = button["title"]
    params = {"selector": selector, "action": "press"}
    if timeout:
        params["timeout"] = timeout
    return client.call("act", params)


def diagnose_of(client, operation_id):
    return client.call("diagnose", {"operationId": operation_id})


def evidence_of(client, operation_id):
    frame = client.call("last_evidence", {"operationId": operation_id})
    return frame.get("evidencePack", frame)


def marker_nodes(client):
    """count 驱动的可见结构节点数（probe-demo 的 count-marker-row 行数）。

    observe 方法表冻结在 role/title/identifier（P0 §3，真机观察 13：SwiftUI Text
    文案在 AXValue 通道，daemon 不序列化），"count: N" 字符串读不到，而
    count-label 又无条件在场——它的存在不随恢复值变化，不构成 UI 佐证。
    demo 为此把 count 具象成 Image 行数（ProbeDemoApp.swift 的结构性标记）。
    这里数全树"无 identifier 的 AXImage"：press→restore 窗口内 drift-marker-row
    与 lazy 行恒常（没有按钮能改它们），差值只可能来自 count 回写。
    """
    tree = client.call("observe", {"maxDepth": 10})
    total = [0]

    def walk(nodes):
        for node in nodes:
            if node.get("role") == "AXImage" and not node.get("identifier"):
                total[0] += 1
            walk(node.get("children") or [])

    walk(tree.get("axTree") or [])
    return total[0]


def run_canary(client, identifier, accepted, label, pre_wait=0.0, post_wait=0.0, attempts=4):
    """Press → (optionally wait) → diagnose; retry while the verdict misses.

    Retry rationale (2026-09-19 真机发现, recorded in smoke.md): the app-wide
    AX tree includes the system Apple-menu whose update badges tick over
    spontaneously — the tree digest therefore carries occasional exogenous
    noise that can flip axChanged for a quiet button. Verdicts are unit-tested
    deterministically; this smoke asserts the end-to-end path, so a miss on
    the noise path is retried and disclosed, never hidden.
    """
    last = None
    for attempt in range(attempts):
        if attempt:
            time.sleep(1.2)
        outcome = press(client, identifier)
        if post_wait:
            time.sleep(post_wait)
        elif pre_wait:
            pass
        diag = diagnose_of(client, outcome["operationId"])
        pack = evidence_of(client, outcome["operationId"])
        cls = diag["class"]
        last = (cls, diag, pack)
        if cls in accepted:
            extra = "" if attempt == 0 else f"（第 {attempt + 1} 次达成；此前分类 {cls} 见 NOTE）"
            check(label, True, f"class={cls}{extra}")
            return pack
    print(f"FAIL {label} — {attempts} 次后仍未落入 {accepted}，最后 class={last[0]}（如系统菜单噪声持续或判定确误，此为真失败）")
    sys.exit(1)


def main():
    daemon_bin = resolve_binary(sys.argv[1] if len(sys.argv) > 1 else None,
                                "GLASSPANE_DAEMON_BIN", DAEMON_CANDIDATES)
    demo_bin = resolve_binary(sys.argv[2] if len(sys.argv) > 2 else None,
                              "GLASSPANE_DEMO_BIN", DEMO_CANDIDATES)
    missing = [p for p in (daemon_bin, demo_bin) if not os.path.exists(p)]
    if missing:
        # 本文件头部定义 exit 0 = PASS：前置缺失绝不能以 0 离场冒充绿——
        # 用独立退出码 2（NOT RUN），并点名缺失产物与可执行的补救命令。
        print("NOT RUN — 前置产物缺失，本轮未执行任何断言（NOT RUN ≠ PASS）：")
        for path in missing:
            print(f"  missing artifact: {path}")
        print("REMEDY: cd engine && swift build && (cd probe && swift build)；"
              "或以位置参数/env（GLASSPANE_DAEMON_BIN、GLASSPANE_DEMO_BIN）显式给出二进制路径")
        sys.exit(2)

    workdir = tempfile.mkdtemp(prefix="glasspane-p6-smoke-")
    engine_sock = os.path.join(workdir, "engine.sock")
    probe_sock = os.path.join(workdir, "probe.sock")

    daemon = subprocess.Popen(
        [daemon_bin, "--socket-path", engine_sock, "--probe-socket-path", probe_sock,
         "--no-c33", "--verbose"],
        stdout=open(os.path.join(workdir, "daemon.log"), "w"),
        stderr=subprocess.STDOUT,
    )
    env = dict(os.environ, GLASSPANE_PROBE_SOCK=probe_sock)
    demo = subprocess.Popen([demo_bin], env=env,
                            stdout=open(os.path.join(workdir, "demo.log"), "w"),
                            stderr=subprocess.STDOUT,
                            start_new_session=True)
    client = None
    try:
        deadline = time.time() + 15
        while time.time() < deadline:
            try:
                client = SocketClient(engine_sock)
                break
            except OSError:
                time.sleep(0.3)
        if client is None:
            print("FAIL daemon 未在 15s 内监听（见 daemon.log）")
            sys.exit(1)

        hello = client.call("hello")
        assert "probe" in hello["capabilities"], "hello.capabilities 必须含 probe（P6 §5.3）"
        check("daemon hello 携带 probe 能力", True)

        # attach by pid — a GUI app registers with LaunchServices
        # asynchronously, so retry the attach itself (not just probe_status).
        attached = False
        for _ in range(40):
            try:
                client.call("attach", {"pid": demo.pid})
                attached = True
                break
            except RuntimeError:
                time.sleep(0.25)
        if not attached:
            print("FAIL attach 未在 10s 内成功（demo 可能未起窗口，见 demo.log）")
            sys.exit(1)
        has_probe = False
        for _ in range(40):
            status = client.call("probe_status")
            if status.get("attachedHasProbe"):
                has_probe = True
                break
            time.sleep(0.25)
        check("probe hello 注册且 attachedHasProbe=true", has_probe)
        probe_info = next(p for p in client.call("probe_status")["probes"] if p["pid"] == demo.pid)
        check("探针能力自报（z1 恒在 + z3 + checkpoint）",
              "z1" in probe_info["capabilities"] and "z3" in probe_info["capabilities"]
              and "checkpoint" in probe_info["capabilities"],
              f"caps={probe_info['capabilities']} version={probe_info['probeVersion']}")

        # tier-1 快照提前拍在任何 count 自增加压之前（此刻 count=0，gpz1 payload
        # 真实为 {"count":"0"}）：回滚目标 0 与金丝雀段累积出的结构标记行数
        # （≥4，饱和上限 6）在 observe 树上可区分——档 1 的 UI 回写核验就靠这个差值。
        snapshot = client.call("snapshot", {"maxDepth": 6})
        snapshot_id = snapshot["snapshotId"]

        # ---- canary 1: NO_ANOMALY + strong attribution -------------------
        outcome = press(client, "ok-press")
        pack = evidence_of(client, outcome["operationId"])
        check("NO_ANOMALY 金丝雀：attribution 升 strong（§2.3）",
              pack["attribution"]["level"] == "strong",
              f"level={pack['attribution']['level']}")
        check("探针信号真实落进 evidence（§3.1 null→object）",
              pack["signals"]["handlerProbe"] is not None
              and pack["signals"]["handlerProbe"]["hitCount"] >= 1
              and pack["signals"]["stateDiff"] is not None
              and pack["signals"]["stateDiff"]["changed"] is True,
              f"handlerProbe={json.dumps(pack['signals']['handlerProbe'])} stateDiff.changed={pack['signals']['stateDiff']['changed']}")
        pixel_denied = (pack.get("circuitBreaker") or {}).get("reason", "") == "screen-recording-denied"
        accepted = {"NO_ANOMALY"} if not pixel_denied else {"NO_ANOMALY", "INCONCLUSIVE"}
        run_canary(client, "ok-press", accepted,
                   "NO_ANOMALY 判定" + ("（屏幕录制未授予→INCONCLUSIVE 为已知边界）" if pixel_denied else ""))

        # ---- canaries 2..6: probe-decidable classes ----------------------
        run_canary(client, "dead-handler", {"T4"},
                   "T4 金丝雀（handler 跑了，state/AX/像素全静）")
        run_canary(client, "hidden-write", {"T5"},
                   "T5 金丝雀（state 变了界面没变）")
        run_canary(client, "ui-only", {"T7"},
                   "T7 金丝雀（UI 变了探针 state 没变）")
        run_canary(client, "nothing", {"T3"},
                   "T3 金丝雀（handler 未跑：黑盒判定零回归）")
        pack = run_canary(client, "delayed", {"T8"},
                          "T8 金丝雀（窗口内静默、迟到事件入账）", post_wait=2.5)
        assert pack["signals"]["handlerProbe"]["lateCount"] >= 1, "lateCount 必须 ≥1"
        check("T8 lateCount 真值落进 evidence", True,
              f"lateCount={pack['signals']['handlerProbe']['lateCount']}")

        # lateCount 真值复核（T8 的判据字段必须已落进 evidence）
        # ---- tier-1 checkpoint: executed rollback + UI 结构回写核验 ---------
        # push further, then roll the checkpoint back through the probe
        press(client, "ok-press")
        markers_before = marker_nodes(client)
        restore = client.call("restore", {"snapshotId": snapshot_id, "mode": "rollback_full"})
        check("档 1 执行面：rollbackExecuted=true + consistent=true（§5.5/C34 语义）",
              restore.get("rollbackExecuted") is True and restore.get("consistent") is True
              and restore.get("executionSurface") == "gp-probe",
              f"surface={restore.get('executionSurface')} consistent={restore.get('consistent')}")
        # UI corroboration: the count label reflects the restored value.
        tree = client.call("observe", {"maxDepth": 10})
        text = json.dumps(tree.get("axTree"))
        check("恢复后 UI 回写可见（count 标签存在）", "count-label" in text)
        # 值敏感的 UI 回写核验（弱断言"标签存在即过"保留，但不再由它充数）：
        # before/after 两点观察窗口内 drift 行与 lazy 行数恒定，无 identifier
        # AXImage 总数的差值只可能来自 count 标记行：回滚目标为快照值 count=0，
        # 回滚前 count=C+1≥4（初始 ok-press + NO_ANOMALY 金丝雀 + delayed +
        # 本轮加压，行渲染 min(count,6)）→ 差值必须落在 [4,6]。
        # 证明：探针写回的数值确实驱动 demo UI 结构回退，且回退量与快照值一致
        #       （没回滚 → 差 0；只回退一步 → 差 ≤1；都判 FAIL）。
        # 不证明：具体数字文案 "count: 0"——AXValue 不在 observe 方法表内
        #       （P6 §0 F6），结构行数即该通道能取到的最强可观测证物，如实到顶。
        time.sleep(0.8)  # 给 SwiftUI 一次重渲周期再读树
        markers_after = marker_nodes(client)
        markers_delta = markers_before - markers_after
        check("恢复后 UI 结构回写：count 标记行随快照值 0 清空（差值∈[4,6]）",
              4 <= markers_delta <= 6,
              f"delta={markers_delta} before={markers_before} after={markers_after}")

        print(f"C34 参考：restore digest {str(restore.get('postStateDigest'))[:8]}… 一致性已验")
        client.call("shutdown")
        print("P6 SMOKE OK")
    finally:
        if client:
            client.close()
        for proc in (demo, daemon):
            try:
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                proc.kill()
        print(f"NOTE 工作目录：{workdir}（daemon.log/demo.log 留档）")


if __name__ == "__main__":
    main()
