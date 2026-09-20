#!/usr/bin/env python3
"""SIGTERM/SIGINT 收尾回归冒烟（P1 v1.2 §11.7 / smoke.md 记录）。

背景：`--replace-daemon` 在本机四次遇到"TERM 发出去、进程还在"，只能靠 SIGKILL 收拢。
根因是 daemon 侧两处叠加（见 glasspaned/main.swift installSignalHandlers 的注释）：信号源
只作局部变量（安装完即被释放）＋ handler 挂在 .main 队列（accept 阻塞主线程时主队列不泵）。
本脚本就是那条缺口的回归闸：起一个隔离 daemon（独立 socket，不碰现网），发 TERM/INT，
要求**自行退出且退出码 0、socket 文件被 unlink**。

用法：
  python3 engine/.signal_smoke.py                 # 默认 .build/release/glasspaned
  python3 engine/.signal_smoke.py <glasspaned>    # 指定产物（可指向旧构建做对照）

无产物时 SKIP 并 exit 0（与 .c33_smoke.py / .t9_smoke.py 同口径：环境不满足不冒充失败）。
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
    binary = argv[1] if len(argv) > 1 else DEFAULT_BIN
    if not os.path.exists(binary):
        print("SKIP：产物不存在（%s），先 swift build -c release" % binary)
        return 0
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
        for problem in problems:
            print("  - " + problem)
        return 1
    print("SIGNAL SMOKE OK：SIGTERM / SIGINT 均自行退出（码 0）且 socket 文件被 unlink")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
