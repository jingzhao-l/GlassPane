#!/usr/bin/env python3
"""P6 spec v6.0 §10 P6-E real-machine smoke — probe SDK end-to-end.

Brings up a dedicated daemon (sockets under a temp dir; it is started with
`--state-dir <sandbox>/.glasspane`, and that named root has to be **measured** —
via the daemon's own read-only CLI — to be where its writes actually land before
a single assertion runs; see 状态根隔离 below) and the synthetic probe-demo
control app, then asserts the full probe surface:

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


# ---- 熔断 reason 的分段匹配（A-02）------------------------------------------
# X-6 把每个未测通道改写成 `"标签: 原文"`，而整串 reason 又是 `"; "` 拼的多段
# （EngineCore 的 reasons.joined / performance| / degradation| 前缀），所以
# `reason == "screen-recording-denied"` 这种全等比较**必然**不成立：无屏幕录制席位
# 的机器（本机常态，见 smoke.md 真机观察 3 与 P6 记录 16）会把唯一端到端探针闸
# 永久钉红。按段匹配保持强度：段本身等于标签、或以 `"标签:"` 开头才算缺席位；
# 别的段把同名子串写在原文里（例如 timeout 段的捕获报错文本）不算——那不是"席位
# 缺失"的判定，放宽成裸子串/任意 reason 会把降级原因读错。
# The pixel channel can be dark for reasons other than a missing Screen
# Recording seat, and the classifier's answer is the same documented
# degradation for all of them (`pixelDiff` null → T6 `INCONCLUSIVE`,
# EngineCore's breaker labels). The canary therefore exempts `INCONCLUSIVE`
# only when the archive itself carries one of these labels — and the set is
# enumerated rather than "any reason", so a misclassified verdict with no
# pixel-channel excuse still fails here.
CIRCUIT_PIXEL_UNAVAILABLE_LABELS = (
    "screen-recording-denied",
    "pixel-capture-timeout",
    "pixel-capture-no-onscreen-window",
    "pixel-capture-window-outside-display",
)
# A-08/R3-1: an unwatched window keeps this label in the archive even when the
# operator declared the window unattended and the verdict therefore reads
# contaminated=false — the declaration may change the *inference*, never the
# record that nobody was watching. Asserted below, so a future change that
# launders a missing monitor into a clean window fails here instead.
CIRCUIT_CONTAMINATION_LABEL = "input-contamination-not-monitored"
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

    # 状态根隔离（B-01 + X-22）：先证明、后起 daemon。证明的东西是"daemon 自报的写入面
    # 落在本轮 --state-dir 那个根里"，不是"参数传了没有"；旧形状在这里传的是继承环境，
    # 于是本轮的 evidence/审批行直接落在开发者真实 ~/.glasspane 上，而脚本头部自称隔离
    # ——那是"未测量的结论"，比红更糟。
    state_root, state_dir_args, daemon_env = daemon_isolation_env(workdir)
    require_proven_isolation(daemon_bin, daemon_env, state_root, state_dir_args)
    probe_notes = []
    live_targets = live_state_targets(daemon_bin, probe_notes)
    state_before = state_fingerprint(live_targets)

    daemon = subprocess.Popen(
        [daemon_bin, *state_dir_args, "--socket-path", engine_sock,
         "--probe-socket-path", probe_sock, "--no-c33", "--unattended-window", "--verbose"],
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
        # 这个 strong 是从哪儿来的，必须一并量出来：本 daemon 用 --no-c33 起，没有任何
        # 输入监视器看过任何一个窗口，所以"未污染"只可能来自 --unattended-window 那句
        # **声明**。不钉这一对取值，闸门就只证明"级别能到 strong"，证不出它绿在
        # "操作员说了没人敲键盘"而不是绿在"有人看着且没看到"——那正是本项目最贵的混淆。
        check("strong 来自声明而非测量（monitored=false + basis 自陈是声明）",
              outcome.get("contaminationMonitored") is False
              and "declaration, not a measurement" in (outcome.get("contaminationBasis") or ""),
              f"basis={outcome.get('contaminationBasis')!r}")
        check("声明不洗白缺失的监视器（reason 仍带 not-monitored 标签）",
              breaker_reason_has_label(
                  (pack.get("circuitBreaker") or {}).get("reason"),
                  CIRCUIT_CONTAMINATION_LABEL),
              f"reason={(pack.get('circuitBreaker') or {}).get('reason')!r}")
        check("探针信号真实落进 evidence（§3.1 null→object）",
              pack["signals"]["handlerProbe"] is not None
              and pack["signals"]["handlerProbe"]["hitCount"] >= 1
              and pack["signals"]["stateDiff"] is not None
              and pack["signals"]["stateDiff"]["changed"] is True,
              f"handlerProbe={json.dumps(pack['signals']['handlerProbe'])} stateDiff.changed={pack['signals']['stateDiff']['changed']}")
        pixel_unavailable = [
            label for label in CIRCUIT_PIXEL_UNAVAILABLE_LABELS
            if breaker_reason_has_label(
                (pack.get("circuitBreaker") or {}).get("reason"), label)
        ]
        accepted = {"NO_ANOMALY"} if not pixel_unavailable else {"NO_ANOMALY", "INCONCLUSIVE"}
        run_canary(client, "ok-press", accepted,
                   "NO_ANOMALY 判定" + (
                       "（像素通道不可用→INCONCLUSIVE 为已知边界：%s）" % ", ".join(pixel_unavailable)
                       if pixel_unavailable else ""))

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
