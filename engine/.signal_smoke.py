#!/usr/bin/env python3
"""SIGTERM/SIGINT 收尾回归冒烟（P1 v1.2 §11.7 / smoke.md 记录）。

背景：`--replace-daemon` 在本机四次遇到"TERM 发出去、进程还在"，只能靠 SIGKILL 收拢。
根因在 daemon 侧的信号面；现在的实现是 `blockShutdownSignalsEarly`（主线程、任何 daemon
线程创建之前 `pthread_sigmask(SIG_BLOCK)` 掉 SIGINT/SIGTERM）+ `startShutdownWaiter`
（detached 线程 `sigwait` → unlink 两个 socket 文件 → `exit(0)`），见
engine/Sources/glasspaned/main.swift 同名两处。旧 DispatchSource 形态的三个坑（信号源
只作局部变量被 ARC 释放、handler 挂 `.main` 队列而 accept() 阻塞主线程永不泵、收尾
close 正被 accept 使用的 fd）记在 `startShutdownWaiter` 的注释里——旧符号名
`installSignalHandlers` 已不存在。本脚本就是那条缺口的回归闸：起一个隔离 daemon（**独立状态根**，两个 socket 由那个根
推导，不碰现网也不碰真 `~/.glasspane`），发 TERM/INT，要求**自行退出且退出码 0、socket 文件被
unlink**。隔离靠 `--state-dir`：只点名 socket、不点名状态根的写法会让 daemon 把状态根解析成真
家目录，启动扫描随之收紧**这台机器上的** `~/.glasspane`（2026-10-08 实测：跑一次这道闸就把真根
与每一条证据档案改了模式）。`run_case` 里那两条"根确实被点名"的断言就是这句承诺的凭证——撤掉
`--state-dir`，它们会红。

用法：
  python3 engine/.signal_smoke.py                    # 默认 .build/release/glasspaned
  python3 engine/.signal_smoke.py <glasspaned>       # 指定产物（可指向旧构建做对照）
  二进制定位：argv > env GLASSPANE_DAEMON_BIN > 上面的默认值

退出码：0 = PASS（两路断言真实跑过），1 = FAIL（断言不过），
  2 = NOT RUN（被测二进制缺失/不可执行，一条断言都没跑）。

CI 契约：本脚本是**唯一**接进 CI 的冒烟（.github/workflows/ci.yml `swift` job：
`swift build` → `python3 .signal_smoke.py .build/debug/glasspaned`），所以"产物找不着"
必须是红（exit 2）而不是绿——构建步骤或产物一旦改名，静默 exit 0 会把这条
SIGTERM/socket-unlink 闸门变成永久什么都不证明的 no-op。确实要在无产物的机器上放过
这一步时，显式设 `GLASSPANE_SMOKE_ALLOW_SKIP=1`（给开发者本机机会式跑商用；CI 里勿设）。
"""

import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time

DEFAULT_BIN = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), ".build", "release", "glasspaned"
)
EXIT_TIMEOUT_SECONDS = 6.0

# 0 = 断言全跑过且通过；1 = 断言不过；2 = NOT RUN（前置二进制不可用，一条断言都没跑）。
# 2 与 1 分开：CI 与人一眼能分清"闸门判出红"和"闸门根本没开门"。
EXIT_PASS = 0
EXIT_FAIL = 1
EXIT_NOT_RUN = 2
# 显式 opt-in 的跳过开关：设成 "1" 才允许在无产物时以 0 离场（本机机会式跑商）。
ALLOW_SKIP_ENV = "GLASSPANE_SMOKE_ALLOW_SKIP"


def resolve_binary(argv):
    """argv > env GLASSPANE_DAEMON_BIN > 默认 release 产物。"""
    if len(argv) > 1:
        return argv[1]
    from_env = os.environ.get("GLASSPANE_DAEMON_BIN")
    if from_env:
        return from_env
    return DEFAULT_BIN


def binary_problem(path):
    """可用 → None；不可用 → 人话原因（进 NOT RUN 报文）。"""
    if not os.path.exists(path):
        return "不存在"
    if not os.path.isfile(path):
        return "存在但不是文件（可能是目录）"
    if not os.access(path, os.X_OK):
        return "存在但没有可执行位"
    return None


def wait_for_socket(path, timeout=10.0, poll=None):
    """`poll` 是无参 callable，返回子进程退出码（已离场）或 None（还在跑）。
    子进程已经退出时立刻收手：再等满预算不产生任何信息，只把闸门拖慢。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if os.path.exists(path):
            try:
                probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                probe.settimeout(0.5)
                probe.connect(path)
                probe.close()
                return True
            except OSError:
                pass
        if poll is not None and poll() is not None:
            return False
        time.sleep(0.15)
    return False


#: stderr 尾巴的上限：诊断要能说话，但不能把一次红门变成几千行的日志倾倒。
STDERR_TAIL_BYTES = 1200


def read_stderr_tail(path, limit=STDERR_TAIL_BYTES):
    """有界地读出子进程留下的 stderr；读不出也要如实说读不出。"""
    try:
        with open(path, "rb") as handle:
            raw = handle.read()
    except OSError as error:
        return "（stderr 读不出：%r）" % (error,)
    if not raw:
        return "（stderr 为空——拒绝启动却不留话的二进制，本身就是一种红）"
    dropped = max(0, len(raw) - limit)
    text = raw[-limit:].decode("utf-8", errors="replace")
    if dropped:
        text = "…%d 字节被截去…%s" % (dropped, text)
    return text.replace("\n", " / ").strip()


def reap(child, grace=5.0):
    """收割子进程并交回退出码；负数是信号，None 是连 SIGKILL 都没收掉。

    从前这条路径是 `child.kill(); child.wait()` 然后把返回值扔掉——退出码是"二进制
    拒绝启动"与"状态根没被采纳"之间最锋利的那块证据，扔掉它，报文就只能靠猜。
    """
    code = child.poll()
    if code is not None:
        return code
    child.kill()
    try:
        return child.wait(timeout=grace)
    except subprocess.TimeoutExpired:
        return None


def startup_failure_text(engine_sock, state_dir, code, stderr_tail, waited):
    """socket 没起来时报什么：两种可能 + 本次能拿到的判别证据，不含糊。

    旧报文把这一眼写成"它没有用被点名的状态根"，而它手上一个证据都没有：那次红其实
    可能是退出码 64 的用法回归（`EX_USAGE`），也可能是崩在 bind 之前。状态根的断言
    并没有被削弱——真没采纳根的时候，下面的 (a) 照样会带着"进程活着、退出码读不出"
    的形状点出来。
    """
    hypotheses = (
        "两种可能：(a) 它没有采纳被点名的状态根 %s（socket 落在别处——缺 --state-dir "
        "的旧形状就是落在真的 ~/.glasspane）；(b) 二进制本身拒绝启动（用法/权限回归，"
        "或崩在 bind 之前）。分辨它们靠退出码与 stderr：只有 (a) 才会留下一个活着且"
        "不自行退场的进程。" % state_dir)
    if code is None:
        evidence = ("证据：%.0fs 内它一直活着，SIGKILL 之后仍收不到退出码 ⇒ 偏向 (a)，"
                    "但 (b) 里「起来了又卡死」的形状与它不可分辨" % waited)
    elif code < 0:
        evidence = ("证据：它被信号 %d 打死、没有自行退出 ⇒ 偏向 (b)（没活到 bind 那一步），"
                    "崩溃现场见 stderr" % -code)
    else:
        evidence = "证据：它自行离场，退出码 %d ⇒ 这是 (b)「拒绝启动」的形状，不是状态根问题" % code
        if code == 64:
            evidence += "（64 = EX_USAGE：参数用法回归的惯用码）"
    return ("daemon 未能在 %.0fs 内于 %s 起 socket。本闸不猜根因，把两种可能和证据一起交出："
            "\n      %s\n      %s\n      stderr 尾：%s"
            % (waited, engine_sock, hypotheses, evidence, stderr_tail))


def shutdown_stall_diagnosis(engine_sock, probe_sock, probe_existed=True):
    """超时那一刻还能看见什么，就说什么——两类失败的修法不一样。

    `startShutdownWaiter` 的收尾顺序是"先 unlink 注册表里的名字，再 exit(0)"
    （`engine/Sources/glasspaned/main.swift` 里 sigwait 分支那两行，改那里必须同步
    这里）。注册表只登记**真的绑上过**的名字（probe 那一半要过 `--no-probe`、A-18
    护栏与 `server.start()` 三道闸才 `shutdownSockets.register`），所以现场是三态：
      - 两个文件都没了、且 probe 这趟绑上过 ⇒ unlink 这一步跑完了，慢在 exit(0)/调度；
      - 两个都还在 ⇒ 登记着的名字一个都没少，与"sigwait 未消费信号"的形状一致；
      - 只少了一个 ⇒ 既不是"全没消费"也不是"全消费"，现场不足以判定信号——多半是
        注册表本来就只有那一个名字（probe 降级）或收尾在两次 unlink 之间中断。
    从前这里把"任何一个残留"都说成"sigwait 未消费信号"，那是把没测到的东西讲成测到的。
    把这两种压成一句"6s 内未退出"，红的那一次就只能靠重跑去猜——本仓为"失败被包装成
    听起来合理的解释"付过一次让像素通道死十天的代价，这条闸不许再来一次。
    """
    leftovers = [name for name in (engine_sock, probe_sock) if os.path.exists(name)]
    names = lambda rows: ", ".join(os.path.basename(one) for one in rows)
    if len(leftovers) == 2:
        return ("两个 socket 文件都还在（%s）——与「sigwait 未消费信号」的形状一致：收尾第一步"
                "就是 unlink 已登记的名字，一个都没少说明那段代码没跑到（F10/R5-07 一族）"
                % names(leftovers))
    if leftovers:
        gone = [one for one in (engine_sock, probe_sock) if one not in leftovers]
        return ("现场不齐：%s 还在、%s 已消失——这只证明收尾没有全部完成，不足以判定 sigwait"
                "有没有消费信号（probe 降级时注册表本就只有 engine 一个名字，也会是这个样子）"
                % (names(leftovers), names(gone)))
    if probe_existed:
        return "信号已消费（两个 socket 均已被 unlink），慢在 exit(0)/调度"
    return ("信号已消费（engine socket 已被 unlink；probe.sock 这趟从未绑上，"
            "那一半无从验证），慢在 exit(0)/调度")


_STUB_SOURCE = """
import os, signal, sys, time
engine, probe, mode = sys.argv[1], sys.argv[2], sys.argv[3]
open(engine, "w").close()
open(probe, "w").close()


def arrived(signum, frame):
    # 'consumed' 复现真收尾的顺序：先 unlink 再退出，然后卡在退出这一步；
    # 'partial' 只 unlink 掉注册表里的第一个名字（probe 降级、或收尾在两次 unlink 之间
    #   中断的形状）——诊断对它只能说"现场不齐"，不许再断言信号没被消费；
    # 'ignored' 什么都不动，只表示"socket 文件还在"——分类只看现场，不看它为什么不动。
    for path in ((engine, probe) if mode == "consumed"
                 else (engine,) if mode == "partial" else ()):
        try:
            os.unlink(path)
        except OSError:
            pass
    time.sleep(30)


signal.signal(signal.SIGINT, arrived)
signal.signal(signal.SIGTERM, arrived)
time.sleep(30)
"""


def self_test_diagnosis(work):
    """判据自己得能被红色检验：用三个 stub 各造一种超时形态。

    一个只在真出问题时才说话的诊断，等于没有诊断——这里主动制造"信号已消费但没退出"
    "socket 一个都没少"与"只少了一个"三种现场，各要求诊断**以它那一句开头**。说错、
    说得含混、或 stub 压根没卡住（＝这条判据今天没被检验过）都算失败。第三种现场是
    诊断收窄之后新增的分支：没有它，"现场不齐"这句话就和它替换掉的那句一样从未经过检验。
    """
    stub = os.path.join(work, "shutdown-stub.py")
    with open(stub, "w", encoding="utf-8") as handle:
        handle.write(_STUB_SOURCE)
    problems = []
    for tag, expect_prefix in (("consumed", "信号已消费"),
                               ("ignored", "两个 socket 文件都还在"),
                               ("partial", "现场不齐")):
        engine_sock = os.path.join(work, "self-%s-engine.sock" % tag)
        probe_sock = os.path.join(work, "self-%s-probe.sock" % tag)
        for path in (engine_sock, probe_sock):
            if os.path.exists(path):
                os.unlink(path)
        child = subprocess.Popen(
            [sys.executable, stub, engine_sock, probe_sock, tag]
        )
        deadline = time.time() + 5
        while time.time() < deadline and not os.path.exists(engine_sock):
            time.sleep(0.02)
        os.kill(child.pid, signal.SIGINT)
        stalled = True
        try:
            child.wait(timeout=1.0)
            stalled = False
        except subprocess.TimeoutExpired:
            pass
        diagnosis = shutdown_stall_diagnosis(engine_sock, probe_sock)
        child.kill()
        child.wait()
        for path in (engine_sock, probe_sock):
            try:
                os.unlink(path)
            except OSError:
                pass
        if not stalled:
            problems.append("自检 stub（%s）没能在信号后卡住 ⇒ 诊断分支今天没有被检验过" % tag)
        elif not diagnosis.startswith(expect_prefix):
            problems.append("自检 %s 诊断与现场不符（期望以 %r 开头）⇒ %s"
                            % (tag, expect_prefix, diagnosis))
    return problems


def run_case(binary, tag, state_dir, signum, inherit_ignored=False):
    """起一个 daemon，发 signum，断言它自行干净退出。返回失败原因列表。

    `inherit_ignored` 是 R6-12：让 daemon 在**继承 SIGINT=SIG_IGN** 的条件下起
    （POSIX：作业控制把后台异步命令的 SIGINT/SIGQUIT 设为 ignore，子进程继承之）。
    这正是门禁跑在 `nohup … &` 链条里、而单跑绿门内红的差别——继承来"忽略"的信号
    不进 pending 队列，`sigwait` 永远收不到，daemon 于是真的杀不掉。没有这一档，
    这个缺陷只能靠别人碰巧在后台跑门禁才看得见。

    状态根必须显式点名，而且这道闸要能发现自己没点名。从前这里是
    `--socket-path` + `--probe-socket-path` 两个具名 socket、**没有** `--state-dir`：
    daemon 于是把状态根解析成真的家目录默认根，启动扫描随之对**这台机器上的**
    `~/.glasspane` 动手（根 →0700，`projects.json`、`approvals.json`、
    `installer-daemon.log` 与每一条证据档案 →0600），而文件头一直写着"隔离…不碰现网"。
    同一棵树里的 `.t9_smoke.py` 早就用具名状态根跑，这道唯一接进 CI 的闸一直没采纳。
    现在 socket 由被点名的根推导（`StateRoot.engineSocketPath`：`<root>/daemon.sock`、
    `<root>/probe.sock`）。
    """
    engine_sock = os.path.join(state_dir, "daemon.sock")
    probe_sock = os.path.join(state_dir, "probe.sock")
    # 状态根**不由本脚本创建**：判据的全部力量来自"只有认了这个根的人才会在那里建目录、
    # 并把它收成 0700"。脚本先把目录建好，撤掉 `--state-dir` 时那条模式断言照样能过
    # （socket 若被显式点名，`prepareSocketDirectory` 也会顺手把父目录收成 0700）——
    # 那就是一个绿着却红不了的闸，本轮正是被一次反向变异抓出来的。
    if os.path.exists(state_dir):
        shutil.rmtree(state_dir)

    def pre_spawn():
        if inherit_ignored and signum == signal.SIGINT:
            signal.signal(signal.SIGINT, signal.SIG_IGN)
    err_log = state_dir + ".stderr.log"
    # stderr 落文件而不是 PIPE：PIPE 满了会把 daemon 顶在写日志上，那是一次我们
    # 自己造出来的超时。文件在 main() 的临时根里，随 rmtree 一起清掉。
    with open(err_log, "wb") as err_handle:
        child = subprocess.Popen(
            [binary, "--state-dir", state_dir, "--no-c33"],
            stdout=subprocess.DEVNULL, stderr=err_handle, preexec_fn=pre_spawn,
        )
    failures = []
    started = time.time()
    if not wait_for_socket(engine_sock, poll=child.poll):
        # 先收割它、读出它留下的话，再说现场允许说的话：这条路径从前扔掉退出码、
        # stderr 记成 DEVNULL，却 confidently 断言"它没有用被点名的状态根"——
        # 崩溃和 exit 64 的用法回归都会被它误诊成状态根问题。
        return [startup_failure_text(engine_sock, state_dir, reap(child),
                                     read_stderr_tail(err_log), time.time() - started)]
    if not os.path.isdir(state_dir):
        return failures + ["被点名的状态根 %s 没有被创建：daemon 用的不是它，"
                           "不碰现网的承诺落空" % state_dir]
    root_mode = os.stat(state_dir).st_mode & 0o777
    if root_mode != 0o700:
        failures.append(
            "被点名的状态根 %s 是 %s，不是 0700：启动扫描没有收紧这个根，"
            "说明 daemon 用的不是它" % (state_dir, oct(root_mode)))
    # 发信号之前先证明 probe.sock 存在过，否则"两个 socket 均被 unlink"里 probe
    # 那一半只是没东西可残留。绑定条件出自 engine/Sources/glasspaned/main.swift：
    # `options.probeEnabled`（本闸不传 --no-probe）且 A-18 护栏放行
    # （`probeListenerAllowed`：名字有主就不抢）且 `server.start()` 成功——三条都在
    # `shutdownSockets.register(probeSocketPath)` 之前，而注册表才是收尾会 unlink 的
    # 那份名单。被点名的根是刚建好的空目录，不会有现任监听者，所以这里理应绑上。
    probe_existed = wait_for_socket(probe_sock, timeout=3.0, poll=child.poll)
    if not probe_existed:
        failures.append(
            "发 %s 之前 %s 就不存在：probe 监听者这一趟没有绑上（降级会把原因写到 stderr）。"
            "这一趟对『两个 socket 均被 unlink』里的 probe 那一半无从验证，被证明的只有 "
            "engine socket。stderr 尾：%s"
            % (tag, os.path.basename(probe_sock), read_stderr_tail(err_log)))
    os.kill(child.pid, signum)
    try:
        code = child.wait(timeout=EXIT_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        diagnosis = shutdown_stall_diagnosis(engine_sock, probe_sock,
                                             probe_existed=probe_existed)
        child.kill()
        child.wait()
        try:
            one, five, _ = os.getloadavg()
            context = "1 分钟负载 %.2f / %d 核" % (one, os.cpu_count() or 0)
        except OSError:
            context = "负载读不出"
        # 现场先记下来再说话：红一次如果只能靠重跑去猜，那次红就等于没发生。
        return ["%s 后 %.0fs 内未退出：%s（%s；stderr 尾：%s）"
                % (tag, EXIT_TIMEOUT_SECONDS, diagnosis, context,
                   read_stderr_tail(err_log))]
    if code != 0:
        failures.append("%s 后退出码 %d（期望 0）；stderr 尾：%s"
                        % (tag, code, read_stderr_tail(err_log)))
    for leftover in (engine_sock, probe_sock):
        if os.path.exists(leftover):
            failures.append("%s 后 socket 文件残留：%s" % (tag, os.path.basename(leftover)))
            try:
                os.unlink(leftover)
            except OSError:
                pass
    return failures


def main(argv):
    binary = resolve_binary(argv)
    problem = binary_problem(binary)
    if problem is not None:
        # 唯一接进 CI 的冒烟闸：前置产物不可用绝不能以 0 离场冒充绿——用独立退出码 2
        # （NOT RUN），点名期望路径与产出它的命令（见文件头 CI 契约）。
        if os.environ.get(ALLOW_SKIP_ENV) == "1":
            print("SKIP（%s=1 显式要求）：被测产物%s：%s" % (ALLOW_SKIP_ENV, problem, binary))
            return EXIT_PASS
        print("NOT RUN — 被测 daemon 二进制%s，本轮未执行任何断言（NOT RUN ≠ PASS）：" % problem)
        print("  expected binary: %s" % binary)
        print("  produce it with: cd engine && swift build            # -> .build/debug/glasspaned")
        print("                   cd engine && swift build -c release # -> .build/release/glasspaned")
        print("  CI 调用形态（.github/workflows/ci.yml `swift` job）："
              "swift build 后 `python3 .signal_smoke.py .build/debug/glasspaned`；")
        print("  产物路径若变更，须同步改该 workflow 的 Signal teardown gate 一行")
        print("  本机确实要机会式跳过：设 %s=1（CI 里勿设）" % ALLOW_SKIP_ENV)
        return EXIT_NOT_RUN
    work = "/tmp/glasspane-signal-smoke-%d" % os.getpid()
    os.makedirs(work, exist_ok=True)
    try:
        problems = self_test_diagnosis(work)
        problems += run_case(binary, "SIGTERM", os.path.join(work, "state-sigterm"), 15)
        problems += run_case(binary, "SIGINT", os.path.join(work, "state-sigint"), 2)
        problems += run_case(binary, "SIGINT", os.path.join(work, "state-sigint-ignored"),
                             2, inherit_ignored=True)
    finally:
        # 清场覆盖 work 下的一切：三个自检 stub 的 socket、`shutdown-stub.py` 本身、
        # 三个被点名的状态根，以及每次起停留下的 `state-*.stderr.log`（它写在
        # `state_dir + ".stderr.log"`，也就是 work 里面，不是外面）。
        # `ignore_errors=True` 会把"没清掉"这件事整个吞了——那等于把一次现场留在
        # /tmp 里没人知道，所以清完必须回头看一眼，清不掉就说。
        shutil.rmtree(work, ignore_errors=True)
        if os.path.exists(work):
            print("WARN: 运行目录没能清干净，现场仍在 %s（里面有状态根与 daemon stderr "
                  "留档；这不是断言失败，但别把 /tmp 越跑越满当成正常）" % work)
    if problems:
        print("SIGNAL SMOKE FAILED（%d 项）：" % len(problems))
        for detail in problems:
            print("  - " + detail)
        return EXIT_FAIL
    print("SIGNAL SMOKE OK：SIGTERM / SIGINT 均自行退出（码 0）且 socket 文件被 unlink"
          "（三次起停各自跑在一个由本脚本点名、由 daemon 自己创建并收紧的状态根里）")
    return EXIT_PASS


if __name__ == "__main__":
    sys.exit(main(sys.argv))
