#!/usr/bin/env python3
"""重编译存活回归冒烟（P1 v1.2 §11.1 结论 3 / 验收项 P1-S8 收尾）。

背景：TCC 席位按「签名身份」记账，而缺省的 designated requirement 含 `cdhash H"..."`——
那样每次 `swift build -c release` 都会静默撤销授权，用户得反复回系统设置重勾（正是本项目
要避免的人工介入）。`make-app.sh` 因此把 DR 显式写成不含 cdhash 的 `identifier` 形式。
这条声明此前只写在脚本注释里、没有任何闸：本脚本就是那条闸。它把现网 daemon 换成一个
cdhash 已变、identifier 与 DR 未变的 bundle，kickstart 重启 launchd 作业，再读 daemon
自己的 `hello` 权限快照，要求「原本已授权的席位仍然已授权」，最后恢复原产物并复验。

它改的是**真实安装**（~/Applications 下的 daemon bundle 与现网 socket），只可能在 macOS
真机跑，不进 CI。用法：

  python3 engine/.rebuild_survival_smoke.py
  python3 engine/.rebuild_survival_smoke.py --bundle "/Applications/GlassPane Daemon.app"

前置不满足（非 macOS / bundle 未装 / daemon 不应答 / DR 里含 cdhash / 一个席位都没授权）
→ SKIP 并 exit 0（与 .signal_smoke.py 同口径：环境不满足不冒充失败）。前置满足而授权丢了
→ exit 1，并把恢复用备份的位置打印出来。
"""

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time

DEFAULT_BUNDLE = os.path.expanduser("~/Applications/GlassPane Daemon.app")
DEFAULT_SOCKET = os.path.expanduser("~/.glasspane/engine.sock")
HELLO_TIMEOUT_SECONDS = 40.0
SEATS = ("accessibility", "inputMonitoring", "screenRecording", "developerTools")


def codesign_output(argv):
    """codesign 把描述信息写到 stderr，与退出码无关——两路都收。"""
    proc = subprocess.run(argv, capture_output=True, text=True)
    return (proc.stdout or "") + (proc.stderr or "")


def cdhash_of(bundle):
    for line in codesign_output(["codesign", "-dvvv", bundle]).splitlines():
        if line.startswith("CDHash="):
            return line.split("=", 1)[1].strip()
    return None


def requirement_of(bundle):
    for line in codesign_output(["codesign", "-d", "-r-", bundle]).splitlines():
        if "designated =>" in line:
            return line.strip()
    return ""


def bundle_identifier(bundle):
    for line in codesign_output(["codesign", "-dvvv", bundle]).splitlines():
        if line.startswith("Identifier="):
            return line.split("=", 1)[1].strip()
    return None


def hello(socket_path, timeout=HELLO_TIMEOUT_SECONDS):
    """只读 `hello`：拿 pid / identity / permissions。读不到返回 None。"""
    request = json.dumps({"id": 0, "method": "hello"}).encode() + b"\n"
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            conn.settimeout(5)
            conn.connect(socket_path)
            conn.sendall(request)
            conn.shutdown(socket.SHUT_WR)
            buf = b""
            while True:
                chunk = conn.recv(65536)
                if not chunk:
                    break
                buf += chunk
            conn.close()
            result = json.loads(buf.decode().strip().splitlines()[0])["result"]
            return {
                "pid": result.get("pid"),
                "permissions": result.get("permissions") or {},
                "identity": result.get("identity") or {},
            }
        except Exception:  # noqa: BLE001 —— 探测到超时为止，单次失败不算结论
            time.sleep(1)
    return None


def kickstart(label):
    proc = subprocess.run(["launchctl", "kickstart", "-k", label],
                          capture_output=True, text=True)
    return proc.returncode == 0, (proc.stderr or proc.stdout or "").strip()


def describe(summary, bundle):
    if summary is None:
        return "hello=无应答 cdhash=%s" % cdhash_of(bundle)
    perms = summary["permissions"]
    return "pid=%s cdhash=%s %s" % (
        summary["pid"], cdhash_of(bundle),
        " ".join("%s=%s" % (k, perms.get(k, "-")) for k in SEATS),
    )


def granted(permissions):
    return sorted(k for k in SEATS if permissions.get(k) == "granted")


def replace_bundle(source, target):
    if os.path.isdir(target):
        shutil.rmtree(target)
    shutil.copytree(source, target, symlinks=True)


def skip(reason):
    print("SKIP：%s" % reason)
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description="重编译存活回归冒烟（P1-S8）")
    parser.add_argument("--bundle", default=DEFAULT_BUNDLE)
    parser.add_argument("--socket", default=DEFAULT_SOCKET)
    parser.add_argument("--job", default="gui/%d/com.glasspane.daemon" % os.getuid())
    args = parser.parse_args(argv)

    if sys.platform != "darwin":
        return skip("只有 macOS 有 TCC / launchd 可测")
    if not os.path.isdir(args.bundle):
        return skip("daemon bundle 未安装（%s），先跑 installer" % args.bundle)

    requirement = requirement_of(args.bundle)
    if "cdhash" in requirement:
        return skip("DR 含 cdhash（%s）——本闸只保证 identifier 形式的 DR 跨重编译存活" % requirement)
    before = hello(args.socket)
    if before is None:
        return skip("%.0fs 内读不到 hello，现网 daemon 不应答（先跑 installer --restore-launchd）"
                    % HELLO_TIMEOUT_SECONDS)
    had_grants = granted(before["permissions"])
    if not had_grants:
        return skip("当前一个席位都没授权（%s），换装后也不可能有授权可对照"
                    % describe(before, args.bundle))

    print("P1-S8 重编译存活回归：现网 bundle %s" % args.bundle)
    print("  BEFORE        %s" % describe(before, args.bundle))

    workdir = tempfile.mkdtemp(prefix="glasspane-rebuild-survival-")
    backup = os.path.join(workdir, "backup")
    shutil.copytree(args.bundle, backup, symlinks=True)
    original_hash = cdhash_of(args.bundle)
    problems = []
    try:
        # 「重编译」产物：多一条 LC_RPATH 使内容变（cdhash 必变），identifier 与 DR 不变。
        # 真跑一次 swift build 不保证字节变化（同一份源码重链常与前次逐字节相同）→ 那才是空测。
        staged = os.path.join(workdir, "staged", os.path.basename(args.bundle))
        os.makedirs(os.path.dirname(staged))
        shutil.copytree(backup, staged, symlinks=True)
        exe = os.path.join(staged, "Contents", "MacOS", "glasspaned")
        marker = os.path.join(workdir, "probe-rpath")
        tool = subprocess.run(["xcrun", "install_name_tool", "-add_rpath", marker, exe],
                              capture_output=True, text=True)
        if tool.returncode != 0:
            return skip("install_name_tool 不可用（%s）" % (tool.stderr or tool.stdout).strip())
        identifier = bundle_identifier(args.bundle) or "com.glasspane.daemon"
        sign = subprocess.run(
            ["codesign", "--force", "--sign", "-", "--identifier", identifier,
             "-r=designated => identifier \"%s\"" % identifier, staged],
            capture_output=True, text=True)
        if sign.returncode != 0:
            problems.append("重签 staged bundle 失败：%s" % (sign.stderr or sign.stdout).strip())

        staged_hash = cdhash_of(staged) if not problems else None
        if not problems and staged_hash == original_hash:
            problems.append("换装产物 cdhash 未变（%s）——空测，判不出任何事" % original_hash)
        if not problems:
            print("  换装            cdhash %s → %s（identifier=%s，DR 不含 cdhash）"
                  % (original_hash, staged_hash, identifier))
            replace_bundle(staged, args.bundle)
            ok, err = kickstart(args.job)
            if not ok:
                problems.append("换装后 kickstart 失败：%s" % err)
            after = hello(args.socket)
            if after is None:
                problems.append("换装后 %.0fs 内读不到 hello（daemon 没能起来）"
                                % HELLO_TIMEOUT_SECONDS)
            else:
                print("  AFTER-SWAP      %s" % describe(after, args.bundle))
                lost = [k for k in had_grants if after["permissions"].get(k) != "granted"]
                if lost:
                    problems.append(
                        "cdhash 变化后授权丢失：%s —— designated requirement 应只认 identifier"
                        % "、".join("%s→%s" % (k, after["permissions"].get(k, "-")) for k in lost))

        # 恢复现网产物并复验：无论上面的结论如何都必须做。
        print("  恢复原产物 …")
        replace_bundle(backup, args.bundle)
        ok, err = kickstart(args.job)
        if not ok:
            problems.append("恢复后 kickstart 失败：%s" % err)
        restored = hello(args.socket)
        if restored is None:
            problems.append("恢复后读不到 hello；备份留在 %s" % backup)
        else:
            print("  AFTER-RESTORE   %s" % describe(restored, args.bundle))
            if cdhash_of(args.bundle) != original_hash:
                problems.append("恢复后 cdhash 与初始不一致（%s ≠ %s）"
                                % (cdhash_of(args.bundle), original_hash))
            lost_back = [k for k in had_grants
                         if restored["permissions"].get(k) != "granted"]
            if lost_back:
                problems.append("恢复后授权反而丢了：%s" % "、".join(lost_back))
    finally:
        if problems:
            print("  !! 备份未删除：%s" % backup)
        else:
            shutil.rmtree(workdir, ignore_errors=True)

    if problems:
        print("REBUILD SURVIVAL FAILED（%d 项）：" % len(problems))
        for problem in problems:
            print("  - " + problem)
        return 1
    print("REBUILD SURVIVAL OK：cdhash 变更后既有授权不丢（%s），恢复后复验一致——"
          "重编译不必回系统设置重勾" % "、".join(had_grants))
    return 0


if __name__ == "__main__":
    sys.exit(main())
