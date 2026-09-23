#!/usr/bin/env python3
"""bridge/test_bridge.py — P6 §6.6: pure-logic unit tests for the LLDB
bridge (queue policy, JSON assembly, truncation, sentinel extraction, argv
composition, socket回传, 退出码判据). No debug permission needed.

三种跑法都跑**全部**用例（P6 §6.6 口径是 python3 直跑，P1 §CI 用 pytest）：

    python3 bridge/test_bridge.py
    python3 -m unittest discover -s bridge -p 'test_*.py'
    python3 -m pytest -q

`if __name__ == "__main__"` 守卫必须留在**文件物理末尾**：任何定义在它之后的
用例，直跑与 unittest discover 两种口径都不会执行（曾有两例栽在这里）。
"""

import json
import os
import socket
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import glasspane_bridge as gb  # noqa: E402


class WatchQueuePolicy(unittest.TestCase):
    """§6.5: 4 hardware slots, FIFO overflow ≤64, exhaustion refused."""

    def test_first_four_arm_with_slot_indices(self):
        queue = gb.WatchQueue()
        for index in range(4):
            outcome, detail = queue.add({"addr": "0x%x" % index})
            self.assertEqual(outcome, "armed")
            self.assertEqual(detail, index)
        snapshot = queue.snapshot()
        self.assertEqual(len(snapshot["slots"]), 4)
        self.assertEqual(snapshot["queued"], [])

    def test_fifth_is_queued_then_arms_on_slot_release(self):
        queue = gb.WatchQueue()
        for index in range(4):
            queue.add({"addr": "0x%x" % index})
        outcome, position = queue.add({"addr": "0xffee"})
        self.assertEqual(outcome, "queued")
        self.assertEqual(position, 1)
        armed = queue.take_slot(freed_index=2)
        self.assertEqual(armed["addr"], "0xffee")
        self.assertEqual(armed["hwSlot"], 2)

    def test_queue_limit_rejects_with_counter(self):
        queue = gb.WatchQueue(slots=1, limit=2)
        queue.add({"addr": "0x1"})
        queue.add({"addr": "0x2"})
        queue.add({"addr": "0x3"})
        outcome, reason = queue.add({"addr": "0x4"})
        self.assertEqual(outcome, "rejected")
        self.assertIn("full", reason)
        self.assertEqual(queue.snapshot()["rejected"], 1)

    def test_hit_counts_recorded(self):
        queue = gb.WatchQueue()
        queue.record_hit("0xabc")
        queue.record_hit("0xabc")
        self.assertEqual(queue.snapshot()["hits"], [{"addr": "0xabc", "hitCount": 2}])


class Truncation(unittest.TestCase):
    def test_short_value_untouched(self):
        text, clipped = gb.truncate("hello")
        self.assertEqual((text, clipped), ("hello", False))

    def test_long_value_marked_and_bounded(self):
        text, clipped = gb.truncate("x" * 300, limit=256)
        self.assertTrue(clipped)
        self.assertLessEqual(len(text.encode("utf-8")), 256 + len("...[truncated]".encode("utf-8")))
        self.assertTrue(text.endswith("...[truncated]"))


class ResultShape(unittest.TestCase):
    def test_keys_complete_and_deterministic(self):
        payload = gb.assemble_result(
            mode="capture", target={"pid": 7}, status="stopped",
            threads=[{"id": 1, "name": "", "queue": "", "stopReason": "signal", "frames": []}],
        )
        for key in ("mode", "target", "status", "stopReason", "threads",
                    "registers", "crash", "watchpoints", "errors"):
            self.assertIn(key, payload)
        self.assertEqual(payload["registers"], {})
        self.assertIsNone(payload["crash"])
        # Deterministic rendering (§6.1): two dumps byte-equal.
        self.assertEqual(gb.render_json(payload), gb.render_json(payload))
        self.assertTrue(gb.render_json(payload).startswith('{"crash"'))  # sorted keys

    def test_frame_record_locals_capped(self):
        frame = gb.frame_record(0, "App", "0x1000", locals_=[("v%d" % i, str(i)) for i in range(40)])
        self.assertLessEqual(len(frame["locals"]), gb.MAX_LOCALS)

    def test_thread_cap(self):
        threads = [{"id": i, "frames": []} for i in range(100)]
        payload = gb.assemble_result(mode="capture", target={}, status="s", threads=threads)
        self.assertEqual(len(payload["threads"]), gb.MAX_THREADS)


class SentinelExtraction(unittest.TestCase):
    def test_payload_extracted_among_lldb_noise(self):
        payload = {"mode": "capture", "status": "stopped"}
        stdout = "(lldb) run\nProcess 7 stopped\n" + gb.SENTINEL_BEGIN + json.dumps(payload) + gb.SENTINEL_END + "\n(lldb) quit\n"
        found, raw = gb.extract_sentinel(stdout)
        self.assertEqual(found, payload)

    def test_missing_sentinel_returns_none(self):
        found, raw = gb.extract_sentinel("no capture here")
        self.assertIsNone(found)

    def test_malformed_payload_returns_none(self):
        stdout = gb.SENTINEL_BEGIN + "{not json" + gb.SENTINEL_END
        found, _raw = gb.extract_sentinel(stdout)
        self.assertIsNone(found)


class ArgvComposition(unittest.TestCase):
    def test_launch_capture_uses_sb_driver_script(self):
        argv = gb.build_lldb_argv("/abs/bridge.py", mode="capture", exe="/tmp/crashme")
        self.assertEqual(argv[:2], ["xcrun", "lldb"])
        self.assertIn("--file", argv)
        commands = [argv[i + 1] for i, token in enumerate(argv) if token == "-o"]
        self.assertIn("command script import /abs/bridge.py", commands[0])
        # Batch would end at the crash stop → one script command drives it all.
        self.assertTrue(any("run_capture_cli" in c for c in commands))
        self.assertNotIn("run", commands)

    def test_attach_capture_uses_pid_and_detaches(self):
        argv = gb.build_lldb_argv("/b.py", mode="capture", pid=4242)
        self.assertIn("-p", argv)
        self.assertNotIn("--attach", argv)  # lldb 无此选项：unknown-option 伪装成权限失败的真机教训
        self.assertIn("4242", argv)
        self.assertIn("detach", argv)
        self.assertNotIn("run", argv)  # attach must never relaunch

    def test_trace_forwards_sample_count(self):
        argv = gb.build_lldb_argv("/b.py", mode="trace", pid=1, samples=9)
        self.assertTrue(any("gp-trace --samples 9" in token for token in argv))


class SocketDelivery(unittest.TestCase):
    """§6.2: --send-sock回传 is a real one-frame NDJSON write."""

    def test_emit_sends_frame_to_unix_socket(self):
        with tempfile.TemporaryDirectory() as tmp:
            sock_path = os.path.join(tmp, "s.sock")
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(sock_path)
            server.listen(1)
            received = {}

            def accept():
                conn, _ = server.accept()
                received["data"] = conn.recv(65536)
                conn.close()

            thread = threading.Thread(target=accept)
            thread.start()
            payload = {"mode": "capture", "status": "stopped"}
            gb.emit(payload, send_sock=sock_path)
            thread.join(timeout=5)
            server.close()
            self.assertEqual(json.loads(received["data"].decode("utf-8").strip()), payload)
            self.assertTrue(received["data"].endswith(b"\n"))

    def test_emit_writes_out_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "payload.json")
            gb.emit({"mode": "trace"}, out_path=out)
            with open(out, encoding="utf-8") as handle:
                self.assertEqual(json.loads(handle.read()), {"mode": "trace"})


# ---------------------------------------------------------------------------
# 退出码判定：零线程的"成功"不是成功（外层 run 用 capture_succeeded 决定退出码）
# A-11 的残余风险是"白名单押在枚举的字符串渲染上"，所以这里钉的是**归一器**
# 的等价关系，而不是某张字面量表：结论若依赖具体 int 数值，注入表会立刻变红。
# 注：这些用例必须是 TestCase 方法——`python3 bridge/test_bridge.py` 与
# `python3 -m unittest discover` 都只收集 TestCase，模块级 test_* 函数只有
# pytest 会跑（第一版的两条就因此从未在文档口径下执行过）。
# ---------------------------------------------------------------------------

class CaptureExitCodeGuard(unittest.TestCase):
    """capture_succeeded 判定表 + 进程状态归一器（纯逻辑，本机无 lldb）。"""

    # 一张刻意与 LLDB 取值毫无关系的表（序号自 900 起）。用它跑通的等价关系，
    # 才证明判据真的与数值无关——只在镜像表上跑通证明不了这一点。
    EXOTIC = {name: 900 + index for index, name in enumerate(gb.PROCESS_STATE_NAMES)}

    def tables(self):
        return {"fallback": None, "exotic": self.EXOTIC}

    def test_whitelist_names_are_real_declared_states(self):
        # 白名单里打错一个字母 = 永不匹配 = 每次真机采集假红，先钉住拼写面。
        for name in gb._OK_STATE_NAMES:
            self.assertIn(name, gb.PROCESS_STATE_NAMES)

    def test_state_int_by_name_is_injective_and_complete(self):
        table = gb.state_int_by_name()
        self.assertEqual(sorted(table), sorted(gb.PROCESS_STATE_NAMES))
        self.assertEqual(len(set(table.values())), len(table))  # 两名一值=判据撞车

    def test_normalize_state_accepts_int_bare_and_qualified_forms(self):
        for label, table in self.tables().items():
            resolved_table = table or gb.state_int_by_name()
            for name, value in resolved_table.items():
                for rendering in (value, str(value), name, "lldb." + name,
                                  "StateType." + name):
                    _int, resolved = gb.normalize_state(rendering, table)
                    self.assertEqual(resolved, name, (label, rendering, name))

    def test_state_matches_equivalence_over_the_whole_table(self):
        # 用户口径：state_matches(<eStateStopped 的 int>, "eStateStopped") 这类
        # 等价关系要在**整张表**上成立，且换一张数值完全不同的表照样成立。
        for label, table in self.tables().items():
            for name, value in (table or gb.state_int_by_name()).items():
                self.assertTrue(
                    gb.state_matches(value, name, table), (label, value, name))
                self.assertTrue(
                    gb.state_matches(name, value, table), (label, name, value))
                self.assertTrue(
                    gb.state_matches("lldb." + name, name, table), (label, name))
                for other in gb.PROCESS_STATE_NAMES:
                    if other != name:
                        self.assertFalse(
                            gb.state_matches(value, other, table),
                            (label, name, other))  # 相邻状态不得互相串味

    def test_unresolvable_status_normalizes_to_nothing(self):
        for junk in ("no-process", "exited-before-stop", "failed", "",
                     "eStateStoppedNot", None, True, False, [], {}):
            self.assertEqual(gb.normalize_state(junk), (None, None), junk)
        self.assertFalse(gb.state_matches("eStateStoppedNot", "eStateStopped"))

    def test_capture_succeeded_requires_stopped_state_and_threads(self):
        stopped = gb.state_int_by_name()["eStateStopped"]
        self.assertTrue(gb.capture_succeeded(
            {"status": "eStateStopped", "threads": [{"id": 1}]}))
        # 同一状态的三种写法必须给同一个判决（A-11 押的就是这里）。
        for rendering in (stopped, str(stopped), "lldb.eStateStopped"):
            self.assertTrue(gb.capture_succeeded(
                {"status": rendering, "threads": [{"id": 1}]}), rendering)
        # 这些形态此前全部以 0 退出，下游读到的是"成功但零线程"。
        for payload in (
            {"status": "no-process", "threads": []},
            {"status": "eStateRunning", "threads": []},
            {"status": "exited-before-stop", "threads": []},
            {"status": "failed", "threads": [{"id": 1}]},
            {"status": "eStateStopped", "threads": []},
            {"status": "lldb.eStateRunning", "threads": [{"id": 1}]},
            {},
            None,
        ):
            self.assertFalse(gb.capture_succeeded(payload), payload)

    def test_empty_threads_stopped_state_is_a_failure(self):
        # 状态对了但什么都没采到 —— 这正是 A-11 要拦的那一类假成功。
        stopped = gb.state_int_by_name()["eStateStopped"]
        for payload in (
            {"status": "eStateStopped", "threads": []},
            {"status": "eStateAttached", "threads": []},
            {"status": stopped, "threads": []},
            {"status": "lldb.eStateStopped", "threads": []},
            {"status": "eStateStopped"},                      # threads 缺席
            {"status": "eStateStopped", "threads": None},
        ):
            self.assertFalse(gb.capture_succeeded(payload), payload)

    def test_capture_succeeded_accepts_attached_with_threads(self):
        attached = gb.state_int_by_name()["eStateAttached"]
        self.assertTrue(gb.capture_succeeded(
            {"status": "eStateAttached", "threads": [{"id": 9}]}))
        self.assertTrue(gb.capture_succeeded(
            {"status": attached, "threads": [{"id": 9}]}))


if __name__ == "__main__":
    unittest.main()
