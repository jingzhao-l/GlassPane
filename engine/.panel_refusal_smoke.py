#!/usr/bin/env python3
"""真机走查：面板遇到"daemon 在 hello 里自报一个不属于本账号的 program path"时，
必须拒到、并把这个拒绝说出来。

这一条不是单元测试能替的：被拒的那一屏文字与那一栏的读数（「没问」而不是假统计）只有真的
SwiftUI 面板 + 真的 AX 树能证明。做法是把面板指向一枚由本脚本自己应答 hello 的 socket，
hello 里的 `identity.binaryPath` 是 /tmp 下一份本脚本真造出来的 own-uid 文件——它过得了
"绝对路径、无控制字符"的形状规则，只有"父目录不对全体写开放"那一条拦得住它。

退出语义与 .p4i4_smoke.py 同口径：前置不满足 → 2（NOT RUN，并打印补上它的命令）；
断言全过 → 0；任一失败 → 1。
"""
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PANEL = os.path.join(HERE, ".build", "debug", "glasspane-settings")
PERMS = ["accessibility", "screenRecording", "inputMonitoring", "developerTools"]


def load_p4i4():
    """按路径把 `.p4i4_smoke.py` 当模块取进来——AX 辅助器的**唯一**一份源码住在那儿。

    从前这里只查 `/tmp/glasspane-p4i4-smoke/p4i4_helper` 在不在，不在就 NOT RUN。
    那等于把这条真机闸的可用性挂在另一条冒烟"这台机器上恰好跑过"上面：/tmp 会被清、
    机器会重启，而这条走的正是要害的那一处安全修复（面板不许 exec 对端自报的路径）。
    现在由它自己编译（swiftc 那份缓存逻辑在被复用模块里，仍是单一真源，没有第二份副本）。
    """
    import importlib.util

    source = os.path.join(HERE, ".p4i4_smoke.py")
    spec = importlib.util.spec_from_loader("gp_p4i4_smoke", loader=None)
    module = importlib.util.module_from_spec(spec)
    with open(source, encoding="utf8") as handle:
        code = compile(handle.read(), source, "exec")
    exec(code, module.__dict__)
    return module


def daemon_version():
    """hello 里那个版本号取自真源，不写死：根 package.json 是版本线的那一颗。

    写死 "1.20.0" 的话，这个文件就成了一枚版本线位点表之外的字面量——升版本时没人跟着改它，
    面板读到的自报版本与本轮发布物不同号，而这条冒烟仍然绿（它判的是"拒没拒、点名没点名"）。
    """
    with open(os.path.join(HERE, os.pardir, "package.json"), encoding="utf8") as handle:
        return json.load(handle)["version"]


def not_asked_caption():
    """「还没向后台服务问过」那句话，从渲染它的那一行 Swift 里读出来。

    草稿写死的是「没问」——面板从来没说过这两个字（实机 2026-10-23 读到的整屏里一处都没有），
    于是这条真机闸无论产品怎么表现都恒红。判据必须指向产品真的那句话，措辞将来再改时红的是
    这条冒烟，而不是一次没人看见的失败。
    """
    source = os.path.join(HERE, "Sources", "glasspane-settings", "EvidenceStatsView.swift")
    with open(source, encoding="utf8") as handle:
        text = handle.read()
    match = re.search(r"case \.notAsked:\s*\n\s*unmeasuredLine\(\"([^\"]+)\"\)", text)
    if not match:
        raise RuntimeError(f"没能在 {source} 里找到 .notAsked 那一行的文案—— SwiftUI 改了形状，"
                           "这条真机判据得跟着改，而不是改回一个屏幕上不存在的名词")
    return match.group(1)


class Peer:
    """一枚会在候选 socket 名字上回 hello 的进程——本缺陷的攻击面就是它。"""

    def __init__(self, path, binary_path, version):
        self.path = path
        self.binary_path = binary_path
        self.version = version
        self.log = []
        self._srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._srv.bind(path)
        self._srv.listen(8)
        self._stop = False
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        while not self._stop:
            try:
                conn, _ = self._srv.accept()
            except OSError:
                return
            threading.Thread(target=self._session, args=(conn,), daemon=True).start()

    def _session(self, conn):
        buf = b""
        conn.settimeout(30)
        while not self._stop:
            try:
                chunk = conn.recv(65536)
            except Exception:
                break
            if not chunk:
                break
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                reply = self._answer(line.decode("utf8", "replace"))
                if reply is None:
                    continue
                try:
                    conn.sendall(json.dumps(reply).encode() + b"\n")
                except Exception:
                    return

    def _answer(self, line):
        try:
            frame = json.loads(line)
        except json.JSONDecodeError:
            return None
        method, ident = frame.get("method"), frame.get("id")
        self.log.append(method)
        if method == "hello":
            return {"jsonrpc": "2.0", "id": ident, "result": {
                "engine": "glasspaned", "version": self.version, "protocolVersion": "0",
                "pid": os.getpid(),
                "identity": {"binaryPath": self.binary_path, "hasBundleIdentity": False},
                "permissions": {k: "granted" for k in PERMS[:3]},
                "capabilities": ["attach", "observe", "act", "assert_element", "audit_ui",
                                 "capture_view", "diagnose", "last_evidence", "snapshot",
                                 "restore", "probe_status"],
            }}
        return {"jsonrpc": "2.0", "id": ident, "error": {
            "code": "GP_E_INTERNAL", "message": "this peer answers nothing",
            "remedy": "the panel must not need this answer to be honest about the path it refused"}}

    def close(self):
        self._stop = True
        try:
            self._srv.close()
        except OSError:
            pass


def main():
    root = tempfile.mkdtemp(prefix="gp-refusal-walk-")
    sock = os.path.join(root, "engine.sock")
    payload_dir = "/tmp"
    payload = os.path.join(payload_dir, f"gp-refusal-payload-{os.getpid()}")
    panel_log = open(os.path.join(root, "panel.log"), "wb")
    panel = None
    peer = None
    failures = []
    try:
        # 前置条件先问完，再动盘：从前这里先 bind socket、先往 /tmp 写载荷、先编译辅助器，
        # 再检查面板产物在不在——于是一台没有构建的机器会留下一堆副作用然后回 2。
        if not os.path.exists(PANEL):
            print(f"NOT RUN：没有 {PANEL}。补上它：swift build --package-path {HERE}")
            return 2
        try:
            helper = load_p4i4().build_helper()
        except Exception as error:  # swiftc 缺席/编译失败都是"这台机器测不了"，不是"这条拒没了"
            print(f"NOT RUN：AX 辅助器编译失败：{error}\n补上它：xcode-select --install 后重跑 {__file__}")
            return 2
        with open(payload, "w", encoding="utf8") as handle:
            handle.write("#!/bin/sh\nexit 0\n")
        os.chmod(payload, 0o755)
        peer = Peer(sock, payload, daemon_version())
        env = dict(os.environ, GLASSPANE_ENGINE_SOCK=sock,
                   GLASSPANE_STATE_DIR=os.path.join(root, "state"))
        panel = subprocess.Popen([PANEL], env=env, stdout=panel_log, stderr=panel_log)
        deadline = time.time() + 45
        seen = None
        while time.time() < deadline:
            # `panel.pid` 是 int，subprocess 要的是 str——这一行原先直接把整数放进 argv，
            # 于是脚本在第一次读 AX 树时就 TypeError 崩掉（本机实测 2026-10-23）。
            # 崩掉的退出码是 1，与它自己的"断言失败"同一格，所以这份草稿从来没真的测过任何东西。
            out = subprocess.run([helper, "texts", str(panel.pid)], capture_output=True,
                                 text=True, timeout=30)
            try:
                seen = json.loads(out.stdout or "[]")
            except json.JSONDecodeError:
                seen = []
            blob = "\n".join(" ".join(e.get("strings", [])) for e in seen)
            if "不能被这个面板执行" in blob:
                break
            time.sleep(1.5)
        blob = "\n".join(" ".join(e.get("strings", [])) for e in (seen or []))
        if not seen:
            print("NOT RUN：AX 树为空（无登录 GUI 会话或屏幕录制/辅助功能未勾）——这一档本机测不到。\n"
                  f"补上它：在系统设置 > 隐私与安全性里勾上运行 {PANEL} 的那台终端，再重跑 {__file__}")
            return 2
        if "不能被这个面板执行" not in blob:
            failures.append("面板没有说出这次拒绝：拒绝行缺席，peer 自报的路径被静默忽略了")
        if payload not in blob:
            failures.append(f"拒绝行没有点名被拒的那个路径：{payload}")
        for forbidden in ("调试被系统拒绝",):
            if forbidden in blob:
                failures.append(f"面板把这一步说成了「{forbidden}」：这是归因错，不是拒绝")

        # 「档案统计」那一栏在**证据档案**页上，面板开在「权限」页——草稿从前只读第一屏，
        # 于是这一栏压根不在 AX 树里，判据永远读不到（实机 2026-10-23：72 个元素、零命中）。
        # 页签是显式按钮（ConsoleRootView 注释说了为什么），按它才进得去。
        caption = not_asked_caption()
        subprocess.run([helper, "press", str(panel.pid), "证据档案"], capture_output=True,
                       text=True, timeout=30)
        evidence_seen = []
        deadline = time.time() + 20
        while time.time() < deadline:
            out = subprocess.run([helper, "texts", str(panel.pid)], capture_output=True,
                                 text=True, timeout=30)
            try:
                evidence_seen = json.loads(out.stdout or "[]")
            except json.JSONDecodeError:
                evidence_seen = []
            evidence_blob = "\n".join(" ".join(e.get("strings", [])) for e in evidence_seen)
            if caption in evidence_blob:
                break
            time.sleep(1.5)
        evidence_blob = "\n".join(" ".join(e.get("strings", [])) for e in evidence_seen)
        if caption not in evidence_blob:
            failures.append("证据档案页的「档案目录统计」没有停在「还没向后台服务问过」那一格——"
                            f"拒掉路径之后这一栏要么被折算成了一次测量，要么这一页没进得去。实读：{evidence_blob[:400]}")
        print(f"peer 收到的方法序列：{peer.log[:6]}")
        print(f"AX 元素数：{len(seen)}（概览）/{len(evidence_seen)}（证据档案）；拒绝行片段：",
              next((line for line in blob.splitlines() if "不能被这个面板执行" in line), "（无）"))
        if failures:
            for line in failures:
                print("FAIL:", line)
            # 真机冒烟红的时候必须把"看到了什么"一起交出去，否则下一位读者只能重跑再猜。
            for title, body in (("概览", blob), ("证据档案", evidence_blob)):
                print(f"---- AX 全文（{title}）----")
                for line in body.splitlines():
                    if line.strip():
                        print("  ", line)
            print("---- 结束 ----")
            return 1
        print("OK：面板拒掉了 hello 自报的路径、点名了它，证据档案页那一栏仍写着「" + caption + "」")
        return 0
    finally:
        if peer is not None:
            peer.close()
        if panel is not None:
            panel.terminate()
            try:
                panel.wait(timeout=15)
            except subprocess.TimeoutExpired:
                panel.kill()
        panel_log.close()
        for path in (payload, sock):
            try:
                os.unlink(path)
            except OSError:
                pass


if __name__ == "__main__":
    sys.exit(main())
