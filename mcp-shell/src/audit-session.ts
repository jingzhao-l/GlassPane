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

  /** Record every operationId/evidenceId found in an engine result frame. */
  record(result: unknown): void {
    for (const id of collectOperationIds(result)) {
      if (!this.ids.includes(id)) {
        this.ids.push(id);
        if (this.ids.length > AUDIT_HISTORY_LIMIT) {
          this.ids.splice(0, this.ids.length - AUDIT_HISTORY_LIMIT);
        }
      }
    }
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
   */
  recordLateArrival(result: unknown): Promise<void> {
    const turn = this.claimTrailTurn();
    return turn.acquire().then(() => {
      try {
        this.record(result);
      } finally {
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