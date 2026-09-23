#!/usr/bin/env python3
"""SIGTERM/SIGINT 收尾回归冒烟（P1 v1.2 §11.7 / smoke.md 记录）。

背景：`--replace-daemon` 在本机四次遇到"TERM 发出去、进程还在"，只能靠 SIGKILL 收拢。
根因在 daemon 侧的信号面；现在的实现是 `blockShutdownSignalsEarly`（主线程、任何 daemon
线程创建之前 `pthread_sigmask(SIG_BLOCK)` 掉 SIGINT/SIGTERM）+ `startShutdownWaiter`
（detached 线程 `sigwait` → unlink 两个 socket 文件 → `exit(0)`），见
engine/Sources/glasspaned/main.swift 同名两处。旧 DispatchSource 形态的三个坑（信号源
只作局部变量被 ARC 释放、handler 挂 `.main` 队列而 accept() 阻塞主线程永不泵、收尾
close 正被 accept 使用的 fd）记在 `startShutdownWaiter` 的注释里——旧符号名
`installSignalHandlers` 已不存在。本脚本就是那条缺口的回归闸：起一个隔离 daemon
（独立 socket，不碰现网），发 TERM/INT，要求**自行退出且退出码 0、socket 文件被 unlink**。

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


def wait_for_socket(path, timeout=10.0):
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
        time.sleep(0.15)
    return False


def run_case(binary, tag, sock_dir, signum):
    """起一个 daemon，发 signum，断言它自行干净退出。返回失败原因列表。"""
    engine_sock = os.path.join(sock_dir, "engine-%s.sock" % tag)
    probe_sock = os.path.join(sock_dir, "probe-%s.sock" % tag)
    child = subprocess.Popen(
        [binary, "--socket-path", engine_sock, "--probe-socket-path", probe_sock, "--no-c33"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    failures = []
    if not wait_for_socket(engine_sock):
        child.kill()
        child.wait()
        return ["daemon 未能在 %.0fs 内起 socket，无法判定信号面" % 10.0]
    os.kill(child.pid, signum)
    try:
        code = child.wait(timeout=EXIT_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()
        return ["%s 后 %.0fs 内未退出（SIGTERM 哑火复现，只能靠 KILL）"
                % (tag, EXIT_TIMEOUT_SECONDS)]
    if code != 0:
        failures.append("%s 后退出码 %d（期望 0）" % (tag, code))
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
    sock_dir = "/tmp/glasspane-signal-smoke-%d" % os.getpid()
    os.makedirs(sock_dir, exist_ok=True)
    try:
        problems = []
        problems += run_case(binary, "SIGTERM", sock_dir, 15)
        problems += run_case(binary, "SIGINT", sock_dir, 2)
    finally:
        for name in os.listdir(sock_dir):
            try:
                os.unlink(os.path.join(sock_dir, name))
            except OSError:
                pass
        os.rmdir(sock_dir)
    if problems:
        print("SIGNAL SMOKE FAILED（%d 项）：" % len(problems))
        for detail in problems:
            print("  - " + detail)
        return EXIT_FAIL
    print("SIGNAL SMOKE OK：SIGTERM / SIGINT 均自行退出（码 0）且 socket 文件被 unlink")
    return EXIT_PASS


if __name__ == "__main__":
    sys.exit(main(sys.argv))
