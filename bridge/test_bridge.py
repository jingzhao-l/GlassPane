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
            gb.emit({"mode": "capture"}, send_sock="/tmp/gp-bridge-unused.sock", timeout_s=5.0)
        self.assertEqual([5.0], timeouts)
        self.assertEqual(gb.render_json({"mode": "capture"}) + "\n", created[0].sent.decode())
        self.assertTrue(created[0].fileno() == -1, "socket must be closed after delivery")

    def test_emit_default_budget_is_finite(self):
        self.assertGreater(gb.EMIT_TIMEOUT_S, 0)
        self.assertLess(gb.EMIT_TIMEOUT_S, 60.0)

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


if __name__ == "__main__":
    unittest.main()
