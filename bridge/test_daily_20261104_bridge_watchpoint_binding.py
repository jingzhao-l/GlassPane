"""2026-11-04：监视点那一环的**方法名**必须照真绑定来，不靠桩答话。

三条判据各自能单独变红：

1. `WatchAddress` 的重载表。本机 `xcrun lldb` 实测只暴露
   `SBTarget.WatchAddress(SBTarget, lldb::addr_t, size_t, bool, bool, SBError)` 一枚；交
   `lldb.SBAddress(...)` 得到 `TypeError: in method 'SBTarget_WatchAddress', argument 2 of type
   'lldb::addr_t'`。从前那句 TypeError 被 `_arm_watchpoint` 自己的 except 咽成
   `"WatchAddress raised ..."`，于是**生产上每一次武装都失败**，而账本照旧答 "queued"。
   测试面看不见它，是因为四条相关用例把 `_arm_watchpoint` 整条 patch 掉了，而
   `StubTarget` 根本没有 `WatchAddress`（`test_bridge.py:1748`）。
2. `SBWatchpoint` 的名字。本机实测有 `SetEnabled`/`Clear`，**没有** `Disable`；从前
   `_disarm_watchpoint` 只问 `Disable`，所以硬件槽位永远让不出来。桩供 `Disable()` ＝给一门
   不存在的能力作背书。
3. 进程状态名那张**闭集**表。本机实测有 `eStateStepping`（=7）而表里没有：单步停的那一次采集
   int→名字反查落空，status 无名，判定表整条走空。这一条向**真绑定**要名单，不向手抄表要。
"""
import os
import subprocess
import sys
import types
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import glasspane_bridge as gb  # noqa: E402

REAL_PROBE = """
import lldb
print(",".join(sorted(n for n in dir(lldb) if n.startswith("eState"))))
"""

_state_names_cache = []


def states_the_binding_actually_exposes():
    """向真 lldb 要它自己的状态名名单（不是向任何手抄表要）。取不到就返回 None，调用方 skip。"""
    if _state_names_cache:
        return _state_names_cache[0]
    try:
        got = subprocess.run(["xcrun", "lldb", "--batch", "-o", "script exec(%r)" % REAL_PROBE],
                             capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.SubprocessError):
        _state_names_cache.append(None)
        return None
    line = next((ln.strip() for ln in (got.stdout or "").splitlines()
                 if ln.strip().startswith("eState")), "")
    if not line:
        _state_names_cache.append(None)
        return None
    _state_names_cache.append(set(line.split(",")))
    return _state_names_cache[0]


class FakeError(object):
    """SBError 的形状：`_outcome_ok` 读 `Success()`/`GetCString()`。"""

    def Success(self):
        return True

    def GetCString(self):
        return None


class WatchpointHandle(object):
    def __init__(self, wp_id=7):
        self._id = wp_id
        self.enabled_calls = []
        self.disable_calls = 0

    def IsValid(self):
        return True

    def GetID(self):
        return self._id

    def SetEnabled(self, enabled):
        self.enabled_calls.append(enabled)
        return True


class LegacyHandle(WatchpointHandle):
    """只有 `Disable()` 的旧绑定：`SetEnabled` 必须真的取不到，否则第二问没被测。"""
    SetEnabled = None

    def Disable(self):
        self.disable_calls += 1
        return True


class BareHandle(object):
    """两个名字都没有的一台绑定——诚实拒绝那一支的读者。"""

    def __init__(self):
        self.marker = object()

    def IsValid(self):
        return True

    def GetID(self):
        return 9


class IntOnlyTarget(object):
    """照本机实测的重载表来：地址那一枚**只认 int**。"""

    def __init__(self, accept_int=True):
        self.calls = []
        self._accept_int = accept_int

    def IsValid(self):
        return True

    def WatchAddress(self, addr, size, read, write, error):
        self.calls.append((addr, size, read, write))
        if self._accept_int:
            if not isinstance(addr, int):
                raise TypeError("in method 'SBTarget_WatchAddress', argument 2 of type "
                                "'lldb::addr_t'")
            return WatchpointHandle()
        # 反向对照：一台只认 SBAddress 的绑定。修法若被换回去，这一支就红。
        if not isinstance(addr, types.SimpleNamespace):
            raise TypeError("in method 'SBTarget_WatchAddress', argument 2 of type 'SBAddress'")
        return WatchpointHandle()


def debugger_for(target):
    return types.SimpleNamespace(GetSelectedTarget=lambda: target)


ENTRY = {"addr": "0x1000", "size": 8, "mode": "w"}


def _fake_lldb_module():
    return types.SimpleNamespace(SBError=FakeError,
                                 SBAddress=lambda value, target: types.SimpleNamespace(v=value))


class ArmingUsesTheOverloadThisBindingHas(unittest.TestCase):
    def setUp(self):
        gb._LIVE_WATCHPOINTS.clear()
        patcher = mock.patch.dict(sys.modules, {"lldb": _fake_lldb_module()})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(gb._LIVE_WATCHPOINTS.clear)

    def test_the_address_handed_to_watchaddress_is_a_plain_int(self):
        target = IntOnlyTarget()
        ok, detail = gb._arm_watchpoint(debugger_for(target), dict(ENTRY))
        self.assertTrue(ok, "生产上每一次武装都在这里失败：%s" % (detail,))
        self.assertEqual(1, len(target.calls))
        addr, size, read, write = target.calls[0]
        self.assertIsInstance(addr, int, "交出去的是 SBAddress 时，这台绑定直接 TypeError")
        self.assertEqual(0x1000, addr)
        self.assertEqual((8, False, True), (size, read, write))
        self.assertIn("0x1000", gb._LIVE_WATCHPOINTS,
                      "武装成功却没记进在册表，下一次 reconcile 就认不出这条监视点")

    def test_a_binding_that_will_not_take_an_int_is_reported_not_swallowed(self):
        """反向对照：桩能变红。把修法换回 SBAddress 或换台绑定，这条就抓住"armed"是句空话。"""
        ok, detail = gb._arm_watchpoint(debugger_for(IntOnlyTarget(accept_int=False)), dict(ENTRY))
        self.assertFalse(ok)
        self.assertIn("WatchAddress raised", detail)
        self.assertEqual([], [k for k in gb._LIVE_WATCHPOINTS],
                         "失败的一支不许留在在册表里——那会让账本说 armed 而调试器什么都没有")


class ReleasingTheSlotUsesTheNameThisBindingHas(unittest.TestCase):
    def setUp(self):
        gb._LIVE_WATCHPOINTS.clear()

    tearDown = setUp

    def test_real_binding_shape_releases_via_set_enabled_false(self):
        handle = WatchpointHandle()
        gb._LIVE_WATCHPOINTS["0x1000"] = handle
        ok, detail = gb._disarm_watchpoint("0x1000")
        self.assertTrue(ok, "本机绑定只有 SetEnabled：%s" % (detail,))
        self.assertEqual([False], handle.enabled_calls,
                         "释槽要写 `SetEnabled(False)`，写 SetEnabled(True) 是没放")
        self.assertNotIn("0x1000", gb._LIVE_WATCHPOINTS)

    def test_legacy_binding_still_releases_via_disable(self):
        handle = LegacyHandle()
        gb._LIVE_WATCHPOINTS["0x2000"] = handle
        ok, _detail = gb._disarm_watchpoint("0x2000")
        self.assertTrue(ok)
        self.assertEqual(1, handle.disable_calls)
        self.assertNotIn("0x2000", gb._LIVE_WATCHPOINTS)

    def test_a_binding_with_neither_name_refuses_and_keeps_the_handle(self):
        handle = BareHandle()
        gb._LIVE_WATCHPOINTS["0x3000"] = handle
        ok, detail = gb._disarm_watchpoint("0x3000")
        self.assertFalse(ok, "两个名字都没有时不许假装放掉了槽位")
        for name in ("SetEnabled", "Disable"):
            self.assertIn(name, detail, "拒绝要说清问了哪两个名字，读者才知该换哪一层：%s" % detail)
        self.assertIn("0x3000", gb._LIVE_WATCHPOINTS,
                      "失败还摘句柄＝这条监视点永久失联，下一次 reconcile 认不出它（D4 记过）")

    def test_an_untracked_address_is_refused_without_inventing_a_disable(self):
        ok, detail = gb._disarm_watchpoint("0xdeadbeef")
        self.assertFalse(ok)
        self.assertIn("no live watchpoint", detail)


class TheClosedStateNameSetCoversWhatTheMachineCanProduce(unittest.TestCase):
    def test_every_state_lldb_exposes_is_in_the_table(self):
        exposed = states_the_binding_actually_exposes()
        if exposed is None:
            self.skipTest("本机取不到真 lldb 的状态名名单（`xcrun lldb --batch` 没答话）；"
                          "补上它需要的动作：在有 Command Line Tools 的机器上跑本文件——"
                          "缺一个名字不是少一条记录，是那一次采集整条判成失败")
        missing = sorted(exposed - set(gb.PROCESS_STATE_NAMES))
        self.assertEqual([], missing,
                         "这张表是闭集：真机能产出、表里没有的状态名，其采集会在 int→名字 反查处落空"
                         "（2026-11-04 实测本机有 eStateStepping=7 而表里缺，就是这一条抓的）")


if __name__ == "__main__":
    unittest.main(verbosity=2)
