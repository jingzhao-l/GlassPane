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
  trace      main-thread samples for a hung process, taken at *separate* stops
             (the target is resumed and re-stopped between samples) — T2 pipeline
  interactive  register gp-capture / gp-trace / gp-watch / gp-queue inside a
             live lldb session (no REPL takeover)

Z4 watchpoints (§6.5): hardware slots capped at 4 (arm64 debug registers);
over-cap requests FIFO-queue (depth ≤64); exhaustion is reported honestly —
no software emulation of a hardware watchpoint. Arming is one-shot: a stop on an
armed watchpoint records its hit, releases its slot and arms the queue head, so a
queued request is only "pending", never silently counted as never-fired. A hit
belongs to the ledger entry that was armed when it was taken, so re-arming an
address — the normal workflow — never inherits the previous generation's count.

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
WATCHPOINT_NOTE_LIMIT = 24
TRACE_SAMPLES = 5
TRACE_INTERVAL_S = 1.0
MAX_TRACE_SAMPLES = 32
EMIT_TIMEOUT_S = 5.0


# ---------------------------------------------------------------------------
# Pure core (unit-tested without lldb)
# ---------------------------------------------------------------------------

class WatchQueue:
    """Z4 hardware-slot ledger (§6.5): ≤4 armed, overflow FIFO ≤64.

    Arming is one-shot: a watchpoint that stops the target records its hit,
    releases its slot, and the queue head is armed into the freed slot — that
    release is the only way an over-cap request ever runs. The ledger therefore
    keeps three phases (armed / queued / spent) and says which one each request
    is in, so an empty ``hits`` list can never read as "never fired" when the
    truth is "never armed".

    Counts belong to a request generation, keyed ``(addr, seq)``: an address that
    is armed, spent and armed again is a *new* request with zero hits, and a stop
    that matches nothing armed is counted as unattributed rather than credited to
    whoever happens to hold the address.
    """

    PHASE_ARMED = "armed"
    PHASE_QUEUED = "queued"
    PHASE_SPENT = "spent"

    QUEUED_REASON = ("no free hardware slot; still queued (armed when a slot is "
                     "released, or by 'gp-queue arm')")
    RESERVED_REASON = ("ledger slot reserved but the debugger never confirmed a "
                       "hardware watchpoint: this address is NOT armed")

    def __init__(self, slots=HW_WATCHPOINT_SLOTS, limit=WATCH_QUEUE_LIMIT):
        self.slot_count = slots
        self.queue_limit = limit
        self.armed = []          # entries holding a hardware slot
        self.queued = []         # FIFO of entries waiting for a slot
        self.spent = []          # entries whose hit was recorded, slot released
        self.rejected = 0
        self.hits = {}           # (addr, seq) -> hits credited to that ledger entry
        self.unattributed = {}   # addr -> stops that matched no armed entry
        self.stops_observed = 0  # watchpoint stops this session reconciled
        self.notes = []          # caveats that belong in every payload's errors[]
        self.notes_dropped = 0
        self.rearm_live = None   # None = automatic re-arm never attempted
        self.rearm_detail = "automatic re-arm never attempted"
        self._seq = 0

    # -- ledger bookkeeping -------------------------------------------------
    def _stamp(self, spec, phase):
        entry = dict(spec)
        self._seq += 1
        entry["seq"] = self._seq
        entry["phase"] = phase
        entry.setdefault("live", False)
        return entry

    def note(self, text):
        """Record a caveat, bounded: the cap itself is stated, never silent."""
        if len(self.notes) < WATCHPOINT_NOTE_LIMIT:
            self.notes.append(text)
            return
        if self.notes_dropped == 0:
            self.notes.append("further watchpoint notes suppressed (limit %d)"
                              % WATCHPOINT_NOTE_LIMIT)
        self.notes_dropped += 1

    def set_rearm(self, live, detail):
        self.rearm_live = bool(live)
        self.rearm_detail = detail

    def free_slot(self):
        used = {entry.get("hwSlot") for entry in self.armed}
        for index in range(self.slot_count):
            if index not in used:
                return index
        return None

    def entries(self):
        return self.armed + self.queued + self.spent

    def entry_for_addr(self, addr):
        for entry in self.entries():
            if entry["addr"] == addr:
                return entry
        return None

    def armed_entry(self, addr):
        """The one entry a hit at ``addr`` can belong to: armed, and this generation."""
        for entry in self.armed:
            if entry["addr"] == addr:
                return entry
        return None

    def hit_count(self, entry):
        return self.hits.get((entry["addr"], entry["seq"]), 0)

    def mark_live(self, addr, live=True):
        """The debugger confirmed (or revoked) the hardware watchpoint itself."""
        entry = self.entry_for_addr(addr)
        if entry is not None:
            entry["live"] = bool(live)
        return entry

    def add(self, spec):
        if not spec.get("addr"):
            self.rejected += 1
            return ("rejected", "watchpoint spec carries no address")
        # One ledger slot per address: a duplicate request would otherwise put two
        # armed entries on one address whose debugger handle only tracks the last.
        # Re-arming an address whose request already *spent* is the intended
        # one-shot workflow, and _stamp() gives it a fresh sequence — the new
        # generation's hit count starts at zero, not at the old one's.
        for entry in self.armed + self.queued:
            if entry["addr"] == spec["addr"]:
                return ("duplicate", "already requested (phase %s, slot %r)"
                        % (entry["phase"], entry.get("hwSlot")))
        free = self.free_slot()
        if free is not None:
            entry = self._stamp(spec, self.PHASE_ARMED)
            entry["hwSlot"] = free
            self.armed.append(entry)
            return ("armed", free)
        if len(self.queued) >= self.queue_limit:
            self.rejected += 1
            return ("rejected", "watchpoint queue full (limit %d)" % self.queue_limit)
        entry = self._stamp(spec, self.PHASE_QUEUED)
        self.queued.append(entry)
        return ("queued", len(self.queued))

    def take_slot(self, freed_index):
        """Arm the queue head into a freed hardware slot; returns the spec.

        The caller releases the slot first (``release``); arming onto an
        occupied slot is recorded as a note rather than silently accepted.
        """
        if not self.queued:
            return None
        if freed_index is None or any(e.get("hwSlot") == freed_index for e in self.armed):
            self.note("take_slot(%r) targets an occupied slot; the ledger and the "
                      "debugger may disagree about %r" % (freed_index, self.queued[0]["addr"]))
        spec = self.queued.pop(0)
        spec["hwSlot"] = freed_index
        spec["phase"] = self.PHASE_ARMED
        spec["live"] = False
        self.armed.append(spec)
        return spec

    def release(self, addr):
        """A hit was recorded: retire the entry and hand back its slot index."""
        for index, entry in enumerate(self.armed):
            if entry["addr"] == addr:
                del self.armed[index]
                entry["phase"] = self.PHASE_SPENT
                entry["live"] = False
                self.spent.append(entry)
                return entry.get("hwSlot")
        return None

    def abandon(self, addr, detail):
        """Drop an entry whose hardware watchpoint does not exist (anymore).

        Unlike ``release`` this is not a hit: the address leaves the ledger with
        a note saying why, so no payload can claim it was armed.
        """
        for index, entry in enumerate(self.armed):
            if entry["addr"] == addr:
                del self.armed[index]
                break
        else:
            for index, entry in enumerate(self.queued):
                if entry["addr"] == addr:
                    del self.queued[index]
                    break
        self.note("watchpoint %s is not armed: %s" % (addr, detail))
        return detail

    def drop(self, addr):
        """Remove a request from the queue or free its slot; returns (phase, slot)."""
        for index, entry in enumerate(self.queued):
            if entry["addr"] == addr:
                del self.queued[index]
                return (self.PHASE_QUEUED, None)
        for index, entry in enumerate(self.armed):
            if entry["addr"] == addr:
                del self.armed[index]
                return (self.PHASE_ARMED, entry.get("hwSlot"))
        return (None, None)

    def record_hit(self, addr):
        """Credit a watchpoint stop to the entry armed at ``addr``; returns its seq.

        Nothing armed means nothing to credit: the stop is counted as
        unattributed (and noted) instead of being laid on whatever generation
        holds the address, which would manufacture "armed and already fired".
        An entry the ledger never confirmed as hardware is still credited — the
        stop is the observation, the contradiction is the note.
        """
        entry = self.armed_entry(addr)
        if entry is None:
            first = self.unattributed.get(addr, 0) == 0
            self.unattributed[addr] = self.unattributed.get(addr, 0) + 1
            if first:
                detail = "queued" if any(e["addr"] == addr for e in self.queued) else \
                    ("spent (one-shot arming; nothing re-armed at it)"
                     if any(e["addr"] == addr for e in self.spent) else "not in the ledger")
                self.note("watchpoint stop at %s credits no ledger entry: %s, so no hit "
                          "was counted for it" % (addr, detail))
            return None
        self.hits[(addr, entry["seq"])] = self.hit_count(entry) + 1
        if not entry.get("live"):
            self.note("watchpoint stop at %s was credited to ledger entry #%d, which the "
                      "ledger has not confirmed as a hardware watchpoint" % (addr, entry["seq"]))
        return entry["seq"]

    def note_stop_observed(self):
        self.stops_observed += 1

    # -- reporting ----------------------------------------------------------
    def _reason_for(self, entry):
        if entry.get("live"):
            return None
        if entry.get("phase") == self.PHASE_QUEUED:
            return self.QUEUED_REASON
        if entry.get("phase") == self.PHASE_SPENT:
            return ("hit recorded (%d); slot %r released for the queued head "
                    "(one-shot arming)" % (self.hit_count(entry), entry.get("hwSlot")))
        return self.RESERVED_REASON

    def records(self):
        """§6.4 ``watchpoints`` array: one record per request, in request order.

        ``hitCount`` is the count of *this* ledger generation: an address armed
        twice shows the spent request with its own hits and the fresh request with
        zero, so an armed row can never read as a fired one.
        """
        return [{
            "addr": entry["addr"],
            "hwSlot": entry.get("hwSlot"),
            "queued": entry.get("phase") == self.PHASE_QUEUED,
            "hitCount": self.hit_count(entry),
            "armed": bool(entry.get("live")),
            "reason": self._reason_for(entry),
        } for entry in sorted(self.entries(), key=lambda e: e["seq"])]

    def snapshot(self):
        return {
            "slots": self.armed,
            "queued": self.queued,
            "spent": self.spent,
            "rejected": self.rejected,
            "hits": [{"addr": addr, "seq": seq, "hitCount": count}
                     for (addr, seq), count in sorted(self.hits.items())],
            "unattributedHits": [{"addr": addr, "stopCount": count}
                                 for addr, count in sorted(self.unattributed.items())],
            "watchpointStopsObserved": self.stops_observed,
            "rearmLive": self.rearm_live,
            "rearmDetail": self.rearm_detail,
            "notes": list(self.notes),
        }

    def integrity_notes(self):
        """Caveats that must ride in a payload's errors[] (A-21/B-23).

        Silent unless somebody actually requested a watchpoint (or a caveat was
        recorded): a plain crash capture must not inherit watchpoint noise.
        """
        if not self.entries() and not self.notes and not self.rejected and not self.unattributed:
            return []
        out = []
        armed = [e for e in self.armed if e.get("live")]
        if self.queued:
            out.append("%d watchpoint request(s) are queued and NOT armed (%s); "
                       "no hit can be recorded for them until a slot frees"
                       % (len(self.queued), self.QUEUED_REASON))
        reserved = [e for e in self.armed if not e.get("live")]
        if reserved:
            out.append("%d ledger slot(s) have no hardware watchpoint behind them: %s"
                       % (len(reserved), ", ".join(e["addr"] for e in reserved)))
        if self.entries() and not self.hits:
            if self.stops_observed == 0:
                out.append("hits is empty because this session observed no watchpoint "
                           "stop at all; that is not evidence the watchpoints never fired")
            elif armed:
                out.append("%d watchpoint stop(s) observed but none matched an armed "
                           "address (%s)" % (self.stops_observed,
                                             ", ".join(e["addr"] for e in armed)))
        if self.unattributed:
            out.append("%d watchpoint stop(s) matched no armed ledger entry and were not "
                       "counted as hits (%s): arm the address again with "
                       "'gp-watch add <hex-addr>' if a further hit is wanted"
                       % (sum(self.unattributed.values()),
                          ", ".join("%s x%d" % (addr, n)
                                    for addr, n in sorted(self.unattributed.items()))))
        if self.rejected:
            out.append("%d watchpoint request(s) rejected: hardware-slot FIFO is full "
                       "(limit %d)" % (self.rejected, self.queue_limit))
        if self.rearm_live is False and (self.queued or armed):
            out.append("automatic re-arm on stop is unavailable (%s): queued watchpoints "
                       "arm only via 'gp-queue arm'" % self.rearm_detail)
        out.extend(self.notes)
        return out


def truncate(value, limit=MAX_VALUE_BYTES):
    text = str(value)
    if len(text.encode("utf-8")) <= limit:
        return text, False
    clipped = text.encode("utf-8")[:limit].decode("utf-8", errors="ignore")
    return clipped + "...[truncated]", True


def keep_capped(items, limit):
    """(kept, dropped_count) — a cap that drops rows must report how many (B-23)."""
    items = list(items or [])
    if len(items) <= limit:
        return items, 0
    return items[:limit], len(items) - limit


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
    seen = list(locals_ or [])
    kept, dropped = keep_capped(seen, MAX_LOCALS)
    frame["locals"] = [
        dict(name=name, value=truncate(value)[0], truncated=truncate(value)[1])
        for name, value in kept
    ]
    # localsTotal/localsTruncated: 16 dumped locals must not read as "that is
    # every local this frame holds".
    frame["localsTotal"] = len(seen)
    frame["localsTruncated"] = dropped
    return frame


def thread_entry(thread_id, name, stop_reason, frames, frames_total=None, queue=None):
    """One §6.4 ``threads[]`` record.

    ``queue`` stays None unless a queue name was actually read: an always-empty
    string is a fabricated measurement ("this thread has an empty queue label")
    where None means "not measured" (§6.1 keeps the key present either way).
    """
    entry = {
        "id": thread_id,
        "name": name if name is not None else "",
        "queue": queue,
        "stopReason": stop_reason,
        "frames": list(frames or []),
    }
    total = len(entry["frames"]) if frames_total is None else frames_total
    entry["framesTotal"] = total
    entry["framesTruncated"] = max(0, total - len(entry["frames"]))
    return entry


def completeness_report(threads):
    """What the per-list caps dropped, aggregated (B-23)."""
    dropped_frames = 0
    dropped_locals = 0
    for thread in threads or []:
        dropped_frames += thread.get("framesTruncated") or 0
        for frame in thread.get("frames") or []:
            dropped_locals += frame.get("localsTruncated") or 0
    return {"frames": dropped_frames, "locals": dropped_locals}


def parse_trace_request(command, default=TRACE_SAMPLES):
    """`gp-trace --samples N` (pure). Returns (requested | None, refusal | None):
    an unreadable or out-of-range count is refused with a reason, never quietly
    replaced by the default."""
    argv = shlex.split(command or "")
    if "--samples" not in argv:
        return default, None
    index = argv.index("--samples") + 1
    if index >= len(argv):
        return None, "usage: gp-trace --samples <count> — the flag has no value"
    try:
        requested = int(argv[index])
    except ValueError:
        return None, "gp-trace --samples wants an integer, got %r" % argv[index]
    if requested < 1:
        return None, "gp-trace --samples wants at least 1 sample, got %d" % requested
    if requested > MAX_TRACE_SAMPLES:
        return None, ("gp-trace --samples %d exceeds MAX_TRACE_SAMPLES=%d; the trace "
                      "would outlast its sampling budget" % (requested, MAX_TRACE_SAMPLES))
    return requested, None


def build_timeline(observations, requested, stop_note=None):
    """Fold per-sample observations into the T2 timeline (A-22).

    An observation only counts when it comes from a *different* stop than the
    previously kept one (``stopId`` from SBProcess.GetStopID). Without a resume
    in between, N reads of one frozen stop state are 1 measurement — and
    reporting them as a time series is exactly what downstream reads as the T2
    verdict "the stack did not move for N seconds". An unavailable stop id is
    treated as "cannot distinguish", i.e. never a new observation.
    """
    kept = []
    for observation in observations or []:
        entry = dict(observation)
        stop_id = entry.get("stopId")
        if kept and (stop_id is None or stop_id == kept[-1].get("stopId")):
            continue
        entry["sample"] = len(kept)
        kept.append(entry)
    shortfall = stop_note if len(kept) < max(1, requested) else None
    if not kept:
        measured = False
        reason = shortfall or ("no stop state could be read from the target; the "
                               "timeline is not measured")
    elif requested > 1 and len(kept) == 1:
        measured = False
        reason = ("1 frozen stop state is not a time series: %d requested samples "
                  "rested on a single measurement (%s)" % (requested, shortfall or
                                                           "the target was never resumed and re-stopped"))
    else:
        measured = True
        reason = shortfall
    return {
        "samples": kept,
        "observations": len(kept),
        "requested": requested,
        "attempts": len(observations or []),
        "intervalS": TRACE_INTERVAL_S,
        "measured": measured,
        "reason": reason,
    }


def assemble_result(mode, target, status, threads, registers=None, stop_reason=None,
                    crash=None, watchpoints=None, errors=None):
    """Fixed-shape result JSON (§6.1). Keys sorted at render; empties are
    explicit, never omitted, so downstream never guesses absence. ``watchpoints``
    is the §6.4 array (one record per request), not a ledger dump."""
    errors = list(errors or [])
    kept_threads, dropped_threads = keep_capped(threads, MAX_THREADS)
    truncated = {}
    if dropped_threads:
        truncated["threads"] = {"kept": len(kept_threads), "dropped": dropped_threads,
                                "limit": MAX_THREADS}
        errors.append("threads truncated: kept %d of %d (MAX_THREADS=%d); this "
                      "payload is not the full thread list"
                      % (len(kept_threads), len(kept_threads) + dropped_threads, MAX_THREADS))
    missing = completeness_report(kept_threads)
    if missing["frames"]:
        truncated["frames"] = {"dropped": missing["frames"], "limit": MAX_FRAMES}
        errors.append("frames truncated: %d frame(s) reported by the target are not in "
                      "this payload (MAX_FRAMES=%d cap, plus any unreadable frame)"
                      % (missing["frames"], MAX_FRAMES))
    if missing["locals"]:
        truncated["locals"] = {"dropped": missing["locals"], "limit": MAX_LOCALS}
        errors.append("locals truncated: %d local(s) beyond MAX_LOCALS=%d are not in "
                      "this payload" % (missing["locals"], MAX_LOCALS))
    return {
        "mode": mode,
        "target": target,
        "status": status,
        "stopReason": stop_reason,
        "threads": kept_threads,
        "registers": registers or {},
        "crash": crash,
        "watchpoints": list(watchpoints or []),
        "truncated": truncated,
        "errors": errors,
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


def emit(payload, out_path=None, send_sock=None, timeout_s=None):
    """R30 local回传: stdout sentinel always; optional one-line NDJSON frame
    into an existing unix socket (connection failure → stderr + nonzero).

    The socket is bounded on connect *and* send and always closed: an engine
    side that stopped draining would otherwise hang the bridge forever with a
    leaked fd (§6.2 only promises "failure surfaces", silence is not success).
    """
    text = render_json(payload)
    sys.stdout.write("%s%s%s\n" % (SENTINEL_BEGIN, text, SENTINEL_END))
    sys.stdout.flush()
    if out_path:
        with open(out_path, "w", encoding="utf-8") as handle:
            handle.write(text + "\n")
    if send_sock:
        budget = EMIT_TIMEOUT_S if timeout_s is None else float(timeout_s)
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            client.settimeout(budget)
            client.connect(send_sock)
            client.sendall((text + "\n").encode("utf-8"))
        except socket.timeout:
            raise OSError("send-sock %s did not take the frame within %ss: the peer is "
                          "not draining (it is not accepting, or its receive buffer is "
                          "full); the payload went to stdout only" % (send_sock, budget))
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

# Captured at `command script import` time — __lldb_init_module receives the
# live SBDebugger (SBDebugger.GetDefault() does not exist in this binding).
_LIVE_DEBUGGER = None

# addr -> SBWatchpoint the debugger actually handed back. The ledger says
# "armed" only for addresses present here; that distinction is the whole point
# of A-21 (a reserved ledger slot is not a hardware watchpoint).
_LIVE_WATCHPOINTS = {}
_RECONCILED_STOPS = set()
_RECONCILED_STOPS_LIMIT = 512


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
    """Frames collected under the cap; the thread's real total travels with the
    row as ``framesTotal``/``framesTruncated`` so the cut is visible (B-23)."""
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


def _num_frames(thread):
    """How many frames the thread really has (the collected list caps at MAX_FRAMES)."""
    try:
        return int(thread.GetNumFrames())
    except (TypeError, ValueError):
        return None


def _thread_queue(thread):
    """GCD queue name, or None when it cannot be read.

    None is "not measured"; the always-"" this replaces was a value nobody
    observed, and it read as "this thread has an empty queue label".
    """
    getter = getattr(thread, "GetQueueName", None)
    if getter is None:
        return None
    try:
        name = getter()
    except Exception:
        return None
    return name or None


# -- Z4 hardware watchpoints: the ledger <-> debugger seam -------------------

def _outcome_ok(outcome):
    """Normalise an SB result: SBError carries Success(), SBCommandReturnObject
    carries Succeeded(), SBProcess.Stop() is a plain bool in some builds; an
    unrecognised shape is reported as *unverified* rather than assumed good."""
    if outcome is None:
        return (False, "the debugger returned no result")
    if isinstance(outcome, bool):
        return (outcome, None if outcome else "the debugger call reported failure")
    for attr in ("Success", "Succeeded"):
        check = getattr(outcome, attr, None)
        if check is None:
            continue
        if check():
            return (True, None)
        describe = getattr(outcome, "GetCString", None)
        return (False, (describe() if describe is not None else None) or "the debugger call failed")
    return (False, "this lldb binding exposed no success indicator for the call")


def _arm_watchpoint(debugger, entry):
    """Create the hardware watchpoint a ledger entry claims (P6 §6.5).

    Returns (ok, detail); detail is the debugger watchpoint id, or why there is
    none. Only a confirmed SBWatchpoint marks the entry armed.
    """
    import lldb
    if entry is None:
        return (False, "no ledger entry to arm")
    target = debugger.GetSelectedTarget()
    if not target or not target.IsValid():
        return (False, "no valid target to hold a watchpoint")
    mode = entry.get("mode") or "w"
    error = lldb.SBError()
    try:
        watchpoint = target.WatchAddress(
            lldb.SBAddress(int(entry["addr"], 16), target),
            int(entry.get("size") or 8), "r" in mode, "w" in mode, error)
    except Exception as exc:
        return (False, "WatchAddress raised %r" % (exc,))
    ok, detail = _outcome_ok(error)
    if not ok:
        return (False, detail)
    if watchpoint is None or not watchpoint.IsValid():
        return (False, "the debugger accepted the request but returned no watchpoint")
    _LIVE_WATCHPOINTS[entry["addr"]] = watchpoint
    _WATCH_QUEUE.mark_live(entry["addr"])
    return (True, str(watchpoint.GetID()))


def _disarm_watchpoint(addr):
    """Disable the debugger-side watchpoint so its hardware slot is really free."""
    watchpoint = _LIVE_WATCHPOINTS.pop(addr, None)
    if watchpoint is None:
        return (False, "no live watchpoint was tracked for %s" % addr)
    disable = getattr(watchpoint, "Disable", None)
    if disable is None:
        return (False, "this lldb binding has no SBWatchpoint.Disable()")
    return _outcome_ok(disable())


def _addr_for_watchpoint_id(watchpoint_id):
    for addr, watchpoint in list(_LIVE_WATCHPOINTS.items()):
        try:
            if watchpoint.GetID() == watchpoint_id:
                return addr
        except Exception:
            continue
    return None


def _promote_and_arm(debugger, freed_index):
    """Arm the queue head into `freed_index`; returns (spec | None, failure | None)."""
    spec = _WATCH_QUEUE.take_slot(freed_index)
    if spec is None:
        return (None, None)
    ok, detail = _arm_watchpoint(debugger, spec)
    if not ok:
        _WATCH_QUEUE.abandon(spec["addr"], detail)
        return (None, "queued watchpoint %s could not take slot %r: %s"
                % (spec["addr"], freed_index, detail))
    return (spec, None)


def _stop_id(process):
    """SBProcess stop counter — the only thing that distinguishes two samples."""
    getter = getattr(process, "GetStopID", None)
    if getter is None:
        return None
    try:
        return int(getter())
    except (TypeError, ValueError):
        return None


def reconcile_watchpoint_stops(debugger, process=None):
    """A-21: close the Z4 loop at a stop.

    For every thread stopped by a watchpoint: record the hit, disable that
    watchpoint, release its slot and arm the queued head into it. Without this
    pass an over-cap request never runs, hits stay empty forever, and `add`
    answers "queued" as a promise nobody keeps. Idempotent per
    (stop id, thread, watchpoint id) so the stop hook and a gp-* command can
    both look at the same stop.
    """
    report = {"hits": [], "rearmed": [], "notes": []}
    try:
        process = process if process is not None else _process_of(debugger)
        if process is None or not process.IsValid():
            return report
        stop_id = _stop_id(process)
        for index in range(min(process.GetNumThreads(), MAX_THREADS)):
            thread = process.GetThreadAtIndex(index)
            if not thread or not thread.IsValid() or _describe_stop(thread) != "watchpoint":
                continue
            try:
                watchpoint_id = thread.GetStopReasonDataAtIndex(0)
            except Exception:
                watchpoint_id = None
            key = (stop_id, thread.GetThreadID(), watchpoint_id)
            if key in _RECONCILED_STOPS:
                continue
            if len(_RECONCILED_STOPS) >= _RECONCILED_STOPS_LIMIT:
                _RECONCILED_STOPS.clear()
                _WATCH_QUEUE.note("re-stop bookkeeping reset after %d entries; a repeat "
                                  "of an older stop could be counted again"
                                  % _RECONCILED_STOPS_LIMIT)
            _RECONCILED_STOPS.add(key)
            _WATCH_QUEUE.note_stop_observed()
            addr = _addr_for_watchpoint_id(watchpoint_id)
            if addr is None:
                note = ("watchpoint stop from debugger id %s matches no armed address; "
                        "no hit recorded" % watchpoint_id)
                _WATCH_QUEUE.note(note)
                report["notes"].append(note)
                continue
            seq = _WATCH_QUEUE.record_hit(addr)
            if seq is None:
                # Nothing armed at that address: the stop is already counted as
                # unattributed, so no slot is released and nothing is promoted
                # (the ledger holds none to free). The debugger-side watchpoint
                # is still disabled — it exists and would keep stopping the target.
                ok, detail = _disarm_watchpoint(addr)
                if not ok:
                    _WATCH_QUEUE.note("watchpoint stop at %s credited no ledger entry and "
                                      "its watchpoint could not be confirmed disabled (%s)"
                                      % (addr, detail))
                continue
            freed = _WATCH_QUEUE.release(addr)
            ok, detail = _disarm_watchpoint(addr)
            if not ok:
                _WATCH_QUEUE.note("hit recorded at %s and slot %r released in the ledger, "
                                  "but the debugger watchpoint is not confirmed disabled "
                                  "(%s)" % (addr, freed, detail))
            report["hits"].append(addr)
            spec, failure = _promote_and_arm(debugger, freed)
            if spec is not None:
                report["rearmed"].append(spec["addr"])
            if failure:
                report["notes"].append(failure)
    except Exception as error:
        # Forensics must not die on the ledger — but the failure is recorded as a
        # note that rides out in every payload's errors[].
        _WATCH_QUEUE.note("watchpoint reconciliation aborted: %r" % (error,))
    return report


def on_watchpoint_stop():
    """lldb target stop-hook entry point.

    Prints nothing on purpose: an extra sentinel on stdout would make
    extract_sentinel() pick the wrong payload.
    """
    if _LIVE_DEBUGGER is None:
        return
    reconcile_watchpoint_stops(_LIVE_DEBUGGER)


def _install_stop_hook(debugger):
    """Automatic re-arm. If the hook cannot be installed we say so in the ledger:
    a queued watchpoint then arms only through `gp-queue arm`."""
    ok, detail = _outcome_ok(debugger.HandleCommand(
        'target stop-hook add -o "script glasspane_bridge.on_watchpoint_stop()"'))
    if ok:
        _WATCH_QUEUE.set_rearm(True, "target stop hook installed; every payload also "
                                     "reconciles the stop it was taken at")
    else:
        _WATCH_QUEUE.set_rearm(False, detail or "stop hook rejected")
    return (ok, detail)


def _payload_from_process(process, mode, errors=None, samples=None):
    import lldb
    notes = _WATCH_QUEUE.integrity_notes()
    if process is None or not process.IsValid():
        return assemble_result(mode=mode, target={"pid": None}, status="no-process",
                               threads=[], errors=(errors or ["no live process to capture"]) + notes)
    threads = []
    for i in range(min(process.GetNumThreads(), MAX_THREADS)):
        thread = process.GetThreadAtIndex(i)
        if not thread or not thread.IsValid():
            continue
        threads.append(thread_entry(
            thread_id=thread.GetThreadID(),
            name=thread.GetName(),
            stop_reason=_describe_stop(thread),
            frames=_collect_frames(thread),
            frames_total=_num_frames(thread),
            queue=_thread_queue(thread),
        ))
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
        watchpoints=_WATCH_QUEUE.records(),
        errors=(errors or []) + notes,
    )
    if samples is not None:
        result["samples"] = samples
    return result


def _payload_via_debugger(debugger, mode, errors=None, samples=None):
    # Any payload assembled at a stop first reads the stop the way Z4 needs it
    # read: a watchpoint hit sitting unobserved is data, not an absence.
    reconcile_watchpoint_stops(debugger)
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
    # The stop we are about to report may BE a watchpoint hit: reconcile first so
    # the payload carries the hit and the queue head is armed (A-21).
    reconcile_watchpoint_stops(debugger, process)
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


def _async_mode(debugger):
    """Best effort read of the debugger's async flag (restored after sampling)."""
    getter = getattr(debugger, "GetAsyncMode", None)
    return bool(getter()) if getter is not None else False


def _main_thread_sample(process):
    """One observation of the main thread, tagged with the stop it came from."""
    import time
    try:
        thread = process.GetSelectedThread() or process.GetThreadAtIndex(0)
    except Exception:
        thread = None
    if thread is None or not thread.IsValid():
        return None
    frames = _collect_frames(thread)
    top = frames[0] if frames else None
    return {
        "at": time.time(),
        "stopId": _stop_id(process),
        "stopReason": _describe_stop(thread),
        "mainThreadFrames": len(frames),
        "framesTotal": _num_frames(thread),
        "topFrame": None if top is None else "%s!%s" % (top.get("module"),
                                                        top.get("function") or top.get("addr")),
    }


def _resume_for_next_sample(process, interval):
    """Run the target, wait out the cadence, then interrupt it again so the next
    sample reads a *new* stop. Returns (ok, detail)."""
    import lldb
    import time
    ok, detail = _outcome_ok(process.Continue())
    if not ok:
        return (False, "the target could not be resumed (%s)" % detail)
    time.sleep(interval)
    stopped = getattr(process, "Stop", None)
    if stopped is None:
        return (False, "this lldb binding has no SBProcess.Stop()")
    ok, detail = _outcome_ok(stopped())
    if not ok:
        return (False, "the interrupt request failed (%s)" % detail)
    budget = max(2.0, interval * 2.0)
    deadline = _now() + budget
    while _now() < deadline:
        state = process.GetState()
        if state == lldb.eStateStopped:
            return (True, None)
        if state in (lldb.eStateExited, lldb.eStateCrashed, lldb.eStateDetached,
                     lldb.eStateInvalid):
            return (False, "the target left the debuggable state (%s)" % state)
        time.sleep(0.05)
    return (False, "the target did not re-stop within %.1fs of the interrupt" % budget)


def cmd_trace(debugger, command, result, internal_dict):
    """T2 hang pipeline: main-thread samples taken at *separate* stops.

    The target is resumed and re-stopped between samples, and build_timeline
    drops any sample not backed by a new stop id: five reads of one frozen stop
    are one measurement, and one measurement must never be emitted as a
    5-sample timeline (that shape reads as the T2 verdict "the stack did not
    move for 5 s"). When the target cannot be resumed, exactly one sample goes
    out with `measured: false` and the reason.
    """
    requested, usage = parse_trace_request(command)
    if usage is not None:
        result.AppendMessage(usage)
        return
    observations = []
    shortfall = None
    process = _process_of(debugger)
    if process is None or not process.IsValid():
        shortfall = "no live process: the trace sampled 0 stops"
    else:
        async_before = _async_mode(debugger)
        # A synchronous Continue() never returns for a hung target, so sampling
        # has to flip the debugger async for the duration of the loop.
        debugger.SetAsync(True)
        try:
            for attempt in range(requested):
                sample = _main_thread_sample(process)
                if sample is None:
                    shortfall = "the main thread could not be read at attempt %d" % attempt
                    break
                sample["attempt"] = attempt
                sample["resumed"] = attempt > 0
                observations.append(sample)
                if attempt + 1 >= requested:
                    break
                ok, detail = _resume_for_next_sample(process, TRACE_INTERVAL_S)
                if not ok:
                    shortfall = ("sampling stopped after %d observation(s): %s"
                                 % (len(observations), detail))
                    break
        finally:
            debugger.SetAsync(async_before)
    timeline = build_timeline(observations, requested, stop_note=shortfall)
    payload = _payload_via_debugger(
        debugger, mode="trace", samples=timeline["observations"],
        errors=[] if timeline["measured"] else ["trace timeline not measured: %s" % timeline["reason"]],
    )
    payload["timeline"] = timeline
    text = render_json(payload)
    print("%s%s%s" % (SENTINEL_BEGIN, text, SENTINEL_END))


def cmd_watch(debugger, command, result, internal_dict):
    """Z4: gp-watch add <addr> [size] [rw] — hardware slots only (§6.5)."""
    argv = shlex.split(command or "")
    if not argv or argv[0] != "add":
        result.AppendMessage("usage: gp-watch add <hex-addr> [size=8] [r|w|rw]")
        return
    if len(argv) < 2:
        result.AppendMessage("usage: gp-watch add <hex-addr> [size=8] [r|w|rw] "
                             "— no address given, nothing was requested")
        return
    try:
        # Original rule kept: 0x-prefixed is hex, a bare number is decimal. The
        # ledger stores canonical "0x…" strings, so both forms reach the same entry.
        address = int(argv[1], 16) if argv[1].lower().startswith("0x") else int(argv[1])
    except ValueError:
        result.AppendMessage("gp-watch add wants an address, got %r; nothing was requested"
                             % argv[1])
        return
    if address < 0:
        result.AppendMessage("gp-watch add cannot watch a negative address (%d); "
                             "nothing was requested" % address)
        return
    size = int(argv[2]) if len(argv) > 2 and argv[2].isdigit() else 8
    mode = argv[3] if len(argv) > 3 else "w"
    spec = {"addr": "0x%x" % address, "size": size, "mode": mode}
    outcome, detail = _WATCH_QUEUE.add(dict(spec))
    if outcome == "armed":
        ok, why = _arm_watchpoint(debugger, _WATCH_QUEUE.entry_for_addr(spec["addr"]))
        if ok:
            result.AppendMessage("watchpoint armed in slot %d at %s (debugger id %s)"
                                 % (detail, spec["addr"], why))
        else:
            # The ledger reserved a slot; the hardware never took it. Undo the
            # claim instead of reporting an armed slot that cannot fire.
            _WATCH_QUEUE.abandon(spec["addr"], why)
            result.AppendMessage("watchpoint at %s NOT armed: %s" % (spec["addr"], why))
    elif outcome == "queued":
        message = ("watchpoint %s queued at position %s: NOT armed, it cannot record a "
                   "hit until a slot is released" % (spec["addr"], detail))
        if _WATCH_QUEUE.rearm_live:
            message += " (a watchpoint hit releases its slot and arms this one automatically)"
        else:
            message += (" (automatic re-arm unavailable: %s — run 'gp-queue arm' once a "
                        "slot frees)" % _WATCH_QUEUE.rearm_detail)
        result.AppendMessage(message)
    elif outcome == "rejected":
        result.AppendMessage("watchpoint rejected: %s" % detail)
    else:  # duplicate
        result.AppendMessage("watchpoint %s %s; no second slot was taken"
                             % (spec["addr"], detail))
    result.AppendMessage(render_json(_WATCH_QUEUE.snapshot()))


def cmd_queue(debugger, command, result, internal_dict):
    """Z4 ledger surface (§6.5). A bare `gp-queue` means `list` — interactive
    mode invokes the command with no argument (see build_lldb_argv)."""
    argv = shlex.split(command or "")
    sub = argv[0].lower() if argv else "list"
    if sub in ("list", "status", "snapshot"):
        reconcile_watchpoint_stops(debugger)
        result.AppendMessage(render_json(_WATCH_QUEUE.snapshot()))
    elif sub in ("arm", "promote"):
        _queue_arm(debugger, argv[1:], result)
    elif sub in ("clear", "drop", "remove"):
        _queue_clear(debugger, argv[1:], result)
    elif sub in ("help", "-h", "--help"):
        result.AppendMessage(QUEUE_USAGE)
        result.AppendMessage(render_json(_WATCH_QUEUE.snapshot()))
    else:
        result.AppendMessage("unknown gp-queue subcommand %r — nothing was changed" % argv[0])
        result.AppendMessage(QUEUE_USAGE)


def _queue_arm(debugger, argv, result):
    """§6.5: move queue head(s) into free hardware slots — the manual half of the
    re-arm path, usable when the stop hook is not available."""
    count = 1
    if argv:
        if not argv[0].isdigit() or int(argv[0]) < 1:
            result.AppendMessage("gp-queue arm wants a positive count, got %r" % argv[0])
            return
        count = min(int(argv[0]), WATCH_QUEUE_LIMIT)
    promoted = []
    stopped = None
    for _ in range(count):
        free = _WATCH_QUEUE.free_slot()
        if free is None:
            stopped = "no free hardware slot (all %d in use)" % _WATCH_QUEUE.slot_count
            break
        if not _WATCH_QUEUE.queued:
            stopped = "watchpoint queue is empty; nothing to arm"
            break
        spec, failure = _promote_and_arm(debugger, free)
        if spec is None:
            stopped = failure or "the queue head could not be armed"
            break
        promoted.append("%s->slot%s" % (spec["addr"], spec["hwSlot"]))
    result.AppendMessage("gp-queue arm: armed %d (%s)" % (len(promoted), ", ".join(promoted) or "none"))
    if stopped:
        result.AppendMessage("gp-queue arm stopped: %s" % stopped)
    result.AppendMessage(render_json(_WATCH_QUEUE.snapshot()))


def _queue_clear(debugger, argv, result):
    """Drop a queued request, disarm an armed one, or drop the whole queue."""
    if not argv:
        result.AppendMessage("gp-queue clear wants <hex-addr> or 'all'")
        return
    if argv[0].lower() == "all":
        targets = [entry["addr"] for entry in list(_WATCH_QUEUE.queued)]
    else:
        try:
            targets = ["0x%x" % int(argv[0], 16)]
        except ValueError:
            result.AppendMessage("gp-queue clear wants a hex address or 'all', got %r" % argv[0])
            return
    for addr in targets:
        phase, freed = _WATCH_QUEUE.drop(addr)
        if phase is None:
            result.AppendMessage("gp-queue clear: no ledger entry for %s — nothing removed" % addr)
            continue
        ok, detail = (True, None)
        if phase == WatchQueue.PHASE_ARMED:
            ok, detail = _disarm_watchpoint(addr)
        _WATCH_QUEUE.note("watchpoint %s was in phase %r and dropped by 'gp-queue clear'; "
                          "it will record no hit%s"
                          % (addr, phase, "" if ok else " (and its slot release is unconfirmed: %s)" % detail))
        if freed is not None:
            _promote_and_arm(debugger, freed)
    result.AppendMessage(render_json(_WATCH_QUEUE.snapshot()))


QUEUE_USAGE = ("usage: gp-queue [list | arm [count] | clear <hex-addr>|all | help]"
               " — Z4 watchpoint slot ledger (P6 §6.5)")


def __lldb_init_module(debugger, internal_dict):
    global _LIVE_DEBUGGER
    _LIVE_DEBUGGER = debugger
    debugger.HandleCommand("command script add -f glasspane_bridge.cmd_capture gp-capture")
    debugger.HandleCommand("command script add -f glasspane_bridge.cmd_trace gp-trace")
    debugger.HandleCommand("command script add -f glasspane_bridge.cmd_watch gp-watch")
    debugger.HandleCommand("command script add -f glasspane_bridge.cmd_queue gp-queue")
    _install_stop_hook(debugger)


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
    if args.mode == "trace" and not 1 <= args.samples <= MAX_TRACE_SAMPLES:
        parser.error("--samples must be within 1..%d; the bridge refuses a sample "
                     "count it cannot honour" % MAX_TRACE_SAMPLES)
    return run_outer(args)


if __name__ == "__main__":
    sys.exit(main())
