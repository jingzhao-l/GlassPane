#!/usr/bin/env python3
"""输入监控「条目登记」真机回归闸（P1 v1.2 §11.5 / 验收项 P1-S10 的真机面）。

症状起点（2026-09-19 用户实测）：点「辅助功能」的授权按钮后，系统设置列表里**自动出现**
GlassPane Daemon 一行；点「输入监控」却什么都不出现，只能把面板顶部拖拽条手动拖进卡片。
根因是 §11.5 那条机制：`CGRequestListenEventAccess()` 与 preflight 都**不建 TCC 行**，
只有**创建事件 tap** 才让 tccd 写入该客户端的 `kTCCServiceListenEvent` 记录（记录在案 =
列表里有这一行，开关默认关）。`PermissionProbeSet.request(.inputMonitoring)` 因此加了
`ListenEventTapProbe` 一次性建/拆 tap。

本闸把这条声明变成可重复的机器判定，用**两个全新 bundle 身份**（不碰现网授权，也不依赖
人眼）：

  A 正例：新身份跑产品路径 `glasspaned --request-permission input-monitoring`
          → tccd 必须写下 `Update Access Record: kTCCServiceListenEvent for <id>`
          （并顺带核对它记的是 `CodeReq: identifier "<id>"`，即不含 cdhash 的 DR）；
  B 对照：另一个新身份只跑 `--check-input-permission`（preflight，不建 tap）
          → 必须有该身份的 `kTCCServiceListenEvent` 访问请求记录（说明真的摸到了这个席位），
            但**不得**出现 Update Access Record——否则"建行"就不是本机制的功劳。

判定面是统一日志（`/usr/bin/log show`，无需 FDA/root），跑完 `tccutil reset All <id>`
把两个临时身份的行清掉。用法：

  python3 engine/.input_monitoring_registration_smoke.py
  python3 engine/.input_monitoring_registration_smoke.py --bundle "/path/GlassPane Daemon.app"

前置不满足（非 macOS / 没有可克隆的 bundle / log 或 tccutil 不可用 / launchctl submit 失败）
→ SKIP 且 exit 0；前置满足而 A 没建行或 B 建了行 → exit 1。
"""

import argparse
import glob
import os
import plistlib
import shutil
import subprocess
import sys
import tempfile
import time

SOURCE_BUNDLE = os.path.expanduser("~/Applications/GlassPane Daemon.app")
LISTEN_EVENT = "kTCCServiceListenEvent"
LOG_POLL_SECONDS = 90.0
LOG_POLL_INTERVAL = 5.0


def run(argv, **kwargs):
    return subprocess.run(argv, capture_output=True, text=True, **kwargs)


def skip(reason):
    print("SKIP：%s" % reason)
    return 0


def make_probe_identity(source_bundle, workdir, tag, nonce):
    """把现网 daemon bundle 克隆成一个**全新签名身份**（改 CFBundleIdentifier + 重签，
    DR 形态与 make-app.sh 一致）。"""
    bundle_id = "com.glasspane.%s.%s" % (tag, nonce)
    app_dir = os.path.join(workdir, "GlassPane %s.app" % tag)
    shutil.copytree(source_bundle, app_dir, symlinks=True)
    plist_path = os.path.join(app_dir, "Contents", "Info.plist")
    with open(plist_path, "rb") as handle:
        plist = plistlib.load(handle)
    plist["CFBundleIdentifier"] = bundle_id
    plist["CFBundleName"] = "GlassPane %s" % tag
    plist["CFBundleDisplayName"] = "GlassPane %s" % tag
    with open(plist_path, "wb") as handle:
        plistlib.dump(plist, handle)
    sign = run(["codesign", "--force", "--sign", "-", "--identifier", bundle_id,
                '-r=designated => identifier "%s"' % bundle_id, app_dir])
    if sign.returncode != 0:
        raise RuntimeError("重签探针 bundle 失败：%s" % (sign.stderr or sign.stdout).strip())
    exe = os.path.join(app_dir, "Contents", "MacOS", "glasspaned")
    return bundle_id, exe


def submit_oneshot(label, exe, arguments):
    """launchctl submit 起一次性任务：责任进程是 launchd 而非本终端/本脚本，
    与产品面板走的是同一条申请路径（§11.2）。调用方负责在取证后 `launchctl remove`
    ——提前 remove 会把任务连根拔掉，登记动作就可能不发生。"""
    proc = run(["launchctl", "submit", "-l", label, "--", exe] + list(arguments))
    if proc.returncode != 0:
        raise RuntimeError("launchctl submit 失败：%s" % (proc.stderr or proc.stdout).strip())


def tccd_lines(bundle_id, since):
    """取 since 之后 tccd 里提到该身份的所有行。"""
    proc = run(["/usr/bin/log", "show", "--start", since, "--info", "--debug",
                "--predicate", 'process == "tccd" AND eventMessage CONTAINS[c] "%s"' % bundle_id,
                "--style", "compact"])
    if proc.returncode != 0:
        raise RuntimeError("log show 失败：%s" % (proc.stderr or proc.stdout).strip())
    return (proc.stdout or "") + (proc.stderr or "")


def wait_for(predicate, bundle_id, since, timeout=LOG_POLL_SECONDS):
    """轮询统一日志直到 predicate 命中（tccd 落盘有延迟），返回命中的那批行。"""
    deadline = time.time() + timeout
    seen = ""
    while time.time() < deadline:
        seen = tccd_lines(bundle_id, since)
        hits = [line.strip() for line in seen.splitlines() if predicate(line)]
        if hits:
            return hits
        time.sleep(LOG_POLL_INTERVAL)
    return []


def quote(text, limit=150):
    return text[:limit].replace("\n", " ")


def case_register(workdir, source_bundle, nonce, started):
    """A 正例：产品申请路径必须让 TCC 建出该身份的输入监控行。

    副作用如实入闸：探针是一次**完整的 daemon 启动**（`--request-permission` 之后才轮到
    socket 那套），它会顺带以自己的身份查辅助功能席位，可能给该身份留一行。因此本例额外
    要求那一行是 **Denied**（只是登记、没有真授权），并确认探针进程已退出——tap 只存在于
    那个已退出的进程里，不存在"观测者真的开始抓输入"。
    """
    tag = "improbe"
    bundle_id, exe = make_probe_identity(source_bundle, workdir, tag, nonce)
    label = "com.glasspane.improbe.guide.%s" % nonce
    submit_oneshot(label, exe, ["--request-permission", "input-monitoring"])
    hits = wait_for(lambda line: "Update Access Record" in line and LISTEN_EVENT in line
                    and bundle_id in line, bundle_id, started)
    asked = [line.strip() for line in tccd_lines(bundle_id, started).splitlines()
             if "Handling access request to %s" % LISTEN_EVENT in line and bundle_id in line]
    blob = tccd_lines(bundle_id, started)
    run(["launchctl", "remove", label])  # 取证之后再摘定义，提前 remove 会把任务连根拔掉
    if not hits:
        return bundle_id, ["正例未建行：%.0fs 内没有 "
                           "'Update Access Record: %s for %s'（用户症状复现：列表里不会出现条目）"
                           % (LOG_POLL_SECONDS, LISTEN_EVENT, bundle_id)]
    problems = []
    print("  A 正例建行：%s" % quote(hits[0]))
    if 'CodeReq: identifier "%s"' % bundle_id not in blob:
        problems.append("建行日志里没有 'CodeReq: identifier \"%s\"'——"
                        "TCC 记的 DR 形态与本仓约定不符，需复核 make-app.sh" % bundle_id)
    if not asked:
        problems.append("正例未取得该身份的 %s 访问请求行——建行与申请路径的关联未证实" % LISTEN_EVENT)

    # ① 副作用入闸：全量 daemon 启动只允许给探针身份留「未授权」的行。
    a11y = [line for line in blob.splitlines()
            if "Update Access Record" in line and "kTCCServiceAccessibility" in line
            and bundle_id in line]
    for line in a11y:
        if "Allowed" in line:
            problems.append("探针身份的辅助功能行被写成 Allowed：%s —— "
                            "A 案例的观测者身份不再干净，探针不得顺带取得真实席位" % quote(line))
        else:
            print("  A 副作用（如实登记为未授权）：%s" % quote(line))
    lingering = run(["pgrep", "-f", os.path.join(workdir, "glasspaned")]).stdout.strip()
    if not lingering:
        lingering = run(["pgrep", "-f", workdir]).stdout.strip()
    if lingering:
        problems.append("探针 daemon 仍在运行（pid %s）——事件 tap 只应存在于已退出的探针进程里"
                        % " ".join(lingering.split()))
    return bundle_id, problems


def case_control(workdir, source_bundle, nonce, started):
    """B 对照：preflight 只读数、不建行——否则 A 的因果不成立。"""
    tag = "imctl"
    bundle_id, exe = make_probe_identity(source_bundle, workdir, tag, nonce)
    label = "com.glasspane.imctl.guide.%s" % nonce
    submit_oneshot(label, exe, ["--check-input-permission"])
    asked = wait_for(lambda line: "Handling access request to %s" % LISTEN_EVENT in line
                     and bundle_id in line, bundle_id, started)
    time.sleep(3)  # 给"如果会建行"的写入留出超过轮询间隔的时间
    blob = tccd_lines(bundle_id, started)
    run(["launchctl", "remove", label])
    created = [line for line in blob.splitlines()
               if "Update Access Record" in line and LISTEN_EVENT in line and bundle_id in line]
    if not asked:
        return bundle_id, ["对照未取得该身份的 %s 访问请求行——它压根没摸到这个席位，"
                           "\"没建行\"因此不构成因果证据" % LISTEN_EVENT]
    print("  B 对照摸到席位：%s" % quote(asked[0]))
    if created:
        return bundle_id, ["对照（仅 preflight）竟然也建了行：%s —— "
                           "说明建行不依赖事件 tap，§11.5 机制声明与 ListenEventTapProbe 的必要性都要重判"
                           % quote(created[0])]
    print("  B 对照未建行（符合预期：preflight 不登记条目）")
    return bundle_id, []


def cleanup_identity(bundle_id):
    proc = run(["tccutil", "reset", "All", bundle_id])
    ok = proc.returncode == 0
    if not ok:
        print("  !! tccutil 清理失败（%s）：%s；手工命令 tccutil reset All %s"
              % (bundle_id, quote((proc.stderr or proc.stdout).strip()), bundle_id))
    return ok


def main(argv=None):
    parser = argparse.ArgumentParser(description="输入监控条目登记真机回归闸（P1-S10）")
    parser.add_argument("--bundle", default=SOURCE_BUNDLE,
                        help="用于克隆身份的现网 daemon bundle")
    parser.add_argument("--keep-workdir", action="store_true",
                        help="保留探针 bundle 目录（排查/复核用；默认成功即删除）")
    args = parser.parse_args(argv)

    if sys.platform != "darwin":
        return skip("只有 macOS 有 TCC / tccd 日志可判")
    if not os.path.isdir(args.bundle):
        return skip("没有现网 daemon bundle（%s）——探针身份需要一个签名有效的 bundle 作模板" % args.bundle)
    if not os.path.exists("/usr/bin/log"):
        return skip("没有 /usr/bin/log，取不到 tccd 判定面")
    if run(["which", "tccutil"]).returncode != 0:
        return skip("没有 tccutil，无法清理临时身份（不留残行是硬要求）")
    if run(["launchctl", "print", "gui/%d" % os.getuid()]).returncode != 0:
        return skip("launchd 用户域不可达，无法以独立责任进程起一次性任务")

    workdir = tempfile.mkdtemp(prefix="glasspane-im-registration-")
    nonce = "%d-%d" % (int(time.time()), os.getpid())
    started = time.strftime("%Y-%m-%d %H:%M:%S")
    probe_ids = []
    problems = []
    print("P1-S10 输入监控条目登记回归：模板 bundle %s，工作目录 %s" % (args.bundle, workdir))
    try:
        probe_id, case_problems = case_register(workdir, args.bundle, nonce, started)
        probe_ids.append(probe_id)
        problems += case_problems
        control_id, control_problems = case_control(workdir, args.bundle, nonce, started)
        probe_ids.append(control_id)
        problems += control_problems
    except Exception as exc:  # noqa: BLE001 —— 任何一步跑不通都如实退出，不留临时身份
        problems.append("执行失败：%s" % exc)
    finally:
        for probe_id in probe_ids:
            cleanup_identity(probe_id)
        leftovers = glob.glob(os.path.join(workdir, "*.app"))
        if problems and leftovers:
            print("  !! 工作目录未删除（含探针 bundle，可用于排查）：%s" % workdir)
        else:
            shutil.rmtree(workdir, ignore_errors=True)

    if problems:
        print("INPUT MONITORING REGISTRATION FAILED（%d 项）：" % len(problems))
        for problem in problems:
            print("  - " + problem)
        return 1
    print("INPUT MONITORING REGISTRATION OK：产品申请路径写出 %s 记录（系统设置列表即出现条目，"
          "无需拖拽）；仅 preflight 的对照身份摸到席位却不建行" % LISTEN_EVENT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
