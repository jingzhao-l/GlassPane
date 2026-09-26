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
import pwd
import re
import signal
import socket
import subprocess
import sys
import ast
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
        // R6-04: report once before any click. The harness needs a baseline it
        // measured — "8MB per click" recited from `LEAK_BYTES` says what the
        // script intends, not what this process did — and a zero-click line is
        // also the earliest witness that the canary is alive and writing.
        reportMetrics()
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
LEAK_MB_PER_CLICK = 8      # 与 CANARY_SOURCE 的 LEAK_BYTES 同值
# R6-04：它不再是失败信息里的一句宣读，而是注入侧的下限判据——实测 rss 增量 ÷ 实测
# clicks 必须达到它的半数（另一半留给被测量进程自己的分配）。以前只印不判，于是
# "T9 没响"永远有可能是"泄漏根本没发生"，而那会把判据叫醒去查一个不存在的 bug。
MIN_LEAK_MB_PER_CLICK = LEAK_MB_PER_CLICK / 2
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


class HomeRecordUnavailable(Exception):
    """本用户的 home 读不到。此时**没有**可用的真根，也没有可以回退的次优值。"""


def record_home():
    """本机用户的 home 目录：**只**从口令库读（`pwd.getpwuid(os.getuid()).pw_dir`）。

    与 daemon 侧的 `NSHomeDirectory()`（`Sources/GlassPaneEngine/StateRoot.swift` 的
    `homeDefault()`）同语义：macOS 上两者都**不采纳 $HOME**。反过来，Python 的
    `os.path.expanduser("~")` 优先读 `$HOME`——用它拼"真根"，脚本一旦跑在 HOME 被重定向
    的环境里（gate.sh 对 engine 模块就是这么做的，任何未来的沙箱也会这么做），报出的就是
    沙箱而不是真根，于是"没有任何写入面落在真实根内"这条判据改成守着沙箱、放着真文件，
    毁掉开发者真实的 `~/.glasspane` 时一声不响（fail-open）。这与把 projects.json 从 71 条
    写成 2 条那次同源于一个 lookup，mcp-shell 侧已用 `os.userInfo().homedir` 修掉同一处
    （`mcp-shell/src/project-registry.ts` 的 `systemHome()`）。
    读不到记录（uid 在口令库里没有条目）时抛 `HomeRecordUnavailable` 而**不回落到 $HOME**：
    一个错的真根远比"没有真根"危险。
    """
    try:
        entry = pwd.getpwuid(os.getuid())
    except KeyError as error:
        raise HomeRecordUnavailable(
            f"口令库里没有 uid={os.getuid()} 的记录（{error}）") from error
    home = entry.pw_dir
    if not home or not home.startswith(os.sep):
        raise HomeRecordUnavailable(
            f"uid={os.getuid()} 的记录里 pw_dir 不是绝对路径（{home!r}）")
    return home


def real_user_state_root():
    """开发者真实的 per-user 状态根 = daemon 不传 `--state-dir` 时会写进去的那个目录。

    home 取自口令库（见 `record_home()`），**不取自 $HOME**：判据不依赖"本脚本自己的环境
    里 HOME 从未挪过"这个前提——那个前提不属于本脚本能保证的东西，而它一旦被破坏，用
    $HOME 拼出来的"真根"就成了沙箱本身，守卫也随之失去意义。daemon 侧同一目录由
    `NSHomeDirectory()` 得出，同样不读 $HOME，两边因此指的是同一个目录。
    """
    return os.path.realpath(os.path.join(record_home(), ".glasspane"))


def announce_home_source():
    """启动即核对 home 口径，并把事实打出来（本文件自己的可证伪断言）。

    要求：`os.environ.get("HOME")` 与口令库里的 home 不一致时，**必须**说出这一事实，
    同时说出判据用的真根不跟着 $HOME 走。也就是说人为
    `HOME=/tmp/whatever python3 <本脚本>`（.p6_smoke.py 与 .t9_smoke.py 同一段）时，真根仍
    然报成 `/Users/<you>/.glasspane`——这一条既能被读，也能被反驳（它对不上就是脚本写错了）。
    口令库里没有本用户的记录 → NOT RUN(2) 离场，此处不回落 $HOME（回落正是本轮要消灭的
    形状），且早于任何子进程与任何断言。
    """
    try:
        home = record_home()
        live_root = real_user_state_root()
    except HomeRecordUnavailable as error:
        print(f"NOT RUN — 启动前置的 home 口径核对失败（{error}），一条断言都没执行"
              "（NOT RUN ≠ PASS）。")
        print("  这里**不**回落到 $HOME：真根一旦由 $HOME 拼出，被重定向的 HOME 会让状态根")
        print("  隔离守卫把沙箱当成真根，毁掉开发者真实的 ~/.glasspane 时一声不响。")
        print("  REMEDY: 以口令库里有条目的 uid 运行（对照：dscl . -read /Users/$(id -un)"
              " NFSHomeDirectory）。")
        sys.exit(2)
    env_home = os.environ.get("HOME")
    print(f"home 口径：口令库 pw_dir={home} → real_user_state_root()={live_root}"
          "（daemon 侧同源 = NSHomeDirectory()，两者都不读 $HOME）")
    if env_home != home:
        print(f"NOTE $HOME={env_home!r} 与口令库的 home={home!r} 不一致：本脚本正跑在 HOME 被"
              "重定向的环境里。真根**仍取自口令库**（上面那个 real_user_state_root），不随"
              " $HOME 走；判据不依赖“HOME 从未挪过”这个前提。")
    return live_root


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
         ~/.glasspane 之内或之下。"在沙箱外"这种模糊说法不作判据，真实根才是要守的东西；
         而"真实根"只从口令库派生（record_home()），$HOME 不参与——本脚本可能正跑在 HOME
         被重定向的环境里，那时 $HOME 拼出的"真根"就是沙箱，判据当场反过来守着沙箱。
      5. 同一套参数、HOME 换回**口令库里的真实 home** 再问一次，结论必须仍然是那个沙箱根。
         只有"路径跟着 --state-dir 走、不跟着 HOME 走"才叫注入生效；少了这一条，一个忽略
         --state-dir 却采纳 HOME 的 daemon 也能交出"落在沙箱里"的回显，而那正是"传了参数
         就当已隔离"。
    任何一条不成立 → NOT RUN(2)，一条断言都不跑。
    """
    expected = os.path.realpath(state_root)
    notes = []
    try:
        live_home = record_home()
        live_root = real_user_state_root()
    except HomeRecordUnavailable as error:
        # 判据要拿"真根"当比对基准，而这里没有任何办法猜出它：读不到就 NOT RUN。
        # 回落 $HOME 会把沙箱目录当真根，那条"没有面落在真根之内"的判据随即守着沙箱。
        print("NOT RUN — 真根无从报出，状态根隔离未证明，一条断言都没执行（NOT RUN ≠ PASS）：")
        print(f"  {error}")
        print("  本闸不回落 $HOME（$HOME 可被任何调用方改写，daemon 却不读它）；见 record_home()。")
        sys.exit(2)

    def not_run(reason_lines):
        print("NOT RUN — 状态根隔离未证明，一条断言都没有执行（NOT RUN ≠ PASS）")
        print(f"  --state-dir 的取值：{state_root}（realpath {expected}）")
        print(f"  真实 per-user 状态根：{live_root}（由口令库 pw_dir={live_home} 派生，与 $HOME 无关）")
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
        print(f"      HOME={live_home} {daemon_bin} {flags}")
        print("        → 这一问用的是口令库里的 home（$HOME 不算），dir 必须**仍然**在那个根内："
              "跟着 HOME 走就是假注入（判据 5）")
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
    # 判据 5：同一套参数、HOME 换回**口令库里的真实 home** 再问一次。这一步把"参数带着走"
    # 与"HOME 带着走"分开：一个忽略 --state-dir 却采纳 HOME 的 CLI 在这一问里会报出真实
    # per-user 根。真值在这里显式给出而不是继承本脚本的 $HOME——本脚本可能正跑在 HOME 被
    # 重定向的环境里，那时"继承"到的根本不是真实值，这一问也就没量到它声称的东西。
    home_notes = []
    against_home = probe_state_roots(daemon_bin, dict(os.environ, HOME=live_home),
                                     home_notes, extra_args)
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


def _newest_source_mtime(source_roots):
    """`source_roots` 里最新源文件的 mtime（跳过 .build 与点目录）。0.0 = 一个都走不出。

    参数是**一组**目录：新鲜度必须对着这个产物真正链接的源码集来量，见
    `_target_source_roots`。
    """
    newest = 0.0
    for source_root in source_roots:
        for dirpath, dirnames, filenames in os.walk(source_root):
            dirnames[:] = [d for d in dirnames if d != ".build" and not d.startswith(".")]
            for name in filenames:
                if name.endswith((".swift", ".c", ".h", ".m", ".py", ".ts", ".js")):
                    try:
                        newest = max(newest, os.path.getmtime(os.path.join(dirpath, name)))
                    except OSError:
                        continue
    return newest


def _package_targets(package_swift):
    """Package.swift 里的 target → (path, 依赖名)。写法变了就老实返回 {}，由调用方退回宽基线。"""
    try:
        with open(package_swift, encoding="utf-8") as handle:
            text = handle.read()
    except OSError:
        return {}
    found = {}
    # Every target kind SwiftPM knows, not just the three this file first met:
    # `engine/probe/Package.swift` declares its macro plugin with `.macro(`, and
    # missing it there silently dropped the macro sources from the demo's
    # freshness baseline while the note claimed they were an external package.
    kinds = "executableTarget|testTarget|target|macro|plugin|binary|systemLibrary"
    for chunk in re.split(r"\.(?:" + kinds + r")\s*\(", text)[1:]:
        name = re.search(r'name:\s*"([^"]+)"', chunk)
        if not name:
            continue
        path = re.search(r'path:\s*"([^"]+)"', chunk)
        # `path:` is optional in a manifest: engine/Package.swift writes it, engine/probe/
        # Package.swift does not and rides SwiftPM's default (`Sources/<name>`). Measured:
        # requiring the literal silently lost `probe-demo`, i.e. the demo's freshness
        # baseline fell back to the whole tree while claiming to be scoped.
        relative = path.group(1) if path else os.path.join("Sources", name.group(1))
        deps = re.search(r"dependencies:\s*\[([^\]]*)\]", chunk)
        found[name.group(1)] = (
            relative,
            re.findall(r'"([^"]+)"', deps.group(1)) if deps else [],
        )
    return found


def _target_source_roots(package_dir, target):
    """`target` 的源码目录 + 它在**本包内**的依赖闭包，名单现读自 Package.swift。

    R6-04：新鲜度基线原来取整个 `engine/Sources`。任何与被测产物无关的 target（GUI
    面板）改一行，daemon 这一条就被判成"产物比源码旧"→ NOT RUN。方向是安全的（宁可
    白烧一次门禁），但白烧在无关事由上的门禁，下一次就被人 `--skip` 掉——那才是真失效。
    现在只量这个产物实际链接的 target 集；闭包从清单的 `path:` / `dependencies:` 现读，
    不写死名单：新增一个包内依赖不需要有人记得回来改这里。

    返回 (源码目录列表, 本包外的依赖名)。依赖名不在本包 target 集里＝跨包 `.product`
    （SwiftSyntax 那一类），它不参与"本仓产物是否当前"的判断，但要说出来：如果哪天那
    是个拼错的**本包** target 名，这里就是看得见它的地方。target 本身找不到 → ([], [])。
    """
    targets = _package_targets(os.path.join(package_dir, "Package.swift"))
    if target not in targets:
        return [], []
    roots, pending, seen, external = [], [target], set(), []
    while pending:
        current = pending.pop(0)
        if current in seen:
            continue
        seen.add(current)
        entry = targets.get(current)
        if entry is None:
            external.append(current)
            continue
        roots.append(os.path.join(package_dir, entry[0]))
        pending.extend(entry[1])
    return sorted(set(roots)), sorted(set(external))


def build_source_roots(package_dir, target):
    """`_target_source_roots` 的带退路版本：解析不出来就退回旧的宽基线，并说明为什么。

    退回宽基线只会让门禁更容易 NOT RUN，不会让它更容易放行——这条方向是故意的。
    """
    roots, external = _target_source_roots(package_dir, target)
    if not roots:
        print(
            f"NOTE 解析不出 {package_dir} 里 target {target!r} 的源码集，"
            f"新鲜度基线退回 {package_dir}/Sources（宽基线：无关 target 的改动也会让本轮 NOT RUN）"
        )
        return [os.path.join(package_dir, "Sources")]
    if external:
        print(
            f"NOTE {target} 的依赖里有 {len(external)} 个本包外的名字（{', '.join(external)}），"
            "不计入本仓源码新鲜度——它们是外部包的产物，不是这里没算进来的源码"
        )
    return roots


def require_current_build(pairs):
    """实测"本轮被测的产物不早于它所声称构建自的源码"，并留下可回溯的指纹。

    R4-02。此前两条端到端闸只检查产物**存在**，不检查它是**当前构建**：实测过一次
    demo 停在旧能力集（hello 报 caps=['z1']，缺 z3/checkpoint），于是整轮"绿"测的是旧 SDK。
    判据是产物的指纹与时间戳，不是"我刚刚 build 过"这句话——命令说过什么不等于发生了什么。
    R6-04 把每对的第三项从"一个源码根"改成"一组"：由 `build_source_roots` 从
    Package.swift 现读该 target 的依赖闭包，无关 target 的改动不再把本轮打成 NOT RUN。
    返回 (指纹行, 不成立的原因)。原因非空由调用方 NOT RUN(2)：过期产物跑出来的结论不能用。
    """
    lines, problems = [], []
    for role, binary, source_roots in pairs:
        try:
            with open(binary, "rb") as handle:
                digest = hashlib.sha256(handle.read()).hexdigest()[:12]
        except OSError as error:
            problems.append(f"{role}: 产物读不出（{error}）——身份无法确认，不放行")
            continue
        built = os.path.getmtime(binary)
        newest_src = _newest_source_mtime(source_roots)
        when = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(built))
        lines.append(f"{role} sha256:{digest} mtime={when}")
        if not newest_src:
            problems.append(
                f"{role}: 源码集 {', '.join(source_roots)} 走不出任何源文件"
                "——无法判断产物是否当前，不放行"
            )
            continue
        if built + 1.0 < newest_src:
            problems.append(
                f"{role} 比它所声称的源码集旧：{binary} 构建于 {when}，而 "
                + f"{', '.join(source_roots)} 下最新源文件是 "
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


# 本段与 engine/.t9_smoke.py 共享同一段判据代码。本仓惯例是冒烟脚本各自自包含、不做跨脚本
# import，所以"改一处必须同步另一处"过去只由一句人读注释承担——而注释不是闸：本轮就发生过
# 一次"提交信息声称有 `shared_block_problems` 守卫，回代码一查从未存在"。下面这道闸把它变成
# 机器判据：与兄弟脚本逐名比对顶层定义，漂移即 NOT RUN(2)。
SHARED_BLOCK_INTENTIONALLY_DIFFERENT = {
    # 每一条都必须**仍然真的不同**才留着；一旦两边写成一样，闸会要求删掉这条例外。
    "DAEMON_CANDIDATES": "p6 多兜一份 /tmp/glasspane-p6 下的构建产物（p6 自己做 round-trip 重建的位置），t9 没有这一步",
    "main": "两个脚本各自的入口：argv 形态、断言顺序与报告文本本就不同",
}


def shared_block_definitions(script):
    """一个脚本里的顶层具名定义 → {name: 源码文本}（按 ast 的行范围切片）。

    按**定义**而不是按整段文本比对：整段比对会因为两份文件各自的本地产物常量与入口
    而必然不等，那条闸就只能靠"忽略整段"活着，等于没有判据。
    """
    with open(script, "r", encoding="utf-8") as handle:
        lines = handle.read().splitlines()
    tree = ast.parse("\n".join(lines))
    out = {}
    for node in tree.body:
        name = None
        if isinstance(node, (ast.FunctionDef, ast.ClassDef)):
            name = node.name
        elif isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name):
            name = node.targets[0].id
        if name and not name.startswith("_"):
            out[name] = "\n".join(lines[node.lineno - 1:node.end_lineno])
    return out


def shared_block_not_run(reason_lines):
    """本闸自己的 NOT RUN 出口（模块级的 `not_run` 不存在——它是
    `require_proven_isolation` 里的局部函数），说清一条断言都没执行再以 2 离场。"""
    print("NOT RUN — 共享段比对未通过，一条断言都没有执行（NOT RUN ≠ PASS）：")
    for line in reason_lines:
        print(line)
    print("  出路二选一：把共享判据在同一批次里改齐两份，或把确实该不同的名字连同"
          "**为什么不同**加进 SHARED_BLOCK_INTENTIONALLY_DIFFERENT。")
    sys.exit(2)


def verify_shared_block(this_script):
    """与兄弟脚本逐名比对；漂移或例外失配即 NOT RUN(2)。

    两个方向都要能红：① 有人在一份里改了共享判据而另一份没改 → 该名字不在例外表里，红；
    ② 例外表里的名字被写成两边一致（漂移消失或抄平） → 例外不再承重，红。第二条是防止
    例外表变成"永远无人复核的免检清单"，那正是本轮之前那条注释的失败模式。
    读不到兄弟脚本（单独 checkout、只拷了一份）→ 明说未比对，不当成通过。
    """
    here = os.path.dirname(os.path.abspath(this_script))
    sibling_name = ".t9_smoke.py" if os.path.basename(this_script).startswith(".p6") else ".p6_smoke.py"
    sibling = os.path.join(here, sibling_name)
    if not os.path.isfile(sibling):
        print(f"NOTE 共享段未比对：找不到兄弟脚本 {sibling}（比对本闸只在本仓完整 checkout 时有意义）")
        return
    try:
        mine = shared_block_definitions(this_script)
    except (OSError, SyntaxError) as error:
        shared_block_not_run([f"本脚本自身无法解析，共享段无从比对：{error}"])
        return
    try:
        theirs = shared_block_definitions(sibling)
    except (OSError, SyntaxError) as error:
        shared_block_not_run([f"{sibling_name} 无法解析，共享段无从比对：{error}"])
        return

    reasons = []
    drifted = []
    stale_exceptions = []
    checked = 0
    for name in sorted(set(mine) & set(theirs)):
        checked += 1
        if mine[name] == theirs[name]:
            if name in SHARED_BLOCK_INTENTIONALLY_DIFFERENT:
                stale_exceptions.append(name)
            continue
        if name in SHARED_BLOCK_INTENTIONALLY_DIFFERENT:
            continue
        drifted.append(name)
    missing_exceptions = [name for name in SHARED_BLOCK_INTENTIONALLY_DIFFERENT
                          if name not in mine or name not in theirs]
    if drifted:
        reasons.append("这些定义在两份冒烟脚本里已经不一致，而它们不在具名例外表中（共享判据漂移）：")
        reasons.extend(f"  {name}：改一处必须同步另一处" for name in drifted)
    if stale_exceptions:
        reasons.append("这些名字被登记为\u201c有意不同\u201d，但两边现在已经写成一样 —— 例外不再承重，请删掉它：")
        reasons.extend(f"  {name}" for name in stale_exceptions)
    if missing_exceptions:
        reasons.append("例外表点名了两侧并不都有的定义（表本身过期）：")
        reasons.extend(f"  {name}" for name in missing_exceptions)
    if reasons:
        shared_block_not_run(reasons)
    print(f"PASS 共享段已比对：{checked} 个两侧同名定义，{len(drifted) + len(stale_exceptions)} 处漂移，"
          f"{len(SHARED_BLOCK_INTENTIONALLY_DIFFERENT)} 条例外均经核对确实仍然不同（{sibling_name}）")


def main():
    # 启动第一件事：核对 home 口径（口令库 vs $HOME）并把事实打出来。任何子进程、任何断言
    # 之前——读不到本用户的记录即 NOT RUN(2)，不带着一个猜出来的"真根"往下跑。
    announce_home_source()
    # 与兄弟脚本的共享判据逐名比对（漂移即 NOT RUN，见 verify_shared_block）。
    verify_shared_block(__file__)
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
                # 分开说两种情形，且不把"存在"报成"缺失"：原实现无条件把每个兜底候选都
                # 印成 missing artifact —— 调用方显式给了一个不存在的路径时（例如手打
                # --daemon-bin 少一个字符），它看到的是"你给的那个"，而脚本宣判的却是
                # 整棵 .build 都不存在。判据要能反驳，前提是它说的必须是量的。
                if daemon_bin is not None:
                    print(f"  显式传入的路径不存在：{daemon_bin}"
                          "（--daemon-bin / env GLASSPANE_DAEMON_BIN；本轮没有改用兜底候选）")
                for cand in DAEMON_CANDIDATES:
                    state = "present" if os.path.exists(cand) else "missing artifact"
                    print(f"  {state}: {cand}")
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
                [('daemon', daemon_bin, build_source_roots(HERE, 'glasspaned'))]
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
            fail(
                "金丝雀 AX 树中未找到 identifier='leak-button' 的 AXButton"
                "（标题现在是 leak#N，而选择器从来不按标题匹配；先怀疑 AX 权限未授予 daemon）"
            )

        # 注入侧基线：第一轮按下**之前**的自报计数。没有它，下面那句"每击泄漏多少"
        # 就只能引用源码常量，而常量说明的是脚本打算注入多少，不是这台机器上真的注入了多少。
        baseline = canary_metrics(metrics_path)
        if baseline is None:
            fail(
                "注入侧基线读不到（金丝雀没写自报计数文件）——缺了基线，\"每击泄漏多少\"就退化成"
                "宣读源码常量，那是把没测到当不用判；本轮不跑 T9 判定"
            )
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
                else:  # a baseline is a precondition of reaching here (checked above)
                    clicks = probe[0] - baseline[0]
                    grew_mb = (probe[1] - baseline[1]) / 1024.0
                    per_click = grew_mb / clicks if clicks else 0.0
                    if per_click < MIN_LEAK_MB_PER_CLICK:
                        fail(
                            f"注入速率不足：实测 {clicks} 次点击只让常驻内存涨了 {grew_mb:.1f}MB"
                            f"（每击 {per_click:.1f}MB，下限 {MIN_LEAK_MB_PER_CLICK}MB）——"
                            "这里 T9 的沉默是正确的，要查的是金丝雀，不是把判据调低"
                        )
                    print(f"PASS 注入侧实测：{clicks} 击 +{grew_mb:.1f}MB"
                          f"（每击 {per_click:.1f}MB ≥ 下限 {MIN_LEAK_MB_PER_CLICK}MB）")
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
                f"（期望 clicks≈{max_acts}，实测 "
                f"{measured[0] if measured else '无'}；每击应有的 {LEAK_MB_PER_CLICK}MB 见上面"
                + "\"注入侧实测\"那一行——它 PASS 过才说明泄漏真的在长，这时才该怀疑判据"
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