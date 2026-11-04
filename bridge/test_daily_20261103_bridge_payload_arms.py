"""2026-11-03 第二轮：桥的**四条臂**各自要不要接得住，用桩与真进程各量一遍。

这五条用例是"发现即证据"的那一半：每条都在指一个具体的失效形状，而不是一句风格意见。

1. 超时臂把已经到手的采丢弃掉（`run_child_captured` 特意留下的字节，`run_outer` 从不读）。
2. `_async_mode` 问的是 `SBDebugger.GetAsyncMode`——本机真 lldb 实测只有 `GetAsync`
   （`HAS_GetAsync=True HAS_GetAsyncMode=False`），所以那一格在生產上恒为"没测到"，
   而桩里却供着 `GetAsyncMode`（`test_bridge.py:1786`）＝给一门不存在的能力作背书。
3. "lldb 没吐载荷"那一臂不唤醒被 SIGSTOP 停住的目标，而兄弟两臂（异常臂、超时臂）都唤醒。
4. 载荷是 JSON 而不是 dict 时（目标自己打印出 `GPBRIDGE<n><[1,2,3]>GPBRIDGE`），
   `payload.setdefault` 以 traceback 离场：§6.2「失败也要有形状」被破。
5. `cmd_capture` 没有兄弟 `run_capture_cli_b64` 那层 guard：`_payload_via_debugger` 一抛，
   lldb 里留 traceback，外层桥读成"没有载荷"，然后把病因写成"去勾 Developer Tools"。
"""
import contextlib
import io
import json
import os
import signal
import subprocess
import sys
import time
import types
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import glasspane_bridge as gb  # noqa: E402


def emitted_payload(stdout_text):
    """外层桥打在 stdout 上的那一载荷，用**产品自己的读者**取（`extract_sentinel`）。

    从前这一支按"整行以 `{` 起、以 `}` 止"扫：而 `emit()` 写的是
    `GPBRIDGE<<{...}>>GPBRIDGE`（本文件其余部分与 §"R30 标记"都是这么交付的），
    于是这个 helper 对真输出**一条也命中不了**——那四条用例测的是一份想象中的形状，
    不是桥真正交回的那一份。夹具必须来自真报文，所以解码也走真读者。
    """
    payload, _raw = gb.extract_sentinel(stdout_text)
    if payload is None:
        raise AssertionError("桥没有以带哨兵的 JSON 离场。stdout=%r" % stdout_text[:400])
    return payload


def good_capture(pid=4242):
    return gb.assemble_result(
        mode="capture",
        target={"pid": pid, "exe": None},
        status="eStateStopped",
        threads=[{"id": 1, "frameCount": 1, "crashed": True}],
        errors=[],
        crash={"signal": "SIGSEGV", "instruction": "0x1000"},
    )


class TimeoutArmMustNotDiscardADeliveredCapture(unittest.TestCase):
    def test_a_full_sentinel_pair_in_the_timeout_bytes_is_the_answer(self):
        """lldb 把整份崩溃采打完了才卡在 `-o detach` 上：字节留着，判决也必须留着。"""
        seen = {}

        def fake_child(argv, timeout, env=None):
            nonce = (env or {}).get(gb.SENTINEL_NONCE_ENV)
            seen["nonce"] = nonce
            payload = good_capture()
            # 形状取自生产：`_sentinel` 走的是 `wrap_sentinel(render_json(payload), nonce=…)`。
            # 直接 dict 交给 wrap_sentinel 会得到 Python repr（单引号），`extract_sentinel` 的
            # json.loads 认不出来——那是一份桩里的假形状，会让这条用例永远只能靠"读不到载荷"过。
            bytes_kept = ("some lldb noise\n"
                          + gb.wrap_sentinel(gb.render_json(payload), nonce=nonce) + "\n")
            return gb._Completed(-9, bytes_kept, ""), True

        out = io.StringIO()
        with mock.patch.object(gb, "run_child_captured", side_effect=fake_child), \
                mock.patch.object(gb, "resume_frozen_target", return_value=(True, "stubbed")),\
                contextlib.redirect_stdout(out):
            code = gb.main(["capture", "--pid", "4242", "--timeout", "1"])
        emitted = emitted_payload(out.getvalue())
        joined = " ".join(emitted.get("errors", []))
        self.assertEqual(
            "eStateStopped", emitted.get("status"),
            "超时臂交回的不是那份已经读到的采，而是一条『lldb 没产出采』的判决：%s" % joined)
        self.assertIsNotNone(emitted.get("crash"), emitted)
        self.assertNotIn("did not produce a capture", joined,
                         "手里有采却说没采到——这是把已知写成未知")
        self.assertIn("timeout", joined.lower(),
                      "用了这份采仍要写明那一趟是被超时收掉的：%s" % joined)
        self.assertIn(code, (0, 1, 3), code)


class AsyncFlagMustReadTheNameRealBindingsHave(unittest.TestCase):
    def test_getasync_is_the_name_xcrun_lldb_actually_exposes(self):
        class OnlyGetAsync:
            def __init__(self, value):
                self.value = value

            def GetAsync(self):
                return self.value

        self.assertTrue(gb._async_mode(OnlyGetAsync(True)) is True,
                        "真 binding 只有 GetAsync：读不到就是恒『没测到』，那这扇门从没开过")
        self.assertFalse(gb._async_mode(OnlyGetAsync(False)) is False and
                         gb._async_mode(OnlyGetAsync(True)) is None,
                         "False 与『没测到』必须是两个答案")

    def test_a_binding_with_neither_name_still_answers_unmeasured(self):
        self.assertIsNone(gb._async_mode(types.SimpleNamespace()),
                          "两个名字都没有时仍然要答『没测到』，不许编一个 False 回写")


class NoPayloadArmMustWakeTheStoppedTarget(unittest.TestCase):
    def _stopped_child(self):
        child = subprocess.Popen(
            [sys.executable, "-c", "import time\nwhile True: time.sleep(0.2)"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(50):
            os.kill(child.pid, signal.SIGSTOP)
            time.sleep(0.02)
            if gb._process_is_stopped(child.pid):
                break
        self.assertTrue(gb._process_is_stopped(child.pid), "夹具没能把一个进程停住")
        return child

    def test_a_nonzero_lldb_exit_after_attach_wakes_the_pid(self):
        child = self._stopped_child()
        try:
            empty = gb._Completed(1, "", "error: attach failed")
            out = io.StringIO()
            with mock.patch.object(gb, "run_child_captured",
                                   side_effect=lambda *a, **k: (empty, False)), \
                    contextlib.redirect_stdout(out):
                gb.main(["capture", "--pid", str(child.pid), "--timeout", "1"])
            joined = " ".join(emitted_payload(out.getvalue()).get("errors", []))
            self.assertTrue(
                gb._process_is_stopped(child.pid) is False,
                "载荷之外还要有动作：调试器已经退出，被附着的进程仍停在 SIGSTOP 上（errors=%s）"
                % joined[:200])
        finally:
            with contextlib.suppress(ProcessLookupError):
                os.kill(child.pid, signal.SIGCONT)
            child.terminate()
            with contextlib.suppress(subprocess.TimeoutExpired):
                child.wait(timeout=5)


class AJsonThatIsNotADictMustStillLeaveWithAShape(unittest.TestCase):
    def test_a_list_payload_with_a_budget_note_does_not_traceback(self):
        def fake_child(argv, timeout, env=None):
            nonce = (env or {}).get(gb.SENTINEL_NONCE_ENV)
            text = "target printed: " + gb.wrap_sentinel(gb.render_json([1, 2, 3]), nonce=nonce)
            return gb._Completed(0, text, ""), False

        out, err = io.StringIO(), io.StringIO()
        env = {"GPBRIDGE_BUDGET": "not-a-number"}
        with mock.patch.object(gb, "run_child_captured", side_effect=fake_child), \
                mock.patch.dict(os.environ, env, clear=False), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = gb.main(["capture", "--pid", "4242", "--timeout", "1"])
        self.assertEqual("", err.getvalue(),
                         "§6.2 要求失败也有形状，这里交回的是 traceback：%s" % err.getvalue()[:300])
        emitted = emitted_payload(out.getvalue())
        self.assertEqual("failed", emitted.get("status"), emitted)
        joined = " ".join(emitted.get("errors", []))
        self.assertIn("list", joined.lower(),
                      "要说清楚读到了什么形状，不能含糊成『没有载荷』：%s" % joined[:200])
        self.assertIn(code, (1, 2), code)


class CmdCaptureNeedsTheSameGuardAsItsSibling(unittest.TestCase):
    def test_a_raising_payload_emits_a_wrapped_failure_not_a_traceback(self):
        printed = []
        result = types.SimpleNamespace(AppendMessage=printed.append)

        def boom(debugger, mode, *a, **k):
            raise RuntimeError("frame list exploded")

        with mock.patch.object(gb, "_payload_via_debugger", side_effect=boom), \
                contextlib.redirect_stdout(io.StringIO()):
            try:
                gb.cmd_capture(types.SimpleNamespace(), "", result, {})
                raised = None
            except Exception as error:  # noqa: BLE001 - 这一条就是在问它会不会抛
                raised = error
        self.assertIsNone(raised,
                          "cmd_capture 抛出去＝lldb 里留一段 traceback，外层桥只能读成『没有载荷』，"
                          "再把病因写成『去勾 Developer Tools』：%r" % raised)
        joined = "\n".join(printed)
        self.assertIn("GPBRIDGE", joined, "守卫必须交回一份带哨兵的载荷，而不是一句人话：%r" % joined[:200])


if __name__ == "__main__":
    unittest.main(verbosity=2)
