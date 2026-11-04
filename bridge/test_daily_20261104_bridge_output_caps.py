"""2026-11-04: tests for the child-output retention cap.

上一轮实现了 `cap_retained_output`（"载荷每个字段都有上界，唯独两条管道没有"）却没有测试。
这里钉住四条：窗口不超出自己的上界、最右那对哨兵活下来、开头诊断活下来、钳过的字节数上载荷。
"""
import contextlib
import io
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import glasspane_bridge as gb  # noqa: E402

TEST_NONCE = "0123456789abcdef"
HEAD_PREFIX = "error: module importing failed: /tmp/x.py\n"


def capture_payload():
    return gb.assemble_result(
        mode="capture",
        target={"pid": 4242, "exe": None},
        status="eStateStopped",
        threads=[{"id": 1, "frameCount": 1}],
        errors=[],
    )


def noisy_stream(middle_bytes, nonce=TEST_NONCE):
    """真形状：开头是 lldb 自己的诊断，中段是噪声，最右边才是哨兵载荷。"""
    junk = ("[lldb noise]" * (middle_bytes // 12 + 1))[:middle_bytes]
    return HEAD_PREFIX + junk + gb.wrap_sentinel(gb.render_json(capture_payload()),
                                                 nonce=nonce) + "\n"


class BoundIsHonoured(unittest.TestCase):
    def test_short_stream_is_returned_untouched(self):
        kept, dropped = gb.cap_retained_output("hello lldb\n")
        self.assertEqual(("hello lldb\n", 0), (kept, dropped),
                         "没钳过却报钳过，等于给读者一个凭空的数")

    def test_long_stream_never_keeps_more_than_the_limit(self):
        stream = noisy_stream(40 * 1024 * 1024)
        kept, dropped = gb.cap_retained_output(stream)
        self.assertGreater(dropped, 0)
        self.assertLessEqual(len(kept.encode("utf-8")), gb.MAX_CHILD_OUTPUT_BYTES,
                            "marker 自占的字节没算进预算时，这一条会红")

    def test_an_absurdly_wide_dropped_count_still_fits(self):
        widest = gb.CHILD_OUTPUT_MARKER % (10 ** 18)
        self.assertLessEqual(len(widest.encode("utf-8")), gb.CHILD_OUTPUT_MARKER_RESERVE,
                            "RESERVE 不再是实测最长 marker，窗口预算就成了假的")
        kept, _dropped = gb.cap_retained_output(noisy_stream(gb.MAX_CHILD_OUTPUT_BYTES + 4096))
        self.assertIn("middle dropped", kept)
        self.assertLessEqual(len(kept.encode("utf-8")), gb.MAX_CHILD_OUTPUT_BYTES)

    def test_head_and_tail_windows_add_up_to_the_limit(self):
        self.assertEqual(gb.MAX_CHILD_OUTPUT_BYTES,
                         gb.CHILD_OUTPUT_HEAD_BYTES + gb.CHILD_OUTPUT_TAIL_BYTES,
                         "两窗相加不等于上界，就有一段字节被凭空算掉了")
        self.assertGreater(gb.CHILD_OUTPUT_TAIL_BYTES, gb.CHILD_OUTPUT_HEAD_BYTES,
                          "载荷住在最右边，tail 必须比 head 大")


class RightMostSentinelSurvives(unittest.TestCase):
    def test_capture_at_the_end_of_a_sixty_megabyte_stream_is_still_readable(self):
        kept, dropped = gb.cap_retained_output(noisy_stream(60 * 1024 * 1024))
        payload, _raw = gb.extract_sentinel(kept, nonce=TEST_NONCE)
        self.assertIsNotNone(payload, "中段被丢把载荷切碎了：手里有采却钳成了没采")
        self.assertEqual("eStateStopped", payload.get("status"))
        self.assertGreater(dropped, 0, "没真的钳到东西，这条就测不到那件事")

    def test_leading_lldb_diagnostic_is_kept(self):
        kept, _dropped = gb.cap_retained_output(noisy_stream(gb.MAX_CHILD_OUTPUT_BYTES))
        self.assertTrue(kept.startswith("error: module importing failed"),
                        "只留 tail 会让「导入失败」和「目标没打印」两种成因变成同一句话")
        self.assertIn(gb.sentinel_begin(TEST_NONCE), kept)


class ClampIsReported(unittest.TestCase):
    def test_both_streams_are_named_with_their_own_counts(self):
        completed = gb._Completed(0, "x" * 10, "y" * 20,
                                 stdout_dropped=111, stderr_dropped=222)
        notes = gb.child_output_truncation_errors(completed)
        self.assertEqual(2, len(notes), "两条管道并成一条，就没人知道哪条被钳了")
        joined = " ".join(notes)
        self.assertIn("111", joined)
        self.assertIn("222", joined)
        self.assertIn("NOT the whole", joined,
                      "说了钳多少却没说这份载荷不是全量，读者仍会当全量读")

    def test_a_clean_stream_produces_no_note(self):
        completed = gb._Completed(0, "clean", "quiet")
        self.assertEqual([], gb.child_output_truncation_errors(completed),
                         "没钳过也追加一条，是给干净重跑制造噪声")

    def test_run_outer_reports_the_clamp_and_still_delivers_the_capture(self):
        kept, dropped = gb.cap_retained_output(noisy_stream(gb.MAX_CHILD_OUTPUT_BYTES + 5000))

        def fake_child(argv, timeout, env=None):
            return gb._Completed(0, kept, "", dropped, 0), False

        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(gb, "new_sentinel_nonce", return_value=TEST_NONCE), \
                mock.patch.object(gb, "run_child_captured", side_effect=fake_child), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = gb.main(["capture", "--pid", "4242", "--timeout", "5"])
        payload, _raw = gb.extract_sentinel(out.getvalue())
        self.assertIsNotNone(payload, "stdout=%r" % out.getvalue()[:300])
        joined = " ".join(payload.get("errors", []))
        self.assertIn("truncated", joined)
        self.assertEqual("eStateStopped", payload.get("status"), "附注不该把到手的采吃掉")
        self.assertIn(code, (0, 1, 3), code)
        self.assertEqual("", err.getvalue(), "失败也要有形状，不许 traceback 离场")


if __name__ == "__main__":
    unittest.main(verbosity=2)
