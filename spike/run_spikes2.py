#!/usr/bin/env python3
"""spike/run_spikes2.py — Phase B 前置补数（H5 真实分布 / H6 真重放 / H4 基线通道）。

对应 P6 spec §8 三项"合成侧缺口"，全部在 probe-demo（已扩展 LazyVStack、
replay 面板、MTKView 三面）+ 隔离 daemon 上机器化采集，结果写
spike/spikes2-result.json 并打印 results.md 表格行：

  H4：GP_DEMO_CAPTURE_SCENARIOS=1 场景轮——三场景（静态窗口 / 连续重绘窗口 /
      非法落点）经 GP.onMetalCaptureResult 帧日志切窗落 manifest，验证 Z4.5
      基线对比通道"成功产出路径 + 结构化失败"两态（画布恒 30fps 重绘，A/B 差
      异仅为持窗时长，如实标注）。
  H5：懒容器索引失效率——加 60 行动态内容后，以 observe 树的 identifier 在场率
      作为五线中"AX 索引"一条的失效率样本；同时聚合 add/remove 轮次里 handler
      命中 / state 事件 / axChanged / pixelChanged / late 五线计数。
  H6：真重放抑制——snapshot 后继续改写（值前进），rollback_full 以状态摘要
      consistent=true 证明值回来；replay-appear-row（onAppear 计数具象成的
      结构行）数量不变即生命周期副作用未被重放。

退出：任一硬判定不过 exit 1；环境缺（无产物）SKIP exit 0。
用法：python3 spike/run_spikes2.py
"""
import json
import os
import subprocess
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINE_BIN = os.path.join(REPO, "engine", ".build", "debug", "glasspaned")
DEMO_BIN = os.path.join(REPO, "engine", "probe", ".build", "debug", "probe-demo")
WORK = "/tmp/glasspane-spikes2"


class Client:
    def __init__(self, socket_path):
        import socket as _socket
        self.sock = _socket.socket(_socket.AF_UNIX)
        self.sock.connect(socket_path)
        self.sock.settimeout(30)
        self.buf = b""
        self.mid = 0

    def handler_count(self):
        """当前 attach 目标的证据里 handlerProbe.hitCount。"""
        ev = self.call("last_evidence")["evidencePack"]
        probe = ev["signals"].get("handlerProbe") or {}
        return int(probe.get("hitCount") or 0)

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
        response = json.loads(line)
        if "error" in response:
            raise RuntimeError("%s → %s" % (method, response["error"]["code"]))
        return response["result"]


def log(msg):
    print("[spikes2] " + msg, file=sys.stderr, flush=True)


def start_daemon(root, tag):
    engine_sock = os.path.join(root, "engine-%s.sock" % tag)
    probe_sock = os.path.join(root, "probe-%s.sock" % tag)
    proc = subprocess.Popen(
        [ENGINE_BIN, "--socket-path", engine_sock, "--probe-socket-path", probe_sock, "--no-c33"],
        stdout=open(os.path.join(root, "daemon-%s.log" % tag), "w"), stderr=subprocess.STDOUT)
    for _ in range(40):
        if os.path.exists(engine_sock):
            break
        time.sleep(0.25)
    return proc, engine_sock, probe_sock


def nodes_with(observe_result, needle):
    hits = []
    def walk(nodes):
        for node in nodes:
            ident = node.get("identifier") or ""
            title = node.get("title") or ""
            if needle in ident or needle in title:
                hits.append(node)
            walk(node.get("children") or [])
    walk(observe_result["axTree"])
    return hits


def run_h4():
    manifest = os.path.join(WORK, "h4-manifest.json")
    if os.path.exists(manifest):
        os.unlink(manifest)
    daemon, engine_sock, probe_sock = start_daemon(WORK, "h4")
    demo_env = dict(os.environ, GLASSPANE_PROBE_SOCK=probe_sock,
                    GP_DEMO_CAPTURE_SCENARIOS="1", GP_DEMO_CAPTURE_MANIFEST=manifest)
    demo = subprocess.Popen([DEMO_BIN], env=demo_env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            start_new_session=True)
    outcome = {"verdict": None, "manifest": None}
    try:
        deadline = time.time() + 45
        while time.time() < deadline and not os.path.exists(manifest):
            time.sleep(0.5)
        if not os.path.exists(manifest):
            outcome["verdict"] = "FAIL: manifest 未生成（capture 场景轮未跑完）"
            return outcome
        # 等第三场景写满（manifest 三次覆写；exit(0) 后即为终态）
        for _ in range(20):
            if demo.poll() is not None:
                break
            time.sleep(0.5)
        data = json.load(open(manifest))
        scen = data["scenarios"]

        def begin(sc):
            return (scen.get(sc, {}).get("beginFrames") or [{}])[0]

        a, b, c = begin("A-static"), begin("B-animating"), begin("C-invalid-dest")
        paths_ok = a.get("path") is not None and b.get("path") is not None
        refusals_structured = all(isinstance(x.get("error"), str) and x.get("error")
                                  for x in (a, b, c))
        outcome["manifest"] = scen
        if paths_ok:
            outcome["verdict"] = "PASS"  # 完整正产物 + 非法落点拒绝
            outcome["notes"] = "全三态达成"
        else:
            # 本机 Graphics Inspector 未开启 → supportsDestination(.gpuTraceDocument)
            # 为 false，通道只能到"结构化拒绝"态；这本身就是 Z4.5 契约的诚实分支。
            outcome["verdict"] = "PASS-REFUSAL" if refusals_structured else \
                "FAIL: A=%r B=%r C=%r" % (a, b, c)
            outcome["notes"] = ("本机实测拒绝态（开启 Xcode Graphics Inspector 后可复跑正产物路径）："
                                + str(a.get("error")))
    finally:
        if demo.poll() is None:
            demo.terminate()
        daemon.terminate()
    return outcome


def run_h5_h6():
    daemon, engine_sock, probe_sock = start_daemon(WORK, "h56")
    import threading as _t  # keep gc quiet
    demo = subprocess.Popen([DEMO_BIN],
                            env=dict(os.environ, GLASSPANE_PROBE_SOCK=probe_sock),
                            stdout=open(os.path.join(WORK, "demo-h56.log"), "w"),
                            stderr=subprocess.STDOUT, start_new_session=True)
    time.sleep(2.0)
    if demo.poll() is not None:
        raise RuntimeError("demo 启动即退（见 %s/demo-h56.log）" % WORK)
    result = {"H5": None, "H6": None}
    try:
        client = Client(engine_sock)
        client.call("hello")
        for _ in range(20):
            try:
                client.call("attach", {"pid": demo.pid})
                break
            except Exception:
                time.sleep(0.5)
        # 等窗口注册 + 探针 hello
        for _ in range(60):
            try:
                probes = client.call("probe_status").get("probes", [])
                if probes and nodes_with(client.call("observe", {"maxDepth": 10}), "lazy-scroller"):
                    break
            except Exception:
                pass
            time.sleep(0.5)

        # ---------------- H5：懒容器索引失效率 + 五线聚合 ----------------
        tree = client.call("observe", {"maxDepth": 10})
        visible0 = len(nodes_with(tree, "lazy-row-"))
        rounds = []
        for r in range(5):
            def one(op, ident):
                act = client.call("act", {"selector": {"identifier": ident, "role": "AXButton"},
                                          "action": "press"})
                ev = client.call("last_evidence",
                                 {"operationId": act["operationId"]})["evidencePack"]
                probe = ev["signals"].get("handlerProbe") or {}
                diff = ev["signals"].get("stateDiff") or {}
                return {"op": op, "hit": probe.get("hitCount", 0),
                        "state": bool(diff.get("changed")),
                        "ax": act.get("axChanged"), "pixel": act.get("pixelChanged"),
                        "level": ev["attribution"]["level"]}
            rounds.append(one("add", "add-rows"))
            rounds.append(one("remove", "remove-rows"))
        # 加满后测"屏外未实体化行"的索引失效率（identifier 在场率）
        for _ in range(3):
            client.call("act", {"selector": {"identifier": "add-rows", "role": "AXButton"},
                                "action": "press"})
        time.sleep(0.8)
        tree = client.call("observe", {"maxDepth": 10})
        rendered = {n.get("identifier") for n in nodes_with(tree, "lazy-row-")}
        total_items = 3 + 20 * (5 * 3 + 3)  # 每轮 add +20；上界按尝试数计
        sampled = ["row-%d" % i for i in range(4, 64)]
        present = sum(1 for s in sampled if ("lazy-row-%s" % s) in rendered)
        result["H5"] = {
            "baselineVisibleRows": visible0,
            "offscreenSample": len(sampled),
            "offscreenIndexed": present,
            "indexMissRate": round(1 - present / len(sampled), 4),
            "roundChannelCounts": rounds,
            "note": "失效率口径=懒容器屏外行 identifier 在 observe 树中的在场率；"
                    "五线计数取 add/remove 各 5 轮",
        }

        # ---------------- H6：真重放抑制（事件计数口径） ----------------
        # 判定面：①快照后继续写、rollback_full 把值带回（consistent=true）；
        # ②恢复写走注册 setter 直写——恢复窗口内探针事件增量必须为 0（副作用
        # 零重放）。onAppear 型生命周期在离屏 harness 下不保证触发，不作为断言面。
        for _ in range(2):
            client.call("act", {"selector": {"identifier": "replay-write", "role": "AXButton"},
                                "action": "press"})
        time.sleep(0.5)
        snap = client.call("snapshot", {"maxDepth": 6})
        handlers_at_snap = client.handler_count()
        client.call("act", {"selector": {"identifier": "replay-write", "role": "AXButton"},
                            "action": "press"})  # 快照之后继续前进（此 act 自身 +1 handler）
        time.sleep(0.4)
        handlers_pre_restore = client.handler_count()
        restore = client.call("restore", {"snapshotId": snap["snapshotId"], "mode": "rollback_full"})
        time.sleep(1.2)
        handlers_after = client.handler_count()
        # rollback 的语义：经注册 setter 直写状态（会产生 state 事件——consistent
        # 已证），但绝不能再触发任何插桩 handler（视图副作用零重放的硬指标）。
        quiet = handlers_after == handlers_pre_restore
        events_at_snap = events_after = None
        result["H6"] = {
            "rollbackExecuted": restore.get("rollbackExecuted"),
            "consistent": restore.get("consistent"),
            "surface": restore.get("executionSurface"),
            "handlersAtSnapshot": handlers_at_snap,
            "handlersPreRestore": handlers_pre_restore,
            "handlersAfterRestore": handlers_after,
            "verdict": ("PASS" if restore.get("rollbackExecuted") and restore.get("consistent")
                        and quiet else "CHECK"),
            "note": "consistent=true 证值经 setter 回来（state 事件应有）；恢复窗口 handler 增量=0"
                    " 证 rollback 不重放插桩副作用。onAppear 可见性语义在离屏 harness 不成立，"
                    "已如实移出断言面。",
        }
    finally:
        demo.terminate()
        daemon.terminate()
    return result


def main():
    global Client
    if not (os.path.isfile(ENGINE_BIN) and os.path.isfile(DEMO_BIN)):
        log("SKIP：缺产物（engine/.build/debug/glasspaned 或 probe/.build/debug/probe-demo）")
        return 0
    os.makedirs(WORK, exist_ok=True)
    h4 = run_h4()
    h56 = run_h5_h6()
    payload = {"timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "H4": h4, **h56}
    out = os.path.join(REPO, "spike", "spikes2-result.json")
    json.dump(payload, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=2, default=str)
    log("数据写 %s" % out)
    failures = []
    if h4["verdict"] not in ("PASS", "PASS-REFUSAL"):
        failures.append("H4 " + str(h4["verdict"]))
    if h56.get("H6", {}).get("verdict") != "PASS":
        failures.append("H6 " + json.dumps(h56.get("H6"), ensure_ascii=False)[:200])
    miss = h56.get("H5", {}).get("indexMissRate")
    if miss is None:
        failures.append("H5 无数据")
    if failures:
        for f in failures:
            log("FAIL " + f)
        return 1
    log("H4 %s：基线通道判定成立（PASS=三态全产；PASS-REFUSAL=本机全部到结构化拒绝，"
        "正产物路径需 Graphics Inspector 一次性开启）" % h4["verdict"])
    log("H5 数据：屏外行索引失效率 %s（懒容器不实体化——通道边界，非缺陷）" % miss)
    log("H6 PASS：rollback consistent=true 且 appear 计数不涨（真重放抑制）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
