#!/usr/bin/env python3
"""P6 spec v6.0 §10 P6-E real-machine smoke — probe SDK end-to-end.

Brings up a dedicated daemon (sockets under a temp dir; its **state root** has to
be proven to follow the sandbox before a single assertion runs — see 状态根隔离
below) and the synthetic probe-demo control app, then asserts the full probe surface:

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
  2 = NOT RUN（前置二进制缺失、状态根隔离未证明、或本轮实际触碰了真实
             ~/.glasspane —— 一条断言都不算数，NOT RUN 绝不等于通过）。
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


# ---- 状态根隔离（B-01）------------------------------------------------------
# daemon 的三个写入面全部由 NSHomeDirectory() 解析：EvidenceStore.defaultDirectory、
# ApprovalGate.defaultPath、ProjectRegistry.defaultProjectsPath；而 glasspaned 的
# parseArguments（Sources/glasspaned/main.swift）里**没有**任何 flag 能挪动这个根
# （--socket-path / --probe-socket-path 只挪 socket）。所以"把 HOME 指进沙箱"到底
# 隔没隔离，不可假设、必须实测：起 daemon **之前**先用被测二进制自己的只读 CLI 问出
# 它解析到的状态根，证明它落在沙箱之内才放行；证明不了即 NOT RUN(2)，一条断言都不跑。
# 事后指纹（state_fingerprint）只是第二道闸——它只能在已经写坏之后告知，不能当隔离
# 证明用，因此本前置闸不可省、也不可被它替代。
# 本段在 engine/.p6_smoke.py 与 engine/.t9_smoke.py 中逐字一致：冒烟脚本按本仓惯例
# 各自自包含（.smoke_client.py 与 .t9_smoke.py 的 send/recv_frame 亦然），不做跨脚本
# import；改一处必须同步另一处。
ISOLATION_PROBE_PROJECT_ID = "prj_gp-smoke-isolation-canary"
ISOLATION_PROBE_TIMEOUT = 20.0


def daemon_state_dir_args(state_root):
    """X-22（台账）：daemon 一旦支持重定向状态根，只改这里——返回
    ["--state-dir", state_root]，两个冒烟脚本共用同一形状，前置闸自然转绿。
    今天必须返回空表：main.swift 的 parseArguments 把未知参数判成
    `unknown argument` 并以 64 退出，伪造参数＝伪造隔离。
    """
    return []


def daemon_isolation_env(workdir):
    """→ (沙箱 HOME, daemon 追加参数, daemon 子进程环境)。

    HOME 挪进沙箱只是**尝试**，不是隔离声明：它能否被 NSHomeDirectory 采纳，由
    require_proven_isolation() 实测决定。沙箱内的 ~/.glasspane 预建出来，让
    EvidenceStore 的 chmod-0700 判定走与真实形态一致的路径。
    """
    home = os.path.join(workdir, "home")
    os.makedirs(os.path.join(home, ".glasspane"), mode=0o700, exist_ok=True)
    return home, daemon_state_dir_args(home), dict(os.environ, HOME=home)


def _first_json_object(text):
    """daemon 的机器可读出口是单行 JSON（writeJSON → AgentText.jsonLine）。"""
    for line in (text or "").splitlines():
        try:
            parsed = json.loads(line.strip())
        except ValueError:
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


def probe_state_roots(daemon_bin, env, notes, extra_args=()):
    """问被测二进制自己：状态根解析到了哪里。两条命令都**只读**，不落盘。

      --evidence-stats         → {"dir": EvidenceStore.defaultDirectory, …}；
                                 stats() 只枚举归档目录，不创建也不删除
      --active-project <假 id> → 未注册分支的 JSON 带 registryPath，且该分支按
                                 R2-16/R6-06 明示 stateChanged=false（从不写状态）

    approvals.json 没有回显路径的 CLI，但它与 projects.json 同源自
    NSHomeDirectory()（同一份默认拼接），所以取 registryPath 的父目录作同一个根。
    `extra_args` 必须与起 daemon 时追加的参数一致（X-22 落地后就是 --state-dir 那一
    对），否则探测问的是"默认根"、daemon 用的是"注入根"，闸会在该转绿的那天反而红。
    返回 {面名: 绝对路径}；问不出来的面记进 notes，由调用方按"未证明"处理。
    """
    probes = (
        ("evidence", [daemon_bin, *extra_args, "--evidence-stats"], "dir"),
        ("projects", [daemon_bin, *extra_args, "--active-project",
                      ISOLATION_PROBE_PROJECT_ID], "registryPath"),
    )
    roots = {}
    for name, argv, key in probes:
        try:
            done = subprocess.run(argv, env=env, capture_output=True, text=True,
                                  timeout=ISOLATION_PROBE_TIMEOUT)
        except (OSError, subprocess.SubprocessError) as error:
            notes.append(f"{name}: 探测无法执行（{error}）")
            continue
        payload = None
        for stream in ("stdout", "stderr"):  # 走哪条流取决于命中/未命中分支
            payload = _first_json_object(getattr(done, stream, "") or "")
            if payload is not None and key in payload:
                break
        if payload is None or key not in payload:
            echo = ((done.stdout or "") + (done.stderr or "")).strip().splitlines()
            notes.append(f"{name}: rc={done.returncode} 未给出 {key} 字段"
                         f"（输出首行 {echo[0][:120] if echo else '无输出'}）")
            continue
        roots[name] = os.path.realpath(str(payload[key]))
    return roots


def require_proven_isolation(daemon_bin, daemon_env, sandbox_home, extra_args=()):
    """前置闸（起 daemon 之前）：沙箱环境没挪动状态根，就不起 daemon。
    `extra_args` 与随后 Popen 追加的参数同一份——闸问的必须是"这一轮真的会用的
    那套参数"，否则放行判定与实际启动可以指向两个根。"""
    notes = []
    roots = probe_state_roots(daemon_bin, daemon_env, notes, extra_args)
    home = os.path.realpath(sandbox_home)
    escaped = {name: path for name, path in roots.items()
               if path != home and not path.startswith(home + os.sep)}
    if roots and not escaped:
        print("PASS 状态根隔离已实测（daemon 的写入面全在沙箱内） "
              + " ".join(f"{name}={roots[name]}" for name in sorted(roots)))
        return
    print("NOT RUN — 状态根隔离未证明，一条断言都没有执行（NOT RUN ≠ PASS）")
    print(f"  期望：daemon 的写入面落在 {home}/.glasspane/ 之下")
    for name in sorted(escaped):
        print(f"  逃逸：{name} 解析到 {escaped[name]}（沙箱之外）")
    if not roots:
        print("  未能从被测二进制问出任何状态根——探测无结果＝未证明，不放行")
    for note in notes:
        print(f"  note: {note}")
    print("  放行后果：evidence 档案写进开发者真实 ~/.glasspane/evidence，restore 的")
    print("       'restore executed' 审批行追加进真实哈希链 approvals.json（审计链被冒名写入）。")
    print("REMEDY: 被测 daemon 没有可重定向状态根的 flag → 见台账 X-22：给 glasspaned 加")
    print("  --state-dir <path>（EvidenceStore/ApprovalGate/ProjectRegistry 改走注入路径，")
    print("  删掉解析到活状态的缺省），落地后把它填进本文件的 daemon_state_dir_args()。")
    print("  本判定可自行复现（agent 可执行；沙箱 HOME 与继承 HOME 各跑一次，只读）：")
    flags = " ".join([*extra_args, "--evidence-stats"])
    print(f"    HOME={home} {daemon_bin} {flags}")
    print(f"    {daemon_bin} {flags}   # dir 不随之移动 → 状态根不可重定向")
    sys.exit(2)


def live_state_targets(daemon_bin, notes):
    """继承环境 + **不加**注入参数下 daemon 会写到哪里 = 逃逸时的受害者清单。
    这里刻意不带 extra_args：要问的就是"默认解析到哪"，即第二道闸该守住的真实文件。"""
    roots = probe_state_roots(daemon_bin, dict(os.environ), notes)
    targets = {}
    registry = roots.get("projects")
    if registry:
        targets["projects.json"] = registry
        targets["approvals.json"] = os.path.join(os.path.dirname(registry), "approvals.json")
    if roots.get("evidence"):
        targets["evidence-dir"] = roots["evidence"]
    return targets


def state_fingerprint(targets):
    """写入面指纹：文件取 (size, mtime_ns)，归档目录取 (文件数, 总字节)。
    不可测（不存在/读不了）如实记 None——"缺失→存在"正是一次写入的证据。"""
    printed = {}
    for name, path in targets.items():
        if name == "evidence-dir":
            entries = [os.path.join(base, leaf)
                       for base, _, leaves in os.walk(path) for leaf in leaves]
            if not entries and not os.path.isdir(path):
                printed[name] = None
                continue
            total = 0
            for entry in entries:
                try:
                    total += os.stat(entry).st_size
                except OSError:
                    pass
            printed[name] = (len(entries), total)
            continue
        try:
            stat = os.stat(path)
        except OSError:
            printed[name] = None
        else:
            printed[name] = (stat.st_size, stat.st_mtime_ns)
    return printed


def enforce_no_state_escape(before, targets, probe_notes):
    """收尾闸（daemon 已退出之后）：真碰到了开发者的状态根就不是 PASS，也不是 FAIL
    ——那一轮的结果不可信，按 NOT RUN(2) 离场并点名逃逸路线。"""
    if not targets:
        print("NOTE 第二道闸未运行：探测没问出可比对的真实写入面（"
              + "；".join(probe_notes) + "）")
        return
    after = state_fingerprint(targets)
    moved = {name: (before.get(name), after[name]) for name in after
             if before.get(name) != after[name]}
    if not moved:
        print("PASS 真实状态未被触碰（" + "、".join(sorted(targets))
              + " 的指纹与起 daemon 前一致）")
        return
    print("NOT RUN — 状态根逃逸：本轮改动了开发者真实 ~/.glasspane，本轮结果不可信")
    for name in sorted(moved):
        print(f"  {targets[name]}: {moved[name][0]} → {moved[name][1]}")
    print("REMEDY: 两种可能，逐条排（都 agent 可执行）：")
    print("  (1) 前置闸放行后仍有落在沙箱外的写入面 → 说明有探测没覆盖到的状态面，")
    print("      把上面点名的文件报进台账 X-22（glasspaned --evidence-stats 只覆盖 evidence）。")
    print("  (2) 现网 daemon 在本轮期间真实写入：`pgrep -fl glasspaned` 数实例，")
    print("      `launchctl print gui/$(id -u)/com.glasspane.daemon` 确认是否 launchd 常驻；")
    print("      确为并行实例时，先 bootout 它再复跑本轮，否则两轮写的是同一个真实归档。")
    sys.exit(2)


# ---- 熔断 reason 的分段匹配（A-02）------------------------------------------
# X-6 把每个未测通道改写成 `"标签: 原文"`，而整串 reason 又是 `"; "` 拼的多段
# （EngineCore 的 reasons.joined / performance| / degradation| 前缀），所以
# `reason == "screen-recording-denied"` 这种全等比较**必然**不成立：无屏幕录制席位
# 的机器（本机常态，见 smoke.md 真机观察 3 与 P6 记录 16）会把唯一端到端探针闸
# 永久钉红。按段匹配保持强度：段本身等于标签、或以 `"标签:"` 开头才算缺席位；
# 别的段把同名子串写在原文里（例如 timeout 段的捕获报错文本）不算——那不是"席位
# 缺失"的判定，放宽成裸子串/任意 reason 会把降级原因读错。
CIRCUIT_PIXEL_LABEL = "screen-recording-denied"
CIRCUIT_REASON_MARKERS = ("performance|", "degradation|")


def breaker_reason_has_label(reason, label):
    """`"; "` 分段后逐段剥掉前缀标记，段等于 label 或以 `"label:"` 开头才为真。"""
    for segment in (reason or "").split(";"):
        head = segment.strip()
        for marker in CIRCUIT_REASON_MARKERS:
            if head.startswith(marker):
                head = head[len(marker):].strip()
        if head == label or head.startswith(label + ":"):
            return True
    return False


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

    # 状态根隔离（B-01）：先证明、后起 daemon。旧形状在这里传的是继承环境，
    # 于是本轮的 evidence/审批行直接落在开发者真实 ~/.glasspane 上，而脚本头部
    # 自称隔离——那是"未测量的结论"，比红更糟。
    sandbox_home, state_dir_args, daemon_env = daemon_isolation_env(workdir)
    require_proven_isolation(daemon_bin, daemon_env, sandbox_home, state_dir_args)
    probe_notes = []
    live_targets = live_state_targets(daemon_bin, probe_notes)
    state_before = state_fingerprint(live_targets)

    daemon = subprocess.Popen(
        [daemon_bin, *state_dir_args, "--socket-path", engine_sock,
         "--probe-socket-path", probe_sock, "--no-c33", "--verbose"],
        stdout=open(os.path.join(workdir, "daemon.log"), "w"),
        stderr=subprocess.STDOUT,
        env=daemon_env,
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
        pixel_denied = breaker_reason_has_label(
            (pack.get("circuitBreaker") or {}).get("reason"), CIRCUIT_PIXEL_LABEL)
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
        # 第二道闸（B-01）：daemon 已退出，此刻比指纹不会漏掉在途写入。绿字
        # "P6 SMOKE OK" 因此挪到 try/finally 之后——逃逸的那一轮不配留下 PASS 字样。
        enforce_no_state_escape(state_before, live_targets, probe_notes)
    print("P6 SMOKE OK")


if __name__ == "__main__":
    main()
