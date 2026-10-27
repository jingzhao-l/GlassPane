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
covered by test_bridge.py with plain python3. The SB-API surface is split at the
*call*, not at the module: the decisions taken about SB objects (which thread
rows reach the payload and what a cap announces, whether a stop is a crash and
what the 0/1/3 verdict is, whether a watchpoint hit released its slot and armed
the queue head, what an unreadable read publishes) are driven in the default
suite against objects shaped like lldb's binding, while the calls that need a
real debugger — `target.WatchAddress`, resume/re-stop, `LaunchSimple`, the live
stop hook — are stubbed at that one seam and stay real-machine smoke only
(§7.5, opt-in via `GLASSPANE_REAL_LLDB=1`). Nothing is faked into a verdict: a
stub may hand back an SB-shaped value, it may not make the bridge report a
measurement it did not take (unreadable stays null + an errors[] note).

Outer CLI exit codes (`run_outer`): 0 = a non-crash scene was captured, 1 =
nothing was captured, 2 = lldb could not be spawned or the payload could not be
delivered, 3 = a crash scene was captured and delivered. 3 exists because a
signal stop used to be indistinguishable from a clean capture at both layers
(`stopReason` came from a hand-copied enum table, so SIGSEGV rendered as
"frameIndexChanged" with `crash: null`, and the exit code was 0).
"""

import argparse
import base64
import json
import os
import secrets
import shlex
import signal
import socket
import subprocess
import sys

SENTINEL_BEGIN = "GPBRIDGE<<"
SENTINEL_END = ">>GPBRIDGE"
#: R30 标记的每次运行随机前缀。固定标记是**可预先伪造**的：被调试目标的 stdout 就
#: 流同一条 lldb stdout（`bridge/crashcanary.swift` 每次跑都打印，
#: `test_bridge.py` 的噪声用例也是这个形状），任何被测进程都能先吐一对
#: `GPBRIDGE<<{…}>>GPBRIDGE` 把 threads/status 换掉，或夹一对畸形 JSON 让真载荷
#: 读成"没有载荷"。父进程生成 nonce、只经子进程环境交给 lldb 内的那个脚本，
#: 匹配时要求它——剩下的残余风险只有一个会读自己环境变量的被测目标，
#: 而"取最后一个可解析的完整对"正是为那种情形兜底。
SENTINEL_NONCE_ENV = "GPBRIDGE_SENTINEL_NONCE"
SENTINEL_NONCE_BYTES = 16
#: `gp-watch add` 的读写档：只有这三形。`x`（或任何别的）会落成
#: read=False, write=False —— 一次都不可能被触发的监视点，还要占掉四个硬件槽
#: 之一，并在账本里报告"已武装"。
WATCH_MODES = ("r", "w", "rw")
DEFAULT_WATCH_MODE = "w"
DEFAULT_WATCH_SIZE = 8  # 显式命名：它从前是藏在 `else 8` 里的一个魔法数

MAX_FRAMES = 64
MAX_LOCALS = 16
MAX_VALUE_BYTES = 256
MAX_THREADS = 64
HW_WATCHPOINT_SLOTS = 4
WATCH_QUEUE_LIMIT = 64
WATCHPOINT_NOTE_LIMIT = 24
TRACE_SAMPLES = 5
TRACE_INTERVAL_S = 1.0
#: R30回传 socket 的 connect/send 上限：对端不读取时宁可报错，不可挂住桥。
SEND_SOCK_TIMEOUT_S = 10.0
MAX_TRACE_SAMPLES = 32
EMIT_TIMEOUT_S = 5.0
#: 杀掉整组之后**再抽干一次管道**的上限。到期就带着已经读到的字节离场：管道写端
#: 可能被一个逃出了进程组的继承者握着，无限等下去会兑现不了「永不静默挂起」。
#: 命名它而不是写死 5：它同时是收尾 `wait()` 的上限，测试要用一个小值跑这条分支。
CHILD_DRAIN_TIMEOUT_S = 5.0


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
    """One §6.4 ``frames[]`` record.

    ``locals_=None`` is **"these locals were never read"**, not "this frame holds
    no locals": only the top frame is read (§6.1), and a frame that was never
    asked about its locals used to publish ``locals: []`` + ``localsTotal: 0`` —
    a count of zero asserted where the truth is unmeasured, the same class the
    ``queue`` rule below refuses to ship. An empty *list* stays "measured, none".
    """
    frame = {"idx": index, "module": module, "addr": address}
    if file is not None:
        frame["file"] = file
    if line is not None:
        frame["line"] = line
    if function is not None:
        frame["function"] = function
    if locals_ is None:
        frame["locals"] = []
        frame["localsTotal"] = None
        frame["localsTruncated"] = None
        return frame
    seen = list(locals_)
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


def parse_watch_mode(raw, default=DEFAULT_WATCH_MODE):
    """`gp-watch add` 的读写档：只认 r / w / rw（纯函数，可单测）。

    以前 `argv[3]` 是不经验证直接进账本的，于是 `gp-watch add 0x… 8 x` 会武装一个
    read=False、write=False 的监视点：它一次都不可能被触发，却占掉四个硬件槽之一，
    并且账本报告"已武装"。拒绝它，且**不登记任何请求**。
    """
    if raw is None or not str(raw).strip():
        return default, None
    mode = str(raw).strip().lower()
    if mode not in WATCH_MODES:
        return None, ("gp-watch add wants a mode of %s, got %r: a mode with neither read "
                      "nor write can never fire, and it would still burn one of the %d "
                      "hardware watchpoint slots — nothing was requested"
                      % (" or ".join(WATCH_MODES), raw, HW_WATCHPOINT_SLOTS))
    return mode, None


def parse_watch_size_token(raw, default=DEFAULT_WATCH_SIZE):
    """`gp-watch add` 的字节数档（纯函数）：**size 位上的非数字一律拒，不许顺延**。

    `parse_watch_mode` 补上了 mode 位那一半，size 位这一半还漏着：调用点是
    `size = int(argv[2]) if argv[2].isdigit() else 8`。于是
    `gp-watch add 0x4000 r`——一个把读写档放在第二位、没写 size 的合法直觉写法——
    "r" 过不了 `isdigit()`，size 静默落回 8，而 argv[3] 根本不存在，mode 又静默落回
    默认 "w"：**要读的人拿到一个写观察点**，账本还按请求地址报告"已武装"。
    位置不能靠猜：要么按 `<addr> [size] [mode]` 写全，要么当场拒，并给出那条形式。
    """
    if raw is None:
        return default, None
    text = str(raw).strip()
    if not text:
        return default, None
    if not text.isdigit():
        return None, ("gp-watch add wants a byte size before the mode, got %r "
                      "(form: gp-watch add <addr> [size] [%s]); a mode belongs in the slot "
                      "after the size, and nothing was armed"
                      % (raw, "/".join(WATCH_MODES)))
    value = int(text)
    if value <= 0:
        return None, ("gp-watch add wants a positive byte size, got %d: a zero or negative "
                      "width cannot be watched — nothing was armed" % value)
    return value, None


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


def new_sentinel_nonce():
    """Per-run marker nonce (hex). Unguessable, never read from the target."""
    return secrets.token_hex(SENTINEL_NONCE_BYTES // 2)


def sentinel_nonce_from_env():
    """The nonce this process was handed by the outer bridge, if any.

    Sanitised: this value is read out of the environment and lands *inside the
    marker*, so a stray whitespace/quote in someone's export would otherwise
    break the framing for the whole run (and hand the outer bridge a stream it
    cannot read). Anything outside the hex-plus-dash set is dropped, and an
    over-long value is clipped — what is left is either a usable nonce or none.
    """
    raw = (os.environ.get(SENTINEL_NONCE_ENV) or "").strip()
    cleaned = "".join(ch for ch in raw if ch.isalnum() or ch in "._-")[:64]
    return cleaned or None


def sentinel_begin(nonce=None):
    """The begin marker for a run: plain when no nonce is in play."""
    nonce = (nonce or "").strip()
    return SENTINEL_BEGIN if not nonce else "GPBRIDGE<%s<<" % nonce


def wrap_sentinel(text, nonce=None):
    """Render one emission around already-rendered JSON text."""
    return "%s%s%s" % (sentinel_begin(nonce), text, SENTINEL_END)


def extract_sentinel(stdout_text, nonce=None):
    """Pull the payload out of noisy lldb stdout: the LAST parseable pair wins.

    Two rules, both learned from a real shape rather than theory:
      * last, not first — the bridge emits its payload after the target has run,
        so an earlier pair is noise or a forgery by construction;
      * parseable — "last" alone would let a late malformed pair mask the real
        payload and read as "no payload", so a candidate that does not complete
        (no end marker) or does not parse is skipped, and the scan keeps going
        leftwards.
    `nonce` narrows the marker to this run's random prefix, so a target that only
    knows the fixed text cannot be matched at all. Returns (payload | None, raw).
    """
    begin = sentinel_begin(nonce)
    cursor = len(stdout_text)
    while True:
        start = stdout_text.rfind(begin, 0, cursor)
        if start < 0:
            return None, stdout_text
        cursor = start  # next candidate sits strictly left of this one
        body = stdout_text[start + len(begin):]
        end = body.find(SENTINEL_END)
        if end < 0:
            continue
        try:
            return json.loads(body[:end]), body[:end]
        except json.JSONDecodeError:
            continue


def sentinel_absence_clue(stdout_text, nonce=None):
    """Say *which* failure it was: no marker at all, or markers that were useless.

    The two have different fixes (the inner script never ran vs. it ran and its
    payload could not be read), and collapsing them is how a green-looking
    "no payload" message hides a regression.
    """
    begin = sentinel_begin(nonce)
    seen = stdout_text.count(begin)
    if not seen:
        if nonce:
            return ("no %s marker carrying this run's nonce appeared in lldb's stdout "
                    "(%d fixed-marker pair(s) were present but untrusted); the in-lldb "
                    "script did not inherit %s, or never emitted"
                    % (begin, stdout_text.count(SENTINEL_BEGIN), SENTINEL_NONCE_ENV))
        return "no %s…%s marker appeared in lldb's stdout at all" % (SENTINEL_BEGIN, SENTINEL_END)
    return ("%d marker(s) carrying this run's nonce appeared, none of them a complete, "
            "JSON-parseable payload (truncated stdout, or a target that learned this "
            "run's nonce and emitted a broken pair)" % seen)


def encode_capture_spec(spec):
    """JSON then base64 — so the spec can ride into a *Python* expression.

    `shlex.quote` is POSIX-SHELL quoting, but the `-o script …` text is evaluated
    by lldb's Python: an exe path with an apostrophe came out as the shell splice
    `'\\''`, which Python reads as a SyntaxError. The capture then died with no
    payload at all (it failed closed, so this was a correctness defect rather
    than an injection, but every path with a quote in it was uncapturable).
    base64's alphabet carries no quote, no space and no shell metacharacter.
    """
    text = json.dumps(spec, ensure_ascii=True, sort_keys=True)
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


#: `command script import` 的参数由 **lldb 自己的命令分词器**切，不是 shell：
#: argv 里的一个 token 交给 lldb 后还会再被拆一次。本机实测（`test_bridge.py`
#: 的 `RealLLDBImportSurvivesPathShape` 就是拿这段跑真 lldb 复算的）：
#:   - 裸路径带空格 → `error: module importing failed: invalid pathname '/tmp/gp'`
#:     （仓库装在带空格的路径上就永远导不进来，而外层把这件事报成"开发者工具权限"）
#:   - 单引号成组、双引号成组都可行，**组内另一种引号是字面量**
#:   - 单独用 `'…'` 时路径里的 `'` 会被吞掉；单独用 `"…"` 时路径里的 `"` 会被吞掉
#:   - `'\''` 那枚 shell 接片段在 lldb 的分词器里同样成立（含两种引号的路径实测通过）
#:   - 反斜杠转义只在空白上可靠，`\t` 这类会被原样留下 → 不采用
#: 于是唯一一条通用形态 = 单引号成组 + 路径里的 `'` 换成 `'\''`。
def lldb_command_quote(text):
    """Quote `text` so lldb's command tokenizer hands it over as ONE token."""
    return "'" + str(text).replace("'", "'\\''") + "'"


#: `GPBRIDGE_BUDGET` 是"在 lldb 里面等多久"，写错它的人只有一个下场：桥以 traceback
#: 离场、`--out` 与 `--send-sock` 零字节（D3，2026-10-24 上一泳道本机实测复现）。那违背
#: 本文件 §6.2「失败也以 JSON 离场」，而且违背得最彻底——调用方拿到的是一个 Python
#: ValueError 和退 1，一个字段都读不到。所以现在：解析不进去就用默认值，并且把这件事
#: 如实写进 errors[]；预算的可观测上限就是外层 timeout（外层到点先 killpg，比外层还长
#: 的预算根本不可能被观测到），下限是 30s 的 debugserver 冷启动地板（F5 实测 >5min 的
#: 首次 attach 说的就是这件事）。外层 timeout 落在地板之上时钳进 `[地板, timeout]`；外层
#: timeout 比地板还短时地板无法兑现，预算退到那唯一可观测的天花板（= timeout）本身，note
#: 点名该抬的那一颗旋钮（`--timeout`），而不是报出一个自相矛盾的 `30..timeout` 区间。
BUDGET_DEFAULT_S = 60.0
BUDGET_FLOOR_S = 30.0


def capture_budget_s(raw_env_value, timeout=None):
    """Resolve the in-lldb capture budget: returns `(seconds, error_or_None)`.

    Pure, and takes the env value as an argument rather than reading `os.environ`,
    so both arms (a garbage value and an out-of-range one) are testable without
    mutating the interpreter's environment.
    """
    text = None if raw_env_value is None else str(raw_env_value).strip()
    if text is None or text == "":
        return BUDGET_DEFAULT_S, None
    try:
        value = float(text)
    except (TypeError, ValueError):
        return BUDGET_DEFAULT_S, (
            "GPBRIDGE_BUDGET=%r is not a number: using the %gs default. A budget that cannot be "
            "parsed is not a budget of zero and not a failure to start — §6.2 says this bridge "
            "leaves with JSON, so the run proceeds and this line says what was ignored."
            % (raw_env_value, BUDGET_DEFAULT_S))
    if value != value or value in (float("inf"), float("-inf")):  # NaN / Infinity
        return BUDGET_DEFAULT_S, ("GPBRIDGE_BUDGET=%r is not a finite number: using the %gs default."
                                  % (raw_env_value, BUDGET_DEFAULT_S))
    floor = BUDGET_FLOOR_S
    # The observable upper bound is the outer --timeout: the bridge SIGKILLs the whole
    # process group there, so a budget ABOVE it can never elapse. `ceiling` therefore
    # equals the timeout when one is given — NOT `max(floor, timeout)`, which for a
    # `--timeout < floor` handed back a budget larger than the window it could never
    # be observed in (the note then asserted a self-contradictory "30..timeout").
    ceiling = floor if timeout is None else float(timeout)
    # The 30s floor is a *usefulness* bound (debugserver cold start, F5), not an upper
    # bound. When the outer window is shorter than the floor, the floor simply cannot
    # be honoured, so it collapses down to the ceiling; the note then names the knob to
    # raise (--timeout) instead of claiming an empty "30..timeout" interval.
    lower = floor if timeout is None else min(floor, ceiling)
    clamped = min(max(value, lower), ceiling)
    if clamped != value:
        if timeout is not None and ceiling < floor:
            return clamped, ("GPBRIDGE_BUDGET=%g clamped to %g: the outer --timeout (%g) is "
                             "smaller than the %gs debugserver cold-start floor, so no budget "
                             "inside that window is long enough for a first attach (F5). The "
                             "budget is capped at the observable ceiling (%g..%g = the outer "
                             "--timeout itself), because a budget above the outer timeout can "
                             "never be observed — the process group is killed first. Raise "
                             "--timeout to at least %gs to get a meaningful capture."
                             % (value, clamped, timeout, floor, lower, ceiling, floor))
        return clamped, ("GPBRIDGE_BUDGET=%g clamped to %g (allowed %g..%g = the %gs cold-start "
                         "floor up to the outer --timeout; a budget above the outer timeout can "
                         "never be observed, because the process group is killed first)."
                         % (value, clamped, floor, ceiling, floor))
    # Even a value that needs no clamping deserves the cold-start warning when the
    # whole outer window sits below the floor: the run cannot honour the floor either way.
    if timeout is not None and ceiling < floor:
        return clamped, ("GPBRIDGE_BUDGET=%g kept, but the outer --timeout (%g) is smaller than "
                         "the %gs debugserver cold-start floor (F5): this capture window is too "
                         "short for a first attach. Raise --timeout to at least %gs."
                         % (value, timeout, floor, floor))
    return value, None


def build_lldb_argv(bridge_path, mode, pid=None, exe=None, exe_args=None,
                    samples=TRACE_SAMPLES, extra_script=None, timeout=None):
    """Compose the `xcrun lldb --batch` invocation (pure; unit-tested)."""
    argv = ["xcrun", "lldb", "--batch"]
    if pid is not None:
        # lldb 的 attach 形态是 -p <pid>（--attach 不存在——2026-09-21 真机
        # 复验抓到这个参数缺陷：attach 面从未真正试过内核，报的是 unknown
        # option 的伪装失败）。
        argv += ["-p", str(pid)]
    if exe:
        argv += ["--file", exe]
    argv += ["-o", "command script import %s" % lldb_command_quote(bridge_path)]
    if extra_script:
        argv += ["-o", extra_script]
    if mode == "capture":
        if exe and pid is None:
            # SB-API driver: batch would end the session at the crash stop,
            # so one script command does launch+wait+collect+emit.
            budget, error = capture_budget_s(os.environ.get("GPBRIDGE_BUDGET"), timeout)
            spec = {"exe": exe, "args": exe_args, "mode": "capture", "budget_s": budget}
            if error:
                # The spec is base64'd JSON, so the note can ride to the child without any
                # quoting hazard; `run_capture_cli_b64` puts it in the payload it sends back.
                spec["budget_note"] = error
            argv += ["-o", "script glasspane_bridge.run_capture_cli_b64('%s')"
                     % encode_capture_spec(spec)]
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


def _secure_out_write(out_path, text):
    """Write the payload to ``--out`` without ever clobbering a file or following a link.

    The payload is a debugged process's registers and top-frame locals, so the
    plain ``open(path, "w")`` this replaces was unsafe three ways at once: the
    mode came from the caller's umask (a world-readable ``/tmp/capture.json`` is
    the documented usage, see ``bridge/crashcanary.swift``), a pre-existing file
    was overwritten silently, and a symlink planted at the target turned the write
    into an arbitrary-file overwrite running as the user. This mirrors the engine's
    evidence-report writer (``EvidenceReportGenerator.swift``): ``O_EXCL`` refuses a
    target that exists, ``O_NOFOLLOW`` refuses a symlink (on macOS both surface as
    ``EEXIST`` and nothing is written), and ``fchmod`` pins ``0600`` because a umask
    can only *clear* bits from ``0o600`` — under ``umask 0777`` an un-pinned file is
    ``0000``, not the ``0600`` the panel promises. Raises ``OSError`` when refused;
    a file this call created but could not finish writing is removed, never left half.
    """
    try:
        fd = os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except OSError as error:
        kind = "is a symlink" if os.path.islink(out_path) else "already exists"
        raise OSError(
            "refusing to write --out %r: the target %s. O_EXCL and O_NOFOLLOW never "
            "clobber a file or follow a link, so nothing was written and the target "
            "was left untouched (errno %s)" % (out_path, kind, error.errno)
        ) from error
    try:
        os.fchmod(fd, 0o600)  # guarantee 0600 regardless of the caller's umask
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            fd = -1  # ownership moved to the file object; the with-block closes it
            handle.write(text + "\n")
    except OSError as error:
        if fd != -1:
            os.close(fd)
        try:
            os.unlink(out_path)  # O_EXCL proved this call created it
        except OSError:
            pass
        raise OSError("could not finish writing --out %r: %s" % (out_path, error)) from error


def emit(payload, out_path=None, send_sock=None, timeout_s=None):
    """R30 local回传: stdout sentinel always; optional one-line NDJSON frame
    into an existing unix socket (connection failure → stderr + nonzero).

    The socket is bounded on connect *and* send and always closed: an engine
    side that stopped draining would otherwise hang the bridge forever with a
    leaked fd (§6.2 only promises "failure surfaces", silence is not success).
    The default bound is EMIT_TIMEOUT_S; an explicit timeout_s overrides it.

    ``--out`` goes through `_secure_out_write` (private, exclusive create): a
    refused target does not leak the capture and does not overwrite anything —
    it leaves a JSON-shaped failure on stdout (§6.2) and re-raises, so the run
    reports nonzero rather than writing a world-readable or symlinked file.
    """
    text = render_json(payload)
    if out_path:
        try:
            _secure_out_write(out_path, text)
        except OSError as error:
            refusal = assemble_result(
                mode=payload.get("mode") if isinstance(payload, dict) else None,
                target=payload.get("target") if isinstance(payload, dict) else None,
                status="failed",
                threads=[],
                errors=["--out delivery refused, the capture was not written: %s" % error],
            )
            sys.stdout.write("%s%s%s\n" % (SENTINEL_BEGIN, render_json(refusal), SENTINEL_END))
            sys.stdout.flush()
            raise
    sys.stdout.write("%s%s%s\n" % (SENTINEL_BEGIN, text, SENTINEL_END))
    sys.stdout.flush()
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


def _decoded_partial(value):
    """Fold a timed-out read's buffer into text the sentinel parser can eat.

    `TimeoutExpired.output`/`.stderr` carry the raw **bytes** read so far — even
    when Popen ran in text mode, CPython fills them straight from the fd-level
    chunks — and this pipe is lossy by contract (B-28): a non-UTF-8 byte must
    become U+FFFD here rather than raise inside the error path.
    """
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value)


def _keep_widest(kept, candidate):
    """Keep the larger buffer, never a concatenation.

    CPython accumulates what it read across `communicate()` calls, so the newest
    buffer is normally a superset of the older one; joining both would duplicate
    the noise. Length is the only comparison that cannot both lose the sentinel
    pair and invent a second copy of it.
    """
    text = _decoded_partial(candidate)
    return text if len(text) >= len(kept) else kept


def _release_pipes_and_reap(proc):
    """Close both read ends and reap the child — the two things a timed-out
    `communicate()` leaves for nobody else to do.

    After a timeout CPython deliberately leaves the fds open in case the caller
    retries, so a path that does not close them leaks one fd pair per hung
    capture, and an unreaped child is a zombie that keeps the pid (and, on this
    bridge, the stopped target) claimed. Both closes are idempotent, so this is
    safe to run on the success path too.
    """
    for name in ("stdout", "stderr"):
        stream = getattr(proc, name, None)
        if stream is None:
            continue
        try:
            stream.close()
        except OSError:
            pass
    if proc.returncode is None:
        try:
            proc.wait(timeout=CHILD_DRAIN_TIMEOUT_S)
        except (subprocess.TimeoutExpired, OSError):
            pass


def _kill_process_group(proc):
    """SIGKILL the child's whole process group — idempotently, and only if it is there.

    D7 (2026-10-24 复核)：这一步从前只写在 `except subprocess.TimeoutExpired` 里面。
    `finally` 只走 `_release_pipes_and_reap`（关管道 + wait），而 :922-926 整段论证的
    就是"只杀直接子进程会把被 attach 的目标留在 SIGSTOP"——所以 `communicate()` 抛出的
    **任何一种**别的异常（解码、ValueError、被信号打断的 syscall）都绕过那段论证：管道
    被关掉、孩子被 wait 收掉，debugserver 与它手里那个停住的进程留在原地。
    挪进幂等的清理路径就是修这个：`getpgid` 先问一次有没有这个组（孩子已经退出时它是
    ProcessLookupError，不是"杀成功了"），杀不到就说杀不到。
    """
    try:
        pgid = os.getpgid(proc.pid)
    except (ProcessLookupError, OSError):
        return (False, "no process group to kill for pid %s" % proc.pid)
    try:
        os.killpg(pgid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError) as error:
        return (False, "killpg(%d) did not land: %r" % (pgid, error))
    return (True, None)


def run_child_captured(argv, timeout, env=None):
    """Spawn the lldb child and drain it: **lossy** decode, whole-group kill.

    `errors="replace"` 是契约的一部分而不是风格：`text=True` 的默认解码是严格的，
    而这条 stdout 里同时流着 lldb 自己**与被调试目标**的输出——一个非 UTF-8 字节就
    会在 `communicate()` 内部抛 UnicodeDecodeError，那里没有任何分支接得住它，于是
    桥以一段 traceback 离场、零载荷，正违背 §6.2「失败也以 JSON 离场」。坏字节换成
    U+FFFD，哨兵对里的载荷照旧解析得出来。

    `start_new_session=True` + 到期 `killpg`：debugserver 是 lldb 的**子进程**
    且继承了同一对管道。`subprocess.run(timeout=)` 超时只 kill 直接子进程，
    随后仍会无时限地 `communicate()` 等管道 EOF——而管道被活着的 debugserver
    握着，于是"永不静默挂起"的注释不成立，且被 attach 的目标进程会常驻
    SIGSTOP（用户的被测应用被冻死在这里）。自成进程组才能整组收掉。

    双重超时（杀了整组、管道还是不通 EOF）那一支从前是 `proc.kill()` +
    `out, err = "", ""`：它同时丢了**已经读进缓冲的字节**（哨兵对可能就在里面，
    lldb 明明已经吐出了载荷）、漏掉那一对 fd、并且从不 `wait()` 收尸。现在两次
    抽干之间的字节都留下，收尾一律走 `_release_pipes_and_reap`，超时判决不变。

    Returns (completed, timed_out). `OSError` 原样上抛，由调用方决定报什么形状。
    """
    proc = subprocess.Popen(
        argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, errors="replace", start_new_session=True, env=env,
    )
    delivered = False
    try:
        out, err = proc.communicate(timeout=timeout)
        delivered = True
        return _Completed(proc.returncode, out, err), False
    except subprocess.TimeoutExpired as first:
        out = _keep_widest("", first.output)
        err = _keep_widest("", first.stderr)
        _kill_process_group(proc)
        try:
            drained_out, drained_err = proc.communicate(timeout=CHILD_DRAIN_TIMEOUT_S)
        except subprocess.TimeoutExpired as second:
            out = _keep_widest(out, second.output)
            err = _keep_widest(err, second.stderr)
        else:
            out = _keep_widest(out, drained_out)
            err = _keep_widest(err, drained_err)
        return _Completed(proc.returncode, out, err), True
    finally:
        # `not delivered` is the whole judgement: a run whose bytes came back has nothing
        # left to kill, and killing a group that may still hold the user's launched target
        # would be a new way to destroy evidence. Everything else — a non-timeout exception
        # from `communicate()`, an early `return` above that never ran, an interrupt — gets
        # the group, and it gets it idempotently (the timeout branch has already killed and
        # `getpgid` will simply say the group is gone). Then, and only then, the fds.
        if not delivered:
            _kill_process_group(proc)
        _release_pipes_and_reap(proc)


def _process_is_stopped(pid):
    """Is this pid *right now* stopped? `ps` answers; None means "cannot tell", not "no"."""
    try:
        got = subprocess.run(["ps", "-p", str(int(pid)), "-o", "state="],
                             capture_output=True, text=True, timeout=5)
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    text = (got.stdout or "").strip()
    if not text:
        return None
    return text[0].upper() == "T"


def resume_frozen_target(pid):
    """F7 (2026-10-24 复核)：超时整组 SIGKILL 之后，唤醒被 attach 的目标，并**如实**说唤醒没唤醒。

    被 `--pid` 附上的进程是 lldb 用 SIGSTOP 停住的；把 lldb 与 debugserver 杀掉，留下的
    就是那个 SIGSTOP——全仓此前没有一处 `SIGCONT`，所以用户的应用一直冻在那里。而超时
    载荷那一句 "a target that had been stopped here is no longer held by this bridge"
    说的恰恰相反：那不是判决，是一次谎。现在先 `kill(pid, SIGCONT)`，再用 `ps` 读回状态，
    把读到的写进 payload——三种结局（醒了 / 进程已经不在了 / 杀不动或读不到）各是各的话。
    """
    if pid is None:
        return (False, "no --pid: this bridge attached nothing, so it wakes nothing")
    try:
        numeric = int(pid)
    except (TypeError, ValueError):
        return (False, "pid %r is not a number: nothing was resumed" % (pid,))
    try:
        os.kill(numeric, signal.SIGCONT)
    except ProcessLookupError:
        return (True, "pid %d is gone: nothing left stopped" % numeric)
    except OSError as error:
        return (False, "SIGCONT to pid %d failed (%r): the target is STILL held stopped"
                % (numeric, error))
    stopped = _process_is_stopped(numeric)
    if stopped is False:
        return (True, "pid %d was sent SIGCONT and reads as running again" % numeric)
    if stopped is True:
        return (False, "pid %d was sent SIGCONT and STILL reads as stopped: something else holds it"
                % numeric)
    return (False, "pid %d was sent SIGCONT and `ps` could not read its state; "
                   "whether it woke was NOT measured" % numeric)


def run_outer(args):
    """Parent-process path: exec lldb, extract payload, re-emit per §6.2."""
    bridge_path = os.path.abspath(__file__)
    exe_args = list(args.exe_args) if args.exe_args else None
    _budget, budget_note = capture_budget_s(os.environ.get("GPBRIDGE_BUDGET"), args.timeout)
    argv = build_lldb_argv(
        bridge_path,
        mode=args.mode,
        pid=args.pid,
        exe=args.exe,
        exe_args=exe_args,
        samples=args.samples,
        extra_script=args.setup,
        timeout=args.timeout,
    )
    # 本轮的哨兵 nonce 只经**子进程环境**交给 lldb 内的那个脚本：被调试目标若自己
    # 打印一对固定标记，它匹配不上带 nonce 的 begin，也就不可能被当成载荷（加上
    # extract_sentinel 的"最后一个可解析对"，两路都堵上）。
    nonce = new_sentinel_nonce()
    try:
        completed, timed_out = run_child_captured(
            argv, args.timeout, env=dict(os.environ, **{SENTINEL_NONCE_ENV: nonce}))
    except OSError as error:
        sys.stderr.write("cannot spawn lldb: %s\n" % error)
        return 2
    if timed_out:
        # F5: lldb --batch can hang pre-timeout on machines where debug attach
        # is gated or cold-started. Structured refusal, never a silent hang.
        # 整组已经 SIGKILL 过了（`run_child_captured` 的清理路径）。现在这一步做的是
        # 那一步做不到的事：被 `--pid` 附上的目标不会因为杀掉调试器而自由——它停在
        # SIGSTOP 上。先唤醒，再把"唤没唤醒"照实写进载荷，而不是沿用那句没人验过的
        # "no longer held by this bridge"。
        woke, wake_detail = resume_frozen_target(args.pid)
        errors = [
            "lldb did not produce a capture within %ss. On this machine "
            "debugger attach/launch is permission-gated (P6 §0 F1/F2/F5): "
            "grant System Settings > Privacy & Security > Developer Tools to the "
            "calling process, or run inside an already-authorized Terminal session. "
            "The whole lldb process group was SIGKILLed on timeout; about the target: %s "
            "(%s)" % (args.timeout,
                      "it was resumed" if woke else "IT IS NOT CONFIRMED RESUMED — check the pid",
                      wake_detail),
        ]
        if not woke and args.pid is not None:
            errors.append("remedy for a target left stopped by an attach: kill -CONT %s; "
                          "if that is refused the process belongs to another debugger session "
                          "and only that session can release it." % args.pid)
        if budget_note:
            errors.append(budget_note)
        payload = assemble_result(
            mode=args.mode,
            target={"pid": args.pid, "exe": args.exe},
            status="failed",
            threads=[],
            errors=errors,
        )
        try:
            emit(payload, out_path=args.out, send_sock=args.send_sock)
        except OSError as error:
            # emit already left the JSON-shaped failure on stdout (§6.2); this is
            # the operator-facing note only. Covers both a refused --out target and
            # a --send-sock that stopped draining, so it must not name just one.
            sys.stderr.write("payload delivery failed (--out / --send-sock): %s\n" % error)
            return 2
        return 1
    payload, _raw = extract_sentinel(completed.stdout, nonce=nonce)
    if payload is None:
        stderr_tail = completed.stderr[-2000:] if completed.stderr else ""
        # 成因先分诊再落文案：桥没被导入（路径形态）与调试席位被拒（权限）补救
        # 完全不同，而从前这里无论哪种都写"去勾 Developer Tools"——路径里一个空格
        # 就让人去勾一张永远不会起效的席位。
        _cause, remedy = no_payload_cause(stderr_tail, completed.stdout, bridge_path)
        payload = assemble_result(
            mode=args.mode,
            target={"pid": args.pid, "exe": args.exe},
            status="failed",
            threads=[],
            errors=[
                "lldb produced no capture payload (exit %d). %s. Cause read from "
                "lldb's own output (%s): %s lldb stderr tail: %s"
                % (completed.returncode,
                   sentinel_absence_clue(completed.stdout, nonce), _cause, remedy,
                   stderr_tail),
            ] + ([budget_note] if budget_note else []),
        )
    elif budget_note:
        # 采到了载荷也不能把"预算被钳过/退回默认值"这件事丢掉：载荷里的 errors[] 就是
        # §6.2 让读者看判决的地方，而这条判决是关于**这一趟跑了多久**的。
        payload.setdefault("errors", [])
        if isinstance(payload["errors"], list):
            payload["errors"].append(budget_note)
    try:
        emit(payload, out_path=args.out, send_sock=args.send_sock)
    except OSError as error:
        # emit already left the JSON-shaped failure on stdout (§6.2); the refusal
        # can come from a protected --out target or a drained --send-sock alike.
        sys.stderr.write("payload delivery failed (--out / --send-sock): %s\n" % error)
        return 2
    # 0/1/3：崩溃现场交付出去仍然给非零（3），调用方只看退出码也不会把一次 SIGSEGV
    # 读成一次干净的通过。判据在 `outer_exit_code()`，纯函数、单测直接钉住。
    return outer_exit_code(payload)


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
#:
#: 退出码是 `0/1/3`（`outer_exit_code()`）：`0` = 采到了**非崩溃**现场，`1` =
#: 什么都没采到，`3` = 崩溃现场已交付。停因同样只认枚举名（`STOP_REASON_NAMES`），
#: 见上面那张表的实测说明——崩溃判据从前押在抄错的 `stop == 7` 上，SIGSEGV 于是
#: 既没有 `crash` 也没有非零退出，两层一起沉默。
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


#: LLDB `SBStopReason` 枚举成员全集，按**声明次序**（= 数值次序）列出。
#: 2026-10-20 本机实测（`xcrun lldb --batch -o "script print([n for n in dir(lldb)
#: if n.startswith('eStopReason')])"`，取值逐条由 lldb 自己给出）：
#:   Invalid 0 · None 1 · Trace 2 · Breakpoint 3 · Watchpoint 4 · **Signal 5** ·
#:   Exception 6 · Exec 7 · PlanComplete 8 · ThreadExiting 9 · Instrumentation 10 ·
#:   ProcessorTrace 11 · Fork 12 · VFork 13 · VForkDone 14 · Interrupt 15 ·
#:   HistoryBoundary 16
#: 旧实现手抄的那张表是 LLDB 早期**私有** `StopReasonEnum` 的次序（`stepOut` /
#: `frameIndexChanged` / `noDebug` / `threadSpec` 这些成员在 SB 绑定里根本不存在），
#: 于是真机上 SIGSEGV 那一次停（5）被报成 `stopReason: "frameIndexChanged"` +
#: `crash: null`，崩溃被呈现成一次干净的采集并以 0 离场——本文件里最坏的那一类
#: 失效。判据与进程状态面同一条纪律：**契约是枚举名，不是数字**（数字由 lldb 给，
#: 见 `stop_reason_int_by_name()`），所以换一台 lldb 取值不同也不会认错停因。
STOP_REASON_NAMES = (
    "eStopReasonInvalid", "eStopReasonNone", "eStopReasonTrace",
    "eStopReasonBreakpoint", "eStopReasonWatchpoint", "eStopReasonSignal",
    "eStopReasonException", "eStopReasonExec", "eStopReasonPlanComplete",
    "eStopReasonThreadExiting", "eStopReasonInstrumentation",
    "eStopReasonProcessorTrace", "eStopReasonFork", "eStopReasonVFork",
    "eStopReasonVForkDone", "eStopReasonInterrupt", "eStopReasonHistoryBoundary",
)

#: 目标被信号打死的那一档：崩溃判据押在名字上，不押在 5 或 7 上。
CRASH_STOP_REASON = "eStopReasonSignal"

#: 上面那张表在纯逻辑 CI（没有 lldb 可导入）里的镜像：数值 = 声明次序的序号。
#: 与 `_FALLBACK_STATE_INT` 同理——真机一律走 lldb 自己的常量，镜像不参与判定，
#: 只为让 name↔int 的等价关系在无 lldb 的机器上同样可测。
_FALLBACK_STOP_REASON_INT = {name: index for index, name in enumerate(STOP_REASON_NAMES)}

_STOP_REASON_INT_BY_NAME = None


def stop_reason_label(name):
    """枚举成员名 → 载荷里的词：剥 `eStopReason` 前缀、首字母小写。
    `eStopReasonSignal` → `signal`，`eStopReasonVForkDone` → `vforkDone`。"""
    stripped = name[len("eStopReason"):] if name.startswith("eStopReason") else name
    return stripped[:1].lower() + stripped[1:] if stripped else stripped


#: 载荷词汇表（`stopReason` 字段写的就是这些）。历史样本里的 `breakpoint` /
#: `watchpoint` / `signal` / `none` / `trace` 拼写保持不变，被纠正的是那四个
#: 从未存在于 SB 绑定的名字。
_STOP_REASON_LABEL_BY_NAME = {name: stop_reason_label(name) for name in STOP_REASON_NAMES}


def stop_reason_int_by_name():
    """停因名 -> 整数。lldb 可导入时**只**信 lldb 常量（与 `state_int_by_name()`
    同一条权威分支纪律，不与镜像混用：混表会让镜像序号盖过真值，int→名字 反查
    就此认错停因——那正是本次要消除的那类假象）。"""
    global _STOP_REASON_INT_BY_NAME
    if _STOP_REASON_INT_BY_NAME is not None:
        return _STOP_REASON_INT_BY_NAME
    resolved = {}
    try:
        import lldb
    except ImportError:
        lldb = None
    if lldb is not None:
        for name in STOP_REASON_NAMES:
            value = getattr(lldb, name, None)
            if value is None:
                continue  # 这个 LLDB 版本没有该停因：如实缺席，不猜
            try:
                resolved[name] = int(value)
            except (TypeError, ValueError):
                continue  # 常量取不到 int：同样缺席，绝不让 producer 因此炸掉
    if not resolved:
        resolved = dict(_FALLBACK_STOP_REASON_INT)
    _STOP_REASON_INT_BY_NAME = resolved
    return resolved


def normalize_stop_reason(reason, table=None):
    """把停因归一成 (int | None, 枚举成员名 | None)。

    接受四种形态（与 `normalize_state` 同口径）：int 5 / 数字串 "5" /
    裸名 "eStopReasonSignal" / 带前缀名 "lldb.eStopReasonSignal"，另外也认
    载荷里那个短词 "signal"（判据要能读自己写出去的东西）。归不出的回 None 名
    ——**未知即拒绝**，不替 lldb 编一个停因；`_describe_stop` 那种"照原样把数字
    报出去"的形态只出现在载荷里，绝不进入判定。
    """
    if table is None:
        table = stop_reason_int_by_name()
    if reason is None or isinstance(reason, bool):
        return None, None
    if isinstance(reason, int):
        for name, mapped in table.items():
            if mapped == reason:
                return reason, name
        return reason, None
    text = str(reason).strip()
    digits = text[1:] if text[:1] in ("+", "-") else text
    if digits.isdigit():
        value = int(text)
        for name, mapped in table.items():
            if mapped == value:
                return value, name
        return value, None
    bare = text.rsplit(".", 1)[-1]
    prefixed = bare if bare.startswith("eStopReason") else "eStopReason" + bare[:1].upper() + bare[1:]
    if prefixed in STOP_REASON_NAMES and prefixed in table:
        return table[prefixed], prefixed
    return None, None


def stop_reason_matches(reason, expected_name, table=None):
    """这次停因与那个枚举成员是不是同一件事？int、数字串、名字、短词在此互解。"""
    _actual_int, actual = normalize_stop_reason(reason, table)
    _expected_int, expected = normalize_stop_reason(expected_name, table)
    if actual is None or expected is None:
        return False
    return actual == expected


def is_crash_stop(reason, table=None):
    """这次停住是不是"目标被信号打死"？判据是枚举名（`CRASH_STOP_REASON`）。"""
    return stop_reason_matches(reason, CRASH_STOP_REASON, table)


def crash_record(reason, signal_number=None, table=None):
    """崩溃记录只在停因确实是信号时给出；其余一律 None（= 现场里没有崩溃）。"""
    if not is_crash_stop(reason, table):
        return None
    try:
        rendered = "signal %d" % int(signal_number)
    except (TypeError, ValueError):
        rendered = "signal %s" % (signal_number,)
    return {"signal": rendered,
            "description": _STOP_REASON_LABEL_BY_NAME.get(
                normalize_stop_reason(reason, table)[1], str(reason))}


def crash_reported(payload):
    """交付的这份现场里有没有崩溃。顶线程、载荷词汇、任意一条线程的停因，
    三处任一处读到信号停就算——崩溃不许从任何一条读法上溜走。"""
    if not isinstance(payload, dict):
        return False
    if payload.get("crash"):
        return True
    if is_crash_stop(payload.get("stopReason")):
        return True
    for thread in payload.get("threads") or []:
        if isinstance(thread, dict) and is_crash_stop(thread.get("stopReason")):
            return True
    return False


def outer_exit_code(payload):
    """外层 CLI 的退出码判据（0/1/3；2 由 `run_outer` 自己用在起不来与交付失败）。

      0 = 确实停住、采到了线程，而且那次停住**不是**崩溃
      1 = 什么都没采到（`no-process` / 零线程 / `failed`）
      3 = 采到了崩溃现场：载荷照常交付（`emit` 在返回之前已经跑完），但退出码
          不许把一次崩溃读成一次干净的通过

    3 是本轮新增的一档。此前崩溃与"采到一帧干净的停住"共用 0，而崩溃判据又押在
    抄错的数字上，于是 SIGSEGV 的现场既没有 `crash` 也没有非零退出——两层都沉默。
    """
    if not capture_succeeded(payload):
        return 1
    return 3 if crash_reported(payload) else 0


def no_payload_cause(stderr_text, stdout_text=None, bridge_path=None):
    """把"lldb 没吐载荷"分成几种成因，各自给各自的补救。

    从前这条路径不分成因，一律写"开发者工具权限挡住了 attach/launch"，于是
    一次**路径形态**故障（`command script import` 被 lldb 自己的命令分词切开，
    桥从未被导入）收到的是"去系统设置里勾 Developer Tools"——一个与病因无关的
    补救，而且怎么勾都不会好。lldb 的 stderr 里两种失败本来就长得不一样，
    所以放行者是测量，不是猜测。

    成因**只从桥自己的可信通道——lldb 的 stderr——判**，绝不读 stdout。本文件
    §"R30 标记"那一段与 `run_child_captured` 都写着同一件事：被调试目标的输出与
    lldb 自己的输出流同一条 stdout，所以为载荷缺席定因时把 stdout 也扫进子串，就是
    拿一条从没测量过的通道去下一个自信的判决——目标只要 print 一句
    `cat: config: No such file or directory`，就会命中 "no such file or directory"，
    把"桥没被导入"连同一个指向 checkout 路径的补救报出来，而真正该看的通道是空的。
    于是现在：stderr 明说导入失败 → bridge-not-imported；stderr 有内容但没说导入失败
    → 桥确实导入了（可信通道里若没导入失败，lldb 一定会写下来），没载荷就归到
    debug-gated；stderr 一片空白 → 可信通道回答不了，如实说 not-determinable，
    不再从猜测里挑一个病因。`stdout_text` 仍留在签名里供调用方传，但不参与分类。

    返回 `(cause, remedy)`：cause ∈ {"bridge-not-imported", "debug-gated",
    "not-determinable"}。
    """
    trusted = (stderr_text or "").lower()
    named_us = bridge_path if bridge_path else "glasspane_bridge.py"
    if ("importing failed" in trusted or "invalid pathname" in trusted
            or "no such file or directory" in trusted
            or "module not found" in trusted):
        # F2/F3（2026-10-24 复核）。这段文字是**给 agent 抄进 shell 的命令**，所以它受同一条
        # 规矩约束：一个路径必须是**一个词**，而 `'%s'` 不是保证——`bridge_path` 来自 `__file__`，
        # checkout 目录名里有一个 `'` 就把它自己那个引号组撕开，句子剩下的部分从此是 shell 文本。
        # `mcp-shell/test/remedy-shell-quoting.test.mjs` 管着 TS 与 updater 那一侧，扫描面从来不含
        # `bridge/*.py`（那条闸住在 mcp-shell 里，本泳道没有写权限），所以这里的词形由
        # `bridge/test_bridge.py` 的 `RemedyCommandsStayOneShellWord` 自己钉住。
        # 第二处更糟：旧落点是 `/tmp/glasspane_bridge.py`——世界可写目录里的一个**可预测名字**，
        # 任何本地账号先建那个文件，这条 remedy 就在用户自己的机器上跑别人的代码。`mktemp -d`
        # 是 0700、名字不可预测，写不进去也就换不了。
        quoted = shlex.quote(str(named_us))
        return ("bridge-not-imported",
                "lldb never imported the bridge: its own command tokenizer split "
                "`command script import %s`, so the checkout path is the suspect, NOT a "
                "permission seat. The historical shape was an unquoted path carrying a "
                "space, but `build_lldb_argv` quotes every token through "
                "`lldb_command_quote` now — re-quoting the -o text is a source edit, not "
                "a step an operator can take, so work the arms that are runnable as-is "
                "(each path below is quoted for a POSIX shell, so it stays ONE word "
                "whatever the checkout directory is called): "
                "(1) `ls -l %s` — the file has to exist and be readable at the path in "
                "the argv; (2) if that argv did not come from `build_lldb_argv` (a "
                "hand-run lldb, or an --setup line), take the quoted token from the "
                "bridge itself, passing the path as an argument so nothing is re-quoted "
                "inside a quoted program: `python3 -c 'import glasspane_bridge as gb, "
                "sys; print(gb.lldb_command_quote(sys.argv[1]))' %s`; (3) if the path "
                "itself is what lldb refuses, run a copy that sits on a plain path, since "
                "the bridge imports its own __file__: `dest_dir=$(mktemp -d) && cp %s "
                "\"$dest_dir/glasspane_bridge.py\" && python3 "
                "\"$dest_dir/glasspane_bridge.py\" capture --pid <pid>` — `mktemp -d` is "
                "0700 with an unpredictable name, which is why this does NOT say "
                "`/tmp/glasspane_bridge.py`: a fixed name in a world-writable directory is "
                "a file another local account created first, and this command would then "
                "run their code as you. "
                "No seat in System Settings fixes this one."
                % (named_us, quoted, quoted, quoted))
    if not trusted.strip():
        # 可信通道一个字都没写：既没有 `command script import` 的失败，也没有 attach
        # 被拒的那一行，成因无从测量。不许因为 stdout（目标的共享流，见上）里出现了
        # 什么相似子串就挑一个病因——那正是本函数要避免的那种"为没测过的东西定因"。
        return ("not-determinable",
                "the cause of the missing payload cannot be measured: lldb wrote nothing to "
                "its own stderr, so neither a `command script import` failure nor a refused "
                "attach left a line on the bridge's trusted channel. The debug target's "
                "stdout shares lldb's stdout (§ R30) and is deliberately NOT read for a "
                "cause, so even a target that printed 'no such file or directory' there stays "
                "undetermined here. Re-run the exact argv lldb echoed and read its stderr; if "
                "stderr is genuinely empty the next step is a real-machine capture "
                "(GLASSPANE_REAL_LLDB=1), not a permission seat or a path fix.")
    return ("debug-gated",
            "the bridge imported but produced no payload: debug attach/launch is "
            "permission-gated on this machine (P6 §0 F1/F2, §7.1) — grant System "
            "Settings > Privacy & Security > Developer Tools to the calling process, "
            "or re-run inside an already-authorized Terminal session.")


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
    """停因 → 载荷词汇。数值由 lldb 自己的常量解（`stop_reason_int_by_name()`），
    所以这张表不可能再与本机 lldb 的取值漂移——旧实现手抄的 `{5: frameIndexChanged,
    6: noDebug, 7: signal, 8: threadSpec}` 是 LLDB 私有枚举的次序，SB 绑定里没有
    这些成员，SIGSEGV 停（真值 5）就此被报成一次干净的停住。认不出来的取值照旧
    原样报出去（`str(reason)`），不替 lldb 编一个名字。"""
    reason = thread.GetStopReason()
    _value, name = normalize_stop_reason(reason)
    if name is None:
        return str(reason)
    return _STOP_REASON_LABEL_BY_NAME[name]


def _collect_locals(frame):
    """Top-frame locals as (variables, unreadable_reason).

    The reason is the honest half of the pair: `variables == []` **with** a reason
    means "not measured", and `variables == []` without one means "read, and this
    frame holds none". Collapsing the two is what let an unreadable frame publish
    `localsTotal: 0` (the `queue` rule at `thread_entry` is the precedent).
    """
    variables = []
    try:
        values = frame.GetVariables(True, True, False, True)
    except Exception as error:
        return variables, ("top-frame locals were not measured: GetVariables() "
                           "raised %r, so locals: [] in this payload is an unreadable "
                           "read, not an empty frame" % (error,))
    for value in values or []:
        try:
            if not value or not value.IsValid():
                continue
            name = value.GetName() or "?"
            displayed = value.GetValue() or value.GetSummary() or ""
        except Exception as error:
            return [], ("top-frame locals were not measured: a variable read raised "
                        "%r after %d of them, so this payload carries no locals for the "
                        "frame rather than a partial list that would read as a complete "
                        "one" % (error, len(variables)))
        variables.append((name, displayed))
    return variables, None


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


def _note(errors, text):
    """Append an integrity note when the caller kept a place for one.

    `errors=None` means this read is not feeding a payload (the trace sampler's
    per-stop observations), and the per-row `localsTotal: null` still carries the
    non-measurement there; a payload path always passes its list.
    """
    if errors is not None:
        errors.append(text)


def _collect_frames(thread, max_frames=MAX_FRAMES, errors=None):
    """Frames collected under the cap; the thread's real total travels with the
    row as ``framesTotal``/``framesTruncated`` so the cut is visible (B-23).

    A locals read that failed says so twice: the row keeps `localsTotal: null`
    (= not measured) and `errors[]` names the unreadable channel.
    """
    frames = []
    for i in range(min(thread.GetNumFrames(), max_frames)):
        frame = thread.GetFrameAtIndex(i)
        if not frame or not frame.IsValid():
            continue
        line_entry = frame.GetLineEntry()
        symbol = frame.GetSymbol()
        module = frame.GetModule()
        address = "0x%x" % frame.GetPC() if frame.GetPC() is not None else "?"
        locals_ = None
        if i == 0:
            variables, unreadable = _collect_locals(frame)
            if unreadable:
                # Keep `locals_: null` (not measured) rather than the failed read's
                # empty list, which `frame_record` would publish as a measured zero.
                _note(errors, unreadable)
            else:
                locals_ = variables
        frames.append(frame_record(
            index=i,
            module=_module_name(module) if module and module.IsValid() else "?",
            address=address,
            file=_line_file(line_entry),
            line=line_entry.GetLine() if line_entry and line_entry.IsValid() else None,
            function=symbol.GetName() if symbol and symbol.IsValid() else None,
            locals_=locals_,
        ))
    return frames


def _collect_registers(thread):
    """Top-frame registers as (registers, unreadable_reason).

    Same rule as `_collect_locals`: `{}` with a reason is "not measured", `{}`
    without one is "read, and the thread has no frames".
    """
    registers = {}
    if thread.GetNumFrames() == 0:
        return registers, None
    frame = thread.GetFrameAtIndex(0)
    try:
        root = frame.GetRegisters()
    except Exception as error:
        return registers, ("registers were not measured: GetRegisters() raised %r, so "
                           "registers: {} in this payload is an unreadable read, not a "
                           "register-less thread" % (error,))
    for group in root or []:
        for reg in group or []:
            try:
                name = reg.GetName()
                value = reg.GetValue()
            except Exception:
                continue
            if name:
                registers[name] = truncate(value or "")[0]
    return registers, None


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
    mode = entry.get("mode") or DEFAULT_WATCH_MODE
    if mode not in WATCH_MODES:
        # 第二道闸：账本里的条目未必都来自 cmd_watch 的校验路径。
        return (False, "watch mode %r is not one of %s — arming it would take a hardware "
                       "slot for a watchpoint that can never fire"
                % (mode, "/".join(WATCH_MODES)))
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
    """Disable the debugger-side watchpoint so its hardware slot is really free.

    D4（2026-10-24 复核）：`_LIVE_WATCHPOINTS.pop()` 从前发生在 `Disable()` **之前**。
    Disable 失败时那个 SBWatchpoint 就永久失联了——没有任何别的地方还拿着它，硬件槽位
    没让出，而账本已经在同一条路径上 `release(addr)` 并把队头 arm 进同一个槽
    （:1776-1781 只补一条 note，没有重试）。下一次 `_addr_for_watchpoint_id` 在这条
    监视点上打出一个停，也认不出它是谁。现在只在成功时摘句柄：失败的那一条留在表里，
    下一次 reconcile 还看得见它、还能再试一次 Disable。
    """
    watchpoint = _LIVE_WATCHPOINTS.get(addr)
    if watchpoint is None:
        return (False, "no live watchpoint was tracked for %s" % addr)
    disable = getattr(watchpoint, "Disable", None)
    if disable is None:
        return (False, "this lldb binding has no SBWatchpoint.Disable()")
    ok, detail = _outcome_ok(disable())
    if ok:
        _LIVE_WATCHPOINTS.pop(addr, None)
    return (ok, detail)


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


def _thread_count(process):
    """Threads the target really reports, as (count, unreadable_reason).

    The count is what makes a cap *visible*: `_payload_from_process` enumerates
    this many rows so `assemble_result` can drop the excess and announce it, and
    `reconcile_watchpoint_stops` compares it with MAX_THREADS to say when a stop
    may have sat past the rows it was allowed to look at. An unreadable count is
    reported as unreadable, never as "0 threads".
    """
    try:
        return max(0, int(process.GetNumThreads())), None
    except Exception as error:
        return 0, ("the thread count was not measured: GetNumThreads() raised %r, so an "
                   "empty thread list here means unreadable, not a threadless process"
                   % (error,))


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

    The thread walk here is capped, so a caveat travels with any cap: the ledger
    note rides out in every payload's errors[], because "the session observed no
    watchpoint stop" must never be readable as evidence when the real reason is
    that the stop sat past the rows this pass was allowed to look at (B-23).
    """
    report = {"hits": [], "rearmed": [], "notes": []}

    def caveat(detail):
        _WATCH_QUEUE.note(detail)
        report["notes"].append(detail)

    try:
        process = process if process is not None else _process_of(debugger)
        if process is None or not process.IsValid():
            return report
        stop_id = _stop_id(process)
        num_threads, unreadable = _thread_count(process)
        if unreadable:
            caveat(unreadable)
        if num_threads > MAX_THREADS:
            # 载荷那一半现在枚举全部线程（封顶与宣告归 assemble_result），这里为了
            # 一次停住的开销上限仍然只看前 MAX_THREADS 条 —— 于是第 65 条线程上的
            # 监视点停会被**静默**漏掉，账本接着报"一次停都没观察到"。漏就要说漏。
            caveat("watchpoint reconciliation looked at only the first %d of %d threads "
                   "(MAX_THREADS=%d): a stop on a thread past that cut was NOT observed, "
                   "so a hit may be missing and a queued watchpoint may still be waiting "
                   "for a slot it never got" % (MAX_THREADS, num_threads, MAX_THREADS))
        for index in range(min(num_threads, MAX_THREADS)):
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
    notes = _WATCH_QUEUE.integrity_notes()
    channel_errors = list(errors or [])
    if process is None or not process.IsValid():
        return assemble_result(mode=mode, target={"pid": None}, status="no-process",
                               threads=[],
                               errors=(channel_errors or ["no live process to capture"]) + notes)
    threads = []
    # 每一**条**线程都要走到，把封顶与宣告留给 `assemble_result`（它本来就在做这两件
    # 事）：从前这里先 `min(GetNumThreads(), MAX_THREADS)` 才交给装配，超出上限的
    # 行根本不存在，于是 `truncated.threads` 是空的、errors[] 一字不提，载荷读起来
    # 像一份完整的线程表——正是 B-23 要杀掉的那一类"截断了却不宣布截断"。
    # 上限之后的行仍然建，但只填便宜字段：它们反正被丢掉，为一行没人收的载荷去付
    # 一次整栈回溯，宽线程目标上能把采集拖过预算。
    num_threads, count_unreadable = _thread_count(process)
    if count_unreadable:
        channel_errors.append(count_unreadable)
    for index in range(num_threads):
        thread = process.GetThreadAtIndex(index)
        if not thread or not thread.IsValid():
            continue
        kept_row = len(threads) < MAX_THREADS
        threads.append(thread_entry(
            thread_id=thread.GetThreadID(),
            name=thread.GetName(),
            stop_reason=_describe_stop(thread),
            frames=_collect_frames(thread, errors=channel_errors) if kept_row else [],
            frames_total=_num_frames(thread),
            queue=_thread_queue(thread),
        ))
    top = process.GetSelectedThread() or process.GetThreadAtIndex(0)
    stop_reason = _describe_stop(top) if top and top.IsValid() else None
    # 崩溃判据走名字（`CRASH_STOP_REASON`），不再走 `stop == 7` 那个抄错的数字：
    # 真机上信号停是 5，旧判据对一次 SIGSEGV 一条都不给，`crash` 就此是 null。
    crash = None
    if top and top.IsValid():
        try:
            crash = crash_record(top.GetStopReason(), top.GetStopReasonDataAtIndex(0))
        except Exception:
            crash = None  # 取不到停因/信号号：如实报"没有崩溃记录"，不猜
    # 进程状态**在此处归一一次**：int 直接取自 SB 枚举，名字由 lldb 模块常量
    # 反查（`state_int_by_name()` 在 lldb 内部走权威分支）。这条路径与 str()
    # 无关，所以退出码判据不再押在"枚举怎么渲染"上——`run_capture_cli` 的
    # `state == lldb.eStateStopped` 本来就是数值比较，这里补齐原先唯一用 str()
    # 的那一行。停因面同一条纪律，只是权威表换成 `stop_reason_int_by_name()`。
    raw_state = process.GetState()
    try:
        state_input = int(raw_state)
    except (TypeError, ValueError):
        state_input = raw_state  # 取不到 int：交给 normalize_state 尽力解析
    _state_int, state_name = normalize_state(state_input)
    status = state_name or ("state(%s)" % raw_state)
    registers, register_failure = ({}, None)
    if top and top.IsValid():
        registers, register_failure = _collect_registers(top)
    if register_failure:
        channel_errors.append(register_failure)
    result = assemble_result(
        mode=mode,
        target={"pid": process.GetProcessID()},
        status=status,
        threads=threads,
        registers=registers,
        stop_reason=stop_reason,
        crash=crash,
        watchpoints=_WATCH_QUEUE.records(),
        errors=channel_errors + notes,
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
    # D3：预算是被钳过还是退回默认值，只有出现在**载荷的 errors[]** 里才算被说过——外层
    # 读的就是那一个字段，而 §6.2 要求失败也带着自己的判决离场。
    notes = [spec["budget_note"]] if spec.get("budget_note") else []
    debugger = _LIVE_DEBUGGER
    if debugger is None:
        print(_sentinel(assemble_result(mode="capture", target={"exe": spec.get("exe")},
                                        status="failed", threads=[],
                                        errors=["bridge imported without a debugger handle"] + notes)))
        return
    debugger.SetAsync(False)
    target = debugger.CreateTarget(spec.get("exe") or "")
    if not target.IsValid():
        print(_sentinel(assemble_result(mode="capture", target={"exe": spec.get("exe")},
                                        status="failed", threads=[],
                                        errors=["invalid executable"] + notes)))
        return
    listener = lldb.SBListener("glasspane.bridge")
    process = target.LaunchSimple(spec.get("args") or None, None,
                                  os.path.dirname(spec.get("exe") or "/") or "/")
    if not process.IsValid():
        print(_sentinel(assemble_result(mode="capture", target={"exe": spec.get("exe")},
                                        status="failed", threads=[],
                                        errors=["launch failed (LaunchSimple returned invalid process)"] + notes)))
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
    if notes:
        payload.setdefault("errors", [])
        if isinstance(payload["errors"], list):
            payload["errors"].extend(notes)
    print(_sentinel(payload))
    try:
        process.Kill()
    except Exception:
        pass


def run_capture_cli_b64(spec_b64):
    """`-o "script glasspane_bridge.run_capture_cli_b64('<base64 of the spec>')"`。

    base64 而不是 shell 引号：这段文本是**Python** 求值的（见 `encode_capture_spec`）。
    解不开、载荷不是 JSON、或采集本身抛了异常，都必须以模块自己的 JSON 错误形状离场
    (§6.2「失败也要有形状」)，而不是在 lldb 里留一段 traceback——那在外层桥看来就是
    "没有载荷"，什么也不指认。
    """
    try:
        spec_json = base64.b64decode(spec_b64, validate=True).decode("utf-8")
    except Exception as error:
        print(_sentinel(assemble_result(
            mode="capture", target={}, status="failed", threads=[],
            errors=["capture spec could not be decoded: %r" % (error,)])))
        return
    try:
        run_capture_cli(spec_json)
    except Exception as error:
        print(_sentinel(assemble_result(
            mode="capture", target={}, status="failed", threads=[],
            errors=["capture driver raised %r before emitting a payload" % (error,)])))


def _sentinel(payload):
    """Emission used *inside* lldb: carries this run's nonce when it was handed
    one (`run_outer` puts it in the child's environment), so only the outer
    bridge can trust it."""
    return wrap_sentinel(render_json(payload), nonce=sentinel_nonce_from_env())


def _now():
    import time
    return time.monotonic()


def cmd_capture(debugger, command, result, internal_dict):
    payload = _payload_via_debugger(debugger, mode="capture")
    print(_sentinel(payload))


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
    print(_sentinel(payload))


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
    size, size_refusal = parse_watch_size_token(argv[2] if len(argv) > 2 else None)
    if size_refusal:
        # size 位的非数字必须当场拒：静默落回 8、再让 mode 位因为"没有第四个 token"
        # 落回 "w"，就是把一次读请求装成了一次写请求。
        result.AppendMessage(size_refusal)
        return
    mode, refusal = parse_watch_mode(argv[3] if len(argv) > 3 else None)
    if refusal:
        # 拒绝在**登记之前**：账本里不会留下一个永不触发却占着硬件槽的请求。
        result.AppendMessage(refusal)
        return
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
    parser.add_argument("--exe", help="launch this executable under the debugger "
                        "(capture only; trace attaches a running pid with --pid, it "
                        "never launches)")
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
    if args.mode == "trace" and args.exe and args.pid is None:
        parser.error("trace --exe is not supported: the bridge never launches a target in "
                     "trace mode — launching lives only in the capture path "
                     "(`run_capture_cli_b64`), so `trace --exe` would build a `--file <exe>` "
                     "argv with no run command and then sample 0 stops and exit 1. Trace a "
                     "hung, already-running process with `trace --pid <pid>`, or capture a "
                     "fresh launch with `capture --exe <path>`. The parser refuses the "
                     "combination rather than answering for a capability it does not have.")
    if args.mode == "trace" and not 1 <= args.samples <= MAX_TRACE_SAMPLES:
        parser.error("--samples must be within 1..%d; the bridge refuses a sample "
                     "count it cannot honour" % MAX_TRACE_SAMPLES)
    return run_outer(args)


if __name__ == "__main__":
    sys.exit(main())
