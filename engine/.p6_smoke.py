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
     the UI is verified to have been written back from the restored value twice
     over: structurally (count-marker-row Image rows return to the snapshot
     value 0, delta in [4,6]) and numerically (assert_element on count-label's
     `value` attribute reads back exactly "count: 0").

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
import pwd
import re
import signal
import subprocess
import sys
import ast
import tempfile
import time
import hashlib
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
# 每读到一枚档案就追加一个 bool：该档案的 signals.pixelDiff 是否是一个实测对象。
PIXEL_DIFFS = []


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
    # R6-双失败：引擎侧 `pixelCaptureFailureLabel` 把 "no capture surface available
    # (for window <id>)"（两阶段均失败、拿不到候选采集面）归并为这个标签 —— 它属于
    # "窗口不在可采集面上"的环境边界，不是应用缺陷。归并后这里已覆盖它，无需新条目，
    # 也避免让它漏成通用 pixel-capture-failed（那条故意不放进来）。
    "pixel-capture-no-onscreen-window",
    "pixel-capture-window-outside-display",
    # 操作把应用换到了另一个窗口（新开窗口/sheet 抢走前台）：前后截的不是同一个窗口，
    # 像素通路如实"未测量"。这仍是一条像素通路的 excuse，不是把误判洗成通过——
    # 引擎此时拒绝给 changedPixelRatio，而不是给一个跨窗口的假数字。
    "pixel-capture-window-changed",
    # R7：窗口在屏但拍不到它自己（被盖住 + 独立窗口采集也失败）。这条以前被归并进
    # "无在屏窗口"标签，而那个标签对它是假话（窗口明明在屏），代理照它去"取消最小化"
    # 根本无效。现在它有独立标签与独立出路，仍然算"通路没测到"而不是"判定错"。
    "pixel-capture-no-surface",
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
    pack = frame.get("evidencePack", frame)
    # R5-04：记下这一枚档案里像素通道**是否真的测出过东西**。null 有两种来源——
    # "这一轮界面确实没变"与"通道根本没测"（键名漂移、权限缺失），把它们混在
    # 一起读就是拿缺席当结论；2026-09-25 那次 CGWindowList 键名写错就藏在这里。
    signals = pack.get("signals") or {}
    PIXEL_DIFFS.append(bool(signals.get("pixelDiff")))
    return pack


COUNT_MARKER_IDENTIFIER = "count-marker-row"


def marker_row_counts(client):
    """一次 observe 同时量两个计数，返回 (marker_rows, unlabeled_images)。

    marker_rows —— role==AXImage 且 identifier=="count-marker-row"。**判定只看这一列。**
      实测形状（2026-09-24 真机 observe，maxDepth=10）：
      {"children": [], "identifier": "count-marker-row", "role": "AXImage"}，
      数量与 demo 的 min(count, 6) 1:1；count=0 时那个 HStack 容器自缩成一个
      AXUnknown，行里一张 Image 都不剩。原因：SwiftUI 会把容器上的
      .accessibilityIdentifier("count-marker-row") **传播到每个子 Image**，所以标记行
      在树里是"带 identifier 的 AXImage"，不是"无 identifier 的 AXImage"——旧谓词
      （只数无标识 AXImage）在任何机器上恒 0，差值断言从未绿过，与环境和漂移无关。
    unlabeled_images —— role==AXImage 且无 identifier。**只作对照诊断输出，不参与任何
      断言**：下次这条检查再红时，一眼分清是"标记行的形状变了"（marker_rows 归 0）
      还是"树里多了别的图像"（unlabeled 涨了）。

    为什么收窄到 identifier 是**加强**而不是放宽：它同时堵掉一条假绿通路。旧谓词数的
    是**全树**无标识 Image，会把系统菜单/徽标等**外部节点**算进差值（smoke.md 真机
    观察 14：全 app 树含 Apple 菜单"N 项更新"徽标且自发跳变）——外部图像一旦随行数
    变化，count 完全没被回写时 before/after 差值也能落进 [4,6]。按 identifier 精确锁定
    demo 自己的标记行之后，"差值只可能来自 count 回写"才重新成为事实。

    daemon 侧对 role/identifier 没有任何过滤（AXChannel.buildNode 逐节点读
    role/title/identifier，TreeDigest.AxNode 只有这三键），所以两种形状能同时存在；
    诊断阶段的对照实验：attach Finder 时 AXImage=4 / 其中无 identifier=4，四张全在树里。
    """
    tree = client.call("observe", {"maxDepth": 10})
    rows = [0]
    unlabeled = [0]

    def walk(nodes):
        for node in nodes:
            if node.get("role") == "AXImage":
                identifier = node.get("identifier")
                if identifier == COUNT_MARKER_IDENTIFIER:
                    rows[0] += 1
                elif not identifier:
                    unlabeled[0] += 1
            walk(node.get("children") or [])

    walk(tree.get("axTree") or [])
    return rows[0], unlabeled[0]


COUNT_LABEL_SELECTOR = {"role": "AXStaticText", "identifier": "count-label"}
SNAPSHOT_COUNT_LABEL_VALUE = "count: 0"


def assert_count_label(client, expected=SNAPSHOT_COUNT_LABEL_VALUE, equal=True,
                       attempts=4, settle=0.8):
    """用协议里现成的 assert_element 读 count-label 的 AXValue（零新增实现）。

    通道：Selector(role, identifier) + property=value → daemon 读
    kAXValueAttribute（AXChannel.readProperty），以 actual 回传
    （EngineCore.assertElement）。这是 observe 取不到的那一路——AxNode 只序列化
    role/title/identifier，Text 文案在 AXValue 里（smoke.md 真机观察 13）。
    前提"会话里已有一次 act"由本脚本 restore 前的 press 满足：assert_element 复用
    最近一次 act 的信号上下文，否则报 GP_E_NO_OPERATION。

    equal=True  → 判 daemon 自己的 passed（actual == expected）
    equal=False → 判 actual != expected，用于**前提核验**：堵掉"这条数值断言本来就
                  成立"的假绿（若回滚前标签已经显示快照值，那"回滚后 == 快照值"恒真）

    AXValue 的读值会滞后于 SwiftUI 的重渲周期，所以这里是**有界重试 + 如实回报读取
    次数**（与 run_canary 同一先例与同一理由：判定语义由单测确定化，真机只证端到端
    通路存在），期望本身不放宽。返回 (通过, actual, 读取次数)。
    """
    actual = None
    for attempt in range(1, attempts + 1):
        if attempt > 1:
            time.sleep(settle)
        frame = client.call("assert_element", {
            "selector": COUNT_LABEL_SELECTOR,
            "property": "value",
            "expected": expected,
        })
        actual = frame.get("actual")
        passed = frame.get("passed") is True if equal else (actual != expected)
        if passed:
            return True, actual, attempt
    return False, actual, attempts


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
    numbers = {}
    cls, diag, pack = last
    signals = pack.get("signals") or {}
    pixel = signals.get("pixelDiff")
    numbers["changedPixelRatio"] = (pixel or {}).get("changedPixelRatio")
    numbers["windowId"] = (pixel or {}).get("windowId")
    numbers["axChanged"] = (signals.get("axEvent") or {}).get("axChanged")
    numbers["stateChanged"] = (signals.get("stateDiff") or {}).get("changed")
    numbers["hitCount"] = (signals.get("handlerProbe") or {}).get("hitCount")
    try:
        one, five, fifteen = os.getloadavg()
        numbers["load1m"] = round(one, 2)
        numbers["cores"] = os.cpu_count()
    except OSError:
        numbers["load1m"] = "读不出"
    print(
        f"FAIL {label} — {attempts} 次后仍未落入 {accepted}，最后 class={cls}\n"
        f"     实测通道：{json.dumps(numbers, ensure_ascii=False)}\n"
        f"     读法：ratio=0 说的是\u201c前后两帧采集到的像素没差\u201d，不等于\u201c界面没变\u201d——\n"
        f"     state/ax/handler 都变了而像素没差：要么采集赶在重绘之前"
        f"（本机此刻负载 {numbers['load1m']}/{numbers.get('cores')} 核），"
        f"要么拍到的不是这块界面（窗口被遮 / 拿错 windowId）。\n"
        f"     这两种都要人来判，不许靠加重试次数或放宽 accepted 了结；"
        f"ratio 为 null 才归到像素通道哑火那一族。"
    )
    sys.exit(1)


def sweep_orphan_fixtures(demo_bin):
    """收掉上一次被强杀时留下的孤儿夹具窗口。

    `finally` 里的 terminate 只在脚本**活着走到收尾**时才有效。脚本被 SIGKILL
    （或终端被直接关掉）时，`start_new_session` 拉起的 probe-demo 不随父进程死，
    于是那个灰色夹具窗口一直留在用户桌面上——用户看到的"运行时冒出来又关不掉的
    灰面板"就是这么来的。开跑前先扫一遍，顺手把上一轮的残留收掉。
    """
    # 按**可执行文件名**匹配，不按传入的完整路径：`pgrep -f` 比的是进程自己的
    # 命令行，冒烟用绝对路径起它、但人（或上一轮的别的调用方式）可能用相对路径
    # 起——只匹配绝对路径就会漏掉真正该收的那个孤儿。
    needle = os.path.basename(demo_bin)
    try:
        listing = subprocess.run(["pgrep", "-f", needle],
                                 capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return []
    killed = []
    for raw in listing.split():
        try:
            pid = int(raw)
        except ValueError:
            continue
        if pid == os.getpid():
            continue
        # 只收**真孤儿**：父进程已变成 launchd（ppid 1）。正在跑的冒烟里，demo 的
        # 父进程是那个 python 脚本本身——不加这一条，两次并发冒烟会把对方正在用的
        # 夹具窗口杀掉，把一条好端端的闸门变成随机 flaky。
        ppid = subprocess.run(["ps", "-o", "ppid=", "-p", str(pid)],
                              capture_output=True, text=True, timeout=5).stdout.strip()
        if ppid != "1":
            continue
        try:
            os.kill(pid, signal.SIGTERM)
            killed.append(pid)
        except ProcessLookupError:
            pass
    if killed:
        print(f"NOTE 收掉上一轮遗留的 probe-demo 孤儿进程：{killed}")
        time.sleep(1.0)
    return killed


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
    daemon_bin = resolve_binary(sys.argv[1] if len(sys.argv) > 1 else None,
                                "GLASSPANE_DAEMON_BIN", DAEMON_CANDIDATES)
    demo_bin = resolve_binary(sys.argv[2] if len(sys.argv) > 2 else None,
                              "GLASSPANE_DEMO_BIN", DEMO_CANDIDATES)
    # R4-02 的两半，都在任何断言之前量：
    # ① 兜底候选里若有别的 checkout 的产物，先用掉它——那测的是另一棵树；
    # ② 产物比自己的源码树旧，那测的是旧构建。两种都不放行，且都留下指纹便于回溯。
    resolved = (
        ("daemon", daemon_bin, DAEMON_CANDIDATES,
         (len(sys.argv) > 1 and sys.argv[1]) or os.environ.get("GLASSPANE_DAEMON_BIN")),
        ("demo", demo_bin, DEMO_CANDIDATES,
         (len(sys.argv) > 2 and sys.argv[2]) or os.environ.get("GLASSPANE_DEMO_BIN")),
    )
    for name, chosen, candidates, explicit in resolved:
        if explicit:
            continue          # 人显式给的路径不猜：那就是他要点名的那个件
        kept, refused = reject_foreign_checkout(candidates, HERE)
        if chosen in refused:
            print(f"NOT RUN — {name} 落到另一个工作副本的产物上，本轮不放行（NOT RUN ≠ PASS）：")
            for one in refused:
                print(f"  被剔除外来产物：{one}")
            print("REMEDY: cd engine && swift build && (cd probe && swift build) 后复跑；"
                  "或确实要跨副本时，用位置参数/env（GLASSPANE_DAEMON_BIN、GLASSPANE_DEMO_BIN）显式点名。")
            sys.exit(2)
    fingerprints, stale = require_current_build([
        ("daemon", daemon_bin, build_source_roots(HERE, "glasspaned")),
        ("demo", demo_bin, build_source_roots(os.path.join(HERE, "probe"), "probe-demo")),
    ])
    if stale:
        print("NOT RUN — 被测产物不是当前构建，本轮未执行任何断言（NOT RUN ≠ PASS）：")
        for line in stale:
            print(f"  {line}")
        print("  实测指纹：" + " | ".join(fingerprints))
        print("REMEDY: cd engine && swift build && (cd probe && swift build) 后复跑。")
        sys.exit(2)
    check("被测产物身份与新鲜度已实测（sha256 + 构建时间不晚于各自源码树）", True,
          " | ".join(fingerprints))

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

    sweep_orphan_fixtures(demo_bin)

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
        markers_before, unlabeled_before = marker_row_counts(client)
        # 前提核验（数值通道的假绿闸）：回滚前 count-label 显示的**不是**快照值。
        # 没有这一条，下面"回滚后 AXValue=='count: 0'"可以本来就成立而恒真。
        # 也是这一次读取顺带证明 AXValue 通道真的读得到文案（不是 nil/空串）。
        moved, label_before, label_before_reads = assert_count_label(
            client, equal=False)
        check("回滚前 count-label 不显示快照值（否则下一条数值断言恒真）", moved,
              f"AXValue={label_before!r} 读取次数={label_before_reads}")
        restore = client.call("restore", {"snapshotId": snapshot_id, "mode": "rollback_full"})
        check("档 1 执行面：rollbackExecuted=true + consistent=true（§5.5/C34 语义）",
              restore.get("rollbackExecuted") is True and restore.get("consistent") is True
              and restore.get("executionSurface") == "gp-probe",
              f"surface={restore.get('executionSurface')} consistent={restore.get('consistent')}")
        # UI corroboration: the count label reflects the restored value.
        tree = client.call("observe", {"maxDepth": 10})
        text = json.dumps(tree.get("axTree"))
        check("恢复后 UI 回写可见（count 标签存在）", "count-label" in text)
        # 值敏感的 UI 回写核验（弱断言"标签存在即过"保留，但不再由它充数——
        # count-label 无条件在场，存在性本身不随恢复值变化）：
        # 判定按 identifier=="count-marker-row" 精确锁定 demo 自己的标记行，
        # 外部图像（系统菜单/徽标）与 drift-marker-row、lazy 行都落在谓词之外，
        # 于是 before/after 差值只可能来自 count 回写：回滚目标为快照值 count=0，
        # 回滚前 count=C+1≥4（初始 ok-press + NO_ANOMALY 金丝雀 + delayed +
        # 本轮加压，行渲染 min(count,6)）→ 差值必须落在 [4,6]。
        # 证明：探针写回的数值确实驱动 demo UI 结构回退，且回退量与快照值一致
        #       （没回滚 → 差 0；只回退一步 → 差 ≤1；都判 FAIL）。
        # 不证明：具体数字文案——observe 的 AxNode 不序列化 AXValue（真机观察 13）。
        #       那一条由紧随其后的 assert_element 数值断言补上（走的是属性通道，
        #       不是 observe 树），这里不再声称"结构行数即能取到的最强证物"。
        time.sleep(0.8)  # 给 SwiftUI 一次重渲周期再读树
        markers_after, unlabeled_after = marker_row_counts(client)
        markers_delta = markers_before - markers_after
        check("恢复后 UI 结构回写：count 标记行随快照值 0 清空（差值∈[4,6]）",
              4 <= markers_delta <= 6,
              f"delta={markers_delta} before={markers_before} after={markers_after}")
        # 对照计数：诊断输出，不参与断言（形状再变时用来分清"标记行形状变了"
        # 还是"树里多了别的图像"）。
        print(f"NOTE 对照计数（不参与断言）：全树无 identifier 的 AXImage "
              f"before={unlabeled_before} after={unlabeled_after}；"
              f"identifier==count-marker-row 的 AXImage before={markers_before} "
              f"after={markers_after}")
        # ---- 数值回写核验：快照值本身被写回界面（比结构行数更强的一条）-------
        # 现成通道 assert_element + property=value，零新增实现：读的是
        # kAXValueAttribute，回传 actual。它精确到"count 标签的文案 == 快照值 0"，
        # 而结构行数只到"行数回退了"。滞后时按有界重试处理并如实打印读取次数。
        zeroed, label_after, label_after_reads = assert_count_label(client)
        # 读取次数如实分三种口径：一次达成 / 重试后达成 / 重试用尽仍未达成。
        # 失败时不得写"第 N 次达成"（那是把用尽上限说成成功）。
        if not zeroed:
            read_note = f"有界重试 {label_after_reads} 次仍未读到快照值"
        elif label_after_reads > 1:
            read_note = f"第 {label_after_reads} 次读取才达成（此前值滞后，见 NOTE）"
        else:
            read_note = "首次读取即达成"
        check("恢复后数值回写：count-label 的 AXValue 等于快照值 'count: 0'"
              "（assert_element value，比结构行数更强）",
              zeroed,
              f"AXValue={label_after!r}（回滚前 {label_before!r}）{read_note}")
        if zeroed and label_after_reads > 1:
            print(f"NOTE 数值通道读取滞后：AXValue 在第 {label_after_reads} 次读取才等于"
                  f"快照值（前 {label_after_reads - 1} 次仍是回滚前文案），期望未放宽")

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
    # R5-04 的正向断言：本轮必须至少测出一枚非 null 的 pixelDiff。
    # 冒烟对"像素不可用"的容忍（CIRCUIT_PIXEL_UNAVAILABLE_LABELS）只在通道**能**测
    # 而本轮恰好没测到时才无害；如果整轮没有一次成功测量，那这个标签就不再是
    # "已知边界"而是通道故障的自陈——本仓库 2026-09-25 之前的形态正是后者，
    # 而当时没有任何一条断言能把它和"这台机器没授权"区分开。
    measured = sum(1 for one in PIXEL_DIFFS if one)
    check(
        "像素通道本轮实测出过 pixelDiff（区分「界面没变」与「通道没测」）",
        measured > 0,
        f"{measured}/{len(PIXEL_DIFFS)} 枚档案带非 null pixelDiff；"
        "全零 ⇒ 捕获路径或屏幕录制席位故障，此时 T5/T6/T7 的判定不可信",
    )
    print("P6 SMOKE OK")


if __name__ == "__main__":
    main()
