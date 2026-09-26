/**
 * In-memory session trail of operationIds seen by this MCP server process.
 * The daemon's method table is frozen (P1 spec v1.3 §10.3), so `gp_recent_reports`
 * cannot ask the daemon to enumerate its history — this shell tracks the
 * operationIds returned by act/assert/diagnose/restore/last_evidence itself,
 * mirroring the daemon's bounded-memory semantics.
 *
 * Lifecycle: cleared on every successful `gp_attach` (the daemon invalidates
 * its evidence history when the attached app changes; re-attach is idempotent
 * and simply restarts the trail). Does not persist across process restarts.
 */
export const AUDIT_HISTORY_LIMIT = 20;

/**
 * One position in a session's trail *request order*, handed out by
 * {@link EvidenceAuditSession.claimTrailTurn}. `release` is idempotent.
 */
export interface TrailTurn {
  /** Wait until every turn claimed before this one has released. */
  acquire(): Promise<void>;
  /** Hand the trail on: this turn is done with it, or never will be. */
  release(): void;
}

/**
 * Handed to {@link EvidenceAuditSession.recordLateArrival} when the request that
 * produced a late reply never said which generation it belonged to. It is
 * deliberately not `undefined` and not a number the real epochs can ever reach:
 * an unattributed frame is *known* unattributed, and refusing it is the default.
 */
export const UNKNOWN_GENERATION = -1;

/** Where a late arrival ended up: written, or refused because a re-attach got there first. */
export interface LateArrivalOutcome {
  written: boolean;
  /** The trail generation in force at the moment of the decision. */
  generationAtWrite: number;
}

/**
 * How an id got into this trail, per id, in the words a renderer can put beside
 * it. The three values are not adjectives of confidence: they name which
 * mechanism wrote the id, and each one is a fact the session itself observes.
 *
 * - `in-order`: written by a call whose own request held a trail turn, answered
 *   by a frame that echoed that request's id. This is the only entry the trail
 *   may describe as verified.
 * - `late`: written from a reply that landed after its caller had already been
 *   answered, so it had no turn left to write at and took the position
 *   {@link recordLateArrival} gives it — behind whatever is still outstanding.
 *   The *operation* is the daemon's own; only its place in request order is
 *   arranged by arrival.
 * - `late-inferred`: that same late write, for a frame that echoed **no request
 *   id** (R10-中2). Which request it answers is then a guess from the daemon's
 *   in-order scheduling, not a match, and an id pulled out of it can be filed
 *   under the wrong operation. The trail still records it — dropping it would
 *   claim "no such operation ran", which is the more dangerous lie for an agent
 *   deciding whether to click again — but it must not read as verified, and
 *   `gp_recent_reports` has to say so from here rather than from the log line.
 *
 * Producers: `EngineJsonRpcClient`'s `LateReply.attribution` decides between the
 * last two (`echoed-id` -> `late`, `arrival-order` -> `late-inferred`); a caller
 * that passes nothing gets `late`, which is everything this session can see on
 * its own.
 */
export type TrailProvenance = "in-order" | "late" | "late-inferred";

/**
 * The attribution a late arrival carries: the same two literals
 * `engine-client.ts`'s `FrameAttribution` produces, and `unknown` for a caller
 * that cannot say (a wiring that has not read the field yet).
 */
export type LateArrivalAttribution = "echoed-id" | "arrival-order" | "unknown";

/**
 * The sentence the surface that shows the trail puts beside one id. Written here
 * because this is the layer that knows the mechanism; the tool layer renders it.
 */
export const TRAIL_PROVENANCE_NOTES: Readonly<Record<TrailProvenance, string>> = {
  "in-order": "recorded from the reply to this session's own request, matched by the id that request carried",
  "late": "recorded from a reply that landed after its caller had already been answered, so it was filed at the next "
    + "free trail position rather than at its request's own",
  "late-inferred": "recorded from a reply that landed late AND echoed no request id: which request it answers is "
    + "inferred from arrival order (the daemon answers in the order it received them) and could not be confirmed by an "
    + "echoed id, so this operation is listed as inferred — not as verified — and its identity, not merely its order, "
    + "is what the inference covers",
};

/** A claimed position whose holder has not released yet. */
interface TrailGate {
  settled: Promise<void>;
  settle: () => void;
}

function openTrailGate(): TrailGate {
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = () => resolve(undefined);
  });
  return { settled, settle };
}

export class EvidenceAuditSession {
  private ids: string[] = [];
  private epoch = 0;
  private attachedAppKey: string | null = null;

  /**
   * Turns claimed but not released. This, not a "latest gate", is what a new
   * claim waits for: a turn that abandons the trail (its engine call failed
   * before any mutation) releases *out of order*, and a chain that only looked
   * at the immediately preceding turn would let everything behind it run while
   * an older, still-outstanding act had not written yet — the exact completion
   * order the turn machinery exists to remove.
   */
  private openGates = new Set<TrailGate>();

  /**
   * How each id in {@link ids} got here. Keyed by the id, because that is what a
   * reader holds; the map is trimmed with the list and cleared when the trail
   * restarts, so an id can never outlive the provenance that describes it.
   */
  private readonly provenance = new Map<string, TrailProvenance>();

  /**
   * Non-null while {@link recordLateArrival} holds the trail, and says how the
   * frame being written was attributed. This is what lets a plain
   * `trail.record(result)` inside that callback be filed as a late arrival without
   * the caller having to remember to say so: the write happens inside a window only
   * that method opens, so the mechanism is visible here rather than being a claim
   * somebody must repeat at every call site.
   */
  private lateWindow: LateArrivalAttribution | null = null;

  /**
   * Record every operationId/evidenceId found in an engine result frame, tagged
   * with the provenance of the path that is recording it (see
   * {@link TrailProvenance}): `in-order` from a call that held its own trail turn,
   * `late`/`late-inferred` from inside {@link recordLateArrival}.
   */
  record(result: unknown): void {
    const source: TrailProvenance = this.lateWindow === null
      ? "in-order"
      : this.lateWindow === "arrival-order" ? "late-inferred" : "late";
    for (const id of collectOperationIds(result)) {
      if (!this.ids.includes(id)) {
        // First arrival wins, in both lists. An id that arrives a second time
        // through a *worse* channel would otherwise upgrade the record: the
        // guessed attribution is the one an agent has to be told about, and a
        // re-arrival never confirms the frame that was matched by guesswork.
        this.ids.push(id);
        this.provenance.set(id, source);
        if (this.ids.length > AUDIT_HISTORY_LIMIT) {
          const evicted = this.ids.splice(0, this.ids.length - AUDIT_HISTORY_LIMIT);
          for (const gone of evicted) {
            this.provenance.delete(gone);
          }
        }
      }
    }
  }

  /**
   * How one id in this trail got recorded, or null when the trail does not hold
   * it — never recorded, evicted past {@link AUDIT_HISTORY_LIMIT}, or cleared by a
   * {@link restart}. A reader that lists ids for an agent renders
   * {@link TRAIL_PROVENANCE_NOTES} for anything that is not `in-order`: an id
   * pulled from a frame this shell only *guessed* an owner for must not appear
   * beside one it matched by id (R10-中2).
   *
   * Read off the map alone, so the map *is* the record of what the trail holds: an
   * id whose provenance outlives its own entry would come back labelled as if it
   * were still listed, and the eviction and the restart are the two places that
   * would have to remember to delete. `test/engine-client.test.mjs` pins both.
   */
  provenanceOf(id: string): TrailProvenance | null {
    return this.provenance.get(id) ?? null;
  }

  /** The ids currently filed as inferred; see {@link TrailProvenance}. */
  inferredIds(): string[] {
    return this.ids.filter((id) => this.provenance.get(id) === "late-inferred");
  }

  /**
   * The trail's generation number. Every {@link restart} bumps it.
   *
   * It exists so a reply that arrives *after* its caller was already answered
   * can be judged against the trail it was written into: {@link recordLateArrival}
   * takes the epoch the request was admitted under, and a mismatch means a
   * re-attach happened in between. Without it, a late write lands in a *new*
   * session's trail — an operationId from the previous app that
   * `gp_recent_reports` then fetches and renders as if it belonged to this one
   * (R8b-高1, measured: `['op_OLDAPP']` in the trail after attaching a second
   * app).
   */
  get generation(): number {
    return this.epoch;
  }

  /** The app the trail currently belongs to, or null before the first attach. */
  get attachedApp(): string | null {
    return this.attachedAppKey;
  }

  /**
   * A successful attach: the trail restarts **only when the attached app
   * changed**, because that is the daemon's own rule —
   * `EngineCore.attach` clears `history` under
   * `if attachedApp != app`, and its comment says re-attach to the same app is
   * idempotent. Clearing on *every* attach (what this used to do) is strictly
   * worse in two directions: an idempotent re-attach wiped operations that were
   * really in the trail (including one recorded by a late reply, which put
   * `gp_recent_reports` back to "run gp_act first"), and — because the clear
   * happens whenever the reply lands — it could also drop the record of an act
   * the daemon still has.
   *
   * `appKey` must be built from every stored property of Swift's `AttachedApp`
   * (`pid`, `bundleId`, `appName`); a key that ignored `pid` would keep the
   * trail across an app restart whose history the daemon did clear. The gate
   * that pins this to the Swift struct is
   * `test/attach-identity.test.mjs`.
   *
   * Returns whether the trail was restarted. A null `appKey` means the attach
   * result did not identify the app at all, which is treated as a change: an
   * unknown identity cannot be *shown* to be the same app, and a stale trail is
   * the failure that misattributes evidence.
   */
  restart(appKey: string | null): boolean {
    if (appKey !== null && appKey === this.attachedAppKey) {
      return false;
    }
    this.attachedAppKey = appKey;
    this.ids = [];
    this.provenance.clear();
    this.epoch += 1;
    // Deliberately does *not* touch `openGates`: outstanding turns are not
    // outstanding mutations, and forgetting them would let a later read overtake
    // an act that is still going to write.
    return true;
  }

  /** The most recent `limit` recorded operationIds, oldest first. */
  recentIds(limit: number): string[] {
    return this.ids.slice(-limit);
  }

  /**
   * Record a frame that arrives with **no request of the caller still holding a
   * turn**: a late engine reply (R8-高3, `EngineJsonRpcClient.onLateReply`). Its
   * own turn was released the moment the timeout was reported to the agent, so
   * there is no request-order position left to write at.
   *
   * It still goes through the turn machinery rather than a bare `record()`,
   * because a direct write could land *between* two admitted calls and reorder
   * the trail against the requests the agent made — the exact thing the turns
   * exist to prevent. Claiming on arrival gives the only honest position left:
   * behind whatever is still outstanding, and ordered among late arrivals by
   * when they arrived.
   *
   * `admittedUnderGeneration` is compared **inside** that wait (see the body):
   * the position and the epoch can only be judged at the moment the write
   * actually happens. A reply whose request carried no generation cannot be
   * placed either — so it is passed as {@link UNKNOWN_GENERATION} and the caller
   * decides whether that is acceptable; this method refuses it by default, because
   * "we do not know which attach this belongs to" is not a reason to write into
   * somebody else's trail.
   *
   * `attribution` is how the transport matched that frame to a request, and it is
   * the difference between `late` and `late-inferred` below: a frame that echoed
   * the id the client sent is confirmed, one with no id is filed against the
   * oldest tracked request by the daemon's in-order scheduling (R10-中2). Anything
   * this method writes is a late arrival by construction, so the window opens
   * whether or not the caller can say more — the default `unknown` is what the
   * session can see on its own, and it is *not* `in-order`: an unconfirmed
   * attribution must not read as a verified one.
   */
  recordLateArrival(
    apply: (session: EvidenceAuditSession) => void,
    admittedUnderGeneration?: number,
    attribution: LateArrivalAttribution = "unknown",
  ): Promise<LateArrivalOutcome> {
    const turn = this.claimTrailTurn();
    return turn.acquire().then(() => {
      try {
        // Re-checked **after** the wait, because the wait is the whole point of
        // the turn: a re-attach admitted before this reply landed may still be
        // outstanding, and when its reply lands the trail restarts. Judging the
        // epoch at arrival would let the late write queue behind that reset and
        // then land in the successor app's trail anyway — measured, not
        // hypothetical: an operation from app A appeared in app B's trail with
        // only the arrival-time check in place.
        if (admittedUnderGeneration !== this.epoch) {
          return { written: false, generationAtWrite: this.epoch };
        }
        // The caller decides *what* the frame means (record an operation, restart
        // the trail on an attach) and it is decided here, at the moment the trail
        // is actually held: 8b's first version restarted only on the non-late
        // path, so an attach whose own caller had already been answered never
        // restarted anything and left no log line at all.
        //
        // The window is opened for the whole of that callback and closed in the
        // `finally`, so a `record()` inside it is tagged by the mechanism that is
        // actually running rather than by whether the caller remembered to say so.
        this.lateWindow = attribution;
        apply(this);
        return { written: true, generationAtWrite: this.epoch };
      } finally {
        this.lateWindow = null;
        // Released in every outcome: a turn that never released would hold up
        // every later trail-scoped call, which is a worse failure than losing
        // one late id.
        turn.release();
      }
    });
  }

  /**
   * Claim the next position in this session's trail request order, so that
   * overlapping calls mutate and read `ids` in the order they were admitted
   * rather than in the order the daemon answered.
   *
   * Synchronous on purpose — a claim made after an `await` would itself be
   * ordered by completion. Callers hold a turn only across a `record()` /
   * `reset()` / `recentIds()`, never across an engine round trip, so the queue
   * can delay the moment a reply is built but never a request at the daemon.
   */
  claimTrailTurn(): TrailTurn {
    const ahead = [...this.openGates];
    const mine = openTrailGate();
    this.openGates.add(mine);
    let released = false;
    return {
      acquire: async () => {
        await Promise.all(ahead.map((gate) => gate.settled));
      },
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.openGates.delete(mine);
        mine.settle();
      },
    };
  }
}

/**
 * Bounded recursive walk (depth ≤ 3) that collects string-valued
 * `operationId` / `evidenceId` fields — from act/assert/diagnose/restore
 * results and from nested `evidencePack` frames. Depth is capped so an
 * adversarial frame cannot force an unbounded descent.
 */
/** The same bounded walk, as the shell's one way to ask "does this frame name an
 * operation?" — the late-reply wiring needs it to say *what* it dropped. */
export function operationIds(value: unknown): string[] {
  return collectOperationIds(value);
}

function collectOperationIds(value: unknown, depth = 0): string[] {
  const out: string[] = [];
  if (depth > 3 || value === null || typeof value !== "object") {
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      out.push(...collectOperationIds(item, depth + 1));
    }
    return out;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const entry = record[key];
    if ((key === "operationId" || key === "evidenceId") && typeof entry === "string") {
      out.push(entry);
    } else {
      out.push(...collectOperationIds(entry, depth + 1));
    }
  }
  return out;
}