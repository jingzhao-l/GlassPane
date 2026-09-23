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
    自起 daemon 模式（默认）：在临时目录起专用 daemon——临时 --socket-path/
    --probe-socket-path 一对 + --no-c33（T9 采样走 proc_pidinfo，关输入监听免
    操作员键鼠把 act 打成 busy；镜像 .p6_smoke.py 的 daemon 启动参数）。
    状态根隔离（B-01）：本脚本**尝试**把 HOME 挪进临时目录，但不再声称它是
    "唯一 agent-可执行的隔离通道"——那是未经测量的断言。daemon 的
    EvidenceStore/ApprovalGate/ProjectRegistry 都按 NSHomeDirectory() 解析路径，
    而 glasspaned 的 parseArguments 没有任何能重定向该根的 flag，HOME 是否被
    采纳只能实测：起 daemon 前用被测二进制自己的只读 CLI（--evidence-stats 的
    dir、--active-project 的 registryPath）问出状态根，落在沙箱内才放行，否则
    NOT RUN exit 2 并点名台账 X-22（daemon 侧 --state-dir）。放行者是测量，
    不是环境变量名。
    不给 --daemon-bin 时按 GLASSPANE_DAEMON_BIN → 仓库相对
    .build/{debug,release}/glasspaned 定位；都不可得 → NOT RUN exit 2。
    绝不隐式回落到 ~/.glasspane/engine.sock 现网口。
  python3 .t9_smoke.py <socket> [max-acts] [delay-s]
    旧契约：仅当显式传入 socket 才连接调用方已有的 daemon。该 daemon 的
    evidence/审批行写在它自己的状态根上（本脚本无从隔离），契约保留、如实留 NOTE。
  退出码：0 = PASS，1 = FAIL，2 = NOT RUN（一条断言都没跑，或本轮实际触碰了
    真实 ~/.glasspane 因而结果不可信——两种都 ≠ 通过）。
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
    显式 socket（连调用方已有的 daemon）。显式 --daemon-bin 时进入自起
    daemon 模式（状态根是否真被隔离由 require_proven_isolation() 实测决定，
    不由模式名宣称），位置参数读作 [max-acts] [delay-s]。env
    GLASSPANE_DAEMON_BIN 为可选补充，不改变位置语义。
    """
    socket_path = None
    daemon_bin = os.environ.get("GLASSPANE_DAEMON_BIN")
    self_spawned = "--daemon-bin" in argv or any(a.startswith("--daemon-bin=") for a in argv)
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
    if positional and not self_spawned:
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
    live_targets = {}
    state_before = {}
    probe_notes = []
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        if socket_path is None:
            # 自起 daemon：不起现网连接，自己拉起临时 daemon（镜像 .p6_smoke.py 的
            # 启动段）。socket 只接受调用方显式传入，绝不默认 ~/.glasspane。
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
            # 状态根隔离（B-01）：先证明 HOME 真的挪动了 daemon 的写入面，才起 daemon。
            # 证明不了 → NOT RUN(2)（本脚本 24 轮 act + T9 判定会把档案写进真实归档）。
            sandbox_home, state_dir_args, daemon_env = daemon_isolation_env(workdir)
            require_proven_isolation(daemon_bin, daemon_env, sandbox_home, state_dir_args)
            live_targets = live_state_targets(daemon_bin, probe_notes)
            state_before = state_fingerprint(live_targets)
            socket_path = os.path.join(workdir, "engine.sock")
            daemon = subprocess.Popen(
                [daemon_bin, *state_dir_args, "--socket-path", socket_path,
                 "--probe-socket-path", os.path.join(workdir, "probe.sock"),
                 "--no-c33", "--verbose"],
                stdout=open(os.path.join(workdir, "daemon.log"), "w"),
                stderr=subprocess.STDOUT,
                env=daemon_env)
        else:
            print(f"NOTE 显式 socket 模式：连的是调用方已有的 daemon（{socket_path}），"
                  "它的 evidence/审批行落在它自己的状态根上，本脚本无从隔离；"
                  "状态根指纹闸只在本脚本自起 daemon 时生效。")
        # 连接重试：自起 daemon 需要时间 bind（.p6_smoke.py 同口径 15s）；
        # 显式 socket 保留旧的快速失败。
        deadline = time.time() + (15 if daemon is not None else 5)
        while True:
            if daemon is not None and daemon.poll() is not None:
                fail(f"自起 daemon 启动即退出（rc={daemon.returncode}，见 {workdir}/daemon.log）")
            try:
                sock.connect(socket_path)
                break
            except OSError as error:
                if time.time() >= deadline:
                    if daemon is not None:
                        fail(f"daemon 未在 15s 内监听 {socket_path}（见 {workdir}/daemon.log）")
                    fail(f"连接 daemon socket {socket_path} 失败：{error}"
                         "（默认请让本脚本自起 daemon：--daemon-bin <glasspaned>；"
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
            # 自起 daemon 模式留档（daemon.log + 沙箱 HOME 下的 evidence/approvals），
            # 与 .p6_smoke.py 同口径；显式 socket 模式维持旧的即时清理。
            print(f"NOTE 工作目录：{workdir}（daemon.log/home/.glasspane 留档）")
            # 第二道闸（B-01）：daemon 已退出，此刻比指纹不会漏掉在途写入；
            # 逃逸的一轮不得留下 "T9 SMOKE OK"。
            enforce_no_state_escape(state_before, live_targets, probe_notes)
        else:
            shutil_rmtree(workdir)

    print("T9 SMOKE OK")


def shutil_rmtree(workdir):
    import shutil

    shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    main()