#!/usr/bin/env python3
"""bridge/test_bridge.py — P6 §6.6: pure-logic unit tests for the LLDB
bridge (queue policy, JSON assembly, truncation, sentinel extraction, argv
composition, socket回传). No debug permission needed — run with:

    python3 -m unittest discover -s bridge -p 'test_*.py'
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


if __name__ == "__main__":
    unittest.main()
