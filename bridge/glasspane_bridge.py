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
        argv += ["--attach", str(pid)]
    if exe:
        argv += ["--file", exe]
    argv += ["-o", "command script import %s" % bridge_path]
    if extra_script:
        argv += ["-o", extra_script]
    if mode == "capture":
        if exe and pid is None:
            argv += ["-o", "run"]
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
    if exe and exe_args:
        argv += ["--"] + list(exe_args)
    return argv


def emit(payload, out_path=None, send_sock=None):
    """R30 local回传: stdout sentinel always; optional one-line NDJSON frame
    into an existing unix socket (connection failure → stderr + nonzero)."""
    text = render_json(payload)
    sys.stdout.write("%s%s%s\n" % (SENTINEL_BEGIN, text, SENTINEL_END))
    sys.stdout.flush()
    if out_path:
        with open(out_path, "w", encoding="utf-8") as handle:
            handle.write(text + "\n")
    if send_sock:
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.connect(send_sock)  # caller catches; failure must surface
        client.sendall((text + "\n").encode("utf-8"))
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
    try:
        completed = subprocess.run(argv, capture_output=True, text=True, timeout=args.timeout)
    except subprocess.TimeoutExpired:
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
                "calling process, or run inside an already-authorized Terminal session." % args.timeout,
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
    return 0 if payload.get("status") != "failed" else 1


# ---------------------------------------------------------------------------
# lldb-embedded layer (SB API). Imported only inside `xcrun lldb`.
# ---------------------------------------------------------------------------

_WATCH_QUEUE = WatchQueue()


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
    for i in range(frame.GetNumVariables()):
        value = frame.GetVariableAtIndex(i)
        if not value or not value.IsValid():
            continue
        name = value.GetName() or "?"
        displayed = value.GetValue() or value.GetSummary() or ""
        variables.append((name, displayed))
    return variables


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
            module=module.GetFile() and os.path.basename(module.GetFile().GetFilespec()) or "?",
            address=address,
            file=line_entry.GetFile().GetFilename() if line_entry and line_entry.GetFile().IsValid() else None,
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
    for i in range(frame.GetNumRegisters()):
        value = frame.GetRegisterAtIndex(i)
        if value and value.IsValid():
            registers[value.GetName()] = truncate(value.GetValue())[0]
    return registers


def _payload_from_process(debugger, mode, errors=None, samples=None):
    process = _process_of(debugger)
    if process is None:
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
    result = assemble_result(
        mode=mode,
        target={"pid": process.GetProcessID()},
        status=str(process.GetState()),
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


def cmd_capture(debugger, command, result, internal_dict):
    payload = _payload_from_process(debugger, mode="capture")
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
        payload = _payload_from_process(debugger, mode="trace")
        main_thread = payload["threads"][0] if payload["threads"] else None
        timeline.append({
            "sample": index,
            "at": time.time(),
            "mainThreadFrames": len(main_thread["frames"]) if main_thread else 0,
            "stopReason": main_thread["stopReason"] if main_thread else None,
        })
        if index + 1 < samples:
            time.sleep(TRACE_INTERVAL_S)
    payload = _payload_from_process(debugger, mode="trace")
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
    parser.add_argument("--timeout", type=float, default=120.0)
    parser.add_argument("--out", help="also write the payload JSON to this file")
    parser.add_argument("--send-sock", help="also send one NDJSON frame to this unix socket (R30回传)")
    args = parser.parse_args(argv)
    if not args.pid and not args.exe and args.mode != "interactive":
        parser.error("capture/trace need --pid or --exe")
    return run_outer(args)


if __name__ == "__main__":
    sys.exit(main())
