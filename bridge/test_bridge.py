#!/usr/bin/env python3
"""bridge/test_bridge.py — P6 §6.6: pure-logic unit tests for the LLDB
bridge (queue policy, JSON assembly, truncation, sentinel extraction, argv
composition, socket回传, 退出码判据, 外层交付 `_payload_from_process` /
`reconcile_watchpoint_stops` / `cmd_*` 用 SB 形状桩驱动, capture-sample 与发射器
同形). No debug permission needed.

真机那三条（停因表、路径形态导入、崩溃现场）仍是 opt-in；本文件里凡是被验的是
**判定**而不是硬件调用的地方，都走 SB-API 形状的桩（见 §"SB-API 形状的桩"一节），
`xcrun lldb` 真跑不进默认泳道。

三种跑法都跑**全部**用例（P6 §6.6 口径是 python3 直跑，P1 §CI 用 pytest）：

    python3 bridge/test_bridge.py
    python3 -m unittest discover -s bridge -p 'test_*.py'
    python3 -m pytest -q

`if __name__ == "__main__"` 守卫必须留在**文件物理末尾**：任何定义在它之后的
用例，直跑与 unittest discover 两种口径都不会执行（曾有两例栽在这里）。
"""

import base64
import contextlib
import io
import json
import os
import re
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest import mock

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

    def test_a_hit_is_credited_to_the_ledger_generation_that_was_armed(self):
        queue = gb.WatchQueue()
        queue.add({"addr": "0xabc"})
        queue.mark_live("0xabc")
        self.assertEqual(queue.armed[0]["seq"], queue.record_hit("0xabc"))
        queue.record_hit("0xabc")
        self.assertEqual(queue.snapshot()["hits"],
                         [{"addr": "0xabc", "seq": queue.armed[0]["seq"], "hitCount": 2}])
        self.assertEqual(2, queue.records()[0]["hitCount"])

    def test_a_hit_for_an_address_with_nothing_armed_credits_no_entry(self):
        """B-05: the ledger used to accept a hit for any address at all, which put
        a number on whatever entry happened to hold that address."""
        queue = gb.WatchQueue()
        queue.add({"addr": "0xabc"})
        queue.mark_live("0xabc")
        self.assertIsNone(queue.record_hit("0xdead"))
        self.assertIsNone(queue.record_hit("0xdead"))
        self.assertEqual([], queue.snapshot()["hits"])
        self.assertEqual([{"addr": "0xdead", "stopCount": 2}],
                         queue.snapshot()["unattributedHits"])
        self.assertEqual(0, queue.records()[0]["hitCount"])
        self.assertTrue(any("credits no ledger entry" in note for note in queue.notes),
                        queue.notes)
        self.assertIn("matched no armed ledger entry", "\n".join(queue.integrity_notes()))

    def test_a_stop_at_a_spent_address_is_not_charged_to_a_later_entry(self):
        queue = gb.WatchQueue(slots=1, limit=4)
        queue.add({"addr": "0xabc"})
        queue.mark_live("0xabc")
        queue.record_hit("0xabc")
        queue.release("0xabc")
        self.assertIsNone(queue.record_hit("0xabc"))
        self.assertEqual(1, queue.records()[0]["hitCount"])
        self.assertEqual([{"addr": "0xabc", "stopCount": 1}],
                         queue.snapshot()["unattributedHits"])
        self.assertIn("spent", "\n".join(queue.notes))


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
        # Determinism (§6.1) has to be *observable*: `render_json(payload) ==
        # render_json(payload)` compares a value with itself and can never go red.
        # The property the contract actually claims is that the bytes do not depend
        # on dict insertion order, so the second dump is the same payload written
        # backwards — which is exactly what `sort_keys=True` buys (and reverting it
        # makes this assertion fail).
        backwards = dict(reversed(list(payload.items())))
        self.assertEqual(gb.render_json(payload), gb.render_json(backwards))
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

    def test_forged_earlier_pair_loses_to_the_real_payload(self):
        """B-27: the target's own stdout shares lldb's stdout (crashcanary.swift
        prints every run), so a pair emitted *before* the bridge's must not win —
        the old first-match `find` handed back the forgery and flipped the verdict."""
        forged = {"mode": "capture", "status": "eStateStopped",
                  "threads": [{"id": 1, "frames": [{"fake": True}]}]}
        real = {"mode": "capture", "status": "eStateStopped",
                "threads": [{"id": 7, "frames": [{"function": "real"}]}]}
        stdout = ("(lldb) run\n" + gb.wrap_sentinel(json.dumps(forged)) +
                  "\ntarget noise\n" + gb.wrap_sentinel(json.dumps(real)) + "\n(lldb) quit\n")
        found, _raw = gb.extract_sentinel(stdout)
        self.assertEqual(found, real)
        self.assertTrue(gb.capture_succeeded(found))

    def test_late_malformed_pair_does_not_mask_the_real_payload(self):
        """"Last" means last *parseable*: a broken pair appended after the real one
        must not turn the capture into "no payload"."""
        real = {"mode": "capture", "status": "eStateStopped", "threads": [{"id": 7}]}
        stdout = (gb.wrap_sentinel(json.dumps(real)) + "\n" +
                  gb.wrap_sentinel("{truncated by the pipe"))
        found, _raw = gb.extract_sentinel(stdout)
        self.assertEqual(found, real)

    def test_marker_must_carry_this_runs_nonce(self):
        """The fixed marker is public: any captured process can print it. A run
        nonce makes the real pair unguessable, and the nonce-less forgery inert."""
        nonce = gb.new_sentinel_nonce()
        forged = {"mode": "capture", "status": "eStateStopped",
                  "threads": [{"id": 1, "frames": [{"fake": True}]}]}
        real = {"mode": "capture", "status": "eStateStopped",
                "threads": [{"id": 7, "frames": [{"function": "real"}]}]}
        stdout = ("target noise\n" + gb.wrap_sentinel(json.dumps(forged)) + "\n" +
                  gb.wrap_sentinel(json.dumps(real), nonce=nonce))
        found, _raw = gb.extract_sentinel(stdout, nonce=nonce)
        self.assertEqual(found, real)
        # ...and a pair carrying the *wrong* nonce is not trusted either.
        self.assertIsNone(gb.extract_sentinel(
            gb.wrap_sentinel(json.dumps(forged), nonce="deadbeef"), nonce=nonce)[0])

    def test_inner_emission_carries_the_nonce_the_outer_side_demands(self):
        """The two halves of R30 have to agree: `run_outer` puts the nonce in the
        child's environment, `_sentinel` (inside lldb) reads it back out of it."""
        previous = os.environ.get(gb.SENTINEL_NONCE_ENV)
        os.environ[gb.SENTINEL_NONCE_ENV] = "cafe1234"
        try:
            nonce = gb.sentinel_nonce_from_env()
            emission = gb._sentinel({"mode": "capture", "status": "eStateStopped"})
        finally:
            if previous is None:
                os.environ.pop(gb.SENTINEL_NONCE_ENV, None)
            else:
                os.environ[gb.SENTINEL_NONCE_ENV] = previous
        self.assertEqual(nonce, "cafe1234")
        self.assertTrue(emission.startswith("GPBRIDGE<cafe1234<<"), emission)
        self.assertTrue(emission.endswith(gb.SENTINEL_END))
        self.assertEqual(gb.extract_sentinel(emission, nonce=nonce)[0],
                         {"mode": "capture", "status": "eStateStopped"})
        # The same emission is inert for a run that demanded a different nonce.
        self.assertIsNone(gb.extract_sentinel(emission, nonce="other-nonce")[0])

    def test_a_stray_env_nonce_cannot_break_the_marker_shape(self):
        """The inner half reads its nonce out of the environment and puts it *inside*
        the marker, so whitespace and marker characters must not survive the read."""
        previous = os.environ.get(gb.SENTINEL_NONCE_ENV)
        os.environ[gb.SENTINEL_NONCE_ENV] = " ab cd\n<<evil>> "
        try:
            nonce = gb.sentinel_nonce_from_env()
        finally:
            if previous is None:
                os.environ.pop(gb.SENTINEL_NONCE_ENV, None)
            else:
                os.environ[gb.SENTINEL_NONCE_ENV] = previous
        self.assertEqual(nonce, "abcdevil")
        emission = gb.wrap_sentinel('{"a": 1}', nonce=nonce)
        self.assertTrue(emission.startswith("GPBRIDGE<abcdevil<<"), emission)
        self.assertEqual(emission.count(gb.SENTINEL_END), 1)
        # A value that sanitises to nothing is "no nonce", not a broken marker.
        os.environ[gb.SENTINEL_NONCE_ENV] = "  \n "
        try:
            self.assertIsNone(gb.sentinel_nonce_from_env())
            self.assertEqual(gb.sentinel_begin(None), gb.SENTINEL_BEGIN)
        finally:
            if previous is None:
                os.environ.pop(gb.SENTINEL_NONCE_ENV, None)
            else:
                os.environ[gb.SENTINEL_NONCE_ENV] = previous

    def test_run_nonce_round_trips_through_a_real_child_process(self):
        """The whole R30 loop across the boundary it actually crosses: `run_outer`
        puts the nonce in the child's env, the in-lldb half reads it back out of
        that env, the parent extracts with it. A forged fixed-marker pair in the
        same stream must not be the one that parses."""
        nonce = gb.new_sentinel_nonce()
        script = (
            "import sys, os; sys.path.insert(0, %r); import glasspane_bridge as gb; "
            "sys.stdout.write(gb.SENTINEL_BEGIN + '{\"status\": \"forged\"}' + gb.SENTINEL_END + "
            "'\\n' + gb._sentinel({'mode': 'capture', 'status': 'eStateStopped'}) + '\\n')"
            % os.path.dirname(os.path.abspath(__file__)))
        completed, timed_out = gb.run_child_captured(
            [sys.executable, "-c", script], timeout=30,
            env=dict(os.environ, **{gb.SENTINEL_NONCE_ENV: nonce}))
        self.assertFalse(timed_out)
        found, _raw = gb.extract_sentinel(completed.stdout, nonce=nonce)
        self.assertEqual(found, {"mode": "capture", "status": "eStateStopped"})

    def test_absence_clue_names_which_failure_it_was(self):
        """The failure stays JSON-shaped, but says whether the marker never came or
        came and was unusable — those two have different fixes."""
        nonce = gb.new_sentinel_nonce()
        silent = gb.sentinel_absence_clue("(lldb) quit\n", nonce=nonce)
        self.assertIn("no ", silent)
        self.assertIn(gb.SENTINEL_NONCE_ENV, silent)
        unusable = gb.sentinel_absence_clue(gb.wrap_sentinel("{broken", nonce=nonce),
                                            nonce=nonce)
        self.assertIn("none of them a complete", unusable)


class ChildOutputDecoding(unittest.TestCase):
    """B-28: the pipe carries lldb's *and the target's* bytes; text=True decodes
    strictly, so one non-UTF-8 byte killed the bridge with a traceback inside
    communicate() — no payload, contradicting §6.2."""

    def test_non_utf8_byte_still_yields_a_json_shaped_result(self):
        payload = {"mode": "capture", "status": "eStateStopped", "threads": [{"id": 3}]}
        script = ("import sys; sys.stdout.buffer.write(b'\\xff\\xfeprefix noise ' "
                  "+ %r + b'\\n'); sys.stdout.flush()" % gb.wrap_sentinel(json.dumps(payload)).encode("utf-8"))
        completed, timed_out = gb.run_child_captured(
            [sys.executable, "-c", script], timeout=30)
        self.assertFalse(timed_out)
        found, _raw = gb.extract_sentinel(completed.stdout)
        self.assertEqual(found, payload)
        # The bad bytes really went through this pipe (and really were not dropped
        # by an exception): the replacement character is the evidence.
        self.assertIn("\ufffd", completed.stdout)


class WatchModeValidation(unittest.TestCase):
    """B-29: argv[3] used to reach the ledger unvalidated, so `gp-watch add 0x… 8 x`
    armed read=False, write=False — never firable, one of four hardware slots gone,
    and the ledger reported it armed.

    These drive `cmd_watch` itself (the SB-API call is stubbed, never faked with a
    fake debugger — §6.6 leaves that surface to real-machine smoke), so the test is
    red if the mode stops being checked *at the command line*, not only in a helper
    nobody calls.
    """

    def _run(self, command):
        queue = gb.WatchQueue()
        armed = []
        messages = []

        def fake_arm(debugger, entry):
            armed.append(dict(entry))
            return (True, "1")

        result = types.SimpleNamespace(AppendMessage=messages.append)
        with mock.patch.object(gb, "_WATCH_QUEUE", queue), \
                mock.patch.object(gb, "_arm_watchpoint", side_effect=fake_arm):
            gb.cmd_watch(None, command, result, {})
        return messages, queue, armed

    def test_a_mode_that_can_never_fire_is_refused(self):
        messages, queue, armed = self._run("add 0x1000 8 x")
        self.assertEqual([], armed, "an unfireable mode must not reach WatchAddress")
        self.assertEqual([], queue.armed)
        self.assertEqual([], queue.queued)
        self.assertEqual([], queue.records(), "the ledger must not claim a request")
        refusal = "\n".join(messages)
        self.assertIn("nothing was requested", refusal)
        self.assertIn("never fire", refusal)

    def test_r_w_and_rw_are_armed_with_the_mode_they_asked_for(self):
        for mode in ("r", "w", "rw"):
            messages, queue, armed = self._run("add 0x1000 8 %s" % mode)
            self.assertEqual([mode], [one["mode"] for one in armed], messages)
            self.assertEqual(1, len(queue.armed))

    def test_absent_mode_keeps_the_documented_default(self):
        _messages, _queue, armed = self._run("add 0x1000")
        self.assertEqual(["w"], [one["mode"] for one in armed])


class ArgvComposition(unittest.TestCase):
    def test_launch_capture_uses_sb_driver_script(self):
        argv = gb.build_lldb_argv("/abs/bridge.py", mode="capture", exe="/tmp/crashme")
        self.assertEqual(argv[:2], ["xcrun", "lldb"])
        self.assertIn("--file", argv)
        commands = [argv[i + 1] for i, token in enumerate(argv) if token == "-o"]
        # 引号是必需的，不是装饰：这段 token 由 lldb **自己的命令分词器**再切一次，
        # 裸路径带一个空格就裂成 `invalid pathname '/tmp/gp'`（真机实测）。见
        # `BridgePathSurvivesLLDBsOwnTokenizer`。
        self.assertIn("command script import '/abs/bridge.py'", commands[0])
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

    def test_apostrophe_in_the_exe_path_does_not_break_the_python_expression(self):
        """B-30: `-o script glasspane_bridge.run_capture_cli('…')` is evaluated by
        PYTHON, but `shlex.quote` speaks POSIX shell — an apostrophe in a path came
        out as the shell splice `'\\''`, which Python reads as a SyntaxError, so every
        capture of such a path died with no payload. base64 has no quotes at all.

        The eval below is the honest shape of the check: the expression is this
        test's own `build_lldb_argv` output from a literal path, i.e. exactly the
        string lldb's Python evaluates. Nothing untrusted reaches it.
        """
        exe = "/tmp/we'ird app/crash me"
        argv = gb.build_lldb_argv("/b.py", mode="capture", exe=exe)
        token = next(item for item in argv[1:] if "run_capture_cli" in item)
        expression = token[len("script "):]
        try:
            code = compile(expression, "<lldb -o script>", "eval")
        except SyntaxError as error:
            self.fail("the -o script token must be valid Python, and it is not: %s" % error)
        seen = {}
        namespace = {"glasspane_bridge": types.SimpleNamespace(
            run_capture_cli_b64=lambda spec: seen.update(spec=spec))}
        eval(code, namespace)
        self.assertRegex(seen["spec"], r"^[A-Za-z0-9+/]+={0,2}$",
                         "the spec must arrive base64: no quote, no space, no metacharacter")
        self.assertEqual(json.loads(base64.b64decode(seen["spec"], validate=True).decode("utf-8"))["exe"],
                         exe)

    def test_a_broken_capture_spec_leaves_as_json_never_as_a_traceback(self):
        """§6.2: failure surfaces as the module's JSON error shape — the b64 entry
        point is reached before lldb is imported, so this runs in plain python3."""
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            gb.run_capture_cli_b64("not-base64-at-all!")
        found, _raw = gb.extract_sentinel(buffer.getvalue())
        self.assertIsNotNone(found, buffer.getvalue())
        self.assertEqual(found["status"], "failed")
        self.assertTrue(any("decoded" in error for error in found["errors"]))


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

    def test_emit_refuses_a_pre_existing_out_file(self):
        """A regular file already at --out must never be clobbered (O_EXCL), and
        the refusal must leave as JSON (§6.2), not as a traceback."""
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "payload.json")
            with open(out, "w", encoding="utf-8") as handle:
                handle.write("PRE-EXISTING-NOT-THE-CAPTURE")
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                with self.assertRaises(OSError):
                    gb.emit({"mode": "capture", "status": "eStateStopped"}, out_path=out)
            with open(out, encoding="utf-8") as handle:
                self.assertEqual(handle.read(), "PRE-EXISTING-NOT-THE-CAPTURE",
                                 "a pre-existing --out target must be left byte-for-byte intact")
            found, _raw = gb.extract_sentinel(buffer.getvalue())
            self.assertIsNotNone(found, buffer.getvalue())
            self.assertEqual(found["status"], "failed")
            self.assertTrue(any("refusing to write --out" in error for error in found["errors"]))

    def test_emit_refuses_a_symlink_at_out_and_leaves_its_target(self):
        """The documented usage is `--out /tmp/capture.json`; a symlink planted at
        that name must turn into a refusal, never an arbitrary-file overwrite.
        O_NOFOLLOW means the linked-to file is not touched and the link survives."""
        with tempfile.TemporaryDirectory() as tmp:
            victim = os.path.join(tmp, "victim.txt")
            with open(victim, "w", encoding="utf-8") as handle:
                handle.write("SECRET-NEVER-OVERWRITE")
            link = os.path.join(tmp, "capture.json")
            os.symlink(victim, link)
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                with self.assertRaises(OSError):
                    gb.emit({"mode": "capture", "status": "eStateStopped"}, out_path=link)
            self.assertTrue(os.path.islink(link), "the symlink must not be replaced or followed")
            self.assertFalse(os.path.exists(os.path.join(tmp, "payload.json")))
            with open(victim, encoding="utf-8") as handle:
                self.assertEqual(handle.read(), "SECRET-NEVER-OVERWRITE",
                                 "writing through a planted symlink would be an arbitrary-file overwrite")
            found, _raw = gb.extract_sentinel(buffer.getvalue())
            self.assertIsNotNone(found, buffer.getvalue())
            self.assertEqual(found["status"], "failed")

    def test_emit_out_mode_is_0600_regardless_of_umask(self):
        """The capture holds registers and a debugged process's LOCALS; the mode is
        pinned to 0600 so no umask can widen it (world-readable leak) nor narrow it
        (an unreadable file the panel claims it can open)."""
        for hostile_umask in (0o000, 0o022, 0o077):
            with tempfile.TemporaryDirectory() as tmp:
                out = os.path.join(tmp, "payload.json")
                previous = os.umask(hostile_umask)
                try:
                    gb.emit({"mode": "capture"}, out_path=out)
                finally:
                    os.umask(previous)
                mode = os.stat(out).st_mode & 0o777
                self.assertEqual(mode, 0o600,
                                 "umask %03o must still yield 0600, got %04o" % (hostile_umask, mode))

    def test_emit_honours_an_explicit_budget(self):
        # B-24: the bound is a parameter, so a slow-but-alive engine can be given
        # more room without ever going back to "wait forever". The回传 frame on the
        # socket is a bare NDJSON line (the engine's line protocol); only stdout is
        # sentinel-wrapped, so asserting the sentinel here would pin the wrong shape.
        from unittest import mock

        created = []
        timeouts = []

        class Recording(socket.socket):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                created.append(self)
                self.sent = b""

            def settimeout(self, value):
                timeouts.append(value)
                return super().settimeout(value)

            def connect(self, address):
                return None

            def sendall(self, data):
                self.sent += data

        with mock.patch.object(gb.socket, "socket", Recording):
            gb.emit({"mode": "capture"}, send_sock="/tmp/gp-bridge-unused.sock", timeout_s=7.5)
        self.assertEqual([7.5], timeouts)
        self.assertEqual(gb.render_json({"mode": "capture"}) + "\n", created[0].sent.decode())
        self.assertTrue(created[0].fileno() == -1, "socket must be closed after delivery")

    def test_emit_default_budget_is_finite_AND_APPLIED(self):
        """Bounding `EMIT_TIMEOUT_S` alone cannot fail: it stayed green while `emit`
        ignored it and sent on an unbounded socket. The default must be observed on
        the socket, so the budget is read off `settimeout`, and the explicit-budget
        case above uses a different number so the two cannot be confused."""
        from unittest import mock

        timeouts = []

        class Recorder(socket.socket):
            def settimeout(self, value):
                timeouts.append(value)

            def connect(self, address):
                return None

            def sendall(self, data):
                return None

        with mock.patch.object(gb.socket, "socket", Recorder):
            gb.emit({"mode": "capture"}, send_sock="/tmp/gp-bridge-unused.sock")
        self.assertEqual([gb.EMIT_TIMEOUT_S], timeouts,
                         "emit must apply EMIT_TIMEOUT_S when the caller gave no budget")
        self.assertGreater(timeouts[0], 0)
        self.assertLess(timeouts[0], 60.0)

    def test_emit_bounds_connect_and_send_and_always_closes_the_socket(self):
        """B-24: an engine that stopped draining must produce an error, not a
        hung bridge holding an open fd."""
        from unittest import mock

        created = []
        timeouts = []

        class Unresponsive(socket.socket):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                created.append(self)

            def settimeout(self, value):
                timeouts.append(value)
                return super().settimeout(value)

            def connect(self, address):
                raise socket.timeout("simulated: the engine side never drains")

        with mock.patch.object(gb.socket, "socket", Unresponsive):
            with self.assertRaises(OSError) as raised:
                gb.emit({"mode": "capture"}, send_sock="/tmp/gp-bridge-unused.sock")
        self.assertEqual(1, len(created))
        self.assertEqual([gb.EMIT_TIMEOUT_S], timeouts)
        self.assertTrue(created[0].fileno() == -1, "fd must not leak: emit always closes")
        self.assertIn("not draining", str(raised.exception))

    def test_emit_closes_the_socket_when_the_send_fails(self):
        """connect() succeeding and sendall() failing is the common half of the
        same bug: the fd must not leak."""
        from unittest import mock

        created = []

        class HalfDead(socket.socket):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                created.append(self)

            def connect(self, address):
                return None

            def sendall(self, data):
                raise OSError(32, "Broken pipe")

        with mock.patch.object(gb.socket, "socket", HalfDead):
            with self.assertRaises(OSError) as raised:
                gb.emit({"mode": "capture"}, send_sock="/tmp/gp-bridge-unused.sock")
        self.assertEqual(1, len(created))
        self.assertTrue(created[0].fileno() == -1, "fd must not leak: emit always closes")
        self.assertIn("Broken pipe", str(raised.exception))


class WatchQueueReArmLoop(unittest.TestCase):
    """A-21: armed → hit → slot released → queue head armed, and no phase of
    that chain may be readable as a measurement it is not."""

    def armed_queue(self, extra=0):
        queue = gb.WatchQueue()
        for index in range(gb.HW_WATCHPOINT_SLOTS):
            queue.add({"addr": "0x%x" % (0x1000 + index), "size": 8, "mode": "w"})
        for index in range(extra):
            queue.add({"addr": "0x%x" % (0x2000 + index)})
        return queue

    def test_slot_indices_reuse_a_released_slot_not_the_list_length(self):
        queue = self.armed_queue()
        self.assertIsNone(queue.free_slot())
        self.assertEqual(1, queue.release("0x1001"))
        self.assertEqual(1, queue.free_slot())
        outcome, slot = queue.add({"addr": "0x3000"})
        self.assertEqual(("armed", 1), (outcome, slot))

    def test_hit_releases_its_slot_and_promotes_the_queue_head(self):
        queue = self.armed_queue(extra=1)
        head = queue.queued[0]
        self.assertEqual("0x2000", head["addr"])
        queue.note_stop_observed()
        queue.record_hit("0x1001")
        freed = queue.release("0x1001")
        promoted = queue.take_slot(freed)
        self.assertEqual("0x2000", promoted["addr"])
        self.assertEqual(1, promoted["hwSlot"])
        self.assertEqual([], queue.queued)
        # A ledger slot is not hardware: armed only becomes true once the
        # debugger confirms the watchpoint.
        self.assertFalse(promoted["live"])
        by_addr = {record["addr"]: record for record in queue.records()}
        self.assertEqual(1, by_addr["0x1001"]["hitCount"])
        self.assertFalse(by_addr["0x1001"]["armed"])
        self.assertIn("hit recorded (1)", by_addr["0x1001"]["reason"])
        self.assertEqual("spent", queue.entry_for_addr("0x1001")["phase"])
        queue.mark_live("0x2000")
        by_addr = {record["addr"]: record for record in queue.records()}
        self.assertTrue(by_addr["0x2000"]["armed"])
        self.assertIsNone(by_addr["0x2000"]["reason"])

    def test_re_arming_an_address_starts_at_zero_and_not_at_the_old_generation_count(self):
        """B-05: re-arming is the intended workflow, so a fresh watchpoint used to
        inherit the spent one's count and render as "armed and already fired once".
        """
        queue = gb.WatchQueue(slots=1, limit=4)
        queue.add({"addr": "0x4000", "size": 8, "mode": "w"})
        queue.mark_live("0x4000")
        queue.note_stop_observed()
        queue.record_hit("0x4000")
        self.assertEqual(0, queue.release("0x4000"))
        self.assertEqual(("armed", 0), queue.add({"addr": "0x4000", "size": 8, "mode": "w"}))
        queue.mark_live("0x4000")
        spent, fresh = queue.records()  # request order: the spent generation comes first
        self.assertEqual(1, spent["hitCount"])
        self.assertFalse(spent["armed"])
        self.assertIn("hit recorded (1)", spent["reason"])
        self.assertEqual(0, fresh["hitCount"])
        self.assertTrue(fresh["armed"])
        self.assertIsNone(fresh["reason"])
        # The exact bytes a payload carries for a freshly armed watchpoint must not
        # be the byte pattern of one that already stopped the target once.
        self.assertEqual('{"addr":"0x4000","armed":true,"hitCount":0,"hwSlot":0,'
                         '"queued":false,"reason":null}', gb.render_json(fresh))
        self.assertNotEqual(gb.render_json(spent), gb.render_json(fresh))
        # The address-level roll-up keeps the real observation and says which
        # generation earned it: one hit happened, on the retired entry.
        self.assertEqual([{"addr": "0x4000", "seq": queue.spent[0]["seq"], "hitCount": 1}],
                         queue.snapshot()["hits"])
        self.assertNotEqual(queue.spent[0]["seq"], queue.armed[0]["seq"])
        self.assertEqual(1, sum(row["hitCount"] for row in queue.snapshot()["hits"]))
        self.assertEqual(2, len(queue.records()))

    def test_take_slot_on_an_occupied_slot_records_a_note_instead_of_quietly_double_booking(self):
        queue = self.armed_queue(extra=1)
        armed = queue.take_slot(freed_index=2)  # slot 2 was never released
        self.assertEqual(2, armed["hwSlot"])
        self.assertTrue(any("occupied slot" in note for note in queue.notes))

    def test_a_queued_watchpoint_is_reported_as_not_armed_with_a_reason(self):
        queue = self.armed_queue(extra=1)
        record = [r for r in queue.records() if r["queued"]][0]
        self.assertEqual("0x2000", record["addr"])
        self.assertIsNone(record["hwSlot"])
        self.assertFalse(record["armed"])
        self.assertEqual(0, record["hitCount"])
        self.assertIn("no free hardware slot", record["reason"])
        notes = "\n".join(queue.integrity_notes())
        self.assertIn("queued and NOT armed", notes)
        self.assertIn("observed no watchpoint stop", notes)
        self.assertEqual(0, queue.snapshot()["watchpointStopsObserved"])

    def test_a_stop_at_a_queued_address_never_credits_the_pending_request(self):
        """A queued request is a promise, not an arm: it cannot take a hit either."""
        queue = self.armed_queue(extra=1)
        self.assertIsNone(queue.record_hit("0x2000"))
        self.assertEqual([], queue.snapshot()["hits"])
        self.assertEqual([{"addr": "0x2000", "stopCount": 1}],
                         queue.snapshot()["unattributedHits"])
        self.assertEqual(0, [r for r in queue.records() if r["queued"]][0]["hitCount"])
        self.assertIn("queued", "\n".join(queue.notes))

    def test_a_duplicate_request_takes_no_second_slot(self):
        queue = self.armed_queue()
        outcome, detail = queue.add({"addr": "0x1002"})
        self.assertEqual("duplicate", outcome)
        self.assertIn("already requested", detail)
        self.assertEqual(4, len(queue.armed))

    def test_an_addrless_spec_is_refused_instead_of_claiming_a_slot(self):
        queue = gb.WatchQueue()
        self.assertEqual("rejected", queue.add({"size": 8})[0])
        self.assertEqual([], queue.armed)

    def test_records_are_the_6_4_array_in_request_order(self):
        queue = gb.WatchQueue(slots=1, limit=4)
        queue.add({"addr": "0x1000", "size": 8, "mode": "w"})
        queue.add({"addr": "0x2000"})
        records = queue.records()
        self.assertIsInstance(records, list)
        self.assertEqual(["0x1000", "0x2000"], [r["addr"] for r in records])
        self.assertEqual({"addr", "hwSlot", "queued", "hitCount", "armed", "reason"},
                         set(records[0]))
        self.assertEqual([False, True], [r["queued"] for r in records])

    def test_reserved_slot_without_hardware_never_claims_armed(self):
        queue = gb.WatchQueue(slots=2, limit=4)
        queue.add({"addr": "0x5000"})
        self.assertFalse(queue.records()[0]["armed"])
        self.assertIn("never confirmed", queue.records()[0]["reason"])
        queue.mark_live("0x5000")
        self.assertTrue(queue.records()[0]["armed"])
        self.assertIsNone(queue.records()[0]["reason"])

    def test_abandoning_a_failed_arm_leaves_no_slot_claimed(self):
        queue = self.armed_queue()
        queue.abandon("0x1002", "no debug registers left")
        self.assertEqual(3, len(queue.armed))
        self.assertEqual(2, queue.free_slot())
        self.assertEqual(0, queue.snapshot()["rejected"])
        self.assertIn("no debug registers left", "\n".join(queue.integrity_notes()))

    def test_clearing_a_request_is_visible_and_frees_its_slot(self):
        queue = gb.WatchQueue(slots=1, limit=4)
        queue.add({"addr": "0xa"})
        queue.add({"addr": "0xb"})
        self.assertEqual(("queued", None), queue.drop("0xb"))
        self.assertEqual(("armed", 0), queue.drop("0xa"))
        self.assertEqual((None, None), queue.drop("0xc"))
        self.assertEqual([], queue.entries())

    def test_rearm_unavailability_names_the_manual_path(self):
        queue = self.armed_queue(extra=1)
        self.assertIsNone(queue.snapshot()["rearmLive"])
        queue.set_rearm(False, "stop hook rejected")
        self.assertIn("gp-queue arm", "\n".join(queue.integrity_notes()))

    def test_note_cap_announces_what_it_suppressed(self):
        queue = gb.WatchQueue()
        for index in range(gb.WATCHPOINT_NOTE_LIMIT + 5):
            queue.note("note %d" % index)
        self.assertEqual(gb.WATCHPOINT_NOTE_LIMIT + 1, len(queue.notes))
        self.assertIn("suppressed", queue.notes[-1])
        self.assertEqual(5, queue.notes_dropped)

    def test_watchpoint_caveats_reach_the_payload(self):
        queue = self.armed_queue(extra=1)
        payload = gb.assemble_result(mode="capture", target={"pid": 1}, status="stopped",
                                     threads=[], watchpoints=queue.records(),
                                     errors=queue.integrity_notes())
        text = gb.render_json(payload)
        self.assertIn("no free hardware slot", text)
        self.assertIn("NOT armed", text)
        self.assertIs(False, payload["watchpoints"][-1]["armed"])

    def test_a_capture_with_no_watchpoint_requests_carries_no_watchpoint_noise(self):
        queue = gb.WatchQueue()
        self.assertEqual([], queue.integrity_notes())
        payload = gb.assemble_result(mode="capture", target={"pid": 1}, status="stopped",
                                     threads=[], watchpoints=queue.records(),
                                     errors=queue.integrity_notes())
        self.assertEqual([], payload["watchpoints"])
        self.assertEqual([], payload["errors"])


class TraceTimeline(unittest.TestCase):
    """A-22: a sample is only worth what the stop behind it is worth."""

    def test_five_reads_of_one_frozen_stop_fold_into_one_observation(self):
        observations = [{"stopId": 3, "attempt": i} for i in range(5)]
        timeline = gb.build_timeline(observations, requested=5)
        self.assertEqual(1, timeline["observations"])
        self.assertEqual(1, len(timeline["samples"]))
        self.assertEqual(5, timeline["attempts"])
        self.assertFalse(timeline["measured"])
        self.assertIn("frozen stop state", timeline["reason"])

    def test_resume_backed_stops_are_a_real_time_series(self):
        observations = [{"stopId": 10 + i, "attempt": i} for i in range(5)]
        timeline = gb.build_timeline(observations, requested=5)
        self.assertEqual(5, timeline["observations"])
        self.assertTrue(timeline["measured"])
        self.assertIsNone(timeline["reason"])
        self.assertEqual([0, 1, 2, 3, 4], [s["sample"] for s in timeline["samples"]])

    def test_an_unreadable_stop_id_can_never_accumulate_samples(self):
        observations = [{"stopId": None} for _ in range(5)]
        timeline = gb.build_timeline(observations, requested=5)
        self.assertEqual(1, timeline["observations"])
        self.assertFalse(timeline["measured"])

    def test_zero_observations_is_an_explicit_non_measurement(self):
        timeline = gb.build_timeline([], requested=5,
                                     stop_note="no live process: the trace sampled 0 stops")
        self.assertEqual([], timeline["samples"])
        self.assertFalse(timeline["measured"])
        self.assertIn("no live process", timeline["reason"])

    def test_sample_count_can_never_exceed_real_observations(self):
        shapes = [
            [],
            [{"stopId": None}] * 5,
            [{"stopId": 3}] * 5,
            [{"stopId": 1}, {"stopId": 1}, {"stopId": 2}],
            [{"stopId": i} for i in range(5)],
            [{"stopId": 1}, {"stopId": None}, {"stopId": 2}],
        ]
        for observations in shapes:
            timeline = gb.build_timeline(observations, requested=5)
            self.assertLessEqual(len(timeline["samples"]), timeline["observations"])
            self.assertLessEqual(timeline["observations"], timeline["attempts"])
            self.assertEqual(len(timeline["samples"]), timeline["observations"])
            if len(timeline["samples"]) < 2:
                self.assertFalse(timeline["measured"], timeline)

    def test_a_shortfall_keeps_the_samples_it_earned_and_says_why(self):
        observations = [{"stopId": 1}, {"stopId": 2}]
        timeline = gb.build_timeline(observations, requested=5,
                                     stop_note="target exited after 2 stops")
        self.assertEqual(2, timeline["observations"])
        self.assertTrue(timeline["measured"])
        self.assertEqual("target exited after 2 stops", timeline["reason"])
        self.assertEqual(5, timeline["requested"])

    def test_trace_request_refuses_counts_it_cannot_honour(self):
        self.assertEqual((5, None), gb.parse_trace_request(""))
        self.assertEqual((9, None), gb.parse_trace_request("--samples 9"))
        requested, refusal = gb.parse_trace_request("--samples")
        self.assertIsNone(requested)
        self.assertIn("the flag has no value", refusal)
        self.assertIsNotNone(gb.parse_trace_request("--samples abc")[1])
        self.assertIsNotNone(gb.parse_trace_request("--samples 0")[1])
        self.assertIsNotNone(gb.parse_trace_request("--samples %d" % (gb.MAX_TRACE_SAMPLES + 1))[1])


class TruncationIsVisible(unittest.TestCase):
    """B-23: a cut-off payload must announce the cut."""

    def thread(self, index, frames=(), frames_total=None):
        return gb.thread_entry(index, "thread-%d" % index, "signal", list(frames),
                               frames_total=frames_total)

    def test_thread_cap_reports_the_drop(self):
        threads = [self.thread(index) for index in range(gb.MAX_THREADS + 30)]
        payload = gb.assemble_result(mode="capture", target={"pid": 1}, status="stopped",
                                     threads=threads)
        self.assertEqual(gb.MAX_THREADS, len(payload["threads"]))
        self.assertEqual({"kept": gb.MAX_THREADS, "dropped": 30, "limit": gb.MAX_THREADS},
                         payload["truncated"]["threads"])
        self.assertTrue(any("threads truncated" in error for error in payload["errors"]),
                        payload["errors"])

    def test_an_uncut_payload_says_so_by_saying_nothing(self):
        payload = gb.assemble_result(mode="capture", target={"pid": 1}, status="stopped",
                                     threads=[self.thread(1)])
        self.assertEqual({}, payload["truncated"])
        self.assertEqual([], payload["errors"])

    def test_frame_and_local_caps_are_marked_per_row(self):
        frame = gb.frame_record(0, "App", "0x1000",
                                locals_=[("v%d" % i, str(i)) for i in range(40)])
        self.assertEqual(gb.MAX_LOCALS, len(frame["locals"]))
        self.assertEqual(40, frame["localsTotal"])
        self.assertEqual(40 - gb.MAX_LOCALS, frame["localsTruncated"])
        thread = self.thread(1, frames=[frame], frames_total=100)
        self.assertEqual(99, thread["framesTruncated"])
        payload = gb.assemble_result(mode="capture", target={"pid": 1}, status="stopped",
                                     threads=[thread])
        self.assertEqual(99, payload["truncated"]["frames"]["dropped"])
        self.assertEqual(24, payload["truncated"]["locals"]["dropped"])
        self.assertTrue(any("frames truncated" in e for e in payload["errors"]))
        self.assertTrue(any("locals truncated" in e for e in payload["errors"]))

    def test_queue_field_is_absent_value_not_an_invented_empty_label(self):
        thread = self.thread(1)
        self.assertIn("queue", thread)          # §6.1: the key is never omitted
        self.assertIsNone(thread["queue"])      # None = not measured
        named = gb.thread_entry(2, "main", "signal", [], queue="com.apple.main-thread")
        self.assertEqual("com.apple.main-thread", named["queue"])


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


class SentinelCannotBeForgedEarlier(unittest.TestCase):
    """被调试进程的 stdout 与哨兵共用管道，所以它也能写出哨兵形状（§审查 2026-10-11）。

    从前取**第一对**：一个提前出现的 `GPBRIDGE<<…>>GPBRIDGE` 就顶掉了真结果，一个
    光秃秃的 `>>GPBRIDGE` 会把真 JSON 截断在前半段。本进程写的那一条在最后，
    所以现在从后往前取第一对能解析成 JSON 的。
    """

    def test_debuggee_forged_marker_does_not_answer_for_the_real_result(self):
        forged = {"status": "stopped", "note": "printed by the app under test"}
        real = {"mode": "capture", "status": "crashed", "frames": 3}
        stdout = (
            "(lldb) run\n"
            + gb.SENTINEL_BEGIN + json.dumps(forged) + gb.SENTINEL_END + "\n"
            + "Process 7 stopped\n"
            + gb.SENTINEL_BEGIN + json.dumps(real) + gb.SENTINEL_END + "\n(lldb) quit\n"
        )
        found, _ = gb.extract_sentinel(stdout)
        self.assertEqual(found, real, "取到的必须是我们最后写出的那一条，不是被调试进程冒充的")

    def test_stray_end_marker_earlier_does_not_truncate_the_real_payload(self):
        real = {"mode": "capture", "status": "stopped"}
        stdout = "the app echoed: " + gb.SENTINEL_END + "\n" + gb.SENTINEL_BEGIN + json.dumps(real) + gb.SENTINEL_END
        found, _ = gb.extract_sentinel(stdout)
        self.assertEqual(found, real)

    def test_no_parseable_pair_returns_none_rather_than_a_guess(self):
        stdout = gb.SENTINEL_BEGIN + "not json at all" + gb.SENTINEL_END
        found, raw = gb.extract_sentinel(stdout)
        self.assertIsNone(found)
        self.assertEqual(raw, stdout, "解析不出要把原文交回调用方，不能编一个形状")

    def test_single_clean_sentinel_still_extracts(self):
        # 对照：收紧扫描不能把正常那一条判没。
        payload = {"mode": "capture", "status": "stopped"}
        stdout = "noise\n" + gb.SENTINEL_BEGIN + json.dumps(payload) + gb.SENTINEL_END + "\n"
        found, _ = gb.extract_sentinel(stdout)
        self.assertEqual(found, payload)


class WatchRequestParsing(unittest.TestCase):
    """size 位上的非数字不许顺延成默认值。上游的 `WatchModeValidation` 管住了 mode 位，
    这一半是漏的：调用点从前写 `size = int(argv[2]) if argv[2].isdigit() else 8`，
    于是 `gp-watch add 0x4000 r` 里 "r" 过不了 isdigit（size 静默落回 8），argv[3] 又不存在
    （mode 静默落回默认 "w"）——**要读的人拿到一个写观察点**，账本还按请求地址报告"已武装"。
    """

    def test_mode_in_the_size_slot_is_refused_not_shifted(self):
        # 这条就是那次倒置：旧代码在此静默给出 (8, "w")。
        size, refusal = gb.parse_watch_size_token("r")
        self.assertIsNone(size, "size 位上的 r 必须当场拒，不许顺延成 8")
        self.assertIn("before the mode", refusal or "", "拒绝要给出正确形式")

    def test_explicit_size_and_absent_size_both_work(self):
        # 对照：这条闸不能只会拒绝。
        self.assertEqual(gb.parse_watch_size_token("16"), (16, None))
        self.assertEqual(gb.parse_watch_size_token(None), (gb.DEFAULT_WATCH_SIZE, None))
        self.assertEqual(gb.parse_watch_size_token(""), (gb.DEFAULT_WATCH_SIZE, None))

    def test_non_positive_size_is_refused(self):
        size, refusal = gb.parse_watch_size_token("0")
        self.assertIsNone(size)
        self.assertTrue(refusal)

    def test_mode_slot_still_refuses_garbage(self):
        self.assertEqual(gb.parse_watch_mode("r"), ("r", None))
        self.assertEqual(gb.parse_watch_mode(None), (gb.DEFAULT_WATCH_MODE, None))
        mode, refusal = gb.parse_watch_mode("sometimes")
        self.assertIsNone(mode)
        self.assertTrue(refusal)


# ---------------------------------------------------------------------------
# 真面（real-machine arms）
#
# 三条用例要跑**本机 lldb 自己**：停因枚举核对、带空格/引号的仓库路径能否真的
# 导进来、以及一次真崩溃的判决。口径取 `engine/smoke.md` §闸门退出码契约那一条：
# `0 = PASS / 1 = FAIL / 2 = NOT RUN`，而"打一行 SKIP 然后 exit 0"已作废——依赖不
# 在时**必须留下可见的 skipped 一档**，且成因要指名缺什么、复算命令是什么。
# pytest 的 skipped 与 passed 分列计数，所以这里用 skipTest(成因) 表达 NOT RUN；
# 绝不用 return（那才是把 NOT RUN 混成 pass）。
#
# 第三条真崩溃采证另外要**显式开关** `GLASSPANE_REAL_LLDB=1`：它跑一次 debugserver
# 冷启动（P6 §0 F5：本机首次 >5min），默认进 CI 会把纯逻辑泳道钉成一分钟级的红/慢，
# 所以它与 `.p6_smoke.py`/`.t9_smoke.py` 同档——真机跑，CI 里显式不开。
# ---------------------------------------------------------------------------

BRIDGE_DIR = os.path.dirname(os.path.abspath(__file__))
REAL_LLDB_OPT_IN = "GLASSPANE_REAL_LLDB"
ENUM_MARKER = "@@GPSTOPENUM@@"
TABLE_MARKER = "@@GPBRIDGETBL@@"

#: 2026-10-20 在本机 `xcrun lldb` 里逐条量到的 SBStopReason **成员次序**（量到的数值
#: 就是声明序号：Invalid 0 · None 1 · Trace 2 · Breakpoint 3 · Watchpoint 4 ·
#: **Signal 5** · Exception 6 · Exec 7 · PlanComplete 8 · ThreadExiting 9 ·
#: Instrumentation 10 · ProcessorTrace 11 · Fork 12 · VFork 13 · VForkDone 14 ·
#: Interrupt 15 · HistoryBoundary 16）。
#: 这里只留**一份**转写：数值由次序导出，所以
#: `test_table_matches_the_recorded_measurement` 比的是"桥的声明次序 = 实测次序"这件
#: 实事，而不是两份各自手抄、可以一起错的同一串字面量。次序之外的权威仍然只有真机
#: 那一条（`RealLLDBStopReasonTable`），它现在连"改名/删员"也一起抓（见
#: `mirror_table_drift`）。旧实现手抄的那张把 5 写成 frameIndexChanged、7 写成
#: signal，那是 LLDB 私有 `StopReasonEnum` 的次序，SB 绑定里没有这些成员。
MEASURED_STOP_REASON_ORDER = (
    "eStopReasonInvalid", "eStopReasonNone", "eStopReasonTrace",
    "eStopReasonBreakpoint", "eStopReasonWatchpoint", "eStopReasonSignal",
    "eStopReasonException", "eStopReasonExec", "eStopReasonPlanComplete",
    "eStopReasonThreadExiting", "eStopReasonInstrumentation",
    "eStopReasonProcessorTrace", "eStopReasonFork", "eStopReasonVFork",
    "eStopReasonVForkDone", "eStopReasonInterrupt", "eStopReasonHistoryBoundary",
)

#: 由上面那份转写导出，不再手抄第二遍。
MEASURED_STOP_REASON_INTS = {name: index
                             for index, name in enumerate(MEASURED_STOP_REASON_ORDER)}


def mirror_table_drift(declared, measured):
    """(missing, extra, mismatched) — 手抄枚举镜像相对**定义它的那台 lldb**的三种漂移。

    从前真机核对只写 `if name in measured and measured[name] != value`：一台把
    `eStopReasonSignal` **改名或删掉**的 lldb 会让它比出 0 行，表照样绿，而它服务的
    崩溃判据已经没人钉了——"没比对到"与"比对通过"在那个写法里是同一个颜色。漂移
    必须是三种各自可读的结果，缺席尤其要是一等发现。这是纯函数：真机那条 opt-in
    用例用它，默认泳道用桩驱动它（`MirrorTableDriftIsDetected`）。
    """
    missing = sorted(set(declared) - set(measured))
    extra = sorted(set(measured) - set(declared))
    mismatched = {name: (declared[name], measured[name]) for name in sorted(declared)
                  if name in measured and measured[name] != declared[name]}
    return missing, extra, mismatched


def run_lldb(commands, timeout=180):
    """Drive the SAME lldb the bridge drives: `xcrun lldb --batch -o …`.

    起不来一律折算成 NOT RUN（`engine/smoke.md` §闸门退出码契约，本文件 :1073-1077
    那条口径）：本机没有 xcrun、没装命令行工具、或**冷启动慢到 `subprocess.run` 抛
    TimeoutExpired**——最后这一种从前接不住（TimeoutExpired 是 SubprocessError 不是
    OSError），慢 debugserver 的机器上这条 opt-in 闸会以 traceback 收场而不是
    skipped，正违背它自己声明的 0/1/2。姊妹调用点 `_import_output` 接的就是两者。
    """
    argv = ["xcrun", "lldb", "--batch"]
    for command in commands:
        argv += ["-o", command]
    argv += ["-o", "quit"]
    try:
        return subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as error:
        raise unittest.SkipTest(
            "NOT RUN（不是 pass）: 本机跑不起 `xcrun lldb`：%r。复算命令："
            "xcrun lldb --batch -o \"script print(1)\" -o quit。缺 Xcode 命令行工具"
            "或开发者工具调试席位（P6 §7.1）、或 lldb 在本机 timeout=%ss 内没起来，"
            "都是这一档；装好/等热之后重跑本条即转真。 engine/smoke.md §闸门退出码契约："
            "NOT RUN 只许记成 skipped。" % (error, timeout))


def marker_payload(output, marker):
    """Take the JSON a `-o script print('<marker>'+json)` line emitted."""
    for line in (output or "").splitlines():
        stripped = line.strip()
        if stripped.startswith(marker):
            try:
                return json.loads(stripped[len(marker):])
            except ValueError:
                continue
    return None


class RealLLDBStopReasonTable(unittest.TestCase):
    """停因表必须与**桥所驱动的这台 lldb**逐条相等——否则下一次 lldb 挪动枚举值，
    崩溃又会从判据里溜出去（2026-10-20 真机复算抓到的正是这一类）。"""

    def _lldb_constants(self):
        probe = run_lldb(["script print('@@GPALIVE@@')"], timeout=120)
        if "@@GPALIVE@@" not in (probe.stdout + probe.stderr):
            self.skipTest("NOT RUN（不是 pass）: lldb 跑起来了但没回显脚本输出，"
                          "读不到 SBStopReason 常量。实测输出尾部：%r"
                          % ((probe.stdout + probe.stderr)[-400:],))
        expression = ("script import json;print('%s'+json.dumps("
                      "{n: int(getattr(lldb, n)) for n in dir(lldb) "
                      "if n.startswith('eStopReason')}))" % ENUM_MARKER)
        completed = run_lldb([expression], timeout=120)
        measured = marker_payload(completed.stdout + completed.stderr, ENUM_MARKER)
        if not measured:
            self.skipTest("NOT RUN（不是 pass）: 这台 lldb 没有回读 eStopReason 常量"
                          "（绑定形态与本仓实测不同）。输出尾部：%r"
                          % ((completed.stdout + completed.stderr)[-400:],))
        return measured

    def _lldb_version(self):
        try:
            completed = subprocess.run(["xcrun", "lldb", "--version"],
                                       capture_output=True, text=True, timeout=60)
        except (OSError, subprocess.SubprocessError):
            return "unreadable on this machine"
        lines = [line for line in (completed.stdout or "").splitlines() if line.strip()]
        return lines[0].strip() if lines else "unreadable on this machine"

    def test_shipped_mirror_table_equals_what_lldb_reports(self):
        """桥里那张手写的镜像表（真机上不直接参与判定，纯逻辑机器全靠它）逐条核对。

        比对**先看覆盖率再看数值**：一台把 `eStopReasonSignal` 改名或删掉的 lldb
        从前在这里比出 0 行、于是表照绿而崩溃判据失钉——"没比到"不能是绿色。
        版本号只在真要报错时去读：绿色一趟不多花一次 `lldb --version` 的启动。
        """
        measured = self._lldb_constants()
        drift = mirror_table_drift(gb._FALLBACK_STOP_REASON_INT, measured)
        if drift != ([], [], {}):
            missing, extra, mismatched = drift
            self.fail(
                "停因镜像表与本机 lldb（版本 %s）的实测成员表漂移：lldb 有而表里没有的 %s / "
                "表里有而 lldb 不再声明的 %s / 数值不符的 (表值, lldb 值) %s。改名或删员"
                "同样要改这张表，否则崩溃判据（%s）在这台机器上无人核对。"
                % (self._lldb_version(), extra, missing, mismatched, gb.CRASH_STOP_REASON))
        self.assertEqual(([], [], {}), drift)

    def test_bridge_resolves_the_same_table_from_inside_lldb(self):
        """production-shaped：让**桥自己**在真 lldb 里把权威表解析出来再比一次。
        这条盯的是权威分支（`stop_reason_int_by_name()` 读 lldb 常量那条路），
        不是把 Python 的表抄给 Python 比——所以它同时钉住前缀拼法与缺席纪律。"""
        measured = self._lldb_constants()
        bridge_copy = os.path.join(self._tempdir(), "glasspane_bridge.py")
        shutil.copyfile(os.path.join(BRIDGE_DIR, "glasspane_bridge.py"), bridge_copy)
        expression = ("script import json;print('%s'+json.dumps("
                      "__import__('glasspane_bridge').stop_reason_int_by_name()))"
                      % TABLE_MARKER)
        completed = run_lldb(["command script import %s"
                              % gb.lldb_command_quote(bridge_copy), expression],
                             timeout=180)
        resolved = marker_payload(completed.stdout + completed.stderr, TABLE_MARKER)
        if resolved is None:
            self.skipTest("NOT RUN（不是 pass）: 桥没能在真 lldb 里把停因表解析出来。"
                          "输出尾部：%r"
                          % ((completed.stdout + completed.stderr)[-400:],))
        for name, value in resolved.items():
            self.assertIn(name, measured, "桥报了一个 lldb 没有声明的停因名：%s" % name)
            self.assertEqual(value, measured[name],
                             "桥在真 lldb 里把 %s 解析成 %s，lldb 自己说是 %s"
                             % (name, value, measured[name]))
        # 缺席必须如实缺席：lldb 没声明的名字不许被镜像补进权威分支。
        for name in gb.STOP_REASON_NAMES:
            if name not in measured:
                self.assertNotIn(name, resolved,
                                 "权威分支拿镜像盖掉了 lldb 的缺席：%s" % name)
        self.assertEqual(resolved[gb.CRASH_STOP_REASON], measured[gb.CRASH_STOP_REASON],
                         "崩溃判据那一档（%s）与 lldb 的取值不是同一件事"
                         % gb.CRASH_STOP_REASON)

    def _tempdir(self):
        path = tempfile.mkdtemp(prefix="gp enum ")
        self.addCleanup(shutil.rmtree, path, True)
        return path


class StopReasonTableIsPinned(unittest.TestCase):
    """纯逻辑机器上（没有 lldb 可导入）这张表照样钉得住——真面用例 skip 时不留洞。"""

    def test_every_declared_stop_reason_has_a_number_and_a_word(self):
        self.assertEqual(len(set(gb.STOP_REASON_NAMES)), len(gb.STOP_REASON_NAMES))
        for name in gb.STOP_REASON_NAMES:
            self.assertTrue(name.startswith("eStopReason"), name)
            label = gb._STOP_REASON_LABEL_BY_NAME[name]
            self.assertTrue(label and label[0].islower(), (name, label))
        # 载荷词汇必须能在整张表上往返：写出去的词读回来还是那一档。
        for name in gb.STOP_REASON_NAMES:
            self.assertTrue(gb.stop_reason_matches(gb._STOP_REASON_LABEL_BY_NAME[name], name),
                            name)

    def test_table_matches_the_recorded_measurement(self):
        """桥的**声明次序**必须等于 2026-10-20 实测到的成员次序；数值由次序导出，
        所以这里比的是一件实事（次序），而不是两份各自手抄、可以一起错的同一串
        字面量。次序之外，取值的权威只有真机那一条（`RealLLDBStopReasonTable`，
        它现在连改名/删员也一起抓）。"""
        self.assertEqual(list(gb.STOP_REASON_NAMES), list(MEASURED_STOP_REASON_ORDER))
        self.assertEqual(gb._FALLBACK_STOP_REASON_INT, MEASURED_STOP_REASON_INTS)
        self.assertEqual(gb.stop_reason_int_by_name(), MEASURED_STOP_REASON_INTS)
        # 崩溃那一档的实测位次单独钉住：旧表当 7 是 signal，本机实测 signal 是 5。
        self.assertEqual(5, MEASURED_STOP_REASON_INTS[gb.CRASH_STOP_REASON])
        self.assertEqual(7, MEASURED_STOP_REASON_INTS["eStopReasonExec"])

    def test_the_wrong_table_that_shipped_is_gone_from_the_vocabulary(self):
        """旧表把 5/6/7/8 写成 frameIndexChanged / noDebug / signal / threadSpec，
        还发明了 stepOut / threadSpec 两个 SB 绑定里不存在的成员。这些词一旦回到
        载荷里，崩溃就又会被下游读成一次干净的停住——所以直接钉住词汇表。"""
        labels = set(gb._STOP_REASON_LABEL_BY_NAME.values())
        for retired in ("frameIndexChanged", "noDebug", "stepOut", "threadSpec"):
            self.assertNotIn(retired, labels, "%s 不是 SB 绑定里的停因" % retired)
        self.assertEqual(gb.stop_reason_label("eStopReasonSignal"), "signal")

    def test_crash_gate_is_the_signal_name_not_the_number_seven(self):
        self.assertEqual(gb.CRASH_STOP_REASON, "eStopReasonSignal")
        self.assertEqual(gb._FALLBACK_STOP_REASON_INT[gb.CRASH_STOP_REASON], 5)
        self.assertFalse(gb.is_crash_stop(7), "7 是 exec，不是信号停：旧判据就错在这里")
        self.assertTrue(gb.is_crash_stop(5))
        self.assertTrue(gb.is_crash_stop("5"))
        self.assertTrue(gb.is_crash_stop("signal"))
        self.assertTrue(gb.is_crash_stop("lldb.eStopReasonSignal"))


class MirrorTableDriftIsDetected(unittest.TestCase):
    """默认泳道对 `mirror_table_drift` 这条**判定**的覆盖：真机那条是 opt-in 的，
    而它接的正是"换一台 lldb 之后崩溃判据会不会静静失钉"这件事。把判定抽成纯函数
    之后，CI 里就能拿一台" hypothetical lldb" 把它跑红。"""

    def declared_table(self):
        return dict(gb._FALLBACK_STOP_REASON_INT)

    def test_a_renamed_member_is_a_drift_not_an_empty_diff(self):
        measured = self.declared_table()
        measured["eStopReasonTrap"] = measured.pop(gb.CRASH_STOP_REASON)
        missing, extra, mismatched = mirror_table_drift(self.declared_table(), measured)
        self.assertEqual([gb.CRASH_STOP_REASON], missing,
                         "lldb 不再声明信号停那一档，必须作为缺席报出来")
        self.assertEqual(["eStopReasonTrap"], extra)
        self.assertEqual({}, mismatched)
        # 旧写法（只比 present 的行）在这里比出 0 行 → 表照绿。缺席必须是结果之一。
        self.assertTrue(missing or extra)

    def test_a_dropped_member_is_a_drift_too(self):
        measured = self.declared_table()
        del measured[gb.CRASH_STOP_REASON]
        missing, extra, mismatched = mirror_table_drift(self.declared_table(), measured)
        self.assertEqual([gb.CRASH_STOP_REASON], missing)
        self.assertEqual([], extra)

    def test_a_shifted_number_still_shows_both_values(self):
        measured = self.declared_table()
        measured["eStopReasonSignal"] = 42
        missing, extra, mismatched = mirror_table_drift(self.declared_table(), measured)
        self.assertEqual([], missing)
        self.assertEqual([], extra)
        self.assertEqual({"eStopReasonSignal": (5, 42)}, mismatched)

    def test_an_agreeing_table_reports_no_drift_at_all(self):
        """控制项：这条闸不许只会报警。"""
        measured = self.declared_table()
        self.assertEqual(([], [], {}), mirror_table_drift(self.declared_table(), measured))


class RealArmGateReportsNotRun(unittest.TestCase):
    """opt-in 真面用例的 0/1/2 契约也得在默认泳道里守得住：`run_lldb` 起不来时报
    skipped，而不是把 traceback 交给闸门当产品失败。这里驱动的就是那条 `except`。"""

    def test_a_slow_lldb_start_is_not_run_not_a_traceback(self):
        def exploding_run(*args, **kwargs):
            raise subprocess.TimeoutExpired(cmd=["xcrun", "lldb", "--batch"], timeout=1)

        with mock.patch.object(subprocess, "run", exploding_run):
            with self.assertRaises(unittest.SkipTest) as raised:
                run_lldb(["script print(1)"], timeout=1)
        self.assertIn("NOT RUN", str(raised.exception))

    def test_a_missing_xcrun_is_not_run_too(self):
        def missing_run(*args, **kwargs):
            raise FileNotFoundError(2, "No such file or directory: 'xcrun'")

        with mock.patch.object(subprocess, "run", missing_run):
            with self.assertRaises(unittest.SkipTest):
                run_lldb(["script print(1)"], timeout=1)

    def test_a_lldb_that_answers_is_handed_back_not_skipped(self):
        """控制项：折算成 NOT RUN 的那条路不许变成"永远 skip"。"""
        completed = subprocess.CompletedProcess(["xcrun", "lldb"], 0, "(lldb) 1\n", "")
        with mock.patch.object(subprocess, "run", return_value=completed):
            self.assertIs(completed, run_lldb(["script print(1)"], timeout=1))


class SignalStopIsNeverACleanPass(unittest.TestCase):
    """一次 SIGSEGV/SIGTRAP 停：`crash` 必须有内容，退出码必须非零。旧实现两处都
    沉默（`stop == 7` 永不命中 + `0 if capture_succeeded else 1`）。"""

    class Thread(object):
        def __init__(self, reason, data=0):
            self._reason, self._data = reason, data

        def IsValid(self):
            return True

        def GetStopReason(self):
            return self._reason

        def GetStopReasonDataAtIndex(self, index):
            return self._data

    def test_signal_stop_describes_as_signal_and_carries_the_number(self):
        self.assertEqual(gb._describe_stop(self.Thread(5)), "signal")
        record = gb.crash_record(5, 11)
        self.assertEqual(record, {"signal": "signal 11", "description": "signal"})
        self.assertTrue(gb.crash_reported({"crash": record, "threads": []}), record)

    def test_other_stops_leave_crash_absent_and_the_run_a_clean_zero(self):
        for reason, label in ((3, "breakpoint"), (4, "watchpoint"), (7, "exec"),
                              (1, "none"), (0, "invalid")):
            self.assertEqual(gb._describe_stop(self.Thread(reason)), label, reason)
            self.assertIsNone(gb.crash_record(reason, 0), label)
            payload = {"status": "eStateStopped", "threads": [{"id": 1}],
                       "stopReason": label, "crash": gb.crash_record(reason, 0)}
            self.assertEqual(gb.outer_exit_code(payload), 0, payload)
            self.assertTrue(gb.capture_succeeded(payload), label)

    def test_signal_stop_is_delivered_but_not_reported_as_a_pass(self):
        payload = {"status": "eStateStopped",
                   "threads": [{"id": 1, "stopReason": "signal"}],
                   "stopReason": "signal", "crash": gb.crash_record(5, 11)}
        # 现场确实采到了（这是崩溃采证的本业），所以 capture_succeeded 仍为真……
        self.assertTrue(gb.capture_succeeded(payload))
        # ……但退出码不许把它读成"一次干净的通过"：非零，且是崩溃那一档。
        self.assertNotEqual(gb.outer_exit_code(payload), 0)
        self.assertEqual(gb.outer_exit_code(payload), 3)
        self.assertTrue(gb.crash_reported(payload))

    def test_a_leaked_numeric_stop_reason_still_counts_as_a_crash(self):
        """即使某台 lldb 的停因解析不出来、载荷里飘出一个裸数字 5，判决也不能装成
        干净通过——判据在名字上，也在任何一条线程的停因上。"""
        for payload in ({"status": "eStateStopped", "threads": [{"id": 1}],
                         "stopReason": "5", "crash": None},
                        {"status": "eStateStopped", "threads": [{"id": 1, "stopReason": 5}],
                         "stopReason": "signal", "crash": None},
                        {"status": "eStateStopped", "threads": [],
                         "stopReason": "signal", "crash": None}):
            self.assertEqual(gb.outer_exit_code(payload),
                             3 if payload["threads"] else 1, payload)

    def test_crash_verdict_survives_a_table_with_unrelated_numbers(self):
        """与 `CaptureExitCodeGuard.EXOTIC` 同一手法：换一张数值毫不相干的表，崩溃
        判据照样成立——证明判据真的不押在 5 或 7 上。"""
        exotic = {name: 700 + index for index, name in enumerate(gb.STOP_REASON_NAMES)}
        signal_value = exotic[gb.CRASH_STOP_REASON]
        self.assertTrue(gb.is_crash_stop(signal_value, exotic))
        self.assertFalse(gb.is_crash_stop(5, exotic))
        self.assertFalse(gb.is_crash_stop(7, exotic))
        self.assertEqual(gb.crash_record(signal_value, 4, exotic)["signal"], "signal 4")
        for name, value in exotic.items():
            if name == gb.CRASH_STOP_REASON:
                continue
            self.assertIsNone(gb.crash_record(value, 4, exotic), name)

    def test_unresolvable_stop_reason_is_reported_as_itself_not_invented(self):
        self.assertEqual(gb._describe_stop(self.Thread(999)), "999")
        self.assertEqual(gb.normalize_stop_reason(999), (999, None))
        self.assertFalse(gb.is_crash_stop(999))
        self.assertIsNone(gb.crash_record(999, 11))


# ---------------------------------------------------------------------------
# SB-API 形状的桩：给外层交付那一半（`_payload_from_process` /
# `reconcile_watchpoint_stops` / `cmd_capture` / `cmd_trace` / `cmd_queue`）一个
# 能跑起来的靶子。
#
# 这些对象**只模仿 lldb SB 绑定的读法**（IsValid / GetThreadAtIndex / GetStopReason /
# GetVariables / GetRegisters / GetID / Disable 的形状与返回形态），不模拟调试器语义：
# 语义正是桥自己负责、也因此需要被真的跑一遍的那一半。§6.6 的分工照旧——真跑
# `xcrun lldb` 仍是 opt-in（`RealMachineCrashScene`），这里补的是此前**任何闸门都没
# 执行过**的外层交付：0/1/3 判决、崩溃记录、命中→释放→重武装的环。`_arm_watchpoint`
# 里真碰硬件的那一句（`target.WatchAddress`）与 `_resume_for_next_sample` 一样按本
# 文件既有做法 stub 掉（见 `WatchModeValidation._run`），并且**故意不**把账目标成
# live：桩不许让载荷声称它没见过的硬件。
# ---------------------------------------------------------------------------


class StubValue(object):
    def __init__(self, name, value=None, summary=None):
        self._name, self._value, self._summary = name, value, summary

    def IsValid(self):
        return True

    def GetName(self):
        return self._name

    def GetValue(self):
        return self._value

    def GetSummary(self):
        return self._summary


class StubRegister(object):
    def __init__(self, name, value):
        self._name, self._value = name, value

    def GetName(self):
        return self._name

    def GetValue(self):
        return self._value


class StubFileSpec(object):
    def __init__(self, filename):
        self._filename = filename

    def IsValid(self):
        return True

    def GetFilename(self):
        return self._filename


class StubModule(object):
    def __init__(self, name):
        self._name = name

    def IsValid(self):
        return True

    def GetFileSpec(self):
        return StubFileSpec(self._name)


class StubSymbol(object):
    def __init__(self, name):
        self._name = name

    def IsValid(self):
        return True

    def GetName(self):
        return self._name


class StubLineEntry(object):
    def __init__(self, filename, line):
        self._filename, self._line = filename, line

    def IsValid(self):
        return True

    def GetFileSpec(self):
        return StubFileSpec(self._filename)

    def GetLine(self):
        return self._line


class StubFrame(object):
    """SBFrame. `variables_error` / `registers_error` make the read **raise** the way
    a failed SB call does — the case a payload must publish as "not measured", never
    as a count of zero."""

    def __init__(self, index=0, pc=0x1000, module="App", function=None, file=None,
                 line=None, variables=(), registers=(), variables_error=None,
                 registers_error=None, variables_scope=(True, True, True)):
        self._index, self._pc, self._module = index, pc, module
        self._function, self._file, self._line = function, file, line
        self._variables, self._registers = variables, registers
        self._variables_error, self._registers_error = variables_error, registers_error
        #: The ONE scope this frame models, as (in_scope, args_only, use_dynamic).
        #: `_collect_locals` asks for in-scope arguments with dynamic values, i.e.
        #: (True, True, True); the frame carries no data for a broader read (globals,
        #: non-args) and must not pretend it can answer one.
        self._variables_scope = tuple(variables_scope)
        #: Every GetVariables() call's full arg tuple, so a test can pin the exact
        #: scope decision the bridge made instead of only the returned list.
        self.getvariables_calls = []

    def IsValid(self):
        return True

    def GetPC(self):
        return self._pc

    def GetModule(self):
        return StubModule(self._module) if self._module else None

    def GetSymbol(self):
        return StubSymbol(self._function) if self._function else None

    def GetLineEntry(self):
        return StubLineEntry(self._file, self._line) if self._file else None

    def GetVariables(self, in_scope=True, args_only=False, show_types=False,
                     use_dynamic=False):
        self.getvariables_calls.append((in_scope, args_only, show_types, use_dynamic))
        if self._variables_error is not None:
            raise self._variables_error
        # A stub must be able to say no. This frame models exactly one variable
        # scope; asked for a different set of variables (globals included, args
        # dropped, dynamic off) it has no data to answer with, so it refuses loudly
        # rather than handing back the same list for every argument combination —
        # which is what let a mutated `_collect_locals` scope stay green.
        if (in_scope, args_only, use_dynamic) != self._variables_scope:
            raise AssertionError(
                "StubFrame.GetVariables asked for scope (in_scope=%r, args_only=%r, "
                "use_dynamic=%r) but this frame only models %r; it cannot answer a "
                "read it has no data for" % (in_scope, args_only, use_dynamic,
                                             self._variables_scope))
        return list(self._variables)

    def GetRegisters(self):
        if self._registers_error is not None:
            raise self._registers_error
        return [list(self._registers)]


class StubThread(object):
    """SBThread: exactly the reads `_payload_from_process` /
    `reconcile_watchpoint_stops` make at a stop."""

    def __init__(self, tid=1, name="thread", stop_reason=1, stop_data=(), frames=(),
                 queue="", num_frames=None, valid=True):
        self._tid, self._name, self._valid = tid, name, valid
        self._stop_reason, self._stop_data = stop_reason, tuple(stop_data)
        self._frames = list(frames)
        self._queue = queue
        self._num_frames = len(self._frames) if num_frames is None else num_frames

    def IsValid(self):
        return self._valid

    def GetThreadID(self):
        return self._tid

    def GetName(self):
        return self._name

    def GetStopReason(self):
        return self._stop_reason

    def GetStopReasonDataAtIndex(self, index):
        return self._stop_data[index] if index < len(self._stop_data) else 0

    def GetNumFrames(self):
        return self._num_frames

    def GetFrameAtIndex(self, index):
        return self._frames[index] if index < len(self._frames) else None

    def GetQueueName(self):
        return self._queue


class StubProcess(object):
    """SBProcess. `num_threads` may be an Exception (unreadable count) or a number
    larger than the thread list, which is the shape of a real wide target."""

    def __init__(self, threads=(), state=5, pid=38946, stop_id=1, selected=None,
                 valid=True, num_threads=None, kill_results=None):
        self._threads = list(threads)
        self._state, self._pid, self._stop_id = state, pid, stop_id
        self._selected, self._valid = selected, valid
        self._num_threads = num_threads
        #: S9-3: the launch arm reads this verdict. Same knob shape as
        #: StubWatchpoint.Disable — a queue consumed per call, the last entry
        #: repeats; an entry that is an Exception is raised the way a failing
        #: SB call does. Default (empty): Kill() succeeds.
        self._kill_results = list(kill_results or [])
        self.kill_calls = 0

    def Kill(self):
        """SBProcess.Kill() takes no arguments — the signature is the refusal:
        the stub answers the call the bridge actually makes, nothing wider."""
        self.kill_calls += 1
        if not self._kill_results:
            return True
        result = self._kill_results.pop(0) if len(self._kill_results) > 1 \
            else self._kill_results[0]
        if isinstance(result, Exception):
            raise result
        return result

    def IsValid(self):
        return self._valid

    def GetNumThreads(self):
        if isinstance(self._num_threads, Exception):
            raise self._num_threads
        return len(self._threads) if self._num_threads is None else self._num_threads

    def GetThreadAtIndex(self, index):
        return self._threads[index] if index < len(self._threads) else None

    def GetSelectedThread(self):
        if self._selected is not None:
            return self._selected
        return self._threads[0] if self._threads else None

    def GetState(self):
        return self._state

    def GetProcessID(self):
        return self._pid

    def GetStopID(self):
        return self._stop_id


class StubWatchpoint(object):
    """SBWatchpoint: the two reads the ledger seam makes. `Disable()` hands back a plain
    bool — one of the shapes `_outcome_ok` has to normalise. `disable_results` (added for
    D4) makes the **failure** arm reachable: a queue of outcomes is consumed per call and
    the last one repeats, so `disable_results=[False]` is "always refuses to disable"."""

    def __init__(self, wp_id, disable_results=None):
        self._id = wp_id
        self.disable_calls = 0
        self._disable_results = list(disable_results or [])

    def IsValid(self):
        return True

    def GetID(self):
        return self._id

    def Disable(self):
        self.disable_calls += 1
        if self._disable_results:
            return self._disable_results.pop(0) if len(self._disable_results) > 1 \
                else self._disable_results[0]
        return True


class StubTarget(object):
    def __init__(self, process=None, valid=True):
        self._process, self._valid = process, valid

    def IsValid(self):
        return self._valid

    def GetProcess(self):
        return self._process


class StubDebugger(object):
    """SBDebugger: the reads `_process_of` / the trace loop / the stop hook make."""

    #: The command texts this debugger will answer. `_install_stop_hook` and
    #: `__lldb_init_module` are the only bridge callers, and both send one of these
    #: prefixes. Anything else is refused rather than rubber-stamped True: a stub
    #: that answers "yes" to arbitrary command text endorses a debugger that did
    #: not exist, and hides which command `_install_stop_hook` actually handed over.
    _ACCEPTED_PREFIXES = ("command script add -f glasspane_bridge.cmd_",
                          "target stop-hook add ")

    def __init__(self, process=None, target_valid=True, refuse=()):
        self._target = StubTarget(process, target_valid)
        self.async_calls = []
        self._async = False
        self.commands = []
        #: substrings the debugger refuses even on an accepted shape, so a test can
        #: drive `_install_stop_hook`'s rejection arm for the right reason.
        self._refuse = tuple(refuse)

    def GetSelectedTarget(self):
        return self._target if self._target.IsValid() else None

    def SetAsync(self, value):
        self.async_calls.append(value)
        self._async = value

    def GetAsyncMode(self):
        return self._async

    def HandleCommand(self, text):
        self.commands.append(text)
        if not any(text.startswith(prefix) for prefix in self._ACCEPTED_PREFIXES):
            return False
        for needle in self._refuse:
            if needle in text:
                return False
        return True


def signal_stop_thread(tid=1894876, frames=None, **kwargs):
    """A thread stopped by SIGSEGV: stop reason 5, first stop-reason datum 11."""
    return StubThread(tid=tid, stop_reason=5, stop_data=(11,),
                      frames=frames if frames is not None else [StubFrame(function="main")],
                      **kwargs)


class OuterDeliveryFromSbStubs(unittest.TestCase):
    """§6.2/§6.4 delivery half driven by the stubs above (default, no opt-in)."""

    def setUp(self):
        self.queue = gb.WatchQueue()
        self.live = {}
        self.armed_calls = []

        def fake_arm(debugger, entry):
            self.armed_calls.append(dict(entry))
            return (True, str(len(self.armed_calls)))

        for attribute, value in (("_WATCH_QUEUE", self.queue),
                                 ("_LIVE_WATCHPOINTS", self.live),
                                 ("_RECONCILED_STOPS", set())):
            mock.patch.object(gb, attribute, value).start()
        mock.patch.object(gb, "_arm_watchpoint", side_effect=fake_arm).start()
        self.addCleanup(mock.patch.stopall)

    def arm_four_slots_and_queue_a_fifth(self):
        """4 armed (debugger-confirmed) watchpoints + 1 queued: the §6.5 over-cap shape."""
        for index in range(gb.HW_WATCHPOINT_SLOTS):
            addr = "0x%x" % (0x1000 + index)
            self.queue.add({"addr": addr, "size": 8, "mode": "w"})
            self.queue.mark_live(addr)
            self.live[addr] = StubWatchpoint(100 + index)
        outcome, _detail = self.queue.add({"addr": "0x2000", "size": 8, "mode": "w"})
        self.assertEqual("queued", outcome)
        return self.live["0x1001"]

    def test_hit_watchpoint_is_recorded_released_and_the_queue_head_rearmed(self):
        hit = self.arm_four_slots_and_queue_a_fifth()
        threads = [StubThread(tid=11, stop_reason=4, stop_data=(hit.GetID(), 0x1001),
                              frames=[StubFrame(function="main")]),
                   StubThread(tid=12, stop_reason=1)]
        process = StubProcess(threads=threads, stop_id=7)
        report = gb.reconcile_watchpoint_stops(StubDebugger(process), process)
        self.assertEqual(["0x1001"], report["hits"], report)
        self.assertEqual(["0x2000"], report["rearmed"], report)
        self.assertEqual([], report["notes"], report["notes"])
        # the debugger side really gave the slot up: hit → Disable() → ledger release
        self.assertEqual(1, hit.disable_calls, "the hit watchpoint must be disabled")
        self.assertNotIn("0x1001", self.live)
        self.assertEqual([], self.queue.queued, "the queued head must have taken the slot")
        promoted = self.queue.entry_for_addr("0x2000")
        self.assertEqual(self.queue.PHASE_ARMED, promoted["phase"])
        self.assertEqual(1, promoted["hwSlot"], "slot 1 was 0x1001's")
        self.assertEqual(["0x2000"], [call["addr"] for call in self.armed_calls])
        records = {record["addr"]: record for record in self.queue.records()}
        self.assertEqual(1, records["0x1001"]["hitCount"])
        self.assertEqual("spent", self.queue.entry_for_addr("0x1001")["phase"])
        self.assertEqual(0, records["0x2000"]["hitCount"])
        # The stub never confirmed hardware for the promoted entry, so the payload
        # must not claim it: only `WatchAddress` coming back can say "armed".
        self.assertFalse(records["0x2000"]["armed"], records["0x2000"])
        self.assertIn("never confirmed", records["0x2000"]["reason"])
        # idempotent per (stop id, thread, watchpoint id): hook + gp-* command both look
        again = gb.reconcile_watchpoint_stops(StubDebugger(process), process)
        self.assertEqual([], again["hits"])
        self.assertEqual([], again["rearmed"])
        self.assertEqual(1, sum(row["hitCount"] for row in self.queue.snapshot()["hits"]))

    def test_payload_carries_the_status_crash_and_exit_verdict_of_the_stop(self):
        frames = ([StubFrame(index=0, pc=0x199cf3ec0, module="libswiftCore.dylib",
                             function="_swift_runtime_on_report",
                             variables=[StubValue("payload", "1"),
                                        StubValue("missing", None, summary="nil")],
                             registers=[StubRegister("pc", "0x0000000199cf3ec0"),
                                        StubRegister("sp", "0x000000016fdfe9a0")])] +
                  [StubFrame(index=i, function="frame-%d" % i)
                   for i in range(1, gb.MAX_FRAMES)])
        thread = signal_stop_thread(frames=frames, num_frames=gb.MAX_FRAMES + 6,
                                   queue="com.apple.main-thread")
        payload = gb._payload_from_process(StubProcess(threads=[thread], state=5, pid=38946),
                                          "capture")
        self.assertEqual("eStateStopped", payload["status"])
        self.assertEqual({"pid": 38946}, payload["target"])
        self.assertEqual({"signal": "signal 11", "description": "signal"}, payload["crash"])
        self.assertEqual("signal", payload["stopReason"])
        self.assertEqual({"pc": "0x0000000199cf3ec0", "sp": "0x000000016fdfe9a0"},
                         payload["registers"])
        self.assertEqual("com.apple.main-thread", payload["threads"][0]["queue"])
        # 64 collected out of 70 must be a declared cut, not a 64-frame stack
        self.assertEqual({"dropped": 6, "limit": gb.MAX_FRAMES}, payload["truncated"]["frames"])
        self.assertEqual(gb.MAX_FRAMES + 6, payload["threads"][0]["framesTotal"])
        self.assertTrue(any("frames truncated" in error for error in payload["errors"]),
                        payload["errors"])
        self.assertEqual(2, payload["threads"][0]["frames"][0]["localsTotal"])
        self.assertTrue(gb.crash_reported(payload))
        # 崩溃现场采到了、也交付得出去，但退出码不许读成一次干净的通过（0/1/3）。
        self.assertTrue(gb.capture_succeeded(payload))
        self.assertEqual(3, gb.outer_exit_code(payload))

    def test_over_cap_threads_are_announced_not_dropped_silently(self):
        """B-23 at the process seam: the cap used to be applied *before* assembly, so
        `truncated.threads` stayed empty and errors[] said nothing about the missing
        rows — the payload read as a complete thread list."""
        threads = [signal_stop_thread(tid=index, name="thread-%d" % index,
                                      frames=[StubFrame(function="main")])
                   for index in range(gb.MAX_THREADS + 5)]
        payload = gb._payload_from_process(StubProcess(threads=threads), "capture")
        self.assertEqual(gb.MAX_THREADS, len(payload["threads"]))
        self.assertEqual({"kept": gb.MAX_THREADS, "dropped": 5, "limit": gb.MAX_THREADS},
                         payload["truncated"]["threads"])
        self.assertTrue(any("threads truncated: kept 64 of 69" in error
                            for error in payload["errors"]), payload["errors"])
        # and the announcement may not cost the rows that *were* kept their content
        self.assertTrue(all(row["frames"] for row in payload["threads"]), payload["threads"])

    def test_reconciliation_names_a_stop_that_could_have_fallen_past_the_cap(self):
        threads = [StubThread(tid=index, stop_reason=1)
                   for index in range(gb.MAX_THREADS + 5)]
        process = StubProcess(threads=threads)
        report = gb.reconcile_watchpoint_stops(StubDebugger(process), process)
        text = "\n".join(report["notes"] + self.queue.notes)
        self.assertIn("watchpoint reconciliation looked at only the first 64 of 69", text)
        self.assertIn("MAX_THREADS", text)
        # the caveat must ride out in the payload, not just in the report
        payload = gb._payload_from_process(process, "capture")
        self.assertTrue(any("watchpoint reconciliation looked at only the first" in error
                            for error in payload["errors"]), payload["errors"])
        # a target inside the cap gets no such note (the announcement is not noise)
        narrow = StubProcess(threads=threads[:2])
        self.assertEqual([], gb.reconcile_watchpoint_stops(StubDebugger(narrow), narrow)["notes"])

    def test_unreadable_locals_and_registers_are_named_never_counted_as_zero(self):
        frame = StubFrame(function="main", variables_error=RuntimeError("unavailable"),
                          registers_error=RuntimeError("unavailable"))
        thread = StubThread(tid=7, stop_reason=1, frames=[frame])
        payload = gb._payload_from_process(StubProcess(threads=[thread]), "capture")
        text = "\n".join(payload["errors"])
        self.assertIn("locals were not measured", text)
        self.assertIn("registers were not measured", text)
        self.assertIsNone(payload["threads"][0]["frames"][0]["localsTotal"],
                          "unreadable locals must not publish a count of zero")
        self.assertEqual({}, payload["registers"], "still empty — errors[] is what says why")
        # control: a frame that WAS read and holds nothing keeps its measured zero,
        # so the assertions above cannot be satisfied by "always null" either.
        read = StubThread(tid=8, stop_reason=1, frames=[StubFrame(function="main")])
        clean = gb._payload_from_process(StubProcess(threads=[read]), "capture")
        self.assertEqual([], clean["errors"], clean["errors"])
        self.assertEqual(0, clean["threads"][0]["frames"][0]["localsTotal"])
        self.assertEqual({}, clean["registers"])

    def test_frame_rows_that_were_never_asked_say_so_instead_of_zero(self):
        """Only the top frame's locals are read (§6.1), so every other row used to
        publish `localsTotal: 0` for a number nobody measured."""
        thread = StubThread(tid=9, stop_reason=1,
                            frames=[StubFrame(index=0, function="main"),
                                    StubFrame(index=1, function="callee")])
        payload = gb._payload_from_process(StubProcess(threads=[thread]), "capture")
        frames = payload["threads"][0]["frames"]
        self.assertEqual(0, frames[0]["localsTotal"], "top frame: read, and empty")
        self.assertIsNone(frames[1]["localsTotal"], "callee: never read")
        self.assertIsNone(frames[1]["localsTruncated"])
        self.assertEqual([], frames[1]["locals"], "the key stays present (§6.1)")

    def test_unreadable_thread_count_is_reported_as_unreadable(self):
        process = StubProcess(threads=[], num_threads=RuntimeError("unavailable"))
        payload = gb._payload_from_process(process, "capture")
        self.assertTrue(any("thread count was not measured" in error
                            for error in payload["errors"]), payload["errors"])
        self.assertEqual(1, gb.outer_exit_code(payload))

    def test_no_live_process_is_no_process_and_never_a_zero_thread_pass(self):
        for process in (None, StubProcess(valid=False)):
            payload = gb._payload_from_process(process, "capture")
            self.assertEqual("no-process", payload["status"], payload)
            self.assertEqual(1, gb.outer_exit_code(payload), payload)
            self.assertTrue(any("no live process to capture" in error
                                for error in payload["errors"]), payload["errors"])

    def test_cmd_capture_emits_a_sentinel_payload_that_delivers_to_out(self):
        """§6.2: `gp-capture` inside lldb always answers with a sentinel pair, and the
        same payload is what `--out`/`--send-sock` deliver."""
        process = StubProcess(threads=[signal_stop_thread(
            frames=[StubFrame(function="main", file="crashme.swift", line=4)])])
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            gb.cmd_capture(StubDebugger(process), "", None, {})
        found, _raw = gb.extract_sentinel(buffer.getvalue())
        self.assertIsNotNone(found, buffer.getvalue())
        self.assertEqual("capture", found["mode"])
        self.assertEqual("eStateStopped", found["status"])
        self.assertEqual({"signal": "signal 11", "description": "signal"}, found["crash"])
        self.assertEqual(3, gb.outer_exit_code(found))
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "capture.json")
            gb.emit(found, out_path=out)
            with open(out, encoding="utf-8") as handle:
                self.assertEqual(found, json.loads(handle.read()))

    def test_cmd_trace_refuses_to_publish_frozen_stop_reads_as_a_time_series(self):
        """T2 at the command seam: a target that cannot be resumed and re-stopped
        rests on one measurement, and one measurement must not go out as a series."""
        process = StubProcess(threads=[StubThread(tid=1, stop_reason=1, stop_data=(0,),
                                                  frames=[StubFrame(function="hang")])])
        debugger = StubDebugger(process)
        buffer = io.StringIO()
        with mock.patch.object(gb, "_resume_for_next_sample",
                               return_value=(False, "the target is not interruptible here")):
            with contextlib.redirect_stdout(buffer):
                gb.cmd_trace(debugger, "gp-trace --samples 3", None, {})
        found, _raw = gb.extract_sentinel(buffer.getvalue())
        self.assertIsNotNone(found, buffer.getvalue())
        self.assertEqual(3, found["timeline"]["requested"])
        self.assertEqual(1, found["timeline"]["attempts"],
                         "sampling must stop at the failed resume, not spin")
        self.assertEqual(1, found["timeline"]["observations"])
        self.assertFalse(found["timeline"]["measured"])
        self.assertEqual(1, found["samples"])
        self.assertIn("not interruptible", found["timeline"]["reason"])
        self.assertTrue(any("trace timeline not measured" in error
                            for error in found["errors"]), found["errors"])
        self.assertEqual([True, False], debugger.async_calls, "async flag must be restored")

    def test_cmd_queue_list_reconciles_the_stop_it_reports_on(self):
        hit = self.arm_four_slots_and_queue_a_fifth()
        process = StubProcess(threads=[StubThread(tid=11, stop_reason=4,
                                                  stop_data=(hit.GetID(), 0x1001))])
        messages = []
        gb.cmd_queue(StubDebugger(process), "list",
                     types.SimpleNamespace(AppendMessage=messages.append), {})
        snapshot = json.loads(messages[-1])
        self.assertEqual(1, snapshot["watchpointStopsObserved"], snapshot)
        self.assertEqual([("0x1001", 1)], [(row["addr"], row["hitCount"])
                                           for row in snapshot["hits"]],
                         "gp-queue list that did not reconcile would report no hit here")
        self.assertEqual(["0x1001"], [row["addr"] for row in snapshot["spent"]])
        self.assertEqual("0x2000", snapshot["slots"][-1]["addr"],
                         "the queued head must now hold the released slot")
        self.assertEqual([], snapshot["queued"])


class OutcomeShapeNormalisation(unittest.TestCase):
    """`_outcome_ok` is the seam every SB result passes through; an unrecognised
    shape must read as *unverified*, never as success."""

    class Error(object):
        def __init__(self, ok, text=None):
            self._ok, self._text = ok, text

        def Success(self):
            return self._ok

        def GetCString(self):
            return self._text

    class CommandResult(object):
        def __init__(self, ok):
            self._ok = ok

        def Succeeded(self):
            return self._ok

    def test_the_four_sb_result_shapes_are_normalised(self):
        self.assertEqual((False, "the debugger returned no result"), gb._outcome_ok(None))
        self.assertEqual((True, None), gb._outcome_ok(True))
        self.assertEqual((False, "the debugger call reported failure"), gb._outcome_ok(False))
        self.assertEqual((True, None), gb._outcome_ok(self.Error(True)))
        self.assertEqual((True, None), gb._outcome_ok(self.CommandResult(True)))
        self.assertEqual((False, "watchpoint not found"),
                         gb._outcome_ok(self.Error(False, "watchpoint not found")))
        # Succeeded() with no message: still a failure, with a reason that is not silence
        described = self.CommandResult(False)
        ok, detail = gb._outcome_ok(described)
        self.assertFalse(ok)
        self.assertTrue(detail)
        # an object with no success indicator at all is NOT assumed good
        self.assertEqual((False, "this lldb binding exposed no success indicator for the "
                                 "call"), gb._outcome_ok(object()))

    def test_an_error_object_without_getcstring_still_reports(self):
        class Silent(object):
            def Success(self):
                return False

        ok, detail = gb._outcome_ok(Silent())
        self.assertFalse(ok)
        self.assertEqual("the debugger call failed", detail)


# ---------------------------------------------------------------------------
# 双重超时那一支（F5 收尾）：管道 fd、收尸、与**已经读进缓冲的哨兵对**
# ---------------------------------------------------------------------------

HOLDER_HOLD_S = 90


class ChildDoubleTimeoutCleanup(unittest.TestCase):
    """`run_child_captured` 的第二次 `communicate()` 也超时那条路径从前是
    `proc.kill()` + `out, err = "", ""`：丢字节、漏 fd、不收尸。这条用例造一个
    **逃出进程组的写端持有者**，让 killpg 之后管道依然不通 EOF，于是第二次抽干
    必然再超时——被验的那一支就是被执行的那一支。"""

    def test_second_timeout_keeps_the_bytes_closes_the_pipes_and_reaps_the_child(self):
        payload = {"mode": "capture", "status": "eStateStopped", "threads": [{"id": 3}]}
        emission = gb.wrap_sentinel(json.dumps(payload))
        with tempfile.TemporaryDirectory() as tmp:
            holder_pid_file = os.path.join(tmp, "holder.pid")
            # 子进程先吐哨兵对，再起一个自成会话的持有者（继承同一对管道）：
            # killpg 打不到它，所以第二次 communicate() 一定还是超时。
            script = (
                "import subprocess, sys, time\n"
                "sys.stdout.write(%r)\nsys.stdout.flush()\n"
                "holder = subprocess.Popen([sys.executable, '-c', "
                "'import time; time.sleep(%d)'], start_new_session=True)\n"
                "open(%r, 'w').write(str(holder.pid))\n"
                "time.sleep(%d)\n"
                % (emission, HOLDER_HOLD_S, holder_pid_file, HOLDER_HOLD_S))
            created = []
            real_popen = subprocess.Popen

            def recording_popen(*args, **kwargs):
                proc = real_popen(*args, **kwargs)
                created.append(proc)
                return proc

            def kill_holder():
                try:
                    with open(holder_pid_file, encoding="utf-8") as handle:
                        os.kill(int(handle.read().strip()), signal.SIGKILL)
                except (OSError, ValueError):
                    pass

            self.addCleanup(kill_holder)
            fds_before = _open_fd_count()
            with mock.patch.object(subprocess, "Popen", recording_popen), \
                    mock.patch.object(gb, "CHILD_DRAIN_TIMEOUT_S", 0.5):
                completed, timed_out = gb.run_child_captured(
                    [sys.executable, "-c", script], timeout=3.0)
            kill_holder()
        self.assertEqual(1, len(created))
        proc = created[0]
        self.assertTrue(timed_out, "the timeout verdict must survive the cleanup")
        found, _raw = gb.extract_sentinel(completed.stdout)
        self.assertEqual(payload, found,
                         "lldb did emit the sentinel pair; a double timeout must not "
                         "throw the buffered bytes away: %r" % (completed.stdout,))
        self.assertIsNotNone(proc.returncode, "the child must be reaped, not left a zombie")
        for name in ("stdout", "stderr"):
            stream = getattr(proc, name)
            self.assertTrue(stream is None or stream.closed,
                            "%s must be closed: a timed-out drain may not leak the fd" % name)
        if fds_before is not None:
            self.assertEqual(fds_before, _open_fd_count(),
                             "the drain leaked an fd pair into this process")


def _open_fd_count():
    try:
        return len(os.listdir("/dev/fd"))
    except OSError:
        return None


class BridgePathSurvivesLLDBsOwnTokenizer(unittest.TestCase):

    """`-o "command script import <path>"` 的 <path> 由 **lldb 自己的分词器**再切
    一次：仓库装在带空格的路径（macOS 家目录常见）时，旧实现交的是裸路径，实测
    `error: module importing failed: invalid pathname '/tmp/gp'`，桥从未导入，而
    外层把这件事报成"开发者工具权限"——一个与病因无关的补救。"""

    def test_the_token_is_quoted_in_the_composed_argv(self):
        argv = gb.build_lldb_argv("/Users/me/My Repos/GlassPane/bridge/glasspane_bridge.py",
                                  mode="capture", exe="/tmp/crashme")
        token = next(item for item in argv if item.startswith("command script import "))
        self.assertEqual(token,
                         "command script import '/Users/me/My Repos/GlassPane/bridge/glasspane_bridge.py'",
                         token)
        # 路径里带单引号也不能裂：shell 接片段在 lldb 分词器里实测成立。
        self.assertEqual(gb.lldb_command_quote("/a'b/x.py"), "'/a'\\''b/x.py'")

    def _import_output(self, bridge_copy):
        """跑桥**自己组的那条 argv**（interactive 模式：import + gp-queue）。"""
        argv = gb.build_lldb_argv(bridge_copy, mode="interactive")
        return subprocess.run(argv, capture_output=True, text=True, timeout=180), argv

    def _place_bridge(self, directory_name):
        root = tempfile.mkdtemp(prefix="gp path ")
        self.addCleanup(shutil.rmtree, root, True)
        directory = os.path.join(root, directory_name)
        os.makedirs(directory)
        target = os.path.join(directory, "glasspane_bridge.py")
        shutil.copyfile(os.path.join(BRIDGE_DIR, "glasspane_bridge.py"), target)
        return target

    def test_real_lldb_imports_a_bridge_sitting_on_a_spaced_path(self):
        run_lldb(["script print('@@GPALIVE@@')"], timeout=120)
        for name in ("with space", "with'quote and space", 'with"dquote and space',
                     "both'\"q and space"):
            with self.subTest(path=name):
                bridge_copy = self._place_bridge(name)
                try:
                    completed, argv = self._import_output(bridge_copy)
                except (OSError, subprocess.SubprocessError) as error:
                    self.skipTest("NOT RUN（不是 pass）: 跑不起真 lldb：%r" % (error,))
                output = completed.stdout + completed.stderr
                if "importing failed" in output:
                    self.fail("桥在路径 %r 上导不进 lldb，真实 argv：%s；输出尾部：%s"
                              % (name, argv, output[-800:]))
                # 导进来 ≠ 采得到：命令注册与 stop-hook 安装才是 `__lldb_init_module`
                # 真跑过的证据。
                self.assertIn("Stop hook #1 added.", output, output[-800:])
                self.assertIn('"rearmLive"', output, output[-800:])
                self.assertEqual(completed.returncode, 0, output[-400:])

    def test_the_control_proves_this_assertion_has_teeth(self):
        """同一条真 lldb、同一个带空格的副本，只把 import token 退回旧的裸路径形态：
        必须**真的失败**并给出 "invalid pathname"。这条控制项就是"测试能红"的证明，
        不需要改源码来演示。"""
        bridge_copy = self._place_bridge("control space")
        try:
            completed = subprocess.run(
                ["xcrun", "lldb", "--batch",
                 "-o", "command script import %s" % bridge_copy,
                 "-o", "gp-queue", "-o", "quit"],
                capture_output=True, text=True, timeout=180)
        except (OSError, subprocess.SubprocessError) as error:
            # 与同组其余用例同一口径：没有 lldb 的机器（CI 的 ubuntu 那一格）要说 NOT RUN
            # 并给出复算命令，而不是让 FileNotFoundError 把这条闸报成一次产品失败。
            self.skipTest("NOT RUN（不是 pass）: 本机跑不起 `xcrun lldb`：%r。复算命令："
                          "xcrun lldb --batch -o \"script print(1)\" -o quit。" % (error,))
        output = completed.stdout + completed.stderr
        if "invalid pathname" not in output:
            self.skipTest("NOT RUN（不是 pass）: 这台 lldb 的分词器不拆裸空格路径，"
                          "控制项跑不出来。输出尾部：%r" % (output[-400:],))
        self.assertNotIn("Stop hook #1 added.", output)
        self.assertEqual(completed.returncode, 1, output[-400:])


SAMPLE_PATH = os.path.join(BRIDGE_DIR, "capture-sample.json")


class CaptureSampleMatchesEmitter(unittest.TestCase):
    """`bridge/capture-sample.json` 是 P6 spec 当作 capture 形态引用的那份文件
    （`specs/GlassPane_P6_实施规格_v6.0…` §"桥采证本身仍以 §34.5/`capture-sample.json`"），
    而从前**没有任何代码读它**：`watchpoints` 是账本 dump 而不是 §6.4 数组，
    `truncated`/`framesTotal`/`localsTotal`/`localsTruncated` 整个缺席，`status` /
    `stopReason` 是裸的 "5"/"10" 而契约是裸状态名。这里把键集比到**发射器自己**
    产出的形状上。

    出处照实说：帧、模块、寄存器那些**值**是遗留采集记录原样带过来的
    （`bridge/crashcanary.swift` 头里已注明那份存档来自已删除的 `crashme` 夹具）；
    键的形状、裸状态名、以及 `queue: null` 是由发射器（`_payload_from_process` →
    `thread_entry`/`frame_record`/`assemble_result`）重新生成、不是手写。所以顶帧
    `localsTotal: 0` 读作"发射器按已读到且为空"，其余帧的 `null` 读作"从未读"——
    那条分别是发射器的判词，不是第二次实测。真机重采仍归 opt-in 的
    `RealMachineCrashScene`。规格文件对本人只读，本报告里另记一句。
    """

    def load_sample(self):
        with open(SAMPLE_PATH, encoding="utf-8") as handle:
            return json.load(handle)

    def reference_payload(self):
        """The shape as the emitter writes it, driven through its own functions."""
        top = gb.frame_record(0, "App", "0x1000", file="a.swift", line=4, function="main",
                              locals_=[("x", "1")])
        callee = gb.frame_record(1, "dyld", "0x2000", function="start", locals_=None)
        thread = gb.thread_entry(1, "main", "signal", [top, callee], frames_total=2,
                                 queue="com.apple.main-thread")
        return gb.assemble_result(mode="capture", target={"pid": 1}, status="eStateStopped",
                                  threads=[thread], registers={"pc": "0x1"},
                                  stop_reason="signal", crash=gb.crash_record(5, 11),
                                  watchpoints=gb.WatchQueue().records())

    def test_sample_key_set_equals_the_emitters_key_set(self):
        sample, reference = self.load_sample(), self.reference_payload()
        self.assertEqual(set(reference), set(sample),
                         "capture-sample.json 与发射器的载荷键集不一致（规格把它当形态）")
        self.assertEqual(set(reference["target"]), set(sample["target"]))
        for row, reference_row in zip(sample["threads"], reference["threads"]):
            self.assertEqual(set(reference_row), set(row),
                             "threads[] 少/多了键：%s vs %s" % (sorted(row), sorted(reference_row)))
            always = {"idx", "module", "addr", "locals", "localsTotal", "localsTruncated"}
            for frame in row["frames"]:
                self.assertTrue(always <= set(frame),
                                "frames[] 缺了发射器一定会写的键：%s" % (sorted(always - set(frame)),))
            fullest = sorted(set(reference["threads"][0]["frames"][0]))
            richest = max(row["frames"], key=lambda frame: len(frame))
            self.assertEqual(fullest, sorted(set(richest)),
                             "没有一帧带齐了 frames[] 的全部键：%s" % sorted(richest))

    def test_sample_states_are_bare_names_not_raw_enum_numbers(self):
        sample = self.load_sample()
        self.assertIn(sample["status"], gb.PROCESS_STATE_NAMES, sample["status"])
        self.assertNotRegex(sample["stopReason"], r"^\d+$",
                            'stopReason 必须是载荷词汇，不是裸的 "10"')
        self.assertIsNotNone(gb.normalize_state(sample["status"])[1], sample["status"])
        self.assertIsNotNone(gb.normalize_stop_reason(sample["stopReason"])[1],
                             sample["stopReason"])
        for row in sample["threads"]:
            self.assertIsNotNone(gb.normalize_stop_reason(row["stopReason"])[1], row)

    def test_sample_watchpoints_are_the_6_4_array_not_a_ledger_dump(self):
        sample = self.load_sample()
        self.assertIsInstance(sample["watchpoints"], list,
                              "§6.4 的 watchpoints 是**每条请求一项的数组**，不是账本快照")
        self.assertNotIn("slots", sample["watchpoints"])
        record = gb.WatchQueue()
        record.add({"addr": "0x1000", "size": 8, "mode": "w"})
        self.assertEqual({"addr", "hwSlot", "queued", "hitCount", "armed", "reason"},
                         set(record.records()[0]),
                         "数组项的键集就是 §6.4 那一套，样本与发射器共用它")

    def test_sample_announces_truncation_and_keeps_unmeasured_unmeasured(self):
        sample = self.load_sample()
        self.assertIn("truncated", sample, "载荷必须带着截断宣告这一**键**（§6.1 不省空值）")
        self.assertIsInstance(sample["truncated"], dict)
        for row in sample["threads"]:
            self.assertIn("queue", row)
            self.assertIsNone(row["queue"],
                              "读不到的 queue 是 null（未测量），不是伪造的空字符串")
            frames = row["frames"]
            self.assertIsInstance(frames[0]["localsTotal"], int, "顶帧的 locals 是读过的")
            for frame in frames[1:]:
                self.assertIsNone(frame["localsTotal"],
                                  "非顶帧从未读局部变量，0 是一个没人测过的数")

    def test_sample_reads_with_the_same_verdicts_a_delivered_payload_gets(self):
        """The file doubles as the artefact of the documented hand-run
        (`lldb --batch -o "command script import …" -o gp-capture`), so the outer
        verdicts must be computable from it exactly as from a live payload."""
        sample = self.load_sample()
        self.assertTrue(gb.capture_succeeded(sample), "样本声称的是一次停住且采到线程的现场")
        self.assertFalse(gb.crash_reported(sample), sample.get("crash"))
        self.assertEqual(0, gb.outer_exit_code(sample),
                         "非崩溃现场交付出去就是 0；这份样本必须读得出那一档")


class NoPayloadCauseIsTriagedNotAssumed(unittest.TestCase):
    """载荷缺席的两种成因各有各的补救：桥没导入（路径形态）与调试席位被拒（权限）。
    从前一律写"去勾 Developer Tools"，路径里一个空格就让人勾一张永不生效的席位。"""

    #: 2026-10-20 本机真 lldb 实测的失败原文（`command script import /tmp/gp sp/b.py`）
    SPACED_PATH_STDERR = ("error: module importing failed: invalid pathname '/tmp/gp'\n"
                          "error: module importing failed: invalid pathname "
                          "'sp/glasspane_bridge.py'\n")
    GATED_STDERR = ("error: process attach failed: Not allowed to attach to process\n")
    #: S9-2（2026-10-29）：另两条**本机真 lldb 原文**。从前它们都落进 catch-all
    #: `debug-gated`，收到的补救是"去勾 Developer Tools"——两张 TCC 席位永远治不了
    #: 一个不存在的 pid，也治不了跨用户的 attach。
    NO_SUCH_PROCESS_STDERR = "error: attach failed: no such process\n"
    PEER_USER_STDERR = ("error: attach failed: process is running as user 'ethanlin' "
                        "and process is running as user 'root'\n")

    def test_path_shape_failure_names_the_path_and_not_permissions(self):
        cause, remedy = gb.no_payload_cause(self.SPACED_PATH_STDERR, "", "/tmp/gp sp/b.py")
        self.assertEqual(cause, "bridge-not-imported")
        self.assertIn("/tmp/gp sp/b.py", remedy)
        # 每一支补救都得是**调用者当场能跑的一行**。从前它写"remedy = 把仓库挪到
        # 这个 bug 够不着的路径，或者在 -o 文本里给路径加引号"——而 `build_lldb_argv`
        # 现在一律经 `lldb_command_quote` 加引号，后一支只能改源码，不是操作员的一步。
        for step in ("ls -l", "cp ", "python3 -c", "lldb_command_quote", "space"):
            self.assertIn(step, remedy, remedy)
        # 那条不可执行的老支路不许回来（这一行就是"改回旧文案立刻变红"的那一枚闸）。
        self.assertNotIn("quote the path in the -o text", remedy)
        self.assertNotIn("move the repo to a path this bug cannot reach", remedy)
        for permission_phrase in ("Developer Tools", "Privacy & Security"):
            self.assertNotIn(permission_phrase, remedy,
                             "路径形态的故障不许给出权限补救：%s" % remedy)

    def test_debug_gated_failure_still_gives_the_permission_remedy(self):
        cause, remedy = gb.no_payload_cause(self.GATED_STDERR, "", "/tmp/b.py")
        self.assertEqual(cause, "debug-gated")
        self.assertIn("Developer Tools", remedy)

    def test_triage_does_not_swallow_the_sentinel_clue(self):
        """分诊只回答"哪一种病因"，不许顶掉哨兵线索：哨兵从没出现（内层脚本没跑）
        与出现了但读不出，仍然是两件事，各有各的补救。"""
        nonce = gb.new_sentinel_nonce()
        cause, _remedy = gb.no_payload_cause(self.SPACED_PATH_STDERR,
                                             gb.wrap_sentinel("{broken", nonce=nonce),
                                             "/tmp/gp sp/b.py")
        self.assertEqual(cause, "bridge-not-imported",
                         "lldb 明说导入失败了，就不许因为载荷形状而改口报权限")
        self.assertEqual(gb.no_payload_cause("nothing useful at all\n", "", "/tmp/b.py")[0],
                         "debug-gated")

    def test_gone_pid_gets_a_step_that_changes_the_outcome(self):
        """S9-2：`no such process` 是 pid 不存在——最常见的操作失误。未改实现里这条
        真机原文落进 catch-all（断言今天红在 cause == "debug-gated"）。"""
        cause, remedy = gb.no_payload_cause(self.NO_SUCH_PROCESS_STDERR, "", "/tmp/b.py")
        self.assertNotEqual(cause, "debug-gated", "不存在的 pid 不许被折成权限猜测：%s" % cause)
        self.assertEqual(cause, "target-gone")
        self.assertNotIn("Developer Tools", remedy, "补救不许指向那张治不了它的席位：%s" % remedy)
        for part in ("no such process", "ps -p", "recycled"):
            self.assertIn(part, remedy, remedy)

    def test_cross_user_attach_gets_a_step_that_changes_the_outcome(self):
        """S9-2：跨用户/SIP 的 attach 拒绝（两侧属户不同）同样不许收 catch-all 的席位
        补救。未改实现里这条真机原文今天也红。"""
        cause, remedy = gb.no_payload_cause(self.PEER_USER_STDERR, "", "/tmp/b.py")
        self.assertNotEqual(cause, "debug-gated", cause)
        self.assertEqual(cause, "peer-user-or-sip")
        self.assertNotIn("Developer Tools", remedy, remedy)
        for part in ("user boundary", "ps -p", "sudo"):
            self.assertIn(part, remedy, remedy)

    def test_catch_all_admits_it_is_a_default_guess_not_a_measurement(self):
        """补臂之后 catch-all 仍然在（并仍给席位补救，控制项不许丢），但它必须**自陈**
        这不是测量——从前那句 "debug attach/launch is permission-gated on this machine"
        是一个从没测过的断言。"""
        cause, remedy = gb.no_payload_cause("some unclassified lldb line\n", "", "/tmp/b.py")
        self.assertEqual(cause, "debug-gated")
        self.assertIn("Developer Tools", remedy)
        self.assertIn("NOT a measurement", remedy, "catch-all 必须明写这是缺省猜测：%s" % remedy)


class RealMachineCrashScene(unittest.TestCase):
    """真崩溃采证（P6 §7.5 的执行面）：`bridge/crashcanary` 是入库夹具，跑一次
    debugserver。默认**不进 CI**（首启 >5min，P6 §0 F5），只认显式开关
    `GLASSPANE_REAL_LLDB=1` —— 与 engine/smoke.md 那条"只认显式开关"同口径。"""

    def test_crashcanary_stop_populates_crash_and_exits_non_zero(self):
        if os.environ.get(REAL_LLDB_OPT_IN) != "1":
            self.skipTest("NOT RUN（不是 pass）: 真崩溃采证要显式开关 "
                          "%s=1（debugserver 首启在本机 >5min，P6 §0 F5），"
                          "且需开发者工具调试席位（P6 §7.1）。复算命令："
                          "GLASSPANE_REAL_LLDB=1 python3 -m pytest -q bridge -k "
                          "RealMachineCrashScene" % REAL_LLDB_OPT_IN)
        canary = os.path.join(BRIDGE_DIR, "crashcanary")
        if not os.path.exists(canary):
            self.skipTest("NOT RUN（不是 pass）: 夹具 %s 不在；按 "
                          "bridge/crashcanary.swift 头里的 swiftc 命令重生成" % canary)
        out = os.path.join(tempfile.mkdtemp(prefix="gp crash "), "capture.json")
        self.addCleanup(_remove_quietly, out)
        completed = subprocess.run(
            [sys.executable, os.path.join(BRIDGE_DIR, "glasspane_bridge.py"),
             "capture", "--exe", canary, "--out", out, "--timeout", "150"],
            capture_output=True, text=True, timeout=200)
        payload, _raw = gb.extract_sentinel(completed.stdout)
        if payload is None or payload.get("status") == "failed" or not payload.get("threads"):
            self.skipTest("NOT RUN（不是 pass）: 这台机器上跑不出崩溃现场（调试权限门控"
                          "或 debugserver 未热）。退出码 %s，载荷：%s"
                          % (completed.returncode, json.dumps(payload, ensure_ascii=False)[-500:]
                             if payload else completed.stderr[-500:]))
        self.assertTrue(gb.crash_reported(payload), json.dumps(payload)[:800])
        self.assertEqual(payload["stopReason"], "signal", json.dumps(payload)[:800])
        self.assertIsNotNone(payload["crash"])
        self.assertIn("signal ", payload["crash"]["signal"])
        self.assertNotEqual(completed.returncode, 0,
                            "一次崩溃不许以 0 离场：%s" % payload["crash"])
        self.assertEqual(completed.returncode, 3)


def _ps_state_stopped(pid):
    """The fixture's own reading of `ps`, independent of the bridge: a test that can only
    ask the implementation-under-test whether the process woke is a test that goes red for
    the wrong reason (and green when the code claims what it did not do)."""
    got = subprocess.run(["ps", "-p", str(int(pid)), "-o", "state="],
                         capture_output=True, text=True)
    text = (got.stdout or "").strip()
    return bool(text) and text[0].upper() == "T"


def _emitted_payload(stdout_text):
    """`emit` 写出去的那一行是**带哨兵对**的，不是裸 JSON——读它要用桥自己的读法，
    第二份解析器只会造出第二种错。"""
    payload, _raw = gb.extract_sentinel(stdout_text)
    assert payload is not None, "stdout 里没有一个可解析的哨兵载荷：%r" % stdout_text
    return payload


def _kill_quietly(pid):
    try:
        os.kill(int(pid), signal.SIGKILL)
    except (OSError, ValueError):
        pass
    try:
        os.waitpid(int(pid), 0)
    except (OSError, ValueError):
        pass


def _remove_quietly(path):
    try:
        os.unlink(path)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# 2026-10-24 发布链/尺子/桥 泳道（qoder-20261024-rel-*）补的桥侧用例：D3 / D4 / D7 / F7 / F2-F3。
# 每一条都是先对着**未改的实现**跑红的：写在下面的注释里的是那一次红的名字。
# ---------------------------------------------------------------------------

class CaptureBudgetIsClampedNotFatal(unittest.TestCase):
    """D3：`GPBRIDGE_BUDGET=abc` 从前让桥以一段 ValueError traceback 离场、退 1，
    `--out` 与 `--send-sock` 零字节——本机已被上一泳道实测复现。§6.2 说的是"失败也以
    JSON 离场"，而 traceback 不是 JSON：一个字段都读不到。"""

    def test_unparsable_budget_falls_back_to_the_default_and_says_so(self):
        # 红的名字：`AttributeError: module 'glasspane_bridge' has no attribute
        # 'capture_budget_s'`（未改实现里没有这一个判据）。
        budget, note = gb.capture_budget_s("abc", 120)
        self.assertEqual(60.0, budget, "解析不进去就用 BUDGET_DEFAULT_S，不是崩、也不是 0")
        self.assertIsNotNone(note, "被忽略的那个值必须被说出来，不能悄悄换成默认")
        self.assertIn("abc", note)

    def test_budget_is_clamped_between_the_floor_and_the_outer_timeout(self):
        self.assertEqual((30.0, gb.capture_budget_s("1", 120)[1]),
                         gb.capture_budget_s("1", 120),
                         "比 debugserver 冷启动还短的预算要钳到 30s 地板")
        budget, note = gb.capture_budget_s("99999", 120)
        self.assertEqual(120.0, budget,
                         "比外层 --timeout 还长的预算永远不会被观测到——外层先 killpg")
        self.assertIn("clamped", note)
        self.assertEqual((60.0, None), gb.capture_budget_s(None, 120),
                         "没设这个环境变量时不许编出一条 note")

    def test_build_lldb_argv_survives_a_garbage_budget(self):
        """未改实现的那一条红：`ValueError: could not convert string to float: 'abc'`
        从 `build_lldb_argv` 里抛出来，早于任何一次 spawn。"""
        with mock.patch.dict(os.environ, {"GPBRIDGE_BUDGET": "abc"}):
            argv = gb.build_lldb_argv("/tmp/glasspane_bridge.py", mode="capture",
                                      exe="/bin/false", timeout=120)
        spec = json.loads(base64.b64decode(
            [a for a in argv if a.startswith("script glasspane_bridge.run_capture_cli_b64(")][0]
            .split("'", 2)[1]).decode("utf-8"))
        self.assertEqual(60.0, spec["budget_s"])
        self.assertIn("GPBRIDGE_BUDGET", spec.get("budget_note", ""),
                      "被退回默认值这件事要跟着载荷走，而不是只在外层说说")

    def test_run_outer_leaves_json_when_the_budget_env_is_garbage(self):
        """整条路径的判据：§6.2 的"失败也以 JSON 离场"必须由**退出码 + stdout** 一起兑现。"""
        seen = {}

        def fake_child(argv, timeout, env=None):
            seen["nonce"] = (env or {}).get(gb.SENTINEL_NONCE_ENV)
            payload = {"mode": "capture", "status": "eStateStopped", "threads": [{"id": 1}]}
            return gb._Completed(0, gb.wrap_sentinel(json.dumps(payload), nonce=seen["nonce"]), ""), False

        out = io.StringIO()
        with mock.patch.dict(os.environ, {"GPBRIDGE_BUDGET": "abc"}), \
                mock.patch.object(gb, "run_child_captured", side_effect=fake_child), \
                contextlib.redirect_stdout(out):
            code = gb.main(["capture", "--exe", "/bin/false", "--timeout", "120"])
        self.assertIn(code, (0, 1, 3), "退 1 加一段 traceback 就是 D3 的本体")
        emitted = _emitted_payload(out.getvalue())
        joined = " ".join(emitted.get("errors", []))
        self.assertIn("GPBRIDGE_BUDGET", joined,
                      "载荷里读不到这一句，调用方就永远不知道自己跑的是哪一档预算")


class DisarmFailureKeepsTheWatchpointHandle(unittest.TestCase):
    """D4：`_disarm_watchpoint` 从前在 `Disable()` 成功**之前**就 `pop`。失败时那个
    SBWatchpoint 永久失联（没有第二处还拿着它）、硬件槽位没让出，而账本已经在同一条
    路径上 `release(addr)` 并把队头 arm 进同一个槽。"""

    def setUp(self):
        self.live = {}
        mock.patch.object(gb, "_LIVE_WATCHPOINTS", self.live).start()
        self.addCleanup(mock.patch.stopall)

    def test_failed_disable_leaves_the_handle_tracked_for_the_next_reconcile(self):
        # 红的名字：`AssertionError: 0x1001 must stay tracked` —— 未改实现先 pop 再 Disable。
        stuck = StubWatchpoint(7, disable_results=[False, True])
        self.live["0x1001"] = stuck
        ok, detail = gb._disarm_watchpoint("0x1001")
        self.assertFalse(ok, detail)
        self.assertIn("0x1001", self.live,
                      "Disable 没成功就把句柄摘掉，下一次 reconcile 再也认不出这条监视点")
        self.assertEqual(1, stuck.disable_calls)
        # 第二次调用（"下一次 reconcile"）必须还能试，并且成功之后才摘。
        ok2, _detail = gb._disarm_watchpoint("0x1001")
        self.assertTrue(ok2, ok2)
        self.assertEqual(2, stuck.disable_calls)
        self.assertNotIn("0x1001", self.live, "成功之后句柄才该走")

    def test_reconcile_notes_the_unconfirmed_disable_and_still_records_the_hit(self):
        queue = gb.WatchQueue()
        live = {}
        armed_calls = []

        def fake_arm(debugger, entry):
            armed_calls.append(dict(entry))
            return (True, str(len(armed_calls)))

        for attribute, value in (("_WATCH_QUEUE", queue), ("_LIVE_WATCHPOINTS", live),
                                 ("_RECONCILED_STOPS", set())):
            mock.patch.object(gb, attribute, value).start()
        mock.patch.object(gb, "_arm_watchpoint", side_effect=fake_arm).start()
        self.addCleanup(mock.patch.stopall)
        for index in range(gb.HW_WATCHPOINT_SLOTS):
            addr = "0x%x" % (0x1000 + index)
            queue.add({"addr": addr, "size": 8, "mode": "w"})
            queue.mark_live(addr)
            live[addr] = StubWatchpoint(100 + index, disable_results=[False])
        queue.add({"addr": "0x2000", "size": 8, "mode": "w"})
        stuck = live["0x1001"]
        threads = [StubThread(tid=11, stop_reason=4, stop_data=(stuck.GetID(), 0x1001),
                              frames=[StubFrame(function="main")])]
        process = StubProcess(threads=threads, stop_id=7)
        report = gb.reconcile_watchpoint_stops(StubDebugger(process), process)
        self.assertEqual(["0x1001"], report["hits"], report)
        # 那条 note 住在**账本**里（它要随每个 payload 的 errors[] 出去），而不是 report["notes"]：
        # 判据落在读它的那一侧，而不是落在测试方便写的那一侧。
        self.assertTrue(any("not confirmed disabled" in n for n in queue.notes),
                        (report["notes"], queue.notes))
        self.assertIn("0x1001", live, "判据不许把没让出的槽位说成已经让出")
        self.assertIn("0x2000", [call["addr"] for call in armed_calls],
                      "队头仍然被 arm 进那个槽——这正是 note 要说出来的代价")


class NonTimeoutChildFailureStillKillsTheGroup(unittest.TestCase):
    """D7：`communicate()` 抛**非 TimeoutExpired** 异常时，`finally` 只关管道 + wait，
    从不 killpg——而 :922-926 整段论证的就是"只杀直接子进程会把目标留在 SIGSTOP"。"""

    def test_injected_non_timeout_exception_still_kills_the_child_group(self):
        real_popen = subprocess.Popen
        created = []

        class Exploding(object):
            """A real child whose `communicate()` raises something that is not a timeout."""

            def __init__(self, argv, **kwargs):
                self._p = real_popen(argv, **kwargs)
                created.append(self._p)

            def communicate(self, timeout=None):
                raise ValueError("injected non-timeout failure inside communicate()")

            def __getattr__(self, name):
                return getattr(self._p, name)

        with mock.patch.object(subprocess, "Popen", Exploding):
            with self.assertRaises(ValueError):
                gb.run_child_captured([sys.executable, "-c", "import time; time.sleep(300)"],
                                      timeout=30.0)
        self.assertEqual(1, len(created))
        child = created[0]
        # 红的名字：`AssertionError: the child outlived a non-timeout communicate() failure`
        # ——未改实现那条路径关管道、wait 到超时，然后留下一个活着的进程组。
        pid = child.pid
        alive = True
        deadline = time.time() + 5
        while time.time() < deadline:
            try:
                os.kill(pid, 0)
            except OSError:
                alive = False
                break
            time.sleep(0.05)
        self.assertFalse(alive,
                         "pid %d 还活着：非超时的失败没被整组收掉，被 attach 的目标就留在那里" % pid)


class TimeoutWakesTheAttachedTarget(unittest.TestCase):
    """F7：超时整组 SIGKILL 之后，被 `--pid` 附上的进程仍停在 SIGSTOP（全仓无 SIGCONT），
    而载荷那一句写的是 "a target that had been stopped here is no longer held by this
    bridge"。那不是判决，是一次谎。"""

    def _stopped_child(self):
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
        self.addCleanup(lambda: _kill_quietly(child.pid))
        os.kill(child.pid, signal.SIGSTOP)
        deadline = time.time() + 5
        while time.time() < deadline and not _ps_state_stopped(child.pid):
            time.sleep(0.05)
        self.assertTrue(_ps_state_stopped(child.pid),
                        "夹具没能造出一个停住的进程，这一条就测不到任何东西")
        return child

    def test_resume_frozen_target_wakes_a_sigstopped_pid(self):
        # 红的名字：`AttributeError: module 'glasspane_bridge' has no attribute
        # 'resume_frozen_target'`（未改实现连唤醒都不做）。
        child = self._stopped_child()
        woke, detail = gb.resume_frozen_target(child.pid)
        self.assertTrue(woke, detail)
        self.assertFalse(_ps_state_stopped(child.pid),
                         "说过它醒了，就必须读回一个不是 T 的状态")

    def test_resume_reports_a_gone_pid_and_a_missing_pid_honestly(self):
        spawned = self._stopped_child()
        pid = spawned.pid
        spawned.kill()
        spawned.wait()
        woke, detail = gb.resume_frozen_target(pid)
        self.assertTrue(woke, detail)
        self.assertIn("gone", detail)
        woke, detail = gb.resume_frozen_target(None)
        self.assertFalse(woke, "没有 --pid 时不许声称自己唤醒过什么")
        self.assertIn("no --pid", detail)

    def test_timeout_payload_says_whether_the_target_actually_woke(self):
        child = self._stopped_child()
        timed_out = gb._Completed(None, "", "")

        def fake_child(argv, timeout, env=None):
            return timed_out, True

        out = io.StringIO()
        with mock.patch.object(gb, "run_child_captured", side_effect=fake_child), \
                contextlib.redirect_stdout(out):
            code = gb.main(["capture", "--pid", str(child.pid), "--timeout", "1"])
        self.assertEqual(1, code)
        emitted = _emitted_payload(out.getvalue())
        joined = " ".join(emitted.get("errors", []))
        self.assertNotIn("no longer held by this bridge", joined,
                         "那句无人验过的断言不许回来：它就是这一条缺陷的本体")
        self.assertNotIn("IT IS NOT CONFIRMED RESUMED", joined, joined)
        self.assertIn("it was resumed", joined, joined)
        self.assertFalse(_ps_state_stopped(child.pid),
                         "载荷说醒了而进程还停着，就是同一句谎的第二个版本")

    def test_unmeasurable_wake_is_reported_as_unmeasured_not_as_woken(self):
        child = self._stopped_child()
        timed_out = gb._Completed(None, "", "")
        out = io.StringIO()
        with mock.patch.object(gb, "run_child_captured", side_effect=lambda *a, **k: (timed_out, True)), \
                mock.patch.object(gb, "_process_is_stopped", return_value=None), \
                contextlib.redirect_stdout(out):
            gb.main(["capture", "--pid", str(child.pid), "--timeout", "1"])
        emitted = _emitted_payload(out.getvalue())
        joined = " ".join(emitted.get("errors", []))
        self.assertIn("NOT measured", joined, joined)
        self.assertNotIn("it was resumed", joined,
                         "读不到状态就是没测到，不许写成已经醒了")


class RemedyCommandsStayOneShellWord(unittest.TestCase):
    """F2/F3：remedy 是给 agent 抄进 shell 的一行。旧文案四处 `'%s'` 插值**没走 quoting**
    （`bridge_path` 来自 `__file__`，目录名里一个 `'` 就破形），落点还是世界可写目录里
    一个可预测的名字。`mcp-shell/test/remedy-shell-quoting.test.mjs` 的扫描面不含
    `bridge/*.py`，而那条闸住在别的泳道里（本泳道没有 mcp-shell 的写权限），所以 Python
    面的词形由这一条自己钉。"""

    HOSTILE = ["/tmp/gp/it's/glasspane_bridge.py",
               "/tmp/gp sp/glasspane_bridge.py",
               "/tmp/x`;touch /tmp/pwned/glasspane_bridge.py"]
    STDERR = "error: module importing failed: invalid pathname '/tmp/gp'\n"

    def _commands(self, remedy):
        """每一支当场可跑的补救：反引号里、以命令词开头的那些（prose 那一支跳过）。"""
        heads = ("ls ", "python3 ", "dest_dir=", "rm ")
        return [span for span in re.findall(r"`([^`]+)`", remedy)
                if span.strip().startswith(heads)]

    def test_every_remedy_command_parses_with_the_path_as_one_word(self):
        """词形判据。反引号是这段文字的 markdown 边界，所以**名字里带反引号**的路径不能
        用"取反引号之间的命令"这个读法——那测的是 markdown 而不是 shell。真正的注入面
        是 `'`（把引号组撕开的那一枚）与空格，两者都在这里逐词判；反引号那一支由
        `test_remedy_never_interpolates_the_path_unquoted` 用同一个 shlex.quote 形态判。"""
        for path in [p for p in self.HOSTILE if "`" not in p] + ["/tmp/it's/glasspane_bridge.py"]:
            cause, remedy = gb.no_payload_cause(self.STDERR, "", path)
            self.assertEqual("bridge-not-imported", cause)
            commands = self._commands(remedy)
            self.assertTrue(commands, "remedy 里一支可跑的命令都没有：%s" % remedy)
            for cmd in commands:
                try:
                    words = shlex.split(cmd)
                except ValueError as error:
                    self.fail("路径 %r 让 remedy 的这一支不再是合法 shell：%r\n  %s"
                              % (path, error, cmd))
                if "ls -l" in cmd or " cp " in cmd or cmd.startswith("python3 -c"):
                    self.assertIn(path, words,
                                  "路径必须是**一个词**，而它被拆成了：%r" % (words,))
                    self.assertNotIn("touch", words, "破形之后多出来的那个词就是注入：%r" % (words,))
                    self.assertNotIn("/tmp/pwned", words)
                    self.assertNotIn("s/glasspane_bridge.py", words,
                                     "被 `'` 撕开之后剩下的那半截就是第二个词：%r" % (words,))

    def test_the_landing_spot_is_no_longer_a_predictable_world_writable_path(self):
        _cause, remedy = gb.no_payload_cause(self.STDERR, "", "/tmp/it's/glasspane_bridge.py")
        # 只看**当场要跑的那几行**：prose 里可以出现那个名字（本条就在说它为什么不行），
        # 而 `cp … /tmp/<固定名>` 那一支一旦出现就是把自己交给第一个抢到那个名字的本地账号。
        for cmd in self._commands(remedy):
            self.assertNotIn("/tmp/glasspane_bridge.py", cmd,
                             "世界可写目录里的固定名字：谁先建谁就是这段代码的作者\n  %s" % cmd)
        self.assertTrue(any("mktemp -d" in cmd for cmd in self._commands(remedy)),
                        "0700、名字不可预测，才是这条 cp 该有的落点")

    def test_remedy_quotes_the_path_it_interpolates(self):
        """对着未改实现的红那一行：`AssertionError: 旧文案的插值形态 '<path>' 还在
        remedy 里` —— 那是 `'%s'` 直接拼出来的东西，目录名里一个 `'` 就破形。"""
        for path in self.HOSTILE:
            _cause, remedy = gb.no_payload_cause(self.STDERR, "", path)
            self.assertIn(shlex.quote(path), remedy,
                          "remedy 里的路径必须已经是 POSIX-shell 引用过的形态：%r" % path)
            if "'" in path:
                self.assertNotIn("'%s'" % path, remedy,
                                 "裸的 \"'\" + path + \"'\" 不是引用，是把 path 里那个引号当边界")
        # 旧落点：世界可写目录里一个可预测的名字，谁先建谁就是这段代码的作者。
        _cause, remedy = gb.no_payload_cause(self.STDERR, "", "/tmp/x/glasspane_bridge.py")
        for cmd in self._commands(remedy):
            self.assertNotIn("/tmp/glasspane_bridge.py", cmd, cmd)


# ---------------------------------------------------------------------------
# 收口补测（qoder-20261024-release-chain）：上面那批 `qoder-20261024-rel-*` 用例写完了
# D3/D4/D7/F7/F2-F3 的主干，本段补的是它们没各自点到的格子——预算五种输入的**逐档**
# 形状（inf / 0 / 负数在前面的表里只是一格）、run_outer 对每一档垃圾值都"以 JSON 离场、
# 不以 traceback 离场"、`resume_frozen_target` 四条出路在桩下逐条对报文（不借真进程，
# 桩化 os.kill 与 `ps` 输出本身）、`_disarm_watchpoint` 失败时**账本不 release**（前面
# 判的是 reconcile 层的代价，这里判的是这个函数自己的边界），以及 remedy 里
# `python3 -c` 那一支把路径**当参数递进去**而不是插进被引起来的程序体。
# REVERSE MUTATIONS（每条 2026-10-24 实测过红，备份在
# /var/tmp/glasspane-main-check/snapshots/relt/，shasum -a 256 核回）：
#   · `if value != value or value in (inf, -inf):` → `if False:` → 五种输入那条红在
#     "inf 那一档必须说 not a finite number"；
#   · `clamped = min(max(value, floor), ceiling)` → `clamped = value` → 同一条红在
#     0/负数那一档（预算原样返回、note 为空）；
#   · `build_lldb_argv` 里改用回旧写法 `max(30.0, float(os.environ.get(...)))` →
#     traceback 那条红在 "abc 让 main 抛了出来"（正是 D3 的本体）；
#   · `stopped = _process_is_stopped(numeric)` 之后把 True 那一支报成"已恢复" →
#     四条出路那条红在"读完仍是 stopped 不许说醒了"；
#   · `_disarm_watchpoint` 里 `if ok:` → `if True:` → 句柄/账本那条红在"失败后地址
#     还该在表里"；
#   · `quoted = shlex.quote(str(named_us))` → `quoted = str(named_us)` → remedy 那条红在
#     "`python3 -c` 那一支不再是一个合法词序列"。
# ---------------------------------------------------------------------------

class CaptureBudgetFiveArmsAndNoTracebackExit(unittest.TestCase):
    """D3 的逐档表：非数、inf、超大值、0/负数、缺省，各回各的形状，note 点名原值；
    且每一档下 run_outer 都以 §6.2 的 JSON 离场，不是 traceback。"""

    def test_each_input_answers_its_documented_arm(self):
        cases = [
            # (输入, timeout, 期望秒数, note 必须含的子串)
            ("abc", 120, 60.0, ["not a number", "abc"]),
            ("inf", 120, 60.0, ["not a finite number", "inf"]),
            ("-inf", 120, 60.0, ["not a finite number", "-inf"]),
            ("99999", 120, 120.0, ["clamped", "99999"]),
            ("0", 120, 30.0, ["clamped", "GPBRIDGE_BUDGET=0"]),
            ("-5", 120, 30.0, ["clamped", "-5"]),
            (None, 120, 60.0, None),
            ("45", 120, 45.0, None),
        ]
        for raw, timeout, want, note_parts in cases:
            with self.subTest(raw=raw):
                budget, note = gb.capture_budget_s(raw, timeout)
                self.assertEqual(want, budget)
                if note_parts is None:
                    self.assertIsNone(note, "合法值与缺省不许编出一条 note：%r" % (note,))
                    continue
                self.assertIsNotNone(note)
                for part in note_parts:
                    self.assertIn(part, note, "errors 文案必须点名原值/原档位：%r" % note)

    def test_no_garbage_budget_leaves_the_bridge_through_a_traceback(self):
        """§6.2 的离场判据逐档走一遍：main 不许抛，stdout 必须是带哨兵的 JSON，
        且 payload 的 errors[] 里读得到那句"这个值被动过"。"""
        for raw in ("abc", "inf", "-inf", "0", "-5", "99999"):
            with self.subTest(raw=raw):
                seen = {}

                def fake_child(argv, timeout, env=None):
                    seen["nonce"] = (env or {}).get(gb.SENTINEL_NONCE_ENV)
                    payload = {"mode": "capture", "status": "eStateStopped",
                               "threads": [{"id": 1}]}
                    return gb._Completed(0, gb.wrap_sentinel(json.dumps(payload),
                                                             nonce=seen["nonce"]), ""), False

                out = io.StringIO()
                try:
                    with mock.patch.dict(os.environ, {"GPBRIDGE_BUDGET": raw}), \
                            mock.patch.object(gb, "run_child_captured", side_effect=fake_child), \
                            contextlib.redirect_stdout(out):
                        code = gb.main(["capture", "--exe", "/bin/false", "--timeout", "120"])
                except Exception as error:
                    self.fail("GPBRIDGE_BUDGET=%r 让 main 抛了（%r）——traceback 不是 JSON 离场，"
                              "就是 D3 的本体" % (raw, error))
                self.assertIn(code, (0, 1, 3), "退出码必须是既定的那一族，不是解释器的 1+traceback")
                emitted = _emitted_payload(out.getvalue())
                joined = " ".join(emitted.get("errors", []))
                self.assertIn("GPBRIDGE_BUDGET", joined,
                              "每一档都得在载荷里留下名字：%r" % (emitted,))
                self.assertIn(raw, joined, "errors 要点名原值：%r" % joined)


class ResumeFrozenTargetOutcomesUnderStubs(unittest.TestCase):
    """F7 的桩面版：四条出路（唤醒成功 / SIGCONT 失败 / 读完仍是 stopped / 读不到状态）
    各自喂一个桩化的 os.kill 与 `ps` 输出——报文必须与**被桩掉的观测**一致，不许把
    "没观测"写成"已恢复"，也不许在 kill 都没落到时去读 ps 并编出一条状态。"""

    def _run(self, kill_side_effect, ps_stdout):
        run_calls = []

        def fake_run(argv, **kwargs):
            run_calls.append(argv)
            return types.SimpleNamespace(stdout=ps_stdout, returncode=0)

        with mock.patch.object(gb.os, "kill", side_effect=kill_side_effect), \
                mock.patch.object(gb.subprocess, "run", side_effect=fake_run):
            woke, detail = gb.resume_frozen_target(4242)
        return woke, detail, run_calls

    def test_wake_success_is_reported_only_when_ps_reads_not_stopped(self):
        woke, detail, calls = self._run(None, "S")
        self.assertTrue(woke, detail)
        self.assertIn("reads as running again", detail)
        self.assertEqual(1, len(calls), "唤醒判据必须真的读了 ps，而不是没读就说醒了")
        self.assertEqual(["ps", "-p", "4242"], calls[0][:3])

    def test_failed_sigcont_says_still_held_and_never_consults_ps(self):
        woke, detail, calls = self._run(PermissionError(1, "Operation not permitted"), "S")
        self.assertFalse(woke, detail)
        self.assertIn("STILL held stopped", detail)
        self.assertIn("SIGCONT to pid 4242 failed", detail)
        self.assertEqual([], calls, "kill 没落到时读到的任何状态都是编的")

    def test_still_stopped_after_cont_is_reported_as_not_resumed(self):
        woke, detail, _calls = self._run(None, "T")
        self.assertFalse(woke, "读完仍是 stopped 却报成唤醒，就是那句谎的桩版")
        self.assertIn("STILL reads as stopped", detail)
        self.assertNotIn("running again", detail)

    def test_unreadable_state_is_reported_as_not_measured(self):
        woke, detail, _calls = self._run(None, "   ")
        self.assertFalse(woke, detail)
        self.assertIn("could not read its state", detail)
        self.assertIn("NOT measured", detail)
        self.assertNotIn("running again", detail, "读不到 = 没测到，不是测到了'没停'")

    def test_gone_and_nonexistent_pid_arms(self):
        woke, detail, _ = self._run(ProcessLookupError(3, "no such process"), "")
        self.assertTrue(woke, detail)
        self.assertIn("gone", detail)
        woke, detail = gb.resume_frozen_target(None)
        self.assertFalse(woke)
        self.assertIn("no --pid", detail)
        woke, detail = gb.resume_frozen_target("not-a-pid")
        self.assertFalse(woke)
        self.assertIn("not a number", detail)


class DisarmFailureIsItsOwnLedgerBoundary(unittest.TestCase):
    """D4 的函数边界：上面的 reconcile 用例判的是"代价要 note 出来"，这里判的是
    `_disarm_watchpoint` 自己——失败时句柄留在表里、`_addr_for_watchpoint_id` 还认得它、
    账本一条不动；成功时只摘句柄，release 仍然是调用方的事。"""

    def setUp(self):
        self.live = {}
        self.queue = gb.WatchQueue()
        mock.patch.object(gb, "_LIVE_WATCHPOINTS", self.live).start()
        mock.patch.object(gb, "_WATCH_QUEUE", self.queue).start()
        self.addCleanup(mock.patch.stopall)
        self.assertEqual("armed", self.queue.add({"addr": "0x2001", "size": 8, "mode": "w"})[0])
        self.queue.mark_live("0x2001")

    def test_failed_disable_keeps_the_handle_resolvable_and_touches_no_ledger(self):
        stuck = StubWatchpoint(9, disable_results=[False])
        self.live["0x2001"] = stuck
        ok, detail = gb._disarm_watchpoint("0x2001")
        self.assertFalse(ok, detail)
        self.assertIn("0x2001", self.live, "Disable 失败后句柄必须还在表里")
        self.assertEqual("0x2001", gb._addr_for_watchpoint_id(9),
                         "下一次停打在这条监视点上，还必须认得出它是谁")
        self.assertEqual(["0x2001"], [e["addr"] for e in self.queue.armed],
                         "这个函数不许动账本：release 是命中处理那条路径的事")
        self.assertEqual([], self.queue.spent, "失败的一支不许被记成 spent")

    def test_successful_disable_pops_only_the_handle(self):
        done = StubWatchpoint(10, disable_results=[True])
        self.live["0x2001"] = done
        ok, detail = gb._disarm_watchpoint("0x2001")
        self.assertTrue(ok, detail)
        self.assertNotIn("0x2001", self.live, "成功之后句柄才该走")
        self.assertIsNone(gb._addr_for_watchpoint_id(10),
                          "句柄走了这条监视点就不许再被认成活的")
        self.assertEqual(["0x2001"], [e["addr"] for e in self.queue.armed],
                         "pop 句柄不等于替调用方 release 账本")

    def test_untracked_address_and_missing_binding_answer_honestly(self):
        ok, detail = gb._disarm_watchpoint("0xdead")
        self.assertFalse(ok)
        self.assertIn("no live watchpoint", detail)

        class NoDisable(object):
            def GetID(self):
                return 11

        self.live["0x3002"] = NoDisable()
        ok, detail = gb._disarm_watchpoint("0x3002")
        self.assertFalse(ok, detail)
        self.assertIn("no SBWatchpoint.Disable()", detail)
        self.assertIn("0x3002", self.live, "连 Disable 都没有的绑定，句柄同样不许消失")


class RemedyArmsAreQuotedArgumentsNotInterpolations(unittest.TestCase):
    """F2/F3 的另两个角：`python3 -c` 那一支把路径**作为 argv 词**递进去（程序体里
    不许再出现插值——那是第二个 quoting surface），cp 那一支的落点是 `$dest_dir` 引起来的
    字面量、全程读不出裸 `/tmp/glasspane_bridge.py` 这个词。"""

    HOSTILE = ["/tmp/gp/it's/glasspane_bridge.py", "/tmp/gp sp/glasspane_bridge.py"]

    def _arms(self, remedy):
        heads = ("ls ", "python3 ", "dest_dir=")
        return [span for span in re.findall(r"`([^`]+)`", remedy)
                if span.strip().startswith(heads)]

    def test_python_c_arm_carries_the_path_as_argv_and_no_path_in_the_program(self):
        for path in self.HOSTILE:
            with self.subTest(path=path):
                _cause, remedy = gb.no_payload_cause(
                    "error: module importing failed: invalid pathname '/tmp/gp'\n", "", path)
                arm = [cmd for cmd in self._arms(remedy) if cmd.startswith("python3 -c")]
                self.assertEqual(1, len(arm), remedy)
                try:
                    words = shlex.split(arm[0])
                except ValueError as error:
                    self.fail("带 %r 的 checkout 路径把 remedy 撕开了：%r（%s）" % (path, error, arm[0]))
                self.assertEqual(4, len(words), "python3 -c <程序体> <路径>，一词不多一词不少：%r" % (words,))
                self.assertEqual(["python3", "-c"], words[:2])
                self.assertIn("sys.argv[1]", words[2], "路径必须经 argv 递进去，不许插进被引起来的程序体")
                self.assertNotIn(path, words[2], "程序体里出现原路径 = 又一次裸插值")
                self.assertEqual(path, words[3], "路径必须整体是一个词：%r" % (words,))

    def test_copy_arm_lands_in_a_private_dir_and_never_names_the_fixed_tmp_path(self):
        for path in self.HOSTILE + ["/tmp/x/glasspane_bridge.py"]:
            with self.subTest(path=path):
                _cause, remedy = gb.no_payload_cause(
                    "error: module importing failed: invalid pathname '/tmp/gp'\n", "", path)
                arms = self._arms(remedy)
                self.assertTrue(any("mktemp -d" in cmd for cmd in arms), remedy)
                for cmd in arms:
                    words = shlex.split(cmd)
                    self.assertNotIn("/tmp/glasspane_bridge.py", words,
                                     "世界可写目录里的可预测名字不许以任何一支命令的形式回来：%s" % cmd)
                cp_arm = [cmd for cmd in arms if cmd.startswith("dest_dir=")]
                self.assertEqual(1, len(cp_arm), remedy)
                words = shlex.split(cp_arm[0])
                self.assertIn(path, words, "cp 的源必须是原路径的那一个词：%r" % (words,))
                self.assertIn('"$dest_dir/glasspane_bridge.py"', cp_arm[0],
                              "落点只能是那个引起来的 $dest_dir 字面量")


class NoPayloadCauseReadsOnlyTheTrustedChannel(unittest.TestCase):
    """DEFECT 1：载荷缺席的成因只从桥自己的可信通道（lldb 的 stderr）判。被调试目标
    的 stdout 与 lldb 的 stdout 共用一条流（§ R30），绝不能因为目标自己 print 的一句
    "cat: config: No such file or directory" 就自信地报 "bridge-not-imported"——那是
    一条从没测量过的病因，配的补救还指向错误的 checkout 路径。"""

    TARGET_NOISE = "cat: config: No such file or directory\n"

    def test_target_stdout_cannot_trigger_the_import_cause(self):
        cause, _remedy = gb.no_payload_cause("", self.TARGET_NOISE, "/tmp/b.py")
        self.assertNotEqual(cause, "bridge-not-imported",
                            "目标的 stdout 不许被读成桥没导入：%s" % cause)
        self.assertEqual(cause, "not-determinable",
                         "可信通道（stderr）没写任何东西，成因不可测量，只能说不确定")

    def test_not_determinable_does_not_point_at_the_checkout_path(self):
        _cause, remedy = gb.no_payload_cause("", self.TARGET_NOISE, "/tmp/b.py")
        self.assertIn("cannot be measured", remedy)
        # 补救不许指向那条从没被证实过的病因（checkout 路径 / 权限席位）。
        self.assertNotIn("mktemp -d", remedy)
        self.assertNotIn("Developer Tools", remedy)

    def test_import_failure_still_classifies_from_stderr_alone(self):
        # 控制项：真正的 lldb 导入失败写在可信的 stderr 上，仍判 bridge-not-imported。
        cause, _ = gb.no_payload_cause(
            "error: module importing failed: invalid pathname '/tmp/gp'\n",
            "", "/tmp/gp sp/b.py")
        self.assertEqual(cause, "bridge-not-imported")

    def test_return_shape_stays_a_two_tuple_for_callers(self):
        for args in (("", self.TARGET_NOISE, "/b.py"),
                     ("error: process attach failed\n", "", "/b.py"),
                     ("importing failed\n", "", "/b.py")):
            result = gb.no_payload_cause(*args)
            self.assertEqual(2, len(result), result)
            self.assertIsInstance(result[0], str)
            self.assertIsInstance(result[1], str)


class CaptureBudgetNeverExceedsTheObservableTimeout(unittest.TestCase):
    """DEFECT 2：预算的可观测上限就是外层 --timeout（外层到点先 killpg），任何
    `--timeout < 30` 都不许交回一个大于外层窗口的预算，note 也不许自称一个空区间。"""

    def test_budget_below_the_floor_is_capped_at_the_outer_timeout(self):
        budget, note = gb.capture_budget_s("5", timeout=10)
        self.assertLessEqual(budget, 10.0,
                             "预算不许超过外层 --timeout：超了永远观测不到")
        self.assertIsNotNone(note)
        self.assertIn("--timeout", note)
        self.assertIn("Raise --timeout", note)
        self.assertNotIn("30..10", note, "文案不许再自称空区间")

    def test_timeout_equal_to_floor_is_the_edge_of_the_normal_interval(self):
        budget, note = gb.capture_budget_s("5", timeout=30)
        self.assertEqual(30.0, budget)
        self.assertLessEqual(budget, 30.0)
        self.assertIn("clamped", note)

    def test_in_range_value_in_a_short_window_still_names_the_knob(self):
        budget, note = gb.capture_budget_s("10", timeout=10)
        self.assertEqual(10.0, budget)
        self.assertLessEqual(budget, 10.0)
        self.assertIn("Raise --timeout", note)

    def test_large_timeout_clamps_to_the_floor(self):
        budget, note = gb.capture_budget_s("5", timeout=600)
        self.assertEqual(30.0, budget)
        self.assertIn("30..600", note)

    def test_in_window_value_on_a_normal_timeout_produces_no_note(self):
        self.assertEqual((45.0, None), gb.capture_budget_s("45", timeout=600))


class TraceExeIsRefusedAtParseTime(unittest.TestCase):
    """DEFECT 3：`trace --exe` 建了一条带 `--file <exe>` 却没有 launch 的 argv，永远
    采到 0 stops 再退 1。CLI 不该为一个不存在的能力作答，所以在 parse 处拒掉，
    口径与 `--samples` 越界（line 2460）一致。"""

    def test_trace_with_exe_refuses_the_launch_it_cannot_do(self):
        err = io.StringIO()
        # Mock the child so that, if the parse-time refusal were ever removed, this
        # proves the refusal by "no SystemExit + reached spawn", not by hanging on a
        # real `xcrun lldb`.
        def fake_child(argv, timeout, env=None):
            return gb._Completed(0, "", ""), False

        with mock.patch.object(gb, "run_child_captured", side_effect=fake_child):
            with contextlib.redirect_stderr(err):
                with self.assertRaises(SystemExit) as ctx:
                    gb.main(["trace", "--exe", "/bin/false"])
        self.assertEqual(2, ctx.exception.code, "argparse 的 parser.error 退 2")
        text = err.getvalue()
        self.assertIn("trace --exe is not supported", text)
        self.assertIn("--pid", text)
        self.assertIn("capture --exe", text)

    def test_trace_with_pid_is_not_blocked_by_the_new_guard(self):
        seen = {}

        def fake_child(argv, timeout, env=None):
            seen["argv"] = argv
            return gb._Completed(0, "", ""), False

        with mock.patch.object(gb, "run_child_captured", side_effect=fake_child), \
                contextlib.redirect_stdout(io.StringIO()):
            gb.main(["trace", "--pid", "4242"])
        self.assertTrue(any(str(a).startswith("gp-trace") for a in seen["argv"]),
                        seen["argv"])

    def test_capture_with_exe_is_still_accepted(self):
        def fake_child(argv, timeout, env=None):
            nonce = (env or {}).get(gb.SENTINEL_NONCE_ENV)
            payload = {"mode": "capture", "status": "failed", "threads": []}
            return gb._Completed(0, gb.wrap_sentinel(json.dumps(payload), nonce=nonce), ""), False

        with mock.patch.object(gb, "run_child_captured", side_effect=fake_child), \
                contextlib.redirect_stdout(io.StringIO()):
            code = gb.main(["capture", "--exe", "/bin/false", "--timeout", "120"])
        self.assertIn(code, (0, 1, 3))


class TopFrameLocalsScopeDecisionIsPinned(unittest.TestCase):
    """DEFECT 4（GetVariables）：桩从前对任何参数组合都交回同一份列表，所以
    `_collect_locals` 的作用域判决可以被改坏（带全局、丢参数）而全绿。桩现在记录
    被调用形参，并拒答它没有建模的作用域。"""

    def test_collect_locals_asks_for_in_scope_args_with_dynamic_values(self):
        frame = StubFrame(function="main", variables=[StubValue("argc", "3")])
        variables, reason = gb._collect_locals(frame)
        self.assertIsNone(reason, reason)
        self.assertEqual([("argc", "3")], variables)
        self.assertEqual([(True, True, False, True)], frame.getvariables_calls,
                         "顶帧局部变量的作用域判决必须逐字钉住")

    def test_the_frame_refuses_a_scope_it_does_not_model(self):
        frame = StubFrame(function="main", variables=[StubValue("argc", "3")])
        for bad in [(False, True, False, True),    # 丢掉 in_scope
                    (True, False, False, True),    # 丢掉 args_only（读成局部/全局）
                    (True, True, False, False)]:   # 关掉 dynamic
            with self.subTest(scope=bad):
                with self.assertRaises(AssertionError):
                    frame.GetVariables(*bad)


class StopHookInstallDrivesBothSeamArms(unittest.TestCase):
    """DEFECT 4（HandleCommand）：桩从前对任何文本都 return True，让
    `_install_stop_hook` 的拒绝臂在桩下不可达。桩现在只答桥会发的那一类命令，
    并留一个 refuse 旋钮把命令文本递进去，好让两条臂都能被真实地跑到。"""

    def setUp(self):
        self.queue = gb.WatchQueue()
        mock.patch.object(gb, "_WATCH_QUEUE", self.queue).start()
        self.addCleanup(mock.patch.stopall)

    def test_success_arm_installs_the_documented_stop_hook_and_marks_rearm_live(self):
        dbg = StubDebugger(StubProcess(threads=[]))
        ok, detail = gb._install_stop_hook(dbg)
        self.assertTrue(ok, detail)
        self.assertEqual(
            ['target stop-hook add -o "script glasspane_bridge.on_watchpoint_stop()"'],
            dbg.commands, "递给调试器的命令文本必须逐字钉住")
        self.assertTrue(self.queue.snapshot()["rearmLive"])

    def test_rejection_arm_marks_rearm_dead_when_the_debugger_refuses(self):
        dbg = StubDebugger(StubProcess(threads=[]), refuse=("stop-hook",))
        ok, _detail = gb._install_stop_hook(dbg)
        self.assertFalse(ok, "调试器拒绝了这条命令，接缝必须走失败臂")
        self.assertFalse(self.queue.snapshot()["rearmLive"],
                         "被拒时账本不许假装自动 re-arm 还活着")
        self.assertTrue(any("target stop-hook add" in c for c in dbg.commands),
                        dbg.commands)

    def test_stub_refuses_a_command_shape_it_should_not_answer_for(self):
        dbg = StubDebugger(StubProcess(threads=[]))
        self.assertFalse(dbg.HandleCommand("script do-something-the-bridge-never-runs()"),
                         "不是桥会发的那一类命令，桩不许无条件说是")


# ---------------------------------------------------------------------------
# 2026-10-29 泳道 9（S9-1..S9-4）。每条都是先对着**未改的实现**跑红的，红的名字
# 写在各自的注释里；反向变异备份在 /var/tmp/glasspane-main-check/2026-10-29-main/lane9/。
# ---------------------------------------------------------------------------

class TimeoutIsFiniteAndEscapeArmsLeaveJson(unittest.TestCase):
    """S9-1：`--timeout` 从前什么 float 都收。本机实测复现：
    `capture --pid 999999 --timeout nan` ⇒ `communicate()` 里
    `ValueError: cannot convert float NaN to integer` 整段 traceback、rc 1、
    stdout 零个哨兵（`inf` 同理 OverflowError）；而 `resume_frozen_target` 只跑在
    `timed_out` 臂——非超时的逃逸路径把 `--pid` 附上的用户进程留在 SIGSTOP，
    既无 SIGCONT、也无 "IT IS NOT CONFIRMED RESUMED"、也无 `kill -CONT` 补救行。
    现在：`timeout_refusal` 在起孩子之前把"有限且 >0"收掉（JSON 离场，rc 2），
    `run_outer` 的 except 从 OSError 放宽到 BaseException——先 resume、再结构化失败。
    """

    def test_non_finite_and_non_positive_timeouts_leave_json_at_rc_two(self):
        # 一律用 `--timeout=<值>` 的等号形：空格形下 argparse 会把 "-inf" 当成另一枚
        # 选项拒在 parse 处，等号形才把值递到 `timeout_refusal` 面前（两条臂都得有人管）。
        for raw in ("nan", "inf", "-inf", "-1", "0"):
            with self.subTest(raw=raw):
                child = mock.Mock(side_effect=AssertionError(
                    "坏 timeout 的拒收必须发生在 spawn 之前"))
                out, err = io.StringIO(), io.StringIO()
                with mock.patch.object(gb, "run_child_captured", child), \
                        contextlib.redirect_stdout(out), \
                        contextlib.redirect_stderr(err):
                    code = gb.main(["capture", "--pid", "999999", "--timeout=%s" % raw])
                self.assertEqual(0, child.call_count, "被拒的那条一次都不许去起 lldb")
                self.assertEqual(2, code)
                text = out.getvalue()
                self.assertIn(gb.SENTINEL_BEGIN, text, "§6.2：失败也以 JSON 离场：%r" % text)
                self.assertNotIn("Traceback", text)
                emitted = _emitted_payload(text)
                self.assertEqual("failed", emitted["status"])
                joined = " ".join(emitted["errors"])
                self.assertIn("--timeout", joined)
                self.assertIn(raw, joined, "拒因必须点名原值：%s" % joined)

    def test_timeout_refusal_is_a_pure_judge_with_a_control_arm(self):
        self.assertIsNone(gb.timeout_refusal(600.0))
        self.assertIsNone(gb.timeout_refusal(0.5), "合法小值不许被误杀（判据是>0，不是>=30）")
        for bad in (float("nan"), float("inf"), float("-inf"), 0.0, -5.0, None):
            self.assertIsNotNone(gb.timeout_refusal(bad), bad)

    def test_non_timeout_child_exception_resumes_target_exactly_once(self):
        """未改实现的红：`ValueError` 穿透 `except OSError`，main 抛栈，
        resume_frozen_target 被调用 **0 次**（今天 0 次，这条断它恰好 1 次）。"""
        calls = []

        def exploding(argv, timeout, env=None):
            raise ValueError("cannot convert float NaN to integer")

        def watch_resume(pid):
            calls.append(pid)
            return (True, "stubbed measurement: pid %s was sent SIGCONT and reads as running" % pid)

        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(gb, "run_child_captured", exploding), \
                mock.patch.object(gb, "resume_frozen_target", watch_resume), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = gb.main(["capture", "--pid", "4242", "--timeout", "5"])
        self.assertEqual([4242], calls, "逃逸臂必须唤醒目标，恰好一次")
        self.assertEqual(2, code)
        text = out.getvalue()
        self.assertIn(gb.SENTINEL_BEGIN, text, "异常不许再以 traceback 离场")
        self.assertNotIn("Traceback", text)
        emitted = _emitted_payload(text)
        self.assertEqual("failed", emitted["status"])
        joined = " ".join(emitted["errors"])
        self.assertIn("non-timeout", joined)
        self.assertIn("it was resumed", joined)

    def test_keyboard_interrupt_cleans_up_then_propagates(self):
        """BaseException 那一层是"接住 + 收尾 + 上抛"，不是吞掉退场原因。"""
        calls = []

        def exploding(argv, timeout, env=None):
            raise KeyboardInterrupt("injected interrupt mid-drain")

        def watch_resume(pid):
            calls.append(pid)
            return (False, "stubbed: SIGCONT refused, the target is STILL held stopped")

        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(gb, "run_child_captured", exploding), \
                mock.patch.object(gb, "resume_frozen_target", watch_resume), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            with self.assertRaises(KeyboardInterrupt):
                gb.main(["capture", "--pid", "4242", "--timeout", "5"])
        self.assertEqual([4242], calls)
        joined = " ".join(_emitted_payload(out.getvalue())["errors"])
        self.assertIn("IT IS NOT CONFIRMED RESUMED", joined)
        self.assertIn("kill -CONT 4242", joined, "F7 的补救行在非超时逃逸臂同样要在场")


class StubLaunchTarget(object):
    """`run_capture_cli` 启动臂里 `debugger.CreateTarget(exe)` 的返回物。只答启动：
    `LaunchSimple` 交出测试注入的进程，等待环的状态由 StubProcess 自己读。"""

    def __init__(self, process):
        self._process = process
        self.launch_calls = []

    def IsValid(self):
        return True

    def LaunchSimple(self, args, env, cwd):
        self.launch_calls.append((args, env, cwd))
        return self._process


class StubLaunchDebugger(object):
    """启动臂要的 debugger 面：`SetAsync` / `CreateTarget`，别的一律不在桩的视野里。"""

    def __init__(self, process):
        self._target = StubLaunchTarget(process)
        self.async_flags = []

    def SetAsync(self, value):
        self.async_flags.append(value)

    def CreateTarget(self, exe):
        return self._target


class LaunchedTargetTeardownIsRead(unittest.TestCase):
    """S9-3：`run_capture_cli` 的 `process.Kill()` 从前包在 `except Exception: pass`
    里，且载荷在那之前已经 print——桥**自己启动**的目标可能没收拢而 errors[] 一字不提；
    对照 attach 臂的 F7 三态读回，这条不对称就是"守卫跑了但判决没读者"。桩里今天根本
    没有 Kill()，所以未改实现的红是：载荷 errors[] 读不到任何收拢判决（`pass` 把
    AttributeError 也咽了）。现在判决在**尚未打印**的 payload 上追加。"""

    def _emitted_from_launch(self, process):
        fake_lldb = types.SimpleNamespace(
            eStateStopped=5, eStateRunning=6, eStateCrashed=7, eStateExited=8,
            eStateDetached=10, SBEvent=lambda: None, SBListener=lambda name: object())
        spec = json.dumps({"exe": "/bin/echo", "args": None, "mode": "capture",
                           "budget_s": 5.0})
        buffer = io.StringIO()
        with mock.patch.object(gb, "_LIVE_DEBUGGER", StubLaunchDebugger(process)), \
                mock.patch.object(gb, "_WATCH_QUEUE", gb.WatchQueue()), \
                mock.patch.object(gb, "_LIVE_WATCHPOINTS", {}), \
                mock.patch.dict(sys.modules, {"lldb": fake_lldb}), \
                contextlib.redirect_stdout(buffer):
            gb.run_capture_cli(spec)
        payload, _raw = gb.extract_sentinel(buffer.getvalue())
        self.assertIsNotNone(payload, buffer.getvalue())
        return payload

    @staticmethod
    def _stopped_process(**kwargs):
        return StubProcess(threads=[StubThread(tid=7, frames=[StubFrame(function="main")])],
                           **kwargs)

    def test_kill_verdict_helpers_answer_all_four_shapes(self):
        self.assertIsNone(gb.capture_teardown_note(True, None, 4242),
                          "确认收拢时不许编出一条 note")
        note = gb.capture_teardown_note(False, "the debugger call reported failure", 4242)
        for part in ("NOT confirmed collected", "ps -p 4242", "kill -9 4242"):
            self.assertIn(part, note, note)
        self.assertEqual((True, None), gb.kill_launched_target(self._stopped_process()))
        ok, detail = gb.kill_launched_target(self._stopped_process(kill_results=[False]))
        self.assertFalse(ok, detail)
        self.assertIn("reported failure", detail)
        ok, detail = gb.kill_launched_target(
            self._stopped_process(kill_results=[RuntimeError("debugserver vanished")]))
        self.assertFalse(ok, detail)
        self.assertIn("Kill() raised", detail)
        self.assertIn("debugserver vanished", detail)

        class NoKill(object):
            pass

        ok, detail = gb.kill_launched_target(NoKill())
        self.assertFalse(ok, detail)
        self.assertIn("no SBProcess.Kill()", detail)

    def test_kill_failure_rides_on_the_emitted_payload(self):
        process = self._stopped_process(pid=4242, kill_results=[False])
        payload = self._emitted_from_launch(process)
        self.assertEqual(1, process.kill_calls, "判决必须先于打印去取")
        joined = " ".join(payload.get("errors", []))
        self.assertIn("NOT confirmed collected", joined, payload)
        self.assertIn("ps -p 4242", joined)
        self.assertIn("kill -9 4242", joined)

    def test_kill_raising_is_reported_not_swallowed(self):
        payload = self._emitted_from_launch(
            self._stopped_process(pid=4243,
                                  kill_results=[RuntimeError("mid-kill binding failure")]))
        joined = " ".join(payload.get("errors", []))
        self.assertIn("NOT confirmed collected", joined)
        self.assertIn("Kill() raised", joined)
        self.assertIn("mid-kill binding failure", joined)

    def test_confirmed_kill_leaves_the_payload_without_the_note(self):
        """控制项：这条闸不许只会拒绝——成功收拢时载荷保持原样。"""
        payload = self._emitted_from_launch(self._stopped_process(kill_results=[True]))
        joined = " ".join(payload.get("errors", []))
        self.assertNotIn("NOT confirmed collected", joined)
        self.assertTrue(gb.capture_succeeded(payload), payload)


class NonceForgedPairIsAmbiguousNotTrusted(unittest.TestCase):
    """S9-4：nonce 经**子进程环境**交给 lldb，`--exe` 启动档里目标继承那份环境
    （`target.inherit-env` 默认 true）⇒ 目标读得到本轮 nonce，能把自己伪造的那一对
    写成**最右**。`extract_sentinel` 从前"最后一个可解析对获胜"会静默采信它，而
    :1124-1128 注释还宣称通道已被完全堵死。同 uid 下藏不住秘密——修法不是换更隐蔽
    的通道（那仍是背书），而是**如实标**：多于一对带本轮 nonce 的可解析载荷 ⇒
    `stdoutAmbiguous: true` + errors[] 一句"哪一对来自桥无法区分"，`outer_exit_code`
    从"实测"降回 1。"早期伪造输给真载荷"的次序语义（SentinelExtraction 那组）不动。
    """

    @staticmethod
    def _scene():
        nonce = gb.new_sentinel_nonce()
        real = {"mode": "capture", "status": "eStateStopped", "errors": [],
                "threads": [{"id": 7, "frames": [{"function": "real"}]}]}
        forged = {"mode": "capture", "status": "eStateStopped", "errors": [],
                  "threads": [{"id": 999, "frames": [{"fake": True}]}]}
        return nonce, real, forged

    def test_rightmost_nonce_forgery_is_declared_ambiguous_not_endorsed(self):
        nonce, real, forged = self._scene()
        stdout = ("noise\n" + gb.wrap_sentinel(json.dumps(real), nonce=nonce) +
                  "\ntarget noise\n" + gb.wrap_sentinel(json.dumps(forged), nonce=nonce))
        found, _raw = gb.extract_sentinel(stdout, nonce=nonce)
        # 未改实现今天在这里**静默取到 forged**（下面第一行钉住"最右内容仍被尽力返回"，
        # 第二、三行是修后的判决：必须给"有歧义"而不是采信）。
        self.assertEqual(forged["threads"], found["threads"])
        self.assertIs(True, found.get("stdoutAmbiguous"),
                      "两对带本轮 nonce 的可解析载荷不许再被静默采信：%r" % (found,))
        joined = " ".join(found["errors"])
        self.assertIn("cannot tell which one the bridge wrote", joined)
        self.assertEqual(1, gb.outer_exit_code(found), "歧义判决不许以 0/3 离场")

    def test_single_nonce_pair_is_still_trusted_and_exits_clean(self):
        nonce, real, _forged = self._scene()
        stdout = "noise\n" + gb.wrap_sentinel(json.dumps(real), nonce=nonce) + "\n"
        found, _raw = gb.extract_sentinel(stdout, nonce=nonce)
        self.assertEqual(real, found)
        self.assertNotIn("stdoutAmbiguous", found, "单对载荷不许被这条闸误伤")
        self.assertEqual(0, gb.outer_exit_code(found))

    def test_a_second_unparseable_pair_does_not_manufacture_ambiguity(self):
        """歧义判据吃的是"**可解析**对"的计数：尾部那条坏的照旧被跳过（B-27 的
        "late malformed pair 不许遮蔽真载荷"语义保持），且不打歧义标。"""
        nonce, real, _forged = self._scene()
        stdout = (gb.wrap_sentinel(json.dumps(real), nonce=nonce) + "\n" +
                  gb.sentinel_begin(nonce) + "{truncated by the pipe" + gb.SENTINEL_END)
        found, _raw = gb.extract_sentinel(stdout, nonce=nonce)
        self.assertEqual(real, found)
        self.assertEqual(0, gb.outer_exit_code(found))

    def test_run_outer_downgrades_an_ambiguous_stream_before_emitting(self):
        def fake_child(argv, timeout, env=None):
            nonce = (env or {}).get(gb.SENTINEL_NONCE_ENV)
            real = {"mode": "capture", "status": "eStateStopped", "errors": [], "threads": [{"id": 7}]}
            forged = {"mode": "capture", "status": "eStateStopped", "errors": [],
                      "threads": [{"id": 999, "frames": [{"fake": True}]}]}
            stdout = (gb.wrap_sentinel(json.dumps(real), nonce=nonce) + "\n" +
                      gb.wrap_sentinel(json.dumps(forged), nonce=nonce))
            return gb._Completed(0, stdout, ""), False

        out = io.StringIO()
        with mock.patch.object(gb, "run_child_captured", fake_child), \
                contextlib.redirect_stdout(out):
            code = gb.main(["capture", "--exe", "/bin/false", "--timeout", "60"])
        self.assertEqual(1, code, "歧义交付必须被降级，而不是 0/3 那两档实测码")
        emitted = _emitted_payload(out.getvalue())
        self.assertIs(True, emitted.get("stdoutAmbiguous"))
        self.assertIn("cannot tell which one the bridge wrote", " ".join(emitted["errors"]))

    def test_the_overclaiming_comments_were_corrected_in_place(self):
        """主张本身也在闸里：`never read from the target` 与"通道已被完全堵死"那两句
        是伪造拿到"实测"外观的一半；改回旧文案，这一条立刻红。"""
        with open(os.path.abspath(gb.__file__), encoding="utf-8") as handle:
            source = handle.read()
        self.assertNotIn("never read from the target",
                         gb.new_sentinel_nonce.__doc__ or "")
        self.assertNotIn("两路都堵上", source, "run_outer 里那句假主张不许回来")
        self.assertIn("target.inherit-env", source, "残余风险必须写在明面上")
        self.assertIn("stdoutAmbiguous", source)


class LaneF20261031CommandHonesty(unittest.TestCase):
    """泳道 F 2026-10-31 审出的五条，一次修齐：

    1. `shlex.split` 对没闭合引号抛 ValueError——在 lldb 里那等于桥崩在解释命令的
       路上，没有 sentinel、没有载荷。折成具名拒绝（`split_command_words`）。
    2. `parse_trace_request` 从前对认不出的词照答（拼错旗标、重复 `--samples`、
       多余 token 全部静默通过）——"桩对任何参数都答话"在真命令上的形状。
    3. `cmd_watch add` 第五个 token 没有读者却照武装。
    4. CLI 的 `--pid` 负数转发给 lldb，换回一份 `target-gone` 判决与"去找活 pid"
       的补救（2026-10-31 本机实测 rc=1）；`--samples` 被 capture/interactive
       照收照走，而这两条 argv 里根本没有它的读者。
    5. `no_payload_cause` 没有工具链缺席那一档：`xcrun: error: unable to find
       utility "lldb"` 落进 catch-all `debug-gated`，补救指向一张永远变不出二进制
       的 TCC 席位。
    每条都走正常/异常/边界三路。"""

    # --- 1. split_command_words ------------------------------------------
    def test_wellformed_words_split_unchanged(self):
        argv, refusal = gb.split_command_words("add 0x1000 8 r")
        self.assertEqual(["add", "0x1000", "8", "r"], argv)
        self.assertIsNone(refusal)

    def test_unterminated_quote_refuses_instead_of_raising(self):
        argv, refusal = gb.split_command_words("--samples 5 \"unclosed")
        self.assertEqual([], argv)
        self.assertIsNotNone(refusal)
        self.assertIn("could not read", refusal)
        self.assertIn("nothing was run", refusal)

    def test_empty_command_is_words_none(self):
        argv, refusal = gb.split_command_words("")
        self.assertEqual([], argv)
        self.assertIsNone(refusal)

    def test_cmd_queue_with_broken_quote_answers_a_refusal_not_a_traceback(self):
        messages = []
        result = types.SimpleNamespace(AppendMessage=messages.append)
        gb.cmd_queue(None, "clear \"dangling", result, {})
        self.assertEqual(1, len(messages), messages)
        self.assertIn("could not read", messages[0])

    # --- 2. gp-trace 的词形闸 --------------------------------------------
    def test_trace_accepts_default_and_single_flag_both_spellings(self):
        self.assertEqual((gb.TRACE_SAMPLES, None), gb.parse_trace_request(""))
        self.assertEqual((5, None), gb.parse_trace_request("--samples 5"))
        self.assertEqual((5, None), gb.parse_trace_request("gp-trace --samples 5"),
                         "带命令名的旧写法不许被新闸误伤")

    def test_trace_refuses_unknown_and_duplicated_words(self):
        for command in ("--smaples 5", "--samples 5 extra",
                        "--samples 5 --samples 9"):
            requested, refusal = gb.parse_trace_request(command)
            self.assertIsNone(requested, command)
            self.assertIsNotNone(refusal, command)
        _req, dup = gb.parse_trace_request("--samples 5 --samples 99999999")
        self.assertIn("named 2 times", dup, "越界的第二条不许静默蒸发")

    def test_trace_boundary_flag_without_value_still_names_the_usage(self):
        requested, refusal = gb.parse_trace_request("--samples")
        self.assertIsNone(requested)
        self.assertIn("the flag has no value", refusal)

    # --- 3. cmd_watch 的尾词闸 -------------------------------------------
    def _run_watch(self, command):
        queue = gb.WatchQueue()
        armed = []
        messages = []

        def fake_arm(debugger, entry):
            armed.append(dict(entry))
            return (True, "1")

        result = types.SimpleNamespace(AppendMessage=messages.append)
        with mock.patch.object(gb, "_WATCH_QUEUE", queue), \
                mock.patch.object(gb, "_arm_watchpoint", side_effect=fake_arm):
            gb.cmd_watch(None, command, result, {})
        return messages, queue, armed

    def test_watch_four_word_form_still_arms(self):
        messages, queue, armed = self._run_watch("add 0x1000 8 r")
        self.assertEqual(1, len(armed))
        self.assertEqual("0x1000", armed[0]["addr"])

    def test_watch_trailing_word_is_refused_and_arms_nothing(self):
        messages, queue, armed = self._run_watch("add 0x1000 8 r nonsense")
        self.assertEqual([], armed, "没读者的 token 不能换走一次武装")
        self.assertEqual([], queue.armed + queue.queued)
        self.assertIn("no reader", " ".join(messages))

    def test_watch_bare_addr_two_words_unchanged(self):
        messages, queue, armed = self._run_watch("add 0x2000")
        self.assertEqual(1, len(armed), "两词形（只给地址）是合法默认，不该被尾词闸拦下")

    # --- 4. CLI 的 --pid / --samples 闸 -----------------------------------
    def _main_exit_code_and_text(self, argv):
        err = io.StringIO()
        def fake_child(args_, timeout, env=None):
            return gb._Completed(0, "", ""), False
        with mock.patch.object(gb, "run_child_captured", side_effect=fake_child), \
                contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit) as ctx:
                gb.main(argv)
        return ctx.exception.code, err.getvalue()

    def test_negative_and_zero_pid_refused_at_parse(self):
        code, text = self._main_exit_code_and_text(["capture", "--pid", "-5"])
        self.assertEqual(2, code)
        self.assertIn("positive integer", text)
        code, text = self._main_exit_code_and_text(["capture", "--pid", "0"])
        self.assertEqual(2, code)
        self.assertIn("positive integer", text,
                      "--pid 0 要答成域错误，而不是『没给目标』")

    def test_samples_for_a_mode_that_reads_none_is_refused(self):
        code, text = self._main_exit_code_and_text(
            ["capture", "--exe", "/bin/false", "--samples", "5"])
        self.assertEqual(2, code)
        self.assertIn("trace mode only", text)
        code, text = self._main_exit_code_and_text(["interactive", "--samples", "5"])
        self.assertEqual(2, code)

    def test_trace_without_samples_still_runs_with_the_default(self):
        seen = {}
        def fake_child(argv, timeout, env=None):
            seen["argv"] = argv
            return gb._Completed(0, "", ""), False
        with mock.patch.object(gb, "run_child_captured", side_effect=fake_child), \
                contextlib.redirect_stdout(io.StringIO()):
            gb.main(["trace", "--pid", "4242"])
        self.assertTrue(any(str(a).startswith("gp-trace --samples %d" % gb.TRACE_SAMPLES)
                            for a in seen["argv"]), seen["argv"])

    # --- 5. toolchain-missing 成因 ----------------------------------------
    XCRUN_NO_UTILITY = ('xcrun: error: unable to find utility "lldb", '
                        'not sure why; try "xcode-select -p"\n')
    XCRUN_BAD_PATH = ("xcrun: error: invalid active developer path "
                      "(/Library/Developer/CommandLineTools), missing xcrun: "
                      "this is an error caused by an recent update to mac operating system\n")

    def test_xcrun_refusal_is_named_as_missing_toolchain(self):
        cause, remedy = gb.no_payload_cause(self.XCRUN_NO_UTILITY, "", "/tmp/b.py")
        self.assertEqual("toolchain-missing", cause)
        self.assertIn("xcode-select", remedy)
        self.assertIn("No TCC seat", remedy, "补救要先说清席位治不了这个")

    def test_invalid_developer_path_lands_in_the_same_arm(self):
        cause, _remedy = gb.no_payload_cause(self.XCRUN_BAD_PATH, "", "/tmp/b.py")
        self.assertEqual("toolchain-missing", cause)

    def test_named_cause_and_empty_stderr_keep_their_own_arms(self):
        cause, _r = gb.no_payload_cause(
            "error: importing 'glasspane_bridge' failed: invalid pathname\n",
            "", "/tmp/b.py")
        self.assertEqual("bridge-not-imported", cause,
                         "新臂抢走了 lldb 自己的导入失败就红了")
        cause, _r = gb.no_payload_cause("", "", "/tmp/b.py")
        self.assertEqual("not-determinable", cause)
        cause, _r = gb.no_payload_cause("", 'xcrun: error: unable to find utility "lldb"',
                                        "/tmp/b.py")
        self.assertEqual("not-determinable", cause,
                         "xcrun 的话出现在共享 stdout 上不算测量——成因只读 stderr")


if __name__ == "__main__":
    unittest.main()
