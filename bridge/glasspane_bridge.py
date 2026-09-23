#!/usr/bin/env python3
"""glasspane_bridge.py — P6 spec v6.0 §6: the LLDB bridge.

Form inherits P3 v3.2 §27 verbatim: Python + the SB API embedded in
``xcrun lldb`` (LLVM's long-term scripting layer), zero third-party
dependencies, C++ plugin stays a deferred optimization option. Result JSON
goes back over the local channel (R30): always between stdout sentinels, and
additionally as one NDJSON frame into ``--send-sock`` when given.

Three modes (§6.3):
  capture    launch/attach, then all-thread backtraces + top-frame registers
             and locals once the process is stopped (T1 crash-frame collector)
  trace      N quick main-thread samples for a hung process (T2 pipeline)
  interactive  register gp-capture / gp-trace / gp-watch / gp-queue inside a
             live lldb session (no REPL takeover)

Z4 watchpoints (§6.5): hardware slots capped at 4 (arm64 debug registers);
over-cap requests FIFO-queue (depth ≤64); exhaustion is reported honestly —
no software emulation of a hardware watchpoint.

Division of testing (v3.2 acceptance口径): the decidable core — queue policy,
JSON assembly, truncation, sentinel extraction, argv building — is pure and
covered by test_bridge.py with plain python3; the SB-API execution surface is
real-machine smoke only (§7.5), never faked into unit tests.
"""

import argparse
import json
import os
import shlex
import signal
import socket
import subprocess
import sys

SENTINEL_BEGIN = "GPBRIDGE<<"
SENTINEL_END = ">>GPBRIDGE"

MAX_FRAMES = 64
MAX_LOCALS = 16
MAX_VALUE_BYTES = 256
MAX_THREADS = 64
HW_WATCHPOINT_SLOTS = 4
WATCH_QUEUE_LIMIT = 64
TRACE_SAMPLES = 5
TRACE_INTERVAL_S = 1.0
#: R30回传 socket 的 connect/send 上限：对端不读取时宁可报错，不可挂住桥。
SEND_SOCK_TIMEOUT_S = 10.0


# ---------------------------------------------------------------------------
# Pure core (unit-tested without lldb)
# ---------------------------------------------------------------------------

class WatchQueue:
    """Z4 hardware-slot ledger (§6.5): ≤4 armed, overflow FIFO ≤64."""

    def __init__(self, slots=HW_WATCHPOINT_SLOTS, limit=WATCH_QUEUE_LIMIT):
        self.slot_count = slots
        self.queue_limit = limit
        self.armed = []          # list of spec dicts, len ≤ slots
        self.queued = []         # FIFO of spec dicts
        self.rejected = 0
        self.hits = {}           # addr -> hit count

    def add(self, spec):
        if len(self.armed) < self.slot_count:
            entry = dict(spec)
            entry["hwSlot"] = len(self.armed)
            self.armed.append(entry)
            return ("armed", entry["hwSlot"])
        if len(self.queued) >= self.queue_limit:
            self.rejected += 1
            return ("rejected", "watchpoint queue full (limit %d)" % self.queue_limit)
        self.queued.append(dict(spec))
        return ("queued", len(self.queued))

    def take_slot(self, freed_index):
        """Arm the queue head into a freed hardware slot; returns the spec."""
        if not self.queued:
            return None
        spec = self.queued.pop(0)
        spec["hwSlot"] = freed_index
        self.armed.append(spec)
        return spec

    def record_hit(self, addr):
        self.hits[addr] = self.hits.get(addr, 0) + 1

    def snapshot(self):
        return {
            "slots": self.armed,
            "queued": self.queued,
            "rejected": self.rejected,
            "hits": [{"addr": addr, "hitCount": count} for addr, count in sorted(self.hits.items())],
        }


def truncate(value, limit=MAX_VALUE_BYTES):
    text = str(value)
    if len(text.encode("utf-8")) <= limit:
        return text, False
    clipped = text.encode("utf-8")[:limit].decode("utf-8", errors="ignore")
    return clipped + "...[truncated]", True


def render_json(payload):
    return json.dumps(payload, sort_keys=True, separators=(",", ":"))


def frame_record(index, module, address, file=None, line=None, function=None, locals_=None):
    frame = {"idx": index, "module": module, "addr": address}
    if file is not None:
        frame["file"] = file
    if line is not None:
        frame["line"] = line
    if function is not None:
        frame["function"] = function
    frame["locals"] = [
        dict(name=name, value=truncate(value)[0], truncated=truncate(value)[1])
        for name, value in (locals_ or [])[:MAX_LOCALS]
    ]
    return frame


def assemble_result(mode, target, status, threads, registers=None, stop_reason=None,
                    crash=None, watchpoints=None, errors=None):
    """Fixed-shape result JSON (§6.1). Keys sorted at render; empties are
    explicit, never omitted, so downstream never guesses absence."""
    return {
        "mode": mode,
        "target": target,
        "status": status,
        "stopReason": stop_reason,
        "threads": threads[:MAX_THREADS],
        "registers": registers or {},
        "crash": crash,
        "watchpoints": watchpoints if watchpoints is not None else {"slots": [], "queued": [], "rejected": 0, "hits": []},
        "errors": errors or [],
    }


def extract_sentinel(stdout_text):
    """Pull the payload between sentinels out of noisy lldb stdout.
    Returns (payload_dict | None, raw_text)."""
    start = stdout_text.find(SENTINEL_BEGIN)
    if start < 0:
        return None, stdout_text
    rest = stdout_text[start + len(SENTINEL_BEGIN):]
    end = rest.find(SENTINEL_END)
    if end < 0:
        return None, stdout_text
    try:
        return json.loads(rest[:end]), rest[:end]
    except json.JSONDecodeError:
        return None, stdout_text


def build_lldb_argv(bridge_path, mode, pid=None, exe=None, exe_args=None,
                    samples=TRACE_SAMPLES, extra_script=None):
    """Compose the `xcrun lldb --batch` invocation (pure; unit-tested)."""
    argv = ["xcrun", "lldb", "--batch"]
    if pid is not None:
        # lldb 的 attach 形态是 -p <pid>（--attach 不存在——2026-09-21 真机
        # 复验抓到这个参数缺陷：attach 面从未真正试过内核，报的是 unknown
        # option 的伪装失败）。
        argv += ["-p", str(pid)]
    if exe:
        argv += ["--file", exe]
    argv += ["-o", "command script import %s" % bridge_path]
    if extra_script:
        argv += ["-o", extra_script]
    if mode == "capture":
        if exe and pid is None:
            # SB-API driver: batch would end the session at the crash stop,
            # so one script command does launch+wait+collect+emit.
            spec = json.dumps({"exe": exe, "args": exe_args, "mode": "capture",
                               "budget_s": max(30.0, float(os.environ.get("GPBRIDGE_BUDGET", "60")))},
                              ensure_ascii=False)
            argv += ["-o", "script glasspane_bridge.run_capture_cli(%s)" % shlex.quote(spec)]
        else:
            argv += ["-o", "gp-capture"]
    elif mode == "trace":
        argv += ["-o", "gp-trace --samples %d" % samples]
    elif mode == "interactive":
        argv += ["-o", "gp-queue"]
    else:
        raise ValueError("unknown mode: %s" % mode)
    if pid is not None:
        argv += ["-o", "detach"]
    argv += ["-o", "quit"]
    return argv


def emit(payload, out_path=None, send_sock=None):
    """R30 local回传: stdout sentinel always; optional one-line NDJSON frame
    into an existing unix socket (connection failure → stderr + nonzero).
    Socket delivery is bounded by SEND_SOCK_TIMEOUT_S on both connect and send,
    and the fd is closed on every path — a stalled peer gets an OSError, never
    a hung bridge."""
    text = render_json(payload)
    sys.stdout.write("%s%s%s\n" % (SENTINEL_BEGIN, text, SENTINEL_END))
    sys.stdout.flush()
    if out_path:
        with open(out_path, "w", encoding="utf-8") as handle:
            handle.write(text + "\n")
    if send_sock:
        # 必须**有界**：对端（daemon）停止读取时，connect/sendall 会无限阻塞，
        # 而"桥永不静默挂起"是本文件的立身之本。两种失败形态都落到 OSError 这
        # 一棵树下——socket.timeout 与（backlog 满时非阻塞 connect 报的）
        # BlockingIOError 均为其子类——所以 run_outer 两处 `except OSError`
        # 真的接得住：结构化失败 + 退出码 2，而不是 traceback 或永久阻塞。
        # 究竟抛哪一种未在本机实测（requires run），但两种的收口是同一个。
        # try/finally 保证失败路径上 fd 不泄漏（此前 close() 异常时根本到不了）。
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            client.settimeout(SEND_SOCK_TIMEOUT_S)  # 同时约束 connect 与 sendall
            client.connect(send_sock)  # caller catches; failure must surface
            client.sendall((text + "\n").encode("utf-8"))
        finally:
            client.close()


def run_outer(args):
    """Parent-process path: exec lldb, extract payload, re-emit per §6.2."""
    bridge_path = os.path.abspath(__file__)
    exe_args = list(args.exe_args) if args.exe_args else None
    argv = build_lldb_argv(
        bridge_path,
        mode=args.mode,
        pid=args.pid,
        exe=args.exe,
        exe_args=exe_args,
        samples=args.samples,
        extra_script=args.setup,
    )
    # `start_new_session=True` + 到期 `killpg`：debugserver 是 lldb 的**子进程**
    # 且继承了同一对管道。`subprocess.run(timeout=)` 超时只 kill 直接子进程，
    # 随后仍会无时限地 `communicate()` 等管道 EOF——而管道被活着的 debugserver
    # 握着，于是"永不静默挂起"的注释不成立，且被 attach 的目标进程会常驻
    # SIGSTOP（用户的被测应用被冻死在这里）。自成进程组才能整组收掉。
    timed_out = False
    try:
        proc = subprocess.Popen(
            argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, start_new_session=True,
        )
    except OSError as error:
        sys.stderr.write("cannot spawn lldb: %s\n" % error)
        return 2
    try:
        out, err = proc.communicate(timeout=args.timeout)
        completed = _Completed(proc.returncode, out, err)
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        try:
            out, err = proc.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            out, err = "", ""
        completed = _Completed(proc.returncode, out, err)
    if timed_out:
        # F5: lldb --batch can hang pre-timeout on machines where debug attach
        # is gated or cold-started. Structured refusal, never a silent hang.
        payload = assemble_result(
            mode=args.mode,
            target={"pid": args.pid, "exe": args.exe},
            status="failed",
            threads=[],
            errors=[
                "lldb did not produce a capture within %ss. On this machine "
                "debugger attach/launch is permission-gated (P6 §0 F1/F2/F5): "
                "grant System Settings > Privacy & Security > Developer Tools to the "
                "calling process, or run inside an already-authorized Terminal session. "
                "Note: the whole lldb process group was killed on timeout, so a target "
                "that had been stopped here is no longer held by this bridge." % args.timeout,
            ],
        )
        try:
            emit(payload, out_path=args.out, send_sock=args.send_sock)
        except OSError as error:
            sys.stderr.write("send-sock delivery failed: %s\n" % error)
            return 2
        return 1
    payload, _raw = extract_sentinel(completed.stdout)
    if payload is None:
        stderr_tail = completed.stderr[-2000:] if completed.stderr else ""
        payload = assemble_result(
            mode=args.mode,
            target={"pid": args.pid, "exe": args.exe},
            status="failed",
            threads=[],
            errors=[
                "lldb produced no capture payload (exit %d). Common cause: "
                "developer-tools permission gates attach/launch on this machine — "
                "grant System Settings > Privacy & Security > Developer Tools to the "
                "calling process (P6 §7.1). lldb stderr tail: %s" % (completed.returncode, stderr_tail),
            ],
        )
    try:
        emit(payload, out_path=args.out, send_sock=args.send_sock)
    except OSError as error:
        sys.stderr.write("send-sock delivery failed: %s\n" % error)
        return 2
    return 0 if capture_succeeded(payload) else 1


class _Completed:
    """Popen 结果的最小封装，保持与 subprocess.CompletedProcess 同样的读法。"""

    __slots__ = ("returncode", "stdout", "stderr")

    def __init__(self, returncode, stdout, stderr):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


#: 只有"确实停住并采到线程"才算一次成功的现场采集。
#: 此前退出码写成 `0 if status != "failed" else 1`，于是 `no-process`、
#: `eStateRunning`（预算内没停住）、`exited-before-stop` 这些**零线程**结局
#: 全部以 0 退出——开发者工具 TCC 被拒时 lldb 仍会跑完 gp-capture 并回
#: `no-process`，下游于是收到"成功但什么都没有"。
#:
#: A-11 的第一版把白名单直接比在 `str(process.GetState())` 上，这一步是押注：
#: 本机绑定里 `SBProcess.GetState()` 的签名是 `-> lldb::StateType`（C 扩展
#: `_lldb...so` 里的枚举，`lldb/__init__.py` 中并无 SBEnum 类兜住 __str__），
#: 它的 str() 到底是 "eStateStopped"、"5"、还是 "StateType.eStateStopped"，
#: 我们**没有实测**（requires run）。押错的后果不是报错，而是**每次真机采集都
#: 以 1 退出**——看着像守卫生效，其实判据已经失效（false red）。
#: 因此：契约是**状态名**，判定不再经过枚举的字符串渲染。
_OK_STATE_NAMES = ("eStateStopped", "eStateAttached")

#: LLDB `ProcessState` 的状态名全集（判定与归一只认这些名字——闭集）。
#: `eStateAttached` 必须在列：白名单认它，而 producer 是把 lldb 返回的 int 反查
#: 成名字传给父进程的。漏一个名字不是少一条记录，而是**真机上每一次以 attached
#: 停住的采集都判成失败**（int 反查不到 → status 无名 → 判定表落空）。
PROCESS_STATE_NAMES = (
    "eStateInvalid", "eStateUnloaded", "eStateConnected", "eStateAttaching",
    "eStateLaunching", "eStateStopped", "eStateRunning", "eStateCrashed",
    "eStateExited", "eStateSuspended", "eStateDetached", "eStateAttached",
)

#: name -> int 的**权威来源是运行时可导入的 `lldb` 模块常量**（真机走这条：
#: 取值由 LLDB 自己定义，见 `state_int_by_name()`，且权威分支**不与本表混用**）。
#: 下面这张表只是纯逻辑 CI（没有 lldb 可导入）用的镜像：数值 = 上面声明次序的
#: 序号，**未与本机 lldb 核对过**，也不参与真机判定——producer 在 lldb 内部用
#: lldb 自己的值得到名字，传给父进程的 status 已经是裸状态名，父进程只做
#: 名对名比较，因此这张表的数值再怎么错也不会把一次真采集判成失败。
_FALLBACK_STATE_INT = {name: index for index, name in enumerate(PROCESS_STATE_NAMES)}

_STATE_INT_BY_NAME = None


def state_int_by_name():
    """状态名 -> 整数。lldb 可导入时**只**信 lldb 常量（权威分支），一条也不用
    镜像补齐：混表会让镜像序号盖过真值，int→名字 反查就此认错状态——那正是本
    次要消除的那类假象。只有 lldb 完全取不到值（纯逻辑 CI）才退回镜像表。
    """
    global _STATE_INT_BY_NAME
    if _STATE_INT_BY_NAME is not None:
        return _STATE_INT_BY_NAME
    resolved = {}
    try:
        import lldb
    except ImportError:
        lldb = None
    if lldb is not None:
        for name in PROCESS_STATE_NAMES:
            value = getattr(lldb, name, None)
            if value is None:
                continue  # 这个 LLDB 版本没有该状态：如实缺席，不猜
            try:
                resolved[name] = int(value)
            except (TypeError, ValueError):
                continue  # 常量取不到 int：同样缺席，绝不让 producer 因此炸掉
    if not resolved:
        # 到这里就是没有 lldb 的纯逻辑环境：镜像表兜底，只为让 name↔int 自洽
        # 可测，**不代表**本机 lldb 的取值（真机走上面那条权威分支）。
        resolved = dict(_FALLBACK_STATE_INT)
    _STATE_INT_BY_NAME = resolved
    return resolved


def _name_for_int(value, table):
    for name, mapped in table.items():
        if mapped == value:
            return name
    return None


def normalize_state(state, table=None):
    """把进程状态归一成 (int | None, 裸状态名 | None)。

    接受四种传入形态，判定结果与枚举怎么 str() 无关：
      int 5 / 数字串 "5" / 裸名 "eStateStopped" / 带前缀名 "lldb.eStateStopped"
      （前缀按最后一段剥，所以 "StateType.eStateStopped" 同样吃得下）。
    解析不出状态名的一律回 None 名字（`no-process`、`failed` 这些合成结局串
    就落在这里）——**未知即拒绝**，不替 lldb 编一个名字。
    `table` 可注入：单测用它证明结论不依赖具体数值。
    """
    if table is None:
        table = state_int_by_name()
    if state is None or isinstance(state, bool):
        return None, None
    if isinstance(state, int):
        return state, _name_for_int(state, table)
    text = str(state).strip()
    digits = text[1:] if text[:1] in ("+", "-") else text
    if digits.isdigit():
        value = int(text)
        return value, _name_for_int(value, table)
    bare = text.rsplit(".", 1)[-1]
    if bare in table:
        return table[bare], bare
    # 词表是**闭集**：只认 PROCESS_STATE_NAMES 里的名字。放一个"看着像状态名"的
    # 字符串过去，等于让判定表之外的人也能给状态命名（`eStateStoppedNot` 这种
    # 拼错的名字会一路飘到判定里，而拼错的人收不到任何提示）。
    return None, None


def state_matches(state, expected_name, table=None):
    """这个状态与那个状态名是不是同一件事？int 与名字在此互解。"""
    _actual_int, actual_name = normalize_state(state, table)
    _expected_int, expected = normalize_state(expected_name, table)
    if actual_name is None or expected is None:
        return False
    return actual_name == expected


def capture_succeeded(payload):
    """本次采集是否可当作成功交付（纯函数，单测直接钉住判定表）。
    状态：int / 裸名 / 带前缀名都认；线程表为空一律不算成功。"""
    if not isinstance(payload, dict):
        return False
    status = payload.get("status")
    if not any(state_matches(status, name) for name in _OK_STATE_NAMES):
        return False
    return bool(payload.get("threads"))


# ---------------------------------------------------------------------------
# lldb-embedded layer (SB API). Imported only inside `xcrun lldb`.
# ---------------------------------------------------------------------------

_WATCH_QUEUE = WatchQueue()

# Captured at `command script import` time — __lldb_init_module receives the
# live SBDebugger (SBDebugger.GetDefault() does not exist in this binding).
_LIVE_DEBUGGER = None


def _is_running_under_lldb():
    try:
        import lldb  # noqa: F401
        return True
    except ImportError:
        return False


def _process_of(debugger):
    target = debugger.GetSelectedTarget()
    if not target or not target.IsValid():
        return None
    process = target.GetProcess()
    if not process or not process.IsValid():
        return None
    return process


def _describe_stop(thread):
    reason = thread.GetStopReason()
    names = {0: "none", 1: "trace", 2: "stepOut", 3: "breakpoint", 4: "watchpoint",
             5: "frameIndexChanged", 6: "noDebug", 7: "signal", 8: "threadSpec"}
    return names.get(int(reason), str(reason))


def _collect_locals(frame):
    variables = []
    try:
        values = frame.GetVariables(True, True, False, True)
    except Exception:
        return variables
    for value in values or []:
        if not value or not value.IsValid():
            continue
        name = value.GetName() or "?"
        displayed = value.GetValue() or value.GetSummary() or ""
        variables.append((name, displayed))
    return variables


def _module_name(module):
    for attr in ("GetFileSpec", "GetFile"):
        getter = getattr(module, attr, None)
        if getter:
            spec = getter()
            if spec and spec.IsValid() and spec.GetFilename():
                return spec.GetFilename()
    return "?"


def _line_file(line_entry):
    if not line_entry or not line_entry.IsValid():
        return None
    spec = line_entry.GetFileSpec()
    if spec and spec.IsValid():
        return spec.GetFilename()
    return None


def _collect_frames(thread, max_frames=MAX_FRAMES):
    frames = []
    for i in range(min(thread.GetNumFrames(), max_frames)):
        frame = thread.GetFrameAtIndex(i)
        if not frame or not frame.IsValid():
            continue
        line_entry = frame.GetLineEntry()
        symbol = frame.GetSymbol()
        module = frame.GetModule()
        address = "0x%x" % frame.GetPC() if frame.GetPC() is not None else "?"
        frames.append(frame_record(
            index=i,
            module=_module_name(module) if module and module.IsValid() else "?",
            address=address,
            file=_line_file(line_entry),
            line=line_entry.GetLine() if line_entry and line_entry.IsValid() else None,
            function=symbol.GetName() if symbol and symbol.IsValid() else None,
            locals_=_collect_locals(frame) if i == 0 else None,
        ))
    return frames


def _collect_registers(thread):
    registers = {}
    if thread.GetNumFrames() == 0:
        return registers
    frame = thread.GetFrameAtIndex(0)
    try:
        root = frame.GetRegisters()
    except Exception:
        return registers
    for group in root or []:
        for reg in group or []:
            try:
                name = reg.GetName()
                value = reg.GetValue()
            except Exception:
                continue
            if name:
                registers[name] = truncate(value or "")[0]
    return registers


def _payload_from_process(process, mode, errors=None, samples=None):
    import lldb
    if process is None or not process.IsValid():
        return assemble_result(mode=mode, target={"pid": None}, status="no-process",
                               threads=[], errors=errors or ["no live process to capture"])
    threads = []
    for i in range(min(process.GetNumThreads(), MAX_THREADS)):
        thread = process.GetThreadAtIndex(i)
        if not thread or not thread.IsValid():
            continue
        threads.append({
            "id": thread.GetThreadID(),
            "name": thread.GetName() or "",
            "queue": "",
            "stopReason": _describe_stop(thread),
            "frames": _collect_frames(thread),
        })
    top = process.GetSelectedThread() or process.GetThreadAtIndex(0)
    stop_reason = _describe_stop(top) if top and top.IsValid() else None
    signal_description = None
    try:
        stop = top.GetStopReason()
        if stop == 7:  # eStopReasonSignal
            signal_description = "signal %d" % top.GetStopReasonDataAtIndex(0)
    except Exception:
        pass
    # 进程状态**在此处归一一次**：int 直接取自 SB 枚举，名字由 lldb 模块常量
    # 反查（`state_int_by_name()` 在 lldb 内部走权威分支）。这条路径与 str()
    # 无关，所以退出码判据不再押在"枚举怎么渲染"上——本文件里 `_describe_stop`
    # 的 `stop == 7` 与 `run_capture_cli` 的 `state == lldb.eStateStopped` 本来
    # 就是数值比较，这里补齐第三处（原先唯一用 str() 的就是这一行）。
    raw_state = process.GetState()
    try:
        state_input = int(raw_state)
    except (TypeError, ValueError):
        state_input = raw_state  # 取不到 int：交给 normalize_state 尽力解析
    _state_int, state_name = normalize_state(state_input)
    status = state_name or ("state(%s)" % raw_state)
    result = assemble_result(
        mode=mode,
        target={"pid": process.GetProcessID()},
        status=status,
        threads=threads,
        registers=_collect_registers(top) if top and top.IsValid() else {},
        stop_reason=stop_reason,
        crash={"signal": signal_description, "description": stop_reason} if stop_reason == "signal" else None,
        watchpoints=_WATCH_QUEUE.snapshot(),
        errors=errors or [],
    )
    if samples is not None:
        result["samples"] = samples
    return result


def _payload_via_debugger(debugger, mode, errors=None, samples=None):
    process = _process_of(debugger)
    return _payload_from_process(process, mode, errors=errors, samples=samples)


def run_capture_cli(spec_json):
    """SB-API driven capture for `lldb --batch -o script ...` invocation.

    Necessary because batch mode ENDS the session when `run` stops on a
    crash — subsequent `-o` commands never execute (2026-09-19 真机实证).
    So launch, event-wait, collect and emit happen inside this single call.
    """
    import lldb
    spec = json.loads(spec_json)
    debugger = _LIVE_DEBUGGER
    if debugger is None:
        print(_sentinel(assemble_result(mode="capture", target={"exe": spec.get("exe")},
                                        status="failed", threads=[],
                                        errors=["bridge imported without a debugger handle"])))
        return
    debugger.SetAsync(False)
    target = debugger.CreateTarget(spec.get("exe") or "")
    if not target.IsValid():
        print(_sentinel(assemble_result(mode="capture", target={"exe": spec.get("exe")},
                                        status="failed", threads=[], errors=["invalid executable"])))
        return
    listener = lldb.SBListener("glasspane.bridge")
    process = target.LaunchSimple(spec.get("args") or None, None,
                                  os.path.dirname(spec.get("exe") or "/") or "/")
    if not process.IsValid():
        print(_sentinel(assemble_result(mode="capture", target={"exe": spec.get("exe")},
                                        status="failed", threads=[],
                                        errors=["launch failed (LaunchSimple returned invalid process)"])))
        return
    # Wait for the first stop (crash) or exit within the budget.
    budget = float(spec.get("budget_s", 60))
    stopped = False
    exited = False
    event = lldb.SBEvent()
    deadline = _now() + budget
    while _now() < deadline:
        state = process.GetState()
        if state == lldb.eStateStopped:
            stopped = True
            break
        if state in (lldb.eStateExited, lldb.eStateCrashed, lldb.eStateDetached):
            exited = True
            break
        if listener.WaitForEvent(0.25, event):
            continue
    payload = _payload_from_process(process, spec.get("mode", "capture"))
    if exited and not stopped:
        payload["status"] = "exited-before-stop"
    print(_sentinel(payload))
    try:
        process.Kill()
    except Exception:
        pass


def _sentinel(payload):
    return "%s%s%s" % (SENTINEL_BEGIN, render_json(payload), SENTINEL_END)


def _now():
    import time
    return time.monotonic()


def cmd_capture(debugger, command, result, internal_dict):
    payload = _payload_via_debugger(debugger, mode="capture")
    text = render_json(payload)
    print("%s%s%s" % (SENTINEL_BEGIN, text, SENTINEL_END))


def cmd_trace(debugger, command, result, internal_dict):
    """T2 hang pipeline: N main-thread samples at a fixed cadence, no resume."""
    import time
    argv = shlex.split(command)
    samples = TRACE_SAMPLES
    if "--samples" in argv:
        samples = int(argv[argv.index("--samples") + 1])
    timeline = []
    for index in range(samples):
        payload = _payload_via_debugger(debugger, mode="trace")
        main_thread = payload["threads"][0] if payload["threads"] else None
        timeline.append({
            "sample": index,
            "at": time.time(),
            "mainThreadFrames": len(main_thread["frames"]) if main_thread else 0,
            "stopReason": main_thread["stopReason"] if main_thread else None,
        })
        if index + 1 < samples:
            time.sleep(TRACE_INTERVAL_S)
    payload = _payload_via_debugger(debugger, mode="trace")
    payload["timeline"] = timeline
    text = render_json(payload)
    print("%s%s%s" % (SENTINEL_BEGIN, text, SENTINEL_END))


def cmd_watch(debugger, command, result, internal_dict):
    """Z4: gp-watch add <addr> [size] [rw] — hardware slots only (§6.5)."""
    import lldb
    argv = shlex.split(command)
    if not argv or argv[0] != "add":
        result.AppendMessage("usage: gp-watch add <hex-addr> [size=8] [r|w|rw]")
        return
    address = int(argv[1], 16) if argv[1].startswith("0x") else int(argv[1])
    size = int(argv[2]) if len(argv) > 2 and argv[2].isdigit() else 8
    mode = argv[3] if len(argv) > 3 else "w"
    read = "r" in mode
    write = "w" in mode
    spec = {"addr": "0x%x" % address, "size": size, "mode": mode}
    outcome, detail = _WATCH_QUEUE.add(dict(spec))
    if outcome == "armed":
        target = debugger.GetSelectedTarget()
        error = lldb.SBError()
        watchpoint = target.WatchAddress(lldb.SBAddress(address, target), size, read, write, error)
        if error.Fail() or not watchpoint.IsValid():
            result.AppendMessage("hw slot %d failed: %s" % (detail, error.GetCString()))
        else:
            result.AppendMessage("watchpoint armed in slot %d at %s" % (detail, spec["addr"]))
    else:
        result.AppendMessage("watchpoint %s (%s)" % (outcome, detail))
    result.AppendMessage(render_json(_WATCH_QUEUE.snapshot()))


def cmd_queue(debugger, command, result, internal_dict):
    result.AppendMessage(render_json(_WATCH_QUEUE.snapshot()))


def __lldb_init_module(debugger, internal_dict):
    global _LIVE_DEBUGGER
    _LIVE_DEBUGGER = debugger
    debugger.HandleCommand("command script add -f glasspane_bridge.cmd_capture gp-capture")
    debugger.HandleCommand("command script add -f glasspane_bridge.cmd_trace gp-trace")
    debugger.HandleCommand("command script add -f glasspane_bridge.cmd_watch gp-watch")
    debugger.HandleCommand("command script add -f glasspane_bridge.cmd_queue gp-queue")


# ---------------------------------------------------------------------------
# CLI entry (parent process; outside lldb)
# ---------------------------------------------------------------------------

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("mode", choices=["capture", "trace", "interactive"])
    parser.add_argument("--pid", type=int, help="attach to a running pid (needs developer-tools permission, P6 §7.1)")
    parser.add_argument("--exe", help="launch this executable under the debugger")
    parser.add_argument("--exe-args", nargs=argparse.REMAINDER, default=None,
                        help="arguments forwarded to --exe")
    parser.add_argument("--samples", type=int, default=TRACE_SAMPLES, help="trace sample count (T2)")
    parser.add_argument("--setup", help="extra lldb command run after script import")
    parser.add_argument("--timeout", type=float, default=600.0,
                        help="budget incl. first debugserver cold start on a machine (F5: >5 min, one-time)")
    parser.add_argument("--out", help="also write the payload JSON to this file")
    parser.add_argument("--send-sock", help="also send one NDJSON frame to this unix socket (R30回传)")
    args = parser.parse_args(argv)
    if not args.pid and not args.exe and args.mode != "interactive":
        parser.error("capture/trace need --pid or --exe")
    return run_outer(args)


if __name__ == "__main__":
    sys.exit(main())
