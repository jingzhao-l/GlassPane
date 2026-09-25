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
    状态根隔离（B-01 + X-22）：daemon 以 `--state-dir <临时目录>/home/.glasspane`
    启动，但**不因传了就宣称隔离**——NSHomeDirectory 不读 $HOME（本项目已因此把开发者
    真实 projects.json 从 71 条写成 2 条），所以 HOME 沙箱本身挪不动任何写入面。起
    daemon 前用被测二进制自己的只读 CLI（带同一套 --state-dir 参数：--evidence-stats
    的 dir、--active-project 的 registryPath）问出它解析到的状态根，realpath 后必须落
    在那个根内且不等于真实 ~/.glasspane，并要求未知参数仍以 64 被拒；证明不了即 NOT
    RUN exit 2。放行者是测量，不是参数名，也不是环境变量名。
    不给 --daemon-bin 时按 GLASSPANE_DAEMON_BIN → 仓库相对
    .build/{debug,release}/glasspaned 定位；都不可得 → NOT RUN exit 2。
    绝不隐式回落到 ~/.glasspane/engine.sock 现网口。
  python3 .t9_smoke.py <socket> [max-acts] [delay-s]
    旧契约：仅当显式传入 socket 才连接调用方已有的 daemon。该 daemon 的
    evidence/审批行写在它自己的状态根上（本脚本无从隔离），契约保留、如实留 NOTE。
  退出码：0 = PASS，1 = FAIL，2 = NOT RUN（一条断言都没跑，或本轮实际触碰了
    真实 ~/.glasspane 因而结果不可信——两种都 ≠ 通过）。
"""
import hashlib
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
    private var button: NSButton!
    private var slabs: [[UInt8]] = []
    private var leakedFds: [Int32] = []
    private var clicks = 0

    /// Where this process records what it actually did, one line per click.
    ///
    /// The harness used to print "内存 8MB/次 + fd 1/次" from the constants in
    /// this source file — a claim about the injection recited from the code that
    /// was supposed to perform it, which is how a T9 gate that never triggered
    /// got diagnosed as a detector bug for as long as it took someone to measure
    /// the process instead of reading the script. Now the canary reports its own
    /// resident size and fd count per click, and the assertions talk about those
    /// numbers or they do not run.
    private let metricsPath = ProcessInfo.processInfo.environment["CANARY_METRICS_FILE"]

    private func reportMetrics() {
        guard let metricsPath else { return }
        var usage = rusage()
        let rssKb: Int
        if getrusage(RUSAGE_SELF, &usage) == 0 {
            rssKb = Int(usage.ru_maxrss / 1024)   // bytes on Darwin
        } else {
            rssKb = -1
        }
        let line = "clicks=\(clicks) rss_kb=\(rssKb) fds_opened=\(leakedFds.count)\n"
        if let handle = FileHandle(forWritingAtPath: metricsPath) {
            handle.seekToEndOfFile()
            handle.write(Data(line.utf8))
            handle.closeFile()
        } else {
            try? Data(line.utf8).write(to: URL(fileURLWithPath: metricsPath))
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        print("CANARY_PID=\(ProcessInfo.processInfo.processIdentifier)")
        fflush(stdout)
        let rect = NSRect(x: 120, y: 120, width: 360, height: 220)
        window = NSWindow(contentRect: rect, styleMask: [.titled, .closable],
                          backing: .buffered, defer: false)
        window.title = "Leak Canary"
        button = NSButton(title: "leak", target: self, action: #selector(leakOne(_:)))
        // The selector binds to this identifier, not to the title: the title is
        // the witness that a press actually ran, and a selector keyed to it would
        // stop matching the moment the witness updated (measured that way).
        button.setAccessibilityIdentifier("leak-button")
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
        // The title is the independent witness: `observe`/`assert_element` can
        // see `leak#N` without trusting anything this process says about itself,
        // and "actConfirmed" only ever meant AXPress returned success — AppKit
        // accepts a press against a window it never shows and the handler never
        // runs. That gap is what made 24 rounds of "confirmed" acts measure zero.
        button?.title = "leak#\(clicks)"
        reportMetrics()
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


# ---- 状态根隔离（B-01 + X-22）------------------------------------------------
# daemon 的三个写入面（evidence 档案、projects.json、approvals.json）从**一个**状态根
# 派生：--state-dir 给的就是那个目录本身（Swift 侧的 StateRoot，
# Sources/GlassPaneEngine/StateRoot.swift），没给才落回 NSHomeDirectory() 下的 per-user
# 目录。"落回"那一条是硬事实而不是推测：macOS 的 NSHomeDirectory **不读 $HOME**，所以
# 把 HOME 指进沙箱挪不动任何写入面——本项目已因此把开发者真实的 projects.json 从 71 条
# 改成 2 条（不可恢复）。于是本闸仍然是**证明式**的，只是证明的东西变了：起 daemon
# **之前**先用被测二进制自己的只读 CLI（带着本脚本要传给 daemon 的那套 --state-dir）问出
# 它解析到的状态根，实测它确实落在本脚本预建的沙箱状态根内、且不等于真实 ~/.glasspane；
# 问不到、落在沙箱外、或它根本没听 --state-dir，一律 NOT RUN(2)，一条断言都不跑。
# "传了参数"永远不等于"已隔离"——只有被测二进制自己的回显才算测量。
# 事后指纹（state_fingerprint）仍只是第二道闸——它只能在已经写坏之后告知，不能当隔离证明
# 用，因此本前置闸不可省、也不可被它替代。
# 本段在 engine/.p6_smoke.py 与 engine/.t9_smoke.py 中逐字一致：冒烟脚本按本仓惯例
# 各自自包含（.smoke_client.py 与 .t9_smoke.py 的 send/recv_frame 亦然），不做跨脚本
# import；改一处必须同步另一处。
LEAK_MB_PER_CLICK = 8      # 与 CANARY_SOURCE 的 LEAK_BYTES 同值，只用于失败信息
ISOLATION_PROBE_PROJECT_ID = "prj_gp-smoke-isolation-canary"
ISOLATION_PROBE_TIMEOUT = 20.0
# 两个都必须问得到才算数：evidence 靠 --evidence-stats 的 dir，projects 靠
# --active-project 未命中分支的 registryPath（approvals.json 与 projects.json 同源于
# 同一个状态根，取后者的父目录）。
STATE_FACES = ("evidence", "projects")
# 一个本脚本确定不认识的参数，用来**实测**"未知参数仍然被拒"。注入参数的意义建立在这个
# 前提上：一个静默吞掉未知 flag 的 CLI，可以在同样吞掉 --state-dir 的时候让路径回显
# 看着像成功了。
UNKNOWN_FLAG_CANARY = "--state-dir-canary-not-a-flag"


def daemon_state_dir_args(state_root):
    """X-22 已落地：daemon 的状态根由 --state-dir 显式命名，两个冒烟脚本共用这一形状。

    取值就是今天 NSHomeDirectory() + "/.glasspane" 所代表的那个目录本身，**不是**它的
    父目录——evidence/、projects.json、approvals.json、probe.sock 都从这个目录派生。
    非法取值（缺值、以 -- 开头、相对路径）由 daemon 判成用法错误、以 64 退出；其余未知
    参数同样以 64 退出，而那一条不是假设，是 require_proven_isolation() 用
    UNKNOWN_FLAG_CANARY 实测的（伪造参数＝伪造隔离，所以拒绝未知参数这件事本身必须在
    放行之前被测量到）。
    """
    return ["--state-dir", state_root]


def sandbox_state_root(sandbox_home):
    """本脚本自己的沙箱状态根：预建在 `<沙箱 HOME>/.glasspane`。

    与 daemon_isolation_env() 预建的那个目录同源，也就是 --state-dir 的取值本身——
    两处各自拼一次就是"注入的路径"与"证明的路径"可以不是同一条的路子。
    """
    return os.path.join(sandbox_home, ".glasspane")


def real_user_state_root():
    """开发者真实的 per-user 状态根（本脚本自己进程的环境，HOME 从未挪过）。

    判据用它，而不是用"沙箱之外"这个模糊说法：daemon 没听 --state-dir 时解析到的正是
    这里，那才是本轮会毁掉的东西。
    """
    return os.path.realpath(os.path.join(os.path.expanduser("~"), ".glasspane"))


def path_inside(candidate, parent):
    """realpath 后的 `candidate` 是否就是 `parent` 或在它之下（按路径分量，不按字面）。"""
    return candidate == parent or candidate.startswith(parent + os.sep)


def daemon_isolation_env(workdir):
    """→ (沙箱状态根, daemon 追加参数, daemon 子进程环境)。

    HOME 挪进沙箱是**顺带**，不是隔离通道：NSHomeDirectory 不采纳它，真正挪动写入面的
    是 --state-dir。沙箱内的 .glasspane 以 0700 预建，让 EvidenceStore 的 chmod-0700
    判定与真实形态走同一条路径。返回值第一项就是 --state-dir 的取值本身，前置闸证明的
    也是它，两者同源（见 sandbox_state_root）。
    """
    home = os.path.join(workdir, "home")
    root = sandbox_state_root(home)
    os.makedirs(root, mode=0o700, exist_ok=True)
    return root, daemon_state_dir_args(root), dict(os.environ, HOME=home)


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

      --evidence-stats         → {"dir": 本次状态根下的 evidence 归档目录, …}；
                                 stats() 只枚举归档目录，不创建也不删除
      --active-project <假 id> → 未注册分支的 JSON 带 registryPath，且该分支按
                                 R2-16/R6-06 明示 stateChanged=false（从不写状态）

    approvals.json 没有回显路径的 CLI，但它与 projects.json 派生自**同一个**状态根
    （--state-dir 给的那个，或没给时的 home 默认），所以取 registryPath 的父目录作同
    一个根。`extra_args` 必须与起 daemon 时追加的参数一致（就是 --state-dir 那一对，
    require_proven_isolation() 会先把这一致性结构上核对一遍），否则探测问的是"默认根"、
    daemon 用的是"注入根"，闸会在该转绿的那天反而红。
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


def require_proven_isolation(daemon_bin, daemon_env, state_root, extra_args=()):
    """前置闸（起 daemon 之前）：**实测** --state-dir 把状态根挪进了沙箱，才起 daemon。

    四条判据，结论只来自被测二进制自己的回显与退出码，不来自"参数传了没有"：
      1. 参数一致性（结构）：`extra_args` 必须正是 `daemon_state_dir_args(state_root)`。
         闸问的那套参数与随后 Popen 追加的那套必须是同一份，否则放行判定与实际启动可以
         指向两个根。
      2. 未知参数仍被拒（实测）：带 UNKNOWN_FLAG_CANARY 的那次调用必须以 64 退出。CLI
         若静默吞掉未知 flag，"回显落在沙箱里"就可能是它连 --state-dir 一起吞掉的结果。
      3. 两个写入面都问得到：evidence 的 `dir` 与 projects 的 `registryPath`（缺一即
         未证明——只问得到一条不等于另一条也没逃）。
      4. realpath 后每个面都落在 `--state-dir` 那个根之内，且没有一个落在真实
         ~/.glasspane 之内或之下。"在沙箱外"这种模糊说法不作判据，真实根才是要守的东西。
      5. 同一套参数、HOME 换回**真实值**再问一次，结论必须仍然是那个沙箱根。只有"路径跟
         着 --state-dir 走、不跟着 HOME 走"才叫注入生效；少了这一条，一个忽略 --state-dir
         却采纳 HOME 的 daemon 也能交出"落在沙箱里"的回显，而那正是"传了参数就当已隔离"。
    任何一条不成立 → NOT RUN(2)，一条断言都不跑。
    """
    expected = os.path.realpath(state_root)
    live_root = real_user_state_root()
    notes = []

    def not_run(reason_lines):
        print("NOT RUN — 状态根隔离未证明，一条断言都没有执行（NOT RUN ≠ PASS）")
        print(f"  --state-dir 的取值：{state_root}（realpath {expected}）")
        print(f"  真实 per-user 状态根：{live_root}")
        for line in reason_lines:
            print(line)
        print("  放行后果：evidence 档案写进开发者真实 ~/.glasspane/evidence，restore 的")
        print("       'restore executed' 审批行追加进真实哈希链 approvals.json（审计链被冒名写入），")
        print("       注册表被整表重写——71 条变 2 条那次就是这么丢的。")
        print("REMEDY: daemon 已经有 --state-dir（X-22 已落地），走到这里说明本轮没把它用上：")
        print("  (1) 被测二进制是旧构建 → cd engine && swift build 后复跑（本脚本按")
        print("      .build/{debug,release}/glasspaned 定位，或 GLASSPANE_DAEMON_BIN 指定）；")
        print("  (2) daemon 侧的解析链断了 → 逐条自己复现（都只读，agent 可执行）：")
        flags = " ".join([*extra_args, "--evidence-stats"])
        print(f"      HOME={daemon_env.get('HOME')} {daemon_bin} {flags}")
        print("        → dir 必须在 --state-dir 那个根内（判据 3/4）")
        print(f"      HOME={os.path.expanduser('~')} {daemon_bin} {flags}")
        print("        → dir 必须**仍然**在那个根内：跟着 HOME 走就是假注入（判据 5）")
        print(f"      {daemon_bin} --evidence-stats")
        print("        → 这一问报出的就是没传参数时的回落形状，也是第二道闸要守的真实文件")
        print("      第一条或第二条落在沙箱外 → --state-dir 没贯穿到那个写入面，"
              "报进台账并点名是哪个面。")
        sys.exit(2)

    # 判据 1：闸与 daemon 用的是同一套参数。
    if list(extra_args) != daemon_state_dir_args(state_root):
        not_run([
            "  结构不符：本轮追加的参数不是 daemon_state_dir_args(state_root) 的那一份。",
            f"      实际：{list(extra_args)}",
            f"      应为：{daemon_state_dir_args(state_root)}",
        ])
    if not os.path.isdir(expected):
        not_run(["  沙箱状态根本不存在（预建失败？）：daemon 不会在里面留下任何东西。"])
    if path_inside(expected, live_root):
        not_run(["  沙箱状态根本就在真实 ~/.glasspane 之内：本轮无从证明不逃逸。"])

    # 判据 2：未知参数仍以 64 被拒（保留对其它未知参数的拒绝，才谈得上"这一对参数被吃了"）。
    try:
        canary = subprocess.run(
            [daemon_bin, *extra_args, UNKNOWN_FLAG_CANARY, "--evidence-stats"],
            env=daemon_env, capture_output=True, text=True,
            timeout=ISOLATION_PROBE_TIMEOUT)
    except (OSError, subprocess.SubprocessError) as error:
        not_run([f"  canary 调用无法执行（{error}）：未知参数的拒绝没测到，不放行。"])
    if canary.returncode != 64:
        not_run([
            f"  被测 daemon 静默接受了未知参数 {UNKNOWN_FLAG_CANARY}"
            f"（rc={canary.returncode}，应为 64＝用法错误）。",
            "  那样的 CLI 同样可以在吞掉 --state-dir 的同时把回显指向别处，隔离不可信。",
        ])

    # 判据 3 + 4：向被测二进制自己问它这一轮真的会用的那套参数解析到了哪里。
    roots = probe_state_roots(daemon_bin, daemon_env, notes, extra_args)
    # 判据 5：同一套参数、HOME 换回真实值。这一步把"参数带着走"与"HOME 带着走"分开：
    # 一个忽略 --state-dir 却采纳 HOME 的 CLI 在这一问里会报出真实 per-user 根。
    home_notes = []
    against_home = probe_state_roots(daemon_bin, dict(os.environ), home_notes, extra_args)
    missing = [face for face in STATE_FACES if face not in roots]
    escaped = {name: path for name, path in roots.items() if not path_inside(path, expected)}
    colliding = {name: path for name, path in roots.items() if path_inside(path, live_root)}
    home_missing = [face for face in STATE_FACES if face not in against_home]
    home_escaped = {name: path for name, path in against_home.items()
                    if not path_inside(path, expected)}
    if (roots and against_home and not missing and not home_missing
            and not escaped and not colliding and not home_escaped):
        print("PASS 状态根隔离已实测（daemon 自报的写入面全在 --state-dir 那个根内，"
              "且换回真实 HOME 也照样跟着那个参数） "
              + " ".join(f"{name}={roots[name]}" for name in sorted(roots)))
        # 对照测量：同一沙箱环境、**不带**注入参数再问一次。它报出的就是本轮若不传参数会
        # 写去哪（第二道闸的受害者清单同源）。报出真实 per-user 根 = NSHomeDirectory 不读
        # HOME，与本闸的前提一致。
        control_notes = []
        control = probe_state_roots(daemon_bin, daemon_env, control_notes)
        if not control:
            print("NOTE 对照测量（不带 --state-dir）没问出任何状态根，未量到本轮的回落形状："
                  + "；".join(control_notes))
        elif all(path_inside(path, expected) for path in control.values()):
            print("NOTE 不带 --state-dir 的回显同样落在沙箱内 → 这份二进制的 home 解析采纳了"
                  "HOME 环境变量（真机不该如此）：判据 5 已把注入与 HOME 分开量过，但这一条值得"
                  "单独查 daemon 侧的 home 口径。")
        return
    reasons = []
    for face in missing:
        reasons.append(f"  问不到 {face} 面的状态根（两个面都要问得到才算证明）")
    for face in home_missing:
        reasons.append(f"  带 --state-dir、HOME 换回真实值后问不到 {face} 面（注入未贯穿）")
    for name in sorted(escaped):
        reasons.append(f"  逃逸：{name} 解析到 {escaped[name]}（--state-dir 那个根之外）")
    for name in sorted(colliding):
        reasons.append(f"  撞车：{name} 解析到 {colliding[name]}（真实 per-user 状态根之内）"
                       " → --state-dir 没有作用到这个面上")
    for name in sorted(home_escaped):
        reasons.append(f"  假注入：真实 HOME 下 {name} 解析到 {home_escaped[name]}"
                       " —— 回显跟着 HOME 走而不是跟着 --state-dir 走，"
                       "不能断定这个参数被采纳了")
    if not roots:
        reasons.append("  未能从被测二进制问出任何状态根——探测无结果＝未证明，不放行")
    reasons.extend(f"  note: {note}" for note in notes + home_notes)
    not_run(reasons)


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
    if tree.get("role") == "AXButton" and tree.get("identifier") == "leak-button":
        return {"role": "AXButton", "identifier": "leak-button"}
    for child in tree.get("children", []) or []:
        found = find_leak_button(child, depth + 1)
        if found:
            return found
    return None


def _newest_source_mtime(source_root):
    """`source_root` 下最新源文件的 mtime（跳过 .build 与点目录）。0.0 = 目录不存在/无源文件。"""
    newest = 0.0
    for dirpath, dirnames, filenames in os.walk(source_root):
        dirnames[:] = [d for d in dirnames if d != ".build" and not d.startswith(".")]
        for name in filenames:
            if name.endswith((".swift", ".c", ".h", ".m", ".py", ".ts", ".js")):
                try:
                    newest = max(newest, os.path.getmtime(os.path.join(dirpath, name)))
                except OSError:
                    continue
    return newest


def require_current_build(pairs):
    """实测"本轮被测的产物不早于它所声称构建自的源码"，并留下可回溯的指纹。

    R4-02。此前两条端到端闸只检查产物**存在**，不检查它是**当前构建**：实测过一次
    demo 停在旧能力集（hello 报 caps=['z1']，缺 z3/checkpoint），于是整轮"绿"测的是旧 SDK。
    判据是产物的指纹与时间戳，不是"我刚刚 build 过"这句话——命令说过什么不等于发生了什么。
    返回 (指纹行, 不成立的原因)。原因非空由调用方 NOT RUN(2)：过期产物跑出来的结论不能用。
    """
    lines, problems = [], []
    for role, binary, source_root in pairs:
        try:
            with open(binary, "rb") as handle:
                digest = hashlib.sha256(handle.read()).hexdigest()[:12]
        except OSError as error:
            problems.append(f"{role}: 产物读不出（{error}）——身份无法确认，不放行")
            continue
        built = os.path.getmtime(binary)
        newest_src = _newest_source_mtime(source_root)
        when = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(built))
        lines.append(f"{role} sha256:{digest} mtime={when}")
        if not newest_src:
            problems.append(
                f"{role}: 源码树 {source_root} 走不出任何源文件——无法判断产物是否当前，不放行"
            )
            continue
        if built + 1.0 < newest_src:
            problems.append(
                f"{role} 比它所声称的源码树旧：{binary} 构建于 {when}，而 {source_root} 下最新源文件是 "
                + time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(newest_src))
                + " —— 本轮会测到旧构建，改动不参与测量"
            )
    return lines, problems


def reject_foreign_checkout(candidates, here, other_roots=("/Volumes/Eng-Dev/GlassPane",)):
    """把"另一个工作副本里的构建产物"从**兜底**候选里剔掉（显式 argv/env 给定不受影响）。

    同一台机器常并存多个 checkout。本脚本跑在 worktree 里，若兜底到
    `/Volumes/Eng-Dev/GlassPane/engine/probe/.build/...`，测的就是另一棵树的代码，
    而输出看起来完全正常——这与"构建过期"同族，都是拿不是本轮的东西当证据。
    返回 (留下的候选, 被剔除的候选)。
    """
    real_here = os.path.realpath(here)
    kept, refused = [], []
    for one in candidates:
        resolved = os.path.realpath(one)
        inside_repo = resolved == real_here or resolved.startswith(real_here + os.sep)
        foreign = any(resolved.startswith(os.path.realpath(root)) for root in other_roots)
        (kept if inside_repo or not foreign else refused).append(one)
    return kept, refused


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
    # 自报计数器走文件而不是 stdout 管道：管道的另一端在脚本手里，脚本正忙着
    # 一轮轮发 act，读它就得并发；写文件则任何一方随时能取到最近事实。
    metrics_path = os.path.join(workdir, "canary-metrics.txt")
    open(metrics_path, "w").close()
    launched = subprocess.Popen(
        [bin_path], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        env=dict(os.environ, CANARY_METRICS_FILE=metrics_path),
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
    return launched, pid, metrics_path


def canary_metrics(path):
    """解析金丝雀自报的 (clicks, rss_kb, fds_opened)，取最后一次；没有则 None。"""
    last = None
    try:
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                fields = dict(
                    one.split("=", 1) for one in line.split() if "=" in one
                )
                if {"clicks", "rss_kb", "fds_opened"} <= set(fields):
                    last = (int(fields["clicks"]), int(fields["rss_kb"]), int(fields["fds_opened"]))
    except OSError:
        return None
    return last


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
            # 状态根隔离（B-01 + X-22）：先实测 daemon 自己把写入面落在本轮
            # --state-dir 那个根里，才起 daemon。证明不了 → NOT RUN(2)（本脚本 24 轮
            # act + T9 判定会把档案写进真实归档）。
            # R4-02 的 t9 半边（与 .p6_smoke.py 同名同体的共享段）：daemon 二进制必须
            # 不早于 engine/Sources，否则这 24 轮测的是旧 daemon。金丝雀每次由 swiftc
            # 现编，不存在过期问题，所以这里只量 daemon。
            fingerprints, stale = require_current_build(
                [('daemon', daemon_bin, os.path.join(HERE, 'Sources'))]
            )
            if stale:
                print('NOT RUN — 被测 daemon 不是当前构建，本轮未执行任何断言（NOT RUN ≠ PASS）：')
                for line in stale:
                    print('  ' + line)
                print('  实测指纹：' + ' | '.join(fingerprints))
                print('REMEDY: cd engine && swift build -c release（或 swift build）后复跑；'
                      '--daemon-bin 显式指到别处的件，也要自己保证它是当前构建。')
                sys.exit(2)
            print('PASS 被测 daemon 产物身份与新鲜度已实测（' + ' | '.join(fingerprints) + '）')

            state_root, state_dir_args, daemon_env = daemon_isolation_env(workdir)
            require_proven_isolation(daemon_bin, daemon_env, state_root, state_dir_args)
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

        canary, pid, metrics_path = build_and_launch_canary(workdir)
        print(f"PASS 泄漏金丝雀已启动（pid={pid}；注入速率不再从常量宣读，见每轮自报计数）")

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
            # actConfirmed 只说明 AXPress 返回 success，不说明动作执行过（AppKit
            # 收下从未上屏的窗口的 press 就丢掉）。所以第一件要量的是"注入真的发生了
            # 吗"，而不是把没发生的注入交给检测器去怪它不响。
            if round_index == 3:
                probe = canary_metrics(metrics_path)
                if probe is None or probe[0] < 3:
                    fail(
                        f"注入未落地：金丝雀自报 clicks={probe[0] if probe else 'None'}"
                        f"（已发 {round_index} 次 act 且全部 actConfirmed=true）——"
                        "问题在点击没有到达 handler，不在 T9 检测器；"
                        "读 daemon.log 里的 pixel-capture-* 标签与 assert_element leak#N 佐证窗口上屏"
                    )
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
            measured = canary_metrics(metrics_path)
            shown = (f"clicks={measured[0]} rss_kb={measured[1]} fds={measured[2]}"
                     if measured else "金丝雀未写出任何自报计数")
            print(f"注入侧实测：{shown}")
            fail(
                f"{max_acts} 轮内未检出 degradation|，T9 未触发。注入侧实测：{shown} "
                f"（期望 clicks≈{max_acts}、RSS 至少增长 {LEAK_MB_PER_CLICK}MB×clicks）——"
                "先比对这一行与上面的轨迹再判断是注入还是判据"
            )

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